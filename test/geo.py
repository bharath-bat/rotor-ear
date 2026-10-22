# Street map frame: (1) GPS ↔ local-metre frame math (RotorMesh.Geo): round trips, rotation recovery, bearings,
# noisy GPS, one-phone fallback. (2) End to end over the relay: 3 ears share GPS (Playwright geolocation), the screen
# turns on the street map and its phone pins land on their GPS spots on the Leaflet map; with failing tiles or no GPS it
# falls back to the plain map. Tiles are a local stub (no OpenStreetMap traffic from tests) unless OSM=1.
# usage: [OSM=1] [SHOTS=dir] python test/geo.py
import os, time, math, struct, zlib, functools, threading, socketserver, http.server
from playwright.sync_api import sync_playwright
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__))); SHOTS = os.environ.get('SHOTS'); OSM = os.environ.get('OSM') == '1'
class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
srv = socketserver.ThreadingTCPServer(('127.0.0.1', 0), functools.partial(Quiet, directory=ROOT)); srv.daemon_threads = True
threading.Thread(target=srv.serve_forever, daemon=True).start(); B = f'http://127.0.0.1:{srv.server_address[1]}/'
def png(w=256):  # a light tile with a grid, so the stub map is visibly a map
    rows = b''.join(b'\x00' + b''.join(bytes([200, 205, 210] if (x % 64 < 2 or y % 64 < 2) else [236, 234, 228]) for x in range(w)) for y in range(w))
    ch = lambda t, d: struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    return b'\x89PNG\r\n\x1a\n' + ch(b'IHDR', struct.pack('>IIBBBBB', w, w, 8, 2, 0, 0, 0)) + ch(b'IDAT', zlib.compress(rows)) + ch(b'IEND', b'')
TILE = png(); res = []
def check(name, ok, info=''): res.append(ok); print(f"{'PASS' if ok else 'FAIL'}  {name}  {info}")
LAT0, LON0, ROT = 12.97633, 77.59295, 30.0  # Cubbon Park, Bengaluru; the plan is turned 30° from north
def gps(x, y):  # where a pin at local (x, y) really is, if the plan is rotated ROT° counter-clockwise from east/north
    c, s = math.cos(math.radians(ROT)), math.sin(math.radians(ROT)); e, n = c * x - s * y, s * x + c * y
    return LAT0 + math.degrees(n / 6371008.8), LON0 + math.degrees(e / (6371008.8 * math.cos(math.radians(LAT0))))
with sync_playwright() as p:
    args = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required']
    b = p.chromium.launch(args=args + [f'--use-file-for-fake-audio-capture={ROOT}/test/wav/quad.wav'])
    # ---- 1) frame math ----
    pg = b.new_page(); pg.goto(B + '#screen')
    m = pg.evaluate("""([LAT0, LON0, ROT, pts]) => { const G = RotorMesh.Geo, out = {};
      const [la, lo] = G.fromEnu(LAT0, LON0, 123.4, -56.7), q = G.enu(LAT0, LON0, la, lo); out.round = Math.hypot(q[0] - 123.4, q[1] + 56.7);
      const P = pts.map(p => ({ pos: p[0], geo: p[1] })), f = G.frame(P); out.rot = f.rot * 180 / Math.PI; out.res = f.res; out.n = f.n;
      const t = f.toLatLng(3, 3), back = f.fromLatLng(t[0], t[1]); out.inv = Math.hypot(back[0] - 3, back[1] - 3);
      out.pinErr = Math.max(...P.map(p => { const ll = f.toLatLng(p.pos[0], p.pos[1]), d = G.enu(p.geo[0], p.geo[1], ll[0], ll[1]); return Math.hypot(d[0], d[1]); }));
      out.bearingUp = f.bearing(0, 1); out.bearingRight = f.bearing(1, 0);
      const one = G.frame([P[0]]); out.oneRot = one.rot; out.oneOrigin = Math.hypot(...G.enu(P[0].geo[0], P[0].geo[1], ...one.toLatLng(0, 0)));
      // noisy GPS (±3 m per phone, a fixed pseudo-random pattern)
      const nz = [[2.1, -1.4], [-2.6, 1.9], [1.2, 2.7], [-1.8, -2.2]], N = P.map((p, i) => ({ pos: p.pos, geo: G.fromEnu(p.geo[0], p.geo[1], nz[i][0], nz[i][1]) })), fn = G.frame(N);
      out.noisyRot = fn.rot * 180 / Math.PI; out.noisyRes = fn.res; out.none = G.frame([{ pos: [0, 0], geo: null }]); return out; }""",
      [LAT0, LON0, ROT, [[[x, y], list(gps(x, y))] for x, y in [(0, 0), (6, 0), (6, 6), (0, 6)]]])
    check('ENU round trip', m['round'] < 1e-6, f"{m['round']:.1e} m")
    check('4 GPS phones: rotation recovered', abs(m['rot'] - ROT) < 0.01 and m['res'] < 0.01 and m['n'] == 4, f"{m['rot']:.3f}° (true {ROT}°), fit ±{m['res']} m")
    check('local ↔ lat/lon inverse', m['inv'] < 1e-6 and m['pinErr'] < 0.01, f"pins within {m['pinErr']:.4f} m of their GPS")
    check('bearings from true north', abs(m['bearingUp'] - 330) < 0.01 and abs(m['bearingRight'] - 60) < 0.01, f"plan up = {m['bearingUp']:.1f}°, plan right = {m['bearingRight']:.1f}°")
    check('one GPS phone: origin only, no rotation', m['oneRot'] == 0 and m['oneOrigin'] < 1e-6)
    check('noisy GPS (±3 m): rotation within 25°', abs(m['noisyRot'] - ROT) < 25 and m['noisyRes'] > 0.5, f"{m['noisyRot']:.1f}°, fit ±{m['noisyRes']} m")
    check('no GPS → no frame', m['none'] is None)
    pg.close()
    # ---- 2) end to end over the relay ----
    def run(tiles_ok=True, with_gps=True):
        sc = b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2); s = sc.new_page(); errs = []
        s.on('pageerror', lambda e: errs.append(str(e)))
        if not OSM or not tiles_ok: s.route('**/tile.openstreetmap.org/**', lambda r: r.fulfill(status=200, content_type='image/png', body=TILE) if tiles_ok else r.abort())
        s.goto(B + '#screen'); s.evaluate("localStorage.clear(); localStorage.setItem('rotorear-mute-until', Date.now() + 6e5); localStorage.setItem('rotorear-geomap', '1')")
        s.reload(); s.click('#tabPhones'); s.click('#pCreate'); time.sleep(1.5); room = s.inner_text('#pRoomCode').lower(); s.click('#phones [data-close]')
        ears = []
        for i, (x, y) in enumerate([(0, 0), (6, 0), (6, 6)]):
            la, lo = gps(x, y); ec = b.new_context(viewport={'width': 390, 'height': 844}, geolocation={'latitude': la, 'longitude': lo, 'accuracy': 4}, permissions=['geolocation'])
            e = ec.new_page(); e.goto(B + '?room=' + room); e.click('#nStart')
            if with_gps: e.check('#nGeo')
            t0 = time.time()
            while s.evaluate('__map.nodes || 0') < i + 1 and time.time() - t0 < 30: time.sleep(0.5)
            ears.append(ec)
        time.sleep(4)
        out = s.evaluate("""() => { const G = __geo, f = G.frame, P = G.project(1); const nodes = (window.__map && __map.nodes) || 0;
          if (!G.shown || !P || !f) return { shown: G.shown, frame: !!f, tiles: G.tiles, nodes };
          const st = __mapNodes().filter(n => n.geo); return { shown: true, tiles: G.tiles, rot: f.rot * 180 / Math.PI, n: f.n, nodes,
            px: st.map(n => { const a = P.W2P(n.pos[0], n.pos[1]), q = G.map.latLngToContainerPoint([n.geo[0], n.geo[1]]); return Math.hypot(a[0] - q.x, a[1] - q.y); }) }; }""")
        return s, sc, ears, out, errs
    s, sc, ears, o, errs = run()
    check('3 ears share GPS → street map shown', o.get('shown') and o.get('n') == 3 and o['tiles']['ok'] > 0, f"tiles {o.get('tiles')}, frame from {o.get('n')} phones, rotation {o.get('rot', 0):.1f}°")
    check('phone pins sit on their GPS spots', o.get('px') and max(o['px']) < 3, f"max {max(o.get('px') or [99]):.2f} px off")
    check('attribution shown', 'OpenStreetMap' in s.inner_text('#geomap'))
    if SHOTS: s.screenshot(path=os.path.join(SHOTS, 'street-map.png'))
    check('no page errors', not errs, str(errs[:2]))
    for c in ears + [sc]: c.close()
    s, sc, ears, o, _ = run(tiles_ok=False)
    check('tiles fail → plain map', not o.get('shown') and o['tiles']['bad'] >= 3, f"tiles {o.get('tiles')}")
    for c in ears + [sc]: c.close()
    s, sc, ears, o, _ = run(with_gps=False)
    check('no GPS → plain map', not o.get('shown') and not o.get('frame'))
    for c in ears + [sc]: c.close()
    b.close()
print('ALL PASS' if all(res) else 'FAIL')
