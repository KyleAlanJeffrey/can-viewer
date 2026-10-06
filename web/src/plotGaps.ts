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

export function gapIfNotFinite(v: number): number | null {
  return Number.isFinite(v) ? v : null;
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
