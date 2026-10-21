# Mesh accuracy test over the real PeerJS relay: opens mesh/ as the map and mesh/sim.html as 3-4 virtual phones,
# then prints loudness-only vs arrival-time-only vs fused position error and heading error against the sim truth.
# usage: python test/mesh.py <circle|eight|line|hover> <3|4> <seconds> ["&speed=1&off=400&jit=1&bias=0"]   (static server on :5311)
import os, time, sys, random, string, statistics as stx
from playwright.sync_api import sync_playwright
room='t'+''.join(random.choice('abcdefghjkmnpqrstuvwxyz23456789') for _ in range(5))
path=sys.argv[1] if len(sys.argv)>1 else 'circle'; N=sys.argv[2] if len(sys.argv)>2 else '4'; dur=int(sys.argv[3]) if len(sys.argv)>3 else 40
BASE='http://127.0.0.1:5311/mesh/'
EXTRA=sys.argv[4] if len(sys.argv)>4 else ''
with sync_playwright() as p:
    b=p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
    mc=b.new_context(viewport={'width':430,'height':900}, device_scale_factor=2)
    m=mc.new_page(); logs=[]; m.on('console', lambda x: logs.append(x.text)); m.on('pageerror', lambda e: logs.append('ERR '+str(e)))
    m.goto(BASE+f'#room={room}&role=map'); time.sleep(4); print('map status:', m.inner_text('#mStatus'))
    sc=b.new_context(); s=sc.new_page(); s.on('pageerror', lambda e: logs.append('SIMERR '+str(e)))
    s.goto(BASE+f'sim.html#room={room}&n={N}&path={path}'+EXTRA); s.click('#sStart')
    errs=[]; t0=time.time(); shot=False
    while time.time()-t0<dur:
        time.sleep(1); M=m.evaluate('window.__map'); 
        print(f"t={time.time()-t0:4.0f} n={M['nodes']} agree={M['agree']} {M['banner']:6s} est={M['est']} truth={M['truth']} errL={M.get('errL')} errT={M.get('errT')} errF={M.get('errF')} pairs={len(M.get('pairs') or [])} head={M.get('headErr')} sync={M.get('sync')}", flush=True)
        if time.time()-t0>15 and M.get('errL') is not None: errs.append((M.get('errL'),M.get('errT'),M.get('errF'),(M.get('headErr') or {}).get('both'),(M.get('headErr') or {}).get('loud'),(M.get('headErr') or {}).get('doppler')))
        if os.environ.get('SHOT') and not shot and M.get('pairs') and time.time()-t0>25:
            m.screenshot(path=os.environ['SHOT'], full_page=True); shot=True
    print('sim nodes:', s.inner_text('#sNodes').replace('\n',' | ')[:400])
    def col(i): v=[e[i] for e in errs if e[i] is not None]; return f"{stx.mean(v):.2f}" if v else '—'
    if errs: print(f"RESULT {path} {EXTRA}: loudness-only {col(0)} m | arrival-time-only {col(1)} m | fused {col(2)} m | heading err both {col(3)}° loud {col(4)}° doppler {col(5)}° (10 s rolling avgs, sampled n={len(errs)})")
    print('logs', logs[:10])
    b.close()
