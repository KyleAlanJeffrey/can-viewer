import { EXT_FLAG, dbcId, formatId, type Database, type MessageDef, type SignalDef } from '../../core/api';
import { signalBits } from '../../signalBits';
import type { LoadedDbc } from '../types';

/** File name of a DBC started in the app. */
export const UNTITLED_DBC = 'untitled.dbc';

/** Payload lengths a DBC message can declare: classic CAN up to 8 bytes, then the CAN FD steps. */
export const DLC_SIZES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 12, 16, 20, 24, 32, 48, 64];

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const MAX_STANDARD_ID = 0x7ff;
const MAX_EXTENDED_ID = 0x1fffffff;

export function isExtended(m: Pick<MessageDef, 'id'>): boolean {
  return m.id >= EXT_FLAG;
}

/** The ID without the extended flag. */
export function rawId(m: Pick<MessageDef, 'id'>): number {
  return isExtended(m) ? m.id - EXT_FLAG : m.id;
}

export function messageIdText(m: Pick<MessageDef, 'id'>): string {
  return formatId(rawId(m), isExtended(m));
}

export function parseNumber(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

export function parseInteger(text: string): number | null {
  const n = parseNumber(text);
  return n !== null && Number.isInteger(n) ? n : null;
}

/** A hex ID as typed, with or without a 0x prefix. */
export function parseHexId(text: string): number | null {
  const digits = text.trim().replace(/^0x/i, '');
  return /^[0-9a-f]{1,8}$/i.test(digits) ? parseInt(digits, 16) : null;
}

export function identifierError(name: string): string | null {
  if (name === '') return 'Enter a name.';
  if (!IDENTIFIER.test(name)) return 'Use letters, digits and _, starting with a letter or _.';
  return null;
}

export function messageNameError(name: string, db: Database, self: MessageDef | null): string | null {
  const invalid = identifierError(name);
  if (invalid) return invalid;
  return db.messages.some((m) => m !== self && m.name === name) ? 'Another message has this name.' : null;
}

export function messageIdError(raw: number | null, extended: boolean, db: Database, self: MessageDef | null): string | null {
  if (raw === null) return 'Enter a hex ID, e.g. 1F5.';
  if (extended && raw > MAX_EXTENDED_ID) return 'Extended IDs go up to 1FFFFFFF.';
  if (!extended && raw > MAX_STANDARD_ID) return 'Standard IDs go up to 7FF. Turn on 29-bit for larger IDs.';
  const id = dbcId({ id: raw, extended });
  const other = db.messages.find((m) => m !== self && m.id === id);
  return other ? `${other.name} already uses this ID.` : null;
}

export function transmitterError(name: string): string | null {
  return name === '' ? null : identifierError(name);
}

/** DBC's placeholder for "no node". */
const NO_NODE = 'Vector__XXX';

export function receiversOf(s: SignalDef): string[] {
  return (s.receivers ?? []).filter((n) => n !== NO_NODE);
}

/** Every node the database names, as a transmitter or a receiver. */
export function nodesOf(db: Database): string[] {
  const nodes = new Set<string>();
  for (const m of db.messages) {
    if (m.transmitter) nodes.add(m.transmitter);
    for (const s of m.signals) receiversOf(s).forEach((n) => nodes.add(n));
  }
  return [...nodes].sort();
}

/** Node names from a comma-separated list. */
export function parseNodeList(text: string): string[] {
  return text
    .split(',')
    .map((n) => n.trim())
    .filter((n) => n !== '');
}

export function nodeListError(text: string): string | null {
  const nodes = parseNodeList(text);
  const invalid = nodes.find((n) => !IDENTIFIER.test(n));
  if (invalid) return `${invalid} isn't a valid node name.`;
  return new Set(nodes).size === nodes.length ? null : 'A node is listed twice.';
}

/** Why `message` can't shrink to `bytes`, if a signal would no longer fit. */
export function sizeError(bytes: number, message: MessageDef): string | null {
  const outside = message.signals.find((s) => signalBits(s).some((b) => b >= bytes * 8));
  return outside ? `${outside.name} needs more than ${bytes} ${bytes === 1 ? 'byte' : 'bytes'}.` : null;
}

export function signalNameError(name: string, message: MessageDef, index: number): string | null {
  const invalid = identifierError(name);
  if (invalid) return invalid;
  return message.signals.some((s, i) => i !== index && s.name === name) ? `${message.name} already has a signal with this name.` : null;
}

/** Why a signal's bits don't fit its message, if they don't. */
export function layoutError(s: SignalDef, bytes: number): string | null {
  if (!Number.isInteger(s.startBit) || s.startBit < 0) return 'Start bit must be a whole number from 0.';
  if (!Number.isInteger(s.size) || s.size < 1 || s.size > 64) return 'Length must be 1 to 64 bits.';
  if (s.kind === 'float32' && s.size !== 32) return 'A 32-bit float signal is 32 bits long.';
  if (s.kind === 'float64' && s.size !== 64) return 'A 64-bit float signal is 64 bits long.';
  if (bytes === 0) return 'The message has no data bytes.';
  if (signalBits(s).some((b) => b >= bytes * 8)) return `Bits run past the message's ${bytes} ${bytes === 1 ? 'byte' : 'bytes'}.`;
  return null;
}

export function newSignal(name: string, startBit: number, size: number): SignalDef {
  return {
    name,
    startBit,
    size,
    byteOrder: 'intel',
    kind: 'unsigned',
    factor: 1,
    offset: 0,
    min: 0,
    max: 2 ** size - 1,
    unit: '',
    isMultiplexor: false,
    muxValue: null,
    valueTable: [],
    comment: null,
  };
}

/** `base`, or `base2`, `base3`... whichever isn't taken. */
export function uniqueName(base: string, taken: string[]): string {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  let n = 2;
  while (used.has(`${base}${n}`)) n++;
  return `${base}${n}`;
}

/** The first unused bit and how many free bits follow it in the same byte. */
export function firstFreeRun(message: MessageDef): { start: number; size: number } | null {
  const used = new Set(message.signals.flatMap(signalBits));
  const total = message.size * 8;
  let start = 0;
  while (start < total && used.has(start)) start++;
  if (start >= total) return null;
  let size = 1;
  while ((start + size) % 8 !== 0 && !used.has(start + size)) size++;
  return { start, size };
}

/** Whether DBCs scoped to buses `a` and `b` (null for every bus) both apply to some bus. */
export function busesOverlap(a: string | null, b: string | null): boolean {
  return a === null || b === null || a === b;
}

/**
 * Per DBC id, the IDs of its messages that an earlier DBC decodes instead on at least one bus,
 * each with that earlier DBC's name. `dbcs` is in lookup order.
 */
export function overriddenMessages(dbcs: LoadedDbc[]): Map<string, Map<number, string>> {
  const result = new Map<string, Map<number, string>>();
  dbcs.forEach((dbc, index) => {
    const earlier = dbcs
      .slice(0, index)
      .filter((e) => busesOverlap(e.channel, dbc.channel))
      .map((e) => ({ name: e.db.name, ids: new Set(e.db.messages.map((m) => m.id)) }));
    const overridden = new Map<number, string>();
    for (const m of dbc.db.messages) {
      const winner = earlier.find((e) => e.ids.has(m.id));
      if (winner) overridden.set(m.id, winner.name);
    }
    result.set(dbc.id, overridden);
  });
  return result;
}

export function dbcFileName(name: string): string {
  return name.toLowerCase().endsWith('.dbc') ? name : `${name}.dbc`;
}

/** Two signals may share bits only when they belong to different multiplexed pages. */
export function canShareBits(a: SignalDef, b: SignalDef): boolean {
  return a.muxValue !== null && b.muxValue !== null && a.muxValue !== b.muxValue;
}

/** A rectangle of layout cells: `col` 0 is bit 7, as the grid draws MSB first. */
export interface Segment {
  byte: number;
  rows: number;
  col: number;
  span: number;
}

/**
 * Rectangles covering `bits`: one per run of adjacent bits within a byte, with identical runs
 * in consecutive bytes merged so a 16-bit signal over two whole bytes reads as one region.
 * Bits past the payload are left out.
 */
export function segmentsOf(bits: number[], bytes: number): Segment[] {
  const columnsByByte = new Map<number, number[]>();
  for (const bit of bits) {
    if (bit < 0 || bit >= bytes * 8) continue;
    const byte = Math.floor(bit / 8);
    const columns = columnsByByte.get(byte) ?? [];
    columns.push(7 - (bit % 8));
    columnsByByte.set(byte, columns);
  }

  const runs: Segment[] = [];
  for (const byte of [...columnsByByte.keys()].sort((a, b) => a - b)) {
    const columns = (columnsByByte.get(byte) ?? []).sort((a, b) => a - b);
    let runStart = columns[0];
    for (let i = 1; i <= columns.length; i++) {
      if (i < columns.length && columns[i] === columns[i - 1] + 1) continue;
      runs.push({ byte, rows: 1, col: runStart, span: columns[i - 1] - runStart + 1 });
      runStart = columns[i];
    }
  }

  const merged: Segment[] = [];
  for (const run of runs) {
    const above = merged.find((m) => m.byte + m.rows === run.byte && m.col === run.col && m.span === run.span);
    if (above) above.rows++;
    else merged.push({ ...run });
  }
  return merged;
}

if (import.meta.env.DEV) {
  const counter = segmentsOf(signalBits(newSignal('Counter', 51, 4)), 8);
  console.assert(
    counter.length === 1 && counter[0].byte === 6 && counter[0].col === 1 && counter[0].span === 4,
    'Counter 51|4@1+ should fill byte 6, bits 6 to 3',
    counter,
  );
}
