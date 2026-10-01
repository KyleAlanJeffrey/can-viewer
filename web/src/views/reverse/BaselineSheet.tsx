import { useCallback, useEffect, useState } from 'react';
import { Sheet } from '../../components/Sheet';
import type { ViewContext } from '../types';
import { WindowStrip } from './WindowStrip';
import { MIN_SPAN, clampWindow, type TimeWindow } from './bits';

/** Only the shape of the load matters here, so one nominal bit rate does for every bus. */
const BITRATE = 500_000;
const DEFAULT_SPAN_S = 5;

/** A short stretch at the start of the log, so a short log isn't taken whole. */
function defaultBaseline(duration: number): TimeWindow {
  return clampWindow([0, Math.max(MIN_SPAN, Math.min(DEFAULT_SPAN_S, duration / 10))], duration);
}

interface Props {
  open: boolean;
  onClose: () => void;
  ctx: ViewContext;
  duration: number;
  baseline: TimeWindow | null;
  onApply: (baseline: TimeWindow | null) => void;
}

/** Pick a quiet stretch of the log; bits that change in it are dimmed in Bit Activity. */
export function BaselineSheet({ open, onClose, ctx, duration, baseline, onApply }: Props) {
  const { core, log, logVersion } = ctx;
  const [draft, setDraft] = useState<TimeWindow>(() => baseline ?? defaultBaseline(duration));

  useEffect(() => {
    if (open) setDraft(baseline ?? defaultBaseline(duration));
  }, [open, baseline, duration]);

  const channels = log?.channels.length ?? 0;
  // Every bus's load added up: a quiet vehicle shows as a dip.
  const busLoad = useCallback(
    async (buckets: number) => {
      const loads = await Promise.all(Array.from({ length: channels }, (_, c) => core.busLoad(c, 0, duration, buckets, BITRATE)));
      const total = new Float64Array(buckets);
      for (const [, load] of loads) for (let i = 0; i < Math.min(buckets, load.length); i++) total[i] += load[i];
      return total;
    },
    [core, channels, duration],
  );

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Ignore Baseline"
      description="Pick a quiet period (nothing pressed, nothing moving). Bits that change there will be dimmed."
      footer={
        <>
          {baseline && (
            <button
              type="button"
              className="button"
              onClick={() => {
                onApply(null);
                onClose();
              }}
            >
              Clear Baseline
            </button>
          )}
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => {
              onApply(draft);
              onClose();
            }}
          >
            Use Baseline
          </button>
        </>
      }
    >
      {open && (
        <WindowStrip
          core={core}
          logVersion={logVersion}
          duration={duration}
          window={draft}
          onChange={setDraft}
          title="Bus load"
          name="Baseline"
          bars={busLoad}
          barsLabel="load of every bus, added up"
        />
      )}
    </Sheet>
  );
}
