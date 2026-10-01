import { describe, expect, it } from 'vitest';
import { makeRowBatch } from '../test/fixtures';
import { EXT_FLAG, FLAG_BRS, FLAG_FD } from './api';
import { ROW_STRIDE, RowBatch } from './rows';

describe('RowBatch', () => {
  const fdPayload = Array.from({ length: 48 }, (_, i) => i);
  const batch = makeRowBatch(7, 40, [
    { t: 0.5, id: 0x1f5, index: 40, channel: 0, data: [0xde, 0xad, 0xbe, 0xef], changed: [0, 3] },
    { t: 1.25, id: (0x18fef100 | EXT_FLAG) >>> 0, index: 97, channel: 2, flags: FLAG_FD | FLAG_BRS, data: fdPayload, changed: [5, 40, 63] },
  ]);

  it('knows its key, start and length', () => {
    expect(batch.key).toBe(7);
    expect(batch.start).toBe(40);
    expect(batch.length).toBe(2);
  });

  it('reads the fixed fields of each row', () => {
    expect(batch.time(0)).toBe(0.5);
    expect(batch.id(0)).toBe(0x1f5);
    expect(batch.index(0)).toBe(40);
    expect(batch.channel(0)).toBe(0);
    expect(batch.flags(0)).toBe(0);
    expect(batch.len(0)).toBe(4);

    expect(batch.time(1)).toBe(1.25);
    expect(batch.id(1)).toBe((0x18fef100 | EXT_FLAG) >>> 0);
    expect(batch.index(1)).toBe(97);
    expect(batch.channel(1)).toBe(2);
    expect(batch.flags(1)).toBe(FLAG_FD | FLAG_BRS);
    expect(batch.len(1)).toBe(48);
  });

  it('returns only the payload length of data', () => {
    expect([...batch.data(0)]).toEqual([0xde, 0xad, 0xbe, 0xef]);
    expect([...batch.data(1)]).toEqual(fdPayload);
  });

  it('reads changed bytes from both words of the mask', () => {
    const changed = (row: number) => Array.from({ length: 64 }, (_, b) => b).filter((b) => batch.changed(row, b));
    expect(changed(0)).toEqual([0, 3]);
    expect(changed(1)).toEqual([5, 40, 63]);
  });

  it('reads a buffer packed by hand at the documented offsets', () => {
    const buffer = new ArrayBuffer(2 * ROW_STRIDE);
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);
    const at = ROW_STRIDE;
    view.setFloat64(at, 9.75, true);
    view.setUint32(at + 8, 0x7ff, true);
    view.setUint32(at + 12, 123_456, true);
    bytes[at + 16] = 1;
    bytes[at + 17] = FLAG_FD;
    bytes[at + 18] = 2;
    view.setUint32(at + 24, 0b10, true);
    bytes.set([0xaa, 0x55], at + 32);

    const handBuilt = new RowBatch(3, 10, buffer);
    expect(handBuilt.length).toBe(2);
    expect(handBuilt.len(0)).toBe(0);
    expect(handBuilt.time(1)).toBe(9.75);
    expect(handBuilt.id(1)).toBe(0x7ff);
    expect(handBuilt.index(1)).toBe(123_456);
    expect(handBuilt.channel(1)).toBe(1);
    expect(handBuilt.flags(1)).toBe(FLAG_FD);
    expect([...handBuilt.data(1)]).toEqual([0xaa, 0x55]);
    expect(handBuilt.changed(1, 0)).toBe(false);
    expect(handBuilt.changed(1, 1)).toBe(true);
  });
});
