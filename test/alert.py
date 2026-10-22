# Alert-flow test for the watch post state machine (Ready → Watching → Checking → DRONE → Got it → Lost → Watching).
# 1) every alert tone (alert / demo / lost), fed straight into the detector with the pause disabled, never reads as a drone;
# 2) a quadcopter: Checking holds 1.5 s, then DRONE: 3 flashes then a steady fill (no endless pulse), beep ×3, detector
#    paused during the beep, sheets close, 1 repeat beep after 10 s, Got it stops flashing and beeps but keeps tracking;
# 3) mute: shown in the status block with a countdown, flash still happens, no beeps, expires on its own;
# 4) lost: drone stops → Drone lost + one low tone; heard again within 60 s → DRONE without a new alert;
# 5) lost for over 60 s → Watching, the next drone is a new alert;  6) a fan → Not a drone for 5 s, then Watching, no alert;
# 7) "Loaded" (load step) is a word on the flight chip only: no extra alert.         usage: python test/alert.py
import os, time, functools, threading, socketserver, http.server, wave
from multiprocessing import Pool
import numpy as np
from playwright.sync_api import sync_playwright
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__))); WAV = os.path.join(ROOT, 'test', 'wav')
PORT = 0
class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass

def burst(name, on_s, off_s):  # the quadcopter recording for on_s seconds, then silence (Chromium's fake mic loops the file)
    with wave.open(f'{WAV}/quad.wav') as w: sr = w.getframerate(); x = np.frombuffer(w.readframes(w.getnframes()), np.int16)
    x = np.tile(x, int(np.ceil(on_s * sr / len(x))))[:int(on_s * sr)].astype(np.float32); x[-int(0.2 * sr):] *= np.linspace(1, 0, int(0.2 * sr))
    y = np.concatenate([x, np.zeros(int(off_s * sr), np.float32)]).astype(np.int16)
    with wave.open(f'{WAV}/{name}.wav', 'wb') as w: w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr); w.writeframes(y.tobytes())

def page(p, wav):
    b = p.chromium.launch(args=['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', f'--use-file-for-fake-audio-capture={WAV}/{wav}.wav', '--autoplay-policy=no-user-gesture-required'])
    pg = b.new_page(viewport={'width': 390, 'height': 844}); pg.goto(f'http://127.0.0.1:{PORT}/#screen'); pg.evaluate('localStorage.clear()'); pg.reload(); return b, pg
W = lambda pg: pg.evaluate('({s: __watch.s, k: __watch.holdK, c: __alert.count, b: __alert.beeps, t: __alert.tones.join(), g: __alert.gated, f: __alert.flashing, m: __alert.muted, pill: document.getElementById("pill").textContent, anim: getComputedStyle(document.getElementById("status")).animationIterationCount, fl: (__rotor.flight || {}).state})')
def until(pg, cond, secs, step=0.1):
    t0 = time.time(); seen = []
    while time.time() - t0 < secs:
        a = W(pg); seen.append(a)
        if cond(a): return a, seen
        time.sleep(step)
    return None, seen

def t_tones():
    with sync_playwright() as p:
        b, pg = page(p, 'silence'); pg.click('#start'); time.sleep(1.5); states = {}; mx = 0
        for k in range(42):
            if k % 2 == 0: pg.evaluate(f"__alert.beepIntoDetector('{['alert', 'demo', 'lost'][k // 2 % 3]}')")
            time.sleep(0.25); s = pg.evaluate('window.__rotor'); states[s['state']] = states.get(s['state'], 0) + 1; mx = max(mx, s['conf'])
        b.close()
    ok = 'drone' not in states and 'some' not in states
    return ok, f"1) alert/demo/lost tones ×21 straight into the detector: states {states}, max score {mx}/100 → {'PASS (rejected)' if ok else 'FAIL'}"

def t_alert():
    with sync_playwright() as p:
        b, pg = page(p, 'quad'); pg.click('#start'); pg.click('#tabPhones')  # a sheet is open when the drone arrives (Teach stays open by design)
        a, seen = until(pg, lambda a: a['s'] == 'drone', 15, 0.05)
        chk = [x for x in seen if x['s'] == 'checking']; hold_max = max([x['k'] for x in chk] or [0])
        sheet_closed = pg.evaluate("document.getElementById('phones').hidden")
        _, s2 = until(pg, lambda a: False, 2.2, 0.1); flashed = any(x['f'] for x in s2[:5]); steady = not s2[-1]['f'] and s2[-1]['anim'] != 'infinite' and s2[-1]['s'] == 'drone'
        gated = any(x['g'] for x in s2); b0 = s2[-1]['b']
        r, _ = until(pg, lambda a: a['b'] > b0, 11.5, 0.2); repeat = r is not None
        pg.evaluate('__watch.ack()'); time.sleep(0.3); tr = W(pg); b1 = tr['b']
        time.sleep(11); after = W(pg)
        pg.click('#peek'); time.sleep(0.6); tl = pg.inner_text('#tlList')
        b.close()
    ok = bool(chk) and hold_max > 0.5 and a and a['c'] == 1 and a['t'].startswith('alert') and flashed and steady and gated and sheet_closed and repeat and tr['s'] == 'tracking' and after['b'] == b1 and after['s'] == 'tracking' and not after['f'] and 'Quadcopter' in tl and 'real' in tl
    return ok, (f"2) quadcopter: Checking first (hold reached {hold_max:.2f} of 1.5 s) → DRONE · alerts {a and a['c']} · tone {a and a['t']} ×3 · flashed {flashed} then steady {steady} (animation-iteration-count {s2[-1]['anim']}) · "
                f"detector paused {gated} · open sheet closed {sheet_closed} · repeat beep at 10 s {repeat} · Got it → {tr['s']}, beeps {b1} → {after['b']} over 11 s, flashing {after['f']} · timeline row: {tl.splitlines()[:5]} → {'PASS' if ok else 'FAIL'}")

def t_mute():
    with sync_playwright() as p:
        b, pg = page(p, 'quad'); pg.click('#more'); pg.click('#mMute'); pg.click('#moreS [data-close]'); pg.click('#start'); time.sleep(0.3); m = W(pg)
        a, _ = until(pg, lambda a: a['s'] == 'drone', 15, 0.05); time.sleep(0.2); x = W(pg)
        act = pg.inner_text('#act1'); pg.evaluate('__alert.expireMute()'); time.sleep(0.3); y = W(pg); b.close()
    ok = m['m'] and m['pill'].startswith('MUTED · flash only · ') and x['f'] and x['b'] == 0 and x['pill'].startswith('MUTED') and 'Unmute' in act and not y['m'] and 'MUTED' not in y['pill']
    return ok, f"3) mute: pill '{m['pill']}' · at DRONE flashing {x['f']}, beeps {x['b']}, action '{act.splitlines()[0]}' · after expiry muted {y['m']}, pill '{y['pill']}' → {'PASS' if ok else 'FAIL'}"

def t_lost_back():
    burst('alert_back', 12, 24)
    with sync_playwright() as p:
        b, pg = page(p, 'alert_back'); pg.click('#start')
        a, _ = until(pg, lambda a: a['s'] == 'drone', 15); l, _ = until(pg, lambda a: a['s'] == 'lost', 20); lt = l and l['t']
        bk, seen = until(pg, lambda a: a['s'] == 'drone', 40, 0.25); time.sleep(1); z = W(pg); b.close()
    ok = a and l and bk and lt.endswith('lost') and z['c'] == 1 and z['t'] == lt and not z['f']
    if os.environ.get('VERBOSE'): print(lt, z)
    return ok, f"4) drone stops → {l and l['s']} with tones [{lt}] · heard again {'' if bk is None else 'within 60 s'} → {bk and bk['s']}, alerts still {bk and bk['c']}, no new flash/alert tone → {'PASS' if ok else 'FAIL'}"

def t_lost_gone():
    burst('alert_gone', 10, 70)
    with sync_playwright() as p:
        b, pg = page(p, 'alert_gone'); pg.click('#start')
        until(pg, lambda a: a['s'] == 'drone', 15); l, _ = until(pg, lambda a: a['s'] == 'lost', 20, 0.05); t0 = time.time()
        g, _ = until(pg, lambda a: a['s'] == 'watching', 70, 0.5); dt = time.time() - t0
        n, _ = until(pg, lambda a: a['c'] == 2, 20, 0.25); b.close()
    ok = l and g and 58 < dt < 64 and n is not None
    return ok, f"5) lost for {dt:.0f} s → {g and g['s']} · next drone is a new alert (alerts {n and n['c']}) → {'PASS' if ok else 'FAIL'}"

def t_fan():
    with sync_playwright() as p:
        b, pg = page(p, 'fan'); pg.click('#start')
        n, _ = until(pg, lambda a: a['s'] == 'notdrone', 10); cls = pg.inner_text('#stCls')
        w, seen = until(pg, lambda a: a['s'] == 'watching', 8, 0.2); time.sleep(4); last = W(pg); sub = pg.inner_text('#stSub'); b.close()
    ok = n and w and last['s'] == 'watching' and last['c'] == 0 and last['b'] == 0
    return ok, f"6) fan: '{cls}' → back to {w and w['s']} after ~5 s while the fan keeps running ('{sub}'), alerts {last['c']}, beeps {last['b']} → {'PASS' if ok else 'FAIL'}"

def t_loaded():
    with sync_playwright() as p:
        b, pg = page(p, 'fl_load'); pg.evaluate("localStorage.setItem('rotorear-mute-until', Date.now() + 600000)"); pg.reload(); pg.click('#start'); seen = []  # muted, as in flight.py
        t0 = time.time()
        while time.time() - t0 < 22: seen.append(W(pg)); time.sleep(0.25)
        b.close()
    heavy = any(x['fl'] == 'Heavy / loaded' for x in seen); ok = heavy and seen[-1]['c'] == 1
    if os.environ.get('VERBOSE'): print([(x['s'], x['fl']) for x in seen[::4]])
    return ok, f"7) load step: flight chip showed 'Loaded' {heavy}, alerts {seen[-1]['c']} (only the drone itself) → {'PASS' if ok else 'FAIL'}"

def run(name): return globals()[name]()
if __name__ == '__main__':
    srv = socketserver.ThreadingTCPServer(('127.0.0.1', 0), functools.partial(Quiet, directory=ROOT))
    PORT = srv.server_address[1]; threading.Thread(target=srv.serve_forever, daemon=True).start()
    with Pool(4, initializer=globals().__setitem__, initargs=('PORT', PORT)) as pool:
        res = pool.map(run, ['t_tones', 't_alert', 't_mute', 't_lost_back', 't_lost_gone', 't_fan', 't_loaded'])
    for ok, msg in res: print(msg)
    print('ALL PASS' if all(ok for ok, _ in res) else 'SOME FAILED')
