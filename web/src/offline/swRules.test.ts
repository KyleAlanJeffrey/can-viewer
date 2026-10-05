import { describe, expect, it } from 'vitest';
import { DEMO_CACHE, routeFor, shellCacheName, staleCaches } from './swRules';

const SCOPE = 'https://app.example.com/';
const get = (url: string, mode = 'cors') => ({ method: 'GET', mode, url });

describe('routeFor', () => {
  it('serves fingerprinted assets cache first', () => {
    expect(routeFor(get('https://app.example.com/assets/index-abc.js'), SCOPE)).toBe('asset');
    expect(routeFor(get('https://app.example.com/assets/can_wasm_bg-1.wasm'), SCOPE)).toBe('asset');
  });

  it('treats every navigation as the page, whatever its path or query', () => {
    expect(routeFor(get('https://app.example.com/', 'navigate'), SCOPE)).toBe('navigation');
    expect(routeFor(get('https://app.example.com/?demo=1', 'navigate'), SCOPE)).toBe('navigation');
    expect(routeFor(get('https://app.example.com/some/route', 'navigate'), SCOPE)).toBe('navigation');
  });

  it('routes the demo files and the other app files', () => {
    expect(routeFor(get('https://app.example.com/demo/demo.log.gz'), SCOPE)).toBe('demo');
    expect(routeFor(get('https://app.example.com/demo/demo.dbc'), SCOPE)).toBe('demo');
    expect(routeFor(get('https://app.example.com/manifest.webmanifest'), SCOPE)).toBe('static');
  });

  it('leaves other origins, other methods and paths outside the scope to the browser', () => {
    expect(routeFor(get('https://cdn.example.com/assets/x.js'), SCOPE)).toBeNull();
    expect(routeFor(get('http://app.example.com/assets/x.js'), SCOPE)).toBeNull();
    expect(routeFor({ method: 'POST', mode: 'cors', url: 'https://app.example.com/assets/x.js' }, SCOPE)).toBeNull();
    expect(routeFor(get('https://app.example.com/other/assets/x.js'), 'https://app.example.com/app/')).toBeNull();
  });
});

describe('staleCaches', () => {
  it("deletes this app's older shells but keeps the current one, the one before it, the demo and other caches", () => {
    const current = shellCacheName('new');
    const names = [shellCacheName('oldest'), DEMO_CACHE, shellCacheName('older'), 'someone-else', shellCacheName('previous'), current];
    expect(staleCaches(names, current)).toEqual([shellCacheName('oldest'), shellCacheName('older')]);
  });

  it('keeps the only other shell on the first update', () => {
    expect(staleCaches([shellCacheName('old'), shellCacheName('new')], shellCacheName('new'))).toEqual([]);
  });
});
