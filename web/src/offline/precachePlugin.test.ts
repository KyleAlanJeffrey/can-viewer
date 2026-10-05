import { describe, expect, it } from 'vitest';
import { PRECACHED_PUBLIC_FILES } from '../../vite.config.ts';
import { PRECACHE_PLACEHOLDER, injectPrecache, precacheFiles, precacheVersion } from './precachePlugin';

describe('precacheFiles', () => {
  it('keeps the page and the fingerprinted assets, and adds the public files', () => {
    const files = precacheFiles(
      ['index.html', 'sw.js', 'assets/index-abc.js', 'assets/index-abc.js.map', 'assets/worker-def.js', 'assets/can_wasm_bg-123.wasm'],
      ['manifest.webmanifest', 'favicon.svg'],
    );
    expect(files).toEqual(['./', 'assets/can_wasm_bg-123.wasm', 'assets/index-abc.js', 'assets/worker-def.js', 'favicon.svg', 'manifest.webmanifest']);
  });

  it('never precaches the demo or the service worker itself', () => {
    const files = precacheFiles(['index.html', 'sw.js', 'demo/demo.log.gz', 'demo/demo.dbc', '_headers'], []);
    expect(files).toEqual(['./']);
  });
});

describe('precacheVersion', () => {
  it('is stable for the same build and changes with a file or the page', async () => {
    const version = await precacheVersion(['./', 'assets/a-1.js'], '<html>');
    expect(version).toMatch(/^[0-9a-f]{16}$/);
    expect(await precacheVersion(['./', 'assets/a-1.js'], '<html>')).toBe(version);
    expect(await precacheVersion(['./', 'assets/a-2.js'], '<html>')).not.toBe(version);
    expect(await precacheVersion(['./', 'assets/a-1.js'], '<html lang="en">')).not.toBe(version);
  });
});

describe('injectPrecache', () => {
  const manifest = { version: 'v1', files: ['./', 'assets/a.js'] };

  it('replaces the placeholder with the manifest as a JS literal', () => {
    const code = injectPrecache(`var {version:o,files:s}=${PRECACHE_PLACEHOLDER};`, manifest);
    expect(code).toBe('var {version:o,files:s}={"version":"v1","files":["./","assets/a.js"]};');
  });

  it('fails the build when the placeholder is missing or repeated', () => {
    expect(() => injectPrecache('self.addEventListener()', manifest)).toThrow(/found it 0 times/);
    expect(() => injectPrecache(`${PRECACHE_PLACEHOLDER};${PRECACHE_PLACEHOLDER}`, manifest)).toThrow(/found it 2 times/);
  });
});

describe('PRECACHED_PUBLIC_FILES', () => {
  // A missing file would make the service worker's install fail, and the app would never work offline.
  it('names files that exist in public/', () => {
    const publicFiles = Object.keys(import.meta.glob('../../public/**/*.{svg,png,webmanifest}')).map((path) =>
      path.replace('../../public/', ''),
    );
    for (const file of PRECACHED_PUBLIC_FILES) expect(publicFiles).toContain(file);
  });
});
