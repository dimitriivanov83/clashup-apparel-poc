// ClashUp Apparel — Service Worker V3 (network-first for everything)
const CACHE_NAME = 'clashup-apparel-v3';

self.addEventListener('install', (e) => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  // Delete ALL old caches
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  // Network-first for everything — always get fresh content
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        // Cache a copy for offline
        const clone = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(e.request, clone));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
