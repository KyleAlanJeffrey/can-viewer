import type { DiscoveryHints, MessageSuggestions } from './api';

function cancelled(): DOMException {
  return new DOMException('The scan was cancelled.', 'AbortError');
}

/** `CoreApi.scanSignals` built on `suggestSignals`: one message at a time, so a scan can stop between them. */
export async function scanEach(
  suggest: (key: number, hints: DiscoveryHints) => Promise<MessageSuggestions>,
  keys: number[],
  hints: DiscoveryHints,
  onProgress: (done: number, total: number, latest: MessageSuggestions) => void,
  signal?: AbortSignal,
): Promise<MessageSuggestions[]> {
  const found: MessageSuggestions[] = [];
  for (const key of keys) {
    if (signal?.aborted) throw cancelled();
    const latest = await suggest(key, hints);
    found.push(latest);
    onProgress(found.length, keys.length, latest);
  }
  if (signal?.aborted) throw cancelled();
  return found;
}

export function isAbort(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'AbortError';
}
