// Rotor Ear · ear mode (#ear&room=…): this phone listens and sends ONLY numbers (rotor score, pitch, band energy,
// class label, envelope-peak times) to the room's screen. Never audio. Passive: nothing here transmits RF.
// Also the demo phones for a room (#demo&room=…, the old mesh/sim.html). Transport and estimation: mesh/core.js.
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const R = window.RotorMesh, App = window.RotorApp, clamp = (x, a, b) => x < a ? a : x > b ? b : x;

  // ---------------- small spectrogram (log 50 Hz–8 kHz) ----------------
  function Spectro(cv) {
    const g = cv.getContext('2d'), PAL = R.PAL;
    return function draw(db, binHz, f0, st) {
      const dpr = Math.min(2, devicePixelRatio || 1), W = Math.round(cv.clientWidth * dpr), H = Math.round(cv.clientHeight * dpr);
      if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
      g.drawImage(cv, 2, 0, W - 2, H, 0, 0, W - 2, H);
      const x = W - 2, L = Math.log(8000 / 50);
      for (let y = 0; y < H; y += 2) { const f = 50 * Math.exp(L * (1 - y / H)), i = Math.round(f / binHz); g.fillStyle = PAL[clamp((db[i] + 105) / 75, 0, 1) * 255 | 0]; g.fillRect(x, y, 2, 2); }
      if (f0 && st !== 'quiet') { g.fillStyle = '#ffffff'; for (let h = 1; h <= 10; h++) { const y = (1 - Math.log(f0 * h / 50) / L) * H; if (y > 0) g.fillRect(x, y - 1, 2, 2); } }
    };
  }
  // same state words, shapes and confidence wording as the watch post (detector.js)
  const STATE_OF = { quiet: 'watching', some: 'checking', drone: 'drone', hum: 'notdrone', off: 'ready' };
  function setBanner(el, st, sub, cls) {
    const s = STATE_OF[st] || 'ready', [icon, word] = RotorEar.STATES[s];
    const key = s + sub + (cls || ''); if (el.dataset.k === key) return; el.dataset.k = key;
    el.className = 'banner ' + s;
    el.innerHTML = `<b class="w">${icon} ${word}</b>` + (cls ? '<b class="cls">' + cls + '</b>' : '') + '<small>' + sub + '</small>';
  }
  const clsText = o => o.cls ? o.cls.label + ' · ' + RotorEar.likelihood(o.cls.conf) : '';

  // ---------------- NODE ----------------
  function runNode(room) {
    $('node').hidden = false; $('earJoin').hidden = true;
    $('roomTag').textContent = 'Ear · room ' + room.toUpperCase();
    const kStore = 'rotorear-key-' + room;
    const key = localStorage.getItem(kStore) || R.randKey(5); localStorage.setItem(kStore, key);
    $('nName').value = localStorage.getItem('rotorear-name') || '';
    $('nName').onchange = () => localStorage.setItem('rotorear-name', $('nName').value.trim());
    let label = '';
    const status = (s, cls) => { $('nStatus').textContent = (label ? 'Node ' + label + ' · ' : '') + s; $('nStatus').className = 'nstatus ' + (cls || ''); };
    const link = new R.NodeLink(room, key, status, d => { if (d.t === 'ping' && d.label && d.label !== label) { label = d.label; status('connected to the screen', 'ok'); } });

    let ctx, an, bus, det, tap, mic, micSrc, sim = null, simGain, simSpk, spec = Spectro($('nSpec')), wake = null;
    function ensure() {
      if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      an = RotorEar.makeAnalyser(ctx); det = new RotorEar.RotorDetector(an);
      bus = ctx.createGain(); bus.connect(an);
      R.TimingTap(ctx, bus).then(t => tap = t).catch(() => {}); // arrival times are optional
      simSpk = ctx.createGain(); simSpk.gain.value = 0; simSpk.connect(ctx.destination);
      setInterval(tick, 50);
      setInterval(() => link.send(R.telemetry(det.out, key, $('nName').value.trim(), null, tap ? tap.take() : null, tap ? tap.takeOnsets() : null)), 1000 / R.SEND_HZ);
    }
    async function keepAwake() { try { if ('wakeLock' in navigator && !wake) { wake = await navigator.wakeLock.request('screen'); wake.onrelease = () => wake = null; } } catch (e) {} }
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && (mic || sim)) keepAwake(); });
    function tick() {
      const o = det.step(performance.now()); if (tap) tap.setF0(o.f0);
      $('nConf').textContent = o.conf; $('nMeter').style.width = o.conf + '%';
      $('nF0').textContent = o.f0 && o.conf > 15 ? Math.round(o.f0) : '—';
      $('nE').textContent = o.f0 ? Math.round(o.e) : '—';
      const sub = o.state === 'drone' ? 'rotor hum ~' + Math.round(o.f0) + ' Hz · the map shows where' : o.state === 'hum' ? (o.cls ? o.cls.why + ' · ignored' : 'ignored') : o.state === 'some' ? 'this phone hears a harmonic hum' : (sim ? 'simulating · numbers go to the map' : mic ? 'listening · numbers go to the map' : 'tap Start listening');
      setBanner($('nBanner'), mic || sim ? o.state : 'off', sub, o.state === 'drone' ? clsText(o) : '');
      spec(det.db, det.binHz, o.f0, o.state);
    }
    $('nStart').onclick = async () => {
      ensure(); keepAwake();
      if (mic) { mic.getTracks().forEach(t => t.stop()); micSrc.disconnect(); mic = null; $('nStart').textContent = 'Start listening'; $('nStart').classList.remove('on'); return; }
      try {
        $('nErr').textContent = '';
        mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
        micSrc = ctx.createMediaStreamSource(mic); micSrc.connect(bus);
        $('nStart').textContent = '■ Stop listening'; $('nStart').classList.add('on');
      } catch (e) { mic = null; $('nErr').textContent = 'Microphone unavailable: ' + (e.message || e.name); }
    };
    const distGain = d => 0.6 / Math.max(1, d); // amplitude ∝ 1/r  ⇒  power ∝ 1/r²
    function updDist() { const d = +$('nDist').value; $('nDistV').textContent = d + ' m'; if (simGain) simGain.gain.setTargetAtTime(distGain(d), ctx.currentTime, 0.2); }
    $('nDist').oninput = updDist;
    $('nSimSpk').onchange = () => { if (simSpk) simSpk.gain.value = $('nSimSpk').checked ? 1 : 0; };
    $('nSim').onchange = () => {
      ensure(); keepAwake();
      if ($('nSim').checked) {
        const d = RotorEar.syntheticDrone(ctx, 200 + Math.random() * 30);
        simGain = ctx.createGain(); simGain.gain.value = distGain(+$('nDist').value);
        d.connect(simGain); simGain.connect(bus); simGain.connect(simSpk);
        const nz = RotorEar.ambientNoise(ctx, 0.01); nz.connect(bus);
        sim = { d, nz }; simSpk.gain.value = $('nSimSpk').checked ? 1 : 0; updDist();
      } else if (sim) { sim.d.stop(); sim.nz.stop(); simGain.disconnect(); sim = null; }
    };
    window.__node = { get out() { return det && det.out; }, key };
    return { room, stop() { if (mic) $('nStart').onclick(); if (sim) { $('nSim').checked = false; $('nSim').onchange(); } } };
  }


  // ---------------- ear mode ----------------
  let node = null;
  $('joinBtn').onclick = () => { const c = $('joinCode').value.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12); if (c) location.hash = 'ear&room=' + c; };
  $('joinCode').onkeydown = e => { if (e.key === 'Enter') $('joinBtn').onclick(); };
  App.modes.ear = {
    enter(p) {
      if (node && node.room !== p.room) return location.reload(); // one room per page load
      if (!p.room) { $('earJoin').hidden = false; $('node').hidden = true; $('roomTag').textContent = 'Be an ear'; return; }
      if (!node) node = runNode(p.room);
    },
    leave() { if (node) node.stop(); },
  };

  // ---------------- demo phones for a room (relay) ----------------
  let eng = null;
  App.modes.sim = {
    enter(p) {
      const h = p.h, room = p.room;
      ['n:sN', 'path:sPath', 'off:sOff', 'jit:sJit', 'bias:sBias', 'gain:sGain', 'alt:sAlt', 'speed:sSpeed'].forEach(kv => { const [k, id] = kv.split(':'); if (h.get(k)) $(id).value = h.get(k); });
      $('sRoomTag').textContent = 'Demo phones · room ' + room.toUpperCase();
      $('sMap').href = location.pathname + '#screen&room=' + room;
      const lbl = () => { $('sAltV').textContent = $('sAlt').value + ' m'; $('sJitV').textContent = $('sJit').value + ' ms'; }; lbl();
      const S = window.__sim = { drone: null, nodes: [] };
      const opts = () => ({ n: +$('sN').value, path: $('sPath').value, speed: +$('sSpeed').value, alt: +$('sAlt').value, clockOffMs: +$('sOff').value, jitterMs: +$('sJit').value, biasMs: +$('sBias').value, gainDb: +$('sGain').value });
      $('simv').querySelectorAll('input,select').forEach(el => el.oninput = () => { lbl(); if (eng) Object.assign(eng.o, { path: $('sPath').value, speed: +$('sSpeed').value, alt: +$('sAlt').value, jitterMs: +$('sJit').value }); });
      $('sStart').onclick = () => {
        if (eng) return location.reload();
        $('sStart').textContent = '■ Stop'; $('sStart').classList.add('on');
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        eng = new R.SimEngine(ctx, opts());
        eng.nodes.forEach(n => { n.status = ''; n.link = new R.NodeLink(room, n.key, s => n.status = s, null, n.clock); });
        S.nodes = eng.nodes; $('claps').hidden = false;
        // for the screen's Calibrate: a clap 30 cm from that phone
        'ABCD'.split('').forEach((l, i) => { $('clap' + l).hidden = i >= eng.nodes.length; $('clap' + l).onclick = () => { const q = eng.nodes[i].p; eng.clap(q[0] + R.NEAR, q[1]); }; });
        setInterval(() => eng.step(performance.now()), 50);
        setInterval(() => {
          const msgs = eng.messages(); eng.nodes.forEach((n, i) => n.link.send(msgs[i]));
          const d = S.drone = eng.drone; if (d) eng.nodes[0].link.send({ t: 'truth', x: +d.x.toFixed(2), y: +d.y.toFixed(2), vx: +d.vx.toFixed(2), vy: +d.vy.toFixed(2) });
          $('sStatus').textContent = d ? 'virtual drone at (' + d.x.toFixed(1) + ', ' + d.y.toFixed(1) + ') m' : '';
          $('sNodes').innerHTML = eng.nodes.map(n => { const o = n.det.out; return `<div class="nrow"><div class="pin">${'ABCD'[n.i]}</div><div class="nm">sim ${'ABCD'[n.i]} · ${n.r.toFixed(1)} m · clock ${n.off >= 0 ? '+' : ''}${Math.round(n.off)} ms · mic ${n.bias >= 0 ? '+' : ''}${n.bias.toFixed(1)} ms ${n.gainDb >= 0 ? '+' : ''}${n.gainDb.toFixed(1)} dB<small>${n.status}${o.cls ? ' · ' + o.cls.label + ' · ' + RotorEar.likelihood(o.cls.conf) : ''}</small><div class="meter"><i style="width:${o.conf}%"></i></div></div><div class="num">${o.f0 ? Math.round(o.f0) : '—'} Hz</div><div class="num">${o.e > -100 ? Math.round(o.e) : '—'} dB</div></div>`; }).join('');
        }, 1000 / R.SEND_HZ);
      };
    },
    leave() { if (eng) location.reload(); },
  };
})();
