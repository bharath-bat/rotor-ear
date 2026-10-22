# Mesh accuracy test over the real PeerJS relay: the screen (/#screen) hosts the room's map, demo phones (/#demo&room=…) run 3-4
# virtual phones that hear a virtual drone with real sound delays. Prints loudness-only vs arrival-time-only vs
# fused position error and heading error against the sim truth. With CAL=full|quick it then runs the watch post's
# clap calibration (pressing the demo phones' clap buttons when asked) and measures again.
# usage: [CAL=full] [SHOT=png] python test/mesh.py <circle|eight|line|hover> <3|4> <seconds per phase> ["&bias=30&gain=4&off=400&jit=1&speed=1"]
#        (static server on :5311)
import os, time, sys, random, statistics as stx
from playwright.sync_api import sync_playwright
room = 't' + ''.join(random.choice('abcdefghjkmnpqrstuvwxyz23456789') for _ in range(5))
path = sys.argv[1] if len(sys.argv) > 1 else 'circle'; N = sys.argv[2] if len(sys.argv) > 2 else '4'
dur = int(sys.argv[3]) if len(sys.argv) > 3 else 40; EXTRA = sys.argv[4] if len(sys.argv) > 4 else ''
CAL = os.environ.get('CAL', ''); BASE = 'http://127.0.0.1:5311/'
def col(errs, i): v = [e[i] for e in errs if e[i] is not None]; return f"{stx.mean(v):.2f}" if v else '—'
def measure(m, secs, skip, tag, shot=None):
    errs = []; t0 = time.time()
    while time.time() - t0 < secs:
        time.sleep(1); M = m.evaluate('window.__map')
        if os.environ.get('VERBOSE'): print(f"{tag} t={time.time() - t0:4.0f} n={M['nodes']} {M['banner']} errL={M.get('errL')} errT={M.get('errT')} errF={M.get('errF')} pairs={M.get('pairs')} tdoaOk={M.get('tdoaOk')} cal={M.get('calTrusted')}", flush=True)
        if time.time() - t0 > skip and M.get('errL') is not None:
            h = M.get('headErr') or {}; errs.append((M['errL'], M.get('errT'), M.get('errF'), h.get('both')))
        if shot and time.time() - t0 > secs - 2 and M.get('pairs'): m.screenshot(path=shot); shot = None
    return errs
with sync_playwright() as p:
    b = p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
    m = b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2).new_page(); logs = []
    m.on('pageerror', lambda e: logs.append('MAP ' + str(e)))
    m.goto(BASE + f'#screen&room={room}'); m.evaluate('localStorage.clear()'); time.sleep(4)
    s = b.new_context().new_page(); s.on('pageerror', lambda e: logs.append('SIM ' + str(e)))
    s.goto(BASE + f'#demo&room={room}&n={N}&path={path}' + EXTRA); s.click('#sStart')
    before = measure(m, dur, 15, 'before', None if CAL else os.environ.get('SHOT'))
    res = f"RESULT {path} n={N} {EXTRA or '(defaults)'}: loudness {col(before, 0)} m | arrival-times {col(before, 1)} m | fused {col(before, 2)} m | heading {col(before, 3)}°"
    if CAL:
        m.click('#tabPhones'); m.select_option('#cMode', CAL); m.click('#cStart'); time.sleep(0.5); claps = 0
        for _ in range(int(N) * 4):
            C = m.evaluate('window.__cal')
            if not C['active']: break
            k = C['k']; s.click('#clap' + C['spot']); claps += 1
            for _ in range(40):
                time.sleep(0.1); C2 = m.evaluate('window.__cal')
                if not C2['active'] or C2['k'] != k: break
        C = m.evaluate('window.__cal'); print('calibration:', C['msg'], f'({claps} claps)')
        for k, c in sorted(C['cal'].items()): print(f"   phone {k[:9]}: latency {c['lat']:+.1f} ms  gain {c['gain']:+.1f} dB  residual {c['resMs']} ms / {c['resDb']} dB")
        sim = s.evaluate("__sim.nodes.map(n => [n.key, +n.bias.toFixed(2), +n.gainDb.toFixed(2)])")
        mb = sum(x[1] for x in sim) / len(sim); mg = sum(x[2] for x in sim) / len(sim)
        print('   true (relative):', ', '.join(f"{k[:9]} {bb - mb:+.1f} ms {g - mg:+.1f} dB" for k, bb, g in sim))
        if os.environ.get('CALSHOT'): time.sleep(1); m.screenshot(path=os.environ['CALSHOT'])
        m.click('#phones [data-close]')
        after = measure(m, dur, 15, 'after', os.environ.get('SHOT'))
        res += f"\n   after {CAL} calibration: loudness {col(after, 0)} m | arrival-times {col(after, 1)} m | fused {col(after, 2)} m | heading {col(after, 3)}°"
    print(res); print('logs', logs[:6]); b.close()
