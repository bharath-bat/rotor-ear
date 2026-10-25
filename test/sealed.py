# Sealed packets (mesh/seal.js) through the real relay code, in one page: a screen (RotorMesh.startHub) and two ears
# (NodeLink) on in-page links, ear C only reaching the screen through ear B. Checks: what B passes on is ciphertext; B, with
# its own private key, the screen's public key and C's name, still can't open it; a flipped bit (payload, origin or id) is
# rejected; a replayed packet is rejected, also by a reloaded screen (the replay floor is kept); B can't speak for C; the
# screen's answers down the path are sealed too and C opens them; the direct links stay plaintext as before.
#   usage: python test/sealed.py
import os, time, json, functools, threading, socketserver, http.server
from playwright.sync_api import sync_playwright
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
srv = socketserver.ThreadingTCPServer(('127.0.0.1', 0), functools.partial(Quiet, directory=ROOT)); srv.daemon_threads = True; PORT = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()
B = f'http://127.0.0.1:{PORT}/'; ok_all = True
def check(name, ok, info=''):
    global ok_all; ok_all &= bool(ok); print(f"  {'PASS' if ok else 'FAIL'}  {name}{'  · ' + info if info else ''}")
def wait(fn, t=20):
    t0 = time.time()
    while time.time() - t0 < t:
        v = fn()
        if v: return v
        time.sleep(0.3)
    return fn()
SETUP = """async () => {
  const R = RotorMesh, got = [], cap = { up: [], dn: [], direct: [] }, W = window.__t = { got, cap };
  const hubCb = st => ({ status() {}, data: (c, d, via) => { if (d.t === 's') got.push({ k: d.k, c: d.c, via: via && via.via, sealed: !!(via && via.sealed) }); }, seal: RotorSeal.screen(st) });
  W.newHub = () => { if (W.hub) W.hub.stop(); W.hub = R.startHub(null, hubCb('t-scr')); };
  W.newHub();
  const L = W.L = {}; ['B', 'C'].forEach(k => L[k] = new R.NodeLink('t', k, () => {}, null, null, { local: true, auto: false, store: 't-' + k }));
  W.direct = k => { const [x, y] = R.pipe({ role: 'map' }, { role: 'node', key: k }); const s = x.send; x.send = o => { cap.direct.push(JSON.stringify(o)); s(o); }; L[k].attach(x); W.hub.add(y); };
  W.direct('B'); W.direct('C');
  const [b, c] = R.pipe({ role: 'ear', key: 'C' }, { role: 'ear', key: 'B' });
  const sb = b.send; b.send = o => { if (o.t === 'dn') cap.dn.push(JSON.parse(JSON.stringify(o))); sb(o); };          // B → C (the screen's answers)
  const sc = c.send; c.send = o => { if (o.t === 'fw') cap.up.push(JSON.parse(JSON.stringify(o))); sc(o); };          // C → B (C's sealed data)
  L.B.addNb(b, 'C'); L.C.addNb(c, 'B');
  W.tick = setInterval(() => { L.B.send({ t: 's', k: 'B', n: 'B', c: Math.random() }); L.C.send({ t: 's', k: 'C', n: 'secret-label-C', c: 0.5, f: 123.25 }); }, 100);
}"""
with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_context(viewport={'width': 390, 'height': 844}).new_page(); errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto(B + '#screen'); pg.evaluate('localStorage.clear()'); pg.reload()
    pg.evaluate(SETUP)
    check('both ears direct, keys swapped over the direct links', wait(lambda: pg.evaluate("__t.hub.seal && __t.hub.seal.knows('B') && __t.hub.seal.knows('C') && __t.L.B.sealer.ready && __t.L.C.sealer.ready && __t.got.some(g => g.k === 'C' && !g.via)")))
    check('direct links unchanged: plaintext as before (no sealing when the link is fine)', pg.evaluate("__t.got.filter(g => g.k === 'C').every(g => !g.sealed)") and pg.evaluate("__t.L.C.fwd === 0"))
    pg.evaluate("__t.L.C.cutLink('screen', true)")
    check("C's data arrives through B, sealed", wait(lambda: pg.evaluate("__t.got.filter(g => g.k === 'C' && g.sealed && g.via.join() === 'B').length > 10"), 15),
          json.dumps(pg.evaluate("__t.hub.links()")))
    up = pg.evaluate("__t.cap.up.slice(-1)[0]")
    check('what B carries is ciphertext: no payload in it', up and set(up) == {'t', 'o', 'id', 'ttl', 'v', 'iv', 'x'} and 'secret-label-C' not in json.dumps(up) and '123.25' not in json.dumps(up), json.dumps(up)[:160])
    # B is curious: its own private key (from its phone's storage), the screen's public key, C's name. Every key it can make fails.
    tries = pg.evaluate("""async p => { const S = crypto.subtle, j = JSON.parse(localStorage.getItem('t-B-id')), scr = __t.hub.seal.pub, EC = { name: 'ECDH', namedCurve: 'P-256' };
      const u = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)), e = new TextEncoder(), out = [];
      const priv = await S.importKey('jwk', j.priv, EC, false, ['deriveBits']), bits = await S.deriveBits({ name: 'ECDH', public: await S.importKey('raw', u(scr), EC, false, []) }, priv, 256);
      const hk = await S.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
      for (const info of ['up|C', 'up|B', 'down|C', 'down|B']) { const k = await S.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: e.encode('rotorear-seal-v1'), info: e.encode(info) }, hk, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
        for (const aad of ['C|' + p.id, 'B|' + p.id]) { try { await S.decrypt({ name: 'AES-GCM', iv: u(p.iv), additionalData: e.encode(aad) }, k, u(p.x)); out.push(info + ' opened'); } catch (x) { out.push('fail'); } } }
      try { await S.decrypt({ name: 'AES-GCM', iv: u(p.iv) }, await S.importKey('raw', bits.slice(0, 32), 'AES-GCM', false, ['decrypt']), u(p.x)); out.push('raw opened'); } catch (x) { out.push('fail'); }
      return out; }""", up)
    check('the middle ear (B) cannot decrypt C\'s packet with anything it holds', tries and all(t == 'fail' for t in tries), f'{len(tries)} attempts: {set(tries)}')
    # tamper / replay: hand packets to the screen on B's link (as B would), watching what gets through
    inj = """async ([p, wait]) => { const s0 = Object.assign({}, __t.hub.seal.stats), n0 = __t.got.length, marks = __t.got.length;
      __t.L.B.conn.send(p); await new Promise(r => setTimeout(r, wait || 400));
      const s = __t.hub.seal.stats; return { bad: s.bad - s0.bad, replay: s.replay - s0.replay, ok: s.ok - s0.ok }; }"""
    def flip(s, i=10):
        c = s[i]; return s[:i] + ('A' if c != 'A' else 'B') + s[i + 1:]
    pg.evaluate("__t.L.B.cutLink('C', true); __t.L.C.cutLink('B', true)") # stop live traffic from C so counters are only ours
    time.sleep(0.6)
    fresh = pg.evaluate("__t.cap.up.slice(-1)[0]"); pg.evaluate("p => { window.__fresh = p; }", fresh)
    # a packet C sealed that B never passed on: forge it as B's (v ends with B), tampered first
    fwd = lambda pk: dict(pk, ttl=pk['ttl'] - 1, v=pk['v'] + ['B'])
    # pick one C sent that the screen hasn't seen yet: seal a new one with C's sealer
    newp = pg.evaluate("async () => { const x = await __t.L.C.sealer.up({ t: 's', k: 'C', n: 'secret-label-C', c: 0.9 }); return { t: 'fw', o: 'C', id: x.id, ttl: 6, v: ['C'], iv: x.iv, x: x.x }; }")
    r1 = pg.evaluate(inj, [fwd(dict(newp, x=flip(newp['x']))), 400])
    r2 = pg.evaluate(inj, [fwd(dict(newp, x=newp['x'][:-4] + ('AAAA' if newp['x'][-4:] != 'AAAA' else 'BBBB'))), 400])
    r3 = pg.evaluate(inj, [fwd(dict(newp, id=newp['id'].split('.')[0] + '.' + str(int(newp['id'].split('.')[1]) + 1))), 400])
    r4 = pg.evaluate(inj, [fwd(dict(newp, o='B', v=['B'])), 400])
    check('tampered packets rejected (payload bit, auth tag, id), nothing delivered', all(r['bad'] == 1 and r['ok'] == 0 for r in (r1, r2, r3)), f'{r1} {r2} {r3}')
    check('B cannot pass C\'s sealed data off as its own (origin swapped)', r4['bad'] == 1 and r4['ok'] == 0, str(r4))
    r5 = pg.evaluate(inj, [fwd(newp), 400])
    check('the untouched packet is accepted', r5['ok'] == 1, str(r5))
    r6 = pg.evaluate(inj, [fwd(newp), 400]); r7 = pg.evaluate(inj, [fwd(fresh), 400]) if fresh else {'replay': 0}
    old = pg.evaluate("__t.cap.up[0]")
    r8 = pg.evaluate(inj, [fwd(old), 400])
    check('replayed packets rejected (just now, and an old one)', r6['replay'] == 1 and r6['ok'] == 0 and r8['replay'] == 1 and r8['ok'] == 0, f'{r6} {r8}')
    # the screen reloads (same phone storage): the replay floor survives
    pg.evaluate("__t.newHub(); __t.L.B.conn.close(); __t.L.B.cutLink('screen', false)"); pg.evaluate("__t.direct('B')")
    wait(lambda: pg.evaluate("!!__t.hub.seal"), 5); time.sleep(1.2)
    r9 = pg.evaluate(inj, [fwd(newp), 400])
    check('a replay to the reloaded screen is still rejected', r9['replay'] == 1 and r9['ok'] == 0, str(r9))
    # down the path: the screen's answers to C ride sealed through B, and C opens them (its ping → pong)
    pg.evaluate("__t.L.B.cutLink('C', false); __t.L.C.cutLink('B', false); const [b, c] = RotorMesh.pipe({ role: 'ear', key: 'C' }, { role: 'ear', key: 'B' }); const sb = b.send; b.send = o => { if (o.t === 'dn') __t.cap.dn.push(JSON.parse(JSON.stringify(o))); sb(o); }; __t.L.B.addNb(b, 'C'); __t.L.C.addNb(c, 'B');")
    check('C heard through B again after the reload', wait(lambda: pg.evaluate("__t.hub.links().C && __t.hub.links().C.via.join() === 'B'"), 15))
    wait(lambda: pg.evaluate("__t.cap.dn.length > 2 && Date.now() - __t.L.C.lastPing < 1500"), 10); dn = pg.evaluate("__t.cap.dn.slice(-1)[0]")
    check("the screen's answers to C are sealed on the way down (C keeps its clock sync)", dn and 'ts' not in dn and 'x' in dn and pg.evaluate("Date.now() - __t.L.C.lastPing < 2500"), json.dumps(dn)[:120] if dn else '')
    bd = pg.evaluate("async p => { const q = Object.assign({}, p, { x: p.x.slice(0, -3) + (p.x.endsWith('AAA') ? 'BBB' : 'AAA'), r: [] }); return await __t.L.C.sealer.down(q); }", dn) if dn else 1
    rd = pg.evaluate("async p => { return await __t.L.C.sealer.down(Object.assign({}, p, { r: [] })); }", dn) if dn else 1
    check('C rejects a tampered or replayed answer', bd is None and rd is None, f'{bd} {rd}')
    check('no page errors', not errs, '; '.join(errs[:3]))
    pg.evaluate("clearInterval(__t.tick)")
    b.close()
print('ALL PASS' if ok_all else 'SOME FAILED')
