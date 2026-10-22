// Rotor Ear · watch post. One screen: status block, map hero, Details peek, thumb-zone actions and a bar
// (Phones · Listen/Stop · Teach). Passive acoustic detection only: it listens, never transmits.
// Detection, classification and the watch-post state machine: detector.js. Mesh (relay, clock sync, arrival
// times, map, simulator, calibration): mesh/core.js.
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const { RotorDetector, whyFrom, makeAnalyser, syntheticDrone, FEATS, CLASSES, TAGS, NH, WatchState, WATCH, likelihood, STATES } = window.RotorEar;
  const R = window.RotorMesh, ME = 'me';
  let ctx, analyser, bus, det, tap, micStream, micSrc, testNodes = null, fileSrc = null, spk, ana, errMsg = '', listenStart = 0;
  const S = window.__rotor = { conf: 0, state: 'off', f0: 0, hits: 0, cls: null };
  const ws = new WatchState();
  const mmss = ms => { const s = Math.max(0, Math.round(ms / 1000)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  const hms = ms => { const s = Math.max(0, Math.round(ms / 1000)); return Math.floor(s / 3600) + ':' + String(Math.floor(s / 60) % 60).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); };
  const clock = t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  const esc = t => String(t).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]);
  const setText = (id, t) => { const e = $(id); if (e.textContent !== t) e.textContent = t; };
  const setHTML = (id, t) => { const e = $(id); if (e._h !== t) { e._h = t; e.innerHTML = t; } };

  // ---------- theme: Night (default) or Sun (outdoors) ----------
  let theme = localStorage.getItem('rotorear-theme') || 'dark', cols = null;
  function applyTheme() {
    document.documentElement.classList.toggle('sun', theme === 'sun');
    document.querySelectorAll('[data-theme]').forEach(b => b.classList.toggle('on', b.dataset.theme === theme));
    const cs = getComputedStyle(document.documentElement), v = k => cs.getPropertyValue(k).trim();
    cols = { map: v('--map'), ink: v('--ink'), ink2: v('--ink-2'), line: v('--line'), pin: v('--pin'), pinInk: v('--pin-ink'), alert: v('--alert'), alert2: v('--drone2'), shade: v('--shade'), check: v('--check'), demo: v('--demo'), panel: v('--panel') };
    document.querySelector('meta[name=theme-color]').content = v('--surface');
  }
  document.querySelectorAll('[data-theme]').forEach(b => b.onclick = () => { theme = b.dataset.theme; localStorage.setItem('rotorear-theme', theme); applyTheme(); });
  applyTheme();

  // ---------- audio graph: mic / test sound / file → bus → detector (+ arrival-time tap) ----------
  function ensureCtx() {
    if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    analyser = makeAnalyser(ctx); det = new RotorDetector(analyser); det.blades = blades; Teach.apply();
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
  function raiseAlert(now, demo) { // the alert moment: 3 flashes + 3 beeps (demo: demo tone) + buzz; sheets close
    A.count++; flash(); if (sheet !== 'teach') openSheet(null); nextBeep = now + REPEAT_MS;
    if (!muted()) { tone(demo ? 'demo' : 'alert', 3); if (navigator.vibrate) navigator.vibrate([250, 120, 250, 120, 250]); }
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
  const SHEETS = ['teach', 'details', 'phones', 'moreS', 'logS'];
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
    const Smp = window.RotorSamples;
    $('tUse').checked = Smp.use;
    $('tTag').innerHTML = TAGS.map(t => `<option value="${t.id}">${t.group === 'Not a drone' && t.label !== t.group ? 'Not a drone: ' : ''}${t.label}</option>`).join('');
    const msg = (t, cls) => { $('tMsg').textContent = t; $('tMsg').className = 'msg ' + (cls || ''); };
    function setDet(d) { d.learned = Smp.list; d.useLearned = Smp.use; d.forget(); }
    function apply() { if (det) setDet(det); if (sim) sim.eng.nodes.forEach(n => setDet(n.det)); }
    function draw() {
      const samples = Smp.list;
      $('tCounts').innerHTML = TAGS.map(t => { const n = samples.filter(x => x.tag === t.id).length; return `<div class="${n ? 'has' : ''}"><b>${n}</b>${t.label}</div>`; }).join('');
      $('tList').innerHTML = samples.slice().reverse().map(x => `<div><span>${esc(Smp.name(x))} <small>· ${Math.round(x.f0)} Hz · ${new Date(x.t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}${x.from === 'label' ? ' · labelled' : ''}</small></span>
        ${x.clip ? `<button data-play="${x.id}" aria-label="play">▶</button>` : '<span></span>'}<button data-del="${x.id}" aria-label="delete">✕</button></div>`).join('');
      setText('teachN', samples.length + (samples.length === 1 ? ' sample' : ' samples'));
    }
    Smp.onChange(() => { apply(); draw(); });
    $('tList').onclick = async e => {
      const id = e.target.dataset.play || e.target.dataset.del; if (!id) return;
      if (e.target.dataset.del) return Smp.remove(id);
      try { const blob = await Smp.clip(id); if (blob) new Audio(URL.createObjectURL(blob)).play(); } catch (er) { msg('Could not play that clip.', 'bad'); }
    };
    $('tUse').onchange = () => { Smp.use = $('tUse').checked; };
    $('tReset').onclick = async () => {
      if (!Smp.list.length || !confirm('Delete all ' + Smp.list.length + ' taught samples on this device?')) return;
      await Smp.clear(); msg('All samples deleted.');
    };
    $('tExport').onclick = () => { Smp.download(); msg('Exported ' + Smp.list.length + ' samples (fingerprints only, no audio).', 'ok'); };
    $('tImport').onclick = () => $('tImportFile').click();
    $('tImportFile').onchange = async e => {
      const f = e.target.files[0]; e.target.value = ''; if (!f) return;
      try { msg('Imported ' + Smp.merge(Smp.parse(await f.text())) + ' new samples.', 'ok'); } catch (er) { msg('Import failed: ' + er.message, 'bad'); }
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
      const smp = { id: Smp.newId(), tag, x: fp.x, f0: +fp.raw.f0.toFixed(1), t: Date.now(), from: 'teach' };
      await Smp.add(smp, rec && chunks.length ? new Blob(chunks, { type: rec.mimeType }) : null);
      msg('Saved: ' + TAGS.find(t => t.id === tag).label + ' @ ' + Math.round(fp.raw.f0) + ' Hz. ' + Smp.list.filter(x => x.tag === tag).length + ' sample(s) of this kind.', 'ok');
    };
    draw();
    return { apply, setDet, get samples() { return Smp.list; }, count: Smp.count };
  })();
  window.__teach = Teach;

  // ---------- the map: this phone (+ phones in a room) or the demo ----------
  let room = '', hub = null, sim = null, workings = false;
  const posKey = () => 'rotorear-pos-' + (room || 'solo'), calKey = () => 'rotorear-cal-' + (room || 'solo');
  const loadCal = () => { try { return JSON.parse(localStorage.getItem(calKey()) || '{}'); } catch (e) { return {}; } };
  let saved = JSON.parse(localStorage.getItem(posKey()) || '{}'), model = new R.MeshModel(saved, loadCal());
  const activeModel = () => sim ? sim.model : model;
  const view = R.MapView($('map'), { colors: () => cols, project: dpr => project(dpr), onDrag: (k, p, done) => { const m = activeModel(), n = m.nodes.get(k); if (!n) return; n.pos = p; n.userMoved = true;
    if (done && !sim) { saved[k] = p; localStorage.setItem(posKey(), JSON.stringify(saved)); } } });
  $('workings').onchange = () => workings = $('workings').checked;
  // coverage circles: each phone's estimated hearing radius (from its own background noise), gaps shaded
  let cover = localStorage.getItem('rotorear-cover') !== '0';
  $('covOn').checked = cover; $('covOn').onchange = () => { cover = $('covOn').checked; localStorage.setItem('rotorear-cover', cover ? '1' : '0'); };
  $('covNote').textContent = 'Shaded = no phone would hear a drone there. ' + RotorEar.COVER.text + ' Updates every few seconds.';
  const rangeOf = n => n.hr ? (n.hr >= RotorEar.COVER.maxM ? '300+ m' : n.hr <= RotorEar.COVER.minM ? 'under 2 m (noisy)' : '~' + n.hr + ' m') : 'measuring…';
  function sendLocal() { // this phone is a node of its own map (in-page, no network): numbers only
    if (!det || !listening()) return;
    const now = performance.now();
    model.ingest({ t: 'pong', k: ME, ts: now, tn: now }, now);
    const ev = tap ? tap.take() : null; // envelope peaks / onsets heard during our own alert tone are dropped
    const on = tap ? tap.takeOnsets() : null, quiet = now < gateUntil + 300;
    const m = R.telemetry(det.out, ME, 'this phone', null, quiet ? null : ev, quiet ? null : on); if (geoMe) m.g = geoMe;
    model.ingest(m, now);
  }

  // Session library: what the room's ears labelled (fingerprint numbers + label only), kept per room on this screen.
  // "Add all to Teach" makes them this screen's own taught samples; Export writes the Teach file format.
  const Lib = (() => {
    const Smp = window.RotorSamples, k = () => 'rotorear-lib-' + (room || 'solo'); let L = [];
    function draw() {
      setText('libN', L.length ? '· ' + L.length : '');
      $('libList').innerHTML = L.slice().reverse().map(x => `<div><span>${esc(Smp.name(x))} <small>· ${Math.round(x.f0)} Hz · phone ${esc(x.by)} · ${clock(x.t)}${Smp.list.some(y => y.id === x.id) ? ' · in Teach' : ''}</small></span><span></span><span></span></div>`).join('')
        || '<p class="note">Nothing yet. On an ear, tap a label during or right after a detection.</p>';
    }
    Smp.onChange(draw);
    return {
      load() { try { L = JSON.parse(localStorage.getItem(k()) || '[]').filter(Smp.valid); } catch (e) { L = []; } draw(); },
      add(d) { // { t: 'label', k: ear key, smp }: keep only the numbers + label, once per id
        if (!Smp.valid(d.smp) || L.some(x => x.id === d.smp.id)) return; const n = model.nodes.get(d.k);
        L.push(Object.assign(Smp.share(d.smp), { by: n ? n.label : '?' })); localStorage.setItem(k(), JSON.stringify(L)); draw();
      },
      get list() { return L; },
      toTeach() { return Smp.merge(L); },
    };
  })();
  $('libAdd').onclick = () => { const n = Lib.toTeach(); setText('tMsg', n ? `Added ${n} labelled sample${n > 1 ? 's' : ''} to Teach.` : 'Nothing new to add.'); };
  $('libExport').onclick = () => window.RotorSamples.download(Lib.list, 'rotor-ear-library-' + (room || 'solo'));
  Lib.load(); window.__lib = Lib;
  // Phones: this screen hosts the room's map; other phones open the join link ?room=… (ear mode)
  const nodeUrl = r => location.href.split(/[?#]/)[0] + '?room=' + r;
  let hubStatus = '';
  function joinRoom(r) {
    if (!r || hub) return;
    room = r; history.replaceState(null, '', location.pathname + '#screen&room=' + r); window.RotorApp.key = 'screen|' + r;
    saved = JSON.parse(localStorage.getItem(posKey()) || '{}'); model = new R.MeshModel(saved, loadCal());
    $('pNone').hidden = true; $('pRoom').hidden = false; $('pLeave').hidden = false; $('pRoomCode').textContent = r; $('pLink').value = nodeUrl(r);
    Lib.load();
    hub = R.startHub(r, { status: s => { hubStatus = s; }, viewer: () => {}, data: (c, d) => { if (d && d.t === 'clip') return clipFlag(d); if (d && d.t === 'bob') return bobFlag(d); if (d && d.t === 'label') return Lib.add(d); const n = model.ingest(d); if (n && d.t === 's') c.nodeLabel = n.label; } });
  }
  $('pCreate').onclick = () => joinRoom(R.randKey(4));
  $('pJoin').onclick = () => joinRoom($('pCode').value.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12));
  $('pCopy').onclick = () => { navigator.clipboard && navigator.clipboard.writeText($('pLink').value); $('pCopy').textContent = 'Copied'; };
  $('pShare').onclick = () => { if (!hub) joinRoom(R.randKey(4)); const url = $('pLink').value; navigator.share ? navigator.share({ title: 'Rotor Ear listening phone', url }).catch(() => {}) : $('pCopy').onclick(); };
  $('pLeave').onclick = () => { location.hash = 'screen'; location.reload(); };

  // Linked watch posts: screens that joined one link code swap only track numbers, twice a second: drone id (shared across
  // posts), position in a shared frame, class, pitch, time. The frame is GPS (lat/lon) when both posts have it, else each
  // post's manual East/North offset and turn. Other posts' drones are drawn faded; a drone that leaves one post and turns up
  // at another (pitch within 8 %, seen there in the last 20 s, position plausible) keeps its id: a hand-off, one incident id.
  const Link = (() => {
    const K = 'rotorear-link', me = R.randKey(5), cfg = Object.assign({ code: '', name: '', e: 0, n: 0, rot: 0 }, (() => { try { return JSON.parse(localStorage.getItem(K) || '{}'); } catch (e) { return {}; } })());
    let net = null, status = '', sentAt = 0, note = null; const posts = {}, seen = {}, told = {}; // seen[gid]: last sighting at another post, in our frame
    const ang = () => cfg.rot * Math.PI / 180;
    const toShared = (x, y) => { const c = Math.cos(ang()), s = Math.sin(ang()); return [+(c * x - s * y + cfg.e).toFixed(2), +(s * x + c * y + cfg.n).toFixed(2)]; };
    const fromShared = (x, y) => { const c = Math.cos(ang()), s = Math.sin(ang()); x -= cfg.e; y -= cfg.n; return [c * x + s * y, -s * x + c * y]; };
    const short = g => '#' + String(g).slice(-4);
    const fill = () => { $('lkCode').value = cfg.code; $('lkName').value = cfg.name; $('lkE').value = cfg.e; $('lkN').value = cfg.n; $('lkR').value = cfg.rot; $('lkGo').textContent = net ? 'Unlink' : 'Link'; };
    const save = () => localStorage.setItem(K, JSON.stringify(cfg));
    function data(d) {
      if (!d || d.t !== 'post' || d.p === me) return;
      const P = posts[d.p] = { name: String(d.name || 'post').slice(0, 16), at: Date.now(), demo: !!d.demo, tr: [] };
      (d.tr || []).slice(0, 8).forEach(q => {
        const xy = q.ll && geoF ? geoF.fromLatLng(q.ll[0], q.ll[1]) : isFinite(q.sx) && isFinite(q.sy) ? fromShared(q.sx, q.sy) : null; if (!xy) return;
        const r = { g: String(q.g), x: xy[0], y: xy[1], cls: String(q.cls || 'Drone'), f0: +q.f0 || 0, z: q.z == null ? null : +q.z, post: d.p, name: P.name, at: P.at };
        P.tr.push(r); seen[r.g] = r;
      });
    }
    function start() {
      cfg.code = $('lkCode').value.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12); cfg.name = $('lkName').value.trim().slice(0, 16) || 'Post ' + me.slice(0, 2).toUpperCase();
      if (!cfg.code) { setText('lkMsg', 'Type a link code first (the same on every post).'); return; }
      save(); net = R.linkPosts(cfg.code, me, { status: s => status = s, data }); fill();
    }
    $('lkGo').onclick = () => { if (net) { net.stop(); net = null; status = ''; cfg.code = ''; save(); fill(); } else start(); };
    ['lkE', 'lkN', 'lkR'].forEach(id => $(id).onchange = () => { cfg.e = +$('lkE').value || 0; cfg.n = +$('lkN').value || 0; cfg.rot = +$('lkR').value || 0; save(); });
    fill(); if (cfg.code) start();
    return {
      get on() { return !!net; },
      get name() { return cfg.name; },
      live: () => Object.values(posts).filter(p => Date.now() - p.at < 5000),
      // twice a second: our drones (those with a position) in the shared frame
      tick(drones, demo) {
        const t = Date.now(); if (!net || t - sentAt < 500) return; sentAt = t;
        net.send({ t: 'post', p: me, name: cfg.name, at: t, demo, tr: drones.filter(d => d.est && d.inc).map(d => Object.assign({ g: d.inc.gid, sx: toShared(d.est[0], d.est[1])[0], sy: toShared(d.est[0], d.est[1])[1], cls: d.cls, f0: Math.round(d.f0), z: d.h && d.h.ok ? d.h.z : null },
          geoF ? { ll: geoF.toLatLng(d.est[0], d.est[1]).map(v => +v.toFixed(7)) } : {})) });
      },
      // a new drone here: the same one another post had in the last 20 s? → its id and that post's name
      match(d) {
        const t = Date.now(); let best = null, bs = 1e9;
        Object.values(seen).forEach(r => { const age = (t - r.at) / 1000, df = Math.abs(r.f0 - d.f0) / (d.f0 || 1); if (age > 20 || df > 0.08) return;
          if (d.est && Math.hypot(d.est[0] - r.x, d.est[1] - r.y) > 15 + 25 * age) return; // faster than 25 m/s: not the same drone
          const sc = df / 0.08 + age / 20; if (sc < bs) { bs = sc; best = r; } });
        return best;
      },
      say(text) { note = { text, until: performance.now() + 8000 }; },
      // other posts' drones to draw (not the ones we have ourselves) · "handed off to …" once per drone of ours that went there
      remote(mine) {
        const out = [], ids = mine.map(d => d.inc && d.inc.gid);
        this.live().forEach(p => p.tr.forEach(r => {
          if (!ids.includes(r.g)) out.push({ x: r.x, y: r.y, label: p.name + ' ' + short(r.g) + (p.demo && !sim ? ' · demo' : ''), g: r.g, name: p.name });
          const e = Log.list.find(x => x.gid === r.g && x.type === 'drone');
          if (e && !ids.includes(r.g) && !told[r.g] && e.from !== p.name) { told[r.g] = 1; e.to = p.name; Log.save(true); this.say(`⇄ Drone ${short(r.g)} handed off to ${p.name}`); }
        }));
        return out;
      },
      get note() { return note && performance.now() < note.until ? note.text : ''; },
      get state() { const n = this.live().length; return net ? `· ${esc(cfg.name)} · ${n ? 'linked with ' + this.live().map(p => esc(p.name)).join(', ') : esc(status || 'connecting…')}` : ''; },
      short,
    };
  })();
  window.__link = Link;

  // Demo: 4 simulated phones + a scripted drone on this screen (real sound delays, clock offsets, jitter, network
  // delay). Marked DEMO the whole time: stripe, "DEMO · DRONE", hatched marker, demo tone, DEMO timeline rows.
  function startDemo(hp) {
    if (sim) return;
    ensureCtx(); openSheet(null);
    const eng = new R.SimEngine(ctx, { n: 4, path: hp.get('path') || 'demo', speed: +(hp.get('speed') || 1), biasMs: +(hp.get('bias') || 0), gainDb: +(hp.get('gain') || 0), jitterMs: +(hp.get('jit') || 1),
      alt: +(hp.get('alt') || 1.5), side: +(hp.get('side') || 6), loud: +(hp.get('loud') || 0), ox: +(hp.get('ox') || 0) }); // alt: the drone's height (m) on the non-scripted paths; side: the phones' square (m); loud: dB louder drone; ox: this post's place on the 'cross' line
    const m = new R.MeshModel({}), links = eng.nodes.map(n => new R.LoopLink(m, n));
    eng.nodes.forEach(n => { Teach.setDet(n.det); n.det.blades = blades; });
    sim = { eng, model: m, links, t0: performance.now() }; ws.reset(); calib = null;
    sim.iv1 = setInterval(() => { const now = performance.now(); eng.step(now); m.truth = eng.truth(); m.truthAt = now; }, 50);
    sim.iv2 = setInterval(() => { const msgs = eng.messages(); links.forEach((l, i) => l.send(msgs[i])); }, 1000 / R.SEND_HZ);
    sim.iv3 = setInterval(() => { const ts = performance.now(); links.forEach(l => l.ping(ts)); }, 1000);
    keepAwake();
  }
  function stopDemo() { if (!sim) return; clearInterval(sim.iv1); clearInterval(sim.iv2); clearInterval(sim.iv3); sim.eng.stop(); sim = null; ws.reset(); calib = null; }
  const replayDemo = () => { if (sim) { sim.eng.replay(); ws.reset(); } };
  const App = window.RotorApp;
  $('tryDemo').onclick = $('mDemo').onclick = () => App.go(sim ? 'screen' : 'demo');
  $('mDemo2').onclick = () => { if (sim) App.go('screen'); App.go('demo&path=two'); }; // runs until Exit demo
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
    leave() { inc = hum = replay = null; Log.save(true); stopDemo(); $('tapStart').hidden = true; if (micStream) toggleMic(); stopTest(); stopFile(); if (sheet) openSheet(null); },
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
    setHTML('lkState', Link.state);
    setText('pStatus', sim ? 'DEMO · ' + live.length + ' simulated phones' : hub ? 'Room ' + room.toUpperCase() + ' · ' + live.length + ' connected' + (hubStatus && !live.length ? ' · ' + hubStatus : '') : 'this phone only');
    const rows = [...live].sort((a, b) => a.label < b.label ? -1 : 1).map(n => { const k = cal[n.key], [w, f] = resWord(k), sync = n.key === ME ? 'this phone' : n.rtt != null ? 'sync ±' + Math.round(n.rtt / 2) + ' ms' : 'syncing…';
      return `<div class="prow"><span class="pin">${n.label}</span><span class="nm"><b>${n.key === ME ? 'This phone' : esc(n.name || 'Phone ' + n.label)}</b><small>hears ${rangeOf(n)} · ${sync}${k ? ` · latency ${k.lat >= 0 ? '+' : ''}${k.lat.toFixed(1)} ms · gain ${k.gain >= 0 ? '+' : ''}${k.gain.toFixed(1)} dB` : ''}</small>` +
        `<span class="rbar"><i><u style="width:${Math.round(Math.min(1, f) * 100)}%"></u></i>${w}</span></span>${k && k.resMs >= 6 ? '<button data-redo>Redo</button>' : '<span></span>'}</div>`; }).join('');
    if (rows !== calKeyStr) { calKeyStr = rows; $('cTable').innerHTML = rows; }
    return { ncal };
  }
  // ---------- what the phones hear, in words ----------
  const compass = (dx, dy) => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(((Math.atan2(dx, dy) * 180 / Math.PI) + 360) % 360 / 45) % 8];
  const humWord = w => ({ 'steady hum (fan / AC / mains)': 'Fan / AC hum', 'mains hum (50/60 Hz)': 'Mains hum', 'engine (low, irregular)': 'Engine noise' })[w] || (w ? w[0].toUpperCase() + w.slice(1).replace(/ \(your samples\)/, '') : 'Steady hum');
  const shortFl = f => (f || '').replace('Heavy / loaded', 'Loaded').replace(' (Doppler)', '');
  const kRpm = r => r >= 1000 ? (r / 1000).toFixed(1) + 'k rpm' : Math.round(r) + ' rpm';
  function whereOf(est, live) { // { dir: 'NE of phone B', where: 'NE of phone B · ~4 m' } from the nearest phone
    const p = live.reduce((a, n) => Math.hypot(n.pos[0] - est[0], n.pos[1] - est[1]) < Math.hypot(a.pos[0] - est[0], a.pos[1] - est[1]) ? n : a, live[0]);
    const dx = est[0] - p.pos[0], dy = est[1] - p.pos[1], r = Math.hypot(dx, dy), dir = r < 1.5 ? 'at phone ' + p.label : compass(dx, dy) + ' of phone ' + p.label;
    return { dir, where: dir + (r >= 1.5 ? ' · ~' + Math.round(r) + ' m' : '') };
  }
  // every drone heard right now (two at once): mesh = the confirmed tracks; one phone = its detector's drone sources
  const soloSlot = {};
  function dronesOf(st, live, D) {
    if (D.mesh) return st.tracks.filter(t => t.hot).map(t => Object.assign({ key: 't' + t.id, slot: t.slot, f0: t.f0, cls: t.label || 'Drone', score: t.score, nAgree: t.voters, agree: `${t.voters} of ${live.length} phones agree`,
      flight: t.flight, rpm: t.f0 * 60 / blades, est: t.est, h: t.h, tz: t.herr != null ? t.h.z - t.herr : null, lead: t.id === st.lead, why: whyOf(t.agree, live) }, t.est ? whereOf(t.est, live) : { dir: '', where: '' }));
    const os = det && listening() ? det.outs.filter(o => o.state === 'drone') : [];
    Object.keys(soloSlot).forEach(k => { if (!os.some(o => 's' + o.id === k)) delete soloSlot[k]; });
    return os.map(o => { const key = 's' + o.id; if (soloSlot[key] == null) soloSlot[key] = Object.values(soloSlot).includes(0) ? 1 : 0;
      return { key, slot: soloSlot[key], f0: o.f0, cls: o.cls ? o.cls.label : 'Drone', score: o.cls ? o.cls.conf : 0, nAgree: 1, agree: 'this phone only', flight: o.flight && o.flight.state, rpm: o.flight ? o.flight.rpm : 0, est: null, dir: '', where: '', lead: o === det.out, why: o.why }; });
  }
  // the reason in words for what these phones hear: the surest phone that sent a fingerprint (else a sound summary)
  function whyOf(keys, live) {
    const c = live.filter(n => (!keys || keys.includes(n.key)) && (n.fx || n.sn)).sort((a, b) => !!b.fx - !!a.fx || b.c * (b.cp || 1) - a.c * (a.cp || 1))[0];
    return c ? whyFrom(c) : null;
  }
  function describe(st, live) {
    const mesh = !!sim || live.some(n => n.key !== ME), o = det && det.out, c = o && o.cls, D = { mesh, n: live.length };
    if (mesh) {
      D.raw = st.banner === 'off' ? 'quiet' : st.banner; D.cls = st.label; D.score = st.score; D.hz = st.f0;
      D.agree = st.voters ? `${st.voters} of ${live.length} phones agree` : '';
      D.learned = st.learned ? `Tuned by your taught samples on ${st.learned} phone${st.learned > 1 ? 's' : ''}` : '';
      const hear = live.filter(n => n.c >= 30 && n.st !== 'hum').map(n => n.label);
      D.hear = hear.length === 1 ? `Phone ${hear[0]} hears a harmonic hum` : hear.length ? `Phones ${hear.join(', ')} hear a harmonic hum` : 'A phone hears a harmonic hum';
      const hum = live.filter(n => n.st === 'hum').sort((a, b) => b.e - a.e)[0]; /* loudest = nearest */ D.hum = hum ? `${humWord(hum.wy)} near phone ${hum.label}` : 'Steady hum'; D.humWhy = hum ? hum.wy : ''; D.humAt = hum ? hum.label : '';
      D.why = D.raw === 'drone' ? whyOf(st.agree, live) : hum ? whyFrom(hum) : whyOf(null, live);
      if (st.est) {
        Object.assign(D, whereOf(st.est, live));
        const A = live.filter(n => st.agree.includes(n.key)), tr = A.length ? A.reduce((a, n) => a + n.trendDB, 0) / A.length : 0;
        D.trend = tr > 1 ? 'getting closer' : tr < -1 ? 'moving away' : '';
      }
      D.rough = !!st.est && live.length >= 3 && !st.tdoaOk;
      D.flight = st.flight; D.rpm = st.f0 * 60 / blades; D.heading = st.heading ? compass(st.heading[0], st.heading[1]) : '';
    } else {
      D.raw = o && listening() ? o.state : 'off'; D.cls = c ? c.label : ''; D.score = c ? c.conf : 0; D.hz = o ? o.f0 : 0;
      D.agree = 'this phone only';
      D.learned = c && c.learned ? `Matched your taught samples (${Teach.count(c.label)} ${c.label})` : '';
      D.hear = 'This phone hears a harmonic hum'; D.hum = c && !c.drone ? humWord(c.why) : 'Steady hum'; D.humWhy = c ? c.why : ''; D.why = o && listening() ? o.why : null;
      const me = live.find(n => n.key === ME), tr = me ? me.trendDB : 0;
      D.trend = tr > 1.5 ? 'getting closer' : tr < -1.5 ? 'moving away' : 'same distance';
      D.flight = o && o.flight && o.flight.state; D.rpm = o && o.flight ? o.flight.rpm : 0;
    }
    const word = (cls, score, n) => cls ? (D.mesh && n < 2 && likelihood(score) === 'very likely' ? 'likely' : likelihood(score)) : '';
    D.word = word(D.cls, D.score, st.voters);
    D.drones = dronesOf(st, live, D); D.drones.forEach(d => d.word = word(d.cls, d.score, d.nAgree));
    return D;
  }

  // ---------- incident log (log.js): one entry per drone / not-a-drone episode, on this phone only ----------
  const Log = window.RotorLog;
  let inc = null, hum = null, replay = null;
  // each drone of an episode gets its own incident; a drone that drops out and comes back within 60 s at the same
  // pitch (±8%) keeps its incident (and its alert), and so does one whose sound is replaced by another within 3 s
  // (a sudden pitch jump, not a second drone). inc = the lead drone's incident.
  let known = [];
  function newIncident(d, live, demo) {
    return Log.add({ id: Log.newId(), type: 'drone', t0: Date.now(), t1: Date.now(), cls: d.cls, peak: d.score || 0, agree: d.agree, nAgree: d.nAgree || 1, flights: [], track: [], dir: '', demo, room, slot: d.slot || 0, f0: Math.round(d.f0),
      pins: live.map(n => ({ label: n.label, pos: n.pos.slice() })), geo: geoF ? { lat0: geoF.lat0, lon0: geoF.lon0, rot: +geoF.rot.toFixed(4) } : null, clips: [] });
  }
  function trackDrones(list, live, now, demo) { // → number of drones new to this episode
    let fresh = 0;
    list.forEach(d => {
      const gone = x => !list.some(y => y.key === x.key);
      let k = known.find(x => x.key === d.key) || known.find(x => gone(x) && Math.abs(x.f0 - d.f0) / x.f0 < 0.08 && now - x.last < 60000)
        || known.find(x => gone(x) && now - x.last < 3000); // one sound swapped for another within 3 s: the same drone changing pitch
      if (!k) { k = { inc: newIncident(d, live, demo) }; known.push(k); fresh++;
        const r = Link.on && Link.match(d); k.inc.gid = r ? r.g : k.inc.id; // one id for one drone across linked posts
        if (r) { k.inc.from = r.name; Link.say(`⇄ Hand-off from ${r.name}: drone ${Link.short(r.g)}`); } }
      Object.assign(k, { key: d.key, f0: d.f0, last: now }); d.inc = k.inc;
      const e = k.inc; e.t1 = Date.now(); e.slot = d.slot; if (d.dir) e.dir = d.dir; if (d.why && d.why.drone) e.why = { id: d.why.id, text: d.why.text }; if (d.cls !== 'Drone' || !e.cls) e.cls = d.cls; e.peak = Math.max(e.peak, d.score || 0);
      if ((d.nAgree || 1) > e.nAgree) { e.nAgree = d.nAgree; e.agree = d.agree; }
      const f = shortFl(d.flight); if (f && !e.flights.includes(f)) e.flights.push(f);
      const h = d.h && d.h.ok ? d.h : null; if (h) e.h = { z: h.z, lo: h.lo, hi: h.hi };
      if (d.est) Log.point(e, d.est[0], d.est[1], h && h.z);
    });
    const L = list.find(d => d.lead) || list[0]; if (L) inc = L.inc;
    return fresh;
  }
  function lastDrone() {
    const e = Log.list.find(x => x.type === 'drone'); if (!e) return '';
    const d = new Date(e.t0), days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(e.t0).setHours(0, 0, 0, 0)) / 864e5);
    return `Last drone ${clock(e.t0)}${e.dir ? ' · ' + e.dir : ''}${e.demo ? ' (demo)' : ''}${days === 1 ? ' (yesterday)' : days > 1 ? ' (' + d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ')' : ''}`;
  }
  let tlKey = '', logKey = '';
  function drawTimeline() {
    const html = Log.list.length ? Log.list.slice(0, 3).map(e => Log.row(e)).join('') : '<div class="lempty">No detections yet. Each drone gets one entry.</div>';
    if (html !== tlKey) { tlKey = html; $('tlList').innerHTML = html; }
    if (sheet !== 'logS') return;
    const all = Log.list.map(e => Log.row(e)).join('') || '<div class="lempty">Nothing logged yet.</div>';
    if (all !== logKey) { logKey = all; $('logList').innerHTML = all; setText('logN', Log.list.length + ' saved'); }
  }
  $('openLog').onclick = $('mLog').onclick = () => openSheet('logS');
  $('lExport').onclick = () => Log.exportJSON();
  $('lReport').onclick = () => Log.openReport();
  $('lClear').onclick = () => { if (confirm('Delete all ' + Log.list.length + ' log entries on this phone? This can\'t be undone.')) { Log.clear(); inc = hum = replay = null; logKey = tlKey = ''; } };
  // tap an incident: replay its track on the map (sped up to ~12 s)
  const onRow = e => { const b = e.target.closest('[data-inc]'); if (b) startReplay(b.dataset.inc); };
  $('tlList').onclick = $('logList').onclick = onRow;
  function startReplay(id) {
    const e = Log.get(id); if (!e) return;
    if (!e.track || e.track.length < 2) { setText('logN', 'no track for that one (a single phone can\'t place a drone)'); return; }
    replay = { e, t0: performance.now(), len: e.track[e.track.length - 1][0] }; openSheet(null);
  }
  $('replayX').onclick = () => { replay = null; };
  function clipFlag(d) { // an ear says "clip saved" for an incident: just a flag, the video stays on that phone
    const e = Log.get(d.id), n = model.nodes.get(d.k); if (!e || !n) return;
    e.clips = e.clips || []; if (!e.clips.some(c => c.phone === n.label)) { e.clips.push({ phone: n.label, n: d.n || 1 }); Log.save(true); logKey = tlKey = ''; }
  }
  // Bird or Bot: that ear's verdict on its clip (numbers and codes only). A confident bird turns the alert into "likely a bird"
  // and stops the repeat beeps, but nothing is dismissed: the person still decides.
  function bobFlag(d) {
    const e = Log.get(d.id), n = model.nodes.get(d.k); if (!e || !n || !RotorBird.WORD[d.v]) return;
    const b = { v: d.v, c: Math.max(0, Math.min(100, Math.round(+d.c || 0))), r: String(d.r || '').slice(0, 10), f: Math.round(+d.f || 0), h: [1, 0, -1].includes(d.h) ? d.h : -1, a: Number.isFinite(+d.a) ? Math.round(+d.a) : -1, phone: n.label };
    if (JSON.stringify(e.bob) !== JSON.stringify(b)) { e.bob = b; Log.save(true); logKey = tlKey = ''; }
  }
  const birdy = e => !!(e && e.bob && e.bob.v === 'bird' && e.bob.c >= 70);

  // ---------- street map (Leaflet + OpenStreetMap) under the plan, anchored by GPS ----------
  let geoMe = null, geoWatch = null, geoF = null, lmap = null, tiles = { ok: 0, bad: 0 }, geoOn = localStorage.getItem('rotorear-geomap') === '1', geoFit = 0, geoMsg = '';
  $('geoMap').checked = geoOn;
  $('geoMap').onchange = () => { geoOn = $('geoMap').checked; localStorage.setItem('rotorear-geomap', geoOn ? '1' : '0'); tiles = { ok: 0, bad: 0 }; };
  $('geoMe').onchange = () => {
    if (!$('geoMe').checked) { if (geoWatch != null) navigator.geolocation.clearWatch(geoWatch); geoWatch = null; geoMe = null; return; }
    if (!navigator.geolocation) { geoMsg = 'This browser has no GPS access.'; $('geoMe').checked = false; return; }
    geoWatch = navigator.geolocation.watchPosition(p => { geoMe = [+p.coords.latitude.toFixed(6), +p.coords.longitude.toFixed(6), Math.round(p.coords.accuracy)]; geoMsg = ''; },
      e => { geoMsg = 'GPS: ' + (e.code === 1 ? 'permission denied' : 'no fix yet'); }, { enableHighAccuracy: true, maximumAge: 5000 });
  };
  const tilesFailed = () => tiles.bad >= 3 && tiles.bad > tiles.ok * 4; // most tiles failing (offline, blocked host): plain map
  let leafletP = null;
  const loadLeaflet = () => leafletP || (leafletP = new Promise((ok, no) => {
    const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = 'lib/leaflet.css'; document.head.appendChild(css);
    const js = document.createElement('script'); js.src = 'lib/leaflet.js'; js.onload = ok; js.onerror = no; document.head.appendChild(js);
  }));
  function geoTick(st, live) { // every frame: GPS frame from the live phones; show / fit the street map when it can be used
    const pts = live.filter(n => n.geo).sort((a, b) => a.label < b.label ? -1 : 1).map(n => ({ pos: n.pos, geo: n.geo }));
    geoF = !sim && pts.length ? R.Geo.frame(pts) : null;
    const use = geoOn && geoF && !tilesFailed();
    $('geomap').hidden = !(use && lmap); $('mapbox').classList.toggle('geo', !!(use && lmap));
    if (!use) return;
    if (!lmap) { loadLeaflet().then(() => { if (lmap) return;
      lmap = L.map('geomap', { zoomControl: false, dragging: false, scrollWheelZoom: false, doubleClickZoom: false, touchZoom: false, boxZoom: false, keyboard: false, zoomSnap: 0, maxZoom: 22, fadeAnimation: false });
      L.tileLayer(window.ROTOREAR_TILES || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxNativeZoom: 19, maxZoom: 22, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' })
        .on('tileload', () => tiles.ok++).on('tileerror', () => tiles.bad++).addTo(lmap);
      lmap.setView(geoF.toLatLng(3, 3), 19); geoFit = 0; }).catch(() => { tiles.bad = 99; geoMsg = 'Street map library failed to load: plain map.'; }); return; }
    const now = performance.now(); if (now - geoFit < 1000) return; geoFit = now;
    lmap.invalidateSize(false);
    const ps = st.nodes.map(n => n.pos).concat(st.est ? [st.est] : [], replay ? replay.e.track.map(p => [p[1], p[2]]) : []).map(p => geoF.toLatLng(p[0], p[1]));
    lmap.fitBounds(L.latLngBounds(ps).pad(0.25), { animate: false, maxZoom: 21, padding: [24, 24] });
  }
  const project = dpr => {
    if (!lmap || $('geomap').hidden || !geoF) return null;
    const W2P = (x, y) => { const q = lmap.latLngToContainerPoint(geoF.toLatLng(x, y)); return [q.x * dpr, q.y * dpr]; }, a = W2P(0, 0), b = W2P(10, 0);
    return { W2P, P2W: (px, py) => { const ll = lmap.containerPointToLatLng([px / dpr, py / dpr]); return geoF.fromLatLng(ll.lat, ll.lng); }, k: Math.hypot(b[0] - a[0], b[1] - a[1]) / 10 };
  };

  window.__mapNodes = () => activeModel().state.nodes.map(n => ({ label: n.label, name: n.name || '', pos: n.pos, geo: n.geo })); // tests
  window.__geo = { get frame() { return geoF; }, get map() { return lmap; }, project, get shown() { return !$('geomap').hidden; }, get tiles() { return tiles; } };
  window.__log = { get replay() { return replay && { id: replay.e.id, len: replay.len }; }, get inc() { return inc; } };

  // ---------- camera confirm: ask the ear nearest the drone to look (it records; only a flag comes back) ----------
  let lookAt = 0;
  function lookWords(n, live, est) { // the direction from that ear in words, relative to the other phones
    const ang = (a, b) => Math.atan2(b[0] - a[0], b[1] - a[1]), da = ang(n.pos, est), diff = x => Math.abs(((x - da) * 180 / Math.PI + 540) % 360 - 180);
    const o = live.filter(m => m.key !== n.key).map(m => ({ m, d: diff(ang(n.pos, m.pos)) })).sort((a, b) => a.d - b.d);
    const r = Math.round(Math.hypot(est[0] - n.pos[0], est[1] - n.pos[1]));
    if (!o.length) return '~' + r + ' m away';
    return (o[0].d < 25 || o.length < 2 ? 'toward phone ' + o[0].m.label : 'between phone ' + o[0].m.label + ' and phone ' + o[1].m.label) + ' · ~' + r + ' m away';
  }
  function askLook(st, live, now) { // the ear nearest the estimate at confirm time keeps the prompt for this incident
    if (!hub || !inc || !st.est || now - lookAt < 1000) return; lookAt = now;
    const ears = live.filter(n => n.key !== ME && !/^sim /.test(n.name || '')); if (!ears.length) return;
    const n = ears.find(m => m.label === inc.asked) || ears.reduce((a, m) => Math.hypot(m.pos[0] - st.est[0], m.pos[1] - st.est[1]) < Math.hypot(a.pos[0] - st.est[0], a.pos[1] - st.est[1]) ? m : a);
    const b = geoF ? Math.round(geoF.bearing(st.est[0] - n.pos[0], st.est[1] - n.pos[1])) : null;
    hub.sendTo(n.key, { t: 'look', id: inc.id, t0: inc.t0, cls: inc.cls, demo: inc.demo, b, w: lookWords(n, live, st.est) });
    inc.asked = n.label;
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
    // alert moment (see raiseAlert()); then 1 beep every 10 s until Got it
    if (ws.ev === 'alert') {
      lastDir = lastHead = ''; raiseAlert(now, demo); replay = null; known = [];
      if (!D.drones.length) D.drones = [{ key: 'lead', slot: 0, f0: D.hz || 0, cls: D.cls || 'Drone', score: D.score, nAgree: st.voters || 1, agree: D.agree, flight: D.flight, dir: D.dir, est: st.est, lead: true }];
    }
    if (ws.ev === 'back') nextBeep = now + REPEAT_MS; // back within 60 s: no new alert sound
    if (s === 'drone' && now > nextBeep) { nextBeep = now + REPEAT_MS; if (!muted() && !birdy(inc)) tone(demo ? 'demo' : 'alert', 1); } // the camera says bird: no repeat beeps
    if (ws.ev === 'lost') { if (!muted()) tone('lost', 1); lostInfo = { pos: lastEst, dir: lastDir, heading: lastHead }; }
    if (ws.ev === 'gone') { inc = null; known = []; Log.save(true); }
    if (hot) {
      // a second drone while the first is still up: its own alert (flash, tone, buzz, un-acknowledged)
      if (trackDrones(D.drones, live, now, demo) && ws.ev !== 'alert') { ws.again(); raiseAlert(now, demo); }
      if (inc) askLook(st, live, now); Log.save();
    }
    Link.tick(hot ? D.drones : [], demo); // after trackDrones: each drone has its incident (and shared id) now
    if (s === 'notdrone' && prevS !== 'notdrone') hum = Log.add({ id: Log.newId(), type: 'hum', t0: Date.now(), t1: Date.now(), cls: 'Not a drone' + (D.hum ? ' · ' + humWord(D.humWhy) : ''), dir: D.humAt ? 'phone ' + D.humAt : '', demo, room, track: [], flights: [] });
    if (hum && D.raw === 'hum') { hum.t1 = Date.now(); if (D.why && !D.why.drone) hum.why = { id: D.why.id, text: D.why.text, x: D.why.bars.map(b => b.v) }; Log.save(); } else hum = null;
    prevS = s;

    $('app').classList.toggle('ready', s === 'ready'); $('app').classList.toggle('demo', demo);
    renderStatus(D, st, live, now);
    // map
    const chip = hot && D.flight ? shortFl(D.flight) + (D.rpm ? ' · ' + kRpm(D.rpm) : '') : '';
    const ring = st.truth && st.err.F != null ? st.err.F : st.estL && st.estF && st.tdoaOk ? Math.hypot(st.estL[0] - st.estF[0], st.estL[1] - st.estF[1]) : 2.5;
    const chips = {}; D.drones.forEach(d => { if (d.key[0] === 't') chips[d.key.slice(1)] = d.flight ? shortFl(d.flight) + (d.rpm ? ' · ' + kRpm(d.rpm) : '') : ''; });
    st.ui = { state: s, demo, workings, chip, chips, cover: cover && !replay, ring: Math.min(5, Math.max(0.8, ring)), me: sim ? sim.eng.nodes[0].key : ME, lost: s === 'lost' && lostInfo ? { pos: lostInfo.pos, ago: mmss(now - ws.lastSeen) } : null };
    if (replay && hot) replay = null;
    if (replay) {
      const e = replay.e, k = Math.max(1, replay.len / 12), t = Math.min(replay.len, (now - replay.t0) / 1000 * k);
      st.ui.replay = { track: e.track, t, chip: 'replay ' + clock(e.t0) + ' · ' + mmss(t * 1000) + ' / ' + mmss(replay.len * 1000) };
      if (!live.length && e.pins && e.pins.length) Object.assign(st, { solo: null, nodes: e.pins.map(p => ({ key: 'r' + p.label, label: p.label, pos: p.pos, age: 0, c: 0, f: 0, st: 'quiet', trendDB: 0 })) });
      setText('replayT', 'REPLAY · ' + clock(e.t0) + ' · ' + (e.cls || 'Drone') + (e.demo ? ' · DEMO' : ''));
    }
    $('replayBar').hidden = !replay;
    if (!st.label && !D.mesh) st.label = D.cls; // solo marker text
    st.remote = Link.on ? Link.remote(hot ? D.drones : []) : [];
    $('handoff').hidden = !Link.note; setText('handoff', Link.note);
    geoTick(st, live);
    if (!st.nodes.length && !sim && !hub) Object.assign(st, { solo: ME, nodes: [{ key: ME, label: 'A', pos: [0, 0], age: 0, c: 0, f: 0, st: 'quiet', trendDB: 0 }] }); // not listening yet: show this phone
    view.set(st);
    const cal = renderCal(st, live);
    const lk = Link.on ? ' · ' + esc(Link.name) + (Link.live().length ? ' ⇄ ' + Link.live().map(p => esc(p.name)).join(', ') : '') : '';
    $('mapTag').innerHTML = replay && !live.length ? 'MAP · replay of a logged track' : demo ? `<span>DEMO · simulated phones${lk}</span>` : D.mesh ? `MAP · ${live.length} phones${st.calTrusted ? ' · calibrated' : ''}${!$('geomap').hidden ? ' · street map' : ''}${lk}` : 'MAP · this phone only until others join' + lk;
    $('addPhones').hidden = !!sim || !!hub || !!replay || !(s === 'ready' || s === 'watching');
    $('endCard').hidden = !(sim && sim.eng.ended);
    drawSide(hot && D.mesh && (D.drones.find(d => d.lead) || D.drones[0]), st.nodes);
    let info = '';
    if (workings && st.truth && st.err.L != null) info = `error vs true drone (10 s avg): loudness <b>${f1(st.err.L)} m</b> · arrival times <b>${f1(st.err.T)} m</b> · both <b>${f1(st.err.F)} m</b>` + (st.headErr.both != null ? ` · heading ±${st.headErr.both}°` : '') + '<br>lines = arrival-time differences · small ring = loudness-only fit · dashed = true drone';
    else if (workings && st.pairs.length) info = `${st.pairs.length} arrival-time lines · they cross where the drone is`;
    if ($('mapInfo').dataset.k !== info) { $('mapInfo').dataset.k = info; $('mapInfo').innerHTML = info; $('mapInfo').style.display = info ? 'block' : 'none'; }
    // bar: Phones · Listen/Stop · Teach
    const nPh = Math.max(1, live.length);
    setText('phonesN', sim ? '4 · demo' : nPh < 2 ? '1 · solo' : nPh + (cal.ncal >= nPh ? ' · calib ✓' : ' · not calibrated'));
    const lt = sim ? ['■ Exit demo', 'demo ' + mmss((sim.eng.length ? Math.min(sim.eng.length, sim.eng.t) : sim.eng.t) * 1000) + (sim.eng.length ? ' / ' + mmss(sim.eng.length * 1000) : '')] : listening() ? (hot ? ['■ Listening', 'tracking ' + mmss(now - ws.first)] : s === 'lost' ? ['■ Listening', 'listening for it'] : ['■ Stop listening', 'listening ' + hms(now - listenStart)])
      : hub && live.length ? ['▶ Listen here too', 'the room is watching'] : ['▶ Listen', 'tap once · sound on too'];
    setText('startT', lt[0]); setText('startS', lt[1]);
    $('pNone').hidden = !!room || !!sim; // no room controls during the demo
    if (sheet === 'phones') { const g = live.filter(n => n.geo).length;
      setText('geoMsg', (geoMsg ? geoMsg + ' ' : '') + (sim ? 'The demo has no GPS. ' : g ? `GPS from ${g} phone${g > 1 ? 's' : ''}${geoF && geoF.n > 1 ? ` · frame fit ±${geoF.res} m` : ' · one GPS phone: north is taken as up on the plan'}${tilesFailed() ? ' · map tiles failed, plain map shown' : ''}. ` : geoOn ? 'Waiting for a phone to share GPS. ' : '') + 'Ears can share GPS too (opt-in on each phone). Only latitude/longitude numbers reach this screen. GPS only anchors and turns the plan; pins keep their metre positions.'); }
    $('bar').classList.toggle('dim', hot);
    setText('mMute', muted() ? 'Unmute (' + muteLeft() + ' left)' : 'Mute 5 min');
    if (sheet === 'details') renderDetails(D, st);
    if (sheet === 'logS') drawTimeline();
    S.watch = s;
    Object.assign(window.__map = window.__map || {}, { remote: (st.remote || []).map(r => ({ g: r.g, x: +r.x.toFixed(1), y: +r.y.toFixed(1), name: r.name })), why: D.why && { id: D.why.id, text: D.why.text }, drones: D.drones.map(d => ({ key: d.key, slot: d.slot, f0: Math.round(d.f0), cls: d.cls, est: d.est, inc: d.inc && d.inc.id })), tracks: st.tracks, alerts: A.count, cover: st.ui.cover ? st.nodes.filter(n => n.hr && n.age < R.STALE_MS).map(n => ({ label: n.label, hr: n.hr, nf: n.nf })) : null, mode: sim ? 'sim' : D.mesh ? 'mesh' : 'solo', watch: s, banner: st.banner, label: st.label, score: st.score, est: st.est, estL: st.estL, estT: st.estT, estF: st.estF, errL: st.err.L, errT: st.err.T, errF: st.err.F, headErr: st.headErr, pairs: st.pairs.length, nodes: live.length, learned: st.learned, tdoaOk: st.tdoaOk, calTrusted: st.calTrusted, truth: st.truth && [st.truth.x, st.truth.y], sync: st.nodes.map(n => n.rtt), demo });
  }
  setInterval(frame, 100);

  function renderStatus(D, st, live, now) {
    const s = ws.s, hot = s === 'drone' || s === 'tracking', demo = isDemo(), [icon, word0] = STATES[s], mt = muted() ? 'MUTED · flash only · ' + muteLeft() : null;
    let word = word0, cls = '', where = '', sub = '', pill = null, prog = null, note = '', peekT = 'Details ˄', peekS = 'log · why · fingerprint · flight', acts = null;
    const quiet = now - Math.max(watchStart, ws.lastSeen || 0);
    switch (s) {
      case 'ready': cls = errMsg || (hub ? 'Ready · waiting for phones' : 'Not listening · tap Listen to start'); sub = lastDrone(); break;
      case 'watching': cls = (D.n > 1 ? D.n + ' phones' : 'This phone') + ' · quiet ' + (quiet < 60000 ? Math.round(quiet / 1000) + ' s' : Math.round(quiet / 60000) + ' min');
        sub = D.raw === 'hum' ? 'Ignoring: ' + D.hum : lastDrone(); pill = mt || 'Sound: ON';
        if (ignored(D.why)) { peekT = 'Why ignored ˄'; peekS = D.why.text; } break;
      case 'checking': cls = D.hear; peekS = 'live: pitch ~' + Math.round(D.hz || 0) + ' Hz · fingerprint forming'; if (ws.holdK > 0) { prog = ws.holdK; note = `hold ${(ws.holdK * WATCH.hold / 1000).toFixed(1)} / ${WATCH.hold / 1000} s`; } break;
      case 'notdrone': cls = D.hum + ' · ignored'; prog = 1 - (now - ws.since) / WATCH.notMs; note = `back to Watching in ${Math.max(0, Math.ceil((WATCH.notMs - (now - ws.since)) / 1000))} s`;
        peekT = 'Why not ˄'; peekS = D.why ? D.why.text : D.humWhy || 'not a rotor signature'; break;
      case 'drone': case 'tracking':
        word = (demo ? 'DEMO · ' : '') + (birdy(inc) ? 'LIKELY A BIRD' : 'DRONE'); cls = (D.cls || 'Drone') + (D.word ? ' · ' + D.word : '');
        where = D.rough ? (D.where ? D.where + ' · rough, calibrate ›' : 'Position is rough. Clap to calibrate ›') : D.mesh ? [D.where, D.trend].filter(Boolean).join(' · ') : D.trend + ' · one phone: no direction';
        sub = [D.agree, 'seen ' + mmss(now - ws.first)].filter(Boolean).join(' · ');
        pill = s === 'tracking' ? '✓ Acknowledged ' + clock(Date.now() - (now - ws.ackAt)) + ' · silent' : mt || (birdy(inc) ? 'Camera says bird · beeps paused' : demo ? 'Demo tone · beeping' : 'Sound ON · beeping');
        peekT = 'Why we think so ˄'; peekS = 'rotor hum ~' + Math.round(D.hz || 0) + ' Hz' + (D.learned ? ' · ' + D.learned.replace(/^Matched your taught samples \((\d+) .*\)$/, 'matches $1 of your samples') : D.flight ? ' · ' + shortFl(D.flight).toLowerCase() : '');
        acts = s === 'drone' ? [demo ? ['replay', 'Replay demo', 'from 0:00'] : muted() ? ['unmute', 'Unmute', muteLeft() + ' left'] : ['mute', 'Mute 5 min', 'banner keeps flashing'], ['ack', 'Got it', 'stops flash + beeps', 1]]
          : [muted() ? ['unmute', 'Unmute', muteLeft() + ' left'] : ['mute', 'Mute 5 min', 'also silences Lost tone'], ['details', 'Details', 'where · how sure · flight']];
        break;
      case 'lost': {
        const L = lostInfo || {}; cls = 'Last seen ' + mmss(now - ws.lastSeen) + ' ago' + (L.dir ? ' · ' + L.dir : '');
        sub = (inc ? inc.cls : 'Drone') + ' · heard for ' + mmss(ws.lastSeen - ws.first) + (L.heading ? ' · was leaving ' + L.heading : ''); where = '';
        prog = 1 - (now - ws.lastSeen) / WATCH.lostMs; note = 'Watching again in ' + mmss(WATCH.lostMs - (now - ws.lastSeen)); pill = mt;
        peekS = inc ? `saved to the log: ${clock(inc.t0)} · ${inc.cls} · ${Log.dur(inc)}` : peekS;
        acts = [['dismiss', 'Back to watching', 'clears now'], ['log', 'Log', 'replay · report']]; break;
      }
    }
    const b = $('status'); b.classList.remove('ready', 'watching', 'checking', 'notdrone', 'drone', 'tracking', 'lost'); b.classList.add(s);
    // two drones at once: one line each, in its map colour
    const many = hot && D.drones.length > 1, dl = many ? D.drones.map(d => `<div class="drow"><i class="dot d${d.slot + 1}"></i><b>${esc(d.cls)}${d.word ? ' · ' + d.word : ''}${d.inc && d.inc.bob ? ' · ' + RotorBird.chip(d.inc.bob) : ''}</b><small>${[d.where, d.agree].filter(Boolean).map(esc).join(' · ')}</small></div>`).join('') : '';
    if ($('stDrones').dataset.k !== dl) { $('stDrones').dataset.k = dl; $('stDrones').innerHTML = dl; }
    if (many) { word = (demo ? 'DEMO · ' : '') + D.drones.length + ' DRONES'; cls = where = ''; sub = 'seen ' + mmss(now - ws.first); }
    b.classList.toggle('birdy', hot && !many && birdy(inc)); // downgraded, not dismissed: calmer colours, the drone stays on the map
    const bb = hot && !many && inc && inc.bob, bk = bb ? JSON.stringify(bb) : ''; // the camera's Bird / Bot chip, with its reason
    if ($('stBob').dataset.k !== bk) { $('stBob').dataset.k = bk; $('stBob').hidden = !bb; $('stBob').innerHTML = bb ? `<span class="bob ${bb.v}">${RotorBird.chip(bb)}</span> <small>phone ${esc(bb.phone)}: ${esc(RotorBird.text(bb))}</small>` : ''; }
    setText('stIcon', icon); setText('stWord', word); $('stWord').classList.toggle('long', word.length > 13); setText('stCls', cls); setText('stWhere', where); setText('stSub', sub); $('stWhere').classList.toggle('link', D.rough && hot);
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
    else if (a === 'details') openSheet('details'); else if (a === 'log') openSheet('logS'); else if (a === 'dismiss') { ws.dismiss(now); inc = null; Log.save(true); } else if (a === 'replay') replayDemo();
    renderKey = '';
  };
  window.__watch = { get s() { return ws.s; }, get holdK() { return ws.holdK; }, ack: () => $('act2').dataset.a === 'ack' && $('act2').click() };

  const ignored = w => !!w && !w.drone && !['noise', 'weak', 'forming'].includes(w.id); // a sound worth saying why we ignored it
  function renderDetails(D, st) {
    const s = ws.s, hot = s === 'drone' || s === 'tracking', why = [];
    if (hot || s === 'checking' || s === 'lost') {
      if (D.hz) why.push(`Rotor hum ~${Math.round(D.hz)} Hz with an even harmonic comb`);
      why.push(D.mesh ? (st.voters ? `${st.voters} of ${D.n} phones hear it and agree` : 'No phone is sure yet') : 'Heard by this phone only (one phone can\'t tell direction)');
      if (D.learned) why.push(D.learned);
      if (D.rough) why.push('Arrival times disagree with loudness, so the position uses loudness only. Calibrate the phones (Phones sheet) to fix this.');
    } else if (s === 'notdrone' || D.raw === 'hum') why.push(D.hum, 'Ignored: no alert. A steady hum like this fools simple detectors');
    else if (ignored(D.why)) why.push('Ignored: no alert');
    else why.push('Nothing heard right now.');
    const wk = why.join('|'); if ($('dWhy').dataset.k !== wk) { $('dWhy').dataset.k = wk; $('dWhy').innerHTML = why.map(w => '<li>' + esc(w) + '</li>').join(''); }
    // the reason in plain words + one bar per feature: the shaded band is where drones sit
    const y = D.why && D.why.id !== 'forming' && (D.why.drone ? hot : !hot) ? D.why : null;
    setText('dWhyK', hot ? 'Why we think so' : y && !y.drone ? 'Why not a drone' : 'Why we think so');
    setText('dReason', y ? y.text : '');
    const bh = y ? y.bars.map(b => `<div class="fb${b.in ? '' : ' off'}"><span>${esc(b.name)}</span><i><u style="left:${(b.lo * 100).toFixed(1)}%;width:${((b.hi - b.lo) * 100).toFixed(1)}%"></u><em style="left:${(b.at * 100).toFixed(1)}%"></em></i><b>${esc(b.show)}</b></div>`).join('') + '<small>shaded = the drone range · ✕ = outside it</small>' : '';
    if ($('dBars').dataset.k !== bh) { $('dBars').dataset.k = bh; $('dBars').innerHTML = bh; }
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
  $('flBlades').onchange = () => { blades = +$('flBlades').value; localStorage.setItem('rotorear-blades', blades); if (det) det.blades = blades; if (sim) sim.eng.nodes.forEach(n => n.det.blades = blades); };
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

  // side view of the lead drone: ground, the phones along it, the drone at its height with the likely range
  const sideC = $('side').firstElementChild, sideG = sideC.getContext('2d');
  function drawSide(d, nodes) {
    const h = d && d.est && d.h; $('side').hidden = !h || replay;
    if (!h || replay) return;
    setHTML('sideT', h.ok ? `~${h.z} m up <small>likely ${h.lo}–${h.hi} m</small>` : h.why === 'measuring' ? 'Height <small>measuring…</small>' : `Height unknown <small>${esc(h.why)}</small>`);
    const dpr = Math.min(2, devicePixelRatio || 1), W = Math.round(sideC.clientWidth * dpr), H = Math.round(sideC.clientHeight * dpr);
    if (!W || !H) return; if (sideC.width !== W || sideC.height !== H) { sideC.width = W; sideC.height = H; }
    const xs = nodes.map(n => n.pos[0]).concat(d.est[0]), x0 = Math.min(...xs) - 2, xr = Math.max(...xs) + 2 - x0, top = Math.max(10, (h.ok ? h.hi : 0) * 1.25, d.tz || 0);
    const gy = H - 9 * dpr, X = x => 8 * dpr + (x - x0) / xr * (W - 16 * dpr), Y = z => gy - z / top * (gy - 30 * dpr);
    sideG.clearRect(0, 0, W, H);
    sideG.strokeStyle = cols.line; sideG.lineWidth = dpr; sideG.beginPath(); sideG.moveTo(0, gy); sideG.lineTo(W, gy); sideG.stroke();
    sideG.fillStyle = cols.ink2; sideG.font = `${9 * dpr}px system-ui`; sideG.textAlign = 'right'; sideG.fillText(Math.round(top) + ' m', W - 4 * dpr, Y(top) + 3 * dpr); sideG.fillText('ground', W - 4 * dpr, gy - 3 * dpr);
    sideG.strokeStyle = cols.line; sideG.setLineDash([2 * dpr, 3 * dpr]); sideG.beginPath(); sideG.moveTo(0, Y(top)); sideG.lineTo(W - 30 * dpr, Y(top)); sideG.stroke(); sideG.setLineDash([]);
    sideG.fillStyle = cols.pin; nodes.forEach(n => { sideG.beginPath(); sideG.arc(X(n.pos[0]), gy, 3 * dpr, 0, 7); sideG.fill(); });
    const c = d.slot ? cols.alert2 : cols.alert, x = X(d.est[0]);
    if (d.tz != null) { sideG.strokeStyle = cols.ink2; sideG.setLineDash([2 * dpr, 2 * dpr]); sideG.beginPath(); sideG.moveTo(x - 8 * dpr, Y(d.tz)); sideG.lineTo(x + 8 * dpr, Y(d.tz)); sideG.stroke(); sideG.setLineDash([]); } // demo: the true height
    if (!h.ok) { sideG.fillStyle = cols.ink2; sideG.font = `700 ${12 * dpr}px system-ui`; sideG.textAlign = 'center'; sideG.fillText('?', x, Y(top * 0.45)); return; }
    sideG.globalAlpha = 0.3; sideG.fillStyle = c; sideG.fillRect(x - 4 * dpr, Y(h.hi), 8 * dpr, Y(h.lo) - Y(h.hi)); sideG.globalAlpha = 1;
    sideG.strokeStyle = c; sideG.setLineDash([2 * dpr, 3 * dpr]); sideG.beginPath(); sideG.moveTo(x, gy); sideG.lineTo(x, Y(h.z)); sideG.stroke(); sideG.setLineDash([]);
    sideG.fillStyle = c; sideG.beginPath(); sideG.arc(x, Y(h.z), 4 * dpr, 0, 7); sideG.fill();
  }

  let lastDetect = 0;
  function loop(t) {
    if (t - lastDetect > 45) {
      lastDetect = t;
      const o = performance.now() < gateUntil ? det.out : det.step(t), c = o.cls; if (tap) tap.setF0(o.f0);
      Object.assign(S, { conf: o.conf, state: o.state, f0: o.f0, hits: o.hits, flight: o.flight && { state: o.flight.state, f: +o.flight.f.toFixed(2), rpm: Math.round(o.flight.rpm), rate: +o.flight.rate.toFixed(2), dbRate: +o.flight.dbRate.toFixed(2), base: o.flight.base }, cls: c && { label: c.label, conf: c.conf, drone: c.drone, learned: c.learned, nearest: c.nearest, raw: c.raw, x: c.x },
        srcs: det.src.map(q => ({ id: q.id, state: q.out.state, conf: q.out.conf, f0: Math.round(q.out.f0), cls: q.out.cls && q.out.cls.label, fl: q.out.flight && q.out.flight.state })), lead: det.li, nf: o.nf, hr: o.hr, snd: det.snd, why: o.why && { id: o.why.id, text: o.why.text } });
      if (sheet === 'details') { const p = primary(); drawFingerprint(p.out.cls, p.out.state); drawFlight(p.out.flight); }
    }
    const p = primary(); if (p.db) { drawColumn(specs[0], p, p.out); drawColumn(specs[1], p, p.out); } // Details keeps drawing while closed, so it opens with history
    requestAnimationFrame(loop);
  }
  drawFingerprint(null);
})();
