// Video and log times are both seconds. An offset ties them together: log time = video time + offset,
// so a positive offset means the video starts after the log.

export function logTimeOf(videoTime: number, offset: number): number {
  return videoTime + offset;
}

export function videoTimeOf(logTime: number, offset: number): number {
  return logTime - offset;
}

/** Where a time falls against a span that runs from 0 to `end`. */
export type Coverage = 'before' | 'inside' | 'after';

export function coverage(t: number, end: number): Coverage {
  if (t < 0) return 'before';
  if (t > end) return 'after';
  return 'inside';
}

/** Offsets are kept to the millisecond, so repeated 0.1 s nudges don't gather float noise. */
export function roundOffset(offset: number): number {
  const rounded = Math.round(offset * 1000) / 1000;
  return rounded === 0 ? 0 : rounded;
}

export function nudgeOffset(offset: number, delta: number): number {
  return roundOffset(offset + delta);
}

/** Seconds without trailing zeros: 3.2 s, 0.05 s, 12 s. */
export function formatShortSeconds(t: number): string {
  return `${Number(t.toFixed(3))} s`;
}

export function describeOffset(offset: number): string {
  const rounded = roundOffset(offset);
  if (rounded === 0) return 'Video and log start together';
  return `Video starts ${formatShortSeconds(Math.abs(rounded))} ${rounded > 0 ? 'after' : 'before'} the log`;
}

/** A video position as `mm:ss.mmm`, or `h:mm:ss.mmm` from an hour on. */
export function formatClock(t: number): string {
  if (!Number.isFinite(t)) return '--:--.---';
  const ms = Math.round(Math.max(0, t) * 1000);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const frac = String(ms % 1000).padStart(3, '0');
  const mmss = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${frac}`;
  return h > 0 ? `${h}:${mmss}` : mmss;
}

/**
 * Reads a typed time: plain seconds (`49.14`, `49.14 s`) or a clock (`0:49.140`, `1:02:03.5`).
 * Null when it is neither, or negative.
 */
export function parseTime(text: string): number | null {
  const trimmed = text.trim().replace(/\s*s$/i, '');
  if (trimmed === '') return null;
  const parts = trimmed.split(':');
  if (parts.length > 3) return null;
  const number = /^\d+(\.\d*)?$|^\.\d+$/;
  if (!parts.every((p) => number.test(p))) return null;
  // Minutes and hours are whole; only the last part may carry a fraction.
  if (parts.slice(0, -1).some((p) => p.includes('.'))) return null;
  if (parts.length > 1 && parts.slice(1).some((p) => Number(p) >= 60)) return null;
  return parts.reduce((total, p) => total * 60 + Number(p), 0);
}

const OFFSETS_KEY = 'freecan-studio.video-offsets';
const MAX_REMEMBERED = 50;

type Remembered = [key: string, offset: number][];

/** What tells one log file from another: its name and size. */
export interface LogIdentity {
  name: string;
  bytes: number;
}

/**
 * The key an offset is remembered under. Dashcams reuse file names, so the video's size and
 * modification time count too, and the log's size.
 */
export function offsetKey(log: LogIdentity, video: Pick<File, 'name' | 'size' | 'lastModified'>): string {
  return JSON.stringify([log.name, log.bytes, video.name, video.size, video.lastModified]);
}

function readRemembered(): Remembered {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(OFFSETS_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((e): e is Remembered[number] => Array.isArray(e) && typeof e[0] === 'string' && typeof e[1] === 'number') : [];
  } catch {
    return [];
  }
}

/** The offset last synced for the log and video of `key` (see `offsetKey`). */
export function rememberedOffset(key: string): number | null {
  return readRemembered().find(([k]) => k === key)?.[1] ?? null;
}

/** Keeps the offset for `key`, or forgets it when null. Only the most recent pairs are kept. */
export function rememberOffset(key: string, offset: number | null) {
  const rest = readRemembered().filter(([k]) => k !== key);
  const next = offset === null ? rest : [...rest, [key, offset] as Remembered[number]].slice(-MAX_REMEMBERED);
  try {
    localStorage.setItem(OFFSETS_KEY, JSON.stringify(next));
  } catch {
    // Storage off or full: the sync still holds for this session.
  }
}
