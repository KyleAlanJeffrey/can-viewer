import { useEffect, useState } from 'react';
import type { LogFormat, LogInfo } from './core/api';

const count = new Intl.NumberFormat('en-US');

export function formatCount(n: number): string {
  return count.format(n);
}

/** `1 frame`, `2,000 frames`. */
export function formatCountOf(n: number, one: string, many: string): string {
  return `${formatCount(n)} ${n === 1 ? one : many}`;
}

export function formatBytes(n: number): string {
  if (n < 1e3) return `${n} B`;
  if (n < 1e6) return `${(n / 1e3).toFixed(0)} kB`;
  if (n < 1e9) return `${(n / 1e6).toFixed(0)} MB`;
  return `${(n / 1e9).toFixed(2)} GB`;
}

export function formatDuration(s: number): string {
  if (s < 60) return `${s.toFixed(1)} s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h} h ${m} min` : `${m} min ${Math.round(s % 60)} s`;
}

/** A message period, e.g. `10 ms` or `1.0 s`; empty when unknown. */
export function formatPeriod(ms: number | null): string {
  if (ms === null) return '';
  // Round first so 9.97 reads 10 ms, not 10.0 ms.
  if (ms < 9.95) return `${ms.toFixed(1)} ms`;
  if (ms < 999.5) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

const LOG_FORMAT_NAMES: Record<LogFormat, string> = {
  candump: 'candump',
  asc: 'ASC',
  trc: 'TRC',
  csv: 'CSV',
  blf: 'BLF',
  mf4: 'MF4',
  capture: 'Capture',
};

export function logFormatName(format: LogFormat): string {
  return LOG_FORMAT_NAMES[format];
}

/** BLF and MF4 count records where the text formats count lines. */
function isBinary(format: LogFormat): boolean {
  return format === 'blf' || format === 'mf4';
}

/** How many lines (records, for BLF and MF4) weren't frames, e.g. `3 lines weren't CAN frames and were skipped.` */
export function formatSkipped(log: LogInfo): string {
  const one = log.rejected === 1;
  const noun = `${isBinary(log.format) ? 'record' : 'line'}${one ? '' : 's'}`;
  return `${formatCount(log.rejected)} ${noun} ${one ? "wasn't a CAN frame and was" : "weren't CAN frames and were"} skipped.`;
}

/** Where the first line or record that wasn't a frame is, and why, e.g. `First at line 3: bad CAN ID`. */
export function formatFirstRejection(log: LogInfo): string | null {
  if (!log.firstRejection) return null;
  const [at, reason] = log.firstRejection;
  return `First at ${isBinary(log.format) ? 'record' : 'line'} ${formatCount(at)}: ${reason}`;
}

/** Why an opened log gives nothing to show, or null when it has frames, or is just empty. */
export function noFramesMessage(log: LogInfo): string | null {
  if (log.frames > 0) return null;
  const file = `${log.name} (${logFormatName(log.format)})`;
  if (log.rejected === 0) {
    return isBinary(log.format)
      ? `No CAN frames in ${file}. It holds no CAN, CAN FD or error frames, only other data such as LIN, FlexRay or Ethernet.`
      : null;
  }
  const reason = log.firstRejection ? `: ${log.firstRejection[1]}` : '';
  return `No CAN frames in ${file}${reason}. FreeCAN Studio reads candump logs (candump -l), Vector ASC and BLF, PEAK TRC, ASAM MF4 bus logging and CSV files.`;
}

/** Read a CSS custom property from the document root. */
export function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** True once web fonts have loaded, so canvas views can redraw with the real faces. */
export function useFontsReady(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let live = true;
    // Canvas text doesn't trigger font loading, so ask for the faces it draws with.
    const faces = ['400 13px "IBM Plex Mono"', '600 13px "IBM Plex Mono"', '400 11px "IBM Plex Sans"', '500 12px "IBM Plex Sans"'];
    Promise.all(faces.map((f) => document.fonts.load(f))).then(() => live && setReady(true));
    return () => {
      live = false;
    };
  }, []);
  return ready;
}
