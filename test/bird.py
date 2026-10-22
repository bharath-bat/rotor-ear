# Bird or Bot on synthetic camera clips (test/gen_video.py → test/video/*.y4m, fed to Chromium as the fake camera).
# A) Live: an ear is asked to look (__node.look.show), records 10 s; its verdict on the clip, with the image check blocked
#    (motion + sound only) and allowed (COCO-SSD from the CDN; skipped honestly if it can't load). Mic: silent (no rotor hum),
#    the quad recording (rotor hum) or off. Prints the confusion table.
# B) Re-analyse a saved clip from the ear's log.
# C) Over the real PeerJS relay (like camera.py): a demo drone, the asked ear films a bird (then a drone) → the screen shows the chip,
#    the alert says LIKELY A BIRD without being dismissed, repeat beeps stop, log row + report carry it, messages stay small.
# usage: [SHOTS=dir] [QUICK=1] python test/bird.py
import os, time, random, functools, threading, socketserver, http.server
from playwright.sync_api import sync_playwright
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__))); SHOTS = os.environ.get('SHOTS'); V = ROOT + '/test/video/'
class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
srv = socketserver.ThreadingTCPServer(('127.0.0.1', 0), functools.partial(Quiet, directory=ROOT)); srv.daemon_threads = True
threading.Thread(target=srv.serve_forever, daemon=True).start(); B = f'http://127.0.0.1:{srv.server_address[1]}/'
rid = lambda p: p + ''.join(random.choice('abcdefghjkmnpqrstuvwxyz23456789') for _ in range(5))
res = []; errs = []
def check(name, ok, info=''): res.append(bool(ok)); print(f"{'PASS' if ok else 'FAIL'}  {name}  {info}", flush=True)
def shot(pg, name):
    if SHOTS and name: pg.screenshot(path=os.path.join(SHOTS, name))
SPY = """(() => { const o = RTCDataChannel.prototype.send; window.__sent = [];
  RTCDataChannel.prototype.send = function (d) { const s = typeof d === 'string' ? d : null; window.__sent.push({ size: s ? s.length : (d.byteLength || d.size || 0) }); return o.call(this, d); }; })()"""
ARGS = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required']
TRUTH = {'bird_flap': 'bird', 'bird_glide': 'bird', 'drone_hover': 'bot', 'drone_drift': 'bot', 'sky': 'none'}
VERDICT = "() => RotorClips.all().then(a => a[0] && { v: a[0].bob.v, c: a[0].bob.c, r: a[0].bob.r, f: a[0].bob.f, h: a[0].bob.h, a: a[0].bob.a, model: a[0].model, n: a[0].F.n, text: RotorBird.text(a[0].bob), id: a[0].id })"

def ear(p, clip, mic, model, shots=None, reanalyse=False):
    wav = ROOT + '/test/wav/' + ('quad.wav' if mic == 'quad' else 'silence.wav')
    b = p.chromium.launch(args=ARGS + [f'--use-file-for-fake-video-capture={V}{clip}.y4m', f'--use-file-for-fake-audio-capture={wav}'])
    c = b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2)
    if not model: c.route('**/cdn.jsdelivr.net/**', lambda r: r.abort())
    e = c.new_page(); e.on('pageerror', lambda x: errs.append(f'{clip} {x}'))
    e.goto(B + f'#ear&room={rid("b")}')
    if mic != 'off': e.click('#nStart')
    e.evaluate("__node.look.show({ id: 'i1', t0: Date.now(), cls: 'Quadcopter', w: 'up and to the left' })")
    t = time.time()
    while time.time() - t < 20 and e.evaluate("RotorBird.Check.state") == 'loading': time.sleep(0.3)  # you take a few seconds to aim
    time.sleep(max(0, 3 - (time.time() - t)))  # and the ear has heard a few seconds by then
    e.click('#lookRec')
    if shots: time.sleep(6); e.evaluate("scrollTo(0, 0)"); shot(e, shots[0])
    t = time.time()
    while time.time() - t < 25 and not e.evaluate("__node.look.state.done"): time.sleep(0.4)
    r = e.evaluate(VERDICT) or {}
    r['card'] = e.evaluate("__node.look.state.bob") and e.inner_text('#bob')
    if shots: e.evaluate("document.getElementById('bob').scrollIntoView({ block: 'start' })"); time.sleep(0.3); shot(e, shots[1])
    if reanalyse:
        e.evaluate("document.getElementById('earLog').scrollIntoView()"); e.click(f"[data-re='{r['id']}']"); t = time.time()
        time.sleep(1)
        while time.time() - t < 25 and e.evaluate(f"document.querySelector(\"[data-re='{r['id']}']\").disabled"): time.sleep(0.4)
        r['re'] = e.evaluate(VERDICT); r['logline'] = e.inner_text('#eLogList .bobline') if e.query_selector('#eLogList .bobline') else ''
        r['logrow'] = e.inner_text('#eLogList .lrow') if e.query_selector('#eLogList .lrow') else ''
        if shots: e.evaluate("document.getElementById('earLog').scrollIntoView()"); time.sleep(0.3); shot(e, shots[2])
    b.close(); return r

def relay(p, clip):  # a demo drone over the real relay; the asked ear films `clip`
    want = TRUTH[clip]; W = {'bird': 'Bird', 'bot': 'Bot'}[want]; tag = f'relay {clip}:'
    room = rid('r'); b = p.chromium.launch(args=ARGS + [f'--use-file-for-fake-video-capture={V}{clip}.y4m', f'--use-file-for-fake-audio-capture={ROOT}/test/wav/silence.wav'])
    sc = b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2); s = sc.new_page(); s.on('pageerror', lambda x: errs.append('screen ' + str(x)))
    s.goto(B + '#screen'); s.evaluate("localStorage.clear()"); s.goto(B + f'#screen&room={room}'); s.reload(); time.sleep(3)
    sim = b.new_context().new_page(); sim.goto(B + f'#demo&room={room}&n=4&path=hover'); sim.click('#sStart')
    ears = {}
    for name in ['Ana', 'Bo']:
        c = b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2); c.add_init_script(SPY); c.route('**/cdn.jsdelivr.net/**', lambda r: r.abort())
        e = c.new_page(); e.on('pageerror', lambda x, n=name: errs.append(n + ' ' + str(x)))
        e.goto(B + f'#ear&room={room}'); e.fill('#nName', name); e.dispatch_event('#nName', 'change'); e.click('#nStart'); ears[name] = e
    t0 = time.time()
    while time.time() - t0 < 60 and not any(e.evaluate('__node.look.state.shown') for e in ears.values()): time.sleep(0.5)
    asked = [n for n, e in ears.items() if e.evaluate('__node.look.state.shown')]
    check(f'{tag} screen confirms and asks one ear to look', len(asked) == 1, f'{asked} after {time.time() - t0:.0f} s')
    if not asked: b.close(); return
    e = ears[asked[0]]; time.sleep(1); e.click('#lookRec'); t = time.time()
    while time.time() - t < 25 and not e.evaluate("__node.look.state.done"): time.sleep(0.4)
    t = time.time()
    while time.time() - t < 10 and not s.evaluate("__log.inc && __log.inc.bob && !document.getElementById('stBob').hidden"): time.sleep(0.3)  # verdict in, and the next frame has drawn it
    q = "() => ({ bob: __log.inc && __log.inc.bob, watch: __map.watch, word: document.getElementById('stWord').textContent, chip: document.getElementById('stBob').innerText, pill: document.getElementById('pill').textContent, beeps: __alert.beeps })"
    st = s.evaluate(q); ev = e.evaluate(VERDICT)
    check(f"{tag} the screen gets the ear's verdict (numbers + codes only)", st['bob'] and st['bob']['v'] == ev['v'] == want and set(st['bob']) == {'v', 'c', 'r', 'f', 'h', 'a', 'phone'}, f"{st['bob']}")
    hot = st['watch'] in ('drone', 'tracking'); says = 'LIKELY A BIRD' in st['word']
    check(f"{tag} {W} chip on the drone status · " + ('alert says LIKELY A BIRD, not dismissed' if want == 'bird' else 'alert stays DRONE'), hot and W in st['chip'] and says == (want == 'bird') and ('DRONE' in st['word']) != says, f"\"{st['word']}\" · {st['chip']} · {st['pill']} · state {st['watch']}")
    s.evaluate("scrollTo(0, 0)"); shot(s, f'screen-{want}-chip.png')
    time.sleep(12); b2 = s.evaluate(q)
    if want == 'bird': check(f'{tag} no repeat beeps after a confident bird (still on screen)', b2['beeps'] == st['beeps'] and b2['watch'] in ('drone', 'tracking'), f"beeps {st['beeps']} → {b2['beeps']} over 12 s · state {b2['watch']}")
    else: check(f'{tag} repeat beeps carry on for a bot', b2['beeps'] > st['beeps'], f"beeps {st['beeps']} → {b2['beeps']} over 12 s")
    s.evaluate("document.getElementById('openLog').click()"); time.sleep(1)
    row = s.inner_text('#logList .lrow'); rep = s.evaluate("RotorLog.report()")
    check(f'{tag} log row and report carry the verdict', W in row and f'Camera: {"🐦" if want == "bird" else "🤖"} {W}' in rep, row.replace('\n', ' | '))
    shot(s, f'screen-{want}-log-entry.png')
    for n, x in ears.items():
        sent = x.evaluate('__sent'); big = max(m['size'] for m in sent)
        check(f'{tag} {n} sent only small messages (no video)', sent and big < 2000, f"{len(sent)} messages, max {big} B")
    b.close()

with sync_playwright() as p:
    quick = os.environ.get('QUICK')
    # ---- A) live verdicts ----
    table = {}
    for model in ([True] if quick else [False, True]):
        for clip in TRUTH:
            first = model and clip == 'bird_flap'
            r = ear(p, clip, 'silent', model, shots=['ear-analysing-bird.png', 'verdict-bird.png', 'ear-log-entry.png'] if first else ['', 'verdict-bot.png'] if model and clip == 'drone_hover' else None, reanalyse=first)
            if model and r.get('model') != 'ready': print(f'NOTE  image check did not load for {clip} ({r.get("model")}): motion only')
            ok = r.get('v') == TRUTH[clip]; table[(model, clip)] = r.get('v')
            check(f"{'with image check' if model else 'motion only'} · {clip} → {TRUTH[clip]}", ok, f"{r.get('v')} {r.get('c')}% {r.get('r')} · image {r.get('a')} ({r.get('model')}) · {r.get('n')} frames · \"{r.get('text')}\"")
            check(f"  verdict card shown with the evidence rows", r.get('card') and 'Wing beat' in r['card'] and 'Image check' in r['card'] and ('motion only' in r['card'] or model), (r.get('card') or '').replace('\n', ' | ')[:160])
            if first:
                re_ = r.get('re') or {}
                check('re-analyse the saved clip from the log', re_.get('v') == r.get('v'), f"live {r.get('v')} {r.get('c')}% {r.get('r')} → re-analysed {re_.get('v')} {re_.get('c')}% {re_.get('r')} ({re_.get('n')} frames)")
                check('  the log shows the verdict on the clip and the incident', 'Bird' in r.get('logline', '') and 'Bird' in r.get('logrow', ''), f"{r.get('logline')} | {r.get('logrow')}")
    # fused with what the ear heard
    for clip, mic, want, why in ([] if quick else [('drone_drift', 'quad', 'bot', 'rotor hum adds to a straight steady path'), ('bird_glide', 'quad', 'none', 'bird-like motion but a rotor hum: clash'), ('bird_flap', 'off', 'bird', 'mic off: wing beat alone')]):
        r = ear(p, clip, mic, False)
        check(f"fused · {clip} + mic {mic} → {want} ({why})", r.get('v') == want, f"{r.get('v')} {r.get('c')}% {r.get('r')} h={r.get('h')} · \"{r.get('text')}\"")
    print('\nconfusion (rows: truth · columns: verdict)')
    for model in ([True] if quick else [False, True]):
        print('  ' + ('with image check' if model else 'motion + sound only'))
        print('    truth \\ said   Bird  Bot  Can\'t tell')
        for t in ['bird', 'bot', 'none']:
            row = [sum(1 for (m, c), v in table.items() if m == model and TRUTH[c] == t and v == x) for x in ['bird', 'bot', 'none']]
            print(f"    {({'bird': 'bird', 'bot': 'drone', 'none': 'empty sky'})[t]:<14} {row[0]:>4} {row[1]:>4} {row[2]:>6}")
    # ---- C) relay: screen chip + downgrade (bird), chip and normal alert (bot) ----
    for clip in ['bird_flap'] + ([] if quick else ['drone_hover']):
        relay(p, clip)
    check('no page errors', not errs, str(errs[:3]))
print('ALL PASS' if all(res) else 'FAIL')
