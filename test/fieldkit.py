# Field kit: label sounds on an ear, merge them on the screen, and check they change classification like Teach does.
# Over the relay: an ear hearing hexa_teach.wav (a hexacopter the hand-set profiles call fixed-wing) labels it
# "Quadcopter" 3 times (one with notes and a kept clip); an ear hearing boxfans_teach.wav (box fans they call a quadcopter)
# labels it "Not a drone" twice and "Other: box fans" once. Checks: the label card shows during / right after a detection,
# samples are saved on the ear (clip in IndexedDB there), the screen's session library gets the numbers + label only
# (no notes, no audio), ear export → import round trip (Teach format), and the held-out recordings (hexa_test,
# boxfans_test) are classified wrong before and right after importing the screen's merged library into Teach.
# usage: [SHOT=dir] python test/fieldkit.py
import os, json, time, functools, threading, http.server, socketserver
from playwright.sync_api import sync_playwright
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__))); WAV = os.path.join(ROOT, 'test', 'wav'); SHOT = os.environ.get('SHOT')
class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
srv = socketserver.ThreadingTCPServer(('127.0.0.1', 0), functools.partial(Quiet, directory=ROOT)); srv.daemon_threads = True
threading.Thread(target=srv.serve_forever, daemon=True).start(); B = f'http://127.0.0.1:{srv.server_address[1]}/'
res = []
def check(name, ok, info=''): res.append(bool(ok)); print(f"{'PASS' if ok else 'FAIL'}  {name}  {info}")
def browser(p, wav): return p.chromium.launch(args=['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', f'--use-file-for-fake-audio-capture={WAV}/{wav}.wav', '--autoplay-policy=no-user-gesture-required'])
def classify(p, wav, samples=None, secs=8):  # as in teach.py: the label most frames show, on a fresh screen
    b = browser(p, wav); pg = b.new_page(viewport={'width': 390, 'height': 844}); pg.goto(B + '#screen')
    if samples: pg.set_input_files('#tImportFile', samples)
    pg.click('#start'); votes = {}; drone = False
    for i in range(4 + secs * 2):
        time.sleep(0.5); s = pg.evaluate('window.__rotor')
        if s['state'] == 'drone': drone = True
        if i >= 8: lab = s['cls']['label'] if s['cls'] and s['state'] != 'quiet' else 'QUIET'; votes[lab] = votes.get(lab, 0) + 1
    b.close(); top = max(votes, key=votes.get); return top, round(100 * votes[top] / sum(votes.values())), drone
def label(e, tag, text='', note='', keep=False, shot=None):
    t0 = time.time()
    while not e.evaluate('__node.lab.state.shown') and time.time() - t0 < 20: time.sleep(0.3)
    shown = e.evaluate('__node.lab.state'); e.click(f'#lbChips [data-t={tag}]')
    if text: e.fill('#lbText', text)
    if note: e.fill('#lbNote', note)
    if keep: e.check('#lbKeep')
    if shot: e.locator('#label').scroll_into_view_if_needed(); e.screenshot(path=shot)
    e.click('#lbSave'); e.wait_for_function("!__node.lab.state.busy && /Saved/.test(document.getElementById('lbMsg').textContent)", timeout=15000)
    time.sleep(3)  # the sound keeps playing: the next label gets a fresh fingerprint
    return shown

with sync_playwright() as p:
    before = {k: classify(p, k + '_test') for k in ('hexa', 'boxfans')}
    bs = browser(p, 'silence'); sc = bs.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, accept_downloads=True); s = sc.new_page(); errs = []
    s.on('pageerror', lambda er: errs.append('screen ' + str(er)))
    s.goto(B + '#screen'); s.evaluate("localStorage.clear(); localStorage.setItem('rotorear-mute-until', Date.now() + 6e5)"); s.reload()
    s.click('#tabPhones'); s.click('#pCreate'); time.sleep(1.5); room = s.inner_text('#pRoomCode').lower(); s.click('#phones [data-close]')
    ears = {}
    for wav, name in (('hexa_teach', 'Hedge'), ('boxfans_teach', 'Shed')):
        b = browser(p, wav); c = b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, accept_downloads=True); e = c.new_page()
        e.on('pageerror', lambda er: errs.append('ear ' + str(er))); e.goto(B + '?room=' + room); e.evaluate('localStorage.clear()'); e.reload()
        e.fill('#nName', name); e.dispatch_event('#nName', 'change'); e.click('#nStart'); ears[name] = (b, c, e)
    h = ears['Hedge'][2]; f = ears['Shed'][2]
    check('label card hidden before anything is heard', not h.evaluate('__node.lab.state.shown') or h.evaluate('__node.out.state') != 'quiet')
    st = label(h, 'quad', note='over the hedge, north side', keep=True, shot=SHOT and f'{SHOT}/label-flow.png'); label(h, 'quad'); label(h, 'quad')
    check('label card offered during a detection', st['shown'] and st['last'], f"app guessed {st['last'] and st['last']['guess']} @ {st['last'] and round(st['last']['f0'])} Hz")
    label(f, 'notdrone'); label(f, 'notdrone'); label(f, 'other', text='box fans')
    hs = h.evaluate('RotorSamples.list'); fs = f.evaluate('RotorSamples.list')
    check('ear keeps its labelled samples (feeds Teach)', [x['tag'] for x in hs] == ['quad'] * 3 and sorted(x['tag'] for x in fs) == ['notdrone', 'notdrone', 'other'], f"{len(hs)} + {len(fs)} samples")
    check('notes and Other text kept on the ear', hs[0].get('note') == 'over the hedge, north side' and any(x.get('text') == 'box fans' for x in fs))
    clip = h.evaluate(f"RotorSamples.clip('{hs[0]['id']}').then(b => b ? b.size : 0)")
    check('optional clip kept on the ear only', hs[0].get('clip') and clip > 1000, f'{clip} bytes in IndexedDB')
    check("ear's detector uses its labels", h.evaluate('__node.out.cls && __node.out.cls.label') == 'Quadcopter', str(h.evaluate('__node.out.cls && [__node.out.cls.label, __node.out.cls.learned]')))
    t0 = time.time()
    while len(s.evaluate('__lib.list')) < 6 and time.time() - t0 < 15: time.sleep(0.5)
    lib = s.evaluate('__lib.list'); keys = set().union(*[set(x) for x in lib]) if lib else set()
    check('screen library got all 6 labels, once each', len(lib) == 6 and len({x['id'] for x in lib}) == 6, f'{len(lib)} entries from phones {sorted({x["by"] for x in lib})}')
    check('library holds numbers + label only (no notes, no audio)', keys <= {'id', 'tag', 'x', 'f0', 't', 'text', 'by'} and all(len(x['x']) == 6 for x in lib), str(sorted(keys)))
    # ear export → import into a fresh ear (Teach format)
    with h.expect_download() as dl: h.click('#lbExport')
    d = json.load(open(dl.value.path()))
    check('ear export is the Teach format', d.get('app') == 'rotor-ear' and d.get('kind') == 'samples' and len(d['samples']) == 3 and 'note' in d['samples'][0] and not any('clip' in x for x in d['samples']))
    e2 = ears['Shed'][0].new_context().new_page(); e2.goto(B + '?room=zz' + room); e2.evaluate('localStorage.clear()'); e2.reload(); e2.set_input_files('#lbImportFile', dl.value.path()); time.sleep(0.5)
    check('import on another ear', e2.evaluate('RotorSamples.list.length') == 3 and 'Imported 3' in e2.inner_text('#lbLMsg'), e2.inner_text('#lbLMsg'))
    if SHOT: h.locator('#lbList').scroll_into_view_if_needed(); h.screenshot(path=f'{SHOT}/ear-labels.png')
    # screen: library → Teach → export → classify the held-out recordings
    s.click('#tabTeach'); time.sleep(0.5)
    if SHOT: s.locator('#libList').scroll_into_view_if_needed(); s.screenshot(path=f'{SHOT}/library.png')
    s.click('#libAdd'); time.sleep(0.5); check('Add all to Teach', s.evaluate('__teach.samples.length') == 6 and 'Added 6' in s.inner_text('#tMsg'), s.inner_text('#tMsg'))
    with s.expect_download() as dl2: s.click('#tExport')
    path = os.path.join(WAV, 'fieldkit-library.json'); dl2.value.save_as(path)  # (downloads vanish with their browser)
    for name, (b, c, e) in ears.items(): b.close()
    bs.close()
    for snd, exp in (('hexa', 'Quadcopter'), ('boxfans', 'Not a drone')):
        a = classify(p, snd + '_test', path); b0 = before[snd]
        ok = b0[0] != exp and a[0] == exp and (exp != 'Not a drone' or not a[2])
        check(f'{snd}_test: wrong before, right after the labels', ok, f"before {b0[0]} {b0[1]}% · after {a[0]} {a[1]}%{' (DRONE banner)' if a[2] else ''}")
    check('no page errors', not errs, '; '.join(errs[:3]))
print('ALL PASS' if all(res) else 'SOME FAILED')
