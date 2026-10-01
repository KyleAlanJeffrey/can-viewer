import type { CoreApi } from '../../core/api';

export type Range = [number, number];

export type CursorMode = 'one' | 'two';

export type CursorId = 'a' | 'b';

export interface Marker {
  id: number;
  label: string;
  time: number;
}

/** One signal's value at a cursor. */
export interface CursorSample {
  /** The nearest recorded sample, which is what readouts show. */
  value: number;
  /** The line's value at the cursor time, so the intersection dot sits on the drawn line. */
  onLine: number;
}

export interface LaneSamples {
  a: CursorSample | null;
  b: CursorSample | null;
}

/** The plotting area's left edge and width in px, relative to whichever element positions against it. */
export interface PlotArea {
  left: number;
  width: number;
}

/** Shortest visible span, in seconds. */
const MIN_SPAN = 1e-3;

export function clampRange([a, b]: Range, duration: number): Range {
  const span = Math.min(duration, Math.max(MIN_SPAN, b - a));
  let t0 = Math.max(0, Math.min(a, duration - span));
  if (!Number.isFinite(t0)) t0 = 0;
  return [t0, t0 + span];
}

export function clampTime(t: number, duration: number): number {
  return Math.min(duration, Math.max(0, t));
}

export function formatSeconds(t: number): string {
  return `${t.toFixed(3)} s`;
}

export function withUnit(text: string, unit: string): string {
  return unit ? `${text} ${unit}` : text;
}

/** Whole minutes only while ticks are at least a minute apart; closer than that, seconds to the tick's precision. */
export function formatTick(t: number, step: number): string {
  if (step >= 60) {
    const minutes = Math.round(t / 60);
    return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`;
  }
  return `${t.toFixed(stepDecimals(step))} s`;
}

// Steps run 1-2-2.5-5 per decade, so 2.5 or 0.25 needs one more place than the decade suggests.
function stepDecimals(step: number): number {
  return (String(Number(step.toFixed(6))).split('.')[1] ?? '').length;
}

const fixedFormats = new Map<number, Intl.NumberFormat>();
const compactFormat = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

/** Y tick labels, to the step's precision; compact once they'd crowd the axis. */
export function formatYTick(v: number, step: number): string {
  if (Math.abs(v) >= 1e6) return compactFormat.format(v);
  const decimals = stepDecimals(step);
  let format = fixedFormats.get(decimals);
  if (!format) {
    format = new Intl.NumberFormat('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
    fixedFormats.set(decimals, format);
  }
  // Ticks can land on -0, which would print as "-0".
  return format.format(v === 0 ? 0 : v);
}

const valueFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

export function formatValue(v: number): string {
  return Math.abs(v) >= 1e4 ? valueFormat.format(Math.round(v)) : valueFormat.format(Number(v.toPrecision(6)));
}

export function formatDelta(v: number): string {
  const text = formatValue(v);
  if (/^-?0$/.test(text)) return '0';
  return v > 0 ? `+${text}` : text;
}

const MINUTE_STEPS = [60, 120, 300, 600, 900, 1200, 1800, 3600, 7200, 10800, 21600, 43200, 86400];

/** A round tick step that keeps labels at least `minGap` px apart across `px` px showing `span` seconds. */
export function niceStep(span: number, px: number, minGap: number): number {
  const raw = (span / Math.max(1, px)) * minGap;
  if (!(raw > 0)) return 1;
  if (raw >= 60) return MINUTE_STEPS.find((s) => s >= raw) ?? Math.ceil(raw / 86400) * 86400;
  const decade = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 5, 10].map((m) => m * decade).find((s) => s >= raw) ?? decade * 10;
}

/** The sample nearest `t`, and the line's value at `t` from the samples either side of it. */
export async function sampleAt(core: CoreApi, handle: number, t: number): Promise<CursorSample | null> {
  // A zero-width window comes back as the raw samples around t, never decimated.
  const [xs, ys] = await core.seriesView(handle, t, t, 1);
  if (xs.length === 0) return null;
  let nearest = 0;
  for (let i = 1; i < xs.length; i++) {
    if (Math.abs(xs[i] - t) < Math.abs(xs[nearest] - t)) nearest = i;
  }
  let onLine = ys[nearest];
  for (let i = 0; i + 1 < xs.length; i++) {
    if (xs[i] <= t && t <= xs[i + 1]) {
      const gap = xs[i + 1] - xs[i];
      onLine = gap > 0 ? ys[i] + ((ys[i + 1] - ys[i]) * (t - xs[i])) / gap : ys[i];
      break;
    }
  }
  return { value: ys[nearest], onLine };
}
