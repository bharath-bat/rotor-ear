// Rotor Ear · incident log, shared by the screen and the ear. Everything stays on this phone:
// incidents in localStorage, camera clips in IndexedDB. Nothing here is ever uploaded.
// Incident: { id, type: 'drone'|'hum', t0, t1, cls, peak (match score), agree ('3 of 4'), flights: [..], slot (0 | 1: the second of
//   two drones at once, drawn blue), f0 (Hz),
//   track: [[s since t0, x m, y m, (z m when the height is known)], ..], h: {z, lo, hi} | absent (height unknown), dir, demo, room, pins: [{label, pos}], geo: {lat0, lon0, rot} | null,
//   clips: [{ phone, id }] (screen: "clip saved" flags from ears),
//   bob: { v: 'bird'|'bot'|'none', c (0–100), r (reason code), f (wing beats/s), h (rotor hum: 1 yes, 0 no, -1 unknown), a (bird image score, -1 none), phone }
//     (Bird or Bot, from an ear's camera clip; words rebuilt by RotorBird.text),
//   why: { id, text, x? } (the reason in plain words; x = the feature values behind it, hum only),
//   gid (one id for one drone across linked watch posts), from / to (the linked post it came from / went on to) }
(function () {
  'use strict';
  const KEY = 'rotorear-log-v1', MAX = 100, MAXPTS = 600;
  localStorage.removeItem('rotorear-timeline-v2'); localStorage.removeItem('rotorear-timeline'); // the old timeline is now this log
  const esc = t => String(t == null ? '' : t).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]);
  const clock = t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  const day = t => new Date(t).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
  const mmss = ms => { const s = Math.max(0, Math.round(ms / 1000)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  const word = s => s >= 85 ? 'very likely' : s >= 65 ? 'likely' : 'possible';
  let list = []; try { list = JSON.parse(localStorage.getItem(KEY) || '[]'); } catch (e) {}
  let savedAt = 0;
  const Log = {
    get list() { return list; },
    newId: () => 'i' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    add(inc) { list.unshift(inc); list = list.slice(0, MAX); Log.save(true); return inc; },
    get: id => list.find(x => x.id === id),
    upsert(inc) { const i = list.findIndex(x => x.id === inc.id); if (i < 0) return Log.add(Object.assign({ track: [], flights: [], clips: [] }, inc)); list[i] = Object.assign(list[i], inc); Log.save(true); return list[i]; },
    point(inc, x, y, z) { const s = +((Date.now() - inc.t0) / 1000).toFixed(1), L = inc.track, p = L[L.length - 1]; if (p && s - p[0] < 0.5) return; L.push(z == null ? [s, +x.toFixed(2), +y.toFixed(2)] : [s, +x.toFixed(2), +y.toFixed(2), +z.toFixed(1)]); if (L.length > MAXPTS) inc.track = L.filter((q, i) => i % 2 === 0); },
    save(force) { const now = Date.now(); if (!force && now - savedAt < 2000) return; savedAt = now; try { localStorage.setItem(KEY, JSON.stringify(list)); } catch (e) { list = list.slice(0, Math.floor(list.length / 2)); } },
    clear() { list = []; Log.save(true); return Clips.clear(); },
    reload() { try { list = JSON.parse(localStorage.getItem(KEY) || '[]'); } catch (e) {} },
    word, clock, mmss,
    dur: e => mmss((e.t1 || e.t0) - e.t0),
    // one row in a log list (screen and ear)
    row(e, clips) {
      const n = (clips || []).length + (e.clips || []).length;
      return `<button class="lrow${e.slot ? ' d2' : ''}" data-inc="${esc(e.id)}"><b>${clock(e.t0)}</b><span><i>${esc(e.cls || (e.type === 'hum' ? 'Not a drone' : 'Drone'))}</i><small>${day(e.t0)}${e.t1 ? ' · ' + Log.dur(e) : ''}${e.type === 'drone' && e.peak ? ' · ' + word(e.peak) : ''}${e.agree ? ' · ' + esc(e.agree) : ''}${e.flights && e.flights.length ? ' · ' + esc(e.flights.join(', ')) : ''}${n ? ' · 🎥 ' + n : ''}${e.bob ? ' · ' + RotorBird.chip(e.bob) : ''}${e.from ? ' · from ' + esc(e.from) : ''}${e.to ? ' · on to ' + esc(e.to) : ''}</small></span><span class="tag${e.demo ? ' demo' : ''}">${e.demo ? 'DEMO' : 'real'}</span></button>`;
    },
    exportJSON() {
      const blob = new Blob([JSON.stringify({ app: 'Rotor Ear', exported: new Date().toISOString(), note: 'positions are metres in the phones\' local frame; geo anchors them when GPS was shared', incidents: list }, null, 1)], { type: 'application/json' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'rotor-ear-log-' + new Date().toISOString().slice(0, 10) + '.json'; document.body.appendChild(a); a.click(); a.remove();
    },
    // a printable one-page report (print to PDF from the browser)
    report(items) {
      items = (items || list).slice(0, 14);
      const svg = e => { const T = e.track || []; if (T.length < 2) return '<span class="none">no track</span>';
        const xs = T.map(p => p[1]).concat((e.pins || []).map(p => p.pos[0])), ys = T.map(p => p[2]).concat((e.pins || []).map(p => p.pos[1]));
        const x0 = Math.min(...xs) - 1, y0 = Math.min(...ys) - 1, s = Math.max(Math.max(...xs) - x0, Math.max(...ys) - y0) + 1, P = (x, y) => [((x - x0) / s * 90 + 5).toFixed(1), (95 - (y - y0) / s * 90).toFixed(1)];
        return `<svg viewBox="0 0 100 100" width="76" height="76"><rect width="100" height="100" fill="#fff" stroke="#bbb"/>${(e.pins || []).map(p => { const [a, b] = P(p.pos[0], p.pos[1]); return `<circle cx="${a}" cy="${b}" r="5" fill="#ddd" stroke="#555"/><text x="${a}" y="${+b + 2.5}" font-size="7" text-anchor="middle">${esc(p.label)}</text>`; }).join('')}<polyline fill="none" stroke="${e.slot ? '#0062C4' : '#C93500'}" stroke-width="2" points="${T.map(p => P(p[1], p[2]).join(',')).join(' ')}"/></svg>`; };
      const drones = items.filter(e => e.type === 'drone'), g = items.find(e => e.geo);
      return `<!doctype html><html><head><meta charset="utf-8"><title>Rotor Ear report</title><style>
@page{size:A4;margin:12mm}body{font:11px/1.35 system-ui,sans-serif;color:#111;margin:0;padding:12px}h1{font-size:20px;margin:0}
.meta{color:#444;margin:2px 0 10px}table{width:100%;border-collapse:collapse}th,td{border-bottom:1px solid #ccc;padding:4px 5px;text-align:left;vertical-align:middle}
th{font-size:10px;text-transform:uppercase;color:#555}.demo{border:1.5px dashed #5B3FD1;color:#5B3FD1;font-weight:700;padding:0 3px;border-radius:3px}.none{color:#888}
.foot{margin-top:10px;color:#555;font-size:10px}@media screen{body{max-width:780px;margin:0 auto}}</style></head><body>
<h1>Rotor Ear · incident report</h1><div class="meta">Generated ${esc(new Date().toLocaleString())} · ${drones.length} drone incident${drones.length === 1 ? '' : 's'}, ${items.length - drones.length} not-a-drone${g ? ` · phone A at ${g.geo.lat0.toFixed(5)}, ${g.geo.lon0.toFixed(5)}` : ''}</div>
<table><tr><th>Start</th><th>Length</th><th>What</th><th>How sure</th><th>Phones</th><th>Flight</th><th>Where</th><th>Height</th><th>Track</th><th>Clip</th></tr>
${items.map(e => `<tr><td><b>${clock(e.t0)}</b><br>${day(e.t0)}</td><td>${Log.dur(e)}</td><td>${esc(e.cls || '')}${e.demo ? ' <span class="demo">DEMO</span>' : ''}${e.why ? '<br><small>' + esc(e.why.text) + '</small>' : ''}${e.bob ? '<br><small><b>Camera: ' + esc(RotorBird.chip(e.bob)) + '</b> · ' + esc(RotorBird.text(e.bob)) + '</small>' : ''}${e.from || e.to ? `<br><small>drone #${esc(String(e.gid).slice(-4))}${e.from ? ' · handed over from ' + esc(e.from) : ''}${e.to ? ' · handed on to ' + esc(e.to) : ''}</small>` : ''}</td><td>${e.type === 'drone' ? word(e.peak || 0) + '<br>match ' + (e.peak || 0) : '—'}</td><td>${esc(e.agree || '—')}</td><td>${esc((e.flights || []).join(', ') || '—')}</td><td>${esc(e.dir || '—')}</td><td>${e.type !== 'drone' ? '—' : e.h ? `~${e.h.z} m<br><small>${e.h.lo}–${e.h.hi} m</small>` : 'unknown'}</td><td>${e.type === 'drone' ? svg(e) : ''}</td><td>${(e.clips || []).length ? '🎥 ' + e.clips.map(c => 'phone ' + esc(c.phone)).join(', ') : '—'}</td></tr>`).join('')}
</table><div class="foot">Passive acoustic detection: phones listen for rotor hum; only numbers were shared between phones, never audio. "How sure" is a match to a sound template, not a measured accuracy. Track: metres in the phones' frame (letters = phones). Height: from loudness and arrival times across the phones, with its likely range; "unknown" when the phones' layout can't tell. Clips stay on the phone that recorded them. Camera: Bird / Bot from the clip's motion (wing beat, path, size) and that phone's sound, worked out on that phone; a guess, not a measured accuracy.${list.length > items.length ? ` ${list.length - items.length} older entries are in the JSON export.` : ''}</div></body></html>`;
    },
    openReport() { const w = window.open(URL.createObjectURL(new Blob([Log.report()], { type: 'text/html' })), '_blank'); if (!w) alert('Allow pop-ups to open the report.'); },
  };

  // camera clips: IndexedDB on this phone only
  let dbp = null;
  const db = () => dbp || (dbp = new Promise((ok, no) => { const r = indexedDB.open('rotorear-clips', 1); r.onupgradeneeded = () => r.result.createObjectStore('clips', { keyPath: 'id' }); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); }));
  const tx = (mode, f) => db().then(d => new Promise((ok, no) => { const t = d.transaction('clips', mode), st = t.objectStore('clips'), r = f(st); t.oncomplete = () => ok(r && r.result); t.onerror = () => no(t.error); }));
  const Clips = {
    put: clip => tx('readwrite', st => st.put(clip)), // { id, inc, t, type, blob, secs }
    all: () => tx('readonly', st => st.getAll()).then(a => (a || []).sort((x, y) => y.t - x.t)),
    del: id => tx('readwrite', st => st.delete(id)),
    clear: () => tx('readwrite', st => st.clear()),
  };
  window.RotorLog = Log; window.RotorClips = Clips;
})();
