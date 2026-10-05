import type { Plugin } from 'vite';

/** Where the service worker is served from. Its scope is the whole app. */
export const SW_FILE = 'sw.js';
/** Stands in for the precache manifest in the service worker source until the build fills it in. */
export const PRECACHE_PLACEHOLDER = '__FREECAN_PRECACHE__';

export interface PrecacheManifest {
  version: string;
  /** URLs relative to the service worker. */
  files: string[];
}

/**
 * The app shell: the page (as `./`, the URL it is served at) and everything Vite fingerprinted under
 * `assets/`, plus the given files from `public/`. The demo log is left out on purpose; it is cached
 * the first time it is used.
 */
export function precacheFiles(bundleFiles: string[], publicFiles: string[]): string[] {
  const built = bundleFiles
    .filter((file) => file === 'index.html' || (file.startsWith('assets/') && !file.endsWith('.map')))
    .map((file) => (file === 'index.html' ? './' : file));
  return [...new Set([...built, ...publicFiles])].sort();
}

/** Changes whenever a fingerprinted file or the page does, so each build gets its own cache. */
export async function precacheVersion(files: string[], html: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([files, html])));
  return [...new Uint8Array(digest)]
    .slice(0, 8)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function injectPrecache(code: string, manifest: PrecacheManifest): string {
  const parts = code.split(PRECACHE_PLACEHOLDER);
  if (parts.length !== 2) {
    throw new Error(`Expected ${PRECACHE_PLACEHOLDER} once in the service worker, found it ${parts.length - 1} times.`);
  }
  return parts.join(JSON.stringify(manifest));
}

/**
 * Builds `swEntry` into `sw.js` at the root of the output, with the list of files to precache
 * written into it. Build only: the dev server and the tests never get a service worker.
 */
export function precachePlugin({ swEntry, publicFiles }: { swEntry: string; publicFiles: string[] }): Plugin {
  return {
    name: 'freecan-precache',
    apply: 'build',
    // After Vite's own plugins have added the page and the worker to the bundle.
    enforce: 'post',
    buildStart() {
      this.emitFile({ type: 'chunk', id: swEntry, fileName: SW_FILE });
    },
    async generateBundle(_options, bundle) {
      const sw = bundle[SW_FILE];
      const page = bundle['index.html'];
      if (sw?.type !== 'chunk') this.error(`${SW_FILE} is missing from the bundle.`);
      if (page?.type !== 'asset') this.error('index.html is missing from the bundle.');
      const html = typeof page.source === 'string' ? page.source : new TextDecoder().decode(page.source);
      const files = precacheFiles(Object.keys(bundle), publicFiles);
      sw.code = injectPrecache(sw.code, { version: await precacheVersion(files, html), files });
    },
  };
}
