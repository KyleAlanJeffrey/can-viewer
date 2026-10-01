import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useCallback, useMemo, useRef, useState, type ComponentType } from 'react';
import { ALL_IDS, dbcId, type CoreApi, type IdSummary, type LogInfo, type MessageDef } from '../core/api';
import type { PlotSpec } from '../components/Plots';
import { SlotContext } from '../views/slots';
import { ViewStateContext, ViewStateStore } from '../views/shared/viewState';
import type { DbcChange, LoadedDbc, ViewContext, ViewId, ViewProps } from '../views/types';
import { logInfo } from './fixtures';

/** What a test can read back from the shell after interacting with a view. */
export interface ShellState {
  dbcs: LoadedDbc[];
  selected: number;
  pinnedTime: number | null;
  plots: PlotSpec[];
  view: ViewId | null;
  error: string | null;
  /** Tasks passed to ctx.run that haven't finished. */
  running: number;
}

export interface ShellOptions {
  core: CoreApi;
  ids?: IdSummary[];
  dbcs?: LoadedDbc[];
  /** Null renders the view without a log. */
  log?: LogInfo | null;
  selected?: number;
  plots?: PlotSpec[];
  pinnedTime?: number | null;
}

const PLOT_COLORS = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'];

/**
 * A stand-in for the app shell: it owns the ViewContext state the way App does, with a search
 * field, a sidebar and an inspector for the view's slots. Messages are matched by exact ID.
 */
function Shell({ view: View, options, state }: { view: ComponentType<ViewProps>; options: ShellOptions; state: ShellState }) {
  const { core } = options;
  // Held in state so they keep their identity across renders, as App's do.
  const [ids] = useState(() => options.ids ?? []);
  const [log] = useState(() => (options.log === undefined ? logInfo() : options.log));
  const [dbcs, setDbcs] = useState<LoadedDbc[]>(options.dbcs ?? []);
  const [selected, setSelected] = useState(options.selected ?? ALL_IDS);
  const [query, setQuery] = useState('');
  const [plots, setPlots] = useState<PlotSpec[]>(options.plots ?? []);
  const [pinnedTime, setPinnedTime] = useState<number | null>(options.pinnedTime ?? null);
  const [view, setView] = useState<ViewId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [store] = useState(() => new ViewStateStore());
  const [sidebar, setSidebar] = useState<HTMLElement | null>(null);
  const [inspector, setInspector] = useState<HTMLElement | null>(null);
  // Changes apply in call order to the latest list, as App's mutateDbcs does.
  const latestDbcs = useRef(dbcs);
  Object.assign(state, { dbcs, selected, pinnedTime, plots, view, error });

  const mutateDbcs = useCallback(async (change: (prev: LoadedDbc[]) => LoadedDbc[]) => {
    latestDbcs.current = change(latestDbcs.current);
    setDbcs(latestDbcs.current);
  }, []);

  const resolved = useMemo(() => {
    const byKey = new Map<number, { dbc: LoadedDbc; message: MessageDef }>();
    for (const s of ids) {
      for (const dbc of dbcs) {
        if (dbc.channel !== null && log?.channels[s.channel] !== dbc.channel) continue;
        const message = dbc.db.messages.find((m) => m.id === dbcId(s));
        if (message) {
          byKey.set(s.key, { dbc, message });
          break;
        }
      }
    }
    return byKey;
  }, [ids, dbcs, log]);
  const messageOf = useCallback((key: number) => resolved.get(key)?.message ?? null, [resolved]);
  const dbcOf = useCallback((key: number) => resolved.get(key)?.dbc ?? null, [resolved]);

  const removePlot = (id: string) => setPlots((ps) => ps.filter((p) => p.id !== id));

  const ctx: ViewContext = {
    core,
    log,
    logVersion: 1,
    ids,
    dbcs,
    messageOf,
    dbcOf,
    addDbc: async (db, channel = null) => {
      const id = `dbc-${latestDbcs.current.length + 1}`;
      await mutateDbcs((prev) => [...prev, { id, db, channel, edited: true }]);
      return id;
    },
    updateDbc: (id, update) =>
      mutateDbcs((prev) =>
        prev.map((d) => {
          if (d.id !== id) return d;
          const change: DbcChange = typeof update === 'function' ? update(d) : update;
          return { ...d, ...change, edited: change.edited ?? (change.db ? true : d.edited) };
        }),
      ),
    removeDbc: (id) => mutateDbcs((prev) => prev.filter((d) => d.id !== id)),
    moveDbc: () => Promise.reject(new Error('moveDbc is not used by these tests')),
    selected,
    select: setSelected,
    query,
    plots,
    togglePlot: async (key, signal) => {
      const id = `${key}:${signal}`;
      if (plots.some((p) => p.id === id)) {
        removePlot(id);
        return;
      }
      const info = await core.decodeSignal(key, signal);
      setPlots((ps) => [...ps, { id, label: signal, info, color: PLOT_COLORS[ps.length] }]);
    },
    removePlot,
    clearPlots: () => setPlots([]),
    signalColor: (key, signal) => plots.find((p) => p.id === `${key}:${signal}`)?.color ?? 'grey',
    pinnedTime,
    setPinnedTime,
    run: async (_label, task) => {
      state.running++;
      try {
        await task();
        return true;
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return false;
      } finally {
        state.running--;
      }
    },
    setError,
    setView,
    setInspectorHidden: () => {},
    openLogPicker: () => {},
    openDbcPicker: () => {},
  };

  return (
    <ViewStateContext.Provider value={store}>
      <aside aria-label="Sidebar">
        <input type="search" aria-label="Search" value={query} onChange={(e) => setQuery(e.target.value)} />
        <div ref={setSidebar} />
      </aside>
      <main>
        <SlotContext.Provider value={{ sidebar, inspector }}>
          <View ctx={ctx} />
        </SlotContext.Provider>
      </main>
      <aside ref={setInspector} aria-label="Inspector" />
      {error && <p role="alert">{error}</p>}
    </ViewStateContext.Provider>
  );
}

/** Renders `view` inside the test shell. `state` always holds the shell's latest state. */
export function renderInShell(view: ComponentType<ViewProps>, options: ShellOptions) {
  const user = userEvent.setup();
  const state = { running: 0 } as ShellState;
  render(<Shell view={view} options={options} state={state} />);
  return { user, state };
}
