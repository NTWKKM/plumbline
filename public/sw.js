/*
 * Offline support. Pages load network-first (so a deploy shows up on the next visit),
 * falling back to the cached shell; hashed assets and fonts load cache-first.
 * Photos never pass through here: they are read from disk and IndexedDB.
 */
// Replaced at build time (vite.config.ts) with the bundle's version and every emitted asset
const BUILD = { version: 'dev', assets: [] };
const CACHE = `plumbline-${BUILD.version}`;
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  ...BUILD.assets.map((a) => `./${a}`),
];

self.addEventListener('install', (event) => {
  // The worker only installs (and so only activates) once the whole build is cached
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com', 'api.fontshare.com', 'cdn.fontshare.com'];

/** Writes a copy in the background; a failed optional write never affects the live response. */
function cacheInBackground(event, key, res) {
  const copy = res.clone();
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.put(key, copy))
      .catch(() => undefined)
  );
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            cacheInBackground(event, './index.html', res);
            return res;
          }
          // A 5xx or 404 page must not replace the shell; serve the cached one when we have it
          return caches.match('./index.html').then((hit) => hit || res);
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  if (sameOrigin || FONT_HOSTS.includes(url.hostname)) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok || res.type === 'opaque') cacheInBackground(event, req, res);
            return res;
          })
      )
    );
  }
});
