# Camera confirm over the real PeerJS relay: the screen hosts a room, demo phones (/#demo&room=…) hear a virtual drone,
# two real ears (fake camera + silent fake mic) join. When the screen confirms, the ear nearest the estimate gets
# "Look this way"; one tap records a ~10 s rear-camera clip into that phone's IndexedDB. Checks: only the nearest ear is
# asked, the clip is stored on the ear and shows in its log, the screen's incident gets a "clip saved" flag, and the ear
# never sends anything but small messages (PeerJS packs them as binary; each < 2 kB, no video, no audio) over the mesh.
# usage: [SHOTS=dir] python test/camera.py
import os, time, json, random, functools, threading, socketserver, http.server
from playwright.sync_api import sync_playwright
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__))); SHOTS = os.environ.get('SHOTS')
class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
srv = socketserver.ThreadingTCPServer(('127.0.0.1', 0), functools.partial(Quiet, directory=ROOT)); srv.daemon_threads = True
threading.Thread(target=srv.serve_forever, daemon=True).start(); B = f'http://127.0.0.1:{srv.server_address[1]}/'
room = 'c' + ''.join(random.choice('abcdefghjkmnpqrstuvwxyz23456789') for _ in range(5)); res = []
def check(name, ok, info=''): res.append(ok); print(f"{'PASS' if ok else 'FAIL'}  {name}  {info}", flush=True)
SPY = """(() => { const o = RTCDataChannel.prototype.send; window.__sent = [];
  RTCDataChannel.prototype.send = function (d) { const s = typeof d === 'string' ? d : null;
    window.__sent.push({ str: !!s, size: s ? s.length : (d.byteLength || d.size || 0), t: s && s[0] === '{' ? 'json' : s ? 'text' : 'binary' }); return o.call(this, d); }; })()"""
with sync_playwright() as p:
    args = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required']
    b = p.chromium.launch(args=args + [f'--use-file-for-fake-audio-capture={ROOT}/test/wav/silence.wav']); errs = []
    sc = b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2); s = sc.new_page()
    s.on('pageerror', lambda e: errs.append('screen ' + str(e)))
    s.goto(B + '#screen'); s.evaluate("localStorage.clear(); localStorage.setItem('rotorear-mute-until', Date.now() + 6e5)")
    s.goto(B + f'#screen&room={room}'); s.reload(); time.sleep(3)
    sim = b.new_context().new_page(); sim.goto(B + f'#demo&room={room}&n=4&path=hover'); sim.click('#sStart')
    ears = {}
    for name in ['Ana', 'Bo']:
        c = b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2); c.add_init_script(SPY); e = c.new_page()
        e.on('pageerror', lambda x, n=name: errs.append(n + ' ' + str(x)))
        e.goto(B + f'#ear&room={room}'); e.fill('#nName', name); e.dispatch_event('#nName', 'change'); e.click('#nStart'); ears[name] = e
    t0 = time.time()
    while time.time() - t0 < 60 and not any(e.evaluate('__node.look.state.shown') for e in ears.values()): time.sleep(0.5)
    asked = [n for n, e in ears.items() if e.evaluate('__node.look.state.shown')]
    st = s.evaluate("""() => { const m = __map, inc = __log.inc, P = __mapNodes(); return { s: m.watch, est: m.est, asked: inc && inc.asked, id: inc && inc.id, nodes: P }; }""")
    near = min((n for n in st['nodes'] if not n['name'].startswith('sim ')), key=lambda n: (n['pos'][0] - st['est'][0]) ** 2 + (n['pos'][1] - st['est'][1]) ** 2, default=None) if st['est'] else None
    check('screen confirms and asks one ear to look', st['s'] in ('drone', 'tracking') and len(asked) == 1, f"{st['s']} after {time.time() - t0:.0f} s, asked {asked}")
    check('asked ear is the nearest to the estimate', near and asked and near['name'] == asked[0] and st['asked'] == near['label'], f"est {st['est']}, nearest {near and near['name']} ({near and near['label']})")
    if not asked: b.close(); print('FAIL'); raise SystemExit(1)
    e = ears[asked[0]]; L = e.evaluate("() => ({ words: document.getElementById('lookWords').textContent, cls: document.getElementById('lookCls').textContent, id: __node.look.state.cur.id })")
    check('prompt says where to look, linked to the incident', L['id'] == st['id'] and len(L['words']) > 10, f"\"{L['words']}\" · {L['cls']}")
    if SHOTS: e.screenshot(path=os.path.join(SHOTS, 'camera-prompt.png'))
    e.click('#lookRec'); time.sleep(3)
    r = e.evaluate("() => ({ rec: __node.look.state.rec, video: !!document.getElementById('recVid').srcObject, shown: !document.getElementById('rec').hidden, t: document.getElementById('recT').textContent })")
    check('rear camera recording', r['rec'] and r['video'] and r['shown'], r['t'])
    if SHOTS: e.screenshot(path=os.path.join(SHOTS, 'recording.png'))
    t1 = time.time()
    while time.time() - t1 < 15 and e.evaluate('__node.look.state.rec'): time.sleep(0.5)
    time.sleep(3)
    c = e.evaluate("() => RotorClips.all().then(a => a.map(c => ({ inc: c.inc, size: c.blob.size, type: c.type, secs: c.secs })))")
    check('~10 s clip stored on this phone (IndexedDB)', len(c) == 1 and c[0]['size'] > 10000 and c[0]['inc'] == st['id'] and 8 <= c[0]['secs'] <= 12, str(c))
    check('clip shows in this phone\'s log', e.evaluate("document.querySelectorAll('#eLogList .clip video').length") == 1 and st['id'] in e.inner_html('#eLogList'))
    flag = s.evaluate(f"() => (RotorLog.get('{st['id']}') || {{}}).clips")
    check('screen log gets only a "clip saved" flag', flag and flag[0].get('n') == 1 and set(flag[0]) <= {'phone', 'n'}, str(flag))
    other = [n for n in ears if n != asked[0]][0]
    check('other ear was not asked and has no clip', not ears[other].evaluate('__node.look.state.cur') and ears[other].evaluate("RotorClips.all().then(a => a.length)") == 0)
    for n, x in ears.items():
        sent = x.evaluate('__sent'); big = max(m['size'] for m in sent); tot = sum(m['size'] for m in sent)
        check(f'{n}: mesh carried only small messages (no video, no audio)', sent and big < 2000 and tot < 100000, f"{len(sent)} messages, max {big} B, total {tot / 1000:.1f} kB (the clip is {c[0]['size'] / 1000:.0f} kB)")
    if SHOTS:
        e.evaluate("document.getElementById('earLog').scrollIntoView()"); time.sleep(0.5); e.screenshot(path=os.path.join(SHOTS, 'clip-in-log.png'))
    check('no page errors', not errs, str(errs[:3]))
    b.close()
print('ALL PASS' if all(res) else 'FAIL')
