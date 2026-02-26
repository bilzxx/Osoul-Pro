'use strict';

const CURRENT_VERSION = '1.0.45';
const CACHE_PREFIX = 'osoul-';
const STATIC_CACHE = `${CACHE_PREFIX}static-${CURRENT_VERSION}`;
const DATA_CACHE = `${CACHE_PREFIX}data-${CURRENT_VERSION}`;

const STATIC_ASSETS = [
  './',
  './index.html',
  './pages/index.html',
  './manifest.json',
  './remote_version.json',
  './update_popup.json',
  './assets/css/styles.css?v=44',
  './assets/js/script.js?v=43',
  './data/exchanges.spot.js',
  './services/feeCalculator.js',
  './ui/tableRenderer.js',
  './ui/onboardingModal.js',
  './ui/exchangeSettings.js',
  './assets/icons/pwa/icon-192.png',
  './assets/icons/pwa/icon-512.png',
  './assets/icons/pwa/icon-180.png',
  './assets/icons/Osoul Pro Dark Mode.png',
  './assets/icons/Osoul Pro Light Mode.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    await precacheStaticAssets();
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    await cleanupOldCaches();
    await self.clients.claim();
    await broadcastMessage({
      type: 'PWA_UPDATE_READY',
      version: CURRENT_VERSION
    });
  })());
});

self.addEventListener('message', (event) => {
  if (!event?.data || typeof event.data !== 'object') return;
  if (event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request, STATIC_CACHE, './pages/index.html'));
    return;
  }

  if (isDataRequest(request, url)) {
    event.respondWith(networkFirst(request, DATA_CACHE));
    return;
  }

  // Keep CSS/JS and local app modules fresh to avoid stale UI after deploys.
  if (isCoreAppAssetRequest(url)) {
    event.respondWith(networkFirst(request, STATIC_CACHE));
    return;
  }

  if (isStaticAssetRequest(request, url)) {
    event.respondWith(cacheFirst(request, STATIC_CACHE));
  }
});

function isCoreAppAssetRequest(url) {
  if (url.origin !== self.location.origin) return false;
  return (
    url.pathname.includes('/assets/css/') ||
    url.pathname.includes('/assets/js/') ||
    url.pathname.includes('/ui/') ||
    url.pathname.includes('/services/') ||
    url.pathname.includes('/data/')
  );
}

function isStaticAssetRequest(request, url) {
  if (['style', 'script', 'image', 'font', 'worker'].includes(request.destination)) {
    return true;
  }

  if (url.origin !== self.location.origin) {
    return ['style', 'script', 'image', 'font'].includes(request.destination);
  }

  return (
    url.pathname.includes('/assets/') ||
    url.pathname.includes('/ui/') ||
    url.pathname.includes('/services/') ||
    url.pathname.endsWith('/manifest.json') ||
    url.pathname.endsWith('/favicon.ico')
  );
}

function isDataRequest(request, url) {
  const accept = (request.headers.get('accept') || '').toLowerCase();
  if (url.pathname.endsWith('.json')) return true;
  if (accept.includes('application/json')) return true;
  if (url.origin !== self.location.origin && request.destination === '') return true;

  const dataHints = [
    'api',
    'ticker',
    'price',
    'prices',
    'markets',
    'coingecko',
    'x.com',
    'twitter',
    'jina.ai',
    'binance',
    'kucoin',
    'kraken',
    'bybit',
    'okx'
  ];

  const combined = `${url.hostname}${url.pathname}`.toLowerCase();
  return dataHints.some((token) => combined.includes(token));
}

async function precacheStaticAssets() {
  const cache = await caches.open(STATIC_CACHE);

  await Promise.allSettled(
    STATIC_ASSETS.map(async (assetPath) => {
      try {
        await cache.add(new Request(assetPath, { cache: 'reload' }));
      } catch (error) {
        console.warn('[SW] Failed to pre-cache asset:', assetPath, error);
      }
    })
  );
}

async function cleanupOldCaches() {
  const cacheNames = await caches.keys();
  const activeCaches = new Set([STATIC_CACHE, DATA_CACHE]);

  await Promise.all(
    cacheNames
      .filter((name) => name.startsWith(CACHE_PREFIX) && !activeCaches.has(name))
      .map((name) => caches.delete(name))
  );
}

async function cacheFirst(request, cacheName) {
  const cachedResponse = await caches.match(request);
  if (cachedResponse) return cachedResponse;

  const networkResponse = await fetch(request);
  const cache = await caches.open(cacheName);
  if (networkResponse && (networkResponse.ok || networkResponse.type === 'opaque')) {
    cache.put(request, networkResponse.clone());
  }
  return networkResponse;
}

async function networkFirst(request, cacheName, fallbackUrl) {
  try {
    const networkResponse = await fetchWithTimeout(request, 9000);
    const cache = await caches.open(cacheName);
    if (networkResponse && (networkResponse.ok || networkResponse.type === 'opaque')) {
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch (_error) {
    const cachedResponse = await caches.match(request);
    if (cachedResponse) return cachedResponse;

    if (fallbackUrl) {
      const fallbackResponse = await caches.match(fallbackUrl);
      if (fallbackResponse) return fallbackResponse;
    }

    throw _error;
  }
}

function fetchWithTimeout(request, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timerId = setTimeout(() => {
      reject(new Error('Network timeout'));
    }, timeoutMs);

    fetch(request)
      .then((response) => {
        clearTimeout(timerId);
        resolve(response);
      })
      .catch((error) => {
        clearTimeout(timerId);
        reject(error);
      });
  });
}

async function broadcastMessage(payload) {
  const clients = await self.clients.matchAll({
    type: 'window',
    includeUncontrolled: true
  });

  clients.forEach((client) => {
    client.postMessage(payload);
  });
}
