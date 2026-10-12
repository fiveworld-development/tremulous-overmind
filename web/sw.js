// Tremulous Overmind – service worker: makes the page installable and opens the app
// instantly. Game data (assets/*.pk3) is cached by the engine itself, status and
// websockets always go to the network.
'use strict';
var CACHE = 'overmind-shell-%SHELL_VER%';
var BASE = '%BASE%';

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.add(BASE); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf('overmind-') === 0 && k !== CACHE; })
      .map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== location.origin || url.pathname.indexOf(BASE) !== 0) return;
  var p = url.pathname.slice(BASE.length);
  if (/^(assets\/|ws\/|status\.json)/.test(p)) return;

  // pages: network first so a deploy shows up right away, cache when offline
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then(function (r) {
      // only the start page itself becomes the offline page, never another URL under BASE
      var start = p === '' || p === 'index.html';
      if (r.ok && start && /^text\/html/.test(r.headers.get('Content-Type') || '')) {
        var copy = r.clone(); caches.open(CACHE).then(function (c) { c.put(BASE, copy); });
      }
      return r;
    }).catch(function () { return caches.match(BASE); }));
    return;
  }

  // versioned or content-addressed files and images: cache first
  if (/\.(css|js|wasm|png|jpg|svg|webmanifest)$/.test(url.pathname)) {
    e.respondWith(caches.match(req).then(function (hit) {
      return hit || fetch(req).then(function (r) {
        if (r.ok) { var copy = r.clone(); caches.open(CACHE).then(function (c) { c.put(req, copy); }); }
        return r;
      });
    }));
  }
});
