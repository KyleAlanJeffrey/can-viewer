import type { TimeWindow, Trace } from './bits';

const W = 100;
const H = 30;

interface Props {
  trace: Trace | null;
  window: TimeWindow;
  /** Fixed value range; raw bytes use 0 to 255. */
  range?: [number, number];
  cursor: number | null;
}

/**
 * A byte's values across the window as one thin graphite line, with the shared cursor as a
 * hairline. A lone value draws as a flat line; no values at all draws nothing.
 */
export function LaneSpark({ trace, window: [t0, t1], range = [0, 255], cursor }: Props) {
  const span = t1 - t0 || 1;
  const [lo, hi] = range;
  const py = (v: number) => H - 2 - ((v - lo) / (hi - lo || 1)) * (H - 4);
  let points = '';
  if (trace && trace.x.length === 1) {
    const y = py(trace.y[0]).toFixed(2);
    points = `0,${y} ${W},${y}`;
  } else if (trace && trace.x.length > 1) {
    const parts: string[] = [];
    for (let i = 0; i < trace.x.length; i++) {
      parts.push(`${(((trace.x[i] - t0) / span) * W).toFixed(2)},${py(trace.y[i]).toFixed(2)}`);
    }
    points = parts.join(' ');
  }
  const at = cursor !== null && cursor >= t0 && cursor <= t1 ? ((cursor - t0) / span) * 100 : null;
  return (
    <span className="re-spark-host" aria-hidden="true">
      <svg className="re-spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        {points && <polyline points={points} fill="none" stroke="var(--graphite)" strokeWidth={1.25} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />}
      </svg>
      {at !== null && <span className="re-spark-cursor" style={{ left: `${at}%` }} />}
    </span>
  );
}
