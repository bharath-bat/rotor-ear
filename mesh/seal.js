// Rotor Ear · sealed packets: what an ear sends through other ears (multi-hop relay) is encrypted and authenticated for the
// screen, so the ears in between carry ciphertext they can neither read nor change. Web Crypto only.
//   Keys: the screen and each ear hold a long-lived ECDH P-256 key pair (kept on the phone). The screen's public key rides
//   in its clock pings, the ear's in its pongs, and each side only takes them from a DIRECT link (not through another ear).
//   ECDH → HKDF-SHA-256 → two AES-256-GCM keys per ear: "up" (ear → screen) and "down" (screen → ear).
//   Packet: { id: "epoch.n", iv, x } with the origin ear's key and the id as additional authenticated data: the GCM tag is
//   the signature, so a flipped bit anywhere (payload, origin, id) fails. Replays: ids only go up; the epoch counts that
//   phone's page loads and is kept on the phone, n counts within one; the receiver keeps a window of the ids it took.
(function () {
  'use strict';
  const S = crypto.subtle, enc = new TextEncoder(), dec = new TextDecoder(), EC = { name: 'ECDH', namedCurve: 'P-256' };
  const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const unb64 = s => Uint8Array.from(atob(String(s).replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
  const get = k => { try { return k && JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } };
  const put = (k, v) => { if (k) try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
  const bump = k => { const e = (+(get(k) || 0)) + 1; put(k, e); return e; };
  async function identity(k) { // store key null: a fresh pair for this page only (the demo)
    const j = get(k);
    if (j) try { return { priv: await S.importKey('jwk', j.priv, EC, false, ['deriveBits']), pub: j.pub }; } catch (e) {}
    const kp = await S.generateKey(EC, true, ['deriveBits']), pub = b64(await S.exportKey('raw', kp.publicKey));
    put(k, { priv: await S.exportKey('jwk', kp.privateKey), pub }); return { priv: kp.privateKey, pub };
  }
  async function pair(priv, theirPub, ear) {
    const bits = await S.deriveBits({ name: 'ECDH', public: await S.importKey('raw', unb64(theirPub), EC, false, []) }, priv, 256);
    const hk = await S.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
    const k = dir => S.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode('rotorear-seal-v1'), info: enc.encode(dir + '|' + ear) }, hk, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    return { up: await k('up'), down: await k('down') };
  }
  async function seal(key, o, aad) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    return { iv: b64(iv), x: b64(await S.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, key, enc.encode(JSON.stringify(o)))) };
  }
  const open = async (key, p, aad) => JSON.parse(dec.decode(await S.decrypt({ name: 'AES-GCM', iv: unb64(p.iv), additionalData: enc.encode(aad) }, key, unb64(p.x))));
  // ids "epoch.n": a lower epoch is old; within one, anything at or below the floor (restored after a reload), already seen,
  // or more than 512 behind the newest is refused
  class Fresh {
    constructor(ep, floor) { this.ep = ep || 0; this.floor = floor || 0; this.max = floor || 0; this.seen = new Set(); }
    ok(id) {
      const [e, n] = String(id).split('.').map(Number); if (!(e >= 1 && n >= 1)) return false;
      if (e < this.ep) return false; if (e > this.ep) { this.ep = e; this.floor = this.max = 0; this.seen.clear(); }
      if (n <= this.floor || n <= this.max - 512 || this.seen.has(n)) return false;
      this.seen.add(n); this.max = Math.max(this.max, n); if (this.seen.size > 1024) this.seen.forEach(x => { if (x <= this.max - 512) this.seen.delete(x); });
      return true;
    }
  }
  // an ear: seals what it sends up, opens what the screen sends down. store: localStorage prefix (null = this page only)
  async function ear(key, store) {
    const me = await identity(store && store + '-id'), ep = store ? bump(store + '-ep') : 1, st = get(store && store + '-scr') || {};
    let keys = null, spk = null, n = 0, fr = new Fresh(st.ep, st.max);
    const setScreen = async (pk, f) => { if (!pk || pk === spk) return; spk = pk; keys = null; fr = f || new Fresh(); const k = await pair(me.priv, pk, key); if (spk === pk) { keys = k; if (!f) put(store && store + '-scr', { pk }); } };
    if (st.pk) await setScreen(st.pk, fr).catch(() => {}); // the same screen as last time: keep the replay floor
    return { pub: me.pub, get ready() { return !!keys; }, setScreen,
      async up(o) { const id = ep + '.' + (++n); return Object.assign({ id }, await seal(keys.up, o, key + '|' + id)); },
      async down(p) { if (!keys) return null; let o; try { o = await open(keys.down, p, key + '|' + p.id); } catch (e) { return null; }
        if (!fr.ok(p.id)) return null; put(store && store + '-scr', { pk: spk, ep: fr.ep, max: fr.max }); return o; } };
  }
  // the screen: opens what ears send up (counting tampered and replayed packets), seals what it sends down
  async function screen(store) {
    const me = await identity(store && store + '-id'), ep = store ? bump(store + '-ep') : 1, ears = get(store && store + '-ears') || {}, keys = new Map(), fresh = new Map();
    const stats = { ok: 0, bad: 0, replay: 0 }; let n = 0;
    const kf = k => { if (!ears[k]) return null; if (!keys.has(k)) keys.set(k, pair(me.priv, ears[k].pk, k)); return keys.get(k); };
    return { pub: me.pub, stats, knows: k => !!ears[k],
      learn(k, pk) { if (!pk || (ears[k] && ears[k].pk === pk)) return; ears[k] = { pk }; keys.delete(k); fresh.delete(k); put(store && store + '-ears', ears); },
      async open(k, p) {
        const kp = kf(k); let o; if (!kp) { stats.bad++; return null; }
        try { o = await open((await kp).up, p, k + '|' + p.id); } catch (e) { stats.bad++; return null; }
        let f = fresh.get(k); if (!f) fresh.set(k, f = new Fresh(ears[k].ep, ears[k].max));
        if (!f.ok(p.id)) { stats.replay++; return null; }
        ears[k].ep = f.ep; ears[k].max = f.max; put(store && store + '-ears', ears); stats.ok++; return o;
      },
      async seal(k, o) { const kp = kf(k); if (!kp) return null; const id = ep + '.' + (++n); return Object.assign({ id }, await seal((await kp).down, o, k + '|' + id)); } };
  }
  window.RotorSeal = { ear, screen, Fresh };
})();
