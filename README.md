# Rotor Ear

Passive, listen-only drone rotor-sound detector prototype. It uses the microphone and Web Audio to look for a steady blade-pass hum and its overtones. It never transmits.

Open the GitHub Pages site on a phone: [https://bharath-bat.github.io/rotor-ear/](https://bharath-bat.github.io/rotor-ear/). Tap **Start listening**, or use **Test sound** to hear a synthetic rotor and watch the detector respond.

Serve this repository from the `main` branch root (GitHub Pages). `.nojekyll` keeps Pages from running Jekyll so `app.js` is published as-is.

## Phone Mesh Radar

Several phones listen together and plot a rough bearing on a shared map: [https://bharath-bat.github.io/rotor-ear/mesh/](https://bharath-bat.github.io/rotor-ear/mesh/). Have 3–4 phones join a room as listening nodes, and open the map on one of them. Only numbers are shared, never audio.

A single-browser demo of the same mesh is at [https://bharath-bat.github.io/rotor-ear/mesh/sim.html](https://bharath-bat.github.io/rotor-ear/mesh/sim.html).
