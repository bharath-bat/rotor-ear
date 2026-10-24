# Hotspot mode (no internet): a screen and an ear pair by code with no PeerJS at all (the relay is blocked and Peer is never
# constructed). Screen: #screen&net=hotspot → Phones → Add an ear (offer QR + code); ear: #ear&net=hotspot → paste the code →
# answer QR + code; screen pastes that back → WebRTC data channel on host candidates only. Then the ear simulates a drone and
# the screen's status goes to DRONE from its numbers. Also: both QR codes decode back to the codes (jsQR), the codes are short,
# the hotspot option is on the start screen, a lost link re-pairs and the queued points catch up, and the app shell loads
# offline after one visit (service worker).   usage: [SHOTS=dir] python test/hotspot.py
import os, time, functools, threading, socketserver, http.server
from playwright.sync_api import sync_playwright
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__))); SHOTS = os.environ.get('SHOTS')
class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
srv = socketserver.ThreadingTCPServer(('127.0.0.1', 0), functools.partial(Quiet, directory=ROOT)); srv.daemon_threads = True; PORT = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()
B = f'http://localhost:{PORT}/'; ok_all = True
def check(name, ok, info=''):
    global ok_all; ok_all &= bool(ok); print(f"  {'PASS' if ok else 'FAIL'}  {name}{'  · ' + info if info else ''}")
NOPEER = "window.__peers = 0; Object.defineProperty(window, 'Peer', { configurable: true, set(v) { this._P = v; }, get() { return function () { window.__peers++; return new this._P(...arguments); }.bind(this); } });"
def wait(fn, t=20):
    t0 = time.time()
    while time.time() - t0 < t:
        v = fn()
        if v: return v
        time.sleep(0.3)
    return fn()

with sync_playwright() as p:
    b = p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'])
    relay = []
    def ctx():
        c = b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, permissions=['camera', 'microphone'])
        c.route('**/*peerjs.com/**', lambda r: (relay.append(r.request.url), r.abort())); c.add_init_script(NOPEER)
        pg = c.new_page(); errs = []; pg.on('pageerror', lambda e: errs.append(str(e))); return c, pg, errs
    cs, S, es = ctx(); ce, E, ee = ctx()
    S.goto(B); S.evaluate("localStorage.clear(); localStorage.setItem('rotorear-mute-until', Date.now() + 6e5)"); S.reload()
    check('start screen offers "No internet? Use hotspot mode"', S.is_visible('#homeHot') and 'No internet? Use hotspot mode' in S.text_content('#homeHot') and 'One phone turns on hotspot, others join it, then scan codes.' in S.text_content('#homeHot'))
    if SHOTS: S.screenshot(path=f'{SHOTS}/hotspot-option.png')
    S.click('text=Screen · hotspot'); time.sleep(0.5)
    check('screen in hotspot mode, pairing panel open', S.evaluate("location.hash") == '#screen&net=hotspot' and S.is_visible('#pHot') and S.is_visible('#hAdd'))
    def offer_code(prev=''):
        S.evaluate("document.getElementById('hAdd').click()"); wait(lambda: S.evaluate("!document.getElementById('hOffer').hidden") and S.input_value('#hCode') not in ('', prev), 10); return S.input_value('#hCode')
    def answer_code(E, offer, prev=''):
        E.fill('#eOff', offer); E.click('#eOk'); wait(lambda: E.input_value('#eCode') not in ('', prev), 10); return E.input_value('#eCode')
    def connect(ans): S.evaluate("c => { document.getElementById('hAns').value = c; document.getElementById('hOk').click(); }", ans)
    offer = offer_code()
    check('offer code is short (QR-friendly)', offer.startswith('R1~o~') and len(offer) < 200, f'{len(offer)} chars: {offer}')
    check('offer QR decodes back to the code (jsQR)', S.evaluate("RotorHotspot.readQR(document.getElementById('hQR'))") == offer)
    if SHOTS: S.screenshot(path=f'{SHOTS}/hotspot-offer-qr.png')
    E.goto(B + '#ear&net=hotspot'); E.evaluate("localStorage.clear()"); E.reload(); time.sleep(0.5)
    check('ear shows the hotspot pairing steps', E.is_visible('#earHot') and 'One phone turns on hotspot' in E.inner_text('#earHot'))
    ans = answer_code(E, offer)
    check('answer code is short and carries the ear key', ans.startswith('R1~a~') and len(ans) < 200 and ans.endswith('~' + E.evaluate("localStorage.getItem('rotorear-key-hotspot')")), f'{len(ans)} chars')
    check('answer QR decodes back to the code', E.evaluate("RotorHotspot.readQR(document.getElementById('eQR'))") == ans)
    connect(ans)
    check('data channel opens, ear switches to listening', wait(lambda: E.is_visible('#node') and S.evaluate('__net().count') == 1, 15), E.inner_text('#nStatus'))
    ce2, E2, ee2 = ctx(); E2.goto(B + '#ear&net=hotspot'); time.sleep(0.5)
    connect(answer_code(E2, offer_code(offer)))
    check('a second ear pairs the same way', wait(lambda: E2.is_visible('#node') and S.evaluate('__net().count') == 2, 15), E2.inner_text('#nStatus'))
    for e in (E, E2): e.evaluate("const r = Math.random; Math.random = () => 0.5; document.getElementById('nSim').click(); Math.random = r")
    st = wait(lambda: S.evaluate("__watch.s") in ('drone', 'tracking') and S.evaluate("__watch.s"), 30)
    check("the ears' simulated drone drives the screen to DRONE (numbers over the data channels)", st, f'screen {S.evaluate("__watch.s")} · ear {E.evaluate("__node.out.state")}')
    n = S.evaluate("__net().nodes")
    check('screen knows each ear by its key, with live timelines', len(n) == 2 and n[0]['key'] == E.evaluate('__node.key') and all(len(x['tl']) > 20 for x in n), str([(x['label'], len(x['tl'])) for x in n]))
    check('ear status names its label from the screen', 'Node A' in E.inner_text('#nStatus') and 'Node B' in E2.inner_text('#nStatus'), E.inner_text('#nStatus'))
    S.evaluate("document.querySelectorAll('[data-close]').forEach(b => { if (b.offsetParent) b.click(); })"); time.sleep(1)
    if SHOTS:
        from PIL import Image
        wait(lambda: len(S.evaluate('__map.drones || []')) == 1, 15)  # the synthetic rotors can read as two pitches for a moment
        S.screenshot(path='/tmp/hs-s.png'); E.screenshot(path='/tmp/hs-e.png')
        a, c = Image.open('/tmp/hs-s.png'), Image.open('/tmp/hs-e.png'); im = Image.new('RGB', (a.width + c.width + 24, max(a.height, c.height)), 'white')
        im.paste(a, (0, 0)); im.paste(c, (a.width + 24, 0)); im.save(f'{SHOTS}/hotspot-connected.png')
    # the link drops (as if the hotspot blinked): the ear keeps queueing, "Pair again" re-pairs, the screen catches up
    E.evaluate("__node.link.conn.close()")
    check('screen chip: Ear A offline, counting', wait(lambda: 'Ear A offline' in S.evaluate('__net().chips'), 10), S.evaluate('__net().chips'))
    check('ear offers "Pair again", keeps listening and queues', wait(lambda: E.is_visible('#nPair') and 'queued' in E.inner_text('#nStatus'), 8), E.inner_text('#nStatus'))
    time.sleep(3); q = E.evaluate('__node.link.q.length')
    E.click('#nPair'); connect(answer_code(E, offer_code(S.input_value('#hCode')), ans))
    chip = wait(lambda: 'synced' in S.evaluate('__net().chips') and S.evaluate('__net().chips'), 20)
    if SHOTS: S.screenshot(path=f'{SHOTS}/hotspot-resynced.png')
    n = S.evaluate("__net().nodes")[0]; ts = [x[0] for x in n['tl']]
    check('re-paired: queued points flushed and merged in time order', chip and q > 10 and n['syncN'] >= q and ts == sorted(ts) and E.evaluate('__node.link.q.length') == 0, f'{chip} · queued {q}')
    check('still two ears on the screen (re-pair replaced the old link)', S.evaluate('__net().count') == 2 and len(S.evaluate('__net().nodes')) == 2)
    check('PeerJS never used: no Peer created, no relay request', S.evaluate('__peers') == 0 and E.evaluate('__peers') == 0 and E2.evaluate('__peers') == 0 and not relay, f'{len(relay)} relay requests')
    check('no page errors', not es and not ee and not ee2, '; '.join((es + ee + ee2)[:3]))
    cs.close(); ce.close(); ce2.close()
    # offline app shell: one online visit, then the network goes away and the app (and hotspot mode) still loads
    c = b.new_context(); c.add_init_script("localStorage.setItem('rotorear-sw-test', '1')"); pg = c.new_page()
    pg.goto(B + '#ear&net=hotspot'); pg.wait_for_function("navigator.serviceWorker && navigator.serviceWorker.ready.then(() => true)", timeout=15000)
    pg.reload(); wait(lambda: pg.evaluate("!!navigator.serviceWorker.controller"), 10); time.sleep(1)
    c.set_offline(True); pg.reload(); time.sleep(1)
    good = pg.evaluate("!!window.RotorHotspot && !!document.getElementById('earHot') && !document.getElementById('earHot').hidden")
    libs = pg.evaluate("RotorHotspot.libs().then(() => !!window.jsQR && !!window.qrcode, e => String(e))")
    check('service worker: app shell + hotspot mode + QR libraries load with the network off', good and libs is True, str(libs))
    c.close(); b.close()
print('ALL PASS' if ok_all else 'SOME FAILED')
