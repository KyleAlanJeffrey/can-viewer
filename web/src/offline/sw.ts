// The service worker, built into /sw.js by precachePlugin. It keeps the app shell so the app opens
// without a network, and the demo once it has run. User files never pass through here: they are
// read with the File API and kept in IndexedDB, never fetched.

import type { PrecacheManifest } from './precachePlugin';
import { DEMO_CACHE, routeFor, shellCacheName, staleCaches } from './swRules';

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
const scopeUrl = (path: string) => new URL(path, sw.registration.scope).href;

sw.addEventListener('install', (event) => {
  // `no-cache` revalidates with the server, so a stale page in the HTTP cache is never kept.
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(files.map((file) => new Request(scopeUrl(file), { cache: 'no-cache' })))),
  );
  // No skipWaiting here: a page keeps the version it loaded until the user picks Reload.
});

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
  switch (routeFor(request, sw.registration.scope)) {
    case 'asset':
      event.respondWith(fromCacheFirst(request));
      break;
    case 'navigation':
      event.respondWith(fromNetworkFirst(request, () => caches.match(scopeUrl('./'), SHELL_MATCH)));
      break;
    case 'demo':
      event.respondWith(demo(event));
      break;
    case 'static':
      event.respondWith(fromNetworkFirst(request, () => caches.match(request, SHELL_MATCH)));
      break;
  }
});

async function fromCacheFirst(request: Request): Promise<Response> {
  return (await caches.match(request, SHELL_MATCH)) ?? fetch(request);
}

async function fromNetworkFirst(request: Request, fallback: () => Promise<Response | undefined>): Promise<Response> {
  try {
    return await fetch(request);
  } catch (error) {
    const cached = await fallback();
    if (cached) return cached;
    throw error;
  }
}

async function demo(event: FetchEvent): Promise<Response> {
  const request = event.request;
  try {
    const response = await fetch(request);
    if (response.status === 200 && response.type === 'basic') {
      const copy = response.clone();
      event.waitUntil(caches.open(DEMO_CACHE).then((cache) => cache.put(request, copy)));
    }
    return response;
  } catch (error) {
    const cached = await caches.match(request, { cacheName: DEMO_CACHE, ignoreVary: true });
    if (cached) return cached;
    throw error;
  }
}
