# Alert test. 1) the alert beep, fed straight into the detector with the pause disabled, never reads as a drone;
# 2) a real DRONE onset (fake-mic quadcopter) flashes, beeps once, pauses detection during the beep, logs 🔔;
# 3) a second onset inside the 30 s cooldown flashes + logs but does not beep; mute silences it.
import os, time, functools, threading, socketserver, http.server
from playwright.sync_api import sync_playwright
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__))); WAV = os.path.join(ROOT, 'test', 'wav')
class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
srv = socketserver.ThreadingTCPServer(('127.0.0.1', 0), functools.partial(Quiet, directory=ROOT))
PORT = srv.server_address[1]; threading.Thread(target=srv.serve_forever, daemon=True).start()
ok = True
with sync_playwright() as p:
    def page(wav):
        b = p.chromium.launch(args=['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', f'--use-file-for-fake-audio-capture={WAV}/{wav}.wav', '--autoplay-policy=no-user-gesture-required'])
        pg = b.new_page(viewport={'width': 390, 'height': 844}); pg.goto(f'http://127.0.0.1:{PORT}/'); pg.evaluate('localStorage.clear()'); pg.reload(); return b, pg
    b, pg = page('silence'); pg.click('#start'); time.sleep(1.5)
    states = {}; mx = 0
    for k in range(40):  # 40 beeps over ~10 s straight into the detector input
        if k % 2 == 0: pg.evaluate("__alert.beepIntoDetector()")
        time.sleep(0.25); s = pg.evaluate('window.__rotor'); states[s['state']] = states.get(s['state'], 0) + 1; mx = max(mx, s['conf'])
    good = 'drone' not in states and 'some' not in states; ok &= good
    print(f"1) beep fed into the detector x20: states {states}, max confidence {mx}/100 → {'PASS (rejected)' if good else 'FAIL'}"); b.close()
    b, pg = page('quad'); pg.click('#start'); t0 = time.time(); gated = 0; frozen = True
    while time.time() - t0 < 8:
        time.sleep(0.1); a = pg.evaluate('({c: __alert.count, b: __alert.beeps, g: __alert.gated, st: __rotor.state})')
        if a['g']: gated += 1
    tl = pg.inner_text('#timeline'); good = a['b'] == 1 and a['c'] == 1 and '🔔' in tl and gated > 0; ok &= good
    print(f"2) quadcopter onset: alerts {a['c']}, beeps {a['b']}, detector paused for ~{gated * 100} ms during the beep, timeline: {tl.splitlines()[:4]} → {'PASS' if good else 'FAIL'}")
    pg.evaluate("__alert.fire('again')"); a = pg.evaluate('({c: __alert.count, b: __alert.beeps})'); good = a['b'] == 1 and a['c'] == 2; ok &= good
    print(f"3) second onset within cooldown: alerts {a['c']}, beeps still {a['b']} → {'PASS' if good else 'FAIL'}")
    pg.click('#bell'); pg.evaluate("__alert.fire('muted')"); a = pg.evaluate('({c: __alert.count, b: __alert.beeps, m: document.getElementById("bell").textContent})')
    good = a['b'] == 1 and a['m'] == '🔕'; ok &= good; print(f"4) muted ({a['m']}): beeps still {a['b']} → {'PASS' if good else 'FAIL'}"); b.close()
print('ALL PASS' if ok else 'SOME FAILED')
