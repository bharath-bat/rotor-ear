# Multi-hop relay over the real PeerJS relay (the default mode): a screen and three ears (simulated drones) in a room. The
# ears link to each other on their own (the screen names them in its pings). Then links are cut (NodeLink.cutLink, as if out
# of range): C loses the screen and A → its data goes C → B → screen; B loses the screen too → C → B → A → screen. Checks:
# all direct while links are fine (and nothing sealed or relayed); the reroute keeps C's live points coming; ear chips say
# "via B (2 hops)" / "via B → A (3 hops)"; the ear's own status says so; no duplicates (each point once, nothing replayed);
# when the links come back C and B go direct again.   usage: [SHOTS=dir] python test/relay.py
import os, time, json, random, functools, threading, socketserver, http.server
from playwright.sync_api import sync_playwright
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__))); SHOTS = os.environ.get('SHOTS')
class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
srv = socketserver.ThreadingTCPServer(('127.0.0.1', 0), functools.partial(Quiet, directory=ROOT)); srv.daemon_threads = True; PORT = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()
B = f'http://127.0.0.1:{PORT}/'; room = 'rl' + ''.join(random.choice('abcdefghjkmnpqrstuvwxyz') for _ in range(6)); ok_all = True
def check(name, ok, info=''):
    global ok_all; ok_all &= bool(ok); print(f"  {'PASS' if ok else 'FAIL'}  {name}{'  · ' + info if info else ''}")
def wait(fn, t=20):
    t0 = time.time()
    while time.time() - t0 < t:
        v = fn()
        if v: return v
        time.sleep(0.3)
    return fn()
with sync_playwright() as p:
    b = p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
    def ctx():
        pg = b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2).new_page(); errs = []; pg.on('pageerror', lambda e: errs.append(str(e))); return pg, errs
    S, es = ctx(); S.goto(B + '#screen'); S.evaluate("localStorage.clear(); localStorage.setItem('rotorear-mute-until', Date.now() + 6e5)"); S.goto(B + '#screen&room=' + room); S.reload()
    ears = []
    for i in range(3): # one at a time, so the screen names them A, B, C in order
        E, ee = ctx(); E.goto(B + '#ear&room=' + room); E.evaluate('localStorage.clear()'); E.reload()
        wait(lambda: 'connected' in E.inner_text('#nStatus'), 40); E.check('#nSim')
        wait(lambda: S.evaluate('__net().nodes.length') == i + 1, 30); ears.append((E, ee))
    keys = [E.evaluate('__node.link.key') for E, _ in ears]; lab = {n['key']: n['label'] for n in S.evaluate('__net().nodes')}
    check('three ears connected, named A, B, C', [lab.get(k) for k in keys] == ['A', 'B', 'C'], str(lab))
    (A, _), (Bp, _), (C, _) = ears; kA, kB, kC = keys
    L = lambda: S.evaluate('__net().links')
    check('all direct while the links are fine', wait(lambda: all(v['direct'] and not v['via'] for v in L().values()) and len(L()) == 3, 15), json.dumps(L()))
    mesh = wait(lambda: all(E.evaluate("[...__node.link.nbs.values()].filter(b => b.c.open && Date.now() - b.at < 3000).length") == 2 for E, _ in ears), 45)
    check('the ears linked to each other on their own (each to the other two)', mesh, str([E.evaluate("[...__node.link.nbs.keys()]") for E, _ in ears]))
    time.sleep(2.5)
    check('direct mode unchanged: nothing relayed or sealed, chips quiet', S.evaluate('__net().fw') == 0 and S.evaluate('__net().chips') == '' and all(E.evaluate('__node.link.fwd') == 0 for E, _ in ears))
    if SHOTS: S.screenshot(path=f'{SHOTS}/links-direct.png')
    tl = lambda k: [x for x in S.evaluate(f"(__net().nodes.find(n => n.key === '{k}') || {{tl: []}}).tl")]
    live = lambda k: len([x for x in tl(k) if not x[1]])
    # 1) C loses the screen and A: only B is left
    C.evaluate(f"__node.link.cutLink('screen', true); __node.link.cutLink('{kA}', true)"); A.evaluate(f"__node.link.cutLink('{kC}', true)"); t1 = time.time()
    via1 = wait(lambda: L().get(kC, {}).get('via') == [kB], 15)
    n0 = live(kC); time.sleep(3); n1 = live(kC)
    check("C's data goes through B (C → B → screen)", via1 and n1 > n0 + 15, f'{json.dumps(L().get(kC))} · {n1 - n0} live points in 3 s · after {time.time() - t1 - 3:.1f} s')
    chip = S.evaluate('__net().chips')
    check('ear chip "Ear C via B (2 hops) · sealed"', 'Ear C via B (2 hops) · sealed' in chip, repr(chip))
    check("C's own status says how it's connected", wait(lambda: 'via B (2 hops)' in C.inner_text('#nStatus'), 5), C.inner_text('#nStatus'))
    if SHOTS: S.screenshot(path=f'{SHOTS}/cut-rerouted.png')
    # 2) B loses the screen as well: C → B → A → screen
    Bp.evaluate("__node.link.cutLink('screen', true)")
    via2 = wait(lambda: L().get(kC, {}).get('via') == [kB, kA] and L().get(kB, {}).get('via') == [kA], 15)
    n0 = live(kC); time.sleep(3); n1 = live(kC)
    check('C → B → A → screen (two ears in between), B via A', via2 and n1 > n0 + 15, f'{json.dumps(L())} · {n1 - n0} points in 3 s')
    chip = S.evaluate('__net().chips')
    check('chips "Ear C via B → A (3 hops)", "Ear B via A (2 hops)", "Ear A direct"', 'Ear C via B → A (3 hops) · sealed' in chip and 'Ear B via A (2 hops) · sealed' in chip and 'Ear A direct' in chip, repr(chip))
    check('A and B forward, the screen opened them all (nothing tampered, nothing replayed)', A.evaluate('__node.link.fwd') > 10 and Bp.evaluate('__node.link.fwd') > 10 and S.evaluate('__net().seal.bad') == 0 and S.evaluate('__net().seal.replay') == 0, json.dumps(S.evaluate('__net().seal')))
    if SHOTS: S.screenshot(path=f'{SHOTS}/two-hop.png')
    # no duplicates: every point C sends in a window is tagged; the screen must take each tag exactly once
    S.evaluate(f"window.__tags = []; const P = RotorMesh.MeshModel.prototype, g = P.ingest; P.ingest = function (d, n) {{ if (d && d.k === '{kC}' && d.tag) __tags.push(d.tag); return g.call(this, d, n); }}")
    C.evaluate("window.__tag = 0; const L = __node.link, s = L.send; L.send = function (o) { if (o && o.t === 's' && __tag < 40) o = Object.assign({}, o, { tag: ++__tag }); return s.call(this, o); }")
    wait(lambda: C.evaluate('__tag') >= 40, 15); time.sleep(1.5); C.evaluate("delete __node.link.send")
    tags = S.evaluate('__tags'); ts = [x[0] for x in tl(kC)]
    check('no duplicates: each of 40 tagged points taken exactly once, none replayed, timeline has no repeats', sorted(tags) == list(range(1, 41)) and S.evaluate('__net().seal.replay') == 0 and len(ts) == len(set(ts)),
          f'{len(tags)} taken, {len(set(tags))} distinct')
    # 3) the links come back
    C.evaluate(f"__node.link.cutLink('screen', false); __node.link.cutLink('{kA}', false)"); A.evaluate(f"__node.link.cutLink('{kC}', false)"); Bp.evaluate("__node.link.cutLink('screen', false)")
    healed = wait(lambda: all(v['direct'] and not v['via'] for v in L().values()), 40)
    check('healed: C and B go direct again when their links return', healed, json.dumps(L()))
    check("C's status: back to direct", wait(lambda: 'direct' in C.inner_text('#nStatus') or C.inner_text('#nStatus') == 'connected to map', 8), C.inner_text('#nStatus'))
    n0 = live(kC); time.sleep(2); check('live points keep flowing', live(kC) > n0 + 8)
    check('nothing went offline or lost on the way (no queue needed while a route existed)', all(E.evaluate('__node.link.dropped') == 0 for E, _ in ears))
    errs = es + [e for _, ee in ears for e in ee]
    check('no page errors', not errs, '; '.join(errs[:3]))
    b.close()
print('ALL PASS' if ok_all else 'SOME FAILED')
