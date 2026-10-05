// Cache names and request routing for the service worker (sw.ts), kept apart so they can be tested.

const CACHE_PREFIX = 'freecan-studio-';
/** The demo is cached the first time it runs and kept across app updates. */
export const DEMO_CACHE = `${CACHE_PREFIX}demo-v1`;

export function shellCacheName(version: string): string {
  return `${CACHE_PREFIX}shell-${version}`;
}

/** This app's caches that the current version no longer uses. Other caches on the origin are left alone. */
export function staleCaches(cacheNames: string[], currentShell: string): string[] {
  return cacheNames.filter((name) => name.startsWith(CACHE_PREFIX) && name !== currentShell && name !== DEMO_CACHE);
}

/**
 * How the service worker answers a request, or null to leave it to the browser:
 * - `asset`: fingerprinted files under `assets/`, which never change, so cache first.
 * - `navigation`: the page. Network first, so a deploy is picked up, with the cached page offline.
 * - `demo`: the demo log and DBC. Network first, keeping a copy for offline use.
 * - `static`: other files of the app (the manifest, icons). Network first, falling back to the cache.
 */
export type Route = 'asset' | 'navigation' | 'demo' | 'static';

export function routeFor(request: { method: string; mode: string; url: string }, scope: string): Route | null {
  if (request.method !== 'GET') return null;
  const url = new URL(request.url);
  const base = new URL(scope);
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) return null;
  if (request.mode === 'navigate') return 'navigation';
  const path = url.pathname.slice(base.pathname.length);
  if (path.startsWith('assets/')) return 'asset';
  if (path.startsWith('demo/')) return 'demo';
  return 'static';
}
