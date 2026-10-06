import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, Cable, FileDown, FileText, Lock, PanelLeft, PanelRight, Save, Search, Square, X } from 'lucide-react';
// Type-only, so the adapters stay out of the main chunk.
import type { CaptureAdapter, CaptureSettings } from './capture/adapter';
import type { CaptureRecorder, CaptureStatus } from './capture/recorder';
import './capture/capture.css';
import { ALL_IDS, EXT_FLAG, type CaptureFrame, type CoreApi, type Database, type IdSummary, type LogInfo, type MessageDef, type SignalDef } from './core/api';
import { unpackFrames } from './core/captureFrames';
import { EXPORT_FORMATS, ExportLogSheet } from './components/ExportLogSheet';
import { Logo } from './components/Logo';
import type { PlotSpec } from './components/Plots';
import { Segmented } from './components/Segmented';
import { ChunkBoundary } from './components/ChunkBoundary';
import { Sheet } from './components/Sheet';
import { UpdateBanner } from './components/UpdateBanner';
import { cssVar, formatBytes, formatCount, formatCountOf, formatDuration, formatFirstRejection, formatSkipped, logFormatName, noFramesMessage } from './format';
import {
  claimKeptCapture,
  forget,
  loadSaved,
  loadSavedDbcs,
  markRestoreLeft,
  onDbcsChangedElsewhere,
  readCaptureChunks,
  save,
  saveDbcs,
  takeRestoreLeft,
  writeKeptCapture,
  type HeldCapture,
  type KeptCapture,
} from './session';
import { VIEWS, viewMeta } from './views';
import { isVideoFile, videoSession } from './views/plot/video/videoSession';
import { chooseBlobFile } from './views/shared/saveFile';
import { BUS_BITRATES_KEY, type BusBitrates } from './views/shared/busBitrates';
import { ViewStateContext, ViewStateStore } from './views/shared/viewState';
import { SlotContext } from './views/slots';
import type { LoadedDbc, ViewContext, ViewId } from './views/types';

const SERIES_SLOTS = 6;
const seriesColor = (slot: number) => cssVar(`--series-${(slot % SERIES_SLOTS) + 1}`);

interface Busy {
  label: string;
  /** 0..1 when the task can report progress. */
  fraction: number | null;
  /** The name of the log this task reads, which opening another log or Cancel may cut short. */
  readingLog?: string;
}

/** A log being read. */
interface LogRead {
  name: string;
  /** Set once another log or Cancel took its place. */
  stopped: boolean;
  /** It reopens a saved log, so cancelling it leaves no log rather than reopening that again. */
  reopens: boolean;
}

/** A task under way, and what the toolbar shows for it. */
interface Task {
  busy: Busy;
  read?: LogRead;
}

/** How a log read ended. */
type ReadOutcome = 'opened' | 'failed' | 'stopped';

interface OpenLogOptions {
  /** Reopens a saved log with this UI, as after a reload. */
  restore?: SavedUi;
  /** Reopens the log shown before a read that was cancelled or failed. */
  reopening?: boolean;
  /** Keeps the current view rather than going to Overview, for a log opened from within a view. */
  stay?: boolean;
}

type OpenLog = (file: Blob, name: string, options?: OpenLogOptions) => Promise<ReadOutcome>;

/** Whether `saved` is a copy of `log`. A capture's bytes are 0; a saved one is kept as the candump file it was saved as. */
const isSavedCopyOf = (saved: SavedLog | undefined, log: LogInfo | null): saved is SavedLog =>
  !!saved && !!log && saved.name === log.name && (log.format === 'capture' || saved.blob.size === log.bytes);

interface SavedLog {
  name: string;
  blob: Blob;
}

interface SavedUi {
  view: ViewId;
  selected: number;
  pinnedTime: number | null;
  plots: { key: number; signal: string; color: string }[];
}

interface Resolved {
  message: MessageDef;
  dbc: LoadedDbc;
}

/** A capture that is recording. */
interface LiveCapture {
  recorder: CaptureRecorder;
}

/** How often a live capture's status line updates, and at the start its frames reach the views. */
const LIVE_REFRESH_MS = 500;
/**
 * The views go over every frame when they refresh, so a growing capture refreshes them less
 * often: one more millisecond between refreshes per this many frames keeps their cost level.
 */
const FRAMES_PER_EXTRA_REFRESH_MS = 2000;
/** Plotted signals are decoded again every this many refreshes while capturing. */
const LIVE_PLOT_REFRESHES = 4;
/** Save Capture writes candump, which keeps every frame, bus name and error class. */
const CANDUMP_FILE = EXPORT_FORMATS.find((f) => f.format === 'candump')!.kind;

/** Restores of an unsaved capture that may fail, or crash the page, before it is restored only when asked. */
const MAX_CAPTURE_RESTORES = 2;

/** An unsaved capture whose stored frames can't be restored, however often it is tried. */
class DamagedCapture extends Error {}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const sentence = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`);
/** Loaded apart from the app, with the adapters behind it, as most visits never capture. */
const CaptureSheet = lazy(() => import('./capture/CaptureSheet').then((m) => ({ default: m.CaptureSheet })));

const narrow = () => window.matchMedia('(max-width: 900px)').matches;

const splitPlotId = (id: string): [number, string] => {
  const at = id.indexOf(':');
  return [Number(id.slice(0, at)), id.slice(at + 1)];
};

/** What a reload, or a cancelled read, restores the open log with. */
function uiSnapshot(view: ViewId, selected: number, pinnedTime: number | null, plots: PlotSpec[]): SavedUi {
  return {
    view,
    selected,
    pinnedTime,
    plots: plots.map((p) => {
      const [key, signal] = splitPlotId(p.id);
      return { key, signal, color: p.color };
    }),
  };
}

const byId = new WeakMap<Database, Map<number, MessageDef>>();
function messagesById(db: Database): Map<number, MessageDef> {
  let map = byId.get(db);
  if (!map) {
    map = new Map(db.messages.map((m) => [m.id, m]));
    byId.set(db, map);
  }
  return map;
}

/** The DBC and message the core decodes `summary` with. `dbcs` must be the list the core last got. */
function resolve(dbcs: LoadedDbc[], summary: IdSummary): Resolved | null {
  const dbc = summary.dbc === null ? undefined : dbcs[summary.dbc];
  const message = dbc && summary.messageId !== null ? messagesById(dbc.db).get(summary.messageId) : undefined;
  return dbc && message ? { message, dbc } : null;
}

/** DBCs saved before J1939 support have no `j1939` on their messages; then every 29-bit message was one. */
function withJ1939Flags(dbcs: LoadedDbc[]): LoadedDbc[] {
  return dbcs.map((d) => ({
    ...d,
    db: { ...d.db, messages: d.db.messages.map((m) => ('j1939' in m ? m : { ...m, j1939: m.id >= EXT_FLAG })) },
  }));
}

/** Whether `next` changes anything the core sees: a DBC's contents, bus or place in the lookup order. */
function coreSees(prev: LoadedDbc[], next: LoadedDbc[]): boolean {
  return prev.length !== next.length || next.some((d, i) => d.db !== prev[i].db || d.channel !== prev[i].channel);
}

/** `name`, or `name` with a number before the extension if another loaded DBC already uses it. */
function uniqueName(dbcs: LoadedDbc[], name: string): string {
  const taken = new Set(dbcs.map((d) => d.db.name));
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  for (let n = 2; ; n++) if (!taken.has(`${stem}-${n}${ext}`)) return `${stem}-${n}${ext}`;
}

export function App({ core }: { core: CoreApi }) {
  const [log, setLog] = useState<LogInfo | null>(null);
  const [logVersion, setLogVersion] = useState(0);
  const [ids, setIds] = useState<IdSummary[]>([]);
  const [dbcs, setDbcs] = useState<LoadedDbc[]>([]);
  const [view, setViewState] = useState<ViewId>('overview');
  const [selected, setSelected] = useState(ALL_IDS);
  const [plots, setPlots] = useState<PlotSpec[]>([]);
  const [pinnedTime, setPinnedTime] = useState<number | null>(null);
  const [busy, setBusy] = useState<Busy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [skippedDismissed, setSkippedDismissed] = useState(false);
  const [notKept, setNotKept] = useState<string | null>(null);
  const [dbcsNotKept, setDbcsNotKept] = useState(false);
  const [dbcsChangedElsewhere, setDbcsChangedElsewhere] = useState(false);
  const [restoring, setRestoring] = useState(true);
  const [dragOver, setDragOver] = useState(false);
  const [captureOpen, setCaptureOpen] = useState(false);
  // The sheet loads when first opened, then stays, keeping the chosen adapter.
  const [captureSheetUsed, setCaptureSheetUsed] = useState(false);
  const [live, setLive] = useState<LiveCapture | null>(null);
  const [liveStatus, setLiveStatus] = useState<CaptureStatus | null>(null);
  const [stopping, setStopping] = useState(false);
  // Set at once, as the state isn't seen by a drop until the next render.
  const stoppingRef = useRef(false);
  /** The open log is a capture not yet saved to a file. */
  const [unsavedCapture, setUnsavedCapture] = useState(false);
  const [captureNotice, setCaptureNotice] = useState<string | null>(null);
  /** Why the open capture is no longer kept for a reload, once storage refused it. */
  const [captureNotKept, setCaptureNotKept] = useState<{ name: string; detail: string } | null>(null);
  /** An unsaved capture that failed to restore too often to be tried again without asking. */
  const [stuckCapture, setStuckCapture] = useState<{ capture: KeptCapture; held: HeldCapture } | null>(null);
  const [deletingStuckCapture, setDeletingStuckCapture] = useState(false);
  /** What screen readers are told while recording: the start, the first problem, the size warning. */
  const [liveAnnouncement, setLiveAnnouncement] = useState('');
  /** What to do once the user agrees to discard an unsaved capture. */
  const [discardThen, setDiscardThen] = useState<(() => void) | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportEnded, setExportEnded] = useState(false);
  const [query, setQuery] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(() => !narrow());
  const [inspectorOpen, setInspectorOpen] = useState(() => !narrow());
  const [inspectorHidden, setInspectorHidden] = useState(false);
  const [sidebarSlot, setSidebarSlot] = useState<HTMLElement | null>(null);
  const [inspectorSlot, setInspectorSlot] = useState<HTMLElement | null>(null);
  const [viewState] = useState(() => new ViewStateStore());
  const logInput = useRef<HTMLInputElement>(null);
  const dbcInput = useRef<HTMLInputElement>(null);
  const exportButton = useRef<HTMLButtonElement>(null);
  const openLogButton = useRef<HTMLButtonElement>(null);
  /** Set when Cancel is pressed or goes away with focus, to give focus somewhere once there is a place for it. */
  const [focusAfterCancel, setFocusAfterCancel] = useState(false);
  const cancelElement = useRef<HTMLButtonElement | null>(null);
  // Stable, so its cleanup runs only when Cancel goes away, not on every render.
  const cancelButton = useCallback((button: HTMLButtonElement | null) => {
    if (!button) return;
    cancelElement.current = button;
    return () => {
      if (cancelElement.current === button) cancelElement.current = null;
      if (document.activeElement === button) setFocusAfterCancel(true);
    };
  }, []);

  // Async tasks read these rather than a render's closure, so queued DBC edits never undo each other.
  const dbcsRef = useRef<LoadedDbc[]>([]);
  const changeQueue = useRef<Promise<unknown>>(Promise.resolve());
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const logRef = useRef(log);
  logRef.current = log;
  const plotsRef = useRef(plots);
  plotsRef.current = plots;
  /** The UI as a reload restores it, to reopen the log shown with it. */
  const currentUi = useRef(() => uiSnapshot(view, selected, pinnedTime, plots));
  currentUi.current = () => uiSnapshot(view, selected, pinnedTime, plots);
  const unsavedRef = useRef(unsavedCapture);
  unsavedRef.current = unsavedCapture;
  // Set by hand rather than each render, so a refresh in flight sees a capture stop at once.
  const liveRef = useRef<LiveCapture | null>(null);
  /** The unsaved capture this tab keeps in storage for a reload, recording or not. */
  const keptRef = useRef<HeldCapture | null>(null);
  /** The signal definition each plot was decoded with, to skip decoding again when it hasn't changed. */
  const plotSignals = useRef(new Map<string, SignalDef>());

  const meta = viewMeta(view);
  // Database works on DBCs alone; every other view needs a log.
  const showView = !!log || (!meta.needsLog && dbcs.length > 0);
  const showInspector = showView && meta.hasInspector && !inspectorHidden;

  const resolved = useMemo(() => {
    const map = new Map<number, Resolved>();
    if (!log) return map;
    for (const s of ids) {
      const hit = resolve(dbcs, s);
      if (hit) map.set(s.key, hit);
    }
    return map;
  }, [ids, dbcs, log]);
  const messageOf = useCallback((key: number) => resolved.get(key)?.message ?? null, [resolved]);
  const dbcOf = useCallback((key: number) => resolved.get(key)?.dbc ?? null, [resolved]);

  /** Tasks under way, latest last: the app stays busy until every one has ended. */
  const tasks = useRef<Task[]>([]);
  /** Shows the latest task. Set now, not on the next render, so a file dropped meanwhile is turned away. */
  const showLatestTask = useCallback(() => {
    const latest = tasks.current[tasks.current.length - 1]?.busy ?? null;
    busyRef.current = latest;
    setBusy(latest);
  }, []);
  /** Runs `task`, which may `report` its progress. `read` is the log read it is, if it is one. */
  const run = useCallback(
    async (label: string, task: (report: (progress: Busy) => void) => Promise<void>, read?: LogRead) => {
      const mine: Task = { busy: { label, fraction: null, readingLog: read?.name }, read };
      tasks.current.push(mine);
      showLatestTask();
      // A reopen follows a read that failed or was cancelled, whose error stays.
      if (!read?.reopens) setError(null);
      const report = (progress: Busy) => {
        if (read?.stopped) return;
        mine.busy = { ...progress, readingLog: read?.name };
        showLatestTask();
      };
      try {
        await task(report);
        return true;
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return false;
      } finally {
        tasks.current = tasks.current.filter((t) => t !== mine);
        showLatestTask();
      }
    },
    [showLatestTask],
  );

  // The Export Log button is disabled while the export runs, so focus fell to the page (or was
  // left in the closed sheet); give it back once the button is enabled again, unless the user
  // has moved on.
  useEffect(() => {
    if (!exportEnded || busy) return;
    setExportEnded(false);
    const focused = document.activeElement;
    const lost = !focused || focused === document.body || focused.closest('dialog:not([open])') !== null;
    if (lost || focused === exportButton.current) exportButton.current?.focus();
  }, [exportEnded, busy]);

  // Cancel goes away when the read ends or is cancelled, and focus would fall to the page. It goes
  // to the Cancel of the log then reopened, if any, or else to Open Log... once that is enabled.
  useEffect(() => {
    if (!focusAfterCancel || (busy && busy.readingLog === undefined) || stopping) return;
    setFocusAfterCancel(false);
    const focused = document.activeElement;
    if (!focused || focused === document.body) (cancelElement.current ?? openLogButton.current)?.focus();
  }, [focusAfterCancel, busy, stopping]);

  const setView = useCallback((next: ViewId) => {
    setViewState(next);
    setQuery('');
    setInspectorHidden(false);
  }, []);

  const decodePlot = useCallback(
    async (key: number, signal: string, color: string, hit: Resolved): Promise<PlotSpec | null> => {
      const def = hit.message.signals.find((s) => s.name === signal);
      if (!def) return null;
      const id = `${key}:${signal}`;
      const info = await core.decodeSignal(key, signal);
      plotSignals.current.set(id, def);
      return { id, label: `${hit.message.name}.${signal}`, info, color };
    },
    [core],
  );

  /** Runs `task` after every earlier log or DBC change, so the core and the UI see them in order. */
  const serially = useCallback(<T,>(task: () => Promise<T>): Promise<T> => {
    const next = changeQueue.current.then(task);
    changeQueue.current = next.catch(() => undefined);
    return next;
  }, []);

  /**
   * Send `next` to the core, then refresh names and decode again any plot whose signal changed.
   * `persist` is false when `next` came from the store: writing it back would only make every
   * other open tab stale.
   */
  const applyDbcs = useCallback(
    async (next: LoadedDbc[], persist = true) => {
      const changed = coreSees(dbcsRef.current, next);
      if (changed) await core.setDatabases(next.map((d) => ({ channel: d.channel, db: d.db })));
      dbcsRef.current = next;
      if (persist) {
        void saveDbcs(next).then((result) => {
          setDbcsNotKept(result === 'failed');
          if (result === 'conflict') setDbcsChangedElsewhere(true);
        });
      }
      // Only edited or exportedAt changed: the core's summaries and the plots stand.
      if (!changed) {
        setDbcs(next);
        return;
      }
      const nextIds = await core.idSummary();
      // Set together: summaries name their DBC by its index in this list.
      setDbcs(next);
      setIds(nextIds);
      const replaced = new Map<string, PlotSpec | null>();
      for (const p of plotsRef.current) {
        const [key, signal] = splitPlotId(p.id);
        const summary = nextIds.find((s) => s.key === key);
        const hit = summary ? resolve(next, summary) : null;
        const def = hit?.message.signals.find((s) => s.name === signal);
        if (hit && def && plotSignals.current.get(p.id) === def) {
          replaced.set(p.id, { ...p, label: `${hit.message.name}.${signal}` });
          continue;
        }
        core.dropSeries(p.info.handle);
        replaced.set(p.id, hit ? await decodePlot(key, signal, p.color, hit) : null);
      }
      // By id, so plots added or removed while this ran stay that way.
      setPlots((current) => current.flatMap((p) => (replaced.has(p.id) ? (replaced.get(p.id) ?? []) : [p])));
      const shown = new Set(plotsRef.current.map((p) => p.id));
      for (const [id, plot] of replaced) if (plot && !shown.has(id)) core.dropSeries(plot.info.handle);
    },
    [core, decodePlot],
  );

  const mutateDbcs = useCallback(
    (change: (prev: LoadedDbc[]) => LoadedDbc[], persist = true) => serially(() => applyDbcs(change(dbcsRef.current), persist)),
    [serially, applyDbcs],
  );

  /** Deletes the stored copy of this tab's unsaved capture, as it was saved or replaced in the core. */
  const forgetKeptCapture = useCallback(() => {
    const held = keptRef.current;
    keptRef.current = null;
    return held?.forget();
  }, []);

  /** Lets go of this tab's unsaved capture, leaving its stored copy for a reload. Returns whether there is one. */
  const letGoOfKeptCapture = useCallback(() => {
    const held = keptRef.current;
    keptRef.current = null;
    const kept = held?.kept ?? false;
    void held?.letGo();
    return kept;
  }, []);

  /** Show no log. The core has already dropped it, with every decoded series. */
  const showNoLog = useCallback(() => {
    plotSignals.current.clear();
    setLog(null);
    setIds([]);
    setDbcs(dbcsRef.current);
    setPlots([]);
    setSelected(ALL_IDS);
    setPinnedTime(null);
    setNotKept(null);
    setUnsavedCapture(false);
    setCaptureNotice(null);
    setCaptureNotKept(null);
    void forgetKeptCapture();
    // A discard prompt left open would name no capture.
    setDiscardThen(null);
    setLogVersion((v) => v + 1);
    viewState.clearScope('log');
    videoSession.close();
  }, [viewState, forgetKeptCapture]);

  const restoreUi = useCallback(
    async (ui: SavedUi, nextIds: IdSummary[]) => {
      setViewState(ui.view);
      setSelected(nextIds.some((s) => s.key === ui.selected) ? ui.selected : ALL_IDS);
      const restored: PlotSpec[] = [];
      for (const p of ui.plots) {
        const summary = nextIds.find((s) => s.key === p.key);
        const hit = summary ? resolve(dbcsRef.current, summary) : null;
        const plot = hit ? await decodePlot(p.key, p.signal, p.color, hit).catch(() => null) : null;
        if (plot) restored.push(plot);
      }
      setPlots(restored);
      if (restored.length > 0) setPinnedTime(ui.pinnedTime);
    },
    [decodePlot],
  );

  /** Show `info`, with its summaries `nextIds`, as the open log, which the core has just read or swapped in. */
  const showOpenedLog = useCallback((info: LogInfo, nextIds: IdSummary[]) => {
    // The new log's series replaced the old ones in the core.
    plotSignals.current.clear();
    setPlots([]);
    setSelected(ALL_IDS);
    setNotKept(null);
    setUnsavedCapture(false);
    setCaptureNotice(null);
    setCaptureNotKept(null);
    setLog(info);
    setLogVersion((v) => v + 1);
    setDbcs(dbcsRef.current);
    setIds(nextIds);
  }, []);

  /** The log read under way, until it ends or is stopped. */
  const reading = useRef<LogRead | null>(null);

  /**
   * Stops the log read under way, if any, as soon as the core can rather than after it ends. The
   * core has no cancel: a newer `openLog` supersedes the read, and an empty one leaves no log.
   */
  const stopReading = useCallback(() => {
    const read = reading.current;
    if (!read) return;
    read.stopped = true;
    reading.current = null;
    // Past its last chunk the core finishes a read before it takes the empty log, so it may stay a while.
    const task = tasks.current.find((t) => t.read === read);
    if (task) task.busy = { label: 'Stopping the read\u2026', fraction: null };
    showLatestTask();
    core.openLog(new Blob([]), '', () => {}).catch(() => undefined);
  }, [core, showLatestTask]);

  /** The saved copy of `shown`, the log the UI shows, to reopen it after the read that replaced it in the core. */
  const savedCopyOf = async (shown: LogInfo | null) => {
    const saved = shown ? await loadSaved<SavedLog>('log') : undefined;
    return isSavedCopyOf(saved, shown) ? saved : undefined;
  };

  /** Reads `file` as the open log. */
  const openLog = useCallback<OpenLog>(
    (file, name, { restore, reopening = false, stay = false } = {}) => {
      stopReading();
      const read: LogRead = { name, stopped: false, reopens: !!restore };
      reading.current = read;
      // The core drops a capture as soon as it gets this read, so there is none left to save.
      unsavedRef.current = false;
      setUnsavedCapture(false);
      void forgetKeptCapture();
      // A video added while a log loads would belong to the log being replaced.
      /** The log shown before, to reopen if this read fails. */
      let previous: SavedLog | undefined;
      return videoSession.whileLoadingLog(async () => {
        const opened = await run(
          `${reopening ? 'Reopening' : 'Reading'} ${name}\u2026`,
          (report) =>
            serially(async () => {
              // Whatever stopped this read shows its own outcome, so nothing here touches the UI.
              if (read.stopped) return;
              setSkippedDismissed(false);
              let info: LogInfo;
              try {
                info = await core.openLog(file, name, (p) =>
                  report({ label: `Parsing ${name}\u2026 ${Math.round((100 * p.bytes) / p.total)}%`, fraction: p.bytes / p.total }),
                );
                if (read.stopped) return;
                const noFrames = noFramesMessage(info);
                if (noFrames) throw new Error(noFrames);
              } catch (e) {
                // Most likely the AbortError of the read the core was told to stop.
                if (read.stopped) return;
                // The core let the log shown go when this read began. It is reopened, as Cancel
                // does, unless this read was a reopen, which a bad saved copy would repeat.
                const saved = read.reopens ? undefined : await savedCopyOf(logRef.current);
                // The lookup can wait behind a save, long enough for this read to be stopped.
                if (read.stopped) return;
                previous = saved;
                if (!previous) {
                  showNoLog();
                  // No log is open now, so none must come back after a reload.
                  void forget('log');
                  void forget('compare');
                }
                throw e;
              }
              const nextIds = await core.idSummary();
              if (read.stopped) return;
              showOpenedLog(info, nextIds);
              if (restore) {
                await restoreUi(restore, nextIds);
                return;
              }
              viewState.clearScope('log');
              videoSession.close();
              if (!stay) setView('overview');
              // The core dropped the comparison log with the old log.
              void forget('compare');
              if (read.stopped) return;
              // Kept so a reload reopens it. A copy this browser can't store just isn't restored.
              void save('log', { name, blob: file } satisfies SavedLog).then((kept) => {
                if (!kept) {
                  setNotKept(name);
                  void forget('log');
                }
              });
            }),
          read,
        );
        if (reading.current === read) reading.current = null;
        if (read.stopped) return 'stopped';
        if (previous) await openLog(previous.blob, previous.name, { restore: currentUi.current(), reopening: true });
        return opened ? 'opened' : 'failed';
      });
    },
    [core, run, serially, stopReading, showNoLog, showOpenedLog, setView, restoreUi, viewState, forgetKeptCapture],
  );

  /**
   * Reopens an unsaved capture kept as it ran, after a reload or a crash, as a stopped capture
   * still to be saved. Resolves whether it did. Only a damaged copy is deleted, since it exists
   * nowhere else; one that failed `MAX_CAPTURE_RESTORES` times is restored only when `asked`.
   */
  const restoreKeptCapture = useCallback(
    async (capture: KeptCapture, held: HeldCapture, ui: SavedUi, asked = false) => {
      // A restore cut short by a reload or a close doesn't count; one cut short by a crash does.
      const left = takeRestoreLeft(capture.id);
      const failed = Math.max(0, (capture.failedRestores ?? 0) - (left ? 1 : 0));
      if (failed >= MAX_CAPTURE_RESTORES && !asked) {
        setStuckCapture({ capture: { ...capture, failedRestores: failed }, held });
        return false;
      }
      let restored = false;
      const noteLeaving = () => markRestoreLeft(capture.id);
      // A frozen page that comes back is restoring again, and a crash then counts.
      const noteBack = () => takeRestoreLeft(capture.id);
      await run(`Restoring ${capture.name}\u2026`, (report) =>
        serially(async () => {
          const tries = failed + 1;
          let info: LogInfo;
          window.addEventListener('pagehide', noteLeaving);
          // Chrome may discard a frozen background tab without a pagehide.
          document.addEventListener('freeze', noteLeaving);
          document.addEventListener('resume', noteBack);
          try {
            // Counted first, so a restore that takes the page down counts too.
            await writeKeptCapture({ ...capture, failedRestores: tries, lastRestoreError: undefined }).catch(() => undefined);
            await core.startCapture(capture.name, capture.bus, capture.startedAtMs);
            let read = 0;
            await readCaptureChunks(capture.id, async (chunk) => {
              let frames: CaptureFrame[];
              try {
                frames = unpackFrames(chunk);
              } catch (e) {
                throw new DamagedCapture(errorText(e));
              }
              await core.appendFrames(frames);
              read += chunk.length;
              report({ label: `Restoring ${capture.name}\u2026 ${Math.round((100 * read) / capture.bytes)}%`, fraction: read / capture.bytes });
            });
            // The chunks hold some of the frames a rolling capture had already dropped.
            if (capture.trimmedBeforeNs !== undefined) await core.trimCapture(capture.trimmedBeforeNs);
            info = await core.endCapture();
            if (info.frames === 0) throw new DamagedCapture('none of its frames were found');
            // Before the listeners go, so a page that goes away now still counts as having left.
            await writeKeptCapture({ ...capture, failedRestores: 0, lastRestoreError: undefined }).catch(() => undefined);
          } catch (e) {
            // As Close does, so the core holds no half-restored capture.
            await core.openLog(new Blob([]), '', () => {}).catch(() => undefined);
            showNoLog();
            const why = errorText(e);
            if (e instanceof DamagedCapture) {
              await held.forget();
              throw new Error(`The unsaved capture ${capture.name} couldn't be restored, so it was deleted: ${why}`);
            }
            const failing = { ...capture, failedRestores: tries, lastRestoreError: why };
            void writeKeptCapture(failing).catch(() => undefined);
            if (tries >= MAX_CAPTURE_RESTORES) {
              setStuckCapture({ capture: failing, held });
              return;
            }
            await held.letGo();
            throw new Error(`The unsaved capture ${capture.name} couldn't be restored: ${sentence(why)} Reload the page to try again.`);
          } finally {
            window.removeEventListener('pagehide', noteLeaving);
            document.removeEventListener('freeze', noteLeaving);
            document.removeEventListener('resume', noteBack);
            // A frozen page that came back finished the restore after all.
            takeRestoreLeft(capture.id);
          }
          restored = true;
          const nextIds = await core.idSummary();
          showOpenedLog(info, nextIds);
          keptRef.current = held;
          unsavedRef.current = true;
          setUnsavedCapture(true);
          const bitrates = (viewState.get(BUS_BITRATES_KEY)?.value ?? {}) as BusBitrates;
          if (!(capture.bus in bitrates)) viewState.set(BUS_BITRATES_KEY, { ...bitrates, [capture.bus]: capture.bitrate }, 'log');
          // As for a saved log, the saved copies stay: log B, if any, was opened beside this capture.
          await restoreUi(ui, nextIds);
        }),
      );
      return restored;
    },
    [core, run, serially, showNoLog, showOpenedLog, restoreUi, viewState],
  );

  const swapCompareLog = useCallback(
    () =>
      run('Swapping the logs\u2026', () =>
        serially(async () => {
          const outgoing = logRef.current;
          const info = await core.swapCompareLog();
          showOpenedLog(info, await core.idSummary());
          viewState.clearScope('log');
          // A video lines up with the log it was added to.
          videoSession.close();
          // The saved copies trade places too, so a reload reopens each log where it now is. A
          // copy that never landed, or failed to, leaves an older log under its key, which must
          // not come back as the other log. Loggers reuse file names, so the size must match too.
          const [savedA, savedB] = await Promise.all([loadSaved<SavedLog>('log'), loadSaved<SavedLog>('compare')]);
          const isCopyOf = (saved: SavedLog | undefined, log: LogInfo | null) => !!saved && !!log && saved.name === log.name && saved.blob.size === log.bytes;
          const a = isCopyOf(savedA, outgoing) ? savedA : undefined;
          const b = isCopyOf(savedB, info) ? savedB : undefined;
          if (!b || !(await save('log', b))) {
            setNotKept(info.name);
            await forget('log');
          }
          if (!a || !(await save('compare', a))) await forget('compare');
        }),
      ),
    [core, run, serially, showOpenedLog, viewState],
  );

  const openDbc = useCallback(
    (file: Blob, name: string) =>
      run(`Loading ${name}\u2026`, async () => {
        const db = await core.parseDbc(file, name);
        // Opening a file that's already loaded reloads it in place, keeping its bus and order,
        // unless that copy has unexported edits: then both are kept.
        await mutateDbcs((prev) => {
          const loaded = prev.find((d) => d.db.name === name);
          if (loaded && !loaded.edited) return prev.map((d) => (d === loaded ? { ...d, db } : d));
          const added = loaded ? { ...db, name: uniqueName(prev, name) } : db;
          return [...prev, { id: crypto.randomUUID(), db: added, channel: null, edited: false }];
        });
      }),
    [core, run, mutateDbcs],
  );

  const openFiles = useCallback(
    async (files: FileList | File[]) => {
      const list = [...files];
      const dbcFiles = list.filter((f) => f.name.toLowerCase().endsWith('.dbc'));
      const videoFiles = list.filter(isVideoFile);
      const logFile = list.find((f) => !dbcFiles.includes(f) && !videoFiles.includes(f));
      // The log replaces one being read, whose read the core would otherwise finish before the DBCs.
      if (logFile) stopReading();
      for (const f of dbcFiles) await openDbc(f, f.name);
      const logOpened = logFile ? (await openLog(logFile, logFile.name)) === 'opened' : false;
      // DBCs on their own are opened for editing.
      if (!logFile && dbcFiles.length > 0 && !logRef.current) setView('database');
      const [videoFile] = videoFiles;
      if (videoFile) {
        // logRef only catches up with a log opened just now on the next render.
        const log = logFile ? (logOpened ? { name: logFile.name, bytes: logFile.size } : null) : logRef.current;
        if (log) {
          videoSession.open(videoFile, log);
          setView('plot');
          if (videoFiles.length > 1) setError(`One video plays at a time, so only ${videoFile.name} was opened.`);
        } else if (!logFile) {
          setError('Open a log first, then add the video to line it up with it.');
        }
      }
    },
    [openDbc, openLog, stopReading, setView],
  );

  /** Shows no log once the core has none, and forgets the copies a reload would reopen. */
  const showClosedLog = async () => {
    showNoLog();
    await Promise.all([forget('log'), forget('compare')]);
    if (dbcsRef.current.length > 0) setView('database');
  };

  const closeLog = () =>
    run('Closing the log\u2026', () =>
      serially(async () => {
        // The core has no close; an empty log releases the old one's memory.
        await core.openLog(new Blob([]), '', () => {});
        await showClosedLog();
      }),
    );

  /**
   * Stops the log being read. The core let the log shown until then go when the read began, so
   * that log is read again from its saved copy, as after a reload, or no log is left open.
   */
  const cancelReading = () => {
    const read = reading.current;
    // The read has just ended, and the next render shows how.
    if (!read) return;
    const shown = read.reopens ? null : logRef.current;
    const ui = currentUi.current();
    setFocusAfterCancel(true);
    stopReading();
    void (async () => {
      let previous: SavedLog | undefined;
      await run('Cancelling\u2026', () =>
        serially(async () => {
          // As Close does: whatever the stopped read reached, the core then holds no log.
          await core.openLog(new Blob([]), '', () => {});
          previous = await savedCopyOf(shown);
          if (!previous) await showClosedLog();
        }),
      );
      if (previous) await openLog(previous.blob, previous.name, { restore: ui, reopening: true });
    })();
  };

  /** Decode every plotted signal again, as a live capture adds frames. Run it inside `serially`. */
  const redecodePlots = useCallback(async () => {
    for (const plot of plotsRef.current) {
      const [key, signal] = splitPlotId(plot.id);
      const info = await core.decodeSignal(key, signal).catch(() => null);
      if (!info) continue;
      const unchanged = (p: PlotSpec) => p.id === plot.id && p.info.handle === plot.info.handle;
      // Removed or decoded again while this ran: the new series isn't wanted.
      if (!plotsRef.current.some(unchanged)) {
        void core.dropSeries(info.handle);
        continue;
      }
      void core.dropSeries(plot.info.handle);
      plotsRef.current = plotsRef.current.map((p) => (unchanged(p) ? { ...p, info } : p));
      setPlots((current) => current.map((p) => (unchanged(p) ? { ...p, info } : p)));
    }
  }, [core]);

  /** Stop the live capture. `endedBecause` says why, when it ended without being asked to. */
  const stopCapture = useCallback(
    async (endedBecause?: string) => {
      const capture = liveRef.current;
      if (!capture) return;
      liveRef.current = null;
      stoppingRef.current = true;
      setStopping(true);
      try {
        await serially(async () => {
          let info: LogInfo;
          try {
            info = await capture.recorder.stop();
          } finally {
            setLive(null);
            setLiveStatus(null);
          }
          const status = capture.recorder.status();
          if (info.frames === 0) {
            showNoLog();
            setError(endedBecause ?? 'No frames came from the adapter. Check the bitrate, and that the adapter is connected to a running bus.');
            return;
          }
          const nextIds = await core.idSummary();
          setLog(info);
          setIds(nextIds);
          await redecodePlots();
          if (endedBecause) setError(`${endedBecause} The frames captured until then are kept.`);
          // The notices while recording, such as the size warning, are done with.
          setCaptureNotice(status.problems > 0 ? `${formatCountOf(status.problems, 'problem', 'problems')} during the capture. The last: ${status.lastProblem}` : null);
        });
      } catch (e) {
        const kept = letGoOfKeptCapture();
        showNoLog();
        const failed = `The capture couldn't be finished: ${errorText(e)}`;
        setError(kept ? `${sentence(failed)} Reload the page to get the capture back.` : failed);
      } finally {
        stoppingRef.current = false;
        setStopping(false);
      }
    },
    [core, serially, showNoLog, redecodePlots, letGoOfKeptCapture],
  );

  /** Start capturing from `adapter`. Rejects, leaving the open log as it was, if it can't start. */
  const startCapture = useCallback(
    (adapter: CaptureAdapter, settings: CaptureSettings) =>
      serially(async () => {
        // Loaded with the Capture sheet rather than with the app.
        const [{ CaptureRecorder, captureName }, { CaptureKeeper, notKeptDetail }] = await Promise.all([import('./capture/recorder'), import('./capture/keeper')]);
        const recorder = new CaptureRecorder(core, adapter, captureName(new Date()));
        const keeper = new CaptureKeeper();
        // The capture shown is kept until this one replaces it in the core.
        const previous = keptRef.current;
        keeper.replaces = previous;
        keeper.onNotKept = (reason) => {
          if (keptRef.current !== keeper) return;
          setCaptureNotKept({ name: recorder.name, detail: notKeptDetail(reason) });
          if (liveRef.current?.recorder === recorder) setLiveAnnouncement(`This browser couldn't keep a copy of ${recorder.name}, so it won't reopen after a reload.`);
        };
        recorder.keeper = keeper;
        keptRef.current = keeper;
        setCaptureNotKept(null);
        // Set before the start, so an adapter that goes away while starting still ends the capture.
        const endedWhileStarting: { message?: string } = {};
        recorder.onEnd = (message) => {
          if (liveRef.current?.recorder === recorder) void stopCapture(message);
          else endedWhileStarting.message = message;
        };
        let started: { info: LogInfo; listenOnly: boolean };
        try {
          started = await recorder.start(settings);
        } catch (e) {
          keptRef.current = previous;
          throw e;
        }
        const { info, listenOnly } = started;
        const capture: LiveCapture = { recorder };
        liveRef.current = capture;
        // The capture replaced the log and its series in the core, as opening a log does.
        videoSession.close();
        plotSignals.current.clear();
        setPlots([]);
        setSelected(ALL_IDS);
        setPinnedTime(null);
        setNotKept(null);
        setSkippedDismissed(false);
        setError(null);
        setCaptureNotice(settings.listenOnly && !listenOnly ? recorder.text.listenOnlyUnconfirmed : null);
        setLiveAnnouncement(recorder.text.started());
        setLog(info);
        setLogVersion((v) => v + 1);
        setDbcs(dbcsRef.current);
        setIds([]);
        setLive(capture);
        setLiveStatus(recorder.status());
        setUnsavedCapture(true);
        viewState.clearScope('log');
        viewState.set(BUS_BITRATES_KEY, { [recorder.bus]: settings.bitrate }, 'log');
        setView('trace');
        // A reload brings back the capture, not the log it replaced. The core dropped log B with the old log.
        void forget('log');
        void forget('compare');
        if (endedWhileStarting.message) void stopCapture(endedWhileStarting.message);
      }),
    [core, serially, stopCapture, viewState, setView],
  );

  /** The capture is in a file now, so the copy kept for a reload goes. */
  const markCaptureSaved = () => {
    setUnsavedCapture(false);
    setCaptureNotKept(null);
    void forgetKeptCapture();
  };

  /** Keeps a saved capture like an opened log, so a reload reopens it. */
  const keepSavedCapture = async (name: string, blob: Blob) => {
    markCaptureSaved();
    if (!(await save('log', { name, blob } satisfies SavedLog))) {
      setNotKept(name);
      void forget('log');
    }
  };

  /** Saves the capture as candump, then runs `then`, as when the discard prompt offers saving. */
  const saveCapture = (then?: () => void) => {
    if (!log) return;
    const name = log.name;
    const label = 'Saving the capture\u2026';
    // The save dialog must open straight from the click, as Export Log's does.
    void chooseBlobFile(name, CANDUMP_FILE).then(
      async (write) => {
        if (!write) return;
        const saved = await run(label, async () => {
          // Queued, so it comes after the last frames and the end of a capture still stopping.
          const blob = await serially(() => core.exportLog('candump'));
          await write(blob);
          await keepSavedCapture(name, blob);
        });
        if (saved) then?.();
      },
      (error: unknown) => run(label, () => Promise.reject(error)),
    );
  };

  /** Runs `action`, first asking to discard the open capture if it was never saved. */
  const unlessUnsavedCapture = (action: () => void) => {
    if (unsavedRef.current) setDiscardThen(() => action);
    else action();
  };

  /** Try Again on a capture that failed to restore: restores it in place of the open log, or else reopens that log's saved copy. */
  const retryStuckCapture = () => {
    const stuck = stuckCapture;
    if (!stuck) return;
    unlessUnsavedCapture(() => {
      setStuckCapture(null);
      stopReading();
      // The core drops the open log, and any capture, for this one.
      unsavedRef.current = false;
      void forgetKeptCapture();
      const ui = currentUi.current();
      void (async () => {
        if (await restoreKeptCapture(stuck.capture, stuck.held, ui, true)) return;
        const saved = await loadSaved<SavedLog>('log');
        if (saved) await openLog(saved.blob, saved.name, { restore: ui });
      })();
    });
  };

  const loadDemo = () => {
    // The demo replaces a log being read, whose read the core would otherwise finish first.
    stopReading();
    return run('Downloading the demo\u2026', async () => {
      const [logGz, dbcBlob] = await Promise.all(
        ['demo/demo.log.gz', 'demo/demo.dbc'].map(async (path) => {
          const res = await fetch(path);
          if (!res.ok) throw new Error(`The demo file ${path} is missing. Run \`npm run demo\` in web/ to generate it.`);
          return res.blob();
        }),
      );
      await openDbc(dbcBlob, 'demo.dbc');
      await openLog(await gunzip(logGz), 'demo.log');
    });
  };

  // The landing page's Try the Demo links to `?demo=1`.
  const demoRequested = useRef(new URLSearchParams(window.location.search).has('demo'));

  // Reopen the last session. Guarded because StrictMode runs effects twice in development.
  const restoreStarted = useRef(false);
  useEffect(() => {
    if (restoreStarted.current) return;
    restoreStarted.current = true;
    void (async () => {
      const [savedLog, savedDbcs, savedUi, savedViews, keptCapture] = await Promise.all([
        loadSaved<SavedLog>('log'),
        loadSavedDbcs<LoadedDbc[]>(),
        loadSaved<SavedUi>('ui'),
        loadSaved<ReturnType<ViewStateStore['snapshot']>>('views'),
        claimKeptCapture(),
      ]);
      if (savedViews) viewState.restore(savedViews);
      if (savedDbcs?.length) await run('Restoring your DBCs\u2026', () => mutateDbcs(() => withJ1939Flags(savedDbcs), false));
      const ui = savedUi ?? { view: 'overview', selected: ALL_IDS, pinnedTime: null, plots: [] };
      // An unsaved capture exists nowhere else, so it comes back in place of a saved log, whose file the user has.
      const restoredCapture = keptCapture !== undefined && (await restoreKeptCapture(keptCapture.capture, keptCapture.held, ui));
      if (!restoredCapture) {
        if (savedLog && (!demoRequested.current || savedLog.name === 'demo.log')) {
          // A saved log other than the demo would only be replaced by it, so it isn't parsed first.
          // A copy that can't be read is forgotten, as is any log that fails to open.
          await openLog(savedLog.blob, savedLog.name, { restore: ui });
        } else if (savedUi && savedDbcs?.length && !viewMeta(savedUi.view).needsLog) {
          setViewState(savedUi.view);
        }
      }
      setRestoring(false);
    })();
  }, [viewState, run, mutateDbcs, openLog, restoreKeptCapture]);

  useEffect(() => {
    if (restoring || !demoRequested.current) return;
    demoRequested.current = false;
    const url = new URL(window.location.href);
    url.searchParams.delete('demo');
    window.history.replaceState(null, '', url);
    // A restored unsaved capture is asked about first.
    if (logRef.current?.name !== 'demo.log') unlessUnsavedCapture(loadDemo);
    // loadDemo is recreated each render; this runs once, when the restore is done.
  }, [restoring]);

  useEffect(() => {
    if (restoring) return;
    const timer = setTimeout(() => void save('ui', uiSnapshot(view, selected, pinnedTime, plots)), 250);
    return () => clearTimeout(timer);
  }, [restoring, view, selected, pinnedTime, plots]);

  useEffect(() => {
    let timer = 0;
    viewState.onChange = () => {
      clearTimeout(timer);
      timer = window.setTimeout(() => void save('views', viewState.snapshot()), 300);
    };
    return () => {
      viewState.onChange = null;
      clearTimeout(timer);
    };
  }, [viewState]);

  useEffect(() => onDbcsChangedElsewhere(() => setDbcsChangedElsewhere(true)), []);

  // The restarted core has the databases back but no log; the user opens it again.
  useEffect(
    () =>
      core.onReset?.(() => {
        const capture = liveRef.current;
        liveRef.current = null;
        if (capture) {
          void capture.recorder.stop().catch(() => undefined);
          setLive(null);
          setLiveStatus(null);
        }
        // Left stored, not forgotten, so a reload brings the capture back.
        const kept = letGoOfKeptCapture();
        showNoLog();
        setError(
          kept
            ? 'The CAN core stopped and was restarted. Reload the page to get the capture back.'
            : capture || unsavedRef.current
              ? 'The CAN core stopped and was restarted, so the capture was lost.'
              : 'The CAN core stopped and was restarted. Open the log again.',
        );
      }),
    [core, showNoLog, letGoOfKeptCapture],
  );

  // While capturing, the views get the new frames and the status line its numbers.
  useEffect(() => {
    if (!live) return;
    let refreshes = 0;
    let refreshing = false;
    let lastRefresh = performance.now();
    let toldOfProblem = false;
    let warnedOfSize = false;
    const refresh = () => {
      const status = live.recorder.status();
      setLiveStatus(status);
      if (status.problems > 0 && !toldOfProblem) {
        toldOfProblem = true;
        setLiveAnnouncement(live.recorder.text.problem(status));
      }
      if (status.nearLimit && !warnedOfSize) {
        warnedOfSize = true;
        const warning = live.recorder.text.sizeWarning();
        setCaptureNotice(warning);
        setLiveAnnouncement(warning);
      }
      const now = performance.now();
      if (refreshing || now - lastRefresh < LIVE_REFRESH_MS + status.frames / FRAMES_PER_EXTRA_REFRESH_MS) return;
      lastRefresh = now;
      refreshing = true;
      const decodePlotsToo = ++refreshes % LIVE_PLOT_REFRESHES === 0;
      serially(async () => {
        const latest = live.recorder.info;
        if (liveRef.current !== live || (latest?.frames === logRef.current?.frames && latest?.droppedFrames === logRef.current?.droppedFrames)) return;
        const nextIds = await core.idSummary();
        const info = live.recorder.info;
        if (liveRef.current !== live || !info) return;
        setLog(info);
        setIds(nextIds);
        if (decodePlotsToo) await redecodePlots();
      })
        .catch(() => undefined)
        .finally(() => {
          refreshing = false;
        });
    };
    const timer = setInterval(refresh, LIVE_REFRESH_MS);
    return () => clearInterval(timer);
  }, [live, core, serially, redecodePlots]);

  // A device left open would go on sending to a port nobody reads, or acknowledging frames.
  useEffect(() => {
    if (!live) return;
    const release = () => live.recorder.release();
    // Written while the browser asks whether to leave, as Chrome drops a write begun as the page goes.
    const keep = () => void live.recorder.keeper?.flush();
    window.addEventListener('pagehide', release);
    window.addEventListener('beforeunload', keep);
    return () => {
      window.removeEventListener('pagehide', release);
      window.removeEventListener('beforeunload', keep);
    };
  }, [live]);

  // Leaving the page would end the capture, and an unsaved one comes back only if storage kept it.
  useEffect(() => {
    if (!live && !unsavedCapture) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [live, unsavedCapture]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setPinnedTime(null);
      if (narrow()) {
        setSidebarOpen(false);
        setInspectorOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Covers Clear, removing the last plot and opening a new log, which all empty the plots.
  useEffect(() => {
    if (plots.length === 0 && !restoring) setPinnedTime(null);
  }, [plots.length, restoring]);

  useEffect(() => {
    const over = (e: DragEvent) => {
      e.preventDefault();
      setDragOver(true);
    };
    const leave = (e: DragEvent) => {
      if (!e.relatedTarget) setDragOver(false);
    };
    const drop = (e: DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      if (!e.dataTransfer?.files.length) return;
      const files = [...e.dataTransfer.files];
      const isDbc = (f: File) => f.name.toLowerCase().endsWith('.dbc');
      // A video goes with the open log, so only a log replaces the capture, or a log being read.
      const opensLog = files.some((f) => !isDbc(f) && !isVideoFile(f));
      if (busyRef.current && !(busyRef.current.readingLog !== undefined && opensLog)) {
        setError(`Wait for "${busyRef.current.label}" to finish, then drop the files again.`);
        return;
      }
      if (liveRef.current && files.some((f) => !isDbc(f))) {
        setError('Stop the capture before opening a log or a video.');
        return;
      }
      if (stoppingRef.current && files.some((f) => !isDbc(f))) {
        setError('Wait for the capture to stop, then drop the files again.');
        return;
      }
      if (opensLog) unlessUnsavedCapture(() => openFiles(files));
      else openFiles(files);
    };
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  }, [openFiles]);

  // A signal keeps one colour everywhere: its plot's colour, or its slot within its message.
  const signalColor = (key: number, signal: string) =>
    plots.find((p) => p.id === `${key}:${signal}`)?.color ??
    seriesColor(Math.max(0, messageOf(key)?.signals.findIndex((s) => s.name === signal) ?? 0));

  const removePlot = (id: string) => {
    const gone = plots.find((p) => p.id === id);
    if (gone) core.dropSeries(gone.info.handle);
    plotSignals.current.delete(id);
    setPlots((ps) => ps.filter((p) => p.id !== id));
  };

  const clearPlots = () => {
    plots.forEach((p) => core.dropSeries(p.info.handle));
    plotSignals.current.clear();
    setPlots([]);
  };

  const togglePlot = async (key: number, signal: string) => {
    const hit = resolved.get(key);
    if (!hit) return;
    const id = `${key}:${signal}`;
    if (plots.some((p) => p.id === id)) {
      removePlot(id);
      return;
    }
    const used = new Set(plots.map((p) => p.color));
    const preferred = seriesColor(hit.message.signals.findIndex((s) => s.name === signal));
    const color = !used.has(preferred)
      ? preferred
      : Array.from({ length: SERIES_SLOTS }, (_, i) => seriesColor(i)).find((c) => !used.has(c));
    if (!color) {
      setError(`Up to ${SERIES_SLOTS} signals can be plotted at once. Remove one to add another.`);
      return;
    }
    await run(`Decoding ${signal}\u2026`, async () => {
      const plot = await decodePlot(key, signal, color, hit);
      if (plot) setPlots((ps) => [...ps, plot]);
    });
  };

  const addDbc = async (db: Database, channel: string | null = null) => {
    const id = crypto.randomUUID();
    await mutateDbcs((prev) => [...prev, { id, db: { ...db, name: uniqueName(prev, db.name) }, channel, edited: true }]);
    return id;
  };

  const updateDbc: ViewContext['updateDbc'] = (id, update) =>
    mutateDbcs((prev) =>
      prev.map((d) => {
        if (d.id !== id) return d;
        const change = typeof update === 'function' ? update(d) : update;
        return { ...d, ...change, edited: change.edited ?? (change.db ? true : d.edited) };
      }),
    );

  const removeDbc = (id: string) => mutateDbcs((prev) => prev.filter((d) => d.id !== id));

  const moveDbc = (id: string, delta: -1 | 1) =>
    mutateDbcs((prev) => {
      const at = prev.findIndex((d) => d.id === id);
      const to = at + delta;
      if (at < 0 || to < 0 || to >= prev.length) return prev;
      const next = [...prev];
      [next[at], next[to]] = [next[to], next[at]];
      return next;
    });

  const select = (key: number) => {
    setSelected(key);
    // On narrow windows the sidebar floats over the content; get it out of the way.
    if (narrow()) setSidebarOpen(false);
  };

  /** The Live Capture sheet around `content`, while the sheet itself loads or if it can't. */
  const captureFrame = (content: ReactNode) => (
    <Sheet open={captureOpen} onClose={() => setCaptureOpen(false)} title="Live Capture">
      {content}
    </Sheet>
  );

  const ctx: ViewContext = {
    core,
    log,
    logVersion,
    capturing: live !== null,
    ids,
    dbcs,
    messageOf,
    dbcOf,
    addDbc,
    updateDbc,
    removeDbc,
    moveDbc,
    selected,
    select,
    query,
    plots,
    togglePlot,
    removePlot,
    clearPlots,
    signalColor,
    pinnedTime,
    setPinnedTime,
    run,
    busyLabel: () => busyRef.current?.label ?? (stoppingRef.current ? 'Stopping the capture\u2026' : null),
    setError,
    setView,
    openLog: (file, name) => {
      if (stoppingRef.current) {
        setError('Wait for the capture to stop, then open the log again.');
        return Promise.resolve(false);
      }
      // Left unsettled if the discard prompt is cancelled, so the caller goes no further.
      return new Promise((resolve) => unlessUnsavedCapture(() => resolve(openLog(file, name, { stay: true }).then((outcome) => outcome === 'opened'))));
    },
    swapCompareLog,
    openLogPicker: () => logInput.current?.click(),
    openDbcPicker: () => dbcInput.current?.click(),
    setInspectorHidden,
    openInspector: () => setInspectorOpen(true),
  };

  const skipped = log && log.rejected > 0 && !skippedDismissed;
  const readingLog = busy?.readingLog !== undefined;
  const dbcSummary = dbcs.length === 1 ? dbcs[0].db.name : `${dbcs.length} DBCs`;

  // On narrow windows the panes float over the content; a tap outside or Escape puts them away.
  const closeOverlays = () => {
    setSidebarOpen(false);
    setInspectorOpen(false);
  };

  return (
    <div className={`app${sidebarOpen ? '' : ' sidebar-hidden'}`} data-busy={busy ? '' : undefined}>
      <aside className="sidebar" aria-label="Sidebar">
        <div className="brand">
          <Logo size={40} />
          <span className="wordmark">
            <b>FreeCAN</b> Studio
          </span>
        </div>
        {showView && (
          <label className="search">
            <Search size={16} strokeWidth={1.5} aria-hidden="true" />
            <span className="sr-only">{meta.search}</span>
            <input type="search" placeholder={meta.search} value={query} onChange={(e) => setQuery(e.target.value)} />
          </label>
        )}
        <div className="sidebar-scroll">
          <div ref={setSidebarSlot} className="sidebar-slot" />
          {!showView && !restoring && <p className="sidebar-empty">Message IDs appear here once a log is open.</p>}
        </div>
        <p className="sidebar-foot">
          <Lock size={13} strokeWidth={1.75} aria-hidden="true" />
          Processed on your computer
        </p>
      </aside>

      <div className="main">
        <header className={live ? 'toolbar recording' : 'toolbar'} data-reading-log={readingLog ? '' : undefined}>
          <div className="toolbar-leading">
            <button
              className="icon-button"
              onClick={() => setSidebarOpen((o) => !o)}
              aria-pressed={sidebarOpen}
              aria-label={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
            >
              <PanelLeft size={18} strokeWidth={1.5} />
            </button>
            <span className="toolbar-divider" />
            <div className="doc" title={log && log.format !== 'capture' ? parseStats(log) : undefined}>
              <h1 className="doc-title">{log?.name ?? (dbcs.length > 0 ? dbcSummary : 'No log open')}</h1>
              {live && liveStatus && (
                // Not a live region: it changes twice a second. The status below tells what matters.
                <p className="doc-sub" title={live.recorder.text.title(liveStatus)}>
                  <span className="cap-recording">Recording</span> &middot; {live.recorder.text.summary(liveStatus)}
                </p>
              )}
              {/* Always mounted, so screen readers hear each change, recording or not. */}
              <p className={live ? 'sr-only' : 'doc-sub'} role="status" title={live ? undefined : dbcs.map((d) => d.db.name).join(', ') || undefined}>
                {live
                  ? liveAnnouncement
                  : busy
                    ? busy.label
                    : stopping
                      ? 'Stopping the capture\u2026'
                      : restoring
                        ? 'Restoring your last session\u2026'
                        : log
                          ? `${unsavedCapture ? 'Not saved \u00b7 ' : ''}${log.format === 'capture' ? '' : `${logFormatName(log.format)} \u00b7 `}${formatCount(log.frames)} frames \u00b7 ${formatDuration(log.durationS)}${dbcs.length > 0 ? ` \u00b7 ${dbcSummary}` : ''}`
                          : dbcs.length > 0
                            ? `${formatCount(dbcs.reduce((n, d) => n + d.db.messages.length, 0))} messages`
                            : 'Open a CAN log to begin'}
              </p>
            </div>
            {log && !live && (
              <button
                className="icon-button small"
                onClick={() => unlessUnsavedCapture(closeLog)}
                disabled={!!busy || stopping}
                aria-label={`Close ${log.name}`}
                title="Close log"
              >
                <X size={14} strokeWidth={1.75} />
              </button>
            )}
          </div>
          {(log || dbcs.length > 0) && (
            <Segmented
              label="View"
              className="view-switcher"
              options={VIEWS.map((v) => ({ value: v.id, label: v.label, disabled: v.needsLog && !log }))}
              value={view}
              onChange={setView}
            />
          )}
          <div className="toolbar-actions">
            <button className="toolbar-button open-dbc" onClick={() => dbcInput.current?.click()} disabled={!!busy} title={'Open DBC\u2026'}>
              <FileText size={16} strokeWidth={1.5} />
              <span className="label">Open DBC&hellip;</span>
            </button>
            {/* Recording, the status line needs the room more than buttons that can't be used. */}
            {!live && (
              <button
                ref={exportButton}
                className="toolbar-button export-log"
                onClick={() => setExportOpen(true)}
                disabled={!!busy || !log || stopping}
                title={'Export Log\u2026'}
              >
                <FileDown size={16} strokeWidth={1.5} />
                <span className="label">Export Log&hellip;</span>
              </button>
            )}
            {live ? (
              <button className={showView && meta.hasPrimary ? 'button' : 'primary'} onClick={() => void stopCapture()} disabled={stopping}>
                <Square size={14} strokeWidth={2} aria-hidden="true" />
                <span>
                  Stop <span className="stop-capture-rest">Capture</span>
                </span>
              </button>
            ) : (
              <>
                {log?.format === 'capture' && (
                  <button className="toolbar-button save-capture" onClick={() => saveCapture()} disabled={!!busy || stopping} title={'Save Capture\u2026'}>
                    <Save size={16} strokeWidth={1.5} />
                    <span className="label">Save Capture&hellip;</span>
                  </button>
                )}
                <button
                  className="toolbar-button capture"
                  onClick={() =>
                    unlessUnsavedCapture(() => {
                      setCaptureSheetUsed(true);
                      setCaptureOpen(true);
                    })
                  }
                  disabled={!!busy || stopping}
                  title={'Capture\u2026'}
                >
                  <Cable size={16} strokeWidth={1.5} />
                  <span className="label">Capture&hellip;</span>
                </button>
              </>
            )}
            {readingLog && (
              <button
                ref={cancelButton}
                className="button cancel-read"
                onClick={cancelReading}
                aria-label={`Cancel reading ${busy?.readingLog}`}
                title={`Cancel reading ${busy?.readingLog}`}
              >
                <X size={14} strokeWidth={2} aria-hidden="true" />
                <span className="label">Cancel</span>
              </button>
            )}
            {!live && (
              <button
                ref={openLogButton}
                className={showView && meta.hasPrimary ? 'button' : 'primary'}
                onClick={() => logInput.current?.click()}
                disabled={(!!busy && !readingLog) || stopping}
              >
                Open Log&hellip;
              </button>
            )}
            <button
              className="icon-button"
              onClick={() => setInspectorOpen((o) => !o)}
              aria-pressed={showInspector && inspectorOpen}
              aria-label={inspectorOpen ? 'Hide inspector' : 'Show inspector'}
              disabled={!showInspector}
            >
              <PanelRight size={18} strokeWidth={1.5} />
            </button>
          </div>
          <input
            ref={logInput}
            type="file"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (!file) return;
              // The picker may have opened before the app got busy, as when log B is restored.
              if (busyRef.current && busyRef.current.readingLog === undefined) setError(`Wait for "${busyRef.current.label}" to finish, then open the log again.`);
              else if (liveRef.current) setError('Stop the capture before opening a log.');
              else if (stoppingRef.current) setError('Wait for the capture to stop, then open the log again.');
              else unlessUnsavedCapture(() => void openLog(file, file.name));
            }}
          />
          <input
            ref={dbcInput}
            type="file"
            accept=".dbc"
            multiple
            hidden
            onChange={(e) => {
              const files = [...(e.target.files ?? [])];
              e.target.value = '';
              void (async () => {
                for (const f of files) await openDbc(f, f.name);
              })();
            }}
          />
          {busy?.fraction != null && (
            <div className="progress" aria-hidden="true">
              <span style={{ transform: `scaleX(${busy.fraction})` }} />
            </div>
          )}
        </header>

        <div className={`body${showInspector && inspectorOpen ? '' : ' inspector-hidden'}`}>
          <section className={`content view-${view}`} aria-label={showView ? meta.label : 'Welcome'}>
            <UpdateBanner />
            {error && (
              <div className="banner" role="alert">
                <AlertTriangle size={16} strokeWidth={1.75} />
                <p>{error}</p>
                <button className="icon-button small" onClick={() => setError(null)} aria-label="Dismiss">
                  <X size={14} strokeWidth={1.75} />
                </button>
              </div>
            )}
            {skipped && (
              <div className="banner">
                <AlertTriangle size={16} strokeWidth={1.75} />
                <p>
                  {formatSkipped(log)}
                  {log.firstRejection && <span className="detail"> {formatFirstRejection(log)}</span>}
                </p>
                <button className="icon-button small" onClick={() => setSkippedDismissed(true)} aria-label="Dismiss">
                  <X size={14} strokeWidth={1.75} />
                </button>
              </div>
            )}
            {captureNotice && (
              <div className="banner">
                <AlertTriangle size={16} strokeWidth={1.75} />
                <p>{captureNotice}</p>
                <button className="icon-button small" onClick={() => setCaptureNotice(null)} aria-label="Dismiss">
                  <X size={14} strokeWidth={1.75} />
                </button>
              </div>
            )}
            {captureNotKept && (
              <div className="banner">
                <AlertTriangle size={16} strokeWidth={1.75} />
                <p>
                  This browser couldn&rsquo;t keep a copy of {captureNotKept.name}, so it won&rsquo;t reopen after a reload.
                  <span className="detail"> {captureNotKept.detail} Save Capture&hellip; keeps it in a file.</span>
                </p>
                <button className="icon-button small" onClick={() => setCaptureNotKept(null)} aria-label="Dismiss">
                  <X size={14} strokeWidth={1.75} />
                </button>
              </div>
            )}
            {stuckCapture && (
              <div className="banner">
                <AlertTriangle size={16} strokeWidth={1.75} />
                <p>
                  {stuckCapture.capture.name} couldn&rsquo;t be restored after {MAX_CAPTURE_RESTORES} tries.
                  <span className="detail">
                    {' '}
                    {stuckCapture.capture.lastRestoreError ? sentence(stuckCapture.capture.lastRestoreError) : 'The page stopped while restoring it.'} It&rsquo;s still kept in this
                    browser, unsaved.
                  </span>
                </p>
                <button className="button" onClick={retryStuckCapture} disabled={!!busy || !!live || stopping}>
                  Try Again
                </button>
                <button className="button" onClick={() => setDeletingStuckCapture(true)}>
                  Delete&hellip;
                </button>
                {/* For this session only: it is still held, so no other tab restores it meanwhile. */}
                <button className="icon-button small" onClick={() => setStuckCapture(null)} aria-label="Dismiss">
                  <X size={14} strokeWidth={1.75} />
                </button>
              </div>
            )}
            {notKept && (
              <div className="banner">
                <AlertTriangle size={16} strokeWidth={1.75} />
                <p>
                  This browser couldn&rsquo;t keep a copy of {notKept}, so it won&rsquo;t reopen after a reload.
                  <span className="detail"> Its storage may be full or turned off.</span>
                </p>
                <button className="icon-button small" onClick={() => setNotKept(null)} aria-label="Dismiss">
                  <X size={14} strokeWidth={1.75} />
                </button>
              </div>
            )}
            {dbcsNotKept && (
              <div className="banner">
                <AlertTriangle size={16} strokeWidth={1.75} />
                <p>
                  This browser couldn&rsquo;t save your DBCs, so changes you haven&rsquo;t exported won&rsquo;t be there after a reload.
                  <span className="detail"> Its storage may be full or turned off.</span>
                </p>
                <button className="icon-button small" onClick={() => setDbcsNotKept(false)} aria-label="Dismiss">
                  <X size={14} strokeWidth={1.75} />
                </button>
              </div>
            )}
            {dbcsChangedElsewhere && (
              <div className="banner">
                <AlertTriangle size={16} strokeWidth={1.75} />
                <p>
                  Your DBCs were changed in another tab. Reload to see them.
                  <span className="detail"> Until then, changes made here aren&rsquo;t saved. Export DBC&hellip; keeps them in a file.</span>
                </p>
                <button className="button" onClick={() => location.reload()}>
                  Reload
                </button>
                <button className="icon-button small" onClick={() => setDbcsChangedElsewhere(false)} aria-label="Dismiss">
                  <X size={14} strokeWidth={1.75} />
                </button>
              </div>
            )}
            {showView ? (
              <SlotContext.Provider value={{ sidebar: sidebarSlot, inspector: inspectorSlot }}>
                <ViewStateContext.Provider value={viewState}>
                  <meta.Component key={view} ctx={ctx} />
                </ViewStateContext.Provider>
              </SlotContext.Provider>
            ) : restoring ? null : (
              <div className="empty">
                <div className="empty-inner">
                  <Logo size={64} background="var(--paper)" />
                  <h2 className="empty-title">Open a CAN log to get started</h2>
                  <p className="lede">
                    Drop a CAN log (candump, Vector ASC or BLF, PEAK TRC, MF4 or CSV) anywhere in this window, or choose Open Log&hellip; above. Add DBC files to decode its signals.
                  </p>
                  <button className="button" onClick={loadDemo} disabled={!!busy && busy.readingLog === undefined}>
                    Try the Demo
                  </button>
                  <p className="privacy">
                    <Lock size={14} strokeWidth={1.75} aria-hidden="true" />
                    Files are processed on your computer and never uploaded. Open files stay in this browser until you close them.
                  </p>
                </div>
              </div>
            )}
          </section>

          <aside ref={setInspectorSlot} className="inspector" aria-label="Inspector" />
        </div>
      </div>
      {(sidebarOpen || (showInspector && inspectorOpen)) && <div className="scrim" aria-hidden="true" onClick={closeOverlays} />}
      {dragOver && <div className="drop-overlay">Drop a log, DBC files or a video to open them</div>}
      {captureSheetUsed && (
        <ChunkBoundary message="Couldn't load capture." frame={captureFrame}>
          <Suspense fallback={captureFrame(<p className="hint">Loading&hellip;</p>)}>
            <CaptureSheet
              open={captureOpen}
              onClose={() => setCaptureOpen(false)}
              onStart={startCapture}
              buses={[...new Set(dbcs.flatMap((d) => (d.channel === null ? [] : [d.channel])))]}
            />
          </Suspense>
        </ChunkBoundary>
      )}
      <Sheet
        open={deletingStuckCapture && stuckCapture !== null}
        onClose={() => setDeletingStuckCapture(false)}
        title="Delete the capture?"
        footer={
          <>
            <button type="button" className="button" onClick={() => setDeletingStuckCapture(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="button"
              onClick={() => {
                setDeletingStuckCapture(false);
                setStuckCapture(null);
                void stuckCapture?.held.forget();
              }}
            >
              Delete Capture
            </button>
          </>
        }
      >
        <p>{stuckCapture?.capture.name} hasn&rsquo;t been saved, and once deleted it can&rsquo;t be restored.</p>
      </Sheet>
      <Sheet
        open={discardThen !== null}
        onClose={() => setDiscardThen(null)}
        title="Discard the capture?"
        footer={
          <>
            <button type="button" className="button" onClick={() => setDiscardThen(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="button"
              onClick={() => {
                const then = discardThen;
                setDiscardThen(null);
                then?.();
              }}
            >
              Discard Capture
            </button>
            <button
              type="button"
              className="primary"
              onClick={() => {
                const then = discardThen ?? undefined;
                setDiscardThen(null);
                saveCapture(then);
              }}
            >
              Save Capture&hellip;
            </button>
          </>
        }
      >
        <p>{log?.name} hasn&rsquo;t been saved. Save it as a candump log file first, or discard it.</p>
      </Sheet>
      {log && (
        <ExportLogSheet
          // Remounted for each log, so its default format is picked for that log.
          key={logVersion}
          open={exportOpen}
          onClose={() => setExportOpen(false)}
          core={core}
          log={log}
          run={run}
          onDone={() => setExportEnded(true)}
          onSaved={(format, file) => {
            if (log.format !== 'capture') return;
            // Only a candump file reopens a capture whole, so only it is kept for a reload.
            if (format === 'candump') void keepSavedCapture(log.name, file);
            else markCaptureSaved();
          }}
        />
      )}
    </div>
  );
}

/** The demo log ships gzipped. A server may already have decoded it, so check for the gzip magic first. */
async function gunzip(blob: Blob): Promise<Blob> {
  const magic = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
  if (magic[0] !== 0x1f || magic[1] !== 0x8b) return blob;
  return new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).blob();
}

function parseStats(log: LogInfo): string {
  const seconds = log.parseMs / 1000;
  const rate = log.bytes / 1e6 / seconds;
  return `Parsed ${formatBytes(log.bytes)} in ${seconds.toFixed(1)} s (${rate.toFixed(0)} MB/s). Engine memory ${formatBytes(log.wasmBytes)}.`;
}
