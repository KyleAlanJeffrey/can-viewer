import { useEffect, useRef, useState } from 'react';
import type { CoreApi } from '../../core/api';
import type { PlotSpec } from '../../components/Plots';
import { sampleAt, type LaneSamples } from './model';

interface Job {
  plots: PlotSpec[];
  a: number | null;
  b: number | null;
}

/**
 * Each plotted signal's samples at cursors A and B, keyed by plot id. They're fetched from the
 * full-resolution series, so readouts don't depend on how far the lanes are zoomed out.
 */
export function useCursorSamples(core: CoreApi, plots: PlotSpec[], a: number | null, b: number | null): Record<string, LaneSamples> {
  const [samples, setSamples] = useState<Record<string, LaneSamples>>({});
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
    pending.current = { plots, a, b };
    if (running.current) return;
    running.current = true;
    // One round trip at a time, so a cursor drag only ever fetches its latest position.
    void (async () => {
      try {
        while (pending.current && mounted.current) {
          const job = pending.current;
          pending.current = null;
          const at = (handle: number, t: number | null) => (t === null ? Promise.resolve(null) : sampleAt(core, handle, t));
          const entries = await Promise.all(
            job.plots.map(async (p) => [p.id, { a: await at(p.info.handle, job.a), b: await at(p.info.handle, job.b) }] as const),
          );
          if (mounted.current) setSamples(Object.fromEntries(entries));
        }
      } catch {
        // A plot removed mid-fetch; the next cursor move fetches what's current.
      } finally {
        running.current = false;
      }
    })();
  }, [core, plots, a, b]);

  return samples;
}
