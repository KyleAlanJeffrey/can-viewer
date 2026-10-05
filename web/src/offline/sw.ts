// The service worker, built into /sw.js by precachePlugin. It keeps the app shell so the app opens
// without a network, and the demo once it has run. User files never pass through here: they are
// read with the File API and kept in IndexedDB, never fetched.

import type { PrecacheManifest } from './precachePlugin';
import { DEMO_CACHE, routeFor, shellCacheName, staleCaches } from './swRules';
import { cacheFirst, checkPrecacheResponse, networkFirst, networkFirstKeeping } from './swStrategies';

// The build replaces this with the manifest of the files it wrote.
declare const __FREECAN_PRECACHE__: PrecacheManifest;

// The few service worker types used here. The WebWorker lib clashes with the DOM lib the app builds with.
interface ExtendableEvent extends Event {
  waitUntil(promise: Promise<unknown>): void;
}
interface FetchEvent extends ExtendableEvent {
  readonly request: Request;
  respondWith(response: Promise<Response>): void;
}
interface ServiceWorkerScope {
  readonly registration: ServiceWorkerRegistration;
  readonly clients: { claim(): Promise<void> };
  skipWaiting(): Promise<void>;
  addEventListener(type: 'install' | 'activate', listener: (event: ExtendableEvent) => void): void;
  addEventListener(type: 'fetch', listener: (event: FetchEvent) => void): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
}

const sw = self as unknown as ServiceWorkerScope;
const { version, files } = __FREECAN_PRECACHE__;
const SHELL_CACHE = shellCacheName(version);
// Each URL is cached once, so a `Vary` header from the server (`Vary: Origin` on a module script, say)
// must not make the cached copy miss.
const SHELL_MATCH: MultiCacheQueryOptions = { cacheName: SHELL_CACHE, ignoreVary: true };
/** Past this, an offline-ish connection gets the cached page instead of a blank window. */
const NAVIGATION_TIMEOUT_MS = 4000;
const scopeUrl = (path: string) => new URL(path, sw.registration.scope).href;

sw.addEventListener('install', (event) => {
  // No skipWaiting here: a page keeps the version it loaded until the user picks Reload.
  event.waitUntil(precache());
});

/** Like `cache.addAll`, but refuses a page sent in place of a missing script. */
async function precache() {
  const entries = await Promise.all(
    files.map(async (file) => {
      // `no-cache` revalidates with the server, so a stale page in the HTTP cache is never kept.
      const request = new Request(scopeUrl(file), { cache: 'no-cache' });
      const response = await fetch(request);
      checkPrecacheResponse(file, response);
      return [request, response] as const;
    }),
  );
  const cache = await caches.open(SHELL_CACHE);
  await Promise.all(entries.map(([request, response]) => cache.put(request, response)));
}

sw.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(staleCaches(names, SHELL_CACHE).map((name) => caches.delete(name))))
      // Lets the first install serve the page that registered it, so the app works offline from the first visit.
      .then(() => sw.clients.claim()),
  );
});

sw.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') void sw.skipWaiting();
});

sw.addEventListener('fetch', (event) => {
  const request = event.request;
  const load = () => fetch(request);
  switch (routeFor(request, sw.registration.scope)) {
    case 'asset':
      // Any cache, so a tab still on the previous version finds its files in the shell kept for it.
      event.respondWith(cacheFirst(() => caches.match(request, { ignoreVary: true }), load));
      break;
    case 'navigation':
      event.respondWith(networkFirst(load, () => caches.match(scopeUrl('./'), SHELL_MATCH), NAVIGATION_TIMEOUT_MS));
      break;
    case 'demo':
      event.respondWith(
        networkFirstKeeping(
          load,
          () => caches.match(request, { cacheName: DEMO_CACHE, ignoreVary: true }),
          (copy) => event.waitUntil(caches.open(DEMO_CACHE).then((cache) => cache.put(request, copy))),
        ),
      );
      break;
    case 'static':
      event.respondWith(networkFirst(load, () => caches.match(request, SHELL_MATCH)));
      break;
  }
});
