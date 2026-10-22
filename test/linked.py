# Linked watch posts over the real PeerJS relay: two screens, each running its own 4 simulated phones (#demo&path=cross),
# 30 m apart on one east–west line (post South sets East = 30 m in the Phones sheet; no GPS, so the manual frame is used).
# One drone (same pitch at both) flies east and back at 3 m/s on the wall clock, so it goes from one post to the other.
# Checks: both link; each draws the other's drone faded at the right place (shared frame); the post it reaches second takes
# the first one's drone id (a hand-off by pitch + time + position) and says so, the first marks it handed on; no page errors.
# usage: [SHOT=dir] python test/linked.py
import os, time, random, functools, threading, socketserver, http.server
from playwright.sync_api import sync_playwright
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__))); SHOT = os.environ.get('SHOT')
class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
srv = socketserver.ThreadingTCPServer(('127.0.0.1', 0), functools.partial(Quiet, directory=ROOT)); srv.daemon_threads = True; PORT = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()
code = 'lt' + ''.join(random.choice('abcdefghjkmnpqrstuvwxyz') for _ in range(6)); ok_all = True
def check(name, ok, info=''):
    global ok_all; ok_all &= bool(ok); print(f"  {'PASS' if ok else 'FAIL'}  {name}{'  · ' + info if info else ''}")
ST = """({ s: __watch.s, tr: (__map.tracks || []).filter(t => t.hot && t.est).map(t => t.est), truth: __map.truth, remote: __map.remote, note: document.getElementById('handoff').hidden ? '' : document.getElementById('handoff').textContent,
  link: __link.state, inc: RotorLog.list.filter(e => e.type === 'drone').map(e => ({ id: e.id, gid: e.gid, from: e.from || '', to: e.to || '' })), tag: document.getElementById('mapTag').textContent })"""
with sync_playwright() as p:
    b = p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required']); P = {}
    for name, ox in (('North', 0), ('South', 30)):
        pg = b.new_context(viewport={'width': 390, 'height': 844}).new_page(); errs = []; pg.on('pageerror', lambda e, errs=errs: errs.append(str(e)))
        pg.goto(f'http://127.0.0.1:{PORT}/#screen'); pg.evaluate("localStorage.clear(); localStorage.setItem('rotorear-mute-until', Date.now() + 6e5)")
        pg.goto(f'http://127.0.0.1:{PORT}/#demo&path=cross&ox={ox}'); pg.reload(); time.sleep(0.5)
        pg.click('#mPhones') if pg.is_visible('#mPhones') else None
        pg.evaluate(f"""(() => {{ const v = (id, x) => {{ const e = document.getElementById(id); e.value = x; e.dispatchEvent(new Event('change')); }}; v('lkCode', '{code}'); v('lkName', '{name}'); v('lkE', {ox}); document.getElementById('lkGo').click(); }})()""")
        P[name] = (pg, errs)
    for pg, _ in P.values(): pg.evaluate("document.querySelectorAll('[data-close]').forEach(b => { if (b.offsetParent) b.click(); })")
    linked, remoteErr, notes, shot = 0, [], {'North': '', 'South': ''}, False
    t0 = time.time()
    while time.time() - t0 < 75:
        time.sleep(1); R = {k: pg.evaluate(ST) for k, (pg, _) in P.items()}
        if all('linked with' in R[k]['link'] for k in R): linked += 1
        for me, other, dx in (('South', 'North', -30), ('North', 'South', 30)):  # the other's drone, in my frame = its estimate shifted by the 30 m between posts
            for r in R[me]['remote']:
                if R[other]['tr']: remoteErr.append(min(abs(r['x'] - (e[0] + dx)) + abs(r['y'] - e[1]) for e in R[other]['tr']))
        for k in R:
            if R[k]['note'] and not notes[k]: notes[k] = R[k]['note']
        if SHOT and not shot and R['South']['note'] and R['North']['note'] and (R['North']['remote'] or R['South']['remote']):
            for k, (pg, _) in P.items(): pg.screenshot(path=f'{SHOT}/linked-{k.lower()}.png')
            shot = True
        if notes['North'] and notes['South'] and time.time() - t0 > 30: break
    N, S = R['North']['inc'], R['South']['inc']
    print('   North incidents:', N, '\n   South incidents:', S, '\n   notes:', notes, '\n   map tags:', R['North']['tag'], '|', R['South']['tag'])
    check('both posts linked', linked >= 10, f'{linked} s linked')
    check("each post draws the other's drone in its own frame", len(remoteErr) >= 5 and sorted(remoteErr)[len(remoteErr) // 2] < 1.0, f'{len(remoteErr)} samples, median |error| {sorted(remoteErr)[len(remoteErr) // 2] if remoteErr else None} m')
    hand = [(a, b2, x, y) for a, b2, A, B in (('North', 'South', N, S), ('South', 'North', S, N)) for x in A for y in B if x['gid'] == y['gid'] and y['from'] == a and x['to'] == b2]
    check('hand-off: the second post keeps the drone id the first gave it, the first marks it handed on', bool(hand), str(hand[:1]))
    a, b2 = hand[0][:2] if hand else ('North', 'South')
    check('hand-off notice on both screens', f'Hand-off from {a}' in notes[b2] and f'handed off to {b2}' in notes[a], str(notes))
    check('one drone, one id across both posts', len({x['gid'] for x in N + S}) == 1, str({x['gid'] for x in N + S}))
    for k, (pg, errs) in P.items(): check(f'no page errors ({k})', not errs, '; '.join(errs[:2]))
    if SHOT and shot:
        from PIL import Image
        a, c = Image.open(f'{SHOT}/linked-north.png'), Image.open(f'{SHOT}/linked-south.png'); im = Image.new('RGB', (a.width + c.width + 12, max(a.height, c.height)), 'white')
        im.paste(a, (0, 0)); im.paste(c, (a.width + 12, 0)); im.save(f'{SHOT}/linked-handoff.png')
    b.close()
print('ALL PASS' if ok_all else 'SOME FAILED')
