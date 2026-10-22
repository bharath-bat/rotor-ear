// Rotor Ear · one app, one link. Hash routes: (none) start screen · #screen watch post · #ear listening phone ·
// #demo simulated demo (#demo&room=… runs simulated phones for that room's screen). Old links are rewritten here,
// before the other scripts read the hash: ?room=R → #ear&room=R, #room=R → #screen&room=R, role=map → #screen.
(function () {
  'use strict';
  const MODES = ['screen', 'ear', 'demo'], clean = r => (r || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12);
  (function normalize() {
    const q = new URLSearchParams(location.search), h = new URLSearchParams(location.hash.slice(1));
    const room = clean(h.get('room') || q.get('room')), role = h.get('role') || q.get('role');
    let mode = MODES.find(m => h.has(m));
    if (!mode && (room || role)) mode = role === 'map' ? 'screen' : role === 'node' || q.get('room') ? 'ear' : 'screen';
    if (!mode) { if (location.search) history.replaceState(null, '', location.pathname); return; }
    const rest = [...h].filter(([k]) => !MODES.includes(k) && k !== 'room' && k !== 'role').map(([k, v]) => k + '=' + encodeURIComponent(v));
    const hash = [mode].concat(room ? ['room=' + room] : [], rest).join('&');
    if (location.search || location.hash.slice(1) !== hash) history.replaceState(null, '', location.pathname + '#' + hash);
  })();

  const parse = () => {
    const h = new URLSearchParams(location.hash.slice(1)), room = clean(h.get('room'));
    const mode = MODES.find(m => h.has(m)) || 'home';
    return { mode: mode === 'demo' && room ? 'sim' : mode, room, h, demo: mode === 'demo' };
  };
  const SECTION = { home: 'home', screen: 'app', demo: 'app', ear: 'ear', sim: 'simv' };
  const App = window.RotorApp = { modes: {}, cur: null, key: '' };
  function route() {
    const p = parse(), key = p.mode + '|' + p.room;
    if (key === App.key) return;
    const old = App.cur && App.modes[App.cur];
    if (old && old.leave) old.leave(p.mode);
    App.cur = p.mode; App.key = key;
    Object.values(SECTION).forEach(id => document.getElementById(id).hidden = id !== SECTION[p.mode]);
    document.title = { home: 'Rotor Ear', screen: 'Rotor Ear · screen', demo: 'Rotor Ear · demo', ear: 'Rotor Ear · ear', sim: 'Rotor Ear · demo phones' }[p.mode];
    const m = App.modes[p.mode === 'demo' ? 'screen' : p.mode];
    if (m && m.enter) m.enter(p);
    window.scrollTo(0, 0);
  }
  // switch modes without a reload; routing inside the tap keeps it a user gesture (audio may start right away)
  App.go = mode => { const h = mode === 'home' ? '' : mode; if (location.hash.slice(1) !== h) history.pushState(null, '', location.pathname + (h ? '#' + h : '')); route(); };
  document.addEventListener('click', e => { const b = e.target.closest('[data-go]'); if (b) { e.preventDefault(); App.go(b.dataset.go); } });
  window.addEventListener('hashchange', route);
  window.addEventListener('popstate', route);
  document.addEventListener('DOMContentLoaded', route);
})();
