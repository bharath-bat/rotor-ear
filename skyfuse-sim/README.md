# SkyFuse sim

Browser simulator of a **passive**, multi-sensor drone-detection fusion system over a 3 km × 3 km area. Plain HTML/JS/canvas, no build step, works on phones (touch, small screens).

**Passive only:** every sensor in the model only receives. Nothing transmits at the drone, nothing is jammed or decoded. Ranges are rough model estimates, not measurements.

## New: pick what flies in, slow mode, guided tour

- **What's flying in?** Pick a toy drone, small quad (DJI Mini class), large quad, fixed-wing, FPV racer, or a decoy: bird, passing jet or helicopter. You can also add a second object to the sky. Each one has its own sound signature, radio and Remote ID behaviour, thermal size, speed, height and map icon.
- **How decoys are rejected:**
  - Bird: a lone high chirp with no rotor ladder, no radio, and the thermal camera calls it a bird (this counts against a drone).
  - Jet: a broadband roar plus a turbine whine, with no ladder. Thermal calls it an aircraft.
  - Helicopter: it has a rotor ladder, but it is too dense (extra peaks between the rungs), so it is flagged as a big slow rotor and is not counted as a drone.
- **Speed:** Slow (1×, real time), Normal (8×) or Fast (30×). "Pause at key moments" stops the clock at the first radio blip, Remote ID, the first sound ladder, the alarm, the camera confirm and when a decoy is spotted. A callout on the map points at the sensor that fired.
- **How it works:** a 7-card guided tour. It flies a small quad with a jet passing and stops at each moment to explain it. The flight fast-forwards between moments. Every control has a "?" help button.

## What it models
- **Sound grid** (16 nodes, 500 m apart): drone blade-pass ladder (f0 + harmonics) minus spherical spreading (20·log10 r), air absorption and ground/turbulence excess loss, against mic hiss + scene noise + wind + a passing jet's broadband roar. Each node synthesises a spectrum and runs **Rotor Ear's harmonic-comb detector** (ported from `rotor-ear/detector.js`: local floor, ±2.5 % peak search, fundamental + low-harmonic rule, 9 dB hit threshold). Upgrades: low-noise mic, dish (+9 dB in its beam), 4-mic ring (+6 dB, bearing ±8°, partial jet rejection), 8 m poles, 3 s listening, ESP32-S3 classifier (6 dB threshold).
- **RF listener** (3 towers): received power of the drone's 2.4/5.8 GHz link with free-space path loss + clutter vs a scene noise floor. Signal strength + coarse bearing only, never decoded. City WiFi makes occasional false blips.
- **Remote ID** (same towers): public broadcast heard within ~1 km (700 m in the city) when the drone broadcasts.
- **Thermal camera**: 7° view on a pan-tilt; patrols until fusion cues it, then slews (30°/s). Range by drone size.
- **Vibration sensor**: only big, low drones almost overhead.
- **Fusion**: per-sense log-odds evidence (capped so RF alone can't raise the alarm), decay over time, gating of reports that don't fit the track, a single-target track, and the cue → localise → confirm hand-off.
- **What happens next**: when fusion crosses 95 %: alert (phone notification mock), camera records, evidence log builds (downloadable JSON), and a checklist (cover, police 112, DGCA Digital Sky). Legal, non-kinetic steps only.

Assumptions and numbers are commented in `physics.js`.
