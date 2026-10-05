import { afterEach, describe, expect, it, vi } from 'vitest';
import { cacheFirst, checkPrecacheResponse, networkFirst, networkFirstKeeping } from './swStrategies';

const cachedCopy = () => new Response('cached');
const offline = () => Promise.reject(new TypeError('Failed to fetch'));
/** A same-origin answer, as a service worker's fetch gives it (a constructed Response is `default`). */
function sameOrigin(body: string, status = 200): Response {
  const response = new Response(body, { status });
  Object.defineProperty(response, 'type', { value: 'basic' });
  return response;
}

afterEach(() => vi.useRealTimers());

describe('networkFirst', () => {
  it("prefers the network's answer", async () => {
    const response = await networkFirst(async () => new Response('fresh'), async () => cachedCopy());
    expect(await response.text()).toBe('fresh');
  });

  it('falls back to the cache when the network fails or answers with a server error', async () => {
    expect(await (await networkFirst(offline, async () => cachedCopy())).text()).toBe('cached');
    expect(await (await networkFirst(async () => new Response('', { status: 503 }), async () => cachedCopy())).text()).toBe('cached');
  });

  it('passes on a failure or a server error when nothing is cached', async () => {
    await expect(networkFirst(offline, async () => undefined)).rejects.toThrow('Failed to fetch');
    expect((await networkFirst(async () => new Response('', { status: 502 }), async () => undefined)).status).toBe(502);
  });

  it('keeps a client error, such as a missing file', async () => {
    expect((await networkFirst(async () => new Response('', { status: 404 }), async () => cachedCopy())).status).toBe(404);
  });

  it('answers from the cache when the network is slower than the timeout', async () => {
    vi.useFakeTimers();
    const pending = networkFirst(() => new Promise<Response>(() => {}), async () => cachedCopy(), 4000);
    await vi.advanceTimersByTimeAsync(4000);
    expect(await (await pending).text()).toBe('cached');
  });

  it('waits for a slow network when nothing is cached', async () => {
    vi.useFakeTimers();
    const pending = networkFirst(
      () => new Promise<Response>((resolve) => setTimeout(() => resolve(new Response('late')), 6000)),
      async () => undefined,
      4000,
    );
    await vi.advanceTimersByTimeAsync(6000);
    expect(await (await pending).text()).toBe('late');
  });
});

describe('cacheFirst', () => {
  it('uses the cached copy, and the network only without one', async () => {
    const load = vi.fn(async () => new Response('fresh'));
    expect(await (await cacheFirst(async () => cachedCopy(), load)).text()).toBe('cached');
    expect(load).not.toHaveBeenCalled();
    expect(await (await cacheFirst(async () => undefined, load)).text()).toBe('fresh');
  });
});

describe('networkFirstKeeping', () => {
  it('keeps a copy of a whole, successful same-origin answer', async () => {
    const keep = vi.fn();
    const response = await networkFirstKeeping(async () => sameOrigin('demo'), async () => undefined, keep);
    expect(await response.text()).toBe('demo');
    expect(keep).toHaveBeenCalledTimes(1);
    expect(await keep.mock.calls[0][0].text()).toBe('demo');
  });

  it('keeps nothing that is partial, an error, opaque or already from the cache', async () => {
    const keep = vi.fn();
    await networkFirstKeeping(async () => sameOrigin('part', 206), async () => undefined, keep);
    await networkFirstKeeping(async () => sameOrigin('', 404), async () => undefined, keep);
    await networkFirstKeeping(async () => new Response('other'), async () => undefined, keep);
    const offlineCopy = await networkFirstKeeping(offline, async () => sameOrigin('kept'), keep);
    expect(await offlineCopy.text()).toBe('kept');
    expect(keep).not.toHaveBeenCalled();
  });
});

describe('checkPrecacheResponse', () => {
  const answer = (contentType: string, status = 200) => new Response('', { status, headers: { 'Content-Type': contentType } });

  it('accepts the page as HTML and every other file as anything but HTML', () => {
    expect(() => checkPrecacheResponse('./', answer('text/html; charset=utf-8'))).not.toThrow();
    expect(() => checkPrecacheResponse('assets/index-abc.js', answer('text/javascript'))).not.toThrow();
    expect(() => checkPrecacheResponse('assets/can_wasm_bg-1.wasm', answer('application/wasm'))).not.toThrow();
  });

  it("refuses the page sent in place of a missing file, as a single-page app's fallback does", () => {
    expect(() => checkPrecacheResponse('assets/worker-old.js', answer('text/html'))).toThrow(/wrong kind of file/);
  });

  it('refuses a failed answer, and a page that is not HTML', () => {
    expect(() => checkPrecacheResponse('assets/index-abc.js', answer('text/javascript', 404))).toThrow(/404/);
    expect(() => checkPrecacheResponse('./', answer('text/plain'))).toThrow(/wrong kind of file/);
  });
});
