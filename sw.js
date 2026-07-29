// Enough of a service worker to make the app installable, so it can run in
// standalone display mode. The address bar costs a meaningful slice of strum
// travel.
//
// Offline operation is not a goal: pairing needs the network either way. This
// is network-first so a reload always picks up new code, with the cache only
// standing in when the network does not answer.

const CACHE = 'air-guitar-v1';

const SHELL = [
  './',
  'index.html',
  'manifest.json',
  'css/base.css',
  'css/fretboard.css',
  'css/strings.css',
  'js/app.js',
  'js/audio.js',
  'js/connection.js',
  'js/music.js',
  'js/storage.js',
  'js/ui-fretboard.js',
  'js/ui-strings.js',
  'js/voicing.js',
  'icons/icon.svg',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  // Leave the CDN scripts and everything non-GET to the browser.
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(request, copy));
        return response;
      })
      .catch(() => caches.match(request).then((hit) => hit || caches.match('index.html'))),
  );
});
