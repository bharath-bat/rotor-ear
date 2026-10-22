# Incident log: a demo drone episode is saved with start/end, class, peak score, phones agreeing, flight states and
# track points; it survives a reload; the Log sheet lists it and tapping it replays the track; JSON export and the
# printable report (one A4 page as PDF) work; Clear all asks first.  usage: [SHOTS=dir] python test/log.py
import os, time, json, functools, threading, socketserver, http.server, re
from playwright.sync_api import sync_playwright
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__))); SHOTS = os.environ.get('SHOTS')
class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
srv = socketserver.ThreadingTCPServer(('127.0.0.1', 0), functools.partial(Quiet, directory=ROOT)); srv.daemon_threads = True
threading.Thread(target=srv.serve_forever, daemon=True).start(); B = f'http://127.0.0.1:{srv.server_address[1]}/'
res = []
def check(name, ok, info=''): res.append(ok); print(f"{'PASS' if ok else 'FAIL'}  {name}  {info}")
with sync_playwright() as p:
    b = p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
    ctx = b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, accept_downloads=True); pg = ctx.new_page(); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e))); pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
    pg.goto(B + '#screen'); pg.evaluate("localStorage.clear(); localStorage.setItem('rotorear-mute-until', Date.now() + 6e5)")
    pg.goto(B + '#demo&path=circle'); pg.reload(); t0 = time.time()
    while pg.evaluate('__watch.s') != 'drone' and time.time() - t0 < 25: time.sleep(0.3)
    time.sleep(14); pg.click('#start'); time.sleep(0.5)  # Exit demo → start screen; the episode is closed and saved
    pg.reload(); time.sleep(0.5)
    L = pg.evaluate('RotorLog.list'); e = L[0] if L else {}
    check('episode saved and survives a reload', len(L) >= 1 and e.get('type') == 'drone', f"{len(L)} entries")
    check('fields: start/end, class, peak, phones, flight, track', e.get('t1', 0) - e.get('t0', 0) > 8000 and e.get('cls') == 'Quadcopter' and e.get('peak', 0) >= 65 and e.get('agree', '').endswith('phones agree')
          and len(e.get('flights', [])) >= 1 and len(e.get('track', [])) >= 15 and e.get('demo') is True and len(e.get('pins', [])) == 4,
          f"{(e.get('t1', 0) - e.get('t0', 0)) / 1000:.1f} s · {e.get('cls')} · peak {e.get('peak')} · {e.get('agree')} · {e.get('flights')} · {len(e.get('track', []))} points · demo {e.get('demo')}")
    pg.click('[data-go=screen]'); pg.click('#more'); pg.click('#mLog'); time.sleep(0.6)
    rows = pg.locator('#logList [data-inc]').count(); check('Log sheet lists it', rows == len(L), f"{rows} rows")
    if SHOTS: pg.screenshot(path=os.path.join(SHOTS, 'log-sheet.png'))
    pg.click('#logList [data-inc]'); time.sleep(6)
    rp = pg.evaluate('__log.replay'); check('tap → replay on the map', bool(rp) and rp['id'] == e.get('id') and pg.is_visible('#replayBar') and not pg.is_visible('#logS'), str(rp))
    if SHOTS: pg.screenshot(path=os.path.join(SHOTS, 'replay.png'))
    pg.click('#replayX'); check('✕ stops the replay', pg.evaluate('__log.replay') is None)
    pg.click('#more'); pg.click('#mLog'); time.sleep(0.3)
    with pg.expect_download() as dl: pg.click('#lExport')
    j = json.load(open(dl.value.path())); check('Export JSON', j.get('app') == 'Rotor Ear' and len(j['incidents']) == len(L) and j['incidents'][0]['track'] == e['track'], dl.value.suggested_filename)
    with ctx.expect_page() as rpage: pg.click('#lReport')
    r = rpage.value; r.wait_for_load_state(); r.set_viewport_size({'width': 390, 'height': 844}); html = r.content()
    check('printable report opens', 'incident report' in html and html.count('<tr>') == len(L) + 1 and '<polyline' in html and 'DEMO' in html, f"{html.count('<tr>') - 1} rows")
    if SHOTS: r.screenshot(path=os.path.join(SHOTS, 'report.png'), full_page=True)
    pdf = r.pdf(format='A4', print_background=True); pages = len(re.findall(rb'/Type\s*/Page[^s]', pdf))
    check('report prints to one A4 page', pages == 1, f"{pages} page(s), {len(pdf) // 1024} KB")
    if SHOTS: open(os.path.join(SHOTS, 'report.pdf'), 'wb').write(pdf)
    r.close()
    pg.once('dialog', lambda d: d.dismiss()); pg.click('#lClear'); time.sleep(0.3)
    check('Clear all → cancel keeps the log', len(pg.evaluate('RotorLog.list')) == len(L))
    pg.once('dialog', lambda d: d.accept()); pg.click('#lClear'); time.sleep(0.5); pg.reload(); time.sleep(0.5)
    check('Clear all → OK empties it (after reload too)', pg.evaluate('RotorLog.list.length') == 0)
    check('no page errors', not errs, str(errs[:3]))
    b.close()
print('ALL PASS' if all(res) else 'FAIL')
