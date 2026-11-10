/* Rotor Ear field-day kit. All data stays in localStorage. Nothing is sent anywhere. */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.RotorField = api;
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', api.boot);
    else api.boot();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const STORE_KEY = 'rotorear-fieldday-v1';
  const CHECK_KEY = 'rotorear-fieldday-checks';
  const THEME_KEY = 'rotorear-theme';
  const LADDER = [2, 5, 10, 20, 30, 50];
  const TARGET_N = 5;
  const PD_RELIABLE = 0.8;
  const Z95 = 1.959963984540054;

  /* ---------------- stats ---------------- */
  const LN_SQRT_2PI = 0.9189385332046728;

  function logGamma(z) {
    const c = [
      0.99999999999980993, 676.5203681218851, -1259.1392167224028,
      771.32342877765313, -176.61502916214059, 12.507343278686905,
      -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7
    ];
    if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
    const x = z - 1;
    let a = c[0];
    for (let i = 1; i < c.length; i++) a += c[i] / (x + i);
    const t = x + 7.5;
    return LN_SQRT_2PI + Math.log(a) + (x + 0.5) * Math.log(t) - t;
  }

  function gammaSeries(s, x) {
    const log0 = s * Math.log(x) - x - logGamma(s);
    let term = 1 / s, sum = term;
    for (let n = 1; n < 250; n++) {
      term *= x / (s + n);
      sum += term;
      if (Math.abs(term) < Math.abs(sum) * 1e-16) break;
    }
    const v = Math.exp(log0 + Math.log(sum));
    return v > 1 ? 1 : v < 0 ? 0 : v;
  }

  function gammaCF(s, x) {
    const logPre = s * Math.log(x) - x - logGamma(s);
    const fpmin = 1e-300;
    let b = x + 1 - s, c = 1 / fpmin, d = 1 / b, h = d;
    for (let i = 1; i <= 250; i++) {
      const an = -i * (i - s);
      b += 2;
      d = an * d + b;
      if (Math.abs(d) < fpmin) d = fpmin;
      c = b + an / c;
      if (Math.abs(c) < fpmin) c = fpmin;
      d = 1 / d;
      const del = d * c;
      h *= del;
      if (Math.abs(del - 1) < 1e-14) break;
    }
    const v = Math.exp(logPre) * h;
    return v > 1 ? 1 : v < 0 ? 0 : v;
  }

  function gammaP(s, x) {
    if (x <= 0) return 0;
    if (!isFinite(x)) return 1;
    if (x < s + 1) return gammaSeries(s, x);
    return 1 - gammaCF(s, x);
  }

  function invGammaP(p, s) {
    if (p <= 0) return 0;
    if (p >= 1) return Infinity;
    let lo = 0, hi = Math.max(1, s);
    while (gammaP(s, hi) < p) {
      hi *= 2;
      if (hi > 1e12) return hi;
    }
    for (let i = 0; i < 80; i++) {
      const mid = (lo + hi) / 2;
      if (gammaP(s, mid) < p) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  }

  function wilson(k, n, z) {
    z = z == null ? Z95 : z;
    if (!n || n <= 0) return null;
    const p = k / n, z2 = z * z, den = 1 + z2 / n;
    const center = (p + z2 / (2 * n)) / den;
    const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n) / den;
    return { p, lo: Math.max(0, center - margin), hi: Math.min(1, center + margin), k, n };
  }

  /* Jeffreys 95% interval for a Poisson rate: k events in T time-units.
     Posterior Gamma(k+0.5, rate=T). CI = invGammaP(α, k+0.5) / T. */
  function jeffreysRate(k, T, alpha) {
    alpha = alpha == null ? 0.05 : alpha;
    if (!T || T <= 0 || k < 0 || !isFinite(k) || !isFinite(T)) return null;
    const shape = k + 0.5;
    return {
      rate: k / T,
      lo: invGammaP(alpha / 2, shape) / T,
      hi: invGammaP(1 - alpha / 2, shape) / T,
      k, T, mean: (k + 0.5) / T
    };
  }

  function median(arr) {
    if (!arr.length) return null;
    const a = arr.slice().sort((x, y) => x - y);
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }

  function countedRuns(state) {
    return (state.runs || []).filter(r => !r.void);
  }

  function sessionSeconds(s, now) {
    if (s.start) {
      const t0 = Date.parse(s.start);
      const t1 = s.end ? Date.parse(s.end) : (now || Date.now());
      if (isFinite(t0) && isFinite(t1)) return Math.max(0, (t1 - t0) / 1000);
    }
    return s.seconds || 0;
  }

  function analyse(state) {
    const runs = countedRuns(state);
    const byDist = {};
    const byDistMotion = {};
    const ttdByDist = {};
    const allTtd = [];
    for (const r of runs) {
      const d = Number(r.distance);
      if (!isFinite(d)) continue;
      if (!byDist[d]) byDist[d] = { k: 0, n: 0, hover: { k: 0, n: 0 }, flypast: { k: 0, n: 0 } };
      byDist[d].n++;
      if (r.detected) byDist[d].k++;
      const mot = r.motion === 'flypast' ? 'flypast' : 'hover';
      byDist[d][mot].n++;
      if (r.detected) byDist[d][mot].k++;
      const key = d + ':' + mot;
      if (!byDistMotion[key]) byDistMotion[key] = { k: 0, n: 0 };
      byDistMotion[key].n++;
      if (r.detected) byDistMotion[key].k++;
      if (r.detected && r.ttd != null && r.ttd !== '' && isFinite(Number(r.ttd))) {
        const t = Number(r.ttd);
        if (!ttdByDist[d]) ttdByDist[d] = [];
        ttdByDist[d].push(t);
        allTtd.push(t);
      }
    }
    const distances = Object.keys(byDist).map(Number).sort((a, b) => a - b);
    const rows = distances.map(d => {
      const w = wilson(byDist[d].k, byDist[d].n);
      return { d, ...w };
    });
    let maxRange = null;
    for (const row of rows) {
      if (row.p >= PD_RELIABLE) maxRange = row.d;
    }
    const belowCloser = maxRange != null
      ? rows.filter(r => r.d < maxRange && r.p < PD_RELIABLE).map(r => r.d)
      : [];
    const maxRow = rows.find(r => r.d === maxRange) || null;

    function ttdStats(arr) {
      if (!arr || !arr.length) return null;
      return { n: arr.length, median: median(arr), min: Math.min(...arr), max: Math.max(...arr) };
    }

    const now = Date.now();
    let quietSec = 0, fa = 0;
    const bySetting = {};
    const alarms = [];
    for (const s of state.sessions || []) {
      const sec = sessionSeconds(s, now);
      quietSec += sec;
      const set = s.setting || 'quiet';
      if (!bySetting[set]) bySetting[set] = { sec: 0, fa: 0, label: set };
      bySetting[set].sec += sec;
      const list = s.alarms || [];
      fa += list.length;
      bySetting[set].fa += list.length;
      for (const a of list) alarms.push({ ...a, setting: set, sessionId: s.id, example: !!(a.example || s.example || state.example) });
    }
    const hours = quietSec / 3600;
    const faInt = jeffreysRate(fa, hours);

    return {
      runsCounted: runs.length,
      runsTotal: (state.runs || []).length,
      runsVoid: (state.runs || []).filter(r => r.void).length,
      distances, byDist, rows, maxRange, maxRow, belowCloser,
      ttdByDist, ttdAll: ttdStats(allTtd),
      ttdAtMax: maxRange != null ? ttdStats(ttdByDist[maxRange] || []) : null,
      quietSec, hours, fa, faInt, bySetting, alarms,
      example: !!state.example
    };
  }

  /* ---------------- formatting ---------------- */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }
  function todayIST() {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Calcutta' });
  }
  function fmtWhen(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d)) return '—';
    return d.toLocaleString('en-IN', {
      timeZone: 'Asia/Calcutta', day: 'numeric', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: true
    }) + ' IST';
  }
  function fmtDate(ymd) {
    if (!ymd) return '';
    const d = new Date(ymd + 'T12:00:00+05:30');
    return d.toLocaleDateString('en-IN', { timeZone: 'Asia/Calcutta', day: 'numeric', month: 'long', year: 'numeric' });
  }
  function fmtDist(d) {
    const n = Number(d);
    if (!isFinite(n)) return String(d);
    return (Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10)) + ' m';
  }
  function pct(x) {
    if (x == null || !isFinite(x)) return '—';
    const r = Math.round(x * 1000) / 10;
    return (Number.isInteger(r) ? r.toFixed(0) : r.toFixed(1)) + '%';
  }
  function rateTxt(x) {
    if (x == null || !isFinite(x)) return '—';
    if (x === 0) return '0';
    if (x >= 100) return String(Math.round(x));
    if (x >= 10) return String(Math.round(x * 10) / 10);
    if (x >= 1) return (Math.round(x * 100) / 100).toFixed(2).replace(/0$/, '').replace(/\.0$/, '');
    if (x >= 0.01) return (Math.round(x * 100) / 100).toString();
    return x.toExponential(2);
  }
  function fmtDur(sec) {
    sec = Math.max(0, Math.round(sec || 0));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    if (h) return m ? h + ' h ' + m + ' min' : h + ' h';
    if (m) return (s && m < 5) ? m + ' min ' + s + ' s' : m + ' min';
    return s + ' s';
  }
  function fmtClock(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    const mm = String(m).padStart(2, '0'), ss = String(s).padStart(2, '0');
    return h ? h + ':' + mm + ':' + ss : mm + ':' + ss;
  }
  function fmtTtd(t) {
    if (t == null || !isFinite(t)) return '—';
    const r = Math.round(Number(t) * 10) / 10;
    return (Number.isInteger(r) ? r.toFixed(0) : r.toFixed(1)) + ' s';
  }
  function motionLabel(m) { return m === 'flypast' ? 'Fly-past' : 'Hover'; }
  function settingLabel(s) {
    return ({ quiet: 'Quiet', road: 'Road / traffic', wind: 'Wind', other: 'Other' })[s] || s || 'Quiet';
  }
  function joinList(arr) {
    if (arr.length <= 1) return arr[0] || '';
    if (arr.length === 2) return arr[0] + ' and ' + arr[1];
    return arr.slice(0, -1).join(', ') + ', and ' + arr[arr.length - 1];
  }
  function exTag(on) {
    return on ? ' <span class="ex-tag">EXAMPLE</span>' : '';
  }
  function uid(prefix) {
    return (prefix || 'id') + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
  }

  function buildSummary(state, S) {
    S = S || analyse(state);
    const prefix = state.example ? 'EXAMPLE (not real field results): ' : '';
    const date = state.meta && state.meta.date ? fmtDate(state.meta.date) : 'an unstated date';
    const site = (state.meta && state.meta.site) ? state.meta.site : 'an unstated site';
    const drone = (state.meta && state.meta.drone) ? state.meta.drone : 'an unstated drone';
    const phones = (state.meta && state.meta.phones) ? String(state.meta.phones) : 'an unstated number of';
    const layout = (state.meta && state.meta.layout) ? ', ' + state.meta.layout : '';
    const weather = (state.meta && state.meta.weather) ? ' Weather: ' + state.meta.weather + '.' : '';
    const phoneWord = String(phones) === '1' ? 'phone' : 'phones';
    let text = prefix + 'On ' + date + ' at ' + site + ', Rotor Ear was tested with ' + drone +
      ' using ' + phones + ' ' + phoneWord + layout + '.' + weather;

    if (!S.rows.length) {
      text += ' No detection runs have been counted yet.';
    } else {
      const groups = [];
      for (const r of S.rows) {
        const last = groups[groups.length - 1];
        if (last && last.k === r.k && last.n === r.n) last.ds.push(r.d);
        else groups.push({ ds: [r.d], k: r.k, n: r.n, p: r.p, lo: r.lo, hi: r.hi });
      }
      const bits = groups.map(g => {
        const dist = joinList(g.ds.map(fmtDist));
        return pct(g.p) + ' at ' + dist + ' (' + g.k + '/' + g.n + ', Wilson 95% ' + pct(g.lo) + '–' + pct(g.hi) + ')';
      });
      text += ' Detection was ' + joinList(bits) + '.';
      if (S.maxRange != null) {
        text += ' The farthest mark with Pd at least 80% was ' + fmtDist(S.maxRange) + '.';
        if (S.belowCloser.length) {
          text += ' Note: Pd was below 80% at ' + joinList(S.belowCloser.map(fmtDist)) + '.';
        }
        if (S.maxRow && S.maxRow.lo < 0.5) {
          text += ' The Wilson 95% interval at that mark is wide (' + pct(S.maxRow.lo) + '–' + pct(S.maxRow.hi) + '), so more runs would help.';
        }
        if (S.ttdAtMax) {
          text += ' Median time to detect at that range was ' + fmtTtd(S.ttdAtMax.median).replace(' s', '') +
            ' s (range ' + fmtTtd(S.ttdAtMax.min).replace(' s', '') + '–' + fmtTtd(S.ttdAtMax.max) + ').';
        }
      } else {
        text += ' No tested distance reached a detection probability of 80%, so a max reliable range is not established.';
      }
    }

    if (S.quietSec <= 0) {
      text += ' No no-drone time has been logged, so a false-alarm rate is not estimated.';
    } else {
      const nFa = S.fa, verb = nFa === 1 ? 'was' : 'were';
      const noun = nFa === 1 ? 'false drone alarm' : 'false drone alarms';
      const lo = S.faInt ? rateTxt(S.faInt.lo) : '—';
      const hi = S.faInt ? rateTxt(S.faInt.hi) : '—';
      const rate = S.faInt ? rateTxt(S.faInt.rate) : '—';
      text += ' In ' + fmtDur(S.quietSec) + ' of no-drone listening, ' + nFa + ' ' + noun + ' ' + verb +
        ' logged (' + rate + '/h, Jeffreys 95% ' + lo + '–' + hi + '/h).';
      const sets = Object.keys(S.bySetting);
      if (sets.length > 1) {
        const parts = sets.map(k => {
          const b = S.bySetting[k];
          return settingLabel(k) + ' ' + fmtDur(b.sec) + ', ' + b.fa + (b.fa === 1 ? ' alarm' : ' alarms');
        });
        text += ' By setting: ' + parts.join('; ') + '.';
      }
    }

    if (state.example) {
      text += ' These figures are EXAMPLE data for demonstrating the sheet, not a real test, and must not appear in a brief as evidence.';
    } else {
      text += ' These figures are from a single site and the drone type logged here; they are not a fielded-system rating.';
    }
    return text;
  }

  /* ---------------- example data ---------------- */
  function exampleState() {
    const runs = [];
    const ladder = [
      [2, 5, 5, 1.4],
      [5, 5, 5, 1.8],
      [10, 5, 4, 2.6],
      [20, 4, 4, 3.8],
      [30, 3, 2, 5.5],
      [50, 1, 0, 8.0]
    ];
    let t = Date.parse('2026-11-08T08:00:00+05:30');
    for (const [d, hYes, fYes, ttd0] of ladder) {
      for (const [motion, yes] of [['hover', hYes], ['flypast', fYes]]) {
        for (let i = 0; i < 5; i++) {
          const detected = i < yes;
          const ttd = detected ? Math.round((ttd0 + i * 0.3 + (motion === 'flypast' ? 0.4 : 0)) * 10) / 10 : null;
          const agree = !detected ? '' : (d <= 10 ? '4 of 4' : d <= 20 ? '3 of 4' : '2 of 4');
          runs.push({
            id: 'ex-r-' + d + '-' + motion + '-' + i,
            ts: new Date(t).toISOString(),
            distance: d,
            drone: 'NHR Fighter Jet (toy)',
            motion,
            weather: 'Clear, leaves rustle',
            detected,
            ttd,
            classShown: detected ? 'Quadcopter' : '',
            phonesAgree: agree,
            notes: '',
            void: false,
            example: true
          });
          t += 3 * 60 * 1000;
        }
      }
    }
    return {
      v: 1,
      example: true,
      meta: {
        date: '2026-11-08',
        site: 'EXAMPLE — Cubbon Park practice ground (fictional)',
        phones: '4',
        layout: '5 m square, tape-measured, clap-calibrated',
        drone: 'NHR Fighter Jet (toy)',
        weather: 'Clear, leaves rustle',
        notes: 'EXAMPLE data only. Not a real field day.'
      },
      runs,
      sessions: [
        {
          id: 'ex-s-quiet',
          start: '2026-11-08T11:30:00+05:30',
          end: '2026-11-08T12:12:00+05:30',
          seconds: 42 * 60,
          setting: 'quiet',
          notes: 'Drone in the bag, same phone layout',
          alarms: [],
          example: true
        },
        {
          id: 'ex-s-wind',
          start: '2026-11-08T12:20:00+05:30',
          end: '2026-11-08T12:38:00+05:30',
          seconds: 18 * 60,
          setting: 'wind',
          notes: 'Light breeze, leaves rustle',
          alarms: [{
            id: 'ex-fa-1',
            ts: '2026-11-08T12:31:00+05:30',
            classShown: 'Quadcopter',
            notes: 'A passing scooter; screen showed DRONE for a few seconds',
            example: true
          }],
          example: true
        }
      ],
      activeSessionId: null
    };
  }

  function defaultState() {
    return {
      v: 1,
      example: false,
      meta: {
        date: todayIST(),
        site: '',
        phones: '4',
        layout: '',
        drone: 'NHR Fighter Jet (toy)',
        weather: '',
        notes: ''
      },
      runs: [],
      sessions: [],
      activeSessionId: null
    };
  }

  /* ---------------- store ---------------- */
  let state = defaultState();

  function normalize(raw) {
    const base = defaultState();
    if (!raw || typeof raw !== 'object') return base;
    const s = {
      v: 1,
      example: !!raw.example,
      meta: { ...base.meta, ...(raw.meta || {}) },
      runs: Array.isArray(raw.runs) ? raw.runs : [],
      sessions: Array.isArray(raw.sessions) ? raw.sessions : [],
      activeSessionId: raw.activeSessionId || null
    };
    if (s.example || s.runs.some(r => r.example) || s.sessions.some(x => x.example)) s.example = true;
    return s;
  }

  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (err) { console.warn('Could not save field-day data', err); }
  }
  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      state = raw ? normalize(JSON.parse(raw)) : defaultState();
    } catch (err) {
      console.warn('Could not read field-day data', err);
      state = defaultState();
    }
    return state;
  }

  /* ---------------- self check ---------------- */
  function selfCheck() {
    const errors = [];
    const near = (a, b, eps) => Math.abs(a - b) <= (eps == null ? 1e-3 : eps);
    const w = wilson(8, 10);
    if (!w || !near(w.p, 0.8) || !near(w.lo, 0.49016, 5e-4) || !near(w.hi, 0.94331, 5e-4)) {
      errors.push('Wilson 8/10 mismatch: ' + JSON.stringify(w));
    }
    const j0 = jeffreysRate(0, 1);
    if (!j0 || !near(j0.rate, 0) || !near(j0.hi, 2.51194, 5e-3) || j0.lo > 0.01) {
      errors.push('Jeffreys 0/1h mismatch: ' + JSON.stringify(j0));
    }
    const j1 = jeffreysRate(1, 1);
    if (!j1 || !near(j1.rate, 1) || !near(j1.lo, 0.1079, 5e-3) || !near(j1.hi, 4.6742, 5e-3)) {
      errors.push('Jeffreys 1/1h mismatch: ' + JSON.stringify(j1));
    }
    const ex = analyse(exampleState());
    if (ex.maxRange !== 20) errors.push('Example max reliable range should be 20 m, got ' + ex.maxRange);
    const r20 = ex.rows.find(r => r.d === 20);
    if (!r20 || r20.k !== 8 || r20.n !== 10) errors.push('Example 20 m should be 8/10');
    if (ex.fa !== 1 || Math.abs(ex.quietSec - 3600) > 1) errors.push('Example FA/time mismatch');
    const sum = buildSummary(exampleState(), ex);
    if (!/EXAMPLE/.test(sum) || /not a fielded-system rating/.test(sum) === false && !/EXAMPLE data/.test(sum)) {
      /* summary for example must say EXAMPLE */
    }
    if (!/EXAMPLE/.test(sum)) errors.push('Example summary missing EXAMPLE label');
    return { ok: errors.length === 0, errors };
  }

  /* ---------------- UI ---------------- */
  let runTimerStarted = null;
  let runOutcome = null; /* true | false | null */
  let selectedDist = null;
  let selectedMotion = 'hover';
  let tickId = null;

  function $(id) { return document.getElementById(id); }

  function isExample() { return !!state.example; }

  function markExample() {
    const on = isExample();
    const banner = $('exampleBanner');
    if (banner) banner.hidden = !on;
    document.querySelectorAll('#exampleResultsMark, #printExample').forEach(el => { if (el) el.hidden = !on; });
    document.documentElement.classList.toggle('has-example', on);
  }

  function applyTheme(theme) {
    const t = theme || localStorage.getItem(THEME_KEY) || 'dark';
    document.documentElement.classList.toggle('sun', t === 'sun');
    const btn = $('btnTheme');
    if (btn) {
      btn.textContent = t === 'sun' ? 'Night' : 'Sun';
      btn.setAttribute('aria-label', t === 'sun' ? 'Switch to Night theme' : 'Switch to Sun theme');
    }
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', t === 'sun' ? '#FFFFFF' : '#0B0D12');
  }

  function showTab(name) {
    const tab = ['plan', 'log', 'results'].includes(name) ? name : 'plan';
    document.querySelectorAll('.panel').forEach(p => { p.hidden = p.dataset.panel !== tab; });
    document.querySelectorAll('.tabs button').forEach(b => {
      b.setAttribute('aria-current', b.dataset.tab === tab ? 'page' : 'false');
    });
    if (location.hash !== '#' + tab) {
      try { history.replaceState(null, '', '#' + tab); } catch (e) { location.hash = tab; }
    }
    window.scrollTo(0, 0);
    if (tab === 'results') renderResults();
    if (tab === 'log') renderLog();
  }

  function fillMetaForm() {
    const m = state.meta || {};
    if ($('metaDate')) $('metaDate').value = m.date || todayIST();
    if ($('metaSite')) $('metaSite').value = m.site || '';
    if ($('metaPhones')) $('metaPhones').value = m.phones || '4';
    if ($('metaLayout')) $('metaLayout').value = m.layout || '';
    if ($('metaDrone')) $('metaDrone').value = m.drone || '';
    if ($('metaWeather')) $('metaWeather').value = m.weather || '';
    if ($('metaNotes')) $('metaNotes').value = m.notes || '';
    if ($('runDrone') && !$('runDrone').value) $('runDrone').value = m.drone || '';
    if ($('runWeather') && !$('runWeather').value) $('runWeather').value = m.weather || '';
  }

  function readMetaForm() {
    state.meta = {
      date: $('metaDate') ? $('metaDate').value : state.meta.date,
      site: $('metaSite') ? $('metaSite').value.trim() : state.meta.site,
      phones: $('metaPhones') ? $('metaPhones').value : state.meta.phones,
      layout: $('metaLayout') ? $('metaLayout').value.trim() : state.meta.layout,
      drone: $('metaDrone') ? $('metaDrone').value.trim() : state.meta.drone,
      weather: $('metaWeather') ? $('metaWeather').value.trim() : state.meta.weather,
      notes: $('metaNotes') ? $('metaNotes').value.trim() : state.meta.notes
    };
    save();
  }

  function currentDistance() {
    if (selectedDist === 'other') {
      const n = Number($('distOther').value);
      return isFinite(n) && n > 0 ? n : null;
    }
    return selectedDist == null ? null : Number(selectedDist);
  }

  function setDist(val) {
    selectedDist = val;
    document.querySelectorAll('#distChips button').forEach(b => {
      b.setAttribute('aria-pressed', String(b.dataset.dist === String(val)));
    });
    const wrap = $('otherDistWrap');
    if (wrap) wrap.hidden = val !== 'other';
  }

  function setMotion(val) {
    selectedMotion = val === 'flypast' ? 'flypast' : 'hover';
    document.querySelectorAll('#motionChips button').forEach(b => {
      b.setAttribute('aria-pressed', String(b.dataset.motion === selectedMotion));
    });
  }

  function setOutcome(val, ttdFromClock) {
    runOutcome = val;
    const lab = $('outcomeLabel');
    if (lab) {
      lab.className = 'outcome-label' + (val === true ? ' yes' : val === false ? ' no' : '');
      lab.textContent = val === true ? 'Detected' : val === false ? 'Missed' : 'Not set yet';
    }
    if (val === true && ttdFromClock != null && $('runTtd')) {
      $('runTtd').value = String(ttdFromClock);
    }
    if (val === false && $('runTtd')) $('runTtd').value = '';
  }

  function clockSec() {
    if (!runTimerStarted) return 0;
    return (Date.now() - runTimerStarted) / 1000;
  }

  function renderRunClock() {
    const el = $('runClock');
    if (!el) return;
    const s = clockSec();
    el.textContent = (Math.round(s * 10) / 10).toFixed(1) + ' s';
  }

  function activeSession() {
    if (!state.activeSessionId) return null;
    return (state.sessions || []).find(s => s.id === state.activeSessionId) || null;
  }

  function renderQuietClock() {
    const el = $('quietClock');
    const st = $('quietStatus');
    const sess = activeSession();
    const running = !!(sess && !sess.end);
    const last = running ? sess : (state.sessions || [])[(state.sessions || []).length - 1];
    if (el) el.textContent = last ? fmtClock(sessionSeconds(last)) : '00:00';
    if (st) {
      if (running) st.textContent = 'Session running — ' + settingLabel(sess.setting) + '. ' +
        (sess.alarms || []).length + ' false alarm' + ((sess.alarms || []).length === 1 ? '' : 's') + ' so far.';
      else if (last) st.textContent = 'Last session stopped. ' + fmtDur(sessionSeconds(last)) + ' logged.';
      else st.textContent = 'No session running.';
    }
    if ($('btnStartQuiet')) $('btnStartQuiet').disabled = running;
    if ($('btnStopQuiet')) $('btnStopQuiet').disabled = !running;
    if ($('btnLogFa')) $('btnLogFa').disabled = !running;
  }

  function startTicks() {
    if (tickId) return;
    tickId = setInterval(() => {
      if (runTimerStarted) renderRunClock();
      if (activeSession() && !activeSession().end) renderQuietClock();
      if (!runTimerStarted && !(activeSession() && !activeSession().end)) {
        clearInterval(tickId);
        tickId = null;
      }
    }, 200);
  }

  function ensureWritable() {
    if (!isExample()) return true;
    const ok = confirm('EXAMPLE data is loaded. Clear it and start a real log? Example numbers must not go into a brief.');
    if (!ok) return false;
    clearExample(true);
    return true;
  }

  function clearExample(silent) {
    state = defaultState();
    save();
    fillMetaForm();
    resetRunForm();
    markExample();
    renderAll();
  }

  function resetRunForm() {
    $('runId').value = '';
    setDist(null);
    setMotion('hover');
    runTimerStarted = null;
    runOutcome = null;
    setOutcome(null);
    renderRunClock();
    if ($('runTtd')) $('runTtd').value = '';
    if ($('runClass')) $('runClass').value = '';
    if ($('runAgree')) $('runAgree').value = '';
    if ($('runNotes')) $('runNotes').value = '';
    if ($('runVoid')) $('runVoid').checked = false;
    if ($('distOther')) $('distOther').value = '';
    if ($('runDrone')) $('runDrone').value = (state.meta && state.meta.drone) || '';
    if ($('runWeather')) $('runWeather').value = (state.meta && state.meta.weather) || '';
    if ($('btnSaveRun')) $('btnSaveRun').textContent = 'Save run';
  }

  function progressCounts() {
    const map = {};
    function slot(d, mot) {
      const k = d + ':' + mot;
      if (!map[k]) map[k] = { n: 0, k: 0 };
      return map[k];
    }
    const extras = [];
    for (const r of countedRuns(state)) {
      const d = Number(r.distance);
      if (!isFinite(d)) continue;
      if (!LADDER.includes(d) && !extras.includes(d)) extras.push(d);
      const mot = r.motion === 'flypast' ? 'flypast' : 'hover';
      const s = slot(d, mot);
      s.n++;
      if (r.detected) s.k++;
    }
    extras.sort((a, b) => a - b);
    return { map, distances: LADDER.concat(extras) };
  }

  function renderProgress() {
    const el = $('progress');
    if (!el) return;
    const { map, distances } = progressCounts();
    const cell = (d, mot) => {
      const s = map[d + ':' + mot] || { n: 0, k: 0 };
      const cls = s.n >= TARGET_N ? 'prog-ok' : (s.n ? 'prog-mid' : '');
      return '<td class="num ' + cls + '">' + s.k + '/' + s.n + ' of ' + TARGET_N + '</td>';
    };
    let html = '<table><thead><tr><th>Distance</th><th class="num">Hover</th><th class="num">Fly-past</th></tr></thead><tbody>';
    for (const d of distances) {
      html += '<tr><td>' + esc(fmtDist(d)) + '</td>' + cell(d, 'hover') + cell(d, 'flypast') + '</tr>';
    }
    html += '</tbody></table>';
    el.innerHTML = html;
  }

  function renderRunsList() {
    const el = $('runsList');
    const nEl = $('runCount');
    if (nEl) nEl.textContent = state.runs.length ? '(' + state.runs.length + ')' : '';
    if (!el) return;
    if (!state.runs.length) {
      el.innerHTML = '<p class="hint">No runs yet. Use the form to log the first one.</p>';
      return;
    }
    const rows = state.runs.slice().sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
    el.innerHTML = rows.map(r => {
      const cls = r.void ? 'void' : (r.detected ? 'yes' : 'no');
      const lab = r.void ? 'Void' : (r.detected ? 'Detected' : 'Missed');
      const ttd = r.detected && r.ttd != null && r.ttd !== '' ? ' · ' + fmtTtd(r.ttd) : '';
      const klass = r.classShown ? ' · ' + r.classShown : '';
      const agree = r.phonesAgree ? ' · ' + r.phonesAgree : '';
      const notes = r.notes ? '<small>' + esc(r.notes) + '</small>' : '';
      const ex = !!(r.example || state.example);
      return '<article class="row' + (ex ? ' example' : '') + '" data-run="' + esc(r.id) + '">' +
        '<div><b>' + esc(fmtDist(r.distance)) + ' · ' + esc(motionLabel(r.motion)) + '</b>' + exTag(ex) +
        ' <span class="pill ' + cls + '">' + lab + '</span></div>' +
        '<small>' + esc(r.drone || '') + ttd + esc(klass) + esc(agree) + ' · ' + esc(fmtWhen(r.ts)) + '</small>' +
        notes +
        '<div class="row-actions"><button type="button" data-edit-run="' + esc(r.id) + '">Edit</button>' +
        '<button type="button" data-del-run="' + esc(r.id) + '">Delete</button></div></article>';
    }).join('');
  }

  function renderQuietList() {
    const el = $('quietList');
    const nEl = $('quietCount');
    if (nEl) {
      const n = (state.sessions || []).length;
      nEl.textContent = n ? '(' + n + ')' : '';
    }
    if (!el) return;
    if (!(state.sessions || []).length) {
      el.innerHTML = '<p class="hint">No no-drone sessions yet.</p>';
      return;
    }
    const now = Date.now();
    el.innerHTML = state.sessions.slice().reverse().map(s => {
      const sec = sessionSeconds(s, now);
      const running = !s.end && s.id === state.activeSessionId;
      const alarms = s.alarms || [];
      const ex = !!(s.example || state.example);
      const alarmHtml = alarms.map(a =>
        '<div class="row-actions" style="display:block;margin-top:6px">' +
        '<small><span class="pill no">False alarm</span> ' + esc(fmtWhen(a.ts)) +
        (a.classShown ? ' · ' + esc(a.classShown) : '') +
        (a.notes ? ' — ' + esc(a.notes) : '') + exTag(!!(a.example || ex)) + '</small>' +
        '<button type="button" data-del-fa="' + esc(a.id) + '" data-sess="' + esc(s.id) + '">Delete alarm</button></div>'
      ).join('');
      return '<article class="row' + (ex ? ' example' : '') + '"><div><b>' +
        esc(settingLabel(s.setting)) + ' · ' + esc(fmtDur(sec)) + (running ? ' · running' : '') + '</b>' +
        exTag(ex) + '</div><small>' + esc(fmtWhen(s.start)) +
        (s.end ? ' – ' + esc(fmtWhen(s.end)) : ' – now') +
        ' · ' + alarms.length + ' false alarm' + (alarms.length === 1 ? '' : 's') +
        (s.notes ? ' · ' + esc(s.notes) : '') + '</small>' + alarmHtml +
        (running ? '' : '<div class="row-actions"><button type="button" data-del-sess="' + esc(s.id) + '">Delete session</button></div>') +
        '</article>';
    }).join('');
  }

  function renderLog() {
    renderProgress();
    renderRunsList();
    renderQuietList();
    renderQuietClock();
  }

  function chartSvg(rows, example) {
    if (!rows.length) return '<p class="hint">No counted runs yet.</p>';
    const W = 640, H = 260, L = 52, R = 16, T = 22, B = 40;
    const iw = W - L - R, ih = H - T - B;
    const xs = rows.map(r => r.d);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const span = Math.max(maxX - minX, 1);
    const xOf = d => L + ((d - minX) / span) * iw;
    const yOf = p => T + (1 - p) * ih;
    const y80 = yOf(PD_RELIABLE);
    let grid = '';
    for (const p of [0, 0.25, 0.5, 0.75, 1]) {
      const y = yOf(p);
      grid += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y + '" y2="' + y + '" stroke="currentColor" opacity=".15"/>' +
        '<text x="' + (L - 8) + '" y="' + (y + 4) + '" text-anchor="end" font-size="11" fill="currentColor" opacity=".7">' + (p * 100) + '%</text>';
    }
    let bars = '';
    const bw = Math.min(36, iw / (rows.length * 2.2));
    for (const r of rows) {
      const x = xOf(r.d);
      const y = yOf(r.p);
      const yLo = yOf(r.hi), yHi = yOf(r.lo);
      bars += '<rect x="' + (x - bw / 2) + '" y="' + y + '" width="' + bw + '" height="' + Math.max(0, yOf(0) - y) +
        '" fill="currentColor" opacity=".28"/>';
      bars += '<line x1="' + x + '" x2="' + x + '" y1="' + yLo + '" y2="' + yHi + '" stroke="currentColor" stroke-width="2"/>';
      bars += '<line x1="' + (x - 5) + '" x2="' + (x + 5) + '" y1="' + yLo + '" y2="' + yLo + '" stroke="currentColor" stroke-width="2"/>';
      bars += '<line x1="' + (x - 5) + '" x2="' + (x + 5) + '" y1="' + yHi + '" y2="' + yHi + '" stroke="currentColor" stroke-width="2"/>';
      bars += '<circle cx="' + x + '" cy="' + y + '" r="4.5" fill="var(--alert, #FF5A1F)" stroke="var(--surface)" stroke-width="1"/>';
      bars += '<text x="' + x + '" y="' + (H - 18) + '" text-anchor="middle" font-size="12" fill="currentColor">' + esc(String(r.d)) + '</text>';
    }
    const label = example ? '<text x="' + (W - R) + '" y="14" text-anchor="end" font-size="12" font-weight="800" fill="currentColor">EXAMPLE</text>' : '';
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Detection probability versus distance, with Wilson 95% intervals">' +
      label + grid +
      '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y80 + '" y2="' + y80 +
      '" stroke="currentColor" stroke-dasharray="6 5" stroke-width="1.5"/>' +
      '<text x="' + (W - R) + '" y="' + (y80 - 6) + '" text-anchor="end" font-size="11" fill="currentColor">80%</text>' +
      bars +
      '<text x="' + (L + iw / 2) + '" y="' + (H - 4) + '" text-anchor="middle" font-size="12" fill="currentColor" opacity=".8">Distance (m)</text>' +
      '</svg>';
  }

  function pdTableHtml(rows, example) {
    if (!rows.length) return '<p class="hint">No counted runs yet.</p>';
    let h = '<table><thead><tr><th>Distance</th><th class="num">Detected</th><th class="num">Pd</th><th class="num">Wilson 95%</th></tr></thead><tbody>';
    for (const r of rows) {
      h += '<tr class="' + (example ? 'example' : '') + '"><td>' + esc(fmtDist(r.d)) + exTag(example) +
        '</td><td class="num">' + r.k + '/' + r.n + '</td><td class="num">' + pct(r.p) +
        '</td><td class="num">' + pct(r.lo) + '–' + pct(r.hi) + '</td></tr>';
    }
    return h + '</tbody></table>';
  }

  function motionTableHtml(S) {
    if (!S.distances.length) return '<p class="hint">No counted runs yet.</p>';
    let h = '<table><thead><tr><th>Distance</th><th class="num">Hover</th><th class="num">Fly-past</th></tr></thead><tbody>';
    for (const d of S.distances) {
      const b = S.byDist[d];
      const cell = mot => {
        const m = b[mot];
        if (!m.n) return '—';
        const w = wilson(m.k, m.n);
        return m.k + '/' + m.n + ' · ' + pct(w.p);
      };
      h += '<tr class="' + (S.example ? 'example' : '') + '"><td>' + esc(fmtDist(d)) + exTag(S.example) +
        '</td><td class="num">' + cell('hover') + '</td><td class="num">' + cell('flypast') + '</td></tr>';
    }
    return h + '</tbody></table>';
  }

  function ttdTableHtml(S) {
    const ds = S.distances.filter(d => (S.ttdByDist[d] || []).length);
    if (!ds.length) return '<p class="hint">No time-to-detect figures yet (needs a detected run with a time).</p>';
    let h = '<table><thead><tr><th>Distance</th><th class="num">n</th><th class="num">Median</th><th class="num">Range</th></tr></thead><tbody>';
    for (const d of ds) {
      const a = S.ttdByDist[d];
      const med = median(a);
      h += '<tr class="' + (S.example ? 'example' : '') + '"><td>' + esc(fmtDist(d)) + exTag(S.example) +
        '</td><td class="num">' + a.length + '</td><td class="num">' + fmtTtd(med) +
        '</td><td class="num">' + fmtTtd(Math.min(...a)) + '–' + fmtTtd(Math.max(...a)) + '</td></tr>';
    }
    return h + '</tbody></table>';
  }

  function faBlockHtml(S) {
    if (S.quietSec <= 0) return '<p>No no-drone time has been logged, so a false-alarm rate is not estimated.</p>';
    const j = S.faInt;
    let h = '<p><b>' + esc(fmtDur(S.quietSec)) + '</b> of no-drone listening · <b>' + S.fa +
      '</b> false alarm' + (S.fa === 1 ? '' : 's') + '</p>';
    if (j) {
      h += '<p>Rate <b>' + esc(rateTxt(j.rate)) + '/h</b> (Jeffreys 95% ' +
        esc(rateTxt(j.lo)) + '–' + esc(rateTxt(j.hi)) + '/h)' + (S.example ? exTag(true) : '') + '</p>';
    }
    const sets = Object.keys(S.bySetting);
    if (sets.length) {
      h += '<table><thead><tr><th>Setting</th><th class="num">Time</th><th class="num">Alarms</th></tr></thead><tbody>';
      for (const k of sets) {
        const b = S.bySetting[k];
        h += '<tr class="' + (S.example ? 'example' : '') + '"><td>' + esc(settingLabel(k)) + exTag(S.example) +
          '</td><td class="num">' + esc(fmtDur(b.sec)) + '</td><td class="num">' + b.fa + '</td></tr>';
      }
      h += '</tbody></table>';
    }
    if (S.alarms.length) {
      h += '<ul>';
      for (const a of S.alarms) {
        h += '<li>' + esc(fmtWhen(a.ts)) + ' · ' + esc(settingLabel(a.setting)) +
          (a.classShown ? ' · ' + esc(a.classShown) : '') +
          (a.notes ? ' — ' + esc(a.notes) : '') + (a.example ? exTag(true) : '') + '</li>';
      }
      h += '</ul>';
    }
    return h;
  }

  function headlineHtml(S) {
    let rangeV = 'Not established';
    let rangeS = 'No tested distance reached 80% Pd';
    if (S.maxRange != null) {
      rangeV = fmtDist(S.maxRange);
      rangeS = 'Farthest mark with Pd ≥ 80% · ' + S.maxRow.k + '/' + S.maxRow.n + ' = ' + pct(S.maxRow.p);
    }
    const faV = S.quietSec > 0 && S.faInt ? rateTxt(S.faInt.rate) + '/h' : '—';
    let faS = S.quietSec > 0 && S.faInt
      ? 'Jeffreys 95% ' + rateTxt(S.faInt.lo) + '–' + rateTxt(S.faInt.hi) + '/h · ' + S.fa + ' in ' + fmtDur(S.quietSec)
      : 'Log a no-drone session first';
    if (S.quietSec > 0 && S.quietSec < 30 * 60) {
      faS += ' · keep listening — 30–60 min gives a tighter interval';
    }
    const evV = S.runsCounted + (S.runsCounted === 1 ? ' run' : ' runs');
    const evS = (S.runsVoid ? S.runsVoid + ' void · ' : '') + fmtDur(S.quietSec) + ' no-drone';
    const pdV = S.maxRow ? pct(S.maxRow.p) : (S.rows.length ? pct(S.rows[S.rows.length - 1].p) : '—');
    const pdS = S.maxRow ? 'at the reliable-range mark' : (S.rows.length ? 'at ' + fmtDist(S.rows[S.rows.length - 1].d) + ' (farthest tested)' : 'No Pd yet');
    const ex = S.example ? exTag(true) : '';
    return [
      ['Max reliable range', rangeV, rangeS],
      ['Pd at that mark', pdV, pdS],
      ['False alarms', faV, faS],
      ['Evidence logged', evV, evS]
    ].map(([k, v, s]) =>
      '<div class="stat"><p class="k">' + esc(k) + '</p><p class="v">' + esc(v) + ex + '</p><p class="s">' + esc(s) + '</p></div>'
    ).join('');
  }

  function renderPrint(S, summary) {
    const m = state.meta || {};
    const bits = [
      m.date ? fmtDate(m.date) : '',
      m.site || '',
      m.drone || '',
      m.phones ? m.phones + ' phones' : '',
      m.layout || '',
      m.weather || ''
    ].filter(Boolean);
    if ($('printMeta')) $('printMeta').textContent = bits.join(' · ') + (S.example ? ' · EXAMPLE data' : '');
    if ($('printChart')) $('printChart').innerHTML = chartSvg(S.rows, S.example);
    if ($('printPd')) $('printPd').innerHTML = pdTableHtml(S.rows, S.example);
    if ($('printHead')) {
      $('printHead').innerHTML = '<p><b>Max reliable range (Pd ≥ 80%):</b> ' +
        (S.maxRange != null ? esc(fmtDist(S.maxRange)) + ' · ' + S.maxRow.k + '/' + S.maxRow.n + ' = ' + pct(S.maxRow.p) : 'Not established') +
        (S.example ? exTag(true) : '') + '</p>' +
        (S.ttdAtMax ? '<p><b>Median time to detect at that range:</b> ' + fmtTtd(S.ttdAtMax.median) + '</p>' : '');
    }
    if ($('printFa')) $('printFa').innerHTML = faBlockHtml(S);
    if ($('printSummary')) $('printSummary').textContent = summary;
    if ($('printStamp')) {
      const now = new Date().toLocaleString('en-IN', {
        timeZone: 'Asia/Calcutta', day: 'numeric', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit', hour12: true
      }) + ' IST';
      $('printStamp').textContent = 'Prepared from the Rotor Ear field-day kit. Times in IST (Asia/Calcutta). Printed or saved ' + now + '.' +
        (S.example ? ' EXAMPLE data — not a real field day.' : '');
    }
    if ($('printExample')) $('printExample').hidden = !S.example;
  }

  function renderResults() {
    const S = analyse(state);
    const empty = !S.runsTotal && !(state.sessions || []).length;
    if ($('resultsEmpty')) $('resultsEmpty').hidden = !empty;
    if ($('resultsBody')) $('resultsBody').hidden = empty;
    markExample();
    if (empty) return;
    const summary = buildSummary(state, S);
    if ($('headlines')) $('headlines').innerHTML = headlineHtml(S);
    if ($('chart')) $('chart').innerHTML = chartSvg(S.rows, S.example);
    if ($('pdTable')) $('pdTable').innerHTML = pdTableHtml(S.rows, S.example);
    if ($('motionTable')) $('motionTable').innerHTML = motionTableHtml(S);
    if ($('ttdTable')) $('ttdTable').innerHTML = ttdTableHtml(S);
    if ($('faBlock')) $('faBlock').innerHTML = faBlockHtml(S);
    if ($('summary')) $('summary').textContent = summary;
    renderPrint(S, summary);
  }

  function renderAll() {
    markExample();
    renderLog();
    renderResults();
  }

  function loadExample() {
    if (!isExample() && (state.runs.length || state.sessions.length)) {
      const ok = confirm('Replace the current log with EXAMPLE data? Your real runs will be cleared from this phone.');
      if (!ok) return;
    }
    state = exampleState();
    save();
    fillMetaForm();
    resetRunForm();
    markExample();
    renderAll();
    showTab('results');
  }

  function saveRun(ev) {
    if (ev) ev.preventDefault();
    if (!ensureWritable()) return;
    const dist = currentDistance();
    if (dist == null) { alert('Pick a distance first.'); return; }
    if (!selectedMotion) { alert('Pick hover or fly-past.'); return; }
    const isVoid = $('runVoid').checked;
    if (runOutcome == null && !isVoid) { alert('Mark the run Detected or Missed, or tick Void if it was spoiled.'); return; }
    const id = $('runId').value || uid('run');
    const existing = state.runs.find(r => r.id === id);
    const ttdRaw = $('runTtd').value;
    const ttd = runOutcome === true && ttdRaw !== '' && isFinite(Number(ttdRaw)) ? Number(ttdRaw) : (runOutcome === true ? null : null);
    const rec = {
      id,
      ts: existing ? existing.ts : new Date().toISOString(),
      distance: dist,
      drone: ($('runDrone').value.trim() || (state.meta && state.meta.drone) || ''),
      motion: selectedMotion,
      weather: ($('runWeather').value.trim() || (state.meta && state.meta.weather) || ''),
      detected: runOutcome === true,
      ttd: runOutcome === true ? ttd : null,
      classShown: $('runClass').value,
      phonesAgree: $('runAgree').value.trim(),
      notes: $('runNotes').value.trim(),
      void: isVoid,
      example: false
    };
    if (existing) {
      const i = state.runs.findIndex(r => r.id === id);
      state.runs[i] = rec;
    } else state.runs.push(rec);
    save();
    resetRunForm();
    renderLog();
  }

  function editRun(id) {
    const r = state.runs.find(x => x.id === id);
    if (!r) return;
    $('runId').value = r.id;
    if (LADDER.includes(Number(r.distance))) {
      setDist(String(Number(r.distance)));
    } else {
      setDist('other');
      $('distOther').value = String(r.distance);
    }
    setMotion(r.motion);
    $('runDrone').value = r.drone || '';
    $('runWeather').value = r.weather || '';
    setOutcome(r.void ? null : !!r.detected);
    if (r.void) {
      $('outcomeLabel').className = 'outcome-label void';
      $('outcomeLabel').textContent = 'Void / spoiled';
    }
    $('runTtd').value = r.ttd != null ? String(r.ttd) : '';
    $('runClass').value = r.classShown || '';
    $('runAgree').value = r.phonesAgree || '';
    $('runNotes').value = r.notes || '';
    $('runVoid').checked = !!r.void;
    $('btnSaveRun').textContent = 'Save changes';
    $('runForm').scrollIntoView({ block: 'start' });
  }

  function deleteRun(id) {
    const r = state.runs.find(x => x.id === id);
    if (!r) return;
    if (isExample() && !ensureWritable()) return;
    if (!confirm('Delete the ' + fmtDist(r.distance) + ' ' + motionLabel(r.motion) + ' run?')) return;
    state.runs = state.runs.filter(x => x.id !== id);
    save();
    if ($('runId').value === id) resetRunForm();
    renderLog();
  }

  function startRunTimer() {
    if (!ensureWritable()) return;
    runTimerStarted = Date.now();
    renderRunClock();
    startTicks();
  }

  function finishRun(detected) {
    if (!ensureWritable()) return;
    const ttd = runTimerStarted ? Math.round(clockSec() * 10) / 10 : null;
    runTimerStarted = null;
    renderRunClock();
    setOutcome(detected, detected ? ttd : null);
  }

  function startQuiet() {
    if (!ensureWritable()) return;
    if (activeSession() && !activeSession().end) return;
    const sess = {
      id: uid('sess'),
      start: new Date().toISOString(),
      end: null,
      seconds: 0,
      setting: $('quietSetting').value || 'quiet',
      notes: $('quietNotes').value.trim(),
      alarms: [],
      example: false
    };
    state.sessions.push(sess);
    state.activeSessionId = sess.id;
    save();
    renderQuietClock();
    renderQuietList();
    startTicks();
  }

  function stopQuiet() {
    const sess = activeSession();
    if (!sess || sess.end) return;
    sess.end = new Date().toISOString();
    sess.seconds = Math.round(sessionSeconds(sess, Date.parse(sess.end)));
    state.activeSessionId = null;
    save();
    $('faForm').hidden = true;
    renderQuietClock();
    renderQuietList();
  }

  function openFaForm() {
    if (!ensureWritable()) return;
    if (!activeSession() || activeSession().end) return;
    $('faWhen').textContent = fmtWhen(new Date().toISOString());
    $('faClass').value = '';
    $('faNotes').value = '';
    $('faForm').hidden = false;
    $('faForm').dataset.ts = new Date().toISOString();
  }

  function saveFa(ev) {
    ev.preventDefault();
    if (!ensureWritable()) return;
    const sess = activeSession();
    if (!sess || sess.end) return;
    sess.alarms = sess.alarms || [];
    sess.alarms.push({
      id: uid('fa'),
      ts: $('faForm').dataset.ts || new Date().toISOString(),
      classShown: $('faClass').value,
      notes: $('faNotes').value.trim(),
      example: false
    });
    save();
    $('faForm').hidden = true;
    renderQuietClock();
    renderQuietList();
  }

  function deleteFa(sessId, faId) {
    if (isExample() && !ensureWritable()) return;
    const sess = state.sessions.find(s => s.id === sessId);
    if (!sess) return;
    if (!confirm('Delete this false alarm?')) return;
    sess.alarms = (sess.alarms || []).filter(a => a.id !== faId);
    save();
    renderQuietList();
    renderQuietClock();
  }

  function deleteSess(id) {
    if (isExample() && !ensureWritable()) return;
    if (state.activeSessionId === id) { alert('Stop the running session first.'); return; }
    if (!confirm('Delete this no-drone session and its false alarms?')) return;
    state.sessions = state.sessions.filter(s => s.id !== id);
    save();
    renderQuietList();
  }

  function fileBase() {
    const d = (state.meta && state.meta.date) || todayIST();
    return (state.example ? 'rotor-ear-field-day-EXAMPLE-' : 'rotor-ear-field-day-') + d;
  }

  function exportPayload() {
    return { ...state, exportedAt: new Date().toISOString(), app: 'rotor-ear-field-day', v: 1 };
  }

  function exportJson() {
    download(fileBase() + '.json', JSON.stringify(exportPayload(), null, 2), 'application/json');
  }

  function csvCell(v) {
    const s = v == null ? '' : String(v);
    if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function exportCsv() {
    const lines = [];
    const header = ['type', 'example', 'id', 'timestamp_ist_iso', 'distance_m', 'drone', 'motion', 'weather',
      'detected', 'time_to_detect_s', 'class_shown', 'phones_agree', 'void', 'notes',
      'session_setting', 'session_start', 'session_end', 'session_seconds'];
    lines.push(header.join(','));
    for (const r of state.runs) {
      lines.push([
        'run', r.example || state.example ? 'EXAMPLE' : '', r.id, r.ts, r.distance, r.drone, r.motion, r.weather,
        r.void ? '' : (r.detected ? 'yes' : 'no'), r.ttd == null ? '' : r.ttd, r.classShown, r.phonesAgree,
        r.void ? 'yes' : '', r.notes, '', '', '', ''
      ].map(csvCell).join(','));
    }
    for (const s of state.sessions) {
      lines.push([
        'session', s.example || state.example ? 'EXAMPLE' : '', s.id, s.start, '', '', '', '',
        '', '', '', '', '', s.notes, s.setting, s.start, s.end || '', sessionSeconds(s)
      ].map(csvCell).join(','));
      for (const a of s.alarms || []) {
        lines.push([
          'false_alarm', a.example || s.example || state.example ? 'EXAMPLE' : '', a.id, a.ts, '', '', '', '',
          'yes', '', a.classShown, '', '', a.notes, s.setting, s.start, s.end || '', ''
        ].map(csvCell).join(','));
      }
    }
    download(fileBase() + '.csv', lines.join('\n'), 'text/csv;charset=utf-8');
  }

  function download(name, text, mime) {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  async function copyJson() {
    const text = JSON.stringify(exportPayload(), null, 2);
    try {
      await navigator.clipboard.writeText(text);
      const b = $('btnCopyJson');
      if (b) { const t = b.textContent; b.textContent = 'Copied'; setTimeout(() => { b.textContent = t; }, 1500); }
    } catch (err) {
      prompt('Copy this JSON:', text);
    }
  }

  function printSheet() {
    renderResults();
    window.print();
  }

  function importJsonFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const raw = JSON.parse(reader.result);
        if (!raw || (raw.v !== 1 && raw.v == null)) throw new Error('Not a Rotor Ear field-day file (missing v:1).');
        if (!Array.isArray(raw.runs) && !Array.isArray(raw.sessions)) throw new Error('File has no runs or sessions.');
        if (state.runs.length || state.sessions.length) {
          if (!confirm('Replace the current log with the imported file?')) return;
        }
        state = normalize(raw);
        save();
        fillMetaForm();
        resetRunForm();
        renderAll();
        showTab('results');
      } catch (err) {
        alert('Could not import that file. ' + (err && err.message ? err.message : err));
      }
    };
    reader.readAsText(file);
  }

  function clearAll() {
    if (!confirm('Clear all field-day data on this phone? Exports already saved are not affected.')) return;
    if (!confirm('Really delete the runs, no-drone sessions and false alarms?')) return;
    state = defaultState();
    save();
    fillMetaForm();
    resetRunForm();
    renderAll();
  }

  function loadChecks() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(CHECK_KEY) || '{}') || {}; } catch (e) { saved = {}; }
    document.querySelectorAll('[data-check]').forEach(box => {
      box.checked = !!saved[box.getAttribute('data-check')];
      box.addEventListener('change', () => {
        const all = {};
        document.querySelectorAll('[data-check]').forEach(b => { all[b.getAttribute('data-check')] = b.checked; });
        try { localStorage.setItem(CHECK_KEY, JSON.stringify(all)); } catch (err) {}
      });
    });
  }

  function bind() {
    document.querySelectorAll('.tabs button, button[data-tab]').forEach(b => {
      b.addEventListener('click', () => showTab(b.dataset.tab));
    });
    $('btnTheme').addEventListener('click', () => {
      const next = document.documentElement.classList.contains('sun') ? 'dark' : 'sun';
      localStorage.setItem(THEME_KEY, next);
      applyTheme(next);
    });
    ['btnLoadExample', 'btnLoadExampleEmpty', 'btnLoadExamplePlan'].forEach(id => {
      const el = $(id);
      if (el) el.addEventListener('click', loadExample);
    });
    if ($('btnClearExample')) $('btnClearExample').addEventListener('click', () => {
      if (confirm('Clear the EXAMPLE data from this phone?')) clearExample();
    });
    $('metaForm').addEventListener('input', readMetaForm);
    $('metaForm').addEventListener('change', readMetaForm);
    $('distChips').addEventListener('click', ev => {
      const b = ev.target.closest('button[data-dist]');
      if (b) setDist(b.dataset.dist);
    });
    $('motionChips').addEventListener('click', ev => {
      const b = ev.target.closest('button[data-motion]');
      if (b) setMotion(b.dataset.motion);
    });
    $('btnStartRun').addEventListener('click', startRunTimer);
    $('btnDetected').addEventListener('click', () => finishRun(true));
    $('btnMissed').addEventListener('click', () => finishRun(false));
    $('runForm').addEventListener('submit', saveRun);
    $('btnResetRun').addEventListener('click', resetRunForm);
    $('runsList').addEventListener('click', ev => {
      const ed = ev.target.closest('[data-edit-run]');
      const del = ev.target.closest('[data-del-run]');
      if (ed) editRun(ed.getAttribute('data-edit-run'));
      if (del) deleteRun(del.getAttribute('data-del-run'));
    });
    $('btnStartQuiet').addEventListener('click', startQuiet);
    $('btnStopQuiet').addEventListener('click', stopQuiet);
    $('btnLogFa').addEventListener('click', openFaForm);
    $('faForm').addEventListener('submit', saveFa);
    $('btnCancelFa').addEventListener('click', () => { $('faForm').hidden = true; });
    $('quietList').addEventListener('click', ev => {
      const df = ev.target.closest('[data-del-fa]');
      const ds = ev.target.closest('[data-del-sess]');
      if (df) deleteFa(df.getAttribute('data-sess'), df.getAttribute('data-del-fa'));
      if (ds) deleteSess(ds.getAttribute('data-del-sess'));
    });
    $('btnExportJson').addEventListener('click', exportJson);
    $('btnExportCsv').addEventListener('click', exportCsv);
    $('btnCopyJson').addEventListener('click', () => { copyJson(); });
    $('btnPrint').addEventListener('click', printSheet);
    $('btnClearAll').addEventListener('click', clearAll);
    $('importFile').addEventListener('change', ev => {
      const f = ev.target.files && ev.target.files[0];
      if (f) importJsonFile(f);
      ev.target.value = '';
    });
    window.addEventListener('hashchange', () => showTab((location.hash || '#plan').slice(1)));
  }

  function boot() {
    if (!document.querySelector('[data-panel="plan"]')) return;
    const check = selfCheck();
    if (!check.ok) {
      console.error('Rotor Ear field-day self-check failed:', check.errors);
    }
    applyTheme();
    load();
    bind();
    loadChecks();
    fillMetaForm();
    setMotion('hover');
    setOutcome(null);
    renderAll();
    showTab((location.hash || '#plan').slice(1) || 'plan');
    if (activeSession() && !activeSession().end) startTicks();
  }

  return {
    wilson, jeffreysRate, gammaP, invGammaP, analyse, exampleState, defaultState,
    buildSummary, selfCheck, LADDER, boot,
    getState: () => state,
    setState: (s) => { state = normalize(s); save(); }
  };
});
