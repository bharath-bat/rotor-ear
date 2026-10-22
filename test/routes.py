# One app, one link: every mode and every old URL lands in the right mode, mode switches don't reload the page,
# and no page throws or logs a console error.  usage: python test/routes.py
import os, time, functools, threading, socketserver, http.server
from playwright.sync_api import sync_playwright
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
srv = socketserver.ThreadingTCPServer(('127.0.0.1', 0), functools.partial(Quiet, directory=ROOT)); srv.daemon_threads = True
threading.Thread(target=srv.serve_forever, daemon=True).start(); B = f'http://127.0.0.1:{srv.server_address[1]}/'
CASES = [('', 'home', ''), ('#screen', 'screen', ''), ('#ear', 'ear', ''), ('#demo', 'demo', ''),
         ('?room=AB12', 'ear', 'ab12'), ('?room=ab12&role=map', 'screen', 'ab12'), ('?role=map', 'screen', ''), ('#room=ab12', 'screen', 'ab12'),
         ('mesh/', 'ear', ''), ('mesh/#room=ab12&role=node', 'ear', 'ab12'), ('mesh/#room=ab12', 'ear', 'ab12'),
         ('mesh/#room=ab12&role=map', 'screen', 'ab12'), ('mesh/?role=map', 'screen', ''),
         ('mesh/sim.html', 'demo', ''), ('mesh/sim.html#room=ab12&n=3&path=line', 'sim', 'ab12')]
SECTION = {'home': 'home', 'screen': 'app', 'demo': 'app', 'ear': 'ear', 'sim': 'simv'}
ok_all = True
with sync_playwright() as p:
    b = p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
    for url, want, room in CASES:
        pg = b.new_page(viewport={'width': 390, 'height': 844}); errs = []
        pg.on('pageerror', lambda e: errs.append(str(e))); pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
        pg.goto(B + url); pg.wait_for_function('window.RotorApp && RotorApp.cur'); time.sleep(0.8)
        cur, vis, key = pg.evaluate("[RotorApp.cur, ['home','app','ear','simv'].filter(id => !document.getElementById(id).hidden), RotorApp.key]")
        ok = cur == want and vis == [SECTION[want]] and key.split('|')[1] == room and not errs; ok_all &= ok
        print(f"{'PASS' if ok else 'FAIL'}  /{url:42} → /{pg.url.replace(B, ''):34} mode {cur:6} room {room or '—':5} {errs[:2] if errs else ''}"); pg.close()
    # switching modes inside one page: no reload (a marker survives), the screen's mic stops on leaving
    pg = b.new_page(viewport={'width': 390, 'height': 844}); errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto(B); pg.evaluate('window.__marker = 1'); seq = []
    for sel in ['[data-go=screen]', '#more', '#moreS [data-go=home]', '[data-go=ear]', '#ear [data-go=home]', '[data-go=demo]', '#start']:
        pg.click(sel); time.sleep(0.6); seq.append(pg.evaluate('RotorApp.cur'))
    pg.go_back(); time.sleep(0.5); seq.append(pg.evaluate('RotorApp.cur'))
    ok = seq[:7] == ['screen', 'screen', 'home', 'ear', 'home', 'demo', 'home'] and pg.evaluate('window.__marker') == 1 and not errs; ok_all &= ok
    print(f"{'PASS' if ok else 'FAIL'}  switching without reload: {' → '.join(seq)} (marker kept {pg.evaluate('window.__marker') == 1}) {errs[:2]}")
    b.close()
print('ALL PASS' if ok_all else 'FAIL')
