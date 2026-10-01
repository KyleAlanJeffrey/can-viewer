import { useEffect, useRef, useState } from 'react';
import { formatId, type SeriesInfo } from '../../core/api';
import { cssVar } from '../../format';
import type { ViewContext } from '../types';
import { errorText } from './bits';

/** A reference kept in view while working on an ID: a decoded signal, or one raw byte of a message. */
export type Pin = { kind: 'signal'; key: number; signal: string } | { kind: 'byte'; key: number; byte: number };

export function pinId(p: Pin): string {
  return p.kind === 'signal' ? `${p.key}:s:${p.signal}` : `${p.key}:b:${p.byte}`;
}

/** A pinned reference with its decoded series, or why it has none yet. */
export interface Reference {
  pin: Pin;
  id: string;
  /** The signal's name, or `123 - Byte 2` for a raw byte. */
  name: string;
  /** Where it comes from: `3E9 - can0`, or the raw byte's fixed scale. */
  source: string;
  unit: string;
  color: string;
  /** Raw bytes keep a fixed scale; decoded signals use their own. */
  range: [number, number] | null;
  info: SeriesInfo | null;
  error: string | null;
}

interface Entry {
  logVersion: number;
  info: SeriesInfo | null;
  error: string | null;
}

const SERIES_SLOTS = 6;

/**
 * Decodes every pin into a series the plots can view, and drops a series once its pin is gone or
 * its signal definition changed. Signals keep the colour they have in the Plot view; otherwise
 * each takes the first series colour no other pin uses. Raw bytes are graphite.
 */
export function useReferences(ctx: ViewContext, pins: Pin[]): Reference[] {
  const { core, logVersion, messageOf, log, ids, plots } = ctx;
  const entries = useRef(new Map<string, Entry>());
  const [, bump] = useState(0);

  const wanted = pins.map((pin) => {
    const message = messageOf(pin.key);
    const def = pin.kind === 'signal' ? (message?.signals.find((s) => s.name === pin.signal) ?? null) : null;
    const decodeKey =
      pin.kind === 'signal' ? `${logVersion}:${pin.key}:s:${pin.signal}:${def ? JSON.stringify(def) : 'missing'}` : `${logVersion}:${pin.key}:b:${pin.byte}`;
    return { pin, def, decodeKey };
  });
  const wantedKeys = wanted.map((w) => w.decodeKey).join('\n');

  useEffect(() => {
    const keep = new Set(wanted.map((w) => w.decodeKey));
    for (const [key, entry] of entries.current) {
      if (keep.has(key)) continue;
      // Handles of an earlier log died with its session; dropping them could hit a new series.
      if (entry.info && entry.logVersion === logVersion) core.dropSeries(entry.info.handle);
      entries.current.delete(key);
    }
    for (const { pin, def, decodeKey } of wanted) {
      if (entries.current.has(decodeKey)) continue;
      const entry: Entry = { logVersion, info: null, error: null };
      entries.current.set(decodeKey, entry);
      const decode =
        pin.kind === 'signal'
          ? def
            ? core.decodeSignal(pin.key, pin.signal)
            : Promise.reject(new Error('Not in the loaded DBCs any more'))
          : core.decodeRaw(pin.key, { startBit: pin.byte * 8, size: 8, byteOrder: 'intel', signed: false, factor: 1, offset: 0 });
      decode.then(
        (info) => {
          if (entries.current.get(decodeKey) !== entry) {
            core.dropSeries(info.handle);
            return;
          }
          entry.info = info;
          bump((n) => n + 1);
        },
        (e) => {
          if (entries.current.get(decodeKey) !== entry) return;
          entry.error = errorText(e);
          bump((n) => n + 1);
        },
      );
    }
    // `wanted` is derived from these.
  }, [core, logVersion, wantedKeys]);

  useEffect(
    () => () => {
      for (const entry of entries.current.values()) if (entry.info) core.dropSeries(entry.info.handle);
      entries.current.clear();
    },
    [core],
  );

  const plottedColor = (pin: Pin) => (pin.kind === 'signal' ? plots.find((p) => p.id === `${pin.key}:${pin.signal}`)?.color : undefined);
  // Plotted colours are fixed, so unplotted pins pick around all of them, not just the ones listed earlier.
  const taken = new Set(pins.map(plottedColor).filter((c): c is string => c !== undefined));
  const graphite = cssVar('--graphite');
  return wanted.map(({ pin, def, decodeKey }, i) => {
    const entry = entries.current.get(decodeKey);
    const summary = ids.find((s) => s.key === pin.key);
    const idText = summary ? formatId(summary.id, summary.extended) : '?';
    const bus = summary ? (log?.channels[summary.channel] ?? '?') : '?';
    if (pin.kind === 'byte') {
      return {
        pin,
        id: pinId(pin),
        name: `${idText} \u00b7 Byte ${pin.byte}`,
        source: 'Raw byte \u00b7 0 to 255',
        unit: '',
        color: graphite,
        range: [0, 255],
        info: entry?.info ?? null,
        error: entry?.error ?? null,
      };
    }
    const plotted = plottedColor(pin);
    let color = plotted ?? cssVar(`--series-${(i % SERIES_SLOTS) + 1}`);
    if (!plotted) {
      for (let slot = 1; slot <= SERIES_SLOTS; slot++) {
        const candidate = cssVar(`--series-${slot}`);
        if (!taken.has(candidate)) {
          color = candidate;
          break;
        }
      }
    }
    taken.add(color);
    return {
      pin,
      id: pinId(pin),
      name: pin.signal,
      source: `${idText} \u00b7 ${bus}`,
      unit: def?.unit ?? '',
      color,
      range: null,
      info: entry?.info ?? null,
      error: entry?.error ?? null,
    };
  });
}
