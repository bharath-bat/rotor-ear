// Rotor Ear: passive acoustic drone detector. Listens only; never transmits.
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const FMAX_VIEW = 8000;          // spectrogram range
  const F0_MIN = 90, F0_MAX = 600; // blade-pass search range
  const NH = 10;                   // harmonics checked per candidate
  const HIT_DB = 9;                // a harmonic "counts" if this far above the local floor
  const HIST_SEC = 1.2;            // stability window

  let ctx, analyser, inputBus, micStream, micSrc, testNodes = null, fileSrc = null;
  let spk, ana; // routing gains for test/file
  let bins, db, floorDb, binHz, running = false, logScale = true;
  const hist = []; // {t, f0, score, hits}
  let conf = 0, state = 'quiet', stateSince = 0, lastDetect = 0;
  const S = window.__rotor = { conf: 0, state: 'off', f0: 0, hits: 0, raw: 0, stab: 0 };

  // ---------- audio graph ----------
  function ensureCtx() {
    if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC();
    analyser = ctx.createAnalyser();
    analyser.fftSize = 8192;
    analyser.smoothingTimeConstant = 0.5;
    analyser.minDecibels = -110; analyser.maxDecibels = -20;
    inputBus = ctx.createGain();
    inputBus.connect(analyser);
    spk = ctx.createGain(); spk.connect(ctx.destination);
    ana = ctx.createGain(); ana.connect(inputBus);
    applyRouting();
    binHz = ctx.sampleRate / analyser.fftSize;
    bins = Math.min(analyser.frequencyBinCount, Math.ceil(FMAX_VIEW / binHz) + 2);
    db = new Float32Array(analyser.frequencyBinCount);
    floorDb = new Float32Array(analyser.frequencyBinCount);
    buildAxis();
    if (!running) { running = true; requestAnimationFrame(loop); }
  }
  function applyRouting() {
    if (!spk) return;
    spk.gain.value = $('toSpk').checked ? 1 : 0;
    ana.gain.value = $('toAna').checked ? 1 : 0;
  }
  $('toSpk').onchange = $('toAna').onchange = applyRouting;

  async function toggleMic() {
    ensureCtx();
    if (micStream) {
      micStream.getTracks().forEach(t => t.stop()); micSrc.disconnect(); micStream = null;
      $('start').textContent = '🎙️ Start listening'; $('start').classList.remove('on');
      return;
    }
    try {
      $('err').textContent = '';
      micStream = await navigator.mediaDevices.getUserMedia({ audio: {
        echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      micSrc = ctx.createMediaStreamSource(micStream);
      micSrc.connect(inputBus);
      $('start').textContent = '⏹ Stop listening'; $('start').classList.add('on');
    } catch (e) {
      micStream = null;
      $('err').textContent = 'Microphone unavailable: ' + (e.message || e.name) + ' (needs HTTPS + permission)';
    }
  }

  // Synthetic quadcopter: 4 rotors at slightly different blade-pass rates, rich harmonics, wobble, wind noise.
  function startTest() {
    ensureCtx();
    const out = ctx.createGain(); out.gain.value = 0;
    out.gain.setTargetAtTime(0.5, ctx.currentTime, 0.3);
    out.connect(spk); out.connect(ana);
    const nodes = [out];
    const N = 24, re = new Float32Array(N + 1), im = new Float32Array(N + 1);
    for (let h = 1; h <= N; h++) im[h] = Math.pow(h, -0.9) * (h % 2 ? 1 : 0.8);
    const wave = ctx.createPeriodicWave(re, im);
    const base = 190 + Math.random() * 50;
    [0, 0.012, -0.009, 0.021].forEach((d, i) => {
      const o = ctx.createOscillator(); o.setPeriodicWave(wave);
      o.frequency.value = base * (1 + d);
      const lfo = ctx.createOscillator(); lfo.frequency.value = 0.3 + i * 0.17;
      const lg = ctx.createGain(); lg.gain.value = base * 0.006;
      lfo.connect(lg); lg.connect(o.frequency);
      const g = ctx.createGain(); g.gain.value = 0.09;
      o.connect(g); g.connect(out); o.start(); lfo.start();
      nodes.push(o, lfo);
    });
    const nb = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate), nd = nb.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    const ns = ctx.createBufferSource(); ns.buffer = nb; ns.loop = true;
    const bp = ctx.createBiquadFilter(); bp.type = 'lowpass'; bp.frequency.value = 3000;
    const ng = ctx.createGain(); ng.gain.value = 0.05;
    ns.connect(bp); bp.connect(ng); ng.connect(out); ns.start(); nodes.push(ns);
    testNodes = nodes;
    $('test').classList.add('on'); $('test').textContent = '⏹ Stop test';
  }
  function stopTest() {
    if (!testNodes) return;
    const [out, ...src] = testNodes;
    out.gain.setTargetAtTime(0, ctx.currentTime, 0.1);
    setTimeout(() => { src.forEach(n => { try { n.stop(); } catch (e) {} }); out.disconnect(); }, 500);
    testNodes = null;
    $('test').classList.remove('on'); $('test').textContent = '🚁 Test sound';
  }
  window.__rotorTest = startTest;

  async function playFile(f) {
    ensureCtx();
    try {
      const buf = await ctx.decodeAudioData(await f.arrayBuffer());
      if (fileSrc) { try { fileSrc.stop(); } catch (e) {} }
      fileSrc = ctx.createBufferSource(); fileSrc.buffer = buf; fileSrc.loop = true;
      fileSrc.connect(spk); fileSrc.connect(ana); fileSrc.start();
      $('fileBtn').classList.add('on'); $('fileBtn').textContent = '⏹ ' + f.name.slice(0, 14);
    } catch (e) { $('err').textContent = 'Could not decode that file.'; }
  }
  function stopFile() {
    if (fileSrc) { try { fileSrc.stop(); } catch (e) {} fileSrc = null; }
    $('fileBtn').classList.remove('on'); $('fileBtn').textContent = '📂 Analyse file';
  }

  $('start').onclick = toggleMic;
  $('test').onclick = () => testNodes ? stopTest() : startTest();
  $('fileBtn').onclick = () => fileSrc ? stopFile() : $('file').click();
  $('file').onchange = e => { const f = e.target.files[0]; if (f) playFile(f); e.target.value = ''; };
  $('scale').onclick = () => { logScale = !logScale; $('scale').textContent = 'Scale: ' + (logScale ? 'log' : 'linear'); buildAxis(); };

  // ---------- detector ----------
  // Local noise floor: mean dB of neighbouring bins (centre excluded), via prefix sums.
  function computeFloor(n) {
    const W = 24, pre = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + db[i];
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - W), b = Math.min(n, i + W + 1);
      const c0 = Math.max(0, i - 2), c1 = Math.min(n, i + 3);
      const sum = pre[b] - pre[a] - (pre[c1] - pre[c0]);
      floorDb[i] = sum / ((b - a) - (c1 - c0));
    }
  }
  function excessAt(f) { // best peak height above floor within ±2.5% of f
    const tol = Math.max(1, Math.round(f * 0.025 / binHz));
    const c = Math.round(f / binHz);
    let best = 0;
    for (let i = c - tol; i <= c + tol; i++) {
      if (i < 1 || i >= bins) continue;
      const e = db[i] - floorDb[i];
      if (e > best) best = e;
    }
    return Math.min(best, 30);
  }
  function scoreF0(f0) {
    let s = 0, hits = 0, low = 0, e1 = 0;
    for (let h = 1; h <= NH; h++) {
      const f = f0 * h; if (f > FMAX_VIEW) break;
      const e = excessAt(f); s += e;
      if (e > HIT_DB) { hits++; if (h <= 4) low++; }
      if (h === 1) e1 = e;
    }
    s /= NH;
    // a real rotor comb has its fundamental and most low harmonics present;
    // this rejects "every other harmonic" matches from a single tone + distortion
    if (e1 < HIT_DB) { s *= 0.3; hits = Math.min(hits, 2); }
    else if (low < 3) { s *= 0.5; hits = Math.min(hits, 3); }
    return { s, hits };
  }
  let liveEnergy = -200, quietFloor = -60;
  function detect(now) {
    const n = bins;
    let e = 0;
    for (let i = 0; i < n; i++) { if (!isFinite(db[i])) db[i] = -160; e += Math.pow(10, db[i] / 10); }
    liveEnergy = 10 * Math.log10(e + 1e-20);
    // slow-rising, fast-falling estimate of the ambient level (adaptive noise floor over time)
    quietFloor += (liveEnergy < quietFloor ? 0.2 : 0.002) * (liveEnergy - quietFloor);
    computeFloor(n);
    let best = { f0: 0, s: 0, hits: 0 }; const cand = [];
    for (let f0 = F0_MIN; f0 <= F0_MAX; f0 += 1) {
      const r = scoreF0(f0); cand.push([f0, r]);
      if (r.s > best.s) best = { f0, s: r.s, hits: r.hits };
    }
    // octave guard: prefer the lowest candidate scoring close to the best
    for (const [f0, r] of cand) { if (r.s >= best.s * 0.85 && r.hits >= best.hits - 1) { best = { f0, s: r.s, hits: r.hits }; break; } }
    const audible = liveEnergy > -75; // digital silence / very faint input
    hist.push({ t: now, f0: best.f0, s: audible ? best.s : 0, hits: audible ? best.hits : 0 });
    while (hist.length && now - hist[0].t > HIST_SEC * 1000) hist.shift();

    // stability: fraction of recent frames that agree on the same pitch and are harmonic-rich
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
    // asymmetric smoothing: rise in ~1s, fall in ~1.5s
    conf += (raw > conf ? 0.08 : 0.05) * (raw - conf);

    // hysteresis + minimum dwell to stop flicker
    const dwell = now - stateSince;
    let next = state;
    if (state === 'quiet') { if (conf > 60) next = 'drone'; else if (conf > 30) next = 'some'; }
    else if (state === 'some') { if (conf > 60) next = 'drone'; else if (conf < 18 && dwell > 1000) next = 'quiet'; }
    else if (state === 'drone') { if (conf < 42 && dwell > 1500) next = conf < 18 ? 'quiet' : 'some'; }
    if (next !== state) { state = next; stateSince = now; }

    Object.assign(S, { conf: Math.round(conf), state, f0: stab > 0.3 ? f0Med : 0, hits: Math.round(hMean), raw: Math.round(raw), stab: +stab.toFixed(2), energy: Math.round(liveEnergy) });
    S.dbg = { best, ex: Array.from({length:NH},(_,h)=>Math.round(excessAt(best.f0*(h+1)))) };
    render(best);
  }
  const clamp = (x, a, b) => x < a ? a : x > b ? b : x;

  function render() {
    $('conf').textContent = S.conf;
    $('meter').style.width = S.conf + '%';
    $('f0').textContent = S.f0 && S.conf > 15 ? Math.round(S.f0) : '—';
    $('harm').textContent = 'harmonics: ' + (S.conf > 15 ? S.hits + '/' + NH : '—');
    const b = $('banner');
    const label = { quiet: ['QUIET', 'no rotor signature'], some: ['SOMETHING', 'harmonic hum, checking…'], drone: ['DRONE NEARBY', 'steady rotor signature @ ' + Math.round(S.f0) + ' Hz'] }[state];
    if (b.dataset.s !== state + label[1]) {
      b.dataset.s = state + label[1];
      b.className = state === 'quiet' ? '' : state;
      b.innerHTML = label[0] + '<small>' + label[1] + '</small>';
    }
  }

  // ---------- spectrogram ----------
  const cv = $('spec'), g2 = cv.getContext('2d');
  function sizeCanvas() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.round(cv.clientWidth * dpr), h = Math.round(cv.clientHeight * dpr);
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; g2.fillStyle = '#000'; g2.fillRect(0, 0, w, h); }
  }
  window.addEventListener('resize', () => { sizeCanvas(); buildAxis(); });
  sizeCanvas();
  const LOGMIN = 50;
  const yToF = y01 => logScale ? LOGMIN * Math.pow(FMAX_VIEW / LOGMIN, y01) : y01 * FMAX_VIEW;
  const fToY = f => logScale ? Math.log(Math.max(f, LOGMIN) / LOGMIN) / Math.log(FMAX_VIEW / LOGMIN) : f / FMAX_VIEW;
  function buildAxis() {
    const ax = $('axis'); ax.innerHTML = '';
    [100, 200, 500, 1000, 2000, 4000, 8000].forEach(f => {
      const y = 1 - fToY(f); if (y < 0.02 || y > 0.98) return;
      const el = document.createElement('b'); el.style.top = (y * 100) + '%';
      el.textContent = f >= 1000 ? f / 1000 + 'k' : f; ax.appendChild(el);
    });
  }
  buildAxis();
  // inferno-ish palette
  const PAL = [];
  (() => {
    const stops = [[0, 0, 0, 4], [0.2, 40, 11, 84], [0.4, 120, 28, 109], [0.6, 200, 60, 70], [0.8, 248, 140, 30], [1, 252, 255, 164]];
    for (let i = 0; i < 256; i++) {
      const t = i / 255; let k = 0; while (t > stops[k + 1][0]) k++;
      const [t0, r0, g0, b0] = stops[k], [t1, r1, gg1, b1] = stops[k + 1], u = (t - t0) / (t1 - t0);
      PAL.push(`rgb(${r0 + (r1 - r0) * u | 0},${g0 + (gg1 - g0) * u | 0},${b0 + (b1 - b0) * u | 0})`);
    }
  })();
  function drawColumn() {
    const W = cv.width, H = cv.height, step = 2;
    g2.drawImage(cv, step, 0, W - step, H, 0, 0, W - step, H);
    const x = W - step;
    for (let y = 0; y < H; y += 2) {
      const f = yToF(1 - y / H), i = Math.min(bins - 1, Math.round(f / binHz));
      const v = clamp((db[i] + 105) / 75, 0, 1);
      g2.fillStyle = PAL[(v * 255) | 0]; g2.fillRect(x, y, step, 2);
    }
    if (state !== 'quiet' && S.f0) { // mark the detected harmonic comb
      g2.fillStyle = state === 'drone' ? '#ff3b5c' : '#ffb547';
      for (let h = 1; h <= NH; h++) { const y = (1 - fToY(S.f0 * h)) * H; if (y > 0) g2.fillRect(x, y - 1, step, 2); }
    }
  }

  function loop(t) {
    if (analyser) {
      analyser.getFloatFrequencyData(db);
      if (t - lastDetect > 45) { lastDetect = t; detect(t); }
      drawColumn();
    }
    requestAnimationFrame(loop);
  }
})();
