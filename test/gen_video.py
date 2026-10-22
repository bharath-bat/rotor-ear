# Synthetic camera clips for "Bird or Bot" (Chromium fake camera, .y4m): sky gradient, optional tree line and hand shake.
#   bird_flap    a small bird crossing, wings beating 6 Hz (flap bursts with short glides), hand-held shake
#   bird_glide   a wide-winged bird circling on fixed wings (banks as it turns), no flap
#   drone_hover  a quadcopter hovering with slow drift, hand-held shake, tree line
#   drone_drift  a quadcopter drifting slowly in a straight line
#   sky          empty sky, clouds drifting, sensor noise
# usage: python test/gen_video.py   → test/video/*.y4m (320x240, 30 fps, 10 s; Chromium loops the file)
import os, numpy as np
ROOT = os.path.dirname(os.path.abspath(__file__)); OUT = os.path.join(ROOT, 'video'); os.makedirs(OUT, exist_ok=True)
W, H, FPS, SEC, SS = 320, 240, 30, 10, 2  # SS: supersampling for smooth edges
yy, xx = np.mgrid[0:H * SS, 0:W * SS] / SS
def poly(px, py):  # filled polygon mask (supersampled grid), even-odd rule
    m = np.zeros(xx.shape, bool); n = len(px)
    for i in range(n):
        x1, y1, x2, y2 = px[i], py[i], px[(i + 1) % n], py[(i + 1) % n]
        if y1 == y2: continue
        c = ((yy >= min(y1, y2)) & (yy < max(y1, y2))) & (xx < x1 + (yy - y1) * (x2 - x1) / (y2 - y1)); m ^= c
    return m
def ell(cx, cy, rx, ry): return ((xx - cx) / rx) ** 2 + ((yy - cy) / ry) ** 2 <= 1
def down(a): return a.reshape(H, SS, W, SS).mean(axis=(1, 3))
SKY = 165 + 35 * (np.arange(H)[:, None] / H) * np.ones((1, W))  # luma: deeper blue up high, brighter toward the horizon
rng = np.random.default_rng(7)
def trees():
    x = np.arange(W); h = 18 + 6 * np.sin(x / 9) + 4 * np.sin(x / 3.3 + 1) + rng.normal(0, 1.5, W).cumsum() * 0.1
    return (np.arange(H)[:, None] > H - h[None, :])
TREE = trees()
def bird(cx, cy, ang, span=13, body=5):  # seen from below: body + two broad wings, root chord 4 px tapering to the tip
    m = ell(cx, cy, body, 2.0)
    for s in (-1, 1):
        tx, ty = cx + s * span * np.cos(ang), cy - span * np.sin(ang)
        m |= poly([cx, tx, tx, cx], [cy - 2.2, ty - 0.9, ty + 0.9, cy + 2.2])
    return m
def drone(cx, cy, k=1.0):
    m = ell(cx, cy, 3.5 * k, 2 * k) | poly([cx - 9 * k, cx + 9 * k, cx + 9 * k, cx - 9 * k], [cy - 0.6 * k, cy - 0.6 * k, cy + 0.6 * k, cy + 0.6 * k])
    r = ell(cx - 9 * k, cy - 1.5 * k, 4 * k, 1.1 * k) | ell(cx + 9 * k, cy - 1.5 * k, 4 * k, 1.1 * k)  # rotor discs: a steady blur
    return m, r
def shake(t, a):  # hand tremor: a few incommensurate wobbles, ~1–3 Hz
    return a * (0.6 * np.sin(2 * np.pi * 1.3 * t) + 0.4 * np.sin(2 * np.pi * 2.7 * t + 1)), a * (0.5 * np.sin(2 * np.pi * 1.7 * t + 2) + 0.5 * np.sin(2 * np.pi * 0.9 * t))
def frame(t, kind):
    y = SKY.copy(); dx = dy = 0.0
    if kind in ('bird_flap', 'drone_hover'): dx, dy = shake(t, 2.0)
    if kind == 'sky':
        for i, (x0, y0, r) in enumerate(((40, 60, 45), (200, 110, 60), (290, 40, 35))):
            cx = (x0 + 3 * t) % (W + 120) - 60; y += 22 * np.exp(-(((np.arange(W)[None, :] - cx) / r) ** 2 + ((np.arange(H)[:, None] - y0) / (r * 0.45)) ** 2))
    obj = rot = None
    if kind == 'bird_flap':
        ph = t % 1.6; flap = ph < 1.2  # 1.2 s of flapping, 0.4 s glide
        ang = 0.6 * np.sin(2 * np.pi * 6 * t) if flap else 0.12
        fold = 0.8 - 0.2 * np.cos(2 * np.pi * 6 * t) if flap else 1.0  # wings spread on the downstroke, half folded on the way up
        obj = bird(20 + 28 * t + dx, 110 + 6 * np.sin(2 * np.pi * 0.35 * t) + dy, ang, span=13 * fold)
    elif kind == 'bird_glide':
        a = 2 * np.pi * t / 7; bank = np.cos(a)  # wings look shorter when it banks away
        obj = bird(160 + 85 * np.sin(a), 105 + 35 * np.cos(a) + 2 * t, 0.15 + 0.05 * bank, span=16 * (0.75 + 0.25 * abs(bank)), body=9)
    elif kind == 'drone_hover':
        obj, rot = drone(165 + 6 * np.sin(2 * np.pi * 0.11 * t) + 3 * np.sin(2 * np.pi * 0.23 * t + 1) + dx, 95 + 4 * np.sin(2 * np.pi * 0.17 * t) + dy)
    elif kind == 'drone_drift':
        obj, rot = drone(70 + 14 * t, 80 + 5 * t)
    if obj is not None:
        y = np.where(down(obj) > 0, y * (1 - down(obj)) + 45 * down(obj), y)
    if rot is not None:
        r = down(rot) * 0.45; y = y * (1 - r) + 90 * r
    if kind in ('drone_hover',):
        tr = np.roll(np.roll(TREE, int(round(dy)), 0), int(round(dx)), 1); y = np.where(tr, 55, y)
    y = y + rng.normal(0, 2.0, y.shape)
    return np.clip(y, 0, 255).astype(np.uint8)
for kind in ('bird_flap', 'bird_glide', 'drone_hover', 'drone_drift', 'sky'):
    with open(os.path.join(OUT, kind + '.y4m'), 'wb') as f:
        f.write(f'YUV4MPEG2 W{W} H{H} F{FPS}:1 Ip A1:1 C420jpeg\n'.encode())
        u = np.full((H // 2, W // 2), 142, np.uint8).tobytes(); v = np.full((H // 2, W // 2), 112, np.uint8).tobytes()  # a blue-ish sky tint
        for i in range(FPS * SEC): f.write(b'FRAME\n' + frame(i / FPS, kind).tobytes() + u + v)
    print('wrote', kind)
