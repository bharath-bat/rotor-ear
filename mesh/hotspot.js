// Rotor Ear · hotspot mode: phones on one Wi-Fi hotspot, no internet, no server. WebRTC with host ICE candidates only
// (no STUN); the offer / answer go phone to phone as QR codes (or pasted text). A code carries only what's needed to
// rebuild the SDP: ICE ufrag + password, the DTLS fingerprint and the host candidates, ~150 characters:
//   R1~o|a~ufrag~pwd~fingerprint (base64url)~ip,port;ip,port…[~ear key]   (mDNS names: "m" + base64url of the UUID)
// Once paired, the data channel carries the same messages as the relay (mesh/core.js NodeLink / startHub).
(function () {
  'use strict';
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const toB64 = hex => { const b = hex.match(/../g).map(h => parseInt(h, 16)); let s = '';
    for (let i = 0; i < b.length; i += 3) { const n = (b[i] << 16) | ((b[i + 1] || 0) << 8) | (b[i + 2] || 0), k = Math.min(4, Math.ceil((b.length - i) * 4 / 3)); for (let j = 0; j < k; j++) s += B64[(n >> (18 - 6 * j)) & 63]; } return s; };
  const toHex = (s, bytes) => { let bits = 0, v = 0, out = ''; for (const ch of s) { v = (v << 6) | B64.indexOf(ch); bits += 6; if (bits >= 8) { bits -= 8; out += ((v >> bits) & 255).toString(16).padStart(2, '0'); } } return out.slice(0, bytes * 2); };
  const UUID = /^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})\.local$/i;
  const host = a => { const m = UUID.exec(a); return m ? 'm' + toB64(m.slice(1).join('').toLowerCase()) : a; };
  const unhost = a => { if (a[0] !== 'm') return a; const h = toHex(a.slice(1), 16); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}.local`; };

  function pack(sdp, type, key) {
    const g = re => (sdp.match(re) || [])[1] || '';
    const fp = g(/a=fingerprint:sha-256 ([0-9A-F:]+)/i).replace(/:/g, ''), cands = [];
    sdp.replace(/a=candidate:\S+ 1 udp \d+ (\S+) (\d+) typ host/gi, (m, ip, port) => { if (cands.length < 4 && !cands.some(c => c === ip + ',' + port)) cands.push(host(ip) + ',' + port); });
    if (!fp || !cands.length) throw new Error('no local network address (is Wi-Fi / the hotspot on?)');
    return ['R1', type === 'offer' ? 'o' : 'a', g(/a=ice-ufrag:(\S+)/), g(/a=ice-pwd:(\S+)/), toB64(fp), cands.join(';')].concat(key ? [key] : []).join('~');
  }
  function unpack(code) {
    const f = String(code || '').trim().split('~');
    if (f[0] !== 'R1' || f.length < 6 || !/^[oa]$/.test(f[1])) throw new Error('not a Rotor Ear hotspot code');
    const [, t, ufrag, pwd, fp64, cs, key] = f, offer = t === 'o';
    const fp = toHex(fp64, 32).toUpperCase().match(/../g).join(':');
    const sdp = ['v=0', 'o=- ' + Date.now() + ' 2 IN IP4 127.0.0.1', 's=-', 't=0 0', 'a=group:BUNDLE 0', 'a=msid-semantic: WMS',
      'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'c=IN IP4 0.0.0.0', 'a=ice-ufrag:' + ufrag, 'a=ice-pwd:' + pwd,
      'a=fingerprint:sha-256 ' + fp, 'a=setup:' + (offer ? 'actpass' : 'active'), 'a=mid:0', 'a=sctp-port:5000', 'a=max-message-size:262144']
      .concat(cs.split(';').map((c, i) => { const [ip, port] = c.split(','); return `a=candidate:${i + 1} 1 udp ${2122260223 - i} ${unhost(ip)} ${port} typ host generation 0`; }), ['a=end-of-candidates', '']).join('\r\n');
    return { type: offer ? 'offer' : 'answer', sdp, key: key || '' };
  }
  const gathered = pc => new Promise(res => { if (pc.iceGatheringState === 'complete') return res(); const t = setTimeout(res, 3000); pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); res(); } }); });
  const newPC = () => new RTCPeerConnection({ iceServers: [] }); // host candidates only: no STUN, no TURN, nothing leaves the local network

  // RTCDataChannel → the little bit of the PeerJS DataConnection interface the mesh uses (open, send, close, on, metadata)
  function wrap(dc, pc, metadata) {
    const h = {}, fire = (ev, x) => (h[ev] || []).forEach(f => f(x));
    const c = { metadata: metadata || {}, pc, get open() { return dc.readyState === 'open'; }, send(o) { dc.send(JSON.stringify(o)); }, close() { try { dc.close(); } catch (e) {} try { pc.close(); } catch (e) {} }, on(ev, fn) { (h[ev] = h[ev] || []).push(fn); return c; } };
    dc.onopen = () => fire('open'); dc.onclose = () => fire('close'); dc.onerror = () => fire('error');
    dc.onmessage = e => { let d; try { d = JSON.parse(e.data); } catch (_) { return; } fire('data', d); };
    pc.addEventListener('connectionstatechange', () => { if (pc.connectionState === 'failed' || pc.connectionState === 'closed') fire('close'); });
    return c;
  }
  // the screen: one offer per ear. → { code, accept(answerCode) → Promise<conn> }
  async function offer() {
    const pc = newPC(), dc = pc.createDataChannel('rotorear', { ordered: true });
    await pc.setLocalDescription(await pc.createOffer()); await gathered(pc);
    const code = pack(pc.localDescription.sdp, 'offer');
    return { code, pc, async accept(ans) {
      const a = unpack(ans); if (a.type !== 'answer') throw new Error('that is an offer code: scan the code the ear shows');
      const c = wrap(dc, pc, { role: 'node', key: a.key || 'hs' + Math.random().toString(36).slice(2, 7) });
      await pc.setRemoteDescription({ type: 'answer', sdp: a.sdp }); return c;
    } };
  }
  // an ear: the screen's offer code → { code (to show back), conn (opens once the screen has scanned it) }
  async function answer(code, key) {
    const o = unpack(code); if (o.type !== 'offer') throw new Error('that is an answer code: scan the code on the screen');
    const pc = newPC(); let conn = null; const got = new Promise(res => pc.ondatachannel = e => res(e.channel));
    await pc.setRemoteDescription({ type: 'offer', sdp: o.sdp });
    await pc.setLocalDescription(await pc.createAnswer()); await gathered(pc);
    return { code: pack(pc.localDescription.sdp, 'answer', key), pc, conn: got.then(dc => conn = wrap(dc, pc, { role: 'map' })) };
  }

  // QR: draw a code on a canvas (lib/qrcode.min.js), and scan with the rear camera (lib/jsQR.min.js), both vendored
  function drawQR(cv, text) {
    const q = qrcode(0, 'L'); q.addData(text); q.make();
    const n = q.getModuleCount(), m = 4, s = Math.max(3, Math.floor(300 / (n + 2 * m))), g = cv.getContext('2d');
    cv.width = cv.height = (n + 2 * m) * s; g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height); g.fillStyle = '#000';
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (q.isDark(y, x)) g.fillRect((x + m) * s, (y + m) * s, s, s);
    return n;
  }
  const readQR = cv => { const g = cv.getContext('2d'), d = g.getImageData(0, 0, cv.width, cv.height), r = jsQR(d.data, d.width, d.height); return r ? r.data : null; };
  // camera scan into <video>; calls found(text) once with the first Rotor Ear code it sees. → stop()
  async function scan(video, found) {
    const st = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    video.srcObject = st; video.setAttribute('playsinline', ''); video.muted = true; await video.play().catch(() => {});
    const cv = document.createElement('canvas'); let on = true;
    const stop = () => { on = false; st.getTracks().forEach(t => t.stop()); video.srcObject = null; };
    (function look() {
      if (!on) return;
      if (video.videoWidth) { const w = Math.min(640, video.videoWidth), h = Math.round(w * video.videoHeight / video.videoWidth); cv.width = w; cv.height = h; cv.getContext('2d').drawImage(video, 0, 0, w, h);
        const t = readQR(cv); if (t && t.startsWith('R1~')) { stop(); return found(t); } }
      setTimeout(look, 200);
    })();
    return stop;
  }
  // the QR libraries load only in hotspot mode (from this site, so they work offline once cached)
  let libs = null;
  const load = src => new Promise((res, rej) => { const el = document.createElement('script'); el.src = src; el.onload = res; el.onerror = () => rej(new Error('could not load ' + src)); document.head.appendChild(el); });
  const loadLibs = () => libs || (libs = Promise.all([window.qrcode || load('lib/qrcode.min.js'), window.jsQR || load('lib/jsQR.min.js')]).catch(e => { libs = null; throw e; }));
  window.RotorHotspot = { libs: loadLibs, pack, unpack, offer, answer, wrap, drawQR, readQR, scan, HINT: 'One phone turns on hotspot, others join it, then scan codes.' };
})();
