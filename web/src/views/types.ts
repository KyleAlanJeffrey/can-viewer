import type { ComponentType } from 'react';
import type { CoreApi, Database, IdSummary, LogInfo, MessageDef } from '../core/api';
import type { PlotSpec } from '../components/Plots';

export type ViewId = 'overview' | 'trace' | 'plot' | 'reverse' | 'database' | 'compare';

/** Everything a view can read or change. The app shell owns all of it; views keep only local UI state. */
export interface ViewContext {
  core: CoreApi;
  /** Null until a log is open. */
  log: LogInfo | null;
  /** Bumps whenever a log is opened or a capture started; reset per-log view state on it. */
  logVersion: number;
  /**
   * True while a live capture records. `log` and `ids` then grow every half second or so, and
   * views keep the newest frames in sight.
   */
  capturing: boolean;
  /** One summary per bus/ID pair in the log. */
  ids: IdSummary[];
  /** Loaded DBCs in lookup order: for each ID, the first one that applies and defines it wins. */
  dbcs: LoadedDbc[];
  /** The message that decodes ID `key`, or null when no loaded DBC defines it for its bus. */
  messageOf(key: number): MessageDef | null;
  /** The DBC that decodes ID `key`. */
  dbcOf(key: number): LoadedDbc | null;
  /** Add a DBC made in the app (marked edited; renamed if the file name is taken). Returns its id. */
  addDbc(db: Database, channel?: string | null): Promise<string>;
  /**
   * Change a loaded DBC. Changing `db` marks it edited unless `edited` is given. Plotted signals
   * are decoded again under the result. Changes are applied in call order; pass a function to
   * build the change from the latest version, so quick successive edits never undo each other.
   */
  updateDbc(id: string, change: DbcChange | ((current: LoadedDbc) => DbcChange)): Promise<void>;
  removeDbc(id: string): Promise<void>;
  /** Move a DBC earlier (-1) or later (+1) in the lookup order. */
  moveDbc(id: string, delta: -1 | 1): Promise<void>;

  /** Selected ID key, or ALL_IDS. Shared by every view, so a selection carries across them. */
  selected: number;
  select(key: number): void;
  /** Text in the sidebar search field. */
  query: string;

  /** Plotted signals, shared by the Trace plot card and the Plot view. */
  plots: PlotSpec[];
  /** Plot `signal` of ID `key`, or remove it if it's already plotted. */
  togglePlot(key: number, signal: string): Promise<void>;
  /**
   * Plot every one of `signals` of ID `key` not plotted yet, as far as there are colours left,
   * saying in the banner why any were not. Resolves to how many of them are plotted after.
   */
  plotAll(key: number, signals: string[]): Promise<number>;
  removePlot(id: string): void;
  clearPlots(): void;
  /** The colour `signal` of ID `key` plots in: its plot's colour, else the one it would get. */
  signalColor(key: number, signal: string): string;
  /** Time pinned by clicking a plot or a trace row, in seconds from the log start. */
  pinnedTime: number | null;
  setPinnedTime(t: number | null): void;

  /** Run a task under the toolbar's busy label; a thrown error shows in the banner. Resolves false if it threw. */
  run(label: string, task: () => Promise<void>): Promise<boolean>;
  /** The label of the task under way, or null when none is; open no file until it ends. */
  busyLabel(): string | null;
  setError(message: string | null): void;
  setView(view: ViewId): void;
  /**
   * Hide the inspector pane while the view has nothing to put there, or for a mode of the view
   * that has none; the shell resets it on a view change.
   */
  setInspectorHidden(hidden: boolean): void;
  /** Whether the inspector pane is shown, which the view's Details toggle reflects. */
  inspectorOpen: boolean;
  /** Show or hide the inspector pane, as the view's Details toggle does. */
  toggleInspector(): void;
  /** Show the inspector pane when the view puts something there to act on. */
  openInspector(): void;
  /**
   * Whether the view shows its own amber button now, for a view where it comes and goes, so
   * Open Log... drops to an outline button meanwhile. Null leaves it to `ViewMeta.hasPrimary`;
   * the view sets that as it unmounts, as not every view change goes through the shell's setView.
   */
  setViewPrimary(has: boolean | null): void;
  /** Show the sidebar, if hidden, for a view that sends the user there. */
  showSidebar(): void;
  /** Open `file` as the log, as Open Log... does but staying in this view. Resolves false if it failed. */
  openLog(file: Blob, name: string): Promise<boolean>;
  /** Make the Compare view's second log the open log, and the open log the second log. Resolves false if it failed. */
  swapCompareLog(): Promise<boolean>;
  openLogPicker(): void;
  openDbcPicker(): void;
}

export interface LoadedDbc {
  /** Stable across reloads. */
  id: string;
  db: Database;
  /** Bus name (as in `LogInfo.channels`) this DBC applies to, or null for every bus. */
  channel: string | null;
  /** Changed since it was opened or last exported. */
  edited: boolean;
  /** When it was last exported from this app, in epoch milliseconds. Absent if never. */
  exportedAt?: number;
}

export type DbcChange = Partial<Pick<LoadedDbc, 'db' | 'channel' | 'edited' | 'exportedAt'>>;

export interface ViewProps {
  ctx: ViewContext;
}

export interface ViewMeta {
  id: ViewId;
  label: string;
  Component: ComponentType<ViewProps>;
  /** Placeholder for the sidebar search field. */
  search: string;
  /** What the sidebar holds, naming the button that shows it on phones. */
  sidebar: 'Messages' | 'Signals';
  /** False leaves the inspector pane out. */
  hasInspector: boolean;
  /** True when the view shows its own amber primary, so Open Log drops to an outlined button. See `setViewPrimary`. */
  hasPrimary: boolean;
  /** False lets the view open with only a database loaded. */
  needsLog: boolean;
}
