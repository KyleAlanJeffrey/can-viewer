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
 * the first time it is used. WOFF fonts are left out when WOFF2 ones exist, since every browser with
 * service workers reads WOFF2.
 */
export function precacheFiles(bundleFiles: string[], publicFiles: string[]): string[] {
  const hasWoff2 = bundleFiles.some((file) => file.endsWith('.woff2'));
  const built = bundleFiles
    .filter((file) => file === 'index.html' || (file.startsWith('assets/') && !file.endsWith('.map')))
    .filter((file) => !(hasWoff2 && file.endsWith('.woff')))
    .map((file) => (file === 'index.html' ? './' : file));
  return [...new Set([...built, ...publicFiles])].sort();
}

async function sha256Hex(data: string | Uint8Array<ArrayBuffer>): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Changes whenever a precached file does, so each build gets its own cache. Fingerprinted files
 * change name with their content; `contents` covers the rest: the page and the public files.
 */
export async function precacheVersion(files: string[], contents: (string | Uint8Array<ArrayBuffer>)[]): Promise<string> {
  const contentHashes = await Promise.all(contents.map(sha256Hex));
  return (await sha256Hex(JSON.stringify([files, contentHashes]))).slice(0, 16);
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
  let publicDir = '';
  return {
    name: 'freecan-precache',
    apply: 'build',
    // After Vite's own plugins have added the page and the worker to the bundle.
    enforce: 'post',
    configResolved(config) {
      publicDir = config.publicDir;
    },
    buildStart() {
      this.emitFile({ type: 'chunk', id: swEntry, fileName: SW_FILE });
    },
    async generateBundle(_options, bundle) {
      const sw = bundle[SW_FILE];
      const page = bundle['index.html'];
      if (sw?.type !== 'chunk') this.error(`${SW_FILE} is missing from the bundle.`);
      if (page?.type !== 'asset') this.error('index.html is missing from the bundle.');
      // The page registers it as a classic script, which cannot import.
      if (sw.imports.length > 0 || sw.dynamicImports.length > 0) {
        this.error(`${SW_FILE} must not import other chunks: ${[...sw.imports, ...sw.dynamicImports].join(', ')}.`);
      }
      const html = typeof page.source === 'string' ? page.source : new TextDecoder().decode(page.source);
      // A listed file missing from public/ fails the build here rather than the install in a browser.
      const publicContents = await Promise.all(publicFiles.map((file) => this.fs.readFile(`${publicDir}/${file}`)));
      const files = precacheFiles(Object.keys(bundle), publicFiles);
      const version = await precacheVersion(files, [html, ...publicContents.map((bytes) => new Uint8Array(bytes))]);
      sw.code = injectPrecache(sw.code, { version, files });
    },
  };
}
