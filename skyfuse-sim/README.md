# SkyFuse sim

Browser simulator of a **passive**, multi-sensor drone-detection fusion system over a 3 km × 3 km area. Plain HTML/JS/canvas, no build step, works on phones (touch, small screens).

**Passive only:** every sensor in the model only receives. Nothing transmits at the drone, nothing is jammed or decoded. Ranges are rough model estimates, not measurements.

## New: weather (wind, dust, rain, hot/cold days and nights)
The **Weather** panel has wind speed (0–15 m/s) and direction, dust/haze (none, light, heavy), rain (none, drizzle, heavy) and temperature & time of day (cold night 15 °C, mild night 21 °C, mild day 27 °C, hot day 38 °C, a Bangalore-style range). It also has four presets: *Clear cold night, Hot afternoon, Monsoon rain, Dusty windy day*. The **Weather impact** readout shows each sensor's estimated range against a clear mild day (2 m/s wind, no dust or rain, 27 °C) in the same scene. Every number below is a **rough, commented estimate** (see `physics.js`, "weather" section) meant for teaching. None of it is a measurement.

- **Sound** (the biggest effect)
  - Wind noise at the mic: about 20·log10(v) dB, mostly below 200 Hz, with a fur windshield assumed. It rises faster above 8 m/s.
  - Wind carries sound farther downwind (up to −5 dB of loss) and leaves an upwind shadow (up to +15 dB).
  - Air absorption changes with humidity and temperature: dry, hot air absorbs more at high frequencies.
  - On a hot day, sound bends upward (about +10 dB of extra loss at range, less on 8 m poles) and heat shimmer makes the signal fade.
  - On a calm cold night, an inversion bends sound back down (about −8 dB). Wind or rain weakens this.
  - Rain hiss adds about 12 dB of broadband noise in drizzle and 27 dB in heavy rain, and a little more with the dish.
  - Dust has only a small effect.
- **RF / Remote ID:** heavy rain costs about 0.15 dB/km at 5.8 GHz and almost nothing at 2.4 GHz, plus a few dB for wet foliage and surroundings. Dust is negligible.
- **Thermal camera:** range ×1.3 on a cold night, ×1.15 on a mild night and ×0.65 on a hot day (warm background, low contrast). Rain gives ×0.7 or ×0.4 and dust ×0.8 or ×0.45.
- **Vibration:** gusts above 8 m/s and drumming rain cause false shakes. They are logged as "probably wind/rain" and only add weak evidence.
- **The drone:** in wind and rain, small craft wobble off their path and run their motors up to about 3 dB louder.

Weather changes apply live. A preset restarts the flight and explains its effect in a callout. Tour card 7 also covers weather.

## New: real map & GPS
- **Plain grid / Street map** toggle. The street map uses OpenStreetMap raster tiles (`tile.openstreetmap.org`) with the "© OpenStreetMap contributors" credit. It uses plain JS Web-Mercator tile math, with no libraries, API keys or satellite imagery, and is meant for light demo use under the OSM tile policy. If the tiles can't load (offline, blocked), the map quietly falls back to the grid.
- **Centre:** Indiranagar, Bangalore (12.9719 N, 77.6412 E) by default. You can search for a place (one Nominatim request, only when you press the search button) or tap **Use my location**, which uses the browser's geolocation only on that tap. Your location is not stored or sent anywhere.
- **Coordinates:** every sensor and the drone have lat/lon, using a flat local approximation that is fine for 3 km, and the 3×3 km model stays to scale. Dragging a sensor updates its GPS. The event log and the evidence report (centre, sensors, track points, first detection by each sense) include lat/lon.
- **No-fly hint:** a faint dashed ring marks about 5 km around HAL Airport (about 12.9499 N, 77.6682 E), labelled "approx, check Digital Sky". It is a hint, not an official zone map.

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

## Engine v2 (quanta spec) — progress
- **Fusion engine toggle**: Pd/Pfa likelihood-ratio blender (new, default) vs the old hand-set weights; both run side by side, the card shows both confidences and the per-sense evidence.
- **No-drone log** (spec f, JSONL schema v1): 1 Hz records per sound post / RF tower / camera, weather every 10 s, sys events. *Mark quiet session* certifies no-drone time and auto-cancels if Remote ID or a confirmed track appears. *Fit false-alarm rates* runs `fitPfa` (Jeffreys CI, n_eff from autocorrelation) per weather/day bin; *Use fitted rates* loads bins with ≥ 1 h effective looks into `sensorModel`. *⬇ JSONL* downloads the log.
- Hardware assumptions: ESP32-S3 nodes with PSRAM (8 s raw audio ring per mic for GCC-PHAT on request), GPS PPS on every node (TDOA on by default), hub T/RH sensor (`soundSpeed`).
- New pure functions: core.js `parseLog, fitPfa, thresholdForPfa, loadPfaTable, sensorModel, newBlendState, lrBlend`; physics.js `soundSpeed`; track.js (`SkyTrack`) `fitSampleClock`.

### Steps 3–5: ADS-B, multi-target tracker, multi-drone (uncommitted → committed in this batch)
- ✈ ADS-B receiver (receive only), 🌡 hub T/RH sensor, 🛰 GPS PPS/TDOA toggles, all on by default. ADS-B only scales sound/thermal evidence (adsbExplain); never radio, Remote ID or a camera 'drone'. "No ADS-B" share setting (default 20 %).
- Tracker: NCV EKF per track, GNN (Hungarian, pitch-signature cost), initiation from pitch-matched crossing bearings or RID/thermal positions, M-of-N 3/5 confirm, deletion rules, TDOA updates when PPS is on, one LR blender per track with miss evidence, p_any. 95 % ellipses on the map (dashed = tentative).
- Alarm rule with the tracker: max(p_any, one-blender p) — a far drone heard by one post makes no track yet, and the strict p_any rule cost 200–500 m of alarm range.
- Drones 1–20, spread or swarm (5 × 4 at 30 m), 🐝 Swarm of 20 preset. Scoreboard in summary().track (one-to-one Hungarian, 150 m).
- Limit: a 30 m swarm is not resolvable by sound bearings; it shows as 4–5 group tracks.
