# Height guess. (1) The fit alone on synthetic passes at 5/15/30 m over a 6 m square of phones (0.5 dB loudness noise, with and
# without arrival times, 10 seeded runs each): error and whether the stated range holds the truth; phones in a line must say
# "height unknown". (2) The whole app: simulated passes at 5/15/30 m (path=pass, drone 20 dB louder so it is heard that high):
# the screen's height readings over 50 s. (3) The demo (4 m, climbing to 8 m): side-view strip, heights in the log track and report.
# Errors are printed as they are; the limits below are what this layout can honestly do.
# usage: [SHOT=dir] python test/height.py
import os, time, functools, threading, socketserver, http.server, statistics as stt
from multiprocessing import Pool
from playwright.sync_api import sync_playwright
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__))); SHOT = os.environ.get('SHOT'); PORT = 0
class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass

FIT = """([z, tdoa, seed, line]) => { let s0 = seed * 7919 + 17; const rnd = () => (s0 = (s0 * 16807) % 2147483647) / 2147483647, g = () => { let u = 0; for (let i = 0; i < 6; i++) u += rnd(); return (u - 3) * 1.41; };
  const ph = line ? [[0, 0], [3, 0], [6, 0], [9, 0]] : [[0, 0], [6, 0], [6, 6], [0, 6]], yd = line ? 0 : 2, S = [];
  for (let k = 0; k < 40; k++) { const t = k * 0.5, x = -14 + 4 * (t % 20 < 10 ? t % 20 : 20 - t % 20) * 0.85;
    const s = { t: k * 500, xy: [Math.min(6, Math.max(0, x)), yd], ph: ph.map((p, i) => [p[0], p[1], (-10 * Math.log10((x - p[0]) ** 2 + (yd - p[1]) ** 2 + z * z) + 0.5 * g()) / 10 * Math.LN10, 200, 'k' + i]), P: [] };
    if (tdoa) for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) s.P.push([ph[i], ph[j], (Math.hypot(x - ph[j][0], yd - ph[j][1], z) - Math.hypot(x - ph[i][0], yd - ph[i][1], z)) / 343 * 1000 + g() * 1.5, 1.5]);
    S.push(s); }
  return RotorMesh.heightFit(S); }"""

def live(alt):
    with sync_playwright() as p:
        b = p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required']); pg = b.new_page(viewport={'width': 390, 'height': 844}); errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.goto(f'http://127.0.0.1:{PORT}/#screen'); pg.evaluate("localStorage.clear(); localStorage.setItem('rotorear-mute-until', Date.now() + 6e5)")
        pg.goto(f'http://127.0.0.1:{PORT}/#demo&path=pass&alt={alt}&loud=20'); pg.reload(); out = []; t0 = time.time()
        while time.time() - t0 < 50:
            time.sleep(1)
            h = pg.evaluate("(() => { const t = (__map.tracks || []).find(t => t.hot && t.h && t.h.why !== 'measuring'); return t ? Object.assign({ err: t.herr }, t.h) : null; })()")
            if h and time.time() - t0 > 20: out.append(h)
        side = pg.evaluate("document.getElementById('sideT').textContent"); b.close()
    return alt, out, side, errs

def demo():
    with sync_playwright() as p:
        b = p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required']); pg = b.new_page(viewport={'width': 390, 'height': 844}); errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.goto(f'http://127.0.0.1:{PORT}/#screen'); pg.evaluate("localStorage.clear(); localStorage.setItem('rotorear-mute-until', Date.now() + 6e5)")
        pg.goto(f'http://127.0.0.1:{PORT}/#demo'); pg.reload(); seen = []; shot = False
        for i in range(40):
            time.sleep(1)
            r = pg.evaluate("(() => { const t = (__map.tracks || []).find(t => t.hot && t.h && t.h.ok); return { side: !document.getElementById('side').hidden, text: document.getElementById('sideT').textContent, h: t && t.h.z, err: t && t.herr }; })()")
            if r['h'] is not None: seen.append((i, r['h'], r['err'], r['side'], r['text']))
            if SHOT and not shot and r['h'] is not None and i >= 18: pg.screenshot(path=f'{SHOT}/height-side.png'); shot = True
        log = pg.evaluate("RotorLog.list.filter(e => e.type === 'drone').map(e => ({ h: e.h, n: e.track.length, nz: e.track.filter(p => p.length === 4).length }))")
        rep = pg.evaluate("RotorLog.report()"); b.close()
    return seen, log, '<th>Height</th>' in rep and '~' in rep.split('<th>Height</th>')[1], errs

if __name__ == '__main__':
    srv = socketserver.ThreadingTCPServer(('127.0.0.1', 0), functools.partial(Quiet, directory=ROOT)); srv.daemon_threads = True
    PORT = srv.server_address[1]; threading.Thread(target=srv.serve_forever, daemon=True).start(); ok = True
    def check(c, msg):
        global ok
        if not c: ok = False; print('   FAIL', msg)
    with Pool(4, initializer=globals().__setitem__, initargs=('PORT', PORT)) as pool:
        L = pool.map_async(live, [5, 15, 30]); Dm = pool.apply_async(demo)
        with sync_playwright() as p:
            b = p.chromium.launch(); pg = b.new_page(); pg.goto(f'http://127.0.0.1:{PORT}/#screen')
            print('(1) the fit alone, 10 noisy passes each   median |error|   range holds truth   said "unknown"')
            for z in (5, 15, 30):
                for td in (0, 1):
                    R = [pg.evaluate(FIT, [z, td, s, 0]) for s in range(10)]; K = [r for r in R if r['ok']]
                    e = [abs(r['z'] - z) for r in K]; hold = sum(r['lo'] - 0.5 <= z <= r['hi'] + 0.5 for r in K)
                    print(f"   {z:2d} m {'loudness + arrival' if td else 'loudness only     '}   {stt.median(e) if e else float('nan'):5.1f} m          {hold:2d}/{len(K):2d}               {10 - len(K):2d}/10")
                    if z <= 15: check(len(K) >= 8 and stt.median(e) <= (1 if z == 5 else 2.5), f'{z} m fit')
                    check(not K or hold >= len(K) * 0.6, f'{z} m range too narrow')
            R = [pg.evaluate(FIT, [8, 0, s, 1]) for s in range(5)]
            print('   phones in a line:', ', '.join(r['why'] if 'why' in r else '%.1f m' % r['z'] for r in R)); check(all(not r['ok'] for r in R), 'line must be unknown')
            b.close()
        print('(2) whole app, simulated pass 20–50 s   readings   median |error|   worst   range holds truth   unknown')
        for alt, out, side, errs in L.get():
            K = [h for h in out if h['ok'] and h['err'] is not None]; e = [abs(h['err']) for h in K]; hold = sum(h['lo'] - 0.5 <= h['z'] - h['err'] <= h['hi'] + 0.5 for h in K)
            print(f"   {alt:2d} m   {len(out):3d}        {stt.median(e) if e else float('nan'):5.1f} m       {max(e) if e else float('nan'):5.1f} m      {hold:2d}/{len(K):2d}            {len(out) - len(K):2d}   strip: {side!r}")
            check(not errs, f'{alt} m page errors {errs[:2]}'); check(len(out) >= 15, f'{alt} m too few readings')
            check(hold >= len(K) * 0.6, f'{alt} m: the shown range must hold the truth most of the time')
            if alt == 5: check(len(K) >= len(out) * 0.8 and stt.median(e) <= 2, '5 m live')
            if alt == 15: check(not K or stt.median(e) <= 6, '15 m live: unknown or within 6 m')
            if alt == 30: check(not K or stt.median(e) <= 10, '30 m live: unknown or within 10 m')
        seen, log, rep, errs = Dm.get()
        print('(3) demo (4 m, climbs to 8 m at 26–30 s):', ' '.join(f"{i}s:{h}m({'%+.1f' % er if er is not None else '?'})" for i, h, er, _, _ in seen[::3]))
        print('   strip:', seen[-1][4] if seen else None, '· log:', log, '· report height column:', rep)
        check(not errs, f'demo page errors {errs[:2]}'); check(seen and all(s[3] for s in seen), 'side strip shown with a height')
        check(seen and stt.median(abs(s[2]) for s in seen if s[2] is not None) <= 3, 'demo height error')
        check(log and log[0]['h'] and log[0]['nz'] >= 5, 'height in the log track'); check(rep, 'height in the report')
    print('ALL PASS' if ok else 'SOME FAILED')
