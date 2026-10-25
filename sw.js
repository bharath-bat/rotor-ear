// Rotor Ear · offline app shell. After one online visit the app (including hotspot mode and its QR libraries) loads with
// no internet. Network first, so an update shows up on the next online load; the cache is only the fallback.
// Same-origin GETs only: map tiles, the camera model CDN and the PeerJS relay are left to the network.
const CACHE = 'rotorear-shell-v1';
const SHELL = ['./', 'index.html', 'watch.css', 'app.js', 'detector.js', 'reid.js', 'tripwire.js', 'log.js', 'samples.js', 'bird.js', 'watch.js', 'ear.js',
  'mesh/seal.js', 'mesh/core.js', 'mesh/hotspot.js', 'mesh/peerjs.min.js', 'mesh/envelope-worklet.js', 'lib/qrcode.min.js', 'lib/jsQR.min.js', 'lib/leaflet.js', 'lib/leaflet.css'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const r = e.request; if (r.method !== 'GET' || new URL(r.url).origin !== location.origin) return;
  e.respondWith(fetch(r).then(res => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(r, copy)); } return res; })
    .catch(() => caches.match(r, { ignoreSearch: true }).then(m => m || (r.mode === 'navigate' ? caches.match('index.html') : Response.error()))));
});
