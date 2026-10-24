# Offline buffering over the real PeerJS relay (the default mode). A screen and one ear (simulated drone) in a room; mid-stream
# the ear's link AND its relay connection are cut (NodeLink.drop: as if the network went away). Checks: the ear keeps detecting
# and queues its numbers with timestamps (status "offline N s · Q queued · retrying in W s"); the screen shows "Ear A offline N s",
# counting up; when the network is back the ear gets a new relay peer, reconnects with backoff, flushes the queue oldest first;
# the screen merges the late points into the ear's timeline by time (ascending, the gap filled) and flips the chip to
# "Ear A back · synced N points". Also: the queue is capped (oldest dropped) and keeps order.   usage: [SHOTS=dir] python test/offline.py
import os, time, random, functools, threading, socketserver, http.server
from playwright.sync_api import sync_playwright
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__))); SHOTS = os.environ.get('SHOTS')
class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
srv = socketserver.ThreadingTCPServer(('127.0.0.1', 0), functools.partial(Quiet, directory=ROOT)); srv.daemon_threads = True; PORT = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()
B = f'http://127.0.0.1:{PORT}/'; room = 'of' + ''.join(random.choice('abcdefghjkmnpqrstuvwxyz') for _ in range(6)); ok_all = True
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
    S, es = ctx(); E, ee = ctx()
    S.goto(B + '#screen'); S.evaluate("localStorage.clear(); localStorage.setItem('rotorear-mute-until', Date.now() + 6e5)"); S.goto(B + '#screen&room=' + room); S.reload()
    E.goto(B + '#ear&room=' + room); E.evaluate('localStorage.clear()'); E.reload()
    # the queue on its own: capped at 2400 (oldest dropped), order kept, pongs never queued
    u = E.evaluate("""() => { const L = new RotorMesh.NodeLink('unit', 'u', () => {}, null, null, { local: true });
      for (let i = 0; i < 2500; i++) L.send({ t: 's', k: 'u', c: i }); L.send({ t: 'pong', k: 'u' }); clearInterval(L.watch);
      return { n: L.q.length, lost: L.dropped, first: L.q[0].m.c, last: L.q[L.q.length - 1].m.c, at: L.q.every(x => x.m.at != null && x.m.w > 0), asc: L.q.every((x, i, a) => !i || a[i - 1].s < x.s) }; }""")
    check('queue capped at 2400, oldest dropped, order + timestamps kept, pongs not queued', u['n'] == 2400 and u['lost'] == 100 and u['first'] == 100 and u['last'] == 2499 and u['at'] and u['asc'], str(u))
    check('ear connects over the relay', wait(lambda: 'connected' in E.inner_text('#nStatus'), 40), E.inner_text('#nStatus'))
    E.check('#nSim')
    check('screen gets live points', wait(lambda: S.evaluate('__net().nodes.length') == 1 and len(S.evaluate('__net().nodes[0].tl')) > 30, 30))
    time.sleep(2)
    E.evaluate('__node.link.drop(true)'); cut = time.time()
    c1 = wait(lambda: 'offline' in S.evaluate('__net().chips') and S.evaluate('__net().chips'), 10); time.sleep(3); c2 = S.evaluate('__net().chips')
    sec = lambda c: int(c.split('offline ')[1].split(' ')[0]) if c and 'offline ' in c else -1
    check('screen chip "Ear A offline N s", counting up', c1 and c1.startswith('Ear A offline') and sec(c2) >= sec(c1) + 2, f'{c1!r} → {c2!r}')
    if SHOTS: S.screenshot(path=f'{SHOTS}/offline-chip.png')
    before = len(S.evaluate('__net().nodes[0].tl'))
    time.sleep(max(0, 9 - (time.time() - cut)))
    est = E.inner_text('#nStatus'); q = E.evaluate('__node.link.q.length')
    check('ear keeps detecting and queues, says offline + retrying', q > 50 and 'queued' in est and 'retrying' in est and E.evaluate('__node.out.state') != 'off', f'{est!r} · {q} queued')
    check('nothing reached the screen while offline', len(S.evaluate('__net().nodes[0].tl')) == before)
    E.evaluate('__node.link.drop(false)')
    chip = wait(lambda: 'synced' in S.evaluate('__net().chips') and S.evaluate('__net().chips'), 60)
    if SHOTS and chip: S.screenshot(path=f'{SHOTS}/synced-chip.png')
    n = S.evaluate('__net().nodes[0]'); tl = n['tl']; ts = [x[0] for x in tl]; late = [x[0] for x in tl if x[1]]; live = [x[0] for x in tl if not x[1]]
    gap_before = max([t for t in live if late and t < late[0]] or [0]); gap_after = min([t for t in live if late and t > late[-1]] or [0])
    check('reconnected (new relay peer) and flushed: chip "Ear A back · synced N points"', chip and chip.startswith('Ear A back · synced') and n['syncN'] >= q and E.evaluate('__node.link.q.length') == 0, f'{chip!r} · synced {n["syncN"]} of {q}+')
    check('late points merged by time: timeline ascending, the gap filled between live points', ts == sorted(ts) and len(late) >= q and late == sorted(late) and gap_before < late[0] and late[-1] < gap_after,
          f'{len(late)} late in [{late[0] if late else 0:.0f}, {late[-1] if late else 0:.0f}] between live {gap_before:.0f} and {gap_after:.0f}')
    check('live points flow again after the sync', wait(lambda: S.evaluate('__net().nodes[0].tl.filter(x => !x[1]).length') > len(live) + 5, 10))
    check('ear status back to connected', wait(lambda: 'connected' in E.inner_text('#nStatus'), 10), E.inner_text('#nStatus'))
    check('no page errors', not es and not ee, '; '.join((es + ee)[:3]))
    b.close()
print('ALL PASS' if ok_all else 'SOME FAILED')
