import { useEffect, useRef, useState } from 'react';
import type { CoreApi } from '../../core/api';

interface Job {
  key: number;
  t: number;
}

/**
 * Log B's payload of ID `key` at or before `t`, refetched as `t` moves. Like `useFrameAt` for
 * log A, one request is in flight at a time, so a cursor drag only fetches its latest position.
 * `version` names log B, so a new one is fetched again.
 */
export function useFrameAtB(core: CoreApi, key: number | null, t: number | null, version: unknown): Uint8Array | null {
  const [frame, setFrame] = useState<{ key: number; data: Uint8Array } | null>(null);
  const pending = useRef<Job | null>(null);
  const running = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (key === null || t === null) {
      pending.current = null;
      setFrame(null);
      return;
    }
    pending.current = { key, t };
    if (running.current) return;
    running.current = true;
    void (async () => {
      while (pending.current && mounted.current) {
        const job = pending.current;
        pending.current = null;
        try {
          const data = await core.compareFrameAt(job.key, job.t);
          if (mounted.current && pending.current === null) setFrame(data.length > 0 ? { key: job.key, data } : null);
        } catch {
          // Log B changed under the request; a newer job queued meanwhile still runs.
        }
      }
      running.current = false;
    })();
  }, [core, key, t, version]);

  return frame && frame.key === key ? frame.data : null;
}
