// Rotor Ear · "Same drone again?": a compact voiceprint per drone, kept on this phone only (localStorage, next to the log).
// Voiceprint = numbers already measured: blade-pass pitch (median Hz over the first few seconds after the alert) and the
// six-feature fingerprint (mean). Nothing new is recorded and nothing leaves the phone.
// Tag: { id, n (Drone #n), name, f0, x: [6], cls, first, last, visits, demo }. Demo drones only ever match demo tags.
// Score 0–100: pitch closeness (0 at ±10 %) 65 %, fingerprint closeness 35 %. ≥ 80 seen before · 60–79 possible match · else new tag.
(function () {
  'use strict';
  const KEY = 'rotorear-tags-v1', MATCH = 80, MAYBE = 60, MAXT = 200;
  let tags = []; try { tags = JSON.parse(localStorage.getItem(KEY) || '[]'); } catch (e) {}
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(tags)); } catch (e) {} };
  const median = a => { const s = a.slice().sort((p, q) => p - q), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  // samples: [{ f0, x? }] → { f0, x | null, n }
  function print(samples) {
    const fs = samples.map(s => s.f0).filter(f => f > 0); if (!fs.length) return null;
    const xs = samples.map(s => s.x).filter(x => x && x.length === 6);
    return { f0: +median(fs).toFixed(1), x: xs.length ? [0, 1, 2, 3, 4, 5].map(i => +(xs.reduce((a, x) => a + x[i], 0) / xs.length).toFixed(3)) : null, n: samples.length };
  }
  // similarity in 0–100. Fingerprint features 1–4 (split, beat, steady, sub): pitch is scored on its own, mains is a flag.
  function score(a, b) {
    const sp = Math.max(0, 1 - Math.abs(Math.log(a.f0 / b.f0)) / Math.log(1.10));
    if (!a.x || !b.x) return Math.round(100 * sp * 0.9); // pitch alone: never fully sure
    const d = Math.sqrt([1, 2, 3, 4].reduce((s, i) => s + (a.x[i] - b.x[i]) ** 2, 0) / 4), sx = Math.max(0, 1 - d / 0.5);
    return Math.round(100 * (0.65 * sp + 0.35 * sx));
  }
  const kindOf = s => s >= MATCH ? 'match' : s >= MAYBE ? 'possible' : 'new';
  const Tags = {
    MATCH, MAYBE, score, print, kindOf,
    get list() { return tags; },
    get: id => tags.find(t => t.id === id),
    best(p, demo) { let b = null, bs = -1; tags.forEach(t => { if (!!t.demo !== !!demo) return; const s = score(p, t); if (s > bs) { bs = s; b = t; } }); return b ? { tag: b, score: bs } : null; },
    // decide for one incident: → { id, n, name, score, kind, visits, prev (last seen before this visit) }
    assign(p, cls, demo, now) {
      now = now || Date.now(); const m = Tags.best(p, demo), kind = m ? kindOf(m.score) : 'new';
      let t, prev = null;
      if (kind === 'new') {
        t = { id: 'g' + now.toString(36) + Math.random().toString(36).slice(2, 4), n: tags.reduce((a, q) => Math.max(a, q.n), 0) + 1, name: '', f0: p.f0, x: p.x, cls: cls || 'Drone', first: now, last: now, visits: 1, demo: !!demo };
        tags.unshift(t); tags = tags.slice(0, MAXT);
      } else {
        t = m.tag; prev = t.last; t.last = now; t.visits++; if (cls && cls !== 'Drone') t.cls = cls;
        if (kind === 'match') { t.f0 = +(0.8 * t.f0 + 0.2 * p.f0).toFixed(1); if (p.x) t.x = t.x ? t.x.map((v, i) => +(0.8 * v + 0.2 * p.x[i]).toFixed(3)) : p.x; } // a sure match refines the print
      }
      save();
      return { id: t.id, n: t.n, name: t.name, score: m ? m.score : 0, kind, visits: t.visits, prev, near: kind === 'new' && m ? m.tag.n : null }; // new: score = the closest past drone's
    },
    rename(id, name) { const t = Tags.get(id); if (t) { t.name = String(name || '').trim().slice(0, 32); save(); } },
    forget(id) { tags = tags.filter(t => t.id !== id); save(); },
    clear() { tags = []; save(); },
    reload() { try { tags = JSON.parse(localStorage.getItem(KEY) || '[]'); } catch (e) {} },
    // words
    label(r) { const t = r && Tags.get(r.id), name = t ? t.name : r ? r.name : ''; return r ? 'Drone #' + r.n + (name ? ' “' + name + '”' : '') : ''; },
    when(t, abs) {
      if (!t) return ''; const ago = Date.now() - t, d = new Date(t);
      if (ago < 3600e3 && !abs) return Math.max(1, Math.round(ago / 60000)) + ' min ago';
      return d.toLocaleString([], ago < 6 * 864e5 ? { weekday: 'short', hour: 'numeric', minute: '2-digit' } : { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    },
    // one line for the status block / log / report
    text(r, abs) {
      if (!r) return '';
      if (r.kind === 'match') return `Seen before · ${Tags.label(r)} · last seen ${Tags.when(r.prev, abs)} · ${r.visits} visits · ${r.score}% match`;
      if (r.kind === 'possible') return `Possible match · ${Tags.label(r)}? · last seen ${Tags.when(r.prev, abs)} · ${r.score}% match · not sure`;
      return `New drone · tagged ${Tags.label(r)}${r.near ? ` · closest past drone #${r.near} only ${r.score}%` : ''}`;
    },
    chip: r => !r ? '' : r.kind === 'new' ? 'new #' + r.n : (r.kind === 'possible' ? '#' + r.n + '? ' : '↺ #' + r.n + ' ') + r.score + '%',
  };
  window.RotorTags = Tags;
})();
