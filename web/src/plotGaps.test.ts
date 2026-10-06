import uPlot from 'uplot';
import { describe, expect, it } from 'vitest';
import { aligned, finiteRange, isolatedDots, isolatedPoints, withGaps } from './plotGaps';

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

describe('isolatedPoints', () => {
  it('finds drawable values with nothing drawable either side', () => {
    expect(isolatedPoints([1, null, 2, 3, null, 4])).toEqual([0, 5]);
    expect(isolatedPoints([null, 1, null])).toEqual([1]);
    expect(isolatedPoints([5])).toEqual([0]);
  });

  it('skips over undefined, which only marks a time another trace has', () => {
    expect(isolatedPoints([null, undefined, 1, undefined, null])).toEqual([2]);
    expect(isolatedPoints([1, undefined, 2])).toBeNull();
  });

  it('is null when every value is part of a line', () => {
    expect(isolatedPoints(Float64Array.from([1, 2, 3]))).toBeNull();
    expect(isolatedPoints([])).toBeNull();
  });
});

describe('aligned', () => {
  it('bridges where a trace has no point, unless that is beside a value it cannot draw', () => {
    const a = { x: [0, 10, 20], y: [1, 2, NaN] };
    const b = { x: [5, 15, 25], y: [7, 8, 9] };
    expect(aligned(a, b)).toEqual([
      [0, 5, 10, 15, 20, 25],
      [1, undefined, 2, null, null, null],
      [undefined, 7, undefined, 8, undefined, 9],
    ]);
  });

  it('pairs shared times', () => {
    expect(aligned({ x: [0, 1, 2], y: [1, 2, 3] }, { x: [1], y: [4] })).toEqual([
      [0, 1, 2],
      [1, 2, 3],
      [undefined, 4, undefined],
    ]);
  });
});

describe('a uPlot overlay pair', () => {
  type Gaps = { _paths: { gaps?: [number, number][] } };

  it('leaves one gap across a NaN run, however many times the other trace has inside it', async () => {
    // A decimated reference: one NaN a bucket from 10 s to 30 s, overlaid on a point every second.
    const reference = { x: [0, 10, 20, 30, 40], y: [1, NaN, NaN, NaN, 2] };
    const overlay = { x: Array.from({ length: 41 }, (_, t) => t), y: Array.from({ length: 41 }, (_, t) => t % 3) };
    const u = new uPlot(
      {
        width: 400,
        height: 100,
        series: [{}, { stroke: 'red', points: isolatedDots('red') }, { stroke: 'grey' }],
        scales: { x: { time: false } },
      },
      aligned(reference, overlay),
      document.createElement('div'),
    );
    await new Promise((resolve) => setTimeout(resolve));
    const gaps = (u.series[1] as uPlot.Series & Gaps)._paths.gaps!;
    expect(gaps).toHaveLength(1);
    expect(Math.abs(gaps[0][0] - u.valToPos(0, 'x', true))).toBeLessThanOrEqual(1);
    expect(Math.abs(gaps[0][1] - u.valToPos(40, 'x', true))).toBeLessThanOrEqual(1);
    expect((u.series[2] as uPlot.Series & Gaps)._paths.gaps ?? []).toHaveLength(0);
    u.destroy();
  });

  it('marks a value alone between NaNs with a point', () => {
    const u = new uPlot(
      { width: 400, height: 100, series: [{}, { stroke: 'red', points: isolatedDots('red') }], scales: { x: { time: false } } },
      [[0, 1, 2, 3], [1, null, 2, null]],
      document.createElement('div'),
    );
    const filter = u.series[1].points!.filter as (self: uPlot, seriesIdx: number, show: boolean) => number[] | null;
    expect(filter(u, 1, false)).toEqual([0, 2]);
    u.destroy();
  });
});
