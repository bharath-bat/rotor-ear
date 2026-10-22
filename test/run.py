# Feeds each synthetic WAV into Rotor Ear through Chromium's fake microphone and prints a confusion table.
# 'synth' = the page's own Test sound. Every file here holds one sound, so a second drone source is always a FAIL.
# usage: [SAMPLES=samples.json] python test/run.py [case ...]      (needs: pip install playwright && playwright install chromium)
import sys, os, time, json, threading, functools, http.server, socketserver
from multiprocessing import Pool
from playwright.sync_api import sync_playwright
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__))); WAV = os.path.join(ROOT, 'test', 'wav')
EXPECT = {'synth': 'Quadcopter', 'quad': 'Quadcopter', 'quad_hi': 'Quadcopter', 'fixed': 'Fixed-wing', 'toy': 'Micro drone',
          'fan': 'neg', 'mains': 'neg', 'engine': 'neg', 'moto': 'neg', 'tone': 'neg', 'white': 'neg', 'silence': 'neg', 'speech': 'neg',
          'hexa_test': 'Quadcopter', 'boxfans_test': 'neg'}
COLS = ['Quadcopter', 'Fixed-wing', 'Micro drone', 'Not a drone', 'QUIET']
PORT = 0  # set in __main__ to a free port

class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass

def case(name):
    with sync_playwright() as p:
        b = p.chromium.launch(args=['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
            f'--use-file-for-fake-audio-capture={WAV}/{"silence" if name == "synth" else name}.wav', '--autoplay-policy=no-user-gesture-required'])
        pg = b.new_page(viewport={'width': 390, 'height': 844})
        pg.goto(f'http://127.0.0.1:{PORT}/#screen')
        if os.environ.get('SAMPLES'): pg.set_input_files('#tImportFile', os.environ['SAMPLES'])  # taught samples (Teach → Import)
        pg.click('#start')
        if name == 'synth': pg.click('#tabTeach'); pg.click('#test'); pg.click('[data-close]')  # built-in Test sound (in the Teach sheet)
        votes, drone_seen, feats, two = {c: 0 for c in COLS}, False, None, 0
        for i in range(22):
            time.sleep(0.5); s = pg.evaluate('window.__rotor')
            if s['state'] == 'drone': drone_seen = True
            if sum(q['state'] == 'drone' for q in s['srcs']) > 1: two += 1
            if i < 8: continue  # let the 2 s fingerprint window fill
            if s['state'] == 'quiet' or not s['cls']: votes['QUIET'] += 1
            else: votes[s['cls']['label']] += 1; feats = s['cls']['raw']
        b.close()
    return name, votes, drone_seen, feats, two

if __name__ == '__main__':
    srv = socketserver.ThreadingTCPServer(('127.0.0.1', 0), functools.partial(Quiet, directory=ROOT))
    PORT = srv.server_address[1]; threading.Thread(target=srv.serve_forever, daemon=True).start()
    names = sys.argv[1:] or list(EXPECT)
    with Pool(4) as pool: res = pool.map(case, names)
    print(f"{'true \\ predicted':16s}" + ''.join(f'{c:>13s}' for c in COLS) + '   DRONE banner   2nd drone   result')
    ok_all = True
    for name, votes, drone_seen, feats, two in res:
        n = sum(votes.values()) or 1; top = max(votes, key=votes.get); exp = EXPECT[name]
        ok = (top == exp) if exp != 'neg' else (top in ('Not a drone', 'QUIET') and not drone_seen)
        # the *_test cases are only expected right after teaching (see test/teach.py); untaught they show the "before"
        before = name.endswith('_test') and not os.environ.get('SAMPLES')
        if two: ok = False; ok_all = False
        if not before: ok_all &= ok
        print(f'{name:16s}' + ''.join(f'{100 * votes[c] / n:12.0f}%' for c in COLS) + f'   {"yes" if drone_seen else "no ":>12s}   {two:9d}   {("wrong, as expected before teaching" if not ok else "right even untaught") if before else "PASS" if ok else "FAIL"}')
        if '-v' in os.environ.get('RUN_FLAGS', '') and feats: print('    ', json.dumps({k: round(v, 4) for k, v in feats.items()}))
    print('ALL PASS' if ok_all else 'SOME FAILED')
