import { describe, expect, it } from 'vitest';
import { ALL_IDS, type DataRule } from '../../core/api';
import { summary } from '../../test/fixtures';
import { filterChips, matchedBytes, NO_FILTERS, toFrameFilter } from './filters';
import { stripDomain } from './TimeRangeStrip';

const engine = summary({ id: 0x100, name: 'Engine' });
const radar = summary({ id: 0x300, channel: 1, name: 'Radar' });

describe('toFrameFilter', () => {
  it('leaves the keys open without picked IDs or a sidebar selection', () => {
    expect(toFrameFilter({ ...NO_FILTERS, t0: 2 }, ALL_IDS)).toMatchObject({ keys: null, t0: 2, t1: null });
  });

  it('narrows the picked IDs to the one picked in the sidebar, or to none', () => {
    const picked = { ...NO_FILTERS, keys: [engine.key] };
    expect(toFrameFilter(NO_FILTERS, radar.key).keys).toEqual([radar.key]);
    expect(toFrameFilter(picked, engine.key).keys).toEqual([engine.key]);
    expect(toFrameFilter(picked, radar.key).keys).toEqual([]);
  });
});

describe('filterChips', () => {
  it('names each filter, and removing one leaves the rest', () => {
    const rules: DataRule[] = [{ type: 'bit', byte: 0, bit: 3, set: true }, { type: 'changes' }];
    const filters = { ...NO_FILTERS, channels: [1], keys: [radar.key], kinds: ['error' as const], rules, t0: 1.5, t1: 4 };
    const chips = filterChips(filters, ['can0', 'can1'], [engine, radar]);
    expect(chips.map((c) => c.label)).toEqual(['can1', '300', 'Error', '1.500 - 4.000 s', 'Byte 0 bit 3 set', 'Any byte changes']);
    expect(chips[4].without.rules).toEqual([{ type: 'changes' }]);
    expect(chips[3].without).toMatchObject({ t0: null, t1: null, channels: [1] });
  });
});

describe('matchedBytes', () => {
  const data = Uint8Array.of(0x08, 0x1f, 0x00, 0xff);

  it('marks the bytes each met rule looks at', () => {
    const rules: DataRule[] = [
      { type: 'byteEquals', byte: 1, value: 0x1f },
      { type: 'bit', byte: 0, bit: 3, set: true },
      { type: 'bit', byte: 2, bit: 0, set: true },
      { type: 'byteEquals', byte: 9, value: 0 },
    ];
    expect(matchedBytes(rules, data, () => false)).toEqual([0, 1]);
  });

  it('marks the changed bytes for "any byte changes"', () => {
    expect(matchedBytes([{ type: 'changes' }, { type: 'bit', byte: 2, bit: 7, set: false }], data, (b) => b === 3)).toEqual([2, 3]);
  });
});

describe('stripDomain', () => {
  it('shows the whole log for a wide range and zooms in on a narrow one', () => {
    expect(stripDomain(0, 100, 100)).toEqual([0, 100]);
    expect(stripDomain(10, 60, 100)).toEqual([0, 100]);
    expect(stripDomain(12, 18.5, 100)).toEqual([10, 22]);
    expect(stripDomain(0, 1, 0)).toEqual([0, 1]);
  });
});
