// Service worker intentionally minimal. The previous cache-first worker could keep serving stale broken JS.
const CACHE_NAME = 'storm-shelter-dashboard-v10';
self.addEventListener('install', event => self.skipWaiting());
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => { return; });
