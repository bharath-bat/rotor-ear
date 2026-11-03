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

  // Drone types. sl = blade-pass fundamental level at 1 m (dB SPL, one 4 Hz bin); harmonics fall 3 dB each.
  // eirp = radio link transmit power (dBm). therm = thermal-camera detection range (m). speed in m/s.
  const DRONES = {
    toy:   { label: 'Toy / micro (~80 g)',  f0: 380, sl: 70, eirp: 10, therm: 220,  speed: 6,  big: false },
    small: { label: 'Small quad (~0.9 kg)', f0: 190, sl: 81, eirp: 20, therm: 550,  speed: 12, big: false },
    large: { label: 'Large quad (~6 kg)',   f0: 110, sl: 89, eirp: 27, therm: 1000, speed: 15, big: true }
  };

  // Air absorption (dB/km), rough ISO 9613-1 shape at ~20 °C, 70% RH: ~0.6 dB/km at 200 Hz, ~5 at 1 kHz, ~30 at 4 kHz.
  const absorb = f => 5 * Math.pow(f / 1000, 1.3);
  // Extra loss beyond spherical spreading: ground effect, turbulence, refraction. Grows slowly with range.
  // A raised node (8 m pole) sees over walls and avoids most ground effect.
  const excess = (r, high) => 10 * Math.log10(1 + r / 150) + (high ? 0 : 5 * (1 - Math.exp(-r / 250)));

  // ---------- SOUND ----------
  // Noise in one 4 Hz bin (dB SPL) at a node: mic self-hiss + ambient + wind + jet roar (broadband).
  function noiseParts(f, env, node) {
    const T = env.tog, high = T.height;
    const self = T.lownoise ? 1 : 8;                                      // INMP441 (SNR 61 dB) vs ICS-43434/IM69D130 class
    let amb;
    if (env.scen === 'night') amb = 4 + 8 * Math.exp(-f / 150);
    else if (env.scen === 'city') amb = Math.max(8, 32 - 4 * Math.log2(Math.max(f, 100) / 100));
    else amb = Math.max(4, 16 - 3 * Math.log2(Math.max(f, 100) / 100));   // suburb + jet
    if (high) amb -= 5;                                                   // above street-level noise
    const v = env.wind * (high ? 1.25 : 1);                               // more wind up a pole...
    const wind = v > 0.2 ? 20 * Math.log10(v) + 6 - 10 * Math.log2(Math.max(f, 50) / 50) : -40; // ...but a fur windshield is assumed
    let jet = -60;
    if (env.jet) {
      const r = Math.hypot(env.jet.x - node.x, env.jet.y - node.y, env.jet.alt);
      const total = 142 - 20 * Math.log10(r) - absorb(500) * r / 1000;    // broadband roar, total level
      jet = total - 29 - (f < 500 ? 0 : 4 * Math.log2(f / 500));          // spread over ~3 kHz
      if (T.ring && node._jetSep > 30) jet -= 8;                           // array steers a null-ish away from jet
    }
    return { self, amb, wind, jet };
  }

  // Received drone tone levels at a node, per harmonic, plus applied gains.
  function droneTones(d, dt, env, node) {
    const T = env.tog, r = Math.max(5, Math.hypot(d.x - node.x, d.y - node.y, d.h - node.h));
    let gain = 0;
    if (T.dish) gain += angDiff(node.dishAz, bearing(node, d)) < 22 ? 9 : -2; // parabolic dish: +9 dB in its beam
    if (T.ring) gain += 6;                                                     // 4-mic ring: 10log10(4) array gain
    if (T.longlisten) gain += 5 * Math.log10(3 / 0.5);                         // 3 s vs 0.5 s integration (~+3.9 dB)
    const out = [];
    if (!d.on) return { r, tones: out, gain };
    for (let h = 1; h <= NH; h++) {
      const f = dt.f0 * d.rpm * h; if (f > FMAX - 20) break;
      const spread = 10 * Math.log10(Math.max(1, 0.02 * f / BIN_HZ));        // rotor speed wobble smears high harmonics
      out.push({ f, L: dt.sl - 3 * (h - 1) - 20 * Math.log10(r) - absorb(f) * r / 1000 - excess(r, T.height) - spread + gain });
    }
    return { r, tones: out, gain };
  }

  // Build a one-frame spectrum (dB per bin). Noise bins fluctuate (chi-square); longer listening averages more frames.
  function synth(d, dt, env, node, out) {
    const db = out || new Float32Array(NB), K = env.tog.longlisten ? 8 : 1;
    const parts = new Float32Array(NB); node._jetDb = node._jetDb || new Float32Array(NB);
    for (let i = 1; i < NB; i++) {
      const p = noiseParts(i * BIN_HZ, env, node);
      const P = Math.pow(10, p.self / 10) + Math.pow(10, p.amb / 10) + Math.pow(10, p.wind / 10) + Math.pow(10, p.jet / 10);
      let x = 0; for (let k = 0; k < K; k++) x -= Math.log(Math.random() + 1e-12);
      parts[i] = P * x / K; node._jetDb[i] = p.jet;
    }
    const tn = droneTones(d, dt, env, node);
    for (const t of tn.tones) {
      const c = Math.round(t.f / BIN_HZ), P = Math.pow(10, t.L / 10) * (0.7 + 0.6 * Math.random());
      if (c > 0 && c < NB) parts[c] += P;
      if (c > 1) parts[c - 1] += P * 0.16; if (c < NB - 1) parts[c + 1] += P * 0.16;
    }
    for (let i = 0; i < NB; i++) db[i] = 10 * Math.log10(parts[i] + 1e-20);
    db[0] = db[1];
    return { db, tn };
  }

  // ---- Rotor Ear comb detector (ported from detector.js): local floor, ±2.5% peak search, ladder score ----
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
    best.floor = fl;
    return best;
  }

  // ---------- RF (passive receive-only energy detector at 2.4 / 5.8 GHz) ----------
  // Received power = drone EIRP + rx antenna gain - free-space path loss - clutter. Signal strength only, never decoded.
  const fspl = (dkm, fMHz) => 20 * Math.log10(Math.max(dkm, 0.01)) + 20 * Math.log10(fMHz) + 32.44;
  function rfFloor(env) { return env.scen === 'city' ? -86 : env.scen === 'night' ? -96 : -93; } // busy WiFi raises it
  function rf(d, dt, env, tw) {
    if (!d.radio) return null;
    const dkm = Math.hypot(d.x - tw.x, d.y - tw.y, d.h - tw.h) / 1000;
    const clutter = (env.scen === 'city' ? 6 : 2) + (d.h < 40 ? 5 : 0);
    const l24 = dt.eirp + 8 - fspl(dkm, 2440) - clutter, l58 = dt.eirp + 3 + 8 - fspl(dkm, 5800) - clutter;
    const rssi = Math.max(l24, l58) + gauss() * 2, band = l24 >= l58 ? '2.4' : '5.8', fl = rfFloor(env);
    const snr = rssi - fl - 6;
    if (snr < 0) return null;
    return { rssi, band, conf: clamp(0.2 + snr / 18, 0.2, 1), brg: bearing(tw, d) + gauss() * 22 };
  }
  // invert free space loss assuming a "typical" 20 dBm drone: rough range from signal strength
  const rfRange = (rssi, env) => 1000 * Math.pow(10, (20 + 8 - (env.scen === 'city' ? 6 : 2) - rssi - 20 * Math.log10(2440) - 32.44) / 20);

  // ---------- Remote ID (public broadcast over Bluetooth/WiFi beacon; designed to be read openly) ----------
  function rid(d, env, tw) {
    if (!d.rid) return null;
    const r = Math.hypot(d.x - tw.x, d.y - tw.y), range = env.scen === 'city' ? 700 : 1000;
    if (r > range || Math.random() > 0.9) return null;               // ~10% packets missed
    return { conf: 1, x: d.x + gauss() * 10, y: d.y + gauss() * 10 };
  }

  // ---------- Thermal camera (pan-tilt, narrow field of view) ----------
  function thermal(d, dt, env, cam) {
    const r = Math.hypot(d.x - cam.x, d.y - cam.y, d.h - cam.h), range = dt.therm * (env.scen === 'night' ? 1.2 : env.scen === 'city' ? 0.85 : 1);
    if (angDiff(cam.az, bearing(cam, d)) > cam.fov / 2 || r > range) return null;
    return { conf: clamp(1.2 - r / range, 0.35, 1), brg: bearing(cam, d) + gauss() * 0.5, r };
  }

  // ---------- Vibration sensor on a roof/window ----------
  function vibration(d, dt, vb) {
    const r = Math.hypot(d.x - vb.x, d.y - vb.y);
    const ok = dt.big ? (r < 35 && d.h < 45) : (r < 12 && d.h < 20);
    return ok ? { conf: 0.8 } : null;
  }

  // ---------- geometry ----------
  function bearing(a, b) { return (Math.atan2(b.x - a.x, -(b.y - a.y)) * 180 / Math.PI + 360) % 360; } // 0 = north (map up)
  function angDiff(a, b) { const d = Math.abs(((a - b) % 360 + 540) % 360 - 180); return d; }
  const compass = b => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(((b % 360) + 360) % 360 / 45) % 8];

  g.SkyPhys = { BIN_HZ, FMAX, NB, HIT_DB, DRONES, synth, comb, rf, rfRange, rid, thermal, vibration, bearing, angDiff, compass, gauss, clamp, absorb, excess, noiseParts, droneTones, dbAdd };
})(typeof window !== 'undefined' ? window : globalThis);
