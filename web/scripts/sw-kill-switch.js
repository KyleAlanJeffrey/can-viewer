// Emergency replacement for /sw.js, for when a broken service worker must be removed from users'
// browsers. It takes over at once, deletes this app's caches, unregisters itself and reloads the tabs
// it controlled, which then load straight from the network. See "Deployment" in CONTRIBUTING.md.
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((name) => name.startsWith('freecan-studio-')).map((name) => caches.delete(name)));
      await self.registration.unregister();
      // Only tabs this worker controls: a page that registers it again starts uncontrolled, so no reload loop.
      const tabs = await self.clients.matchAll({ type: 'window' });
      await Promise.all(tabs.map((tab) => tab.navigate(tab.url)));
    })(),
  );
});
