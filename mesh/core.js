// Rotor Ear · mesh core (shared by the screen, the ear and the demo phones of the one app).
// Nodes send ONLY numbers: detector confidence, pitch, band energy, fingerprint label, and the times
// of rotor-envelope peaks (for arrival-time direction finding). Never audio. Passive only.
// Transport: PeerJS cloud (wss://0.peerjs.com:443) signalling + one WebRTC data channel per node → map.
(function () {
  'use strict';
  const BASE = document.currentScript.src.replace(/[^/]*$/, '');
  const PREFIX = 'rotorear-v1-', SEND_HZ = 8, STALE_MS = 1600, C_SOUND = 343;
  const LABELS = 'ABCDEFGHIJKLMNOP';
  const COLORS = ['#4cc9ff', '#2ee6a6', '#ffb547', '#c77dff', '#ff8fab', '#90e0ef', '#f9c74f', '#a7c957'];
  const DEFAULT_POS = [[0, 0], [6, 0], [6, 6], [0, 6], [3, -2], [8, 3], [3, 8], [-2, 3]];
  const hubId = room => PREFIX + room + '-map';
  const randKey = n => Array.from(crypto.getRandomValues(new Uint8Array(n)), b => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]).join('');
  const clamp = (x, a, b) => x < a ? a : x > b ? b : x;
  const median = a => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };
  const slope = pts => { // least-squares slope of [t(ms), y] pairs, per second
    if (pts.length < 4) return 0; const n = pts.length, mt = pts.reduce((a, p) => a + p[0], 0) / n, my = pts.reduce((a, p) => a + p[1], 0) / n;
    let sxy = 0, sxx = 0; pts.forEach(p => { sxy += (p[0] - mt) * (p[1] - my); sxx += (p[0] - mt) ** 2; }); return sxx ? sxy / sxx * 1000 : 0;
  };

  // ---------------- what a node sends (numbers only) ----------------
  const telemetry = (o, key, name, p, ev, on) => {
    const m = { t: 's', k: key, n: name, c: o.conf, f: Math.round(o.f0 * 10) / 10, e: o.e, st: o.state };
    if (o.cls) { m.cl = o.cls.label; m.cp = o.cls.conf; m.fr = +o.cls.raw.f0.toFixed(2); if (o.cls.learned) m.lr = 1; if (o.cls.why) m.wy = o.cls.why; }
    if (o.flight && o.flight.state) m.fs = o.flight.state;
    if (p) m.p = p;
    if (ev && ev.length) m.ev = ev.map(t => +t.toFixed(2));
    if (on && on.length) m.on = on.map(([t, v]) => [+t.toFixed(2), +v.toFixed(1)]); // clap onsets: [time, peak dBFS]
    return m;
  };

  // ---------------- arrival-time tap (AudioWorklet) ----------------
  // Band-passes the input around the 3rd harmonic of the detected rotor pitch (rotors drifting in and
  // out of phase "beat" 3× faster there than at the fundamental, so the envelope peaks are sharper) and
  // reports envelope-peak times in this page's performance.now() clock.
  const workletLoaded = new WeakMap();
  async function TimingTap(ctx, src) {
    if (!workletLoaded.get(ctx)) workletLoaded.set(ctx, ctx.audioWorklet.addModule(BASE + 'envelope-worklet.js'));
    await workletLoaded.get(ctx);
    const HARM = 3, bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 600; bp.Q.value = 6;
    const w = new AudioWorkletNode(ctx, 'rotor-envelope', { processorOptions: { hold: 40, gap: 60, tau: 0.005 } }), sink = ctx.createGain(); sink.gain.value = 0;
    const wo = new AudioWorkletNode(ctx, 'rotor-onset'); // raw input → clap onsets for calibration
    src.connect(bp); bp.connect(w); w.connect(sink); src.connect(wo); wo.connect(sink); sink.connect(ctx.destination);
    let off = null, events = [], onsets = [];
    const sync = () => { const ts = ctx.getOutputTimestamp && ctx.getOutputTimestamp(); off = ts && ts.contextTime > 0 ? ts.performanceTime - ts.contextTime * 1000 : performance.now() - ctx.currentTime * 1000; };
    sync(); setInterval(sync, 2000);
    w.port.onmessage = e => events.push(e.data.t * 1000 + off);
    wo.port.onmessage = e => onsets.push([e.data.t * 1000 + off, e.data.v]);
    return {
      setF0(f) { if (f > 0) bp.frequency.setTargetAtTime(f * HARM, ctx.currentTime, 0.1); },
      take() { const a = events; events = []; return a; },
      takeOnsets() { const a = onsets; onsets = []; return a; }
    };
  }

  // ---------------- transport ----------------
  // NodeLink keeps a data channel open to the room's map, reconnecting forever, and answers the
  // map's clock pings with its own clock (NTP-style) so the map can line up arrival times.
  class NodeLink {
    constructor(room, key, onStatus, onMsg, clock) {
      Object.assign(this, { room, key, onStatus, onMsg, clock: clock || (() => performance.now()), conn: null, peer: null, lastPing: 0, idSuffix: '' });
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
      c.on('data', d => {
        if (d && d.t === 'ping') { this.lastPing = Date.now(); if (d.ts != null) this.send({ t: 'pong', k: this.key, ts: d.ts, tn: this.clock() }); }
        this.onMsg && this.onMsg(d);
      });
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

  // Hub: the map owns the room's well-known peer id. If it's taken, we become a read-only viewer.
  function startHub(room, cb) {
    let peer, conns = new Set(), mode = 'hub', hubConn = null;
    const make = () => {
      peer = new Peer(mode === 'hub' ? hubId(room) : PREFIX + room + '-v-' + randKey(5), { debug: 0 });
      peer.on('open', () => { if (mode === 'hub') cb.status('map is live — waiting for nodes', 'ok'); else viewerConnect(); });
      peer.on('connection', c => {
        c.on('open', () => { conns.add(c); c.send({ t: 'ping', ts: performance.now() }); });
        c.on('data', d => cb.data(c, d));
        c.on('close', () => conns.delete(c));
        c.on('error', () => conns.delete(c));
      });
      peer.on('disconnected', () => { if (!peer.destroyed) setTimeout(() => { try { peer.reconnect(); } catch (e) {} }, 1000); });
      peer.on('error', err => {
        if (err.type === 'unavailable-id' && mode === 'hub') { mode = 'viewer'; cb.status('another map already hosts this room — viewing it', 'bad'); cb.viewer && cb.viewer(); peer.destroy(); setTimeout(make, 300); }
        else if (err.type === 'peer-unavailable' && mode === 'viewer') setTimeout(viewerConnect, 2000);
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
    // 1 Hz clock pings: nodes answer with their own clock (see NodeLink), the map keeps the lowest-RTT offset
    setInterval(() => { const ts = performance.now(); conns.forEach(c => { if (c.open) try { c.send({ t: 'ping', ts, label: c.nodeLabel }); } catch (e) {} }); }, 1000);
    return {
      get mode() { return mode; },
      get count() { return [...conns].filter(c => c.open && c.metadata && c.metadata.role === 'node').length; },
      broadcastViewers(o) { conns.forEach(c => { if (c.open && c.metadata && c.metadata.role === 'viewer') try { c.send(o); } catch (e) {} }); }
    };
  }

  // ---------------- MeshModel: everything the map knows and estimates ----------------
  class MeshModel {
    constructor(saved, cal) { this.saved = saved || {}; this.cal = cal || {}; this.calSpot = null; this.nodes = new Map(); this.truth = null; this.truthAt = 0; this.est = {}; this.trail = []; this.hold = 0; this.errs = { L: [], T: [], F: [] }; this.hErr = []; }
    node(key, d) {
      let n = this.nodes.get(key);
      if (!n) {
        const i = this.nodes.size;
        n = { key, label: d && /^sim [A-P]$/.test(d.n || '') ? d.n.slice(4) : LABELS[i % 16], color: COLORS[i % 8], pos: this.saved[key] || (d && d.p ? d.p.slice() : DEFAULT_POS[i % 8].slice()), es: null, hist: [], ev: [], on: [], sync: [], off: null, rtt: null, c: 0, last: 0 };
        this.nodes.set(key, n);
      }
      return n;
    }
    ingest(d, now = performance.now()) {
      if (!d) return null;
      if (d.t === 'truth') { this.truth = d; this.truthAt = now; return null; }
      if (d.t === 'pong') { // NTP-style: offset maps node clock → map clock; trust the lowest round trip
        const n = this.nodes.get(d.k); if (!n) return null;
        const rtt = now - d.ts; n.sync.push({ rtt, off: d.ts + rtt / 2 - d.tn }); if (n.sync.length > 12) n.sync.shift();
        const b = n.sync.reduce((a, s) => s.rtt < a.rtt ? s : a); n.off = b.off; n.rtt = b.rtt; return n;
      }
      if (d.t !== 's' || !d.k) return null;
      const n = this.node(d.k, d);
      if (!this.saved[d.k] && d.p && !n.userMoved) n.pos = d.p.slice();
      Object.assign(n, { name: d.n || '', c: d.c, f: d.f, e: d.e, st: d.st, cl: d.cl || '', cp: d.cp || 0, lr: !!d.lr, wy: d.wy || '', fs: d.fs || '', last: now });
      // calibration (if any): this phone's input latency (ms) and mic gain (dB) relative to the others
      const cal = this.cal[d.k] || { lat: 0, gain: 0 }, e = d.e - cal.gain;
      if (d.f > 0 && d.e > -100) n.es = n.es == null ? e : n.es + 0.5 * (e - n.es); else n.es = null;
      if (d.f > 0) n.hist.push([now, e, d.fr || d.f]); while (n.hist.length && now - n.hist[0][0] > 2500) n.hist.shift();
      if (d.ev && n.off != null) d.ev.forEach(t => n.ev.push(t + n.off - cal.lat));
      if (d.on && n.off != null) d.on.forEach(([t, v]) => n.on.push([t + n.off, v])); // raw (uncorrected) clap onsets, map clock
      while (n.ev.length && now - n.ev[0] > 5000) n.ev.shift();
      while (n.on.length && now - n.on[0][0] > 15000) n.on.shift();
      return n;
    }
    setCal(cal) { // new calibration: forget data measured with the old one
      this.cal = cal; this.errs = { L: [], T: [], F: [] }; this.hErr = [];
      this.nodes.forEach(n => { n.ev = []; n.es = null; n.hist = []; });
    }
    // --- estimators -----------------------------------------------------------
    // Loudness: P_i = S / r_i²  → residual spread of (ln P_i + ln r_i²) at a candidate point.
    loudCost(A) {
      const lp = A.map(n => n.es / 10 * Math.LN10), ws = A.map(n => Math.pow(10, n.es / 20)), W = ws.reduce((a, b) => a + b, 0);
      const cx = A.reduce((a, n, i) => a + n.pos[0] * ws[i], 0) / W, cy = A.reduce((a, n, i) => a + n.pos[1] * ws[i], 0) / W, LAMBDA = 0.004; // tiny pull to centroid breaks ties
      return (x, y) => { let m = 0; const r = A.map((n, i) => { const v = lp[i] + Math.log((x - n.pos[0]) ** 2 + (y - n.pos[1]) ** 2 + 1); m += v; return v; });
        m /= A.length; return r.reduce((a, v) => a + (v - m) ** 2, 0) + LAMBDA * ((x - cx) ** 2 + (y - cy) ** 2); };
    }
    // Arrival times: each node pair's TDOA should equal (r_b − r_a)/c.
    tdoaCost(P) {
      return (x, y) => P.reduce((a, q) => { const ra = Math.hypot(x - q.a.pos[0], y - q.a.pos[1], 1), rb = Math.hypot(x - q.b.pos[0], y - q.b.pos[1], 1);
        return a + ((q.dt - (rb - ra) / C_SOUND * 1000) / q.sd) ** 2; }, 0);
    }
    gridMin(A, cost) {
      const xs = A.map(n => n.pos[0]), ys = A.map(n => n.pos[1]), PAD = 6;
      let best = null, bc = Infinity;
      for (let x = Math.min(...xs) - PAD; x <= Math.max(...xs) + PAD; x += 0.25) for (let y = Math.min(...ys) - PAD; y <= Math.max(...ys) + PAD; y += 0.25) { const c = cost(x, y); if (c < bc) { bc = c; best = [x, y]; } }
      const [bx, by] = best;
      for (let x = bx - 0.3; x <= bx + 0.3; x += 0.05) for (let y = by - 0.3; y <= by + 0.3; y += 0.05) { const c = cost(x, y); if (c < bc) { bc = c; best = [x, y]; } }
      return best;
    }
    // Pair up envelope peaks between two nodes (same beat seen at both) → robust median TDOA.
    pairs(A, now) {
      const out = [];
      for (let i = 0; i < A.length; i++) for (let j = i + 1; j < A.length; j++) {
        const a = A[i], b = A[j]; if (a.off == null || b.off == null) continue;
        const maxLag = Math.hypot(a.pos[0] - b.pos[0], a.pos[1] - b.pos[1]) / C_SOUND * 1000 + 25, ds = [];
        a.ev.forEach(t => { if (t < now - 1600 || t > now - 250) return; let best = null;
          b.ev.forEach(u => { const d = u - t; if (Math.abs(d) <= maxLag && (best == null || Math.abs(d) < Math.abs(best))) best = d; });
          if (best != null) ds.push(best); });
        if (ds.length < 3) continue;
        const dt = median(ds), mad = median(ds.map(d => Math.abs(d - dt)));
        out.push({ a, b, dt, sd: Math.max(1.5, 1.86 * mad / Math.sqrt(ds.length)), n: ds.length }); // std. error of the median, floored at 1.5 ms for unmodelled per-phone latency
      }
      return out;
    }
    // Direction of travel from loudness trends (d dB/dt ∝ v·u_i / r_i) and Doppler (f_i ∝ 1 + v·u_i/c).
    heading(A, at) {
      if (A.length < 3 || !at) return null;
      const rows = [];
      A.forEach(n => { const r = Math.max(1, Math.hypot(n.pos[0] - at[0], n.pos[1] - at[1], 1)), u = [(n.pos[0] - at[0]) / r, (n.pos[1] - at[1]) / r];
        n.trend = { dB: slope(n.hist.map(h => [h[0], h[1]])), f: n.hist.length ? median(n.hist.map(h => h[2])) : 0 };
        rows.push({ u, vu: n.trend.dB * r / 8.69, f: n.trend.f }); });
      const fm = rows.reduce((a, q) => a + q.f, 0) / rows.length; // Doppler: pitch differences between nodes
      rows.forEach(q => { q.vuD = fm ? (q.f / fm - 1) * C_SOUND : 0; });
      const lsq = key => { let a = 0, b = 0, c = 0, p = 0, q = 0; const mu = rows.reduce((s, r) => s + r[key], 0) / rows.length;
        const ux = rows.reduce((s, r) => s + r.u[0], 0) / rows.length, uy = rows.reduce((s, r) => s + r.u[1], 0) / rows.length;
        rows.forEach(r => { const x0 = key === 'vuD' ? r.u[0] - ux : r.u[0], x1 = key === 'vuD' ? r.u[1] - uy : r.u[1], y = key === 'vuD' ? r[key] - mu : r[key];
          a += x0 * x0; b += x0 * x1; c += x1 * x1; p += x0 * y; q += x1 * y; });
        const det = a * c - b * b; return Math.abs(det) < 1e-6 ? [0, 0] : [(c * p - b * q) / det, (a * q - b * p) / det]; };
      const vL = lsq('vu'), vD = lsq('vuD');
      return { vL, vD, v: [vL[0] + vD[0], vL[1] + vD[1]] };
    }
    update(now = performance.now()) {
      const live = [...this.nodes.values()].filter(n => now - n.last < STALE_MS);
      const cand = live.filter(n => n.c >= 35 && n.f > 0 && n.es != null).sort((a, b) => b.c - a.c);
      const A = cand.length ? cand.filter(n => Math.abs(n.f - cand[0].f) / cand[0].f < 0.05) : [];
      const voters = A.filter(n => n.st === 'drone');
      const tally = {}; voters.forEach(n => { if (n.cl) tally[n.cl] = (tally[n.cl] || 0) + n.c * n.cp; });
      const top = Object.keys(tally).sort((a, b) => tally[b] - tally[a])[0], tn = voters.filter(n => n.cl === top);
      const label = top || '', score = tn.length ? Math.round(tn.reduce((a, n) => a + n.cp, 0) / tn.length) : 0; // class + its mean match score
      if (A.length >= 2 && voters.length >= 2) this.hold = now + 1500;
      const banner = now < this.hold ? 'drone' : live.some(n => n.st === 'hum') && !live.some(n => n.st === 'drone') ? 'hum' : live.some(n => n.c >= 30) ? 'some' : live.length ? 'quiet' : 'off';
      const P = A.length >= 3 ? this.pairs(A, now) : [];
      const E = this.est, sm = (k, p) => { E[k] = p ? (E[k] ? [E[k][0] + 0.3 * (p[0] - E[k][0]), E[k][1] + 0.3 * (p[1] - E[k][1])] : p) : null; };
      let hd = null;
      if (A.length >= 2 && voters.length >= 1) {
        let pL;
        if (A.length >= 3) pL = this.gridMin(A, this.loudCost(A));
        else { const w = A.map(n => Math.pow(10, n.es / 20)), W = w[0] + w[1]; pL = [0, 1].map(k => (A[0].pos[k] * w[0] + A[1].pos[k] * w[1]) / W); }
        sm('L', pL);
        if (P.length >= 2) {
          const lc = this.loudCost(A), tc = this.tdoaCost(P), pT = this.gridMin(A, tc);
          // Sanity gate: if arrival times put the drone far from where loudness does, the phones' timing is
          // probably off (uncalibrated mic latency), so fall back to loudness instead of trusting the lines.
          // Phones calibrated with small residuals are trusted without this check.
          this.calTrusted = A.every(n => this.cal[n.key] && (this.cal[n.key].resMs == null || this.cal[n.key].resMs < 3));
          this.tdoaOk = this.calTrusted || Math.hypot(pT[0] - pL[0], pT[1] - pL[1]) < 2.5;
          sm('T', pT); sm('F', this.tdoaOk ? this.gridMin(A, (x, y) => tc(x, y) + lc(x, y) / 0.03) : pL);
        } else { sm('T', null); sm('F', null); this.tdoaOk = false; }
        const shown = E.F || E.L; this.trail.push(shown.slice()); if (this.trail.length > 60) this.trail.shift();
        hd = this.heading(A, shown);
      } else if (banner !== 'drone') { sm('L', null); sm('T', null); sm('F', null); if (this.trail.length) this.trail.shift(); }
      // solo / per-node trend arrows (approaching vs moving away) for every live node
      live.forEach(n => { n.trendDB = n.hist.length && n.hist[n.hist.length - 1][0] - n.hist[0][0] > 2000 ? slope(n.hist.map(h => [h[0], h[1]])) : 0; }); // needs 2 s of pitch: no fake "approaching" at onset
      const tr = this.truth && now - this.truthAt < 3000 ? this.truth : null;
      const errOf = (k, p) => { const L = this.errs[k]; if (p && tr) L.push([now, Math.hypot(p[0] - tr.x, p[1] - tr.y)]); while (L.length && now - L[0][0] > 10000) L.shift(); return L.length ? +(L.reduce((a, e) => a + e[1], 0) / L.length).toFixed(2) : null; };
      const err = { L: errOf('L', E.L), T: errOf('T', E.T), F: errOf('F', E.F) };
      if (hd && tr && Math.hypot(tr.vx, tr.vy) > 0.2) { const ang = v => Math.abs(((Math.atan2(v[1], v[0]) - Math.atan2(tr.vy, tr.vx)) * 180 / Math.PI + 540) % 360 - 180);
        this.hErr.push([now, ang(hd.v), ang(hd.vL), ang(hd.vD)]); }
      while (this.hErr.length && now - this.hErr[0][0] > 10000) this.hErr.shift();
      const hm = k => this.hErr.length ? Math.round(this.hErr.reduce((a, e) => a + e[k], 0) / this.hErr.length) : null;
      return this.state = {
        nodes: [...this.nodes.values()].map(n => ({ key: n.key, label: n.label, color: n.color, pos: n.pos, name: n.name, c: n.c, f: n.f, e: n.e, st: n.st, cl: n.cl, cp: n.cp, fs: n.fs, wy: n.wy,
          age: now - n.last, trendDB: n.trendDB || 0, rtt: n.rtt, synced: n.off != null, evRate: n.ev.filter(t => t > now - 3000).length / 3 })),
        agree: A.map(n => n.key), voters: voters.length, banner, label, score, learned: tn.filter(n => n.lr).length, demo: live.some(n => /^sim /.test(n.name || '')), flight: (() => { const c = {}; tn.forEach(n => { if (n.fs) c[n.fs] = (c[n.fs] || 0) + 1; }); return Object.keys(c).sort((a, b) => c[b] - c[a])[0] || ''; })(), solo: live.length === 1 ? live[0].key : null, f0: A.length ? A[0].f : 0,
        est: E.F || E.L || null, estL: E.L, estT: E.T, estF: E.F, tdoaOk: !!(E.T && this.tdoaOk), calTrusted: !!(E.T && this.calTrusted), calSpot: this.calSpot, trail: this.trail.slice(),
        pairs: P.map(q => ({ a: q.a.key, b: q.b.key, dt: +q.dt.toFixed(2), sd: +q.sd.toFixed(2), n: q.n })),
        heading: hd && Math.hypot(...hd.v) > 0.05 ? hd.v : null, truth: tr, err, headErr: { both: hm(1), loud: hm(2), doppler: hm(3) }
      };
    }
  }

  // ---------------- MapView: draws a MeshModel state on a canvas ----------------
  // Calm by default: grey lettered pins, N arrow and a 5 m scale. The alert accent is used only for a confirmed
  // drone (marker, heading, uncertainty ring). Bearing lines are faint during a drone and hidden while quiet;
  // "Show workings" (S.ui.workings) brings back full lines, the loudness-only fit, the true drone (sim) and the legend.
  // S.ui (set by the page): { state, demo, workings, chip, lost: {pos, ago}, me, ring }
  function MapView(cv, opts = {}) {
    const g = cv.getContext('2d'); let view = { x0: -3, y0: -3, s: 12 }, drag = null, S = null;
    const sc = () => Math.min(cv.width, cv.height) / view.s;
    const W2P = (x, y) => { const k = sc(); return [cv.width / 2 + (x - view.x0 - view.s / 2) * k, cv.height / 2 - (y - view.y0 - view.s / 2) * k]; };
    const P2W = (px, py) => { const k = sc(); return [view.x0 + view.s / 2 + (px - cv.width / 2) / k, view.y0 + view.s / 2 - (py - cv.height / 2) / k]; };
    const DARK = { map: '#0f1218', ink: '#F4F6FA', ink2: '#B9C0CE', line: '#2A303C', pin: '#3a414f', pinInk: '#F4F6FA', alert: '#FF5A1F', check: '#E8B500', demo: '#A78BFA', panel: '#161A22' };
    function fitView(list) {
      if (drag) return;
      if (S.solo) { const n = list.find(m => m.key === S.solo); view = { x0: n.pos[0] - 6, y0: n.pos[1] - 6, s: 12 }; return; }
      const xs = [0, 6], ys = [0, 6]; list.forEach(n => { xs.push(n.pos[0]); ys.push(n.pos[1]); });
      const L = S.ui && S.ui.lost && S.ui.lost.pos;
      [S.est, L, S.ui && S.ui.workings && S.truth && [S.truth.x, S.truth.y]].forEach(p => { if (p) { xs.push(clamp(p[0], -12, 18)); ys.push(clamp(p[1], -12, 18)); } });
      const x0 = Math.min(...xs) - 3, x1 = Math.max(...xs) + 3, y0 = Math.min(...ys) - 3, y1 = Math.max(...ys) + 3, s = Math.max(x1 - x0, y1 - y0);
      view = { x0: (x0 + x1) / 2 - s / 2, y0: (y0 + y1) / 2 - s / 2, s };
    }
    const arrow = (x0, y0, x1, y1, col, w) => { const a = Math.atan2(y1 - y0, x1 - x0), h = 4 * w; g.strokeStyle = g.fillStyle = col; g.lineWidth = w; g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
      g.beginPath(); g.moveTo(x1, y1); g.lineTo(x1 - h * Math.cos(a - 0.45), y1 - h * Math.sin(a - 0.45)); g.lineTo(x1 - h * Math.cos(a + 0.45), y1 - h * Math.sin(a + 0.45)); g.closePath(); g.fill(); };
    const tri = (x, y, r) => { g.beginPath(); g.moveTo(x, y - r); g.lineTo(x + r * 0.95, y + r * 0.7); g.lineTo(x - r * 0.95, y + r * 0.7); g.closePath(); };
    const text = (t, x, y, col, px, bold, align) => { g.fillStyle = col; g.font = `${bold ? '600 ' : ''}${px}px system-ui`; g.textAlign = align || 'center'; g.textBaseline = 'middle'; g.fillText(t, x, y); g.textAlign = 'left'; g.textBaseline = 'alphabetic'; };
    function chip(t, x, y, C, dpr) { // neutral grey flight chip under the marker
      g.font = `500 ${12 * dpr}px system-ui`; const w = g.measureText(t).width + 20 * dpr, h = 24 * dpr;
      g.fillStyle = C.panel; g.strokeStyle = C.line; g.lineWidth = 1 * dpr; g.beginPath(); g.roundRect(x - w / 2, y - h / 2, w, h, h / 2); g.fill(); g.stroke(); text(t, x, y, C.ink, 12 * dpr, false);
    }
    // TDOA "bearing line" for a pair = the hyperbola r_b − r_a = c·dt, traced by marching squares
    function hyperbola(a, b, dt, col, w) {
      const [X0, Y1] = P2W(0, 0), [X1, Y0] = P2W(cv.width, cv.height);
      const k = dt / 1000 * C_SOUND, st = (X1 - X0) / 70, f = (x, y) => Math.hypot(x - b.pos[0], y - b.pos[1], 1) - Math.hypot(x - a.pos[0], y - a.pos[1], 1) - k;
      g.strokeStyle = col; g.lineWidth = w; g.beginPath();
      for (let x = X0; x < X1; x += st) for (let y = Y0; y < Y1; y += st) {
        const v = [f(x, y), f(x + st, y), f(x + st, y + st), f(x, y + st)], P = [[x, y], [x + st, y], [x + st, y + st], [x, y + st]], cr = [];
        for (let e = 0; e < 4; e++) { const u = v[e], w2 = v[(e + 1) % 4]; if ((u < 0) !== (w2 < 0)) { const t = u / (u - w2), p = P[e], q = P[(e + 1) % 4]; cr.push(W2P(p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1]))); } }
        if (cr.length >= 2) { g.moveTo(cr[0][0], cr[0][1]); g.lineTo(cr[1][0], cr[1][1]); }
      }
      g.stroke();
    }
    // One phone can't tell direction, only "is it getting closer?": rings for how strongly it hears rotors,
    // and chevrons pointing in (louder = approaching) or out (moving away).
    function drawSolo(n, C, dpr, now, hot) {
      if (!n || n.age > STALE_MS) return;
      const [x, y] = W2P(n.pos[0], n.pos[1]), col = hot ? C.alert : C.ink2;
      if (n.c > 5) for (let k = 0; k < 3; k++) { const ph = ((now / 1400 + k / 3) % 1), R = (20 + ph * 120) * dpr; g.strokeStyle = col; g.globalAlpha = (1 - ph) * (0.15 + n.c / 130); g.lineWidth = 2 * dpr; g.beginPath(); g.arc(x, y, R, 0, 7); g.stroke(); }
      g.globalAlpha = 1;
      if (n.f > 0 && n.c > 20) {
        const inb = n.trendDB > 1.5, outb = n.trendDB < -1.5;
        if (inb || outb) for (let k = 0; k < 8; k++) { const a = k * Math.PI / 4, r0 = 90 * dpr, r1 = 54 * dpr, [s0, s1] = inb ? [r0, r1] : [r1, r0];
          arrow(x + s0 * Math.cos(a), y + s0 * Math.sin(a), x + s1 * Math.cos(a), y + s1 * Math.sin(a), hot && inb ? C.alert : C.ink2, 3 * dpr); }
        text(hot ? (S.label || 'Drone') + (inb ? ' · approaching' : outb ? ' · moving away' : ' · same distance') : n.st === 'hum' ? '✓ not a drone' : 'hears a hum…', x, y - 104 * dpr, C.ink, 15 * dpr, true);
        if (hot && S.ui && S.ui.chip) chip(S.ui.chip, x, y + 40 * dpr, C, dpr);
        text('one phone: no direction · add phones for a position', x, y + 120 * dpr, C.ink2, 12 * dpr);
      }
    }
    function draw() {
      const dpr = Math.min(2, devicePixelRatio || 1), Wd = Math.round(cv.clientWidth * dpr), Hd = Math.round(cv.clientHeight * dpr) || Wd;
      if (cv.width !== Wd || cv.height !== Hd) { cv.width = Wd; cv.height = Hd; }
      requestAnimationFrame(draw); if (!S) return;
      const C = Object.assign({}, DARK, opts.colors ? opts.colors() : null), U = S.ui || {}, ws = U.state || '';
      const W = cv.width, H = cv.height, now = performance.now(), list = S.nodes, byKey = k => list.find(n => n.key === k);
      const hot = ws === 'drone' || ws === 'tracking', work = !!U.workings;
      fitView(list);
      g.fillStyle = C.map; g.fillRect(0, 0, W, H);
      // N arrow + 5 m scale bar
      text('N ↑', W - 22 * dpr, 18 * dpr, C.ink2, 13 * dpr, true);
      const L5 = 5 * sc(), y5 = H - 16 * dpr; g.strokeStyle = C.ink2; g.lineWidth = 2 * dpr; g.beginPath(); g.moveTo(12 * dpr, y5); g.lineTo(12 * dpr + L5, y5); g.stroke(); text('5 m', 20 * dpr + L5, y5, C.ink2, 12 * dpr, false, 'left');
      if (hot || work) (S.pairs || []).forEach(q => { const a = byKey(q.a), b = byKey(q.b); if (a && b) hyperbola(a, b, q.dt, work ? a.color + 'cc' : C.ink2 + '40', (work ? 2.2 : 1.2) * dpr); });
      if (S.calSpot) { const [x, y] = W2P(S.calSpot[0], S.calSpot[1]), ph = 1 + 0.3 * Math.sin(now / 120); g.strokeStyle = C.check; g.lineWidth = 3 * dpr; g.beginPath(); g.arc(x, y, 24 * dpr * ph, 0, 7); g.stroke(); text('👏 clap here', x, y - 34 * dpr, C.ink, 13 * dpr, true); }
      if (work && S.truth) { const [x, y] = W2P(S.truth.x, S.truth.y); g.strokeStyle = C.ink2; g.lineWidth = 2 * dpr; g.setLineDash([3 * dpr, 3 * dpr]); g.beginPath(); g.arc(x, y, 9 * dpr, 0, 7); g.stroke(); g.setLineDash([]); text('true', x, y + 20 * dpr, C.ink2, 11 * dpr); }
      if (work && S.estL && S.estF) { const [x, y] = W2P(S.estL[0], S.estL[1]); g.strokeStyle = C.check; g.lineWidth = 2 * dpr; g.beginPath(); g.arc(x, y, 6 * dpr, 0, 7); g.stroke(); }
      const E = hot ? S.est : null, T = S.trail || [];
      if (hot || ws === 'lost') { g.fillStyle = C.alert; for (let i = 0; i < T.length; i += 3) { const [a, b] = W2P(T[i][0], T[i][1]); g.globalAlpha = 0.15 + 0.5 * i / T.length; g.beginPath(); g.arc(a, b, 2.5 * dpr, 0, 7); g.fill(); } g.globalAlpha = 1; }
      if (E) {
        const [x, y] = W2P(E[0], E[1]), rr = Math.max(18 * dpr, (U.ring || 1.5) * sc());
        g.strokeStyle = C.alert; g.lineWidth = 2.5 * dpr; g.beginPath(); g.arc(x, y, rr, 0, 7); g.stroke();
        if (S.heading) { const h = S.heading, m = Math.hypot(h[0], h[1]), Lh = rr + 34 * dpr; arrow(x + h[0] / m * rr * 0.6, y - h[1] / m * rr * 0.6, x + h[0] / m * Lh, y - h[1] / m * Lh, C.alert, 3 * dpr); }
        tri(x, y + 2 * dpr, 14 * dpr);
        if (U.demo) { g.save(); g.clip(); g.strokeStyle = C.alert; g.lineWidth = 2 * dpr; for (let k = -30; k < 30; k += 5) { g.beginPath(); g.moveTo(x + k * dpr, y + 16 * dpr); g.lineTo(x + (k + 20) * dpr, y - 16 * dpr); g.stroke(); } g.restore(); tri(x, y + 2 * dpr, 14 * dpr); g.strokeStyle = C.alert; g.lineWidth = 2 * dpr; g.stroke(); }
        else { g.fillStyle = C.alert; g.fill(); }
        if (U.chip) chip(U.chip, x, y + rr + 18 * dpr, C, dpr);
      }
      if (ws === 'lost' && U.lost && U.lost.pos && !S.solo) {
        let [x, y] = W2P(U.lost.pos[0], U.lost.pos[1]); const near = 48 * dpr; // keep the marker off the phone pins
        list.forEach(n => { if (!n.pos) return; const [px, py] = W2P(n.pos[0], n.pos[1]), dx = x - px, dy = y - py, d = Math.hypot(dx, dy); if (d < near) { if (d < 1) y = py + near; else { x = px + dx / d * near; y = py + dy / d * near; } } });
        g.strokeStyle = C.alert; g.lineWidth = 2 * dpr; g.setLineDash([5 * dpr, 4 * dpr]); g.beginPath(); g.arc(x, y, 26 * dpr, 0, 7); g.stroke(); g.setLineDash([]);
        tri(x, y + 2 * dpr, 12 * dpr); g.stroke(); text('last seen ' + U.lost.ago + ' ago', x, y + 42 * dpr, C.ink, 12 * dpr);
      }
      if (S.solo) drawSolo(list.find(n => n.key === S.solo), C, dpr, now, hot);
      list.forEach(n => {
        const [x, y] = W2P(n.pos[0], n.pos[1]), stale = n.age > STALE_MS, r = 16 * dpr;
        if (!stale && ws === 'checking' && n.c >= 30 && n.st !== 'hum') { const ph = (now / 1000) % 1; g.strokeStyle = C.check; g.lineWidth = 2 * dpr; g.setLineDash([5 * dpr, 4 * dpr]);
          [8, 18].forEach(k => { g.globalAlpha = 1 - ph * 0.6; g.beginPath(); g.arc(x, y, r + (k + ph * 6) * dpr, 0, 7); g.stroke(); }); g.setLineDash([]); g.globalAlpha = 1; if (!S.solo) text('hears it', x, y + r + 34 * dpr, C.ink, 12 * dpr, true); }
        if (!stale && n.st === 'hum' && !S.solo) text('✓ hum', x, y + r + 16 * dpr, C.ink, 12 * dpr, true);
        if (!stale && (ws === 'watching' || ws === 'ready') && n.key === U.me) { const ph = (Math.sin(now / 4000 * 2 * Math.PI) + 1) / 2; g.strokeStyle = C.ink2; g.lineWidth = 1.5 * dpr; g.setLineDash([4 * dpr, 4 * dpr]); g.globalAlpha = 0.4 + 0.5 * ph; g.beginPath(); g.arc(x, y, r + (6 + 6 * ph) * dpr, 0, 7); g.stroke(); g.setLineDash([]); g.globalAlpha = 1; }
        g.fillStyle = stale ? C.line : C.pin; g.beginPath(); g.arc(x, y, r, 0, 7); g.fill(); g.strokeStyle = C.ink2; g.lineWidth = 1.2 * dpr; g.stroke();
        text(n.label, x, y + 1, stale ? C.ink2 : C.pinInk, 14 * dpr, true);
        if (n.key === U.me && (ws === 'watching' || ws === 'ready')) text('this phone', x, y + r + 24 * dpr, C.ink2, 12 * dpr);
      });
    }
    requestAnimationFrame(draw);
    const evPos = e => { const r = cv.getBoundingClientRect(); return [(e.clientX - r.left) * cv.width / r.width, (e.clientY - r.top) * cv.height / r.height]; };
    cv.addEventListener('pointerdown', e => {
      if (!opts.onDrag || !S) return; const [px, py] = evPos(e); let best = null, bd = 30 * Math.min(2, devicePixelRatio || 1);
      S.nodes.forEach(n => { const [x, y] = W2P(n.pos[0], n.pos[1]), d = Math.hypot(x - px, y - py); if (d < bd) { bd = d; best = n; } });
      if (best) { drag = best.key; cv.setPointerCapture(e.pointerId); e.preventDefault(); }
    });
    cv.addEventListener('pointermove', e => { if (!drag) return; const [px, py] = evPos(e), [x, y] = P2W(px, py); opts.onDrag(drag, [Math.round(x * 2) / 2, Math.round(y * 2) / 2], false); });
    const end = () => { if (!drag) return; const n = S.nodes.find(m => m.key === drag); if (n) opts.onDrag(drag, n.pos, true); drag = null; };
    cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);
    return { set(state) { S = state; } };
  }

  // ---------------- SimEngine: N virtual phones + a virtual drone, using the real detector ----------------
  // Each virtual phone hears the synthetic drone through a delay of r/c (so arrival times and Doppler
  // are physical), at loudness ∝ 1/r², plus its own noise. Phone imperfections are simulated on the
  // reported numbers: a random clock offset (the map must remove it by clock sync), per-event timing
  // jitter, and an optional fixed per-phone latency bias.

  // ---------------- Calibrator: clap next to the phones, solve per-phone latency + gain ----------------
  // A clap at a known spot k (next to a phone pin) reaches phone i at  t_ik = T_k + r_ik/c + L_i  (map clock,
  // after clock sync) and is heard at  dB_ik = S_k − 20·log10 r_ik + G_i.  Unknowns: clap times T_k and levels
  // S_k, and each phone's input latency L_i and mic gain G_i (both relative: Σ L = Σ G = 0). With one clap
  // the system is exactly determined (no residual); clapping next to every phone in turn over-determines it,
  // so the per-phone residuals (ms, dB) show whether the pins and the solution are right.
  const NEAR = 0.3; // m: "next to the phone"
  function solveCal(meas, keys) {
    const K = meas.length, fit = (val, use) => { // two-way additive fit: v_ik ≈ A_k + B_i, Σ B = 0
      const A = new Array(K).fill(0), B = {}; keys.forEach(k => B[k] = 0);
      for (let it = 0; it < 40; it++) {
        meas.forEach((m, k) => { const r = keys.filter(i => use(m, i)); A[k] = r.reduce((a, i) => a + val(m, i) - B[i], 0) / (r.length || 1); });
        keys.forEach(i => { const r = meas.map((m, k) => [m, k]).filter(([m]) => use(m, i)); B[i] = r.reduce((a, [m, k]) => a + val(m, i) - A[k], 0) / (r.length || 1); });
        const mb = keys.reduce((a, i) => a + B[i], 0) / keys.length; keys.forEach(i => B[i] -= mb);
      }
      const res = {}; keys.forEach(i => { const r = meas.map((m, k) => [m, k]).filter(([m]) => use(m, i)); res[i] = K > 1 && r.length ? Math.sqrt(r.reduce((a, [m, k]) => a + (val(m, i) - A[k] - B[i]) ** 2, 0) / r.length) : null; });
      return { B, res };
    };
    const r = (m, i) => m.spot.key === i ? NEAR : Math.max(NEAR, Math.hypot(m.pos[i][0] - m.spot.pos[0], m.pos[i][1] - m.spot.pos[1]));
    const lat = fit((m, i) => m.obs[i][0] - r(m, i) / C_SOUND * 1000, (m, i) => !!m.obs[i]);
    // gain: skip the clapped-at phone itself when there are other claps (a clap at 30 cm can clip the mic)
    const gain = fit((m, i) => m.obs[i][1] + 20 * Math.log10(r(m, i)), (m, i) => !!m.obs[i] && (K === 1 || m.spot.key !== i));
    const out = {}; keys.forEach(i => out[i] = { lat: +lat.B[i].toFixed(2), gain: +gain.B[i].toFixed(2), resMs: lat.res[i] == null ? null : +lat.res[i].toFixed(2), resDb: gain.res[i] == null ? null : +gain.res[i].toFixed(2), claps: K, t: Date.now() });
    return out;
  }
  class Calibrator {
    constructor(model, onDone) { this.m = model; this.onDone = onDone; this.active = false; this.msg = ''; }
    start(mode, spotKey, now = performance.now()) {
      const live = [...this.m.nodes.values()].filter(n => now - n.last < STALE_MS).sort((a, b) => a.label < b.label ? -1 : 1);
      if (live.length < 2) { this.msg = 'Need at least 2 phones listening.'; return false; }
      this.keys = live.map(n => n.key); this.spots = mode === 'quick' ? [spotKey || this.keys[0]] : this.keys.slice();
      Object.assign(this, { mode, k: 0, meas: [], since: now, active: true }); this.prompt(); return true;
    }
    get spot() { return this.active ? this.spots[this.k] : null; }
    label(k) { const n = this.m.nodes.get(k); return n ? n.label : '?'; }
    prompt(extra) {
      const n = this.m.nodes.get(this.spot); this.m.calSpot = n ? n.pos.slice() : null;
      this.msg = (extra ? extra + ' ' : '') + `Clap once, sharply, right next to phone ${this.label(this.spot)}` + (this.spots.length > 1 ? ` (${this.k + 1} of ${this.spots.length})` : '') + '.';
    }
    cancel() { this.active = false; this.m.calSpot = null; this.msg = 'Calibration cancelled.'; }
    poll(now = performance.now()) {
      if (!this.active) return;
      const per = {}; this.keys.forEach(k => { const n = this.m.nodes.get(k); per[k] = n ? n.on.filter(o => o[0] > this.since) : []; });
      const all = [].concat(...Object.values(per)); if (!all.length) return;
      const first = Math.min(...all.map(o => o[0]));
      if (now - first < 900) return; // let every phone's report arrive
      const obs = {}; this.keys.forEach(k => { const o = per[k].find(o => o[0] >= first - 20 && o[0] <= first + 300); if (o) obs[k] = o; });
      const got = Object.keys(obs).length;
      if (got < this.keys.length) { this.since = first + 20; this.prompt(`Only ${got} of ${this.keys.length} phones heard that.`); return; }
      const pos = {}; this.keys.forEach(k => pos[k] = this.m.nodes.get(k).pos.slice());
      this.meas.push({ spot: { key: this.spot, pos: pos[this.spot] }, pos, obs });
      this.since = Math.max(...Object.values(obs).map(o => o[0])) + 400; this.k++;
      if (this.k < this.spots.length) { this.prompt('✓ Got it.'); return; }
      this.active = false; this.m.calSpot = null;
      const cal = solveCal(this.meas, this.keys); this.m.setCal(cal); this.result = cal;
      const worst = Math.max(...Object.values(cal).map(c => c.resMs || 0));
      this.msg = this.spots.length > 1 ? `Calibrated ${this.keys.length} phones. Worst timing residual ${worst.toFixed(1)} ms` + (worst < 3 ? ' ✓ arrival times trusted.' : ' — re-check the pin positions and clap again.')
        : `Calibrated ${this.keys.length} phones from one clap (no residual check: clap next to each phone for that).`;
      this.onDone && this.onDone(cal);
    }
  }

  class SimEngine {
    constructor(ctx, o) {
      this.o = Object.assign({ n: 4, side: 6, path: 'circle', speed: 1, alt: 1.5, clockOffMs: 400, jitterMs: 1, biasMs: 0, gainDb: 0 }, o);
      this.ctx = ctx; this.t = 0; this.drone = null;
      const s = this.o.side, POS = [[0, 0], [s, 0], [s, s], [0, s]].slice(0, this.o.n);
      const src = RotorEar.syntheticDrone(ctx, 205 + Math.random() * 20);
      const gauss = () => Math.sqrt(-2 * Math.log(Math.random() + 1e-12)) * Math.cos(2 * Math.PI * Math.random());
      this.nodes = POS.map((p, i) => {
        const bus = ctx.createGain(), an = RotorEar.makeAnalyser(ctx), det = new RotorEar.RotorDetector(an);
        const dl = ctx.createDelay(1), g = ctx.createGain(); g.gain.value = 0;
        src.connect(dl); dl.connect(g); g.connect(bus); bus.connect(an);
        const off = (Math.random() * 2 - 1) * this.o.clockOffMs, bias = gauss() * this.o.biasMs;
        const nz = RotorEar.ambientNoise(ctx, 0.01); nz.connect(bus);
        const node = { i, p, an, bus, nz, det, dl, g, key: 'sim' + 'ABCD'[i] + randKey(3), off, bias, clock: () => performance.now() + off, ev: [], tap: null };
        TimingTap(ctx, bus).then(tp => node.tap = tp);
        node.eventsOut = () => node.tap ? node.tap.take().map(t => t + off + bias + gauss() * this.o.jitterMs) : [];
        node.onsetsOut = () => node.tap ? node.tap.takeOnsets().map(([t, v]) => [t + off + bias + gauss() * this.o.jitterMs, v]) : [];
        node.gainDb = gauss() * this.o.gainDb; bus.gain.value = Math.pow(10, node.gainDb / 20); // mic sensitivity spread
        return node;
      });
      this.src = src;
      if (this.o.path === 'demo') { // the fan of the scripted demo, heard by each phone at 1/r from a spot near phone B
        this.fan = RotorEar.syntheticFan(ctx); this.fanPos = [s + 1, -1];
        this.nodes.forEach(n => { n.fg = ctx.createGain(); n.fg.gain.value = 0; this.fan.connect(n.fg); n.fg.connect(n.bus); });
      }
    }
    // The scripted 60-second demo: 0–5 s quiet · 5–12 s a fan near phone B (ignored) · 12–20 s a drone approaches
    // from the NE · 20–30 s crosses the square and climbs · 30–45 s hovers · 45–55 s leaves to the SW · then the end card.
    script(t) {
      const s = this.o.side / 6, L = (a, b, u) => a + (b - a) * clamp(u, 0, 1), seg = (p, q, u) => [L(p[0], q[0], u), L(p[1], q[1], u)];
      const K = [[12, [13, 13]], [20, [7.5, 7.5]], [26, [3.5, 4]], [45, [3.5, 4]], [55, [-13, -13]]];
      let P = K[0][1]; for (let i = 1; i < K.length; i++) if (t < K[i][0] || i === K.length - 1) { P = seg(K[i - 1][1], K[i][1], (t - K[i - 1][0]) / (K[i][0] - K[i - 1][0])); break; }
      const lev = t < 12 ? 0 : t < 14 ? (t - 12) / 2 : t < 47 ? 1 : Math.max(0, 1 - (t - 47) / 5);
      return { P: [P[0] * s, P[1] * s], lev, pitch: t < 26 ? 1 : t < 30 ? 1 + 0.08 * (t - 26) / 4 : 1.08, fan: t >= 5 && t < 12 ? 1 : 0 };
    }
    get ended() { return this.o.path === 'demo' && this.t >= 55; }
    replay() { this.t = 0; }
    pathAt(t) {
      const w = 2 * Math.PI / 40, s = this.o.side / 6, k = this.o.path;
      const P = k === 'circle' ? [3 + 3 * Math.cos(w * t), 3 + 3 * Math.sin(w * t)] : k === 'eight' ? [3 + 5 * Math.sin(w * t), 3 + 3 * Math.sin(2 * w * t)]
        : k === 'line' ? (() => { const u = (t / 20) % 2, v = u < 1 ? u : 2 - u; return [-3 + 12 * v, 2]; })() : [4.5, 1.5];
      return [P[0] * s, P[1] * s];
    }
    step(now) {
      const dt = this.last ? (now - this.last) / 1000 : 0; this.last = now; this.t += dt * this.o.speed;
      const demo = this.o.path === 'demo', sc = demo ? this.script(this.t) : null, at = t => demo ? this.script(t).P : this.pathAt(t);
      const d = at(this.t), d2 = at(this.t + 0.05), sp = this.o.speed / 0.05, lev = demo ? sc.lev : 1;
      this.drone = lev > 0 ? { x: d[0], y: d[1], vx: (d2[0] - d[0]) * sp, vy: (d2[1] - d[1]) * sp } : null;
      if (demo && sc.pitch !== this.pitch) { this.pitch = sc.pitch; this.src.setPitch(sc.pitch, 0.3); }
      this.nodes.forEach(n => {
        const r = Math.hypot(d[0] - n.p[0], d[1] - n.p[1], this.o.alt); n.r = r;
        n.dl.delayTime.setTargetAtTime(r / C_SOUND, this.ctx.currentTime, 0.03);
        n.g.gain.setTargetAtTime(lev * 0.6 / Math.max(1, r), this.ctx.currentTime, 0.05);
        if (n.fg) n.fg.gain.setTargetAtTime(sc.fan * 0.5 / Math.max(1, Math.hypot(this.fanPos[0] - n.p[0], this.fanPos[1] - n.p[1])), this.ctx.currentTime, 0.2);
        const out = n.det.step(now); if (n.tap) n.tap.setF0(out.f0);
      });
    }
    messages() { return this.nodes.map(n => telemetry(n.det.out, n.key, 'sim ' + 'ABCD'[n.i], n.p, n.eventsOut(), n.onsetsOut())); }
    // a hand clap at (x, y): a 2 ms noise burst, physically delayed (r/c) and attenuated (1/r) to every phone
    clap(x, y) {
      const ctx = this.ctx, sr = ctx.sampleRate, b = ctx.createBuffer(1, Math.round(sr * 0.06), sr), d = b.getChannelData(0);
      for (let i = 0; i < d.length; i++) { const t = i / sr; d[i] = (Math.random() * 2 - 1) * Math.min(1, t / 0.0005) * Math.exp(-t / 0.008); }
      const t0 = ctx.currentTime + 0.05;
      this.nodes.forEach(n => {
        const r = Math.hypot(x - n.p[0], y - n.p[1]), s = ctx.createBufferSource(), dl = ctx.createDelay(1), g = ctx.createGain();
        s.buffer = b; dl.delayTime.value = r / C_SOUND; g.gain.value = 1.5 / Math.max(0.3, r);
        s.connect(dl); dl.connect(g); g.connect(n.bus); s.start(t0); s.onended = () => setTimeout(() => g.disconnect(), 1200);
      });
    }
    stop() { this.src.stop(); if (this.fan) this.fan.stop(); this.nodes.forEach(n => { n.nz.stop(); n.bus.disconnect(); }); }
  }
  // In-page loopback "link" for the watch post's sim mode: same messages, a simulated 5–40 ms network,
  // and the same ping/pong clock sync as the real relay.
  class LoopLink {
    constructor(model, node) { this.model = model; this.node = node; }
    net() { return 5 + Math.random() * 35; }
    send(m) { setTimeout(() => this.model.ingest(m), this.net()); }
    ping(ts) { setTimeout(() => this.send({ t: 'pong', k: this.node.key, ts, tn: this.node.clock() }), this.net()); }
  }

  // spectrogram palette (inferno-like), shared by the screen and the ear
  const PAL = [];
  (() => { const stops = [[0, 0, 0, 4], [0.2, 40, 11, 84], [0.4, 120, 28, 109], [0.6, 200, 60, 70], [0.8, 248, 140, 30], [1, 252, 255, 164]];
    for (let i = 0; i < 256; i++) { const t = i / 255; let k = 0; while (t > stops[k + 1][0]) k++; const [t0, r0, g0, b0] = stops[k], [t1, r1, g1, b1] = stops[k + 1], u = (t - t0) / (t1 - t0); PAL.push(`rgb(${r0 + (r1 - r0) * u | 0},${g0 + (g1 - g0) * u | 0},${b0 + (b1 - b0) * u | 0})`); } })();
  window.RotorMesh = { PAL, NEAR, solveCal, Calibrator, PREFIX, SEND_HZ, STALE_MS, C_SOUND, LABELS, COLORS, DEFAULT_POS, hubId, randKey, telemetry, TimingTap, NodeLink, startHub, MeshModel, MapView, SimEngine, LoopLink };
})();
