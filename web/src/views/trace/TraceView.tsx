import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import { ALL_IDS, FILTERED_ROWS, dbcId, idLabel, type CoreApi, type FrameFilter } from '../../core/api';
import type { RowBatch } from '../../core/rows';
import { ChunkBoundary } from '../../components/ChunkBoundary';
import { DetailPanel } from '../../components/DetailPanel';
import { Plots } from '../../components/Plots';
import { TraceTable } from '../../components/TraceTable';
import { usePhone } from '../../phone';
import { DetailsToggle } from '../shared/DetailsToggle';
import { IdListSidebar } from '../shared/IdListSidebar';
import { useViewState } from '../shared/viewState';
import { InspectorSlot, PhoneActionsSlot } from '../slots';
import type { ViewProps } from '../types';
import { FilterBar, NoMatches } from './FilterBar';
import { filterChips, hasFilters, lastEditedChip, matchedBytes, toFrameFilter, type FilterChip, type TraceFilters } from './filters';
import { TraceCards, type FrameLookup } from './TraceCards';
import './trace.css';

const FilterSheet = lazy(() => import('./FilterSheet').then((m) => ({ default: m.FilterSheet })));

/** The filtered rows the core holds: for which query, and how many. */
interface Filtered {
  query: string;
  count: number;
  /** New per result, so the table starts over even when the count is the same. */
  version: number;
  logVersion: number;
}

/**
 * What each core holds as its filtered rows, so the Trace view, mounted again after another
 * view, shows them at once instead of filtering the log again.
 */
const held = new WeakMap<CoreApi, Filtered>();
let results = 0;

/** Every frame (or one ID's, or the filtered ones) over the plot card, with the selected ID in the inspector. */
export function TraceView({ ctx }: ViewProps) {
  const { core, log, ids, selected, plots, pinnedTime, setPinnedTime, setError, logVersion, setInspectorHidden } = ctx;
  const [filters, setFilters] = useViewState<TraceFilters | null>('trace.filters', null, 'log');
  const [sheetOpen, setSheetOpen] = useState(false);
  // A new key per opening, so the sheet's draft starts from the applied filters.
  const [sheetKey, setSheetKey] = useState(0);
  const [filtered, setFiltered] = useState<Filtered | null>(() => held.get(core) ?? null);
  const editButton = useRef<HTMLButtonElement>(null);
  const phone = usePhone();

  // Names come from the core's summaries, which already apply each DBC's bus scope.
  const nameOf = useMemo(() => {
    const names = new Map(ids.map((s) => [`${s.channel}:${dbcId(s)}`, s.name ?? undefined]));
    return (channel: number, id: number) => names.get(`${channel}:${id}`);
  }, [ids]);
  const { messageOf } = ctx;
  const lookup = useMemo(() => {
    const byId = new Map(ids.map((s) => [`${s.channel}:${dbcId(s)}`, s]));
    return (channel: number, id: number): FrameLookup => {
      const s = byId.get(`${channel}:${id}`);
      return { name: s?.name ?? undefined, message: s ? messageOf(s.key) : null, key: s?.key ?? null };
    };
  }, [ids, messageOf]);

  const query = filters ? JSON.stringify(toFrameFilter(filters, selected)) : null;
  useEffect(() => {
    if (query === null) {
      setFiltered(null);
      // Frees the rows the core kept.
      if (held.delete(core)) core.setTraceFilter(null).catch(() => undefined);
      return;
    }
    const kept = held.get(core);
    if (kept && kept.query === query && kept.logVersion === logVersion) {
      setFiltered(kept);
      return;
    }
    let stale = false;
    core.setTraceFilter(JSON.parse(query) as FrameFilter).then(
      (count) => {
        // Calls run in order, so the core holds these rows until a later call, even if this view is gone.
        const result = { query, count, version: ++results, logVersion };
        held.set(core, result);
        if (!stale) setFiltered(result);
      },
      (e) => {
        // The core dropped its filtered rows.
        held.delete(core);
        if (stale) return;
        setFiltered(null);
        setFilters(null);
        setError(`The filters couldn't be applied: ${e instanceof Error ? e.message : String(e)}`);
      },
    );
    return () => {
      stale = true;
    };
  }, [core, query, logVersion, setError, setFilters]);

  // The rows on screen are those of the last result, which may be for older filters.
  const result = filters && filtered && filtered.query === query && filtered.logVersion === logVersion ? filtered : null;

  // The core adds a capture's new frames that match to the rows, and finds them again in time
  // order when it ends, so the count follows each refresh of the capture. Without the memory
  // for that, the core drops the filter and goes on recording.
  const resultVersion = result?.version;
  useEffect(() => {
    if (resultVersion === undefined || log?.format !== 'capture') return;
    let stale = false;
    core.filteredRowCount().then((count) => {
      if (stale) return;
      if (count === null) {
        held.delete(core);
        setFiltered(null);
        setFilters(null);
        setError("The filters were turned off: there was no memory left to filter the capture's frames.");
        return;
      }
      setFiltered((f) => {
        if (!f || f.version !== resultVersion || f.count === count) return f;
        const next = { ...f, count };
        if (held.get(core) === f) held.set(core, next);
        return next;
      });
    }, () => undefined);
    return () => {
      stale = true;
    };
  }, [core, log, resultVersion, setError, setFilters]);
  const shownQuery = result?.query;
  const highlight = useMemo(() => {
    const rules = shownQuery ? (JSON.parse(shownQuery) as FrameFilter).rules : [];
    return rules.length > 0 ? (batch: RowBatch, i: number) => matchedBytes(rules, batch.data(i), (b) => batch.changed(i, b)) : undefined;
  }, [shownQuery]);

  // The sheet unmounts as it closes, so its dialog can't hand focus back, and while the dialog
  // is up the rest of the page is inert; so focus moves once it has gone.
  const sheetWasOpen = useRef(false);
  useEffect(() => {
    if (sheetOpen) sheetWasOpen.current = true;
    else if (sheetWasOpen.current) {
      sheetWasOpen.current = false;
      editButton.current?.focus();
    }
  }, [sheetOpen]);

  // With All frames there is nothing to inspect, so the pane gives the table its room. On phones
  // an opened card shows what the inspector would.
  const nothingSelected = !ids.some((s) => s.key === selected);
  useEffect(() => {
    setInspectorHidden(nothingSelected || phone);
  }, [setInspectorHidden, nothingSelected, phone]);

  const apply = useCallback(
    (next: TraceFilters | null) => {
      setFilters(next && hasFilters(next) ? next : null);
      // The button that had focus may be gone; this one never is.
      editButton.current?.focus();
    },
    [setFilters],
  );

  if (!log) return null;

  const summary = ids.find((s) => s.key === selected) ?? null;
  const message = summary ? ctx.messageOf(summary.key) : null;
  const total = selected === ALL_IDS ? log.frames : (summary?.count ?? 0);
  const signalColors = summary ? (message?.signals ?? []).map((s) => ctx.signalColor(summary.key, s.name)) : [];
  const plottedHere = new Set(
    plots.filter((p) => summary && p.id.startsWith(`${summary.key}:`)).map((p) => p.id.slice(p.id.indexOf(':') + 1)),
  );
  const chips: FilterChip[] = filters ? filterChips(filters, log.channels, ids) : [];

  const openSheet = () => {
    setSheetKey((k) => k + 1);
    setSheetOpen(true);
  };
  const closeSheet = () => setSheetOpen(false);

  const plotMessage = async (key: number, time: number) => {
    const message = ctx.messageOf(key);
    if (!message) return;
    // Nothing to show if none could be plotted; the banner says why.
    if ((await ctx.plotAll(key, message.signals.map((s) => s.name))) === 0) return;
    setPinnedTime(time);
    ctx.setView('plot');
  };

  return (
    <>
      <IdListSidebar ctx={ctx} />
      {phone && (
        <PhoneActionsSlot>
          <button ref={editButton} type="button" className="button" onClick={openSheet}>
            <SlidersHorizontal size={16} strokeWidth={1.5} aria-hidden="true" />
            {chips.length > 0 ? `Filters (${chips.length})` : 'Filters'}
          </button>
        </PhoneActionsSlot>
      )}
      {(!phone || chips.length > 0) && (
        <FilterBar
          chips={chips}
          anyRule={filters?.combine === 'any' && filters.rules.length > 1}
          matches={result?.count ?? null}
          total={total}
          editRef={editButton}
          onEdit={openSheet}
          onRemove={(chip) => apply(chip.without)}
          onClear={() => apply(null)}
          showEdit={!phone}
          trailing={phone ? null : <DetailsToggle ctx={ctx} emptyReason={summary ? null : 'Select an ID to see its bit activity and signals'} />}
        />
      )}
      {sheetOpen && (
        <ChunkBoundary key={sheetKey} message="Couldn't load the filters.">
          <Suspense fallback={null}>
            <FilterSheet
              open
              onClose={closeSheet}
              core={core}
              channels={log.channels}
              ids={ids}
              duration={log.durationS}
              selected={selected}
              total={total}
              filters={filters}
              onApply={(next) => {
                setSheetOpen(false);
                apply(next);
              }}
            />
          </Suspense>
        </ChunkBoundary>
      )}
      {filters && !result ? (
        <div className="tv-empty">
          <p className="tv-empty-lede">Filtering&hellip;</p>
        </div>
      ) : result && result.count === 0 && chips.length > 0 ? (
        <NoMatches
          last={lastEditedChip(chips, filters?.edited)}
          oneId={summary ? idLabel(summary) : null}
          onRemoveLast={() => apply(lastEditedChip(chips, filters?.edited).without)}
          onClear={() => apply(null)}
        />
      ) : phone ? (
        <TraceCards
          key={result ? `filtered-${result.version}` : 'all'}
          core={core}
          filterKey={result ? FILTERED_ROWS : selected}
          rowCount={result ? result.count : total}
          logVersion={logVersion}
          droppedFrames={log.droppedFrames}
          follow={ctx.capturing}
          channels={log.channels}
          hasDbc={ctx.dbcs.length > 0}
          lookup={lookup}
          pinnedTime={pinnedTime}
          onPin={plots.length > 0 ? setPinnedTime : undefined}
          onPlotMessage={(key, time) => void plotMessage(key, time)}
          matchedBytes={result ? highlight : undefined}
        />
      ) : (
        <TraceTable
          key={result ? `filtered-${result.version}` : 'all'}
          core={core}
          filterKey={result ? FILTERED_ROWS : selected}
          rowCount={result ? result.count : total}
          logVersion={logVersion}
          droppedFrames={log.droppedFrames}
          follow={ctx.capturing}
          channels={log.channels}
          nameOf={nameOf}
          pinnedTime={pinnedTime}
          onPin={plots.length > 0 ? setPinnedTime : undefined}
          matchedBytes={result ? highlight : undefined}
        />
      )}
      {/* On phones the cards need the height; Plot is a tap away. */}
      {!phone && (
        <Plots
          core={core}
          specs={plots}
          duration={log.durationS}
          pinnedTime={pinnedTime}
          onPin={setPinnedTime}
          onRemove={ctx.removePlot}
          onClear={ctx.clearPlots}
        />
      )}
      <InspectorSlot>
        <DetailPanel
          core={core}
          summary={summary}
          channels={log.channels}
          message={message}
          logVersion={logVersion}
          signalColors={signalColors}
          plotted={plottedHere}
          onTogglePlot={(signal) => summary && ctx.togglePlot(summary.key, signal)}
        />
      </InspectorSlot>
    </>
  );
}
