# "Same drone again?": voiceprints kept on this phone. (1) scoring: identical prints 100, a few % off in pitch = possible,
# far pitch = new; pitch-only prints are never a full match. (2) the synthetic drone twice (circle path, 215 Hz): first visit
# → new tag Drone #1, second → "Seen before · Drone #1 … · N visits · S% match". (3) a different pitch (300 Hz) → new tag #2.
# (4) rename + forget from the Drone tags sheet; the name shows up in the status block, log, report and JSON export.
#   usage: [SHOTS=dir] python test/reid.py
import os, time, json, functools, threading, socketserver, http.server
from multiprocessing import Pool
from playwright.sync_api import sync_playwright
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__))); SHOTS = os.environ.get('SHOTS')
class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
PORT = 0
B = lambda: f'http://127.0.0.1:{PORT}/'
def page(p):
    b = p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
    c = b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, accept_downloads=True); pg = c.new_page(); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e))); pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
    pg.on('dialog', lambda d: d.accept()); return b, c, pg, errs
def visit(pg, f0, t=40):  # run the circle demo until the tag decision → (stTag class, text, reid)
    pg.goto(B() + '#screen'); pg.goto(B() + f'#demo&path=circle&f0={f0}'); pg.reload(); t0 = time.time()
    while time.time() - t0 < t:
        time.sleep(0.4); k = pg.evaluate("(() => { const e = document.getElementById('stTag'); return e.hidden ? '' : e.className; })()")
        if k and k != 'wait': break
    return k, pg.inner_text('#stTag'), pg.evaluate('RotorTags.list.map(t => ({n: t.n, f0: t.f0, visits: t.visits}))')
def stop(pg):
    if pg.is_visible('#start'): pg.click('#start'); time.sleep(0.4)

def scoring():
    R = []
    with sync_playwright() as p:
        b, c, pg, errs = page(p); pg.goto(B() + '#screen'); pg.evaluate('localStorage.clear()')
        s = pg.evaluate("""() => { const T = RotorTags, x = [0.1, 0.4, 0.7, 0.8, 0.2, 0], a = { f0: 215, x };
          return { same: T.score(a, a), near: T.score(a, { f0: 224, x }), far: T.score(a, { f0: 300, x }), fx: T.score(a, { f0: 215, x: [0.1, 0.9, 0.1, 0.2, 0.9, 0] }),
                   ponly: T.score({ f0: 215, x: null }, a), k: [100, 80, 79, 60, 59].map(T.kindOf) }; }""")
        R.append(('identical prints = 100 %', s['same'] == 100, str(s)))
        R.append(('4 % pitch difference = possible match', 60 <= s['near'] < 80))
        R.append(('300 Hz vs 215 Hz: far below new-tag line', s['far'] < 60))
        R.append(('same pitch, different fingerprint: not a sure match', s['fx'] < 80))
        R.append(('pitch only: at most 90 %', s['ponly'] == 90))
        R.append(('thresholds 80 / 60', s['k'] == ['match', 'match', 'possible', 'possible', 'new']))
        r = pg.evaluate("""() => { const T = RotorTags, now = Date.now(), a = T.assign({ f0: 215, x: null }, 'Quadcopter', false, now - 864e5 * 3);
          const b = T.assign({ f0: 216, x: null }, 'Quadcopter', false, now), d = T.assign({ f0: 215, x: null }, 'Quadcopter', true, now); return { a, b, d, text: T.text(b, true) }; }""")
        R.append(('real tags: new → then the same pitch matches it', r['a']['kind'] == 'new' and r['b']['kind'] == 'match' and r['b']['n'] == r['a']['n'] and r['b']['visits'] == 2, r['text']))
        R.append(('demo drones never match real tags', r['d']['kind'] == 'new'))
        R.append(('no page errors', not errs, str(errs[:2]))); b.close()
    return 'scoring', R

def visits():
    R = []
    with sync_playwright() as p:
        b, c, pg, errs = page(p); pg.goto(B() + '#screen'); pg.evaluate("localStorage.clear(); localStorage.setItem('rotorear-mute-until', Date.now() + 6e5)")
        k, txt, L = visit(pg, 215)
        R.append(('first visit (215 Hz) → new tag Drone #1', k == 'new' and 'New drone · tagged Drone #1' in txt and len(L) == 1, txt.replace('\n', ' ')))
        R.append(('voiceprint stored: pitch near 215 Hz', L and abs(L[0]['f0'] - 215) < 215 * 0.04, str(L)))
        R.append(('print has the fingerprint too', pg.evaluate('!!(RotorTags.list[0] && RotorTags.list[0].x)')))
        stop(pg)
        # make the first visit look like it was on an earlier evening, a few visits ago (for the words + screenshot)
        pg.evaluate("""() => { const L = JSON.parse(localStorage.getItem('rotorear-tags-v1')), d = new Date(); d.setDate(d.getDate() - 3); d.setHours(21, 40, 0, 0);
          L[0].last = d.getTime(); L[0].visits = 3; localStorage.setItem('rotorear-tags-v1', JSON.stringify(L)); }""")
        k, txt, L = visit(pg, 215)
        R.append(('same synthetic drone again → Seen before · Drone #1', k == 'match' and 'Seen before · Drone #1' in txt and len(L) == 1, txt.replace('\n', ' ')))
        R.append(('…last seen on that evening, 4 visits, match %', '9:40' in txt and '4 visits' in txt and '% match' in txt))
        if SHOTS: time.sleep(0.5); pg.screenshot(path=os.path.join(SHOTS, 'seen-before-alert.png'))
        # rename from the status line
        pg.click('#stTag'); time.sleep(0.4); R.append(('tapping it opens Drone tags, that drone first', pg.is_visible('#tagsS') and pg.locator('#tagList .tagrow.on').count() == 1))
        inp = pg.locator('#tagList input[data-name]').first; inp.fill("Neighbour's DJI"); inp.press('Enter'); inp.dispatch_event('change'); time.sleep(0.3)
        R.append(('rename saved', pg.evaluate('RotorTags.list[0].name') == "Neighbour's DJI"))
        if SHOTS: pg.screenshot(path=os.path.join(SHOTS, 'tag-rename.png'))
        pg.click('#tagsS [data-close]'); time.sleep(0.6); t2 = pg.inner_text('#stTag')
        R.append(('the name shows in the status block', "Neighbour's DJI" in t2, t2.replace('\n', ' ')))
        stop(pg)
        k, txt, L = visit(pg, 300)
        R.append(('different pitch (300 Hz) → new tag Drone #2', k == 'new' and 'Drone #2' in txt and len(L) == 2, txt.replace('\n', ' ')))
        stop(pg)
        pg.click('[data-go=screen]') if pg.is_visible('[data-go=screen]') else None; time.sleep(0.3)
        pg.click('#more'); pg.click('#mLog'); time.sleep(0.6); row = pg.inner_text('#logList')
        R.append(('log rows carry the tag chips', 'new #2' in row and '↺ #1' in row and 'new #1' in row, row.replace('\n', ' ')[:200]))
        if SHOTS: pg.screenshot(path=os.path.join(SHOTS, 'log-entries-tags.png'))
        with pg.expect_download() as dl: pg.click('#lExport')
        j = json.load(open(dl.value.path())); R.append(('JSON export: voiceprints + each incident\'s tag', len(j.get('droneTags', [])) == 2 and sum(1 for e in j['incidents'] if e.get('reid')) == 3, ''))
        with c.expect_page() as rp: pg.click('#lReport')
        r = rp.value; r.wait_for_load_state(); html = r.content()
        R.append(('printable report: "Seen before · Drone #1 “Neighbour\'s DJI”"', 'Seen before · Drone #1' in html and "Neighbour" in html))
        if SHOTS: r.set_viewport_size({'width': 800, 'height': 900}); r.screenshot(path=os.path.join(SHOTS, 'report-tags.png'), full_page=True)
        r.close(); pg.click('#logS [data-close]') if pg.is_visible('#logS [data-close]') else None
        # forget
        pg.click('#more'); pg.click('#mTags'); time.sleep(0.4); n = pg.locator('#tagList .tagrow').count()
        pg.locator('#tagList [data-forget]').last.click(); time.sleep(0.3)
        R.append(('Forget deletes a voiceprint (after confirm)', n == 2 and pg.locator('#tagList .tagrow').count() == 1 and len(pg.evaluate('JSON.parse(localStorage.getItem("rotorear-tags-v1"))')) == 1))
        R.append(('no page errors', not errs, str(errs[:2]))); b.close()
    return 'visits', R

def job(n): return {'s': scoring, 'v': visits}[n]()
if __name__ == '__main__':
    srv = socketserver.ThreadingTCPServer(('127.0.0.1', 0), functools.partial(Quiet, directory=ROOT)); srv.daemon_threads = True
    PORT = srv.server_address[1]; threading.Thread(target=srv.serve_forever, daemon=True).start()
    if SHOTS: os.makedirs(SHOTS, exist_ok=True)
    with Pool(2) as P: out = P.map(job, ['s', 'v'])
    ok = True
    for name, R in out:
        print(name)
        for t, good, *info in R: ok &= bool(good); print(f"  {'PASS' if good else 'FAIL'}  {t}{'  · ' + info[0] if info and info[0] else ''}")
    print('ALL PASS' if ok else 'SOME FAILED')
