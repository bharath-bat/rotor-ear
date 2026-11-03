// SkyFuse sim: world, flying objects, fusion brain, key moments, guided tour, response timeline, rendering and UI.
(function () {
  'use strict';
  const P = window.SkyPhys, $ = id => document.getElementById(id), OB = P.OBJECTS;
  const W = 3000, EVAL_DT = 0.5, ALARM = 0.95, clamp = P.clamp;

  // ---------- preset layout (metres, origin top-left, y grows south) ----------
  const HUB = { kind: 'hub', id: 'HUB', name: 'hub', x: 1500, y: 1500, h: 10 };
  const sensors = [];
  function buildLayout() {
    sensors.length = 0; let k = 1;
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) sensors.push({ kind: 'node', id: 'N' + k, name: 'sound node N' + (k++), x: 750 + c * 500, y: 750 + r * 500, h: 1.5 });
    sensors.push({ kind: 'tower', id: 'A', name: 'tower A', x: 550, y: 650, h: 30 }, { kind: 'tower', id: 'B', name: 'tower B', x: 2450, y: 700, h: 30 }, { kind: 'tower', id: 'C', name: 'tower C', x: 1500, y: 2500, h: 30 });
    sensors.push({ kind: 'cam', id: 'CAM', name: 'thermal camera', x: 1450, y: 1350, h: 20, az: 45, fov: 7 });
    sensors.push({ kind: 'vib', id: 'VIB', name: 'vibration sensor', x: 1700, y: 1650, h: 12 });
    sensors.push(HUB);
    aimDishes();
  }
  // each node's dish points outward from the hub (watching the perimeter)
  function aimDishes() { for (const n of sensors) if (n.kind === 'node') n.dishAz = Math.hypot(n.x - HUB.x, n.y - HUB.y) < 50 ? 45 : P.bearing(HUB, n); }
  const nodes = () => sensors.filter(s => s.kind === 'node'), towers = () => sensors.filter(s => s.kind === 'tower');
  const cam = () => sensors.find(s => s.kind === 'cam'), vib = () => sensors.find(s => s.kind === 'vib');
  const byId = id => sensors.find(s => s.id === id);

  // routes start ~1 km beyond the map edge: long-range senses may hear the drone before it is on the map
  const ROUTES = [
    [[3700, -550], [2200, 950], [1700, 1650], [1150, 2150], [10, 2990]],
    [[4000, 1750], [2300, 1640], [1700, 1650], [900, 1700], [5, 1250]],
    [[2750, -1000], [2650, 900], [2600, 1800], [2500, 2995]]
  ];
  function pathFor(kind, role, route) {
    if (kind === 'jet') return { pts: [[-4000, 1300], [8000, 1300]], loop: role === 2, phase: role === 2 ? 1 : 22 }; // overhead ~45 s in (decoy) / ~23 s (main)
    if (kind === 'heli') return { pts: [[1150, 3900], [1350, -900]], loop: false, phase: role === 2 ? 0 : 0 };
    if (kind === 'bird' && role === 2) return { pts: [[-200, 1950], [1500, 1450], [3200, 1250]], loop: false, phase: 0, wavy: true };
    const rt = ROUTES[role === 2 ? (route + 1) % 3 : route];
    return { pts: kind === 'bird' ? rt.map(p => [clamp(p[0], -100, 3100), clamp(p[1], -100, 3100)]) : rt, loop: false, phase: 0, wavy: kind === 'bird' };
  }

  // ---------- state ----------
  const S = {
    t: 0, acc: 0, playing: true, speed: 8, scen: 'suburb', wind: 3, kind: 'small', second: 'jet', height: 60, rid: true, radio: true, route: 0, pauseAt: true,
    tog: { mics: true, lownoise: true, dish: true, ring: true, s3: true, height: true, longlisten: true, rf: true, rid: true, thermal: true, vib: true, fusion: true },
    sel: null, objs: [], trail: [], done: false, focus: null
  };
  const TOG = [
    ['mics', '🎙 Sound grid', 'The 16 listening posts. Each one looks for the drone\'s sound ladder.'], ['lownoise', 'Low-noise mics', 'Better microphones with less hiss: faint drones show up sooner.'],
    ['dish', 'Dish', 'A bowl behind each mic that boosts sound from one direction (+9 dB), pointing outward.'], ['ring', '4-mic ring', 'Four mics per post: gives a direction arrow and turns down sound from other directions.'],
    ['s3', 'ESP32-S3 classifier', 'A small trained model on a faster chip: accepts fainter ladders (6 dB instead of 9).'],
    ['height', 'Posts on 8 m poles', 'Lifts the mics above walls and street noise.'], ['longlisten', 'Long listening 3 s', 'Averages 3 seconds of sound: a faint steady hum builds up above random noise.'],
    ['rf', '📡 Radio listener', 'Measures how strong drone radio signals are at 2.4/5.8 GHz. Never decodes or transmits.'], ['rid', '🆔 Remote ID', 'Reads the public "here I am" broadcast that many drones send.'],
    ['thermal', '🌡 Thermal cam', 'Sees warm motors against the cool sky, and tells drone vs bird vs aircraft by shape and motion.'], ['vib', '〰 Vibration', 'Feels a big drone flying very low over the building.'],
    ['fusion', '🧠 Fusion', 'Combines all sensors. Off = any single sensor sets off the alarm (expect false alarms).']
  ];
  const PICK = ['toy', 'small', 'large', 'fixed', 'fpv', 'bird', 'jet', 'heli'];
  let F, R, EV, firsts, lastState, logLines, moments;

  function makeObj(kind, role) {
    const sp = OB[kind], path = pathFor(kind, role, S.route);
    return { kind, spec: sp, role, path, x: 0, y: 0, h: role === 1 ? S.height : sp.h, rpm: 1, phase: Math.random() * 6,
      radioOn: sp.eirp != null && (role === 1 ? S.radio : true), ridOn: role === 1 ? (S.rid && sp.drone) : sp.rid, done: false, trail: [] };
  }
  function reset() {
    S.t = 0; S.acc = 0; S.done = false; S.focus = null; hideCallout();
    S.objs = [makeObj(S.kind, 1)]; if (S.second) S.objs.push(makeObj(S.second, 2));
    F = { B: {}, L: -5, p: 0.007, est: null, er: 0, hist: [], cue: false, loc: false, conf: false, alarmT: null, lastMeasT: -99, falseAlarms: 0 };
    R = { step: 0, recStart: null };
    EV = { points: [], senses: {} };
    firsts = {}; lastState = {}; logLines = []; moments = {};
    $('log').innerHTML = ''; $('first').textContent = 'Waiting…'; $('first').className = ''; $('firsts').innerHTML = '';
    ['r1', 'r2', 'r3', 'r4'].forEach(id => $(id).classList.remove('done'));
    $('dl').disabled = true; $('respstate').textContent = 'starts at 95% fusion confidence'; $('pnmsg').textContent = '—'; $('rectime').textContent = '00:00';
    document.querySelectorAll('#timeline input').forEach(i => i.checked = false);
    for (const s of sensors) { s.det = false; s.conf = 0; s.hist = []; s.rep = null; s.spec = null; s.cls = null; }
    cam().az = 45;
    moveObjs();
    log('Flight starts: ' + S.objs.map(o => OB[o.kind].label).join(' + ') + ' · ' + sceneName(), 'fus');
  }
  const sceneName = () => ({ night: 'quiet night', city: 'city day', suburb: 'suburb, daytime' })[S.scen];
  const drones = () => S.objs.filter(o => o.spec.drone);
  // reference object for "how far out": the drone nearest the hub, or the main object if there is no drone
  const refObj = () => { const d = drones(); return d.length ? d.reduce((a, o) => dh(o) < dh(a) ? o : a) : S.objs[0]; };
  const dh = o => Math.hypot(o.x - HUB.x, o.y - HUB.y);

  // ---------- motion ----------
  function along(pts, s) {
    let hd = 0;
    for (let i = 1; i < pts.length; i++) {
      const L = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      hd = P.bearing({ x: pts[i - 1][0], y: pts[i - 1][1] }, { x: pts[i][0], y: pts[i][1] });
      if (s <= L) return { x: pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * s / L, y: pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * s / L, hd, end: false };
      s -= L;
    }
    const e = pts[pts.length - 1]; return { x: e[0], y: e[1], hd, end: true };
  }
  const plen = pts => pts.slice(1).reduce((a, p, i) => a + Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]), 0);
  function moveObjs() {
    for (const o of S.objs) {
      const pth = o.path, sp = o.spec; let s = (S.t + pth.phase) * sp.speed;
      if (pth.loop) s = s % (plen(pth.pts) * 1.0);
      const p = along(pth.pts, s);
      o.x = p.x; o.y = p.y; o.hd = p.hd;
      if (pth.wavy) { const t = p.hd * Math.PI / 180, off = 70 * Math.sin(S.t / 4 + o.phase); o.x += Math.cos(t) * off; o.y += Math.sin(t) * off; o.h = (o.role === 1 ? S.height : sp.h) + 12 * Math.sin(S.t / 7 + o.phase); }
      else if (o.role === 1) o.h = S.height;
      o.rpm = 1 + 0.03 * Math.sin(S.t / 3 + o.phase);                     // rotor speed wobble: the whole ladder slides together
      if (sp.snd.chirp) { o.chirping = Math.random() < sp.snd.chirp.duty; o.chirpF = 2600 + Math.random() * 800; }
      if (p.end && !pth.loop) o.done = true;
    }
    if (S.objs[0].done && !S.done) { S.done = true; S.playing = false; setPlay(); finish(); }
  }

  // ---------- one sensing + fusion step (every 0.5 s of sim time) ----------
  function evaluate() {
    const env = { scen: S.scen, wind: S.wind, tog: S.tog, objs: S.objs }, reps = [], T = S.tog;
    // sound grid
    for (const n of nodes()) {
      n.h = T.height ? 8 : 1.5;
      n._focus = S.objs.filter(o => o.spec.drone).sort((a, b) => Math.hypot(a.x - n.x, a.y - n.y) - Math.hypot(b.x - n.x, b.y - n.y))[0] || null;
      n.rep = null;
      if (!T.mics) { n.det = false; n.conf = 0; n.spec = null; continue; }
      const sp = P.synth(env, n, n.specBuf || (n.specBuf = new Float32Array(P.NB)));
      const cb = P.comb(sp.db, T.s3 ? 6 : P.HIT_DB);
      const hit = cb.hits >= 3;
      n.hist.push(hit ? cb : null); if (n.hist.length > 3) n.hist.shift();
      const good = n.hist.filter(Boolean);
      n.det = good.length >= 2;                                             // 2 of last 3 frames agree (stability)
      n.cls = n.det ? (good.filter(c => c.dense >= 3).length * 2 > good.length ? 'heli' : 'drone') : null; // dense ladder = big slow rotor
      n.conf = n.det ? clamp((good.reduce((a, c) => a + c.s, 0) / good.length - 2) / 8, 0.2, 1) : 0;
      n.spec = { db: sp.db, floor: cb.floor, cb, roar: n._roarDb, src: nearestSrc(n, cb) };
      if (n.det) {
        const src = n.spec.src;
        n.rep = { kind: 'snd', id: n.id, conf: n.conf, f0: cb.f0, hits: cb.hits, w: cb.s, cls: n.cls, obj: src };
        if (T.ring && src) n.rep.brg = P.bearing(n, src) + P.gauss() * 8;     // ring gives a direction (±8°)
        reps.push(n.rep);
      }
    }
    // towers: RF energy + Remote ID
    for (const tw of towers()) {
      tw.rep = null; tw.ridRep = null;
      if (T.rf) {
        let best = null; for (const o of S.objs) { const r = P.rf(o, env, tw); if (r && (!best || r.rssi > best.rssi)) best = r; }
        if (!best && S.scen === 'city' && Math.random() < 0.025) best = { rssi: -79 - Math.random() * 3, band: '2.4', conf: 0.25, brg: Math.random() * 360, fake: true }; // WiFi clutter false blip
        if (best) { tw.rep = Object.assign({ kind: 'rf', id: tw.id }, best); reps.push(tw.rep); }
      }
      if (T.rid) for (const o of S.objs) { const r = P.rid(o, env, tw); if (r) { tw.ridRep = Object.assign({ kind: 'rid', id: tw.id }, r); reps.push(tw.ridRep); break; } }
      tw.det = !!(tw.rep || tw.ridRep); tw.conf = Math.max(tw.rep ? tw.rep.conf : 0, tw.ridRep ? 1 : 0);
    }
    // thermal camera: patrols when uncued; turns to the fusion track when cued (30°/s)
    const c = cam(); c.rep = null;
    if (T.thermal) {
      let target = null;
      if (T.fusion && F.est && F.p > 0.5) { target = P.bearing(c, F.est); c.cued = true; } else c.cued = false;
      if (target == null) c.az = (c.az + 20 * EVAL_DT) % 360;
      else { const diff = ((target - c.az + 540) % 360) - 180; c.az = (c.az + clamp(diff, -15, 15) + 360) % 360; }
      let best = null; for (const o of S.objs) { const r = P.thermal(o, env, c); if (r && (!best || r.r < best.r)) best = r; }
      if (best) { c.rep = Object.assign({ kind: 'cam', id: 'CAM' }, best); reps.push(c.rep); }
    }
    c.det = !!c.rep; c.conf = c.rep ? c.rep.conf : 0;
    const v = vib(); v.rep = null;
    if (T.vib) for (const o of S.objs) { const r = P.vibration(o, v); if (r) { v.rep = Object.assign({ kind: 'vib', id: 'VIB' }, r); reps.push(v.rep); break; } }
    v.det = !!v.rep;

    fuse(reps);
    logTransitions(reps);
    recordEvidence(reps);
    response();
  }
  // which object made the ladder this node found (to point the ring's direction arrow at it)
  function nearestSrc(n, cb) {
    if (!cb || cb.hits < 3) return null; let best = null, be = 1;
    for (const o of S.objs) { const l = o.spec.snd.ladder; if (!l) continue; const ratio = cb.f0 / (l.f0 * o.rpm), k = Math.round(ratio); if (k < 1) continue; const e = Math.abs(ratio - k) / ratio; if (e < 0.05 && e < be) { be = e; best = o; } }
    return best;
  }

  // ---------- fusion brain: log-odds evidence, association by place, single-target track ----------
  // Weights = how much one report of that sense is trusted (log-odds units per 0.5 s at confidence 1).
  const WEIGHT = { rid: 3, cam: 2.5, snd: 0.6, rf: 0.55, vib: 1.5 };
  // Per-sense caps: RF alone can reach "likely" (~85%) but never the 95% alarm, because a radio blip can't tell a drone
  // from a WiFi camera. Sound, Remote ID or thermal (or RF + any of them) can. Negative evidence: thermal says bird/aircraft.
  const CAP = { rid: 12, cam: 12, snd: 9, rf: 6.7, vib: 6 };
  const positive = r => r.kind === 'rf' ? true : r.kind === 'snd' ? r.cls === 'drone' : r.kind === 'cam' ? r.cls === 'drone' : true;
  function fuse(reps) {
    const T = S.tog;
    const pos = reps.filter(r => positive(r));
    let meas = null;
    const rid = pos.find(r => r.kind === 'rid'), snd = pos.filter(r => r.kind === 'snd'), brs = snd.filter(r => r.brg != null);
    if (rid) meas = { x: rid.x, y: rid.y, er: 20, by: 'Remote ID' };
    else if (brs.length >= 2) { const p = triangulate(brs.map(r => ({ s: byId(r.id), b: r.brg, w: r.w }))); if (p) meas = { x: p.x, y: p.y, er: 70, by: brs.length + ' sound posts (directions)' }; }
    if (!meas && snd.length) { let sx = 0, sy = 0, sw = 0; for (const r of snd) { const n = byId(r.id); sx += n.x * r.w; sy += n.y * r.w; sw += r.w; } meas = { x: sx / sw, y: sy / sw, er: 260, by: snd.length + ' sound post' + (snd.length > 1 ? 's' : '') }; }
    const cm = pos.find(r => r.kind === 'cam');
    if (cm) { const c = cam(), rr = cm.r * (1 + P.gauss() * 0.05), b = cm.brg * Math.PI / 180; if (!meas || meas.er > 30) meas = { x: c.x + Math.sin(b) * rr, y: c.y - Math.cos(b) * rr, er: 30, by: 'thermal' }; }
    const rfs = pos.filter(r => r.kind === 'rf');
    if (!meas && rfs.length) {
      let pts = rfs.map(r => { const t = byId(r.id), rg = clamp(P.rfRange(r.rssi, { scen: S.scen }), 100, 4000), b = r.brg * Math.PI / 180; return { x: t.x + Math.sin(b) * rg, y: t.y - Math.cos(b) * rg, w: r.conf }; });
      if (F.est && F.p > 0.3) pts = pts.filter(p => Math.hypot(p.x - F.est.x, p.y - F.est.y) < F.er * 2 + 900);
      if (pts.length) { const sw = pts.reduce((a, p) => a + p.w, 0); meas = { x: pts.reduce((a, p) => a + p.x * p.w, 0) / sw, y: pts.reduce((a, p) => a + p.y * p.w, 0) / sw, er: rfs.length > 1 ? 450 : 700, by: 'radio towers' }; }
    }
    // evidence buckets with decay
    const B = F.B;
    for (const k in B) B[k] *= Math.exp(-EVAL_DT / 8);
    let nS = 0;
    for (const r of reps) {
      if (r.kind === 'snd' && r.cls !== 'drone') continue;                  // helicopter-like ladder: no drone evidence
      if (r.kind === 'cam' && r.cls !== 'drone') { B.cam = Math.max(-4, (B.cam || 0) - 1.5 * r.conf); continue; } // camera says bird/aircraft
      let w = WEIGHT[r.kind] * r.conf;
      if (r.kind === 'snd' && ++nS > 4) continue;
      if (F.est && F.p > 0.3 && r.kind === 'rf' && rayDist(byId(r.id), r.brg, F.est) > F.er + 600) { w *= 0.15; r.mismatch = true; }
      B[r.kind] = Math.min(CAP[r.kind], (B[r.kind] || 0) + w);
    }
    F.L = -5 + Object.values(B).reduce((a, b) => a + b, 0);
    const pF = 1 / (1 + Math.exp(-F.L));
    // no fusion: the alarm is simply the most confident single sensor (so false blips / birds raise alarms)
    F.p = T.fusion ? pF : reps.reduce((a, r) => Math.max(a, r.conf), 0);
    if (!T.fusion && reps.some(r => r.fake || (r.kind === 'cam' && r.cls !== 'drone') || (r.kind === 'snd' && r.cls !== 'drone'))) F.falseAlarms++;
    // track
    if (meas) {
      if (!F.est || Math.hypot(meas.x - F.est.x, meas.y - F.est.y) > 1600 && meas.er < F.er) { F.est = { x: meas.x, y: meas.y }; F.er = meas.er; }
      else { const k = clamp(F.er / (F.er + meas.er), 0.15, 0.85); F.est.x += k * (meas.x - F.est.x); F.est.y += k * (meas.y - F.est.y); F.er = Math.max(15, F.er * (1 - k) + meas.er * k * 0.6); }
      F.by = meas.by; F.lastMeasT = S.t;
      F.hist.push({ t: S.t, x: F.est.x, y: F.est.y }); if (F.hist.length > 400) F.hist.shift();
    } else if (F.est) { F.er = Math.min(1500, F.er + 8 * EVAL_DT); if (S.t - F.lastMeasT > 25) F.est = null; }
    // stages + key moments
    const realRf = rfs.filter(r => !r.mismatch && !r.fake);
    if ((realRf.length || rid) && !F.cue) { F.cue = true; log('Fusion: CUE from ' + (rid ? 'Remote ID' : 'radio tower ' + realRf[0].id) + ' → sound posts listen harder, camera told where to look', 'fus'); }
    if ((snd.length >= 2 || rid) && !F.loc && F.est) { F.loc = true; log('Fusion: LOCATED by ' + (F.by || 'sound grid') + ', ±' + Math.round(F.er) + ' m', 'fus'); }
    if (cm && !F.conf) { F.conf = true; log('Fusion: CONFIRMED by thermal camera at ' + km(cm.r), 'fus'); mark('confirm', 'Thermal confirm');
      moment('confirm', cam(), '📷 Camera confirms', 'Fusion told the thermal camera where to look. It turned and sees a warm, drone-shaped dot ' + km(cm.r) + ' away. Now it\'s certain.'); }
    if (F.p >= ALARM && F.alarmT == null) {
      F.alarmT = S.t; mark('alarm', T.fusion ? 'Fusion ≥95%' : 'single-sensor alarm');
      moment('alarm', HUB, '🚨 Alarm: ' + Math.round(F.p * 100) + '% sure', T.fusion ? 'Several different senses agree, so their "maybes" add up past the 95% line. The response steps start now (see the "What happens next" panel).' : 'Fusion is OFF, so one sensor alone set off the alarm.');
    }
  }
  function triangulate(L) {
    let a = 0, b = 0, c = 0, bx = 0, by = 0;
    for (const l of L) { const t = l.b * Math.PI / 180, ux = Math.sin(t), uy = -Math.cos(t), w = l.w;
      const m11 = 1 - ux * ux, m12 = -ux * uy, m22 = 1 - uy * uy; a += w * m11; b += w * m12; c += w * m22; bx += w * (m11 * l.s.x + m12 * l.s.y); by += w * (m12 * l.s.x + m22 * l.s.y); }
    const det = a * c - b * b; if (Math.abs(det) < 1e-6 * (a + c) * (a + c)) return null;
    const x = (c * bx - b * by) / det, y = (a * by - b * bx) / det;
    return (x > -500 && x < W + 500 && y > -500 && y < W + 500) ? { x, y } : null;
  }
  function rayDist(s, b, p) { const t = b * Math.PI / 180, ux = Math.sin(t), uy = -Math.cos(t), dx = p.x - s.x, dy = p.y - s.y, al = dx * ux + dy * uy; return al < 0 ? Math.hypot(dx, dy) : Math.abs(dx * uy - dy * ux); }
  const km = m => m >= 1000 ? (m / 1000).toFixed(1) + ' km' : Math.round(m / 10) * 10 + ' m';

  // ---------- first detections ----------
  const SENSE_NAME = { rf: 'radio listener', rid: 'Remote ID', snd: 'sound grid', cam: 'thermal camera', vib: 'vibration sensor' };
  function mark(k, label, who) { if (firsts[k]) return; firsts[k] = { t: S.t, d: dh(refObj()), label, who }; renderFirsts(); }
  function renderFirsts() {
    const order = ['rf', 'rid', 'snd', 'cam', 'vib', 'alarm', 'confirm'];
    const real = ['rf', 'rid', 'snd', 'cam', 'vib'].filter(k => firsts[k]).sort((a, b) => firsts[a].t - firsts[b].t);
    if (real.length) { const f = firsts[real[0]]; $('first').textContent = 'First detected ' + km(f.d) + ' from the hub by ' + f.label + (f.who ? ' ' + f.who : '') + ' at ' + clock(f.t); }
    $('firsts').innerHTML = order.filter(k => firsts[k]).map(k => '<span>' + firsts[k].label + '</span><span>' + km(firsts[k].d) + ' out · ' + clock(firsts[k].t) + '</span>').join('');
  }

  // ---------- event log ----------
  function clock(t) { const s = Math.floor(10 * 3600 + 21 * 60 + t); return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map(v => String(v).padStart(2, '0')).join(':'); }
  function log(msg, cls) {
    const line = clock(S.t) + ' ' + msg; logLines.push(line);
    const div = document.createElement('div'); div.className = cls || ''; div.textContent = line;
    const L = $('log'); L.prepend(div); while (L.children.length > 150) L.lastChild.remove();
  }
  const strength = c => c > 0.75 ? 'strong' : c > 0.45 ? 'clear' : 'weak';
  function logTransitions(reps) {
    const now = {};
    for (const r of reps) now[r.kind + r.id] = r;
    for (const k in now) if (!lastState[k] || lastState[k].cls !== now[k].cls) {
      const r = now[k], s = byId(r.id);
      if (r.kind === 'rf') {
        log('Radio tower ' + r.id + ': ' + strength(r.conf) + ' ' + r.band + ' GHz blip, ' + P.compass(r.brg) + ' (' + r.rssi.toFixed(0) + ' dBm)' + (r.fake ? ' · WiFi clutter?' : '') + (r.mismatch ? ' · doesn\'t fit track, down-weighted' : ''), r.fake ? 'warn' : 'rf');
        if (!r.fake) { mark('rf', 'radio tower', r.id); moment('rf', s, '📡 Radio hears first', 'Tower ' + r.id + ' picked up a ' + strength(r.conf) + ' ' + r.band + ' GHz signal from the ' + P.compass(r.brg) + ', about ' + km(dh(refObj())) + ' out. Radio travels much farther than sound. It only measures strength, never decodes. One blip = "maybe".'); }
      } else if (r.kind === 'rid') { log('Remote ID @ tower ' + r.id + ': public broadcast received, position ' + Math.round(r.x) + ',' + Math.round(r.y), 'rid'); mark('rid', 'Remote ID @ tower', r.id);
        moment('rid', s, '🆔 Remote ID heard', 'The drone is broadcasting its public "here I am" message. Tower ' + r.id + ' reads its position openly. Drones that switch this off still get caught by the other senses.'); }
      else if (r.kind === 'snd') {
        if (r.cls === 'drone') { log('Sound ' + r.id + ': rotor ladder f0 ' + Math.round(r.f0) + ' Hz, ' + r.hits + ' rungs' + (r.brg != null ? ', from ' + P.compass(r.brg) : ''), 'snd'); mark('snd', 'sound post', r.id);
          moment('snd', s, '🎙 Sound post ' + r.id + ' hears a ladder', 'A hum at ' + Math.round(r.f0) + ' Hz plus exact multiples (' + r.hits + ' rungs) — the fingerprint of spinning propellers. A jet\'s roar or a bird\'s chirp never makes this neat ladder.'); }
        else { log('Sound ' + r.id + ': rotor ladder too dense → big slow rotor (helicopter), NOT counted as a drone', 'warn');
          moment('heli', s, '🚁 Not a drone: helicopter', 'Post ' + r.id + ' hears rotor sound, but the rungs are packed too close (extra peaks between them). That means a huge, slow rotor — a helicopter. Fusion ignores it.'); }
      } else if (r.kind === 'cam') {
        if (r.cls === 'drone') { log('Thermal: warm drone-shaped dot in view, ' + km(r.r) + ' ' + P.compass(r.brg), 'cam'); mark('cam', 'thermal camera'); }
        else { log('Thermal: warm dot ' + km(r.r) + ' ' + P.compass(r.brg) + ' → ' + (r.cls === 'bird' ? 'flapping, wobbly path: a BIRD' : 'big and fast: an AIRCRAFT') + ', not a drone (lowers confidence)', 'warn');
          moment(r.cls === 'bird' ? 'bird' : 'aircraft', cam(), r.cls === 'bird' ? '🐦 Camera: just a bird' : '✈ Camera: an aircraft', r.cls === 'bird' ? 'The camera sees something warm, but it flaps and wobbles like a bird. That counts AGAINST a drone, so fusion stays calm.' : 'Something big, hot and fast: an aircraft. That counts against a drone.'); }
      } else if (r.kind === 'vib') { log('Vibration: roof sensor shaking, something heavy low overhead', 'vib'); mark('vib', 'vibration sensor');
        moment('vib', s, '〰 Roof is shaking', 'A heavy drone is flying very low over the building. Only big, low drones do this.'); }
    }
    lastState = now;
  }

  // ---------- key moments: pause + callout bubble pointing at the sensor ----------
  function moment(key, sensor, title, text) {
    if (moments[key]) return; moments[key] = { t: S.t, sensor, title, text };
    if (tour.on) { tourMoment(key, sensor, title, text); return; }
    if (!S.pauseAt) return;
    S.playing = false; setPlay(); showCallout(sensor, title, text, true);
  }
  function showCallout(sensor, title, text, withBtn) {
    S.focus = sensor; const co = $('callout');
    co.querySelector('.co-t').textContent = title; co.querySelector('.co-x').textContent = text;
    co.querySelector('.co-go').hidden = !withBtn; co.hidden = false; placeCallout();
  }
  function placeCallout() {
    const co = $('callout'); if (co.hidden || !S.focus) return;
    const w = map.clientWidth, sx = X(S.focus.x), sy = X(S.focus.y), cw = co.offsetWidth, ch = co.offsetHeight;
    const left = clamp(sx - cw / 2, 6, w - cw - 6); let top, cls;
    if (sy - ch - 22 > 0) { top = sy - ch - 18; cls = 'above'; } else { top = Math.min(sy + 18, w - ch - 4); cls = 'below'; }
    co.className = cls; co.style.left = left + 'px'; co.style.top = top + 'px'; co.style.setProperty('--ax', clamp(sx - left, 14, cw - 14) + 'px');
  }
  function hideCallout() { $('callout').hidden = true; S.focus = null; }

  // ---------- evidence + response timeline ----------
  function recordEvidence(reps) {
    const per = {}; for (const r of reps) { if (!positive(r) || (r.kind === 'snd' && r.cls !== 'drone') || (r.kind === 'cam' && r.cls !== 'drone')) continue; per[r.kind] = Math.max(per[r.kind] || 0, +r.conf.toFixed(2)); }
    if (F.est) EV.points.push({ time: clock(S.t), est_x_m: Math.round(F.est.x), est_y_m: Math.round(F.est.y), err_m: Math.round(F.er), fusion_conf: +F.p.toFixed(3), per_sense: per });
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
    const dt = S.t - F.alarmT, est = F.est || refObj();
    const where = 'Drone ' + P.compass(P.bearing(HUB, est)) + ', ' + km(Math.hypot(est.x - HUB.x, est.y - HUB.y)) + ', ' + headingTxt() + '. Go indoors.';
    $('pnmsg').textContent = where;
    [0, 2, 4, 6].forEach((s, i) => { if (dt >= s && R.step <= i) { R.step = i + 1; $('r' + (i + 1)).classList.add('done');
      if (i === 0) log('RESPONSE ① alert sent to phones + siren/light: "' + where + '"', 'rsp');
      if (i === 1) { R.recStart = S.t; log('RESPONSE ② camera turning to the track, recording started', 'rsp'); }
      if (i === 2) { $('dl').disabled = false; log('RESPONSE ③ evidence log building (time, path, confidence per sense)', 'rsp'); }
      if (i === 3) log('RESPONSE ④ checklist shown: cover, police 112, DGCA Digital Sky', 'rsp'); } });
    $('respstate').textContent = 'ALARM at ' + clock(F.alarmT) + ' · +' + Math.round(dt) + ' s';
    if (R.recStart != null) { const e = Math.floor(S.t - R.recStart); $('rectime').textContent = String(Math.floor(e / 60)).padStart(2, '0') + ':' + String(e % 60).padStart(2, '0'); }
    const c = cam(); $('camtxt').textContent = S.tog.thermal ? ('Camera at ' + Math.round(c.az) + '° (' + P.compass(c.az) + ')' + (c.det ? ' · target in frame' : ' · turning to track')) : 'Thermal camera switched off';
    $('evtxt').textContent = EV.points.length + ' track points · senses: ' + Object.keys(EV.senses).map(k => SENSE_NAME[k]).join(', ');
  }
  function evidenceReport() {
    const real = ['rf', 'rid', 'snd', 'cam', 'vib'].filter(k => firsts[k]).sort((a, b) => firsts[a].t - firsts[b].t);
    return {
      title: 'SkyFuse sim evidence report (SIMULATED DATA)', generated: new Date().toISOString(),
      note: 'Simulation only. Passive sensing: nothing transmitted at the drone, nothing jammed or decoded. Ranges are rough model estimates.',
      scenario: { scene: sceneName(), wind_mps: S.wind, objects: S.objs.map(o => ({ type: OB[o.kind].label, height_m: Math.round(o.h), radio_link: o.radioOn, remote_id: o.ridOn })), route: $('route').selectedOptions[0].text },
      senses_enabled: Object.keys(S.tog).filter(k => S.tog[k]),
      first_detected_by: real.length ? { sense: firsts[real[0]].label + (firsts[real[0]].who ? ' ' + firsts[real[0]].who : ''), time: clock(firsts[real[0]].t), distance_from_hub_m: Math.round(firsts[real[0]].d) } : null,
      first_by_sense: Object.fromEntries(Object.entries(firsts).map(([k, v]) => [k, { time: clock(v.t), distance_from_hub_m: Math.round(v.d) }])),
      alarm_time: F.alarmT != null ? clock(F.alarmT) : null,
      track: EV.points, event_log: logLines.slice(),
      map: { size_m: W, hub: { x: HUB.x, y: HUB.y }, sensors: sensors.map(s => ({ id: s.id, kind: s.kind, x: Math.round(s.x), y: Math.round(s.y) })) }
    };
  }
  function finish() {
    const real = ['rf', 'rid', 'snd', 'cam', 'vib'].filter(k => firsts[k]).sort((a, b) => firsts[a].t - firsts[b].t), el = $('first');
    if (!drones().length) {
      if (F.alarmT == null) { el.textContent = '✅ Correct: no alarm. It was only ' + S.objs.map(o => OB[o.kind].label.toLowerCase()).join(' + ') + '.'; el.className = 'ok'; log('Flight over: no drone, and no alarm. Correct.', 'ok'); }
      else { el.textContent = '❌ False alarm: no drone was flying.'; el.className = 'bad'; log('Flight over: FALSE ALARM (no drone was flying).', 'warn'); }
    } else if (real.length) log('Flight over. First detected ' + km(firsts[real[0]].d) + ' out by ' + firsts[real[0]].label + (firsts[real[0]].who ? ' ' + firsts[real[0]].who : '') + (F.alarmT == null ? ', but never reached the alarm line.' : '.'), F.alarmT == null ? 'warn' : 'ok');
    else { log('Flight over: the drone was never detected. Try more senses or a quieter scene.', 'warn'); el.textContent = '❌ Missed: the drone was never detected.'; el.className = 'bad'; }
    if (!S.tog.fusion) log('Without fusion: ' + F.falseAlarms + ' moments where a decoy or clutter alone looked like a drone.', 'warn');
  }

  // ---------- icons (vector, same everywhere: map, picker, legend) ----------
  function drawIcon(c, kind, x, y, s, col, hd) {
    c.save(); c.translate(x, y); c.rotate(((hd || 0)) * Math.PI / 180); c.fillStyle = col; c.strokeStyle = col; c.lineWidth = Math.max(1.2, s * 0.12); c.lineCap = 'round';
    const k = s / 10;
    if (kind === 'quad' || kind === 'fpv') {
      c.beginPath(); c.moveTo(-6 * k, -6 * k); c.lineTo(6 * k, 6 * k); c.moveTo(6 * k, -6 * k); c.lineTo(-6 * k, 6 * k); c.stroke();
      for (const [ox, oy] of [[-6, -6], [6, -6], [-6, 6], [6, 6]]) { c.beginPath(); c.arc(ox * k, oy * k, 3.6 * k, 0, 7); kind === 'fpv' ? c.fill() : c.stroke(); }
      c.fillRect(-2 * k, -2 * k, 4 * k, 4 * k);
      if (kind === 'fpv') { c.globalAlpha = .6; c.beginPath(); c.moveTo(-2 * k, 9 * k); c.lineTo(-2 * k, 15 * k); c.moveTo(2 * k, 9 * k); c.lineTo(2 * k, 13 * k); c.stroke(); }
    } else if (kind === 'wing') {
      c.beginPath(); c.moveTo(0, -8 * k); c.lineTo(10 * k, 2 * k); c.lineTo(10 * k, 4 * k); c.lineTo(0, 1 * k); c.lineTo(-10 * k, 4 * k); c.lineTo(-10 * k, 2 * k); c.closePath(); c.fill();
      c.fillRect(-1 * k, 0, 2 * k, 8 * k); c.fillRect(-4 * k, 7 * k, 8 * k, 1.8 * k);
    } else if (kind === 'jet') {
      c.beginPath(); c.moveTo(0, -10 * k); c.lineTo(1.6 * k, -4 * k); c.lineTo(10 * k, 2 * k); c.lineTo(10 * k, 4 * k); c.lineTo(1.6 * k, 1 * k); c.lineTo(1.4 * k, 6 * k); c.lineTo(4 * k, 9 * k); c.lineTo(-4 * k, 9 * k); c.lineTo(-1.4 * k, 6 * k); c.lineTo(-1.6 * k, 1 * k); c.lineTo(-10 * k, 4 * k); c.lineTo(-10 * k, 2 * k); c.lineTo(-1.6 * k, -4 * k); c.closePath(); c.fill();
    } else if (kind === 'heli') {
      c.beginPath(); c.ellipse(0, -1 * k, 4 * k, 5.5 * k, 0, 0, 7); c.fill(); c.fillRect(-0.9 * k, 3 * k, 1.8 * k, 8 * k); c.fillRect(-3 * k, 10 * k, 6 * k, 1.6 * k);
      c.beginPath(); c.moveTo(-10 * k, -8 * k); c.lineTo(10 * k, 6 * k); c.moveTo(10 * k, -8 * k); c.lineTo(-10 * k, 6 * k); c.stroke();
    } else if (kind === 'bird') {
      c.rotate(-((hd || 0)) * Math.PI / 180); c.lineWidth = Math.max(1.6, s * 0.18);
      c.beginPath(); c.moveTo(-9 * k, -2 * k); c.quadraticCurveTo(-4 * k, -7 * k, 0, 1 * k); c.quadraticCurveTo(4 * k, -7 * k, 9 * k, -2 * k); c.stroke();
    }
    c.restore();
  }
  const OBJCOL = o => o.spec.drone ? '#ff4d4d' : '#ffb86b';

  // ---------- rendering ----------
  const map = $('map'), mctx = map.getContext('2d'), spec = $('spec'), sctx = spec.getContext('2d');
  let scale = 1, dpr = 1;
  function resize() {
    dpr = window.devicePixelRatio || 1;
    const w = map.clientWidth; map.width = w * dpr; map.height = w * dpr; scale = w / W;
    spec.width = spec.clientWidth * dpr; spec.height = spec.clientHeight * dpr; placeCallout();
  }
  const X = v => v * scale;
  function drawMap() {
    const c = mctx, w = map.clientWidth, big = w > 500 ? 1 : 0.85; c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, w, w);
    c.fillStyle = '#0f1a2b'; c.fillRect(0, 0, w, w);
    c.strokeStyle = '#18263c'; c.lineWidth = 1;
    for (let m = 1000; m < W; m += 1000) { c.beginPath(); c.moveTo(X(m), 0); c.lineTo(X(m), w); c.moveTo(0, X(m)); c.lineTo(w, X(m)); c.stroke(); }
    c.setLineDash([3, 6]); c.strokeStyle = '#2a3b56'; for (const r of [1000, 2000]) { c.beginPath(); c.arc(X(HUB.x), X(HUB.y), X(r), 0, 7); c.stroke(); } c.setLineDash([]);
    c.fillStyle = '#5d7391'; c.font = (12 * big) + 'px sans-serif'; c.fillText('1 km', X(HUB.x) + 4, X(HUB.y - 1000) + 14); c.fillText('2 km', X(HUB.x) + 4, X(HUB.y - 2000) + 14);
    c.font = 'bold 13px sans-serif'; c.fillText('N ↑', w - 30, 18);
    const v = vib(); c.fillStyle = '#26324a'; c.fillRect(X(v.x) - 10, X(v.y) - 8, 20, 16);
    // roar footprint of jets / helicopters
    for (const o of S.objs) if (o.spec.snd.roar) { const x = X(o.x), y = X(o.y), R = X(o.kind === 'jet' ? 1500 : 900); const g = c.createRadialGradient(x, y, 2, x, y, R); g.addColorStop(0, '#9aa5b830'); g.addColorStop(1, '#9aa5b800'); c.fillStyle = g; c.beginPath(); c.arc(x, y, R, 0, 7); c.fill(); }
    // main route (faint)
    const rt = S.objs[0].path.pts; c.strokeStyle = '#ff4d4d26'; c.setLineDash([2, 6]); c.beginPath(); rt.forEach((p, i) => i ? c.lineTo(X(p[0]), X(p[1])) : c.moveTo(X(p[0]), X(p[1]))); c.stroke(); c.setLineDash([]);
    const pulse = (Date.now() % 1200) / 1200;
    for (const s of sensors) {
      const x = X(s.x), y = X(s.y);
      if (s.kind === 'node') {
        if (s === S.sel && S.tog.mics && S.tog.dish) { c.fillStyle = '#7fd38c18'; wedge(c, x, y, 34, s.dishAz, 44); }
        if (s.det) { ring(c, x, y, s.cls === 'drone' ? '#7fd38c' : '#ffb86b', pulse); if (s.rep && s.rep.brg != null && s.cls === 'drone') ray(c, x, y, s.rep.brg, X(700), '#7fd38c66'); }
        c.fillStyle = S.tog.mics ? (s.det ? (s.cls === 'drone' ? '#a6ffb4' : '#ffb86b') : '#4f8f5a') : '#33465f'; c.beginPath(); c.arc(x, y, s === S.sel ? 6 : 5, 0, 7); c.fill();
        if (s === S.sel) { c.strokeStyle = '#fff'; c.lineWidth = 1.5; c.beginPath(); c.arc(x, y, 9, 0, 7); c.stroke(); c.lineWidth = 1; }
      } else if (s.kind === 'tower') {
        if (s.rep) { ring(c, x, y, s.rep.fake ? '#ff8a8a' : '#b48cff', pulse); c.fillStyle = s.rep.fake ? '#ff8a8a12' : '#b48cff1a'; wedge(c, x, y, X(Math.min(1300, P.rfRange(s.rep.rssi, { scen: S.scen }))), s.rep.brg, 44); }
        if (s.ridRep) { ring(c, x, y, '#ffffff', (pulse + 0.5) % 1); c.strokeStyle = '#ffffff30'; c.beginPath(); c.arc(x, y, X(S.scen === 'city' ? 700 : 1000), 0, 7); c.stroke(); }
        c.fillStyle = (S.tog.rf || S.tog.rid) ? '#b48cff' : '#3b3355'; c.beginPath(); c.moveTo(x, y - 10); c.lineTo(x + 8, y + 7); c.lineTo(x - 8, y + 7); c.fill();
        c.fillStyle = '#e6dcff'; c.font = 'bold ' + (14 * big) + 'px sans-serif'; c.fillText(s.id, x + 10, y - 4);
      } else if (s.kind === 'cam') {
        if (S.tog.thermal) { c.fillStyle = s.det ? '#ffb34766' : '#ffb34722'; wedge(c, x, y, X(1100), s.az, s.fov); }
        if (s.det) ring(c, x, y, s.rep && s.rep.cls !== 'drone' ? '#ffd39a' : '#ffb347', pulse);
        c.fillStyle = S.tog.thermal ? '#ffb347' : '#4a3a22'; c.fillRect(x - 6, y - 6, 12, 12);
        c.fillStyle = '#ffcf8a'; c.font = (12 * big) + 'px sans-serif'; c.fillText('camera', x - 48, y + 4);
      } else if (s.kind === 'vib') {
        if (s.det) ring(c, x, y, '#ff7ad9', pulse);
        c.fillStyle = S.tog.vib ? '#ff7ad9' : '#4a2a42'; c.save(); c.translate(x, y); c.rotate(Math.PI / 4); c.fillRect(-5, -5, 10, 10); c.restore();
      } else if (s.kind === 'hub') { c.fillStyle = '#fff'; star(c, x, y, 8); c.font = 'bold ' + (13 * big) + 'px sans-serif'; c.fillText('hub', x + 10, y + 5); }
    }
    // focus highlight (key moment)
    if (S.focus) { const x = X(S.focus.x), y = X(S.focus.y); c.strokeStyle = '#fff7d6'; c.lineWidth = 3; c.globalAlpha = 1 - pulse * 0.7; c.beginPath(); c.arc(x, y, 12 + pulse * 22, 0, 7); c.stroke(); c.globalAlpha = 1; c.lineWidth = 1; }
    // estimate
    if (F.est && F.p > 0.15) { const x = X(F.est.x), y = X(F.est.y); c.strokeStyle = '#4fe3ff'; c.fillStyle = '#4fe3ff14'; c.beginPath(); c.arc(x, y, Math.max(7, X(F.er)), 0, 7); c.fill(); c.stroke();
      c.beginPath(); c.moveTo(x - 9, y); c.lineTo(x + 9, y); c.moveTo(x, y - 9); c.lineTo(x, y + 9); c.stroke(); c.fillStyle = '#4fe3ff'; c.font = 'bold ' + (12 * big) + 'px sans-serif'; c.fillText('guess ' + Math.round(F.p * 100) + '%', x + 10, y + 16); }
    // objects + trails
    for (const o of S.objs) {
      o.trail.push({ x: o.x, y: o.y }); if (o.trail.length > 600) o.trail.shift();
      c.strokeStyle = OBJCOL(o) + '77'; c.beginPath(); o.trail.forEach((p, i) => i ? c.lineTo(X(p.x), X(p.y)) : c.moveTo(X(p.x), X(p.y))); c.stroke();
      const x = X(o.x), y = X(o.y), sz = 12 * o.spec.size * (w > 500 ? 1.15 : 1);
      if (x > -20 && y > -20 && x < w + 20 && y < w + 20) {
        c.fillStyle = '#0f1a2bcc'; c.beginPath(); c.arc(x, y, sz * 1.25, 0, 7); c.fill();
        drawIcon(c, o.spec.icon, x, y, sz, OBJCOL(o), o.spec.icon === 'bird' ? 0 : o.hd);
        c.fillStyle = OBJCOL(o); c.font = 'bold ' + (12 * big) + 'px sans-serif'; c.fillText(OB[o.kind].label + ' · ' + Math.round(o.h) + ' m', x + sz + 4, y - 6);
      } else {
        const ex = clamp(x, 12, w - 12), ey = clamp(y, 34, w - 12);
        drawIcon(c, o.spec.icon, ex, ey, 9, OBJCOL(o), o.spec.icon === 'bird' ? 0 : o.hd);
        c.fillStyle = OBJCOL(o); c.font = (11 * big) + 'px sans-serif'; const tx = OB[o.kind].label + ' ' + km(dh(o)) + ' out'; c.fillText(tx, clamp(ex - c.measureText(tx).width / 2, 4, w - c.measureText(tx).width - 4), ey + (ey > w / 2 ? -14 : 22));
      }
    }
    if (F.alarmT != null && S.t - F.alarmT < 8 && pulse < 0.5) { c.strokeStyle = '#ff4d4d'; c.lineWidth = 5; c.strokeRect(2, 2, w - 4, w - 4); c.lineWidth = 1; }
  }
  function star(c, x, y, r) { c.beginPath(); for (let i = 0; i < 10; i++) { const a = i * Math.PI / 5 - Math.PI / 2, rr = i % 2 ? r * 0.45 : r; c.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr); } c.closePath(); c.fill(); }
  function ring(c, x, y, col, ph) { c.strokeStyle = col; c.globalAlpha = 1 - ph; c.lineWidth = 2.5; c.beginPath(); c.arc(x, y, 8 + ph * 18, 0, 7); c.stroke(); c.globalAlpha = 1; c.lineWidth = 1; }
  function wedge(c, x, y, r, az, fov) { const a = (az - 90) * Math.PI / 180, h = fov / 2 * Math.PI / 180; c.beginPath(); c.moveTo(x, y); c.arc(x, y, r, a - h, a + h); c.closePath(); c.fill(); }
  function ray(c, x, y, b, len, col) { const t = b * Math.PI / 180; c.strokeStyle = col; c.lineWidth = 1.5; c.beginPath(); c.moveTo(x, y); c.lineTo(x + Math.sin(t) * len, y - Math.cos(t) * len); c.stroke(); c.lineWidth = 1; }

  function pickSel() { // auto: follow the node with the strongest ladder (or the one nearest the main object)
    if (S.selPinned && S.sel) return S.sel;
    const o = refObj(); let best = null, bs = -1e9;
    for (const n of nodes()) { const sc = n.det ? 10 + n.conf + (n.cls === 'drone' ? 5 : 0) : -Math.hypot(n.x - o.x, n.y - o.y) / 1e4; if (sc > bs) { bs = sc; best = n; } }
    S.sel = best; return best;
  }
  function drawSpec() {
    const c = sctx, w = spec.clientWidth, h = spec.clientHeight; c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, w, h);
    const n = S.sel, sp = n && n.spec, FM = 3600, lo = -10, hi = 60, yy = v => h - 14 - (clamp(v, lo, hi) - lo) / (hi - lo) * (h - 20), xx = f => f / FM * w;
    c.fillStyle = '#4b607c'; c.font = '10px sans-serif'; for (let f = 500; f < FM; f += 500) c.fillText(f + ' Hz', xx(f) - 14, h - 2);
    if (!sp) { c.fillText(S.tog.mics ? 'waiting…' : 'sound grid off', 10, 20); $('spinfo').textContent = ''; return; }
    const nb = Math.floor(FM / P.BIN_HZ);
    if (sp.roar) { c.fillStyle = '#9aa5b840'; c.beginPath(); c.moveTo(0, h - 14); for (let i = 1; i < nb; i++) c.lineTo(xx(i * P.BIN_HZ), yy(sp.roar[i])); c.lineTo(w, h - 14); c.fill(); }
    c.strokeStyle = '#2b82e8'; c.beginPath(); for (let i = 1; i < nb; i++) { const x = xx(i * P.BIN_HZ), y = yy(sp.db[i]); i > 1 ? c.lineTo(x, y) : c.moveTo(x, y); } c.stroke();
    c.strokeStyle = '#ffffff44'; c.setLineDash([3, 3]); c.beginPath(); for (let i = 1; i < nb; i++) { const x = xx(i * P.BIN_HZ), y = yy(sp.floor[i] + (S.tog.s3 ? 6 : 9)); i > 1 ? c.lineTo(x, y) : c.moveTo(x, y); } c.stroke(); c.setLineDash([]);
    const cb = sp.cb, ok = cb && cb.hits >= 3, dense = ok && cb.dense >= 3;
    if (ok) for (const r of cb.rungs) if (r.f < FM) { c.fillStyle = dense ? (r.hit ? '#ffb86b' : '#ffb86b33') : (r.hit ? '#ffd34d' : '#ffd34d33'); c.fillRect(xx(r.f) - 2, yy(sp.floor[Math.round(r.f / P.BIN_HZ)] || 0), 4, -Math.max(4, r.e / (hi - lo) * (h - 20))); }
    $('spttl').firstChild.textContent = 'Sound at post ' + n.id + (S.selPinned ? ' (pinned)' : '');
    $('spinfo').textContent = ok ? (dense ? 'ladder too dense → helicopter, not a drone' : 'drone ladder ' + Math.round(cb.f0) + ' Hz · ' + cb.hits + ' rungs') : 'no ladder' + (S.objs.some(o => o.spec.snd.roar) ? ' (roar only)' : '');
  }
  function drawPanel() {
    const p = F.p, st = $('pstate'); $('mfill').style.width = (p * 100).toFixed(1) + '%';
    let cls = '', txt;
    if (p >= ALARM) { cls = 'alarm'; txt = (S.tog.fusion ? 'DRONE ' : 'ALARM ') + Math.round(p * 100) + '%'; } else if (p >= 0.7) { cls = 'likely'; txt = 'Likely ' + Math.round(p * 100) + '%'; } else if (p >= 0.25) { cls = 'maybe'; txt = 'Maybe ' + Math.round(p * 100) + '%'; } else txt = 'Clear ' + Math.round(p * 100) + '%';
    st.className = 'state ' + cls; st.textContent = txt;
    $('stCue').classList.toggle('on', F.cue); $('stLoc').classList.toggle('on', F.loc); $('stConf').classList.toggle('on', F.conf);
    $('clock').textContent = clock(S.t) + (S.done ? ' · flight over' : !S.playing ? ' · paused' : '');
  }

  // ---------- main loop ----------
  let last = performance.now();
  function frame(now) {
    const fdt = Math.min(0.1, (now - last) / 1000); last = now;
    if (S.playing && !S.done) {
      S.acc += fdt * S.speed; let n = 0;
      while (S.acc >= EVAL_DT && n++ < 40) { S.acc -= EVAL_DT; S.t += EVAL_DT; moveObjs(); if (S.done) break; evaluate(); if (!S.playing) { S.acc = 0; break; } }
    }
    pickSel(); drawMap(); drawSpec(); drawPanel(); audioUpdate(); placeCallout();
    requestAnimationFrame(frame);
  }

  // ---------- Web Audio "listen at node" (synthetic, made from the model levels) ----------
  let AC = null, osc = [], noiseG = null, master = null;
  function audioToggle() {
    if (AC) { AC.close(); AC = null; osc = []; $('listen').firstChild.textContent = '🔊 Listen'; return; }
    AC = new (window.AudioContext || window.webkitAudioContext)(); master = AC.createGain(); master.gain.value = 0.5; master.connect(AC.destination);
    for (let h = 1; h <= 10; h++) { const o = AC.createOscillator(), g = AC.createGain(); o.type = 'sine'; g.gain.value = 0; o.connect(g); g.connect(master); o.start(); osc.push({ o, g }); }
    const buf = AC.createBuffer(1, AC.sampleRate * 2, AC.sampleRate), ch = buf.getChannelData(0); for (let i = 0; i < ch.length; i++) ch[i] = Math.random() * 2 - 1;
    const src = AC.createBufferSource(); src.buffer = buf; src.loop = true; const lp = AC.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900; noiseG = AC.createGain(); noiseG.gain.value = 0;
    src.connect(lp); lp.connect(noiseG); noiseG.connect(master); src.start(); $('listen').firstChild.textContent = '🔇 Stop';
  }
  function audioUpdate() {
    if (!AC || !S.sel) return;
    const n = S.sel, env = { scen: S.scen, wind: S.wind, tog: S.tog, objs: S.objs }, now = AC.currentTime;
    const tones = S.objs.flatMap(o => P.objectTones(o, env, n).tones).filter(t => t.f > 60).sort((a, b) => b.L - a.L).slice(0, 10);
    const nz = P.noiseParts(300, env, n), noiseDb = P.dbAdd(nz.self, nz.amb, nz.wind, nz.roar), amp = db => Math.min(0.25, Math.pow(10, (db - 60) / 20));
    osc.forEach((o, i) => { const t = tones[i]; o.o.frequency.setTargetAtTime(t ? t.f : 100, now, 0.05); o.g.gain.setTargetAtTime(t ? amp(t.L) : 0, now, 0.1); });
    noiseG.gain.setTargetAtTime(Math.min(0.4, Math.pow(10, (noiseDb - 45) / 20)), now, 0.1);
  }

  // ---------- guided tour ----------
  const TOUR = [
    { t: 'Meet the sensors', x: 'This is a 3 × 3 km area seen from above, with a <b>hub</b> (★) in the middle. <b>Green dots</b> are 16 sound posts (mics on poles). <b>Purple triangles</b> are 3 tall towers with radio + Remote ID listeners. The <b>orange square</b> is a thermal camera, the <b>pink diamond</b> a vibration sensor on a roof.<br>Every one of them only <b>listens</b>. Tap Next to fly a small drone in, with a jet passing overhead.' },
    { t: 'Radio hears first', wait: 'rf', x: 'The drone talks to its pilot on <b>2.4 / 5.8 GHz</b>. Radio carries for kilometres, while sound fades within a few hundred metres, so a <b>tower hears it first</b>. It only measures signal strength and direction — it never decodes anything. On its own a blip is just a <b>"maybe"</b> (WiFi looks similar), so the meter can rise but never hits the alarm line.' },
    { t: 'The sound ladder', wait: 'snd', x: 'Spinning propellers make one hum plus <b>exact multiples</b> of it — like rungs on a ladder (yellow bars in the "Sound at post" chart). A <b>jet</b> is a smeared roar (grey haze, no rungs). A <b>bird</b> is a lone high chirp. A <b>helicopter\'s</b> ladder is far too dense. Only a clean ladder counts as a drone — that is how the sound grid tells them apart.' },
    { t: 'Fusion adds up the maybes', wait: 'alarm', x: 'Each sense gives a score. Fusion adds them up: two different senses agreeing (radio + sound) beat one loud sensor. Scores that point to a different place are mostly ignored, and old evidence fades. When the total crosses <b>95%</b>, the alarm goes off. Below the map the cyan circle is fusion\'s <b>guess</b> of where the drone is.' },
    { t: 'The camera confirms', wait: 'confirm', x: 'Fusion told the thermal camera where to look, so it <b>turned</b> to the guess instead of searching the whole sky. It sees a warm, drone-shaped dot. Shape and motion also let it say "that\'s a bird" or "that\'s a plane", which would <b>lower</b> the score.' },
    { t: 'What happens next', x: 'Look at the <b>What happens next</b> panel: ① an alert goes to phones and a siren/light, ② the camera records, ③ an evidence log builds that you can <b>download</b>, ④ a checklist: go indoors, don\'t approach it, report to <b>police (112)</b> and <b>DGCA Digital Sky</b> with the evidence. All legal, nothing is jammed or shot down.' },
    { t: 'Your turn', x: 'Try a decoy and see fusion stay calm:<br><button data-try="bird">🐦 Bird only</button><button data-try="heli">🚁 Helicopter + small quad</button><button data-try="fpv">⚡ Silent FPV racer</button><br>Or pick anything from <b>What\'s flying in?</b> Tap any <b>?</b> for help.' }
  ];
  const tour = { on: false, i: 0, waiting: null };
  function startTour() {
    tour.on = true; tour.i = 0; tour.waiting = null; S.kind = 'small'; S.second = 'jet'; S.route = 0; S.scen = 'suburb'; S.rid = false; S.radio = true; S.height = 60;
    for (const k in S.tog) S.tog[k] = true; syncUI(); reset(); S.playing = false; setPlay(); showTour();
  }
  function showTour() {
    const st = TOUR[tour.i]; $('tour').hidden = false;
    $('tourStep').textContent = 'HOW IT WORKS · ' + (tour.i + 1) + ' / ' + TOUR.length; $('tourTitle').textContent = st.t;
    if (st.wait && !moments[st.wait]) {
      tour.waiting = st.wait; $('tourText').innerHTML = '<span class="wait">⏩ Playing the flight until this happens…</span>'; $('tourNext').disabled = true;
      S.speed = 15; S.playing = true; setPlay(); hideCallout();
    } else {
      tour.waiting = null; $('tourText').innerHTML = st.x; $('tourNext').disabled = false; S.playing = false; setPlay();
      const m = st.wait && moments[st.wait]; if (m) showCallout(m.sensor, m.title, m.text, false); else if (tour.i === 0) { hideCallout(); } else if (tour.i === 5) { hideCallout(); document.getElementById('resp').scrollIntoView({ behavior: 'smooth', block: 'center' }); }
    }
    $('tourBack').disabled = tour.i === 0; $('tourNext').textContent = tour.i === TOUR.length - 1 ? 'Finish ✓' : 'Next ▶';
    $('tourText').querySelectorAll('[data-try]').forEach(b => b.onclick = () => { endTour(); const k = b.dataset.try; S.kind = k === 'heli' ? 'small' : k; S.second = k === 'heli' ? 'heli' : ''; S.radio = k !== 'fpv'; S.rid = false; S.height = OB[S.kind].h; syncUI(); reset(); S.playing = true; setPlay(); });
  }
  function tourMoment(key) { if (tour.waiting === key) { tour.waiting = null; showTour(); } }
  function endTour() { tour.on = false; tour.waiting = null; $('tour').hidden = true; hideCallout(); setSpeed(8); }

  // ---------- UI ----------
  function setPlay() { $('play').textContent = S.playing ? '⏸ Pause' : '▶ Play'; }
  function setSpeed(v) { S.speed = v; document.querySelectorAll('#speedSeg button').forEach(b => b.classList.toggle('on', +b.dataset.v === v)); }
  function iconCanvas(kind, col, px) {
    const cv = document.createElement('canvas'), d = window.devicePixelRatio || 1; cv.width = px * d; cv.height = px * d; const c = cv.getContext('2d'); c.scale(d, d);
    drawIcon(c, kind, px / 2, px / 2, px * 0.36, col, kind === 'bird' ? 0 : 0); return cv;
  }
  function buildPicker() {
    const box = $('picker'); box.innerHTML = '';
    for (const k of PICK) {
      const o = OB[k], b = document.createElement('button'); b.dataset.k = k; if (!o.drone) b.classList.add('decoy');
      b.appendChild(iconCanvas(o.icon, o.drone ? '#ff6b6b' : '#ffb86b', 40));
      b.insertAdjacentHTML('beforeend', '<span class="nm">' + o.label + '</span><span class="sb">' + o.sub + '</span>');
      b.onclick = () => { S.kind = k; S.height = o.h; S.rid = o.rid; S.radio = o.eirp != null; if (S.second === k) S.second = ''; syncUI(); reset(); S.playing = true; setPlay(); };
      box.appendChild(b);
    }
    const sel = $('second'); for (const k of PICK) { const op = document.createElement('option'); op.value = k; op.textContent = (OB[k].drone ? '' : 'Decoy: ') + OB[k].label; sel.appendChild(op); }
  }
  function buildLegend() {
    const L = $('legend'); L.innerHTML = '';
    const item = (cv, t) => { const s = document.createElement('span'); s.appendChild(cv); s.appendChild(document.createTextNode(t)); L.appendChild(s); };
    const dot = (fn) => { const cv = document.createElement('canvas'), d = window.devicePixelRatio || 1; cv.width = 22 * d; cv.height = 22 * d; const c = cv.getContext('2d'); c.scale(d, d); fn(c); return cv; };
    item(dot(c => { c.fillStyle = '#4f8f5a'; c.beginPath(); c.arc(11, 11, 5, 0, 7); c.fill(); }), 'sound post');
    item(dot(c => { c.fillStyle = '#b48cff'; c.beginPath(); c.moveTo(11, 2); c.lineTo(19, 18); c.lineTo(3, 18); c.fill(); }), 'radio + Remote ID tower');
    item(dot(c => { c.fillStyle = '#ffb347'; c.fillRect(5, 5, 12, 12); }), 'thermal camera');
    item(dot(c => { c.fillStyle = '#ff7ad9'; c.translate(11, 11); c.rotate(Math.PI / 4); c.fillRect(-5, -5, 10, 10); }), 'vibration');
    item(dot(c => { c.fillStyle = '#fff'; star(c, 11, 11, 8); }), 'hub');
    item(dot(c => { c.strokeStyle = '#7fd38c'; c.lineWidth = 2.5; c.beginPath(); c.arc(11, 11, 8, 0, 7); c.stroke(); c.fillStyle = '#a6ffb4'; c.beginPath(); c.arc(11, 11, 3.5, 0, 7); c.fill(); }), 'pulsing ring = hears it');
    item(iconCanvas('quad', '#ff6b6b', 22), 'drone (truth)');
    item(iconCanvas('bird', '#ffb86b', 22), 'decoy');
    item(dot(c => { c.strokeStyle = '#4fe3ff'; c.lineWidth = 2; c.beginPath(); c.arc(11, 11, 7, 0, 7); c.stroke(); c.beginPath(); c.moveTo(3, 11); c.lineTo(19, 11); c.moveTo(11, 3); c.lineTo(11, 19); c.stroke(); }), 'fusion guess');
  }
  function buildToggles() {
    const box = $('toggles'); box.innerHTML = '';
    for (const [k, label, help] of TOG) { const b = document.createElement('button'); b.textContent = label; b.className = S.tog[k] ? 'on' : ''; b.dataset.k = k; b.title = help;
      b.onclick = () => { S.tog[k] = !S.tog[k]; b.className = S.tog[k] ? 'on' : ''; log((S.tog[k] ? 'ON: ' : 'OFF: ') + label.replace(/^\S+ /, ''), 'fus'); }; box.appendChild(b); }
  }
  function syncUI() {
    document.querySelectorAll('#picker button').forEach(b => b.classList.toggle('on', b.dataset.k === S.kind));
    $('second').value = S.second; $('route').value = S.route; $('scen').value = S.scen; $('height').value = S.height; $('hv').textContent = S.height + ' m';
    $('rid').checked = S.rid; $('radio').checked = S.radio; const dr = OB[S.kind].drone; $('rid').disabled = !dr; $('radio').disabled = !dr;
    document.querySelectorAll('#toggles button').forEach(b => b.className = S.tog[b.dataset.k] ? 'on' : '');
  }
  // small "?" next to every control that has data-help
  function buildHelp() {
    const pop = $('pop');
    document.querySelectorAll('[data-help]').forEach(el => {
      const q = document.createElement('button'); q.className = 'q'; q.type = 'button'; q.textContent = '?'; q.setAttribute('aria-label', 'Help');
      q.onclick = e => { e.preventDefault(); e.stopPropagation(); if (!pop.hidden && pop._for === q) { pop.hidden = true; return; } pop._for = q; pop.textContent = el.dataset.help; pop.hidden = false;
        const r = q.getBoundingClientRect(), pw = Math.min(280, window.innerWidth - 16); pop.style.maxWidth = pw + 'px';
        pop.style.left = clamp(r.left + window.scrollX - pw / 2, 8 + window.scrollX, window.scrollX + window.innerWidth - pw - 8) + 'px'; pop.style.top = (r.bottom + window.scrollY + 6) + 'px'; };
      if (el.classList.contains('seg')) el.after(q); else if (el.tagName === 'LABEL' && el.querySelector('select,input[type=range]')) { const t = el.firstChild, sp = document.createElement('span'); sp.className = 'lt'; el.insertBefore(sp, t); sp.appendChild(t); sp.appendChild(q); } else el.appendChild(q);
    });
    document.addEventListener('click', e => { if (!pop.hidden && e.target !== pop) pop.hidden = true; });
  }
  function bind() {
    $('play').onclick = () => { if (S.done) reset(); S.playing = !S.playing || S.done; if (S.playing) hideCallout(); setPlay(); };
    $('restart').onclick = () => { reset(); S.playing = true; setPlay(); };
    document.querySelectorAll('#speedSeg button').forEach(b => b.onclick = () => setSpeed(+b.dataset.v));
    $('pauseAt').onchange = e => S.pauseAt = e.target.checked;
    $('callout').querySelector('.co-go').onclick = () => { hideCallout(); S.playing = true; setPlay(); };
    $('listen').onclick = audioToggle;
    $('dl').onclick = () => { const blob = new Blob([JSON.stringify(evidenceReport(), null, 2)], { type: 'application/json' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'skyfuse-evidence-' + clock(S.t).replace(/:/g, '') + '.json'; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); };
    const restartOn = () => { S.second = $('second').value; S.route = +$('route').value; S.scen = $('scen').value; S.rid = $('rid').checked; S.radio = $('radio').checked; if (S.second === S.kind) S.second = ''; syncUI(); reset(); S.playing = true; setPlay(); };
    ['second', 'route', 'scen', 'rid', 'radio'].forEach(id => $(id).onchange = restartOn);
    $('height').oninput = e => { S.height = +e.target.value; $('hv').textContent = S.height + ' m'; };
    $('wind').oninput = e => { S.wind = +e.target.value; $('wv').textContent = S.wind + ' m/s'; };
    $('tourBtn').onclick = startTour;
    $('tourNext').onclick = () => { if (tour.i >= TOUR.length - 1) { endTour(); return; } tour.i++; showTour(); };
    $('tourBack').onclick = () => { if (tour.i > 0) { tour.i--; tour.waiting = null; const st = TOUR[tour.i]; $('tourStep').textContent = 'HOW IT WORKS · ' + (tour.i + 1) + ' / ' + TOUR.length; $('tourTitle').textContent = st.t; $('tourText').innerHTML = st.x; $('tourNext').disabled = false; $('tourBack').disabled = tour.i === 0; $('tourNext').textContent = 'Next ▶'; S.playing = false; setPlay(); } };
    $('tourClose').onclick = endTour;
    // drag sensors / tap posts
    let drag = null, moved = false;
    const pos = e => { const r = map.getBoundingClientRect(); return { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale }; };
    map.addEventListener('pointerdown', e => { const p = pos(e); let best = null, bd = 24 / scale; for (const s of sensors) { const d = Math.hypot(s.x - p.x, s.y - p.y); if (d < bd) { bd = d; best = s; } }
      if (best) { drag = best; moved = false; map.setPointerCapture(e.pointerId); e.preventDefault(); } });
    map.addEventListener('pointermove', e => { if (!drag) return; const p = pos(e); moved = true; drag.x = clamp(p.x, 0, W); drag.y = clamp(p.y, 0, W); if (drag.kind === 'node' || drag.kind === 'hub') aimDishes(); });
    const up = () => { if (drag && !moved && drag.kind === 'node') { if (S.sel === drag && S.selPinned) S.selPinned = false; else { S.sel = drag; S.selPinned = true; } } drag = null; };
    map.addEventListener('pointerup', up); map.addEventListener('pointercancel', up);
    window.addEventListener('resize', resize);
  }

  buildLayout(); buildPicker(); buildLegend(); buildToggles(); buildHelp(); bind(); syncUI(); resize(); reset();
  window.SkyFuse = { S, F: () => F, firsts: () => firsts, moments: () => moments, tour, evidenceReport, reset, startTour, syncUI, setSpeed };
  requestAnimationFrame(frame);
})();
