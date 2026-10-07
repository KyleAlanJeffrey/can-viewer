import { describe, expect, it } from 'vitest';
import { message, signal } from '../../test/fixtures';
import { decodeFrame, rawValue } from './decodeFrame';

const bytes = (...b: number[]) => Uint8Array.from(b);

describe('decodeFrame', () => {
  it('reads Intel and Motorola fields', () => {
    const data = bytes(0x12, 0x34, 0x56, 0x78, 0, 0, 0, 0);
    expect(rawValue(signal('intel', { startBit: 0, size: 16 }), data)).toBe(0x3412n);
    expect(rawValue(signal('motorola', { startBit: 7, size: 16, byteOrder: 'motorola' }), data)).toBe(0x1234n);
    expect(rawValue(signal('nibble', { startBit: 4, size: 4 }), data)).toBe(0x1n);
    expect(rawValue(signal('past the end', { startBit: 56, size: 16 }), data)).toBeNull();
  });

  it('scales, signs and labels values, with their units', () => {
    const msg = message(0x100, 'M', {
      signals: [
        signal('Speed', { size: 16, factor: 0.25, unit: 'rpm' }),
        signal('Angle', { startBit: 16, size: 8, kind: 'signed', factor: 0.5, unit: 'deg' }),
        signal('Gear', { startBit: 24, size: 4, valueTable: [[3, 'Drive']] }),
      ],
    });
    expect(decodeFrame(msg, bytes(0xaf, 0x0c, 0xfe, 0x03, 0, 0, 0, 0))).toEqual([
      { name: 'Speed', text: '811.75 rpm' },
      { name: 'Angle', text: '-1 deg' },
      { name: 'Gear', text: 'Drive' },
    ]);
  });

  it('leaves out signals multiplexed out of the frame', () => {
    const msg = message(0x100, 'M', {
      signals: [signal('Page', { isMultiplexor: true }), signal('A', { startBit: 8, muxValue: 0 }), signal('B', { startBit: 8, muxValue: 1 })],
    });
    expect(decodeFrame(msg, bytes(1, 7)).map((v) => `${v.name}=${v.text}`)).toEqual(['Page=1', 'B=7']);
  });

  it('says when a J1939 value is not available', () => {
    const msg = message(0x18fef100, 'CCVS', { j1939: true, signals: [signal('Speed', { size: 16, factor: 1 / 256 })] });
    expect(decodeFrame(msg, bytes(0xff, 0xff))).toEqual([{ name: 'Speed', text: 'Not available' }]);
  });
});
