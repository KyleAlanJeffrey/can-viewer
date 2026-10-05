import { describe, expect, it } from 'vitest';
import { FLAG_ERROR, FLAG_FD, FLAG_RTR } from './api';
import { CAPTURE_RECORD_HEADER, packFrames } from './captureFrames';

describe('packFrames', () => {
  it('packs each frame as a header and its payload', () => {
    const packed = packFrames([
      { timeNs: 1_500_000, id: 0x123, extended: false, flags: 0, data: Uint8Array.of(1, 2) },
      { timeNs: 2_000_000, id: 0x1234_5678, extended: true, flags: FLAG_RTR, data: new Uint8Array(0) },
      { timeNs: 3_000_000, id: 0x80, extended: false, flags: FLAG_ERROR, data: new Uint8Array(8) },
      { timeNs: 4_000_000, id: 0x321, extended: false, flags: FLAG_FD, data: new Uint8Array(64).fill(7) },
    ]);
    const view = new DataView(packed.buffer);
    expect(packed.length).toBe(4 * CAPTURE_RECORD_HEADER + 2 + 0 + 8 + 64);

    expect(view.getFloat64(0, true)).toBe(1_500_000);
    expect(view.getUint32(8, true)).toBe(0x123);
    expect([packed[12], packed[13], packed[14], packed[15]]).toEqual([0, 2, 1, 2]);

    let at = CAPTURE_RECORD_HEADER + 2;
    expect(view.getUint32(at + 8, true)).toBe(0x9234_5678);
    expect([packed[at + 12], packed[at + 13]]).toEqual([FLAG_RTR, 0]);

    at += CAPTURE_RECORD_HEADER;
    expect(view.getUint32(at + 8, true)).toBe(0x2000_0080);
    expect(packed[at + 13]).toBe(8);

    at += CAPTURE_RECORD_HEADER + 8;
    expect(view.getFloat64(at, true)).toBe(4_000_000);
    expect(packed[at + 13]).toBe(64);
    expect(packed[packed.length - 1]).toBe(7);
  });

  it('packs nothing for no frames', () => {
    expect(packFrames([]).length).toBe(0);
  });
});
