// Service Worker for Na'jiki PWA
const CACHE_NAME = 'najiki-cache-v6';
const OFFLINE_URL = '/offline';

// NOTE: every entry here must actually exist, otherwise the request 404s.
// The list previously included '/favicon.ico', which this app does not serve
// (Next.js only emits /favicon.ico when src/app/favicon.ico exists) — so
// cache.addAll() rejected and the ENTIRE precache silently failed, leaving the
// offline page and all icons uncached.
const PRECACHE_ASSETS = [
  OFFLINE_URL,
  '/manifest.json',
  '/logo.svg',
  '/icons/icon-192x192.png',
  '/icons/icon-512x512.png',
  '/icons/icon-maskable-192x192.png',
  '/icons/icon-maskable-512x512.png',
  '/icons/apple-touch-icon.png',
  '/icons/favicon-32x32.png',
];

// Install Event - Precache static assets.
// Each asset is cached independently so a single missing file can no longer
// abort caching for everything else.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return Promise.all(
        PRECACHE_ASSETS.map((asset) =>
          cache.add(new Request(asset, { cache: 'reload' })).catch((err) => {
            console.warn('[SW] Failed to precache', asset, err);
          })
        )
      );
    }).then(() => self.skipWaiting())
  );
});

// Activate Event - Purge ALL old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((name) => {
          if (name !== CACHE_NAME) {
            return caches.delete(name);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch Event
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // NEVER intercept non-GET, API routes, Auth, Webpack chunks, Next.js internal files, HMR
  if (request.method !== 'GET') return;
  if (
    url.pathname.startsWith('/_next/') ||
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/auth/') ||
    url.pathname.includes('webpack') ||
    url.pathname.includes('hot-update') ||
    url.pathname.includes('supabase') ||
    url.pathname.includes('upstash')
  ) {
    return;
  }

  // Handle Navigation / HTML pages -> Always Network Only. If offline, serve /offline page.
  // NEVER cache HTML pages, as they contain references to ephemeral Webpack chunk hashes!
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(async () => {
        const offlinePage = await caches.match(OFFLINE_URL);
        if (offlinePage) {
          return offlinePage;
        }
        return new Response('Offline - No connection available', {
          status: 503,
          headers: { 'Content-Type': 'text/plain' },
        });
      })
    );
    return;
  }

  // Handle Static Media Assets (icons, images, fonts) -> Cache First with Network Fallback
  if (
    url.pathname.startsWith('/icons/') ||
    url.pathname.endsWith('.svg') ||
    url.pathname.endsWith('.png') ||
    url.pathname.endsWith('.jpg') ||
    url.pathname.endsWith('.woff2')
  ) {
    event.respondWith(
      caches.match(request).then((cachedResponse) => {
        if (cachedResponse) {
          return cachedResponse;
        }
        return fetch(request).then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const responseToCache = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(request, responseToCache);
            });
          }
          return networkResponse;
        });
      })
    );
    return;
  }

  // Default: Network fetch directly
  event.respondWith(fetch(request));
});
