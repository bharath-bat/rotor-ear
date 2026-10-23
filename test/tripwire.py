# Tripwire lines. (1) geometry: segment crossing, direction, jitter next to a line doesn't fire. (2) the #demo with its default
# line (B–D diagonal) and "Alert only on tripwire crossing" on: no alert when the drone is confirmed, then one alert when it
# crosses, with the crossing point, direction and time in the status block and the log (and the report / JSON export).
# (3) circle path, a line it never crosses, toggle on: no alert, no beeps. (4) toggle off, a line through the circle: normal
# alert plus a tripwire alert. (5) drawing: tap two points on the plain map; delete; lines persist. (6) the same on the street
# map (one GPS phone, stub tiles): the line keeps lat/lon.   usage: [SHOTS=dir] python test/tripwire.py
import os, time, json, functools, threading, socketserver, http.server, struct, zlib
from multiprocessing import Pool
from playwright.sync_api import sync_playwright
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__))); SHOTS = os.environ.get('SHOTS'); WAV = os.path.join(ROOT, 'test', 'wav')
class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
PORT = 0
def png(w=256):
    rows = b''.join(b'\x00' + b''.join(bytes([200, 205, 210] if (x % 64 < 2 or y % 64 < 2) else [236, 234, 228]) for x in range(w)) for y in range(w))
    ch = lambda t, d: struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    return b'\x89PNG\r\n\x1a\n' + ch(b'IHDR', struct.pack('>IIBBBBB', w, w, 8, 2, 0, 0, 0)) + ch(b'IDAT', zlib.compress(rows)) + ch(b'IEND', b'')

def page(p, extra=None, ctx_kw=None):
    b = p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'] + (extra or []))
    c = b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, accept_downloads=True, **(ctx_kw or {})); pg = c.new_page(); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e))); pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
    return b, c, pg, errs
B = lambda: f'http://127.0.0.1:{PORT}/'
def fresh(pg, mute=True, only=False, lines=None, key='demo'):
    pg.goto(B() + '#screen')
    pg.evaluate("""([mute, only, lines, key]) => { localStorage.clear(); if (mute) localStorage.setItem('rotorear-mute-until', Date.now() + 6e5);
      localStorage.setItem('rotorear-trip-only', only ? '1' : '0'); if (lines) { localStorage.setItem('rotorear-trip-' + key, JSON.stringify(lines)); localStorage.setItem('rotorear-trip-demo-init', '1'); } }""", [mute, only, lines, key])
def tap(pg, x, y):  # world metres → a tap on the map canvas
    q = pg.evaluate('([x, y]) => __mapTap(x, y)', [x, y]); pg.mouse.click(q[0], q[1])

def geometry():
    R = []
    with sync_playwright() as p:
        b, c, pg, errs = page(p); pg.goto(B() + '#screen'); pg.evaluate('localStorage.clear()')
        g = pg.evaluate("""() => { const T = RotorTrip; T.use('unit'); T.lines.slice().forEach(l => T.remove(l.id));
          const L = T.add([0, -5], [0, 5], [-3, 0]), st = {}, out = {};
          out.hit = T.hit([-1, 0], [1, 0], [0, -5], [0, 5]); out.miss = T.hit([-1, 6], [1, 6], [0, -5], [0, 5]);
          out.jitter = [[-0.3, 0], [0.4, 0.1], [-0.2, 0.2], [0.42, -0.1], [-0.4, 0]].map(q => T.step(st, q).length).reduce((a, b) => a + b, 0);
          const s2 = {}; T.step(s2, [-2, 1]); out.cross = T.step(s2, [2, 1.5]).map(c => ({ pt: c.pt, dir: c.dir }));
          out.back = T.step(s2, [-2, 1]).map(c => c.dir); const s3 = {}; T.step(s3, [-2, 8]); out.outside = T.step(s3, [2, 8]).length; return out; }""")
        R.append(('segment crossing point', g['hit'] == [0, 0] and g['miss'] is None, str(g['hit'])))
        R.append(('jitter within 0.45 m of a line never fires', g['jitter'] == 0))
        R.append(('firm crossing → one crossing, out of the "in" side = OUT', g['cross'] == [{'pt': [0, 1.25], 'dir': 'out'}], str(g['cross'])))
        R.append(('crossing back = IN', g['back'] == ['in']))
        R.append(('passing beyond the end of the line: no crossing', g['outside'] == 0))
        R.append(('no page errors', not errs, str(errs[:2]))); b.close()
    return 'geometry', R

def demo_only():  # the scripted demo, its default line, "alert only on crossing" on
    R = []
    with sync_playwright() as p:
        b, c, pg, errs = page(p); fresh(pg, mute=False, only=True); pg.goto(B() + '#demo'); pg.reload(); t0 = time.time()
        conf = None; said = False
        while time.time() - t0 < 70:
            time.sleep(0.4); s = pg.evaluate('({s: __watch.s, a: __alert.count, h: __alert.held, b: __alert.beeps, tr: __alert.trips, last: __trip.last, pill: document.getElementById("pill").textContent, trip: document.getElementById("stTrip").textContent})')
            if s['s'] == 'drone' and conf is None: conf = dict(s); time.sleep(2); pre = pg.evaluate('({a: __alert.count, b: __alert.beeps, pill: document.getElementById("pill").textContent, trip: document.getElementById("stTrip").textContent})')
            said = said or (s['s'] == 'drone' and not s['last'] and 'Tripwire only' in s['pill'] and 'Tripwire only' in s['trip'])
            if s['last']: break
        lines = pg.evaluate('__trip.lines')
        R.append(('demo starts with its default tripwire line', len(lines) == 1, str(lines and lines[0]['a'])))
        R.append(('toggle on: drone confirmed silently (no alert, no beeps)', conf is not None and conf['a'] == 0 and conf['h'] >= 1 and pre['a'] == 0 and pre['b'] == 0, f"{conf['s'] if conf else ''} {pre if conf else ''}"))
        R.append(('…and it says so', said))
        time.sleep(0.6); s = pg.evaluate('({a: __alert.count, tr: __alert.trips, b: __alert.beeps, last: __trip.last, txt: document.getElementById("stTrip").textContent, flash: __alert.flashing})')
        L = s['last'] or {}
        R.append(('crossing → its own alert (flash + beeps)', s['a'] == 1 and s['tr'] == 1 and s['b'] >= 1 and s['flash'], f"alerts {s['a']} · trip alerts {s['tr']} · tones {s['b']} · {round(time.time() - t0)} s in"))
        R.append(('crossing has point, direction and time', L.get('dir') == 'out' and len(L.get('pt', [])) == 2 and L.get('t', 0) > 0 and L.get('name') == 'Line 1', str(L)))
        R.append(('status block shows it', 'TRIPWIRE · Line 1 crossed OUT' in s['txt'] and 'heading' in s['txt'], s['txt']))
        if SHOTS: pg.screenshot(path=os.path.join(SHOTS, 'tripwire-crossing-alert.png'))
        while pg.evaluate('__watch.s') in ('drone', 'tracking') and time.time() - t0 < 80: time.sleep(0.5)
        e = pg.evaluate('RotorLog.list.find(x => x.type === "drone")') or {}
        R.append(('log entry keeps the crossing', len(e.get('trips', [])) >= 1 and e['trips'][0]['dir'] == 'out' and e['trips'][0]['pt'] == L.get('pt'), str(e.get('trips'))))
        pg.click('#start'); time.sleep(0.4); pg.click('[data-go=screen]'); pg.click('#more'); pg.click('#mLog'); time.sleep(0.6)
        row = pg.inner_text('#logList'); R.append(('log row shows Tripwire Line 1 OUT', 'Tripwire Line 1 OUT' in row, row.replace('\n', ' ')[:120]))
        if SHOTS: pg.screenshot(path=os.path.join(SHOTS, 'log-entries-tripwire.png'))
        with pg.expect_download() as dl: pg.click('#lExport')
        j = json.load(open(dl.value.path())); R.append(('JSON export: crossings + the lines', any(x.get('trips') for x in j['incidents']) and 'tripwires' in j, ''))
        with c.expect_page() as rp: pg.click('#lReport')
        r = rp.value; r.wait_for_load_state(); html = r.content(); R.append(('printable report: "Tripwire: Line 1 crossed OUT"', 'Line 1 crossed OUT' in html))
        if SHOTS: r.set_viewport_size({'width': 800, 'height': 900}); r.screenshot(path=os.path.join(SHOTS, 'report-tripwire.png'), full_page=True)
        R.append(('no page errors', not errs, str(errs[:2]))); b.close()
    return 'demo · alert only on crossing', R

def circle(only):
    R = []; line = {'id': 'tx', 'n': 1, 'a': [3, -6], 'b': [3, 12], 'inS': 1, 'll': None} if not only else {'id': 'tf', 'n': 1, 'a': [25, -6], 'b': [25, 12], 'inS': 1, 'll': None}
    with sync_playwright() as p:
        b, c, pg, errs = page(p); fresh(pg, mute=False, only=only, lines=[line]); pg.goto(B() + '#demo&path=circle'); pg.reload(); t0 = time.time(); seen = 0
        while time.time() - t0 < 50:
            time.sleep(0.5); s = pg.evaluate('({s: __watch.s, a: __alert.count, tr: __alert.trips, b: __alert.beeps, h: __alert.held})')
            if s['s'] in ('drone', 'tracking'): seen += 0.5
            if not only and s['tr'] >= 1: break
            if only and seen >= 22: break
        if only:
            R.append(('drone tracked 20 s+, never crossing the line', seen >= 20, f'{seen} s'))
            R.append(('toggle on + no crossing → no alert, no beeps', s['a'] == 0 and s['tr'] == 0 and s['b'] == 0 and s['h'] >= 1, str(s)))
            R.append(('no crossing logged', not pg.evaluate('RotorLog.list.some(e => e.trips && e.trips.length)')))
        else:
            last = pg.evaluate('__trip.last') or {}
            R.append(('toggle off: normal alert, then a tripwire alert on crossing', s['a'] >= 2 and s['tr'] >= 1, str(s)))
            R.append(('direction given', last.get('dir') in ('in', 'out') and abs(last['pt'][0] - 3) < 0.01, str(last)))
        R.append(('no page errors', not errs, str(errs[:2]))); b.close()
    return 'circle · toggle ' + ('on, line far away' if only else 'off, line through the circle'), R

def drawing():
    R = []
    with sync_playwright() as p:
        b, c, pg, errs = page(p); fresh(pg); pg.goto(B() + '#demo&path=circle'); pg.reload(); time.sleep(2)
        n0 = len(pg.evaluate('__trip.lines'))
        pg.click('#tripBtn'); time.sleep(0.3)
        if pg.is_visible('#tripS'): pg.click('#tripAdd')
        R.append(('Tripwire button → draw mode', pg.is_visible('#tripDraw') and pg.evaluate('!!__trip.drawing')))
        tap(pg, -2, 8); time.sleep(0.3); R.append(('first tap: "tap the other end"', 'other end' in pg.inner_text('#tripDraw') and pg.evaluate('!!(__trip.drawing && __trip.drawing.a)')))
        if SHOTS: pg.screenshot(path=os.path.join(SHOTS, 'tripwire-drawing.png'))
        tap(pg, 8, 8); time.sleep(0.5); L = pg.evaluate('__trip.lines')
        R.append(('second tap adds the line', len(L) == n0 + 1 and abs(L[-1]['a'][0] + 2) < 0.6 and abs(L[-1]['b'][1] - 8) < 0.6 and not pg.is_visible('#tripDraw'), str(L[-1]['a']) + '→' + str(L[-1]['b'])))
        R.append(('"in" = the phones\' side', L[-1]['inS'] == pg.evaluate('([a, b]) => RotorTrip.side({a, b}, [3, 3]) > 0 ? 1 : -1', [L[-1]['a'], L[-1]['b']])))
        time.sleep(1)
        if SHOTS: pg.screenshot(path=os.path.join(SHOTS, 'map-with-tripwire.png'))
        pg.click('#tripBtn'); time.sleep(0.4); R.append(('with lines: the button opens the list', pg.is_visible('#tripS') and pg.locator('#tripList [data-del]').count() == n0 + 1))
        if SHOTS: pg.screenshot(path=os.path.join(SHOTS, 'tripwire-sheet.png'))
        pg.locator('#tripList [data-flip]').last.click(); R.append(('Flip in/out', pg.evaluate('__trip.lines').pop()['inS'] == -L[-1]['inS']))
        pg.reload(); time.sleep(2); R.append(('lines persist after a reload', len(pg.evaluate('__trip.lines')) == n0 + 1))
        pg.click('#tripBtn'); time.sleep(0.3); pg.locator('#tripList [data-del]').first.click(); time.sleep(0.2)
        R.append(('✕ deletes a line', len(pg.evaluate('__trip.lines')) == n0))
        R.append(('demo lines are separate from real ones', pg.evaluate("JSON.parse(localStorage.getItem('rotorear-trip-solo') || '[]').length") == 0))
        R.append(('no page errors', not errs, str(errs[:2]))); b.close()
    return 'drawing on the plain map', R

def street():
    R = []; TILE = png()
    with sync_playwright() as p:
        b, c, pg, errs = page(p, ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', f'--use-file-for-fake-audio-capture={WAV}/silence.wav'],
                              {'geolocation': {'latitude': 12.97633, 'longitude': 77.59295, 'accuracy': 4}, 'permissions': ['geolocation']})
        pg.route('**/tile.openstreetmap.org/**', lambda r: r.fulfill(status=200, content_type='image/png', body=TILE))
        fresh(pg); pg.evaluate("localStorage.setItem('rotorear-geomap', '1')"); pg.reload(); pg.click('#start'); time.sleep(0.5)
        pg.click('#tabPhones'); pg.check('#geoMe'); pg.click('#phones [data-close]'); t0 = time.time()
        while not pg.evaluate('__geo.shown') and time.time() - t0 < 20: time.sleep(0.5)
        time.sleep(1.5); R.append(('street map shown (one GPS phone)', pg.evaluate('__geo.shown')))
        pg.click('#tripBtn'); tap(pg, -4, 3); time.sleep(0.2); tap(pg, 4, 3); time.sleep(1.5); L = pg.evaluate('__trip.lines')
        R.append(('line drawn on the street map keeps lat/lon', len(L) == 1 and L[0]['ll'] and abs(L[0]['ll'][0][0] - 12.97633) < 0.001, str(L and L[0]['ll'])))
        R.append(('line stored per room (solo) on this phone', pg.evaluate("JSON.parse(localStorage.getItem('rotorear-trip-solo') || '[]').length") == 1))
        if SHOTS: pg.screenshot(path=os.path.join(SHOTS, 'street-map-tripwire.png'))
        R.append(('no page errors', not errs, str(errs[:2]))); b.close()
    return 'street map', R

def job(n): return {'g': geometry, 'd': demo_only, 'c1': lambda: circle(True), 'c0': lambda: circle(False), 'w': drawing, 's': street}[n]()
if __name__ == '__main__':
    srv = socketserver.ThreadingTCPServer(('127.0.0.1', 0), functools.partial(Quiet, directory=ROOT)); srv.daemon_threads = True
    PORT = srv.server_address[1]; threading.Thread(target=srv.serve_forever, daemon=True).start()
    if SHOTS: os.makedirs(SHOTS, exist_ok=True)
    with Pool(3) as P: out = P.map(job, ['d', 'c1', 'c0', 'g', 'w', 's'])
    ok = True
    for name, R in out:
        print(name)
        for t, good, *info in R: ok &= bool(good); print(f"  {'PASS' if good else 'FAIL'}  {t}{'  · ' + info[0] if info and info[0] else ''}")
    print('ALL PASS' if ok else 'SOME FAILED')
