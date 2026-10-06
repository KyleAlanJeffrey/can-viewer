import type uPlot from 'uplot';

/**
 * Values for uPlot, with null where a value can't be drawn (NaN, or a float signal's infinity), so
 * the line breaks there and the y range comes from the other values. A view with none, the usual
 * case, is passed through without a copy.
 */
export function withGaps<T extends ArrayLike<number>>(y: T): T | (number | null)[] {
  for (let i = 0; i < y.length; i++) {
    if (!Number.isFinite(y[i])) return Array.from(y, gapIfNotFinite);
  }
  return y;
}

function gapIfNotFinite(v: number): number | null {
  return Number.isFinite(v) ? v : null;
}

/**
 * Indices of drawable values with nothing drawable either side, which a line can't show: for
 * uPlot's `points.filter`, so each gets a dot. Undefined values (times only another trace has)
 * are skipped over. Null when there are none, as uPlot then draws no points.
 */
export function isolatedPoints(y: ArrayLike<number | null | undefined>): number[] | null {
  const found: number[] = [];
  let previousDrawable = false;
  // A drawable index after one that isn't, until the next value says whether it is isolated.
  let candidate = -1;
  for (let i = 0; i < y.length; i++) {
    const v = y[i];
    if (v === undefined) continue;
    const drawable = v !== null;
    if (candidate >= 0 && !drawable) found.push(candidate);
    candidate = drawable && !previousDrawable ? i : -1;
    previousDrawable = drawable;
  }
  if (candidate >= 0) found.push(candidate);
  return found.length > 0 ? found : null;
}

/** uPlot points that show only the isolated values of a line, as dots in its colour. */
export function isolatedDots(color: string): uPlot.Series.Points {
  return { show: false, fill: color, filter: (u, seriesIdx) => isolatedPoints(u.data[seriesIdx]) };
}

/** The lowest and highest finite values; `lo > hi` when there are none. */
export function finiteRange(values: ArrayLike<number>): { lo: number; hi: number } {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  return { lo, hi };
}

interface Trace {
  x: ArrayLike<number>;
  y: ArrayLike<number>;
}

/**
 * Two traces on one time axis: the union of their times. A value that can't be drawn becomes
 * null, a gap. Where a trace has no point, it gets undefined, which uPlot bridges, unless the
 * point is next to one it can't draw: then null, so the gap spans the other trace's times too.
 */
export function aligned(a: Trace, b: Trace): uPlot.AlignedData {
  const xs: number[] = [];
  const ya: (number | null | undefined)[] = [];
  const yb: (number | null | undefined)[] = [];
  let i = 0;
  let j = 0;
  while (i < a.x.length || j < b.x.length) {
    const ta = i < a.x.length ? a.x[i] : Infinity;
    const tb = j < b.x.length ? b.x[j] : Infinity;
    const t = Math.min(ta, tb);
    xs.push(t);
    if (ta === t) {
      ya.push(gapIfNotFinite(a.y[i]));
      i++;
    } else {
      ya.push(noPointBefore(a.y, i));
    }
    if (tb === t) {
      yb.push(gapIfNotFinite(b.y[j]));
      j++;
    } else {
      yb.push(noPointBefore(b.y, j));
    }
  }
  return [xs, ya, yb];
}

/** What a trace gets at a time it has no point, just before its point `next`. */
function noPointBefore(y: ArrayLike<number>, next: number): null | undefined {
  const cannotDraw = (k: number) => k >= 0 && k < y.length && !Number.isFinite(y[k]);
  return cannotDraw(next - 1) || cannotDraw(next) ? null : undefined;
}
