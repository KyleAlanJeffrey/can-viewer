import { describe, expect, it } from 'vitest';
import { PRECACHED_PUBLIC_FILES } from '../../vite.config.ts';
import type { Rolldown } from 'vite';
import { PRECACHE_PLACEHOLDER, injectPrecache, precacheFiles, precachePlugin, precacheVersion } from './precachePlugin';

describe('precacheFiles', () => {
  it('keeps the page and the fingerprinted assets, and adds the public files', () => {
    const files = precacheFiles(
      ['index.html', 'sw.js', 'assets/index-abc.js', 'assets/index-abc.js.map', 'assets/worker-def.js', 'assets/can_wasm_bg-123.wasm'],
      ['manifest.webmanifest', 'favicon.svg'],
    );
    expect(files).toEqual(['./', 'assets/can_wasm_bg-123.wasm', 'assets/index-abc.js', 'assets/worker-def.js', 'favicon.svg', 'manifest.webmanifest']);
  });

  it('leaves out WOFF fonts when WOFF2 ones exist', () => {
    expect(precacheFiles(['index.html', 'assets/plex-1.woff', 'assets/plex-2.woff2'], [])).toEqual(['./', 'assets/plex-2.woff2']);
    expect(precacheFiles(['index.html', 'assets/plex-1.woff'], [])).toEqual(['./', 'assets/plex-1.woff']);
  });

  it('never precaches the demo or the service worker itself', () => {
    const files = precacheFiles(['index.html', 'sw.js', 'demo/demo.log.gz', 'demo/demo.dbc', '_headers'], []);
    expect(files).toEqual(['./']);
  });
});

describe('precacheVersion', () => {
  it('is stable for the same build and changes with a file, the page or a public file', async () => {
    const icon = new Uint8Array([1, 2, 3]);
    const version = await precacheVersion(['./', 'assets/a-1.js'], ['<html>', icon]);
    expect(version).toMatch(/^[0-9a-f]{16}$/);
    expect(await precacheVersion(['./', 'assets/a-1.js'], ['<html>', new Uint8Array([1, 2, 3])])).toBe(version);
    expect(await precacheVersion(['./', 'assets/a-2.js'], ['<html>', icon])).not.toBe(version);
    expect(await precacheVersion(['./', 'assets/a-1.js'], ['<html lang="en">', icon])).not.toBe(version);
    expect(await precacheVersion(['./', 'assets/a-1.js'], ['<html>', new Uint8Array([1, 2, 4])])).not.toBe(version);
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

describe('precachePlugin', () => {
  function bundleWith(swImports: string[]) {
    return {
      'index.html': { type: 'asset', fileName: 'index.html', source: '<html>' },
      'assets/index-abc.js': { type: 'chunk', fileName: 'assets/index-abc.js', code: '', imports: [], dynamicImports: [] },
      'sw.js': { type: 'chunk', fileName: 'sw.js', code: `const m=${PRECACHE_PLACEHOLDER};`, imports: swImports, dynamicImports: [] },
    } as unknown as Rolldown.OutputBundle & Record<string, { code: string }>;
  }

  async function generate(bundle: Rolldown.OutputBundle) {
    const plugin = precachePlugin({ swEntry: '/src/offline/sw.ts', publicFiles: ['favicon.svg'] });
    const read: string[] = [];
    (plugin.configResolved as (config: { publicDir: string }) => void)({ publicDir: '/app/public' });
    const context = {
      error: (message: string) => {
        throw new Error(message);
      },
      fs: { readFile: async (path: string) => (read.push(path), new Uint8Array([1])) },
    };
    await (plugin.generateBundle as (this: unknown, options: unknown, bundle: Rolldown.OutputBundle) => Promise<void>).call(context, {}, bundle);
    return read;
  }

  it('writes the precache manifest into sw.js, reading the public files', async () => {
    const bundle = bundleWith([]);
    expect(await generate(bundle)).toEqual(['/app/public/favicon.svg']);
    expect(bundle['sw.js'].code).toMatch(/^const m=\{"version":"[0-9a-f]{16}","files":\["\.\/","assets\/index-abc\.js","favicon\.svg"\]\};$/);
  });

  it('fails the build when sw.js imports another chunk, since it is registered as a classic script', async () => {
    await expect(generate(bundleWith(['assets/shared-1.js']))).rejects.toThrow(/must not import/);
  });
});
