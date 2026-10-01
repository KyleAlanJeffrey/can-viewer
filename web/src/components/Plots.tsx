import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { X } from 'lucide-react';
import type { CoreApi, SeriesInfo } from '../core/api';
import { cssVar, formatDuration, useFontsReady } from '../format';

export interface PlotSpec {
  /** `${idKey}:${signal}` */
  id: string;
  label: string;
  info: SeriesInfo;
  color: string;
}

type Range = [number, number];

const PLOT_H = 96;
const AXIS_H = 26;
/** A press that travels less than this many px is a click (pin), not a drag (zoom). */
const CLICK_SLOP = 3;

interface Props {
  core: CoreApi;
  specs: PlotSpec[];
  duration: number;
  /** Where the scrubber rests while the pointer is away from the plots. */
  pinnedTime: number | null;
  onPin: (time: number) => void;
  onRemove: (id: string) => void;
  onClear: () => void;
}

interface PointerState {
  /** Plot whose plotting area is under the pointer. */
  over: string | null;
  /** A press that began in a plot hasn't been released yet. */
  pressed: boolean;
}

const NO_POINTER: PointerState = { over: null, pressed: false };

/** With the pointer away from the plots, the scrubber is parked at the pin. */
const isParked = (p: PointerState) => p.over === null && !p.pressed;

/** Stacked single-signal plots sharing one time axis, cursor and zoom. */
export function Plots({ core, specs, duration, pinnedTime, onPin, onRemove, onClear }: Props) {
  const [range, setRange] = useState<Range>([0, duration]);
  useEffect(() => setRange([0, duration]), [duration]);
  // uPlot hooks read the ref synchronously; the state copy re-renders the plots.
  const pointerRef = useRef(NO_POINTER);
  const [pointer, setPointer] = useState(NO_POINTER);
  const updatePointer = useCallback((change: Partial<PointerState>) => {
    pointerRef.current = { ...pointerRef.current, ...change };
    setPointer(pointerRef.current);
  }, []);

  if (specs.length === 0) {
    return <p className="plots-hint">Select an ID, then tick Plot next to a signal to chart it here.</p>;
  }
  const zoomed = range[0] > 0 || range[1] < duration;
  return (
    <section className="plots-card" aria-label="Signal plots">
      <div className="plots-bar">
        <span className="range" title="Drag across a plot or scroll to zoom. Shift-scroll pans. Double-click resets.">
          {zoomed ? `Showing ${formatDuration(range[1] - range[0])} of ${formatDuration(duration)}` : `All ${formatDuration(duration)}`}
        </span>
        <button className="text-button" onClick={() => setRange([0, duration])} disabled={!zoomed}>
          Reset Zoom
        </button>
        <button className="text-button" onClick={onClear}>
          Clear
        </button>
      </div>
      {specs.map((spec, i) => (
        <Plot
          key={spec.id}
          core={core}
          spec={spec}
          range={range}
          duration={duration}
          setRange={setRange}
          showTimeAxis={i === specs.length - 1}
          pinnedTime={pinnedTime}
          onPin={onPin}
          pointer={pointer}
          pointerRef={pointerRef}
          onPointer={updatePointer}
          isTop={i === 0}
          onRemove={() => onRemove(spec.id)}
        />
      ))}
    </section>
  );
}

interface PlotProps {
  core: CoreApi;
  spec: PlotSpec;
  range: Range;
  duration: number;
  setRange: (r: Range) => void;
  showTimeAxis: boolean;
  pinnedTime: number | null;
  onPin: (time: number) => void;
  pointer: PointerState;
  pointerRef: RefObject<PointerState>;
  onPointer: (change: Partial<PointerState>) => void;
  /** The top plot carries the callout while the scrubber is parked. */
  isTop: boolean;
  onRemove: () => void;
}

interface Readout {
  value: string;
  time: string;
  /** Cursor position in the plot, or null when the readout isn't following the cursor. */
  left: number | null;
}

function Plot({
  core,
  spec,
  range,
  duration,
  setRange,
  showTimeAxis,
  pinnedTime,
  onPin,
  pointer,
  pointerRef,
  onPointer,
  isTop,
  onRemove,
}: PlotProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const [width, setWidth] = useState(0);
  const [readout, setReadout] = useState<Readout | null>(null);
  const fontsReady = useFontsReady();
  const latest = useRef({ range, duration, setRange, pinnedTime, onPin, onPointer });
  latest.current = { range, duration, setRange, pinnedTime, onPin, onPointer };
  const height = PLOT_H + (showTimeAxis ? AXIS_H : 0);
  const unit = spec.info.unit;
  const parked = isParked(pointer);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const font = `400 11px ${cssVar('--font-ui')}`;
    const grid = { stroke: cssVar('--gridline'), width: 1 };
    const u = new uPlot(
      {
        width: host.clientWidth,
        height,
        legend: { show: false },
        padding: [6, 0, showTimeAxis ? 0 : 4, 14],
        scales: { x: { time: false, range: () => latest.current.range } },
        series: [
          {},
          {
            label: spec.info.name,
            stroke: spec.color,
            width: 1.5,
            points: { show: false },
          },
        ],
        axes: [
          showTimeAxis
            ? { stroke: cssVar('--slate'), font, grid, ticks: { show: false }, size: AXIS_H, values: (_, ticks, _axis, _space, step) => ticks.map((t) => formatTick(t, step)) }
            : { grid, ticks: { show: false }, size: 0, values: (_, ticks) => ticks.map(() => '') },
          { side: 1, stroke: cssVar('--slate'), font, grid, ticks: { show: false }, size: 52, space: 24 },
        ],
        cursor: {
          sync: { key: 'plots' },
          drag: { x: true, y: false, setScale: false },
          points: { size: 7, width: 2, fill: spec.color, stroke: cssVar('--paper') },
        },
        hooks: {
          // Without a cursor the readout shows the last value in view.
          setData: [
            (self) => {
              const left = self.cursor.left;
              if (left == null || left < 0) setReadout(readoutAt(self, self.data[0].length - 1, null, unit));
            },
          ],
          // A zoom or resize moves the pinned time on screen.
          draw: [
            (self) => {
              if (isParked(pointerRef.current)) setReadout(park(self, latest.current.pinnedTime, unit));
            },
          ],
          setCursor: [
            (self) => {
              if (isParked(pointerRef.current)) {
                setReadout(park(self, latest.current.pinnedTime, unit));
                return;
              }
              const left = self.cursor.left;
              const inside = left != null && left >= 0;
              setReadout(readoutAt(self, inside ? self.cursor.idx : self.data[0].length - 1, inside ? left : null, unit));
            },
          ],
          setSelect: [
            (self) => {
              if (self.select.width >= CLICK_SLOP) {
                const a = self.posToVal(self.select.left, 'x');
                const b = self.posToVal(self.select.left + self.select.width, 'x');
                latest.current.setRange(clampRange([a, b], latest.current.duration));
              }
              self.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false);
            },
          ],
        },
      },
      [new Float64Array(0), new Float64Array(0)],
      host,
    );
    plotRef.current = u;

    // offsetX is relative to whichever child was hit (the cursor line or point), so measure from the overlay.
    const overX = (e: MouseEvent) => e.clientX - u.over.getBoundingClientRect().left;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const { range: [t0, t1], duration: d, setRange: set } = latest.current;
      const span = t1 - t0;
      const pan = e.shiftKey ? e.deltaY : Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : 0;
      if (pan !== 0) {
        const shift = (pan / u.over.clientWidth) * span;
        set(clampRange([t0 + shift, t1 + shift], d));
      } else {
        const at = u.posToVal(overX(e), 'x');
        const f = Math.exp(e.deltaY * 0.002);
        set(clampRange([at - (at - t0) * f, at + (t1 - at) * f], d));
      }
    };
    const onDblClick = () => latest.current.setRange([0, latest.current.duration]);
    // Pointer boundary events fire before uPlot's mouse ones, so its hooks already see the change.
    const onEnter = () => latest.current.onPointer({ over: spec.id });
    const onLeave = () => latest.current.onPointer({ over: null });
    const onMouseDown = (down: MouseEvent) => {
      if (down.button !== 0) return;
      latest.current.onPointer({ pressed: true });
      // On window this runs after uPlot's mouseup on document, once every plot has ended the drag.
      const onMouseUp = (up: MouseEvent) => {
        if (Math.hypot(up.clientX - down.clientX, up.clientY - down.clientY) < CLICK_SLOP) {
          latest.current.onPin(u.posToVal(overX(down), 'x'));
        }
        latest.current.onPointer({ pressed: false });
      };
      window.addEventListener('mouseup', onMouseUp, { once: true });
    };
    u.over.addEventListener('wheel', onWheel, { passive: false });
    u.over.addEventListener('dblclick', onDblClick);
    u.over.addEventListener('pointerenter', onEnter);
    u.over.addEventListener('pointerleave', onLeave);
    u.over.addEventListener('mousedown', onMouseDown);

    const ro = new ResizeObserver(([entry]) => {
      const w = Math.floor(entry.contentRect.width);
      if (w > 0 && w !== u.width) u.setSize({ width: w, height });
      setWidth(w);
    });
    ro.observe(host);
    return () => {
      ro.disconnect();
      u.destroy();
      plotRef.current = null;
      // A plot removed from under the pointer never sees pointerleave.
      if (pointerRef.current.over === spec.id) latest.current.onPointer({ over: null });
    };
  }, [spec.id, spec.info, spec.color, height, showTimeAxis, unit, fontsReady, pointerRef]);

  useEffect(() => {
    const u = plotRef.current;
    if (u && parked) setReadout(park(u, pinnedTime, unit));
  }, [parked, pinnedTime, unit]);

  useEffect(() => {
    const u = plotRef.current;
    if (!u || width === 0) return;
    let stale = false;
    core.seriesView(spec.info.handle, range[0], range[1], width).then(([x, y]) => {
      if (stale) return;
      u.setData([x, y]);
    });
    return () => {
      stale = true;
    };
  }, [core, spec.info.handle, range, width, height]);

  const plotWidth = plotRef.current?.over.clientWidth ?? 0;
  return (
    <div className="plot">
      <div className="plot-head">
        <span className="dot" style={{ background: spec.color }} />
        <span className="plot-name" title={spec.label}>
          {spec.info.name}
          {unit && <span className="unit"> ({unit})</span>}
        </span>
        <button className="icon-button small remove" onClick={onRemove} aria-label={`Remove ${spec.label}`}>
          <X size={14} strokeWidth={1.75} />
        </button>
        <span className="readout" aria-live="off">
          {readout?.value ?? ''}
        </span>
      </div>
      <div className="plot-host" ref={hostRef}>
        {readout && readout.left !== null && (parked ? isTop : pointer.over === spec.id) && (
          <span className={`callout${readout.left > plotWidth * 0.66 ? ' flip' : ''}`} style={{ left: readout.left }}>
            {readout.time} &middot; {readout.value}
          </span>
        )}
      </div>
    </div>
  );
}

function readoutAt(u: uPlot, i: number | null | undefined, left: number | null, unit: string): Readout | null {
  if (i == null || i < 0) return null;
  const x = u.data[0][i];
  const y = u.data[1][i];
  if (x == null || y == null) return null;
  return { value: `${formatValue(y)}${unit ? ` ${unit}` : ''}`, time: `${x.toFixed(3)} s`, left };
}

/** Puts the cursor at the pinned time, or hides it when that's out of view, and returns the readout to show. */
function park(u: uPlot, time: number | null, unit: string): Readout | null {
  const { min, max } = u.scales.x;
  // fireHook false: the setCursor hook parks too, so firing it would recurse.
  if (time == null || min == null || max == null || time < min || time > max) {
    u.setCursor({ left: -10, top: -10 }, false);
    return readoutAt(u, u.data[0].length - 1, null, unit);
  }
  const left = u.valToPos(time, 'x');
  u.setCursor({ left, top: 0 }, false);
  const readout = readoutAt(u, u.cursor.idx, left, unit);
  // Label the pinned time itself, so it matches the selected trace row rather than the
  // nearest downsampled point.
  return readout && { ...readout, time: `${time.toFixed(3)} s` };
}

function clampRange([a, b]: Range, duration: number): Range {
  const span = Math.min(duration, Math.max(1e-6, b - a));
  let t0 = Math.max(0, Math.min(a, duration - span));
  if (!Number.isFinite(t0)) t0 = 0;
  return [t0, t0 + span];
}

/** Whole minutes only while ticks are at least a minute apart; closer than that, seconds to the tick's precision. */
function formatTick(t: number, step: number): string {
  if (step >= 60) {
    const minutes = Math.round(t / 60);
    return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`;
  }
  // Steps run 1-2-2.5-5 per decade, so 2.5 or 0.25 needs one more place than the decade suggests.
  const decimals = (String(Number(step.toFixed(6))).split('.')[1] ?? '').length;
  return `${t.toFixed(decimals)} s`;
}

const valueFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

function formatValue(v: number): string {
  return Math.abs(v) >= 1e4 ? valueFormat.format(Math.round(v)) : valueFormat.format(Number(v.toPrecision(6)));
}
