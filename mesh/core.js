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
    if (o.cls) { m.cl = o.cls.label; m.cp = o.cls.conf; m.fr = +o.cls.raw.f0.toFixed(2); if (o.cls.learned) m.lr = 1; if (o.cls.why) m.wy = o.cls.why; m.fx = o.cls.x; }
    else if (o.snd) { const n = o.snd; m.sn = [n.comb, n.jump, n.spread, n.mx, n.lo, n.lf, n.pk]; } // no fingerprint: what it sounded like (for the reason in words)
    if (o.flight && o.flight.state) m.fs = o.flight.state;
    const a = o.alt; // a second sound at another pitch (two drones at once): its own numbers
    if (a) { m.s2 = { c: a.conf, f: Math.round(a.f0 * 10) / 10, e: a.e, st: a.state }; if (a.cls) Object.assign(m.s2, { cl: a.cls.label, cp: a.cls.conf, fr: +a.cls.raw.f0.toFixed(2) }); if (a.flight && a.flight.state) m.s2.fs = a.flight.state; }
    if (o.hr != null) { m.nf = o.nf; m.hr = o.hr; } // coverage: drone-band noise floor (dB) and the hearing radius it implies (m)
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
      sendTo(key, o) { conns.forEach(c => { if (c.open && c.metadata && c.metadata.key === key) try { c.send(o); } catch (e) {} }); },
      broadcastViewers(o) { conns.forEach(c => { if (c.open && c.metadata && c.metadata.role === 'viewer') try { c.send(o); } catch (e) {} }); }
    };
  }

  // ---------------- MeshModel: everything the map knows and estimates ----------------
  class MeshModel {
    constructor(saved, cal) { this.saved = saved || {}; this.cal = cal || {}; this.calSpot = null; this.nodes = new Map(); this.truth = null; this.truthAt = 0; this.tracks = []; this.nid = 0; this.errs = { L: [], T: [], F: [] }; this.hErr = []; }
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
      Object.assign(n, { name: d.n || '', c: d.c, f: d.f, e: d.e, st: d.st, cl: d.cl || '', cp: d.cp || 0, lr: !!d.lr, wy: d.wy || '', fs: d.fs || '', fx: d.fx || null, fr: d.fr || 0, sn: d.sn || null, geo: d.g || null, nf: d.nf == null ? null : d.nf, hr: d.hr || null, last: now });
      // calibration (if any): this phone's input latency (ms) and mic gain (dB) relative to the others
      const cal = this.cal[d.k] || { lat: 0, gain: 0 }, prev = n.srcs || [];
      // each sound this phone reports (the lead one, plus d.s2 when it hears two drones) keeps its own smoothed loudness and
      // pitch/loudness history across messages, matched by pitch (±6%)
      const raw = [{ c: d.c, f: d.f, e: d.e, st: d.st, cl: d.cl || '', cp: d.cp || 0, lr: !!d.lr, fs: d.fs || '', fr: d.fr, lead: true }];
      if (d.s2) raw.push({ c: d.s2.c, f: d.s2.f, e: d.s2.e, st: d.s2.st, cl: d.s2.cl || '', cp: d.s2.cp || 0, lr: false, fs: d.s2.fs || '', fr: d.s2.fr, lead: false });
      n.srcs = raw.map((r, i) => {
        const p = prev.find(q => q.lf && r.f > 0 && Math.abs(q.lf - r.f) / r.f < 0.06) || (!(r.f > 0) && prev[i]) || null, e = r.e - cal.gain;
        r.lf = r.f > 0 ? r.f : p ? p.lf : 0;
        r.es = r.f > 0 && r.e > -100 ? (p && p.es != null ? p.es + 0.5 * (e - p.es) : e) : null;
        r.hist = p ? p.hist : []; if (r.f > 0) r.hist.push([now, e, r.fr || r.f]); while (r.hist.length && now - r.hist[0][0] > 2500) r.hist.shift();
        return r;
      });
      n.es = n.srcs[0].es; n.hist = n.srcs[0].hist;
      if (d.ev && n.off != null) d.ev.forEach(t => n.ev.push(t + n.off - cal.lat));
      if (d.on && n.off != null) d.on.forEach(([t, v]) => n.on.push([t + n.off, v])); // raw (uncorrected) clap onsets, map clock
      while (n.ev.length && now - n.ev[0] > 5000) n.ev.shift();
      while (n.on.length && now - n.on[0][0] > 15000) n.on.shift();
      return n;
    }
    setCal(cal) { // new calibration: forget data measured with the old one
      this.cal = cal; this.errs = { L: [], T: [], F: [] }; this.hErr = [];
      this.nodes.forEach(n => { n.ev = []; n.es = null; n.hist = []; n.srcs = []; });
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
    // One drone track: the phones hearing that pitch (A, views of their nodes) → class vote, position, heading.
    solve(T, now) {
      const A = T.A, voters = A.filter(n => n.st === 'drone');
      const tally = {}; voters.forEach(n => { if (n.cl) tally[n.cl] = (tally[n.cl] || 0) + n.c * n.cp; });
      const top = Object.keys(tally).sort((a, b) => tally[b] - tally[a])[0], tn = voters.filter(n => n.cl === top);
      Object.assign(T, { voters: voters.length, label: top || '', score: tn.length ? Math.round(tn.reduce((a, n) => a + n.cp, 0) / tn.length) : 0, learned: tn.filter(n => n.lr).length }); // class + its mean match score
      const fc = {}; tn.forEach(n => { if (n.fs) fc[n.fs] = (fc[n.fs] || 0) + 1; }); T.flight = Object.keys(fc).sort((a, b) => fc[b] - fc[a])[0] || '';
      // confirmed by 2+ phones; once confirmed, one sure phone (of 2+ hearing it) keeps it up
      if (A.length >= 2 && (voters.length >= 2 || (T.ok && voters.length >= 1))) { T.hold = now + 1500; T.ok = T.ok || voters.length >= 2; }
      // arrival times are timed on each phone's lead sound, so only those phones' peaks belong to this track
      const At = A.filter(n => n.lead), P = T.P = At.length >= 3 ? this.pairs(At, now) : [];
      const E = T.est, sm = (k, p) => { E[k] = p ? (E[k] ? [E[k][0] + 0.3 * (p[0] - E[k][0]), E[k][1] + 0.3 * (p[1] - E[k][1])] : p) : null; };
      T.hd = null;
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
          T.calTrusted = At.every(n => this.cal[n.key] && (this.cal[n.key].resMs == null || this.cal[n.key].resMs < 3));
          T.tdoaOk = T.calTrusted || Math.hypot(pT[0] - pL[0], pT[1] - pL[1]) < 2.5;
          sm('T', pT); sm('F', T.tdoaOk ? this.gridMin(A, (x, y) => tc(x, y) + lc(x, y) / 0.03) : pL);
        } else { sm('T', null); sm('F', null); T.tdoaOk = false; }
        const shown = E.F || E.L; T.trail.push(shown.slice()); if (T.trail.length > 60) T.trail.shift();
        T.hd = this.heading(A, shown);
      } else if (now >= T.hold) { sm('L', null); sm('F', null); sm('T', null); if (T.trail.length) T.trail.shift(); }
    }
    // Height: phones sit on the ground (z = 0), so a 3D fit over the last ~20 s of a track can find z. Every 0.5 s a snapshot
    // keeps what the phones hear (loudness, arrival-time pairs, pitch); once a second each candidate height is scored over all
    // snapshots: per snapshot the best spot (x, y) at that height (loudness ratios + arrival times), plus a source loudness
    // that follows one straight line in time over the pass (a drone passing overhead gets louder by (d² + z²) / z²: that is what pins z down), plus Doppler: the
    // pitch drop at each phone is sharper the closer the drone passes (rmin = speed × the drop's time scale).
    height(T, now) {
      const S = T.snap || (T.snap = []), A = T.A.filter(n => n.es != null), xy = T.est.F || T.est.L;
      if (A.length >= 3 && xy && T.voters && now - (T.snapAt || 0) >= 500) { T.snapAt = now;
        S.push({ t: now, xy: xy.slice(), ph: A.map(n => [n.pos[0], n.pos[1], n.es / 10 * Math.LN10, n.f, n.key]), P: T.tdoaOk ? T.P.map(q => [q.a.pos, q.b.pos, q.dt, q.sd]) : [] }); }
      while (S.length && now - S[0].t > 20000) S.shift();
      if (now - (T.hAt || 0) < 1000) return; T.hAt = now;
      T.h = heightFit(S);
    }
    update(now = performance.now()) {
      const live = [...this.nodes.values()].filter(n => now - n.last < STALE_MS);
      // every sound each phone reports, as a view of its node (position, clock, arrival times) carrying that sound's numbers
      const ents = []; live.forEach(n => (n.srcs || []).forEach(q => { if (q.c >= 35 && q.f > 0 && q.es != null) ents.push(Object.assign(Object.create(n), q, { node: n })); }));
      ents.sort((a, b) => b.c - a.c);
      // tracks: one per sound, matched across phones by pitch (±5%, one sound per phone); a track keeps its id and colour slot
      const used = new Set(), take = f => { const A = [], had = new Set(); ents.forEach(v => { if (!used.has(v) && !had.has(v.node) && Math.abs(v.f - f) / f < 0.05) { A.push(v); had.add(v.node); used.add(v); } }); return A; };
      this.tracks.forEach(T => { T.A = take(T.f); if (T.A.length) { T.f = T.A[0].f; T.seen = now; } });
      for (let v; this.tracks.length < 2 && (v = ents.find(x => !used.has(x)));) {
        if (this.tracks.some(T => Math.abs(v.f - T.f) / T.f < 0.08)) { used.add(v); continue; } // a second drone needs a pitch > 8% away
        const T = { id: ++this.nid, slot: [0, 1].find(k => !this.tracks.some(q => q.slot === k)), f: v.f, est: {}, trail: [], hold: 0, seen: now };
        T.A = take(v.f); this.tracks.push(T);
      }
      this.tracks = this.tracks.filter(T => T.A.length || now < T.hold || now - T.seen < 3000);
      this.tracks.forEach(T => { this.solve(T, now); this.height(T, now); });
      // the lead track drives the single-drone fields: the oldest confirmed drone, else the sound the most sure phone hears
      const held = this.tracks.filter(T => now < T.hold).sort((a, b) => a.id - b.id);
      const L = held[0] || this.tracks.find(T => ents.length && T.A.includes(ents[0])) || null, A = L ? L.A : [], E = L ? L.est : {};
      const banner = held.length ? 'drone' : live.some(n => n.st === 'hum') && !live.some(n => n.st === 'drone') ? 'hum' : live.some(n => n.c >= 30) ? 'some' : live.length ? 'quiet' : 'off';
      // solo / per-node trend arrows (approaching vs moving away) for every live node
      live.forEach(n => { n.trendDB = n.hist && n.hist.length && n.hist[n.hist.length - 1][0] - n.hist[0][0] > 2000 ? slope(n.hist.map(h => [h[0], h[1]])) : 0; }); // needs 2 s of pitch: no fake "approaching" at onset
      const tr = this.truth && now - this.truthAt < 3000 ? this.truth : null, truths = tr ? [tr].concat(tr.d2 ? [tr.d2] : []) : [];
      const near = p => truths.reduce((a, q) => !a || Math.hypot(p[0] - q.x, p[1] - q.y) < Math.hypot(p[0] - a.x, p[1] - a.y) ? q : a, null); // two drones: score each estimate against the nearer one
      const errOf = (k, p) => { const L2 = this.errs[k], q = p && near(p); if (q) L2.push([now, Math.hypot(p[0] - q.x, p[1] - q.y)]); while (L2.length && now - L2[0][0] > 10000) L2.shift(); return L2.length ? +(L2.reduce((a, e) => a + e[1], 0) / L2.length).toFixed(2) : null; };
      const err = { L: errOf('L', E.L), T: errOf('T', E.T), F: errOf('F', E.F) }, hd = L && L.hd, ht = E.F || E.L ? near(E.F || E.L) : null;
      if (hd && ht && Math.hypot(ht.vx, ht.vy) > 0.2) { const ang = v => Math.abs(((Math.atan2(v[1], v[0]) - Math.atan2(ht.vy, ht.vx)) * 180 / Math.PI + 540) % 360 - 180);
        this.hErr.push([now, ang(hd.v), ang(hd.vL), ang(hd.vD)]); }
      while (this.hErr.length && now - this.hErr[0][0] > 10000) this.hErr.shift();
      const hm = k => this.hErr.length ? Math.round(this.hErr.reduce((a, e) => a + e[k], 0) / this.hErr.length) : null;
      const head = T => T.hd && Math.hypot(...T.hd.v) > 0.05 ? T.hd.v : null, P = L ? L.P : [];
      return this.state = {
        nodes: [...this.nodes.values()].map(n => ({ key: n.key, label: n.label, color: n.color, pos: n.pos, name: n.name, c: n.c, f: n.f, e: n.e, st: n.st, cl: n.cl, cp: n.cp, lr: n.lr, fs: n.fs, wy: n.wy, fx: n.fx, fr: n.fr, sn: n.sn, geo: n.geo, nf: n.nf, hr: n.hr,
          age: now - n.last, trendDB: n.trendDB || 0, rtt: n.rtt, synced: n.off != null, evRate: n.ev.filter(t => t > now - 3000).length / 3 })),
        agree: A.map(n => n.key), voters: L ? L.voters : 0, banner, label: L ? L.label : '', score: L ? L.score : 0, learned: L ? L.learned : 0, demo: live.some(n => /^sim /.test(n.name || '')), flight: L ? L.flight : '', solo: live.length === 1 ? live[0].key : null, f0: A.length ? A[0].f : 0,
        est: E.F || E.L || null, estL: E.L || null, estT: E.T || null, estF: E.F || null, tdoaOk: !!(E.T && L.tdoaOk), calTrusted: !!(E.T && L.calTrusted), calSpot: this.calSpot, trail: L ? L.trail.slice() : [],
        pairs: P.map(q => ({ a: q.a.key, b: q.b.key, dt: +q.dt.toFixed(2), sd: +q.sd.toFixed(2), n: q.n })),
        heading: L ? head(L) : null, truth: tr, err, headErr: { both: hm(1), loud: hm(2), doppler: hm(3) },
        // every drone track (two drones at once): its own class, confidence, phones agreeing, flight, position and colour slot
        lead: L ? L.id : 0, tracks: this.tracks.map(T => ({ id: T.id, slot: T.slot, f0: T.f, hot: now < T.hold, est: T.est.F || T.est.L || null, trail: T.trail.slice(), label: T.label, score: T.score, voters: T.voters, agree: T.A.map(n => n.key), flight: T.flight, heading: head(T), tdoaOk: !!(T.est.T && T.tdoaOk),
          h: T.h || null, herr: T.h && T.h.ok && (T.est.F || T.est.L) && near(T.est.F || T.est.L) && near(T.est.F || T.est.L).z != null ? +(T.h.z - near(T.est.F || T.est.L).z).toFixed(1) : null,
          err: (T.est.F || T.est.L) && truths.length ? +Math.hypot((T.est.F || T.est.L)[0] - near(T.est.F || T.est.L).x, (T.est.F || T.est.L)[1] - near(T.est.F || T.est.L).y).toFixed(2) : null }))
      };
    }
  }

  // ---------------- height fit (see MeshModel.height) ----------------
  // → { ok, z, lo, hi (m, a 1-sigma band), n (snapshots), dop (m, Doppler alone, or null), why (when not ok) }
  const HZ = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 14, 16, 18, 20, 23, 26, 30, 35, 40, 50, 60];
  const SW = 0.173, SB = 0.345; // loudness noise per phone (0.75 dB) and drift of the drone's own loudness over a pass (1.5 dB), ln units
  function heightFit(S) {
    if (S.length < 8) return { ok: false, why: 'measuring', n: S.length };
    // phones in a line (or all in one spot) can't tell height from sideways distance: the same distances fit a whole circle
    const pts = {}; S.forEach(s => s.ph.forEach(p => pts[p[4]] = p)); const P = Object.values(pts), mx = P.reduce((a, p) => a + p[0], 0) / P.length, my = P.reduce((a, p) => a + p[1], 0) / P.length;
    const sxx = P.reduce((a, p) => a + (p[0] - mx) ** 2, 0) / P.length, syy = P.reduce((a, p) => a + (p[1] - my) ** 2, 0) / P.length, sxy = P.reduce((a, p) => a + (p[0] - mx) * (p[1] - my), 0) / P.length;
    const lmin = (sxx + syy) / 2 - Math.sqrt(((sxx - syy) / 2) ** 2 + sxy * sxy);
    if (Math.sqrt(Math.max(0, lmin)) < 0.8) return { ok: false, why: 'phones in a line', n: S.length };
    const fitAt = z => { // → total cost at height z, and each snapshot's best spot. Two passes: the second pulls every snapshot towards
      // the source loudness as a straight line in time (mm: a drone fading out or throttling up is not read as climbing), which also
      // picks the right one of two mirror spots that fit the ratios equally well
      const z2 = z * z, ts = S.map(s => (s.t - S[0].t) / 1000), tm = ts.reduce((a, b) => a + b, 0) / S.length, tv = ts.reduce((a, t) => a + (t - tm) ** 2, 0) || 1;
      let tot = 0, ms = [], best = [], mm = null;
      for (let pass = 0; pass < 2; pass++) {
        tot = 0; ms = []; best = [];
        S.forEach(s => {
          const wB = 1 / (SB * SB + SW * SW / s.ph.length), mk = mm && mm(ts[best.length]);
          const f = (x, y) => { let m = 0; const v = s.ph.map(p => { const r = p[2] + Math.log(Math.max(0.25, (x - p[0]) ** 2 + (y - p[1]) ** 2 + z2)); m += r; return r; }); m /= v.length;
            let c = v.reduce((a, r) => a + (r - m) ** 2, 0) / (SW * SW) + (mk == null ? 0 : (m - mk) ** 2 * wB);
            s.P.forEach(([a, b, dt, sd]) => { const ra = Math.sqrt((x - a[0]) ** 2 + (y - a[1]) ** 2 + z2), rb = Math.sqrt((x - b[0]) ** 2 + (y - b[1]) ** 2 + z2); c += ((dt - (rb - ra) / C_SOUND * 1000) / sd) ** 2; });
            return [c, m]; };
          let bx = s.xy[0], by = s.xy[1], bc = f(bx, by); // a 2 m grid ±14 m around the flat estimate, then a pattern search down to 2 cm
          for (let x = s.xy[0] - 14; x <= s.xy[0] + 14; x += 2) for (let y = s.xy[1] - 14; y <= s.xy[1] + 14; y += 2) { const c = f(x, y); if (c[0] < bc[0]) { bc = c; bx = x; by = y; } }
          for (let st = 1, it = 0; st > 0.02 && it < 60; it++) { let moved = false; for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) { const c = f(bx + dx * st, by + dy * st); if (c[0] < bc[0]) { bc = c; bx += dx * st; by += dy * st; moved = true; break; } } if (!moved) st /= 2; }
          tot += bc[0]; ms.push(bc[1]); best.push([bx, by]);
        });
        const mu = ms.reduce((a, b) => a + b, 0) / ms.length, sl = ms.reduce((a, m, i) => a + (m - mu) * (ts[i] - tm), 0) / tv;
        mm = t => mu + sl * (t - tm);
      }
      return { c: tot, best };
    };
    const C = HZ.map(fitAt), cs = C.map(q => q.c), k = cs.indexOf(Math.min(...cs));
    const dof = Math.max(1, S.reduce((a, s) => a + s.ph.length - 1 + s.P.length - 2, 0) + S.length - 2), sc = Math.max(1, cs[k] / dof);
    let z = HZ[k]; // parabolic refine on the (uneven) grid
    if (k > 0 && k < HZ.length - 1) { const [x0, x1, x2] = [HZ[k - 1], HZ[k], HZ[k + 1]], [y0, y1, y2] = [cs[k - 1], cs[k], cs[k + 1]], d = (x0 - x1) * (x0 - x2) * (x1 - x2);
      const A2 = (x2 * (y1 - y0) + x1 * (y0 - y2) + x0 * (y2 - y1)) / d, B2 = (x2 * x2 * (y0 - y1) + x1 * x1 * (y2 - y0) + x0 * x0 * (y1 - y2)) / d; if (A2 > 0) z = clamp(-B2 / (2 * A2), x0, x2); }
    // snapshots 0.5 s apart of a drone that barely moved are the same look again (smoothed loudness): count only looks ≥ 2 s and
    // ≥ 1.5 m apart, and widen the range by how many repeats there were, so a hover doesn't fake a tight answer
    let ne = 0, lt = -1e9, lp = null; S.forEach((s, i) => { const p = C[k].best[i]; if (s.t - lt >= 2000 && (!lp || Math.hypot(p[0] - lp[0], p[1] - lp[1]) >= 1.5)) { ne++; lt = s.t; lp = p; } });
    const lim = cs[k] + sc * S.length / Math.max(1, ne), edge = (i, dir) => { while (i + dir >= 0 && i + dir < HZ.length && cs[i + dir] <= lim) i += dir; const j = i + dir; if (j < 0 || j >= HZ.length) return null; return HZ[i] + (HZ[j] - HZ[i]) * (lim - cs[i]) / (cs[j] - cs[i]); };
    let lo = edge(k, -1), hi = edge(k, 1); if (lo == null) lo = 0; lo = Math.min(lo, z); if (hi != null) hi = Math.max(hi, z);
    const dop = doppler(S, C[k].best);
    if (dop && dop.ok) { // two independent looks at the same height: inverse-variance mix, band = the narrower one's width around it
      const wl = hi == null ? 0 : 1 / Math.max(0.5, (hi - lo) / 2) ** 2, wd = 1 / Math.max(0.5, (dop.hi - dop.lo) / 2) ** 2, zz = (z * wl + dop.z * wd) / (wl + wd), half = 1 / Math.sqrt(wl + wd);
      z = zz; lo = Math.max(0, zz - half); hi = zz + half;
    }
    // unobservable: the band runs off the top of the grid, or it is wider than 60 % of the height (and 4 m)
    const ok = hi != null && hi - lo <= Math.max(4, 0.6 * z), m = 0.25 * z + 0.5;
    // shown range: never tighter than ±(25 % + 0.5 m), the model error seen in simulated passes (smoothed loudness lags, noise floor)
    if (ok) { lo = Math.max(0, Math.min(lo, z - m)); hi = Math.max(hi, z + m); }
    const out = { z: +z.toFixed(1), lo: +lo.toFixed(1), hi: hi == null ? null : +hi.toFixed(1), n: S.length, dop: dop && dop.ok ? dop.z : null, ok };
    if (!out.ok) out.why = 'too high or too far for these phones';
    return out;
  }
  // Doppler: a straight pass at speed v; at each phone the pitch is F·(1 + vr/c) with vr = −v²(t − tc)/√(rmin² + v²(t − tc)²) and tc the
  // moment of closest approach on the ground track. Only rmin and F are free → z = √(rmin² − dmin²). Needs v ≥ 3 m/s and a 3 Hz+ swing.
  function doppler(S, xy) {
    const t0 = S[0].t, T = S.map(s => (s.t - t0) / 1000), n = T.length, mt = T.reduce((a, b) => a + b, 0) / n;
    const lin = k => { const m = xy.reduce((a, p) => a + p[k], 0) / n; let a = 0, b = 0; T.forEach((t, i) => { a += (t - mt) * (xy[i][k] - m); b += (t - mt) ** 2; }); return [a / b, m]; };
    const [vx, x0] = lin(0), [vy, y0] = lin(1), v = Math.hypot(vx, vy);
    const res = Math.sqrt(xy.reduce((a, p, i) => a + (p[0] - x0 - vx * (T[i] - mt)) ** 2 + (p[1] - y0 - vy * (T[i] - mt)) ** 2, 0) / n);
    if (v < 3 || res > 3) return null; // hovering / turning: no clean pass
    const zs = [];
    const keys = [...new Set([].concat(...S.map(s => s.ph.map(p => p[4]))))];
    keys.forEach(key => {
      const obs = []; let pos = null; S.forEach((s, i) => { const p = s.ph.find(q => q[4] === key); if (p && p[3] > 0) { obs.push([T[i], p[3]]); pos = p; } });
      if (obs.length < 10 || !pos) return;
      const u = ((pos[0] - x0) * vx + (pos[1] - y0) * vy) / (v * v), tc = mt + u, dmin = Math.hypot(x0 + vx * u - pos[0], y0 + vy * u - pos[1]);
      if (tc < obs[0][0] + 3 || tc > obs[obs.length - 1][0] - 3) return; // the closest approach must be well inside the window
      const swing = Math.max(...obs.map(o => o[1])) - Math.min(...obs.map(o => o[1])); if (swing < 3) return;
      let best = null; const prof = [];
      for (let r = Math.max(0.5, dmin); r <= 80; r *= 1.06) {
        const g = obs.map(([t]) => 1 - v * v * (t - tc) / Math.sqrt(r * r + v * v * (t - tc) ** 2) / C_SOUND), F = obs.reduce((a, o, i) => a + o[1] * g[i], 0) / g.reduce((a, x) => a + x * x, 0);
        const e = obs.reduce((a, o, i) => a + (o[1] - F * g[i]) ** 2, 0); prof.push([r, e]); if (!best || e < best[1]) best = [r, e];
      }
      const s2 = Math.max(0.3, best[1] / Math.max(1, obs.length - 2)), band = prof.filter(q => q[1] <= best[1] + s2).map(q => q[0]);
      const zz = r => Math.sqrt(Math.max(0, r * r - dmin * dmin));
      zs.push([zz(best[0]), zz(Math.min(...band)), zz(Math.max(...band))]);
    });
    if (!zs.length) return null;
    zs.sort((a, b) => a[0] - b[0]); const m = zs[zs.length >> 1];
    return { ok: m[2] < 79 && m[2] - m[1] <= Math.max(6, m[0]), z: +m[0].toFixed(1), lo: m[1], hi: m[2], n: zs.length };
  }

  // ---------------- Geo: anchor the local metre frame to GPS ----------------
  // The solver keeps working in its own metres (pins you can drag). GPS (±5 m on phones) is too rough to place
  // the pins, so it only anchors and orients that frame: the lowest-lettered phone with GPS is the origin, and
  // with 2+ GPS phones a least-squares rotation (2D Procrustes, scale fixed at 1) lines the pins up with them.
  const Geo = {
    R: 6371008.8,
    enu(lat0, lon0, lat, lon) { const r = Math.PI / 180; return [(lon - lon0) * r * Geo.R * Math.cos(lat0 * r), (lat - lat0) * r * Geo.R]; },
    fromEnu(lat0, lon0, x, y) { const r = Math.PI / 180; return [lat0 + y / (Geo.R * r), lon0 + x / (Geo.R * r * Math.cos(lat0 * r))]; },
    // pts: [{ pos: [x, y] local m, geo: [lat, lon, acc?] }] → frame { lat0, lon0, rot (rad, local→east/north), t: [e, n], res (m), n } or null
    frame(pts) {
      pts = pts.filter(p => p.geo && isFinite(p.geo[0]) && isFinite(p.geo[1])); if (!pts.length) return null;
      const [lat0, lon0] = pts[0].geo, E = pts.map(p => Geo.enu(lat0, lon0, p.geo[0], p.geo[1])), L = pts.map(p => p.pos);
      const mean = A => [0, 1].map(k => A.reduce((a, v) => a + v[k], 0) / A.length), cl = mean(L), ce = mean(E);
      let rot = 0;
      if (pts.length >= 2) { let sn = 0, cs = 0; L.forEach((l, i) => { const ax = l[0] - cl[0], ay = l[1] - cl[1], bx = E[i][0] - ce[0], by = E[i][1] - ce[1]; sn += ax * by - ay * bx; cs += ax * bx + ay * by; }); rot = Math.atan2(sn, cs); }
      const c = Math.cos(rot), s = Math.sin(rot), t = [ce[0] - (c * cl[0] - s * cl[1]), ce[1] - (s * cl[0] + c * cl[1])];
      const toEnu = (x, y) => [c * x - s * y + t[0], s * x + c * y + t[1]];
      const res = Math.sqrt(L.reduce((a, l, i) => { const q = toEnu(l[0], l[1]); return a + (q[0] - E[i][0]) ** 2 + (q[1] - E[i][1]) ** 2; }, 0) / L.length);
      return { lat0, lon0, rot, t, n: pts.length, res: +res.toFixed(2), toEnu,
        toLatLng(x, y) { const q = toEnu(x, y); return Geo.fromEnu(lat0, lon0, q[0], q[1]); },
        fromLatLng(lat, lon) { const q = Geo.enu(lat0, lon0, lat, lon), x = q[0] - t[0], y = q[1] - t[1]; return [c * x + s * y, -s * x + c * y]; },
        bearing(dx, dy) { const q = [c * dx - s * dy, s * dx + c * dy]; return (Math.atan2(q[0], q[1]) * 180 / Math.PI + 360) % 360; } }; // local direction → degrees from true north
    },
  };

  // ---------------- MapView: draws a MeshModel state on a canvas ----------------
  // Calm by default: grey lettered pins, N arrow and a 5 m scale. The alert accent is used only for a confirmed
  // drone (marker, heading, uncertainty ring). Bearing lines are faint during a drone and hidden while quiet;
  // "Show workings" (S.ui.workings) brings back full lines, the loudness-only fit, the true drone (sim) and the legend.
  // S.ui (set by the page): { state, demo, workings, chip (one phone), chips: {track id: text}, cover, lost: {pos, ago}, me, ring }
  function MapView(cv, opts = {}) {
    const g = cv.getContext('2d'), cov = document.createElement('canvas'), cg = cov.getContext('2d'); let view = { x0: -3, y0: -3, s: 12 }, drag = null, S = null, ext = null;
    // ext (opts.project): a street map under the canvas owns the projection: { W2P, P2W, k: px per m } in device px
    const sc = () => ext ? ext.k : Math.min(cv.width, cv.height) / view.s;
    const W2P = (x, y) => { if (ext) return ext.W2P(x, y); const k = sc(); return [cv.width / 2 + (x - view.x0 - view.s / 2) * k, cv.height / 2 - (y - view.y0 - view.s / 2) * k]; };
    const P2W = (px, py) => { if (ext) return ext.P2W(px, py); const k = sc(); return [view.x0 + view.s / 2 + (px - cv.width / 2) / k, view.y0 + view.s / 2 - (py - cv.height / 2) / k]; };
    const DARK = { map: '#0f1218', ink: '#F4F6FA', ink2: '#B9C0CE', line: '#2A303C', pin: '#3a414f', pinInk: '#F4F6FA', alert: '#FF5A1F', alert2: '#3DA9FC', shade: 'rgba(0,0,0,.42)', check: '#E8B500', demo: '#A78BFA', panel: '#161A22' };
    function fitView(list) {
      if (drag) return;
      if (S.solo) { const n = list.find(m => m.key === S.solo); view = { x0: n.pos[0] - 6, y0: n.pos[1] - 6, s: 12 }; return; }
      const xs = [0, 6], ys = [0, 6]; list.forEach(n => { xs.push(n.pos[0]); ys.push(n.pos[1]); }); // coverage circles don't zoom the view: they are a background layer
      const L = S.ui && S.ui.lost && S.ui.lost.pos, RP = S.ui && S.ui.replay;
      if (RP) RP.track.forEach(p => { xs.push(clamp(p[1], -30, 36)); ys.push(clamp(p[2], -30, 36)); });
      (S.tracks || []).forEach(t => { if (t.hot && t.est) { xs.push(clamp(t.est[0], -12, 18)); ys.push(clamp(t.est[1], -12, 18)); } });
      (S.remote || []).forEach(r => { xs.push(clamp(r.x, -40, 46) - 5, clamp(r.x, -40, 46) + 5); ys.push(clamp(r.y, -40, 46) - 2); }); // linked posts' drones, with room for the label
      [S.est, L, S.ui && S.ui.workings && S.truth && [S.truth.x, S.truth.y]].forEach(p => { if (p) { xs.push(clamp(p[0], -12, 18)); ys.push(clamp(p[1], -12, 18)); } });
      (S.trips || []).forEach(l => [l.a, l.b].forEach(p => { xs.push(clamp(p[0], -20, 26)); ys.push(clamp(p[1], -20, 26)); })); // tripwire lines stay in view
      if (S.tripDraft) { xs.push(clamp(S.tripDraft[0], -20, 26)); ys.push(clamp(S.tripDraft[1], -20, 26)); }
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
    // Coverage: shade everything, then rub out a soft disc of each phone's hearing radius (an offscreen layer, so the
    // street map underneath stays), plus a dashed edge and the range in metres
    function coverage(list, C, dpr) {
      const live = list.filter(n => n.hr && n.age < STALE_MS); if (!live.length || !cv.width || !cv.height) return;
      if (cov.width !== cv.width || cov.height !== cv.height) { cov.width = cv.width; cov.height = cv.height; }
      cg.globalCompositeOperation = 'source-over'; cg.clearRect(0, 0, cov.width, cov.height); cg.fillStyle = C.shade; cg.fillRect(0, 0, cov.width, cov.height);
      cg.globalCompositeOperation = 'destination-out';
      live.forEach(n => { const [x, y] = W2P(n.pos[0], n.pos[1]), R = n.hr * sc(), gr = cg.createRadialGradient(x, y, R * 0.8, x, y, R);
        gr.addColorStop(0, 'rgba(0,0,0,1)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); cg.fillStyle = gr; cg.beginPath(); cg.arc(x, y, R, 0, 7); cg.fill(); });
      g.drawImage(cov, 0, 0);
      live.forEach(n => { const [x, y] = W2P(n.pos[0], n.pos[1]), R = n.hr * sc(), big = R > 40 * dpr, t = (n.hr <= 2 ? '<2' : '~' + n.hr) + ' m';
        g.strokeStyle = C.ink2; g.globalAlpha = 0.6; g.lineWidth = 1.5 * dpr; g.setLineDash([6 * dpr, 6 * dpr]);
        g.beginPath(); g.arc(x, y, Math.max(R, 22 * dpr), 0, 7); g.stroke(); g.setLineDash([]); g.globalAlpha = 1;
        if (big && y - R > 14 * dpr) text(t, x, y - R + 12 * dpr, C.ink2, 11 * dpr); else if (!big) text('hears ' + t, x, y - 32 * dpr, C.ink2, 11 * dpr); });
    }
    // TDOA "bearing line" for a pair = the hyperbola r_b − r_a = c·dt, traced by marching squares
    function hyperbola(a, b, dt, col, w) {
      const cs = [P2W(0, 0), P2W(cv.width, 0), P2W(0, cv.height), P2W(cv.width, cv.height)], X0 = Math.min(...cs.map(c => c[0])), X1 = Math.max(...cs.map(c => c[0])), Y0 = Math.min(...cs.map(c => c[1])), Y1 = Math.max(...cs.map(c => c[1]));
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
    // tripwire lines (S.trips: [{ a, b, inS, label, hot }]): thick dashed yellow, an "in" arrow at the middle; S.tripDraft = first tap;
    // S.tripHits: [{ pt, dir }] crossing points of this episode
    function tripwires(C, dpr, now) {
      (S.trips || []).forEach(l => {
        const [ax, ay] = W2P(l.a[0], l.a[1]), [bx, by] = W2P(l.b[0], l.b[1]), hot = l.hot && Math.floor(now / 300) % 2;
        g.strokeStyle = hot ? C.alert : C.check; g.lineWidth = 4 * dpr; g.setLineDash([10 * dpr, 6 * dpr]); g.beginPath(); g.moveTo(ax, ay); g.lineTo(bx, by); g.stroke(); g.setLineDash([]);
        g.fillStyle = C.check; [[ax, ay], [bx, by]].forEach(([x, y]) => { g.beginPath(); g.arc(x, y, 5 * dpr, 0, 7); g.fill(); });
        const mx = (ax + bx) / 2, my = (ay + by) / 2, L = Math.hypot(bx - ax, by - ay) || 1, nx = (by - ay) / L * l.inS, ny = -(bx - ax) / L * l.inS; // screen y points down, so the world's left of a→b is (Δy, −Δx) on screen
        arrow(mx - nx * 10 * dpr, my - ny * 10 * dpr, mx + nx * 22 * dpr, my + ny * 22 * dpr, C.check, 2.5 * dpr);
        text('in', mx + nx * 34 * dpr, my + ny * 34 * dpr, C.check, 12 * dpr, true);
        text(l.label, bx + (bx - ax) / L * 16 * dpr - nx * 14 * dpr, by + (by - ay) / L * 16 * dpr - ny * 14 * dpr, C.ink, 12 * dpr, true); // at the b end: the middle is where crossings land
      });
      if (S.tripDraft) { const [x, y] = W2P(S.tripDraft[0], S.tripDraft[1]), ph = 1 + 0.25 * Math.sin(now / 150); g.strokeStyle = C.check; g.lineWidth = 3 * dpr; g.beginPath(); g.arc(x, y, 10 * dpr * ph, 0, 7); g.stroke(); text('tap the other end', x, y - 22 * dpr, C.ink, 12 * dpr, true); }
      (S.tripHits || []).forEach(h => { const [x, y] = W2P(h.pt[0], h.pt[1]), r = 8 * dpr; g.strokeStyle = C.alert; g.lineWidth = 4 * dpr; g.beginPath(); g.moveTo(x - r, y - r); g.lineTo(x + r, y + r); g.moveTo(x + r, y - r); g.lineTo(x - r, y + r); g.stroke(); text(h.dir === 'in' ? 'crossed IN' : 'crossed OUT', x, y + 20 * dpr, C.alert, 12 * dpr, true); });
    }
    function draw() {
      const dpr = Math.min(2, devicePixelRatio || 1), Wd = Math.round(cv.clientWidth * dpr), Hd = Math.round(cv.clientHeight * dpr) || Wd;
      if (cv.width !== Wd || cv.height !== Hd) { cv.width = Wd; cv.height = Hd; }
      requestAnimationFrame(draw); if (!S) return;
      const C = Object.assign({}, DARK, opts.colors ? opts.colors() : null), U = S.ui || {}, ws = U.state || '';
      ext = opts.project ? opts.project(dpr) : null;
      const W = cv.width, H = cv.height, now = performance.now(), list = S.nodes, byKey = k => list.find(n => n.key === k);
      const hot = ws === 'drone' || ws === 'tracking', work = !!U.workings;
      if (ext) g.clearRect(0, 0, W, H); else { fitView(list); g.fillStyle = C.map; g.fillRect(0, 0, W, H); }
      if (U.cover) coverage(list, C, dpr);
      // N arrow + 5 m scale bar
      text('N ↑', W - 22 * dpr, 18 * dpr, C.ink2, 13 * dpr, true);
      const L5 = 5 * sc(), y5 = H - 16 * dpr; g.strokeStyle = C.ink2; g.lineWidth = 2 * dpr; g.beginPath(); g.moveTo(12 * dpr, y5); g.lineTo(12 * dpr + L5, y5); g.stroke(); text('5 m', 20 * dpr + L5, y5, C.ink2, 12 * dpr, false, 'left');
      if (hot || work) (S.pairs || []).forEach(q => { const a = byKey(q.a), b = byKey(q.b); if (a && b) hyperbola(a, b, q.dt, work ? a.color + 'cc' : C.ink2 + '40', (work ? 2.2 : 1.2) * dpr); });
      if (S.calSpot) { const [x, y] = W2P(S.calSpot[0], S.calSpot[1]), ph = 1 + 0.3 * Math.sin(now / 120); g.strokeStyle = C.check; g.lineWidth = 3 * dpr; g.beginPath(); g.arc(x, y, 24 * dpr * ph, 0, 7); g.stroke(); text('👏 clap here', x, y - 34 * dpr, C.ink, 13 * dpr, true); }
      if (work && S.truth) { const [x, y] = W2P(S.truth.x, S.truth.y); g.strokeStyle = C.ink2; g.lineWidth = 2 * dpr; g.setLineDash([3 * dpr, 3 * dpr]); g.beginPath(); g.arc(x, y, 9 * dpr, 0, 7); g.stroke(); g.setLineDash([]); text('true', x, y + 20 * dpr, C.ink2, 11 * dpr); }
      if (work && S.estL && S.estF) { const [x, y] = W2P(S.estL[0], S.estL[1]); g.strokeStyle = C.check; g.lineWidth = 2 * dpr; g.beginPath(); g.arc(x, y, 6 * dpr, 0, 7); g.stroke(); }
      tripwires(C, dpr, now);
      // drones: every confirmed track (and the lead one while hot), each in its own colour: first C.alert, second C.alert2
      const dots = (T, col) => { g.fillStyle = col; for (let i = 0; i < T.length; i += 3) { const [a, b] = W2P(T[i][0], T[i][1]); g.globalAlpha = 0.15 + 0.5 * i / T.length; g.beginPath(); g.arc(a, b, 2.5 * dpr, 0, 7); g.fill(); } g.globalAlpha = 1; };
      if (ws === 'lost') dots(S.trail || [], C.alert);
      (hot ? (S.tracks || []).filter(t => t.est && (t.hot || t.id === S.lead)) : []).forEach(t => {
        const E = t.est, col = t.slot ? C.alert2 : C.alert; dots(t.trail, col);
        const [x, y] = W2P(E[0], E[1]), rr = Math.max(18 * dpr, (U.ring || 1.5) * sc());
        g.strokeStyle = col; g.lineWidth = 2.5 * dpr; g.beginPath(); g.arc(x, y, rr, 0, 7); g.stroke();
        if (t.heading) { const q = W2P(E[0] + t.heading[0], E[1] + t.heading[1]), hx = q[0] - x, hy = q[1] - y, m = Math.hypot(hx, hy) || 1, Lh = rr + 34 * dpr; arrow(x + hx / m * rr * 0.6, y + hy / m * rr * 0.6, x + hx / m * Lh, y + hy / m * Lh, col, 3 * dpr); }
        tri(x, y + 2 * dpr, 14 * dpr);
        if (U.demo) { g.save(); g.clip(); g.strokeStyle = col; g.lineWidth = 2 * dpr; for (let k = -30; k < 30; k += 5) { g.beginPath(); g.moveTo(x + k * dpr, y + 16 * dpr); g.lineTo(x + (k + 20) * dpr, y - 16 * dpr); g.stroke(); } g.restore(); tri(x, y + 2 * dpr, 14 * dpr); g.strokeStyle = col; g.lineWidth = 2 * dpr; g.stroke(); }
        else { g.fillStyle = col; g.fill(); }
        const ct = U.chips && U.chips[t.id]; if (ct) chip(ct, x, y + rr + 18 * dpr, C, dpr);
      });
      (S.remote || []).forEach(r => { // another linked post's drone: faded, with that post's name
        const [x, y] = W2P(r.x, r.y); g.globalAlpha = 0.45; g.strokeStyle = C.ink2; g.lineWidth = 2 * dpr; g.setLineDash([4 * dpr, 4 * dpr]); g.beginPath(); g.arc(x, y, 18 * dpr, 0, 7); g.stroke(); g.setLineDash([]);
        tri(x, y + 2 * dpr, 12 * dpr); g.fillStyle = C.ink2; g.fill(); g.globalAlpha = 0.8; text(r.label, x, y + 32 * dpr, C.ink2, 11 * dpr); g.globalAlpha = 1;
      });
      if (ws === 'lost' && U.lost && U.lost.pos && !S.solo) {
        let [x, y] = W2P(U.lost.pos[0], U.lost.pos[1]); const near = 48 * dpr; // keep the marker off the phone pins
        list.forEach(n => { if (!n.pos) return; const [px, py] = W2P(n.pos[0], n.pos[1]), dx = x - px, dy = y - py, d = Math.hypot(dx, dy); if (d < near) { if (d < 1) y = py + near; else { x = px + dx / d * near; y = py + dy / d * near; } } });
        g.strokeStyle = C.alert; g.lineWidth = 2 * dpr; g.setLineDash([5 * dpr, 4 * dpr]); g.beginPath(); g.arc(x, y, 26 * dpr, 0, 7); g.stroke(); g.setLineDash([]);
        tri(x, y + 2 * dpr, 12 * dpr); g.stroke(); text('last seen ' + U.lost.ago + ' ago', x, y + 42 * dpr, C.ink, 12 * dpr);
      }
      if (U.replay && !hot) {
        const RP = U.replay, pts = RP.track.filter(p => p[0] <= RP.t); g.strokeStyle = C.alert; g.lineWidth = 2.5 * dpr; g.setLineDash([6 * dpr, 5 * dpr]); g.beginPath();
        pts.forEach((p, i) => { const [a, b] = W2P(p[1], p[2]); g[i ? 'lineTo' : 'moveTo'](a, b); }); g.stroke(); g.setLineDash([]);
        const last = pts[pts.length - 1]; if (last) { const [x, y] = W2P(last[1], last[2]); tri(x, y + 2 * dpr, 13 * dpr); g.lineWidth = 3 * dpr; g.stroke(); if (RP.chip) chip(RP.chip, x, y + 30 * dpr, C, dpr); }
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
    let down = null; // a tap that isn't a pin drag → opts.onTap(world point) (drawing tripwires)
    cv.addEventListener('pointerdown', e => {
      if (!S) return; const [px, py] = evPos(e); let best = null, bd = 30 * Math.min(2, devicePixelRatio || 1); down = [px, py];
      if (opts.onDrag) S.nodes.forEach(n => { const [x, y] = W2P(n.pos[0], n.pos[1]), d = Math.hypot(x - px, y - py); if (d < bd) { bd = d; best = n; } });
      if (best && !(opts.tapping && opts.tapping())) { drag = best.key; down = null; cv.setPointerCapture(e.pointerId); e.preventDefault(); }
    });
    cv.addEventListener('pointerup', e => { if (!down || !opts.onTap) return; const [px, py] = evPos(e); if (Math.hypot(px - down[0], py - down[1]) < 14 * Math.min(2, devicePixelRatio || 1)) opts.onTap(P2W(px, py)); down = null; });
    cv.addEventListener('pointermove', e => { if (!drag) return; const [px, py] = evPos(e), [x, y] = P2W(px, py); opts.onDrag(drag, [Math.round(x * 2) / 2, Math.round(y * 2) / 2], false); });
    const end = () => { if (!drag) return; const n = S.nodes.find(m => m.key === drag); if (n) opts.onDrag(drag, n.pos, true); drag = null; };
    cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);
    return { set(state) { S = state; }, W2P: (x, y) => W2P(x, y) };
  }

  // Linked watch posts: every post's screen joins one link code. The first takes the well-known id and relays what each post sends
  // to all the others; if it goes away, the next one to notice takes over. Only track numbers travel (see watch.js), never audio.
  function linkPosts(code, me, cb) {
    const hostId = PREFIX + 'link-' + code; let peer = null, host = true, up = null, conns = new Set(), stopped = false;
    const make = () => {
      if (stopped) return;
      peer = new Peer(host ? hostId : hostId + '-' + me + '-' + randKey(3), { debug: 0 });
      peer.on('open', () => { if (host) cb.status('linked · waiting for other posts'); else join(); });
      peer.on('connection', c => {
        c.on('open', () => conns.add(c)); c.on('close', () => conns.delete(c)); c.on('error', () => conns.delete(c));
        c.on('data', d => { cb.data(d); conns.forEach(o => { if (o !== c && o.open) try { o.send(d); } catch (e) {} }); });
      });
      peer.on('error', err => {
        if (err.type === 'unavailable-id' && host) { host = false; peer.destroy(); setTimeout(make, 300); }
        else if (err.type === 'peer-unavailable' && !host) retake();
        else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) { cb.status('relay unreachable — retrying…'); peer.destroy(); setTimeout(make, 3000); }
      });
    };
    const join = () => { up = peer.connect(hostId, { reliable: false, serialization: 'json' }); up.on('open', () => cb.status('linked')); up.on('data', d => cb.data(d)); up.on('close', retake); };
    const retake = () => { if (stopped || host) return; up = null; host = true; peer.destroy(); setTimeout(make, 500 + Math.random() * 1500); };
    make();
    return {
      send(d) { if (host) conns.forEach(c => { if (c.open) try { c.send(d); } catch (e) {} }); else if (up && up.open) try { up.send(d); } catch (e) {} },
      stop() { stopped = true; if (peer) peer.destroy(); },
    };
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

  const pp = u => { u = ((u % 2) + 2) % 2; return u < 1 ? u : 2 - u; }; // ping-pong 0→1→0
  class SimEngine {
    constructor(ctx, o) {
      this.o = Object.assign({ f0: 0, n: 4, side: 6, path: 'circle', speed: 1, alt: 1.5, loud: 0, ox: 0, clockOffMs: 400, jitterMs: 1, biasMs: 0, gainDb: 0 }, o); // loud: dB louder drone (heard further); ox: where this post sits on the 'cross' line (m east)
      this.ctx = ctx; this.t = 0; this.drone = this.drone2 = null;
      const s = this.o.side, POS = [[0, 0], [s, 0], [s, s], [0, s]].slice(0, this.o.n), base = this.o.f0 || (this.o.path === 'cross' ? 215 : 205 + Math.random() * 20); // 'cross': the same drone at every post
      const src = RotorEar.syntheticDrone(ctx, base);
      // path 'two': a second, higher-pitched drone (×1.4: its low harmonics sit between the first one's)
      const src2 = this.o.path === 'two' ? RotorEar.syntheticDrone(ctx, base * 1.4) : null;
      const gauss = () => Math.sqrt(-2 * Math.log(Math.random() + 1e-12)) * Math.cos(2 * Math.PI * Math.random());
      this.nodes = POS.map((p, i) => {
        const bus = ctx.createGain(), an = RotorEar.makeAnalyser(ctx), det = new RotorEar.RotorDetector(an);
        const dl = ctx.createDelay(1), g = ctx.createGain(); g.gain.value = 0;
        src.connect(dl); dl.connect(g); g.connect(bus); bus.connect(an);
        const off = (Math.random() * 2 - 1) * this.o.clockOffMs, bias = gauss() * this.o.biasMs;
        const nz = RotorEar.ambientNoise(ctx, 0.01); nz.connect(bus);
        const node = { i, p, an, bus, nz, det, dl, g, key: 'sim' + 'ABCD'[i] + randKey(3), off, bias, clock: () => performance.now() + off, ev: [], tap: null };
        if (src2) { node.dl2 = ctx.createDelay(1); node.g2 = ctx.createGain(); node.g2.gain.value = 0; src2.connect(node.dl2); node.dl2.connect(node.g2); node.g2.connect(bus); }
        TimingTap(ctx, bus).then(tp => node.tap = tp);
        node.eventsOut = () => node.tap ? node.tap.take().map(t => t + off + bias + gauss() * this.o.jitterMs) : [];
        node.onsetsOut = () => node.tap ? node.tap.takeOnsets().map(([t, v]) => [t + off + bias + gauss() * this.o.jitterMs, v]) : [];
        node.gainDb = gauss() * this.o.gainDb; bus.gain.value = Math.pow(10, node.gainDb / 20); // mic sensitivity spread
        return node;
      });
      this.src = src; this.src2 = src2;
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
      return { P: [P[0] * s, P[1] * s], lev, pitch: t < 26 ? 1 : t < 30 ? 1 + 0.08 * (t - 26) / 4 : 1.08, fan: t >= 5 && t < 12 ? 1 : 0, alt: t < 26 ? 4 : t < 30 ? 4 + (t - 26) : 8 }; // flies in at 4 m, climbs to 8 m
    }
    get ended() { return this.o.path === 'demo' && this.t >= 55; }
    get length() { return this.o.path === 'demo' ? 60 : 0; } // s; 0 = runs until stopped
    replay() { this.t = 0; }
    pathAt(t) {
      const w = 2 * Math.PI / 40, s = this.o.side / 6, k = this.o.path;
      const P = k === 'circle' ? [3 + 3 * Math.cos(w * t), 3 + 3 * Math.sin(w * t)] : k === 'eight' ? [3 + 5 * Math.sin(w * t), 3 + 3 * Math.sin(2 * w * t)]
        : k === 'line' ? (() => { const u = (t / 20) % 2, v = u < 1 ? u : 2 - u; return [-3 + 12 * v, 2]; })()
        : k === 'two' ? (() => { const v = pp(t / 24); return [-1 + 8 * v, -1 + 8 * v]; })()
        : k === 'pass' ? [-16 + 38 * pp(t * 4 / 38), 2] // 'pass': straight over the phones at 4 m/s, back and forth
        : k === 'cross' ? [-12 + 72 * pp((Date.now() / 1000 + t - this.t) * 3 / 72) - this.o.ox, 3] : [4.5, 1.5]; // 'cross': east and back along a line at 3 m/s on the wall clock, so posts at different ox see one drone go from one to the next
      return [P[0] * s, P[1] * s];
    }
    pathAt2(t) { const v = pp(t / 24 + 0.3), s = this.o.side / 6; return [(-1 + 8 * v) * s, (7 - 8 * v) * s]; } // 'two': the other diagonal, so the tracks cross
    lev2(t) { return clamp((t - 10) / 2, 0, 1); } // 'two': the second drone shows up 10 s in (its own alert)
    step(now) {
      const dt = this.last ? (now - this.last) / 1000 : 0; this.last = now; this.t += dt * this.o.speed;
      const demo = this.o.path === 'demo', sc = demo ? this.script(this.t) : null, at = t => demo ? this.script(t).P : this.pathAt(t);
      const d = at(this.t), d2 = at(this.t + 0.05), sp = this.o.speed / 0.05, lev = demo ? sc.lev : 1, z = demo ? sc.alt : this.o.alt;
      this.drone = lev > 0 ? { x: d[0], y: d[1], z, vx: (d2[0] - d[0]) * sp, vy: (d2[1] - d[1]) * sp } : null;
      const e = this.src2 ? this.pathAt2(this.t) : null, e2 = e && this.pathAt2(this.t + 0.05);
      const lv2 = e ? this.lev2(this.t) : 0;
      this.drone2 = lv2 > 0 ? { x: e[0], y: e[1], z: this.o.alt, vx: (e2[0] - e[0]) * sp, vy: (e2[1] - e[1]) * sp } : null;
      if (demo && sc.pitch !== this.pitch) { this.pitch = sc.pitch; this.src.setPitch(sc.pitch, 0.3); }
      this.nodes.forEach(n => {
        const r = Math.hypot(d[0] - n.p[0], d[1] - n.p[1], z); n.r = r;
        n.dl.delayTime.setTargetAtTime(r / C_SOUND, this.ctx.currentTime, 0.03);
        const k = 0.6 * Math.pow(10, this.o.loud / 20); n.g.gain.setTargetAtTime(lev * k / Math.max(1, r), this.ctx.currentTime, 0.05);
        if (e) { const r2 = Math.hypot(e[0] - n.p[0], e[1] - n.p[1], this.o.alt); n.dl2.delayTime.setTargetAtTime(r2 / C_SOUND, this.ctx.currentTime, 0.03); n.g2.gain.setTargetAtTime(lv2 * k / Math.max(1, r2), this.ctx.currentTime, 0.05); }
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
    truth() { const r = o => ({ x: +o.x.toFixed(2), y: +o.y.toFixed(2), z: +o.z.toFixed(2), vx: +o.vx.toFixed(2), vy: +o.vy.toFixed(2) }), d = this.drone; // for the error readout
      return d ? Object.assign({ t: 'truth' }, r(d), this.drone2 ? { d2: r(this.drone2) } : null) : null; }
    stop() { if (this.src2) this.src2.stop(); this.src.stop(); if (this.fan) this.fan.stop(); this.nodes.forEach(n => { n.nz.stop(); n.bus.disconnect(); }); }
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
  window.RotorMesh = { linkPosts, heightFit, Geo, PAL, NEAR, solveCal, Calibrator, PREFIX, SEND_HZ, STALE_MS, C_SOUND, LABELS, COLORS, DEFAULT_POS, hubId, randKey, telemetry, TimingTap, NodeLink, startHub, MeshModel, MapView, SimEngine, LoopLink };
})();
