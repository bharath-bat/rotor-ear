# Rotor Ear

Passive, listen-only drone rotor-sound detector prototype. It uses the microphone and Web Audio to look for a steady blade-pass hum and its overtones. It never transmits, and it never sends audio anywhere.

Open the GitHub Pages site on a phone: [https://bharath-bat.github.io/rotor-ear/](https://bharath-bat.github.io/rotor-ear/).

## One app, three modes

The link opens a start screen with three choices. Switching modes doesn't reload the page. Use ‹ Modes, ••• → Switch mode, or Back.

- **Be the screen** (`#screen`): the watch post below. It hosts a room (Phones → Create a room) that other phones join.
- **Be an ear** (`#ear`): this phone listens and sends numbers to a screen. Its join link is `?room=CODE`, which lands here. Without a code it asks for one.
- **Watch a demo** (`#demo`): the scripted 60 s demo on the screen. `#demo&room=CODE` instead runs simulated phones that report to that room's screen over the relay (the old simulator).

The start screen also has **No internet? Use hotspot mode** (`#screen&net=hotspot`, `#ear&net=hotspot`). It's an extra option: the relay mode above stays the default. See [Hotspot mode](#hotspot-mode-no-internet).

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

**Two drones crossing** (••• → Demo) runs until you exit: two simulated drones on crossing diagonals, the second (higher-pitched) one arriving 10 s in with its own alert.

## Two drones at once

The detector looks for up to two separate harmonic combs. The strongest comb is found first; its harmonics (±4.5 %, covering all rotors of one drone) are masked out and the strongest comb left over becomes the second sound, if its pitch is more than 8 % away, it has its own fundamental and at least 3 of its first 4 harmonics (so the odd partials left over from one hum, e.g. 150 Hz from 50 Hz mains, are not a second sound). Each sound keeps its own id, pitch history, confidence, state, fingerprint class and flight state / RPM.

- **Mesh:** each phone sends its lead sound's numbers plus `s2` (the second sound's confidence, pitch, energy, state, class, flight). The map matches sounds across phones by pitch (±5 %) into up to two tracks, each with its own class vote, confidence, phones agreeing, position, trail and heading. Arrival times are timed on each phone's lead sound only, so the quieter drone is placed by loudness.
- **Screen:** the first drone is drawn in the usual alert colour, the second in blue (Night `#3DA9FC`, Sun `#0062C4`). With two drones the status block reads **2 DRONES** with one line each (colour dot, class and likelihood, where, phones agreeing). A new drone raises its own alert (flash, beeps, buzz, un-acknowledged); a drone that drops out and comes back at the same pitch (±8 %) within 60 s is the same drone.
- **Log:** each drone is its own incident; the second has a blue edge in the log and a blue track in the report.
- Limits: two drones within 8 % of each other in pitch read as one; a much quieter second drone is only heard by the phones near it.

## Why (not) a drone

Every decision comes with a short reason in plain words, built from the six fingerprint numbers (pitch, split, beat, steadiness, sub-harmonic, mains lock) and the nearest class:

- **Drone:** "Several rotors at slightly different speeds (split peaks) beating against each other, like a multirotor", "One propeller: a low, smooth pitch with little beat, like a fixed-wing", "High, whiny pitch from small rotors …, like a micro drone".
- **Not a drone:** "Pitch too steady and locked to 50 Hz mains, like a transformer or mains hum", "Pitch too steady: one motor at a fixed speed with no rotor beat, looks like a fan / AC", "Pitch sweeping up and down like a motorbike engine", "Low, irregular firing like an engine or generator", "Harmonics come and go and the pitch jumps around, more like a voice or bird", "A single pure tone …", "No harmonics, just broadband noise …", and "Close to sounds you taught as not a drone" when a taught sample matched.
- When no fingerprint forms, the reason comes from what the sound did over the last 3 s: how comb-like it is, how far the pitch jumps, low firing peaks (25–90 Hz) and peak spread.
- **Details** shows the reason with one small bar per feature: the shaded band is the drone range, the mark is this sound, a ✕ row is outside the range. A watching screen with an ignored hum shows **Why ignored** on the peek card.
- On a mesh the screen rebuilds the reason from the numbers an ear sends: its fingerprint, or a 7-number sound summary when it has none. Still no audio.
- The reason is saved with the incident (drone and not-a-drone) and printed in the report's What column.

## Height

During a pass the screen estimates how high the drone is from the phones on the ground (all at z = 0):

- Every 0.5 s it keeps a snapshot: each phone's loudness and, when trusted, the arrival-time differences. Each second it refits the last 20 s.
- For each candidate height 0–60 m, every snapshot gets its own best ground spot. Loudness ratios between phones and arrival times must fit within the snapshot. Across snapshots the source loudness must follow one straight line in time, so a fade isn't read as a climb. The height with the lowest total misfit wins.
- When the pass is fast enough (≥ 3 m/s, ≥ 3 Hz pitch swing, closest approach inside the window), a Doppler closest-approach fit per phone is mixed in by its own uncertainty.
- **Range:** the heights that fit about as well, widened by how many snapshots were really new looks (≥ 2 s and ≥ 1.5 m apart, so a hover doesn't fake a tight answer). It is never narrower than ±(25 % + 0.5 m), the model error seen in simulated passes.
- **Height unknown** instead of a number when the phones are in a line (they can't tell up from sideways), or when the range runs off the top or is wider than 60 % of the height (too high or too far for these phones).
- **Screen:** a small side-view strip (top right of the map) shows the ground, the phones, the drone at its height and its range, and "~N m up · likely lo–hi m" or "Height unknown · why". In the demo a dashed tick marks the true height.
- **Log:** track points carry z when it is known (`[s, x, y, z]`), the incident keeps the last known `h: {z, lo, hi}`, and the report has a Height column ("unknown" when it never was).
- The demo flies in at 4 m and climbs to 8 m at 26–30 s. `#demo&path=pass&alt=15&loud=20` flies straight passes at any height.
- Simulated results (6 m square of 4 phones, see `test/height.py`): 5 m is good, 15 m is often "unknown" and otherwise a few metres out, and 30 m is mostly "unknown". This needs real-world checks. Wind, reflections, rotor directivity and uneven mic gains all bend the loudness model.

## Linked watch posts

Two or more screens, each with its own room of ears, can link: Phones sheet → **Linked watch posts**, the same link code on each, and a name per post ("North", "Gate").

- Posts share only track numbers, twice a second: drone id, position, class, pitch, height if known, time. Never audio, never phone data. The first screen holds the link id on the PeerJS relay and passes messages on; if it leaves, another takes over.
- **Shared frame:** GPS (lat/lon) when both posts have a street-map frame. Otherwise each post types where it sits in a plan all posts agree on: **East m, North m, Turn °**.
- Each screen draws the other posts' drones faded, labelled with the post's name and drone id. The map tag shows who is linked ("North ⇄ South").
- **Hand-off:** when a new drone turns up at one post and another post had a drone in the last 20 s at a pitch within 8 %, at a place it could have flown from (≤ 15 m + 25 m/s × time), it keeps that drone's id. Both screens say so ("⇄ Hand-off from North: drone #mt3s" / "⇄ Drone #mt3s handed off to South"), and both incidents keep the one id (`gid`) with `from` / `to`, shown in the log and the report.
- `#demo&path=cross&ox=30` simulates a post 30 m east on a shared line: one drone (same pitch at every post) flies east and back at 3 m/s on the wall clock.

## Coverage map

Each phone measures its background noise in the drone band (the median local floor from 150 Hz to 2 kHz, 20th percentile over 3 s, refreshed every 2 s, only while it hears no harmonic sound unless one has gone on for 30 s) and turns it into a **hearing radius**: r = 10^((ref − noise − 12 dB) / 20), clamped to 2–300 m. The assumption, stated in the Phones sheet: a small quadcopter whose strongest harmonics are about 75 dB SPL at 1 m (−45 dBFS on a typical phone mic, −65 dB per bin in this analyser, where a full-scale sine reads about −20 dB), open ground and no wind (6 dB per doubling of distance), and the harmonics must stay 12 dB above the noise (the detector's 9 dB plus a margin). It is a rough guide, not a measured range.

- The screen draws a soft circle per phone (plain and street map) and shades everything outside all circles; Phones sheet → **Coverage circles** turns them off. Each phone row says "hears ~N m"; an ear shows its own range under its spectrogram.
- Only two numbers per phone are added to the messages: noise floor (dB) and radius (m).

## Field kit: label sounds

On an ear, during a detection and for 60 s after, a **Label this sound** card offers Quadcopter / Fixed-wing / Micro drone / Not a drone / Other (with a few words; counts as not a drone), optional notes, and an optional "keep 5 s of sound" (recorded from that moment, stored on that phone like a Teach clip). The fingerprint freezes once you pick a label.

- **Save** keeps the six fingerprint numbers + label as a Teach sample on that ear (its detector uses it at once) and sends only the numbers + label to the screen (`{t:'label'}`; never audio, never notes).
- The screen keeps a **session library** per room (Teach sheet): **Add all to Teach** makes them its own taught samples, **Export** writes the Teach file format.
- The ear lists its labelled sounds with play / delete, and exports / imports them in the Teach format (its own export keeps its notes).
- `samples.js` holds the shared sample store used by Teach and Label.

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
- Not a drone: fan/AC, engine/bike, bird, voice, not a drone, or other.

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

Every episode the screen sees is saved on that device (`localStorage`, newest 100): start and end time, class, the reason in words, peak match, phones agreeing, flight states seen, the track (one point every 0.5 s, in the phones' metre frame, with height when known) and the linked-post id and hand-off. "Not a drone" episodes are logged too.

- **Log sheet** (••• → Incident log, or Details → All incidents): one row per incident. Tap a row to replay its track on the map (sped up to about 12 s); ✕ stops it.
- **Export JSON** downloads the whole log. **Printable report** opens a one-page A4 summary (table with a small track drawing per incident) that prints cleanly to PDF.
- **Clear all…** asks first, and also deletes the clips on that device.
- An ear keeps its own short log: the incidents it was asked to look at, with its clips.

## Same drone again?

Each drone incident gets a voiceprint built from numbers the phones already measure: the median rotor pitch over about 4 s after the alert (8 samples), plus the mean of the six-feature fingerprint. It is kept on this phone only (`localStorage`, newest 200). No new audio is recorded.

- **Score 0–100.** Pitch closeness counts 65 % (0 at ±10 %) and fingerprint closeness (split, beat, steady, sub) counts 35 %. With pitch only, the score is capped at 90 %.
- **80 % or more: seen before.** The status block shows "Seen before · Drone #3 · last seen Tue 9:40 PM · 4 visits · 97% match", and a sure match refines the stored print.
- **60–79 %: possible match.** It reads "Possible match · Drone #3? · … · not sure".
- **Below 60 %: a new tag.** It reads "New drone · tagged Drone #4".
- **Drone tags sheet** (••• → Drone tags, or tap that line): name a tag, or **Forget** it after confirming. Log entries keep their note.
- **Log, JSON export and report:** the log row shows a chip (`new #4`, `#3? 72%`, `↺ #3 97%`), the printable report shows the sentence, and the JSON export includes `droneTags`.
- **Demo drones only ever match demo tags.**
- **Limits:** drones of one model sound alike, a throttle or payload change shifts the pitch, and tuning has only been done on synthetic sound.

## Tripwire

Draw lines on the map, then get told when a drone's position crosses one. The positions are the ones the phones already work out; nothing new is shared.

- **Draw a line:** tap **Tripwire** at the top left of the map (or ••• → Tripwire), then tap two points. This works on both the plain map and the street map; on the street map, lines keep their lat/lon. Lines are saved per room on this phone. The demo has its own lines, and its default line sits across the drone's way out.
- **"In"** is the side the phones were on when you drew the line. **Flip in/out** changes it, and **✕** deletes the line.
- **What counts as a crossing:** two consecutive track positions on opposite sides of the line, both more than 0.45 m from it, with the move between them passing through the drawn segment. Jitter near a line doesn't fire.
- **What a crossing shows:** a yellow line in the status block ("TRIPWIRE · Line 1 crossed OUT · heading SW · 10:59:24"), a ✕ on the map at the crossing point, and a fresh flash and beep. The crossing (point, direction, heading, time) also goes into the log row, the report and the JSON export (`trips`, plus `tripwires`).
- **Alert only on tripwire crossing** (in the Tripwire sheet): the drone is still shown and logged, but there is no flash and no beeps until it crosses a line. This setting only applies when at least one line exists.

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

## Bird or Bot

While the 10 s clip records, the ear phone also checks whether the thing in the sky is a bird or a drone. Everything runs in that phone's browser and the video never leaves it.

- **Find it**: each frame is shrunk to 160×120. The hand shake is measured from the background's edges and cancelled. Pixels that differ from a slowly learned sky are grouped into blobs, and the biggest one is followed (yellow box on the live picture).
- **How it moves**: wing beats make the blob's size and shape pulse at 2–20 Hz (an FFT of its area, height and height/width). Birds also glide in curves. Drones keep a steady size and hover or fly straight, because rotors are a blur at camera rate. With a shaky camera, a beat under 3 Hz doesn't count, since the hand makes thin shapes flicker at that pace.
- **What it looks like (optional)**: COCO-SSD (TensorFlow.js from jsDelivr, fetched when the phone is asked to look) gives a "bird" score on the blob crops. COCO has no drone class, so this only ever counts toward bird. If it can't load within 8 s, the card says "unavailable — motion only".
- **What the ear heard**: the share of the recording when this phone's detector said drone. Rotor hum counts toward Bot. Moving like a bird while a rotor hums gives "Can't tell".
- **Result**: **Bird**, **Bot** or **Can't tell**, with a confidence and a reason in plain words, for example "Wings beating ~6 times a second and no rotor hum — bird". The ear shows a card with the evidence row by row: wing beat, path, size, sound and image check.
- **The screen** gets only `{v, c, r, f, h, a}`: verdict, confidence, reason code, beats per second, hum yes/no/unknown and image score. It rebuilds the words itself. It shows a 🐦/🤖 chip on the drone status (and on each row when there are two drones), in the log and in the report. A confident bird (≥ 70%) changes the alert to **LIKELY A BIRD**, in calmer colours, and stops the repeat beeps. Nothing is dismissed: the drone stays on the map until you decide.
- **Saved clips**: **Re-analyse** (or **Bird or Bot?** on older clips) in the ear's log plays the clip off-screen and checks it again, using the sound result saved with it.

## Dropouts: ears keep listening and catch up

When an ear loses the screen (no clock ping for 3 s: Wi-Fi blip, relay down, phone walked out of range) it keeps detecting.

- It queues its numbers (telemetry, labels, clip and Bird-or-Bot flags), each with its own clock time and wall time. The queue keeps the newest 2400 messages (about 5 minutes at 8 per second). Clock pongs are never queued.
- It retries with backoff (1, 2, 4, 8, then every 15 s). If the relay itself went away it starts a fresh relay peer. Its status line says `offline 12 s · 96 queued · retrying in 4 s`.
- Once the screen answers again it sends the queue oldest first, 25 at a time, each chunk acked (resent after 2 s without an ack, duplicates skipped).
- The screen maps each late point onto its own clock with that ear's clock offset and merges it into the ear's timeline by time.
- The screen's status block shows a chip per ear: **Ear B offline 12 s** (counting up), then **Ear B back · syncing 40 points…**, then **Ear B back · synced 96 points** for 12 s. A drone an ear heard while offline becomes its own log entry, "heard by ear B while offline". It can't be placed on the map, because one phone gives no position.

Still numbers only: nothing in the queue is audio or video.

## Hotspot mode (no internet)

For a field with no signal. **One phone turns on hotspot, others join it, then scan codes.** It's opt-in from the start screen, the ear's join screen or the screen's Phones sheet. The relay mode stays the default.

- **Screen** (`#screen&net=hotspot`): Phones → **Add an ear** shows an offer QR (and the same text, to copy).
- **Ear** (`#ear&net=hotspot`): **Scan the screen's code** with the rear camera (or paste it). The ear then shows its answer QR.
- **Screen:** **Scan the ear's code** (or paste it) → Connect. Repeat Add an ear for each ear.

How it works:

- A WebRTC data channel per ear with **no signalling server, no STUN, no TURN**. Only host ICE candidates are used, so traffic stays on the hotspot's Wi-Fi.
- A code is only what the other side needs to rebuild the SDP: ICE ufrag and password, the DTLS fingerprint and up to 4 host candidates (mDNS `.local` names are packed too). That's about 100 characters, so it makes a small QR (`mesh/hotspot.js`).
- The same messages go over the channel as over the relay, so the map, log, tripwire, re-ID, camera confirm and the dropout catch-up all work the same.
- If the link drops, the ear keeps listening and queues, and offers **Pair again**. A fresh code pair replaces the old link and the queue catches up.
- The QR libraries are vendored: `lib/qrcode.min.js` (qrcode-generator 1.4.4, MIT) and `lib/jsQR.min.js` (jsQR 1.4.0, Apache-2.0, `lib/jsQR.LICENSE`). They load only in hotspot mode.
- **Offline app shell:** `sw.js` caches the app on the first online visit (network first, same-origin only), so the page and hotspot mode load later with no internet. Open the app once while online on every phone. A service worker needs HTTPS (or localhost).

Limits:

- Camera scanning needs HTTPS and a camera permission. Paste works everywhere.
- **iPhone:** Safari and every iOS browser (Chrome on iOS is WebKit) scan with jsQR from the camera, which works. WebRTC between phones on one hotspot generally works. Some iOS versions hide local addresses behind mDNS names that Android can't resolve, and some hotspots block traffic between clients (client isolation). In those cases the link doesn't open, and the app says so after 12 s. Making the hotspot phone itself the screen avoids client isolation.
- iOS may evict the service worker cache after weeks unused, so open the app online before going out.

## Relay through other ears (multi-hop)

An ear that loses its own link to the screen keeps reporting **through a neighbour ear** that still has one, over as many ears as it takes (up to 6 hops): C → B → A → screen. When links are fine nothing changes: every ear talks to the screen directly, as before.

- **Neighbours:** the screen names the other ears in its 1 Hz clock pings; each ear links to the others (the higher key dials), up to 6. Relay mode dials them over PeerJS; hotspot mode passes the pairing codes through the screen's data channels, so no QR scan is needed.
- **Route:** fewest hops. Each ear tells its neighbours its own way to the screen once a second, and at once when it changes, so a reroute takes about one link delay. A neighbour whose path already contains this ear is never used (no loops).
- **Packets:** `{ id, origin, ttl, visited }`. An ear forwards a packet once (it remembers the id), never back through an ear on the visited list, and drops it when the ttl runs out. The screen takes each id once.
- **Queue only when there's no route at all.** If no neighbour can reach the screen either, the ear queues as in [Dropouts](#dropouts-ears-keep-listening-and-catch-up) and catches up later, whichever way it gets back.
- The screen answers (clock pings, acks) back along the same path.
- The ear's own status says how it's connected: `connected via B → A (3 hops) · sealed`. "Pair again" (hotspot) shows whenever the ear has no direct link.

## Links map

The map draws the links between phones: each ear's line to the screen, and lines between ears. Each ear's current path to the screen is drawn in its colour with packets running along it. A link that worked and broke turns **dashed red with a cross**, and the path visibly moves to the new route. Ear chips say `Ear C via B (2 hops) · sealed` (with a lock) and `Ear A direct` while any ear is relayed. Ears heard through others get a small lock on their pin.

**In the demo** (`#demo`) the four phones run the real relay, seal and queue code over in-page links (5 to 40 ms each): phone A is this screen, B, C and D each link to it and to their neighbours (B–C, C–D). **✂ Cut a link** steps through: C loses the screen (C → B → screen), then B does (B → C → D → screen), then everything heals. Tapping a line also cuts it, or heals it. The dots keep moving the whole time.

## Sealed packets

What an ear sends **through other ears** is encrypted and authenticated for the screen, so the ears in between carry it but can't read or change it (`mesh/seal.js`, Web Crypto only).

- The screen and each ear keep an **ECDH P-256** key pair on the phone. The screen's public key rides in its pings, and the ear's rides in its pongs. Each side takes them **only from a direct link**, never through another ear.
- ECDH → HKDF-SHA-256 → two **AES-256-GCM** keys per ear (up and down). The origin ear's key and the packet id are authenticated too, so a changed bit anywhere is rejected. The GCM tag serves as the signature (a shared-key MAC). There's no separate ECDSA signature, so anyone holding that ear's key pair (the ear and the screen) could make it.
- **Replays:** ids are `epoch.n`. The epoch counts page loads on that phone (kept on the phone), and n counts within one. The receiver keeps the newest ids it took (512 back) and a floor that survives a reload. Old, repeated or out-of-window ids are rejected.
- Direct links are unchanged: plain messages over the WebRTC (DTLS) link, as before.

**How far to trust it.** Sealing protects against the **ears in between**. It is not a pairing ceremony:

- In relay mode the public keys are swapped over the direct WebRTC link, whose DTLS fingerprints are themselves exchanged through the PeerJS relay. Someone controlling that relay at pairing time could sit in the middle. Nothing compares keys by eye.
- In hotspot mode the keys ride the data channel that the scanned QR codes set up, which is better: the code carries the DTLS fingerprint.
- A new key on a direct link replaces the old one (last writer wins), so an ear that re-pairs with a fresh phone storage just works. The same rule would let an impostor with a direct link take over that ear's name.
- Keys are stored in `localStorage`, extractable, in the clear. Anyone with the phone can read them, and clearing site data makes new ones.
- An ear that has never had a direct link to this screen can't relay its own data. The screen doesn't know its key yet, so its packets are dropped.
- **iPhone:** Web Crypto needs a secure context (HTTPS or localhost), the same as the mic. Safari may clear `localStorage` after 7 days without a visit. The ear then re-keys at its next direct link, and until then its relayed packets are dropped.

## Code

The code is plain JS:

- `app.js`: the start screen router (`#screen` / `#ear` / `#demo`) and old-link rewriting.
- `detector.js`: detector and classifier, shared by every mode.
- `watch.js`: the screen (watch post) and the scripted demo.
- `ear.js`: ear mode (with the look prompt, camera clip and the ear's log) and the relay demo phones.
- `samples.js`: taught / labelled samples (Teach and the ear's Label), their clips and the Teach JSON format.
- `log.js`: the incident log, JSON export, printable report, and clip storage (IndexedDB).
- `reid.js`: Same drone again? (voiceprints, scores, tags).
- `tripwire.js`: tripwire lines, segment crossing, in/out.
- `bird.js`: Bird or Bot (blob tracker, motion features, the optional COCO-SSD check, the fusion and its words).
- `lib/leaflet.js`, `lib/leaflet.css`: Leaflet 1.9.4 (BSD-2), loaded only when the street map is shown.
- `watch.css`: all styles (Night and Sun).
- `mesh/core.js`: relay link (with the offline queue and reconnect), clock sync, timing tap, MeshModel estimators, the height fit (`heightFit`), the GPS frame (`Geo`), the post link (`linkPosts`), MapView, SimEngine.
- `mesh/core.js` also holds the Calibrator. `detector.js` holds the FlightTracker.
- `mesh/hotspot.js`: hotspot mode: the SDP ⇄ short code packing, offer / answer, the data channel adapter, QR draw and camera scan.
- `mesh/seal.js`: sealed packets: key pairs, HKDF → AES-GCM keys per ear, the replay window.
- `mesh/core.js` also holds the multi-hop relay (`NodeLink` neighbours, routes, forwarding; `startHub` opening relayed packets) and `pipe` (in-page links for the demo).
- `sw.js`: the offline app shell (service worker).
- `lib/qrcode.min.js`, `lib/jsQR.min.js`: QR encode / decode for hotspot pairing, loaded only in hotspot mode.
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
- `python3 test/gen_video.py` then `python3 test/bird.py`: Bird or Bot. The first renders synthetic sky clips (`.y4m`, fed to Chromium as the fake camera): a flapping bird with hand shake, a gliding bird circling, a hovering quadcopter with shake and a tree line, a drifting quadcopter, and empty sky with clouds. The second checks each verdict with the image check blocked and with it allowed, plus the sound fusion cases, and prints a confusion table. It also re-analyses a clip from the log. Then, over the relay, a bird clip gives LIKELY A BIRD on the screen with no repeat beeps and no dismissal, and a drone clip gives a Bot chip with the alert unchanged. Log and report are checked, and the ears' messages stay small.
- `python3 test/two.py`: two drones on one phone (`two.wav`: two sources with their own ids, pitch, class, flight, alert and incident) and the two-drone demo (two tracks near the two true drones, two colours, two alerts, two incidents). `run.py` fails if any single-sound file shows a second drone.
- `python3 test/coverage.py`: the radius math (+6 dB halves it, clamps), then three ears over the relay: the noisy one has the smallest circle, ranges listed in the Phones sheet, a phone that gets noisy shrinks its circle within seconds, circles on the street map too.
- `python3 test/fieldkit.py`: two ears label hexa / box-fan recordings (notes, Other text, a kept clip), the screen's library gets numbers + label only, ear export → import, and the held-out recordings go from wrong to right after the library is added to Teach.
- `python3 test/why.py`: every synthetic sound gets the expected reason (fan → steady/50 Hz, moto → motorbike, speech → voice …), Details shows the bars, the reason is logged, and the screen rebuilds the same reason from an ear's numbers.
- `python3 test/height.py`: the height fit alone on noisy synthetic passes at 5/15/30 m (with and without arrival times), phones in a line → "unknown", whole-app passes at 5/15/30 m, and the demo: side strip, z in the log track, Height in the report. Prints its errors as they are.
- `python3 test/reid.py`: scoring and thresholds, then the synthetic drone twice (`#demo&path=circle&f0=215`): first visit gives a new tag, the second gives Seen before with visits and match %. A 300 Hz drone gets a new tag. Also covers rename and forget, the log chips, the report and the JSON export.
- `python3 test/tripwire.py`: segment math and jitter. Then the demo with Alert only on crossing: silent at confirm, then one alert with an OUT crossing that is logged, reported and exported. Also checks a circle that never crosses (no alert, no beeps), a circle with the toggle off (normal alert plus a crossing alert), drawing, flip, delete and persistence on the plain map, and a line on the street map that keeps lat/lon.
- `python3 test/linked.py`: two screens linked over the relay, each with 4 simulated phones 30 m apart. Checks each draws the other's drone in its own frame, and a hand-off keeps one drone id across both.
- `python3 test/offline.py`: the dropout queue (cap, order, timestamps). Then a screen and an ear over the relay: the ear's link and relay are cut mid-stream, the screen shows "Ear A offline N s" counting up while the ear queues, and after reconnect the chip says "synced N points". The late points are merged in time order into the gap.
- `python3 test/hotspot.py`: hotspot mode with PeerJS blocked: the screen and two ears pair by pasted codes (both QR codes decode back to the codes), the ears' simulated drone drives the screen to DRONE, the two ears pair with each other through the screen and a dropped link carries on via the other ear, a link with no route re-pairs and catches up, and the app shell plus the QR libraries load offline through the service worker.
- `python3 test/relay.py`: a screen and three ears over the relay. The ears link to each other on their own. Cutting C's links to the screen and A sends C's data via B. Cutting B's link to the screen too gives C → B → A → screen. Chips and the ear's status say "via", each tagged point arrives exactly once, and everything goes direct again when the links come back.
- `python3 test/sealed.py`: in-page screen and two ears. What the middle ear carries is ciphertext, and it can't open it with its own private key, the screen's public key and the origin's name. A flipped bit in the payload, tag, id or origin is rejected. Replays are rejected, also after the screen reloads. The answers down the path are sealed too.
- `python3 test/mesh.py circle 4 45 "&bias=30"`: mesh accuracy over the PeerJS relay. Add `CAL=full` or `CAL=quick` to calibrate in the sim and print before/after numbers. It needs a static server on port 5311, for example `python3 -m http.server 5311`.

Serve this repository from the `main` branch root (GitHub Pages). `.nojekyll` keeps Pages from running Jekyll.
