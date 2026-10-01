import { useEffect, useState } from 'react';
import type { CoreApi, SeriesInfo } from '../../core/api';
import type { TimeWindow } from './bits';
import { Sparkline } from './Sparkline';

const BUCKETS = 64;

interface Props {
  core: CoreApi;
  /** One decoded series per byte, starting at `firstByte`. */
  lanes: SeriesInfo[];
  firstByte: number;
  window: TimeWindow;
  selectedBytes: Set<number>;
  onSelectByte: (byte: number) => void;
}

/** Every byte's raw value across the window on a fixed 0 to 255 scale, for spotting counters and constants at a glance. */
export function ByteLanes({ core, lanes, firstByte, window: win, selectedBytes, onSelectByte }: Props) {
  const [views, setViews] = useState<[Float64Array, Float64Array][] | null>(null);
  const [t0, t1] = win;

  useEffect(() => {
    let stale = false;
    Promise.all(lanes.map((lane) => core.seriesView(lane.handle, t0, t1, BUCKETS))).then(
      (v) => !stale && setViews(v),
      () => !stale && setViews(null),
    );
    return () => {
      stale = true;
    };
  }, [core, lanes, t0, t1]);

  return (
    <div className="re-lanes">
      {lanes.map((lane, k) => {
        const byte = firstByte + k;
        const view = views?.[k];
        const constant = view ? constantIn(view, win) : null;
        const pressed = selectedBytes.has(byte);
        return (
          <button
            key={lane.handle}
            type="button"
            className="re-lane"
            aria-pressed={pressed}
            aria-label={`Byte ${byte}${constant !== null ? `, constant ${hexByte(constant)}` : ''}. Select its 8 bits.`}
            onClick={() => onSelectByte(byte)}
          >
            <span className="re-lane-head">
              <span className="mono">B{byte}</span>
              {constant !== null && <span className="re-lane-note mono">{hexByte(constant)}</span>}
            </span>
            {view ? <Sparkline x={view[0]} y={view[1]} x0={t0} x1={t1} y0={0} y1={255} /> : <span className="re-spark" />}
          </button>
        );
      })}
    </div>
  );
}

/** The byte's value if it never changes inside the window, else null. */
function constantIn([x, y]: [Float64Array, Float64Array], [t0, t1]: TimeWindow): number | null {
  let value: number | null = null;
  for (let i = 0; i < x.length; i++) {
    if (x[i] < t0 || x[i] > t1) continue;
    if (value === null) value = y[i];
    else if (y[i] !== value) return null;
  }
  return value;
}

function hexByte(v: number): string {
  return `0x${Math.round(v).toString(16).toUpperCase().padStart(2, '0')}`;
}
