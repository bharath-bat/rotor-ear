// Rotor Ear · tripwire lines: segments drawn on the map (metres in the phones' frame; lat/lon kept too when GPS anchored it).
// A track crossing a line = the drone's position moved firmly from one side to the other (> 0.45 m from the line on both
// ends, so jitter near the line doesn't fire) and the move passes through the drawn segment. "In" = toward the side the
// phones are on when the line was drawn (flip per line). Stored per room on this phone; the demo has its own lines.
(function () {
  'use strict';
  const FIRM = 0.45, ONLY = 'rotorear-trip-only';
  const side = (L, p) => (L.b[0] - L.a[0]) * (p[1] - L.a[1]) - (L.b[1] - L.a[1]) * (p[0] - L.a[0]); // > 0: left of a→b
  const dist = (L, p) => Math.abs(side(L, p)) / (Math.hypot(L.b[0] - L.a[0], L.b[1] - L.a[1]) || 1);
  // segments p→q and a→b: the crossing point or null
  function hit(p, q, a, b) {
    const r = [q[0] - p[0], q[1] - p[1]], s = [b[0] - a[0], b[1] - a[1]], d = r[0] * s[1] - r[1] * s[0]; if (Math.abs(d) < 1e-9) return null;
    const t = ((a[0] - p[0]) * s[1] - (a[1] - p[1]) * s[0]) / d, u = ((a[0] - p[0]) * r[1] - (a[1] - p[1]) * r[0]) / d;
    return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? [+(p[0] + t * r[0]).toFixed(2), +(p[1] + t * r[1]).toFixed(2)] : null;
  }
  let key = 'solo', lines = [];
  const load = () => { try { lines = JSON.parse(localStorage.getItem('rotorear-trip-' + key) || '[]'); } catch (e) { lines = []; } };
  const save = () => localStorage.setItem('rotorear-trip-' + key, JSON.stringify(lines));
  const Trip = {
    hit, side, dist, FIRM,
    use(k) { if (k !== key) { key = k; load(); } },
    get key() { return key; },
    get lines() { return lines; },
    get only() { return localStorage.getItem(ONLY) === '1'; },
    set only(v) { localStorage.setItem(ONLY, v ? '1' : '0'); },
    // a, b: [x, y] m; inside: a point on the "in" side (the phones' middle); ll: [[lat, lon], [lat, lon]] when GPS-anchored
    add(a, b, inside, ll) {
      const L = { id: 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 4), n: lines.reduce((m, x) => Math.max(m, x.n), 0) + 1, a: a.map(v => +v.toFixed(2)), b: b.map(v => +v.toFixed(2)), inS: 1, ll: ll || null };
      L.inS = inside && side(L, inside) < 0 ? -1 : 1; lines.push(L); save(); return L;
    },
    flip(id) { const L = lines.find(x => x.id === id); if (L) { L.inS = -L.inS; save(); } },
    remove(id) { lines = lines.filter(x => x.id !== id); save(); },
    name: L => 'Line ' + L.n,
    // GPS-anchored lines follow the street map if the metre frame moved
    refit(fromLatLng) { if (!fromLatLng) return; lines.forEach(L => { if (L.ll) { L.a = fromLatLng(L.ll[0][0], L.ll[0][1]).map(v => +v.toFixed(2)); L.b = fromLatLng(L.ll[1][0], L.ll[1][1]).map(v => +v.toFixed(2)); } }); },
    // per drone: st = {} kept by the caller; p = its newest position → crossings [{ line, pt, dir: 'in'|'out', head: [dx, dy] }]
    step(st, p) {
      const out = [];
      lines.forEach(L => {
        const s = side(L, p) > 0 ? 1 : -1, firm = dist(L, p) > FIRM, last = st[L.id];
        if (!firm) return;
        if (last && last.s !== s) { const pt = hit(last.p, p, L.a, L.b); if (pt) out.push({ line: L, pt, dir: s === L.inS ? 'in' : 'out', head: [p[0] - last.p[0], p[1] - last.p[1]] }); }
        st[L.id] = { s, p: p.slice() };
      });
      return out;
    },
  };
  window.RotorTrip = Trip;
})();
