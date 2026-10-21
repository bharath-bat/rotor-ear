// Rotor Ear: passive acoustic drone detector + sound fingerprint. Listens only; never transmits.
// Detection and classification live in detector.js (shared with mesh/).
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const { RotorDetector, makeAnalyser, syntheticDrone, FEATS, CLASSES, GROUPS, NH } = window.RotorEar;
  const FMAX_VIEW = 8000;
  let ctx, analyser, det, micStream, micSrc, testNodes = null, fileSrc = null, spk, ana;
  let running = false, logScale = true, lastDetect = 0;
  const S = window.__rotor = { conf: 0, state: 'off', f0: 0, hits: 0, cls: null };

  // ---------- audio graph ----------
  function ensureCtx() {
    if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    analyser = makeAnalyser(ctx);
    det = new RotorDetector(analyser);
    spk = ctx.createGain(); spk.connect(ctx.destination);
    ana = ctx.createGain(); ana.connect(analyser);
    applyRouting(); buildAxis();
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
      micSrc.connect(analyser);
      $('start').textContent = '⏹ Stop listening'; $('start').classList.add('on');
    } catch (e) {
      micStream = null;
      $('err').textContent = 'Microphone unavailable: ' + (e.message || e.name) + ' (needs HTTPS + permission)';
    }
  }

  // Synthetic quadcopter + wind noise as the Test sound.
  function startTest() {
    ensureCtx();
    const out = ctx.createGain(); out.gain.value = 0;
    out.gain.setTargetAtTime(0.5, ctx.currentTime, 0.3);
    out.connect(spk); out.connect(ana);
    const drone = syntheticDrone(ctx, 190 + Math.random() * 50); drone.connect(out);
    const nb = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate), nd = nb.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    const ns = ctx.createBufferSource(); ns.buffer = nb; ns.loop = true;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3000;
    const ng = ctx.createGain(); ng.gain.value = 0.05;
    ns.connect(lp); lp.connect(ng); ng.connect(out); ns.start();
    testNodes = { out, drone, ns };
    $('test').classList.add('on'); $('test').textContent = '⏹ Stop test';
  }
  function stopTest() {
    if (!testNodes) return;
    const { out, drone, ns } = testNodes;
    out.gain.setTargetAtTime(0, ctx.currentTime, 0.1);
    setTimeout(() => { drone.stop(); try { ns.stop(); } catch (e) {} out.disconnect(); }, 500);
    testNodes = null;
    $('test').classList.remove('on'); $('test').textContent = '🚁 Test sound';
  }

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

  // ---------- readouts ----------
  function render(o) {
    const c = o.cls;
    Object.assign(S, { conf: o.conf, state: o.state, f0: o.f0, hits: o.hits, cls: c && { label: c.label, conf: c.conf, drone: c.drone, nearest: c.nearest, raw: c.raw } });
    // drone confidence = harmonic-comb confidence, scaled down by how sure the fingerprint is it's NOT a drone
    const dc = c ? Math.round(o.conf * (1 - c.probs[3])) : o.conf;
    $('conf').textContent = dc;
    $('meter').style.width = dc + '%';
    $('f0').textContent = o.f0 && o.conf > 15 ? Math.round(o.f0) : '—';
    $('harm').textContent = 'harmonics: ' + (o.conf > 15 ? o.hits + '/' + NH : '—');
    const hz = Math.round(o.f0);
    const L = {
      quiet: ['QUIET', 'no rotor signature', ''],
      some: ['SOMETHING', 'harmonic hum, checking…', c ? c.label + ' · ' + c.conf + '%' : ''],
      drone: ['DRONE NEARBY', 'steady rotor signature @ ' + hz + ' Hz', c ? c.label + ' · ' + c.conf + '%' : 'fingerprinting…'],
      hum: ['NOT A DRONE', c ? c.why + ' @ ' + hz + ' Hz' : '', c ? c.conf + '% sure' : '']
    }[o.state];
    const b = $('banner'), key = o.state + L.join('|');
    if (b.dataset.s !== key) {
      b.dataset.s = key;
      b.className = o.state === 'quiet' ? '' : o.state === 'hum' ? 'some' : o.state;
      b.innerHTML = L[0] + (L[2] ? '<b class="cls">' + L[2] + '</b>' : '') + '<small>' + L[1] + '</small>';
    }
    drawFingerprint(c);
  }

  // Radar of the 6 fingerprint features (live polygon vs the matched class profile) + class bars.
  const fpc = $('fpRadar'), fg = fpc.getContext('2d');
  const AXES = ['pitch', 'split', 'beat', 'steady', 'sub', 'mains'];
  const norm = (v, i) => i === 0 ? (v + 1.5) / 3.3 : i === 3 ? v / 2 : i === 5 ? v : v / 1.5;
  function poly(vals, stroke, fill) {
    const W = fpc.width, cx = W / 2, cy = W / 2, R = W * 0.3;
    fg.beginPath();
    vals.forEach((v, i) => { const a = -Math.PI / 2 + i * 2 * Math.PI / vals.length, r = R * Math.max(0.04, Math.min(1, norm(v, i)));
      fg[i ? 'lineTo' : 'moveTo'](cx + r * Math.cos(a), cy + r * Math.sin(a)); });
    fg.closePath(); if (fill) { fg.fillStyle = fill; fg.fill(); } fg.strokeStyle = stroke; fg.lineWidth = 3; fg.stroke();
  }
  let lastBars = '';
  function drawFingerprint(c) {
    const W = fpc.width, cx = W / 2, R = W * 0.3;
    fg.clearRect(0, 0, W, W);
    fg.strokeStyle = '#1c2438'; fg.lineWidth = 1.5;
    [0.33, 0.66, 1].forEach(k => { fg.beginPath(); for (let i = 0; i <= 6; i++) { const a = -Math.PI / 2 + i * Math.PI / 3; fg[i ? 'lineTo' : 'moveTo'](cx + R * k * Math.cos(a), cx + R * k * Math.sin(a)); } fg.stroke(); });
    fg.fillStyle = '#6f7a95'; fg.font = '22px system-ui'; fg.textAlign = 'center'; fg.textBaseline = 'middle';
    AXES.forEach((t, i) => { const a = -Math.PI / 2 + i * Math.PI / 3; fg.fillText(t, cx + (R + 38) * Math.cos(a), cx + (R + 24) * Math.sin(a)); });
    if (c) {
      const proto = CLASSES.find(k => k.id === c.nearest);
      if (proto) poly(proto.c, 'rgba(255,255,255,0.25)');
      poly(c.x, c.drone ? '#ff3b5c' : '#ffb547', c.drone ? 'rgba(255,59,92,0.25)' : 'rgba(255,181,71,0.22)');
    }
    const probs = c ? c.probs : [0, 0, 0, 0], top = c ? GROUPS.indexOf(c.label) : -1;
    const html = GROUPS.map((gn, i) => `<div class="${i === top ? 'top' : ''} ${i === 3 ? 'neg' : ''}"><span>${gn}</span><i><b style="width:${Math.round(probs[i] * 100)}%"></b></i><span>${c ? Math.round(probs[i] * 100) + '%' : '—'}</span></div>`).join('');
    if (html !== lastBars) { $('fpBars').innerHTML = html; lastBars = html; }
  }
  drawFingerprint(null);

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
  const PAL = [];
  (() => { // inferno-ish palette
    const stops = [[0, 0, 0, 4], [0.2, 40, 11, 84], [0.4, 120, 28, 109], [0.6, 200, 60, 70], [0.8, 248, 140, 30], [1, 252, 255, 164]];
    for (let i = 0; i < 256; i++) {
      const t = i / 255; let k = 0; while (t > stops[k + 1][0]) k++;
      const [t0, r0, g0, b0] = stops[k], [t1, r1, gg1, b1] = stops[k + 1], u = (t - t0) / (t1 - t0);
      PAL.push(`rgb(${r0 + (r1 - r0) * u | 0},${g0 + (gg1 - g0) * u | 0},${b0 + (b1 - b0) * u | 0})`);
    }
  })();
  function drawColumn(o) {
    const W = cv.width, H = cv.height, step = 2, db = det.db;
    g2.drawImage(cv, step, 0, W - step, H, 0, 0, W - step, H);
    const x = W - step;
    for (let y = 0; y < H; y += 2) {
      const i = Math.min(det.bins - 1, Math.round(yToF(1 - y / H) / det.binHz));
      g2.fillStyle = PAL[(Math.max(0, Math.min(1, (db[i] + 105) / 75)) * 255) | 0]; g2.fillRect(x, y, step, 2);
    }
    if (o.state !== 'quiet' && o.f0) { // mark the detected harmonic comb
      g2.fillStyle = o.state === 'drone' ? '#ff3b5c' : '#ffb547';
      for (let h = 1; h <= NH; h++) { const y = (1 - fToY(o.f0 * h)) * H; if (y > 0) g2.fillRect(x, y - 1, step, 2); }
    }
  }

  let out = null;
  function loop(t) {
    if (det) {
      if (t - lastDetect > 45 || !out) { lastDetect = t; out = det.step(t); render(out); }
      drawColumn(out);
    }
    requestAnimationFrame(loop);
  }
})();
