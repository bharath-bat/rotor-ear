# Rotor Ear

Passive, listen-only drone rotor-sound detector prototype. It uses the microphone and Web Audio to look for a steady blade-pass hum and its overtones. It never transmits, and it never sends audio anywhere.

Open the GitHub Pages site on a phone: [https://bharath-bat.github.io/rotor-ear/](https://bharath-bat.github.io/rotor-ear/).

## One app, three modes

The link opens a start screen with three choices. Switching modes doesn't reload the page. Use ‹ Modes, ••• → Switch mode, or Back.

- **Be the screen** (`#screen`): the watch post below. It hosts a room (Phones → Create a room) that other phones join.
- **Be an ear** (`#ear`): this phone listens and sends numbers to a screen. Its join link is `?room=CODE`, which lands here. Without a code it asks for one.
- **Watch a demo** (`#demo`): the scripted 60 s demo on the screen. `#demo&room=CODE` instead runs simulated phones that report to that room's screen over the relay (the old simulator).

Old links and QR codes still work:

- `mesh/#room=R&role=node`, `mesh/#room=R` and `?room=R` open `#ear&room=R`.
- `role=map` and the old `#room=R` open `#screen&room=R`.
- `mesh/sim.html` opens `#demo`, keeping its settings.

## Watch post (Be the screen)

One mobile screen, top to bottom:

- **Status block**: a big icon + word, then one line each for what, where and how sure. The orange-red accent is used only for a confirmed drone.
  - **Ready** (not listening) → **Watching** (quiet; a slow breathing ring on this phone shows it is alive) → **Checking** (a harmonic hum, held 1.5 s before it can become a drone; dashed outline) → **DRONE** (solid fill) or **Not a drone** (e.g. "Fan / AC hum · ignored", back to Watching after 5 s).
  - **Got it** acknowledges a drone: the block stays filled, but the flash and beeps stop (tracking).
  - **Drone lost**: no rotor sound for 1 s. It shows "last seen X ago", where it was, a 60 s countdown and **Back to watching**. If it is heard again inside those 60 s it is the same drone, with no new alert.
  - Confidence is a word: *possible*, *likely* or *very likely*, plus "N of N phones agree". With fewer than 2 phones voting it never says more than *likely*. The one number (the match score against the class template) appears only in **Details**.
- **Map**: grey lettered phone pins, N ↑ and a 5 m scale bar.
  - **Solo**: one phone can't tell direction, so it shows rings for how strongly it hears rotors, and in/out arrows for approaching or moving away.
  - **With phones**: a triangle marker with heading arrow, an uncertainty ring and a flight chip (e.g. `Hovering · 5.4k rpm`, or `Loaded`; a load never raises an alert by itself). Arrival-time lines are faint and drawn only while a drone is confirmed, unless **Show workings** is on.
- **Peek card**: "Why we think so" and a mini spectrogram. Tap it to open **Details**: why, match score, flight card (30 s pitch sparkline, RPM, blade count), fingerprint hexagon, spectrogram, the timeline (episodes such as `21:37 Quadcopter 1:04 NE`, demo rows tagged DEMO) and Show workings.
- **Two big actions** for the current state (Got it / Mute 5 min, Back to watching / Details, Replay demo).
- **Bottom bar**: **Phones** (room, join link, clap calibration), a wide **Listen / Stop**, and **Teach** (also holds Test sound and Analyse file). Every tap target is at least 44 pt.
- **••• menu** (hidden during an alert): Night / Sun theme, Mute 5 min, Test sound, the 60 s demo and device notes (wake lock, vibration).
- **Sun theme**: white surface and darker accents for bright daylight. It is stored in `localStorage`.

## Demo

**Try the demo** (or ••• → Demo) plays a scripted 60 s scene on 4 simulated phones: 5 s of quiet, a fan near phone B that is ignored, a drone that approaches, climbs, hovers and leaves, then "Drone lost" and an end card. A permanent hatched **DEMO** stripe stays on the status block, the word reads **DEMO · DRONE**, the map is tagged and the marker hatched, the beep is a different, lower tone, and timeline rows are tagged DEMO. Simulated phones from `#demo&room=…` (named `sim …`) also count as demo.

## Alerts and stay-awake

- **Screen Wake Lock** while listening, re-acquired when the page becomes visible again. Browsers without it (iOS before 16.4) get a note in ••• that the screen may sleep. There is no silent-video trick.
- **On DRONE:** the block flashes 3 times and then stays filled (no endless pulse; reduced-motion skips the flash). A 2.4 / 1.8 kHz beep plays 3 times, then once every 10 s until **Got it**. The phone vibrates where `navigator.vibrate` exists (not iOS). Open sheets close, except Teach (you may be recording the drone on purpose). **Drone lost** plays one falling tone.
- **Mute 5 min** silences beeps only; the flash still works. The pill shows "MUTED · flash only · 4:59" and mute expires on its own.
- **The beep can't trigger the detector:** it is pure tones (rejected as a whistle), and detection pauses while it plays (about 1.1 s for the 3 beeps). `test/alert.py` checks this.

## Flight state and RPM

While a drone is heard, a tracker follows the smoothed fundamental f0, its rate of change (%/s) and the loudness trend:

- **Hovering**: steady pitch. The first steady 2.5 s becomes this drone's hover baseline.
- **Climbing / Descending**: pitch rising / falling faster than 0.8 %/s.
- **Heavy / loaded**: steady pitch more than 5 % above the hover baseline at similar loudness (within 4 dB).
- **Maneuvering**: pitch swinging up and down.
- **Passing by (Doppler)**: pitch falling while loudness peaks, or pitch falling while it has just got much louder.
- **RPM** = f0 × 60 / blades (2 blades by default).

Honest limits: one phone can't fully separate Doppler from throttle. A drone that descends while coming closer can look like a fly-by, and a constant-speed approach shifts pitch without any visible change. Thresholds were tuned on synthetic sounds.

## Sound fingerprint

When the detector fires, Rotor Ear fingerprints the sound over about 2 s. It measures six features:

- pitch
- rotor split (several close peaks around each harmonic)
- beating between rotors
- pitch steadiness
- sub-harmonic hum
- 50/60 Hz lock

Those features are matched against hand-set profiles to pick Quadcopter, Fixed-wing, Micro drone or Not a drone. A confident "not a drone" (fans, AC, mains, engines) replaces DRONE with NOT A DRONE. The hand-set profiles were tuned on synthetic sounds only.

## Teach mode

You can record about 5 s of a real sound (or a drone video played aloud) and tag it:

- Quadcopter, Fixed-wing or Micro drone.
- Not a drone: fan/AC, engine/bike, bird, voice or other.

Rules for taught samples:

- **What is saved:** only the 6 fingerprint numbers, in `localStorage`. If you choose to keep a clip, it stays in this browser's IndexedDB and is never uploaded or exported.
- **How labels are decided:** the classifier blends the hand-set profiles with your samples. Each sample is a narrow kernel, so it only affects sounds that really look like it.
- **Controls:** per-class counts, a "Use my samples" toggle, delete/reset, and JSON export/import (fingerprints only).
- **Caveat:** if a sound you teach is identical in these 6 numbers to a real class, teaching one will mislabel the other.

## Phone mesh: position from loudness + arrival times

Each phone sends about 8 times a second:

- confidence, pitch and harmonic band energy
- its fingerprint label
- the **times of rotor-envelope peaks**, from an AudioWorklet on a band-pass around the 3rd harmonic

That is numbers only, never audio. The map then works as follows:

- **Clock sync:** it syncs every phone's clock with NTP-style ping/pong through the relay, keeping the lowest round-trip of the last 12 samples.
- **Arrival times:** it matches the same envelope peak across phone pairs (median of about 10 peaks, roughly 1.3 s), giving a time difference for each pair. Each difference is a hyperbola ("bearing line"), and the lines cross at the drone.
- **Position:** it solves loudness-only (inverse-square), arrival-time-only and a fused fit. The fused fit is shown.
- **Arrows:** per-phone ▲ louder / ▼ quieter, and a heading arrow from Doppler (pitch differences between phones) plus loudness trends.

Pages:

- The screen is the map (`#screen&room=…`). Phones join as ears (`?room=…`).
- `#demo&room=…` simulates phones over the real relay. You can set the clock offset (±400 ms / ±3 s), timing jitter and mic-latency spread.

**Honest accuracy.** Sound travels 34 cm per millisecond, and with phones 6 m apart the largest time difference is about 17 ms. Arrival times only help if each phone's timing is known to about 1 ms:

- The clock offset is fine: the sync removes it, and in the sim ±3 s of offset made no difference.
- The killer is the **unknown and varying microphone input latency** of each phone (OS and Bluetooth buffers, often tens of ms, and different for each model).
- The sim shows the effect. Once the latency spread exceeds a few ms, arrival times stop beating loudness.

So on real, uncalibrated phones expect loudness-level accuracy, a few metres inside the group of phones and much worse outside it. Arrival-time fixes are only shown when they agree with loudness (within 2.5 m), unless every phone is calibrated.

### Clap calibration

Phones sheet → **Calibrate**. Every phone listens for a sharp onset (an AudioWorklet on the raw mic) and sends only its time (on the synced clock) and peak level.

- **Full:** clap next to each phone in turn. Per-phone latency and gain are solved by least squares with residuals shown in ms / dB.
- **Quick:** one clap next to a phone you pick. It is solved exactly, so there is no residual check.
- **Clap now** starts a 3 · 2 · 1 countdown. **Click from this phone** plays a loud click instead of a clap. Each phone row shows its residual as a bar plus a word (good under 3 ms, fair under 6 ms, redo above, with a Redo button).

Corrections are stored per room in `localStorage` and applied to event times and levels in the arrival-time and loudness fits. When all agreeing phones are calibrated with residuals under 3 ms, the loudness sanity gate is dropped. Limits: it assumes the clap is at the phone (30 cm ≈ 0.9 ms), a phone's latency must stay stable (Bluetooth or a route change breaks it, so recalibrate), and mics clip on a clap right next to them, so the level is taken from the other phones.

## Incident log

Every episode the screen sees is saved on that device (`localStorage`, newest 100): start and end time, class, peak match, phones agreeing, flight states seen and the track (one point every 0.5 s, in the phones' metre frame). "Not a drone" episodes are logged too.

- **Log sheet** (••• → Incident log, or Details → All incidents): one row per incident. Tap a row to replay its track on the map (sped up to about 12 s); ✕ stops it.
- **Export JSON** downloads the whole log. **Printable report** opens a one-page A4 summary (table with a small track drawing per incident) that prints cleanly to PDF.
- **Clear all…** asks first, and also deletes the clips on that device.
- An ear keeps its own short log: the incidents it was asked to look at, with its clips.

## Street map (optional)

Phones sheet → **Street map**. Each ear may tick **Share GPS position** (off by default, per phone). It then sends only its latitude/longitude with its other numbers, never audio. With at least one GPS phone the screen draws OpenStreetMap tiles (Leaflet, attribution shown) under the map:

- Positions still come from the metre-based solver. GPS only anchors the frame (the lowest-lettered GPS phone is the origin) and, with two or more GPS phones, turns it (a best-fit rotation, shown as "frame fit ±N m").
- One GPS phone: north is taken as up on the plan.
- No GPS, the demo, or failing tiles (offline, blocked host): the plain map, as before.
- The tile URL can be swapped with `window.ROTOREAR_TILES` before load. OSM tiles are fine for light use; for a busy deployment use your own tile server.

## Camera confirm

When the screen confirms a drone, it asks the ear nearest the estimate (that ear keeps the prompt for the incident): **Look this way**.

- With a street-map frame the prompt shows an arrow: the bearing from true north, turned by the phone's compass (`DeviceOrientation`; iPhone needs a **Use compass** tap). Without a compass the arrow is drawn with the top of the phone as north.
- Without GPS it says it in words relative to the other phones ("toward phone C · ~6 m away").
- **Record 10 s** opens the rear camera (video only, no sound) and saves the clip in that phone's IndexedDB, tagged with the incident id. Only a "clip saved" count goes to the screen, where the log shows 🎥.
- Clips can be played, downloaded or deleted in that phone's log. They never leave the phone unless you download them.

## Code

The code is plain JS:

- `app.js`: the start screen router (`#screen` / `#ear` / `#demo`) and old-link rewriting.
- `detector.js`: detector and classifier, shared by every mode.
- `watch.js`: the screen (watch post) and the scripted demo.
- `ear.js`: ear mode (with the look prompt, camera clip and the ear's log) and the relay demo phones.
- `log.js`: the incident log, JSON export, printable report, and clip storage (IndexedDB).
- `lib/leaflet.js`, `lib/leaflet.css`: Leaflet 1.9.4 (BSD-2), loaded only when the street map is shown.
- `watch.css`: all styles (Night and Sun).
- `mesh/core.js`: relay, clock sync, timing tap, MeshModel estimators, the GPS frame (`Geo`), MapView, SimEngine.
- `mesh/core.js` also holds the Calibrator. `detector.js` holds the FlightTracker.
- `mesh/envelope-worklet.js`: the envelope-peak timer and the clap-onset timer.
- `mesh/index.html` and `mesh/sim.html`: redirects only, for old links.

Tests use Playwright Chromium with a fake mic: `pip install playwright numpy && playwright install chromium`, then:

- `python3 test/gen.py`: synthetic WAVs.
- `python3 test/routes.py`: every mode and old URL lands in the right mode, with no console errors, and switching modes doesn't reload the page.
- `python3 test/run.py`: confusion table. `SAMPLES=test/wav/taught-samples.json` imports taught samples first.
- `python3 test/teach.py`: wrong before teaching, right after.
- `python3 test/flight.py`: flight-state table for hover / climb / descend / load / fly-by / maneuver WAVs.
- `python3 test/alert.py`: the alert flow: beep never triggers the detector, Checking → DRONE, flash ×3 then steady, repeat beep, Got it, mute with expiry, Drone lost and back, Lost → Watching, fan ignored, Loaded is not an alert.
- `python3 test/log.py`: an episode is saved with every field, the Log sheet lists it, tap replays, JSON export, the report prints to one A4 page, Clear all asks first.
- `python3 test/geo.py`: GPS frame math (round trips, rotation recovery, bearings, noisy GPS, one phone), then three ears sharing GPS: pins land on their GPS spots on the street map, and failing tiles or no GPS fall back to the plain map. Tiles are a local stub; `OSM=1` uses real OpenStreetMap tiles.
- `python3 test/camera.py`: with a fake camera, the nearest ear is asked to look, records a ~10 s clip into IndexedDB, the screen gets only the flag, and the ears' mesh messages stay small (no media).
- `python3 test/mesh.py circle 4 45 "&bias=30"`: mesh accuracy over the PeerJS relay. Add `CAL=full` or `CAL=quick` to calibrate in the sim and print before/after numbers. It needs a static server on port 5311, for example `python3 -m http.server 5311`.

Serve this repository from the `main` branch root (GitHub Pages). `.nojekyll` keeps Pages from running Jekyll.
