import uPlot from 'uplot';
import { describe, expect, it } from 'vitest';
import { finiteRange, withGaps } from './plotGaps';

describe('withGaps', () => {
  it('passes finite values through without a copy', () => {
    const y = Float64Array.from([1, -2, 0, 3]);
    expect(withGaps(y)).toBe(y);
  });

  it('turns NaN and infinities into null', () => {
    const y = Float64Array.from([NaN, 1, Infinity, -Infinity, 2]);
    expect(withGaps(y)).toEqual([null, 1, null, null, 2]);
  });
});

describe('finiteRange', () => {
  it('skips NaN and infinities', () => {
    expect(finiteRange(Float64Array.from([NaN, 3, -Infinity, -1, Infinity]))).toEqual({ lo: -1, hi: 3 });
  });

  it('has lo above hi when nothing is finite', () => {
    const { lo, hi } = finiteRange([NaN, Infinity]);
    expect(lo).toBeGreaterThan(hi);
  });
});

describe('a uPlot line given NaN', () => {
  const x = Float64Array.from([0, 1, 2, 3, 4, 5]);
  const y = Float64Array.from([NaN, 1, 4, NaN, 2, 3]);

  async function plot(values: uPlot.AlignedData[1]) {
    const u = new uPlot(
      { width: 400, height: 100, series: [{}, { stroke: 'red' }], scales: { x: { time: false } } },
      [x, values],
      document.createElement('div'),
    );
    // uPlot draws in a microtask after setData.
    await new Promise((resolve) => setTimeout(resolve));
    return u;
  }

  it('keeps a NaN y range when the raw values start with NaN', async () => {
    const u = await plot(y);
    expect(u.scales.y.min).toBeNaN();
    u.destroy();
  });

  it('fits the y range to the other values and draws a gap with withGaps', async () => {
    const u = await plot(withGaps(y));
    const { min, max } = u.scales.y;
    expect(Number.isFinite(min) && Number.isFinite(max)).toBe(true);
    expect(min).toBeLessThanOrEqual(1);
    expect(max).toBeGreaterThanOrEqual(4);
    const paths = (u.series[1] as uPlot.Series & { _paths: { gaps: [number, number][] } })._paths;
    // The line starts at the first value it can draw, and breaks from t = 2 to t = 4 around the other NaN.
    expect(paths.gaps).toHaveLength(1);
    const [from, to] = paths.gaps[0];
    expect(Math.abs(from - u.valToPos(2, 'x', true))).toBeLessThanOrEqual(1);
    expect(Math.abs(to - u.valToPos(4, 'x', true))).toBeLessThanOrEqual(1);
    u.destroy();
  });
});
