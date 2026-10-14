/* CourseForge Self-Unregistering Service Worker to purge legacy caches */
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches
      .keys()
      .then(keys => {
        return Promise.all(keys.map(key => caches.delete(key)));
      })
      .then(() => {
        return self.registration.unregister();
      })
      .then(() => {
        return self.clients.claim();
      }),
  );
});
