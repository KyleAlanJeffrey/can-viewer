import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type uPlot from 'uplot';
import { ChartLine, ImageDown, MapPin } from 'lucide-react';
import type { PlotSpec } from '../../components/Plots';
import { Segmented } from '../../components/Segmented';
import { formatDuration } from '../../format';
import { useViewState } from '../shared/viewState';
import type { ViewProps } from '../types';
import { CursorRail } from './CursorRail';
import { exportPlotPng } from './exportPng';
import { AXIS_H, LANE_HEAD_H, Lane } from './Lane';
import { Minimap } from './Minimap';
import { clampRange, clampTime, formatSeconds, formatValue, withUnit, type CursorId, type CursorMode, type Marker, type Range } from './model';
import { Readouts } from './Readouts';
import { SignalTree } from './SignalTree';
import { useCursorSamples } from './useCursorSamples';
import { AddVideoButton } from './video/AddVideoButton';
import { VideoWorkspace } from './video/VideoWorkspace';
import { useVideo } from './video/videoSession';
import './plot.css';

const SYNC_KEY = 'plot-view';
const RAIL_H = 28;
/** Smallest lane, head included. More lanes than fit at this height scroll. */
const MIN_LANE_H = 80;
/** The lanes card's border and the stack's bottom padding. */
const STACK_CHROME_H = 10;
/** Cursor A reaches the shared pin once it stops moving, so a drag doesn't re-render the whole app per frame. */
const PIN_DELAY_MS = 150;

const CURSOR_OPTIONS: { value: CursorMode; label: string }[] = [
  { value: 'one', label: '1 cursor' },
  { value: 'two', label: '2 cursors' },
];

/** Where the plotting area sits relative to the rail and the minimap, which both align to it. */
interface Area {
  rail: number;
  minimap: number;
  width: number;
}

/** Stacked signal lanes on one time axis, with A/B cursors, markers, a full-log minimap and a readout table. */
export function PlotView({ ctx }: ViewProps) {
  const { core, log, plots, pinnedTime, setPinnedTime } = ctx;
  const duration = log?.durationS ?? 0;
  const [mode, setMode] = useViewState<CursorMode>('plot.cursorMode', 'one');
  // Null shows the whole log.
  const [savedRange, setRange] = useViewState<Range | null>('plot.range', null, 'log');
  const [savedA, setCursorA] = useViewState<number | null>('plot.cursorA', null, 'log');
  const [savedB, setCursorB] = useViewState<number | null>('plot.cursorB', null, 'log');
  const [savedMarkers, setMarkers] = useViewState<Marker[]>('plot.markers', [], 'log');
  const [markerCount, setMarkerCount] = useViewState('plot.markerCount', 0, 'log');
  const [stackH, setStackH] = useState(0);
  const [area, setArea] = useState<Area | null>(null);
  const stackRef = useRef<HTMLDivElement>(null);
  const treeRef = useRef<HTMLElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const minimapRef = useRef<HTMLDivElement>(null);
  const lanePlots = useRef(new Map<string, uPlot>());
  /** The last time this view pinned, to tell its own echo from a pin set elsewhere. */
  const published = useRef<number | null>(null);
  const pinnedRef = useRef(pinnedTime);
  pinnedRef.current = pinnedTime;

  const hasPlots = plots.length > 0;
  // Saved state is stored apart from the log and can outlast it, so it is fitted to this log on read.
  const range = useMemo<Range>(() => (savedRange ? clampRange(savedRange, duration) : [0, duration]), [savedRange, duration]);
  const markers = useMemo(() => savedMarkers.filter((m) => m.time <= duration), [savedMarkers, duration]);
  // Cursors show while something is plotted, but are kept without: a reload restores the plots after this view mounts.
  const cursorA = hasPlots && savedA !== null ? clampTime(savedA, duration) : null;
  const cursorB = hasPlots && savedB !== null ? clampTime(savedB, duration) : null;
  const [t0, t1] = range;
  const span = t1 - t0;
  const b = mode === 'two' ? cursorB : null;

  // A starts at the shared pin if there is one.
  useLayoutEffect(() => {
    if (!hasPlots) return;
    if (savedA === null) setCursorA(pinnedTime ?? t0 + span / 3);
    if (mode === 'two' && savedB === null) setCursorB(t0 + (2 * span) / 3);
  }, [hasPlots, savedA, savedB, mode, pinnedTime, t0, span, setCursorA, setCursorB]);

  useEffect(() => {
    if (pinnedTime !== null && pinnedTime !== published.current) setCursorA(pinnedTime);
  }, [pinnedTime, setCursorA]);

  useEffect(() => {
    // Reading the pin through a ref: Escape clears it, and that shouldn't make A pin itself again.
    if (cursorA === null || cursorA === pinnedRef.current) return;
    const timer = window.setTimeout(() => {
      published.current = cursorA;
      setPinnedTime(cursorA);
    }, PIN_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [cursorA, setPinnedTime]);

  useEffect(() => {
    const el = stackRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setStackH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [hasPlots]);

  // Every lane has the same geometry, so any one of them locates the plotting area.
  const measure = useCallback(() => {
    const u = lanePlots.current.values().next().value;
    const rail = railRef.current;
    const minimap = minimapRef.current;
    if (!u || !rail || !minimap) return;
    const over = u.over.getBoundingClientRect();
    if (over.width === 0) return;
    const next = {
      rail: over.left - rail.getBoundingClientRect().left,
      minimap: over.left - minimap.getBoundingClientRect().left,
      width: over.width,
    };
    setArea((prev) => (prev && prev.rail === next.rail && prev.minimap === next.minimap && prev.width === next.width ? prev : next));
  }, []);

  const onPlot = useCallback(
    (id: string, u: uPlot | null) => {
      if (u) lanePlots.current.set(id, u);
      else lanePlots.current.delete(id);
      measure();
    },
    [measure],
  );

  useLayoutEffect(measure, [measure, plots.length]);

  const samples = useCursorSamples(core, plots, cursorA, b);
  const video = useVideo();

  // Until something is plotted, the next step is the view's own amber button.
  const { setViewPrimary } = ctx;
  useLayoutEffect(() => {
    setViewPrimary(!hasPlots);
    return () => setViewPrimary(null);
  }, [setViewPrimary, hasPlots]);

  if (!log) return null;

  const laneSpace = stackH - RAIL_H - STACK_CHROME_H - AXIS_H;
  const laneH = Math.max(MIN_LANE_H, Math.floor(laneSpace / Math.max(1, plots.length)));
  // Each lane after the first gives a pixel to the hairline above it.
  const plotHeight = laneH - LANE_HEAD_H - 1;
  const zoomed = t0 > 0 || t1 < duration;

  const moveCursor = (id: CursorId, t: number) => (id === 'a' ? setCursorA : setCursorB)(clampTime(t, duration));
  const pick = (t: number) => {
    const time = clampTime(t, duration);
    if (b !== null && cursorA !== null && Math.abs(time - b) < Math.abs(time - cursorA)) setCursorB(time);
    else setCursorA(time);
  };
  const changeMode = (next: CursorMode) => {
    setMode(next);
    if (next === 'two' && cursorB !== null && (cursorB < t0 || cursorB > t1)) setCursorB(t0 + (2 * span) / 3);
  };
  const resetZoom = () => setRange(null);
  const addMarker = () => {
    if (cursorA === null) return;
    const n = markerCount + 1;
    setMarkerCount(n);
    setMarkers((ms) => [...ms, { id: n, label: `M${n}`, time: cursorA }].sort((x, y) => x.time - y.time));
  };
  const removeMarker = (id: number) => setMarkers((ms) => ms.filter((m) => m.id !== id));

  const readout = (spec: PlotSpec, which: 'a' | 'b') => {
    const s = samples[spec.id]?.[which];
    return s ? withUnit(formatValue(s.value), spec.info.unit) : null;
  };

  const exportPng = () => {
    const lanes = plots.flatMap((spec) => {
      const u = lanePlots.current.get(spec.id);
      const parts = [readout(spec, 'a') && `A ${readout(spec, 'a')}`, b !== null && readout(spec, 'b') && `B ${readout(spec, 'b')}`];
      return u ? [{ u, spec, readout: parts.filter(Boolean).join('    ') }] : [];
    });
    const cursorsText = [
      cursorA !== null && `A ${formatSeconds(cursorA)}`,
      b !== null && `B ${formatSeconds(b)}`,
      cursorA !== null && b !== null && `\u0394t ${formatSeconds(b - cursorA)}`,
    ];
    ctx.run('Exporting PNG\u2026', () =>
      exportPlotPng({
        fileName: `${log.name.replace(/\.[^.]+$/, '')}-plot.png`,
        title: `${log.name} \u00b7 ${t0.toFixed(3)}\u2013${formatSeconds(t1)}`,
        subtitle: cursorsText.filter(Boolean).join('  \u00b7  '),
        lanes,
      }),
    );
  };

  // The signals are listed in the sidebar, so this shows it and moves there.
  const chooseSignals = () => {
    ctx.showSidebar();
    requestAnimationFrame(() => treeRef.current?.querySelector<HTMLElement>('button, input')?.focus());
  };
  const hasSignals = ctx.ids.some((s) => (ctx.messageOf(s.key)?.signals.length ?? 0) > 0);
  const noSignals = ctx.dbcs.length === 0 ? 'Signals come from a DBC, so open one first.' : 'No loaded DBC describes a message in this log. Open one that does.';

  const railCursors = [
    ...(cursorA !== null ? [{ id: 'a' as const, time: cursorA }] : []),
    ...(b !== null ? [{ id: 'b' as const, time: b }] : []),
  ];

  return (
    <>
      <SignalTree ctx={ctx} navRef={treeRef} />
      <VideoWorkspace logDuration={duration} cursor={cursorA} onCursor={(t) => moveCursor('a', t)}>
        {!hasPlots ? (
          <div className="pv-empty">
            <ChartLine className="pv-empty-icon" size={32} strokeWidth={1.5} aria-hidden="true" />
            <h2 className="pv-empty-title">Choose signals to plot</h2>
            <p className="pv-empty-hint">{hasSignals ? 'Pick signals from your DBC to compare them over time.' : noSignals}</p>
            <div className="pv-empty-actions">
              {hasSignals ? (
                <button className="primary" onClick={chooseSignals}>
                  Choose Signals
                </button>
              ) : (
                <button className="primary" onClick={ctx.openDbcPicker}>
                  Open DBC&hellip;
                </button>
              )}
              {/* A video lines up with a finished log, not one still being recorded. */}
              {!video && !ctx.capturing && <AddVideoButton log={log} />}
            </div>
          </div>
        ) : (
          <>
            <header className="content-header pv-header">
              <div className="pv-summary">
                <p className="content-sub pv-summary-text" title="Drag across a plot or scroll to zoom. Shift-scroll pans. Double-click resets.">
                  {plots.length} {plots.length === 1 ? 'signal' : 'signals'} &middot;{' '}
                  {zoomed ? `Showing ${formatDuration(span)} of ${formatDuration(duration)}` : `All ${formatDuration(duration)}`}
                </p>
                <button className="text-button" onClick={resetZoom} disabled={!zoomed} title="Or double-click a plot">
                  Reset Zoom
                </button>
              </div>
              <div className="content-actions">
                <Segmented label="Cursors" options={CURSOR_OPTIONS} value={mode} onChange={changeMode} />
                {!video && !ctx.capturing && <AddVideoButton log={log} />}
                <button className="button" onClick={addMarker} disabled={cursorA === null}>
                  <MapPin size={16} strokeWidth={1.5} aria-hidden="true" />
                  Add Marker
                </button>
                <button className="button" onClick={exportPng}>
                  <ImageDown size={16} strokeWidth={1.5} aria-hidden="true" />
                  Export PNG
                </button>
                <button className="text-button" onClick={ctx.clearPlots}>
                  Clear
                </button>
              </div>
            </header>
            <div className="pv-body">
              <div className="pv-stack" ref={stackRef}>
                <CursorRail
                  railRef={railRef}
                  area={area && { left: area.rail, width: area.width }}
                  range={range}
                  duration={duration}
                  cursors={railCursors}
                  onMove={moveCursor}
                />
                <div className="pv-lanes">
                  {plots.map((spec, i) => (
                    <Lane
                      key={spec.id}
                      core={core}
                      spec={spec}
                      range={range}
                      duration={duration}
                      plotHeight={plotHeight}
                      showTimeAxis={i === plots.length - 1}
                      showMarkerLabels={i === 0}
                      syncKey={SYNC_KEY}
                      cursorA={cursorA}
                      cursorB={b}
                      samples={samples[spec.id]}
                      markers={markers}
                      readoutA={readout(spec, 'a')}
                      readoutB={b !== null ? readout(spec, 'b') : null}
                      onZoom={setRange}
                      onResetZoom={resetZoom}
                      onPick={pick}
                      onRemove={() => ctx.removePlot(spec.id)}
                      onPlot={onPlot}
                      onLayout={measure}
                    />
                  ))}
                </div>
              </div>
              <Minimap
                core={core}
                spec={plots[0]}
                duration={duration}
                range={range}
                cursorA={cursorA}
                cursorB={b}
                markers={markers}
                rootRef={minimapRef}
                area={area && { left: area.minimap, width: area.width }}
                onRange={setRange}
              />
              <Readouts plots={plots} cursorA={cursorA} cursorB={b} samples={samples} markers={markers} onRemoveMarker={removeMarker} />
            </div>
          </>
        )}
      </VideoWorkspace>
    </>
  );
}
