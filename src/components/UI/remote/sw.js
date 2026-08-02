'use strict';
// BigKiji Universe Mobile — service worker.
// 鉄則: /api/* には絶対に respondWith しない（SSEストリームを死守）。
// '/' は network-first（UIを古くしない）、静的資産のみ cache-first。
const VERSION = 'bkm-v2';
const STATIC = ['/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/vendor/three.module.js', '/vendor/three.core.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(STATIC)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/')) return; // SSE/POSTは素通し
  // Generated media is passed straight through as well. A service worker that answers
  // a ranged request out of the Cache API replies 200 with the whole body, and Safari
  // then refuses to play the video at all — caching媒体 would break exactly the files
  // this route exists to deliver.
  if (url.pathname.startsWith('/assets/') || e.request.headers.has('range')) return;
  if (url.pathname === '/' || e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .then((r) => { const cp = r.clone(); caches.open(VERSION).then((c) => c.put('/', cp)); return r; })
        .catch(() => caches.match('/')),
    );
    return;
  }
  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request).then((r) => {
      const cp = r.clone(); caches.open(VERSION).then((c) => c.put(e.request, cp)); return r;
    })),
  );
});
