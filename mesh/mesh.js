// Rotor Ear · Phone Mesh Radar pages (mesh/index.html): landing + listening node. The map is the watch post (../).
// All transport/estimation lives in core.js. Nodes send ONLY numbers + a class label + envelope-peak
// times. Never audio. Passive: nothing here transmits RF or affects drones.
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const R = window.RotorMesh, clamp = (x, a, b) => x < a ? a : x > b ? b : x;

  function parseHash() {
    const h = new URLSearchParams(location.hash.slice(1));
    const room = (h.get('room') || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12);
    return { room, role: h.get('role') || '', h };
  }
  const baseUrl = () => location.href.split('#')[0];
  const nodeLink = room => baseUrl() + '#room=' + room + '&role=node';

  // ---------------- small spectrogram (log 50 Hz–8 kHz) ----------------
  function Spectro(cv) {
    const g = cv.getContext('2d'), PAL = [];
    const stops = [[0, 0, 0, 4], [0.2, 40, 11, 84], [0.4, 120, 28, 109], [0.6, 200, 60, 70], [0.8, 248, 140, 30], [1, 252, 255, 164]];
    for (let i = 0; i < 256; i++) { const t = i / 255; let k = 0; while (t > stops[k + 1][0]) k++; const a = stops[k], b = stops[k + 1], u = (t - a[0]) / (b[0] - a[0]); PAL.push(`rgb(${a[1] + (b[1] - a[1]) * u | 0},${a[2] + (b[2] - a[2]) * u | 0},${a[3] + (b[3] - a[3]) * u | 0})`); }
    return function draw(db, binHz, f0, st) {
      const dpr = Math.min(2, devicePixelRatio || 1), W = Math.round(cv.clientWidth * dpr), H = Math.round(cv.clientHeight * dpr);
      if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
      g.drawImage(cv, 2, 0, W - 2, H, 0, 0, W - 2, H);
      const x = W - 2, L = Math.log(8000 / 50);
      for (let y = 0; y < H; y += 2) { const f = 50 * Math.exp(L * (1 - y / H)), i = Math.round(f / binHz); g.fillStyle = PAL[clamp((db[i] + 105) / 75, 0, 1) * 255 | 0]; g.fillRect(x, y, 2, 2); }
      if (f0 && st !== 'quiet') { g.fillStyle = st === 'drone' ? '#ff3b5c' : '#ffb547'; for (let h = 1; h <= 10; h++) { const y = (1 - Math.log(f0 * h / 50) / L) * H; if (y > 0) g.fillRect(x, y - 1, 2, 2); } }
    };
  }
  function setBanner(el, st, sub, cls) {
    const L = { quiet: 'QUIET', some: 'SOMETHING', drone: 'DRONE NEARBY', hum: 'NOT A DRONE', off: 'READY' };
    const key = st + sub + (cls || ''); if (el.dataset.k === key) return; el.dataset.k = key;
    el.className = 'banner ' + (st === 'quiet' ? '' : st === 'hum' ? 'some' : st);
    el.innerHTML = (L[st] || st) + (cls ? '<b class="cls">' + cls + '</b>' : '') + '<small>' + sub + '</small>';
  }
  const clsText = o => o.cls ? o.cls.label + ' · ' + o.cls.conf + '%' : '';

  // ---------------- NODE ----------------
  function runNode(room) {
    $('node').hidden = false;
    $('roomTag').textContent = 'room ' + room + ' · node';
    const kStore = 'rotorear-key-' + room;
    const key = localStorage.getItem(kStore) || R.randKey(5); localStorage.setItem(kStore, key);
    $('nName').value = localStorage.getItem('rotorear-name') || '';
    $('nName').onchange = () => localStorage.setItem('rotorear-name', $('nName').value.trim());
    let label = '';
    const status = (s, cls) => { $('nStatus').textContent = (label ? 'Node ' + label + ' · ' : '') + s; $('nStatus').className = 'status ' + (cls || ''); };
    const link = new R.NodeLink(room, key, status, d => { if (d.t === 'ping' && d.label && d.label !== label) { label = d.label; status('connected to map', 'ok'); } });

    let ctx, an, bus, det, tap, mic, micSrc, sim = null, simGain, simSpk, spec = Spectro($('nSpec')), wake = null;
    function ensure() {
      if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      an = RotorEar.makeAnalyser(ctx); det = new RotorEar.RotorDetector(an);
      bus = ctx.createGain(); bus.connect(an);
      R.TimingTap(ctx, bus).then(t => tap = t).catch(() => {}); // arrival times are optional
      simSpk = ctx.createGain(); simSpk.gain.value = 0; simSpk.connect(ctx.destination);
      setInterval(tick, 50);
      setInterval(() => link.send(R.telemetry(det.out, key, $('nName').value.trim(), null, tap ? tap.take() : null, tap ? tap.takeOnsets() : null)), 1000 / R.SEND_HZ);
    }
    async function keepAwake() { try { if ('wakeLock' in navigator && !wake) { wake = await navigator.wakeLock.request('screen'); wake.onrelease = () => wake = null; } } catch (e) {} }
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && (mic || sim)) keepAwake(); });
    function tick() {
      const o = det.step(performance.now()); if (tap) tap.setF0(o.f0);
      $('nConf').textContent = o.conf; $('nMeter').style.width = o.conf + '%';
      $('nF0').textContent = o.f0 && o.conf > 15 ? Math.round(o.f0) : '—';
      $('nE').textContent = o.f0 ? Math.round(o.e) : '—';
      const sub = o.state === 'drone' ? 'rotor signature @ ' + Math.round(o.f0) + ' Hz' : o.state === 'hum' ? (o.cls ? o.cls.why : '') : o.state === 'some' ? 'harmonic hum, checking…' : (sim ? 'simulating' : 'listening');
      setBanner($('nBanner'), o.state, sub, o.state === 'drone' || o.state === 'some' ? clsText(o) : o.state === 'hum' && o.cls ? o.cls.conf + '% sure' : '');
      spec(det.db, det.binHz, o.f0, o.state);
    }
    $('nStart').onclick = async () => {
      ensure(); keepAwake();
      if (mic) { mic.getTracks().forEach(t => t.stop()); micSrc.disconnect(); mic = null; $('nStart').textContent = '🎙️ Start listening'; $('nStart').classList.remove('on'); return; }
      try {
        $('nErr').textContent = '';
        mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
        micSrc = ctx.createMediaStreamSource(mic); micSrc.connect(bus);
        $('nStart').textContent = '⏹ Stop listening'; $('nStart').classList.add('on');
      } catch (e) { mic = null; $('nErr').textContent = 'Microphone unavailable: ' + (e.message || e.name); }
    };
    const distGain = d => 0.6 / Math.max(1, d); // amplitude ∝ 1/r  ⇒  power ∝ 1/r²
    function updDist() { const d = +$('nDist').value; $('nDistV').textContent = d + ' m'; if (simGain) simGain.gain.setTargetAtTime(distGain(d), ctx.currentTime, 0.2); }
    $('nDist').oninput = updDist;
    $('nSimSpk').onchange = () => { if (simSpk) simSpk.gain.value = $('nSimSpk').checked ? 1 : 0; };
    $('nSim').onchange = () => {
      ensure(); keepAwake();
      if ($('nSim').checked) {
        const d = RotorEar.syntheticDrone(ctx, 200 + Math.random() * 30);
        simGain = ctx.createGain(); simGain.gain.value = distGain(+$('nDist').value);
        d.connect(simGain); simGain.connect(bus); simGain.connect(simSpk);
        const nz = RotorEar.ambientNoise(ctx, 0.01); nz.connect(bus);
        sim = { d, nz }; simSpk.gain.value = $('nSimSpk').checked ? 1 : 0; updDist();
      } else if (sim) { sim.d.stop(); sim.nz.stop(); simGain.disconnect(); sim = null; }
    };
    window.__node = { get out() { return det && det.out; }, key };
  }

  // ---------------- landing / roles ----------------
  function route() {
    ['landing', 'roles', 'node'].forEach(id => $(id).hidden = true);
    const { room, role } = parseHash();
    if (!room) {
      $('landing').hidden = false;
      $('newRoom').onclick = () => { location.hash = 'room=' + R.randKey(4); };
      $('joinBtn').onclick = () => { const c = $('joinCode').value.toLowerCase().replace(/[^a-z0-9]/g, ''); if (c) location.hash = 'room=' + c; };
      return;
    }
    if (role === 'node') return runNode(room);
    if (role === 'map') return location.replace('../#room=' + room); // the map lives in the watch post now
    $('roles').hidden = false; $('roomCode').textContent = room; $('roomTag').textContent = 'room ' + room;
    $('shareUrl').value = baseUrl() + '#room=' + room;
    $('copyBtn').onclick = () => { navigator.clipboard && navigator.clipboard.writeText($('shareUrl').value); $('copyBtn').textContent = 'Copied'; };
    $('beNode').onclick = () => { location.hash = 'room=' + room + '&role=node'; };
    $('beMap').onclick = () => { location.href = '../#room=' + room; };
    $('simLink').href = 'sim.html#room=' + room;
  }
  window.addEventListener('hashchange', () => location.reload());
  route();
})();
