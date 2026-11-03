// SkyFuse sim: world, flying objects, fusion brain, key moments, guided tour, response timeline, rendering and UI.
(function () {
  'use strict';
  const P = window.SkyPhys, C = window.SkyCore, $ = id => document.getElementById(id), OB = P.OBJECTS;
  const W = 3000, EVAL_DT = 0.5, ALARM = C.ALARM, clamp = P.clamp;

  // ---------- preset layout (metres, origin top-left, y grows south) ----------
  const HUB = { kind: 'hub', id: 'HUB', name: 'hub', x: 1500, y: 1500, h: 10 };
  const sensors = [];
  function buildLayout() {
    sensors.length = 0; let k = 1;
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) sensors.push({ kind: 'node', id: 'N' + k, name: 'sound node N' + k, x: 750 + c * 500, y: 750 + r * 500, h: 1.5, wireD: 0.006 + 0.0003 * (k++ % 10) }); // guy-wire thickness differs a little per post
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
    t: 0, acc: 0, playing: true, speed: 8, scen: 'suburb', wx: { wind: 3, windFrom: 270, dust: 0, rain: 0, tod: 'mildday' }, preset: null,
    mapMode: 'grid', geo: { lat: 12.9719, lon: 77.6412, name: 'Indiranagar, Bangalore' }, kind: 'small', second: 'jet', height: 60, rid: true, radio: true, route: 0, pauseAt: true,
    tog: { mics: true, lownoise: true, dish: true, ring: true, s3: true, height: true, longlisten: true, rf: true, rid: true, thermal: true, vib: true, adsb: true, temp: true, pps: true, fusion: true },
    tracker: true, adsbMissing: 0.2, count: 1, formation: 'spread',
    sel: null, objs: [], trail: [], done: false, focus: null,
    clock0: 10 * 3600 + 21 * 60, weekend: false,                 // flight start time of day (s) and day type
    wxAware: true, impact: null, policy: C.NEUTRAL, cov: null,    // 1. weather-aware fusion
    engine: 'lr', learnOn: true, place: C.newPlace(), srcs: [], heat: false, nightly: true, protect: true, learnedAt: null, srcsAtLearn: '' // 2. place learning
  };
  const TOG = [
    ['mics', '🎙 Sound grid', 'The 16 listening posts. Each one looks for the drone\'s sound ladder.'], ['lownoise', 'Low-noise mics', 'Better microphones with less hiss: faint drones show up sooner.'],
    ['dish', 'Dish', 'A bowl behind each mic that boosts sound from one direction (+9 dB), pointing outward.'], ['ring', '4-mic ring', 'Four mics per post: gives a direction arrow and turns down sound from other directions.'],
    ['s3', 'ESP32-S3 classifier', 'A small trained model on a faster chip: accepts fainter ladders (6 dB instead of 9).'],
    ['height', 'Posts on 8 m poles', 'Lifts the mics above walls and street noise.'], ['longlisten', 'Long listening 3 s', 'Averages 3 seconds of sound: a faint steady hum builds up above random noise.'],
    ['rf', '📡 Radio listener', 'Measures how strong drone radio signals are at 2.4/5.8 GHz. Never decodes or transmits.'], ['rid', '🆔 Remote ID', 'Reads the public "here I am" broadcast that many drones send.'],
    ['thermal', '🌡 Thermal cam', 'Sees warm motors against the cool sky, and tells drone vs bird vs aircraft by shape and motion.'], ['vib', '〰 Vibration', 'Feels a big drone flying very low over the building.'],
    ['adsb', '✈ ADS-B receiver', 'Receive-only 1090 MHz: public position broadcasts from crewed aircraft. Only explains away aircraft sound/heat; never touches drone radio.'],
    ['temp', '🌡 Hub temp + humidity', 'A shaded temperature/humidity sensor at the hub sets the speed of sound for timing (±0.3 °C). Off: a time-of-day guess (±4 °C).'],
    ['pps', '🛰 GPS time sync (PPS)', 'Each post timestamps its audio to GPS time (about 1 µs), so arrival-time differences between posts (TDOA) pin the drone down.'],
    ['fusion', '🧠 Fusion', 'Combines all sensors. Off = any single sensor sets off the alarm (expect false alarms).']
  ];
  const PICK = ['toy', 'small', 'large', 'fixed', 'fpv', 'bird', 'jet', 'heli'];
  let F, R, EV, firsts, lastState, logLines, moments;

  function makeObj(kind, role) {
    const sp = OB[kind], path = pathFor(kind, role, S.route);
    return { kind, spec: sp, role, path, x: 0, y: 0, h: role === 1 ? S.height : sp.h, rpm: 1, phase: Math.random() * 6,
      radioOn: sp.eirp != null && (role === 1 ? S.radio : true), ridOn: role === 1 ? (S.rid && sp.drone) : sp.rid, done: false, trail: [],
      adsbOn: !!sp.adsb && Math.random() >= S.adsbMissing, callsign: sp.adsb ? (kind === 'heli' ? 'VT-H' : 'AI') + (100 + Math.floor(Math.random() * 900)) : null, rpm0: 1, idx: 0 };
  }
  // multi-drone: extra copies of the main drone. Spread = staggered on the three routes; swarm = one tight formation (5 x 4, 30 m)
  function makeFleet() {
    const out = [], n = clamp(S.count | 0, 1, 20);
    for (let i = 0; i < n; i++) {
      const o = makeObj(S.kind, 1); o.idx = i; o.rpm0 = i ? 1 + (((i * 7919) % 17) - 8) * 0.006 : 1;      // airframes differ by a few % in rotor pitch
      if (i) { o.ridOn = o.ridOn && i % 2 === 0;
        if (S.formation === 'swarm') { const gx = (i % 5) - 2, gy = Math.floor(i / 5) - 1.5; o.path = Object.assign({}, o.path, { pts: o.path.pts.map(p => [p[0] + gx * 30, p[1] + gy * 30]) }); o.h = S.height + (i % 3) * 10; }
        else { o.path = Object.assign({}, pathFor(S.kind, 1, (S.route + i) % 3), { phase: -i * 9 }); o.path.pts = o.path.pts.map(p => [p[0] + ((i * 37) % 7 - 3) * 60, p[1] + ((i * 53) % 7 - 3) * 60]); o.h = S.height + ((i * 13) % 5) * 10; } }
      out.push(o);
    }
    return out;
  }
  function reset() {
    S.t = 0; S.acc = 0; S.done = false; logNewRun(); S.focus = null; hideCallout();
    S.objs = makeFleet(); if (S.second) S.objs.push(makeObj(S.second, 2)); TK = { tracks: [], next: 1, scans: 0 }; SB = { scans: 0, covered: 0, droneScans: 0, errSum: 0, errN: 0, falseScans: 0, swaps: 0, locT: 0, locG: 0, last: new Map() };
    F = { B: {}, Bleg: {}, LR: C.newBlendState({ lambdaD: 1 / 8 }), pLeg: 0.007, pLR: 0.007, L: -5, p: 0.007, est: null, er: 0, hist: [], cue: false, loc: false, conf: false, alarmT: null, lastMeasT: -99, falseAlarms: 0, alarmFalse: null, alarmD: null, falseSnd: 0, fakeVib: 0, familiar: 0 };
    R = { step: 0, recStart: null };
    EV = { points: [], senses: {} };
    firsts = {}; lastState = {}; logLines = []; moments = {};
    $('log').innerHTML = ''; $('first').textContent = 'Waiting…'; $('first').className = ''; $('firsts').innerHTML = '';
    ['r1', 'r2', 'r3', 'r4'].forEach(id => $(id).classList.remove('done'));
    $('dl').disabled = true; $('respstate').textContent = 'starts at 95% fusion confidence'; $('pnmsg').textContent = '—'; $('rectime').textContent = '00:00';
    document.querySelectorAll('#timeline input').forEach(i => i.checked = false);
    for (const s of sensors) { s.det = false; s.conf = 0; s.hist = []; s.rep = null; s.spec = null; s.cls = null; s.sh = []; }
    cam().az = 45;
    moveObjs();
    log('Flight starts: ' + S.objs.map(o => OB[o.kind].label).join(' + ') + ' · ' + sceneName() + ' · ' + wxName() + ' · map centre ' + llTxt(HUB) + ' (' + S.geo.name + ') · ' + dayTxt() + ' · weather-aware ' + (S.wxAware ? 'ON' : 'OFF') + ' · place learning ' + (S.learnOn ? (learned() ? 'ON' : 'ON (not learned yet)') : 'OFF') + (S.srcs.length ? ' · local noise: ' + S.srcs.map(x => P.SOURCES[x.type].label).join(', ') : ''), 'fus');
    for (const a of AIRPORTS) { const q = fromLL(a.lat, a.lon), d = Math.hypot(clamp(q.x, 0, W) - q.x, clamp(q.y, 0, W) - q.y); if (d < a.r) log('Note: area is within ~' + (a.r / 1000) + ' km of ' + a.name + ' (approx, check Digital Sky before any flying)', 'warn'); }
  }
  const hourNow = () => ((S.clock0 + S.t) / 3600) % 24, slotNow = () => C.slotOf(hourNow(), S.weekend);
  const liveDay = () => S.weekend ? 12 : 7;                          // the learning week is days 0-6 (Mon-Sun); "today" comes after
  const dayTxt = () => S.weekend ? 'weekend' : 'weekday';
  const learned = () => S.place.samples > 0;
  const envNow = () => ({ scen: S.scen, wind: S.wx.wind, wx: S.wx, tog: S.tog, objs: S.objs });
  const wxName = () => { const w = S.wx; return P.TOD[w.tod].label + ' ' + P.TOD[w.tod].T + ' °C, wind ' + w.wind + ' m/s from ' + P.compass(w.windFrom) + (w.rain ? ', ' + ['', 'drizzle', 'heavy rain'][w.rain] : '') + (w.dust ? ', ' + ['', 'light haze', 'heavy dust'][w.dust] : ''); };
  // ---------- GPS: the 3 x 3 km model is a local flat patch centred on S.geo (map centre = 1500,1500 m) ----------
  const M_DEG = 111320, cosLat = () => Math.cos(S.geo.lat * Math.PI / 180);
  const toLL = p => ({ lat: S.geo.lat - (p.y - W / 2) / M_DEG, lon: S.geo.lon + (p.x - W / 2) / (M_DEG * cosLat()) });
  const fromLL = (lat, lon) => ({ x: W / 2 + (lon - S.geo.lon) * M_DEG * cosLat(), y: W / 2 - (lat - S.geo.lat) * M_DEG });
  const llTxt = p => { const g = toLL(p); return Math.abs(g.lat).toFixed(5) + '°' + (g.lat >= 0 ? 'N' : 'S') + ', ' + Math.abs(g.lon).toFixed(5) + '°' + (g.lon >= 0 ? 'E' : 'W'); };
  const llObj = p => { const g = toLL(p); return { lat: +g.lat.toFixed(6), lon: +g.lon.toFixed(6) }; };
  // known airports: faint "no-fly" hint ring (approx; the real zones are on DGCA Digital Sky)
  const AIRPORTS = [{ name: 'HAL Airport', lat: 12.9499, lon: 77.6682, r: 5000 }];
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
      const pth = o.path, sp = o.spec; let s = Math.max(0, S.t + pth.phase) * sp.speed; const px = o.x, py = o.y;
      if (pth.loop) s = s % (plen(pth.pts) * 1.0);
      const p = along(pth.pts, s);
      o.x = p.x; o.y = p.y; o.hd = p.hd;
      if (pth.wavy) { const t = p.hd * Math.PI / 180, off = 70 * Math.sin(S.t / 4 + o.phase); o.x += Math.cos(t) * off; o.y += Math.sin(t) * off; o.h = (o.role === 1 ? S.height : sp.h) + 12 * Math.sin(S.t / 7 + o.phase); }
      else if (o.role === 1) o.h = S.height;
      const st = P.droneStrain(o.spec, S.wx); o.loud = st.loud;                // bad weather: louder motors, wobbly path
      if (st.wobble) { const t = (p.hd + 90) * Math.PI / 180, off = st.wobble * (0.6 * Math.sin(S.t / 2.3 + o.phase) + 0.4 * Math.sin(S.t / 0.9)); o.x += Math.sin(t) * off; o.y -= Math.cos(t) * off; }
      o.rpm = (o.rpm0 || 1) * (1 + 0.03 * Math.sin(S.t / 3 + o.phase));                     // rotor speed wobble: the whole ladder slides together
      if (sp.snd.chirp) { o.chirping = Math.random() < sp.snd.chirp.duty; o.chirpF = 2600 + Math.random() * 800; }
      if (p.end && !pth.loop) o.done = true;
      o.vx = (o.x - px) / EVAL_DT; o.vy = (o.y - py) / EVAL_DT;
    }
    if (S.objs.filter(o => o.role === 1).every(o => o.done) && !S.done) { S.done = true; S.playing = false; setPlay(); finish(); }
  }

  // ---------- one sensing + fusion step (every 0.5 s of sim time) ----------
  function evaluate() {
    const env = Object.assign(envNow(), P.activeSources(S.srcs, hourNow(), S.weekend)), reps = [], T = S.tog, pol = S.policy;
    const slot = slotNow(), useL = S.learnOn && learned(), thr = T.s3 ? 6 : P.HIT_DB, busy = F.p >= 0.25 || F.alarmT != null;
    // sound grid
    for (const n of nodes()) {
      n.h = T.height ? 8 : 1.5;
      n._focus = S.objs.filter(o => o.spec.drone).sort((a, b) => Math.hypot(a.x - n.x, a.y - n.y) - Math.hypot(b.x - n.x, b.y - n.y))[0] || null;
      n.rep = null;
      if (!T.mics) { n.det = false; n.conf = 0; n.spec = null; n.lads = []; continue; }
      const sp = P.synth(env, n, n.specBuf || (n.specBuf = new Float32Array(P.NB)));
      const lads = ladders(sp.db, thr), bands = S.learnOn ? C.bandsOf(sp.db, P.BIN_HZ) : null;
      let cb = lads[0] || P.comb(sp.db, thr), nov = null, famT = null;
      if (useL) {                                                           // place learning: is each ladder normal here at this hour?
        famT = C.familiarTones(S.place, n.id, slot, 0.5);
        const scored = lads.map(l => ({ l, nv: C.novelty(S.place, n.id, slot, { bands, f0: l.f0 }) }));
        const fresh = scored.find(x => x.nv.ladder >= 0.5);                 // the first NEW ladder under the familiar ones (generator, bells)
        const pick = fresh || scored[0];
        if (pick) { cb = pick.l; nov = pick.nv; } else nov = C.novelty(S.place, n.id, slot, { bands });
      }
      const hit = cb.hits >= pol.sndMinHits;                                // weather-aware: 4 rungs needed when wind makes wires sing
      if (cb.hits >= 3 && !hit) n.rejected = (n.rejected || 0) + 1;
      n.hist.push(hit ? { cb, nov: nov && nov.ladder != null ? nov.ladder : 1 } : null); if (n.hist.length > 3) n.hist.shift();
      const good = n.hist.filter(Boolean), gnov = good.length ? good.reduce((a, g) => a + g.nov, 0) / good.length : 1;
      n.det = good.length >= 2;                                             // 2 of last 3 frames agree (stability)
      n.cls = n.det ? (good.filter(g => g.cb.dense >= 3).length * 2 > good.length ? 'heli' : useL && gnov < 0.5 ? 'familiar' : 'drone') : null; // dense = big slow rotor
      n.conf = n.det ? clamp((good.reduce((a, g) => a + g.cb.s, 0) / good.length - 2) / 8, 0.2, 1) : 0;
      n.lads = lads.filter(l => l.hits >= pol.sndMinHits).map(l => {          // every ladder this post hears, for the multi-target tracker
        const nv = useL ? C.novelty(S.place, n.id, slot, { bands, f0: l.f0 }) : null, fam = nv && nv.ladder != null ? 1 - nv.ladder : 0, src = nearestSrc(n, l);
        return { f0: l.f0, cls: l.dense >= 3 ? 'heli' : fam >= 0.5 ? 'familiar' : 'drone', fam, src, snr: snr3(l), brg: T.ring ? (src ? P.bearing(n, src) + P.gauss() * 8 : Math.random() * 360) : null };
      }).filter(l => l.cls !== 'familiar');
      n.nov = nov; n.spec = { db: sp.db, floor: cb.floor, cb, roar: n._roarDb, src: nearestSrc(n, cb), fam: famT, nov };
      if (S.learnOn && !useL) n.spec.fam = null;
      if (S.debug) S.debug.push({ t: S.t, id: n.id, f0s: lads.map(l => Math.round(l.f0) + '/' + l.hits), pick: Math.round(cb.f0), nov: nov && nov.ladder, cls: n.cls, src: !!n.spec.src });
      if (S.learnOn) C.learn(S.place, n.id, slot, liveDay(), { bands, f0s: lads.map(l => l.f0) }, { alarmActive: busy, protect: S.protect, rate: 0.0005 }); // slow drift
      if (n.det) {
        const src = n.spec.src;
        if (n.cls === 'drone' && !src) F.falseSnd = (F.falseSnd || 0) + 1;  // a 'drone' ladder no flying object made (wires, generator, bells)
        n.rep = { kind: 'snd', id: n.id, conf: n.conf, snr: snr3(cb), f0: cb.f0, hits: cb.hits, w: cb.s, cls: n.cls, obj: src, novelty: useL ? gnov : null };
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
      if (T.rid) for (const o of S.objs) { const r = P.rid(o, env, tw); if (r) { tw.ridRep = Object.assign({ kind: 'rid', id: tw.id, serial: '1596F3SIM' + o.role }, r); reps.push(tw.ridRep); break; } }
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
    let shake = null;
    if (T.vib) for (const o of S.objs) { const r = P.vibration(o, v); if (r) { shake = Object.assign({ kind: 'vib', id: 'VIB' }, r); break; } }
    if (T.vib && !shake && Math.random() < P.vibFalseRate(S.wx)) shake = { kind: 'vib', id: 'VIB', conf: 0.4, fake: true }; // gust / rain drumming
    v.sh.push(shake ? 1 : 0); if (v.sh.length > 3) v.sh.shift();
    if (shake && v.sh.reduce((a, b) => a + b, 0) >= pol.vibNeed) { v.rep = shake; reps.push(shake); if (shake.fake) F.fakeVib++; } // weather-aware: 2 shakes needed in gusty/rainy weather
    v.det = !!v.rep;

    fuse(reps);
    logTransitions(reps);
    recordEvidence(reps);
    logSecond(reps);
    response();
  }
  // ---------- no-drone log (quanta spec f, JSONL schema v1) ----------
  // 1 Hz records per sound post / RF tower / camera, weather every 10 s, sys events. Session "nd-…" = operator-certified quiet
  // time; it auto-cancels (records re-tagged, note logged) the moment Remote ID or a confirmed track appears.
  var LOG_MAX = 200000, DAY0 = Date.UTC(2026, 10, 2, 18, 30);   // 2026-11-03 00:00 IST
  var LG = { recs: [], ss: { mode: 'IDLE', seq: 0 }, sess: null, lastS: -1, lastWx: -99, off: 0, lastWet: null };   // var: reset() may run first
  // each flight restart moves the log clock forward by whole days, so ts stays increasing and hod stays true
  function logNewRun() { if (!LG || !LG.recs.length) return; const last = LG.recs[LG.recs.length - 1].ts, start = DAY0 + Math.round(S.clock0 * 1000);
    LG.off = Math.max(0, Math.ceil((last + 1000 - start) / 86400000)) * 86400000; LG.lastS = -1; LG.lastWx = -99; }
  const tsNow = () => DAY0 + LG.off + Math.round((S.clock0 + S.t) * 1000), hodNow = () => Math.floor(hourNow());
  function logRec(o) { if (LG.recs.length >= LOG_MAX) LG.recs.splice(0, 10000); LG.recs.push(Object.assign({ v: 1, ts: tsNow(), hod: hodNow(), session: LG.sess ? LG.sess.id : 'live', up: true }, o)); }
  function logSys(event, detail, extra) { logRec(Object.assign({ node: 'HUB', kind: 'sys', event, detail: detail || '' }, extra || {})); }
  // rain state (g.6): operator flag + feed. Feed = live Open-Meteo (optional, cached 15 min, real clock) or the sim's own weather.
  const OM_KEY = 'skyfuse.openmeteo';
  function omCached() { try { return JSON.parse(localStorage.getItem(OM_KEY) || 'null'); } catch (e) { return null; } }
  function omPoll(force) {
    if (!$('omFeed') || !$('omFeed').checked) return; const c = omCached();
    if (!force && c && Date.now() - c.fetchedAt < C.OPEN_METEO_POLL_MS && c.lat === S.geo.lat && c.lon === S.geo.lon) return;
    fetch(C.openMeteoUrl(S.geo.lat, S.geo.lon)).then(r => r.json()).then(j => { const d = C.parseOpenMeteo(j); if (d) localStorage.setItem(OM_KEY, JSON.stringify({ d, fetchedAt: Date.now(), lat: S.geo.lat, lon: S.geo.lon })); rainUI(); })
      .catch(() => { log('Open-Meteo feed unreachable; using the cached value until it is over 1 h old', 'warn'); rainUI(); });
  }
  function rainNow() {
    const live = $('omFeed') && $('omFeed').checked, c = live ? omCached() : null, wf = $('wetFlag') ? $('wetFlag').value : '';
    const now = live ? Date.now() : tsNow(), feed = live ? (c ? { rain_mmh: c.d.rain_mmh, ts: c.d.ts } : null) : { rain_mmh: [0, 2, 20][S.wx.rain || 0], ts: now };
    const manual = wf === '' ? null : { wet: wf === '1', ts: (live ? LG.flagReal : LG.flagTs) || now };
    const rs = C.rainState({ manual, feed, lastWetTs: LG.lastWet, now }); if (feed && feed.rain_mmh >= 0.5 && !rs.feedStale || manual && manual.wet) LG.lastWet = now;
    return Object.assign(rs, { mmh: feed ? feed.rain_mmh : null, src: live ? 'Open-Meteo' : 'sim weather' });
  }
  function rainUI() { const el = $('rainstat'); if (!el) return; const r = rainNow();
    el.textContent = 'Rain state: ' + r.state + ' (p wet ' + r.pWet.toFixed(2) + ') · feed: ' + r.src + (r.mmh != null ? ' ' + (+r.mmh).toFixed(1) + ' mm/h' : ' none') + (r.feedStale ? ' · feed stale, set the rain flag' : ''); }
  function logSecond(reps) {
    const s = Math.floor(S.t); if (s === LG.lastS) return; LG.lastS = s;
    if (LG.ss.mode === 'ARMED') { const rid = reps.find(r => r.kind === 'rid');
      if (rid) sessEv({ type: 'rid', hash: C.idHash(rid.serial || rid.id) });         // serial stored only as a hash
      else if (F.conf || F.alarmT != null) sessEv({ type: 'track', confirmed: true, pDrone: F.p, id: 1 });
      else sessEv({ type: 'tick' }); }
    const T = S.tog, cl = { T: P.TOD[S.wx.tod].T, RH: S.wx.rain ? 92 : P.TOD[S.wx.tod].RH };
    if (S.t - LG.lastWx >= 10) { LG.lastWx = S.t; const rs = rainNow(), mmh = rs.mmh, now = tsNow();
      logRec({ node: 'HUB', kind: 'wx', t_c: cl.T, rh_pct: cl.RH, p_hpa: 907.5, wind_ms: S.wx.wind, wind_from_deg: S.wx.windFrom, rain_mmh: mmh, rain_state: rs.state, p_wet: rs.pWet, feed_stale: rs.feedStale, sensor_ok: true }); }
    const thr = T.s3 ? 6 : P.HIT_DB;
    for (const n of nodes()) { const cb = n.spec && n.spec.cb;
      logRec({ node: n.id, kind: 'snd', up: !!T.mics, score: cb ? +cb.s.toFixed(2) : 0, f0_hz: cb && cb.hits >= 3 ? +cb.f0.toFixed(1) : null, hits: cb ? cb.hits : 0, snr_db: cb && snr3(cb) != null ? +snr3(cb).toFixed(1) : null, fam: n.nov && n.nov.ladder != null ? +(1 - n.nov.ladder).toFixed(2) : 0, det: !!(n.rep && n.rep.cls === 'drone'), thr }); }
    const fl = S.scen === 'city' ? -86 : S.scen === 'night' ? -96 : -93;
    for (const tw of towers()) { const r = tw.rep;
      logRec({ node: tw.id, kind: 'rf', up: !!T.rf, band: r ? r.band : '2.4', ch_mhz: r && r.band === '5.8' ? 5745 : 2437, bw_mhz: 5, rssi_max_dbm: r ? +r.rssi.toFixed(1) : +(fl + 4 + P.gauss()).toFixed(1), rssi_mean_dbm: r ? +(r.rssi - 6).toFixed(1) : fl + 1, floor_dbm: fl, occ: r ? 0.3 : 0.05, det: !!r }); }
    const c = cam(); logRec({ node: 'CAM', kind: 'cam', up: !!T.thermal, cls: c.rep ? c.rep.cls : 'none', conf: c.rep ? +(+c.rep.conf).toFixed(2) : 0, n_obj: c.rep ? 1 : 0, looks: 2, det: !!(c.rep && c.rep.cls === 'drone'), thr: 0.5 });
    if (LG.sess) LG.sess.secs++;
    if (s % 2 === 0) logUI();
  }
  // session marking follows core.sessionStep (spec g.5): IDLE/ARMED, auto-cancel on Remote ID or a confirmed drone track (p >= 0.5)
  function sessEv(ev) {
    const was = LG.ss.mode; LG.ss = C.sessionStep(LG.ss, Object.assign({ ts: tsNow() }, ev));
    if (was === 'IDLE' && LG.ss.mode === 'ARMED') {
      LG.sess = { id: LG.ss.session, secs: 0 };
      logSys('nd_start', '', { operator: 'operator', planned_h: ev.hours || 4, note: ev.note || '' });
      log('No-drone log: quiet session ' + LG.sess.id + ' armed for ' + (ev.hours || 4) + ' h', 'fus');
    } else if (was === 'ARMED' && LG.ss.mode === 'IDLE') {
      const L = LG.ss.last; LG.sess = null;
      logSys('nd_end', '', { session: L.session, reason: L.reason, trigger_ts: L.triggerTs, exclude_from_ts: L.excludeFromTs, trigger_detail: L.detail });
      if (L.reason === 'rid' || L.reason === 'track') log('No-drone log: quiet session ' + L.session + ' AUTO-CANCELLED — ' + (L.reason === 'rid' ? 'Remote ID heard' : 'confirmed drone track') + '; data from 5 min before is excluded from the false-alarm fit', 'warn');
      else log('No-drone log: quiet session ' + L.session + ' ended (' + L.reason + ')', 'fus');
    }
    logUI();
  }
  const startQuiet = () => sessEv({ type: 'button', hours: 4, note: 'sim' }), stopQuiet = () => sessEv({ type: 'button_stop' });
  function fitFromLog() {
    const recs = C.parseLog(LG.recs.map(r => JSON.stringify(r)).join('\n')).records, out = [];
    for (const kind of ['snd', 'rf', 'cam']) for (const b of C.fitPfa(recs, { kind }).bins) out.push(Object.assign({ kind }, b));
    return out;
  }
  function logUI() {
    const el = $('ndstat'); if (!el) return; const nd = LG.recs.filter(r => typeof r.session === 'string' && r.session.startsWith('nd-') && r.kind === 'snd').length / Math.max(1, nodes().length);
    $('ndBtn').textContent = LG.sess ? '⏹ End quiet session ' + LG.sess.id : '🤫 Mark quiet session';
    el.textContent = LG.recs.length.toLocaleString() + ' records logged' + (LG.sess ? ' · ' + LG.sess.id + ' running, ' + LG.sess.secs + ' s' : '') + ' · ' + Math.round(nd) + ' s certified quiet';
  }
  function showFit() {
    const bins = fitFromLog(), byK = {};
    for (const b of bins) { const k = b.kind + '|' + b.key; (byK[k] = byK[k] || { kind: b.kind, key: b.key, k: 0, n: 0, nEff: 0 }); byK[k].k += b.k; byK[k].n += b.n; byK[k].nEff += b.nEff; }
    const rows = Object.values(byK).map(r => { const pf = (r.k * r.nEff / r.n + 0.5) / (r.nEff + 1), def = C.sensorModel(r.kind, { wx: S.wx, scen: S.scen }).pfa;
      return '<tr><td>' + r.kind + '</td><td>' + r.key + '</td><td>' + Math.round(r.n) + '</td><td>' + Math.round(r.nEff) + '</td><td>' + pf.toFixed(4) + '</td><td>' + def.toFixed(3) + '</td></tr>'; });
    $('ndfit').innerHTML = rows.length ? '<table class="small"><tr><th>sense</th><th>bin</th><th>looks</th><th>n_eff</th><th>fitted Pfa</th><th>default</th></tr>' + rows.join('') + '</table>' : 'No certified quiet records yet — mark a quiet session first.';
    return bins;
  }
  function useFit() {
    const bins = fitFromLog(), t = { v: 1, sensors: {} };
    for (const b of bins) if (b.source === 'fit') { const s = t.sensors[b.kind] = t.sensors[b.kind] || {}; (s[b.node] = s[b.node] || []).push({ key: b.key, pfa: b.pfa, lo: b.lo, hi: b.hi, n: b.n, n_eff: b.nEff, k: b.k, source: 'fit' }); }
    const n = Object.values(t.sensors).reduce((a, s) => a + Object.values(s).reduce((x, r) => x + r.length, 0), 0);
    C.loadPfaTable(n ? t : null); log(n ? 'Fusion now uses ' + n + ' fitted false-alarm rates from the no-drone log' : 'Not enough certified quiet time per bin (need ≥ 1 h effective); using defaults', 'fus');
  }
  function downloadLog() {
    const blob = new Blob([LG.recs.map(r => JSON.stringify(r)).join('\n') + '\n'], { type: 'application/x-ndjson' }), a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'nodrone-' + new Date(tsNow()).toISOString().slice(0, 10).replace(/-/g, '') + '.jsonl'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  // demo helper: a bird-only quiet stretch, run headless, then the fit table
  function recordQuiet(mins) {
    const keep = { kind: S.kind, second: S.second }; S.kind = 'bird'; S.second = ''; reset(); S.objs.forEach(o => o.path = Object.assign({}, o.path, { loop: true })); startQuiet();
    for (let i = 0; i < mins * 60 / EVAL_DT; i++) { S.t += EVAL_DT; moveObjs(); evaluate(); if (!LG.sess) break; }
    stopQuiet(); S.kind = keep.kind; S.second = keep.second; reset(); syncUI(); showFit();
  }
  // ---------- multi-target tracker (quanta spec c, steps 4-5): NCV EKF per track, GNN (Hungarian) association with the
  // pitch-signature cost, M-of-N confirm/delete, one LR blender per track, p_any = 1 - Π(1 - p_k). ENU: x east, y north (= -sim y), z AGL.
  const K = window.SkyTrack, D2R = Math.PI / 180, F0_SIG = 0.015, SCAN = EVAL_DT;
  var TK = { tracks: [], next: 1, scans: 0 }, SB = null;   // var: reset() may run before this line
  const enu = s => [s.x, -s.y, s.h || 0];
  const trkXY = t => ({ x: t.k.x[0], y: -t.k.x[1] });
  function cNow(withSensor) {                                                // speed of sound the hub believes (c.3a): hub T/RH sensor or climatology
    const cl = P.TOD[S.wx.tod], RH = S.wx.rain ? 92 : cl.RH;
    return withSensor ? { c: P.soundSpeed(cl.T + P.gauss() * 0.3, RH, 907.5), sT: 0.6 } : { c: P.soundSpeed(cl.T - 4, null), sT: 4 };
  }
  // measurements this scan: sound bearings (one per node per ladder), RF bearings, RID / thermal positions
  function trackMeas(reps) {
    const M = [], T = S.tog, sEl = a => Math.max(8 * D2R / Math.max(Math.sin(a), 0.2), 8 * D2R);
    for (const n of nodes()) for (const l of n.lads || []) {
      if (l.brg == null) continue; const s = enu(n), el = l.src ? Math.atan2(l.src.h - s[2], Math.hypot(l.src.x - n.x, l.src.y - n.y)) + P.gauss() * 6 * D2R : null;
      M.push({ kind: 'snd', node: n, f0: l.f0, cls: l.cls, src: l.src, rep: l.rep, snr: l.snr, fam: l.fam, z: { type: 'bearing', s, az: l.brg * D2R, el, sAz: 8 * D2R, sEl: el != null ? sEl(el) : null } });
    }
    for (const r of reps) {
      if (r.kind === 'rf' && r.brg != null && !r.fake) M.push({ kind: 'rf', rep: r, z: { type: 'bearing', s: enu(byId(r.id)), az: r.brg * D2R, sAz: 22 * D2R } });
      else if (r.kind === 'rf' && r.fake) M.push({ kind: 'rf', rep: r, z: { type: 'bearing', s: enu(byId(r.id)), az: (r.brg || 0) * D2R, sAz: 22 * D2R } });
      if (r.kind === 'rid' && r.x != null) M.push({ kind: 'rid', rep: r, z: { type: 'pos', z: [r.x, -r.y, r.h != null ? r.h : S.height], R: [[400, 0, 0], [0, 400, 0], [0, 0, 100]] } });
      if (r.kind === 'cam' && r.r != null) { const c = cam(), b = r.brg * D2R, rr = r.r; M.push({ kind: 'cam', rep: r, z: { type: 'pos', z: [c.x + Math.sin(b) * rr, -(c.y - Math.cos(b) * rr), r.obj ? r.obj.h : 60], R: [[900, 0, 0], [0, 900, 0], [0, 0, 900]] } }); }
    }
    return M;
  }
  function newTrack(p, sp, src, f0, t) {
    const k = K.kfInit({ p, v: [0, 0, 0], sp: [sp, sp, 40], sv: 15 }); k.t = S.t;
    return { id: TK.next++, k, f0, hist: [], conf: false, born: S.t, lastHit: S.t, B: C.newBlendState({ lambdaD: 1 / 8 }), p: 0.0067, why: {}, explain: null, by: t };
  }
  function trackScan(reps) {
    const T = S.tog; TK.scans++;
    for (const t of TK.tracks) K.kfPredict(t.k, S.t - t.k.t, 2.0, 0.5), t.k.t = S.t;
    const M = trackMeas(reps), used = new Array(M.length).fill(false), hit = new Map(), evid = new Map();
    const addEv = (t, rep) => { if (!evid.has(t)) evid.set(t, []); evid.get(t).push(rep); };
    // GNN per sensor (each node / tower / camera reports at most one measurement per target): Hungarian over tracks x its measurements
    const groups = new Map(); M.forEach((m, i) => { const key = m.kind + ':' + (m.node ? m.node.id : m.rep ? m.rep.id : '?'); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(i); });
    for (const idx of groups.values()) {
      const tr = TK.tracks; if (!tr.length) break;
      const cost = tr.map(t => idx.map(i => { const m = M[i], g = K.gate(t.k, m.z); if (!g.ok) return 1e12;
        const df = m.f0 && t.f0 ? Math.log(m.f0 / t.f0) / F0_SIG : 0; return g.d2 + df * df; }));
      const a = K.assign(cost, 9.21 + 9);                                   // miss = γ (χ²₂ 0.99) + a 3σ pitch budget; ln det(2πS) cancels between pair and miss
      a.forEach((j, ti) => { if (j < 0) return; const i = idx[j], m = M[i], t = tr[ti]; const u = K.kfUpdate(t.k, m.z); if (!u.ok) return; used[i] = true; hit.set(t, true); t.lastHit = S.t;
        if (m.f0) t.f0 = t.f0 ? t.f0 * 0.8 + m.f0 * 0.2 : m.f0;
        if (m.kind === 'snd') addEv(t, { kind: 'snd', detected: true, cls: m.cls, snr: m.snr, familiarity: m.fam || 0, node: m.node, z: m.z });
        else if (m.kind === 'rf') addEv(t, { kind: 'rf', detected: true, snr: m.rep.rssi != null ? m.rep.rssi - (S.scen === 'city' ? -86 : S.scen === 'night' ? -96 : -93) - 6 : null, band: m.rep.band, tower: m.rep.id });
        else addEv(t, { kind: m.kind, detected: true, cls: m.rep.cls }); });
    }
    // TDOA (c.3b, every node has GPS PPS): pairs of nodes whose ladders this track took, against the strongest one
    if (T.pps) { const cc = cNow(T.temp);
      for (const t of TK.tracks) { const ev = (evid.get(t) || []).filter(e => e.kind === 'snd' && e.node), src = ev.length >= 2 ? ev.map(e => M.find(m => m.node === e.node && m.kind === 'snd' && used[M.indexOf(m)])).find(m => m && m.src) : null;
        if (!src) continue; const o = src.src, ref = ev.slice().sort((a, b) => (b.snr || 0) - (a.snr || 0))[0].node, cTrue = cNow(true).c;
        for (const e of ev) { if (e.node === ref) continue; const s1 = enu(e.node), s2 = enu(ref), op = [o.x, -o.y, o.h], r1 = Math.hypot(...op.map((v, i) => v - s1[i])), r2 = Math.hypot(...op.map((v, i) => v - s2[i]));
          const sT = Math.hypot(60e-6, Math.abs(r1 - r2) * 0.59 * cc.sT / cc.c / cc.c, (S.wx.wind * 0.5) * Math.abs(r1 - r2) / cc.c / cc.c);
          K.kfUpdate(t.k, { type: 'tdoa', s1, s2, tau: (r1 - r2) / cTrue + P.gauss() * 60e-6, sTau: sT, c: cc.c }); } } }
    // initiation from unused sound bearings: 2+ posts, pitch within 2 %, crossing > 20° (c.4); RID / thermal positions start a track directly
    const pool = M.map((m, i) => ({ m, i })).filter(({ m, i }) => !used[i]);
    for (const { m, i } of pool) if (!used[i] && (m.kind === 'rid' || m.kind === 'cam')) { const t = newTrack(m.z.z, m.kind === 'rid' ? 20 : 40, null, null, m.kind); TK.tracks.push(t); used[i] = true; hit.set(t, true); addEv(t, { kind: m.kind, detected: true, cls: m.rep.cls }); }
    const snd = pool.filter(({ m, i }) => !used[i] && m.kind === 'snd' && m.cls === 'drone');
    for (const a of snd) { if (used[a.i]) continue;
      const mates = snd.filter(b => !used[b.i] && b.m.node !== a.m.node && Math.abs(Math.log(b.m.f0 / a.m.f0)) < 0.02);
      const sel = [a]; for (const b of mates) if (!sel.some(x => x.m.node === b.m.node)) sel.push(b); if (sel.length < 2) continue;
      let maxX = 0; for (const x of sel) for (const y of sel) { const d = Math.abs(((x.m.z.az - y.m.z.az) / D2R + 540) % 360 - 180); maxX = Math.max(maxX, Math.min(d, 180 - d)); }
      if (maxX < 20) continue;
      const p = triangulate(sel.map(x => ({ s: x.m.node, b: x.m.z.az / D2R, w: 1 }))); if (!p) continue;
      const t = newTrack([p.x, -p.y, 60], 120, null, a.m.f0, 'sound'); TK.tracks.push(t); hit.set(t, true);
      for (const x of sel) { used[x.i] = true; K.kfUpdate(t.k, x.m.z); addEv(t, { kind: 'snd', detected: true, cls: 'drone', snr: x.m.snr, familiarity: x.m.fam || 0, node: x.m.node }); }
    }
    // M-of-N, deletion, per-track evidence
    const ctx = { dt: SCAN, wx: S.wx, scen: S.scen }, reach = (S.policy.cover && S.policy.cover.snd) || 600, ns = nodes();
    for (const t of TK.tracks) {
      t.hist.push(hit.get(t) ? 1 : 0); if (t.hist.length > 8) t.hist.shift();
      if (!t.conf && t.hist.slice(-5).reduce((a, b) => a + b, 0) >= 3) t.conf = true;
      const ev = (evid.get(t) || []).slice(), xy = trkXY(t);
      // one sound report per track per scan into the blender (n_eff handled by the blender's node cap); miss evidence from posts that should hear it
      if (!ev.some(e => e.kind === 'snd') && T.mics) { const k = ns.filter(n => Math.hypot(n.x - xy.x, n.y - xy.y) < reach).length; if (k) ev.push({ kind: 'snd', detected: false, pd: 0.5 * k / ns.length }); }
      if (vib().rep && Math.hypot(xy.x - vib().x, xy.y - vib().y) < 300) ev.push({ kind: 'vib', detected: true });
      if (T.adsb) for (const e of ev) if (e.kind === 'snd' && e.detected && e.z) { const x = C.adsbExplain({ kind: 'snd', node: e.z.s, az: e.z.az, el: e.z.el, sAz: e.z.sAz, sEl: e.z.sEl, t: S.t, h: t.k.x[2], sH: Math.sqrt(t.k.P[2][2]) }, adsbFeed(), { c: cNow(T.temp).c }); if (x.id) { e.explain = x.factor; t.explain = x; } }
      const o = C.lrBlend(t.B, ev, ctx); t.p = o.p; t.why = o.contrib;
    }
    TK.tracks = TK.tracks.filter(t => { const pos = Math.sqrt(t.k.P[0][0] + t.k.P[1][1]); const h = t.hist.reduce((a, b) => a + b, 0);
      return !((t.hist.length >= 8 && h <= 1) || S.t - t.lastHit > 10 || pos > 300 || !t.conf && S.t - t.born > 4 && h < 2); });
    const conf = TK.tracks.filter(t => t.conf), pAny = 1 - conf.reduce((a, t) => a * (1 - t.p), 1);
    return { pAny, best: conf.slice().sort((a, b) => b.p - a.p)[0] || null };
  }
  // scoreboard (sim truth): how much drone-time a confirmed track covers, its error, false tracks, track swaps
  function scoreScan() {
    if (!SB) return; SB.scans++; const conf = TK.tracks.filter(t => t.conf), inPlay = drones().filter(o => !o.done && o.x > -200 && o.x < W + 200 && o.y > -200 && o.y < W + 200);
    // one-to-one (Hungarian, 150 m): a track that sits between two drones covers only one of them
    const tq = conf.map(trkXY), a = K.assign(inPlay.map(o => tq.map(q => Math.hypot(q.x - o.x, q.y - o.y))), 150);
    if (F.estG) { const o = inPlay.slice().sort((p, q) => Math.hypot(p.x - F.estG.x, p.y - F.estG.y) - Math.hypot(q.x - F.estG.x, q.y - F.estG.y))[0]; if (o && Math.hypot(o.x - F.estG.x, o.y - F.estG.y) < 150) SB.locG++; }
    inPlay.forEach((o, i) => { SB.droneScans++; const j = a[i]; if (j == null || j < 0) return; const best = conf[j], bd = Math.hypot(tq[j].x - o.x, tq[j].y - o.y);
      if (best.p >= ALARM) SB.locT++; SB.covered++; SB.errSum += bd; SB.errN++; const prev = SB.last.get(o); if (prev != null && prev !== best.id) SB.swaps++; SB.last.set(o, best.id); });
    for (const t of conf) { const q = trkXY(t); if (!drones().some(o => Math.hypot(q.x - o.x, q.y - o.y) < 300)) SB.falseScans++; }
    SB.maxConf = Math.max(SB.maxConf || 0, conf.length);
  }
  const trackStats = () => SB && SB.droneScans ? { locTrk: Math.round(100 * SB.locT / SB.droneScans), locOne: Math.round(100 * SB.locG / SB.droneScans), cover: Math.round(100 * SB.covered / SB.droneScans), err: SB.errN ? Math.round(SB.errSum / SB.errN) : null, falseTrackMin: +(SB.falseScans * EVAL_DT / 60).toFixed(2), swaps: SB.swaps, maxConf: SB.maxConf || 0, drones: drones().length } : null;
  // passive ADS-B receive feed (synthetic): crewed aircraft that carry a transponder; S.adsbMissing of them do not
  function adsbFeed() { return S.objs.filter(o => o.adsbOn).map(o => ({ id: o.callsign, x: o.x, y: -o.y, z: o.h, vx: o.vx || 0, vy: -(o.vy || 0), vz: 0, t: S.t })); }
  // which object made the ladder this node found (to point the ring's direction arrow at it)
  function nearestSrc(n, cb) {
    if (!cb || cb.hits < 3) return null; let best = null, be = 1;
    for (const o of S.objs) { const l = o.spec.snd.ladder; if (!l) continue; const ratio = cb.f0 / (l.f0 * o.rpm), k = Math.round(ratio); if (k < 1) continue; const e = Math.abs(ratio - k) / ratio; if (e < 0.05 && e < be) { be = e; best = o; } }
    return best;
  }

  // ---------- fusion brain: log-odds evidence, association by place, single-target track ----------
  // Weights = how much one report of that sense is trusted (log-odds units per 0.5 s at confidence 1).
  // Weights, caps and the log-odds blender are in core.js (SkyCore.blend). RF alone can reach ~85% but not the alarm,
  // unless weather-aware fusion is leaning on radio and 2+ towers agree. Negative evidence: thermal says bird/aircraft.
  const positive = r => r.kind === 'rf' ? true : r.kind === 'snd' ? r.cls === 'drone' : r.kind === 'cam' ? r.cls === 'drone' : true;
  // sim reports -> likelihood-ratio reports (quanta spec a): SNR in, Pd/Pfa from core.sensorModel. Weak sound "miss": while a
  // track exists and no post hears it, posts whose live coverage reaches the track say "looked, heard nothing" (area-mean Pd).
  const snr3 = cb => { const e = (cb.rungs || []).map(r => r.e).sort((a, b) => b - a).slice(0, 3); return e.length ? e.reduce((a, b) => a + b, 0) / e.length : null; };
  function lrReps(reps) {
    const fl = S.scen === 'city' ? -86 : S.scen === 'night' ? -96 : -93, out = [];
    for (const r of reps) {
      if (r.kind === 'snd' && r.cls === 'familiar' && S.famSkip !== false) continue;           // a ladder this place makes every day at this hour: no evidence either way
      if (r.kind === 'snd') { const ex = S.tog.adsb && r.brg != null ? C.adsbExplain({ kind: 'snd', node: enu(byId(r.id)), az: r.brg * D2R, sAz: 8 * D2R, t: S.t }, adsbFeed(), { c: 343 }) : null;
        if (ex && ex.id) { F.adsbN = (F.adsbN || 0) + 1; F.adsbWhy = Object.assign({ t: S.t }, ex); }
        out.push({ kind: 'snd', detected: true, cls: r.cls, snr: r.snr, familiarity: r.novelty != null ? 1 - r.novelty : 0, mismatch: r.mismatch, explain: ex && ex.id ? ex.factor : r.explain }); }
      else if (r.kind === 'rf') out.push({ kind: 'rf', detected: true, snr: r.rssi != null ? r.rssi - fl - 6 : null, band: r.band, tower: r.id, mismatch: r.mismatch });
      else if (r.kind === 'cam') out.push({ kind: 'cam', detected: true, cls: r.cls, explain: r.explain });
      else out.push({ kind: r.kind, detected: true });
    }
    if (F.est && S.tog.mics && !reps.some(r => r.kind === 'snd')) {
      const reach = (S.policy.cover && S.policy.cover.snd) || 600, ns = nodes(), k = ns.filter(n => Math.hypot(n.x - F.est.x, n.y - F.est.y) < reach).length;
      if (k) out.push({ kind: 'snd', detected: false, pd: 0.5 * k / ns.length });
    }
    return out;
  }
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
      let pts = rfs.map(r => { const t = byId(r.id), rg = clamp(P.rfRange(r.rssi, { scen: S.scen }, r.band), 100, 4000), b = r.brg * Math.PI / 180; return { x: t.x + Math.sin(b) * rg, y: t.y - Math.cos(b) * rg, w: r.conf }; });
      if (F.est && F.p > 0.3) pts = pts.filter(p => Math.hypot(p.x - F.est.x, p.y - F.est.y) < F.er * 2 + 900);
      if (pts.length) { const sw = pts.reduce((a, p) => a + p.w, 0); meas = { x: pts.reduce((a, p) => a + p.x * p.w, 0) / sw, y: pts.reduce((a, p) => a + p.y * p.w, 0) / sw, er: rfs.length > 1 ? 450 : 700, by: 'radio towers' }; }
    }
    // evidence: the blender lives in core.js (pure). Geometry checks stay here: does an RF bearing fit the track? do 2+ towers agree?
    for (const r of rfs) if (F.est && F.p > 0.3 && rayDist(byId(r.id), r.brg, F.est) > F.er + 600) r.mismatch = true;
    const okRf = rfs.filter(r => !r.mismatch && !r.fake), rfAgree = okRf.length >= 2 && !!triangulate(okRf.map(r => ({ s: byId(r.id), b: r.brg, w: r.conf })));
    const leg = C.blend(F.Bleg, reps, { dt: EVAL_DT, policy: S.policy, fusion: T.fusion, rfAgree }); F.pLeg = leg.p; // old ad-hoc blender, kept for comparison
    const lr = C.lrBlend(F.LR, lrReps(reps), { dt: EVAL_DT, wx: S.wx, scen: S.scen }); F.pLR = lr.p;
    const out = S.engine === 'legacy' ? leg : { L: lr.L, p: T.fusion === false ? leg.p : lr.p };
    F.B = S.engine === 'legacy' ? F.Bleg : lr.contrib;
    // multi-target tracker (needs ring bearings): one blender per confirmed track, p_any; the global blender stays as a comparison readout
    F.pGlob = lr.p; F.pGlobMax = Math.max(F.pGlobMax || 0, lr.p); F.tr = null;
    if (T.fusion) { F.tr = trackScan(reps); F.pAny = F.tr.pAny; }
    const useTrk = S.tracker && T.fusion && T.ring && S.engine === 'lr';
    // alarm rule: any-drone from the tracks, or the one-blender answer if it is already sure (a single post hearing a far drone makes no track yet)
    if (useTrk) { out.p = Math.max(F.tr.pAny, lr.p); out.L = Math.log(out.p / (1 - out.p)); F.B = F.tr.best ? F.tr.best.why : lr.contrib; }
    F.L = out.L; F.p = out.p;                                               // no fusion: the most confident single sensor (false blips raise alarms)
    if (!T.fusion && reps.some(r => r.fake || (r.kind === 'cam' && r.cls !== 'drone') || (r.kind === 'snd' && r.cls !== 'drone'))) F.falseAlarms++;
    // track
    if (meas) {
      if (!F.est || Math.hypot(meas.x - F.est.x, meas.y - F.est.y) > 1600 && meas.er < F.er) { F.est = { x: meas.x, y: meas.y }; F.er = meas.er; }
      else { const k = clamp(F.er / (F.er + meas.er), 0.15, 0.85); F.est.x += k * (meas.x - F.est.x); F.est.y += k * (meas.y - F.est.y); F.er = Math.max(15, F.er * (1 - k) + meas.er * k * 0.6); }
      F.by = meas.by; F.lastMeasT = S.t;
      F.hist.push({ t: S.t, x: F.est.x, y: F.est.y }); if (F.hist.length > 400) F.hist.shift();
    } else if (F.est) { F.er = Math.min(1500, F.er + 8 * EVAL_DT); if (S.t - F.lastMeasT > 25) F.est = null; }
    F.estG = F.est && F.pGlob >= ALARM ? { x: F.est.x, y: F.est.y } : null;   // one-blender answer: one spot, one confidence
    if (useTrk && F.tr.best) { const b = F.tr.best, e = K.ellipse(b.k, 0.95); F.est = trkXY(b); F.er = Math.max(10, e.a); F.by = 'track T' + b.id; }
    scoreScan();
    // stages + key moments
    const realRf = rfs.filter(r => !r.mismatch && !r.fake);
    if ((realRf.length || rid) && !F.cue) { F.cue = true; log('Fusion: CUE from ' + (rid ? 'Remote ID' : 'radio tower ' + realRf[0].id) + ' → sound posts listen harder, camera told where to look', 'fus'); }
    if ((snd.length >= 2 || rid) && !F.loc && F.est) { F.loc = true; log('Fusion: LOCATED by ' + (F.by || 'sound grid') + ' at ' + llTxt(F.est) + ', ±' + Math.round(F.er) + ' m', 'fus'); }
    if (cm && !F.conf) { F.conf = true; log('Fusion: CONFIRMED by thermal camera at ' + km(cm.r) + ', drone at ' + llTxt(F.est || refObj()), 'fus'); mark('confirm', 'Thermal confirm');
      moment('confirm', cam(), '📷 Camera confirms', 'Fusion told the thermal camera where to look. It turned and sees a warm, drone-shaped dot ' + km(cm.r) + ' away. Now it\'s certain.'); }
    if (F.p >= ALARM && F.alarmT == null) {
      F.alarmT = S.t; mark('alarm', T.fusion ? 'Fusion ≥95%' : 'single-sensor alarm');
      // ground truth check (the sim knows; a real hub doesn't): is a drone anywhere near the guess?
      const ds = drones(), gp = F.est || HUB; F.alarmD = dh(refObj());
      F.alarmFalse = !ds.length || Math.min(...ds.map(o => Math.hypot(o.x - gp.x, o.y - gp.y))) > 1200;
      if (F.alarmFalse) log('⚠ (sim truth) FALSE ALARM: no drone near the guess. Caused by ' + falseCause(reps) + '.', 'warn');
      // place-learning rule: ladders tied to an alarm are never learned as normal
      if (S.learnOn) for (const r of snd) if ((r.novelty == null || r.novelty >= 0.5) && !commonHere(r.f0) && C.quarantine(S.place, r.f0, 'alarm at ' + clock(S.t) + ' ' + dayTxt())) log('Place learning: ' + Math.round(r.f0) + ' Hz ladder is tied to this alarm, so it will never be learned as "normal"', 'fus');
      moment('alarm', HUB, '🚨 Alarm: ' + Math.round(F.p * 100) + '% sure', T.fusion ? 'Several different senses agree, so their "maybes" add up past the 95% line. The response steps start now (see the "What happens next" panel).' : 'Fusion is OFF, so one sensor alone set off the alarm.');
    }
  }
  // all rotor-like ladders in one spectrum (strongest first): find one, notch it out, look again (max 3)
  function ladders(db, thr) {
    const out = []; let d = db;
    for (let i = 0; i < 3; i++) { const cb = P.comb(d, thr); if (cb.hits < 3) break; out.push(cb); d = C.notch(d, [cb.f0], P.BIN_HZ); }
    return out;
  }
  // a pitch that 2+ posts already know as normal at this hour (bells, generator) was a bystander, not the alarm's cause
  function commonHere(f0) { const sl = slotNow(); return nodes().filter(n => C.familiarity(S.place, n.id, sl, f0) >= 0.5).length >= 2; }
  function falseCause(reps) {
    const s = reps.filter(r => r.kind === 'snd' && r.cls === 'drone');
    const srcNear = s.map(r => { const n = byId(r.id); return S.srcs.filter(x => P.SOURCES[x.type].snd).sort((a, b) => Math.hypot(a.x - n.x, a.y - n.y) - Math.hypot(b.x - n.x, b.y - n.y))[0]; }).filter(Boolean);
    if (s.length && srcNear.length) return 'a ' + P.SOURCES[srcNear[0].type].label.toLowerCase() + ' ladder (' + Math.round(s[0].f0) + ' Hz) heard as a drone';
    if (s.length && S.wx.wind >= 6) return 'wind singing in guy wires (' + Math.round(s[0].f0) + ' Hz, 3 rungs)';
    if (s.length) return 'a ladder-like sound (' + Math.round(s[0].f0) + ' Hz)';
    return reps.some(r => r.fake) ? 'clutter / gusts' : 'the evidence mix';
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
  function mark(k, label, who) { if (firsts[k]) return; firsts[k] = { t: S.t, d: dh(refObj()), label, who, ll: llObj(refObj()) }; renderFirsts(); }
  function renderFirsts() {
    const order = ['rf', 'rid', 'snd', 'cam', 'vib', 'alarm', 'confirm'];
    const real = ['rf', 'rid', 'snd', 'cam', 'vib'].filter(k => firsts[k]).sort((a, b) => firsts[a].t - firsts[b].t);
    if (real.length) { const f = firsts[real[0]]; $('first').textContent = 'First detected ' + km(f.d) + ' from the hub by ' + f.label + (f.who ? ' ' + f.who : '') + ' at ' + clock(f.t); }
    $('firsts').innerHTML = order.filter(k => firsts[k]).map(k => '<span>' + firsts[k].label + '</span><span>' + km(firsts[k].d) + ' out · ' + clock(firsts[k].t) + '</span>').join('');
  }

  // ---------- event log ----------
  function clock(t) { const s = Math.floor(S.clock0 + t) % 86400; return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map(v => String(v).padStart(2, '0')).join(':'); }
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
        log('Radio tower ' + r.id + ' (' + llTxt(s) + '): ' + strength(r.conf) + ' ' + r.band + ' GHz blip, ' + P.compass(r.brg) + ' (' + r.rssi.toFixed(0) + ' dBm)' + (r.fake ? ' · WiFi clutter?' : '') + (r.mismatch ? ' · doesn\'t fit track, down-weighted' : ''), r.fake ? 'warn' : 'rf');
        if (!r.fake) { mark('rf', 'radio tower', r.id); moment('rf', s, '📡 Radio hears first', 'Tower ' + r.id + ' picked up a ' + strength(r.conf) + ' ' + r.band + ' GHz signal from the ' + P.compass(r.brg) + ', about ' + km(dh(refObj())) + ' out. Radio travels much farther than sound. It only measures strength, never decodes. One blip = "maybe".'); }
      } else if (r.kind === 'rid') { log('Remote ID @ tower ' + r.id + ': public broadcast received, position ' + Math.round(r.x) + ',' + Math.round(r.y), 'rid'); mark('rid', 'Remote ID @ tower', r.id);
        moment('rid', s, '🆔 Remote ID heard', 'The drone is broadcasting its public "here I am" message. Tower ' + r.id + ' reads its position openly. Drones that switch this off still get caught by the other senses.'); }
      else if (r.kind === 'snd') {
        if (r.cls === 'drone') { log('Sound ' + r.id + ' (' + llTxt(s) + '): rotor ladder f0 ' + Math.round(r.f0) + ' Hz, ' + r.hits + ' rungs' + (r.brg != null ? ', from ' + P.compass(r.brg) : ''), 'snd'); mark('snd', 'sound post', r.id);
          moment('snd', s, '🎙 Sound post ' + r.id + ' hears a ladder', 'A hum at ' + Math.round(r.f0) + ' Hz plus exact multiples (' + r.hits + ' rungs) — the fingerprint of spinning propellers. A jet\'s roar or a bird\'s chirp never makes this neat ladder.'); }
        else if (r.cls === 'familiar') { F.familiar++; const what = srcName(s, r.f0); log('Sound ' + r.id + ': ' + Math.round(r.f0) + ' Hz ladder is NORMAL here at ' + clock(S.t).slice(0, 5) + ' (novelty ' + (r.novelty || 0).toFixed(2) + (what ? ', probably the ' + what : '') + ') → not counted', 'snd');
          moment('familiar', s, '🏠 Normal for this place', 'Post ' + r.id + ' hears a ' + Math.round(r.f0) + ' Hz ladder' + (what ? ' (the ' + what + ')' : '') + ', but it learned that this sound is here most ' + dayTxt() + 's at this hour. Novelty ' + (r.novelty || 0).toFixed(2) + ', so the blender ignores it and keeps listening underneath for anything new.'); }
        else { log('Sound ' + r.id + ': rotor ladder too dense → big slow rotor (helicopter), NOT counted as a drone', 'warn');
          moment('heli', s, '🚁 Not a drone: helicopter', 'Post ' + r.id + ' hears rotor sound, but the rungs are packed too close (extra peaks between them). That means a huge, slow rotor — a helicopter. Fusion ignores it.'); }
      } else if (r.kind === 'cam') {
        if (r.cls === 'drone') { log('Thermal: warm drone-shaped dot in view, ' + km(r.r) + ' ' + P.compass(r.brg), 'cam'); mark('cam', 'thermal camera'); }
        else { log('Thermal (' + llTxt(cam()) + '): warm dot ' + km(r.r) + ' ' + P.compass(r.brg) + ' → ' + (r.cls === 'bird' ? 'flapping, wobbly path: a BIRD' : 'big and fast: an AIRCRAFT') + ', not a drone (lowers confidence)', 'warn');
          moment(r.cls === 'bird' ? 'bird' : 'aircraft', cam(), r.cls === 'bird' ? '🐦 Camera: just a bird' : '✈ Camera: an aircraft', r.cls === 'bird' ? 'The camera sees something warm, but it flaps and wobbles like a bird. That counts AGAINST a drone, so fusion stays calm.' : 'Something big, hot and fast: an aircraft. That counts against a drone.'); }
      } else if (r.kind === 'vib' && r.fake) { log('Vibration: a short shake, probably a wind gust or rain drumming (weak evidence)', 'warn'); }
      else if (r.kind === 'vib') { log('Vibration: roof sensor shaking, something heavy low overhead' + ' @ ' + llTxt(s), 'vib'); mark('vib', 'vibration sensor');
        moment('vib', s, '〰 Roof is shaking', 'A heavy drone is flying very low over the building. Only big, low drones do this.'); }
    }
    lastState = now;
  }

  function srcName(n, f0) { let best = null, bd = 1e9; for (const x of S.srcs) { const sp = P.SOURCES[x.type].snd; if (!sp) continue; const b = sp.ladder ? sp.ladder.f0 : sp.partials.hum, d = Math.hypot(x.x - n.x, x.y - n.y); if (Math.abs(b - f0) / b < 0.06 && d < bd) { bd = d; best = x; } } return best ? P.SOURCES[best.type].label.toLowerCase() : ''; }
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
    if (F.est) EV.points.push({ time: clock(S.t), est_x_m: Math.round(F.est.x), est_y_m: Math.round(F.est.y), ...llObj(F.est), err_m: Math.round(F.er), fusion_conf: +F.p.toFixed(3), per_sense: per });
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
      if (i === 0) log('RESPONSE ① alert sent to phones + siren/light: "' + where + '" · GPS ' + llTxt(est), 'rsp');
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
      scenario: { scene: sceneName(), weather: Object.assign({ summary: wxName() }, S.wx), wind_mps: S.wx.wind, objects: S.objs.map(o => ({ type: OB[o.kind].label, height_m: Math.round(o.h), radio_link: o.radioOn, remote_id: o.ridOn })), route: $('route').selectedOptions[0].text },
      senses_enabled: Object.keys(S.tog).filter(k => S.tog[k]),
      first_detected_by: real.length ? { sense: firsts[real[0]].label + (firsts[real[0]].who ? ' ' + firsts[real[0]].who : ''), time: clock(firsts[real[0]].t), distance_from_hub_m: Math.round(firsts[real[0]].d) } : null,
      first_by_sense: Object.fromEntries(Object.entries(firsts).map(([k, v]) => [k, { time: clock(v.t), distance_from_hub_m: Math.round(v.d), drone_lat_lon: v.ll }])),
      alarm_time: F.alarmT != null ? clock(F.alarmT) : null,
      track: EV.points, event_log: logLines.slice(),
      map: { size_m: W, centre: { name: S.geo.name, lat: S.geo.lat, lon: S.geo.lon }, coords_note: 'local flat-earth patch around the centre; lat/lon approx', hub: { x: HUB.x, y: HUB.y, ...llObj(HUB) }, sensors: sensors.map(s => ({ id: s.id, kind: s.kind, x: Math.round(s.x), y: Math.round(s.y), ...llObj(s) })) }
    };
  }
  function finish() {
    const real = ['rf', 'rid', 'snd', 'cam', 'vib'].filter(k => firsts[k]).sort((a, b) => firsts[a].t - firsts[b].t), el = $('first');
    if (!drones().length) {
      if (F.alarmT == null) { el.textContent = '✅ Correct: no alarm. It was only ' + S.objs.map(o => OB[o.kind].label.toLowerCase()).join(' + ') + '.'; el.className = 'ok'; log('Flight over: no drone, and no alarm. Correct.', 'ok'); }
      else { el.textContent = '❌ False alarm: no drone was flying.'; el.className = 'bad'; log('Flight over: FALSE ALARM (no drone was flying).', 'warn'); }
    } else if (F.alarmFalse) { el.textContent = '❌ False alarm first: the alarm went off before the drone was near, because of ' + falseCause([]).replace('the evidence mix', 'local sounds') + '.'; el.className = 'bad'; log('Flight over: the alarm was a FALSE alarm (raised away from the drone).', 'warn'); }
    else if (real.length) log('Flight over. First detected ' + km(firsts[real[0]].d) + ' out by ' + firsts[real[0]].label + (firsts[real[0]].who ? ' ' + firsts[real[0]].who : '') + (F.alarmT == null ? ', but never reached the alarm line.' : '.'), F.alarmT == null ? 'warn' : 'ok');
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
    const street = S.mapMode === 'street' && !tiles.failed && drawTiles(c, w);
    if (street) { c.fillStyle = '#0b1220a6'; c.fillRect(0, 0, w, w); }  // darken tiles so sensors stay readable
    $('attrib').hidden = !(S.mapMode === 'street' && !tiles.failed);
    c.strokeStyle = street ? '#2a3b5688' : '#18263c'; c.lineWidth = 1;
    for (let m = 1000; m < W; m += 1000) { c.beginPath(); c.moveTo(X(m), 0); c.lineTo(X(m), w); c.moveTo(0, X(m)); c.lineTo(w, X(m)); c.stroke(); }
    c.setLineDash([3, 6]); c.strokeStyle = '#2a3b56'; for (const r of [1000, 2000]) { c.beginPath(); c.arc(X(HUB.x), X(HUB.y), X(r), 0, 7); c.stroke(); } c.setLineDash([]);
    c.fillStyle = '#5d7391'; c.font = (12 * big) + 'px sans-serif'; c.fillText('1 km', X(HUB.x) + 4, X(HUB.y - 1000) + 14); c.fillText('2 km', X(HUB.x) + 4, X(HUB.y - 2000) + 14);
    c.font = 'bold 13px sans-serif'; c.fillText('N ↑', w - 30, 18);
    const v = vib(); c.fillStyle = '#26324a'; c.fillRect(X(v.x) - 10, X(v.y) - 8, 20, 16);
    drawAirports(c, w, big);
    drawHeat(c, w, big);
    drawCoverage(c, w, big);
    drawSources(c, w, big);
    drawWeather(c, w, big);
    // roar footprint of jets / helicopters
    for (const o of S.objs) if (o.spec.snd.roar) { const x = X(o.x), y = X(o.y), R = X(o.kind === 'jet' ? 1500 : 900); const g = c.createRadialGradient(x, y, 2, x, y, R); g.addColorStop(0, '#9aa5b830'); g.addColorStop(1, '#9aa5b800'); c.fillStyle = g; c.beginPath(); c.arc(x, y, R, 0, 7); c.fill(); }
    // main route (faint)
    const rt = S.objs[0].path.pts; c.strokeStyle = '#ff4d4d26'; c.setLineDash([2, 6]); c.beginPath(); rt.forEach((p, i) => i ? c.lineTo(X(p[0]), X(p[1])) : c.moveTo(X(p[0]), X(p[1]))); c.stroke(); c.setLineDash([]);
    const pulse = (Date.now() % 1200) / 1200;
    for (const s of sensors) {
      const x = X(s.x), y = X(s.y);
      if (s.kind === 'node') {
        if (s === S.sel && S.tog.mics && S.tog.dish) { c.fillStyle = '#7fd38c18'; wedge(c, x, y, 34, s.dishAz, 44); }
        if (s.det) { ring(c, x, y, s.cls === 'drone' ? '#7fd38c' : s.cls === 'familiar' ? '#8fb3ff' : '#ffb86b', pulse); if (s.rep && s.rep.brg != null && s.cls === 'drone') ray(c, x, y, s.rep.brg, X(700), '#7fd38c66'); }
        c.fillStyle = S.tog.mics ? (s.det ? (s.cls === 'drone' ? '#a6ffb4' : '#ffb86b') : '#4f8f5a') : '#33465f'; c.beginPath(); c.arc(x, y, s === S.sel ? 6 : 5, 0, 7); c.fill();
        if (s === S.sel) { c.strokeStyle = '#fff'; c.lineWidth = 1.5; c.beginPath(); c.arc(x, y, 9, 0, 7); c.stroke(); c.lineWidth = 1; }
      } else if (s.kind === 'tower') {
        if (s.rep) { ring(c, x, y, s.rep.fake ? '#ff8a8a' : '#b48cff', pulse); c.fillStyle = s.rep.fake ? '#ff8a8a12' : '#b48cff1a'; wedge(c, x, y, X(Math.min(1300, P.rfRange(s.rep.rssi, { scen: S.scen }, s.rep.band))), s.rep.brg, 44); }
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
    // tracks: 95 % ellipses (solid = confirmed, dashed = tentative), id and confidence
    if (S.tog.fusion) for (const t of TK.tracks) { const q = trkXY(t), e = K.ellipse(t.k, 0.95), x = X(q.x), y = X(q.y);
      c.save(); c.translate(x, y); c.rotate(-e.theta); c.setLineDash(t.conf ? [] : [4, 4]); c.strokeStyle = t.p >= ALARM ? '#ff5d5d' : t.conf ? '#7dffb0' : '#7dffb088';
      c.beginPath(); c.ellipse(0, 0, Math.max(4, X(e.a)), Math.max(3, X(e.b)), 0, 0, 7); c.stroke(); c.restore(); c.setLineDash([]);
      if (t.conf) { c.fillStyle = '#7dffb0'; c.font = (11 * big) + 'px sans-serif'; c.fillText('T' + t.id + ' ' + Math.round(t.p * 100) + '%', x + 8, y - 8); } }
    // estimate
    if (F.est && F.p > 0.15 && !(S.tracker && S.tog.ring && S.engine === 'lr')) { const x = X(F.est.x), y = X(F.est.y); c.strokeStyle = '#4fe3ff'; c.fillStyle = '#4fe3ff14'; c.beginPath(); c.arc(x, y, Math.max(7, X(F.er)), 0, 7); c.fill(); c.stroke();
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
        if (o.spec.drone) { c.font = (10 * big) + 'px ui-monospace,monospace'; c.fillStyle = OBJCOL(o) + 'cc'; c.fillText(llTxt(o), x + sz + 4, y + 7); }
      } else {
        const ex = clamp(x, 12, w - 12), ey = clamp(y, 34, w - 12);
        drawIcon(c, o.spec.icon, ex, ey, 9, OBJCOL(o), o.spec.icon === 'bird' ? 0 : o.hd);
        c.fillStyle = OBJCOL(o); c.font = (11 * big) + 'px sans-serif'; const tx = OB[o.kind].label + ' ' + km(dh(o)) + ' out'; c.fillText(tx, clamp(ex - c.measureText(tx).width / 2, 4, w - c.measureText(tx).width - 4), ey + (ey > w / 2 ? -14 : 22));
      }
    }
    if (S.drag) { const x = X(S.drag.x), y = X(S.drag.y), t = S.drag.id + ' · ' + llTxt(S.drag); c.font = '11px ui-monospace,monospace'; const tw = c.measureText(t).width, lx = clamp(x - tw / 2, 4, w - tw - 4);
      c.fillStyle = '#000c'; c.fillRect(lx - 3, y - 30, tw + 6, 15); c.fillStyle = '#fff'; c.fillText(t, lx, y - 19); }
    if (F.alarmT != null && S.t - F.alarmT < 8 && pulse < 0.5) { c.strokeStyle = '#ff4d4d'; c.lineWidth = 5; c.strokeRect(2, 2, w - 4, w - 4); c.lineWidth = 1; }
  }
  function star(c, x, y, r) { c.beginPath(); for (let i = 0; i < 10; i++) { const a = i * Math.PI / 5 - Math.PI / 2, rr = i % 2 ? r * 0.45 : r; c.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr); } c.closePath(); c.fill(); }
  function ring(c, x, y, col, ph) { c.strokeStyle = col; c.globalAlpha = 1 - ph; c.lineWidth = 2.5; c.beginPath(); c.arc(x, y, 8 + ph * 18, 0, 7); c.stroke(); c.globalAlpha = 1; c.lineWidth = 1; }
  function wedge(c, x, y, r, az, fov) { const a = (az - 90) * Math.PI / 180, h = fov / 2 * Math.PI / 180; c.beginPath(); c.moveTo(x, y); c.arc(x, y, r, a - h, a + h); c.closePath(); c.fill(); }
  function ray(c, x, y, b, len, col) { const t = b * Math.PI / 180; c.strokeStyle = col; c.lineWidth = 1.5; c.beginPath(); c.moveTo(x, y); c.lineTo(x + Math.sin(t) * len, y - Math.cos(t) * len); c.stroke(); c.lineWidth = 1; }

  // ---------- OpenStreetMap raster tiles (plain Web-Mercator tile math, no library). Only fetched when Street map is on. ----------
  const tiles = { cache: new Map(), loaded: 0, failed: false, errors: 0 };
  function tileImg(z, x, y) {
    const n = 1 << z; x = ((x % n) + n) % n; if (y < 0 || y >= n) return null;
    const k = z + '/' + x + '/' + y; let im = tiles.cache.get(k);
    if (!im) {
      im = new Image(); im.decoding = 'async';
      im.onload = () => { im.ok = true; tiles.loaded++; };
      im.onerror = () => { im.bad = true; if (++tiles.errors >= 1 && !tiles.loaded) { tiles.failed = true; geoStat('Street map tiles could not load (offline?), showing the plain grid'); } };
      im.src = 'https://tile.openstreetmap.org/' + k + '.png'; tiles.cache.set(k, im);
    }
    return im;
  }
  function drawTiles(c, w) {
    const mppMap = W / w, lat = S.geo.lat * Math.PI / 180, d = Math.min(1.5, window.devicePixelRatio || 1);
    const z = clamp(Math.round(Math.log2(156543.03 * Math.cos(lat) / (mppMap / d))), 3, 18), mppT = 156543.03 * Math.cos(lat) / Math.pow(2, z);
    const q = mppMap / mppT, n = 256 * Math.pow(2, z);                       // q = tile pixels per screen pixel
    const cx = (S.geo.lon + 180) / 360 * n, cy = (1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2 * n;
    const tlx = cx - w / 2 * q, tly = cy - w / 2 * q; let any = false;
    for (let ty = Math.floor(tly / 256); ty <= Math.floor((tly + w * q) / 256); ty++) for (let tx = Math.floor(tlx / 256); tx <= Math.floor((tlx + w * q) / 256); tx++) {
      // politeness + offline: until one tile has loaded, only ask for the centre tile (1 request, not ~16)
      if (!tiles.loaded && !(tx === Math.floor(cx / 256) && ty === Math.floor(cy / 256))) continue;
      const im = tileImg(z, tx, ty); if (im && im.ok) { c.drawImage(im, (tx * 256 - tlx) / q, (ty * 256 - tly) / q, 256 / q + 0.6, 256 / q + 0.6); any = true; }
    }
    return any;
  }
  function drawAirports(c, w, big) {
    for (const a of AIRPORTS) {
      const q = fromLL(a.lat, a.lon), nx = clamp(q.x, 0, W), ny = clamp(q.y, 0, W);
      if (Math.hypot(nx - q.x, ny - q.y) > a.r) continue;                    // zone doesn't reach the 3 km box
      c.fillStyle = '#ff6b3510'; c.strokeStyle = '#ff6b3566'; c.setLineDash([8, 6]); c.lineWidth = 2;
      c.beginPath(); c.arc(X(q.x), X(q.y), X(a.r), 0, 7); c.fill(); c.stroke(); c.setLineDash([]); c.lineWidth = 1;
      const inside = q.x >= 0 && q.x <= W && q.y >= 0 && q.y <= W, lx = inside ? X(q.x) : X(clamp(q.x, 150, W - 150)), ly = Math.min(inside ? X(q.y) : X(clamp(q.y, 260, W - 260)), w - 30 - 13 * big); // keep clear of the OSM credit
      c.font = 'bold ' + (11 * big) + 'px sans-serif'; c.fillStyle = '#ffab85';
      const t1 = '✈ ' + a.name + (inside ? '' : ' ' + km(Math.hypot(q.x - HUB.x, q.y - HUB.y)) + ' ' + P.compass(P.bearing(HUB, q))), t2 = '~' + a.r / 1000 + ' km zone · approx, check Digital Sky';
      for (const [t, dy] of [[t1, 0], [t2, 13 * big]]) { const tw = c.measureText(t).width; c.fillText(t, clamp(lx - tw / 2, 4, w - tw - 4), ly + dy); }
    }
  }
  // note lines at the bottom-right of the map (row 0 = lowest), above the OSM credit
  function mapNote(c, w, text, row, col) {
    c.font = (10.5 * (w > 500 ? 1 : 0.9)) + 'px sans-serif'; const tw = c.measureText(text).width, y = w - 30 - row * 15;
    c.fillStyle = '#0b1220cc'; c.fillRect(w - tw - 10, y - 11, tw + 7, 14); c.fillStyle = col || '#cfe3ff'; c.fillText(text, w - tw - 6, y);
  }
  // 1. live coverage: how far each sense reaches NOW (small quad). Circles ease toward the new size when the weather changes.
  const covC = document.createElement('canvas');
  function drawCoverage(c, w) {
    if (!S.wxAware || !S.policy.cover) return;
    const tg = S.policy.cover, cv = S.cov || (S.cov = Object.assign({}, tg));
    for (const k in tg) cv[k] += (tg[k] - cv[k]) * 0.08;
    const to = ((S.wx.windFrom + 180) % 360) * Math.PI / 180, r = (cv.sndUp + cv.sndDn) / 2, off = (cv.sndDn - cv.sndUp) / 2; // shifted downwind
    if (S.tog.mics) {
      if (covC.width !== map.width) { covC.width = map.width; covC.height = map.height; }
      const k = covC.getContext('2d'); k.setTransform(dpr, 0, 0, dpr, 0, 0); k.clearRect(0, 0, w, w); k.fillStyle = '#7fd38c';
      for (const n of nodes()) { k.beginPath(); k.arc(X(n.x + Math.sin(to) * off), X(n.y - Math.cos(to) * off), Math.max(2, X(r)), 0, 7); k.fill(); }
      c.save(); c.setTransform(1, 0, 0, 1, 0, 0); c.globalAlpha = 0.09; c.drawImage(covC, 0, 0); c.restore();
    }
    c.lineWidth = 1.2; c.setLineDash([4, 5]);
    if (S.tog.rid) { c.strokeStyle = '#ffffff30'; for (const t of towers()) { c.beginPath(); c.arc(X(t.x), X(t.y), X(cv.rid), 0, 7); c.stroke(); } }
    if (S.tog.thermal) { const m = cam(); c.strokeStyle = '#ffb34766'; c.beginPath(); c.arc(X(m.x), X(m.y), X(cv.cam), 0, 7); c.stroke(); }
    c.setLineDash([]); c.lineWidth = 1;
    mapNote(c, w, 'reach now (small quad): sound ' + km(r) + ' · Remote ID ' + km(cv.rid) + ' · thermal ' + km(cv.cam) + ' · radio ' + km(cv.rf24), 0, '#b9f5c9');
  }
  // 2. "Normal noise heat map": what the posts learned is normal at this hour (inverse-distance blend of the 16 posts)
  const heatC = document.createElement('canvas'); heatC.width = heatC.height = 40;
  function drawHeat(c, w) {
    if (!S.heat) return;
    const slot = slotNow(), pts = nodes().map(n => ({ n, L: C.normalLevel(S.place, n.id, slot) })).filter(p => p.L != null);
    if (!pts.length) { mapNote(c, w, 'Normal noise map: nothing learned yet. Tap 🧠 Learning first.', 1, '#ffe48a'); return; }
    const lo = Math.min(...pts.map(p => p.L)), hi = Math.max(lo + 6, ...pts.map(p => p.L)), k = heatC.getContext('2d'), img = k.createImageData(40, 40);
    for (let j = 0; j < 40; j++) for (let i = 0; i < 40; i++) {
      const x = (i + 0.5) * W / 40, y = (j + 0.5) * W / 40; let sw = 0, sv = 0;
      for (const p of pts) { const d2 = (p.n.x - x) ** 2 + (p.n.y - y) ** 2 + 4e4, wt = 1 / d2; sw += wt; sv += wt * p.L; }
      const v = clamp((sv / sw - lo) / (hi - lo), 0, 1), o = (j * 40 + i) * 4;
      img.data[o] = 40 + 215 * v; img.data[o + 1] = 90 + 120 * (1 - Math.abs(v - 0.5) * 2); img.data[o + 2] = 230 * (1 - v); img.data[o + 3] = 150;
    }
    k.putImageData(img, 0, 0); c.save(); c.imageSmoothingEnabled = true; c.globalAlpha = 0.5; c.drawImage(heatC, 0, 0, w, w); c.restore();
    c.font = '10px sans-serif'; c.fillStyle = '#fff';
    for (const p of pts) { const ft = C.familiarTones(S.place, p.n.id, slot, 0.5); if (ft.length) c.fillText('♪ ' + ft.map(t => Math.round(t.f0)).join(', ') + ' Hz', X(p.n.x) - 18, X(p.n.y) + 17); }
    mapNote(c, w, 'Normal noise at ' + C.slotName(slot) + ' (learned): blue quiet → red loud, ' + lo.toFixed(0) + '–' + hi.toFixed(0) + ' dB · ♪ = normal ladders', 1, '#ffe48a');
  }
  const srcOn = (type, h, we) => type === 'temple' ? (h >= 6 && h < 6.34) || (h >= 18 && h < 18.34) : type === 'build' ? !we && ((h >= 9 && h < 13) || (h >= 14 && h < 18)) : P.srcGain(type, h, we) != null;
  function drawSources(c, w, big) {
    const h = hourNow(), pulse = (Date.now() % 1400) / 1400;
    for (const x of S.srcs) {
      const sp = P.SOURCES[x.type], on = srcOn(x.type, h, S.weekend), px = X(x.x), py = X(x.y);
      if (sp.road) { c.strokeStyle = on ? '#c9a46a77' : '#c9a46a33'; c.lineWidth = 7; c.beginPath(); c.moveTo(0, py); c.lineTo(w, py); c.stroke(); c.lineWidth = 1; }
      if (on) ring(c, px, py, '#ffd34d', pulse);
      c.globalAlpha = on ? 1 : 0.5; c.fillStyle = '#0b1220cc'; c.beginPath(); c.arc(px, py, 12, 0, 7); c.fill();
      c.font = (15 * big) + 'px sans-serif'; c.fillText(sp.icon, px - 9, py + 6);
      c.font = (10.5 * big) + 'px sans-serif'; c.fillStyle = '#ffe9a8'; c.fillText(sp.label + (on ? ' · on' : ' · off now'), px + 14, py + 4); c.globalAlpha = 1;
    }
  }
  function drawWeather(c, w, big) {
    const wx = S.wx;
    if (wx.dust) { c.fillStyle = wx.dust === 2 ? '#c8a36a26' : '#c8a36a12'; c.fillRect(0, 0, w, w); }
    if (wx.rain) { c.strokeStyle = '#9ec9ff' + (wx.rain === 2 ? '40' : '22'); c.beginPath(); const n = wx.rain === 2 ? 90 : 35, ph = (Date.now() / 6) % w;
      for (let i = 0; i < n; i++) { const x = (i * 97.3 + ph * 0.3) % w, y = (i * 53.7 + ph) % w; c.moveTo(x, y); c.lineTo(x - 3, y + 9); } c.stroke(); }
    // wind arrow (points where the wind blows TO)
    const ax = 36, ay = w - 82, to = (wx.windFrom + 180) % 360, t = to * Math.PI / 180, L = 9 + Math.min(15, wx.wind * 1.2);
    c.fillStyle = '#0b1220cc'; c.beginPath(); c.arc(ax, ay, 24, 0, 7); c.fill(); c.strokeStyle = '#cfe3ff'; c.lineWidth = 2.5;
    const ex = ax + Math.sin(t) * L, ey = ay - Math.cos(t) * L; c.beginPath(); c.moveTo(ax - Math.sin(t) * L, ay + Math.cos(t) * L); c.lineTo(ex, ey); c.stroke();
    c.beginPath(); c.moveTo(ex, ey); c.lineTo(ex - Math.sin(t - 0.5) * 7, ey + Math.cos(t - 0.5) * 7); c.lineTo(ex - Math.sin(t + 0.5) * 7, ey + Math.cos(t + 0.5) * 7); c.closePath(); c.fillStyle = '#cfe3ff'; c.fill(); c.lineWidth = 1;
    c.font = (11 * big) + 'px sans-serif'; c.fillStyle = '#cfe3ff'; const lab = 'wind ' + wx.wind + ' m/s from ' + P.compass(wx.windFrom) + ' · ' + P.TOD[wx.tod].T + '°C' + (wx.rain ? ' 🌧' : '') + (wx.dust ? ' 🌫' : '');
    const lw = c.measureText(lab).width; c.fillStyle = '#0b1220cc'; c.fillRect(3, ay + 27, lw + 7, 15); c.fillStyle = '#cfe3ff'; c.fillText(lab, 6, ay + 38);
  }
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
    if (sp.fam) { c.strokeStyle = '#8fb3ff'; c.setLineDash([2, 3]); for (const t of sp.fam) for (let k = 1; k * t.f0 < FM; k++) { c.beginPath(); c.moveTo(xx(k * t.f0), 6); c.lineTo(xx(k * t.f0), h - 14); c.stroke(); } c.setLineDash([]); }
    const cb = sp.cb, ok = cb && cb.hits >= 3, dense = ok && cb.dense >= 3;
    if (ok) for (const r of cb.rungs) if (r.f < FM) { c.fillStyle = dense ? (r.hit ? '#ffb86b' : '#ffb86b33') : (r.hit ? '#ffd34d' : '#ffd34d33'); c.fillRect(xx(r.f) - 2, yy(sp.floor[Math.round(r.f / P.BIN_HZ)] || 0), 4, -Math.max(4, r.e / (hi - lo) * (h - 20))); }
    $('spttl').firstChild.textContent = 'Sound at post ' + n.id + (S.selPinned ? ' (pinned)' : '');
    const nv = sp.nov && sp.nov.learned ? ' · novelty ' + (sp.nov.ladder != null ? sp.nov.ladder : sp.nov.loud || 0).toFixed(2) : '';
    $('spinfo').textContent = (ok ? (dense ? 'ladder too dense → helicopter, not a drone' : (n.cls === 'familiar' ? 'normal here: ' : 'drone ladder ') + Math.round(cb.f0) + ' Hz · ' + cb.hits + ' rungs' + (cb.hits < S.policy.sndMinHits ? ' (needs ' + S.policy.sndMinHits + ')' : '')) : 'no ladder' + (S.objs.some(o => o.spec.snd.roar) ? ' (roar only)' : '')) + nv;
  }
  function drawPanel() {
    const p = F.p, st = $('pstate'); $('mfill').style.width = (p * 100).toFixed(1) + '%';
    let cls = '', txt;
    if (p >= ALARM) { cls = 'alarm'; txt = (S.tog.fusion ? 'DRONE ' : 'ALARM ') + Math.round(p * 100) + '%'; } else if (p >= 0.7) { cls = 'likely'; txt = 'Likely ' + Math.round(p * 100) + '%'; } else if (p >= 0.25) { cls = 'maybe'; txt = 'Maybe ' + Math.round(p * 100) + '%'; } else txt = 'Clear ' + Math.round(p * 100) + '%';
    st.className = 'state ' + cls; st.textContent = txt;
    if ($('engp')) { const nm = { snd: 'sound', rf: 'radio', cam: 'camera', rid: 'Remote ID', vib: 'vibration' }, E = S.engine === "lr" && F.B ? F.B : F.LR ? F.LR.E : {};
      const why = Object.keys(E).filter(k => Math.abs(E[k]) > 0.05).map(k => nm[k] + ' ' + (E[k] > 0 ? '+' : '') + E[k].toFixed(1)).join(', ');
      const nT = TK.tracks.filter(t => t.conf).length, bx = (F.tr && F.tr.best && F.tr.best.explain) || (F.adsbWhy && S.t - F.adsbWhy.t < 3 ? F.adsbWhy : null);
      $('engp').textContent = (S.tracker && S.tog.ring && S.engine === 'lr' ? 'tracks ' + nT + ' confirmed, any-drone ' + Math.round((F.pAny || 0) * 100) + '% · ' : '') + 'one-blender ' + Math.round((F.pGlob != null ? F.pGlob : F.pLR) * 100) + '% · old ' + Math.round(F.pLeg * 100) + '%' + (why ? ' · evidence (log-odds): ' + why : '') +
        (bx && bx.id ? ' · sound explained by aircraft ' + bx.id + ', ' + (bx.range / 1000).toFixed(1) + ' km, ' + Math.round(bx.agl) + ' m AGL (×' + bx.factor.toFixed(2) + ')' : ''); }
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
    pickSel(); drawMap(); drawSpec(); drawPanel(); audioUpdate(); placeCallout(); if (now - (frame.g || 0) > 1000) { frame.g = now; renderGps(); }
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
    const n = S.sel, env = envNow(), now = AC.currentTime;
    const tones = S.objs.flatMap(o => P.objectTones(o, env, n).tones).filter(t => t.f > 60).sort((a, b) => b.L - a.L).slice(0, 10);
    const nz = P.noiseParts(300, env, n), noiseDb = P.dbAdd(nz.self, nz.amb, nz.wind, nz.roar, nz.rain), amp = db => Math.min(0.25, Math.pow(10, (db - 60) / 20));
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
    { t: 'Knows the weather and your street', x: '<b>Weather-aware:</b> the hub works out how far each sense reaches right now (faint shaded circles). In rain or wind it trusts the mics less, asks for a cleaner ladder, and leans on radio. A red <b>Blind spot</b> banner says so.<br><b>Learns your place:</b> each sound post learns what is normal at each hour, like the evening generator or temple bells. Those stop counting, but a new sound such as a drone still counts fully. Anything tied to an alarm is never learned, so a drone that comes every night can\'t become "normal".<br><button data-try="dusty">🌪 Dusty windy day</button><button data-try="sixpm">🕕 6 PM generator + temple</button>' },
    { t: 'Your turn', x: 'Try a decoy and see fusion stay calm:<br><button data-try="bird">🐦 Bird only</button><button data-try="heli">🚁 Helicopter + small quad</button><button data-try="fpv">⚡ Silent FPV racer</button><br><b>Weather</b> matters too: rain hiss buries the sound ladder, heat and dust blind the thermal camera, radio barely cares.<br><button data-try="monsoon">🌧 Small quad in monsoon rain</button><button data-try="coldnight">🌙 Clear cold night</button><br>Or pick anything from <b>What\'s flying in?</b> Tap any <b>?</b> for help.' }
  ];
  const tour = { on: false, i: 0, waiting: null };
  function startTour() {
    tour.on = true; tour.i = 0; tour.waiting = null; S.clock0 = 10 * 3600 + 21 * 60; S.weekend = false; S.wx = Object.assign({}, PRESETS.clear.wx, { wind: 3 }); S.preset = null; updateImpact(); S.kind = 'small'; S.second = 'jet'; S.route = 0; S.scen = 'suburb'; S.rid = false; S.radio = true; S.height = 60;
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
    $('tourText').querySelectorAll('[data-try]').forEach(b => b.onclick = () => { endTour(); const k = b.dataset.try; if (k === 'sixpm') { demo6pm(); return; } if (PRESETS[k]) { S.kind = 'small'; S.second = ''; S.height = 60; applyPreset(k); return; } S.kind = k === 'heli' ? 'small' : k; S.second = k === 'heli' ? 'heli' : ''; S.radio = k !== 'fpv'; S.rid = false; S.height = OB[S.kind].h; syncUI(); reset(); S.playing = true; setPlay(); });
  }
  function tourMoment(key) { if (tour.waiting === key) { tour.waiting = null; showTour(); } }
  function endTour() { tour.on = false; tour.waiting = null; $('tour').hidden = true; hideCallout(); setSpeed(8); }

  // ---------- UI ----------
  // ---------- weather UI ----------
  const PRESETS = {
    clear:     { wx: { wind: 2, windFrom: 270, dust: 0, rain: 0, tod: 'mildday' }, scen: 'suburb', t: '☀️ Clear mild day', x: 'The reference day: 27 °C, light breeze, dry. Every "Weather impact" number is compared with this.' },
    coldnight: { wx: { wind: 1, windFrom: 90, dust: 0, rain: 0, tod: 'coldnight' }, scen: 'night', t: '🌙 Clear cold night', x: 'Calm, 15 °C. The ground cools and traps a layer of cold air: sound bends back down and carries much farther. The cold sky also makes warm motors stand out for the thermal camera. Best case for detection.' },
    hot:       { wx: { wind: 4, windFrom: 270, dust: 1, rain: 0, tod: 'hotday' }, scen: 'suburb', t: '🔥 Hot afternoon', x: '38 °C on sun-baked ground: sound bends UP and away, and heat shimmer makes the rotor ladder flicker, so sound range drops. The warm background washes out the thermal camera. Radio barely changes.' },
    monsoon:   { wx: { wind: 7, windFrom: 225, dust: 0, rain: 2, tod: 'mildday' }, scen: 'suburb', t: '🌧 Monsoon rain', x: 'Raindrops drumming on mics and dishes make a hiss that buries the rotor ladder. Rain blurs thermal badly. Radio only loses a little (5.8 GHz more), so radio + Remote ID carry the load. Gusts and drumming can also shake the vibration sensor.' },
    dusty:     { wx: { wind: 11, windFrom: 315, dust: 2, rain: 0, tod: 'hotday' }, scen: 'suburb', t: '🌪 Dusty windy day', x: 'Strong wind roars on the mics and bends sound away upwind. Dust scatters heat so the thermal camera sees much less. Light drones wobble and work their motors harder (a bit louder). Radio does not care about dust.' }
  };
  const WXPT = { id: 'WX', name: 'weather', x: 120, y: 330 };              // where the callout points: the wind badge on the map
  function applyPreset(k) {
    const pr = PRESETS[k]; S.wx = Object.assign({}, pr.wx); S.scen = pr.scen; S.preset = k; syncUI(); reset(); updateImpact();
    const im = P.weatherImpact(envNow()), f = v => (v > 0 ? '+' : '') + v + '%';
    WXPT.x = 36 / scale; WXPT.y = (map.clientWidth - 106) / scale; S.playing = false; setPlay(); const t = S.policy.trust;
    showCallout(WXPT, pr.t, pr.x + ' Estimated vs clear mild day: sound ' + f(im.sound.pct) + ', thermal ' + f(im.thermal.pct) + ', radio ' + f(im.rf24.pct) + '.' + (S.wxAware && k !== 'clear' ? ' Weather-aware fusion now trusts sound ×' + t.snd.toFixed(1) + ' and thermal ×' + t.cam.toFixed(1) + ', and leans on radio. The shaded circles show how far each sense reaches now.' : ''), true);
  }
  function wxChanged(full) { S.preset = null; $('wv').textContent = S.wx.wind + ' m/s'; if (full) syncUI(); updateImpact(); }
  function updatePolicy(im) {
    S.impact = im; const old = S.policy;
    S.policy = C.weatherPolicy(im, S.wx, { on: S.wxAware, micWind: S.wx.wind * (S.tog.height ? 1.25 : 1), ridOn: S.objs.some(o => o.ridOn) });
    const b = $('blind'); b.hidden = !S.policy.banner; b.textContent = S.policy.banner ? '⚠ Blind spot · ' + S.policy.banner : ''; b.classList.toggle('off', !S.wxAware);
    const t = S.policy.trust, txt = S.wxAware ? 'Weather-aware fusion: trust sound ×' + t.snd.toFixed(2) + ', thermal ×' + t.cam.toFixed(2) + ', vibration ×' + t.vib.toFixed(2) + ', radio ×' + t.rf.toFixed(2) + (S.policy.sndMinHits > 3 ? '; posts need 4 rungs (wind makes wires sing)' : '') + (S.policy.vibNeed > 1 ? '; vibration needs 2 shakes' : '') : 'Weather-aware fusion OFF: every sense trusted as on a clear day';
    if (logLines && txt !== updatePolicy.last) { updatePolicy.last = txt; if (old !== C.NEUTRAL || S.wxAware) log(txt, 'fus'); }
    $('wxpol').textContent = txt;
  }
  function updateImpact() {
    const im = P.weatherImpact(envNow()); updatePolicy(im); const row = (name, m, pct, extra) => {
      const cls = pct > 3 ? 'up' : pct < -3 ? 'dn' : 'eq', w = clamp(100 + pct, 0, 200) / 2;
      return '<span>' + name + '</span><div class="bar" title="' + (extra || '') + '"><i style="width:' + w + '%"></i></div><span class="' + cls + '">' + (pct > 0 ? '+' : '') + pct + '%' + (m != null ? ' · ' + km(m) : '') + '</span>';
    };
    $('impact').innerHTML = '<span class="hd">Weather impact: estimated range vs a clear mild day (same scene &amp; sensors). Bar middle = no change.</span>' +
      row('🎙 Sound (small quad)', im.sound.m, im.sound.pct) + '<span class="hd" style="margin-top:-2px">&nbsp;&nbsp;upwind ' + km(im.sound.up) + ' · downwind ' + km(im.sound.dn) + '</span>' +
      row('📡 Radio 2.4 GHz', im.rf24.m, im.rf24.pct) + row('📡 Radio 5.8 GHz', im.rf58.m, im.rf58.pct) + row('🆔 Remote ID', im.rid.m, im.rid.pct) + row('🌡 Thermal (small quad)', im.thermal.m, im.thermal.pct) +
      '<span>〰 Vibration</span><span></span><span class="' + (im.vib.falsePerMin > 0.1 ? 'dn' : 'eq') + '">' + (im.vib.falsePerMin > 0.1 ? '~' + im.vib.falsePerMin.toFixed(1) + ' false shakes/min' : 'no false shakes') + '</span>' +
      (() => { const st = P.droneStrain(OB[S.kind], S.wx); return st.wobble ? '<span class="hd">✈ ' + OB[S.kind].label + ' fights the weather: path wobbles ±' + Math.round(st.wobble) + ' m, motors ~' + st.loud.toFixed(1) + ' dB louder</span>' : ''; })();
    document.querySelectorAll('#presets button').forEach(b => b.classList.toggle('on', b.dataset.p === S.preset));
  }
  // ---------- place learning UI ----------
  const SRC_SPOT = { ac: [850, 950], road: [1500, 2700], temple: [1250, 2000], gen: [1900, 1350], build: [2600, 2350] };
  let srcN = 0;
  function addSource(type, x, y) {
    const sp = SRC_SPOT[type], o = { type, id: type + (++srcN), name: P.SOURCES[type].label, x: x != null ? x : sp[0] + (S.srcs.filter(z => z.type === type).length * 160), y: y != null ? y : sp[1] };
    S.srcs.push(o); renderSrcs(); log('Placed ' + o.name + ' at ' + llTxt(o) + ' (' + P.SOURCES[type].sched + ')', 'fus'); return o;
  }
  function renderSrcs() {
    $('srclist').innerHTML = S.srcs.map((x, i) => '<div><span>' + P.SOURCES[x.type].icon + ' ' + x.name + '</span><span class="muted">' + P.SOURCES[x.type].sched + '</span><button data-i="' + i + '" aria-label="Remove">✕</button></div>').join('');
    $('srclist').querySelectorAll('button').forEach(b => b.onclick = () => { const x = S.srcs.splice(+b.dataset.i, 1)[0]; log('Removed ' + x.name, 'fus'); renderSrcs(); learnStat(); });
    learnStat();
  }
  const srcKey = () => JSON.stringify(S.srcs.map(x => [x.type, Math.round(x.x / 50), Math.round(x.y / 50)]));
  function learnStat(extra) {
    if (!learned()) { $('learnstat').textContent = 'Not learned yet: every sound counts as new. Tap 🧠 Learning to listen to a simulated week first.'; return; }
    const agg = {};
    for (const n of nodes()) for (let h = 0; h < 24; h++) for (const t of C.familiarTones(S.place, n.id, h, 0.6)) { const b = C.toneBin(t.f0), a = agg[b] || (agg[b] = { f0: t.f0, nodes: new Set(), hours: new Set() }); a.nodes.add(n.id); a.hours.add(h); }
    const list = Object.values(agg).sort((a, b) => b.nodes.size - a.nodes.size).slice(0, 4).map(a => Math.round(a.f0) + ' Hz at ' + a.nodes.size + ' posts (' + [...a.hours].sort((x, y) => x - y).map(h => h + 'h').slice(0, 4).join(' ') + ')');
    const q = S.place.quar.map(z => Math.round(z.f0) + ' Hz (' + z.why + ')');
    $('learnstat').textContent = 'Learned ' + (S.learnedDays || 7) + ' days, 16 posts, 48 hour-slots. Normal ladders: ' + (list.join('; ') || 'none') + '. Never learned (tied to an alarm): ' + (q.join('; ') || 'none') + '.' + (extra || S.learnNote || '') + (S.srcsAtLearn !== srcKey() ? ' ⚠ Noise sources changed since learning: run it again, or let it drift in over days.' : '');
  }
  // Fast-forward a simulated week (every 10 min, all 16 posts) through the real physics: builds each post's normal.
  // Nightly test drone (optional): hovers between N6 and N7 at 23:30-23:50. The live hub would alarm on it (new ladder at
  // 2+ posts + radio), and the rule keeps it out of "normal". With the rule off (test API only) it teaches itself in.
  function learnWeek(opts) {
    opts = opts || {};
    return new Promise(res => {
      const place = C.newPlace(), STEP = 600, total = 7 * 86400 / STEP, ns = nodes(), bufs = ns.map(() => new Float32Array(P.NB)), protect = opts.protect != null ? opts.protect : S.protect;
      const nightly = opts.nightly != null ? opts.nightly : S.nightly, drone = { kind: 'small', spec: OB.small, x: 1500, y: 1250, h: 60, rpm: 1, loud: 0, phase: 0 }, nights = [];
      let i = 0; $('learnBtn').disabled = true; $('learnprog').hidden = false; const T = Object.assign({}, S.tog), thr = T.s3 ? 6 : P.HIT_DB;
      for (const n of ns) n.h = T.height ? 8 : 1.5;
      function chunk() {
        const t0 = performance.now();
        while (i < total && performance.now() - t0 < 30) {
          const ts = i * STEP, day = Math.floor(ts / 86400), hour = (ts % 86400) / 3600, we = day >= 5, slot = C.slotOf(hour, we), night = hour >= 22 || hour < 6;
          const visit = nightly && hour >= 23.5 && hour < 23.84; drone.rpm = 1 + 0.03 * Math.sin(i);
          const env = Object.assign({ scen: night ? 'night' : (S.scen === 'city' ? 'city' : 'suburb'), wx: { wind: 2, windFrom: 270, dust: 0, rain: 0, tod: night ? 'mildnight' : 'mildday' }, tog: T, objs: visit ? [drone] : [] }, P.activeSources(S.srcs, hour, we));
          const obs = ns.map((n, k) => { const sp = P.synth(env, n, bufs[k]), l = ladders(sp.db, thr); return { n, bands: C.bandsOf(sp.db, P.BIN_HZ), f0s: l.map(x => x.f0) }; });
          let alarm = false;
          if (visit) {
            const nov = obs.map(o => ({ o, f: o.f0s.find(f => Math.abs(f / OB.small.snd.ladder.f0 - 1) < 0.08) })).filter(x => x.f && C.novelty(place, x.o.n.id, slot, { f0: x.f }).ladder >= 0.5);
            alarm = nov.length >= 2; nights[day] = nights[day] || alarm;
            if (alarm && protect) for (const x of nov) C.quarantine(place, x.f, 'test drone alarm, night ' + (day + 1));
          }
          for (const o of obs) C.learn(place, o.n.id, slot, day, o, { alarmActive: alarm, protect });
          i++;
        }
        $('learnprog').firstChild.style.width = (100 * i / total).toFixed(1) + '%';
        const d = Math.min(6, Math.floor(i * STEP / 86400));
        $('learnstat').textContent = 'Listening… day ' + (d + 1) + '/7 (' + ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][d] + ') ' + String(Math.floor((i * STEP % 86400) / 3600)).padStart(2, '0') + ':00';
        if (i < total) { setTimeout(chunk, 0); return; }
        S.place = place; S.learnedDays = 7; S.srcsAtLearn = srcKey(); $('learnBtn').disabled = false; $('learnprog').hidden = true;
        const nA = nights.filter(Boolean).length;
        S.learnNote = nightly ? ' Test drone at 23:30: alarm on ' + nA + ' of 7 nights' + (protect ? ' (the never-learn-alarms rule kept it new every night).' : ' (rule OFF: it taught itself in).') : '';
        learnStat(); log('Place learning: listened to a simulated week (' + place.samples + ' samples).' + S.learnNote, 'fus');
        res({ samples: place.samples, nightsAlarmed: nA, nights: nights.map(Boolean), quarantine: place.quar.map(q => Math.round(q.f0)) });
        if (!opts.quiet) { let best = null, bn = 0; for (const n of ns) { const k = C.familiarTones(place, n.id, 18, 0.5).length + C.familiarTones(place, n.id, slotNow(), 0.5).length; if (k > bn) { bn = k; best = n; } }
          S.playing = false; setPlay(); showCallout(best || HUB, '🏠 Learned your place', 'Each post now knows what is normal at each hour: ' + (bn ? 'e.g. post ' + best.id + ' hears a steady ladder most evenings (a generator or bells), so it stops counting. ' : 'nothing ladder-like is regular here. ') + 'A new sound, like a drone, still counts fully. Sounds tied to an alarm are never learned.' + (nightly ? ' The test drone that came every night at 23:30 set off the alarm ' + nA + '/7 nights.' : ''), true); }
      }
      chunk();
    });
  }
  function demo6pm() {
    S.srcs = []; addSource('gen'); addSource('temple'); addSource('ac');
    S.clock0 = 18 * 3600 + 120; S.weekend = false; S.kind = 'small'; S.second = ''; S.rid = false; S.radio = true; S.route = 0; S.height = 60;
    S.wx = Object.assign({}, PRESETS.clear.wx); S.scen = 'suburb'; S.preset = null; syncUI(); reset(); updateImpact();
    S.playing = false; setPlay();
    showCallout(S.srcs[0], '🕕 6 PM: generator + temple bells', 'The evening power cut starts a generator, and the temple rings its bells. Both make neat sound ladders, just like a drone. A small quad (Remote ID off) will fly past. Place learning is ' + (S.learnOn ? 'ON' : 'OFF') + '. ' + (S.learnOn && (!learned() || S.srcsAtLearn !== srcKey()) ? 'Tap 🧠 Learning first so the posts learn these sounds, then Restart.' : 'Compare with learning ' + (S.learnOn ? 'OFF' : 'ON') + '.'), true);
  }
  // headless helpers for tests: run the flight to the end without drawing, and summarise
  function summary() {
    return { alarm: F.alarmT != null, alarmFalse: F.alarmFalse, alarmDist: F.alarmD != null ? Math.round(F.alarmD) : null, firsts: Object.fromEntries(Object.entries(firsts).map(([k, v]) => [k, Math.round(v.d)])),
      falseSnd: F.falseSnd, fakeVib: F.fakeVib, familiar: F.familiar, track: trackStats(), adsbExplained: F.adsbN || 0, pGlobMax: F.pGlobMax, rejected: nodes().reduce((a, n) => a + (n.rejected || 0), 0) };
  }
  function runToEnd(max) { S.pauseAt = false; hideCallout(); for (const n of nodes()) n.rejected = 0; let k = 0; while (!S.done && k++ < (max || 3000)) { S.t += EVAL_DT; moveObjs(); if (S.done) break; evaluate(); } return summary(); }
  // ---------- location UI ----------
  let geoBusy = false;
  function geoStat(msg) { $('geostat').textContent = msg || (S.geo.name + ' · ' + llTxt(HUB) + (S.mapMode === 'street' ? (tiles.failed ? ' · street map unavailable, plain grid' : ' · street map from OpenStreetMap') : '')); }
  function setGeo(lat, lon, name) { S.geo = { lat, lon, name }; geoStat(); log('Map centre moved to ' + name + ' (' + llTxt(HUB) + '). Sensors keep their layout in metres.', 'fus'); renderGps(); }
  function renderGps() {
    const det = $('gpslist').parentElement; if (!det.open) return;
    const rows = sensors.map(s => [s.id + ' ' + (s.kind === 'node' ? 'sound' : s.kind), s]).concat(S.objs.map(o => [OB[o.kind].label, o]));
    if (F && F.est) rows.push(['fusion guess', F.est]);
    $('gpslist').innerHTML = rows.map(([n, p]) => '<div><span>' + n + '</span><span>' + llTxt(p) + '</span></div>').join('');
  }
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
      b.onclick = () => { S.tog[k] = !S.tog[k]; b.className = S.tog[k] ? 'on' : ''; updateImpact(); log((S.tog[k] ? 'ON: ' : 'OFF: ') + label.replace(/^\S+ /, ''), 'fus'); }; box.appendChild(b); }
  }
  function syncUI() {
    document.querySelectorAll('#engSeg button').forEach(b => b.classList.toggle('on', b.dataset.v === S.engine));
    if ($('fleetN')) { $('fleetN').value = S.count; $('fleetF').value = S.formation; $('trkOn').checked = S.tracker; $('adsbMiss').value = S.adsbMissing; }
    document.querySelectorAll('#picker button').forEach(b => b.classList.toggle('on', b.dataset.k === S.kind));
    $('second').value = S.second; $('route').value = S.route; $('scen').value = S.scen; $('height').value = S.height; $('hv').textContent = S.height + ' m';
    $('wind').value = S.wx.wind; $('wv').textContent = S.wx.wind + ' m/s'; $('wdir').value = S.wx.windFrom; $('dust').value = S.wx.dust; $('rain').value = S.wx.rain; $('tod').value = S.wx.tod;
    $('rid').checked = S.rid; $('radio').checked = S.radio; const dr = OB[S.kind].drone; $('rid').disabled = !dr; $('radio').disabled = !dr;
    document.querySelectorAll('#toggles button').forEach(b => b.className = S.tog[b.dataset.k] ? 'on' : '');
    $('clk').value = String(S.clock0); $('day').value = S.weekend ? '1' : '0'; $('heat').checked = S.heat; $('nightly').checked = S.nightly;
    document.querySelectorAll('#awareSeg button').forEach(b => b.classList.toggle('on', (b.dataset.v === '1') === S.wxAware));
    document.querySelectorAll('#learnSeg button').forEach(b => b.classList.toggle('on', (b.dataset.v === '1') === S.learnOn));
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
    const restartOn = () => { S.second = $('second').value; S.route = +$('route').value; if (S.scen !== $('scen').value) { S.scen = $('scen').value; const night = S.scen === 'night'; if (night !== P.TOD[S.wx.tod].night) S.wx.tod = night ? 'mildnight' : 'mildday'; updateImpact(); } S.rid = $('rid').checked; S.radio = $('radio').checked; if (S.second === S.kind) S.second = ''; syncUI(); reset(); S.playing = true; setPlay(); };
    ['second', 'route', 'scen', 'rid', 'radio'].forEach(id => $(id).onchange = restartOn);
    $('height').oninput = e => { S.height = +e.target.value; $('hv').textContent = S.height + ' m'; };
    // weather (live) + presets
    $('wind').oninput = e => { S.wx.wind = +e.target.value; wxChanged(); };
    ['wdir', 'dust', 'rain'].forEach(id => $(id).onchange = e => { S.wx[{ wdir: 'windFrom', dust: 'dust', rain: 'rain' }[id]] = +e.target.value; wxChanged(true); });
    $('tod').onchange = e => { S.wx.tod = e.target.value; const night = P.TOD[S.wx.tod].night; if (night !== (S.scen === 'night')) { S.scen = night ? 'night' : 'suburb'; } wxChanged(true); };
    document.querySelectorAll('#presets button').forEach(b => b.onclick = () => applyPreset(b.dataset.p));
    // 1. weather-aware fusion on/off (live)   2. place learning
    document.querySelectorAll('#awareSeg button').forEach(b => b.onclick = () => { S.wxAware = b.dataset.v === '1'; S.cov = null; syncUI(); updateImpact(); });
    document.querySelectorAll('#engSeg button').forEach(b => b.onclick = () => { S.engine = b.dataset.v; syncUI(); log('Fusion engine: ' + (S.engine === 'lr' ? 'Pd/Pfa evidence (new)' : 'hand-set weights (old)'), 'fus'); });
    $('ndBtn').onclick = () => LG.ss.mode === 'ARMED' ? stopQuiet() : startQuiet();
    $('ndRec').onclick = () => { S.playing = false; setPlay(); recordQuiet(10); };
    $('ndFit').onclick = () => showFit();
    $('ndUse').onclick = () => useFit();
    $('ndDl').onclick = () => downloadLog();
    $('fleetN').onchange = $('fleetF').onchange = () => { S.count = +$('fleetN').value; S.formation = $('fleetF').value; log('Drones: ' + S.count + (S.count > 1 ? ' (' + S.formation + ')' : ''), 'fus'); reset(); S.playing = true; setPlay(); };
    $('trkOn').onchange = () => { S.tracker = $('trkOn').checked; syncUI(); };
    $('adsbMiss').onchange = () => { S.adsbMissing = +$('adsbMiss').value; reset(); S.playing = true; setPlay(); };
    $('swarmBtn').onclick = () => { S.kind = 'small'; S.count = 20; S.formation = 'swarm'; S.second = ''; S.rid = false; syncUI(); reset(); S.playing = true; setPlay(); log('Swarm: 20 small quads in a 5 x 4 formation, 30 m apart', 'fus'); };
    $('omFeed').onchange = () => { omPoll(true); rainUI(); }; $('wetFlag').onchange = () => { LG.flagTs = tsNow(); LG.flagReal = Date.now(); logSys('wet_flag', '', { wet: $('wetFlag').value === '1' }); rainUI(); };
    setInterval(() => { omPoll(false); rainUI(); }, 60000); rainUI();
    document.querySelectorAll('#learnSeg button').forEach(b => b.onclick = () => { S.learnOn = b.dataset.v === '1'; syncUI(); log('Place learning ' + (S.learnOn ? 'ON' : 'OFF'), 'fus'); reset(); S.playing = true; setPlay(); });
    $('clk').onchange = e => { S.clock0 = +e.target.value; reset(); S.playing = true; setPlay(); };
    $('day').onchange = e => { S.weekend = e.target.value === '1'; reset(); S.playing = true; setPlay(); };
    document.querySelectorAll('#srcadd button').forEach(b => b.onclick = () => addSource(b.dataset.s));
    $('learnBtn').onclick = () => learnWeek();
    $('heat').onchange = e => S.heat = e.target.checked;
    $('nightly').onchange = e => S.nightly = e.target.checked;
    $('try6pm').onclick = demo6pm;
    // map + location
    document.querySelectorAll('#mapSeg button').forEach(b => b.onclick = () => { S.mapMode = b.dataset.v; if (S.mapMode === 'street') { tiles.failed = false; tiles.errors = 0; }
      document.querySelectorAll('#mapSeg button').forEach(x => x.classList.toggle('on', x === b)); geoStat(); });
    $('geoform').onsubmit = e => { e.preventDefault(); const q = $('geoq').value.trim(); if (!q || geoBusy) return; geoBusy = true; $('geogo').disabled = true; geoStat('Searching OpenStreetMap for "' + q + '"…');
      fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' + encodeURIComponent(q), { headers: { 'Accept-Language': 'en' } })
        .then(r => r.ok ? r.json() : Promise.reject(r.status)).then(j => { if (!j.length) { geoStat('No place found for "' + q + '"'); return; } setGeo(+j[0].lat, +j[0].lon, j[0].display_name.split(',').slice(0, 2).join(',')); })
        .catch(() => geoStat('Search failed (offline?). Map centre unchanged.')).finally(() => { geoBusy = false; $('geogo').disabled = false; }); };
    $('geome').onclick = () => { if (!navigator.geolocation) { geoStat('This browser has no location access'); return; } geoStat('Asking the browser for your location…');
      navigator.geolocation.getCurrentPosition(p => setGeo(p.coords.latitude, p.coords.longitude, 'My location (±' + Math.round(p.coords.accuracy) + ' m)'), err => geoStat('Location not available: ' + err.message), { timeout: 10000, maximumAge: 60000 }); };
    $('tourBtn').onclick = startTour;
    $('tourNext').onclick = () => { if (tour.i >= TOUR.length - 1) { endTour(); return; } tour.i++; showTour(); };
    $('tourBack').onclick = () => { if (tour.i > 0) { tour.i--; tour.waiting = null; const st = TOUR[tour.i]; $('tourStep').textContent = 'HOW IT WORKS · ' + (tour.i + 1) + ' / ' + TOUR.length; $('tourTitle').textContent = st.t; $('tourText').innerHTML = st.x; $('tourNext').disabled = false; $('tourBack').disabled = tour.i === 0; $('tourNext').textContent = 'Next ▶'; S.playing = false; setPlay(); } };
    $('tourClose').onclick = endTour;
    // drag sensors / tap posts
    let drag = null, moved = false;
    const pos = e => { const r = map.getBoundingClientRect(); return { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale }; };
    map.addEventListener('pointerdown', e => { const p = pos(e); let best = null, bd = 24 / scale; for (const s of sensors.concat(S.srcs)) { const d = Math.hypot(s.x - p.x, s.y - p.y); if (d < bd) { bd = d; best = s; } }
      if (best) { drag = best; S.drag = best; moved = false; map.setPointerCapture(e.pointerId); e.preventDefault(); } });
    map.addEventListener('pointermove', e => { if (!drag) return; const p = pos(e); moved = true; drag.x = clamp(p.x, 0, W); drag.y = clamp(p.y, 0, W); if (drag.kind === 'node' || drag.kind === 'hub') aimDishes(); });
    const up = () => { if (drag && moved) { log('Moved ' + drag.name + ' to ' + llTxt(drag), 'fus'); if (!drag.kind) learnStat(); } S.drag = null; if (drag && !moved && drag.kind === 'node') { if (S.sel === drag && S.selPinned) S.selPinned = false; else { S.sel = drag; S.selPinned = true; } } drag = null; };
    map.addEventListener('pointerup', up); map.addEventListener('pointercancel', up);
    window.addEventListener('resize', resize);
  }

  buildLayout(); buildPicker(); buildLegend(); buildToggles(); buildHelp(); bind(); syncUI(); resize(); reset(); updateImpact(); geoStat(); renderSrcs();
  window.SkyFuse = { learnWeek, demo6pm, addSource, runToEnd, summary, policy: () => S.policy, place: () => S.place, applyPreset, setGeo, toLL, fromLL, tiles, updateImpact, S, F: () => F, firsts: () => firsts, moments: () => moments, tour, evidenceReport, reset, startTour, syncUI, setSpeed };
  requestAnimationFrame(frame);
})();
