import { useEffect, useRef, useState } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { X } from 'lucide-react';
import type { CoreApi } from '../../core/api';
import type { PlotSpec } from '../../components/Plots';
import { cssVar, useFontsReady } from '../../format';
import { isolatedDots, withGaps } from '../../plotGaps';
import { clampRange, formatTick, formatYTick, type LaneSamples, type Marker, type Range } from './model';

export const LANE_HEAD_H = 24;
export const AXIS_H = 26;
const PAD_LEFT = 12;
const Y_AXIS_W = 52;
/** A press that travels less than this many px is a click (move a cursor), not a drag (zoom). */
const CLICK_SLOP = 3;
/** Zooming and panning settle for this long before decimated data is fetched again. */
const REFETCH_DELAY_MS = 80;
/** A touch drag narrower than this many px zooms nothing. */
const TOUCH_ZOOM_MIN = 12;

/** What a touch drag across the plot does: move the nearest cursor, or zoom to its span. Null leaves it to scroll. */
export type TouchMode = 'move' | 'zoom' | null;

interface Props {
  core: CoreApi;
  spec: PlotSpec;
  range: Range;
  duration: number;
  /** Height of the plotting canvas, without the head or the time axis. */
  plotHeight: number;
  showTimeAxis: boolean;
  /** Marker labels go on the top lane only. */
  showMarkerLabels: boolean;
  syncKey: string;
  cursorA: number | null;
  cursorB: number | null;
  samples: LaneSamples | undefined;
  markers: Marker[];
  /** Values at A and B for the head, already formatted. */
  readoutA: string | null;
  readoutB: string | null;
  onZoom: (range: Range) => void;
  onResetZoom: () => void;
  /** A click in the plot, at this time. */
  onPick: (time: number) => void;
  onRemove: () => void;
  /** Hands over this lane's uPlot (null on teardown), for measuring and export. */
  onPlot: (id: string, u: uPlot | null) => void;
  /** The plotting area moved or resized. */
  onLayout: () => void;
  touchMode?: TouchMode;
  /** Where the signal comes from, under its name, as on phones. */
  source?: string;
}

interface OverlayStyle {
  graphite: string;
  slate: string;
  paper: string;
  font: string;
}

/** One plotted signal on the shared time axis, with the cursors, markers and intersection dots drawn over it. */
export function Lane(props: Props) {
  const { core, spec, range, plotHeight, showTimeAxis, cursorA, cursorB, samples, markers, showMarkerLabels, readoutA, readoutB, onRemove, source } = props;
  const hostRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const [plotWidth, setPlotWidth] = useState(0);
  const [generation, setGeneration] = useState(0);
  const fontsReady = useFontsReady();
  const height = plotHeight + (showTimeAxis ? AXIS_H : 0);
  // uPlot hooks and DOM listeners outlive renders; they read the current props from here.
  const latest = useRef({ props, height });
  latest.current = { props, height };
  const { name, unit } = spec.info;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const style: OverlayStyle = {
      graphite: cssVar('--graphite'),
      slate: cssVar('--slate'),
      paper: cssVar('--paper'),
      font: cssVar('--font-ui'),
    };
    const font = `400 11px ${style.font}`;
    const grid = { stroke: cssVar('--gridline'), width: 1 };
    const u = new uPlot(
      {
        width: host.clientWidth,
        height: latest.current.height,
        legend: { show: false },
        padding: [8, 0, showTimeAxis ? 0 : 6, PAD_LEFT],
        scales: { x: { time: false, range: () => latest.current.props.range } },
        series: [{}, { label: name, stroke: spec.color, width: 1.5, points: isolatedDots(spec.color) }],
        axes: [
          showTimeAxis
            ? {
                stroke: cssVar('--slate'),
                font,
                grid,
                ticks: { show: false },
                size: AXIS_H,
                values: (_u, ticks, _axis, _space, step) => ticks.map((t) => formatTick(t, step)),
              }
            : { grid, ticks: { show: false }, size: 0, values: (_u, ticks) => ticks.map(() => '') },
          {
            side: 1,
            stroke: style.graphite,
            font,
            grid,
            ticks: { show: false },
            size: Y_AXIS_W,
            space: 24,
            values: (_u, ticks, _axis, _space, step) => ticks.map((v) => formatYTick(v, step)),
          },
        ],
        cursor: {
          sync: { key: latest.current.props.syncKey },
          y: false,
          drag: { x: true, y: false, setScale: false },
          points: { show: false },
        },
        hooks: {
          setSelect: [
            (self) => {
              if (self.select.width >= CLICK_SLOP) {
                const a = self.posToVal(self.select.left, 'x');
                const b = self.posToVal(self.select.left + self.select.width, 'x');
                latest.current.props.onZoom(clampRange([a, b], latest.current.props.duration));
              }
              self.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false);
            },
          ],
          draw: [(self) => drawOverlay(self, latest.current.props, style)],
          setSize: [() => latest.current.props.onLayout()],
        },
      },
      [new Float64Array(0), new Float64Array(0)],
      host,
    );
    plotRef.current = u;
    latest.current.props.onPlot(spec.id, u);
    setGeneration((g) => g + 1);

    // offsetX is relative to whichever child was hit, so measure from the overlay.
    const overX = (e: MouseEvent) => e.clientX - u.over.getBoundingClientRect().left;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const {
        range: [t0, t1],
        duration,
        onZoom,
      } = latest.current.props;
      const span = t1 - t0;
      const pan = e.shiftKey ? e.deltaY : Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : 0;
      if (pan !== 0) {
        const shift = (pan / u.over.clientWidth) * span;
        onZoom(clampRange([t0 + shift, t1 + shift], duration));
      } else {
        const at = u.posToVal(overX(e), 'x');
        const f = Math.exp(e.deltaY * 0.002);
        onZoom(clampRange([at - (at - t0) * f, at + (t1 - at) * f], duration));
      }
    };
    const onDblClick = () => latest.current.props.onResetZoom();
    const onMouseDown = (down: MouseEvent) => {
      if (down.button !== 0) return;
      const at = u.posToVal(overX(down), 'x');
      const onMouseUp = (up: MouseEvent) => {
        if (Math.hypot(up.clientX - down.clientX, up.clientY - down.clientY) < CLICK_SLOP) latest.current.props.onPick(at);
      };
      window.addEventListener('mouseup', onMouseUp, { once: true });
    };
    // uPlot follows the mouse only, so a finger scrolls the page past the plot unless a touch mode is on.
    const onPointerDown = (down: PointerEvent) => {
      const mode = latest.current.props.touchMode;
      if (down.pointerType === 'mouse' || !mode) return;
      // Stops the emulated mouse events, so a tap while zooming doesn't also move cursor A.
      down.preventDefault();
      u.over.setPointerCapture(down.pointerId);
      const xOf = (e: PointerEvent) => Math.max(0, Math.min(u.over.clientWidth, overX(e)));
      const startX = xOf(down);
      if (mode === 'move') latest.current.props.onPick(u.posToVal(startX, 'x'));
      const onMove = (e: PointerEvent) => {
        const x = xOf(e);
        if (mode === 'move') latest.current.props.onPick(u.posToVal(x, 'x'));
        else u.setSelect({ left: Math.min(startX, x), width: Math.abs(x - startX), top: 0, height: u.over.clientHeight }, false);
      };
      const onEnd = (e: PointerEvent) => {
        u.over.removeEventListener('pointermove', onMove);
        u.over.removeEventListener('pointerup', onEnd);
        u.over.removeEventListener('pointercancel', onEnd);
        if (mode !== 'zoom') return;
        u.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false);
        const x = xOf(e);
        if (e.type !== 'pointerup' || Math.abs(x - startX) < TOUCH_ZOOM_MIN) return;
        const range: Range = [u.posToVal(Math.min(startX, x), 'x'), u.posToVal(Math.max(startX, x), 'x')];
        latest.current.props.onZoom(clampRange(range, latest.current.props.duration));
      };
      u.over.addEventListener('pointermove', onMove);
      u.over.addEventListener('pointerup', onEnd);
      u.over.addEventListener('pointercancel', onEnd);
    };
    u.over.addEventListener('wheel', onWheel, { passive: false });
    u.over.addEventListener('dblclick', onDblClick);
    u.over.addEventListener('mousedown', onMouseDown);
    u.over.addEventListener('pointerdown', onPointerDown);

    const ro = new ResizeObserver(([entry]) => {
      const w = Math.floor(entry.contentRect.width);
      if (w <= 0) return;
      if (w !== u.width) u.setSize({ width: w, height: latest.current.height });
      setPlotWidth(Math.max(1, w - PAD_LEFT - Y_AXIS_W));
    });
    ro.observe(host);
    return () => {
      ro.disconnect();
      u.destroy();
      plotRef.current = null;
      latest.current.props.onPlot(spec.id, null);
    };
  }, [spec.id, spec.color, name, showTimeAxis, fontsReady]);

  useEffect(() => {
    const u = plotRef.current;
    if (u && u.height !== height) u.setSize({ width: u.width, height });
  }, [height, generation]);

  useEffect(() => {
    const u = plotRef.current;
    if (!u || plotWidth === 0) return;
    const [t0, t1] = range;
    // Rescale what's already loaded at once; fetch the new view once the zoom settles.
    u.setScale('x', { min: t0, max: t1 });
    let stale = false;
    const fetchView = () =>
      core.seriesView(spec.info.handle, t0, t1, plotWidth).then(([x, y]) => {
        if (!stale && plotRef.current === u) u.setData([x, withGaps(y)]);
      });
    const timer = window.setTimeout(fetchView, u.data[0].length === 0 ? 0 : REFETCH_DELAY_MS);
    return () => {
      stale = true;
      window.clearTimeout(timer);
    };
  }, [core, spec.info.handle, range, plotWidth, generation]);

  useEffect(() => {
    plotRef.current?.redraw(false);
  }, [cursorA, cursorB, samples, markers, showMarkerLabels]);

  return (
    <div className={source ? 'pv-lane with-source' : 'pv-lane'} role="group" aria-label={unit ? `${name} (${unit})` : name}>
      <div className="pv-lane-head">
        <span className="pv-dot" style={{ background: spec.color }} aria-hidden="true" />
        <span className="pv-lane-name" title={spec.label}>
          {name}
        </span>
        {unit && <span className="pv-lane-unit">({unit})</span>}
        <button className="icon-button small pv-lane-remove" onClick={onRemove} aria-label={`Remove ${spec.label}`}>
          <X size={14} strokeWidth={1.75} />
        </button>
        {source && <span className="pv-lane-source">{source}</span>}
        {/* The readout table carries these for assistive tech. */}
        <span className="pv-lane-readout" aria-hidden="true">
          {readoutA !== null && (
            <span>
              <span className="pv-key">A</span>
              {readoutA}
            </span>
          )}
          {readoutB !== null && (
            <span>
              <span className="pv-key">B</span>
              {readoutB}
            </span>
          )}
        </span>
      </div>
      <div className="pv-lane-host" ref={hostRef} />
    </div>
  );
}

/** Markers, cursor lines and the cursor intersection dots, in canvas pixels so they export with the plot. */
function drawOverlay(u: uPlot, p: Props, style: OverlayStyle) {
  const { left, top, width, height } = u.bbox;
  if (width <= 0 || height <= 0) return;
  const ctx = u.ctx;
  const px = uPlot.pxRatio;
  const right = left + width;
  const bottom = top + height;
  const lineWidth = Math.max(1, Math.round(px));
  // An odd line width needs a half-pixel offset to stay crisp.
  const snap = (x: number) => Math.round(x) + (lineWidth % 2 ? 0.5 : 0);
  const xOf = (t: number) => u.valToPos(t, 'x', true);
  const inView = (x: number) => x >= left - 0.5 && x <= right + 0.5;
  const vline = (x: number, color: string, dash: number[]) => {
    ctx.strokeStyle = color;
    ctx.setLineDash(dash);
    ctx.beginPath();
    ctx.moveTo(snap(x), top);
    ctx.lineTo(snap(x), bottom);
    ctx.stroke();
  };

  // save/restore also keeps uPlot's cached canvas state (font, stroke) truthful.
  ctx.save();
  ctx.lineWidth = lineWidth;
  for (const m of p.markers) {
    const x = xOf(m.time);
    if (inView(x)) vline(x, style.slate, [4 * px, 3 * px]);
  }
  const cursors = [
    { time: p.cursorA, color: style.graphite, sample: p.samples?.a ?? null },
    { time: p.cursorB, color: style.slate, sample: p.samples?.b ?? null },
  ];
  for (const c of cursors) {
    if (c.time === null) continue;
    const x = xOf(c.time);
    if (inView(x)) vline(x, c.color, []);
  }

  if (p.showMarkerLabels) {
    ctx.font = `500 ${11 * px}px ${style.font}`;
    ctx.textBaseline = 'top';
    for (const m of p.markers) {
      const x = xOf(m.time);
      if (!inView(x)) continue;
      const w = ctx.measureText(m.label).width + 8 * px;
      // Flip to the left of the line rather than run into the y axis.
      const lx = x + 3 * px + w > right ? x - 3 * px - w : x + 3 * px;
      ctx.fillStyle = style.paper;
      ctx.fillRect(lx, top + 2 * px, w, 15 * px);
      ctx.fillStyle = style.slate;
      ctx.fillText(m.label, lx + 4 * px, top + 4 * px);
    }
  }

  for (const c of cursors) {
    if (c.time === null || !c.sample) continue;
    const x = xOf(c.time);
    const y = u.valToPos(c.sample.onLine, 'y', true);
    if (!inView(x) || !Number.isFinite(y) || y < top - 1 || y > bottom + 1) continue;
    ctx.beginPath();
    ctx.arc(x, y, 4.5 * px, 0, 2 * Math.PI);
    ctx.fillStyle = style.paper;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, y, 3.5 * px, 0, 2 * Math.PI);
    ctx.fillStyle = p.spec.color;
    ctx.fill();
  }
  ctx.restore();
}
