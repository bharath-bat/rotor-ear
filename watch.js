// Rotor Ear · watch post. One screen: status block, map hero, Details peek, thumb-zone actions and a bar
// (Phones · Listen/Stop · Teach). Passive acoustic detection only: it listens, never transmits.
// Detection, classification and the watch-post state machine: detector.js. Mesh (relay, clock sync, arrival
// times, map, simulator, calibration): mesh/core.js.
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const { RotorDetector, makeAnalyser, syntheticDrone, FEATS, CLASSES, TAGS, NH, WatchState, WATCH, likelihood, STATES } = window.RotorEar;
  const R = window.RotorMesh, ME = 'me';
  let ctx, analyser, bus, det, tap, micStream, micSrc, testNodes = null, fileSrc = null, spk, ana, errMsg = '', listenStart = 0;
  const S = window.__rotor = { conf: 0, state: 'off', f0: 0, hits: 0, cls: null };
  const ws = new WatchState();
  const mmss = ms => { const s = Math.max(0, Math.round(ms / 1000)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  const hms = ms => { const s = Math.max(0, Math.round(ms / 1000)); return Math.floor(s / 3600) + ':' + String(Math.floor(s / 60) % 60).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); };
  const clock = t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  const esc = t => String(t).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]);
  const setText = (id, t) => { const e = $(id); if (e.textContent !== t) e.textContent = t; };

  // ---------- theme: Night (default) or Sun (outdoors) ----------
  let theme = localStorage.getItem('rotorear-theme') || 'dark', cols = null;
  function applyTheme() {
    document.documentElement.classList.toggle('sun', theme === 'sun');
    document.querySelectorAll('[data-theme]').forEach(b => b.classList.toggle('on', b.dataset.theme === theme));
    const cs = getComputedStyle(document.documentElement), v = k => cs.getPropertyValue(k).trim();
    cols = { map: v('--map'), ink: v('--ink'), ink2: v('--ink-2'), line: v('--line'), pin: v('--pin'), pinInk: v('--pin-ink'), alert: v('--alert'), check: v('--check'), demo: v('--demo'), panel: v('--panel') };
    document.querySelector('meta[name=theme-color]').content = v('--surface');
  }
  document.querySelectorAll('[data-theme]').forEach(b => b.onclick = () => { theme = b.dataset.theme; localStorage.setItem('rotorear-theme', theme); applyTheme(); });
  applyTheme();

  // ---------- audio graph: mic / test sound / file → bus → detector (+ arrival-time tap) ----------
  function ensureCtx() {
    if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    analyser = makeAnalyser(ctx); det = new RotorDetector(analyser); det.flight.blades = blades; Teach.apply();
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
    if (micStream) { micStream.getTracks().forEach(t => t.stop()); micSrc.disconnect(); micStream = null; return; }
    try {
      errMsg = '';
      micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      micSrc = ctx.createMediaStreamSource(micStream); micSrc.connect(bus); keepAwake(); listenStart = performance.now();
    } catch (e) { micStream = null; errMsg = 'Microphone unavailable: ' + (e.message || e.name) + ' (needs HTTPS + permission)'; }
  }
  // Stay awake: Screen Wake Lock while listening; the OS drops it when the page is hidden, so re-acquire on return.
  let wake = null, notes = [];
  const devNote = t => { if (!notes.includes(t)) { notes.push(t); $('devNotes').innerHTML = notes.map(esc).join('<br>'); } };
  async function keepAwake() {
    if (!('wakeLock' in navigator)) devNote('⚠ This browser can\'t keep the screen on: set Auto-Lock to Never while on watch.');
    else if (!wake) { try { wake = await navigator.wakeLock.request('screen'); wake.onrelease = () => { wake = null; }; devNote('Screen stays on while listening.'); } catch (e) { devNote('⚠ Screen may sleep (wake lock refused: ' + (e.name || e) + ').'); } }
    if (!navigator.vibrate) devNote('No vibration in this browser (iOS): alerts are flash + beep + the status block.');
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && (listening() || sim)) keepAwake(); });

  // ---------- sound: alert tones, mute that expires ----------
  // Tones are pure sine segments: no harmonic comb, so the detector rejects them, and detection is also paused
  // while they play, so the phone never hears its own alert. The demo uses a different, lower tone.
  const TONES = { alert: [[2400, 0.14], [1800, 0.14]], demo: [[1200, 0.14], [1500, 0.14]], lost: [[900, 0.22], [600, 0.32]] };
  const MUTE_MS = 5 * 60000, REPEAT_MS = 10000;
  localStorage.removeItem('rotorear-mute'); // old never-expiring mute
  let muteUntil = +localStorage.getItem('rotorear-mute-until') || 0, gateUntil = 0, nextBeep = 0, flashT = 0;
  const muted = () => Date.now() < muteUntil, muteLeft = () => mmss(muteUntil - Date.now());
  const setMute = on => { muteUntil = on ? Date.now() + MUTE_MS : 0; localStorage.setItem('rotorear-mute-until', muteUntil); };
  function tone(kind, reps, into) {
    ensureCtx(); const t0 = ctx.currentTime + 0.02, g = ctx.createGain(), o = ctx.createOscillator(); let t = 0;
    o.connect(g); g.connect(into || ctx.destination); g.gain.value = 0;
    for (let r = 0; r < (reps || 1); r++) { TONES[kind].forEach(([f, len]) => { o.frequency.setValueAtTime(f, t0 + t); g.gain.setTargetAtTime(0.35, t0 + t, 0.004); g.gain.setTargetAtTime(0, t0 + t + len, 0.006); t += len + 0.06; }); t += 0.18; }
    o.start(t0); o.stop(t0 + t + 0.1); o.onended = () => g.disconnect();
    if (!into) gateUntil = Math.max(gateUntil, performance.now() + t * 1000 + 300);
    A.beeps++; A.tones.push(kind);
  }
  function flash() { const b = $('status'); b.classList.remove('flash'); void b.offsetWidth; b.classList.add('flash'); flashT = performance.now(); setTimeout(() => b.classList.remove('flash'), 1550); }
  const A = window.__alert = { count: 0, beeps: 0, tones: [], beepIntoDetector: k => tone(k || 'alert', 1, bus), get gated() { return performance.now() < gateUntil; },
    get muted() { return muted(); }, expireMute() { muteUntil = Date.now() - 1; }, get flashing() { return $('status').classList.contains('flash'); } };
  $('mTest').onclick = () => { flash(); if (!muted()) tone(isDemo() ? 'demo' : 'alert', 1); };
  $('mMute').onclick = () => setMute(!muted());
  $('pill').onclick = () => { if (ws.s !== 'tracking') setMute(!muted()); };

  function startTest() { // synthetic quadcopter + wind noise
    ensureCtx();
    const out = ctx.createGain(); out.gain.value = 0; out.gain.setTargetAtTime(0.5, ctx.currentTime, 0.3); out.connect(spk); out.connect(ana);
    const drone = syntheticDrone(ctx, 190 + Math.random() * 50); drone.connect(out);
    const nb = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate), nd = nb.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    const ns = ctx.createBufferSource(); ns.buffer = nb; ns.loop = true;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3000;
    const ng = ctx.createGain(); ng.gain.value = 0.05; ns.connect(lp); lp.connect(ng); ng.connect(out); ns.start();
    testNodes = { out, drone, ns }; $('test').classList.add('on'); $('test').textContent = 'Stop test sound'; if (!listenStart) listenStart = performance.now();
  }
  function stopTest() {
    if (!testNodes) return; const { out, drone, ns } = testNodes;
    out.gain.setTargetAtTime(0, ctx.currentTime, 0.1); setTimeout(() => { drone.stop(); try { ns.stop(); } catch (e) {} out.disconnect(); }, 500);
    testNodes = null; $('test').classList.remove('on'); $('test').textContent = 'Test sound';
  }
  async function playFile(f) {
    ensureCtx();
    try {
      const buf = await ctx.decodeAudioData(await f.arrayBuffer());
      if (fileSrc) { try { fileSrc.stop(); } catch (e) {} }
      fileSrc = ctx.createBufferSource(); fileSrc.buffer = buf; fileSrc.loop = true; fileSrc.connect(spk); fileSrc.connect(ana); fileSrc.start();
      $('fileBtn').classList.add('on'); $('fileBtn').textContent = 'Stop ' + f.name.slice(0, 14); if (!listenStart) listenStart = performance.now();
    } catch (e) { errMsg = 'Could not decode that file.'; }
  }
  function stopFile() { if (fileSrc) { try { fileSrc.stop(); } catch (e) {} fileSrc = null; } $('fileBtn').classList.remove('on'); $('fileBtn').textContent = 'Analyse file'; }
  $('start').onclick = () => { if (sim) return window.RotorApp.go('home'); if (listening() && !micStream) { stopTest(); stopFile(); return; } toggleMic(); };
  $('test').onclick = () => { testNodes ? stopTest() : startTest(); };
  $('fileBtn').onclick = () => fileSrc ? stopFile() : $('file').click();
  $('file').onchange = e => { const f = e.target.files[0]; if (f) playFile(f); e.target.value = ''; };

  // ---------- sheets: open from the bottom, close with Done or a swipe down; a DRONE alert closes them (not Teach: you may be recording it) ----------
  let sheet = null;
  const SHEETS = ['teach', 'details', 'phones', 'moreS'];
  function openSheet(id) {
    sheet = sheet === id ? null : id;
    $('app').classList.toggle('sheet-open', !!sheet);
    SHEETS.forEach(s => $(s).hidden = s !== sheet);
    if (sheet) requestAnimationFrame(() => document.documentElement.style.setProperty('--sheet-top', ($('status').getBoundingClientRect().bottom + 8) + 'px'));
  }
  document.querySelectorAll('[data-close]').forEach(b => b.onclick = () => openSheet(null));
  SHEETS.forEach(id => { // swipe down on the grab handle / header closes
    const el = $(id); let y0 = null;
    el.addEventListener('pointerdown', e => { if (e.target.closest('.grab,.shead')) y0 = e.clientY; });
    el.addEventListener('pointerup', e => { if (y0 != null && e.clientY - y0 > 60) openSheet(null); y0 = null; });
  });
  $('tabTeach').onclick = () => openSheet('teach');
  $('tabPhones').onclick = () => openSheet('phones');
  $('more').onclick = () => openSheet('moreS');
  $('peek').onclick = e => { if (e.target.id !== 'itWas') openSheet('details'); };
  $('addPhones').onclick = () => openSheet('phones');
  $('itWas').onclick = () => { openSheet('teach'); $('tTag').value = 'quad'; $('tMsg').textContent = 'Tagged as Quadcopter. Record while the sound is still playing.'; };
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
        ${x.clip ? `<button data-play="${x.id}" aria-label="play">▶</button>` : '<span></span>'}<button data-del="${x.id}" aria-label="delete">✕</button></div>`).join('');
      setText('teachN', samples.length + (samples.length === 1 ? ' sample' : ' samples'));
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
    return { apply, setDet, get samples() { return samples; }, count: group => samples.filter(x => TAGS.find(t => t.id === x.tag).group === group).length };
  })();
  window.__teach = Teach;

  // ---------- the map: this phone (+ phones in a room) or the demo ----------
  let room = '', hub = null, sim = null, workings = false;
  const posKey = () => 'rotorear-pos-' + (room || 'solo'), calKey = () => 'rotorear-cal-' + (room || 'solo');
  const loadCal = () => { try { return JSON.parse(localStorage.getItem(calKey()) || '{}'); } catch (e) { return {}; } };
  let saved = JSON.parse(localStorage.getItem(posKey()) || '{}'), model = new R.MeshModel(saved, loadCal());
  const activeModel = () => sim ? sim.model : model;
  const view = R.MapView($('map'), { colors: () => cols, onDrag: (k, p, done) => { const m = activeModel(), n = m.nodes.get(k); if (!n) return; n.pos = p; n.userMoved = true;
    if (done && !sim) { saved[k] = p; localStorage.setItem(posKey(), JSON.stringify(saved)); } } });
  $('workings').onchange = () => workings = $('workings').checked;
  function sendLocal() { // this phone is a node of its own map (in-page, no network): numbers only
    if (!det || !listening()) return;
    const now = performance.now();
    model.ingest({ t: 'pong', k: ME, ts: now, tn: now }, now);
    const ev = tap ? tap.take() : null; // envelope peaks / onsets heard during our own alert tone are dropped
    const on = tap ? tap.takeOnsets() : null, quiet = now < gateUntil + 300;
    model.ingest(R.telemetry(det.out, ME, 'this phone', null, quiet ? null : ev, quiet ? null : on), now);
  }

  // Phones: this screen hosts the room's map; other phones open the join link ?room=… (ear mode)
  const nodeUrl = r => location.href.split(/[?#]/)[0] + '?room=' + r;
  let hubStatus = '';
  function joinRoom(r) {
    if (!r || hub) return;
    room = r; history.replaceState(null, '', location.pathname + '#screen&room=' + r); window.RotorApp.key = 'screen|' + r;
    saved = JSON.parse(localStorage.getItem(posKey()) || '{}'); model = new R.MeshModel(saved, loadCal());
    $('pNone').hidden = true; $('pRoom').hidden = false; $('pLeave').hidden = false; $('pRoomCode').textContent = r; $('pLink').value = nodeUrl(r);
    hub = R.startHub(r, { status: s => { hubStatus = s; }, viewer: () => {}, data: (c, d) => { const n = model.ingest(d); if (n && d.t === 's') c.nodeLabel = n.label; } });
  }
  $('pCreate').onclick = () => joinRoom(R.randKey(4));
  $('pJoin').onclick = () => joinRoom($('pCode').value.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12));
  $('pCopy').onclick = () => { navigator.clipboard && navigator.clipboard.writeText($('pLink').value); $('pCopy').textContent = 'Copied'; };
  $('pShare').onclick = () => { if (!hub) joinRoom(R.randKey(4)); const url = $('pLink').value; navigator.share ? navigator.share({ title: 'Rotor Ear listening phone', url }).catch(() => {}) : $('pCopy').onclick(); };
  $('pLeave').onclick = () => { location.hash = 'screen'; location.reload(); };

  // Demo: 4 simulated phones + a scripted drone on this screen (real sound delays, clock offsets, jitter, network
  // delay). Marked DEMO the whole time: stripe, "DEMO · DRONE", hatched marker, demo tone, DEMO timeline rows.
  function startDemo(hp) {
    if (sim) return;
    ensureCtx(); openSheet(null);
    const eng = new R.SimEngine(ctx, { n: 4, path: hp.get('path') || 'demo', speed: +(hp.get('speed') || 1), biasMs: +(hp.get('bias') || 0), gainDb: +(hp.get('gain') || 0), jitterMs: +(hp.get('jit') || 1) });
    const m = new R.MeshModel({}), links = eng.nodes.map(n => new R.LoopLink(m, n));
    eng.nodes.forEach(n => { Teach.setDet(n.det); n.det.flight.blades = blades; });
    sim = { eng, model: m, links, t0: performance.now() }; ws.reset(); calib = null;
    sim.iv1 = setInterval(() => { const now = performance.now(); eng.step(now); m.truth = eng.drone && Object.assign({ t: 'truth' }, eng.drone); m.truthAt = now; }, 50);
    sim.iv2 = setInterval(() => { const msgs = eng.messages(); links.forEach((l, i) => l.send(msgs[i])); }, 1000 / R.SEND_HZ);
    sim.iv3 = setInterval(() => { const ts = performance.now(); links.forEach(l => l.ping(ts)); }, 1000);
    keepAwake();
  }
  function stopDemo() { if (!sim) return; clearInterval(sim.iv1); clearInterval(sim.iv2); clearInterval(sim.iv3); sim.eng.stop(); sim = null; ws.reset(); calib = null; }
  const replayDemo = () => { if (sim) { sim.eng.replay(); ws.reset(); } };
  const App = window.RotorApp;
  $('tryDemo').onclick = $('mDemo').onclick = () => App.go(sim ? 'screen' : 'demo');
  $('endReplay').onclick = replayDemo;
  let pendingSheet = null;
  $('endPhones').onclick = () => { pendingSheet = 'phones'; App.go('screen'); };
  // a deep link (#demo, #screen&room=…) opens without a tap, so audio may be suspended until the first touch
  const tapStart = () => { $('tapStart').hidden = !(sim && ctx && ctx.state === 'suspended'); };
  $('tapStart').onclick = () => { ctx.resume().then(tapStart); };
  App.modes.screen = {
    enter(p) {
      if (p.room && !hub) joinRoom(p.room);
      if (p.demo) { startDemo(p.h); setTimeout(tapStart, 300); }
      if (pendingSheet) { openSheet(pendingSheet); pendingSheet = null; }
    },
    leave() { stopDemo(); $('tapStart').hidden = true; if (micStream) toggleMic(); stopTest(); stopFile(); if (sheet) openSheet(null); },
  };
  const isDemo = () => !!sim || !!(model.state && model.state.demo);

  // ---------- clap calibration (Phones sheet): per-phone input latency + gain ----------
  let calib = null, countdown = 0;
  const calibFor = () => { const m = activeModel(); if (!calib || calib.m !== m) calib = new R.Calibrator(m, cal => { if (!sim) localStorage.setItem(calKey(), JSON.stringify(cal)); }); return calib; };
  $('cMode').onchange = () => $('cSpot').hidden = $('cMode').value !== 'quick';
  $('cStart').onclick = () => { const c = calibFor(); if (c.active) { c.cancel(); countdown = 0; return; } if (c.start($('cMode').value, $('cSpot').value) !== false) countdown = performance.now(); };
  $('cClear').onclick = () => { const c = calibFor(); c.cancel(); c.m.setCal({}); if (!sim) localStorage.removeItem(calKey()); c.msg = 'Calibration cleared.'; };
  $('cClick').onclick = () => { // a loud 1 ms click from this phone's speaker, for a clap-free calibration at this phone
    ensureCtx(); const sr = ctx.sampleRate, b = ctx.createBuffer(1, Math.round(sr * 0.02), sr), d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / sr / 0.002);
    const src = ctx.createBufferSource(); src.buffer = b; src.connect(ctx.destination); src.start();
  };
  $('cSim').onclick = () => { const c = calibFor(), n = sim && c.spot && c.m.nodes.get(c.spot); if (n) sim.eng.clap(n.pos[0] + R.NEAR, n.pos[1]); };
  $('cTable').onclick = e => { if (e.target.closest('[data-redo]')) { const c = calibFor(); c.cancel(); $('cMode').value = 'full'; $('cStart').onclick(); } };
  const resWord = k => !k ? ['not calibrated', 0] : k.resMs == null ? ['1 clap · no check', 0.3] : k.resMs < 3 ? ['good · ' + k.resMs.toFixed(1) + ' ms', k.resMs / 10] : k.resMs < 6 ? ['fair · ' + k.resMs.toFixed(1) + ' ms', k.resMs / 10] : ['redo · ' + k.resMs.toFixed(1) + ' ms', 1];
  let calKeyStr = '';
  function renderCal(st, live) {
    const c = calibFor(); c.poll();
    const cal = c.m.cal, ncal = live.filter(n => cal[n.key]).length;
    window.__cal = { active: c.active, spot: c.spot && c.label(c.spot), k: c.k, msg: c.msg, cal, trusted: st.calTrusted };
    if (sheet !== 'phones') return { ncal };
    $('cSim').hidden = !sim;
    const cd = c.active && countdown ? 3 - Math.floor((performance.now() - countdown) / 1000) : 0;
    setText('cStart', ''); $('cStart').innerHTML = c.active ? (cd > 0 ? `<b>${cd}…</b><small>get ready · tap to cancel</small>` : `<b>Clap!</b><small>listening for one sharp clap · tap to cancel</small>`) : '<b>Clap now</b><small>3 · 2 · 1 countdown, then clap once</small>';
    const spots = live.map(n => `<option value="${n.key}">at phone ${n.label}</option>`).join('');
    if ($('cSpot').dataset.k !== spots) { $('cSpot').dataset.k = spots; $('cSpot').innerHTML = spots; }
    setText('cNext', c.active && c.spot ? 'Next: clap next to phone ' + c.label(c.spot) : $('cMode').value === 'quick' ? 'Calibrate: one clap next to one phone' : 'Calibrate: clap next to each phone in turn');
    setText('cMsg', c.msg || (live.length < 2 ? 'Calibration needs 2+ phones listening.' : ''));
    setText('cState', ncal ? `· ${ncal}/${live.length} calibrated` : '');
    setText('pStatus', sim ? 'DEMO · ' + live.length + ' simulated phones' : hub ? 'Room ' + room.toUpperCase() + ' · ' + live.length + ' connected' + (hubStatus && !live.length ? ' · ' + hubStatus : '') : 'this phone only');
    const rows = [...live].sort((a, b) => a.label < b.label ? -1 : 1).map(n => { const k = cal[n.key], [w, f] = resWord(k), sync = n.key === ME ? 'this phone' : n.rtt != null ? 'sync ±' + Math.round(n.rtt / 2) + ' ms' : 'syncing…';
      return `<div class="prow"><span class="pin">${n.label}</span><span class="nm"><b>${n.key === ME ? 'This phone' : esc(n.name || 'Phone ' + n.label)}</b><small>${sync}${k ? ` · latency ${k.lat >= 0 ? '+' : ''}${k.lat.toFixed(1)} ms · gain ${k.gain >= 0 ? '+' : ''}${k.gain.toFixed(1)} dB` : ''}</small>` +
        `<span class="rbar"><i><u style="width:${Math.round(Math.min(1, f) * 100)}%"></u></i>${w}</span></span>${k && k.resMs >= 6 ? '<button data-redo>Redo</button>' : '<span></span>'}</div>`; }).join('');
    if (rows !== calKeyStr) { calKeyStr = rows; $('cTable').innerHTML = rows; }
    return { ncal };
  }
  // ---------- what the phones hear, in words ----------
  const compass = (dx, dy) => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(((Math.atan2(dx, dy) * 180 / Math.PI) + 360) % 360 / 45) % 8];
  const humWord = w => ({ 'steady hum (fan / AC / mains)': 'Fan / AC hum', 'mains hum (50/60 Hz)': 'Mains hum', 'engine (low, irregular)': 'Engine noise' })[w] || (w ? w[0].toUpperCase() + w.slice(1).replace(/ \(your samples\)/, '') : 'Steady hum');
  const shortFl = f => (f || '').replace('Heavy / loaded', 'Loaded').replace(' (Doppler)', '');
  const kRpm = r => r >= 1000 ? (r / 1000).toFixed(1) + 'k rpm' : Math.round(r) + ' rpm';
  function describe(st, live) {
    const mesh = !!sim || live.some(n => n.key !== ME), o = det && det.out, c = o && o.cls, D = { mesh, n: live.length };
    if (mesh) {
      D.raw = st.banner === 'off' ? 'quiet' : st.banner; D.cls = st.label; D.score = st.score; D.hz = st.f0;
      D.agree = st.voters ? `${st.voters} of ${live.length} phones agree` : '';
      D.learned = st.learned ? `Tuned by your taught samples on ${st.learned} phone${st.learned > 1 ? 's' : ''}` : '';
      const hear = live.filter(n => n.c >= 30 && n.st !== 'hum').map(n => n.label);
      D.hear = hear.length === 1 ? `Phone ${hear[0]} hears a harmonic hum` : hear.length ? `Phones ${hear.join(', ')} hear a harmonic hum` : 'A phone hears a harmonic hum';
      const hum = live.filter(n => n.st === 'hum').sort((a, b) => b.e - a.e)[0]; /* loudest = nearest */ D.hum = hum ? `${humWord(hum.wy)} near phone ${hum.label}` : 'Steady hum'; D.humWhy = hum ? hum.wy : ''; D.humAt = hum ? hum.label : '';
      if (st.est) {
        const p = live.reduce((a, n) => Math.hypot(n.pos[0] - st.est[0], n.pos[1] - st.est[1]) < Math.hypot(a.pos[0] - st.est[0], a.pos[1] - st.est[1]) ? n : a, live[0]);
        const dx = st.est[0] - p.pos[0], dy = st.est[1] - p.pos[1], r = Math.hypot(dx, dy);
        D.dir = r < 1.5 ? 'at phone ' + p.label : compass(dx, dy) + ' of phone ' + p.label; D.where = D.dir + (r >= 1.5 ? ' · ~' + Math.round(r) + ' m' : '');
        const A = live.filter(n => st.agree.includes(n.key)), tr = A.length ? A.reduce((a, n) => a + n.trendDB, 0) / A.length : 0;
        D.trend = tr > 1 ? 'getting closer' : tr < -1 ? 'moving away' : '';
      }
      D.rough = !!st.est && live.length >= 3 && !st.tdoaOk;
      D.flight = st.flight; D.rpm = st.f0 * 60 / blades; D.heading = st.heading ? compass(st.heading[0], st.heading[1]) : '';
    } else {
      D.raw = o && listening() ? o.state : 'off'; D.cls = c ? c.label : ''; D.score = c ? c.conf : 0; D.hz = o ? o.f0 : 0;
      D.agree = 'this phone only';
      D.learned = c && c.learned ? `Matched your taught samples (${Teach.count(c.label)} ${c.label})` : '';
      D.hear = 'This phone hears a harmonic hum'; D.hum = c && !c.drone ? humWord(c.why) : 'Steady hum'; D.humWhy = c ? c.why : '';
      const me = live.find(n => n.key === ME), tr = me ? me.trendDB : 0;
      D.trend = tr > 1.5 ? 'getting closer' : tr < -1.5 ? 'moving away' : 'same distance';
      D.flight = o && o.flight && o.flight.state; D.rpm = o && o.flight ? o.flight.rpm : 0;
    }
    D.word = D.cls ? (D.mesh && st.voters < 2 && likelihood(D.score) === 'very likely' ? 'likely' : likelihood(D.score)) : '';
    return D;
  }

  // ---------- timeline: one row per drone (time · type · how long · bearing · demo/real) ----------
  const TL_KEY = 'rotorear-timeline-v2'; localStorage.removeItem('rotorear-timeline');
  let tl = []; try { tl = JSON.parse(localStorage.getItem(TL_KEY) || '[]'); } catch (e) {}
  let ep = null, hum = null, tlSaved = 0;
  const saveTl = force => { const now = performance.now(); if (force || now - tlSaved > 2000) { tl = tl.slice(0, 40); localStorage.setItem(TL_KEY, JSON.stringify(tl)); tlSaved = now; } };
  function lastDrone() {
    const e = tl.find(x => x.type === 'drone'); if (!e) return '';
    const d = new Date(e.t), days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(e.t).setHours(0, 0, 0, 0)) / 864e5);
    return `Last drone ${clock(e.t)}${e.dir ? ' · ' + e.dir : ''}${e.demo ? ' (demo)' : ''}${days === 1 ? ' (yesterday)' : days > 1 ? ' (' + d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ')' : ''}`;
  }
  let tlKey = '';
  function drawTimeline() {
    const html = tl.length ? tl.map(e => `<div class="tl"><b>${clock(e.t)}</b><span>${esc(e.l)}</span><span class="dur">${mmss(e.dur || 0)}</span><span class="dir">${esc((e.dir || '—').replace(/ of phone /, ' · ').replace(/^at phone /, ''))}</span><span class="tag${e.demo ? ' demo' : ''}">${e.demo ? 'DEMO' : 'real'}</span></div>`).join('')
      : '<div class="tl empty">No detections yet. Each drone gets one row here.</div>';
    if (html !== tlKey) { tlKey = html; $('tlList').innerHTML = html; }
  }
  // ---------- one frame: state machine → status block, map, peek, actions, bar ----------
  let watchStart = 0, prevS = 'ready', lastEst = null, lastDir = '', lastHead = '', lostInfo = null, renderKey = '';
  const f1 = v => v == null ? '—' : v.toFixed(1);
  function frame() {
    const M = activeModel(), st = M.update(), now = performance.now();
    const live = st.nodes.filter(n => n.age < R.STALE_MS), D = describe(st, live), demo = isDemo();
    const on = listening() || !!sim || live.some(n => n.key !== ME);
    ws.update(now, on ? D.raw : 'off', on);
    const s = ws.s, hot = s === 'drone' || s === 'tracking';
    if (prevS === 'ready' && s !== 'ready') watchStart = now;
    if (hot && st.est) { lastEst = st.est.slice(); lastDir = D.dir || lastDir; lastHead = D.heading || lastHead; }
    // alert moment: 3 flashes + 3 beeps (demo: demo tone), sheets close; then 1 beep every 10 s until Got it
    if (ws.ev === 'alert') {
      lastDir = lastHead = ''; A.count++; flash(); if (sheet !== 'teach') openSheet(null); nextBeep = now + REPEAT_MS;
      if (!muted()) { tone(demo ? 'demo' : 'alert', 3); if (navigator.vibrate) navigator.vibrate([250, 120, 250, 120, 250]); }
      ep = { t: Date.now(), type: 'drone', l: D.cls || 'Drone', dur: 0, dir: '', demo }; tl.unshift(ep); saveTl(true);
    }
    if (ws.ev === 'back') nextBeep = now + REPEAT_MS; // back within 60 s: no new alert sound
    if (s === 'drone' && now > nextBeep) { nextBeep = now + REPEAT_MS; if (!muted()) tone(demo ? 'demo' : 'alert', 1); }
    if (ws.ev === 'lost') { if (!muted()) tone('lost', 1); lostInfo = { pos: lastEst, dir: lastDir, heading: lastHead }; }
    if (ws.ev === 'gone') { ep = null; saveTl(true); }
    if (ep && hot) { ep.dur = ws.lastSeen - ws.first; if (D.dir) ep.dir = D.dir; if (D.cls) ep.l = D.cls; saveTl(); }
    if (s === 'notdrone' && prevS !== 'notdrone') { hum = { t: Date.now(), type: 'hum', l: 'Not a drone', dur: 0, dir: D.humAt ? 'phone ' + D.humAt : '', demo, t0: now }; tl.unshift(hum); saveTl(true); }
    if (hum && D.raw === 'hum') hum.dur = now - hum.t0; else hum = null;
    prevS = s;

    $('app').classList.toggle('ready', s === 'ready'); $('app').classList.toggle('demo', demo);
    renderStatus(D, st, live, now);
    // map
    const chip = hot && D.flight ? shortFl(D.flight) + (D.rpm ? ' · ' + kRpm(D.rpm) : '') : '';
    const ring = st.truth && st.err.F != null ? st.err.F : st.estL && st.estF && st.tdoaOk ? Math.hypot(st.estL[0] - st.estF[0], st.estL[1] - st.estF[1]) : 2.5;
    st.ui = { state: s, demo, workings, chip, ring: Math.min(5, Math.max(0.8, ring)), me: sim ? sim.eng.nodes[0].key : ME, lost: s === 'lost' && lostInfo ? { pos: lostInfo.pos, ago: mmss(now - ws.lastSeen) } : null };
    if (!st.label && !D.mesh) st.label = D.cls; // solo marker text
    if (!st.nodes.length && !sim && !hub) Object.assign(st, { solo: ME, nodes: [{ key: ME, label: 'A', pos: [0, 0], age: 0, c: 0, f: 0, st: 'quiet', trendDB: 0 }] }); // not listening yet: show this phone
    view.set(st);
    const cal = renderCal(st, live);
    $('mapTag').innerHTML = demo ? '<span>DEMO · simulated phones</span>' : D.mesh ? `MAP · ${live.length} phones${st.calTrusted ? ' · calibrated' : ''}` : 'MAP · this phone only until others join';
    $('addPhones').hidden = !!sim || !!hub || !(s === 'ready' || s === 'watching');
    $('endCard').hidden = !(sim && sim.eng.ended);
    let info = '';
    if (workings && st.truth && st.err.L != null) info = `error vs true drone (10 s avg): loudness <b>${f1(st.err.L)} m</b> · arrival times <b>${f1(st.err.T)} m</b> · both <b>${f1(st.err.F)} m</b>` + (st.headErr.both != null ? ` · heading ±${st.headErr.both}°` : '') + '<br>lines = arrival-time differences · small ring = loudness-only fit · dashed = true drone';
    else if (workings && st.pairs.length) info = `${st.pairs.length} arrival-time lines · they cross where the drone is`;
    if ($('mapInfo').dataset.k !== info) { $('mapInfo').dataset.k = info; $('mapInfo').innerHTML = info; $('mapInfo').style.display = info ? 'block' : 'none'; }
    // bar: Phones · Listen/Stop · Teach
    const nPh = Math.max(1, live.length);
    setText('phonesN', sim ? '4 · demo' : nPh < 2 ? '1 · solo' : nPh + (cal.ncal >= nPh ? ' · calib ✓' : ' · not calibrated'));
    const lt = sim ? ['■ Exit demo', 'demo ' + mmss(Math.min(60, sim.eng.t) * 1000) + ' / 1:00'] : listening() ? (hot ? ['■ Listening', 'tracking ' + mmss(now - ws.first)] : s === 'lost' ? ['■ Listening', 'listening for it'] : ['■ Stop listening', 'listening ' + hms(now - listenStart)])
      : hub && live.length ? ['▶ Listen here too', 'the room is watching'] : ['▶ Listen', 'tap once · sound on too'];
    setText('startT', lt[0]); setText('startS', lt[1]);
    $('pNone').hidden = !!room || !!sim; // no room controls during the demo
    $('bar').classList.toggle('dim', hot);
    setText('mMute', muted() ? 'Unmute (' + muteLeft() + ' left)' : 'Mute 5 min');
    if (sheet === 'details') renderDetails(D, st);
    S.watch = s;
    Object.assign(window.__map = window.__map || {}, { mode: sim ? 'sim' : D.mesh ? 'mesh' : 'solo', watch: s, banner: st.banner, label: st.label, score: st.score, est: st.est, estL: st.estL, estT: st.estT, estF: st.estF, errL: st.err.L, errT: st.err.T, errF: st.err.F, headErr: st.headErr, pairs: st.pairs.length, nodes: live.length, learned: st.learned, tdoaOk: st.tdoaOk, calTrusted: st.calTrusted, truth: st.truth && [st.truth.x, st.truth.y], sync: st.nodes.map(n => n.rtt), demo });
  }
  setInterval(frame, 100);

  function renderStatus(D, st, live, now) {
    const s = ws.s, hot = s === 'drone' || s === 'tracking', demo = isDemo(), [icon, word0] = STATES[s], mt = muted() ? 'MUTED · flash only · ' + muteLeft() : null;
    let word = word0, cls = '', where = '', sub = '', pill = null, prog = null, note = '', peekT = 'Details ˄', peekS = 'timeline · why · fingerprint · flight', acts = null;
    const quiet = now - Math.max(watchStart, ws.lastSeen || 0);
    switch (s) {
      case 'ready': cls = errMsg || (hub ? 'Ready · waiting for phones' : 'Not listening · tap Listen to start'); sub = lastDrone(); break;
      case 'watching': cls = (D.n > 1 ? D.n + ' phones' : 'This phone') + ' · quiet ' + (quiet < 60000 ? Math.round(quiet / 1000) + ' s' : Math.round(quiet / 60000) + ' min');
        sub = D.raw === 'hum' ? 'Ignoring: ' + D.hum : lastDrone(); pill = mt || 'Sound: ON'; break;
      case 'checking': cls = D.hear; peekS = 'live: pitch ~' + Math.round(D.hz || 0) + ' Hz · fingerprint forming'; if (ws.holdK > 0) { prog = ws.holdK; note = `hold ${(ws.holdK * WATCH.hold / 1000).toFixed(1)} / ${WATCH.hold / 1000} s`; } break;
      case 'notdrone': cls = D.hum + ' · ignored'; prog = 1 - (now - ws.since) / WATCH.notMs; note = `back to Watching in ${Math.max(0, Math.ceil((WATCH.notMs - (now - ws.since)) / 1000))} s`;
        peekT = 'Why not ˄'; peekS = D.humWhy || 'not a rotor signature'; break;
      case 'drone': case 'tracking':
        word = demo ? 'DEMO · DRONE' : 'DRONE'; cls = (D.cls || 'Drone') + (D.word ? ' · ' + D.word : '');
        where = D.rough ? (D.where ? D.where + ' · rough, calibrate ›' : 'Position is rough. Clap to calibrate ›') : D.mesh ? [D.where, D.trend].filter(Boolean).join(' · ') : D.trend + ' · one phone: no direction';
        sub = [D.agree, 'seen ' + mmss(now - ws.first)].filter(Boolean).join(' · ');
        pill = s === 'tracking' ? '✓ Acknowledged ' + clock(Date.now() - (now - ws.ackAt)) + ' · silent' : mt || (demo ? 'Demo tone · beeping' : 'Sound ON · beeping');
        peekT = 'Why we think so ˄'; peekS = 'rotor hum ~' + Math.round(D.hz || 0) + ' Hz' + (D.learned ? ' · ' + D.learned.replace(/^Matched your taught samples \((\d+) .*\)$/, 'matches $1 of your samples') : D.flight ? ' · ' + shortFl(D.flight).toLowerCase() : '');
        acts = s === 'drone' ? [demo ? ['replay', 'Replay demo', 'from 0:00'] : muted() ? ['unmute', 'Unmute', muteLeft() + ' left'] : ['mute', 'Mute 5 min', 'banner keeps flashing'], ['ack', 'Got it', 'stops flash + beeps', 1]]
          : [muted() ? ['unmute', 'Unmute', muteLeft() + ' left'] : ['mute', 'Mute 5 min', 'also silences Lost tone'], ['details', 'Details', 'where · how sure · flight']];
        break;
      case 'lost': {
        const L = lostInfo || {}; cls = 'Last seen ' + mmss(now - ws.lastSeen) + ' ago' + (L.dir ? ' · ' + L.dir : '');
        sub = (ep ? ep.l : 'Drone') + ' · heard for ' + mmss(ws.lastSeen - ws.first) + (L.heading ? ' · was leaving ' + L.heading : ''); where = '';
        prog = 1 - (now - ws.lastSeen) / WATCH.lostMs; note = 'Watching again in ' + mmss(WATCH.lostMs - (now - ws.lastSeen)); pill = mt;
        peekS = ep ? `saved: ${clock(ep.t)} · ${ep.l} · ${mmss(ep.dur)}` : peekS;
        acts = [['dismiss', 'Back to watching', 'clears now'], ['details', 'Details', 'timeline · where it was']]; break;
      }
    }
    const b = $('status'); b.classList.remove('ready', 'watching', 'checking', 'notdrone', 'drone', 'tracking', 'lost'); b.classList.add(s);
    setText('stIcon', icon); setText('stWord', word); setText('stCls', cls); setText('stWhere', where); setText('stSub', sub); $('stWhere').classList.toggle('link', D.rough && hot);
    $('pill').hidden = !pill; if (pill) { setText('pill', pill); $('pill').classList.toggle('muted', !!mt); }
    $('stProg').hidden = prog == null; if (prog != null) $('stProg').firstChild.style.width = Math.round(Math.max(0, Math.min(1, prog)) * 100) + '%'; setText('stNote', note);
    setText('peekT', peekT); setText('peekS', peekS); $('itWas').hidden = s !== 'notdrone';
    const ak = acts ? JSON.stringify(acts) : '';
    if (ak !== renderKey) { renderKey = ak; $('actions').hidden = !acts;
      if (acts) acts.forEach((a, i) => { const el = $('act' + (i + 1)); el.dataset.a = a[0]; el.className = a[3] ? 'primary' : ''; el.innerHTML = `<b>${a[1]}</b><small>${a[2]}</small>`; }); }
  }
  $('stWhere').onclick = () => { if ($('stWhere').classList.contains('link')) openSheet('phones'); };
  $('actions').onclick = e => {
    const a = e.target.closest('button') && e.target.closest('button').dataset.a, now = performance.now();
    if (a === 'ack') { ws.acknowledge(now); $('status').classList.remove('flash'); }
    else if (a === 'mute') setMute(true); else if (a === 'unmute') setMute(false);
    else if (a === 'details') openSheet('details'); else if (a === 'dismiss') { ws.dismiss(now); ep = null; } else if (a === 'replay') replayDemo();
    renderKey = '';
  };
  window.__watch = { get s() { return ws.s; }, get holdK() { return ws.holdK; }, ack: () => $('act2').dataset.a === 'ack' && $('act2').click() };

  function renderDetails(D, st) {
    const s = ws.s, hot = s === 'drone' || s === 'tracking', why = [];
    if (hot || s === 'checking' || s === 'lost') {
      if (D.hz) why.push(`Rotor hum ~${Math.round(D.hz)} Hz with an even harmonic comb`);
      why.push(D.mesh ? (st.voters ? `${st.voters} of ${D.n} phones hear it and agree` : 'No phone is sure yet') : 'Heard by this phone only (one phone can\'t tell direction)');
      if (D.learned) why.push(D.learned);
      if (D.rough) why.push('Arrival times disagree with loudness, so the position uses loudness only. Calibrate the phones (Phones sheet) to fix this.');
    } else if (s === 'notdrone' || D.raw === 'hum') why.push(`${D.hum}: ${D.humWhy || 'not a rotor signature'}`, 'Ignored: a steady hum like this fools simple detectors');
    else why.push('Nothing heard right now.');
    const wk = why.join('|'); if ($('dWhy').dataset.k !== wk) { $('dWhy').dataset.k = wk; $('dWhy').innerHTML = why.map(w => '<li>' + esc(w) + '</li>').join(''); }
    setText('dScore', D.cls && s !== 'watching' && s !== 'ready' ? String(Math.round(D.score)) : '—');
    setText('dScoreS', D.cls ? `how close to the ${D.cls} template · not accuracy` : 'how close to a class template · not accuracy');
    setText('flState', D.flight && (hot || s === 'checking') ? shortFl(D.flight) + (D.rpm ? ' · ' + kRpm(D.rpm) : '') : 'no flight data');
    drawTimeline();
  }

  // ---------- Details: fingerprint hexagon, spectrogram, flight sparkline (this phone, or the loudest demo phone) ----------
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
    fg.strokeStyle = cols.line; fg.lineWidth = 2;
    [0.5, 1].forEach(k => { fg.beginPath(); for (let i = 0; i <= 6; i++) { const a = -Math.PI / 2 + i * Math.PI / 3; fg[i ? 'lineTo' : 'moveTo'](cx + Rr * k * Math.cos(a), cx + Rr * k * Math.sin(a) * 0.8 + W * 0.02); } fg.stroke(); });
    fg.fillStyle = cols.ink2; fg.font = '26px system-ui'; fg.textAlign = 'center'; fg.textBaseline = 'middle';
    AXES.forEach((t, i) => { const a = -Math.PI / 2 + i * Math.PI / 3; fg.fillText(t, cx + (Rr + 30) * Math.cos(a), cx + (Rr + 22) * Math.sin(a) * 0.8 + W * 0.02); });
    if (c) { const proto = CLASSES.find(k => k.id === c.nearest); if (proto) poly(proto.c, cols.line); poly(c.x, cols.ink, cols.ink2 + '55'); }
    const lbl = c && state !== 'quiet' ? `<b>${c.label}</b>` : 'fingerprint'; // the class only: the one number lives in Match score
    if (lbl !== lastLbl) { $('fpLbl').innerHTML = lbl; lastLbl = lbl; }
  }
  const specs = [$('spec'), $('spec2')].map(cv => ({ cv, g: cv.getContext('2d') })), FMAX = 8000, LOGMIN = 50;
  function sizeCanvas(sp) { // a resize keeps the history (scaled) instead of starting black
    const dpr = Math.min(2, devicePixelRatio || 1), w = Math.round(sp.cv.clientWidth * dpr), h = Math.round(sp.cv.clientHeight * dpr);
    if (!w || !h || (sp.cv.width === w && sp.cv.height === h)) return;
    const old = document.createElement('canvas'); old.width = sp.cv.width; old.height = sp.cv.height; old.getContext('2d').drawImage(sp.cv, 0, 0);
    sp.cv.width = w; sp.cv.height = h; sp.g.fillStyle = '#000'; sp.g.fillRect(0, 0, w, h); sp.g.drawImage(old, 0, 0, w, h);
  }
  window.addEventListener('resize', () => { specs.forEach(sizeCanvas); buildAxis(); });
  const yToF = y01 => LOGMIN * Math.pow(FMAX / LOGMIN, y01), fToY = f => Math.log(Math.max(f, LOGMIN) / LOGMIN) / Math.log(FMAX / LOGMIN);
  function buildAxis() { const ax = $('axis'); ax.innerHTML = ''; [100, 300, 1000, 3000].forEach(f => { const el = document.createElement('b'); el.style.top = ((1 - fToY(f)) * 100) + '%'; el.textContent = f >= 1000 ? f / 1000 + 'k' : f; ax.appendChild(el); }); }
  buildAxis();
  const PAL = R.PAL;
  function drawColumn(sp, d, o) {
    sizeCanvas(sp); const { cv, g } = sp, W = cv.width, H = cv.height, step = 2, db = d.db; if (!W || !H) return;
    g.drawImage(cv, step, 0, W - step, H, 0, 0, W - step, H);
    const x = W - step;
    for (let y = 0; y < H; y += 2) { const i = Math.min(d.bins - 1, Math.round(yToF(1 - y / H) / d.binHz)); g.fillStyle = PAL[(Math.max(0, Math.min(1, (db[i] + 105) / 75)) * 255) | 0]; g.fillRect(x, y, step, 2); }
    if (o.state !== 'quiet' && o.f0) { g.fillStyle = '#ffffff'; for (let h = 1; h <= NH; h++) { const y = (1 - fToY(o.f0 * h)) * H; if (y > 0) g.fillRect(x, y - 1, step, 2); } }
  }
  // flight: state + estimated RPM (blade-pass × 60 / blades) + 30 s pitch sparkline. "Loaded" is a word here and on
  // the map chip only; it never raises an alert (it is an inference, not a sighting).
  let blades = +localStorage.getItem('rotorear-blades') || 2;
  $('flBlades').value = String(blades);
  $('flBlades').onchange = () => { blades = +$('flBlades').value; localStorage.setItem('rotorear-blades', blades); if (det) det.flight.blades = blades; if (sim) sim.eng.nodes.forEach(n => n.det.flight.blades = blades); };
  const sp = $('spark'), sg = sp.getContext('2d');
  function drawFlight(fl) {
    const dpr = Math.min(2, devicePixelRatio || 1), W = Math.round(sp.clientWidth * dpr), H = Math.round(sp.clientHeight * dpr);
    if (!W || !H) return; if (sp.width !== W || sp.height !== H) { sp.width = W; sp.height = H; }
    sg.clearRect(0, 0, W, H);
    if (!fl || !fl.spark || fl.spark.length < 2) return;
    const now = performance.now(), pts = fl.spark.filter(p => now - p[0] < 30000); if (pts.length < 2) return;
    const fs = pts.map(p => p[1]), mid = (Math.max(...fs) + Math.min(...fs)) / 2, span = Math.max(Math.max(...fs) - Math.min(...fs), mid * 0.04) * 1.2;
    const X = t => W - (now - t) / 30000 * W, Y = f => H / 2 - (f - mid) / span * H;
    if (fl.base) { sg.strokeStyle = cols.ink2; sg.setLineDash([3 * dpr, 3 * dpr]); sg.lineWidth = dpr; sg.beginPath(); sg.moveTo(0, Y(fl.base)); sg.lineTo(W, Y(fl.base)); sg.stroke(); sg.setLineDash([]); }
    sg.strokeStyle = cols.ink; sg.lineWidth = 2 * dpr; sg.beginPath(); pts.forEach((p, i) => sg[i ? 'lineTo' : 'moveTo'](X(p[0]), Y(p[1]))); sg.stroke();
  }

  let lastDetect = 0;
  function loop(t) {
    if (t - lastDetect > 45) {
      lastDetect = t;
      const o = performance.now() < gateUntil ? det.out : det.step(t), c = o.cls; if (tap) tap.setF0(o.f0);
      Object.assign(S, { conf: o.conf, state: o.state, f0: o.f0, hits: o.hits, flight: o.flight && { state: o.flight.state, f: +o.flight.f.toFixed(2), rpm: Math.round(o.flight.rpm), rate: +o.flight.rate.toFixed(2), dbRate: +o.flight.dbRate.toFixed(2), base: o.flight.base }, cls: c && { label: c.label, conf: c.conf, drone: c.drone, learned: c.learned, nearest: c.nearest, raw: c.raw } });
      if (sheet === 'details') { const p = primary(); drawFingerprint(p.out.cls, p.out.state); drawFlight(p.out.flight); }
    }
    const p = primary(); if (p.db) { drawColumn(specs[0], p, p.out); drawColumn(specs[1], p, p.out); } // Details keeps drawing while closed, so it opens with history
    requestAnimationFrame(loop);
  }
  drawFingerprint(null);
})();
