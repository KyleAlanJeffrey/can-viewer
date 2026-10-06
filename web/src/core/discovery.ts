import type { DiscoveryHints, MessageSuggestions } from './api';

function cancelled(): DOMException {
  return new DOMException('The scan was cancelled.', 'AbortError');
}

/** The worker's calls for a suggestion job; see `suggest_begin` in crates/can-wasm/src/suggest.rs. */
export interface JobCalls {
  begin: (key: number, hints: DiscoveryHints) => Promise<number>;
  /** Null while the job has more to do. */
  step: (job: number) => Promise<MessageSuggestions | null>;
  drop: (job: number) => Promise<void>;
}

/**
 * `CoreApi.suggestSignals` as a job the worker does a few milliseconds at a time, each step a
 * request of its own, so other requests run in between and an abort lands within the message.
 */
export async function suggestInSteps(calls: JobCalls, key: number, hints: DiscoveryHints, signal?: AbortSignal): Promise<MessageSuggestions> {
  if (signal?.aborted) throw cancelled();
  const job = await calls.begin(key, hints);
  for (;;) {
    if (signal?.aborted) {
      void calls.drop(job);
      throw cancelled();
    }
    const found = await calls.step(job);
    if (found) return found;
  }
}

/** `CoreApi.scanSignals` built on `suggestSignals`: one message at a time, each cancellable part way. */
export async function scanEach(
  suggest: (key: number, hints: DiscoveryHints, signal?: AbortSignal) => Promise<MessageSuggestions>,
  keys: number[],
  hints: DiscoveryHints,
  onProgress: (done: number, total: number, latest: MessageSuggestions | null) => void,
  signal?: AbortSignal,
  skip?: (key: number) => boolean,
): Promise<MessageSuggestions[]> {
  const found: MessageSuggestions[] = [];
  let done = 0;
  for (const key of keys) {
    if (signal?.aborted) throw cancelled();
    if (skip?.(key)) {
      onProgress(++done, keys.length, null);
      continue;
    }
    const latest = await suggest(key, hints, signal);
    found.push(latest);
    onProgress(++done, keys.length, latest);
  }
  if (signal?.aborted) throw cancelled();
  return found;
}

export function isAbort(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'AbortError';
}
