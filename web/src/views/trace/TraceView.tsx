import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ALL_IDS, FILTERED_ROWS, dbcId, idLabel } from '../../core/api';
import type { RowBatch } from '../../core/rows';
import { DetailPanel } from '../../components/DetailPanel';
import { Plots } from '../../components/Plots';
import { TraceTable } from '../../components/TraceTable';
import { IdListSidebar } from '../shared/IdListSidebar';
import { useViewState } from '../shared/viewState';
import { InspectorSlot } from '../slots';
import type { ViewProps } from '../types';
import { FilterBar, NoMatches } from './FilterBar';
import { FilterSheet } from './FilterSheet';
import { filterChips, hasFilters, matchedBytes, toFrameFilter, type FilterChip, type TraceFilters } from './filters';
import './trace.css';

/** The filtered rows the core holds: for which query, and how many. */
interface Filtered {
  query: string;
  count: number;
  /** Bumps per result, so the table starts over even when the count is the same. */
  version: number;
}

/** Every frame (or one ID's, or the filtered ones) over the plot card, with the selected ID in the inspector. */
export function TraceView({ ctx }: ViewProps) {
  const { core, log, ids, selected, plots, pinnedTime, setPinnedTime, setError } = ctx;
  const [filters, setFilters] = useViewState<TraceFilters | null>('trace.filters', null, 'log');
  const [sheetOpen, setSheetOpen] = useState(false);
  // A new key per opening, so the sheet's draft starts from the applied filters.
  const [sheetKey, setSheetKey] = useState(0);
  const [filtered, setFiltered] = useState<Filtered | null>(null);
  const editButton = useRef<HTMLButtonElement>(null);

  // Names come from the core's summaries, which already apply each DBC's bus scope.
  const nameOf = useMemo(() => {
    const names = new Map(ids.map((s) => [`${s.channel}:${dbcId(s)}`, s.name ?? undefined]));
    return (channel: number, id: number) => names.get(`${channel}:${id}`);
  }, [ids]);

  const query = filters ? JSON.stringify(toFrameFilter(filters, selected)) : null;
  useEffect(() => {
    if (query === null) {
      setFiltered(null);
      // Frees the rows the core kept.
      core.setTraceFilter(null).catch(() => undefined);
      return;
    }
    let stale = false;
    core.setTraceFilter(JSON.parse(query)).then(
      (count) => {
        if (!stale) setFiltered((prev) => ({ query, count, version: (prev?.version ?? 0) + 1 }));
      },
      (e) => {
        if (!stale) setError(`The filters couldn't be applied: ${e instanceof Error ? e.message : String(e)}`);
      },
    );
    return () => {
      stale = true;
    };
  }, [core, query, ctx.logVersion, setError]);

  const rules = filters?.rules;
  const highlight = useMemo(
    () => (rules && rules.length > 0 ? (batch: RowBatch, i: number) => matchedBytes(rules, batch.data(i), (b) => batch.changed(i, b)) : undefined),
    [rules],
  );

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
  // Until the first result for these filters arrives, the trace keeps showing what it showed.
  const current = filters ? filtered : null;
  const matches = current && current.query === query ? current.count : null;

  const openSheet = () => {
    setSheetKey((k) => k + 1);
    setSheetOpen(true);
  };

  return (
    <>
      <IdListSidebar ctx={ctx} />
      <FilterBar
        chips={chips}
        anyRule={filters?.combine === 'any' && filters.rules.length > 1}
        matches={matches}
        total={total}
        editRef={editButton}
        onEdit={openSheet}
        onRemove={(chip) => apply(chip.without)}
        onClear={() => apply(null)}
      />
      {current && current.count === 0 && chips.length > 0 ? (
        <NoMatches
          last={chips[chips.length - 1]}
          oneId={summary ? idLabel(summary) : null}
          onRemoveLast={() => apply(chips[chips.length - 1].without)}
          onClear={() => apply(null)}
        />
      ) : (
        <TraceTable
          key={current ? `filtered-${current.version}` : 'all'}
          core={core}
          filterKey={current ? FILTERED_ROWS : selected}
          rowCount={current ? current.count : total}
          logVersion={ctx.logVersion}
          channels={log.channels}
          nameOf={nameOf}
          pinnedTime={pinnedTime}
          onPin={plots.length > 0 ? setPinnedTime : undefined}
          matchedBytes={current ? highlight : undefined}
        />
      )}
      <Plots
        core={core}
        specs={plots}
        duration={log.durationS}
        pinnedTime={pinnedTime}
        onPin={setPinnedTime}
        onRemove={ctx.removePlot}
        onClear={ctx.clearPlots}
      />
      <InspectorSlot>
        <DetailPanel
          core={core}
          summary={summary}
          channels={log.channels}
          message={message}
          logVersion={ctx.logVersion}
          signalColors={signalColors}
          plotted={plottedHere}
          onTogglePlot={(signal) => summary && ctx.togglePlot(summary.key, signal)}
        />
      </InspectorSlot>
      <FilterSheet
        key={sheetKey}
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
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
    </>
  );
}
