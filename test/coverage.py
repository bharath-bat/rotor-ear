# Coverage map. (1) The hearing-radius math (RotorEar.hearingRadius): inverse square against the detection threshold,
# +6 dB of background noise halves the radius, clamped to 2–300 m. (2) End to end over the relay: three ears, two in a
# fairly quiet spot (faint hiss) and one next to loud broadband noise; each reports its background noise floor and radius, the
# screen draws one soft circle per phone (plain map and street map) and lists each phone's range in the Phones sheet;
# when a quiet ear gets noisy (Simulate's noise bed switched on, its drone too far to hear) its circle shrinks within a few seconds.
# usage: [SHOT=dir] python test/coverage.py   (tiles are a local stub, as in geo.py)
import os, time, math, struct, zlib, functools, threading, socketserver, http.server
from playwright.sync_api import sync_playwright
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__))); SHOT = os.environ.get('SHOT'); WAV = os.path.join(ROOT, 'test', 'wav')
class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
srv = socketserver.ThreadingTCPServer(('127.0.0.1', 0), functools.partial(Quiet, directory=ROOT)); srv.daemon_threads = True
threading.Thread(target=srv.serve_forever, daemon=True).start(); B = f'http://127.0.0.1:{srv.server_address[1]}/'
def png(w=256):
    rows = b''.join(b'\x00' + b''.join(bytes([200, 205, 210] if (x % 64 < 2 or y % 64 < 2) else [236, 234, 228]) for x in range(w)) for y in range(w))
    ch = lambda t, d: struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    return b'\x89PNG\r\n\x1a\n' + ch(b'IHDR', struct.pack('>IIBBBBB', w, w, 8, 2, 0, 0, 0)) + ch(b'IDAT', zlib.compress(rows)) + ch(b'IEND', b'')
TILE = png(); res = []
def check(name, ok, info=''): res.append(bool(ok)); print(f"{'PASS' if ok else 'FAIL'}  {name}  {info}")
LAT0, LON0 = 12.97633, 77.59295
def gps(x, y): return LAT0 + math.degrees(y / 6371008.8), LON0 + math.degrees(x / (6371008.8 * math.cos(math.radians(LAT0))))
args = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required']
with sync_playwright() as p:
    bq = p.chromium.launch(args=args + [f'--use-file-for-fake-audio-capture={WAV}/hiss.wav'])
    bn = p.chromium.launch(args=args + [f'--use-file-for-fake-audio-capture={WAV}/white.wav'])
    # ---- 1) the math ----
    pg = bq.new_page(); pg.goto(B + '#screen')
    m = pg.evaluate("""(() => { const h = RotorEar.hearingRadius, C = RotorEar.COVER; return { r100: h(-100), r94: h(-94), r90: h(-90), r110: h(-110), lo: h(-20), hi: h(-200), C }; })()""")
    C = m['C']; want = 10 ** ((C['refDb'] + 100 - C['needDb']) / 20)
    check('radius = 10^((ref − floor − need)/20)', abs(m['r100'] - want) < 1e-9, f"floor −100 dB → {m['r100']:.1f} m")
    check('+6 dB of noise halves the radius', abs(m['r94'] / m['r100'] - 0.501) < 0.01, f"{m['r100']:.1f} → {m['r94']:.1f} m")
    check('+20 dB → a tenth', abs(m['r90'] / m['r110'] - 0.1) < 0.001, f"{m['r110']:.1f} → {m['r90']:.2f} m")
    check('clamped to 2–300 m', m['lo'] == C['minM'] and m['hi'] == C['maxM'], f"{m['lo']} / {m['hi']} m")
    pg.close()
    # ---- 2) end to end ----
    sc = bq.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2); s = sc.new_page(); errs = []
    s.on('pageerror', lambda e: errs.append(str(e)))
    s.route('**/tile.openstreetmap.org/**', lambda r: r.fulfill(status=200, content_type='image/png', body=TILE))
    s.goto(B + '#screen'); s.evaluate("localStorage.clear(); localStorage.setItem('rotorear-mute-until', Date.now() + 6e5)"); s.reload()
    s.click('#tabPhones'); check('coverage circles on by default, assumption stated', s.is_checked('#covOn') and 'quadcopter' in s.inner_text('#covNote'), s.inner_text('#covNote')[:80] + '…')
    s.click('#pCreate'); time.sleep(1.5); room = s.inner_text('#pRoomCode').lower(); s.click('#phones [data-close]')
    ears = []
    for i, (br, x, y, name) in enumerate([(bq, 0, 0, 'Quiet1'), (bn, 6, 0, 'Noisy'), (bq, 6, 6, 'Quiet2')]):
        la, lo = gps(x, y); ec = br.new_context(viewport={'width': 390, 'height': 844}, geolocation={'latitude': la, 'longitude': lo, 'accuracy': 4}, permissions=['geolocation'])
        e = ec.new_page(); e.on('pageerror', lambda er: errs.append('ear ' + str(er))); e.goto(B + '?room=' + room); e.fill('#nName', name); e.dispatch_event('#nName', 'change'); e.click('#nStart'); e.check('#nGeo'); ears.append(e)
        t0 = time.time()
        while s.evaluate('__map.nodes || 0') < i + 1 and time.time() - t0 < 30: time.sleep(0.5)
    t0 = time.time()
    while time.time() - t0 < 20:
        cov = s.evaluate('__map.cover') or []
        if len(cov) == 3: break
        time.sleep(0.5)
    time.sleep(4); cov = {c['label']: c for c in s.evaluate('__map.cover') or []}; names = s.evaluate('__mapNodes().map(n => [n.label, n.name])'); lab = {n: l for l, n in names}
    print('   ', {n: (cov[lab[n]]['hr'], cov[lab[n]]['nf']) for n in lab if lab[n] in cov}, '(radius m, background dB)')
    q1, nz, q2 = (cov.get(lab.get(n), {}).get('hr') for n in ('Quiet1', 'Noisy', 'Quiet2'))
    check('every phone reports a radius', None not in (q1, nz, q2), str((q1, nz, q2)))
    check('the noisy phone has the smallest circle', q1 and nz and q2 and nz < q1 / 2 and nz < q2 / 2, f'quiet {q1} m / {q2} m vs noisy {nz} m')
    check('ear shows its own range', 'would hear a small drone out to' in ears[0].inner_text('#nRange'), ears[0].inner_text('#nRange'))
    s.click('#tabPhones'); time.sleep(0.6); rows = s.inner_text('#cTable')
    check('Phones sheet lists each range in metres', rows.count('hears ') == 3 and ' m' in rows, rows.replace('\n', ' | ')[:160])
    s.click('#phones [data-close]'); time.sleep(1.5)
    if SHOT: s.screenshot(path=f'{SHOT}/coverage-plain.png')
    shade = s.evaluate("""(() => { const c = document.getElementById('map'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let a = 0, n = 0;
      for (let i = 0; i < d.length; i += 4 * 97) { n++; a += d[i] + d[i + 1] + d[i + 2]; } return a / n; })()""")
    # quiet ear 1 gets noisy: Simulate adds a noise bed (its simulated drone set 60 m away, too faint to hear), so its circle shrinks
    ears[0].fill('#nDist', '60'); ears[0].dispatch_event('#nDist', 'input'); ears[0].check('#nSim'); t0 = time.time(); after = q1
    while time.time() - t0 < 12:
        time.sleep(1); c = {x['label']: x for x in s.evaluate('__map.cover') or []}; after = c.get(lab['Quiet1'], {}).get('hr', after)
        if after < q1 / 2: break
    check('a phone that gets noisy shrinks its circle within seconds', after < q1 / 2, f'{q1} → {after} m in {time.time() - t0:.0f} s')
    ears[0].uncheck('#nSim')
    # street map under the plan: circles drawn there too
    s.click('#tabPhones'); s.check('#geoMap'); s.click('#phones [data-close]'); t0 = time.time()
    while not s.evaluate('__geo.shown') and time.time() - t0 < 20: time.sleep(0.5)
    time.sleep(3); shown = s.evaluate('__geo.shown'); check('street map shown with coverage circles', shown and len(s.evaluate('__map.cover') or []) == 3)
    if SHOT: s.screenshot(path=f'{SHOT}/coverage-street.png')
    s.click('#tabPhones'); s.uncheck('#covOn'); s.click('#phones [data-close]'); time.sleep(0.5)
    check('circles can be switched off', s.evaluate('__map.cover') is None)
    check('no page errors', not errs, '; '.join(errs[:3]))
    bq.close(); bn.close()
print('ALL PASS' if all(res) else 'SOME FAILED')
