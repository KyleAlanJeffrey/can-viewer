import { useEffect, useRef, useState } from 'react';
import type { CoreApi } from '../../core/api';

/** One frame's time and payload. */
export interface FrameAt {
  key: number;
  t: number;
  data: Uint8Array;
}

interface Job {
  key: number;
  t: number;
}

/**
 * The payload of ID `key`'s last frame at or before `t`, refetched as `t` moves. One request is
 * in flight at a time, so a cursor drag only ever fetches its latest position.
 */
export function useFrameAt(core: CoreApi, key: number | null, t: number | null, logVersion: number): FrameAt | null {
  const [frame, setFrame] = useState<FrameAt | null>(null);
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
          const found = await frameAt(core, job.key, job.t);
          if (mounted.current && pending.current === null) setFrame(found);
        } catch {
          // The log changed under the request; a newer job queued meanwhile still runs.
        }
      }
      running.current = false;
    })();
  }, [core, key, t, logVersion]);

  return frame && frame.key === key ? frame : null;
}

async function frameAt(core: CoreApi, key: number, t: number): Promise<FrameAt | null> {
  // rowAtTime gives the first row at or after t; the one before it is the last at or before.
  const at = await core.rowAtTime(key, t);
  const batch = await core.rows(key, Math.max(0, at - 1), 2);
  if (batch.length === 0) return null;
  let row = 0;
  for (let i = 0; i < batch.length; i++) if (batch.time(i) <= t) row = i;
  return { key, t: batch.time(row), data: batch.data(row).slice() };
}
