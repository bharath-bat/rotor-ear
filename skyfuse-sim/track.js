// SkyFuse tracker: timing, Kalman filter, association and Doppler (quanta-engine-spec §c, §d). Pure functions, no DOM.
// Coordinates: ENU metres (x east, y north, z up), angles in radians, azimuth clockwise from north. sim.js converts (y_sim = -y).
// Hardware assumed (owner): ESP32-S3 nodes with PSRAM keep an 8 s raw 24-bit PCM ring per mic, served on request for hub GCC-PHAT;
// every node has GPS PPS (cross-node TDOA on by default); the hub has a T/RH sensor feeding soundSpeed().
(function (g) {
  'use strict';

  // ---------- c.3b PPS-disciplined sample clock ----------
  // edges: [{n: fractional sample index at the PPS edge, t: GPS second}]. Least-squares line over the last <=10 edges
  // (suppresses capture jitter); returns the fitted rate and t(n). Centred sums keep precision with t ~ 1.8e9 s.
  function fitSampleClock(edges) {
    const E = edges.slice(-10), m = E.length; if (m < 2) return null;
    const t0 = E[0].t, n0 = E[0].n; let sn = 0, st = 0; for (const e of E) { sn += e.n - n0; st += e.t - t0; } const mn = sn / m, mt = st / m;
    let sxx = 0, sxy = 0; for (const e of E) { const dn = e.n - n0 - mn, dt = e.t - t0 - mt; sxx += dn * dn; sxy += dn * dt; }
    const slope = sxy / sxx, fs = 1 / slope;                                  // seconds per sample -> Hz
    return { fs, t: n => t0 + mt + (n - n0 - mn) * slope };
  }


  // ---------- small dense matrix helpers ----------
  const zeros = (r, c) => Array.from({ length: r }, () => new Array(c).fill(0));
  const eye = n => { const m = zeros(n, n); for (let i = 0; i < n; i++) m[i][i] = 1; return m; };
  const T = A => A[0].map((_, j) => A.map(r => r[j]));
  const mm = (A, B) => A.map(r => B[0].map((_, j) => r.reduce((s, v, k) => s + v * B[k][j], 0)));
  const add = (A, B) => A.map((r, i) => r.map((v, j) => v + B[i][j]));
  const sub = (A, B) => A.map((r, i) => r.map((v, j) => v - B[i][j]));
  function inv(A) { const n = A.length, M = A.map((r, i) => r.concat(eye(n)[i]));
    for (let c = 0; c < n; c++) { let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r; [M[c], M[p]] = [M[p], M[c]];
      const d = M[c][c]; if (Math.abs(d) < 1e-300) throw new Error('singular'); for (let j = 0; j < 2 * n; j++) M[c][j] /= d;
      for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c]; if (f) for (let j = 0; j < 2 * n; j++) M[r][j] -= f * M[c][j]; } }
    return M.map(r => r.slice(n)); }
  function det(A) { const n = A.length, M = A.map(r => r.slice()); let d = 1;
    for (let c = 0; c < n; c++) { let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r; if (p !== c) { [M[c], M[p]] = [M[p], M[c]]; d = -d; }
      if (!M[c][c]) return 0; d *= M[c][c]; for (let r = c + 1; r < n; r++) { const f = M[r][c] / M[c][c]; for (let j = c; j < n; j++) M[r][j] -= f * M[c][j]; } }
    return d; }
  const sym = A => A.map((r, i) => r.map((v, j) => (v + A[j][i]) / 2));
  const wrap = a => { a = (a + Math.PI) % (2 * Math.PI); if (a < 0) a += 2 * Math.PI; return a - Math.PI; };
  const CHI2_99 = [0, 6.635, 9.210, 11.345, 13.277, 15.086, 16.812];            // χ²_m(0.99), m = 1..6
  const chi2Gate = (m, pg) => pg == null || pg === 0.99 ? CHI2_99[m] : m === 2 ? -2 * Math.log(1 - pg) : CHI2_99[m] * Math.log(1 - pg) / Math.log(0.01); // m=2 exact; else scaled approx

  // ---------- c.1 NCV Kalman filter, state [px py pz vx vy vz] ----------
  function kfInit(o) {
    const v = o.v || [0, 0, 0], sp = o.sp != null ? o.sp : 50, sv = o.sv != null ? o.sv : 15, P = zeros(6, 6);
    for (let i = 0; i < 3; i++) { P[i][i] = (Array.isArray(sp) ? sp[i] : sp) ** 2; P[i + 3][i + 3] = (Array.isArray(sv) ? sv[i] : sv) ** 2; }
    if (o.Ppos) for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) P[i][j] = o.Ppos[i][j];
    return { x: o.p.slice(0, 3).concat(v.slice(0, 3)), P, t: o.t || 0, hits: 0, misses: 0 };
  }
  function kfPredict(trk, dt, q, qz) {
    if (!(dt > 0)) return trk; q = q != null ? q : 2.0; qz = qz != null ? qz : 0.5;
    const F = eye(6); for (let i = 0; i < 3; i++) F[i][i + 3] = dt;
    const Q = zeros(6, 6); for (let i = 0; i < 3; i++) { const qq = i === 2 ? qz : q; Q[i][i] = qq * dt ** 3 / 3; Q[i][i + 3] = Q[i + 3][i] = qq * dt ** 2 / 2; Q[i + 3][i + 3] = qq * dt; }
    trk.x = F.map(r => r.reduce((s, v, k) => s + v * trk.x[k], 0)); trk.P = sym(add(mm(mm(F, trk.P), T(F)), Q)); trk.t = (trk.t || 0) + dt;
    return trk;
  }
  // measurement model: innovation nu, Jacobian H (m x 6), noise R (m x m)
  function model(trk, m) {
    const x = trk.x;
    if (m.type === 'bearing') {
      const s = m.s, dx = x[0] - s[0], dy = x[1] - s[1], dz = x[2] - (s[2] || 0), rho2 = Math.max(dx * dx + dy * dy, 1e-6), rho = Math.sqrt(rho2), r2 = rho2 + dz * dz;
      const nu = [wrap(m.az - Math.atan2(dx, dy))], H = [[dy / rho2, -dx / rho2, 0, 0, 0, 0]], Rd = [m.sAz ** 2];
      if (m.el != null && m.sEl) { nu.push(wrap(m.el - Math.atan2(dz, rho))); H.push([-dx * dz / (r2 * rho), -dy * dz / (r2 * rho), rho / r2, 0, 0, 0]); Rd.push(m.sEl ** 2); }
      const R = zeros(nu.length, nu.length); Rd.forEach((v, i) => R[i][i] = v); return { nu, H, R };
    }
    if (m.type === 'tdoa') {
      const p = x.slice(0, 3), d1 = p.map((v, i) => v - m.s1[i]), d2 = p.map((v, i) => v - m.s2[i]), r1 = Math.hypot(...d1), r2 = Math.hypot(...d2), c = m.c || 343;
      const g = d1.map((v, i) => (v / r1 - d2[i] / r2) / c);
      return { nu: [m.tau - (r1 - r2) / c], H: [g.concat([0, 0, 0])], R: [[m.sTau ** 2]] };
    }
    if (m.type === 'pos') {
      const H = zeros(3, 6); for (let i = 0; i < 3; i++) H[i][i] = 1;
      return { nu: m.z.map((v, i) => v - x[i]), H, R: m.R };
    }
    throw new Error('unknown measurement ' + m.type);
  }
  function gate(trk, meas, pg) {
    const { nu, H, R } = model(trk, meas), S = add(mm(mm(H, trk.P), T(H)), R), Si = inv(S);
    const d2 = nu.reduce((s, a, i) => s + a * nu.reduce((t, b, j) => t + Si[i][j] * b, 0), 0), gamma = chi2Gate(nu.length, pg);
    return { d2, gamma, ok: d2 <= gamma, S, lnDet: Math.log(det(S.map(r => r.map(v => v * 2 * Math.PI)))) };
  }
  // gated EKF update (Joseph form). meas.noGate skips the gate (e.g. RID position).
  function kfUpdate(trk, meas, pg) {
    const g = gate(trk, meas, pg); if (!g.ok && !meas.noGate) return { ok: false, d2: g.d2 };
    const { nu, H, R } = model(trk, meas), K = mm(mm(trk.P, T(H)), inv(g.S));
    trk.x = trk.x.map((v, i) => v + K[i].reduce((s, k, j) => s + k * nu[j], 0));
    const IKH = sub(eye(6), mm(K, H)); trk.P = sym(add(mm(mm(IKH, trk.P), T(IKH)), mm(mm(K, R), T(K))));
    return { ok: true, d2: g.d2 };
  }
  // c.7 horizontal uncertainty ellipse
  function ellipse(trk, conf) {
    const k = -2 * Math.log(1 - (conf != null ? conf : 0.95)), a = trk.P[0][0], b = trk.P[1][1], c = trk.P[0][1], m = (a + b) / 2, d = Math.sqrt(((a - b) / 2) ** 2 + c * c);
    return { a: Math.sqrt(k * (m + d)), b: Math.sqrt(k * Math.max(m - d, 0)), theta: 0.5 * Math.atan2(2 * c, a - b), sz: Math.sqrt(trk.P[2][2]) };
  }
  // c.6 GNN: Hungarian (Munkres, O(n^3)) on [cost | miss] — each row may take a column or its own miss column (missCost)
  function assign(cost, missCost) {
    const n = cost.length; if (!n) return []; const m = cost[0].length, N = n + m, BIG = 1e15, a = zeros(N, N);
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
      if (i < n && j < m) a[i][j] = Math.min(cost[i][j], BIG); else if (i < n) a[i][j] = j - m === i ? missCost : BIG; else a[i][j] = j < m ? 0 : 0;
    }
    // e-maxx Hungarian, 1-indexed potentials
    const u = new Array(N + 1).fill(0), v = new Array(N + 1).fill(0), p = new Array(N + 1).fill(0), way = new Array(N + 1).fill(0);
    for (let i = 1; i <= N; i++) { p[0] = i; let j0 = 0; const minv = new Array(N + 1).fill(Infinity), used = new Array(N + 1).fill(false);
      do { used[j0] = true; const i0 = p[j0]; let delta = Infinity, j1 = 0;
        for (let j = 1; j <= N; j++) if (!used[j]) { const cur = a[i0 - 1][j - 1] - u[i0] - v[j]; if (cur < minv[j]) { minv[j] = cur; way[j] = j0; } if (minv[j] < delta) { delta = minv[j]; j1 = j; } }
        for (let j = 0; j <= N; j++) if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta; j0 = j1; } while (p[j0] !== 0);
      do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0); }
    const out = new Array(n).fill(-1); for (let j = 1; j <= N; j++) { const i = p[j] - 1; if (i < n && j - 1 < m && cost[i][j - 1] < BIG && cost[i][j - 1] <= missCost) out[i] = j - 1; }
    return out;
  }

  g.SkyTrack = { fitSampleClock, kfInit, kfPredict, kfUpdate, gate, ellipse, assign, inv, det, wrap };
  if (typeof module !== 'undefined' && module.exports) module.exports = g.SkyTrack;
})(typeof window !== 'undefined' ? window : globalThis);
