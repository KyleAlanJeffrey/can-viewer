import { describe, expect, it } from 'vitest';
import { signalBits } from '../../signalBits';
import { message, signal, summary } from '../../test/fixtures';
import {
  MAX_BITS,
  MIN_SPAN,
  changesIn,
  clampWindow,
  coveringRange,
  hexByte,
  lastIn,
  layoutString,
  matchesQuery,
  pointAt,
  rangeBits,
  rangeFits,
  rectBits,
  windowFits,
} from './bits';

describe('rangeBits', () => {
  it('walks Intel ranges up from the LSB', () => {
    expect(rangeBits({ startBit: 4, size: 8, byteOrder: 'intel' })).toEqual([4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it('walks Motorola ranges down from the MSB into the next byte', () => {
    expect(rangeBits({ startBit: 3, size: 8, byteOrder: 'motorola' })).toEqual([3, 2, 1, 0, 15, 14, 13, 12]);
    expect(rangeBits({ startBit: 7, size: 16, byteOrder: 'motorola' })).toEqual([7, 6, 5, 4, 3, 2, 1, 0, 15, 14, 13, 12, 11, 10, 9, 8]);
  });

  it('agrees with signalBits for both byte orders', () => {
    for (const byteOrder of ['intel', 'motorola'] as const) {
      const range = { startBit: 13, size: 12, byteOrder };
      expect(rangeBits(range)).toEqual(signalBits(signal('S', range)));
    }
  });
});

describe('coveringRange', () => {
  it('is null for no bits', () => {
    expect(coveringRange([], 'intel')).toBeNull();
  });

  it('spans the lowest to the highest Intel bit', () => {
    expect(coveringRange([12, 3, 7], 'intel')).toEqual({ startBit: 3, size: 10, byteOrder: 'intel' });
  });

  it('starts a Motorola range at the first bit in reading order', () => {
    expect(coveringRange([3, 2, 1, 0, 15, 14, 13, 12], 'motorola')).toEqual({ startBit: 3, size: 8, byteOrder: 'motorola' });
    // Bit 0 ends byte 0 in reading order and bit 15 starts byte 1, so they are adjacent.
    expect(coveringRange([15, 0], 'motorola')).toEqual({ startBit: 0, size: 2, byteOrder: 'motorola' });
  });

  it('round-trips through rangeBits', () => {
    const range = { startBit: 21, size: 11, byteOrder: 'motorola' as const };
    expect(coveringRange(rangeBits(range), 'motorola')).toEqual(range);
  });

  it('cuts to MAX_BITS', () => {
    expect(coveringRange([0, 100], 'intel')?.size).toBe(MAX_BITS);
  });
});

describe('rectBits', () => {
  it('covers the grid rectangle between two corners, MSB first per row', () => {
    expect(rectBits(7, 14).sort((a, b) => a - b)).toEqual([6, 7, 14, 15]);
  });
});

describe('rangeFits', () => {
  it('checks Intel ranges against the payload length', () => {
    expect(rangeFits({ startBit: 56, size: 8, byteOrder: 'intel' }, 8)).toBe(true);
    expect(rangeFits({ startBit: 57, size: 8, byteOrder: 'intel' }, 8)).toBe(false);
  });

  it('checks Motorola ranges in reading order', () => {
    expect(rangeFits({ startBit: 7, size: 64, byteOrder: 'motorola' }, 8)).toBe(true);
    expect(rangeFits({ startBit: 63, size: 8, byteOrder: 'motorola' }, 8)).toBe(true);
    // Bit 56 is the last bit of byte 7 in reading order, so eight bits run past the payload.
    expect(rangeFits({ startBit: 56, size: 8, byteOrder: 'motorola' }, 8)).toBe(false);
  });

  it('rejects empty, oversized and negative ranges', () => {
    expect(rangeFits({ startBit: 0, size: 0, byteOrder: 'intel' }, 8)).toBe(false);
    expect(rangeFits({ startBit: 0, size: MAX_BITS + 1, byteOrder: 'intel' }, 64)).toBe(false);
    expect(rangeFits({ startBit: -1, size: 1, byteOrder: 'intel' }, 8)).toBe(false);
  });
});

describe('clampWindow', () => {
  it('keeps a window that fits', () => {
    expect(clampWindow([40, 70], 100)).toEqual([40, 70]);
  });

  it('slides a window back inside the log, keeping its span', () => {
    expect(clampWindow([90, 120], 100)).toEqual([70, 100]);
    expect(clampWindow([-5, 5], 100)).toEqual([0, 10]);
  });

  it('shrinks to the log and grows to the minimum span', () => {
    expect(clampWindow([0, 200], 100)).toEqual([0, 100]);
    expect(clampWindow([10, 10], 100)).toEqual([10, 10 + MIN_SPAN]);
  });

  it('collapses without a log', () => {
    expect(clampWindow([10, 20], 0)).toEqual([0, 0]);
    expect(clampWindow([10, 20], NaN)).toEqual([0, 0]);
  });

  it('gives windows windowFits accepts', () => {
    expect(windowFits(clampWindow([95, 96], 100), 100)).toBe(true);
    expect(windowFits([90, 120], 100)).toBe(false);
  });
});

describe('series helpers', () => {
  const trace = { x: [1, 2, 3], y: [10, 20, 30] };

  it('pointAt finds the last point at or before t', () => {
    expect(pointAt(trace, 2)).toEqual({ t: 2, v: 20 });
    expect(pointAt(trace, 2.5)).toEqual({ t: 2, v: 20 });
    expect(pointAt(trace, 5)).toEqual({ t: 3, v: 30 });
  });

  it('pointAt falls back to the first point before the trace starts', () => {
    expect(pointAt(trace, 0)).toEqual({ t: 1, v: 10 });
    expect(pointAt({ x: [], y: [] }, 1)).toBeNull();
  });

  it('lastIn finds the last point inside the window', () => {
    expect(lastIn(trace, [1.5, 2.5])).toEqual({ t: 2, v: 20 });
    expect(lastIn(trace, [0, 10])).toEqual({ t: 3, v: 30 });
    expect(lastIn(trace, [4, 5])).toBeNull();
  });

  it('changesIn looks only inside the window', () => {
    expect(changesIn(trace, [0, 10])).toBe(true);
    expect(changesIn(trace, [1.5, 2.5])).toBe(false);
    expect(changesIn({ x: [1, 2, 3], y: [7, 7, 7] }, [0, 10])).toBe(false);
    expect(changesIn({ x: [1, 2, 3], y: [7, 7, 8] }, [0, 2])).toBe(false);
  });
});

describe('hexByte', () => {
  it('pads and rounds to two upper-case digits', () => {
    expect(hexByte(0)).toBe('00');
    expect(hexByte(171)).toBe('AB');
    expect(hexByte(255)).toBe('FF');
    expect(hexByte(10.6)).toBe('0B');
  });
});

describe('matchesQuery', () => {
  const s = summary({ id: 0x1f5, name: 'EngineData' });
  const m = message(0x1f5, 'EngineData', { signals: [signal('EngineSpeed')] });

  it('matches everything for a blank query', () => {
    expect(matchesQuery(s, m, '')).toBe(true);
    expect(matchesQuery(s, m, '   ')).toBe(true);
  });

  it('matches the ID, the name or a signal, ignoring case and padding', () => {
    expect(matchesQuery(s, m, '1f5')).toBe(true);
    expect(matchesQuery(s, m, 'engined')).toBe(true);
    expect(matchesQuery(s, m, ' SPEED ')).toBe(true);
    expect(matchesQuery(s, m, 'brake')).toBe(false);
  });

  it('matches signals only when the message is known', () => {
    expect(matchesQuery(summary({ id: 0x1f5 }), null, 'speed')).toBe(false);
  });

  it('matches extended IDs by their eight-digit form', () => {
    expect(matchesQuery(summary({ id: 0x18fef100, extended: true }), null, '18fef1')).toBe(true);
  });
});

describe('layoutString', () => {
  it('writes DBC notation', () => {
    expect(layoutString({ startBit: 23, size: 16, byteOrder: 'motorola' }, false)).toBe('23|16@0+');
    expect(layoutString({ startBit: 0, size: 8, byteOrder: 'intel' }, true)).toBe('0|8@1-');
    expect(layoutString({ startBit: 0, size: 32, byteOrder: 'intel' }, false, true)).toBe('0|32@1- float');
  });
});
