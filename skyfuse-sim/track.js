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

  g.SkyTrack = { fitSampleClock };
  if (typeof module !== 'undefined' && module.exports) module.exports = g.SkyTrack;
})(typeof window !== 'undefined' ? window : globalThis);
