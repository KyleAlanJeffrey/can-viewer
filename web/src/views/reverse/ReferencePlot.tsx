import { useEffect, useMemo, useRef, useState } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { cssVar, useFontsReady } from '../../format';
import { aligned, isolatedDots, withGaps } from '../../plotGaps';
import { formatTick, formatYTick } from '../plot/model';
import { formatSeconds, pointAt, type TimeWindow, type Trace } from './bits';

export const REF_PLOT_H = 56;
export const REF_AXIS_H = 26;
const Y_AXIS_W = 48;
const PAD_LEFT = 8;

interface Props {
  trace: Trace | null;
  color: string;
  /** Draw the main line dashed, for a candidate that isn't a reference. */
  dashed?: boolean;
  /** A second line in dashed graphite on this plot's value scale. */
  overlay?: Trace | null;
  window: TimeWindow;
  cursor: number | null;
  /** A fixed value scale; null fits the data. */
  range: [number, number] | null;
  showTimeAxis: boolean;
  /** Label the cursor's time above this plot; only the top plot does. */
  showCursorTime: boolean;
  /** Names the plot for assistive technology. */
  label: string;
  onHover: (t: number | null) => void;
  onPark: (t: number) => void;
  /** The plotting area's width in px, for fetching a view at the right resolution. */
  onWidth?: (w: number) => void;
}

interface Marks {
  line: HTMLDivElement;
  dots: HTMLDivElement[];
  flag: HTMLDivElement | null;
}

/**
 * One reference on the shared time axis: a thin line, value labels on the right, and the shared
 * cursor as a line with a dot where it crosses the trace. The cursor is DOM over the canvas, so
 * moving it never redraws the plot.
 */
export function ReferencePlot({ trace, color, dashed = false, overlay, window: win, cursor, range, showTimeAxis, showCursorTime, label, onHover, onPark, onWidth }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const marksRef = useRef<Marks | null>(null);
  const [generation, setGeneration] = useState(0);
  // Cursor marks are placed in pixels, so they move when the plot is resized.
  const [plotWidth, setPlotWidth] = useState(0);
  // uPlot rescales a tick after new data, so marks placed before then would use the old scales.
  const [rescaled, setRescaled] = useState(0);
  const fontsReady = useFontsReady();
  const hasOverlay = !!overlay;
  // uPlot callbacks and DOM listeners outlive renders; they read the current props from here.
  const latest = useRef({ win, range, onHover, onPark, onWidth });
  latest.current = { win, range, onHover, onPark, onWidth };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const font = `400 11px ${cssVar('--font-ui')}`;
    const grid = { stroke: cssVar('--gridline'), width: 1 };
    const graphite = cssVar('--graphite');
    const u = new uPlot(
      {
        width: Math.max(1, host.clientWidth),
        height: REF_PLOT_H + (showTimeAxis ? REF_AXIS_H : 0),
        legend: { show: false },
        padding: [6, 0, showTimeAxis ? 0 : 4, PAD_LEFT],
        scales: {
          x: { time: false, range: () => latest.current.win },
          y: {
            range: (_u, min, max) => {
              if (latest.current.range) return latest.current.range;
              if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
              return min === max ? [min - 1, max + 1] : uPlot.rangeNum(min, max, 0.1, true);
            },
          },
        },
        series: [
          {},
          { width: 1.5, stroke: color, dash: dashed ? [4, 3] : undefined, points: isolatedDots(color) },
          ...(hasOverlay ? [{ width: 1.25, stroke: graphite, dash: [4, 3], points: isolatedDots(graphite) }] : []),
        ],
        axes: [
          showTimeAxis
            ? {
                stroke: cssVar('--slate'),
                font,
                grid,
                ticks: { show: false },
                size: REF_AXIS_H,
                values: (_u, ticks, _axis, _space, step) => ticks.map((t) => formatTick(t, step)),
              }
            : { grid, ticks: { show: false }, size: 0, values: (_u, ticks) => ticks.map(() => '') },
          {
            side: 1,
            stroke: cssVar('--slate'),
            font,
            grid,
            ticks: { show: false },
            size: Y_AXIS_W,
            space: 20,
            values: (_u, ticks, _axis, _space, step) => ticks.map((v) => formatYTick(v, step)),
          },
        ],
        cursor: { show: false },
        hooks: { setScale: [() => setRescaled((n) => n + 1)] },
      },
      [new Float64Array(0), new Float64Array(0)],
      host,
    );
    plotRef.current = u;

    const mark = (className: string) => {
      const el = document.createElement('div');
      el.className = className;
      el.hidden = true;
      u.over.appendChild(el);
      return el;
    };
    marksRef.current = {
      line: mark('re-cursor-line'),
      dots: [mark('re-cursor-dot'), ...(hasOverlay ? [mark('re-cursor-dot overlay')] : [])],
      flag: showCursorTime ? mark('re-cursor-flag') : null,
    };
    marksRef.current.dots[0].style.background = color;

    const timeAt = (e: MouseEvent) => u.posToVal(e.clientX - u.over.getBoundingClientRect().left, 'x');
    const onMove = (e: MouseEvent) => latest.current.onHover(timeAt(e));
    const onLeave = () => latest.current.onHover(null);
    const onClick = (e: MouseEvent) => latest.current.onPark(timeAt(e));
    u.over.addEventListener('mousemove', onMove);
    u.over.addEventListener('mouseleave', onLeave);
    u.over.addEventListener('click', onClick);

    const ro = new ResizeObserver(([entry]) => {
      const w = Math.floor(entry.contentRect.width);
      if (w <= 0) return;
      if (w !== u.width) {
        u.setSize({ width: w, height: u.height });
        setPlotWidth(w);
      }
      latest.current.onWidth?.(Math.max(1, w - PAD_LEFT - Y_AXIS_W));
    });
    ro.observe(host);
    setGeneration((g) => g + 1);
    return () => {
      ro.disconnect();
      u.destroy();
      plotRef.current = null;
      marksRef.current = null;
    };
  }, [color, dashed, hasOverlay, showTimeAxis, showCursorTime, fontsReady]);

  const data = useMemo<uPlot.AlignedData>(() => {
    if (!trace) return [new Float64Array(0), new Float64Array(0)];
    if (!overlay) return [trace.x as number[], withGaps(trace.y as number[])];
    return aligned(trace, overlay);
  }, [trace, overlay]);

  useEffect(() => {
    plotRef.current?.setData(data);
  }, [data, generation]);

  useEffect(() => {
    plotRef.current?.setScale('x', { min: win[0], max: win[1] });
  }, [win, generation]);

  useEffect(() => {
    const u = plotRef.current;
    const marks = marksRef.current;
    if (!u || !marks) return;
    const shown = cursor !== null && cursor >= win[0] && cursor <= win[1];
    marks.line.hidden = !shown;
    if (marks.flag) marks.flag.hidden = !shown;
    marks.dots.forEach((d) => (d.hidden = true));
    if (!shown) return;
    const x = u.valToPos(cursor, 'x');
    marks.line.style.transform = `translateX(${x}px)`;
    if (marks.flag) {
      marks.flag.textContent = formatSeconds(cursor);
      const w = marks.flag.offsetWidth;
      marks.flag.style.transform = `translateX(${Math.min(Math.max(0, x - w / 2), Math.max(0, u.over.clientWidth - w))}px)`;
    }
    [trace, overlay].forEach((t, i) => {
      const dot = marks.dots[i];
      if (!dot || !t) return;
      const p = pointAt(t, cursor);
      if (!p) return;
      const y = u.valToPos(p.v, 'y');
      if (!Number.isFinite(y)) return;
      dot.hidden = false;
      dot.style.transform = `translate(${x}px, ${y}px)`;
    });
  }, [cursor, win, trace, overlay, data, generation, plotWidth, rescaled]);

  return <div className="re-ref-plot" ref={hostRef} role="img" aria-label={label} />;
}

/**
 * The shared time axis, apart from the plots so it stays in view while they scroll. Laid out
 * like a plot, so its ticks line up with their grid lines.
 */
export function TimeAxis({ window: win }: { window: TimeWindow }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const fontsReady = useFontsReady();
  const latest = useRef(win);
  latest.current = win;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const u = new uPlot(
      {
        width: Math.max(1, host.clientWidth),
        height: REF_AXIS_H,
        legend: { show: false },
        padding: [0, 0, 0, PAD_LEFT],
        // An empty value scale still needs a range, or uPlot drops the value axis the plots line up with.
        scales: { x: { time: false, range: () => latest.current }, y: { range: () => [0, 1] } },
        series: [{}, {}],
        axes: [
          {
            stroke: cssVar('--slate'),
            font: `400 11px ${cssVar('--font-ui')}`,
            grid: { show: false },
            ticks: { show: false },
            size: REF_AXIS_H,
            values: (_u, ticks, _axis, _space, step) => ticks.map((t) => formatTick(t, step)),
          },
          { side: 1, grid: { show: false }, ticks: { show: false }, size: Y_AXIS_W, values: (_u, ticks) => ticks.map(() => '') },
        ],
        cursor: { show: false },
      },
      [new Float64Array(0), new Float64Array(0)],
      host,
    );
    plotRef.current = u;
    const ro = new ResizeObserver(([entry]) => {
      const w = Math.floor(entry.contentRect.width);
      if (w > 0 && w !== u.width) u.setSize({ width: w, height: u.height });
    });
    ro.observe(host);
    return () => {
      ro.disconnect();
      u.destroy();
      plotRef.current = null;
    };
  }, [fontsReady]);

  useEffect(() => {
    plotRef.current?.setScale('x', { min: win[0], max: win[1] });
  }, [win, fontsReady]);

  return <div className="re-ref-axis" ref={hostRef} />;
}
