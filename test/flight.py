# Flight-state test: plays each synthetic flight WAV through Chromium's fake mic into the watch post and
# samples the flight-state label twice a second (alerts muted, see below). usage: python test/flight.py [case ...]
import os, sys, time, functools, threading, socketserver, http.server
from multiprocessing import Pool
from playwright.sync_api import sync_playwright
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__))); WAV = os.path.join(ROOT, 'test', 'wav')
# case: (window to score [s from start], expected state, states that must NOT appear in that window)
EXPECT = {
    'fl_hover':    ((4, 15), 'Hovering', ('Climbing', 'Descending', 'Heavy / loaded', 'Maneuvering')),
    'fl_climb':    ((9, 15), 'Climbing', ('Descending', 'Hovering')),
    'fl_descend':  ((9, 15), 'Descending', ('Climbing', 'Hovering')),
    'fl_load':     ((10, 15), 'Heavy / loaded', ('Descending', 'Maneuvering')),
    'fl_flyby':    ((9, 13), 'Passing by (Doppler)', ('Climbing', 'Heavy / loaded')),
    'fl_maneuver': ((6, 15), 'Maneuvering', ('Heavy / loaded',)),
}
class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
def case(name):
    with sync_playwright() as p:
        b = p.chromium.launch(args=['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
            f'--use-file-for-fake-audio-capture={WAV}/{name}.wav', '--autoplay-policy=no-user-gesture-required'])
        pg = b.new_page(viewport={'width': 390, 'height': 844}); pg.goto(f'http://127.0.0.1:{PORT}/#screen')
        # alerts muted: an alert tone pauses detection for ~2 s at the drone's arrival, which would delay the hover baseline
        pg.evaluate("localStorage.setItem('rotorear-mute-until', Date.now() + 600000)"); pg.reload(); pg.click('#start')
        t0 = time.time(); seq = []
        while time.time() - t0 < 15.5:
            time.sleep(0.5); s = pg.evaluate('window.__rotor'); f = s.get('flight') or {}
            seq.append((round(time.time() - t0, 1), f.get('state') or '-', f.get('rpm'), f.get('rate')))
        b.close(); return name, seq
if __name__ == '__main__':
    srv = socketserver.ThreadingTCPServer(('127.0.0.1', 0), functools.partial(Quiet, directory=ROOT))
    PORT = srv.server_address[1]; threading.Thread(target=srv.serve_forever, daemon=True).start()
    names = sys.argv[1:] or list(EXPECT)
    with Pool(3) as pool: res = pool.map(case, names)
    ok_all = True; abbrev = lambda s: {'Hovering': 'H', 'Climbing': 'C', 'Descending': 'D', 'Heavy / loaded': 'L', 'Passing by (Doppler)': 'P', 'Maneuvering': 'M'}.get(s, '.')
    print(f"{'case':12s} {'scored window':14s} {'expected':22s} {'predicted in window':44s} result   timeline (0.5 s steps; H hover C climb D descend L loaded P passing M maneuver)")
    for name, seq in res:
        (a, z), exp, bad = EXPECT[name]
        win = [s for t, s, _, _ in seq if a <= t <= z]; n = len(win) or 1
        share = {k: round(100 * win.count(k) / n) for k in sorted(set(win), key=win.count, reverse=True)}
        top = max(share, key=share.get) if share else '-'
        ok = top == exp and share.get(exp, 0) >= 50 and not any(share.get(k, 0) > 20 for k in bad)
        ok_all &= ok
        rpm = [r for t, s, r, _ in seq if r and a <= t <= z]
        print(f"{name:12s} {f'{a}-{z} s':14s} {exp:22s} {', '.join(f'{k} {v}%' for k, v in share.items())[:44]:44s} {'PASS' if ok else 'FAIL'}     {''.join(abbrev(s) for _, s, _, _ in seq)}   rpm {min(rpm) if rpm else '-'}–{max(rpm) if rpm else '-'}")
    print('ALL PASS' if ok_all else 'SOME FAILED')
