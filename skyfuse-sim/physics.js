// SkyFuse sim: per-sense physics models + a port of Rotor Ear's harmonic-comb ("ladder") detector.
// Everything here is a deliberately SIMPLE model. Numbers are rough, hand-picked estimates, not measurements.
// Passive only: every sense here only RECEIVES. Nothing transmits at the drone, nothing is jammed or decoded.
(function (g) {
  'use strict';
  const BIN_HZ = 4, FMAX = 4000, NB = FMAX / BIN_HZ;          // synthetic spectrum: 0-4 kHz in 4 Hz bins
  const F0_MIN = 90, F0_MAX = 1500, NH = 10, HIT_DB = 9;        // Rotor Ear numbers, but F0_MAX raised from 600: micro/FPV props reach ~0.5-1.5 kHz
  const clamp = (x, a, b) => x < a ? a : x > b ? b : x;
  const dbAdd = (...d) => 10 * Math.log10(d.reduce((s, x) => s + Math.pow(10, x / 10), 0) + 1e-30);
  const gauss = () => { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };

  // ---------- flying objects ----------
  // snd.ladder: rotor/prop blade-pass pitch f0 (Hz), level of the fundamental at 1 m (dB, one 4 Hz bin), number of
  //   harmonics, dB drop per harmonic. snd.chirp: a single high tone that comes and goes (birdsong). snd.roar: total
  //   broadband level at 1 m (jet / helicopter). snd.whine: one turbine tone.
  // eirp: radio link power (dBm) or null (no drone radio). rid: Remote ID broadcast by default.
  // therm: thermal-camera detection range (m); tcls: what the camera's shape/motion check calls it.
  // speed m/s, h = default height (m). big: shakes a roof when low.
  const OBJECTS = {
    toy:   { label: 'Toy drone', sub: '~80 g micro', drone: true, snd: { ladder: { f0: 380, sl: 70, nh: 10, slope: 3 } }, eirp: 10, band: '2.4', rid: false, therm: 220, tcls: 'drone', speed: 6, h: 30, icon: 'quad', size: 0.7 },
    small: { label: 'Small quad', sub: 'DJI Mini class', drone: true, snd: { ladder: { f0: 190, sl: 81, nh: 10, slope: 3 } }, eirp: 20, band: '2.4', rid: true, therm: 550, tcls: 'drone', speed: 12, h: 60, icon: 'quad', size: 1 },
    large: { label: 'Large quad', sub: '~6 kg, heavy lift', drone: true, snd: { ladder: { f0: 110, sl: 89, nh: 10, slope: 3 } }, eirp: 27, band: '2.4', rid: true, therm: 1000, tcls: 'drone', speed: 15, h: 60, icon: 'quad', size: 1.4, big: true },
    fixed: { label: 'Fixed-wing drone', sub: 'single prop, fast', drone: true, snd: { ladder: { f0: 150, sl: 82, nh: 8, slope: 3.5 } }, eirp: 20, band: '2.4', rid: true, therm: 700, tcls: 'drone', speed: 22, h: 110, icon: 'wing', size: 1.2 },
    fpv:   { label: 'FPV racer', sub: 'loud, 5.8 GHz video', drone: true, snd: { ladder: { f0: 480, sl: 84, nh: 8, slope: 3 } }, eirp: 25, band: '5.8', rid: false, therm: 300, tcls: 'drone', speed: 30, h: 25, icon: 'fpv', size: 0.9 },
    bird:  { label: 'Bird', sub: 'decoy: crow / kite', drone: false, snd: { chirp: { f: 3000, sl: 74, duty: 0.3 } }, eirp: null, rid: false, therm: 200, tcls: 'bird', speed: 10, h: 35, icon: 'bird', size: 1 },
    jet:   { label: 'Passing jet', sub: 'decoy: 1.5 km up', drone: false, snd: { roar: 142, whine: { f: 2200, sl: 112 } }, eirp: null, rid: false, therm: 2500, tcls: 'aircraft', speed: 120, h: 1500, icon: 'jet', size: 1.6 },
    heli:  { label: 'Helicopter', sub: 'decoy: 300 m up', drone: false, snd: { ladder: { f0: 21, sl: 112, nh: 48, slope: 0.6 }, roar: 124 }, eirp: null, rid: false, therm: 2500, tcls: 'aircraft', speed: 55, h: 300, icon: 'heli', size: 1.5 }
  };

  // ---------- WEATHER (all rough estimates; see README "Weather model") ----------
  // wx = { wind m/s, windFrom deg (meteorological: where it blows FROM), dust 0/1/2, rain 0/1/2, tod }
  const TOD = {
    coldnight: { label: 'Cold night', T: 15, RH: 85, night: true },  // Bangalore winter night, calm: ground inversion likely
    mildnight: { label: 'Mild night', T: 21, RH: 75, night: true },
    mildday:   { label: 'Mild day',   T: 27, RH: 55, night: false }, // the reference "clear mild day"
    hotday:    { label: 'Hot day',    T: 38, RH: 25, night: false }  // April afternoon: sun-baked ground, upward refraction
  };
  const WX_REF = { wind: 2, windFrom: 270, dust: 0, rain: 0, tod: 'mildday' };
  const wxOf = env => env.wx || WX_REF;
  const climate = wx => { const t = TOD[wx.tod] || TOD.mildday; return { T: t.T, RH: wx.rain ? Math.max(t.RH, 92) : t.RH, night: t.night }; };

  // Air absorption, ISO 9613-1:1993 closed form (pure tone, dB/m; T °C, RH %, pa kPa). Uses ABSOLUTE humidity, so a hot
  // dry afternoon is not double-penalised. Reference (no weather) = 20 °C / 70 %: 0.78 / 4.98 / 23.1 dB/km at 0.2 / 1 / 4 kHz.
  function isoAlpha(f, Tc, RH, pa = 101.325) {
    const T = Tc + 273.15, T0 = 293.15, T01 = 273.16, pr = 101.325;
    const h = RH * Math.pow(10, -6.8346 * Math.pow(T01 / T, 1.261) + 4.6151) * (pr / pa);
    const frO = (pa / pr) * (24 + 4.04e4 * h * (0.02 + h) / (0.391 + h));
    const frN = (pa / pr) * Math.pow(T / T0, -0.5) * (9 + 280 * h * Math.exp(-4.170 * (Math.pow(T / T0, -1 / 3) - 1)));
    return 8.686 * f * f * (1.84e-11 * (pr / pa) * Math.sqrt(T / T0) + Math.pow(T / T0, -2.5) *
      (0.01275 * Math.exp(-2239.1 / T) / (frO + f * f / frO) + 0.1068 * Math.exp(-3352.0 / T) / (frN + f * f / frN)));
  }
  // dB/km. Dust adds a tiny broadband scattering loss (minor for sound).
  const absorb = (f, wx) => { if (!wx) return 1000 * isoAlpha(f, 20, 70); const c = climate(wx); return 1000 * isoAlpha(f, c.T, c.RH) + 0.15 * wx.dust; };
  // Refraction (dB, positive = quieter) over horizontal distance r, for a path with c = cos(angle between the sound path and
  // where the wind blows TO): +1 downwind, -1 upwind. hs, hr = source and receiver heights (m).
  // Effective sound-speed gradient g = 0.59 dT/dz + du/dz cos(phi) (1/s). Rough "effective" gradients (tunable):
  //   hot sunny day -0.1 (lapse), mild day -0.03, mild night +0.03, calm cold night +0.08 (inversion; wind/rain break it up);
  //   wind shear du/dz ~ 0.02 * wind speed.
  //  g < 0: sound bends UP. Almost no loss until the shadow-zone onset x_s = sqrt(2c/|g|) (sqrt hs + sqrt hr) (linear profile,
  //         flat ground), then 10-20 dB more (turbulent scattering limits the depth), a bit deeper at high pitch.
  //  g > 0: sound bends DOWN: a modest gain growing with distance, up to ~10 dB. (Embleton 1996; Salomons 2001.)
  const C_AIR = T => 331.3 * Math.sqrt(1 + T / 273.15);
  function gradient(wx, c) {
    const w = wx.wind, calm = clamp(1 - (w - 2) / 6, 0, 1) * (wx.rain ? 0.4 : 1);
    const gT = { hotday: -0.1, mildday: -0.03, mildnight: 0.03 * calm, coldnight: 0.08 * calm }[wx.tod] || -0.03;
    return gT + 0.02 * w * c;
  }
  const smooth = x => x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x);
  function wxLoss(r, wx, c, hs, hr, f) {
    if (!wx) return 0;
    const g = gradient(wx, c), c0 = C_AIR(climate(wx).T);
    if (g >= 0) return -Math.min(10, 80 * g) * (1 - Math.exp(-r / 600));
    const xs = Math.sqrt(2 * c0 / -g) * (Math.sqrt(Math.max(1, hs)) + Math.sqrt(Math.max(0.5, hr)));
    const depth = 10 + 10 * clamp(-g / 0.3, 0, 1) + clamp(2 * Math.log2((f || 200) / 200), 0, 5);
    return depth * smooth((r - xs) / (0.3 * xs));
  }
  const shadowOnset = (g, hs, hr, c0 = 343.2) => Math.sqrt(2 * c0 / Math.abs(g)) * (Math.sqrt(hs) + Math.sqrt(hr));
  // Turbulence: random level flicker per frame (dB, 1 sigma). Wind gusts and hot-day convection make the ladder flicker.
  const turbSigma = wx => wx ? 0.25 * wx.wind + (wx.tod === 'hotday' ? 2 : 0) : 0;
  const windTo = wx => (wx.windFrom + 180) % 360;
  // Ground effect, capped (ISO 9613-2 A_gr style): up to ~3 dB for grazing paths, fading out above ~12° elevation. Long-range
  // loss is left to the refraction model above (the old unbounded term double counted it). A raised node (8 m) halves it.
  const excess = (r, high, hs, hr) => { const el = Math.atan2(Math.abs((hs == null ? 1.5 : hs) - (hr == null ? (high ? 8 : 1.5) : hr)), Math.max(r, 1)) * 180 / Math.PI;
    return 3 * (1 - Math.exp(-r / 200)) * (1 - smooth(el / 12)) * (high ? 0.5 : 1); };
  const dist3 = (o, n) => Math.max(5, Math.hypot(o.x - n.x, o.y - n.y, o.h - n.h));

  // ---------- SOUND ----------
  // Noise in one 4 Hz bin (dB SPL) at a node: mic self-hiss + ambient + wind + broadband roar of jets/helicopters.
  function noiseParts(f, env, node) {
    const T = env.tog, high = T.height;
    // mic self-noise from datasheet EIN spread over 20 Hz-20 kHz in 4 Hz bins (EIN - 37 dB), + gentle 1/f rise below 300 Hz:
    // INMP441 EIN 33 dBA -> -2 dB/bin (checked by test N1); "low-noise" ICS-43434 class ~29 dBA -> -6
    const self = (T.lownoise ? -6 : -2) + 3 * Math.max(0, Math.log2(300 / Math.max(f, 30)));
    // ambient (per 4 Hz bin): suburb day ~48 dBA, city ~58 dBA, quiet night ~38 dBA (typical ranges; replace with logs)
    let amb;
    if (env.scen === 'night') amb = 8 + 8 * Math.exp(-f / 150);
    else if (env.scen === 'city') amb = Math.max(18, 44 - 4 * Math.log2(Math.max(f, 100) / 100));
    else amb = Math.max(14, 28 - 3 * Math.log2(Math.max(f, 100) / 100));  // suburb
    if (high) amb -= 5;                                                   // above street-level noise
    const wx = wxOf(env), v = wx.wind * (high ? 1.25 : 1);                // more wind up a pole...
    // wind noise is low-frequency turbulence at the mic; a fur windshield is assumed (~-20 dB), so it bites mainly below ~300 Hz
    const wind = v > 0.2 ? 20 * Math.log10(v) + 6 + (v > 8 ? 1.5 * (v - 8) : 0) - 10 * Math.log2(Math.max(f, 50) / 50) : -40;
    // rain: broadband drop impacts on the mic, windshield and dish, fairly flat, slightly rising to ~2 kHz
    const rain = wx.rain ? (wx.rain === 2 ? 27 : 12) + (T.dish ? 3 : 0) + 2 * clamp(Math.log2(f / 250), -2, 3) : -60;
    let roar = -60;
    for (const o of env.objs) {
      if (!o.spec.snd.roar) continue;
      const r = dist3(o, node), rh = Math.hypot(o.x - node.x, o.y - node.y), total = o.spec.snd.roar - 20 * Math.log10(r) - absorb(500, env.wx) * r / 1000 - excess(rh, T.height, o.h, node.h) - wxLoss(rh, env.wx, Math.cos((bearing(o, node) - windTo(wxOf(env))) * Math.PI / 180), o.h, node.h, 500); // same loss chain as tones
      let L = total - 29 - (f < 500 ? 0 : 4 * Math.log2(f / 500));        // spread over ~3 kHz
      if (T.ring && node._focus && angDiff(bearing(node, o), bearing(node, node._focus)) > 30) L -= 8; // array points away from it
      roar = dbAdd(roar, L);
    }
    // local broadband sources (highway = long E-W line: spreads as 10log r; construction = point: 20log r), level per 4 Hz bin at 10 m
    let src = -60;
    for (const b of env.srcBB || []) {
      const r = b.road ? Math.max(15, Math.abs(node.y - b.y)) : Math.max(5, Math.hypot(node.x - b.x, node.y - b.y));
      src = dbAdd(src, b.L - 3 * Math.log2(Math.max(f, 100) / 100) - (b.road ? 10 : 20) * Math.log10(r / 10) - absorb(f, env.wx) * r / 1000 - excess(r, T.height, 2, node.h));
    }
    return { self, amb, wind, roar, rain, src };
  }

  // Tone gain at a node for a source in a given direction, at frequency f. Dish (D = 0.5 m, efficiency 0.5):
  // G = max(0, 10log10(0.5 (pi D / lambda)^2)), half-power beam ~70 lambda/D degrees -> ~0 dB at the 100-200 Hz fundamentals,
  // +10 dB at 1 kHz. Ring: 10log10(4) = 6 dB (true in uncorrelated noise like wind/self-noise; less in diffuse low-f ambient).
  // Long listening is NOT a tone gain: it averages 8 noise frames in synth() (steadier floor), counted once there.
  const DISH_D = 0.5;
  const dishGain = f => Math.max(0, 10 * Math.log10(0.5 * Math.pow(Math.PI * DISH_D * f / 343, 2)));
  const dishBeam = f => Math.min(360, 70 * (343 / f) / DISH_D);
  function gains(env, node, o, f) {
    const T = env.tog; let gain = 0;
    if (T.dish) { const off = angDiff(node.dishAz, bearing(node, o)), bw = dishBeam(f); gain += off <= bw / 2 ? dishGain(f) : off <= bw ? dishGain(f) - 3 : 0; }
    if (T.ring) gain += 6;
    return gain;
  }
  // All tonal components one object puts into one node: rotor ladder, bird chirp, turbine whine.
  function objectTones(o, env, node) {
    const s = o.spec.snd, r = dist3(o, node), wx = env.wx, c = wx ? Math.cos((bearing(o, node) - windTo(wx)) * Math.PI / 180) : 0;
    const rh = Math.hypot(o.x - node.x, o.y - node.y), hs = o.h, hr = node.h, ex = excess(rh, env.tog.height, hs, hr);
    const loss = f => 20 * Math.log10(r) + absorb(f, wx) * r / 1000 + ex + wxLoss(rh, wx, c, hs, hr, f);
    const G = f => gains(env, node, o, f) + (o.loud || 0), out = [];
    if (s.ladder) for (let h = 1; h <= s.ladder.nh; h++) {
      const f = s.ladder.f0 * o.rpm * h; if (f > FMAX - 20) break;
      const spread = 10 * Math.log10(Math.max(1, 0.02 * f / BIN_HZ));     // rotor speed wobble smears high harmonics
      out.push({ f, L: s.ladder.sl - s.ladder.slope * (h - 1) - loss(f) - spread + G(f) });
    }
    if (s.partials) s.partials.r.forEach((k, i) => { const f = s.partials.hum * k; out.push({ f, L: s.partials.sl - 2.5 * i - loss(f) + G(f) }); }); // bell: inharmonic partials
    if (s.chirp && o.chirping) out.push({ f: o.chirpF, L: s.chirp.sl - loss(o.chirpF) + G(o.chirpF) });
    if (s.whine) out.push({ f: s.whine.f, L: s.whine.sl - loss(s.whine.f) + G(s.whine.f) - 6 });
    return { r, tones: out };
  }

  // Build a one-frame spectrum (dB per bin). Noise bins fluctuate (chi-square); longer listening averages more frames.
  function synth(env, node, out) {
    const db = out || new Float32Array(NB), K = env.tog.longlisten ? 8 : 1;
    const parts = new Float32Array(NB); node._roarDb = node._roarDb || new Float32Array(NB);
    for (let i = 1; i < NB; i++) {
      const p = noiseParts(i * BIN_HZ, env, node);
      const P = Math.pow(10, p.self / 10) + Math.pow(10, p.amb / 10) + Math.pow(10, p.wind / 10) + Math.pow(10, p.roar / 10) + Math.pow(10, p.rain / 10) + Math.pow(10, p.src / 10);
      let x = 0; for (let k = 0; k < K; k++) x -= Math.log(Math.random() + 1e-12);
      parts[i] = P * x / K; node._roarDb[i] = p.roar;
    }
    const ts = turbSigma(env.wx);
    // fades only: turbulence breaks up the sound path, it doesn't make the source louder on average than the model
    const add = (t, flick) => { const c = Math.round(t.f / BIN_HZ), P = Math.pow(10, (t.L + flick) / 10) * (0.7 + 0.6 * Math.random());
      if (c > 0 && c < NB) parts[c] += P;
      if (c > 1) parts[c - 1] += P * 0.16; if (c < NB - 1) parts[c + 1] += P * 0.16; };
    for (const o of env.objs.concat(env.srcTones || [])) { const flick = -Math.abs(gauss()) * ts; for (const t of objectTones(o, env, node).tones) add(t, flick); }
    const sing = singing(env, node); if (sing) for (const t of sing) add(t, 0);
    for (let i = 0; i < NB; i++) db[i] = 10 * Math.log10(parts[i] + 1e-20);
    db[0] = db[1];
    return { db };
  }

  // ---- Rotor Ear comb detector (ported from detector.js): local floor, ±2.5% peak search, ladder score ----
  // Added "dense" check (Rotor Ear's sub-harmonic feature): peaks standing up BETWEEN the rungs mean the true pitch is
  // far below the comb, i.e. a big slow rotor (helicopter), not a small drone.
  function comb(db, hit) {
    hit = hit || HIT_DB;
    const n = NB, Wd = 24, pre = new Float64Array(n + 1), fl = new Float32Array(n);
    for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + db[i];
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - Wd), b = Math.min(n, i + Wd + 1), c0 = Math.max(0, i - 2), c1 = Math.min(n, i + 3);
      fl[i] = (pre[b] - pre[a] - (pre[c1] - pre[c0])) / ((b - a) - (c1 - c0));
    }
    const tol = f => Math.max(1, Math.round(f * 0.025 / BIN_HZ));
    let peakAt = 0;
    const excessAt = f => { const t = tol(f), c = Math.round(f / BIN_HZ); let best = 0; peakAt = c;
      for (let i = c - t; i <= c + t; i++) { if (i < 1 || i >= n) continue; const e = db[i] - fl[i]; if (e > best) { best = e; peakAt = i; } }
      return Math.min(best, 30); };
    // parabolic interpolation of a peak bin -> Hz
    const peakHz = i => { if (i < 1 || i >= n - 1) return i * BIN_HZ; const a = db[i - 1], b = db[i], c = db[i + 1], d = a - 2 * b + c; return (i + (d < 0 ? clamp(0.5 * (a - c) / d, -0.5, 0.5) : 0)) * BIN_HZ; };
    function score(f0) {
      let s = 0, hits = 0, low = 0, e1 = 0; const rungs = [];
      for (let h = 1; h <= NH; h++) { const f = f0 * h; if (f > FMAX) break;
        const e = excessAt(f); s += e; rungs.push({ f, e, hit: e > hit, pk: peakAt, h });
        if (e > hit) { hits++; if (h <= 4) low++; } if (h === 1) e1 = e; }
      s /= NH;
      // a real rotor comb has its fundamental and most low harmonics present (Rotor Ear rule)
      if (e1 < hit) { s *= 0.3; hits = Math.min(hits, 2); } else if (low < 3) { s *= 0.5; hits = Math.min(hits, 3); }
      return { f0, s, hits, rungs };
    }
    let best = { f0: 0, s: 0, hits: 0, rungs: [] };
    // speed-up vs Rotor Ear: only test pitches whose fundamental already sticks out (the rule rejects the rest anyway)
    for (let f0 = F0_MIN; f0 <= F0_MAX; f0 += 1) {
      if (excessAt(f0) < hit * 0.8) continue;
      const r = score(f0); if (r.s > best.s || (r.s > best.s * 0.85 && r.hits >= best.hits && r.f0 < best.f0 && best.hits)) best = r;
    }
    // debias pitch (the search prefers the lowest f0 within 85% of the best score, ~2% low): least squares over hit rungs
    if (best.hits >= 3) { let num = 0, den = 0; for (const r of best.rungs) if (r.hit) { num += r.h * peakHz(r.pk); den += r.h * r.h; } if (den) best.f0 = num / den; }
    best.dense = 0;
    if (best.hits >= 3) for (let h = 1; h <= 4; h++) {                    // count peaks between rungs h and h+1
      const a = Math.round((best.f0 * h) / BIN_HZ) + tol(best.f0 * h) + 1, b = Math.round((best.f0 * (h + 1)) / BIN_HZ) - tol(best.f0 * (h + 1)) - 1;
      for (let i = a + 1; i < b && i < n - 1; i++) if (db[i] - fl[i] > hit && db[i] >= db[i - 1] && db[i] >= db[i + 1]) best.dense++;
    }
    best.floor = fl;
    return best;
  }

  // ---------- RF (passive receive-only energy detector at 2.4 / 5.8 GHz) ----------
  // Received power = EIRP + rx antenna gain - free-space path loss - clutter. Signal strength only, never decoded.
  const fspl = (dkm, fMHz) => 20 * Math.log10(Math.max(dkm, 0.01)) + 20 * Math.log10(fMHz) + 32.44;
  function rfFloor(env) { return env.scen === 'city' ? -86 : env.scen === 'night' ? -96 : -93; } // busy WiFi raises it
  function rf(o, env, tw) {
    if (!o.radioOn || o.spec.eirp == null) return null;
    const dkm = Math.hypot(o.x - tw.x, o.y - tw.y, o.h - tw.h) / 1000, sp = o.spec;
    const clutter = (env.scen === 'city' ? 6 : 2) + (o.h < 40 ? 5 : 0);
    const l24 = sp.band === '5.8' ? -200 : sp.eirp + 8 - fspl(dkm, 2440) - clutter - rainAtt(wxOf(env), 2.4, dkm);
    const l58 = sp.eirp + (sp.band === '5.8' ? 0 : -6) + 8 - fspl(dkm, 5800) - clutter - rainAtt(wxOf(env), 5.8, dkm); // 5.8 GHz video downlink
    const rssi = Math.max(l24, l58) + gauss() * 2, band = l24 >= l58 ? '2.4' : '5.8', fl = rfFloor(env);
    const snr = rssi - fl - 6;
    if (snr < 0) return null;
    return { rssi, band, conf: clamp(0.2 + snr / 18, 0.2, 1), brg: bearing(tw, o) + gauss() * 22, obj: o };
  }
  // Rain attenuation (dB): ITU-R P.838-style specific attenuation is tiny at these frequencies (heavy ~25 mm/h rain:
  // ~0.004 dB/km at 2.4 GHz, ~0.08 dB/km at 5.8 GHz; light ~5 mm/h: ~0.0007 / ~0.012) plus wet trees/roofs/antenna radome (~1 dB / ~2 dB). Dust: negligible.
  function rainAtt(wx, ghz, dkm) {
    if (!wx.rain) return 0; const hv = wx.rain === 2;
    return (ghz > 5 ? (hv ? 0.08 : 0.012) : (hv ? 0.004 : 0.0007)) * dkm + (ghz > 5 ? (hv ? 2 : 0.6) : (hv ? 1 : 0.3));
  }
  // invert free space loss assuming a "typical" 20 dBm drone, at the band the energy was seen in (2.4 or 5.8 GHz). EIRP is
  // unknown (10-30 dBm), so this range is only good to a factor of ~3 either way.
  const rfRange = (rssi, env, band) => 1000 * Math.pow(10, (20 + 8 - (env.scen === 'city' ? 6 : 2) - rssi - 20 * Math.log10(band === '5.8' ? 5800 : 2440) - 32.44) / 20);

  // ---------- Remote ID (public broadcast over Bluetooth/WiFi beacon; designed to be read openly) ----------
  function rid(o, env, tw) {
    if (!o.ridOn) return null;
    const r = Math.hypot(o.x - tw.x, o.y - tw.y), range = ridRange(env);
    if (r > range || Math.random() > 0.9) return null;               // ~10% packets missed
    return { conf: 1, x: o.x + gauss() * 10, y: o.y + gauss() * 10, obj: o };
  }

  // Remote ID range: 1 km (700 m in a busy city); rain loss at 2.4 GHz turns into a few % less range (20log rule)
  const ridRange = env => (env.scen === 'city' ? 700 : 1000) * Math.pow(10, -rainAtt(wxOf(env), 2.4, 1) / 20);
  // Thermal range factor from weather: contrast of a warm motor against the background + what the air does to LWIR.
  //  cold night = best contrast; hot day = warm sky/ground background + heat shimmer; rain and dust/haze scatter and absorb a lot.
  function thermFactor(wx) {
    const tod = { coldnight: 1.3, mildnight: 1.15, mildday: 1, hotday: 0.65 }[wx.tod] || 1;
    return tod * [1, 0.7, 0.4][wx.rain] * [1, 0.8, 0.45][wx.dust];
  }
  // ---------- Thermal camera (pan-tilt, narrow view) + a simple shape/motion check (drone / bird / aircraft) ----------
  function thermal(o, env, cam) {
    const r = Math.hypot(o.x - cam.x, o.y - cam.y, o.h - cam.h), range = o.spec.therm * thermFactor(wxOf(env)) * (env.scen === 'city' ? 0.85 : 1);
    if (angDiff(cam.az, bearing(cam, o)) > cam.fov / 2 || r > range) return null;
    return { conf: clamp(1.2 - r / range, 0.35, 1), brg: bearing(cam, o) + gauss() * 0.5, r, cls: o.spec.tcls, obj: o };
  }

  // ---------- Vibration sensor on a roof/window ----------
  function vibration(o, vb) {
    if (!o.spec.drone) return null;
    const r = Math.hypot(o.x - vb.x, o.y - vb.y);
    const ok = o.spec.big ? (r < 35 && o.h < 45) : (r < 12 && o.h < 20);
    return ok ? { conf: 0.8, obj: o } : null;
  }

  // Vibration false shakes per 0.5 s step: gusts above ~8 m/s rattle the roof; heavy rain drumming adds more.
  const vibFalseRate = wx => Math.max(0, wx.wind - 8) * 0.006 + [0, 0.002, 0.012][wx.rain];
  // Drone in bad weather: motors work harder (louder ladder) and the path wobbles; light drones suffer most.
  function droneStrain(spec, wx) {
    if (!spec.drone) return { loud: 0, wobble: 0 };
    const light = spec.size < 1.05 ? 1.6 : 1, w = Math.max(0, wx.wind - 4) + (wx.rain === 2 ? 3 : wx.rain ? 1 : 0);
    return { loud: Math.min(3, 0.25 * w * light), wobble: Math.min(120, 6 * w * light) };
  }

  // Wind "singing": wind over a guy wire / pole edge sheds vortices at f = 0.2 v / d (Strouhal) and the wire hums with a few
  // harmonics, right at the mic. Classic false alarm for a harmonic detector. Starts ~7 m/s at the mic, gusty (comes and goes).
  function singing(env, node) {
    const wx = wxOf(env), v = wx.wind * (env.tog.height ? 1.25 : 1);
    if (v < 7 || Math.random() > clamp((v - 7) / 8, 0, 0.6)) return null;
    const d = node.wireD || 0.0075, f0 = 0.2 * v / d * (1 + 0.06 * gauss()), L = 24 + 1.8 * (v - 7);
    return [1, 2, 3].map(h => ({ f: f0 * h, L: L - 5 * (h - 1) }));        // only ~3 rungs: a real rotor usually shows more
  }

  // ---------- LOCAL NOISE SOURCES the user can place (rough estimates; schedules are typical Bangalore guesses) ----------
  // tone: a ladder (f0, level per bin at 1 m, harmonics, dB drop each); partials: a bell's inharmonic partials;
  // bb: broadband level per 4 Hz bin at 10 m (at 100 Hz, -3 dB/octave). Levels are dB SPL like the drones above.
  const SOURCES = {
    ac:     { label: 'AC unit', icon: '❄️', sched: '11:00–23:00 daily, compressor cycles', snd: { ladder: { f0: 100, sl: 62, nh: 5, slope: 5 } } },
    road:   { label: 'Highway', icon: '🛣️', sched: 'all day, busiest 8–10 & 17–20, quiet 0–5', bb: 50, road: true },
    temple: { label: 'Temple bells', icon: '🛕', sched: '6:00 & 18:00, ~20 min each', snd: { partials: { hum: 140, sl: 92, r: [1, 2, 2.4, 3, 4, 5] } } },
    gen:    { label: 'Generator', icon: '⚡', sched: '18:00–20:30 daily (evening power cut)', snd: { ladder: { f0: 125, sl: 74, nh: 8, slope: 3 } } },
    build:  { label: 'Construction', icon: '🏗️', sched: 'weekdays 9–13 & 14–18, bangs', bb: 52 }
  };
  // dB offset for a source at this time, or null when it is off. hour = 0..24 (float).
  function srcGain(type, hour, weekend) {
    const in_ = (a, b) => hour >= a && hour < b, m = (hour * 60) % 20;
    if (type === 'ac') return in_(11, 23) && m < 14 ? 0 : null;          // compressor on 14 of every 20 minutes
    if (type === 'road') return in_(0, 5) ? -12 : in_(5, 7) ? -5 : in_(22, 24) ? -6 : weekend ? -3 : (in_(8, 10) || in_(17, 20)) ? 3 : 0;
    if (type === 'temple') return (in_(6, 6.34) || in_(18, 18.34)) && Math.random() < 0.7 ? 0 : null; // bells struck on and off
    if (type === 'gen') return in_(18, 20.5) ? 0 : null;
    if (type === 'build') return !weekend && (in_(9, 13) || in_(14, 18)) ? (Math.random() < 0.35 ? 14 : 0) : null; // hammer / breaker bangs
    return null;
  }
  // what the placed sources put into the world right now: tonal ones become still "objects" for objectTones, broadband ones noise
  function activeSources(srcs, hour, weekend) {
    const srcTones = [], srcBB = [];
    for (const s of srcs || []) {
      const sp = SOURCES[s.type], g = srcGain(s.type, hour, weekend); if (g == null) continue;
      if (sp.snd) srcTones.push({ x: s.x, y: s.y, h: 3, spec: { snd: sp.snd }, rpm: 1, loud: g, src: s });
      else srcBB.push({ x: s.x, y: s.y, road: !!sp.road, L: sp.bb + g });
    }
    return { srcTones, srcBB };
  }

  // ---------- Weather impact readout: range vs a clear mild day (same scene + sensors) ----------
  // Sound: distance where a small quad's first 3 rungs average > hit threshold above noise, averaged up/cross/downwind.
  const REF_MARGIN = 4.5;
  function soundRangeRef(env, c) {
    const lad = OBJECTS.small.snd.ladder, T = env.tog, node = { h: T.height ? 8 : 1.5, dishAz: 0 }, hit = T.s3 ? 6 : HIT_DB, wx = wxOf(env);
    const hs = OBJECTS.small.h, e = Object.assign({}, env, { objs: [] });
    const ok = r => { let s = 0; for (let h = 1; h <= 3; h++) { const f = lad.f0 * h, n = noiseParts(f, e, node), G = (T.dish ? dishGain(f) : 0) + (T.ring ? 6 : 0);
      const L = lad.sl - lad.slope * (h - 1) - 20 * Math.log10(Math.hypot(r, hs - node.h)) - absorb(f, env.wx) * r / 1000 - excess(r, T.height, hs, node.h) - wxLoss(r, env.wx, c, hs, node.h, f) + G;
      s += L - dbAdd(n.self, n.amb, n.wind, n.rain); } return s / 3 > hit + REF_MARGIN; };  // margin calibrated so this matches the synth+comb sweep (tests/ranges.js)
    let a = 20, b = 8000; if (!ok(a)) return 0; for (let i = 0; i < 40; i++) { const m = (a + b) / 2; ok(m) ? a = m : b = m; } return a;
  }
  function rfRangeRef(env, ghz) {
    const wx = wxOf(env), fl = rfFloor(env) + 6, cl = env.scen === 'city' ? 6 : 2;
    const ok = d => 20 + 8 - fspl(d, ghz * 1000) - cl - rainAtt(wx, ghz, d) > fl;
    let a = 0.05, b = 30; for (let i = 0; i < 40; i++) { const m = (a + b) / 2; ok(m) ? a = m : b = m; } return a * 1000;
  }
  function weatherImpact(env) {
    const ref = Object.assign({}, env, { wx: WX_REF }), snd = e => (soundRangeRef(e, -1) + soundRangeRef(e, 0) + soundRangeRef(e, 1)) / 3;
    const pct = (a, b) => b > 0 ? Math.round((a / b - 1) * 100) : 0, wx = wxOf(env);
    const s = snd(env), s0 = snd(ref), up = soundRangeRef(env, -1), dn = soundRangeRef(env, 1);
    return {
      sound: { m: s, pct: pct(s, s0), up, dn },
      rf24: { m: rfRangeRef(env, 2.4), pct: pct(rfRangeRef(env, 2.4), rfRangeRef(ref, 2.4)) },
      rf58: { m: rfRangeRef(env, 5.8), pct: pct(rfRangeRef(env, 5.8), rfRangeRef(ref, 5.8)) },
      rid: { m: ridRange(env), pct: pct(ridRange(env), ridRange(ref)) },
      thermal: { m: OBJECTS.small.therm * thermFactor(wx), pct: pct(thermFactor(wx), thermFactor(WX_REF)) },
      vib: { falsePerMin: vibFalseRate(wx) * 120 }
    };
  }

  // ---------- geometry ----------
  function bearing(a, b) { return (Math.atan2(b.x - a.x, -(b.y - a.y)) * 180 / Math.PI + 360) % 360; } // 0 = north (map up)
  function angDiff(a, b) { return Math.abs(((a - b) % 360 + 540) % 360 - 180); }
  const compass = b => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(((b % 360) + 360) % 360 / 45) % 8];

  // speed of sound from the hub T/RH sensor (spec c.3a): sonic temperature Ts = (T+273.15)(1+0.51q), q from RH (Bolton 1980)
  function soundSpeed(T, RH, p) {
    if (RH == null) return 331.3 * Math.sqrt(1 + T / 273.15);
    const e = (RH / 100) * 6.112 * Math.exp(17.67 * T / (T + 243.5)), P = p || 1013.25, q = 0.622 * e / (P - 0.378 * e);
    return 331.3 * Math.sqrt((T + 273.15) * (1 + 0.51 * q) / 273.15);
  }
  g.SkyPhys = { soundSpeed, isoAlpha, gradient, wxLoss, shadowOnset, dishGain, dishBeam, gains, C_AIR, SOURCES, srcGain, activeSources, singing, TOD, WX_REF, weatherImpact, vibFalseRate, droneStrain, thermFactor, rainAtt, turbSigma, BIN_HZ, FMAX, NB, HIT_DB, OBJECTS, synth, comb, rf, rfRange, rid, thermal, vibration, bearing, angDiff, compass, gauss, clamp, absorb, excess, noiseParts, objectTones, dbAdd };
  if (typeof module !== 'undefined' && module.exports) module.exports = g.SkyPhys;
})(typeof window !== 'undefined' ? window : globalThis);
