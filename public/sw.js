// Service Worker — تخزين نموذج Vosk والسكربتات للعمل offline بعد أول تنزيل
const CACHE_NAME = 'smart-assistant-v1';
const PRECACHE_URLS = [
  '/',
  '/manifest.json',
  'https://cdn.jsdelivr.net/npm/vosk@0.0.8/dist/vosk.js',
  'https://cdn.jsdelivr.net/npm/fflate@0.8.2/esm/browser.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// استراتيجية: stale-while-revalidate لكل الطلبات
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const fetchPromise = fetch(event.request)
        .then((response) => {
          // خزّن الردود الصالحة (نفس الأصل أو CDN)
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => cached);
      return cached || fetchPromise;
    })
  );
});
