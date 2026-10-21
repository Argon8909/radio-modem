const CACHE = 'radiobridge-v1';
const FILES = ['./', './index.html', './style.css', './manifest.webmanifest', './icon.svg',
  './src/app.js', './src/packet.js', './src/modem.js', './src/storage.js', './src/channel.js',
  './src/resampler.js', './src/rx-worker.js', './src/capture-worklet.js'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('radiobridge-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(caches.open(CACHE).then(async cache => (await cache.match(event.request)) ?? fetch(event.request)));
});
self.addEventListener('message', event => {
  if (event.data === 'offline-status') event.waitUntil(caches.open(CACHE).then(async cache => {
    const ready = (await Promise.all(FILES.map(file => cache.match(file)))).every(Boolean);
    if (ready) event.ports[0]?.postMessage('offline-ready');
  }));
});
