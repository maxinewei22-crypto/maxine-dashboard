// Service Worker for Maxine's Creator Dashboard - PWA
// Strategy: Network-first for HTML (always latest), cache-first for static assets
const CACHE_NAME = 'maxine-dashboard-v9';
const ASSETS = [
  './creator-dashboard.html',
  './manifest.json',
  './icon-512.jpg',
  './icon-192.png',
  './icon-512.png',
  './icon-192-maskable.png',
  './icon-512-maskable.png',
  './apple-touch-icon.png',
  './favicon.png'
];

// Install: cache core assets, skip waiting to activate immediately
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS).catch((err) => {
        console.log('Cache addAll error (some assets may be missing):', err);
        // Cache individually, ignoring failures
        return Promise.allSettled(
          ASSETS.map(url => cache.add(url))
        );
      });
    })
  );
  self.skipWaiting();
});

// Activate: clean ALL old caches and take control
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => {
          console.log('Deleting old cache:', key);
          return caches.delete(key);
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch: network-first for everything (online-priority mode)
// User chose "online only" - SW just ensures latest content
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // Skip cross-origin requests (e.g., ECharts CDN)
  if (url.origin !== self.location.origin) {
    event.respondWith(fetch(event.request));
    return;
  }

  // Skip API calls - always go to network
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(event.request));
    return;
  }

  // Network-first for all requests (online priority)
  event.respondWith(
    fetch(event.request).then((response) => {
      // Cache successful responses for offline fallback
      if (response && response.status === 200 && response.type === 'basic') {
        const responseClone = response.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(event.request, responseClone);
        });
      }
      return response;
    }).catch(() => {
      // Fallback to cache if network fails
      return caches.match(event.request).then((cached) => {
        if (cached) return cached;
        // Ultimate fallback for navigation requests
        if (event.request.destination === 'document') {
          return caches.match('./creator-dashboard.html');
        }
      });
    })
  );
});

// Handle messages from the page (e.g., trigger update)
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
