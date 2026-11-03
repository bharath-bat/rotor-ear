// SkyFuse sim: world, fusion brain, response timeline, rendering and UI.
(function () {
  'use strict';
  const P = window.SkyPhys, $ = id => document.getElementById(id);
  const W = 3000, EVAL_DT = 0.5, ALARM = 0.95;
  const clamp = P.clamp;

  // ---------- preset layout (metres, origin top-left, y grows south) ----------
  const HUB = { kind: 'hub', id: 'HUB', x: 1500, y: 1500, h: 10 };
  const sensors = [];
  function buildLayout() {
    sensors.length = 0; let k = 1;
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
      const n = { kind: 'node', id: 'N' + (k++), x: 750 + c * 500, y: 750 + r * 500, h: 1.5 };
      sensors.push(n);
    }
    sensors.push({ kind: 'tower', id: 'A', x: 550, y: 650, h: 30 }, { kind: 'tower', id: 'B', x: 2450, y: 700, h: 30 }, { kind: 'tower', id: 'C', x: 1500, y: 2500, h: 30 });
    sensors.push({ kind: 'cam', id: 'CAM', x: 1450, y: 1350, h: 20, az: 0, fov: 7 });
    sensors.push({ kind: 'vib', id: 'VIB', x: 1700, y: 1650, h: 12 });
    sensors.push(HUB);
    aimDishes();
  }
  // each node's dish points outward from the hub (watching the perimeter)
  function aimDishes() { for (const n of sensors) if (n.kind === 'node') { const b = P.bearing(HUB, n); n.dishAz = Math.hypot(n.x - HUB.x, n.y - HUB.y) < 50 ? 45 : b; } }
  const nodes = () => sensors.filter(s => s.kind === 'node'), towers = () => sensors.filter(s => s.kind === 'tower');
  const cam = () => sensors.find(s => s.kind === 'cam'), vib = () => sensors.find(s => s.kind === 'vib');

  const ROUTES = [
    // routes start ~1 km beyond the map edge: long-range senses may hear the drone before it is on the map
    [[3700, -550], [2200, 950], [1700, 1650], [1150, 2150], [10, 2990]],
    [[4000, 1750], [2300, 1640], [1700, 1650], [900, 1700], [5, 1250]],
    [[2750, -1000], [2650, 900], [2600, 1800], [2500, 2995]]
  ];

  // ---------- state ----------
  const S = {
    t: 0, acc: 0, playing: true, speed: 10, scen: 'jet', wind: 3, dtype: 'small', height: 60, rid: false, radio: true, route: 0,
    tog: { mics: true, lownoise: true, dish: true, ring: true, s3: true, height: true, longlisten: true, rf: true, rid: true, thermal: true, vib: true, fusion: true },
    sel: null, drone: null, jet: null, trail: [], done: false
  };
  const TOG = [
    ['mics', '🎙 Sound grid'], ['lownoise', 'Low-noise mics'], ['dish', 'Dish'], ['ring', '4-mic ring'], ['s3', 'ESP32-S3 classifier'],
    ['height', 'Nodes on 8 m poles'], ['longlisten', 'Long listening 3 s'], ['rf', '📡 RF listener'], ['rid', '🆔 Remote ID'],
    ['thermal', '🌡 Thermal cam'], ['vib', '〰 Vibration'], ['fusion', '🧠 Fusion']
  ];
  let F, R, EV, firsts, lastState, logLines;
  function reset() {
    S.t = 0; S.acc = 0; S.done = false; S.trail = []; S.rpmPhase = Math.random() * 6;
    F = { L: -5, p: 0.007, est: null, er: 0, hist: [], cue: false, loc: false, conf: false, alarmT: null, lastMeasT: -99, falseAlarms: 0, stage: 0 };
    R = { t0: null, step: 0, recStart: null };
    EV = { points: [], senses: {} };
    firsts = {}; lastState = {}; logLines = [];
    $('log').innerHTML = ''; $('first').textContent = 'Waiting for the drone…'; $('firsts').innerHTML = '';
    ['r1', 'r2', 'r3', 'r4'].forEach(id => $(id).classList.remove('done'));
    $('dl').disabled = true; $('respstate').textContent = 'arms at 95% fusion confidence'; $('pnmsg').textContent = '—';
    document.querySelectorAll('#timeline input').forEach(i => i.checked = false);
    for (const s of sensors) { s.det = false; s.conf = 0; s.hist = []; s.rep = null; s.spec = null; }
    const c = cam(); if (c) c.az = 45;
    updateDrone(); log('Flight starts: ' + P.DRONES[S.dtype].label + ', ' + S.height + ' m, radio ' + (S.radio ? 'on' : 'OFF') + ', Remote ID ' + (S.rid ? 'on' : 'off') + ', scene: ' + sceneName(), 'fus');
  }
  const sceneName = () => ({ night: 'quiet night', city: 'city day', jet: 'passing jet overhead' })[S.scen];

  // ---------- motion ----------
  function routeLen(rt) { let L = 0; for (let i = 1; i < rt.length; i++) L += Math.hypot(rt[i][0] - rt[i - 1][0], rt[i][1] - rt[i - 1][1]); return L; }
  function updateDrone() {
    const rt = ROUTES[S.route], dt = P.DRONES[S.dtype];
    let s = S.t * dt.speed, x = rt[0][0], y = rt[0][1], hd = 0, end = true;
    for (let i = 1; i < rt.length; i++) {
      const L = Math.hypot(rt[i][0] - rt[i - 1][0], rt[i][1] - rt[i - 1][1]);
      hd = P.bearing({ x: rt[i - 1][0], y: rt[i - 1][1] }, { x: rt[i][0], y: rt[i][1] });
      if (s <= L) { x = rt[i - 1][0] + (rt[i][0] - rt[i - 1][0]) * s / L; y = rt[i - 1][1] + (rt[i][1] - rt[i - 1][1]) * s / L; end = false; break; }
      s -= L; x = rt[i][0]; y = rt[i][1];
    }
    // small rpm wobble = drone speeding up / turning; the whole ladder slides together
    S.drone = { x, y, h: S.height, on: true, rpm: 1 + 0.03 * Math.sin(S.t / 3 + S.rpmPhase), radio: S.radio, rid: S.rid, hd };
    // jet: crosses the map W→E at 1.5 km altitude every 100 s, ~120 m/s (sound modelled as broadband roar)
    if (S.scen === 'jet') { const jx = -4000 + ((S.t + 30) % 100) * 120; S.jet = { x: jx, y: 1300, alt: 1500 }; } else S.jet = null;
    if (end && !S.done) { S.done = true; S.playing = false; $('play').textContent = '▶ Play'; finish(); }
  }

  // ---------- one sensing + fusion step (every 0.5 s of sim time) ----------
  function evaluate() {
    const d = S.drone, dt = P.DRONES[S.dtype], env = { scen: S.scen, wind: S.wind, tog: S.tog, jet: S.jet };
    const reps = [], T = S.tog;
    // sound grid
    for (const n of nodes()) {
      n.h = T.height ? 8 : 1.5;
      n._jetSep = S.jet ? P.angDiff(P.bearing(n, S.jet), P.bearing(n, d)) + 30 : 0; // jet mostly overhead; crude separation
      if (!T.mics) { n.det = false; n.conf = 0; n.rep = null; continue; }
      const sp = P.synth(d, dt, env, n, n.specBuf || (n.specBuf = new Float32Array(P.NB)));
      const cb = P.comb(sp.db, T.s3 ? 6 : P.HIT_DB);
      const hit = cb.hits >= 3;
      n.hist.push(hit ? cb : null); if (n.hist.length > 3) n.hist.shift();
      const good = n.hist.filter(Boolean);
      n.det = good.length >= 2;                                             // 2 of last 3 frames agree (stability)
      n.conf = n.det ? clamp((good.reduce((a, c) => a + c.s, 0) / good.length - 2) / 8, 0.2, 1) : 0;
      n.spec = { db: sp.db, floor: cb.floor, cb, jet: n._jetDb, r: sp.tn.r };
      n.rep = null;
      if (n.det) {
        n.rep = { kind: 'snd', id: n.id, conf: n.conf, f0: cb.f0, hits: cb.hits, w: cb.s };
        if (T.ring) n.rep.brg = P.bearing(n, d) + P.gauss() * 8;           // ring gives a direction (±8°)
        reps.push(n.rep);
      }
    }
    // towers: RF energy + Remote ID
    for (const tw of towers()) {
      tw.rep = null; tw.ridRep = null;
      if (T.rf) {
        let r = P.rf(d, dt, env, tw);
        if (!r && S.scen === 'city' && Math.random() < 0.025) r = { rssi: -79 - Math.random() * 3, band: '2.4', conf: 0.25, brg: Math.random() * 360, fake: true }; // WiFi clutter false blip
        if (r) { tw.rep = Object.assign({ kind: 'rf', id: tw.id }, r); reps.push(tw.rep); }
      }
      if (T.rid) { const r = P.rid(d, env, tw); if (r) { tw.ridRep = Object.assign({ kind: 'rid', id: tw.id }, r); reps.push(tw.ridRep); } }
      tw.det = !!(tw.rep || tw.ridRep); tw.conf = Math.max(tw.rep ? tw.rep.conf : 0, tw.ridRep ? 1 : 0);
    }
    // thermal camera: scans when uncued; slews to the fusion track when cued (30°/s)
    const c = cam(); c.rep = null;
    if (T.thermal) {
      let target = null;
      if (T.fusion && F.est && F.p > 0.5) { target = P.bearing(c, F.est); c.cued = true; } else c.cued = false;
      if (target == null) c.az = (c.az + 20 * EVAL_DT) % 360;
      else { const diff = ((target - c.az + 540) % 360) - 180; c.az = (c.az + clamp(diff, -15, 15) + 360) % 360; }
      const r = P.thermal(d, dt, env, c); if (r) { c.rep = Object.assign({ kind: 'cam', id: 'CAM' }, r); reps.push(c.rep); }
    }
    c.det = !!c.rep; c.conf = c.rep ? c.rep.conf : 0;
    const v = vib(); v.rep = null;
    if (T.vib) { const r = P.vibration(d, dt, v); if (r) { v.rep = Object.assign({ kind: 'vib', id: 'VIB' }, r); reps.push(v.rep); } }
    v.det = !!v.rep;

    fuse(reps);
    logTransitions(reps);
    recordEvidence(reps);
    response();
  }

  // ---------- fusion brain: log-odds evidence, association by place, single-target track ----------
  // Weights = how much one report of that sense is trusted (log-odds units per 0.5 s at conf 1).
  const WEIGHT = { rid: 3, cam: 2.5, snd: 0.6, rf: 0.55, vib: 1.5 };
  // Per-sense evidence caps: RF alone can reach "likely" (~85%) but never the 95% alarm, because a radio blip
  // can't tell a drone from a WiFi camera. Sound, Remote ID or thermal (or RF + any of them) can.
  const CAP = { rid: 12, cam: 12, snd: 9, rf: 6.7, vib: 6 };
  function fuse(reps) {
    const T = S.tog, d = S.drone;
    // --- position measurements from this step, best quality first ---
    let meas = null;
    const rid = reps.find(r => r.kind === 'rid');
    const snd = reps.filter(r => r.kind === 'snd');
    const brs = snd.filter(r => r.brg != null);
    if (rid) meas = { x: rid.x, y: rid.y, er: 20, by: 'Remote ID' };
    else if (brs.length >= 2) { const p = triangulate(brs.map(r => ({ s: byId(r.id), b: r.brg, w: r.w }))); if (p) meas = { x: p.x, y: p.y, er: 70, by: brs.length + ' sound nodes (bearings)' }; }
    if (!meas && snd.length) { let sx = 0, sy = 0, sw = 0; for (const r of snd) { const n = byId(r.id); sx += n.x * r.w; sy += n.y * r.w; sw += r.w; } meas = { x: sx / sw, y: sy / sw, er: 260, by: snd.length + ' sound node' + (snd.length > 1 ? 's' : '') }; }
    const cm = reps.find(r => r.kind === 'cam');
    if (cm) { const c = cam(), rr = cm.r * (1 + P.gauss() * 0.05), b = cm.brg * Math.PI / 180; const m = { x: c.x + Math.sin(b) * rr, y: c.y - Math.cos(b) * rr, er: 30, by: 'thermal' }; if (!meas || meas.er > 30) meas = m; }
    const rfs = reps.filter(r => r.kind === 'rf');
    if (!meas && rfs.length) {
      const env = { scen: S.scen };
      let pts = rfs.map(r => { const t = byId(r.id), rg = P.clamp(P.rfRange(r.rssi, env), 100, 4000), b = r.brg * Math.PI / 180; return { x: t.x + Math.sin(b) * rg, y: t.y - Math.cos(b) * rg, w: r.conf }; });
      if (F.est && F.p > 0.3) pts = pts.filter(p => Math.hypot(p.x - F.est.x, p.y - F.est.y) < F.er * 2 + 900);
      if (pts.length) { const sw = pts.reduce((a, p) => a + p.w, 0); meas = { x: pts.reduce((a, p) => a + p.x * p.w, 0) / sw, y: pts.reduce((a, p) => a + p.y * p.w, 0) / sw, er: rfs.length > 1 ? 450 : 700, by: 'RF towers' }; }
    }
    // --- evidence (with association gating: reports that don't fit the track count much less) ---
    const L0 = -5, B = F.B || (F.B = {});
    for (const k in B) B[k] *= Math.exp(-EVAL_DT / 8);                      // evidence fades without new support
    let nS = 0;
    for (const r of reps) {
      let w = WEIGHT[r.kind] * r.conf;
      if (r.kind === 'snd') { if (++nS > 4) continue; }
      if (F.est && F.p > 0.3 && (r.kind === 'rf') && rayDist(byId(r.id), r.brg, F.est) > F.er + 600) { w *= 0.15; r.mismatch = true; }
      B[r.kind] = Math.min(CAP[r.kind], (B[r.kind] || 0) + w);
    }
    F.L = L0 + Object.values(B).reduce((a, b) => a + b, 0);
    const pF = 1 / (1 + Math.exp(-F.L));
    // no fusion: the alarm is simply the most confident single sensor (so false blips raise alarms)
    F.p = T.fusion ? pF : reps.reduce((a, r) => Math.max(a, r.conf), 0);
    // --- track ---
    if (meas) {
      if (!F.est || Math.hypot(meas.x - F.est.x, meas.y - F.est.y) > 1600 && meas.er < F.er) { F.est = { x: meas.x, y: meas.y }; F.er = meas.er; }
      else { const k = clamp(F.er / (F.er + meas.er), 0.15, 0.85); F.est.x += k * (meas.x - F.est.x); F.est.y += k * (meas.y - F.est.y); F.er = Math.max(15, F.er * (1 - k) + meas.er * k * 0.6); }
      F.by = meas.by; F.lastMeasT = S.t;
      F.hist.push({ t: S.t, x: F.est.x, y: F.est.y }); if (F.hist.length > 400) F.hist.shift();
    } else if (F.est) { F.er = Math.min(1500, F.er + 8 * EVAL_DT); if (S.t - F.lastMeasT > 25) F.est = null; }
    // stages: cue → localise → confirm
    const cueNow = rfs.some(r => !r.mismatch && !r.fake) || !!rid, locNow = snd.length >= 2 || !!rid, confNow = !!cm;
    if (cueNow && !F.cue) { F.cue = true; log('Fusion: CUE from ' + (rid ? 'Remote ID' : 'RF tower ' + rfs[0].id) + ' → sound grid told to listen harder, camera cued', 'fus'); }
    if (locNow && !F.loc && F.est) { F.loc = true; log('Fusion: LOCALISED by ' + (F.by || 'sound grid') + ', ±' + Math.round(F.er) + ' m', 'fus'); }
    if (confNow && !F.conf) { F.conf = true; log('Fusion: CONFIRMED visually by thermal camera at ' + km(cm.r), 'fus'); mark('confirm', 'Thermal confirm'); }
    const fake = reps.filter(r => r.fake);
    if (!T.fusion && fake.length && !d.radio) {}
    if (!T.fusion && fake.length) F.falseAlarms++;
    if (F.p >= ALARM && F.alarmT == null) { F.alarmT = S.t; mark('alarm', T.fusion ? 'Fusion ≥95%' : 'single-sensor alarm'); }
  }
  function triangulate(L) {
    let a = 0, b = 0, c = 0, bx = 0, by = 0;
    for (const l of L) { const t = l.b * Math.PI / 180, ux = Math.sin(t), uy = -Math.cos(t), w = l.w;
      const m11 = 1 - ux * ux, m12 = -ux * uy, m22 = 1 - uy * uy; a += w * m11; b += w * m12; c += w * m22; bx += w * (m11 * l.s.x + m12 * l.s.y); by += w * (m12 * l.s.x + m22 * l.s.y); }
    const det = a * c - b * b; if (Math.abs(det) < 1e-6 * (a + c) * (a + c)) return null;
    const x = (c * bx - b * by) / det, y = (a * by - b * bx) / det;
    return (x > -500 && x < W + 500 && y > -500 && y < W + 500) ? { x, y } : null;
  }
  function rayDist(s, b, p) { const t = b * Math.PI / 180, ux = Math.sin(t), uy = -Math.cos(t), dx = p.x - s.x, dy = p.y - s.y, along = dx * ux + dy * uy; return along < 0 ? Math.hypot(dx, dy) : Math.abs(dx * uy - dy * ux); }
  const byId = id => sensors.find(s => s.id === id);
  const distHub = () => Math.hypot(S.drone.x - HUB.x, S.drone.y - HUB.y);
  const km = m => m >= 1000 ? (m / 1000).toFixed(1) + ' km' : Math.round(m / 10) * 10 + ' m';

  // ---------- first detections ----------
  const SENSE_NAME = { rf: 'RF listener', rid: 'Remote ID', snd: 'sound grid', cam: 'thermal camera', vib: 'vibration sensor' };
  function mark(k, label, who) {
    if (firsts[k]) return; firsts[k] = { t: S.t, d: distHub(), label, who };
    renderFirsts();
  }
  function renderFirsts() {
    const order = ['rf', 'rid', 'snd', 'cam', 'vib', 'alarm', 'confirm'];
    const real = ['rf', 'rid', 'snd', 'cam', 'vib'].filter(k => firsts[k]).sort((a, b) => firsts[a].t - firsts[b].t);
    if (real.length) { const f = firsts[real[0]]; $('first').textContent = 'First detected ' + km(f.d) + ' from the hub by ' + f.label + (f.who ? ' ' + f.who : '') + ' at ' + clock(f.t); }
    $('firsts').innerHTML = order.filter(k => firsts[k]).map(k => '<span>' + (firsts[k].label) + '</span><span>' + km(firsts[k].d) + ' out · ' + clock(firsts[k].t) + '</span>').join('');
  }

  // ---------- event log ----------
  function clock(t) { const s = Math.floor(10 * 3600 + 21 * 60 + t); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, ss = s % 60; return [h, m, ss].map(v => String(v).padStart(2, '0')).join(':'); }
  function log(msg, cls) {
    const line = clock(S.t) + ' ' + msg; logLines.push(line);
    const div = document.createElement('div'); div.className = cls || ''; div.textContent = line;
    const L = $('log'); L.prepend(div); while (L.children.length > 120) L.lastChild.remove();
  }
  function strength(c) { return c > 0.75 ? 'strong' : c > 0.45 ? 'clear' : 'weak'; }
  function logTransitions(reps) {
    const now = {};
    for (const r of reps) now[r.kind + r.id] = r;
    for (const k in now) if (!lastState[k]) {
      const r = now[k], s = byId(r.id);
      if (r.kind === 'rf') { log('RF tower ' + r.id + ': ' + strength(r.conf) + ' ' + r.band + ' GHz blip, ' + P.compass(r.brg) + ' (' + r.rssi.toFixed(0) + ' dBm)' + (r.fake ? ' · WiFi clutter?' : '') + (r.mismatch ? ' · doesn\'t fit track, down-weighted' : ''), r.fake ? 'warn' : 'rf'); if (!r.fake) mark('rf', 'RF tower', r.id); }
      else if (r.kind === 'rid') { log('Remote ID @ tower ' + r.id + ': broadcast received, position ' + Math.round(r.x) + ',' + Math.round(r.y), 'rid'); mark('rid', 'Remote ID @ tower', r.id); }
      else if (r.kind === 'snd') { log('Sound ' + r.id + ': rotor ladder f0 ' + Math.round(r.f0) + ' Hz, ' + r.hits + ' rungs' + (r.brg != null ? ', from ' + P.compass(r.brg) : ''), 'snd'); mark('snd', 'sound node', r.id); }
      else if (r.kind === 'cam') { log('Thermal: warm moving dot in view, ' + km(r.r) + ' ' + P.compass(r.brg), 'cam'); mark('cam', 'thermal camera'); }
      else if (r.kind === 'vib') { log('Vibration: roof sensor shaking, drone low overhead', 'vib'); mark('vib', 'vibration sensor'); }
    }
    for (const k in lastState) if (!now[k] && lastState[k].kind === 'snd' && Math.random() < 0) {}
    lastState = now;
  }

  // ---------- evidence + response timeline ----------
  function recordEvidence(reps) {
    const per = {}; for (const r of reps) { const k = r.kind; per[k] = Math.max(per[k] || 0, +r.conf.toFixed(2)); }
    if (F.est) EV.points.push({ time: clock(S.t), est_x_m: Math.round(F.est.x), est_y_m: Math.round(F.est.y), err_m: Math.round(F.er), fusion_conf: +F.p.toFixed(3), per_sense: per,
      true_x_m: Math.round(S.drone.x), true_y_m: Math.round(S.drone.y) });
    for (const k in per) EV.senses[k] = (EV.senses[k] || 0) + 1;
  }
  function headingTxt() {
    const h = F.hist.filter(p => S.t - p.t < 20); if (h.length < 6) return 'heading unknown';
    const k = Math.floor(h.length / 3), avg = arr => ({ x: arr.reduce((s, p) => s + p.x, 0) / arr.length, y: arr.reduce((s, p) => s + p.y, 0) / arr.length });
    const a = avg(h.slice(0, k)), b = avg(h.slice(-k)); if (Math.hypot(b.x - a.x, b.y - a.y) < 30) return 'hovering';
    return 'heading ' + P.compass(P.bearing(a, b));
  }
  function response() {
    if (F.alarmT == null) return;
    const dt = S.t - F.alarmT, est = F.est || S.drone;
    const where = 'Drone ' + P.compass(P.bearing(HUB, est)) + ', ' + km(Math.hypot(est.x - HUB.x, est.y - HUB.y)) + ', ' + headingTxt() + '. Go indoors.';
    $('pnmsg').textContent = where;
    const steps = [0, 2, 4, 6];
    steps.forEach((s, i) => { if (dt >= s && R.step <= i) { R.step = i + 1; $('r' + (i + 1)).classList.add('done');
      if (i === 0) log('RESPONSE ① alert sent to phones + siren/light: "' + where + '"', 'rsp');
      if (i === 1) { R.recStart = S.t; log('RESPONSE ② camera slewing to track, recording started', 'rsp'); }
      if (i === 2) { $('dl').disabled = false; log('RESPONSE ③ evidence log building (time, path, confidence per sense)', 'rsp'); }
      if (i === 3) log('RESPONSE ④ checklist shown: cover, police 112, DGCA Digital Sky', 'rsp'); } });
    $('respstate').textContent = 'ALARM at ' + clock(F.alarmT) + ' · +' + Math.round(dt) + ' s';
    if (R.recStart != null) { const e = Math.floor(S.t - R.recStart); $('rectime').textContent = String(Math.floor(e / 60)).padStart(2, '0') + ':' + String(e % 60).padStart(2, '0'); }
    const c = cam(); $('camtxt').textContent = S.tog.thermal ? ('Camera at ' + Math.round(c.az) + '° (' + P.compass(c.az) + ')' + (c.det ? ' · drone in frame' : ' · slewing to track')) : 'Thermal camera switched off';
    $('evtxt').textContent = EV.points.length + ' track points · senses: ' + Object.keys(EV.senses).map(k => SENSE_NAME[k]).join(', ');
  }
  function evidenceReport() {
    const real = ['rf', 'rid', 'snd', 'cam', 'vib'].filter(k => firsts[k]).sort((a, b) => firsts[a].t - firsts[b].t);
    return {
      title: 'SkyFuse sim evidence report (SIMULATED DATA)', generated: new Date().toISOString(),
      note: 'Simulation only. Passive sensing: nothing transmitted at the drone, nothing jammed or decoded. Ranges are rough model estimates.',
      scenario: { scene: sceneName(), wind_mps: S.wind, drone: P.DRONES[S.dtype].label, height_m: S.height, radio_link: S.radio, remote_id: S.rid, route: $('route').selectedOptions[0].text },
      senses_enabled: Object.keys(S.tog).filter(k => S.tog[k]),
      first_detected_by: real.length ? { sense: firsts[real[0]].label + (firsts[real[0]].who ? ' ' + firsts[real[0]].who : ''), time: clock(firsts[real[0]].t), distance_from_hub_m: Math.round(firsts[real[0]].d) } : null,
      first_by_sense: Object.fromEntries(Object.entries(firsts).map(([k, v]) => [k, { time: clock(v.t), distance_from_hub_m: Math.round(v.d) }])),
      alarm_time: F.alarmT != null ? clock(F.alarmT) : null,
      track: EV.points, event_log: logLines.slice(),
      map: { size_m: W, hub: { x: HUB.x, y: HUB.y }, sensors: sensors.map(s => ({ id: s.id, kind: s.kind, x: Math.round(s.x), y: Math.round(s.y) })) }
    };
  }
  function finish() {
    const real = ['rf', 'rid', 'snd', 'cam', 'vib'].filter(k => firsts[k]).sort((a, b) => firsts[a].t - firsts[b].t);
    if (real.length) log('Drone left the map. First detected ' + km(firsts[real[0]].d) + ' out by ' + firsts[real[0]].label + (firsts[real[0]].who ? ' ' + firsts[real[0]].who : '') + '.', 'fus');
    else log('Drone left the map undetected. Try switching senses on or a quieter scene.', 'warn');
    if (!S.tog.fusion) log('Without fusion: ' + F.falseAlarms + ' false alarm frames from RF clutter.', 'warn');
  }

  // ---------- rendering ----------
  const map = $('map'), mctx = map.getContext('2d'), spec = $('spec'), sctx = spec.getContext('2d');
  let scale = 1, dpr = 1;
  function resize() {
    dpr = window.devicePixelRatio || 1;
    const w = map.clientWidth; map.width = w * dpr; map.height = w * dpr; scale = w / W;
    spec.width = spec.clientWidth * dpr; spec.height = spec.clientHeight * dpr;
  }
  const X = v => v * scale;
  function drawMap() {
    const c = mctx, w = map.clientWidth; c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, w, w);
    c.fillStyle = '#0f1a2b'; c.fillRect(0, 0, w, w);
    c.strokeStyle = '#1b2a42'; c.lineWidth = 1; c.font = '10px sans-serif'; c.fillStyle = '#4b607c';
    for (let m = 500; m < W; m += 500) { c.beginPath(); c.moveTo(X(m), 0); c.lineTo(X(m), w); c.moveTo(0, X(m)); c.lineTo(w, X(m)); c.stroke(); if (m % 1000 === 0) { c.fillText(m / 1000 + ' km', X(m) + 2, w - 18); } }
    // range rings around hub
    c.setLineDash([3, 5]); c.strokeStyle = '#26364f'; for (const r of [1000, 2000]) { c.beginPath(); c.arc(X(HUB.x), X(HUB.y), X(r), 0, 7); c.stroke(); } c.setLineDash([]);
    c.fillStyle = '#4b607c'; c.fillText('N ↑', w - 26, 14);
    // building
    const v = vib(); c.fillStyle = '#26324a'; c.fillRect(X(v.x) - 9, X(v.y) - 7, 18, 14);
    // jet
    if (S.jet) { const jx = X(S.jet.x), jy = X(S.jet.y); if (jx > -200 && jx < w + 200) {
      const g = c.createRadialGradient(jx, jy, 2, jx, jy, X(1600)); g.addColorStop(0, '#9aa5b833'); g.addColorStop(1, '#9aa5b800'); c.fillStyle = g; c.beginPath(); c.arc(jx, jy, X(1600), 0, 7); c.fill();
      c.fillStyle = '#c4ccd8'; c.font = '16px sans-serif'; c.fillText('✈', jx - 8, jy + 6); c.font = '10px sans-serif'; c.fillText('jet 1.5 km up', jx + 10, jy - 6); } }
    // RID circles
    if (S.tog.rid) { c.strokeStyle = '#b48cff22'; for (const t of towers()) { c.beginPath(); c.arc(X(t.x), X(t.y), X(S.scen === 'city' ? 700 : 1000), 0, 7); c.stroke(); } }
    // route (faint)
    const rt = ROUTES[S.route]; c.strokeStyle = '#ff4d4d22'; c.setLineDash([2, 6]); c.beginPath(); rt.forEach((p, i) => i ? c.lineTo(X(p[0]), X(p[1])) : c.moveTo(X(p[0]), X(p[1]))); c.stroke(); c.setLineDash([]);
    const pulse = (Date.now() % 1000) / 1000;
    // sensors
    for (const s of sensors) {
      const x = X(s.x), y = X(s.y);
      if (s.kind === 'node') {
        if (S.tog.mics && S.tog.dish) { c.fillStyle = '#7fd38c10'; wedge(c, x, y, 26, s.dishAz, 44); }
        if (s.det) { ring(c, x, y, '#7fd38c', pulse); if (s.rep && s.rep.brg != null) { ray(c, x, y, s.rep.brg, X(900), '#7fd38c55'); } }
        c.fillStyle = S.tog.mics ? (s.det ? '#a6ffb4' : '#4f8f5a') : '#33465f'; c.beginPath(); c.arc(x, y, s === S.sel ? 6 : 4.5, 0, 7); c.fill();
        if (s === S.sel) { c.strokeStyle = '#fff'; c.lineWidth = 1.5; c.beginPath(); c.arc(x, y, 9, 0, 7); c.stroke(); c.lineWidth = 1; }
      } else if (s.kind === 'tower') {
        if (s.rep) { ring(c, x, y, s.rep.fake ? '#ff8a8a' : '#b48cff', pulse); c.fillStyle = s.rep.fake ? '#ff8a8a14' : '#b48cff1c'; wedge(c, x, y, X(Math.min(1400, P.rfRange(s.rep.rssi, { scen: S.scen }))), s.rep.brg, 44); }
        if (s.ridRep) ring(c, x, y, '#ffffff', (pulse + 0.5) % 1);
        c.fillStyle = (S.tog.rf || S.tog.rid) ? '#b48cff' : '#3b3355'; c.beginPath(); c.moveTo(x, y - 8); c.lineTo(x + 7, y + 6); c.lineTo(x - 7, y + 6); c.fill();
        c.fillStyle = '#e6dcff'; c.font = 'bold 11px sans-serif'; c.fillText(s.id, x + 8, y - 4);
      } else if (s.kind === 'cam') {
        if (S.tog.thermal) { c.fillStyle = s.det ? '#ffb34766' : '#ffb34722'; wedge(c, x, y, X(1100), s.az, s.fov); }
        if (s.det) ring(c, x, y, '#ffb347', pulse);
        c.fillStyle = S.tog.thermal ? '#ffb347' : '#4a3a22'; c.fillRect(x - 5, y - 5, 10, 10);
      } else if (s.kind === 'vib') {
        if (s.det) ring(c, x, y, '#ff7ad9', pulse);
        c.fillStyle = S.tog.vib ? '#ff7ad9' : '#4a2a42'; c.save(); c.translate(x, y); c.rotate(Math.PI / 4); c.fillRect(-4, -4, 8, 8); c.restore();
      } else if (s.kind === 'hub') { c.fillStyle = '#fff'; c.font = '15px sans-serif'; c.fillText('★', x - 6, y + 5); c.font = '10px sans-serif'; c.fillText('hub', x + 8, y + 4); }
    }
    // estimate
    if (F.est) { const x = X(F.est.x), y = X(F.est.y); c.strokeStyle = '#4fe3ff'; c.fillStyle = '#4fe3ff14'; c.beginPath(); c.arc(x, y, Math.max(6, X(F.er)), 0, 7); c.fill(); c.stroke();
      c.beginPath(); c.moveTo(x - 8, y); c.lineTo(x + 8, y); c.moveTo(x, y - 8); c.lineTo(x, y + 8); c.stroke(); c.fillStyle = '#4fe3ff'; c.font = '10px sans-serif'; c.fillText('estimate ' + Math.round(F.p * 100) + '%', x + 9, y + 12); }
    // drone + trail
    c.strokeStyle = '#ff4d4d88'; c.beginPath(); S.trail.forEach((p, i) => i ? c.lineTo(X(p.x), X(p.y)) : c.moveTo(X(p.x), X(p.y))); c.stroke();
    const d = S.drone; if (d) { const x = X(d.x), y = X(d.y); c.fillStyle = '#ff4d4d'; for (const [ox, oy] of [[-4, -4], [4, -4], [-4, 4], [4, 4]]) { c.beginPath(); c.arc(x + ox, y + oy, 2.6, 0, 7); c.fill(); } c.fillRect(x - 1.5, y - 1.5, 3, 3);
      c.font = '10px sans-serif'; c.fillText('drone ' + S.height + ' m', x + 8, y - 6);
      if (x < 0 || y < 0 || x > w || y > w) { const ex = clamp(x, 14, w - 70), ey = clamp(y, 30, w - 30); c.fillText('◀ drone ' + km(Math.hypot(d.x - HUB.x, d.y - HUB.y)) + ' out (off map)', ex, ey); } }
    // alarm flash
    if (F.alarmT != null && S.t - F.alarmT < 8 && pulse < 0.5) { c.strokeStyle = '#ff4d4d'; c.lineWidth = 4; c.strokeRect(2, 2, w - 4, w - 4); c.lineWidth = 1; }
  }
  function ring(c, x, y, col, ph) { c.strokeStyle = col; c.globalAlpha = 1 - ph; c.lineWidth = 2; c.beginPath(); c.arc(x, y, 7 + ph * 14, 0, 7); c.stroke(); c.globalAlpha = 1; c.lineWidth = 1; }
  function wedge(c, x, y, r, az, fov) { const a = (az - 90) * Math.PI / 180, h = fov / 2 * Math.PI / 180; c.beginPath(); c.moveTo(x, y); c.arc(x, y, r, a - h, a + h); c.closePath(); c.fill(); }
  function ray(c, x, y, b, len, col) { const t = b * Math.PI / 180; c.strokeStyle = col; c.beginPath(); c.moveTo(x, y); c.lineTo(x + Math.sin(t) * len, y - Math.cos(t) * len); c.stroke(); }

  function pickSel() { // auto: follow the node with the strongest ladder (or the nearest one)
    if (S.selPinned && S.sel) return S.sel;
    let best = null, bs = -1; for (const n of nodes()) { const sc = n.det ? 10 + n.conf : -Math.hypot(n.x - S.drone.x, n.y - S.drone.y) / 1e4; if (sc > bs) { bs = sc; best = n; } }
    S.sel = best; return best;
  }
  function drawSpec() {
    const c = sctx, w = spec.clientWidth, h = spec.clientHeight; c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, w, h);
    const n = S.sel, sp = n && n.spec, FM = 2500, lo = -10, hi = 60, yy = v => h - 14 - (clamp(v, lo, hi) - lo) / (hi - lo) * (h - 20), xx = f => f / FM * w;
    c.fillStyle = '#4b607c'; c.font = '10px sans-serif'; for (let f = 500; f < FM; f += 500) { c.fillText(f + ' Hz', xx(f) - 14, h - 2); }
    if (!sp) { c.fillText(S.tog.mics ? 'waiting…' : 'sound grid off', 10, 20); $('spinfo').textContent = ''; return; }
    const nb = Math.floor(FM / P.BIN_HZ);
    if (sp.jet) { c.fillStyle = '#9aa5b833'; c.beginPath(); c.moveTo(0, h - 14); for (let i = 1; i < nb; i++) c.lineTo(xx(i * P.BIN_HZ), yy(sp.jet[i])); c.lineTo(w, h - 14); c.fill(); }
    c.strokeStyle = '#2b82e8'; c.beginPath(); for (let i = 1; i < nb; i++) { const x = xx(i * P.BIN_HZ), y = yy(sp.db[i]); i > 1 ? c.lineTo(x, y) : c.moveTo(x, y); } c.stroke();
    c.strokeStyle = '#ffffff44'; c.setLineDash([3, 3]); c.beginPath(); for (let i = 1; i < nb; i++) { const x = xx(i * P.BIN_HZ), y = yy(sp.floor[i] + (S.tog.s3 ? 6 : 9)); i > 1 ? c.lineTo(x, y) : c.moveTo(x, y); } c.stroke(); c.setLineDash([]);
    const cb = sp.cb;
    if (cb && cb.hits >= 3) for (const r of cb.rungs) if (r.f < FM) { c.fillStyle = r.hit ? '#ffd34d' : '#ffd34d33'; c.fillRect(xx(r.f) - 2, yy(sp.floor[Math.round(r.f / P.BIN_HZ)] || 0), 4, -Math.max(4, r.e / (hi - lo) * (h - 20))); }
    $('spttl').textContent = 'Spectrum at node ' + n.id + (S.selPinned ? ' (pinned)' : ' (auto)');
    $('spinfo').textContent = (cb && cb.hits >= 3 ? 'ladder f0 ' + Math.round(cb.f0) + ' Hz · ' + cb.hits + ' rungs' : 'no ladder') + ' · drone ' + km(sp.r);
  }
  function drawPanel() {
    const p = F.p, st = $('pstate'); $('mfill').style.width = (p * 100).toFixed(1) + '%';
    let cls = '', txt = 'Clear';
    if (p >= ALARM) { cls = 'alarm'; txt = (S.tog.fusion ? 'DRONE ' : 'ALARM ') + Math.round(p * 100) + '%'; } else if (p >= 0.7) { cls = 'likely'; txt = 'Likely ' + Math.round(p * 100) + '%'; } else if (p >= 0.25) { cls = 'maybe'; txt = 'Maybe ' + Math.round(p * 100) + '%'; } else txt = 'Clear ' + Math.round(p * 100) + '%';
    st.className = 'state ' + cls; st.textContent = txt;
    $('stCue').classList.toggle('on', F.cue); $('stLoc').classList.toggle('on', F.loc); $('stConf').classList.toggle('on', F.conf);
    $('clock').textContent = clock(S.t) + (S.done ? ' · flight over' : '');
  }

  // ---------- main loop ----------
  let last = performance.now();
  function frame(now) {
    const fdt = Math.min(0.1, (now - last) / 1000); last = now;
    if (S.playing && !S.done) {
      S.acc += fdt * S.speed; let n = 0;
      while (S.acc >= EVAL_DT && n++ < 40) { S.acc -= EVAL_DT; S.t += EVAL_DT; updateDrone(); S.trail.push({ x: S.drone.x, y: S.drone.y }); if (S.trail.length > 800) S.trail.shift(); evaluate(); if (S.done) break; }
    }
    pickSel(); drawMap(); drawSpec(); drawPanel(); audioUpdate();
    requestAnimationFrame(frame);
  }

  // ---------- Web Audio "listen at node" (synthetic, made from the model levels) ----------
  let AC = null, osc = [], noiseG = null, master = null;
  function audioToggle() {
    if (AC) { AC.close(); AC = null; osc = []; $('listen').textContent = '🔊 Listen'; return; }
    AC = new (window.AudioContext || window.webkitAudioContext)(); master = AC.createGain(); master.gain.value = 0.5; master.connect(AC.destination);
    for (let h = 1; h <= 8; h++) { const o = AC.createOscillator(), g = AC.createGain(); o.type = 'sine'; g.gain.value = 0; o.connect(g); g.connect(master); o.start(); osc.push({ o, g, h }); }
    const buf = AC.createBuffer(1, AC.sampleRate * 2, AC.sampleRate), ch = buf.getChannelData(0); for (let i = 0; i < ch.length; i++) ch[i] = Math.random() * 2 - 1;
    const src = AC.createBufferSource(); src.buffer = buf; src.loop = true; const lp = AC.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900; noiseG = AC.createGain(); noiseG.gain.value = 0;
    src.connect(lp); lp.connect(noiseG); noiseG.connect(master); src.start(); $('listen').textContent = '🔇 Stop';
  }
  function audioUpdate() {
    if (!AC || !S.sel || !S.drone) return;
    const n = S.sel, dt = P.DRONES[S.dtype], env = { scen: S.scen, wind: S.wind, tog: S.tog, jet: S.jet }, tn = P.droneTones(S.drone, dt, env, n), now = AC.currentTime;
    const nz = P.noiseParts(300, env, n), noiseDb = P.dbAdd(nz.self, nz.amb, nz.wind, nz.jet);
    const amp = db => Math.min(0.25, Math.pow(10, (db - 60) / 20));
    osc.forEach((o, i) => { const t = tn.tones[i]; o.o.frequency.setTargetAtTime(t ? t.f : 100, now, 0.05); o.g.gain.setTargetAtTime(t ? amp(t.L) : 0, now, 0.1); });
    noiseG.gain.setTargetAtTime(Math.min(0.4, Math.pow(10, (noiseDb - 45) / 20)), now, 0.1);
  }

  // ---------- UI ----------
  function buildToggles() {
    const box = $('toggles'); box.innerHTML = '';
    for (const [k, label] of TOG) { const b = document.createElement('button'); b.textContent = label; b.className = S.tog[k] ? 'on' : ''; b.dataset.k = k;
      b.onclick = () => { S.tog[k] = !S.tog[k]; b.className = S.tog[k] ? 'on' : ''; log((S.tog[k] ? 'ON: ' : 'OFF: ') + label.replace(/^\S+ /, ''), 'fus'); }; box.appendChild(b); }
  }
  function bind() {
    $('play').onclick = () => { if (S.done) { reset(); } S.playing = !S.playing || S.done; S.playing = S.playing; $('play').textContent = S.playing ? '⏸ Pause' : '▶ Play'; };
    $('restart').onclick = () => { reset(); S.playing = true; $('play').textContent = '⏸ Pause'; };
    $('speed').onchange = e => S.speed = +e.target.value;
    $('listen').onclick = audioToggle;
    $('dl').onclick = () => { const blob = new Blob([JSON.stringify(evidenceReport(), null, 2)], { type: 'application/json' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'skyfuse-evidence-' + clock(S.t).replace(/:/g, '') + '.json'; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); };
    const restartOn = id => $(id).onchange = () => { S.dtype = $('dtype').value; S.route = +$('route').value; S.scen = $('scen').value; S.rid = $('rid').checked; S.radio = $('radio').checked; reset(); S.playing = true; $('play').textContent = '⏸ Pause'; };
    ['dtype', 'route', 'scen', 'rid', 'radio'].forEach(restartOn);
    $('height').oninput = e => { S.height = +e.target.value; $('hv').textContent = S.height + ' m'; };
    $('wind').oninput = e => { S.wind = +e.target.value; $('wv').textContent = S.wind + ' m/s'; };
    // drag sensors / tap nodes
    let drag = null, moved = false;
    const pos = e => { const r = map.getBoundingClientRect(); return { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale }; };
    map.addEventListener('pointerdown', e => { const p = pos(e); let best = null, bd = 22 / scale; for (const s of sensors) { const d = Math.hypot(s.x - p.x, s.y - p.y); if (d < bd) { bd = d; best = s; } }
      if (best) { drag = best; moved = false; map.setPointerCapture(e.pointerId); e.preventDefault(); } });
    map.addEventListener('pointermove', e => { if (!drag) return; const p = pos(e); moved = true; drag.x = clamp(p.x, 0, W); drag.y = clamp(p.y, 0, W); if (drag.kind === 'node' || drag.kind === 'hub') aimDishes(); });
    const up = () => { if (drag && !moved && drag.kind === 'node') { if (S.sel === drag && S.selPinned) S.selPinned = false; else { S.sel = drag; S.selPinned = true; } } drag = null; };
    map.addEventListener('pointerup', up); map.addEventListener('pointercancel', up);
    window.addEventListener('resize', resize);
  }

  buildLayout(); buildToggles(); bind(); resize(); reset();
  window.SkyFuse = { S, F: () => F, firsts: () => firsts, evidenceReport, reset };
  requestAnimationFrame(frame);
})();
