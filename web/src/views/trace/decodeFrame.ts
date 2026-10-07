import type { MessageDef, SignalDef } from '../../core/api';
import { formatValue } from '../plot/model';

/** One signal of a frame, ready to show. */
export interface DecodedValue {
  name: string;
  /** The value with its unit, its value-table label, or why there is none. */
  text: string;
}

/**
 * The signals of `message` in one frame's payload, decoded as the core decodes them
 * (`MessageDef::decode` in crates/can-dbc-model): signals multiplexed out of the frame are left
 * out, and J1939 values that mean error or not available say so.
 */
export function decodeFrame(message: MessageDef, data: Uint8Array): DecodedValue[] {
  const values: DecodedValue[] = [];
  for (const signal of message.signals) {
    if (!isPresent(message, signal, data)) continue;
    const raw = rawValue(signal, data);
    if (raw === null) {
      values.push({ name: signal.name, text: 'Not in this frame' });
      continue;
    }
    if (message.j1939 && signal.kind === 'unsigned' && notAvailable(raw, signal.size)) {
      values.push({ name: signal.name, text: 'Not available' });
      continue;
    }
    const label = signal.valueTable.find(([value]) => BigInt(value) === raw)?.[1];
    const physical = physicalValue(signal, raw);
    values.push({ name: signal.name, text: label ?? (signal.unit ? `${formatValue(physical)} ${signal.unit}` : formatValue(physical)) });
  }
  return values;
}

/** The signal's raw field, or null when the frame is too short for it. */
export function rawValue(signal: SignalDef, data: Uint8Array): bigint | null {
  const { startBit: start, size } = signal;
  if (size <= 0 || size > 64) return null;
  let first: number;
  let last: number;
  let shift: number;
  if (signal.byteOrder === 'intel') {
    first = start >> 3;
    last = (start + size - 1) >> 3;
    shift = start % 8;
  } else {
    // Counted from the MSB of byte 0, so big-endian bits run on without a break.
    const msb = (start >> 3) * 8 + (7 - (start % 8));
    const lsb = msb + size - 1;
    first = msb >> 3;
    last = lsb >> 3;
    shift = (last + 1) * 8 - 1 - lsb;
  }
  if (last >= data.length) return null;
  let acc = 0n;
  if (signal.byteOrder === 'intel') for (let i = last; i >= first; i--) acc = (acc << 8n) | BigInt(data[i]);
  else for (let i = first; i <= last; i++) acc = (acc << 8n) | BigInt(data[i]);
  return (acc >> BigInt(shift)) & ((1n << BigInt(size)) - 1n);
}

function physicalValue(signal: SignalDef, raw: bigint): number {
  let v: number;
  switch (signal.kind) {
    case 'unsigned':
      v = Number(raw);
      break;
    case 'signed':
      v = Number(BigInt.asIntN(signal.size, raw));
      break;
    case 'float32': {
      const view = new DataView(new ArrayBuffer(4));
      view.setUint32(0, Number(raw & 0xffff_ffffn));
      v = view.getFloat32(0);
      break;
    }
    case 'float64': {
      const view = new DataView(new ArrayBuffer(8));
      view.setBigUint64(0, raw);
      v = view.getFloat64(0);
      break;
    }
  }
  return v * signal.factor + signal.offset;
}

/** Whether `signal` is switched into this frame, following its chain of multiplexors. */
function isPresent(message: MessageDef, signal: SignalDef, data: Uint8Array): boolean {
  let current = signal;
  // A chain longer than the signal list is a cycle in a hand-edited DBC.
  for (let hops = 0; hops <= message.signals.length; hops++) {
    const sw = current.muxSwitch;
    if (!sw) {
      if (current.muxValue === null) return true;
      const multiplexor = message.signals.find((s) => s.isMultiplexor);
      const raw = multiplexor ? rawValue(multiplexor, data) : null;
      return raw !== null && raw === BigInt(current.muxValue);
    }
    const multiplexor = message.signals.find((s) => s.name === sw.signal);
    const raw = multiplexor ? rawValue(multiplexor, data) : null;
    if (!multiplexor || raw === null || !sw.ranges.some(([lo, hi]) => raw >= BigInt(lo) && raw <= BigInt(hi))) return false;
    current = multiplexor;
  }
  return false;
}

/** SAE J1939-71: a whole-byte field whose top byte is above 0xFA holds no value. */
function notAvailable(raw: bigint, size: number): boolean {
  return size % 8 === 0 && size >= 8 && size <= 64 && raw >= 0xfbn << BigInt(size - 8);
}
