// Rotor Ear · watch post. One screen: status banner, map, fingerprint + spectrogram, detection timeline,
// and a tap bar (Listen · Teach · Phones · Sim). Passive acoustic detection only: it listens, never transmits.
// Detection/classification: detector.js. Mesh (relay, clock sync, arrival times, map, simulator): mesh/core.js.
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const { RotorDetector, makeAnalyser, syntheticDrone, FEATS, CLASSES, GROUPS, TAGS, NH } = window.RotorEar;
  const R = window.RotorMesh, ME = 'me';
  let ctx, analyser, bus, det, tap, micStream, micSrc, testNodes = null, fileSrc = null, spk, ana, errMsg = '';
  const S = window.__rotor = { conf: 0, state: 'off', f0: 0, hits: 0, cls: null };

  // ---------- audio graph: mic / test sound / file → bus → detector (+ arrival-time tap) ----------
  function ensureCtx() {
    if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    analyser = makeAnalyser(ctx); det = new RotorDetector(analyser); det.flight.blades = +localStorage.getItem('rotorear-blades') || 2; Teach.apply();
    bus = ctx.createGain(); bus.connect(analyser); // everything the detector hears; also what Teach records
    spk = ctx.createGain(); spk.connect(ctx.destination);
    ana = ctx.createGain(); ana.connect(bus);
    R.TimingTap(ctx, bus).then(t => tap = t).catch(() => {});
    applyRouting(); buildAxis();
    setInterval(sendLocal, 1000 / R.SEND_HZ);
    requestAnimationFrame(loop);
  }
  function applyRouting() { if (!spk) return; spk.gain.value = $('toSpk').checked ? 1 : 0; ana.gain.value = $('toAna').checked ? 1 : 0; }
  $('toSpk').onchange = $('toAna').onchange = applyRouting;
  const listening = () => !!(micStream || testNodes || fileSrc);
  async function toggleMic() {
    ensureCtx();
    if (micStream) { micStream.getTracks().forEach(t => t.stop()); micSrc.disconnect(); micStream = null; tabs(); return; }
    try {
      errMsg = '';
      micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      micSrc = ctx.createMediaStreamSource(micStream); micSrc.connect(bus); keepAwake();
    } catch (e) { micStream = null; errMsg = 'Microphone unavailable: ' + (e.message || e.name) + ' (needs HTTPS + permission)'; }
    tabs();
  }
  // Stay awake: Screen Wake Lock while listening; the OS drops it when the page is hidden, so re-acquire on return.
  let wake = null, wakeNoted = false;
  async function keepAwake() {
    let msg = '';
    if (!('wakeLock' in navigator)) msg = '⚠ this browser can\'t keep the screen on: set Auto-Lock to Never while on watch';
    else if (!wake) { try { wake = await navigator.wakeLock.request('screen'); wake.onrelease = () => { wake = null; $('banner').dataset.s = ''; }; } catch (e) { msg = '⚠ screen may sleep (wake lock refused: ' + (e.name || e) + ')'; } }
    if (!wakeNoted) { wakeNoted = true; note(msg || '☀ screen stays on while listening'); if (!navigator.vibrate) note('📳 no vibration in this browser (iOS): beep + flash only'); }
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && (listening() || sim)) keepAwake(); });

  // ---------- alerts on DRONE onset: banner flash, beep, vibration; mute toggle + cooldown ----------
  const COOLDOWN_MS = 30000;
  let muted = localStorage.getItem('rotorear-mute') === '1', lastAlert = -1e9, gateUntil = 0;
  const bell = () => { $('bell').textContent = muted ? '🔕' : '🔔'; $('bell').title = muted ? 'alerts muted (tap to unmute)' : 'alerts on (tap to mute)'; };
  $('bell').onclick = e => { e.stopPropagation(); muted = !muted; localStorage.setItem('rotorear-mute', muted ? '1' : '0'); bell(); };
  // Beep = two short pure 2.4 kHz tones. A pure tone has no harmonic comb so the detector rejects it, and the
  // detector is also paused while it plays so the phone never hears its own alert.
  function beep(into) {
    ensureCtx(); const t0 = ctx.currentTime + 0.02, g = ctx.createGain(), o = ctx.createOscillator();
    o.frequency.value = 2400; o.connect(g); g.connect(into || ctx.destination); g.gain.value = 0;
    [0, 0.25].forEach(d => { g.gain.setTargetAtTime(0.35, t0 + d, 0.004); g.gain.setTargetAtTime(0, t0 + d + 0.14, 0.006); });
    o.start(t0); o.stop(t0 + 0.5); o.onended = () => g.disconnect();
    if (!into) gateUntil = performance.now() + 800;
  }
  function alertOnset(label) {
    const b = $('banner'); b.classList.remove('flash'); void b.offsetWidth; b.classList.add('flash'); setTimeout(() => b.classList.remove('flash'), 1800);
    const now = performance.now(), fire = !muted && now - lastAlert > COOLDOWN_MS;
    if (fire) { lastAlert = now; beep(); if (navigator.vibrate) navigator.vibrate([250, 120, 250]); }
    addTl({ t: Date.now(), k: 'alert', d: true, l: (fire ? '🔔 ' : muted ? '🔕 ' : '🔔 (cooldown) ') + label, sim: !!sim });
    A.count++; if (fire) A.beeps++;
  }
  const A = window.__alert = { count: 0, beeps: 0, beepIntoDetector: () => beep(bus), fire: l => alertOnset(l || 'test'), get gated() { return performance.now() < gateUntil; } };

  function startTest() { // synthetic quadcopter + wind noise
    ensureCtx();
    const out = ctx.createGain(); out.gain.value = 0; out.gain.setTargetAtTime(0.5, ctx.currentTime, 0.3); out.connect(spk); out.connect(ana);
    const drone = syntheticDrone(ctx, 190 + Math.random() * 50); drone.connect(out);
    const nb = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate), nd = nb.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    const ns = ctx.createBufferSource(); ns.buffer = nb; ns.loop = true;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3000;
    const ng = ctx.createGain(); ng.gain.value = 0.05; ns.connect(lp); lp.connect(ng); ng.connect(out); ns.start();
    testNodes = { out, drone, ns }; $('test').classList.add('on'); $('test').textContent = '⏹ Stop test';
  }
  function stopTest() {
    if (!testNodes) return; const { out, drone, ns } = testNodes;
    out.gain.setTargetAtTime(0, ctx.currentTime, 0.1); setTimeout(() => { drone.stop(); try { ns.stop(); } catch (e) {} out.disconnect(); }, 500);
    testNodes = null; $('test').classList.remove('on'); $('test').textContent = '🚁 Test sound';
  }
  async function playFile(f) {
    ensureCtx();
    try {
      const buf = await ctx.decodeAudioData(await f.arrayBuffer());
      if (fileSrc) { try { fileSrc.stop(); } catch (e) {} }
      fileSrc = ctx.createBufferSource(); fileSrc.buffer = buf; fileSrc.loop = true; fileSrc.connect(spk); fileSrc.connect(ana); fileSrc.start();
      $('fileBtn').classList.add('on'); $('fileBtn').textContent = '⏹ ' + f.name.slice(0, 14);
    } catch (e) { errMsg = 'Could not decode that file.'; }
  }
  function stopFile() { if (fileSrc) { try { fileSrc.stop(); } catch (e) {} fileSrc = null; } $('fileBtn').classList.remove('on'); $('fileBtn').textContent = '📂 Analyse file'; }
  $('start').onclick = toggleMic;
  $('test').onclick = () => { testNodes ? stopTest() : startTest(); tabs(); };
  $('fileBtn').onclick = () => fileSrc ? (stopFile(), tabs()) : $('file').click();
  $('file').onchange = e => { const f = e.target.files[0]; if (f) playFile(f).then(tabs); e.target.value = ''; };

  // ---------- sheets + tab bar ----------
  let sheet = null;
  function openSheet(id) { sheet = sheet === id ? null : id; ['teach', 'phones'].forEach(s => $(s).hidden = s !== sheet); tabs(); }
  document.querySelectorAll('[data-close]').forEach(b => b.onclick = () => openSheet(null));
  $('tabTeach').onclick = () => openSheet('teach');
  $('tabPhones').onclick = () => openSheet('phones');
  function tabs() {
    $('start').classList.toggle('on', !!micStream); $('start').querySelector('span').textContent = micStream ? 'Listening' : 'Listen';
    $('tabTeach').classList.toggle('on', sheet === 'teach'); $('tabPhones').classList.toggle('on', sheet === 'phones' || !!hub);
    $('tabSim').classList.toggle('on', !!sim);
  }

  // ---------- Teach: record tagged clips, keep only their fingerprints on this device ----------
  const Teach = (() => {
    const KEY = 'rotorear-samples-v1', USE = 'rotorear-use-samples';
    let samples = []; try { samples = JSON.parse(localStorage.getItem(KEY) || '[]'); } catch (e) {}
    const valid = smp => smp && TAGS.some(t => t.id === smp.tag) && Array.isArray(smp.x) && smp.x.length === FEATS.length && smp.x.every(Number.isFinite);
    samples = samples.filter(valid);
    $('tUse').checked = localStorage.getItem(USE) !== '0';
    $('tTag').innerHTML = TAGS.map(t => `<option value="${t.id}">${t.group === 'Not a drone' ? 'Not a drone: ' : ''}${t.label}</option>`).join('');
    const msg = (t, cls) => { $('tMsg').textContent = t; $('tMsg').className = 'msg ' + (cls || ''); };
    const save = () => { localStorage.setItem(KEY, JSON.stringify(samples)); apply(); draw(); };
    function setDet(d) { d.learned = samples; d.useLearned = $('tUse').checked; d.probs = d.lprobs = null; }
    function apply() { if (det) setDet(det); if (sim) sim.eng.nodes.forEach(n => setDet(n.det)); }
    const db = () => new Promise((res, rej) => { const r = indexedDB.open('rotorear', 1); r.onupgradeneeded = () => r.result.createObjectStore('clips'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const clipOp = async (mode, fn) => { const d = await db(); return new Promise((res, rej) => { const q = fn(d.transaction('clips', mode).objectStore('clips')); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); };
    function draw() {
      $('tCounts').innerHTML = TAGS.map(t => { const n = samples.filter(x => x.tag === t.id).length; return `<div class="${n ? 'has' : ''}"><b>${n}</b>${t.label}</div>`; }).join('');
      $('tList').innerHTML = samples.slice().reverse().map(x => `<div><span>${TAGS.find(t => t.id === x.tag).label} <small>· ${Math.round(x.f0)} Hz · ${new Date(x.t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</small></span>
        ${x.clip ? `<button data-play="${x.id}">▶</button>` : '<span></span>'}<button data-del="${x.id}">✕</button></div>`).join('');
    }
    $('tList').onclick = async e => {
      const id = e.target.dataset.play || e.target.dataset.del; if (!id) return;
      if (e.target.dataset.del) { samples = samples.filter(x => x.id !== id); try { await clipOp('readwrite', st => st.delete(id)); } catch (er) {} save(); return; }
      try { const blob = await clipOp('readonly', st => st.get(id)); if (blob) new Audio(URL.createObjectURL(blob)).play(); } catch (er) { msg('Could not play that clip.', 'bad'); }
    };
    $('tUse').onchange = () => { localStorage.setItem(USE, $('tUse').checked ? '1' : '0'); apply(); };
    $('tReset').onclick = async () => {
      if (!samples.length || !confirm('Delete all ' + samples.length + ' taught samples on this device?')) return;
      samples = []; try { await clipOp('readwrite', st => st.clear()); } catch (e) {} save(); msg('All samples deleted.');
    };
    $('tExport').onclick = () => {
      const data = { app: 'rotor-ear', kind: 'samples', v: 1, feats: FEATS, samples: samples.map(({ id, tag, x, f0, t }) => ({ id, tag, x, f0, t })) };
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' }));
      a.download = 'rotor-ear-samples-' + new Date().toISOString().slice(0, 10) + '.json'; a.click();
      msg('Exported ' + samples.length + ' samples (fingerprints only, no audio).', 'ok');
    };
    $('tImport').onclick = () => $('tImportFile').click();
    $('tImportFile').onchange = async e => {
      const f = e.target.files[0]; e.target.value = ''; if (!f) return;
      try {
        const d = JSON.parse(await f.text());
        if (d.app !== 'rotor-ear' || String(d.feats) !== String(FEATS)) throw new Error('not a Rotor Ear samples file');
        const have = new Set(samples.map(x => x.id)), add = (d.samples || []).filter(x => valid(x) && !have.has(x.id)).map(({ id, tag, x, f0, t }) => ({ id, tag, x, f0, t }));
        samples = samples.concat(add); save(); msg('Imported ' + add.length + ' new samples.', 'ok');
      } catch (er) { msg('Import failed: ' + er.message, 'bad'); }
    };
    $('tRec').onclick = async () => {
      if (!listening()) await toggleMic();
      if (!det || !listening()) return msg('Start listening first.', 'bad');
      const tag = $('tTag').value, keep = $('tKeep').checked && window.MediaRecorder;
      let rec = null, chunks = [];
      if (keep) { const dest = ctx.createMediaStreamDestination(); bus.connect(dest); rec = new MediaRecorder(dest.stream); rec.ondataavailable = ev => chunks.push(ev.data); rec.onstop = () => bus.disconnect(dest); rec.start(); }
      $('tRec').disabled = true; det.startCapture(); const t0 = performance.now();
      await new Promise(res => { const iv = setInterval(() => { const k = (performance.now() - t0) / 5000; $('tProg').style.width = Math.min(100, k * 100) + '%'; msg('Recording… ' + Math.max(0, 5 - (performance.now() - t0) / 1000).toFixed(1) + ' s'); if (k >= 1) { clearInterval(iv); res(); } }, 100); });
      const fp = det.stopCapture(); $('tRec').disabled = false; $('tProg').style.width = '0';
      if (rec) await new Promise(res => { rec.addEventListener('stop', res, { once: true }); rec.stop(); });
      if (!fp) return msg('No steady harmonic hum in that clip, so there is nothing to learn (Rotor Ear already ignores it). Try again closer to the sound.', 'bad');
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const smp = { id, tag, x: fp.x, f0: +fp.raw.f0.toFixed(1), t: Date.now() };
      if (rec && chunks.length) { try { await clipOp('readwrite', st => st.put(new Blob(chunks, { type: rec.mimeType }), id)); smp.clip = true; } catch (e) {} }
      samples.push(smp); save();
      msg('Saved: ' + TAGS.find(t => t.id === tag).label + ' @ ' + Math.round(fp.raw.f0) + ' Hz. ' + samples.filter(x => x.tag === tag).length + ' sample(s) of this kind.', 'ok');
    };
    draw();
    return { apply, setDet, get samples() { return samples; } };
  })();
  window.__teach = Teach;

  // ---------- the map: this phone (+ phones in a room) or the simulator ----------
  const hp = new URLSearchParams(location.hash.slice(1));
  let room = (hp.get('room') || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12), hub = null, sim = null;
  const posKey = () => 'rotorear-pos-' + (room || 'solo'), calKey = () => 'rotorear-cal-' + (room || 'solo');
  const loadCal = () => { try { return JSON.parse(localStorage.getItem(calKey()) || '{}'); } catch (e) { return {}; } };
  let saved = JSON.parse(localStorage.getItem(posKey()) || '{}'), model = new R.MeshModel(saved, loadCal());
  const activeModel = () => sim ? sim.model : model;
  const view = R.MapView($('map'), { onDrag: (k, p, done) => { const m = activeModel(), n = m.nodes.get(k); if (!n) return; n.pos = p; n.userMoved = true;
    if (done && !sim) { saved[k] = p; localStorage.setItem(posKey(), JSON.stringify(saved)); } } });
  function sendLocal() { // this phone is a node of its own map (in-page, no network): numbers only
    if (!det || !listening()) return;
    const now = performance.now();
    model.ingest({ t: 'pong', k: ME, ts: now, tn: now }, now);
    const ev = tap ? tap.take() : null; // envelope peaks heard during our own beep are dropped
    const on = tap ? tap.takeOnsets() : null, quiet = now < gateUntil + 300;
    model.ingest(R.telemetry(det.out, ME, 'this phone', null, quiet ? null : ev, quiet ? null : on), now);
  }

  // Phones: this page hosts the room's map; other phones open mesh/#room=…&role=node
  const nodeUrl = r => new URL('mesh/#room=' + r + '&role=node', location.href.split('#')[0]).href;
  function joinRoom(r) {
    if (!r || hub) return;
    room = r; history.replaceState(null, '', '#room=' + r);
    saved = JSON.parse(localStorage.getItem(posKey()) || '{}'); model = new R.MeshModel(saved, loadCal());
    $('pNone').hidden = true; $('pRoom').hidden = false; $('pRoomCode').textContent = r; $('pLink').value = nodeUrl(r);
    hub = R.startHub(r, {
      status: (s, cls) => { $('pStatus').textContent = s; $('pStatus').style.color = cls === 'ok' ? 'var(--quiet)' : 'var(--some)'; },
      viewer: () => {}, data: (c, d) => { const n = model.ingest(d); if (n && d.t === 's') c.nodeLabel = n.label; }
    });
    tabs();
  }
  $('pCreate').onclick = () => joinRoom(R.randKey(4));
  $('pJoin').onclick = () => joinRoom($('pCode').value.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12));
  $('pCopy').onclick = () => { navigator.clipboard && navigator.clipboard.writeText($('pLink').value); $('pCopy').textContent = 'Copied'; };
  $('pShare').onclick = () => navigator.share ? navigator.share({ title: 'Rotor Ear node', url: $('pLink').value }).catch(() => {}) : $('pCopy').onclick();
  $('pLeave').onclick = () => { location.hash = ''; location.reload(); };
  if (room) joinRoom(room);

  // Sim mode: fake phones + a fake drone, same screen. Real sound delays, clock offsets, jitter, network delay.
  $('tabSim').onclick = () => {
    if (sim) { clearInterval(sim.iv1); clearInterval(sim.iv2); clearInterval(sim.iv3); sim.eng.stop(); sim = null; tabs(); return; }
    ensureCtx();
    const eng = new R.SimEngine(ctx, { n: 4, path: hp.get('path') || 'circle', speed: +(hp.get('speed') || 1), biasMs: +(hp.get('bias') || 0), gainDb: +(hp.get('gain') || 0), jitterMs: +(hp.get('jit') || 1) });
    const m = new R.MeshModel({}), links = eng.nodes.map(n => new R.LoopLink(m, n));
    eng.nodes.forEach(n => { Teach.setDet(n.det); n.det.flight.blades = blades; });
    sim = { eng, model: m, links };
    sim.iv1 = setInterval(() => { const now = performance.now(); eng.step(now); m.truth = Object.assign({ t: 'truth' }, eng.drone); m.truthAt = now; }, 50);
    sim.iv2 = setInterval(() => { const msgs = eng.messages(); links.forEach((l, i) => l.send(msgs[i])); }, 1000 / R.SEND_HZ);
    sim.iv3 = setInterval(() => { const ts = performance.now(); links.forEach(l => l.ping(ts)); }, 1000);
    keepAwake(); tabs();
  };

  // ---------- clap calibration (Phones sheet): per-phone input latency + gain ----------
  let calib = null;
  const calibFor = () => { const m = activeModel(); if (!calib || calib.m !== m) calib = new R.Calibrator(m, cal => { if (!sim) localStorage.setItem(calKey(), JSON.stringify(cal)); }); return calib; };
  $('cMode').onchange = () => $('cSpot').hidden = $('cMode').value !== 'quick';
  $('cStart').onclick = () => { const c = calibFor(); if (c.active) { c.cancel(); return; } c.start($('cMode').value, $('cSpot').value); };
  $('cClear').onclick = () => { const c = calibFor(); c.cancel(); c.m.setCal({}); if (!sim) localStorage.removeItem(calKey()); c.msg = 'Calibration cleared.'; };
  $('cClick').onclick = () => { // a loud 1 ms click from this phone's speaker, for a clap-free calibration at this phone
    ensureCtx(); const sr = ctx.sampleRate, b = ctx.createBuffer(1, Math.round(sr * 0.02), sr), d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / sr / 0.002);
    const src = ctx.createBufferSource(); src.buffer = b; src.connect(ctx.destination); src.start();
  };
  $('cSim').onclick = () => { const c = calibFor(), n = sim && c.spot && c.m.nodes.get(c.spot); if (n) sim.eng.clap(n.pos[0] + R.NEAR, n.pos[1]); };
  function renderCal(st) {
    const c = calibFor(); c.poll();
    const live = st.nodes.filter(n => n.age < R.STALE_MS), cal = c.m.cal, ncal = live.filter(n => cal[n.key]).length;
    window.__cal = { active: c.active, spot: c.spot && c.label(c.spot), k: c.k, msg: c.msg, cal, trusted: st.calTrusted };
    if (sheet !== 'phones') return;
    $('cSim').hidden = !sim; $('cStart').textContent = c.active ? '✕ Cancel' : '👏 Calibrate';
    const spots = live.map(n => `<option value="${n.key}">next to ${n.label}</option>`).join('');
    if ($('cSpot').dataset.k !== spots) { $('cSpot').dataset.k = spots; $('cSpot').innerHTML = spots; }
    $('cMsg').textContent = c.msg || (live.length < 2 ? 'Calibration needs 2+ phones listening.' : '');
    $('cState').textContent = ncal ? `· ${ncal}/${live.length} calibrated` : '';
    const f = (v, u) => v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(1) + ' ' + u;
    const rows = live.map(n => { const k = cal[n.key]; return `<div><b style="color:${n.color}">${n.label}</b><span>latency ${k ? f(k.lat, 'ms') : '—'}</span><span>gain ${k ? f(k.gain, 'dB') : '—'}</span>` +
      `<span class="${k && k.resMs != null ? (k.resMs < 3 ? 'ok' : 'bad') : ''}">residual ${k ? (k.resMs == null ? 'n/a (1 clap)' : k.resMs.toFixed(1) + ' ms / ' + (k.resDb == null ? '—' : k.resDb.toFixed(1) + ' dB')) : '—'}</span></div>`; }).join('');
    $('cTable').innerHTML = rows ? '<div><b></b><small>vs. the average phone</small><span></span><span></span></div>' + rows : '';
  }

  // ---------- render: banner, map, timeline ----------
  const shortFl = f => f.replace(' / loaded', '').replace(' (Doppler)', '').toLowerCase(), flTxt = f => f && f.state ? ' · ' + shortFl(f.state) : '';
  const shortCls = l => ({ Quadcopter: 'quad', 'Fixed-wing': 'fixed-wing', 'Micro drone': 'micro', 'Not a drone': 'not a drone' })[l] || l;
  function setBanner(st, title, cls, sub, learned) {
    const b = $('banner'), badge = learned ? '<span class="learn">🎓 mine</span>' : '', key = st + title + cls + sub + badge;
    if (b.dataset.s === key) return; b.dataset.s = key;
    b.className = st === 'quiet' ? '' : st === 'hum' ? 'some' : st;
    b.innerHTML = title + (cls || badge ? '<b class="cls">' + (cls || '') + badge + '</b>' : '') + '<small>' + sub + '</small>';
  }
  const TL_KEY = 'rotorear-timeline'; let tl = []; try { tl = JSON.parse(localStorage.getItem(TL_KEY) || '[]'); } catch (e) {}
  let lastTl = '';
  let prevB = '';
  function logEvent(st, label) {
    if (st === 'drone' && prevB !== 'drone') alertOnset(label.split(' · ')[0]);
    prevB = st;
    const k = st + label; if (k === lastTl) return; lastTl = k; if (st !== 'drone' && st !== 'hum') return;
    const top = tl[0], now = Date.now();
    if (top && top.k === k && now - top.t < 60000) { top.n = (top.n || 1) + 1; top.t = now; drawTimeline(); localStorage.setItem(TL_KEY, JSON.stringify(tl)); }
    else addTl({ t: now, k, d: st === 'drone', l: label, sim: !!sim });
  }
  function addTl(e) { tl.unshift(e); tl = tl.slice(0, 40); localStorage.setItem(TL_KEY, JSON.stringify(tl)); drawTimeline(); }
  function note(text) { addTl({ t: Date.now(), k: 'note', i: true, l: text }); }
  function drawTimeline() {
    $('timeline').innerHTML = tl.length ? tl.map(e => `<span class="ev ${e.d ? 'd' : ''} ${e.i ? 'i' : ''}">${new Date(e.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}<b>${e.sim ? '🧪 ' : ''}${e.l}${e.n > 1 ? ' ×' + e.n : ''}</b></span>`).join('') : '<span class="dim">detections will appear here</span>';
  }
  drawTimeline();

  const f1 = v => v == null ? '—' : v.toFixed(1);
  let mapInfoKey = '';
  function frame() {
    const M = activeModel(), st = M.update(), now = performance.now();
    view.set(st); renderCal(st);
    const live = st.nodes.filter(n => n.age < R.STALE_MS), remote = live.filter(n => n.key !== ME).length;
    $('phonesN').textContent = 'Phones: ' + Math.max(1, model.state ? model.state.nodes.filter(n => n.age < R.STALE_MS).length : 1);
    $('mapTag').textContent = sim ? '🧪 sim · ' + live.length + ' fake phones · fake drone' : remote ? 'room ' + room + ' · ' + live.length + ' phones' : hub ? 'room ' + room + ' · waiting for phones' : 'solo · this phone';
    $('mapTag').className = sim ? 'sim' : '';
    // banner: multi-phone/sim → the map's fused verdict; solo → this phone's detector
    const c = det && det.out.cls, o = det && det.out;
    if (sim || remote) {
      const b = st.banner, lab = st.label;
      const sub = b === 'drone' ? (st.flight ? st.flight + ' · ' : '') + `${st.agree.length} phones agree @ ${Math.round(st.f0)} Hz` + (st.calTrusted ? ' · calibrated arrival-time fix' : st.tdoaOk ? ' · arrival-time fix' : st.estT ? ' · loudness fix (arrival times disagree)' : ' · loudness fix') : b === 'some' ? 'a phone hears a harmonic hum…' : b === 'hum' ? 'harmonic hum, fingerprint says not a drone' : live.length + ' phones listening';
      setBanner(b === 'off' ? 'off' : b, b === 'drone' ? 'DRONE' : b === 'hum' ? 'NOT A DRONE' : b === 'some' ? 'SOMETHING' : b === 'off' ? 'WAITING' : 'QUIET', b === 'drone' ? lab : '', sub, b === 'drone' && st.learned);
      logEvent(b, b === 'drone' ? shortCls((lab || 'drone').split(' · ')[0]) + (st.flight ? ' · ' + shortFl(st.flight) : '') : 'not a drone');
    } else if (o && listening()) {
      const hz = Math.round(o.f0), trend = st.nodes.find(n => n.key === ME), tr = trend && trend.trendDB, dir = tr > 1.5 ? ' · approaching' : tr < -1.5 ? ' · moving away' : '';
      const L = { quiet: ['QUIET', '', 'listening · no rotor signature'], some: ['SOMETHING', c ? c.label + ' · ' + c.conf + '%' : '', 'harmonic hum, checking…'],
        drone: ['DRONE', c ? c.label + ' · ' + c.conf + '%' : 'fingerprinting…', (o.flight && o.flight.state ? o.flight.state + ' · ' + fmtRpm(o.flight.rpm) + ' · ' : 'rotor signature @ ') + hz + ' Hz' + dir], hum: ['NOT A DRONE', c ? c.conf + '% sure' : '', c ? c.why + ' @ ' + hz + ' Hz' : ''] }[o.state];
      setBanner(o.state, L[0], L[1], L[2], c && c.learned && o.state !== 'quiet');
      logEvent(o.state, o.state === 'drone' ? shortCls(c ? c.label : 'drone') + flTxt(o.flight) : c ? c.why.replace(/ \(your samples\)/, '') : 'not a drone');
    } else { prevB = ''; setBanner('off', 'READY', '', errMsg || (hub ? 'room ' + room + ' is open · tap Listen' : 'tap Listen · or try Sim mode'), false); }
    // map overlay: honest accuracy numbers in sim, what the lines mean otherwise
    let info = '';
    if (st.truth && st.err.L != null) info = `error vs true drone (10 s avg): <span class="l">loudness <b>${f1(st.err.L)} m</b></span> · <span class="t">arrival times <b>${f1(st.err.T)} m</b></span> · <span class="f">both <b>${f1(st.err.F)} m</b></span>` + (st.headErr.both != null ? ` · heading ±${st.headErr.both}°` : '') +
      `<br>lines = arrival-time differences · <span class="l">○</span> loudness-only fit · ◌ true drone`;
    else if (st.pairs.length) info = `${st.pairs.length} arrival-time lines · they cross where the drone is`;
    if (info !== mapInfoKey) { mapInfoKey = info; $('mapInfo').innerHTML = info; $('mapInfo').style.display = info ? 'block' : 'none'; }
    if (hub && sheet === 'phones') $('pNodes').innerHTML = live.map(n => `<div><span><b style="color:${n.color}">${n.label}</b> ${(n.name || '').replace(/[<>&]/g, '')} <small>· ${n.st}${n.rtt != null && n.key !== ME ? ' · sync ±' + Math.round(n.rtt / 2) + ' ms' : ''}</small></span><span></span><small>${n.f > 0 ? Math.round(n.f) + ' Hz' : ''}</small></div>`).join('');
    Object.assign(window.__map = window.__map || {}, { mode: sim ? 'sim' : remote ? 'mesh' : 'solo', banner: st.banner, label: st.label, est: st.est, estL: st.estL, estT: st.estT, estF: st.estF, errL: st.err.L, errT: st.err.T, errF: st.err.F, headErr: st.headErr, pairs: st.pairs.length, nodes: live.length, learned: st.learned, tdoaOk: st.tdoaOk, calTrusted: st.calTrusted, truth: st.truth && [st.truth.x, st.truth.y], sync: st.nodes.map(n => n.rtt) });
  }
  setInterval(frame, 100);

  // ---------- fingerprint hexagon + spectrogram strip (this phone, or the loudest fake phone in sim) ----------
  const primary = () => sim ? sim.eng.nodes.reduce((a, n) => n.det.out.conf > a.det.out.conf ? n : a).det : det;
  const fpc = $('fpRadar'), fg = fpc.getContext('2d'), AXES = ['pitch', 'split', 'beat', 'steady', 'sub', 'mains'];
  const norm = (v, i) => i === 0 ? (v + 1.5) / 3.3 : i === 3 ? v / 2 : i === 5 ? v : v / 1.5;
  function poly(vals, stroke, fill) {
    const W = fpc.width, cx = W / 2, Rr = W * 0.3; fg.beginPath();
    vals.forEach((v, i) => { const a = -Math.PI / 2 + i * Math.PI / 3, r = Rr * Math.max(0.04, Math.min(1, norm(v, i))); fg[i ? 'lineTo' : 'moveTo'](cx + r * Math.cos(a), cx + r * Math.sin(a) * 0.8 + W * 0.02); });
    fg.closePath(); if (fill) { fg.fillStyle = fill; fg.fill(); } fg.strokeStyle = stroke; fg.lineWidth = 4; fg.stroke();
  }
  let lastLbl = '';
  function drawFingerprint(c, state) {
    const W = fpc.width, cx = W / 2, Rr = W * 0.3; fg.clearRect(0, 0, W, W);
    fg.strokeStyle = '#1c2438'; fg.lineWidth = 2;
    [0.5, 1].forEach(k => { fg.beginPath(); for (let i = 0; i <= 6; i++) { const a = -Math.PI / 2 + i * Math.PI / 3; fg[i ? 'lineTo' : 'moveTo'](cx + Rr * k * Math.cos(a), cx + Rr * k * Math.sin(a) * 0.8 + W * 0.02); } fg.stroke(); });
    fg.fillStyle = '#6f7a95'; fg.font = '22px system-ui'; fg.textAlign = 'center'; fg.textBaseline = 'middle';
    AXES.forEach((t, i) => { const a = -Math.PI / 2 + i * Math.PI / 3; fg.fillText(t, cx + (Rr + 30) * Math.cos(a), cx + (Rr + 20) * Math.sin(a) * 0.8 + W * 0.02); });
    if (c) { const proto = CLASSES.find(k => k.id === c.nearest); if (proto) poly(proto.c, 'rgba(255,255,255,0.25)'); poly(c.x, c.drone ? '#ff3b5c' : '#ffb547', c.drone ? 'rgba(255,59,92,0.25)' : 'rgba(255,181,71,0.22)'); }
    const lbl = c && state !== 'quiet' ? `<b>${c.label}</b> ${c.conf}%${c.learned ? ' 🎓' : ''}` : 'fingerprint';
    if (lbl !== lastLbl) { $('fpLbl').innerHTML = lbl; lastLbl = lbl; }
  }
  drawFingerprint(null);
  const cv = $('spec'), g2 = cv.getContext('2d'), FMAX = 8000, LOGMIN = 50;
  function sizeCanvas() { const dpr = Math.min(2, devicePixelRatio || 1), w = Math.round(cv.clientWidth * dpr), h = Math.round(cv.clientHeight * dpr); if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; g2.fillStyle = '#000'; g2.fillRect(0, 0, w, h); } }
  window.addEventListener('resize', () => { sizeCanvas(); buildAxis(); }); sizeCanvas();
  const yToF = y01 => LOGMIN * Math.pow(FMAX / LOGMIN, y01), fToY = f => Math.log(Math.max(f, LOGMIN) / LOGMIN) / Math.log(FMAX / LOGMIN);
  function buildAxis() { const ax = $('axis'); ax.innerHTML = ''; [100, 300, 1000, 3000].forEach(f => { const el = document.createElement('b'); el.style.top = ((1 - fToY(f)) * 100) + '%'; el.textContent = f >= 1000 ? f / 1000 + 'k' : f; ax.appendChild(el); }); }
  buildAxis();
  const PAL = [];
  (() => { const stops = [[0, 0, 0, 4], [0.2, 40, 11, 84], [0.4, 120, 28, 109], [0.6, 200, 60, 70], [0.8, 248, 140, 30], [1, 252, 255, 164]];
    for (let i = 0; i < 256; i++) { const t = i / 255; let k = 0; while (t > stops[k + 1][0]) k++; const [t0, r0, g0, b0] = stops[k], [t1, r1, gg1, b1] = stops[k + 1], u = (t - t0) / (t1 - t0); PAL.push(`rgb(${r0 + (r1 - r0) * u | 0},${g0 + (gg1 - g0) * u | 0},${b0 + (b1 - b0) * u | 0})`); } })();
  function drawColumn(d, o) {
    sizeCanvas(); const W = cv.width, H = cv.height, step = 2, db = d.db;
    g2.drawImage(cv, step, 0, W - step, H, 0, 0, W - step, H);
    const x = W - step;
    for (let y = 0; y < H; y += 2) { const i = Math.min(d.bins - 1, Math.round(yToF(1 - y / H) / d.binHz)); g2.fillStyle = PAL[(Math.max(0, Math.min(1, (db[i] + 105) / 75)) * 255) | 0]; g2.fillRect(x, y, step, 2); }
    if (o.state !== 'quiet' && o.f0) { g2.fillStyle = o.state === 'drone' ? '#ff3b5c' : '#ffb547'; for (let h = 1; h <= NH; h++) { const y = (1 - fToY(o.f0 * h)) * H; if (y > 0) g2.fillRect(x, y - 1, step, 2); } }
  }
  // flight state card: label, estimated RPM (blade-pass × 60 / blades), 20 s pitch sparkline
  const fmtRpm = r => Math.round(r / 10) * 10 + ' rpm';
  let blades = +localStorage.getItem('rotorear-blades') || 2;
  const setBlades = () => { if (det) det.flight.blades = blades; if (sim) sim.eng.nodes.forEach(n => n.det.flight.blades = blades); };
  $('flRpm').onclick = () => { const b = parseInt(prompt('Blades per propeller? (most quadcopters: 2; the pitch heard is blades × shaft speed)', blades), 10); if (b >= 1 && b <= 8) { blades = b; localStorage.setItem('rotorear-blades', b); setBlades(); } };
  const sp = $('spark'), sg = sp.getContext('2d'); let lastFl = '';
  function drawFlight(fl, st) {
    const dpr = Math.min(2, devicePixelRatio || 1), W = Math.round(sp.clientWidth * dpr), H = Math.round(sp.clientHeight * dpr);
    if (sp.width !== W || sp.height !== H) { sp.width = W; sp.height = H; }
    sg.clearRect(0, 0, W, H);
    const on = fl && fl.state && st !== 'quiet', key = on ? fl.state + '|' + fmtRpm(fl.rpm) + blades : '';
    if (key !== lastFl) { lastFl = key; $('flState').textContent = on ? fl.state : 'flight'; $('flState').className = on ? 'on' : '';
      $('flRpm').innerHTML = on ? fmtRpm(fl.rpm) + ` <small>${blades}-blade</small>` : `— rpm <small>${blades}-blade</small>`; }
    if (!fl || !fl.spark || fl.spark.length < 2) return;
    const now = performance.now(), pts = fl.spark.filter(p => now - p[0] < 20000); if (pts.length < 2) return;
    const fs = pts.map(p => p[1]), mid = (Math.max(...fs) + Math.min(...fs)) / 2, span = Math.max(Math.max(...fs) - Math.min(...fs), mid * 0.04) * 1.2;
    const X = t => W - (now - t) / 20000 * W, Y = f => H / 2 - (f - mid) / span * H;
    if (fl.base) { sg.strokeStyle = '#3a4560'; sg.setLineDash([3 * dpr, 3 * dpr]); sg.beginPath(); sg.moveTo(0, Y(fl.base)); sg.lineTo(W, Y(fl.base)); sg.stroke(); sg.setLineDash([]); }
    sg.strokeStyle = { Climbing: '#2ee6a6', Descending: '#4cc9ff', 'Heavy / loaded': '#ffb547', Maneuvering: '#c77dff', 'Passing by (Doppler)': '#ff8fab' }[fl.state] || '#d8e1f5';
    sg.lineWidth = 2 * dpr; sg.beginPath(); pts.forEach((p, i) => sg[i ? 'lineTo' : 'moveTo'](X(p[0]), Y(p[1]))); sg.stroke();
  }

  let lastDetect = 0;
  function loop(t) {
    if (t - lastDetect > 45) {
      lastDetect = t;
      const o = performance.now() < gateUntil ? det.out : det.step(t), c = o.cls; if (tap) tap.setF0(o.f0);
      Object.assign(S, { conf: o.conf, state: o.state, f0: o.f0, hits: o.hits, flight: o.flight && { state: o.flight.state, f: +o.flight.f.toFixed(2), rpm: Math.round(o.flight.rpm), rate: +o.flight.rate.toFixed(2), dbRate: +o.flight.dbRate.toFixed(2), base: o.flight.base }, cls: c && { label: c.label, conf: c.conf, drone: c.drone, learned: c.learned, nearest: c.nearest, raw: c.raw } });
      const p = primary(); drawFingerprint(p.out.cls, p.out.state); drawFlight(p.out.flight, p.out.state);
    }
    const p = primary(); if (p.db) drawColumn(p, p.out);
    requestAnimationFrame(loop);
  }
  bell(); tabs();
})();
