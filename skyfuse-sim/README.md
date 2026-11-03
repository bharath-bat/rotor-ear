# SkyFuse sim

Browser simulator of a **passive**, multi-sensor drone-detection fusion system over a 3 km × 3 km area. Plain HTML/JS/canvas, no build step, works on phones (touch, small screens).

**Passive only:** every sensor in the model only receives. Nothing transmits at the drone, nothing is jammed or decoded. Ranges are rough model estimates, not measurements.

## What it models
- **Sound grid** (16 nodes, 500 m apart): drone blade-pass ladder (f0 + harmonics) minus spherical spreading (20·log10 r), air absorption and ground/turbulence excess loss, against mic hiss + scene noise + wind + a passing jet's broadband roar. Each node synthesises a spectrum and runs **Rotor Ear's harmonic-comb detector** (ported from `rotor-ear/detector.js`: local floor, ±2.5 % peak search, fundamental + low-harmonic rule, 9 dB hit threshold). Upgrades: low-noise mic, dish (+9 dB in its beam), 4-mic ring (+6 dB, bearing ±8°, partial jet rejection), 8 m poles, 3 s listening, ESP32-S3 classifier (6 dB threshold).
- **RF listener** (3 towers): received power of the drone's 2.4/5.8 GHz link with free-space path loss + clutter vs a scene noise floor. Signal strength + coarse bearing only, never decoded. City WiFi makes occasional false blips.
- **Remote ID** (same towers): public broadcast heard within ~1 km (700 m in the city) when the drone broadcasts.
- **Thermal camera**: 7° view on a pan-tilt; patrols until fusion cues it, then slews (30°/s). Range by drone size.
- **Vibration sensor**: only big, low drones almost overhead.
- **Fusion**: per-sense log-odds evidence (capped so RF alone can't raise the alarm), decay over time, gating of reports that don't fit the track, a single-target track, and the cue → localise → confirm hand-off.
- **What happens next**: when fusion crosses 95 %: alert (phone notification mock), camera records, evidence log builds (downloadable JSON), and a checklist (cover, police 112, DGCA Digital Sky). Legal, non-kinetic steps only.

Assumptions and numbers are commented in `physics.js`.
