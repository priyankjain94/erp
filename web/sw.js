/* Make My Space service worker: the app shell and libraries work offline; API calls always go to the network
   (the app itself queues field changes while offline and syncs them later). */
const CACHE = 'mms-shell-v3';
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icon.svg', '/icon-192.png', '/logo.svg'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.pathname.startsWith('/api/')) return;
  if (e.request.mode === 'navigate') {
    // Open instantly from the saved copy; fetch the latest in the background. If it changed, tell the page
    // so it can offer a one-tap reload. First visit (nothing saved yet) goes to the network as before.
    const fresh = fetch(e.request, { cache: 'no-cache' }).then(async r => {
      if (r.ok && r.type === 'basic') {
        const cache = await caches.open(CACHE), old = await cache.match('/index.html');
        const [a, b] = await Promise.all([r.clone().text(), old ? old.text() : Promise.resolve(null)]);
        await cache.put('/index.html', r.clone());
        if (old && a !== b) (await self.clients.matchAll({ type: 'window' })).forEach(c => c.postMessage({ type: 'mms-update' }));
      }
      return r;
    });
    e.respondWith(caches.match('/index.html').then(hit => {
      if (hit) { e.waitUntil(fresh.catch(() => {})); return hit; }
      return fresh.catch(() => caches.match('/index.html'));
    }));
    return;
  }
  const lib = /cdnjs\.cloudflare\.com|unpkg\.com|fonts\.(googleapis|gstatic)\.com/.test(u.host);
  if (lib || u.origin === location.origin) {
    e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request).then(r => { if (r.ok || r.type === 'opaque') { const c = r.clone(); caches.open(CACHE).then(x => x.put(e.request, c)); } return r; })));
  }
});
