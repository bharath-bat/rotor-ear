# Teach-mode test: a sound the hand-set profiles get wrong is classified before teaching, then 3 clips of a
# *different* recording of the same kind are taught through the real Teach UI (fake mic → Record 5 s → Export),
# and the held-out test recording is classified again after Import.  usage: python test/teach.py
import os, sys, json, time, functools, threading, http.server, socketserver
from playwright.sync_api import sync_playwright
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__))); WAV = os.path.join(ROOT, 'test', 'wav')
CASES = [('hexa', 'quad', 'Quadcopter'), ('boxfans', 'fan', 'Not a drone')]  # (sound, tag taught, expected label)
OUT = os.path.join(ROOT, 'test', 'wav', 'taught-samples.json')
class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
srv = socketserver.ThreadingTCPServer(('127.0.0.1', 0), functools.partial(Quiet, directory=ROOT))
PORT = srv.server_address[1]; threading.Thread(target=srv.serve_forever, daemon=True).start()

def browser(p, wav):
    return p.chromium.launch(args=['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
        f'--use-file-for-fake-audio-capture={WAV}/{wav}.wav', '--autoplay-policy=no-user-gesture-required'])

def classify(p, wav, samples=None, secs=8):
    b = browser(p, wav); pg = b.new_page(viewport={'width': 390, 'height': 844})
    pg.goto(f'http://127.0.0.1:{PORT}/')
    if samples: pg.set_input_files('#tImportFile', samples)
    pg.click('#start'); votes = {}; learned = 0; drone = False; n = 0
    for i in range(4 + secs * 2):
        time.sleep(0.5); s = pg.evaluate('window.__rotor')
        if s['state'] == 'drone': drone = True
        if i < 8: continue
        lab = s['cls']['label'] if s['cls'] and s['state'] != 'quiet' else 'QUIET'
        votes[lab] = votes.get(lab, 0) + 1; n += 1
        if s['cls'] and s['cls'].get('learned'): learned += 1
    b.close()
    top = max(votes, key=votes.get)
    return top, round(100 * votes[top] / n), round(100 * learned / n), drone

def teach(p, wav, tag, clips=3):
    b = browser(p, wav); pg = b.new_context(accept_downloads=True).new_page()
    pg.goto(f'http://127.0.0.1:{PORT}/'); pg.click('#start'); time.sleep(3)
    pg.click('#tabTeach'); pg.select_option('#tTag', tag)  # Teach bottom sheet
    for k in range(clips):
        pg.click('#tRec'); pg.wait_for_function("!document.getElementById('tRec').disabled", timeout=15000)
        print('   teach clip', k + 1, '→', pg.inner_text('#tMsg'))
    with pg.expect_download() as dl: pg.click('#tExport')
    path = dl.value.path(); data = json.load(open(path)); b.close(); return data

with sync_playwright() as p:
    merged = None; before = {}
    for snd, tag, exp in CASES: before[snd] = classify(p, snd + '_test')
    for snd, tag, exp in CASES:
        print(f'teaching {tag!r} from {snd}_teach.wav')
        d = teach(p, snd + '_teach', tag)
        if merged is None: merged = d
        else: merged['samples'] += d['samples']
    json.dump(merged, open(OUT, 'w')); print('taught samples:', [(s['tag'], s['f0']) for s in merged['samples']])
    print(f"\n{'held-out test sound':20s} {'expected':12s} {'BEFORE teaching':28s} {'AFTER teaching':38s}")
    ok = True
    for snd, tag, exp in CASES:
        b0 = before[snd]; a = classify(p, snd + '_test', OUT)
        good_b, good_a = b0[0] == exp, a[0] == exp and (exp != 'Not a drone' or not a[3])
        ok &= good_a and not good_b
        print(f"{snd + '_test':20s} {exp:12s} {b0[0] + ' ' + str(b0[1]) + '%' + (' (DRONE banner)' if b0[3] else ''):28s} "
              f"{a[0] + ' ' + str(a[1]) + '%, 🎓 learned in ' + str(a[2]) + '% of frames' + (' (DRONE banner)' if a[3] else ''):38s} {'PASS' if good_a else 'FAIL'}")
    print('wrong before, right after: ' + ('YES' if ok else 'NO'))
    print('samples file for regression run:', OUT)
