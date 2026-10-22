// Rotor Ear · Bird or Bot: tell a bird from a drone in a camera-confirm clip, on this phone only (the video never leaves it).
// 1) Find the moving thing against the sky: each frame downscaled to 160×120, hand shake removed (a sub-pixel shift fitted to
//    the previous frame), a slow background model, pixels that differ from it by more than the noise and more than a sub-pixel
//    misalignment of an edge would explain, then the largest blob (kept near the last one), its centroid and size over time.
// 2) Motion signature: wing beats make the blob's area / height / shape pulse at 2–20 Hz (FFT of each, detrended); birds glide
//    in curves; drones keep a steady size and hover or fly straight (rotors are a steady blur at camera rate).
// 3) Optional appearance check: COCO-SSD (TensorFlow.js, loaded from a CDN) on the blob crop gives a "bird" score. COCO has no
//    drone class, so it only counts as bird evidence. Without it (offline) the verdict uses motion and sound only, and says so.
// 4) Fuse with what this phone heard (rotor harmonics or not) → Bird / Bot / Can't tell, a confidence and a reason code.
// Only { v, c, r, f, h, a } numbers go to the screen; RotorBird.text() turns them into words on both sides.
(function () {
  'use strict';
  const AW = 160, AH = 120, N = AW * AH, clamp = (x, a, b) => x < a ? a : x > b ? b : x;
  const med = a => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };
  const mean = a => a.reduce((s, v) => s + v, 0) / (a.length || 1);

  // ---- per-frame: stabilise, background, blob ----
  class Watcher {
    constructor() {
      this.cv = document.createElement('canvas'); this.cv.width = AW; this.cv.height = AH; this.g = this.cv.getContext('2d', { willReadFrequently: true });
      this.prev = null; this.bg = null; this.k = 0; this.T = []; this.frames = 0; this.shake = []; this.last = null; this.crops = [];
    }
    luma(src) {
      this.g.drawImage(src, 0, 0, AW, AH); const d = this.g.getImageData(0, 0, AW, AH).data, Y = new Float32Array(N);
      for (let i = 0; i < N; i++) Y[i] = 0.299 * d[4 * i] + 0.587 * d[4 * i + 1] + 0.114 * d[4 * i + 2];
      return Y;
    }
    // hand shake: the whole-frame shift (±3 px, then sub-pixel) that best lines this frame up with the previous one, measured
    // on edges only (trees, roofs, cloud rims) and away from the moving thing. A plain sky gives no grip: then no shift.
    shift(A, B) {
      const L = this.last, ex = L ? [L.box[0] * AW - 6, L.box[1] * AH - 6, L.box[2] * AW + 6, L.box[3] * AH + 6] : null, P = [];
      for (let y = 4; y < AH - 4; y++) for (let x = 4; x < AW - 4; x++) {
        if (ex && x > ex[0] && x < ex[2] && y > ex[1] && y < ex[3]) continue;
        const i = y * AW + x; if (Math.abs(B[i + 1] - B[i - 1]) + Math.abs(B[i + AW] - B[i - AW]) > 30) P.push(i);
      }
      if (P.length < 150) return [0, 0];
      const sad = (dx, dy) => { let s = 0; for (const i of P) s += Math.abs(B[i] - A[i + dy * AW + dx]); return s / P.length; };
      const S = {}; let bx = 0, by = 0, b = sad(0, 0); const s0 = b;
      for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) { const v = S[dx + ',' + dy] = sad(dx, dy); if (v < b) { b = v; bx = dx; by = dy; } }
      if (b > s0 * 0.97) return [0, 0];
      const p = (m, z, q) => { const d = m - 2 * z + q; return d > 0 ? clamp(0.5 * (m - q) / d, -0.5, 0.5) : 0; }, g = (dx, dy) => S[dx + ',' + dy] != null ? S[dx + ',' + dy] : sad(dx, dy);
      return [bx + (Math.abs(bx) < 3 ? p(g(bx - 1, by), b, g(bx + 1, by)) : 0), by + (Math.abs(by) < 3 ? p(g(bx, by - 1), b, g(bx, by + 1)) : 0)];
    }
    // move the background by (dx, dy) with bilinear sampling, so it stays lined up with the shaking camera
    warp(bg, dx, dy) {
      if (!dx && !dy) return bg; const o = new Float32Array(N), ix = Math.floor(dx), iy = Math.floor(dy), fx = dx - ix, fy = dy - iy;
      for (let y = 0; y < AH; y++) for (let x = 0; x < AW; x++) {
        const x0 = clamp(x + ix, 0, AW - 1), x1 = clamp(x + ix + 1, 0, AW - 1), y0 = clamp(y + iy, 0, AH - 1), y1 = clamp(y + iy + 1, 0, AH - 1);
        o[y * AW + x] = (bg[y0 * AW + x0] * (1 - fx) + bg[y0 * AW + x1] * fx) * (1 - fy) + (bg[y1 * AW + x0] * (1 - fx) + bg[y1 * AW + x1] * fx) * fy;
      }
      return o;
    }
    frame(src, t) {
      const Y = this.luma(src); this.frames++;
      if (!this.bg) { this.bg = Y.slice(); this.prev = Y; return null; }
      const [dx, dy] = this.shift(Y, this.prev); this.prev = Y; this.shake.push(Math.hypot(dx, dy));
      const bg = this.bg = this.warp(this.bg, dx, dy);
      // noise: median |frame − background| (most of the frame is sky); edges: a 0.5 px misalignment changes a pixel by ~½ its gradient
      const D = new Float32Array(N); for (let i = 0; i < N; i++) D[i] = Math.abs(Y[i] - bg[i]);
      const sm = []; for (let i = 0; i < N; i += 37) sm.push(D[i]); const nz = med(sm) * 1.5 + 1, thr = Math.max(14, 5 * nz);
      const M = new Uint8Array(N);
      for (let y = 1; y < AH - 1; y++) for (let x = 1; x < AW - 1; x++) {
        const i = y * AW + x, gr = Math.max(Math.abs(bg[i + 1] - bg[i - 1]), Math.abs(bg[i + AW] - bg[i - AW])) * 0.5;
        if (D[i] > thr + 0.6 * gr) M[i] = 1;
      }
      // the background learns slowly, and ten times slower where something is moving (a hovering drone isn't absorbed for ~10 s,
      // but a misaligned tree edge heals)
      const a = this.k++ < 15 ? 0.3 : 0.04; for (let i = 0; i < N; i++) bg[i] += (M[i] ? a / 10 : a) * (Y[i] - bg[i]);
      if (this.k < 15) return null;
      const Md = new Uint8Array(N); // grown by one pixel, so a thin drone's arms and rotor blur stay one blob
      for (let y = 1; y < AH - 1; y++) for (let x = 1; x < AW - 1; x++) { const i = y * AW + x; if (M[i] || M[i - 1] || M[i + 1] || M[i - AW] || M[i + AW]) Md[i] = 1; }
      const b = this.blob(Md, Y, thr, M); if (b) { this.moments(b, D, 2 * nz); b.t = t; this.T.push(b); this.last = b; this.miss = 0; } else this.miss = (this.miss || 0) + 1;
      return b;
    }
    // 4-connected components; the biggest, favouring the one near the last spot. A "ghost" (the background still holds something
    // that has left: the frame there looks like the sky around it) is healed at once instead.
    blob(M, Y, thr, M0) {
      const seen = new Uint8Array(N), st = [], pix = []; let best = null, bs = 0;
      for (let s = 0; s < N; s++) {
        if (!M[s] || seen[s]) continue;
        let n = 0, sx = 0, sy = 0, x0 = AW, x1 = 0, y0 = AH, y1 = 0; st.push(s); seen[s] = 1; pix.length = 0;
        while (st.length) { const i = st.pop(), x = i % AW, y = (i / AW) | 0; n++; pix.push(i); sx += x; sy += y; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
          for (const j of [i - 1, i + 1, i - AW, i + AW]) if (j >= 0 && j < N && M[j] && !seen[j]) { seen[j] = 1; st.push(j); } }
        if (n < 3 || n > N * 0.2) continue; // speckle, or a whole-frame change (exposure jump)
        if (x0 <= 1 || y0 <= 1 || x1 >= AW - 2 || y1 >= AH - 2 || x1 - x0 > AW * 0.4) continue; // touching the edge (tree line, roof, half in view) or too wide
        const ring = []; for (let x = Math.max(0, x0 - 3); x <= Math.min(AW - 1, x1 + 3); x++) for (const y of [Math.max(0, y0 - 3), Math.min(AH - 1, y1 + 3)]) ring.push(Y[y * AW + x]);
        for (let y = Math.max(0, y0 - 3); y <= Math.min(AH - 1, y1 + 3); y++) for (const x of [Math.max(0, x0 - 3), Math.min(AW - 1, x1 + 3)]) ring.push(Y[y * AW + x]);
        const core = pix.filter(i => M0[i]), sky = med(ring), con = core.reduce((a, i) => a + Math.abs(Y[i] - sky), 0) / (core.length || 1);
        if (con < thr * 0.5) { core.forEach(i => this.bg[i] = Y[i]); continue; } // a ghost
        const L = this.last && this.miss < 8 ? this.last : null, cx = sx / n, cy = sy / n, d = L ? Math.hypot(cx - L.x, cy - L.y) : 0;
        if (L && d > 12 + L.w) continue; // while tracking, stay with it (lost for 8+ frames: take the best anywhere)
        const sc = n * Math.exp(-d / 10);
        if (sc > bs) { bs = sc; best = { x: cx, y: cy, a: n, w: x1 - x0 + 1, h: y1 - y0 + 1, box: [x0 / AW, y0 / AH, (x1 + 1) / AW, (y1 + 1) / AH] }; }
      }
      return best;
    }
    // sub-pixel shape numbers from how much the blob differs from the sky (not a pixel count, which flickers as a thin shape
    // slides across the pixel grid): mass and spread across / up-down
    moments(b, D, nz) {
      const x0 = Math.max(0, Math.round(b.box[0] * AW) - 2), x1 = Math.min(AW, Math.round(b.box[2] * AW) + 2), y0 = Math.max(0, Math.round(b.box[1] * AH) - 2), y1 = Math.min(AH, Math.round(b.box[3] * AH) + 2);
      let m = 0, sx = 0, sy = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const v = Math.max(0, D[y * AW + x] - nz); m += v; sx += v * x; sy += v * y; }
      if (!m) return; const cx = sx / m, cy = sy / m; let vx = 0, vy = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const v = Math.max(0, D[y * AW + x] - nz); vx += v * (x - cx) ** 2; vy += v * (y - cy) ** 2; }
      Object.assign(b, { x: cx, y: cy, m, sx: Math.sqrt(vx / m) + 0.3, sy: Math.sqrt(vy / m) + 0.3 });
    }
    // keep up to 3 crops of the source frame around the blob (its largest views) for the appearance check
    crop(src, b) {
      if (!b || !src.videoWidth) return; const W = src.videoWidth, H = src.videoHeight, cx = (b.box[0] + b.box[2]) / 2 * W, cy = (b.box[1] + b.box[3]) / 2 * H;
      const s = Math.max(48, 2.5 * Math.max((b.box[2] - b.box[0]) * W, (b.box[3] - b.box[1]) * H));
      if (this.crops.length >= 3 && b.a <= Math.min(...this.crops.map(c => c.a))) return;
      const c = document.createElement('canvas'); c.width = c.height = 224; c.getContext('2d').drawImage(src, cx - s / 2, cy - s / 2, s, s, 0, 0, 224, 224);
      this.crops.push({ a: b.a, c }); this.crops.sort((p, q) => q.a - p.a); this.crops.length = Math.min(3, this.crops.length);
    }
  }

  // ---- the motion signature of a blob track ----
  function features(T, frames, dur, shake) {
    const out = { n: T.length, present: frames ? T.length / frames : 0, dur, shake: shake ? +Math.sqrt(mean(shake.map(v => v * v))).toFixed(2) : 0 }; // shake: rms frame-to-frame camera shift (px)
    if (T.length < 20) return out;
    const t = T.map(b => b.t), dt = med(t.slice(1).map((v, i) => v - t[i])) || 1 / 30, fs = 1 / dt, n = Math.floor((t[t.length - 1] - t[0]) * fs) + 1;
    const L = med(T.map(b => b.w)); out.L = L; // body length (px at 160 wide)
    // uniform resampling (linear), then remove a 1 s moving average and divide by it
    const res = key => { const o = new Float64Array(n); let j = 0; for (let i = 0; i < n; i++) { const ti = t[0] + i * dt; while (j < T.length - 2 && t[j + 1] < ti) j++; const u = clamp((ti - t[j]) / ((t[j + 1] - t[j]) || dt), 0, 1); o[i] = key(T[j]) * (1 - u) + key(T[j + 1]) * u; } return o; };
    const detr = x => { const w = Math.max(3, Math.round(fs)), y = new Float64Array(x.length); let amp = 0;
      for (let i = 0; i < x.length; i++) { let s = 0, c = 0; for (let k = Math.max(0, i - (w >> 1)); k <= Math.min(x.length - 1, i + (w >> 1)); k++) { s += x[k]; c++; } const m = s / c; y[i] = (x[i] - m) / (m || 1); amp += y[i] * y[i]; }
      return { y, amp: Math.sqrt(amp / x.length) }; };
    const spec = y => { // power at 0.25 Hz steps; the flap band is 2–20 Hz (below Nyquist); peak share of all power above 0.75 Hz
      const top = Math.min(20, fs / 2 - 0.5), P = []; let all = 0;
      for (let f = 0.75; f <= fs / 2 - 0.25; f += 0.25) { let re = 0, im = 0; for (let i = 0; i < y.length; i++) { const a = 2 * Math.PI * f * i / fs; re += y[i] * Math.cos(a); im -= y[i] * Math.sin(a); } const p = re * re + im * im; P.push([f, p]); all += p; }
      let bf = 0, bp = 0; P.forEach(([f, p], i) => { if (f >= 2 && f <= top) { const q = p + (P[i - 1] ? P[i - 1][1] : 0) + (P[i + 1] ? P[i + 1][1] : 0); if (q > bp) { bp = q; bf = f; } } });
      return { f: bf, share: all ? bp / all : 0 }; };
    // wing beat: mass (wings spread on the downstroke, folded on the upstroke), up-down spread and their ratio
    let fl = { f: 0, share: 0, amp: 0 };
    [b => b.m, b => b.sy, b => b.sy / b.sx].forEach(k => { const d = detr(res(k)), s = spec(d.y); if (s.share * Math.min(1, d.amp / 0.11) > fl.share * Math.min(1, fl.amp / 0.11)) fl = { f: s.f, share: s.share, amp: d.amp }; });
    out.flapHz = fl.f; out.flapShare = +fl.share.toFixed(2); out.flapAmp = +fl.amp.toFixed(3);
    // a wing beat swings the visible size by over 11% (a shape sliding across the pixel grid flickers ~5–8%); a shaking hand (1–3 Hz) makes a thin shape flicker at the same pace, so with a shaky camera a beat under 3 Hz doesn't count
    out.flap = L >= 4 && fl.amp >= 0.11 && fl.share >= 0.4 && !(out.shake > 0.15 && fl.f < 3);
    // path: centroid smoothed over 0.3 s, in body lengths
    const sx = res(b => b.x), sy = res(b => b.y), w = Math.max(1, Math.round(0.15 * fs)), smo = a => a.map((_, i) => { let s = 0, c = 0; for (let k = Math.max(0, i - w); k <= Math.min(a.length - 1, i + w); k++) { s += a[k]; c++; } return s / c; });
    const X = smo(Array.from(sx)), Yp = smo(Array.from(sy)), step = Math.max(1, Math.round(0.5 * fs)), V = [], H = [];
    for (let i = step; i < X.length; i += step) { const vx = X[i] - X[i - step], vy = Yp[i] - Yp[i - step]; V.push(Math.hypot(vx, vy) / L / (step / fs)); H.push(Math.atan2(vy, vx)); }
    out.speed = +med(V).toFixed(2);
    let turn = 0, tn = 0; for (let i = 1; i < H.length; i++) if (V[i] > 0.5 && V[i - 1] > 0.5) { let d = Math.abs(H[i] - H[i - 1]); if (d > Math.PI) d = 2 * Math.PI - d; turn += d; tn++; }
    out.turn = tn ? Math.round(turn / tn * 180 / Math.PI / (step / fs)) : 0; // degrees per second
    const win = Math.round(2 * fs), st = []; for (let i = 0; i + win < X.length; i += step) { let p = 0; for (let k = i + 1; k <= i + win; k++) p += Math.hypot(X[k] - X[k - 1], Yp[k] - Yp[k - 1]); if (p > L * 0.5) st.push(Math.hypot(X[i + win] - X[i], Yp[i + win] - Yp[i]) / p); }
    out.straight = st.length ? +med(st).toFixed(2) : null;
    out.hover = out.speed < 0.35; out.glide = !out.flap && out.turn >= 15 && out.speed >= 0.8;
    const ar = Array.from(res(b => b.m)), w2 = Math.round(2 * fs); let cv = 0; ar.forEach((v, i) => { const m = mean(ar.slice(Math.max(0, i - w2 / 2), i + w2 / 2)); cv += ((v - m) / (m || 1)) ** 2; });
    out.sizeCv = +Math.sqrt(cv / ar.length).toFixed(3); out.steady = !out.flap && out.sizeCv < 0.12;
    return out;
  }

  // ---- fuse: motion + sound (+ appearance) → verdict ----
  // sound: rotor share of frames (0–1) heard while the clip ran, or null (mic off); look: bird score 0–1 or null (no model)
  function decide(F, sound, look) {
    const h = sound == null ? -1 : sound >= 0.3 ? 1 : sound < 0.1 ? 0 : -1, a = look == null ? -1 : Math.round(look * 100), f = F.flap ? Math.round(F.flapHz) : 0;
    const res = (v, c, r) => ({ v, c, r, f, h, a, F });
    if (F.n < 20 || F.present < 0.3) return res('none', 0, 'empty');
    let s = 0, r = 'mixed';
    const tiny = F.L < 4;
    if (F.flap) { s += 2.5; r = 'flap'; }
    else if (F.glide) { s += 1.5; r = 'glide'; }
    else if (!tiny) {
      if (F.hover) { s -= 2; r = 'hover'; } else if (F.straight != null && F.straight >= 0.92) { s -= 1.2; r = 'straight'; }
      if (F.steady) { s -= 0.7; if (r === 'mixed') r = 'steady'; }
    }
    if (h === 1) s -= 1.5; else if (h === 0) s += 0.3;
    if (a >= 50) s += 1.5; else if (a >= 30) s += 0.7;
    if (tiny && r === 'mixed') r = 'tiny';
    const p = 1 / (1 + Math.exp(-s)), v = s >= 1.5 ? 'bird' : s <= -1.5 ? 'bot' : 'none';
    if (v === 'none' && r !== 'tiny') r = h === 1 && (F.flap || F.glide) ? 'clash' : r === 'flap' || r === 'glide' || r === 'hover' || r === 'straight' ? r : 'mixed';
    return res(v, v === 'none' ? 0 : Math.round(100 * (v === 'bird' ? p : 1 - p)), r);
  }

  // ---- words, from the numbers alone (the screen rebuilds them from what the ear sent) ----
  const WORD = { bird: 'Bird', bot: 'Bot', none: "Can't tell" }, ICON = { bird: '🐦', bot: '🤖', none: '?' };
  function text(b) {
    if (!b) return '';
    const m = { flap: `Wings beating ~${b.f} times a second`, glide: 'Gliding in curves on still wings', hover: 'Hovering in one spot, no wing beat', straight: 'Moving in a straight line at a steady size, no wing beat',
      steady: 'Steady size, no wing beat', empty: 'Nothing moving against the sky', tiny: 'Too small or far to see wings', mixed: 'No clear wing beat, hover or straight path', clash: 'Moves like a bird, but this phone hears a rotor hum' }[b.r] || '';
    const hum = b.r === 'clash' ? '' : b.h === 1 ? 'rotor hum heard' : b.h === 0 ? 'no rotor hum' : '', look = b.a >= 50 ? 'looks like a bird to the image check' : '';
    const end = b.v === 'bird' ? (b.c >= 80 ? 'bird' : 'likely a bird') : b.v === 'bot' ? (b.c >= 80 ? 'drone' : 'likely a drone') : "can't tell";
    const P = [m, hum, look].filter(Boolean), said = P.length > 1 ? P.slice(0, -1).join(', ') + ' and ' + P[P.length - 1] : P[0];
    return said ? said + ' — ' + end : end;
  }
  const chip = b => b ? `${ICON[b.v]} ${WORD[b.v]}${b.v !== 'none' ? ' ' + b.c + '%' : ''}` : '';

  // ---- the appearance check: COCO-SSD from a CDN, in a worker (loading it blocks for seconds, which would stall this phone's
  // telemetry), fetched when the phone is asked to look (8 s budget, then motion only) ----
  const CDN = ['https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js', 'https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.3/dist/coco-ssd.min.js'];
  const WORKER = `let m = null;
onmessage = async e => {
  if (e.data.load) { try { importScripts(...e.data.load); m = await cocoSsd.load({ base: 'lite_mobilenet_v2' }); postMessage({ ok: 1 }); } catch (er) { postMessage({ ok: 0 }); } return; }
  try { let best = 0; for (const im of e.data.crops) (await m.detect(im, 5, 0.1)).forEach(d => { if (d.class === 'bird' && d.score > best) best = d.score; }); postMessage({ best }); }
  catch (er) { postMessage({ best: null }); }
};`;
  let worker = null, loading = null; const Check = { state: 'idle' }; // idle | loading | ready | off
  const ask = (msg, ms) => new Promise(ok => { const t = setTimeout(() => ok(null), ms); worker.onmessage = e => { clearTimeout(t); ok(e.data); }; worker.postMessage(msg); });
  function loadModel() {
    if (loading) return loading; Check.state = 'loading';
    try { worker = new Worker(URL.createObjectURL(new Blob([WORKER], { type: 'text/javascript' }))); } catch (e) { Check.state = 'off'; return loading = Promise.resolve(false); }
    return loading = ask({ load: CDN }, window.ROTOREAR_MODEL_MS || 8000).then(r => { const ok = !!(r && r.ok); Check.state = ok ? 'ready' : 'off'; if (!ok) worker.terminate(); return ok; });
  }
  async function birdScore(crops) { // best 'bird' score over the crops (0–1); null when the check isn't there
    if (!crops.length || !(await loadModel())) return null;
    const r = await ask({ crops: crops.map(({ c }) => c.getContext('2d').getImageData(0, 0, c.width, c.height)) }, 5000);
    return r && r.best != null ? r.best : null;
  }

  // ---- analyse a playing <video> (live camera or a saved clip) until stop() / it ends ----
  // onTick(blob, partial) every frame for the overlay; returns { stop(): Promise<verdict> }
  function analyse(video, getSound, onTick) {
    const w = new Watcher(); let on = true, raf = 0, t0 = performance.now(); loadModel();
    const use = (now, meta) => { if (!on) return; const t = meta && meta.mediaTime != null ? meta.mediaTime : (now - t0) / 1000;
      if (video.readyState >= 2 && video.videoWidth) { const b = w.frame(video, t); if (b && w.T.length % 10 === 0) w.crop(video, b); onTick && onTick(b, w); }
      raf = video.requestVideoFrameCallback ? video.requestVideoFrameCallback(use) : requestAnimationFrame(use); };
    raf = video.requestVideoFrameCallback ? video.requestVideoFrameCallback(use) : requestAnimationFrame(use);
    return {
      w,
      get live() { return w.T.length >= 20 ? features(w.T, w.frames, (performance.now() - t0) / 1000, w.shake) : null; },
      async stop() {
        on = false; if (video.cancelVideoFrameCallback) try { video.cancelVideoFrameCallback(raf); } catch (e) {} cancelAnimationFrame(raf);
        const F = features(w.T, Math.max(1, w.frames - 15), (performance.now() - t0) / 1000, w.shake), look = F.present >= 0.3 ? await birdScore(w.crops) : null;
        const v = decide(F, getSound(), look); v.model = Check.state; return v;
      },
    };
  }
  // a saved clip (Blob): play it muted, off-screen, at normal speed, and analyse it
  function analyseBlob(blob, sound, onTick) {
    return new Promise(ok => {
      const v = document.createElement('video'); v.muted = true; v.playsInline = true; v.src = URL.createObjectURL(blob);
      v.style.cssText = 'position:fixed;left:-9999px;width:320px;height:240px'; document.body.appendChild(v);
      let job = null; const done = async () => { if (!job) return; const j = job; job = null; const r = await j.stop(); v.remove(); URL.revokeObjectURL(v.src); ok(r); };
      v.onplaying = () => { if (!job) job = analyse(v, () => sound, onTick); };
      v.onended = done; v.onerror = () => { v.remove(); ok(decide({ n: 0, present: 0 }, sound, null)); };
      setTimeout(done, 15000); v.play().catch(() => {});
    });
  }

  window.RotorBird = { Watcher, features, decide, text, chip, WORD, ICON, analyse, analyseBlob, loadModel, Check };
})();
