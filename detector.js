// RotorDetector: the shared Rotor Ear detector + sound fingerprint classifier.
// Used by the watch post (index.html + watch.js) and by Phone Mesh Radar (mesh/).
// Passive: it only reads an AnalyserNode. No audio ever leaves the device.
(function (g) {
  'use strict';
  const FMAX = 8000, F0_MIN = 90, F0_MAX = 600, NH = 10, HIT_DB = 9, HIST_MS = 1200, FP_MS = 2000;
  const clamp = (x, a, b) => x < a ? a : x > b ? b : x;
  const median = a => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };

  // ---- fingerprint classes: hand-set centroids in a normalised feature space ----
  // features: pitch = log2(f0/200), split = extra peaks per harmonic (several rotors),
  // beat = amplitude-modulation depth, steady = how rock-stable the pitch is,
  // sub = energy between harmonics (true pitch is below the comb), mains = locked to 50/60 Hz.
  const FEATS = ['pitch', 'split', 'beat', 'steady', 'sub', 'mains'];
  const W = [1.0, 1.2, 0.8, 1.0, 1.2, 1.0];
  const CLASSES = [
    { id: 'quad',   label: 'Quadcopter', drone: true,  c: [0.1, 0.8, 1.2, 0.2, 0, 0] },
    { id: 'fixed',  label: 'Fixed-wing', drone: true,  c: [-0.6, 0, 0.15, 0.6, 0, 0] },
    { id: 'micro',  label: 'Micro drone', drone: true, c: [1.4, 0.6, 0.5, 0.2, 0, 0] },
    { id: 'hum',    label: 'Not a drone', why: 'steady hum (fan / AC / mains)', drone: false, c: [-0.2, 0, 0, 1.6, 0, 0.3] },
    { id: 'mains',  label: 'Not a drone', why: 'mains hum (50/60 Hz)', drone: false, c: [-0.8, 0, 0, 1.6, 1.0, 1] },
    { id: 'engine', label: 'Not a drone', why: 'engine (low, irregular)', drone: false, c: [-0.8, 0.3, 0.6, 0, 1.2, 0] }
  ];
  const GROUPS = ['Quadcopter', 'Fixed-wing', 'Micro drone', 'Not a drone'];
  const T = 0.35, LEARN_T = 0.15, LEARN_W = 2; // taught samples: tighter kernel, higher weight
  // Teach-mode tags (each belongs to one of the four groups above)
  const TAGS = [
    { id: 'quad', label: 'Quadcopter', group: 'Quadcopter' }, { id: 'fixed', label: 'Fixed-wing', group: 'Fixed-wing' },
    { id: 'micro', label: 'Micro drone', group: 'Micro drone' }, { id: 'fan', label: 'Fan / AC', group: 'Not a drone' },
    { id: 'engine', label: 'Engine / bike', group: 'Not a drone' }, { id: 'bird', label: 'Bird', group: 'Not a drone' },
    { id: 'voice', label: 'Voice', group: 'Not a drone' }, { id: 'other', label: 'Other', group: 'Not a drone' }
  ];

  function makeAnalyser(ctx) {
    const a = ctx.createAnalyser();
    a.fftSize = 8192; a.smoothingTimeConstant = 0.5;
    a.minDecibels = -110; a.maxDecibels = -20;
    return a;
  }


  // ---- flight state from the rotor pitch over time ----
  // Blade-pass pitch follows rotor speed: throttle up (climb, heavier load) raises it, throttle down lowers it.
  // A moving drone also shifts pitch by Doppler (±v/343: ±3% at 10 m/s), which only *changes* when the
  // drone passes by, and then the pitch drop coincides with a loudness peak; that is how we tell them apart.
  const FLIGHT = { climbPct: 0.8, steadyPct: 0.45, swingPct: 1.1, heavyPct: 5, heavyDb: 4 };
  const lsq = pts => { // [x, y] → slope, intercept, residual std
    const n = pts.length, mx = pts.reduce((a, p) => a + p[0], 0) / n, my = pts.reduce((a, p) => a + p[1], 0) / n;
    let sxy = 0, sxx = 0; pts.forEach(p => { sxy += (p[0] - mx) * (p[1] - my); sxx += (p[0] - mx) ** 2; });
    const b = sxx ? sxy / sxx : 0, a = my - b * mx;
    return { b, a, sd: Math.sqrt(pts.reduce((s, p) => s + (p[1] - a - b * p[0]) ** 2, 0) / n) };
  };
  class FlightTracker {
    constructor() { this.blades = 2; this.reset(); }
    reset() { this.h = []; this.spark = []; this.base = null; this.state = ''; this.cand = ''; this.candT = 0; this.lastOn = 0; }
    // now ms, f = refined pitch Hz (0 = no comb this frame), e = harmonic band energy dB, on = a drone is detected
    update(now, f, e, on) {
      if (!on) { if (now - this.lastOn > 8000 && this.h.length) this.reset(); this.state = ''; return null; }
      this.lastOn = now;
      if (f > 0) this.h.push([now, Math.log(f) * 100, e]); // log-pitch in "percent" units
      while (this.h.length && now - this.h[0][0] > 6000) this.h.shift();
      const H = this.h, last = k => H.filter(x => now - x[0] <= k);
      if (!H.length) return null;
      const r = last(500), fs = Math.exp((r.length ? median(r.map(x => x[1])) : H[H.length - 1][1]) / 100);
      if (!this.spark.length || now - this.spark[this.spark.length - 1][0] >= 250) { this.spark.push([now, fs]); if (this.spark.length > 80) this.spark.shift(); }
      const w = last(2500), out = { f: fs, rpm: fs * 60 / this.blades, rate: 0, dbRate: 0, state: this.state, base: this.base && this.base.f, spark: this.spark };
      if (w.length < 15 || now - w[0][0] < 2000) return out;
      const p = lsq(w.map(x => [(x[0] - now) / 1000, x[1]])), l = lsq(w.map(x => [(x[0] - now) / 1000, x[2]]));
      out.rate = p.b; out.dbRate = l.b; // %/s and dB/s
      // fly-by test: over the last ~5 s, loudness rose then fell (a peak) while the pitch fell
      const w5 = last(5000); let flyby = false;
      if (w5.length > 30 && now - w5[0][0] > 4000) {
        const T = w5.map(x => (x[0] - now) / 1000), mt = T.reduce((a, b) => a + b, 0) / T.length;
        const q = lsq(w5.map((x, i) => [(T[i] - mt) ** 2, x[2]])); // dB ≈ a + b·(t − mid)²
        const pp = lsq(w5.map((x, i) => [T[i], x[1]]));
        // …or the pitch is falling right after the drone got clearly louder (it is passing us now)
        const ago = w5.filter(x => now - x[0] > 3500).map(x => x[2]), rec = last(1000).map(x => x[2]);
        const rose = ago.length > 3 && median(rec) - median(ago) > 3;
        flyby = (q.b < -0.6 || rose) && pp.b < -FLIGHT.climbPct * 0.7;
      }
      const steady = Math.abs(p.b) < FLIGHT.steadyPct;
      if (steady && p.sd < 0.5 && !this.base && now - H[0][0] > 2500) this.base = { f: fs, e: median(w.map(x => x[2])) };
      let st;
      if (p.sd > FLIGHT.swingPct) st = 'Maneuvering';
      else if (flyby) st = 'Passing by (Doppler)';
      else if (p.b > FLIGHT.climbPct) st = 'Climbing';
      else if (p.b < -FLIGHT.climbPct) st = 'Descending';
      else if (steady && this.base && (fs / this.base.f - 1) * 100 > FLIGHT.heavyPct && Math.abs(median(w.map(x => x[2])) - this.base.e) < FLIGHT.heavyDb) st = 'Heavy / loaded';
      else if (steady) st = 'Hovering';
      else st = this.state || 'Hovering';
      // a new state must hold for 0.7 s before it is shown
      if (st !== this.cand) { this.cand = st; this.candT = now; }
      if (st !== this.state && (now - this.candT > 700 || !this.state)) this.state = st;
      out.state = this.state;
      return out;
    }
  }

  class RotorDetector {
    constructor(analyser) {
      this.an = analyser;
      this.binHz = analyser.context.sampleRate / analyser.fftSize;
      this.bins = Math.min(analyser.frequencyBinCount, Math.ceil(FMAX / this.binHz) + 2);
      this.db = new Float32Array(analyser.frequencyBinCount);
      this.fl = new Float32Array(analyser.frequencyBinCount);
      this.pre = new Float64Array(this.bins + 1);
      this.hist = []; this.eh = []; this.fp = []; this.onset = 0; this.probs = null; this.lprobs = null; this.cap = null; this.conf = 0; this.state = 'quiet'; this.since = 0;
      this.learned = []; this.useLearned = true; // taught samples: [{tag, x}]
      this.flight = new FlightTracker();
      this.out = { conf: 0, state: 'quiet', f0: 0, hits: 0, e: -120, level: -120, cls: null, feat: null };
    }
    // Local noise floor: mean dB of neighbouring bins (centre excluded), via prefix sums.
    floor() {
      const n = this.bins, Wd = 24, pre = this.pre, db = this.db;
      for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + db[i];
      for (let i = 0; i < n; i++) {
        const a = Math.max(0, i - Wd), b = Math.min(n, i + Wd + 1), c0 = Math.max(0, i - 2), c1 = Math.min(n, i + 3);
        this.fl[i] = (pre[b] - pre[a] - (pre[c1] - pre[c0])) / ((b - a) - (c1 - c0));
      }
    }
    tolBins(f) { return Math.max(1, Math.round(f * 0.025 / this.binHz)); }
    excessAt(f) { // best peak height above floor within ±2.5% of f
      const tol = this.tolBins(f), c = Math.round(f / this.binHz); let best = 0;
      for (let i = c - tol; i <= c + tol; i++) {
        if (i < 1 || i >= this.bins) continue;
        const e = this.db[i] - this.fl[i]; if (e > best) best = e;
      }
      return Math.min(best, 30);
    }
    score(f0) {
      let s = 0, hits = 0, low = 0, e1 = 0;
      for (let h = 1; h <= NH; h++) {
        const f = f0 * h; if (f > FMAX) break;
        const e = this.excessAt(f); s += e;
        if (e > HIT_DB) { hits++; if (h <= 4) low++; }
        if (h === 1) e1 = e;
      }
      s /= NH;
      // a real rotor comb has its fundamental and most low harmonics present
      if (e1 < HIT_DB) { s *= 0.3; hits = Math.min(hits, 2); }
      else if (low < 3) { s *= 0.5; hits = Math.min(hits, 3); }
      return { s, hits };
    }
    sumPow(f, tolScale) {
      const tol = Math.max(1, Math.round(this.tolBins(f) * (tolScale || 1))), c = Math.round(f / this.binHz); let p = 0;
      for (let i = c - tol; i <= c + tol; i++) if (i >= 1 && i < this.bins) p += Math.pow(10, this.db[i] / 10);
      return p;
    }
    // Harmonic band energy (dB): power around each harmonic minus power half-way between harmonics.
    bandEnergy(f0) {
      let ps = 0, pn = 0;
      for (let h = 1; h <= NH; h++) { const f = f0 * h; if (f + f0 / 2 > FMAX) break; ps += this.sumPow(f); pn += this.sumPow(f + f0 / 2); }
      return 10 * Math.log10(Math.max(ps - pn, ps * 1e-3) + 1e-14);
    }
    // ~0.6 s power average: rotors beat against each other, so single frames jump by several dB.
    avgEnergy(eDb) {
      this.eh.push(Math.pow(10, eDb / 10)); if (this.eh.length > 12) this.eh.shift();
      return 10 * Math.log10(this.eh.reduce((a, b) => a + b, 0) / this.eh.length);
    }

    // ---- per-frame fingerprint measurements around a comb at f0 ----
    frameFeatures(f0) {
      const db = this.db, fl = this.fl, bh = this.binHz;
      let fw = 0, fs = 0, split = 0, ns = 0, sub = 0, nsub = 0, low = 0, hp = 0, hc = 0;
      for (let h = 1; h <= NH; h++) {
        const f = f0 * h; if (f > FMAX - f0) break;
        const tol = this.tolBins(f), c = Math.round(f / bh);
        let bi = -1, bv = -1e9;
        for (let i = c - tol; i <= c + tol; i++) if (i > 1 && i < this.bins - 1 && db[i] > bv) { bv = db[i]; bi = i; }
        if (bi < 0) continue;
        const ex = bv - fl[bi];
        if (ex > HIT_DB) { // parabolic peak interpolation → precise pitch from every harmonic
          const a = db[bi - 1], b = db[bi], cc = db[bi + 1], d = a - 2 * b + cc;
          const off = d < 0 ? clamp(0.5 * (a - cc) / d, -0.5, 0.5) : 0;
          const w = ex * h; fs += w * (bi + off) * bh / h; fw += w;
        }
        if (h >= 3 && h <= 8 && ex > HIT_DB) { // count separate peaks (one per rotor) near this harmonic
          const t2 = Math.max(2, Math.round(f * 0.04 / bh)); let pk = 0;
          for (let i = c - t2; i <= c + t2; i++) if (i > 1 && i < this.bins - 1 && db[i] > db[i - 1] && db[i] >= db[i + 1] && db[i] > bv - 12 && db[i] - fl[i] > 6) pk++;
          split += pk; ns++;
        }
        if (h <= 4) { sub += Math.max(0, this.excessAt(f - f0 / 2)); nsub++; }
        const p = this.sumPow(f); if (h <= 3) low += p; hp += p * h; hc += p;
      }
      return { f: fw ? fs / fw : f0, split: ns ? split / ns : 1, sub: nsub ? sub / nsub : 0, low, cent: hc ? hp / hc : 1 };
    }
    // Six-number fingerprint from a run of comb frames (all at roughly the same pitch).
    aggregate(fp) {
      if (fp.length < 20) return null;
      const fs = fp.map(x => x.f), f0 = median(fs);
      const jit = median(fp.slice(1).map((x, i) => Math.abs(x.f - fp[i].f) / f0));
      // linear drift (relative per second): slow Doppler glide of a passing single prop
      const tm = fp.reduce((a, x) => a + x.t, 0) / fp.length, fm = fs.reduce((a, b) => a + b, 0) / fs.length;
      let sxy = 0, sxx = 0; fp.forEach(x => { sxy += (x.t - tm) * (x.f - fm); sxx += (x.t - tm) ** 2; });
      const drift = Math.abs(sxx ? sxy / sxx * 1000 / f0 : 0);
      const lows = fp.map(x => x.low), lm = lows.reduce((a, b) => a + b, 0) / lows.length;
      const am = Math.sqrt(lows.reduce((a, b) => a + (b - lm) ** 2, 0) / lows.length) / (lm || 1);
      const split = fp.reduce((a, x) => a + x.split, 0) / fp.length;
      const sub = fp.reduce((a, x) => a + x.sub, 0) / fp.length;
      const cent = fp.reduce((a, x) => a + x.cent, 0) / fp.length;
      const mainsErr = Math.min(...[50, 60].map(m => Math.abs(f0 - m * Math.round(f0 / m))));
      const steadyRaw = Math.max(jit, drift * 0.3); // a slow glide counts as unsteady too
      const x = [
        clamp(Math.log2(f0 / 200), -1.5, 1.8),
        clamp((split - 1) / 1.0, 0, 1.5),
        clamp(am / 0.35, 0, 1.5),
        clamp(-Math.log10(steadyRaw + 1e-5) - 2.3, 0, 2),
        clamp(sub / 10, 0, 1.5),
        mainsErr < 0.6 && steadyRaw < 0.002 ? 1 : 0
      ].map(v => +v.toFixed(3));
      return { x, raw: { f0, jit, drift, am, split, sub, cent, mainsErr } };
    }
    // Soft nearest-centroid over the hand-set profiles plus (optionally) the user's taught samples.
    // Each taught tag contributes a narrow kernel around its nearest sample, weighted LEARN_W, so a close
    // real recording outranks a generic profile but has little pull on sounds that differ from it.
    match(x) {
      const dist = c => c.reduce((a, v, i) => a + W[i] * (x[i] - v) ** 2, 0);
      const hand = CLASSES.map(k => ({ group: k.label, s: Math.exp(-dist(k.c) / T), why: k.why, id: k.id, d: dist(k.c), learned: false }));
      const near = {};
      if (this.useLearned) this.learned.forEach(smp => {
        const d = dist(smp.x); if (!near[smp.tag] || d < near[smp.tag].d) near[smp.tag] = { d, smp };
      });
      const learned = Object.keys(near).map(tag => { const tg = TAGS.find(t => t.id === tag);
        return { group: tg.group, s: LEARN_W * Math.exp(-near[tag].d / LEARN_T), why: tg.label + ' (your samples)', id: tag, d: near[tag].d, learned: true }; });
      const all = hand.concat(learned), tot = all.reduce((a, k) => a + k.s, 0) || 1;
      const p = GROUPS.map(gn => all.reduce((a, k) => a + (k.group === gn ? k.s / tot : 0), 0));
      const lp = GROUPS.map(gn => learned.reduce((a, k) => a + (k.group === gn ? k.s / tot : 0), 0));
      return { p, lp, all, hand };
    }
    classify(now, f0Med) {
      // skip the first 0.4 s after the sound appears: the onset ramp would read as amplitude modulation
      const ag = this.aggregate(this.fp.filter(x => x.t > this.onset + 400 && Math.abs(x.f - f0Med) / f0Med < 0.05));
      if (!ag) return null;
      const m = this.match(ag.x);
      this.probs = this.probs ? this.probs.map((v, i) => v + 0.15 * (m.p[i] - v)) : m.p;
      this.lprobs = this.lprobs ? this.lprobs.map((v, i) => v + 0.15 * (m.lp[i] - v)) : m.lp;
      const bi = this.probs.indexOf(Math.max(...this.probs)), gn = GROUPS[bi];
      const inGroup = m.all.filter(k => k.group === gn).sort((a, b) => b.s - a.s)[0];
      const nearest = m.hand.slice().sort((a, b) => a.d - b.d)[0];
      return { label: gn, drone: bi < 3, conf: Math.round(100 * this.probs[bi]),
        learned: this.lprobs[bi] > this.probs[bi] / 2, // most of the winning class came from taught samples
        why: bi === 3 ? (inGroup.why || 'not a rotor signature') : '',
        x: ag.x, raw: ag.raw, probs: this.probs.slice(), nearest: nearest.id };
    }
    // Teach mode: collect comb frames for a clip, then return its fingerprint (or null if no steady hum).
    startCapture() { this.cap = []; }
    stopCapture() {
      const cap = this.cap || []; this.cap = null;
      if (cap.length < 20) return null;
      const fm = median(cap.map(x => x.f));
      return this.aggregate(cap.filter(x => Math.abs(x.f - fm) / fm < 0.05));
    }

    step(now) {
      const db = this.db, n = this.bins;
      this.an.getFloatFrequencyData(db);
      let tot = 0;
      for (let i = 0; i < n; i++) { if (!isFinite(db[i])) db[i] = -160; tot += Math.pow(10, db[i] / 10); }
      const level = 10 * Math.log10(tot + 1e-20);
      this.floor();
      let best = { f0: 0, s: 0, hits: 0 }; const cand = [];
      for (let f0 = F0_MIN; f0 <= F0_MAX; f0 += 1) {
        const r = this.score(f0); cand.push(f0, r.s, r.hits);
        if (r.s > best.s) best = { f0, s: r.s, hits: r.hits };
      }
      // octave guard: prefer the lowest candidate scoring close to the best
      for (let k = 0; k < cand.length; k += 3) {
        if (cand[k + 1] >= best.s * 0.85 && cand[k + 2] >= best.hits - 1) { best = { f0: cand[k], s: cand[k + 1], hits: cand[k + 2] }; break; }
      }
      const audible = level > -75, hist = this.hist;
      hist.push({ t: now, f0: best.f0, s: audible ? best.s : 0, hits: audible ? best.hits : 0 });
      while (hist.length && now - hist[0].t > HIST_MS) hist.shift();
      // stability: fraction of recent frames that agree on the same pitch and are harmonic-rich
      const good = hist.filter(h => h.hits >= 3);
      let stab = 0, f0Med = 0, sMean = 0, hMean = 0;
      if (good.length >= 3) {
        f0Med = median(good.map(h => h.f0));
        const agree = good.filter(h => Math.abs(h.f0 - f0Med) / f0Med < 0.04);
        stab = agree.length / hist.length;
        sMean = agree.reduce((a, h) => a + h.s, 0) / Math.max(1, agree.length);
        hMean = agree.reduce((a, h) => a + h.hits, 0) / Math.max(1, agree.length);
      }
      const harmonicity = clamp((sMean - 5) / 8, 0, 1) * clamp((hMean - 2) / 4, 0, 1);
      const stability = clamp((stab - 0.3) / 0.45, 0, 1);
      const raw = 100 * harmonicity * stability;
      this.conf += (raw > this.conf ? 0.08 : 0.05) * (raw - this.conf);
      // hysteresis + minimum dwell to stop flicker
      const c = this.conf, dwell = now - this.since; let st = this.state;
      if (st === 'quiet') { if (c > 60) st = 'drone'; else if (c > 30) st = 'some'; }
      else if (st === 'some') { if (c > 60) st = 'drone'; else if (c < 18 && dwell > 1000) st = 'quiet'; }
      else if (st === 'drone') { if (c < 42 && dwell > 1500) st = c < 18 ? 'quiet' : 'some'; }
      if (st !== this.state) { this.state = st; this.since = now; }
      const f0 = stab > 0.3 ? f0Med : 0;

      // fingerprint: collect features while a comb is present, classify over ~2 s
      if (audible && best.hits >= 3) {
        if (!this.fp.length) this.onset = now;
        const fr = Object.assign({ t: now }, this.frameFeatures(best.f0));
        this.fp.push(fr); if (this.cap) this.cap.push(fr); this.lastF = fr.f;
      } else this.lastF = 0;
      while (this.fp.length && now - this.fp[0].t > FP_MS) this.fp.shift();
      let cls = null;
      if (f0 && st !== 'quiet') cls = this.classify(now, f0Med);
      else if (st === 'quiet') this.probs = this.lprobs = null;
      // DRONE NEARBY needs a drone fingerprint; a "not a drone" fingerprint turns it into NOT A DRONE (hum)
      const shown = st === 'quiet' ? 'quiet' : !cls ? (st === 'drone' ? 'some' : st) : cls.drone ? st : 'hum';
      Object.assign(this.out, { conf: Math.round(c), state: shown, f0, hits: Math.round(hMean), level: Math.round(level),
        e: f0 ? +this.avgEnergy(this.bandEnergy(f0)).toFixed(1) : (this.eh.length = 0, -120),
        cls, feat: cls ? cls.x : null });
      const fOk = f0 && this.lastF && Math.abs(this.lastF - f0Med) / f0Med < 0.04;
      this.out.flight = this.flight.update(now, fOk ? this.lastF : 0, this.out.e, shown === 'drone' || (shown === 'some' && this.flight.state !== ''));
      return this.out;
    }
  }

  // Synthetic quadcopter (Rotor Ear's Test sound): 4 slightly detuned rotors, wobble. Returns its output GainNode.
  function syntheticDrone(ctx, base) {
    const out = ctx.createGain(), nodes = [];
    const N = 24, re = new Float32Array(N + 1), im = new Float32Array(N + 1);
    for (let h = 1; h <= N; h++) im[h] = Math.pow(h, -0.9) * (h % 2 ? 1 : 0.8);
    const wave = ctx.createPeriodicWave(re, im);
    [0, 0.012, -0.009, 0.021].forEach((d, i) => {
      const o = ctx.createOscillator(); o.setPeriodicWave(wave); o.frequency.value = base * (1 + d);
      const lfo = ctx.createOscillator(); lfo.frequency.value = 0.3 + i * 0.17;
      const lg = ctx.createGain(); lg.gain.value = base * 0.006; lfo.connect(lg); lg.connect(o.frequency);
      const gg = ctx.createGain(); gg.gain.value = 0.09; o.connect(gg); gg.connect(out);
      o.start(); lfo.start(); nodes.push(o, lfo);
    });
    out.stop = () => { nodes.forEach(n => { try { n.stop(); } catch (e) {} }); out.disconnect(); };
    return out;
  }
  // Ambient noise bed (independent per call), so a far-away virtual drone fades into the background.
  function ambientNoise(ctx, level) {
    const b = ctx.createBuffer(1, ctx.sampleRate * 3, ctx.sampleRate), d = b.getChannelData(0);
    let y = 0; for (let i = 0; i < d.length; i++) { y = 0.9 * y + 0.1 * (Math.random() * 2 - 1); d[i] = y * 3 + (Math.random() * 2 - 1) * 0.3; }
    const s = ctx.createBufferSource(); s.buffer = b; s.loop = true;
    const gn = ctx.createGain(); gn.gain.value = level; s.connect(gn); s.start(0, Math.random() * 2.5);
    gn.stop = () => { try { s.stop(); } catch (e) {} gn.disconnect(); };
    return gn;
  }

  g.RotorEar = { RotorDetector, FlightTracker, FLIGHT, makeAnalyser, syntheticDrone, ambientNoise, NH, FEATS, CLASSES, GROUPS, TAGS };
})(window);
