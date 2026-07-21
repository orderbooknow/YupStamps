// sw.js
const CACHE_NAME = 'yupstamps-v1';
const urlsToCache = [
  '/YupStamps/',
  '/YupStamps/index.html',
  '/YupStamps/supabase.js',
  '/YupStamps/manifest.json'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(urlsToCache))
  );
});

self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request)
      .then(response => response || fetch(event.request))
  );
});