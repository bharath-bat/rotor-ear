# "Why (not) a drone": every synthetic sound gets the expected plain-words reason (from the six fingerprint numbers and the
# class match, or from what it sounded like when no fingerprint forms), Details shows it with one bar per feature against the
# drone range, it is logged with the incident, and the screen rebuilds the same reason from an ear's numbers (demo fan).
# usage: [SHOT=dir] python test/why.py
import os, time, functools, threading, socketserver, http.server
from multiprocessing import Pool
from playwright.sync_api import sync_playwright
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__))); WAV = os.path.join(ROOT, 'test', 'wav'); SHOT = os.environ.get('SHOT')
EXPECT = {'fan': ('fan', 'fan'), 'mains': ('mains', '50 Hz'), 'engine': ('engine', 'engine'), 'moto': ('engine', 'motorbike'), 'tone': ('tone', 'tone'),
          'white': ('noise', 'noise'), 'speech': ('voice', 'voice'), 'quad': ('quad', 'rotors'), 'quad_hi': ('quad', 'rotors'), 'fixed': ('fixed', 'propeller'), 'toy': ('micro', 'micro'), 'silence': (None, '')}
PORT = 0
class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass

def case(name):
    with sync_playwright() as p:
        b = p.chromium.launch(args=['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', f'--use-file-for-fake-audio-capture={WAV}/{name}.wav', '--autoplay-policy=no-user-gesture-required'])
        pg = b.new_page(viewport={'width': 390, 'height': 844}); errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.goto(f'http://127.0.0.1:{PORT}/#screen'); pg.evaluate("localStorage.clear(); localStorage.setItem('rotorear-mute-until', Date.now() + 6e5)"); pg.reload(); pg.click('#start')
        ids, text, shown = {}, '', {}
        for i in range(18):
            time.sleep(0.5)
            if i < 8: continue  # ~4 s: fingerprint window filled
            w = pg.evaluate('__rotor.why'); k = w and w['id']; ids[k] = ids.get(k, 0) + 1
            if w and w['id'] == EXPECT[name][0]: text = w['text']
        pg.click('#peek'); time.sleep(0.8)
        shown = pg.evaluate("({ head: document.getElementById('dWhyK').textContent, reason: document.getElementById('dReason').textContent, bars: document.querySelectorAll('#dBars .fb').length, off: [...document.querySelectorAll('#dBars .fb.off span')].map(e => e.textContent), peek: document.getElementById('peekS').textContent })")
        if SHOT and name in ('fan', 'moto'): pg.screenshot(path=f'{SHOT}/why-{name}.png')
        log = pg.evaluate('RotorLog.list.map(e => [e.type, e.why && e.why.id, e.why && e.why.text])')
        b.close()
    return name, ids, text, shown, log, errs

if __name__ == '__main__':
    srv = socketserver.ThreadingTCPServer(('127.0.0.1', 0), functools.partial(Quiet, directory=ROOT)); srv.daemon_threads = True
    PORT = srv.server_address[1]; threading.Thread(target=srv.serve_forever, daemon=True).start()
    with Pool(4, initializer=globals().__setitem__, initargs=('PORT', PORT)) as pool: res = pool.map(case, list(EXPECT))
    ok_all = True
    print(f"{'sound':10s} {'expected':9s} {'got (share of frames)':34s} reason")
    for name, ids, text, shown, log, errs in res:
        exp, word = EXPECT[name]; n = sum(ids.values()); top = max(ids, key=ids.get)
        ok = top == exp and ids[top] >= 0.7 * n and (word.lower() in text.lower()) and not errs
        if exp: ok = ok and shown['reason'] == text and shown['bars'] in (3, 6)
        if exp in ('fan', 'mains'): ok = ok and any(t == 'hum' and i == exp for t, i, _ in log) and shown['head'] == 'Why not a drone'
        if exp in ('quad', 'fixed', 'micro'): ok = ok and any(t == 'drone' and i == exp for t, i, _ in log) and shown['head'] == 'Why we think so'
        if exp in ('engine', 'tone', 'voice'): ok = ok and shown['head'] == 'Why not a drone' and (shown['peek'] == text or shown['peek'].startswith('live: pitch'))  # (or caught mid-check)
        ok_all &= ok
        print(f"{name:10s} {str(exp):9s} {', '.join(f'{k}:{v}/{n}' for k, v in ids.items()):34s} {'PASS' if ok else 'FAIL'}  \"{text}\"" + (f"  · bars outside the drone range: {shown['off']}" if exp else '') + (f'  errors {errs}' if errs else '') + ('' if ok else f'  {shown} {log}'))
    # the screen rebuilds the reason from an ear's numbers: the demo's fan near phone B (5–12 s) is ignored as a fan
    with sync_playwright() as p:
        b = p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required']); pg = b.new_page(viewport={'width': 390, 'height': 844})
        pg.goto(f'http://127.0.0.1:{PORT}/#screen'); pg.evaluate("localStorage.clear(); localStorage.setItem('rotorear-mute-until', Date.now() + 6e5)"); pg.goto(f'http://127.0.0.1:{PORT}/#demo'); pg.reload()
        t0, seen = time.time(), None
        while time.time() - t0 < 14 and not seen:
            time.sleep(0.4); m = pg.evaluate('({ s: __watch.s, why: __map.why })')
            if m['s'] == 'notdrone' and m['why']: seen = m['why']
        log = pg.evaluate("RotorLog.list.filter(e => e.type === 'hum').map(e => e.why && e.why.id)"); b.close()
    ok = bool(seen) and seen['id'] == 'fan' and 'fan' in log; ok_all &= ok
    print(f"demo fan (mesh: rebuilt from phone B's numbers) {'PASS' if ok else 'FAIL'}  {seen and seen['text']} · logged {log}")
    print('ALL PASS' if ok_all else 'SOME FAILED')
