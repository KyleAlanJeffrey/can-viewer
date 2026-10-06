import type { CoreApi } from '../../core/api';
import { forget } from '../../session';

const pending = new WeakMap<CoreApi, number>();

/** Tracks `work` on `core` that reads or compares log B, for `forgetLogBOnReset`. */
export async function onLogB<T>(core: CoreApi, work: Promise<T>): Promise<T> {
  pending.set(core, (pending.get(core) ?? 0) + 1);
  try {
    return await work;
  } finally {
    pending.set(core, (pending.get(core) ?? 1) - 1);
  }
}

/**
 * Forgets the saved log B when the core restarts while log B is read or compared: reading it
 * back after a reload could stop the core again, every time Compare opens. Returns the
 * unsubscribe function.
 */
export function forgetLogBOnReset(core: CoreApi): () => void {
  return (
    core.onReset?.(() => {
      if ((pending.get(core) ?? 0) > 0) void forget('compare');
    }) ?? (() => undefined)
  );
}
