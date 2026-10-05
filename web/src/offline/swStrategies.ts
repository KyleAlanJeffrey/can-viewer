// How the service worker (sw.ts) answers each kind of request, with the network and the caches passed
// in so the rules can be tested without a service worker.

type Load = () => Promise<Response>;
type Lookup = () => Promise<Response | undefined>;

/**
 * The network's answer, or the cached copy when the network fails, answers with a server error, or
 * (with `timeoutMs`) is slower than that. A slow network with nothing cached is still waited for.
 */
export async function networkFirst(load: Load, cached: Lookup, timeoutMs?: number): Promise<Response> {
  const network = load();
  // Once the cached copy has answered, a late network failure has no one to report to.
  network.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const slow = new Promise<'slow'>((resolve) => {
    if (timeoutMs !== undefined) timer = setTimeout(() => resolve('slow'), timeoutMs);
  });
  try {
    const first = await Promise.race([network, slow]);
    if (first === 'slow') return (await cached()) ?? (await network);
    if (first.status >= 500) return (await cached()) ?? first;
    return first;
  } catch (error) {
    const copy = await cached();
    if (copy) return copy;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function cacheFirst(cached: Lookup, load: Load): Promise<Response> {
  return (await cached()) ?? load();
}

/** Network first like `networkFirst`, handing every whole, successful same-origin answer to `keep`. */
export async function networkFirstKeeping(load: Load, cached: Lookup, keep: (response: Response) => void): Promise<Response> {
  let fromNetwork: Response | undefined;
  const response = await networkFirst(async () => (fromNetwork = await load()), cached);
  if (response === fromNetwork && response.status === 200 && response.type === 'basic') keep(response.clone());
  return response;
}

/**
 * Throws unless `response` is fit to precache as `file`. A missing file can come back as the page
 * with a 200 (Cloudflare's single-page-application fallback), which must never be cached as a script.
 */
export function checkPrecacheResponse(file: string, response: Response): void {
  if (!response.ok) throw new Error(`Precaching ${file} failed: ${response.status}.`);
  const isPage = (response.headers.get('Content-Type') ?? '').startsWith('text/html');
  if (isPage !== (file === './')) throw new Error(`Precaching ${file} failed: the server sent the wrong kind of file.`);
}
