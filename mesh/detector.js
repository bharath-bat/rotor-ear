// RotorDetector — same harmonic-comb + stability algorithm as ../app.js (Rotor Ear),
// packaged as a class so several detectors can run in one page (Mesh Radar sim).
// Passive: it only reads an AnalyserNode.
(function (g) {
  'use strict';
  const FMAX = 8000, F0_MIN = 90, F0_MAX = 600, NH = 10, HIT_DB = 9, HIST_MS = 1200;
  const clamp = (x, a, b) => x < a ? a : x > b ? b : x;

  function makeAnalyser(ctx) {
    const a = ctx.createAnalyser();
    a.fftSize = 8192; a.smoothingTimeConstant = 0.5;
    a.minDecibels = -110; a.maxDecibels = -20;
    return a;
  }

  class RotorDetector {
    constructor(analyser) {
      this.an = analyser;
      this.binHz = analyser.context.sampleRate / analyser.fftSize;
      this.bins = Math.min(analyser.frequencyBinCount, Math.ceil(FMAX / this.binHz) + 2);
      this.db = new Float32Array(analyser.frequencyBinCount);
      this.fl = new Float32Array(analyser.frequencyBinCount);
      this.pre = new Float64Array(this.bins + 1);
      this.hist = []; this.eh = []; this.conf = 0; this.state = 'quiet'; this.since = 0;
      this.out = { conf: 0, state: 'quiet', f0: 0, hits: 0, e: -120, level: -120 };
    }
    floor() {
      const n = this.bins, W = 24, pre = this.pre, db = this.db;
      for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + db[i];
      for (let i = 0; i < n; i++) {
        const a = Math.max(0, i - W), b = Math.min(n, i + W + 1), c0 = Math.max(0, i - 2), c1 = Math.min(n, i + 3);
        this.fl[i] = (pre[b] - pre[a] - (pre[c1] - pre[c0])) / ((b - a) - (c1 - c0));
      }
    }
    tolBins(f) { return Math.max(1, Math.round(f * 0.025 / this.binHz)); }
    excessAt(f) {
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
      if (e1 < HIT_DB) { s *= 0.3; hits = Math.min(hits, 2); }
      else if (low < 3) { s *= 0.5; hits = Math.min(hits, 3); }
      return { s, hits };
    }
    // Harmonic band energy (dB): power in the bins around each harmonic of f0, minus the power
    // measured half-way between harmonics (an estimate of the background in the same band).
    bandEnergy(f0) {
      let ps = 0, pn = 0;
      const sumAt = f => { const tol = this.tolBins(f), c = Math.round(f / this.binHz); let p = 0;
        for (let i = c - tol; i <= c + tol; i++) if (i >= 1 && i < this.bins) p += Math.pow(10, this.db[i] / 10); return p; };
      for (let h = 1; h <= NH; h++) { const f = f0 * h; if (f + f0 / 2 > FMAX) break; ps += sumAt(f); pn += sumAt(f + f0 / 2); }
      return 10 * Math.log10(Math.max(ps - pn, ps * 1e-3) + 1e-14);
    }
    // ~0.6 s power average: rotors beat against each other, so single frames jump by several dB.
    avgEnergy(eDb) {
      this.eh.push(Math.pow(10, eDb / 10)); if (this.eh.length > 12) this.eh.shift();
      return 10 * Math.log10(this.eh.reduce((a, b) => a + b, 0) / this.eh.length);
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
      for (let k = 0; k < cand.length; k += 3) {
        if (cand[k + 1] >= best.s * 0.85 && cand[k + 2] >= best.hits - 1) { best = { f0: cand[k], s: cand[k + 1], hits: cand[k + 2] }; break; }
      }
      const audible = level > -75, hist = this.hist;
      hist.push({ t: now, f0: best.f0, s: audible ? best.s : 0, hits: audible ? best.hits : 0 });
      while (hist.length && now - hist[0].t > HIST_MS) hist.shift();
      const good = hist.filter(h => h.hits >= 3);
      let stab = 0, f0Med = 0, sMean = 0, hMean = 0;
      if (good.length >= 3) {
        const fs = good.map(h => h.f0).sort((a, b) => a - b);
        f0Med = fs[fs.length >> 1];
        const agree = good.filter(h => Math.abs(h.f0 - f0Med) / f0Med < 0.04);
        stab = agree.length / hist.length;
        sMean = agree.reduce((a, h) => a + h.s, 0) / Math.max(1, agree.length);
        hMean = agree.reduce((a, h) => a + h.hits, 0) / Math.max(1, agree.length);
      }
      const harmonicity = clamp((sMean - 5) / 8, 0, 1) * clamp((hMean - 2) / 4, 0, 1);
      const stability = clamp((stab - 0.3) / 0.45, 0, 1);
      const raw = 100 * harmonicity * stability;
      this.conf += (raw > this.conf ? 0.08 : 0.05) * (raw - this.conf);
      const c = this.conf, dwell = now - this.since; let st = this.state;
      if (st === 'quiet') { if (c > 60) st = 'drone'; else if (c > 30) st = 'some'; }
      else if (st === 'some') { if (c > 60) st = 'drone'; else if (c < 18 && dwell > 1000) st = 'quiet'; }
      else if (st === 'drone') { if (c < 42 && dwell > 1500) st = c < 18 ? 'quiet' : 'some'; }
      if (st !== this.state) { this.state = st; this.since = now; }
      const f0 = stab > 0.3 ? f0Med : 0;
      Object.assign(this.out, { conf: Math.round(c), state: st, f0, hits: Math.round(hMean), level: Math.round(level),
        e: f0 ? +this.avgEnergy(this.bandEnergy(f0)).toFixed(1) : (this.eh.length = 0, -120) });
      return this.out;
    }
  }

  // Synthetic quadcopter (same recipe as Rotor Ear's Test sound). Returns the output GainNode.
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

  g.RotorEar = { RotorDetector, makeAnalyser, syntheticDrone, ambientNoise, NH };
})(window);
