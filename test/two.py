# Two drones at once.
# 1) one phone, test/wav/two.wav (quads at ~182 and ~258 Hz whose loudness crosses over): the detector reports two drone
#    sources with their own ids, a steady pitch each, a class each; the screen alerts once per drone and logs two incidents.
# 2) the #demo&path=two scenario (4 simulated phones, two drones on crossing diagonals, the second shows up 10 s in): two
#    map tracks at once, each near one true drone, drawn in two colours; two alerts, two incidents.
# usage: [SHOT=dir] python test/two.py   (single-drone behaviour is covered by run.py, which fails on any second drone)
import os, time, statistics as stx, threading, functools, http.server, socketserver
from playwright.sync_api import sync_playwright
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__))); WAV = os.path.join(ROOT, 'test', 'wav'); SHOT = os.environ.get('SHOT')
class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
srv = socketserver.ThreadingTCPServer(('127.0.0.1', 0), functools.partial(Quiet, directory=ROOT)); PORT = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()
ok_all = True
def check(name, ok, info=''):
    global ok_all; ok_all &= bool(ok); print(f"  {'PASS' if ok else 'FAIL'}  {name}{'  · ' + info if info else ''}")

def solo(p):
    print('one phone · two.wav')
    b = p.chromium.launch(args=['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', f'--use-file-for-fake-audio-capture={WAV}/two.wav', '--autoplay-policy=no-user-gesture-required'])
    pg = b.new_page(viewport={'width': 390, 'height': 844}); errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto(f'http://127.0.0.1:{PORT}/#screen'); pg.evaluate('localStorage.clear()'); pg.reload(); pg.click('#start')
    seen, both = {}, 0
    for i in range(56):  # 28 s: the 16 s file plays almost twice (Chromium loops it)
        time.sleep(0.5); s = pg.evaluate('window.__rotor'); dr = [q for q in s['srcs'] if q['state'] == 'drone' and q['f0']]
        for q in dr: seen.setdefault(q['id'], []).append((q['f0'], q['cls'], q['fl']))
        if len(dr) == 2: both += 1
    M = pg.evaluate('({alerts: __map.alerts, inc: RotorLog.list.filter(e => e.type === "drone").map(e => [e.slot, e.f0, e.cls])})')
    ids = {k: v for k, v in seen.items() if len(v) >= 4}  # a source heard as a drone for 2 s or more
    pitch = {k: stx.median(f for f, _, _ in v) for k, v in ids.items()}
    print('   drone sources:', {k: f"{pitch[k]:.0f} Hz × {len(v)} frames, {stx.mode(c for _, c, _ in v)}" for k, v in ids.items()}, '· both at once', both / 2, 's')
    fs = sorted(pitch.values()); check('two separate drone sources, > 8% apart', len(fs) >= 2 and fs[-1] / fs[0] > 1.08, f'{len(fs)} sources')
    check('both heard at the same time for 2 s+', both >= 4)
    check('each keeps a steady pitch (±5%)', all(max(abs(f - pitch[k]) / pitch[k] for f, _, _ in v) < 0.05 for k, v in ids.items()))
    check('each is classed a quadcopter', all(stx.mode(c for _, c, _ in v) == 'Quadcopter' for v in ids.values()))
    check('each gets a flight state', all(any(fl for _, _, fl in v) for v in ids.values()))
    check('one alert per drone', M['alerts'] >= 2, f"{M['alerts']} alerts")
    check('one incident per drone, two colours', len(M['inc']) >= 2 and {e[0] for e in M['inc']} == {0, 1}, str(M['inc']))
    check('no page errors', not errs, '; '.join(errs[:2])); b.close()

def demo(p):
    print('demo · two drones crossing (4 simulated phones)')
    b = p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
    pg = b.new_page(viewport={'width': 390, 'height': 844}, device_scale_factor=2); errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto(f'http://127.0.0.1:{PORT}/#screen'); pg.evaluate('localStorage.clear()'); pg.goto(f'http://127.0.0.1:{PORT}/#demo&path=two'); pg.reload()
    both, err, cols, shot = 0, {0: [], 1: []}, set(), None
    for i in range(44):
        time.sleep(1); M = pg.evaluate('__map'); hot = [t for t in M['tracks'] if t['hot'] and t['est']]
        for t in hot:
            if t['err'] is not None and i > 6: err[t['slot']].append(t['err'])
        if len({t['slot'] for t in hot}) == 2:
            both += 1; d = ((hot[0]['est'][0] - hot[1]['est'][0]) ** 2 + (hot[0]['est'][1] - hot[1]['est'][1]) ** 2) ** 0.5
            if SHOT and not shot and both >= 3 and d > 3: pg.screenshot(path=f'{SHOT}/two-tracks.png'); shot = pg.evaluate('document.getElementById("stWord").textContent')  # apart, not mid-crossing
            if both == 6:  # colours on the map canvas: pixels near the first (#FF5A1F) and second (#3DA9FC) drone colours
                cols = set(pg.evaluate("""(() => { const c = document.getElementById('map'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data, n = [0, 0];
                  for (let i = 0; i < d.length; i += 4) { if (Math.abs(d[i] - 255) + Math.abs(d[i + 1] - 90) + Math.abs(d[i + 2] - 31) < 60) n[0]++; if (Math.abs(d[i] - 61) + Math.abs(d[i + 1] - 169) + Math.abs(d[i + 2] - 252) < 60) n[1]++; }
                  return n.map((v, k) => v > 200 ? k : -1).filter(k => k >= 0); })()"""))

    L = pg.evaluate('RotorLog.list.filter(e => e.type === "drone").map(e => [e.slot, e.f0, e.track.length, e.agree])'); A = pg.evaluate('__map.alerts')
    md = {k: (round(stx.median(v), 2) if v else None) for k, v in err.items()}
    print('   both tracks up', both, 's · median error vs the nearer true drone', md, '· incidents', L, '· status', shot)
    check('two tracks at once for 6 s+', both >= 6)
    check('each track sits near a true drone (median < 2.5 m)', all(v is not None and v < 2.5 for v in md.values()))
    check('drawn in two colours', cols == {0, 1}, str(sorted(cols)))
    check('one alert per drone', A >= 2, f'{A} alerts')
    check('one incident per drone', len(L) >= 2 and {e[0] for e in L} == {0, 1} and all(e[2] > 5 for e in L))
    check('no page errors', not errs, '; '.join(errs[:2])); b.close()

with sync_playwright() as p: solo(p); demo(p)
print('ALL PASS' if ok_all else 'SOME FAILED')
