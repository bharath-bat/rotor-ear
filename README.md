# Rotor Ear

Passive, listen-only drone rotor-sound detector prototype. It uses the microphone and Web Audio to look for a steady blade-pass hum and its overtones. It never transmits, and it never sends audio anywhere.

Open the GitHub Pages site on a phone: [https://bharath-bat.github.io/rotor-ear/](https://bharath-bat.github.io/rotor-ear/).

## Watch post (the main page)

One mobile screen, top to bottom:

- **Status banner**: state (QUIET / SOMETHING / DRONE / NOT A DRONE), class label and confidence, plus a **🎓 mine** badge when your taught samples decided the label.
- **Map**:
  - **Solo**: just this phone. One phone can't tell direction, so it shows rings for how strongly it hears rotors, and in/out arrows for *approaching* (getting louder) or *moving away*.
  - **With phones**: pins for each phone, arrival-time lines that cross at the drone, and a red dot with the class label, trail and heading arrow.
- **Fingerprint hexagon** (six features) and a live **spectrogram** strip.
- **Detection timeline**: a row of entries such as `21:12 quad`.
- **Tap bar**:
  - **Listen**: start the mic.
  - **Teach**: a bottom sheet, also holding the Test sound and Analyse file.
  - **Phones: N**: create or join a room. This phone becomes the map, and other phones open the node link `mesh/#room=…&role=node`.
  - **Sim mode**: 4 fake phones and a fake drone on the same screen, with live accuracy numbers.

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

- `mesh/` has the standalone node, map and room pages.
- `mesh/sim.html` simulates phones over the real relay. You can set the clock offset (±400 ms / ±3 s), timing jitter and mic-latency spread.

**Honest accuracy.** Sound travels 34 cm per millisecond, and with phones 6 m apart the largest time difference is about 17 ms. Arrival times only help if each phone's timing is known to about 1 ms:

- The clock offset is fine: the sync removes it, and in the sim ±3 s of offset made no difference.
- The killer is the **unknown and varying microphone input latency** of each phone (OS and Bluetooth buffers, often tens of ms, and different for each model).
- The sim shows the effect. Once the latency spread exceeds a few ms, arrival times stop beating loudness.

So on real, uncalibrated phones expect loudness-level accuracy, a few metres inside the group of phones and much worse outside it. Arrival times need a per-phone latency calibration step first (for example, one shared clap or chirp). Everything here was tuned on synthetic sounds.

## Code

The code is plain JS:

- `detector.js`: detector and classifier, shared by all pages.
- `watch.js` / `watch.css`: the watch post.
- `mesh/core.js`: relay, clock sync, timing tap, MeshModel estimators, MapView, SimEngine.
- `mesh/envelope-worklet.js`: the envelope-peak timer.
- `mesh/mesh.js`: the standalone mesh pages.

Tests use Playwright Chromium with a fake mic: `pip install playwright numpy && playwright install chromium`, then:

- `python3 test/gen.py`: synthetic WAVs.
- `python3 test/run.py`: confusion table. `SAMPLES=test/wav/taught-samples.json` imports taught samples first.
- `python3 test/teach.py`: wrong before teaching, right after.
- `python3 test/mesh.py circle 4 45`: mesh accuracy over the PeerJS relay. It needs a static server on port 5311, for example `python3 -m http.server 5311`.

Serve this repository from the `main` branch root (GitHub Pages). `.nojekyll` keeps Pages from running Jekyll.
