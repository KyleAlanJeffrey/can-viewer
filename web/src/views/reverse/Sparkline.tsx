import { finiteRange } from '../../plotGaps';

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
  const own = finiteRange(y);
  const lo = y0 ?? own.lo;
  const hi = y1 ?? own.hi;
  const span = hi - lo;
  const xSpan = x1 - x0 || 1;
  // NaN and infinite values break the line into runs.
  let path = '';
  let drawing = false;
  for (let i = 0; i < x.length; i++) {
    if (!Number.isFinite(y[i])) {
      drawing = false;
      continue;
    }
    const px = ((x[i] - x0) / xSpan) * W;
    // A flat line sits in the middle rather than on the floor.
    const py = span > 0 ? H - 2 - ((y[i] - lo) / span) * (H - 4) : H / 2;
    path += `${drawing ? 'L' : 'M'}${px.toFixed(2)},${py.toFixed(2)}`;
    drawing = true;
  }
  return (
    <svg className="re-spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      {path.includes('L') && (
        <path
          d={path}
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
