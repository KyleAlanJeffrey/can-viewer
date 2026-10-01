const W = 100;
const H = 30;

interface Props {
  x: ArrayLike<number>;
  y: ArrayLike<number>;
  /** Time span to fit across the width. */
  x0: number;
  x1: number;
  /** Fixed value range; the data's own range when left out. */
  y0?: number;
  y1?: number;
}

/** A neutral graphite line with no axes, for scanning shape rather than reading values. */
export function Sparkline({ x, y, x0, x1, y0, y1 }: Props) {
  let lo = y0 ?? Infinity;
  let hi = y1 ?? -Infinity;
  if (y0 === undefined || y1 === undefined) {
    for (let i = 0; i < y.length; i++) {
      if (y0 === undefined) lo = Math.min(lo, y[i]);
      if (y1 === undefined) hi = Math.max(hi, y[i]);
    }
  }
  const span = hi - lo;
  const xSpan = x1 - x0 || 1;
  const points: string[] = [];
  for (let i = 0; i < x.length; i++) {
    const px = ((x[i] - x0) / xSpan) * W;
    // A flat line sits in the middle rather than on the floor.
    const py = span > 0 ? H - 2 - ((y[i] - lo) / span) * (H - 4) : H / 2;
    points.push(`${px.toFixed(2)},${py.toFixed(2)}`);
  }
  return (
    <svg className="re-spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      {points.length > 1 && (
        <polyline
          points={points.join(' ')}
          fill="none"
          stroke="var(--graphite)"
          strokeWidth={1.25}
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      )}
    </svg>
  );
}
