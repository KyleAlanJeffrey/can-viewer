import { useMemo } from 'react';
import { ALL_IDS, dbcId } from '../../core/api';
import { DetailPanel } from '../../components/DetailPanel';
import { Plots } from '../../components/Plots';
import { TraceTable } from '../../components/TraceTable';
import { IdListSidebar } from '../shared/IdListSidebar';
import { InspectorSlot } from '../slots';
import type { ViewProps } from '../types';

/** Every frame (or one ID's) over the plot card, with the selected ID in the inspector. */
export function TraceView({ ctx }: ViewProps) {
  const { core, log, ids, selected, plots, pinnedTime, setPinnedTime } = ctx;
  // Names come from the core's summaries, which already apply each DBC's bus scope.
  const nameOf = useMemo(() => {
    const names = new Map(ids.map((s) => [`${s.channel}:${dbcId(s)}`, s.name ?? undefined]));
    return (channel: number, id: number) => names.get(`${channel}:${id}`);
  }, [ids]);
  if (!log) return null;

  const summary = ids.find((s) => s.key === selected) ?? null;
  const message = summary ? ctx.messageOf(summary.key) : null;
  const rowCount = selected === ALL_IDS ? log.frames : (summary?.count ?? 0);
  const signalColors = summary ? (message?.signals ?? []).map((s) => ctx.signalColor(summary.key, s.name)) : [];
  const plottedHere = new Set(
    plots.filter((p) => summary && p.id.startsWith(`${summary.key}:`)).map((p) => p.id.slice(p.id.indexOf(':') + 1)),
  );

  return (
    <>
      <IdListSidebar ctx={ctx} />
      <TraceTable
        core={core}
        filterKey={selected}
        rowCount={rowCount}
        logVersion={ctx.logVersion}
        channels={log.channels}
        nameOf={nameOf}
        pinnedTime={pinnedTime}
        onPin={plots.length > 0 ? setPinnedTime : undefined}
      />
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
    </>
  );
}
