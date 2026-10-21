# Rotor Ear

Passive, listen-only drone rotor-sound detector prototype. It uses the microphone and Web Audio to look for a steady blade-pass hum and its overtones. It never transmits.

Open the GitHub Pages site on a phone: [https://bharath-bat.github.io/rotor-ear/](https://bharath-bat.github.io/rotor-ear/). Tap **Start listening**, or use **Test sound** to hear a synthetic rotor and watch the detector respond.

## Sound fingerprint

When the detector fires, Rotor Ear also fingerprints the sound and shows a label in the banner, for example **Quadcopter · 82%**. The radar chart on the page shows the six features it measures over about 2 seconds: pitch, rotor split (several close peaks around each harmonic), beating between rotors, pitch steadiness, sub-harmonic hum and 50/60 Hz lock. A nearest-centroid match against hand-set profiles picks one of Quadcopter, Fixed-wing, Micro drone or Not a drone. A confident "not a drone" (fans, AC, mains, engines) replaces DRONE NEARBY with NOT A DRONE. The profiles were tuned on synthetic sounds only, so treat the label as a hint.

The detector and classifier live in `detector.js`, shared by the main page and `mesh/`. To rerun the synthetic tests: `python3 test/gen.py && python3 test/run.py` (needs `pip install playwright numpy` and `playwright install chromium`).

Serve this repository from the `main` branch root (GitHub Pages). `.nojekyll` keeps Pages from running Jekyll so `app.js` is published as-is.

## Phone Mesh Radar

Several phones listen together and plot a rough bearing on a shared map: [https://bharath-bat.github.io/rotor-ear/mesh/](https://bharath-bat.github.io/rotor-ear/mesh/). Have 3–4 phones join a room as listening nodes, and open the map on one of them. Only numbers and the fingerprint label are shared, never audio. The map labels the drone dot with the class the agreeing nodes report.

A single-browser demo of the same mesh is at [https://bharath-bat.github.io/rotor-ear/mesh/sim.html](https://bharath-bat.github.io/rotor-ear/mesh/sim.html).
