// Rotor Ear · timing taps (AudioWorklets). Only times and levels ever leave the device, never audio.
// rotor-envelope: on a band-passed copy of what the detector hears, turns the rotor "beating" envelope into a
// 1 kHz series and reports the time of each distinct envelope peak (sub-millisecond, AudioContext seconds).
class RotorEnvelope extends AudioWorkletProcessor {
  constructor(opt) {
    super();
    const o = (opt && opt.processorOptions) || {};
    this.H = o.hold || 40; this.gap = o.gap || 60;               // peak must dominate ±H ms; ≥ gap ms apart
    this.dec = Math.max(1, Math.round(sampleRate / 1000));      // ~1 kHz envelope
    this.a = Math.exp(-1 / ((o.tau || 0.005) * sampleRate));     // one-pole envelope smoother
    this.env = 0; this.acc = 0; this.k = 0;
    this.N = 512; this.buf = new Float32Array(this.N); this.fr = new Float64Array(this.N);
    this.idx = 0; this.last = -1e9; this.mean = 0;
  }
  process(inputs) {
    const x = inputs[0] && inputs[0][0]; if (!x) return true;
    const f0 = currentFrame;
    for (let i = 0; i < x.length; i++) {
      this.env = this.a * this.env + (1 - this.a) * Math.abs(x[i]);
      this.acc += this.env;
      if (++this.k === this.dec) { this.push(this.acc / this.dec, f0 + i - this.dec / 2); this.acc = 0; this.k = 0; }
    }
    return true;
  }
  push(v, frame) {
    const N = this.N, H = this.H, K = 6; // fit the vertex over ±6 ms
    this.buf[this.idx % N] = v; this.fr[this.idx % N] = frame; this.idx++;
    this.mean += 0.002 * (v - this.mean);
    if (this.idx < 2 * H + 1) return;
    const c = this.idx - 1 - H, vc = this.buf[c % N];
    let mn = vc;
    for (let j = c - H; j <= c + H; j++) { const u = this.buf[j % N]; if (u > vc) return; if (u < mn) mn = u; }
    if (vc < mn * 1.25 || vc < 0.3 * this.mean || c - this.last < this.gap) return;
    // least-squares parabola through the top of the peak → sub-sample vertex
    let sxy = 0, sxx = 0, sqy = 0, sqq = 0; const m2 = K * (K + 1) / 3;
    for (let d = -K; d <= K; d++) { const y = this.buf[(c + d) % N]; sxy += d * y; sxx += d * d; sqy += (d * d - m2) * y; sqq += (d * d - m2) ** 2; }
    const b = sxy / sxx, a = sqy / sqq, off = a < 0 ? Math.max(-K, Math.min(K, -b / (2 * a))) : 0;
    this.last = c;
    this.port.postMessage({ t: (this.fr[c % N] + off * this.dec) / sampleRate, v: vc });
  }
}
registerProcessor('rotor-envelope', RotorEnvelope);

// Clap / click onset timer for calibration: watches the raw (un-filtered) input for a sudden broadband
// burst far above the running background, then reports when the burst *starts* (first sample above 35 %
// of its own peak, so loud and quiet phones mark the same instant) and its peak level in dBFS.
class RotorOnset extends AudioWorkletProcessor {
  constructor() {
    super();
    this.N = 16384; this.buf = new Float32Array(this.N); this.n = 0;          // ring of |x|, ~0.34 s
    this.af = Math.exp(-1 / (0.001 * sampleRate)); this.as = Math.exp(-1 / (0.3 * sampleRate));
    this.ef = 0; this.es = 1e-4; this.trig = -1; this.refr = 0;
    this.post = Math.round(0.025 * sampleRate); this.pre = Math.round(0.005 * sampleRate);
  }
  process(inputs) {
    const x = inputs[0] && inputs[0][0]; if (!x) return true;
    for (let i = 0; i < x.length; i++) {
      const a = Math.abs(x[i]), n = this.n++;
      this.buf[n % this.N] = a;
      this.ef = this.af * this.ef + (1 - this.af) * a;
      if (this.trig < 0) {
        this.es = this.as * this.es + (1 - this.as) * a;
        if (n > this.refr && this.ef > 4 * this.es && this.ef > 0.004) this.trig = n;
      } else if (n - this.trig >= this.post) this.measure(n, currentFrame + i);
    }
    return true;
  }
  measure(n, frameN) { // frameN = AudioContext frame of sample n
    const t0 = this.trig - this.pre; let pk = 0, pi = t0;
    for (let j = t0; j <= n; j++) { const v = this.buf[j % this.N]; if (v > pk) { pk = v; pi = j; } }
    let on = pi; for (let j = t0; j <= pi; j++) if (this.buf[j % this.N] > 0.35 * pk) { on = j; break; }
    const frame = frameN - (n - on);
    this.port.postMessage({ t: frame / sampleRate, v: 20 * Math.log10(pk + 1e-9) });
    this.trig = -1; this.refr = n + Math.round(0.3 * sampleRate);
  }
}
registerProcessor('rotor-onset', RotorOnset);
