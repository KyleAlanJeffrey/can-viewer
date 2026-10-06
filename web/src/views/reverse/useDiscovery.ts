import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DiscoveryHints, MessageSuggestions, Suggestion } from '../../core/api';
import { isAbort } from '../../core/discovery';
import { useViewState } from '../shared/viewState';
import type { ViewContext } from '../types';
import { errorText } from './bits';

/** A suggestion that went into a DBC, kept so it can be undone. */
export interface Accepted {
  signal: string;
  dbc: string;
  /** The DBC message's ID. */
  messageId: number;
  /** The add created the message, or the whole DBC, which Undo then removes again once empty. */
  createdMessage: boolean;
  createdDbc: boolean;
}

export interface MessageHints {
  /** Event markers, in seconds from the start of the log. */
  markers: number[];
  reference: { key: number; signal: string } | null;
}

export const NO_HINTS: MessageHints = { markers: [], reference: null };

interface Saved {
  results: Record<string, MessageSuggestions>;
  /** Whether the scan of every unknown message ran to the end, or was stopped part way. */
  scan: 'none' | 'stopped' | 'done';
  dismissed: string[];
  accepted: Record<string, Accepted>;
  hints: Record<string, MessageHints>;
}

const EMPTY: Saved = {
  results: {},
  scan: 'none',
  dismissed: [],
  accepted: {},
  hints: {},
};

export interface ScanProgress {
  done: number;
  total: number;
}

export interface Discovery {
  results: Record<string, MessageSuggestions>;
  scan: Saved['scan'];
  /** The scan in hand, or null. */
  progress: ScanProgress | null;
  /** Why the last scan stopped short, other than being cancelled. */
  scanError: string | null;
  /** IDs being suggested for on their own. */
  running: number[];
  errors: Record<string, string>;
  dismissed: Set<string>;
  accepted: Record<string, Accepted>;
  hintsFor: (key: number) => MessageHints;
  /**
   * Suggest for `key` when nothing has yet. An unknown ID starts the scan of all of them, or
   * during a scan goes ahead of the messages still to come.
   */
  ensure: (key: number) => void;
  /** Scan the unknown messages not scanned yet, `first` first. */
  scanAll: (first?: number) => void;
  cancel: () => void;
  /** Suggest again for one message, with its hints. */
  rescan: (key: number, hints?: MessageHints) => void;
  dismiss: (id: string, dismissed: boolean) => void;
  markAccepted: (id: string, accepted: Accepted | null) => void;
}

/** A suggestion's id: its message and bits, so it survives a scan again with other hints. */
export function suggestionId(key: number, s: Suggestion): string {
  const page = s.spec.mux ? `:m${s.spec.mux.value}` : '';
  return `${key}:${s.spec.startBit}:${s.spec.size}:${s.spec.byteOrder}${page}`;
}

export function toCoreHints(hints: MessageHints): DiscoveryHints {
  return {
    markers: hints.markers.map((t) => ({ t })),
    reference: hints.reference,
  };
}

/**
 * Suggested signals for the open log. Results, dismissals and acceptances are kept with the log;
 * the scan itself runs in the view and stops when it unmounts.
 */
export function useDiscovery(ctx: ViewContext, unknown: number[]): Discovery {
  const { core } = ctx;
  const [saved, setSaved] = useViewState<Saved>('re.discovery', EMPTY, 'log');
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [running, setRunning] = useState<number[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [scanError, setScanError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const cancelledByUser = useRef(false);
  const latest = useRef({ saved, unknown, logVersion: ctx.logVersion });
  latest.current = { saved, unknown, logVersion: ctx.logVersion };

  const inFlight = useRef(new Set<number>());
  // The key the scan has in hand.
  const scanning = useRef<number | null>(null);

  // Leaving the view, or opening another log, stops the scan; it picks up again where it left off.
  useEffect(
    () => () => {
      controller.current?.abort();
      controller.current = null;
      inFlight.current.clear();
      setRunning([]);
      setProgress(null);
      setErrors({});
      setScanError(null);
    },
    [ctx.logVersion],
  );

  const store = useCallback(
    (found: MessageSuggestions, logVersion: number) => {
      if (logVersion !== latest.current.logVersion) return;
      setSaved((s) => ({ ...s, results: { ...s.results, [found.key]: found } }));
    },
    [setSaved],
  );
  const setError = (key: number, error: string | null) =>
    setErrors((all) => {
      const next = { ...all };
      if (error === null) delete next[key];
      else next[key] = error;
      return next;
    });

  const scanAll = useCallback(
    (first?: number) => {
      if (controller.current) return;
      const { saved: now, unknown: keys } = latest.current;
      const todo = keys.filter((k) => !now.results[k]);
      if (first !== undefined && todo.includes(first)) todo.sort((a, b) => Number(b === first) - Number(a === first));
      if (todo.length === 0) {
        setSaved((s) => ({ ...s, scan: 'done' }));
        return;
      }
      const abort = new AbortController();
      const logVersion = latest.current.logVersion;
      controller.current = abort;
      cancelledByUser.current = false;
      setScanError(null);
      setProgress({ done: 0, total: todo.length });
      core
        .scanSignals(
          todo,
          {},
          (done, total, found) => {
            // The message in hand when the scan was cancelled still counts: it may be the one open.
            if (found) store(found, logVersion);
            if (!abort.signal.aborted) setProgress({ done, total });
          },
          abort.signal,
          // Passes over a message suggested for out of turn, as when opened during the scan.
          (k) => {
            const skip = !!latest.current.saved.results[k] || inFlight.current.has(k);
            if (!skip) scanning.current = k;
            return skip;
          },
        )
        .then(
          () => logVersion === latest.current.logVersion && setSaved((s) => ({ ...s, scan: 'done' })),
          (e) => {
            if (logVersion !== latest.current.logVersion) return;
            if (!isAbort(e)) setScanError(errorText(e));
            setSaved((s) => ({ ...s, scan: isAbort(e) && !cancelledByUser.current ? 'none' : 'stopped' }));
          },
        )
        .finally(() => {
          if (controller.current !== abort) return;
          controller.current = null;
          scanning.current = null;
          setProgress(null);
        });
    },
    [core, setSaved, store],
  );

  const rescan = useCallback(
    (key: number, hints?: MessageHints) => {
      const use = hints ?? latest.current.saved.hints[key] ?? NO_HINTS;
      const logVersion = latest.current.logVersion;
      inFlight.current.add(key);
      setRunning((r) => (r.includes(key) ? r : [...r, key]));
      setError(key, null);
      core
        .suggestSignals(key, toCoreHints(use))
        .then(
          (found) => store(found, logVersion),
          (e) => logVersion === latest.current.logVersion && setError(key, errorText(e)),
        )
        .finally(() => {
          // A request for the log before is already forgotten, and must not end one for this log.
          if (logVersion !== latest.current.logVersion) return;
          inFlight.current.delete(key);
          setRunning((r) => r.filter((k) => k !== key));
        });
    },
    [core, store],
  );

  const ensure = useCallback(
    (key: number) => {
      const { saved: now, unknown: keys } = latest.current;
      if (now.results[key] || inFlight.current.has(key)) return;
      if (controller.current && scanning.current === key) return;
      if (keys.includes(key) && !controller.current && now.scan === 'none') scanAll(key);
      // During a scan this goes ahead of the messages still to come, which then skip it.
      else rescan(key);
    },
    [scanAll, rescan],
  );

  const dismissed = useMemo(() => new Set(saved.dismissed), [saved.dismissed]);

  return {
    results: saved.results,
    scan: saved.scan,
    progress,
    scanError,
    running,
    errors,
    dismissed,
    accepted: saved.accepted,
    hintsFor: (key) => saved.hints[key] ?? NO_HINTS,
    ensure,
    scanAll,
    cancel: () => {
      cancelledByUser.current = true;
      controller.current?.abort();
    },
    rescan: (key, hints) => {
      if (hints) setSaved((s) => ({ ...s, hints: { ...s.hints, [key]: hints } }));
      rescan(key, hints);
    },
    dismiss: (id, dismissed) =>
      setSaved((s) => ({
        ...s,
        dismissed: dismissed ? [...s.dismissed.filter((d) => d !== id), id] : s.dismissed.filter((d) => d !== id),
      })),
    markAccepted: (id, accepted) =>
      setSaved((s) => {
        const next = { ...s.accepted };
        if (accepted) next[id] = accepted;
        else delete next[id];
        return { ...s, accepted: next };
      }),
  };
}
