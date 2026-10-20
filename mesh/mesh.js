// Rotor Ear · Phone Mesh Radar
// Nodes run the Rotor Ear detector on their own mic and send ONLY numbers
// (confidence, fundamental Hz, harmonic band energy dB) to a map "hub" peer.
// Transport: PeerJS cloud (wss://0.peerjs.com:443) for signalling, then a direct WebRTC
// data channel per node -> map. Passive: nothing here transmits RF or affects drones.
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const PREFIX = 'rotorear-v1-';
  const SEND_HZ = 8, STALE_MS = 1600;
  const LABELS = 'ABCDEFGHIJKLMNOP';
  const COLORS = ['#4cc9ff', '#2ee6a6', '#ffb547', '#c77dff', '#ff8fab', '#90e0ef', '#f9c74f', '#a7c957'];
  const DEFAULT_POS = [[0, 0], [6, 0], [6, 6], [0, 6], [3, -2], [8, 3], [3, 8], [-2, 3]];
  const hubId = room => PREFIX + room + '-map';
  const randKey = n => Array.from(crypto.getRandomValues(new Uint8Array(n)), b => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]).join('');
  const clamp = (x, a, b) => x < a ? a : x > b ? b : x;

  function parseHash() {
    const h = new URLSearchParams(location.hash.slice(1));
    const room = (h.get('room') || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12);
    return { room, role: h.get('role') || '', h };
  }
  const baseUrl = () => location.href.split('#')[0];
  const nodeLink = room => baseUrl() + '#room=' + room + '&role=node';

  // ---------------- transport ----------------
  // NodeLink: keeps a data channel open to the room's map peer, reconnecting forever.
  class NodeLink {
    constructor(room, key, onStatus, onMsg) {
      Object.assign(this, { room, key, onStatus, onMsg, conn: null, peer: null, lastPing: 0, tries: 0, dead: false });
      this.idSuffix = '';
      this.makePeer();
      this.watch = setInterval(() => this.watchdog(), 1000);
    }
    makePeer() {
      if (this.peer) { try { this.peer.destroy(); } catch (e) {} }
      const p = this.peer = new Peer(PREFIX + this.room + '-n-' + this.key + this.idSuffix, { debug: 0 });
      this.onStatus('connecting to relay…', 'bad');
      p.on('open', () => this.connect());
      p.on('disconnected', () => { if (!p.destroyed) setTimeout(() => { try { p.reconnect(); } catch (e) {} }, 1000); });
      p.on('error', err => {
        if (err.type === 'peer-unavailable') { this.onStatus('map not open yet — retrying…', 'bad'); this.retry(2000); }
        else if (err.type === 'unavailable-id') { this.idSuffix = '-' + randKey(3); setTimeout(() => this.makePeer(), 500); }
        else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) { this.onStatus('relay unreachable — retrying…', 'bad'); setTimeout(() => this.makePeer(), 3000); }
        else { this.onStatus('error: ' + err.type, 'bad'); this.retry(3000); }
      });
    }
    retry(ms) { clearTimeout(this.rt); this.rt = setTimeout(() => this.connect(), ms); }
    connect() {
      const p = this.peer; if (!p || p.destroyed || p.disconnected || !p.open) return;
      if (this.conn) { try { this.conn.close(); } catch (e) {} }
      const c = this.conn = p.connect(hubId(this.room), { reliable: false, serialization: 'json', metadata: { role: 'node', key: this.key } });
      this.onStatus('connecting to map…', 'bad');
      c.on('open', () => { this.lastPing = Date.now(); this.onStatus('connected to map', 'ok'); });
      c.on('data', d => { if (d && d.t === 'ping') this.lastPing = Date.now(); this.onMsg && this.onMsg(d); });
      c.on('close', () => { if (this.conn === c) { this.onStatus('lost map — reconnecting…', 'bad'); this.retry(1500); } });
      c.on('error', () => { if (this.conn === c) this.retry(2000); });
    }
    watchdog() {
      const c = this.conn;
      if (c && c.open && Date.now() - this.lastPing > 7000) { this.onStatus('map silent — reconnecting…', 'bad'); try { c.close(); } catch (e) {} this.retry(500); }
      if (c && !c.open && Date.now() - (this.lastTry || 0) > 10000) { this.lastTry = Date.now(); if (this.peer && this.peer.open) this.retry(0); }
    }
    send(o) { const c = this.conn; if (c && c.open) { try { c.send(o); } catch (e) {} } }
  }

  // Hub: the map owns the well-known peer id for the room. If it's taken, we become a viewer.
  function startHub(room, cb) {
    let peer, conns = new Set(), mode = 'hub', hubConn = null;
    const make = () => {
      peer = new Peer(mode === 'hub' ? hubId(room) : PREFIX + room + '-v-' + randKey(5), { debug: 0 });
      peer.on('open', () => {
        if (mode === 'hub') cb.status('map is live — waiting for nodes', 'ok');
        else viewerConnect();
      });
      peer.on('connection', c => {
        c.on('open', () => { conns.add(c); c.send({ t: 'ping' }); });
        c.on('data', d => cb.data(c, d));
        c.on('close', () => { conns.delete(c); cb.gone && cb.gone(c); });
        c.on('error', () => conns.delete(c));
      });
      peer.on('disconnected', () => { if (!peer.destroyed) setTimeout(() => { try { peer.reconnect(); } catch (e) {} }, 1000); });
      peer.on('error', err => {
        if (err.type === 'unavailable-id' && mode === 'hub') { mode = 'viewer'; cb.status('another map already hosts this room — viewing it', 'bad'); cb.viewer && cb.viewer(); peer.destroy(); setTimeout(make, 300); }
        else if (err.type === 'peer-unavailable' && mode === 'viewer') { setTimeout(viewerConnect, 2000); }
        else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) { cb.status('relay unreachable — retrying…', 'bad'); peer.destroy(); setTimeout(make, 3000); }
        else cb.status('relay error: ' + err.type, 'bad');
      });
    };
    function viewerConnect() {
      hubConn = peer.connect(hubId(room), { reliable: false, serialization: 'json', metadata: { role: 'viewer' } });
      hubConn.on('open', () => cb.status('viewing the room map (read-only)', 'ok'));
      hubConn.on('data', d => cb.view && cb.view(d));
      hubConn.on('close', () => setTimeout(viewerConnect, 1500));
    }
    make();
    setInterval(() => { conns.forEach(c => { if (c.open) try { c.send({ t: 'ping', label: c.label }); } catch (e) {} }); }, 2000);
    return {
      get mode() { return mode; },
      broadcastViewers(o) { conns.forEach(c => { if (c.open && c.metadata && c.metadata.role === 'viewer') try { c.send(o); } catch (e) {} }); }
    };
  }

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

  function setBanner(el, st, sub) {
    const L = { quiet: 'QUIET', some: 'SOMETHING', drone: 'DRONE NEARBY', off: 'READY' };
    const key = st + sub; if (el.dataset.k === key) return; el.dataset.k = key;
    el.className = 'banner ' + (st === 'quiet' ? '' : st);
    el.innerHTML = (L[st] || st) + '<small>' + sub + '</small>';
  }

  // ---------------- NODE ----------------
  function runNode(room) {
    $('node').hidden = false;
    $('roomTag').textContent = 'room ' + room + ' · node';
    const kStore = 'rotorear-key-' + room;
    const key = localStorage.getItem(kStore) || randKey(5); localStorage.setItem(kStore, key);
    const name = localStorage.getItem('rotorear-name') || ''; $('nName').value = name;
    $('nName').onchange = () => localStorage.setItem('rotorear-name', $('nName').value.trim());
    let label = '';
    const status = (s, cls) => { $('nStatus').textContent = (label ? 'Node ' + label + ' · ' : '') + s; $('nStatus').className = 'status ' + (cls || ''); };
    const link = new NodeLink(room, key, status, d => { if (d.t === 'ping' && d.label && d.label !== label) { label = d.label; status('connected to map', 'ok'); } });

    let ctx, an, det, mic, micSrc, sim = null, simGain, simSpk, spec = Spectro($('nSpec')), wake = null;
    function ensure() {
      if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      an = RotorEar.makeAnalyser(ctx); det = new RotorEar.RotorDetector(an);
      simSpk = ctx.createGain(); simSpk.gain.value = 0; simSpk.connect(ctx.destination);
      setInterval(tick, 50);
      setInterval(() => {
        const o = det.out;
        link.send({ t: 's', k: key, n: $('nName').value.trim(), c: o.conf, f: Math.round(o.f0 * 10) / 10, e: o.e, st: o.state });
      }, 1000 / SEND_HZ);
    }
    async function keepAwake() { try { if ('wakeLock' in navigator && !wake) { wake = await navigator.wakeLock.request('screen'); wake.onrelease = () => wake = null; } } catch (e) {} }
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && (mic || sim)) keepAwake(); });
    function tick() {
      const o = det.step(performance.now());
      $('nConf').textContent = o.conf; $('nMeter').style.width = o.conf + '%';
      $('nF0').textContent = o.f0 && o.conf > 15 ? Math.round(o.f0) : '—';
      $('nE').textContent = o.f0 ? Math.round(o.e) : '—';
      setBanner($('nBanner'), o.state, o.state === 'drone' ? 'rotor signature @ ' + Math.round(o.f0) + ' Hz' : o.state === 'some' ? 'harmonic hum, checking…' : (sim ? 'simulating' : 'listening'));
      spec(det.db, det.binHz, o.f0, o.state);
    }
    $('nStart').onclick = async () => {
      ensure(); keepAwake();
      if (mic) { mic.getTracks().forEach(t => t.stop()); micSrc.disconnect(); mic = null; $('nStart').textContent = '🎙️ Start listening'; $('nStart').classList.remove('on'); return; }
      try {
        $('nErr').textContent = '';
        mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
        micSrc = ctx.createMediaStreamSource(mic); micSrc.connect(an);
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
        d.connect(simGain); simGain.connect(an); simGain.connect(simSpk);
        const nz = RotorEar.ambientNoise(ctx, 0.01); nz.connect(an);
        sim = { d, nz }; simSpk.gain.value = $('nSimSpk').checked ? 1 : 0; updDist();
      } else if (sim) { sim.d.stop(); sim.nz.stop(); simGain.disconnect(); sim = null; }
    };
    window.__node = { get out() { return det && det.out; }, key };
  }

  // ---------------- MAP ----------------
  function runMap(room) {
    $('map').hidden = false;
    $('roomTag').textContent = 'room ' + room + ' · map';
    $('mShare').value = nodeLink(room);
    $('mCopy').onclick = () => { navigator.clipboard && navigator.clipboard.writeText($('mShare').value); $('mCopy').textContent = 'Copied'; };
    const posKey = 'rotorear-pos-' + room;
    const saved = JSON.parse(localStorage.getItem(posKey) || '{}');
    const nodes = new Map(); // key -> node
    let est = null, estS = null, trail = [], truth = null, truthAt = 0, errs = [], viewer = false, droneHold = 0, agreeKeys = [];
    const M = window.__map = { est: null, truth: null, err: null, meanErr: null, agree: 0, banner: 'quiet', nodes: 0 };

    const status = (s, cls) => { $('mStatus').textContent = s; $('mStatus').className = 'status ' + (cls || ''); };
    const hub = startHub(room, {
      status,
      viewer: () => { viewer = true; },
      data: (c, d) => {
        if (!d) return;
        if (d.t === 'truth') { truth = [d.x, d.y]; truthAt = performance.now(); return; }
        if (d.t !== 's' || !d.k) return;
        let n = nodes.get(d.k);
        if (!n) {
          const idx = nodes.size;
          n = { key: d.k, label: LABELS[idx % LABELS.length], color: COLORS[idx % COLORS.length], pos: saved[d.k] || (d.p ? d.p.slice() : DEFAULT_POS[idx % DEFAULT_POS.length].slice()), es: null };
          nodes.set(d.k, n);
        }
        if (!saved[d.k] && d.p && !n.userMoved) n.pos = d.p.slice();
        c.label = n.label;
        Object.assign(n, { name: d.n || '', c: d.c, f: d.f, e: d.e, st: d.st, last: performance.now() });
        if (d.f > 0 && d.e > -100) n.es = n.es == null ? d.e : n.es + 0.5 * (d.e - n.es); else n.es = null;
      },
      view: d => { if (d.t === 'view') { viewState = d; } }
    });
    let viewState = null;

    // --- localisation ---
    // Agreeing nodes: fresh, confident, same fundamental (±5%) as the most confident node.
    function agreeing(now) {
      const live = [...nodes.values()].filter(n => now - n.last < STALE_MS);
      const cand = live.filter(n => n.c >= 35 && n.f > 0 && n.es != null).sort((a, b) => b.c - a.c);
      if (!cand.length) return { live, A: [] };
      const ref = cand[0].f;
      return { live, A: cand.filter(n => Math.abs(n.f - ref) / ref < 0.05) };
    }
    // Inverse-square fit: P_i = S / r_i²  →  ln P_i = ln S − ln r_i².
    // Grid-search (x,y); for each point the best ln S is the mean residual, so we only score the spread.
    function fit(A) {
      const lp = A.map(n => n.es / 10 * Math.LN10);
      const ws = A.map(n => Math.pow(10, n.es / 20)); const W = ws.reduce((a, b) => a + b, 0);
      const cx = A.reduce((a, n, i) => a + n.pos[0] * ws[i], 0) / W, cy = A.reduce((a, n, i) => a + n.pos[1] * ws[i], 0) / W;
      if (A.length < 3) return [cx, cy]; // 2 nodes: loudness-weighted centroid (1/r weights)
      const xs = A.map(n => n.pos[0]), ys = A.map(n => n.pos[1]), PAD = 6;
      const x0 = Math.min(...xs) - PAD, x1 = Math.max(...xs) + PAD, y0 = Math.min(...ys) - PAD, y1 = Math.max(...ys) + PAD;
      const Z2 = 1.0, LAMBDA = 0.004; // assume ~1 m height offset; tiny pull to centroid breaks ties
      const cost = (x, y) => {
        let m = 0; const r = new Array(A.length);
        for (let i = 0; i < A.length; i++) { const dx = x - A[i].pos[0], dy = y - A[i].pos[1]; r[i] = lp[i] + Math.log(dx * dx + dy * dy + Z2); m += r[i]; }
        m /= A.length; let s = 0; for (let i = 0; i < A.length; i++) s += (r[i] - m) * (r[i] - m);
        return s + LAMBDA * ((x - cx) ** 2 + (y - cy) ** 2);
      };
      let best = [cx, cy], bc = cost(cx, cy);
      for (let x = x0; x <= x1; x += 0.25) for (let y = y0; y <= y1; y += 0.25) { const c = cost(x, y); if (c < bc) { bc = c; best = [x, y]; } }
      const [bx, by] = best;
      for (let x = bx - 0.3; x <= bx + 0.3; x += 0.05) for (let y = by - 0.3; y <= by + 0.3; y += 0.05) { const c = cost(x, y); if (c < bc) { bc = c; best = [x, y]; } }
      return best;
    }
    function update() {
      if (viewer) {
        if (viewState) {
          const vb = viewState.banner;
          setBanner($('mBanner'), vb, viewState.sub || '');
          if (vb === 'drone') $('mBanner').firstChild.textContent = 'DRONE'; else if (vb === 'off') $('mBanner').firstChild.textContent = 'WAITING FOR NODES';
          Object.assign(M, { est: viewState.est, banner: vb, nodes: viewState.nodes.filter(n => n.age < STALE_MS).length });
          renderList(performance.now());
        }
        return;
      }
      const now = performance.now(), { live, A } = agreeing(now);
      agreeKeys = A.map(n => n.key);
      const droneVotes = A.filter(n => n.st === 'drone' || n.c >= 60).length;
      if (A.length >= 2 && droneVotes >= 2) droneHold = now + 1500;
      const banner = now < droneHold ? 'drone' : live.some(n => n.c >= 30) ? 'some' : live.length ? 'quiet' : 'off';
      if (A.length >= 2 && (banner === 'drone' || A.length >= 2 && droneVotes >= 1)) {
        const p = fit(A);
        estS = estS ? [estS[0] + 0.3 * (p[0] - estS[0]), estS[1] + 0.3 * (p[1] - estS[1])] : p;
        est = estS; trail.push(est.slice()); if (trail.length > 60) trail.shift();
      } else if (banner !== 'drone') { est = null; estS = null; if (trail.length) trail.shift(); }
      if (truth && now - truthAt > 3000) truth = null;
      let err = null;
      if (est && truth) { err = Math.hypot(est[0] - truth[0], est[1] - truth[1]); errs.push([now, err]); }
      while (errs.length && now - errs[0][0] > 10000) errs.shift();
      Object.assign(M, { est: est && est.map(v => +v.toFixed(2)), truth, err: err && +err.toFixed(2), meanErr: errs.length ? +(errs.reduce((a, e) => a + e[1], 0) / errs.length).toFixed(2) : null, agree: A.length, banner, nodes: live.length });
      const sub = banner === 'drone' ? `${A.length} nodes agree @ ${Math.round(A[0].f)} Hz` + (est ? ` · est (${est[0].toFixed(1)}, ${est[1].toFixed(1)}) m` : '')
        : banner === 'some' ? 'a node hears a harmonic hum…' : banner === 'quiet' ? live.length + ' node' + (live.length === 1 ? '' : 's') + ' listening' : 'open the node link on the listening phones';
      setBanner($('mBanner'), banner === 'off' ? 'off' : banner, sub);
      if (banner === 'off') $('mBanner').firstChild.textContent = 'WAITING FOR NODES';
      else if (banner === 'drone') $('mBanner').firstChild.textContent = 'DRONE';
      $('mErr').textContent = M.meanErr != null ? `sim check: estimate is ${M.err != null ? M.err.toFixed(1) : '—'} m from the true drone (10 s avg ${M.meanErr.toFixed(1)} m)` : '';
      hub.broadcastViewers({ t: 'view', nodes: [...nodes.values()].map(n => ({ key: n.key, label: n.label, color: n.color, pos: n.pos, name: n.name, c: n.c, f: n.f, e: n.e, st: n.st, age: now - n.last })), est, trail, truth, banner, sub, agreeKeys });
      if (hub.mode === 'hub' && /^map is live/.test($('mStatus').textContent)) status('map is live · ' + live.length + ' node' + (live.length === 1 ? '' : 's') + ' connected', 'ok');
      renderList(now);
    }
    setInterval(update, 100);

    // --- drawing ---
    const cv = $('mCanvas'), g = cv.getContext('2d');
    let view = { x0: -3, y0: -3, s: 12 }, drag = null;
    function fitView(list) {
      if (drag) return;
      const xs = [0, 6], ys = [0, 6]; list.forEach(n => { xs.push(n.pos[0]); ys.push(n.pos[1]); });
      const x0 = Math.min(...xs) - 3, x1 = Math.max(...xs) + 3, y0 = Math.min(...ys) - 3, y1 = Math.max(...ys) + 3;
      const s = Math.max(x1 - x0, y1 - y0);
      view = { x0: (x0 + x1) / 2 - s / 2, y0: (y0 + y1) / 2 - s / 2, s };
    }
    const W2P = (x, y) => [(x - view.x0) / view.s * cv.width, cv.height - (y - view.y0) / view.s * cv.height];
    const P2W = (px, py) => [view.x0 + px / cv.width * view.s, view.y0 + (cv.height - py) / cv.height * view.s];
    function draw() {
      const dpr = Math.min(2, devicePixelRatio || 1), Wd = Math.round(cv.clientWidth * dpr);
      if (cv.width !== Wd) { cv.width = Wd; cv.height = Wd; }
      const W = cv.width, H = cv.height, now = performance.now();
      const st = viewer ? viewState : null;
      const list = st ? st.nodes : [...nodes.values()].map(n => Object.assign({}, n, { age: now - n.last }));
      const E = st ? st.est : est, T = st ? st.trail : trail, TR = st ? st.truth : truth, AK = st ? st.agreeKeys : agreeKeys;
      fitView(list);
      g.fillStyle = '#03050a'; g.fillRect(0, 0, W, H);
      const px = W / view.s;
      g.lineWidth = 1; g.font = `${11 * dpr}px system-ui`; g.fillStyle = '#3a4560';
      for (let m = Math.ceil(view.x0); m <= view.x0 + view.s; m++) { const [x] = W2P(m, 0); g.strokeStyle = m % 5 ? '#0e1424' : '#1a2238'; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); if (m % 2 === 0) g.fillText(m + 'm', x + 2, H - 4 * dpr); }
      for (let m = Math.ceil(view.y0); m <= view.y0 + view.s; m++) { const [, y] = W2P(0, m); g.strokeStyle = m % 5 ? '#0e1424' : '#1a2238'; g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); if (m % 2 === 0) g.fillText(m + 'm', 3 * dpr, y - 2); }
      // estimated range rings for agreeing nodes (relative, from the fitted source strength)
      if (E && AK && AK.length >= 2) list.filter(n => AK.includes(n.key)).forEach(n => {
        const [x, y] = W2P(n.pos[0], n.pos[1]), r = Math.hypot(E[0] - n.pos[0], E[1] - n.pos[1]) * px;
        g.strokeStyle = n.color + '55'; g.setLineDash([4 * dpr, 6 * dpr]); g.beginPath(); g.arc(x, y, r, 0, 7); g.stroke(); g.setLineDash([]);
      });
      if (TR) { const [x, y] = W2P(TR[0], TR[1]); g.strokeStyle = '#ffffffaa'; g.lineWidth = 2 * dpr; g.setLineDash([3 * dpr, 3 * dpr]); g.beginPath(); g.arc(x, y, 9 * dpr, 0, 7); g.stroke(); g.setLineDash([]); g.fillStyle = '#ffffffaa'; g.fillText('true (sim)', x + 12 * dpr, y - 8 * dpr); }
      if (T && T.length > 1) { for (let i = 1; i < T.length; i++) { const [a, b] = W2P(T[i - 1][0], T[i - 1][1]), [c, d] = W2P(T[i][0], T[i][1]); g.strokeStyle = `rgba(255,59,92,${i / T.length * 0.8})`; g.lineWidth = 3 * dpr * i / T.length; g.beginPath(); g.moveTo(a, b); g.lineTo(c, d); g.stroke(); } }
      if (E) {
        const [x, y] = W2P(E[0], E[1]), pulse = 1 + 0.25 * Math.sin(now / 160);
        const gr = g.createRadialGradient(x, y, 0, x, y, 34 * dpr * pulse); gr.addColorStop(0, 'rgba(255,90,110,0.95)'); gr.addColorStop(0.25, 'rgba(255,59,92,0.55)'); gr.addColorStop(1, 'rgba(255,59,92,0)');
        g.fillStyle = gr; g.beginPath(); g.arc(x, y, 34 * dpr * pulse, 0, 7); g.fill();
        g.fillStyle = '#fff'; g.beginPath(); g.arc(x, y, 5 * dpr, 0, 7); g.fill();
        g.fillStyle = '#ffd6dd'; g.font = `bold ${12 * dpr}px system-ui`; g.fillText('DRONE?', x + 10 * dpr, y + 18 * dpr);
      }
      list.forEach(n => {
        const [x, y] = W2P(n.pos[0], n.pos[1]), stale = n.age > STALE_MS, r = 13 * dpr;
        if (!stale && n.c > 5) { g.strokeStyle = n.st === 'drone' ? '#ff3b5c' : n.st === 'some' ? '#ffb547' : n.color; g.globalAlpha = 0.5; g.lineWidth = 3 * dpr; g.beginPath(); g.arc(x, y, r + 4 * dpr + n.c / 100 * 12 * dpr, 0, 7); g.stroke(); g.globalAlpha = 1; }
        g.fillStyle = stale ? '#3a4560' : n.color; g.beginPath(); g.arc(x, y, r, 0, 7); g.fill();
        g.fillStyle = '#04121a'; g.font = `bold ${13 * dpr}px system-ui`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(n.label, x, y + 1); g.textAlign = 'left'; g.textBaseline = 'alphabetic';
      });
      requestAnimationFrame(draw);
    }
    requestAnimationFrame(draw);
    // drag pins (map host only)
    const evPos = e => { const r = cv.getBoundingClientRect(); return [(e.clientX - r.left) * cv.width / r.width, (e.clientY - r.top) * cv.height / r.height]; };
    cv.addEventListener('pointerdown', e => {
      if (viewer) return; const [px, py] = evPos(e); let best = null, bd = 30 * Math.min(2, devicePixelRatio || 1);
      nodes.forEach(n => { const [x, y] = W2P(n.pos[0], n.pos[1]), d = Math.hypot(x - px, y - py); if (d < bd) { bd = d; best = n; } });
      if (best) { drag = best; cv.setPointerCapture(e.pointerId); e.preventDefault(); }
    });
    cv.addEventListener('pointermove', e => { if (!drag) return; const [px, py] = evPos(e), [x, y] = P2W(px, py); drag.pos = [Math.round(x * 2) / 2, Math.round(y * 2) / 2]; drag.userMoved = true; });
    const endDrag = () => { if (!drag) return; saved[drag.key] = drag.pos; localStorage.setItem(posKey, JSON.stringify(saved)); drag = null; };
    cv.addEventListener('pointerup', endDrag); cv.addEventListener('pointercancel', endDrag);

    function renderList(now) {
      const st = viewer ? viewState : null;
      const list = st ? st.nodes : [...nodes.values()].map(n => Object.assign({}, n, { age: now - n.last }));
      const AK = (st ? st.agreeKeys : agreeKeys) || [];
      $('mNodes').innerHTML = list.map(n => `<div class="nrow ${n.age > STALE_MS ? 'stale' : ''}"><div class="pin" style="background:${n.color}">${n.label}</div>
        <div class="nm">${(n.name || 'Node ' + n.label).replace(/[<>&]/g, '')}<small>${n.age > STALE_MS ? 'offline' : n.st === 'drone' ? 'DRONE' + (AK.includes(n.key) ? ' · agrees' : '') : n.st}</small><div class="meter"><i style="width:${n.c}%"></i></div></div>
        <div class="num">${n.f > 0 ? Math.round(n.f) + ' Hz' : '— Hz'}</div><div class="num">${n.e > -100 ? Math.round(n.e) + ' dB' : '— dB'}</div></div>`).join('');
    }
  }

  // ---------------- landing / roles ----------------
  function route() {
    ['landing', 'roles', 'node', 'map'].forEach(id => $(id).hidden = true);
    const { room, role } = parseHash();
    if (!room) {
      $('landing').hidden = false;
      $('newRoom').onclick = () => { location.hash = 'room=' + randKey(4); };
      $('joinBtn').onclick = () => { const c = $('joinCode').value.toLowerCase().replace(/[^a-z0-9]/g, ''); if (c) location.hash = 'room=' + c; };
      return;
    }
    if (role === 'node') return runNode(room);
    if (role === 'map') return runMap(room);
    $('roles').hidden = false; $('roomCode').textContent = room; $('roomTag').textContent = 'room ' + room;
    $('shareUrl').value = baseUrl() + '#room=' + room;
    $('copyBtn').onclick = () => { navigator.clipboard && navigator.clipboard.writeText($('shareUrl').value); $('copyBtn').textContent = 'Copied'; };
    $('beNode').onclick = () => { location.hash = 'room=' + room + '&role=node'; };
    $('beMap').onclick = () => { location.hash = 'room=' + room + '&role=map'; };
    $('simLink').href = 'sim.html#room=' + room;
  }
  window.RotorMesh = { NodeLink, hubId };
  if (!document.getElementById('landing')) return; // loaded as a library (sim.html)
  window.addEventListener('hashchange', () => location.reload());
  route();
})();
