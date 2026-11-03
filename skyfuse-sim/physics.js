// SkyFuse sim: per-sense physics models + a port of Rotor Ear's harmonic-comb ("ladder") detector.
// Everything here is a deliberately SIMPLE model. Numbers are rough, hand-picked estimates, not measurements.
// Passive only: every sense here only RECEIVES. Nothing transmits at the drone, nothing is jammed or decoded.
(function (g) {
  'use strict';
  const BIN_HZ = 4, FMAX = 4000, NB = FMAX / BIN_HZ;          // synthetic spectrum: 0-4 kHz in 4 Hz bins
  const F0_MIN = 90, F0_MAX = 600, NH = 10, HIT_DB = 9;         // same numbers as Rotor Ear detector.js / rotor_detector.h
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

  // Air absorption (dB/km), rough ISO 9613-1 shape at ~20 °C, 70% RH: ~0.6 dB/km at 200 Hz, ~5 at 1 kHz, ~30 at 4 kHz.
  const absorb = f => 5 * Math.pow(f / 1000, 1.3);
  // Extra loss beyond spherical spreading: ground effect, turbulence, refraction. A raised node (8 m pole) avoids most ground effect.
  const excess = (r, high) => 10 * Math.log10(1 + r / 150) + (high ? 0 : 5 * (1 - Math.exp(-r / 250)));
  const dist3 = (o, n) => Math.max(5, Math.hypot(o.x - n.x, o.y - n.y, o.h - n.h));

  // ---------- SOUND ----------
  // Noise in one 4 Hz bin (dB SPL) at a node: mic self-hiss + ambient + wind + broadband roar of jets/helicopters.
  function noiseParts(f, env, node) {
    const T = env.tog, high = T.height;
    const self = T.lownoise ? 1 : 8;                                      // INMP441 (SNR 61 dB) vs ICS-43434/IM69D130 class
    let amb;
    if (env.scen === 'night') amb = 4 + 8 * Math.exp(-f / 150);
    else if (env.scen === 'city') amb = Math.max(8, 32 - 4 * Math.log2(Math.max(f, 100) / 100));
    else amb = Math.max(4, 16 - 3 * Math.log2(Math.max(f, 100) / 100));   // suburb
    if (high) amb -= 5;                                                   // above street-level noise
    const v = env.wind * (high ? 1.25 : 1);                               // more wind up a pole...
    const wind = v > 0.2 ? 20 * Math.log10(v) + 6 - 10 * Math.log2(Math.max(f, 50) / 50) : -40; // ...but a fur windshield is assumed
    let roar = -60;
    for (const o of env.objs) {
      if (!o.spec.snd.roar) continue;
      const r = dist3(o, node), total = o.spec.snd.roar - 20 * Math.log10(r) - absorb(500) * r / 1000;
      let L = total - 29 - (f < 500 ? 0 : 4 * Math.log2(f / 500));        // spread over ~3 kHz
      if (T.ring && node._focus && angDiff(bearing(node, o), bearing(node, node._focus)) > 30) L -= 8; // array points away from it
      roar = dbAdd(roar, L);
    }
    return { self, amb, wind, roar };
  }

  // Tone gains at a node for a source in a given direction: dish (+9 dB in its beam), ring (+6 dB), long listening (+3.9 dB).
  function gains(env, node, o) {
    const T = env.tog; let gain = 0;
    if (T.dish) gain += angDiff(node.dishAz, bearing(node, o)) < 22 ? 9 : -2;
    if (T.ring) gain += 6;                                                 // 4-mic ring: 10log10(4) array gain
    if (T.longlisten) gain += 5 * Math.log10(3 / 0.5);                     // 3 s vs 0.5 s integration
    return gain;
  }
  // All tonal components one object puts into one node: rotor ladder, bird chirp, turbine whine.
  function objectTones(o, env, node) {
    const s = o.spec.snd, r = dist3(o, node), loss = f => 20 * Math.log10(r) + absorb(f) * r / 1000 + excess(r, env.tog.height), G = gains(env, node, o), out = [];
    if (s.ladder) for (let h = 1; h <= s.ladder.nh; h++) {
      const f = s.ladder.f0 * o.rpm * h; if (f > FMAX - 20) break;
      const spread = 10 * Math.log10(Math.max(1, 0.02 * f / BIN_HZ));     // rotor speed wobble smears high harmonics
      out.push({ f, L: s.ladder.sl - s.ladder.slope * (h - 1) - loss(f) - spread + G });
    }
    if (s.chirp && o.chirping) out.push({ f: o.chirpF, L: s.chirp.sl - loss(o.chirpF) + G });
    if (s.whine) out.push({ f: s.whine.f, L: s.whine.sl - loss(s.whine.f) + G - 6 });
    return { r, tones: out };
  }

  // Build a one-frame spectrum (dB per bin). Noise bins fluctuate (chi-square); longer listening averages more frames.
  function synth(env, node, out) {
    const db = out || new Float32Array(NB), K = env.tog.longlisten ? 8 : 1;
    const parts = new Float32Array(NB); node._roarDb = node._roarDb || new Float32Array(NB);
    for (let i = 1; i < NB; i++) {
      const p = noiseParts(i * BIN_HZ, env, node);
      const P = Math.pow(10, p.self / 10) + Math.pow(10, p.amb / 10) + Math.pow(10, p.wind / 10) + Math.pow(10, p.roar / 10);
      let x = 0; for (let k = 0; k < K; k++) x -= Math.log(Math.random() + 1e-12);
      parts[i] = P * x / K; node._roarDb[i] = p.roar;
    }
    for (const o of env.objs) for (const t of objectTones(o, env, node).tones) {
      const c = Math.round(t.f / BIN_HZ), P = Math.pow(10, t.L / 10) * (0.7 + 0.6 * Math.random());
      if (c > 0 && c < NB) parts[c] += P;
      if (c > 1) parts[c - 1] += P * 0.16; if (c < NB - 1) parts[c + 1] += P * 0.16;
    }
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
    const excessAt = f => { const t = tol(f), c = Math.round(f / BIN_HZ); let best = 0;
      for (let i = c - t; i <= c + t; i++) { if (i < 1 || i >= n) continue; const e = db[i] - fl[i]; if (e > best) best = e; }
      return Math.min(best, 30); };
    function score(f0) {
      let s = 0, hits = 0, low = 0, e1 = 0; const rungs = [];
      for (let h = 1; h <= NH; h++) { const f = f0 * h; if (f > FMAX) break;
        const e = excessAt(f); s += e; rungs.push({ f, e, hit: e > hit });
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
    const l24 = sp.band === '5.8' ? -200 : sp.eirp + 8 - fspl(dkm, 2440) - clutter;
    const l58 = sp.eirp + (sp.band === '5.8' ? 0 : -6) + 8 - fspl(dkm, 5800) - clutter; // 5.8 GHz video downlink
    const rssi = Math.max(l24, l58) + gauss() * 2, band = l24 >= l58 ? '2.4' : '5.8', fl = rfFloor(env);
    const snr = rssi - fl - 6;
    if (snr < 0) return null;
    return { rssi, band, conf: clamp(0.2 + snr / 18, 0.2, 1), brg: bearing(tw, o) + gauss() * 22, obj: o };
  }
  // invert free space loss assuming a "typical" 20 dBm drone: rough range from signal strength
  const rfRange = (rssi, env) => 1000 * Math.pow(10, (20 + 8 - (env.scen === 'city' ? 6 : 2) - rssi - 20 * Math.log10(2440) - 32.44) / 20);

  // ---------- Remote ID (public broadcast over Bluetooth/WiFi beacon; designed to be read openly) ----------
  function rid(o, env, tw) {
    if (!o.ridOn) return null;
    const r = Math.hypot(o.x - tw.x, o.y - tw.y), range = env.scen === 'city' ? 700 : 1000;
    if (r > range || Math.random() > 0.9) return null;               // ~10% packets missed
    return { conf: 1, x: o.x + gauss() * 10, y: o.y + gauss() * 10, obj: o };
  }

  // ---------- Thermal camera (pan-tilt, narrow view) + a simple shape/motion check (drone / bird / aircraft) ----------
  function thermal(o, env, cam) {
    const r = Math.hypot(o.x - cam.x, o.y - cam.y, o.h - cam.h), range = o.spec.therm * (env.scen === 'night' ? 1.2 : env.scen === 'city' ? 0.85 : 1);
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

  // ---------- geometry ----------
  function bearing(a, b) { return (Math.atan2(b.x - a.x, -(b.y - a.y)) * 180 / Math.PI + 360) % 360; } // 0 = north (map up)
  function angDiff(a, b) { return Math.abs(((a - b) % 360 + 540) % 360 - 180); }
  const compass = b => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(((b % 360) + 360) % 360 / 45) % 8];

  g.SkyPhys = { BIN_HZ, FMAX, NB, HIT_DB, OBJECTS, synth, comb, rf, rfRange, rid, thermal, vibration, bearing, angDiff, compass, gauss, clamp, absorb, excess, noiseParts, objectTones, dbAdd };
})(typeof window !== 'undefined' ? window : globalThis);
