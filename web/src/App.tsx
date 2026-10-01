import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, FileText, Lock, PanelLeft, PanelRight, Search, X } from 'lucide-react';
import { ALL_IDS, EXT_FLAG, type CoreApi, type Database, type IdSummary, type LogInfo, type MessageDef, type SignalDef } from './core/api';
import { Logo } from './components/Logo';
import type { PlotSpec } from './components/Plots';
import { Segmented } from './components/Segmented';
import { cssVar, formatBytes, formatCount, formatDuration } from './format';
import { forget, loadSaved, loadSavedDbcs, onDbcsChangedElsewhere, save, saveDbcs } from './session';
import { VIEWS, viewMeta } from './views';
import { ViewStateContext, ViewStateStore } from './views/shared/viewState';
import { SlotContext } from './views/slots';
import type { LoadedDbc, ViewContext, ViewId } from './views/types';

const SERIES_SLOTS = 6;
const seriesColor = (slot: number) => cssVar(`--series-${(slot % SERIES_SLOTS) + 1}`);

interface Busy {
  label: string;
  /** 0..1 when the task can report progress. */
  fraction: number | null;
}

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

const narrow = () => window.matchMedia('(max-width: 900px)').matches;

const splitPlotId = (id: string): [number, string] => {
  const at = id.indexOf(':');
  return [Number(id.slice(0, at)), id.slice(at + 1)];
};

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
  const [query, setQuery] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(() => !narrow());
  const [inspectorOpen, setInspectorOpen] = useState(() => !narrow());
  const [inspectorHidden, setInspectorHidden] = useState(false);
  const [sidebarSlot, setSidebarSlot] = useState<HTMLElement | null>(null);
  const [inspectorSlot, setInspectorSlot] = useState<HTMLElement | null>(null);
  const [viewState] = useState(() => new ViewStateStore());
  const logInput = useRef<HTMLInputElement>(null);
  const dbcInput = useRef<HTMLInputElement>(null);

  // Async tasks read these rather than a render's closure, so queued DBC edits never undo each other.
  const dbcsRef = useRef<LoadedDbc[]>([]);
  const changeQueue = useRef<Promise<unknown>>(Promise.resolve());
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const logRef = useRef(log);
  logRef.current = log;
  const plotsRef = useRef(plots);
  plotsRef.current = plots;
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

  const run = useCallback(async (label: string, task: () => Promise<void>) => {
    setBusy({ label, fraction: null });
    setError(null);
    try {
      await task();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(null);
    }
  }, []);

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
    setLogVersion((v) => v + 1);
    viewState.clearScope('log');
  }, [viewState]);

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

  const openLog = useCallback(
    (file: Blob, name: string, restore?: SavedUi) =>
      run(`Reading ${name}\u2026`, () =>
        serially(async () => {
          setSkippedDismissed(false);
          let info: LogInfo;
          try {
            info = await core.openLog(file, name, (p) =>
              setBusy({ label: `Parsing ${name}\u2026 ${Math.round((100 * p.bytes) / p.total)}%`, fraction: p.bytes / p.total }),
            );
            if (info.frames === 0 && info.rejected > 0) {
              throw new Error(`${name} has no CAN frames that FreeCAN Studio can read. It reads candump logs (candump -l), Vector ASC and BLF, PEAK TRC, ASAM MF4 bus logging and CSV files.`);
            }
          } catch (e) {
            showNoLog();
            throw e;
          }
          const nextIds = await core.idSummary();
          // The new log's series replaced the old ones in the core.
          plotSignals.current.clear();
          setPlots([]);
          setSelected(ALL_IDS);
          setNotKept(null);
          setLog(info);
          setLogVersion((v) => v + 1);
          setDbcs(dbcsRef.current);
          setIds(nextIds);
          if (restore) {
            await restoreUi(restore, nextIds);
            return;
          }
          viewState.clearScope('log');
          setView('overview');
          // Kept so a reload reopens it. A copy this browser can't store just isn't restored.
          void save('log', { name, blob: file } satisfies SavedLog).then((kept) => {
            if (!kept) {
              setNotKept(name);
              void forget('log');
            }
          });
        }),
      ),
    [core, run, serially, showNoLog, setView, restoreUi, viewState],
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
      const logFile = list.find((f) => !dbcFiles.includes(f));
      for (const f of dbcFiles) await openDbc(f, f.name);
      if (logFile) await openLog(logFile, logFile.name);
      // DBCs on their own are opened for editing.
      else if (dbcFiles.length > 0 && !logRef.current) setView('database');
    },
    [openDbc, openLog, setView],
  );

  const closeLog = () =>
    run('Closing the log\u2026', () =>
      serially(async () => {
        // The core has no close; an empty log releases the old one's memory.
        await core.openLog(new Blob([]), '', () => {});
        showNoLog();
        await forget('log');
        if (dbcsRef.current.length > 0) setView('database');
      }),
    );

  const loadDemo = () =>
    run('Downloading the demo\u2026', async () => {
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

  // The landing page's Try the Demo links to `?demo=1`.
  const demoRequested = useRef(new URLSearchParams(window.location.search).has('demo'));

  // Reopen the last session. Guarded because StrictMode runs effects twice in development.
  const restoreStarted = useRef(false);
  useEffect(() => {
    if (restoreStarted.current) return;
    restoreStarted.current = true;
    void (async () => {
      const [savedLog, savedDbcs, savedUi, savedViews] = await Promise.all([
        loadSaved<SavedLog>('log'),
        loadSavedDbcs<LoadedDbc[]>(),
        loadSaved<SavedUi>('ui'),
        loadSaved<ReturnType<ViewStateStore['snapshot']>>('views'),
      ]);
      if (savedViews) viewState.restore(savedViews);
      if (savedDbcs?.length) await run('Restoring your DBCs\u2026', () => mutateDbcs(() => withJ1939Flags(savedDbcs), false));
      // A saved log other than the demo would only be replaced by it, so it isn't parsed first.
      if (savedLog && (!demoRequested.current || savedLog.name === 'demo.log')) {
        const ui = savedUi ?? { view: 'overview', selected: ALL_IDS, pinnedTime: null, plots: [] };
        if (!(await openLog(savedLog.blob, savedLog.name, ui))) void forget('log');
      } else if (savedUi && savedDbcs?.length && !viewMeta(savedUi.view).needsLog) {
        setViewState(savedUi.view);
      }
      setRestoring(false);
    })();
  }, [viewState, run, mutateDbcs, openLog]);

  useEffect(() => {
    if (restoring || !demoRequested.current) return;
    demoRequested.current = false;
    const url = new URL(window.location.href);
    url.searchParams.delete('demo');
    window.history.replaceState(null, '', url);
    if (logRef.current?.name !== 'demo.log') loadDemo();
    // loadDemo is recreated each render; this runs once, when the restore is done.
  }, [restoring]);

  useEffect(() => {
    if (restoring) return;
    const timer = setTimeout(() => {
      const saved: SavedUi = {
        view,
        selected,
        pinnedTime,
        plots: plots.map((p) => {
          const [key, signal] = splitPlotId(p.id);
          return { key, signal, color: p.color };
        }),
      };
      void save('ui', saved);
    }, 250);
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
        showNoLog();
        setError('The CAN core stopped and was restarted. Open the log again.');
      }),
    [core, showNoLog],
  );

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
      if (busyRef.current) {
        setError(`Wait for "${busyRef.current.label}" to finish, then drop the files again.`);
        return;
      }
      openFiles(e.dataTransfer.files);
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

  const ctx: ViewContext = {
    core,
    log,
    logVersion,
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
    setError,
    setView,
    openLogPicker: () => logInput.current?.click(),
    openDbcPicker: () => dbcInput.current?.click(),
    setInspectorHidden,
  };

  const skipped = log && log.rejected > 0 && !skippedDismissed;
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
        <header className="toolbar">
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
            <div className="doc" title={log ? parseStats(log) : undefined}>
              <h1 className="doc-title">{log?.name ?? (dbcs.length > 0 ? dbcSummary : 'No log open')}</h1>
              <p className="doc-sub" role="status" title={dbcs.map((d) => d.db.name).join(', ') || undefined}>
                {busy
                  ? busy.label
                  : restoring
                    ? 'Restoring your last session\u2026'
                    : log
                      ? `${formatCount(log.frames)} frames \u00b7 ${formatDuration(log.durationS)}${dbcs.length > 0 ? ` \u00b7 ${dbcSummary}` : ''}`
                      : dbcs.length > 0
                        ? `${formatCount(dbcs.reduce((n, d) => n + d.db.messages.length, 0))} messages`
                        : 'Open a CAN log to begin'}
              </p>
            </div>
            {log && (
              <button className="icon-button small" onClick={closeLog} disabled={!!busy} aria-label={`Close ${log.name}`} title="Close log">
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
            <button className="toolbar-button" onClick={() => dbcInput.current?.click()} disabled={!!busy}>
              <FileText size={16} strokeWidth={1.5} />
              <span className="label">Open DBC&hellip;</span>
            </button>
            <button
              className={showView && meta.hasPrimary ? 'button' : 'primary'}
              onClick={() => logInput.current?.click()}
              disabled={!!busy}
            >
              Open Log&hellip;
            </button>
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
              if (file) openLog(file, file.name);
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
                  {formatCount(log.rejected)} {log.rejected === 1 ? "line wasn't a CAN frame and was" : "lines weren't CAN frames and were"}{' '}
                  skipped.
                  {log.firstRejection && (
                    <span className="detail">
                      {' '}
                      First at line {formatCount(log.firstRejection[0])}: {log.firstRejection[1]}
                    </span>
                  )}
                </p>
                <button className="icon-button small" onClick={() => setSkippedDismissed(true)} aria-label="Dismiss">
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
                  <button className="button" onClick={loadDemo} disabled={!!busy}>
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
      {dragOver && <div className="drop-overlay">Drop a log or DBC files to open them</div>}
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
