// Rotor Ear · arrival-time tap. Runs on the audio thread, on a band-passed copy of what the
// detector hears. It turns the rotor "beating" envelope into a 1 kHz series and reports the time
// of each distinct envelope peak (sub-millisecond, in AudioContext seconds). Only these times
// ever leave the device — never audio.
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
