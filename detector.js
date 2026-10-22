// RotorDetector: the shared Rotor Ear detector + sound fingerprint classifier.
// Used by the watch post (index.html + watch.js) and by Phone Mesh Radar (mesh/), together with the shared
// watch-post state machine (WatchState) and its wording (likelihood, STATES).
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
    { id: 'voice', label: 'Voice', group: 'Not a drone' }, { id: 'notdrone', label: 'Not a drone', group: 'Not a drone' }, { id: 'other', label: 'Other', group: 'Not a drone' }
  ];

  // ---- "why (not) a drone": plain words from the six fingerprint numbers and the class match ----
  // RANGE: where real drones sit on each feature (the drone profiles ± a margin), drawn as the shaded band behind each bar.
  // Everything here is a function of numbers only, so a screen can rebuild an ear's reason from what the ear sends.
  const RANGE = [
    { k: 'pitch', name: 'Pitch', lo: -0.9, hi: 1.6, min: -1.5, max: 1.8, show: v => Math.round(200 * Math.pow(2, v)) + ' Hz' },
    { k: 'split', name: 'Rotors (split peaks)', lo: 0, hi: 1.5, min: 0, max: 1.5, show: v => v < 0.25 ? 'one' : v < 0.9 ? 'a few' : 'many' },
    { k: 'beat', name: 'Beat (rotors drifting)', lo: 0.1, hi: 1.5, min: 0, max: 1.5, show: v => v < 0.1 ? 'none' : v < 0.6 ? 'some' : 'strong' },
    { k: 'steady', name: 'Pitch steadiness', lo: 0, hi: 1.1, min: 0, max: 2, show: v => v > 1.1 ? 'locked' : v > 0.4 ? 'smooth' : 'wobbly' },
    { k: 'sub', name: 'Energy between harmonics', lo: 0, hi: 0.5, min: 0, max: 1.5, show: v => v > 0.5 ? 'high' : 'low' },
    { k: 'mains', name: 'Locked to 50/60 Hz', lo: 0, hi: 0.5, min: 0, max: 1, show: v => v >= 0.5 ? 'yes' : 'no' },
  ];
  const bar = (r, v) => ({ k: r.k, name: r.name, v, at: clamp((v - r.min) / (r.max - r.min), 0, 1), lo: (r.lo - r.min) / (r.max - r.min), hi: (r.hi - r.min) / (r.max - r.min), in: v >= r.lo && v <= r.hi, show: r.show(v) });
  // c: a classification ({ label, drone, learned, x: six features, raw: { f0 } }) → { id, text, bars, drone }
  function explain(c) {
    const x = c.x, [pitch, split, beat, steady, sub, mains] = x, f0 = c.raw && c.raw.f0 || 200 * Math.pow(2, pitch);
    const bars = RANGE.map((r, i) => bar(r, x[i])), off = bars.filter(b => !b.in).map(b => b.name.toLowerCase().replace(/ \(.*\)/, ''));
    const fb = sub >= 0.6 ? f0 / 2 : f0, hz = Math.abs(fb - 50 * Math.round(fb / 50)) <= Math.abs(fb - 60 * Math.round(fb / 60)) ? 50 : 60; // energy between harmonics: the true pitch is half
    let id, text;
    if (c.drone) {
      if (c.label === 'Fixed-wing') { id = 'fixed'; text = 'One propeller: a low, smooth pitch with little beat, like a fixed-wing'; }
      else if (c.label === 'Micro drone') { id = 'micro'; text = 'High, whiny pitch from small rotors with fast-fading harmonics, like a micro drone'; }
      else { id = 'quad'; text = 'Several rotors at slightly different speeds (split peaks) beating against each other, like a multirotor'; }
      if (c.learned) text = 'Close to your taught samples. ' + text;
    } else if (c.learned) { id = 'taught'; text = 'Close to sounds you taught as not a drone' + (off.length ? ' (' + off.join(', ') + ' outside the drone range)' : ''); }
    else if (mains >= 0.5 || (steady >= 0.6 && sub >= 0.6)) { id = 'mains'; text = `Pitch too steady and locked to ${hz} Hz mains, like a transformer or mains hum`; }
    else if (sub >= 0.6) { id = 'engine'; text = 'Energy between the harmonics: the real firing rate is lower and irregular, like an engine'; }
    else if (steady > 1.1) { id = 'fan'; text = 'Pitch too steady: one motor at a fixed speed' + (beat < 0.1 ? ' with no rotor beat' : '') + ', looks like a fan / AC'; }
    else { id = 'notdrone'; text = 'Does not match a rotor profile' + (off.length ? ': ' + off.join(', ') + ' outside the drone range' : ''); }
    return { id, text, bars, drone: !!c.drone };
  }
  // n: a sound() summary (no fingerprint formed: no steady comb for 2 s) → { id, text, bars } or null when nothing was heard
  const SND = [
    { k: 'comb', name: 'Harmonic comb present', lo: 0.8, hi: 1, min: 0, max: 1, show: v => Math.round(v * 100) + '%' },
    { k: 'jump', name: 'Pitch jumps frame to frame', lo: 0, hi: 0.4, min: 0, max: 3, show: v => v.toFixed(1) + '%' },
    { k: 'spread', name: 'Pitch range', lo: 0, hi: 6, min: 0, max: 60, show: v => Math.round(v) + '%' },
  ];
  function soundWhy(n) {
    if (!n) return null;
    let id, text;
    if (n.mx >= 40 && n.comb < 0.2) { id = 'tone'; text = 'A single pure tone with no harmonic series, like a beep, whistle or alarm'; }
    else if (n.comb >= 0.15 && n.spread > 15) { id = 'voice'; text = 'Harmonics come and go and the pitch jumps around, more like a voice or bird'; }
    else if (n.lo >= 15 || (n.comb >= 0.4 && n.comb < 0.9 && n.jump > 0.5)) { // (a steady comb, ≥ 0.9, is a rotor still forming its fingerprint)
      id = 'engine'; const fire = n.lo >= 15 ? ` (firing ~${n.lf} Hz, below the rotor range)` : '';
      text = n.comb >= 0.3 && n.jump > 0.5 ? 'Pitch sweeping up and down like a motorbike engine' + fire : 'Low, irregular firing like an engine or generator' + fire; }
    else if (n.comb >= 0.8) { id = 'forming'; text = 'A steady harmonic comb: checking its fingerprint'; }
    else if (n.pk <= 1 && n.mx < 15) { id = 'noise'; text = 'No harmonics, just broadband noise, like wind, rain or traffic'; }
    else { id = 'weak'; text = 'Harmonics too weak or too brief to fingerprint'; }
    return { id, text, bars: SND.map(r => bar(r, n[r.k])), drone: false };
  }

  // the same reason rebuilt from what an ear sends (telemetry numbers: cl, lr, fr, fx = the six features, sn = sound summary)
  const whyFrom = n => n.fx ? explain({ label: n.cl, drone: !!n.cl && n.cl !== GROUPS[3], learned: n.lr, x: n.fx, raw: { f0: n.fr } })
    : n.sn ? soundWhy({ comb: n.sn[0], jump: n.sn[1], spread: n.sn[2], mx: n.sn[3], lo: n.sn[4], lf: n.sn[5], pk: n.sn[6] }) : null;

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
      if (!this.spark.length || now - this.spark[this.spark.length - 1][0] >= 250) { this.spark.push([now, fs]); if (this.spark.length > 120) this.spark.shift(); }
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

  // Hearing radius from this phone's noise floor in the drone band (inverse square, free field, no wind).
  // Assumption: a reference small quadcopter whose strongest rotor harmonics are ~75 dB SPL at 1 m, heard by a typical
  // phone mic (−26 dBFS at 94 dB SPL, so −45 dBFS), reads COVER.refDb in this analyser's per-bin dB at 1 m (a full-scale
  // sine reads about −20 dB here, measured). The detector needs those harmonics COVER.needDb above the local floor
  // (HIT_DB + 3 dB margin), and the level falls 6 dB per doubling of distance (20·log10 r).
  const COVER = { refDb: -65, needDb: 12, minM: 2, maxM: 300, f0: 150, f1: 2000, text: 'Assumes a small quadcopter (~75 dB at 1 m), open ground, no wind: sound falls 6 dB per doubling of distance and must stay 12 dB above this phone\'s background noise. Real range varies a lot.' };
  const hearingRadius = floorDb => clamp(Math.pow(10, (COVER.refDb - floorDb - COVER.needDb) / 20), COVER.minM, COVER.maxM);

  // One sound the detector follows: its own pitch history, confidence, state, fingerprint and flight state.
  // The detector runs two of these, so two drones at once (two harmonic combs with distinct pitches) stay apart.
  class Source {
    constructor(det, id) {
      Object.assign(this, { det, id, hist: [], eh: [], fp: [], onset: 0, probs: null, lprobs: null, conf: 0, state: 'quiet', since: 0, seen: 0, lastF: 0, ref: 0 });
      this.flight = new FlightTracker(); this.flight.blades = det.blades;
      this.out = { id, conf: 0, state: 'quiet', f0: 0, hits: 0, e: -120, level: -120, cls: null, feat: null, flight: null };
    }
    idle(now) { return this.state === 'quiet' && now - this.seen > HIST_MS; }
    // ~0.6 s power average: rotors beat against each other, so single frames jump by several dB.
    avgEnergy(eDb) {
      this.eh.push(Math.pow(10, eDb / 10)); if (this.eh.length > 12) this.eh.shift();
      return 10 * Math.log10(this.eh.reduce((a, b) => a + b, 0) / this.eh.length);
    }
    classify(f0Med) {
      // skip the first 0.4 s after the sound appears: the onset ramp would read as amplitude modulation
      const det = this.det, ag = det.aggregate(this.fp.filter(x => x.t > this.onset + 400 && Math.abs(x.f - f0Med) / f0Med < 0.05));
      if (!ag) return null;
      const m = det.match(ag.x);
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
    // c: this frame's comb for this source ({ f0, s, hits, fr: frame features }) or null
    step(now, c, audible, level) {
      const det = this.det, hist = this.hist;
      hist.push(c && audible ? { t: now, f0: c.f0, s: c.s, hits: c.hits } : { t: now, f0: 0, s: 0, hits: 0 });
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
      this.ref = f0Med || (c ? c.f0 : this.ref);
      const harmonicity = clamp((sMean - 5) / 8, 0, 1) * clamp((hMean - 2) / 4, 0, 1);
      const stability = clamp((stab - 0.3) / 0.45, 0, 1);
      const raw = 100 * harmonicity * stability;
      this.conf += (raw > this.conf ? 0.08 : 0.05) * (raw - this.conf);
      // hysteresis + minimum dwell to stop flicker
      const cf = this.conf, dwell = now - this.since; let st = this.state;
      if (st === 'quiet') { if (cf > 60) st = 'drone'; else if (cf > 30) st = 'some'; }
      else if (st === 'some') { if (cf > 60) st = 'drone'; else if (cf < 18 && dwell > 1000) st = 'quiet'; }
      else if (st === 'drone') { if (cf < 42 && dwell > 1500) st = cf < 18 ? 'quiet' : 'some'; }
      if (st !== this.state) { this.state = st; this.since = now; }
      const f0 = stab > 0.3 ? f0Med : 0;
      // fingerprint: collect features while this comb is present, classify over ~2 s
      if (c && audible) { if (!this.fp.length) this.onset = now; this.fp.push(Object.assign({ t: now }, c.fr)); this.lastF = c.fr.f; this.seen = now; } else this.lastF = 0;
      while (this.fp.length && now - this.fp[0].t > FP_MS) this.fp.shift();
      let cls = null;
      if (f0 && st !== 'quiet') cls = this.classify(f0Med);
      else if (st === 'quiet') this.probs = this.lprobs = null;
      // DRONE NEARBY needs a drone fingerprint; a "not a drone" fingerprint turns it into NOT A DRONE (hum)
      const shown = st === 'quiet' ? 'quiet' : !cls ? (st === 'drone' ? 'some' : st) : cls.drone ? st : 'hum';
      Object.assign(this.out, { conf: Math.round(cf), state: shown, f0, hits: Math.round(hMean), level: Math.round(level),
        e: f0 ? +this.avgEnergy(det.bandEnergy(f0)).toFixed(1) : (this.eh.length = 0, -120),
        cls, feat: cls ? cls.x : null });
      const fOk = f0 && this.lastF && Math.abs(this.lastF - f0Med) / f0Med < 0.04;
      this.out.flight = this.flight.update(now, fOk ? this.lastF : 0, this.out.e, shown === 'drone' || (shown === 'some' && this.flight.state !== ''));
    }
  }
  const RANK = { quiet: 0, hum: 1, some: 2, drone: 3 };

  class RotorDetector {
    constructor(analyser) {
      this.an = analyser;
      this.binHz = analyser.context.sampleRate / analyser.fftSize;
      this.bins = Math.min(analyser.frequencyBinCount, Math.ceil(FMAX / this.binHz) + 2);
      this.db = new Float32Array(analyser.frequencyBinCount);
      this.fl = new Float32Array(analyser.frequencyBinCount);
      this.db0 = this.db; this.fl0 = this.fl; this.dbm = new Float32Array(analyser.frequencyBinCount); this.flm = new Float32Array(analyser.frequencyBinCount); // + with the strongest comb masked out
      this.pre = new Float64Array(this.bins + 1);
      this.cap = null; this.nid = 0; this.b = 2; this.nfh = []; this.noise = null;
      this.learned = []; this.useLearned = true; // taught samples: [{tag, x}]
      this.src = [new Source(this, 0), new Source(this, 0)]; this.li = 0;
      this.out = this.src[0].out; this.outs = [];
    }
    get blades() { return this.b; }
    set blades(v) { this.b = v; this.src.forEach(s => s.flight.blades = v); }
    get flight() { return this.src[this.li].flight; }
    forget() { this.src.forEach(s => s.probs = s.lprobs = null); } // taught samples changed: re-learn class shares
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
      return { s, hits, low };
    }
    // the best harmonic comb in the current spectrum (octave guard: prefer the lowest candidate scoring close to the best)
    scan(away) { // the best comb; away: a second comb, so skip pitches within 8% of the first (what is left of it after masking)
      let best = { f0: 0, s: 0, hits: 0, low: 0 }; const cand = [];
      for (let f0 = F0_MIN; f0 <= F0_MAX; f0 += 1) {
        if (away && Math.abs(f0 - away) / away < 0.08) continue;
        const r = this.score(f0); cand.push(f0, r.s, r.hits, r.low);
        if (r.s > best.s) best = { f0, s: r.s, hits: r.hits, low: r.low };
      }
      // (a second comb only looks at true sub-octaves, best/2 and best/3: anything lower would be leftovers of the first)
      const sub = f => !away || [2, 3].some(k => Math.abs(f * k - best.f0) / best.f0 < 0.03);
      for (let k = 0; k < cand.length; k += 4) {
        if (cand[k + 1] >= best.s * 0.85 && cand[k + 2] >= best.hits - 1 && sub(cand[k])) { best = { f0: cand[k], s: cand[k + 1], hits: cand[k + 2], low: cand[k + 3] }; break; }
      }
      return best;
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
    // Teach mode: collect comb frames for a clip, then return its fingerprint (or null if no steady hum).
    startCapture() { this.cap = []; }
    stopCapture() {
      const cap = this.cap || []; this.cap = null;
      if (cap.length < 20) return null;
      const fm = median(cap.map(x => x.f));
      return this.aggregate(cap.filter(x => Math.abs(x.f - fm) / fm < 0.05));
    }

    // Swap in the spectrum with the strongest comb's harmonics flattened to the floor, so a second comb can be scored on its own.
    // the spectrum with the strongest comb's harmonics flattened onto the floor (this.dbm / this.flm), so a second comb can be scored on its own
    mask(f0) {
      const db = this.dbm, hit = []; db.set(this.db);
      for (let h = 1; f0 * h < FMAX; h++) { const tol = Math.round(f0 * h * 0.045 / this.binHz) + 1, c = Math.round(f0 * h / this.binHz); // ±4.5% + 1 bin: all rotors of one drone + window leakage
        for (let i = Math.max(0, c - tol); i <= c + tol && i < this.bins; i++) { db[i] = Math.min(db[i], this.fl[i]); hit.push(i); } }
      const keep = [this.db, this.fl]; this.db = db; this.fl = this.flm; this.floor(); // the floor without that comb is lower, so flatten the masked bins onto it too
      hit.forEach(i => { db[i] = Math.min(db[i], this.fl[i]); }); [this.db, this.fl] = keep;
    }
    use(masked) { if (masked) { this.db = this.dbm; this.fl = this.flm; } else { this.db = this.db0; this.fl = this.fl0; } }
    step(now) {
      const db = this.db, n = this.bins;
      this.an.getFloatFrequencyData(db);
      let tot = 0;
      for (let i = 0; i < n; i++) { if (!isFinite(db[i])) db[i] = -160; tot += Math.pow(10, db[i] / 10); }
      const level = 10 * Math.log10(tot + 1e-20), audible = level > -75;
      this.floor(); this.measureNoise(now);
      // up to two combs: the strongest, then the strongest one left once its harmonics are masked: pitch > 8% apart and its own
      // fundamental + low harmonics (so the odd partials of one hum, e.g. 150 Hz left over from 50 Hz mains, are not a second sound)
      const c1 = this.scan(), cs = [];
      if (audible && c1.hits >= 3) { c1.fr = this.frameFeatures(c1.f0); cs.push(c1); if (this.cap) this.cap.push(Object.assign({ t: now }, c1.fr)); }
      this.hear(now, c1, audible);
      if (cs.length) {
        this.mask(c1.fr.f); this.use(true); const c2 = this.scan(c1.fr.f); this.use(false);
        if (c2.hits >= 3 && c2.low >= 3) {
          // its pitch comes from the real spectrum (±5%), like the strongest comb's, so a drone reads the same pitch whichever comb it is
          for (let f = Math.round(c2.f0 * 0.95), b = -1; f <= c2.f0 * 1.05; f++) { if (Math.abs(f - c1.fr.f) / c1.fr.f < 0.08) continue; const r = this.score(f); if (r.s > b) { b = r.s; c2.pf = f; } }
          c2.f0 = c2.pf; this.use(true); c2.fr = this.frameFeatures(c2.f0); c2.masked = true; this.use(false); cs.push(c2);
        }
      }
      // each comb goes to the source already following that pitch (closest first, within 12%), else to an idle source (a new id)
      const got = new Map(), pairs = [];
      cs.forEach(c => this.src.forEach((q, i) => { const d = q.ref && !q.idle(now) ? Math.abs(c.f0 - q.ref) / q.ref : 1; if (d < 0.12) pairs.push([d, c, i]); }));
      pairs.sort((x, y) => x[0] - y[0]).forEach(([, c, i]) => { if (!got.has(i) && ![...got.values()].includes(c)) got.set(i, c); });
      cs.filter(c => ![...got.values()].includes(c)).forEach(c => { const i = [0, 1].find(k => !got.has(k) && this.src[k].idle(now)); if (i != null) { this.src[i] = new Source(this, ++this.nid); got.set(i, c); } });
      // the masked spectrum serves the second comb's source; everything else reads the real one
      const isM = i => got.has(i) && got.get(i).masked;
      [0, 1].forEach(i => { this.use(isM(i)); this.src[i].step(now, got.get(i), audible, level); }); this.use(false);
      // lead = the source the single-drone UI follows; it moves only to a source in a stronger state
      const L = this.src[this.li], O = this.src[1 - this.li];
      if (RANK[O.out.state] > RANK[L.out.state] || (L.out.state === 'quiet' && O.out.state === 'quiet' && O.conf > L.conf)) this.li = 1 - this.li;
      const o = this.out = this.src[this.li].out, alt = this.src[1 - this.li].out;
      this.outs = [o, alt].filter(x => x.state !== 'quiet');
      o.alt = alt.state !== 'quiet' ? alt : null; alt.alt = null;
      o.nf = this.noise; o.hr = this.noise == null ? null : Math.round(hearingRadius(this.noise));
      // the reason in words: from the fingerprint once there is one, else from what the last ~3 s sounded like
      o.snd = this.snd = o.cls ? null : this.sound(); o.why = o.cls ? explain(o.cls) : soundWhy(this.snd); if (alt.cls) alt.why = explain(alt.cls);
      return o;
    }
    // What this phone heard over the last ~3 s, comb or not (for "why not a drone" when no fingerprint forms):
    // the best comb's pitch and harmonic count each frame, plus how many separate peaks stand out and how tall the tallest is.
    hear(now, c, audible) {
      const H = this.heard || (this.heard = []);
      if (audible) {
        let pk = 0, mx = 0; const a = Math.round(F0_MIN / this.binHz), b = Math.min(this.bins - 1, Math.round(4000 / this.binHz));
        for (let i = a; i < b; i++) { const e = this.db[i] - this.fl[i]; if (e > mx) mx = e; if (e > HIT_DB + 3 && this.db[i] > this.db[i - 1] && this.db[i] >= this.db[i + 1]) pk++; }
        let lo = 0, lf = 0; for (let i = Math.round(25 / this.binHz); i < a; i++) { const e = this.db[i] - this.fl[i]; if (e > lo) { lo = e; lf = i * this.binHz; } } // a peak below the rotor range (an engine's firing rate)
        H.push({ t: now, f: c.fr ? c.fr.f : c.f0, hits: c.hits, pk, mx, lo, lf });
      }
      while (H.length && now - H[0].t > 3000) H.shift();
    }
    // a summary of hear(): null until ~1 s of sound. comb: share of frames with a harmonic comb (3+ harmonics); jump / spread:
    // mean frame-to-frame pitch change and the 10–90 % pitch range of those frames (%); pk: separate peaks; mx: tallest peak (dB over floor)
    sound() {
      const H = this.heard || []; if (H.length < 20) return null;
      const C = H.filter(h => h.hits >= 3), lf = C.map(h => Math.log(h.f) * 100), q = a => a.slice().sort((x, y) => x - y);
      const d = lf.slice(1).map((v, i) => Math.abs(v - lf[i])), jump = C.length > 4 ? d.reduce((a, v) => a + v, 0) / d.length : 0, sl = q(lf);
      return { n: H.length, comb: +(C.length / H.length).toFixed(2), jump: +jump.toFixed(2), spread: sl.length > 4 ? +(sl[Math.floor(sl.length * 0.9)] - sl[Math.floor(sl.length * 0.1)]).toFixed(1) : 0,
        pk: median(H.map(h => h.pk)), mx: Math.round(median(H.map(h => h.mx))), lo: Math.round(median(H.map(h => h.lo))), lf: Math.round(median(H.map(h => h.lf))), hits: median(H.map(h => h.hits)), f: Math.round(median((C.length ? C : H).map(h => h.f))) };
    }
    // drone-band noise floor (dB per bin): the median local floor 150 Hz–2 kHz, then the 20th percentile over ~3 s;
    // refreshed every 2 s. Background only: frames where this phone hears no harmonic sound (a nearby drone would
    // otherwise shrink the circle it is in), unless it has heard one for 30 s straight (a fan that never stops).
    measureNoise(now) {
      if (this.src.every(q => q.state === 'quiet')) this.calm = now; else if (now - (this.calm || 0) < 30000 && this.noise != null) return;
      const a = Math.max(1, Math.round(COVER.f0 / this.binHz)), b = Math.min(this.bins - 1, Math.round(COVER.f1 / this.binHz));
      const v = Array.from(this.fl.subarray(a, b)).sort((x, y) => x - y);
      this.nfh.push([now, v[v.length >> 1]]); while (now - this.nfh[0][0] > 3000) this.nfh.shift();
      if (!this.nfAt || now - this.nfAt > 2000) { this.nfAt = now; const v = this.nfh.map(x => x[1]).sort((x, y) => x - y); this.noise = Math.round(v[Math.floor(v.length * 0.2)] * 10) / 10; }
    }
  }

  // Synthetic quadcopter (Rotor Ear's Test sound): 4 slightly detuned rotors, wobble. Returns its output GainNode.
  // ---- watch-post state machine (shared by the watch post and the mesh node page) ----
  // Ready → Watching → Checking a sound… → DRONE (held 1.5 s) or Not a drone (shown 5 s) → Watching.
  // DRONE → Got it → Tracking (silent). DRONE/Tracking → signal gone for 1 s → Drone lost → heard again within
  // 60 s: back to DRONE/Tracking with no new alert; after 60 s → Watching.  raw = 'off'|'quiet'|'some'|'drone'|'hum'
  // (the detector's or the mesh's verdict, which already has its own hysteresis). ev = 'alert' | 'lost' | 'back' | 'gone'.
  const WATCH = { hold: 1500, grace: 1000, notMs: 5000, lostMs: 60000 };
  class WatchState {
    constructor() { this.reset(); }
    reset() { this.s = 'ready'; this.since = 0; this.holdT = 0; this.holdK = 0; this.dropT = 0; this.ack = false; this.ackAt = 0; this.first = 0; this.lastSeen = 0; this.humSeen = false; this.humT = -1e9; this.ev = null; }
    update(now, raw, listening) {
      this.ev = null;
      const go = (s, ev) => { if (s !== this.s) { this.s = s; this.since = now; } if (ev) this.ev = ev; };
      if (!listening) { if (this.s !== 'ready') this.reset(); return this; }
      if (raw === 'drone') { if (!this.holdT) this.holdT = now; } else this.holdT = 0;
      this.holdK = this.holdT ? Math.min(1, (now - this.holdT) / WATCH.hold) : 0;
      const held = this.holdK >= 1;
      if (this.s === 'ready') go('watching');
      if (raw === 'hum') this.humT = now; else if (raw !== 'some') this.humSeen = false;
      const humNear = now - this.humT < 3000; // a weak 'some' right after a hum is the same ignored hum, not a new sound
      switch (this.s) {
        case 'watching':
          if (raw === 'drone' || (raw === 'some' && !humNear)) go('checking');
          else if (raw === 'hum' && !this.humSeen) { this.humSeen = true; go('notdrone'); } // a steady fan is shown once, then ignored
          break;
        case 'checking':
          if (held) { this.first = this.lastSeen = now; this.ack = false; go('drone', 'alert'); }
          else if (raw === 'hum') { this.humSeen = true; go('notdrone'); }
          else if (raw === 'quiet' || raw === 'off') go('watching');
          break;
        case 'notdrone':
          if (raw === 'drone' || (raw === 'some' && !humNear)) go('checking'); else if (now - this.since > WATCH.notMs) go('watching');
          break;
        case 'drone': case 'tracking':
          if (raw === 'drone') { this.lastSeen = now; this.dropT = 0; }
          else { if (!this.dropT) this.dropT = now; if (now - this.dropT > WATCH.grace) go('lost', 'lost'); }
          break;
        case 'lost':
          if (held) { this.lastSeen = now; go(this.ack ? 'tracking' : 'drone', 'back'); }
          else if (now - this.lastSeen > WATCH.lostMs) go('watching', 'gone');
          break;
      }
      return this;
    }
    again() { if (this.s === 'tracking') { this.s = 'drone'; this.ack = false; } } // another drone joined: alert again, un-acknowledged
    acknowledge(now) { if (this.s === 'drone') { this.ack = true; this.ackAt = now; this.s = 'tracking'; } }
    dismiss(now) { if (this.s === 'lost' || this.s === 'notdrone') { this.s = 'watching'; this.since = now; this.ack = false; this.ev = 'gone'; } }
  }
  // Wording. The match score is a softmax share against the class templates, not an accuracy, so the UI shows a
  // word; the number appears once, in Details, as "match score".
  const likelihood = score => score >= 85 ? 'very likely' : score >= 65 ? 'likely' : 'possible';
  const STATES = { ready: ['⊖', 'READY'], watching: ['○', 'WATCHING'], checking: ['◐', 'Checking a sound…'], notdrone: ['✓', 'Not a drone'],
    drone: ['▲', 'DRONE'], tracking: ['▲', 'DRONE'], lost: ['◇', 'Drone lost'] };

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
      o.start(); lfo.start(); nodes.push(o, lfo); o.f1 = base * (1 + d);
    });
    out.stop = () => { nodes.forEach(n => { try { n.stop(); } catch (e) {} }); out.disconnect(); };
    out.setPitch = (k, tc) => nodes.forEach(n => { if (n.f1) n.frequency.setTargetAtTime(n.f1 * k, ctx.currentTime, tc || 0.5); }); // throttle
    return out;
  }
  // Ambient noise bed (independent per call), so a far-away virtual drone fades into the background.
  // a fan / AC: a rock-steady 140 Hz blade-pass comb plus airflow noise (what the 'Not a drone' class expects)
  function syntheticFan(ctx) {
    const N = 10, re = new Float32Array(N + 1), im = new Float32Array(N + 1);
    for (let h = 1; h <= N; h++) im[h] = Math.pow(h, -1.3);
    const o = ctx.createOscillator(); o.setPeriodicWave(ctx.createPeriodicWave(re, im)); o.frequency.value = 140;
    const out = ctx.createGain(), og = ctx.createGain(); og.gain.value = 0.25; o.connect(og); og.connect(out); o.start();
    const nz = ambientNoise(ctx, 0.04); nz.connect(out);
    out.stop = () => { try { o.stop(); } catch (e) {} nz.stop(); out.disconnect(); };
    return out;
  }
  function ambientNoise(ctx, level) {
    const b = ctx.createBuffer(1, ctx.sampleRate * 3, ctx.sampleRate), d = b.getChannelData(0);
    let y = 0; for (let i = 0; i < d.length; i++) { y = 0.9 * y + 0.1 * (Math.random() * 2 - 1); d[i] = y * 3 + (Math.random() * 2 - 1) * 0.3; }
    const s = ctx.createBufferSource(); s.buffer = b; s.loop = true;
    const gn = ctx.createGain(); gn.gain.value = level; s.connect(gn); s.start(0, Math.random() * 2.5);
    gn.stop = () => { try { s.stop(); } catch (e) {} gn.disconnect(); };
    return gn;
  }

  g.RotorEar = { explain, soundWhy, whyFrom, RANGE, RotorDetector, COVER, hearingRadius, FlightTracker, FLIGHT, WatchState, WATCH, likelihood, STATES, makeAnalyser, syntheticDrone, syntheticFan, ambientNoise, NH, FEATS, CLASSES, GROUPS, TAGS };
})(window);
