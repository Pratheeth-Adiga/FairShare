const CACHE_NAME = 'fairshare-v1';

// CSP header injected into cached navigate responses so index.html
// served from cache carries the same policy as the meta tag in the document.
const NAVIGATE_CSP = "default-src 'self'; script-src 'self'; connect-src 'self' stun: turn: turns:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'self'; frame-ancestors 'none';";
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/favicon.svg',
];
// filled in at build time by swCacheVersionPlugin with the hashed JS/CSS
// bundle filenames, so a genuinely-first offline load (before any fetch has ever
// succeeded) can still serve the app shell instead of just the empty index.html.
const BUILT_ASSETS = [];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS.concat(BUILT_ASSETS)))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  if (request.method !== 'GET') return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() =>
        caches.match('/index.html').then((response) => {
          if (!response) return Response.error();
          const headers = new Headers(response.headers);
          headers.set('Content-Security-Policy', NAVIGATE_CSP);
          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers,
          });
        })
      )
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      const fetchPromise = fetch(request).then((response) => {
        // an SPA fallback answers a missing asset with index.html, never cache that as the asset
        const type = response.headers.get('content-type') || '';
        if (response.ok && !type.includes('text/html')) {
          const clone = response.clone();
          // keep the worker alive until the write finishes
          event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(request, clone)));
        }
        return response;
      });
      if (cached) {
        // offline refresh of a cached asset shouldn't become an unhandled rejection
        fetchPromise.catch(() => cached);
        return cached;
      }
      return fetchPromise.catch(() => Response.error());
    })
  );
});
