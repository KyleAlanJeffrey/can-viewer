import type { SignalDef } from './core/api';

/**
 * Payload bits covered by a signal, as `byte * 8 + bit` with bit 0 the LSB - the same indexing
 * as the core's bit-flip counts. Motorola signals start at their MSB and walk down through each
 * byte, then continue at bit 7 of the next byte.
 */
export function signalBits(s: SignalDef): number[] {
  const bits: number[] = [];
  let pos = s.startBit;
  for (let k = 0; k < s.size; k++) {
    if (s.byteOrder === 'intel') {
      bits.push(s.startBit + k);
    } else {
      bits.push(pos);
      pos = pos % 8 === 0 ? pos + 15 : pos - 1;
    }
  }
  return bits;
}

/** `startBit|size@order` in DBC notation, e.g. `7|16@0-`. */
export function signalLayout(s: SignalDef): string {
  const order = s.byteOrder === 'intel' ? 1 : 0;
  const sign = s.kind === 'unsigned' ? '+' : '-';
  return `${s.startBit}|${s.size}@${order}${sign}`;
}
