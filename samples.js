// Rotor Ear · taught / labelled sound samples, shared by the screen (Teach) and the ear (Label). Each sample is the six
// fingerprint numbers plus what the sound was: { id, tag, x: [6], f0, t, text?: 'Other' words, note?: this phone only,
// from?: 'label' | 'teach', clip?: true }. Stored in localStorage on this device; optional clips stay in IndexedDB here.
// Export / import is the Teach JSON format: { app: 'rotor-ear', kind: 'samples', v: 1, feats, samples: [...] } (never audio;
// an ear's own export keeps its notes, nothing sent to the screen ever carries them).
(function () {
  'use strict';
  const { TAGS, FEATS } = window.RotorEar, KEY = 'rotorear-samples-v1', USE = 'rotorear-use-samples';
  const valid = s => !!s && TAGS.some(t => t.id === s.tag) && Array.isArray(s.x) && s.x.length === FEATS.length && s.x.every(Number.isFinite) && typeof s.id === 'string';
  // the numbers + label only: what may leave this phone (export, or to the room's screen); notes and clips never do
  const share = ({ id, tag, x, f0, t, text }) => Object.assign({ id, tag, x: x.slice(), f0: +(+f0).toFixed(1), t: +t }, text ? { text: String(text).slice(0, 60) } : null);
  let list = []; try { list = JSON.parse(localStorage.getItem(KEY) || '[]').filter(valid); } catch (e) {}
  const subs = [];
  const save = () => { localStorage.setItem(KEY, JSON.stringify(list)); subs.forEach(f => f()); };
  window.addEventListener('storage', e => { if (e.key === KEY) { try { list = JSON.parse(e.newValue || '[]').filter(valid); } catch (er) {} subs.forEach(f => f()); } }); // another tab
  const db = () => new Promise((res, rej) => { const r = indexedDB.open('rotorear', 1); r.onupgradeneeded = () => r.result.createObjectStore('clips'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const clipOp = async (mode, fn) => { const d = await db(); return new Promise((res, rej) => { const q = fn(d.transaction('clips', mode).objectStore('clips')); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); };
  const S = window.RotorSamples = {
    get list() { return list; }, valid, share,
    get use() { return localStorage.getItem(USE) !== '0'; }, set use(v) { localStorage.setItem(USE, v ? '1' : '0'); subs.forEach(f => f()); },
    onChange(f) { subs.push(f); },
    newId: () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    tag: id => TAGS.find(t => t.id === id),
    name: s => s.tag === 'other' && s.text ? 'Other: ' + s.text : S.tag(s.tag).label,
    async add(smp, blob) {
      if (blob) { try { await clipOp('readwrite', st => st.put(blob, smp.id)); smp.clip = true; } catch (e) {} }
      list.push(smp); save(); return smp;
    },
    merge(arr) { const have = new Set(list.map(x => x.id)), add = arr.filter(x => valid(x) && !have.has(x.id)).map(x => Object.assign(share(x), x.note ? { note: String(x.note).slice(0, 200) } : null)); list = list.concat(add); if (add.length) save(); return add.length; },
    async remove(id) { list = list.filter(x => x.id !== id); try { await clipOp('readwrite', st => st.delete(id)); } catch (e) {} save(); },
    async clear() { list = []; try { await clipOp('readwrite', st => st.clear()); } catch (e) {} save(); },
    clip: id => clipOp('readonly', st => st.get(id)),
    count: group => list.filter(x => S.tag(x.tag).group === group).length,
    file: (arr, notes) => ({ app: 'rotor-ear', kind: 'samples', v: 1, feats: FEATS, samples: (arr || list).map(x => Object.assign(share(x), notes && x.note ? { note: x.note } : null)) }),
    download(arr, name, notes) {
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(S.file(arr, notes), null, 1)], { type: 'application/json' }));
      a.download = (name || 'rotor-ear-samples') + '-' + new Date().toISOString().slice(0, 10) + '.json'; document.body.appendChild(a); a.click(); a.remove();
    },
    parse(text) { // → valid samples from a Teach / Label export, or throws
      const d = JSON.parse(text);
      if (d.app !== 'rotor-ear' || String(d.feats) !== String(FEATS)) throw new Error('not a Rotor Ear samples file');
      return (d.samples || []).filter(valid);
    },
  };
})();
