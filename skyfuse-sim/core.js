// SkyFuse core: the hub's decision logic, kept apart from the simulator so it can later run on the real hub.
// Pure functions only: no DOM, no drawing, no clock, no randomness. Inputs are sensor reports plus a description of the
// world (weather impact on each sense, time-of-day slot); outputs are scores and decisions. sim.js calls these.
(function (g) {
  'use strict';
  const clamp = (x, a, b) => x < a ? a : x > b ? b : x;

  // ===================== 1. Evidence blender (log-odds) =====================
  // WEIGHT = how much a sense is trusted: log-odds per RATE_S seconds of continuous reporting at confidence 1. Evidence is
  // added per unit time (w * dt / RATE_S), not per report, so the result doesn't depend on how often the hub evaluates.
  // CAP = most a sense can add on its own. RF alone tops out at ~85% (a radio blip can't tell a drone from a WiFi camera).
  const WEIGHT = { rid: 3, cam: 2.5, snd: 0.6, rf: 0.55, vib: 1.5 };
  const CAP = { rid: 12, cam: 12, snd: 9, rf: 6.7, vib: 6 };
  const PRIOR = -5, ALARM = 0.95, MEMORY_S = 8, RATE_S = 0.5;                // evidence fades with an 8 s time constant
  const NEUTRAL = { on: false, trust: { snd: 1, cam: 1, rf: 1, rid: 1, vib: 1 }, sndMinHits: 3, vibNeed: 1, rfCapBoost: 0 };

  // B: evidence buckets per sense (mutated). reps: this step's reports {kind, conf, cls?, novelty?, mismatch?}.
  // ctx: { dt, policy (weatherPolicy), fusion (false = any single sensor alarms), rfAgree (2+ towers' bearings cross) }
  function blend(B, reps, ctx) {
    const pol = ctx.policy || NEUTRAL, tr = pol.trust;
    for (const k in B) B[k] *= Math.exp(-ctx.dt / MEMORY_S);
    let nS = 0;
    for (const r of reps) {
      if (r.kind === 'snd' && r.cls !== 'drone') continue;                       // helicopter / familiar sound: no drone evidence
      if (r.kind === 'cam' && r.cls !== 'drone') { B.cam = Math.max(-4, (B.cam || 0) - 1.5 * r.conf * tr.cam * (ctx.dt / RATE_S)); continue; } // bird / aircraft
      if (r.kind === 'snd' && ++nS > 4) continue;                                 // at most 4 posts per step (one drone ≈ a few posts)
      let w = WEIGHT[r.kind] * r.conf * tr[r.kind] * (r.novelty == null ? 1 : r.novelty) * (ctx.dt / RATE_S);
      if (r.mismatch) w *= 0.15;                                                  // points somewhere else than the track
      const cap = CAP[r.kind] + (r.kind === 'rf' && ctx.rfAgree ? pol.rfCapBoost : 0);
      B[r.kind] = Math.min(cap, (B[r.kind] || 0) + w);
    }
    const L = PRIOR + Object.values(B).reduce((a, b) => a + b, 0);
    const p = ctx.fusion === false ? reps.reduce((a, r) => Math.max(a, r.conf), 0) : 1 / (1 + Math.exp(-L));
    return { L, p, alarm: p >= ALARM };
  }

  // ===================== 1b. Likelihood-ratio blender with a two-state Markov target (quanta-engine-spec §a) =====================
  // Each report says "detected" (ln Pd/Pfa) or "looked and heard nothing" (ln (1-Pd)/(1-Pfa)), scaled by dt/tc (tc = time
  // after which a new look is independent). Between steps p relaxes to the prior pi exactly: p = pi + (p - pi)·e^(-kappa·dt).
  // All Pd/Pfa numbers marked [approx] in the spec are placeholders to be refit from logged no-drone hours.
  const PH = () => g.SkyPhys || null;                                         // physics models, when loaded (browser or node)
  const logit = p => Math.log(p / (1 - p)), sig = x => 1 / (1 + Math.exp(-x));
  function Phi(x) { const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2), y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x / 2); return x >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y); }
  // channel constants (spec a.3 table). lmax = today's CAP so saturation behaves the same.
  const CH = { snd: { tc: 1.0, pfa: 0.05, lmax: 9, lmin: -3 }, rf: { tc: 1.0, pfa: 0.10, lmax: 6.7, lmin: -2 }, cam: { tc: 0.5, pfa: 0.02, lmax: 12, lmin: -4 },
               rid: { tc: 1.0, pfa: 1e-5, lmax: 12, lmin: -0.5 }, vib: { tc: 1.5, pfa: 0.05, lmax: 6, lmin: -1 } };
  const RF_PFA = { suburb: 0.10, city: 0.25, night: 0.05 };
  // camera confusion matrix P(reported class | true class) and confuser mixture (spec a.3) [approx]
  const CAM_CM = { drone: { drone: 0.85, bird: 0.10, aircraft: 0.03, unknown: 0.02 }, bird: { drone: 0.10, bird: 0.85, aircraft: 0.02, unknown: 0.03 },
                   aircraft: { drone: 0.02, bird: 0.03, aircraft: 0.90, unknown: 0.05 }, clutter: { drone: 0.02, bird: 0.05, aircraft: 0.02, unknown: 0.91 } };
  const CAM_W = { bird: 0.7, aircraft: 0.1, clutter: 0.2 }, RHO_SND = 0.3, ALARM_HOLD = 1.0;
  // q = { snr?, range? (m), wx, scen, familiarity?, band?, pd? (caller-predicted Pd overrides the model) }
  function sensorModel(kind, q) {
    q = q || {}; const k = CH[kind], wx = q.wx || {}, P = PH(); let pd, pfa = k.pfa;
    if (kind === 'snd') {
      const eta = P ? P.HIT_DB : 9, ts = P && q.wx ? P.turbSigma(q.wx) : 0, sd = Math.sqrt(ts * ts + 9);
      pd = q.snr != null ? Phi((q.snr - eta) / sd) : 0.7;
      pfa *= 1 + 0.15 * Math.max(0, (wx.wind || 0) - 5); if (wx.rain === 2) pfa *= 2;
      if (q.familiarity) pfa = pfa + q.familiarity * (1 - pfa) * 0.8;          // a familiar ladder carries almost no evidence
    } else if (kind === 'rf') {
      pfa = RF_PFA[q.scen] || RF_PFA.suburb;                                    // no weather term: discriminability is weather-invariant (a.5)
      if (q.snr != null) pd = Phi(q.snr / 4);
      else if (q.range != null) {                                               // EIRP unknown: average over 10..30 dBm (a.2)
        const ghz = q.band === '5.8' ? 5.8 : 2.44, dkm = Math.max(q.range, 10) / 1000, fl = q.scen === 'city' ? -86 : q.scen === 'night' ? -96 : -93, cl = q.scen === 'city' ? 6 : 2;
        const rain = P && q.wx ? P.rainAtt(q.wx, ghz > 5 ? 5.8 : 2.4, dkm) : 0, fs = 20 * Math.log10(dkm) + 20 * Math.log10(ghz * 1000) + 32.44;
        let s = 0, n = 0; for (let e = 10; e <= 30; e += 2) { s += Phi((e + 8 - fs - cl - rain - fl - 6) / 4); n++; } pd = s / n;
      } else pd = 0.5;
    } else if (kind === 'cam') {
      pd = q.snr != null ? Phi((q.snr - 10) / 3) : 0.7;                         // SNR = 20log10(ΔT_app/NETD) [approx]
      if (wx.rain || wx.dust) pfa *= 1.5;
    } else if (kind === 'rid') pd = q.range != null && q.maxRange != null && q.range > q.maxRange ? 0 : 0.9;
    else { pd = 0.6; pfa *= 1 + 0.3 * (wx.wind || 0) / 10; }                  // vibration: current sim heuristic [approx]
    const tp = tablePfa(kind, q); if (tp != null) pfa = kind === 'snd' && q.familiarity ? tp + q.familiarity * (1 - tp) * 0.8 : tp; // fitted from no-drone logs (f.4)
    if (q.pd != null) pd = q.pd;
    return { pd: clamp(pd, 1e-6, 0.999), pfa: clamp(pfa, 1e-9, 0.99), tc: k.tc, lmax: k.lmax, lmin: k.lmin };
  }
  function newBlendState(opts) {
    const o = opts || {}, pi = o.prior != null ? o.prior : 0.0067, lD = o.lambdaD != null ? o.lambdaD : 1 / 8;   // decision 1: 8 s memory
    return { L: logit(pi), E: {}, pi, kappa: lD / (1 - pi), Lc: o.Lclamp || 15, hold: 0 };
  }
  // log-likelihood of one report for its channel (before the dt/tc scaling)
  function repEll(r, m) {
    if (r.kind === 'cam' && r.detected !== false && r.cls) {                  // class report: confusion matrix (a.3)
      const c = CAM_CM.drone[r.cls] != null ? r.cls : 'unknown', clutter = Object.assign({}, CAM_CM.clutter, { drone: m.pfa });
      const pNot = CAM_CM.bird[c] * CAM_W.bird + CAM_CM.aircraft[c] * CAM_W.aircraft + clutter[c] * CAM_W.clutter;
      return Math.log(CAM_CM.drone[c] / pNot);
    }
    return r.detected === false ? Math.log((1 - m.pd) / (1 - m.pfa)) : Math.log(m.pd / m.pfa);
  }
  // reps: {kind, detected (default true), snr?, range?, band?, tower?, pd?, familiarity?, cls?, mismatch?, explain? (ADS-B factor)}
  // ctx: { dt, wx, scen }. Returns {L, p, alarm, contrib} and mutates state.
  // Sub-stepped (h <= 0.1 s, spec v2 a.1): predict-then-update interleaving is only step-invariant for small h at 8 s memory.
  const H_MAX = 0.1;
  function lrBlend(st, reps, ctx) {
    const n = Math.max(1, Math.ceil(ctx.dt / H_MAX - 1e-9)), sub = Object.assign({}, ctx, { dt: ctx.dt / n }); let o;
    for (let i = 0; i < n; i++) o = lrStep(st, reps, sub);
    return o;
  }
  function lrStep(st, reps, ctx) {
    const dt = ctx.dt, L0 = logit(st.pi), p = sig(st.L), pm = st.pi + (p - st.pi) * Math.exp(-st.kappa * dt), Lm = logit(pm);
    const den = st.L - L0, s = Math.abs(den) < 1e-12 ? 1 : (Lm - L0) / den;
    for (const k in st.E) st.E[k] *= s;                                         // Markov predict, shared across buckets (keeps "why" honest)
    const by = { snd: [], rf: [], rid: [], cam: [], vib: [] }, M = {};
    for (const r of reps || []) {
      if (!by[r.kind]) continue;
      if (r.kind === 'snd' && r.detected !== false && r.cls && r.cls !== 'drone' && r.cls !== 'familiar') continue; // helicopter: no drone evidence
      const m = M[r.kind + (r.band || '')] = sensorModel(r.kind, { snr: r.snr, range: r.range, wx: ctx.wx, scen: ctx.scen, familiarity: r.familiarity, band: r.band, pd: r.pd, maxRange: r.maxRange });
      let l = repEll(r, m) * dt / m.tc;
      if (l > 0 && r.mismatch) l *= 0.15;                                       // points somewhere other than the track
      if (l > 0 && r.explain != null && (r.kind === 'snd' || (r.kind === 'cam' && r.cls !== 'drone'))) l *= r.explain; // ADS-B: explains sound/heat only
      by[r.kind].push({ l, m });
    }
    const add = (k, d, m) => { st.E[k] = clamp((st.E[k] || 0) + d, m.lmin, m.lmax); };
    // sound posts: correlated (shared source level + weather fading) -> sum of up to 4, times n_eff/n (a.4.2)
    if (by.snd.length) { const a = by.snd.sort((x, y) => Math.abs(y.l) - Math.abs(x.l)).slice(0, 4), n = a.length, ne = n / (1 + (n - 1) * RHO_SND);
      add('snd', a.reduce((t, x) => t + x.l, 0) * ne / n, a[0].m); }
    // RF: max over towers (emitter identity, a.4.3); RF + RID at the same radio: one group, the larger ΔL goes in (a.4.4)
    const mx = a => a.length ? a.reduce((b, x) => x.l > b.l ? x : b) : null, rf = mx(by.rf), rid = mx(by.rid);
    if (rf && rid) { if (rid.l >= rf.l) add('rid', rid.l, rid.m); else add('rf', rf.l, rf.m); } else if (rf) add('rf', rf.l, rf.m); else if (rid) add('rid', rid.l, rid.m);
    for (const k of ['cam', 'vib']) { const b = mx(by[k]); if (b) add(k, b.l, b.m); }
    st.L = clamp(L0 + Object.values(st.E).reduce((a, b) => a + b, 0), -st.Lc, st.Lc);
    const pp = sig(st.L); st.hold = pp >= ALARM ? st.hold + dt : 0;
    return { L: st.L, p: pp, alarm: st.hold >= ALARM_HOLD - 1e-9, contrib: Object.assign({}, st.E) };
  }

  // ===================== 2. Weather-aware confidence =====================
  // impact: per-sense range now vs a clear mild day ({sound:{m,pct,up,dn}, rf24, rf58, rid, thermal, vib:{falsePerMin}}),
  // from the physics model (a real hub would feed its weather station into the same model).
  // micWind: wind speed at the mics (m/s). Returns trust multipliers, adapted thresholds, live coverage and a banner.
  function weatherPolicy(impact, wx, opts) {
    const on = opts.on, ratio = k => clamp(1 + impact[k].pct / 100, 0, 3);
    const blind = { snd: clamp(1 - ratio('sound'), 0, 1), cam: clamp(1 - ratio('thermal'), 0, 1) };
    const worst = Math.max(blind.snd, blind.cam), fpm = impact.vib.falsePerMin;
    const cover = { snd: impact.sound.m, sndUp: impact.sound.up, sndDn: impact.sound.dn, rid: impact.rid.m, rf24: impact.rf24.m, rf58: impact.rf58.m, cam: impact.thermal.m };
    const pol = Object.assign({}, NEUTRAL, { on, blind, cover, banner: banner(impact, wx, opts) });
    if (!on) return pol;
    pol.trust = {
      snd: 1 - 0.75 * blind.snd,                 // rain hiss / wind: a sound report is less sure, and sound misses more
      cam: 1 - 0.6 * blind.cam,                  // hot afternoon / rain / dust: low thermal contrast
      vib: 1 / (1 + fpm),                        // gusts and rain drumming shake the roof sensor
      rf: 1,                                     // radio's drone-vs-WiFi discrimination doesn't change with weather: no boost
      rid: 1
    };
    pol.sndMinHits = opts.micWind >= 7.5 ? 4 : 3;  // wind makes wires "sing" (~3 rungs): demand a 4-rung ladder
    pol.vibNeed = fpm > 0.5 ? 2 : 1;               // need 2 shakes within 1.5 s when the weather rattles the roof
    pol.rfCapBoost = 0;                            // (quanta review) RF alone still can't confirm: it cues, others confirm
    return pol;
  }
  function banner(impact, wx, opts) {
    const s = -impact.sound.pct, t = -impact.thermal.pct;
    if (s < 35 && t < 35) return null;
    const cause = wx.rain === 2 ? 'Heavy rain' : wx.rain ? 'Drizzle' : wx.wind >= 8 && wx.dust === 2 ? 'Dust storm' : wx.wind >= 8 ? 'Strong wind' : wx.dust === 2 ? 'Heavy dust' : wx.tod === 'hotday' ? 'Hot afternoon' : 'Weather';
    const parts = []; if (s >= 35) parts.push('sound coverage down ' + Math.round(s) + '%'); if (t >= 35) parts.push('thermal down ' + Math.round(t) + '%');
    return cause + ': ' + parts.join(', ') + (opts.on ? ', relying on ' + (opts.ridOn ? 'Remote ID + radio' : 'radio to cue (it can\'t confirm alone)') : ' (weather-aware fusion OFF: still trusting every sense fully)');
  }

  // ===================== 3. Learns your place (noise map) =====================
  // Per sound post, per hour slot (0-23 weekday, 24-47 weekend): typical loudness in 12 bands, and which rotor-like ladders
  // (by pitch) are heard there on most days. Novelty = how unusual the current sound is vs that post's normal for this hour.
  const NBANDS = 12, BLO = 50, BHI = 4000, FORGET = 0.93;   // ~2-week memory: each new day, older days count 7% less
  const toneBin = f0 => Math.round(Math.log(f0) / Math.log(1.03));  // 3% pitch bins
  const slotOf = (hour, weekend) => (Math.floor(hour) % 24) + (weekend ? 24 : 0);
  const slotName = slot => String(slot % 24).padStart(2, '0') + ':00 ' + (slot >= 24 ? 'weekend' : 'weekday');
  function newPlace() { return { nodes: {}, quar: [], samples: 0 }; }
  function bandsOf(db, binHz) {
    const out = new Float32Array(NBANDS);
    for (let b = 0; b < NBANDS; b++) {
      const lo = Math.round(BLO * Math.pow(BHI / BLO, b / NBANDS) / binHz), hi = Math.max(lo + 1, Math.round(BLO * Math.pow(BHI / BLO, (b + 1) / NBANDS) / binHz));
      let p = 0; for (let i = lo; i < hi && i < db.length; i++) p += Math.pow(10, db[i] / 10);
      out[b] = 10 * Math.log10(p / (hi - lo) + 1e-20);
    }
    return out;
  }
  const getSlot = (place, id, slot) => place.nodes[id] && place.nodes[id][slot];
  function mkSlot(place, id, slot) {
    const n = place.nodes[id] || (place.nodes[id] = {});
    return n[slot] || (n[slot] = { daysObs: 0, lastDay: -1, tones: {}, m: new Float32Array(NBANDS), v: new Float32Array(NBANDS).fill(9), n: 0 });
  }
  const quarantined = (place, f0) => { const b = toneBin(f0); return place.quar.some(q => Math.abs(q.bin - b) <= 2); };
  // obs = { bands, f0 (pitch of a detected ladder, or null) }; ctx = { alarmActive, protect (default true), rate }
  // RULE: anything tied to an alarm is never absorbed into "normal" (so a nightly drone can't teach itself in).
  function learn(place, id, slot, day, obs, ctx) {
    const protect = ctx.protect !== false;
    if (protect && ctx.alarmActive) return 'skip: alarm';
    const s = mkSlot(place, id, slot); place.samples++;
    if (s.lastDay !== day) { s.daysObs = s.daysObs * FORGET + 1; for (const b in s.tones) s.tones[b].days *= FORGET; s.lastDay = day; }
    for (const f0 of obs.f0s || (obs.f0 ? [obs.f0] : [])) {                 // every ladder heard in this frame (generator AND bells)
      if (protect && quarantined(place, f0)) continue;
      const b = toneBin(f0), t = s.tones[b] || (s.tones[b] = { days: 0, lastDay: -1, f0 }); if (t.lastDay !== day) { t.days += 1; t.lastDay = day; } }
    s.n++; const a = Math.max(ctx.rate || 0.02, 1 / s.n);  // fast at first, then slow drift
    for (let i = 0; i < NBANDS; i++) { const d = obs.bands[i] - s.m[i]; s.m[i] += a * d; s.v[i] = (1 - a) * (s.v[i] + a * d * d); }
    return 'learned';
  }
  // 0..1: on what share of days this pitch was heard at this post around this hour (±1 h counts 80%). +half-day prior = a little cautious.
  function familiarity(place, id, slot, f0) {
    const b = toneBin(f0), h = slot % 24, base = slot - h; let best = 0;
    for (const [dh, w] of [[0, 1], [-1, 0.8], [1, 0.8]]) {
      const s = getSlot(place, id, base + (h + dh + 24) % 24); if (!s || s.daysObs < 0.5) continue;
      let d = 0; for (let k = -1; k <= 1; k++) d += s.tones[b + k] ? s.tones[b + k].days : 0;
      best = Math.max(best, w * Math.min(1, d / (s.daysObs + 0.5)));
    }
    return best;
  }
  // { learned, ladder: novelty of the ladder 0..1 (null if none), loud: loudness novelty 0..1, score }
  function novelty(place, id, slot, obs) {
    const s = getSlot(place, id, slot), learned = !!(s && s.n >= 3);
    let loud = null;
    if (learned && obs.bands) { let z = 0; for (let i = 0; i < NBANDS; i++) z += Math.max(0, (obs.bands[i] - s.m[i]) / Math.max(2, Math.sqrt(s.v[i])) - 1); loud = clamp(z / NBANDS / 3, 0, 1); }
    const ladder = obs.f0 ? (quarantined(place, obs.f0) ? 1 : 1 - familiarity(place, id, slot, obs.f0)) : null;
    return { learned, ladder, loud, score: ladder != null ? ladder : loud };
  }
  // pitches that are normal at this post around this hour (not alarm-tied)
  function familiarTones(place, id, slot, min) {
    const out = [], h = slot % 24, base = slot - h, seen = {};
    for (const dh of [0, -1, 1]) { const s = getSlot(place, id, base + (h + dh + 24) % 24); if (!s) continue;
      for (const b in s.tones) { const t = s.tones[b]; if (seen[b] || quarantined(place, t.f0)) continue; const f = familiarity(place, id, slot, t.f0); if (f >= (min || 0.5)) { seen[b] = 1; out.push({ f0: t.f0, fam: f }); } } }
    return out;
  }
  // hide known-normal ladders (every harmonic) so the detector can look for something else underneath. Returns a copy.
  function notch(db, f0s, binHz) {
    const out = Float32Array.from(db), n = out.length;
    for (const f0 of f0s) for (let h = 1; h <= 12; h++) {
      const c = Math.round(f0 * h / binHz), t = Math.max(1, Math.round(f0 * h * 0.03 / binHz)) + 1; if (c - t - 6 < 1 || c + t + 6 >= n) continue;
      let sum = 0; for (let k = 3; k <= 6; k++) sum += db[c - t - k] + db[c + t + k];
      for (let i = c - t; i <= c + t; i++) out[i] = sum / 8;
    }
    return out;
  }
  // an alarm happened with this ladder pitch: never learn it, and forget it wherever it was learned
  function quarantine(place, f0, why) {
    if (quarantined(place, f0)) return false; const bin = toneBin(f0); place.quar.push({ bin, f0, why });
    for (const id in place.nodes) for (const sl in place.nodes[id]) { const T = place.nodes[id][sl].tones; for (const b in T) if (Math.abs(b - bin) <= 2) delete T[b]; }
    return true;
  }
  const normalLevel = (place, id, slot) => { const s = getSlot(place, id, slot); if (!s || s.n < 3) return null; let p = 0; for (let i = 0; i < NBANDS; i++) p += Math.pow(10, s.m[i] / 10); return 10 * Math.log10(p / NBANDS); };

  // ===================== 4. No-drone log (JSONL schema v1) and Pfa fitting (quanta-engine-spec §f) =====================
  const LOG_V = 1, WX_MAXAGE_MS = 60000;
  // parse JSONL text; malformed lines and v != 1 are counted, not thrown. Sensor records get the latest wx (<= 60 s old).
  function parseLog(text) {
    const recs = []; let errors = 0;
    for (const line of String(text).split(/\r?\n/)) {
      if (!line.trim()) continue;
      let o; try { o = JSON.parse(line); } catch (e) { errors++; continue; }
      if (!o || typeof o !== 'object' || o.v !== LOG_V) { errors++; continue; }
      recs.push(o);
    }
    recs.sort((a, b) => (a.ts || 0) - (b.ts || 0));                           // stable: same-ts order kept
    let wx = null;
    for (const r of recs) {
      if (r.kind === 'wx') { wx = r; continue; }
      if (r.kind === 'sys') continue;
      r.wx = wx && r.ts - wx.ts <= WX_MAXAGE_MS && r.ts >= wx.ts ? { t_c: wx.t_c, rh_pct: wx.rh_pct, wind_ms: wx.wind_ms, wind_from_deg: wx.wind_from_deg, rain_mmh: wx.rain_mmh, rain_state: wx.rain_state, p_wet: wx.p_wet } : null;
    }
    return { records: recs, errors };
  }
  // bin key "w<i>|<dry|wet>|<day|night>" (RF: "<day|night>", never weather, a.5). Accepts log wx {wind_ms, rain_mmh} or sim wx {wind, rain, tod}.
  function pfaKey(kind, wx, hod, tod) {
    const day = hod != null ? (hod >= 6 && hod < 18) : !(tod === 'coldnight' || tod === 'mildnight' || (wx && (wx.tod === 'coldnight' || wx.tod === 'mildnight')));
    const dn = day ? 'day' : 'night';
    if (kind === 'rf') return dn;
    if (!wx) return 'unknown';
    const w = wx.wind_ms != null ? wx.wind_ms : wx.wind || 0, wet = wx.rain_state ? wx.rain_state : (wx.rain_mmh != null ? wx.rain_mmh >= 0.5 : !!wx.rain) ? 'wet' : 'dry';
    return 'w' + (w < 3 ? 0 : w < 7 ? 1 : 2) + '|' + (wet === 'uncertain' ? 'unk' : wet) + '|' + dn;   // uncertain rain: kept out of wet/dry bins (g.6)
  }
  // log-gamma, regularized incomplete beta (Numerical Recipes betacf) and its inverse by bisection
  function lgam(x) { const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
    let y = x, t = x + 5.5; t -= (x + 0.5) * Math.log(t); let s = 1.000000000190015; for (const k of c) s += k / ++y; return -t + Math.log(2.5066282746310005 * s / x); }
  function betacf(a, b, x) { let qab = a + b, qap = a + 1, qam = a - 1, c = 1, d = 1 - qab * x / qap; d = 1 / (Math.abs(d) < 1e-300 ? 1e-300 : d); let h = d;
    for (let m = 1; m <= 300; m++) { const m2 = 2 * m; let aa = m * (b - m) * x / ((qam + m2) * (a + m2)); d = 1 + aa * d; d = 1 / (Math.abs(d) < 1e-300 ? 1e-300 : d); c = 1 + aa / c; if (Math.abs(c) < 1e-300) c = 1e-300; h *= d * c;
      aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2)); d = 1 + aa * d; d = 1 / (Math.abs(d) < 1e-300 ? 1e-300 : d); c = 1 + aa / c; if (Math.abs(c) < 1e-300) c = 1e-300; const del = d * c; h *= del; if (Math.abs(del - 1) < 3e-12) break; }
    return h; }
  function ibeta(x, a, b) { if (x <= 0) return 0; if (x >= 1) return 1; const bt = Math.exp(lgam(a + b) - lgam(a) - lgam(b) + a * Math.log(x) + b * Math.log(1 - x));
    return x < (a + 1) / (a + b + 2) ? bt * betacf(a, b, x) / a : 1 - bt * betacf(b, a, 1 - x) / b; }
  function betaQ(q, a, b) { let lo = 0, hi = 1; for (let i = 0; i < 100; i++) { const m = (lo + hi) / 2; ibeta(m, a, b) < q ? lo = m : hi = m; } return (lo + hi) / 2; }
  // effective number of looks for a clustered 0/1 series: n / (1 + 2 Σ ρ_m), m = 1..60, stop at the first negative ρ
  function nEffOf(x) {
    const n = x.length; if (n < 3) return n; let mu = 0; for (const v of x) mu += v; mu /= n; const v0 = mu * (1 - mu); if (v0 <= 0) return n;
    let s = 0; for (let m = 1; m <= Math.min(60, n - 1); m++) { let c = 0; for (let i = 0; i + m < n; i++) c += (x[i] - mu) * (x[i + m] - mu); const r = c / (n - m) / v0; if (r < 0) break; s += r; }
    return n / (1 + 2 * s);
  }
  // records: parsed log. Certified no-drone sessions ("nd-..."), up:true only. One bin per node x weather/hour key.
  function fitPfa(records, opts) {
    const o = opts || {}, kind = o.kind, groups = new Map(), excl = {};
    for (const r of records || []) if (r.kind === 'sys' && r.event === 'nd_end' && r.exclude_from_ts != null) excl[r.session] = r.exclude_from_ts; // g.5
    for (const r of records || []) {
      if (excl[r.session] != null && r.ts >= excl[r.session]) continue;
      if (r.kind !== kind || r.up !== true || !(typeof r.session === 'string' && r.session.startsWith('nd-'))) continue;
      const key = pfaKey(kind, r.wx, r.hod), g = (r.node || '*') + '\u0000' + key;
      if (!groups.has(g)) groups.set(g, { node: r.node || '*', key, recs: [] }); groups.get(g).recs.push(r);
    }
    const bins = [];
    for (const { node, key, recs } of groups.values()) {
      recs.sort((a, b) => a.ts - b.ts); const x = [];
      for (const r of recs) { const looks = r.looks || 1; for (let j = 0; j < looks; j++) x.push(r.det ? 1 : 0); }
      const n = x.length, k = x.reduce((a, b) => a + b, 0), nEff = nEffOf(x), kEff = k * nEff / n;
      const a = kEff + 0.5, b = nEff - kEff + 0.5;
      bins.push({ node, key, k, n, nEff, kEff, pfa: (kEff + 0.5) / (nEff + 1), lo: betaQ(0.025, a, b), hi: betaQ(0.975, a, b), source: nEff < 3600 ? 'thin' : 'fit' });
    }
    return { bins };
  }
  // threshold eta whose per-look exceedance rate on no-drone scores is `target`; null if < 10/target looks (refuse)
  function thresholdForPfa(scores, target) {
    const s = Float64Array.from(scores || []).sort(), n = s.length; if (!n || n < 10 / target) return null;
    return s[Math.min(n - 1, Math.max(0, Math.floor((1 - target) * n)))];
  }
  // ---------- g.5 no-drone session state machine (IDLE / ARMED) ----------
  // event: {type:'button', ts, hours, operator, note} | {type:'rid'|'track'|'tick'|'button_stop'|'hub_restart', ts, ...}
  function sessionStep(st, ev) {
    const s = Object.assign({ mode: 'IDLE', seq: 0 }, st), ts = ev.ts;
    const rej = (type, reason) => Object.assign(s, { rejected: { type, reason, ts } });
    delete s.rejected;
    if (s.mode === 'CAL') {                                                   // g.2a bring-up: claps/chirps allowed, detection off
      if (ev.type === 'button') return rej('button', 'cal');
      const endCal = reason => Object.assign(s, { mode: 'IDLE', last: { session: s.session, reason, triggerTs: ts, endTs: ts, excludeFromTs: ts } });
      if (ev.type === 'cal_end') return endCal('cal_end');
      if (ev.type === 'hub_restart') return endCal('hub_restart');
      if (ev.type === 'tick' && ts >= s.endPlanned) return endCal('timeout');
      return s;
    }
    if (ev.type === 'cal_start') {
      if (s.mode === 'ARMED') return rej('cal_start', 'armed');
      const seq = (s.seq || 0) + 1;
      return Object.assign(s, { mode: 'CAL', seq, session: 'cal-' + String(seq).padStart(4, '0'), startTs: ts, endPlanned: ts + 2 * 3600000, operator: ev.operator || '' });
    }
    if (s.mode === 'IDLE') {
      if (ev.type !== 'button') return s;
      const h = Math.min(12, Math.max(1, ev.hours || 4)), seq = (s.seq || 0) + 1;
      return Object.assign(s, { mode: 'ARMED', seq, session: 'nd-' + String(seq).padStart(4, '0'), startTs: ts, endPlanned: ts + h * 3600000, operator: ev.operator || '', note: ev.note || '', last: s.last });
    }
    const end = (reason, auto, detail) => Object.assign(s, { mode: 'IDLE', last: { session: s.session, reason, triggerTs: ts, endTs: ts, excludeFromTs: auto ? ts - 300000 : reason === 'timeout' ? s.endPlanned : ts, detail: detail || '' } });
    if (ev.type === 'rid') return end('rid', true, ev.hash ? 'rid ' + ev.hash : '');
    if (ev.type === 'track' && ev.confirmed && ev.pDrone >= 0.5) return end('track', true, ev.id != null ? 'track ' + ev.id : '');
    if (ev.type === 'button_stop') return end('button', false);
    if (ev.type === 'hub_restart') return end('hub_restart', false);
    if (ev.type === 'tick' && ts >= s.endPlanned) return end('timeout', false);
    return s;
  }
  // RID serials are logged only as a hash (FNV-1a 32-bit, hex)
  function idHash(str) { let h = 0x811c9dc5; for (const ch of String(str)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16).padStart(8, '0'); }
  // ---------- g.6 rain state without a gauge: manual flag + weather feed ----------
  function rainState(o) {
    const now = o.now, H = 3600000; let p = null;
    const feedOk = !!(o.feed && o.feed.rain_mmh != null && now - o.feed.ts <= H);   // stale feed (> 1 h, e.g. offline cache) is ignored entirely
    if (o.manual && now - o.manual.ts <= 2 * H) { p = o.manual.wet ? 0.95 : 0.05; if (!o.manual.wet && feedOk && o.feed.rain_mmh >= 2) p = 0.5; }
    else if (feedOk) p = o.feed.rain_mmh >= 0.5 ? 0.8 : 0.15;
    if (o.lastWetTs != null && now - o.lastWetTs <= 30 * 60000 && !(o.manual && now - o.manual.ts <= 2 * H && !o.manual.wet)) p = Math.max(p == null ? 0 : p, 0.8);
    if (p == null) p = 0.3;
    return { state: p >= 0.8 ? 'wet' : p <= 0.2 ? 'dry' : 'uncertain', pWet: p, feedStale: !feedOk };
  }
  // Open-Meteo weather feed (g.6): public HTTPS read-only, polled every 10-15 min by the hub and cached; used only for rain state
  const OPEN_METEO_POLL_MS = 15 * 60000;
  const openMeteoUrl = (lat, lon) => 'https://api.open-meteo.com/v1/forecast?latitude=' + (+lat).toFixed(4) + '&longitude=' + (+lon).toFixed(4) +
    '&current=precipitation,rain,temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m,surface_pressure&timezone=UTC';
  // -> {rain_mmh, ts, t_c, rh_pct, p_hpa, wind_ms, wind_from_deg}; precipitation is mm per `interval` seconds (900 s), converted to mm/h
  function parseOpenMeteo(j) {
    const c = j && j.current; if (!c || !c.time) return null; const iv = c.interval || 900, mm = c.precipitation != null ? c.precipitation : c.rain;
    const kmh = (j.current_units && j.current_units.wind_speed_10m) === 'km/h';
    return { ts: Date.parse(c.time + (/[zZ]|[+-]\d\d:?\d\d$/.test(c.time) ? '' : 'Z')), rain_mmh: mm == null ? null : mm * 3600 / iv, t_c: c.temperature_2m, rh_pct: c.relative_humidity_2m,
      p_hpa: c.surface_pressure, wind_ms: c.wind_speed_10m == null ? null : kmh ? c.wind_speed_10m / 3.6 : c.wind_speed_10m, wind_from_deg: c.wind_direction_10m };
  }
  const rainBinCorrect = (pObs, pDry, m) => (pObs - m * pDry) / (1 - m);
  // ===================== (b) ADS-B explanation / veto (never a boost) =====================
  // aircraft: ENU {id, x, y, z(AGL), vx, vy, vz, t, nacp?, sigma?}. det: {kind:'snd'|'cam', node:[3], az, el?, sAz, sEl?, t, h?, sH?}.
  // Passive 1090 MHz receive only; public position squitters from crewed aircraft. Explains sound/heat only (not RF, RID, cam 'drone').
  const ADSB_CFG = { max_range_km: 30, max_age_s: 10, sigma_pos_default_m: 50, f_min: 0.1, max_drone_agl_m: 150 };
  const wrapPi = a => { a = (a + Math.PI) % (2 * Math.PI); if (a < 0) a += 2 * Math.PI; return a - Math.PI; };
  function adsbExplain(det, aircraft, ctx) {
    const cfg = Object.assign({}, ADSB_CFG, ctx && ctx.adsb), c = (ctx && ctx.c) || 343.2, nd = det.node || [0, 0, 0];
    let best = 0, id = null, info = null;
    for (const a of aircraft || []) {
      if (det.t - a.t > cfg.max_age_s) continue;
      let te = det.t; const at = tt => [a.x + (a.vx || 0) * (tt - a.t), a.y + (a.vy || 0) * (tt - a.t), a.z + (a.vz || 0) * (tt - a.t)];
      if (det.kind !== 'cam') for (let i = 0; i < 3; i++) { const q = at(te); te = det.t - Math.hypot(q[0] - nd[0], q[1] - nd[1], q[2] - nd[2]) / c; } // retarded time
      const q = at(te), dx = q[0] - nd[0], dy = q[1] - nd[1], dz = q[2] - nd[2], rho = Math.hypot(dx, dy), r = Math.hypot(rho, dz);
      if (r > cfg.max_range_km * 1000) continue;
      const sp = a.sigma || cfg.sigma_pos_default_m, ang = (sp / Math.max(r, 1)) ** 2;
      let d2 = wrapPi(det.az - Math.atan2(dx, dy)) ** 2 / (det.sAz ** 2 + ang), m = 1;
      if (det.el != null && det.sEl) { d2 += wrapPi(det.el - Math.atan2(dz, rho)) ** 2 / (det.sEl ** 2 + ang); m = 2; }
      if (d2 > (m === 2 ? 9.21 : 6.63)) continue;
      let pA = Math.exp(-d2 / 2);
      if (det.h != null && det.sH) pA *= Phi((det.h - cfg.max_drone_agl_m) / det.sH);   // a drone below 150 m cannot be an aircraft at 1500 m
      if (pA > best) { best = pA; id = a.id; info = { range: r, agl: q[2] }; }
    }
    return { pAssoc: best, factor: 1 - best * (1 - cfg.f_min), id, range: info && info.range, agl: info && info.agl };
  }
  let PFA_TABLE = null;
  function loadPfaTable(table) { PFA_TABLE = table && table.sensors ? table : null; }
  // fitted Pfa for this sensor/node/bin, or null (then the a.3 default is used). Wrong threshold -> null (fit invalid).
  function tablePfa(kind, q) {
    if (!PFA_TABLE || !PFA_TABLE.sensors[kind]) return null; const S = PFA_TABLE.sensors[kind], rows = S[q.node] || S['*']; if (!rows) return null;
    const key = pfaKey(kind, q.wx, q.hod), row = rows.find(r => r.key === key); if (!row || row.pfa == null) return null;
    if (row.thr != null && q.thr != null && row.thr !== q.thr) return null;
    return row.pfa;
  }

  g.SkyCore = { RATE_S, MEMORY_S, WEIGHT, CAP, PRIOR, ALARM, NEUTRAL, blend, weatherPolicy, adsbExplain, ADSB_CFG, parseLog, pfaKey, sessionStep, idHash, rainState, rainBinCorrect, openMeteoUrl, parseOpenMeteo, OPEN_METEO_POLL_MS, fitPfa, thresholdForPfa, loadPfaTable, nEffOf, Phi, CH, sensorModel, newBlendState, lrBlend, newPlace, slotOf, slotName, bandsOf, learn, familiarity, novelty, familiarTones, notch, quarantine, quarantined, normalLevel, toneBin };
  if (typeof module !== 'undefined' && module.exports) module.exports = g.SkyCore;
})(typeof window !== 'undefined' ? window : globalThis);
