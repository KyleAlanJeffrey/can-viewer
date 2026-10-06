import { useEffect, useState } from 'react';
import { formatId, type CoreApi, type IdSummary, type MessageDef, type RawSignalSpec } from '../../core/api';
import { formatCount, formatPeriod } from '../../format';

export type ByteOrder = RawSignalSpec['byteOrder'];

/** A run of payload bits in DBC terms: Intel counts from its LSB, Motorola from its MSB. */
export interface BitRange {
  startBit: number;
  size: number;
  byteOrder: ByteOrder;
}

/** The core decodes at most this many bits at once. */
export const MAX_BITS = 64;

/**
 * Bits are numbered `byte * 8 + bit` with bit 0 the LSB, as in the core's flip counts. Reading
 * order walks each byte from its MSB instead, which is the order Motorola ranges are contiguous
 * in. The mapping is its own inverse.
 */
export function readingOrder(bit: number): number {
  return (bit & ~7) | (7 - (bit & 7));
}

export function rangeBits({ startBit, size, byteOrder }: BitRange): number[] {
  const bits: number[] = [];
  if (byteOrder === 'intel') {
    for (let k = 0; k < size; k++) bits.push(startBit + k);
  } else {
    const first = readingOrder(startBit);
    for (let k = 0; k < size; k++) bits.push(readingOrder(first + k));
  }
  return bits;
}

/** The shortest range in `byteOrder` that covers every one of `bits`, cut to MAX_BITS. */
export function coveringRange(bits: number[], byteOrder: ByteOrder): BitRange | null {
  if (bits.length === 0) return null;
  const positions = byteOrder === 'intel' ? bits : bits.map(readingOrder);
  const first = Math.min(...positions);
  const size = Math.min(MAX_BITS, Math.max(...positions) - first + 1);
  return { startBit: byteOrder === 'intel' ? first : readingOrder(first), size, byteOrder };
}

/** Every cell of the grid rectangle with opposite corners at bits `a` and `b`. */
export function rectBits(a: number, b: number): number[] {
  const rows = [a >> 3, b >> 3].sort((x, y) => x - y);
  const cols = [7 - (a & 7), 7 - (b & 7)].sort((x, y) => x - y);
  const bits: number[] = [];
  for (let row = rows[0]; row <= rows[1]; row++) {
    for (let col = cols[0]; col <= cols[1]; col++) bits.push(row * 8 + (7 - col));
  }
  return bits;
}

export function rangeFits(r: BitRange, bytes: number): boolean {
  if (r.size < 1 || r.size > MAX_BITS || r.startBit < 0) return false;
  const first = r.byteOrder === 'intel' ? r.startBit : readingOrder(r.startBit);
  return first + r.size - 1 < bytes * 8;
}

/** DBC notation, e.g. `23|16@0+`, or `0|32@1- float` for a float. */
export function layoutString(r: BitRange, signed: boolean, float = false): string {
  return `${r.startBit}|${r.size}@${r.byteOrder === 'intel' ? 1 : 0}${signed || float ? '-' : '+'}${float ? ' float' : ''}`;
}

export const DBC_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The heat step (0 to steps - 1) for a change count. The scale is logarithmic, as in the Trace
 * inspector's grid, so a bit that changes once in 10,000 frames still shows next to a counter.
 */
export function heatStep(changes: number, transitions: number, steps: number): number {
  const rate = changes / Math.max(1, transitions);
  const t = Math.min(1, Math.max(0, (Math.log10(rate) + 4) / 4));
  return Math.min(steps - 1, Math.floor(t * steps));
}

/** Start and end in seconds from the start of the log. */
export type TimeWindow = [number, number];

const DEFAULT_START = 40;
const DEFAULT_SPAN = 30;
export const MIN_SPAN = 0.05;

/** Keeps the span where possible and slides the window back inside the log. */
export function clampWindow([a, b]: TimeWindow, duration: number): TimeWindow {
  if (!(duration > 0)) return [0, 0];
  const span = Math.min(duration, Math.max(MIN_SPAN, b - a));
  const t0 = Math.min(Math.max(0, a), duration - span);
  return [t0, t0 + span];
}

export function defaultWindow(duration: number): TimeWindow {
  return clampWindow([DEFAULT_START, DEFAULT_START + DEFAULT_SPAN], duration);
}

/** A window of the default span centred on `t`, kept inside the log. */
export function windowAround(t: number, duration: number): TimeWindow {
  return clampWindow([t - DEFAULT_SPAN / 2, t + DEFAULT_SPAN / 2], duration);
}

export function windowFits([a, b]: TimeWindow, duration: number): boolean {
  return duration > 0 ? a >= 0 && b <= duration && b - a >= MIN_SPAN - 1e-9 : a === 0 && b === 0;
}

/** Index of the first row of `s` at or after `t`, estimated from the frame rate if the core can't look it up. */
export async function rowIndexAt(core: CoreApi, s: IdSummary, t: number, duration: number): Promise<number> {
  try {
    return await core.rowAtTime(s.key, t);
  } catch {
    const fraction = duration > 0 ? Math.min(1, Math.max(0, t / duration)) : 0;
    return Math.round(fraction * Math.max(0, s.count - 1));
  }
}

/** A quiet, readable reason for a failed core call. Methods the core doesn't have yet read as unavailable. */
export function errorText(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e);
  return /isn't implemented|not yet/i.test(message) ? 'Not available in this build yet.' : message;
}

/** `value`, once it has stopped changing for `ms`. */
export function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

export function formatSeconds(t: number): string {
  return `${t.toFixed(3)} s`;
}

const valueFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

export function formatValue(v: number): string {
  return Math.abs(v) >= 1e4 ? valueFormat.format(Math.round(v)) : valueFormat.format(Number(v.toPrecision(6)));
}

/** A number for an editable field, without float noise such as 655.3500000000001. */
export function plainNumber(v: number): string {
  return String(Number(v.toPrecision(10)));
}

/** Parses a typed number; blank or malformed text is null. */
export function parseNumber(text: string): number | null {
  if (text.trim() === '') return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

export interface WindowStats {
  /** Points inside the window. */
  frames: number;
  /** Points whose value differs from the point before. */
  changes: number;
  min: number;
  max: number;
  last: number | null;
}

/** Stats over the points of a series view that fall inside the window (views carry one neighbour each side). */
export function windowStats(x: Float64Array, y: Float64Array, [t0, t1]: TimeWindow): WindowStats {
  let frames = 0;
  let changes = 0;
  let min = Infinity;
  let max = -Infinity;
  let last: number | null = null;
  for (let i = 0; i < x.length; i++) {
    if (x[i] < t0 || x[i] > t1) continue;
    const v = y[i];
    if (last !== null && v !== last) changes++;
    frames++;
    min = Math.min(min, v);
    max = Math.max(max, v);
    last = v;
  }
  return { frames, changes, min, max, last };
}

/** Points of a series across a window: times in seconds and values, in time order. */
export interface Trace {
  x: ArrayLike<number>;
  y: ArrayLike<number>;
}

export interface Point {
  t: number;
  v: number;
}

/** The last point at or before `t`, or the first point when `t` is before all of them. */
export function pointAt(trace: Trace, t: number): Point | null {
  const { x, y } = trace;
  if (x.length === 0) return null;
  let lo = 0;
  let hi = x.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (x[mid] <= t) lo = mid + 1;
    else hi = mid;
  }
  const i = Math.max(0, lo - 1);
  return { t: x[i], v: y[i] };
}

/** The last point inside the window. */
export function lastIn(trace: Trace, [t0, t1]: TimeWindow): Point | null {
  const { x, y } = trace;
  for (let i = x.length - 1; i >= 0; i--) if (x[i] >= t0 && x[i] <= t1) return { t: x[i], v: y[i] };
  return null;
}

/** Whether the points inside the window take more than one value. */
export function changesIn(trace: Trace, [t0, t1]: TimeWindow): boolean {
  const { x, y } = trace;
  let first: number | null = null;
  for (let i = 0; i < x.length; i++) {
    if (x[i] < t0 || x[i] > t1) continue;
    if (first === null) first = y[i];
    else if (y[i] !== first) return true;
  }
  return false;
}

export function clampTime(t: number, duration: number): number {
  return Math.min(Math.max(0, duration), Math.max(0, t));
}

/** The sidebar search's rule: the ID, the message name or one of its signals contains the text. */
export function matchesQuery(s: IdSummary, message: MessageDef | null, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    formatId(s.id, s.extended).toLowerCase().includes(q) ||
    (s.name ?? '').toLowerCase().includes(q) ||
    (message?.signals.some((sig) => sig.name.toLowerCase().includes(q)) ?? false)
  );
}

export function hexByte(v: number): string {
  return Math.round(v).toString(16).toUpperCase().padStart(2, '0');
}

/** Bus, period, frame count and optionally payload length, separated by middle dots. */
export function describeId(channels: string[], s: IdSummary, withLength: boolean): string {
  const length = s.minLen === s.maxLen ? `${s.maxLen} bytes` : `${s.minLen}-${s.maxLen} bytes`;
  return [channels[s.channel], s.periodMs !== null ? `every ${formatPeriod(s.periodMs)}` : null, `${formatCount(s.count)} frames`, withLength ? length : null]
    .filter(Boolean)
    .join(' \u00b7 ');
}
