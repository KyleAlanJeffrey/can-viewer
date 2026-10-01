import { useEffect, useState } from 'react';

const count = new Intl.NumberFormat('en-US');

export function formatCount(n: number): string {
  return count.format(n);
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
