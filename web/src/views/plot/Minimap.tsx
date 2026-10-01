import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';
import type { CoreApi } from '../../core/api';
import type { PlotSpec } from '../../components/Plots';
import { cssVar, formatDuration } from '../../format';
import { clampRange, formatSeconds, formatTick, niceStep, type Marker, type PlotArea, type Range } from './model';

const TRACK_H = 32;
const TICK_LEN = 7;
/** The window never draws narrower than this, however far in the lanes zoom. */
const MIN_WINDOW_PX = 6;
/** Narrower than this, the window only pans: its edges would leave nothing to grab in between. */
const EDGE_MIN_PX = 18;
const LABEL_GAP_PX = 90;
const REFETCH_DELAY_MS = 100;

interface Props {
  core: CoreApi;
  /** The signal drawn in the overview: the first one plotted. */
  spec: PlotSpec;
  duration: number;
  range: Range;
  cursorA: number | null;
  cursorB: number | null;
  markers: Marker[];
  rootRef: RefObject<HTMLDivElement | null>;
  /** The lanes' plotting area, relative to the minimap, so both share one horizontal frame. */
  area: PlotArea | null;
  onRange: (range: Range) => void;
}

interface Drag {
  kind: 'pan' | 'start' | 'end';
  originX: number;
  origin: Range;
}

interface Overview {
  handle: number;
  x: Float64Array;
  y: Float64Array;
}

/** The whole log at a glance, with the zoomed window as a draggable, resizable rectangle. */
export function Minimap({ core, spec, duration, range, cursorA, cursorB, markers, rootRef, area, onRange }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const windowRef = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const fetchedFor = useRef<number | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const width = area ? Math.max(0, Math.round(area.width)) : 0;
  const { handle, min, max } = spec.info;
  const [t0, t1] = range;

  useEffect(() => {
    if (width === 0 || duration <= 0) return;
    let stale = false;
    const timer = window.setTimeout(
      () =>
        core.seriesView(handle, 0, duration, width).then(([x, y]) => {
          if (stale) return;
          fetchedFor.current = handle;
          setOverview({ handle, x, y });
        }),
      fetchedFor.current === handle ? REFETCH_DELAY_MS : 0,
    );
    return () => {
      stale = true;
      window.clearTimeout(timer);
    };
  }, [core, handle, duration, width]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx || width === 0 || duration <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(TRACK_H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = cssVar('--plot-paper');
    ctx.fillRect(0, 0, width, TRACK_H);
    const xOf = (t: number) => (t / duration) * width;

    if (overview && overview.handle === handle && overview.x.length > 0 && min !== null && max !== null) {
      const lo = min;
      const hi = max > min ? max : min + 1;
      const yOf = (v: number) => TRACK_H - 4 - ((v - lo) / (hi - lo)) * (TRACK_H - 8);
      ctx.strokeStyle = spec.color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(xOf(overview.x[0]), yOf(overview.y[0]));
      for (let i = 1; i < overview.x.length; i++) ctx.lineTo(xOf(overview.x[i]), yOf(overview.y[i]));
      ctx.stroke();
    }

    ctx.strokeStyle = cssVar('--slate');
    ctx.setLineDash([3, 3]);
    for (const m of markers) {
      const x = Math.round(xOf(m.time)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, TRACK_H);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    const ticks: [number | null, string][] = [
      [cursorA, cssVar('--graphite')],
      [cursorB, cssVar('--slate')],
    ];
    for (const [t, color] of ticks) {
      if (t === null) continue;
      const x = Math.round(xOf(t)) - 1;
      ctx.fillStyle = color;
      ctx.fillRect(x, 0, 2, TICK_LEN);
      ctx.fillRect(x, TRACK_H - TICK_LEN, 2, TICK_LEN);
    }
  }, [overview, handle, min, max, spec.color, width, duration, cursorA, cursorB, markers]);

  const axis = useMemo(() => {
    if (width === 0 || duration <= 0) return { step: 1, ticks: [] as number[] };
    const step = niceStep(duration, width, LABEL_GAP_PX);
    const ticks: number[] = [];
    // Stop short of the end label rather than collide with it.
    for (let k = 0; k * step < duration && ((duration - k * step) / duration) * width >= LABEL_GAP_PX * 0.75; k++) ticks.push(k * step);
    return { step, ticks };
  }, [width, duration]);

  const timeAt = (clientX: number) => {
    const track = trackRef.current;
    if (!track || width === 0) return 0;
    return ((clientX - track.getBoundingClientRect().left) / width) * duration;
  };

  const winLeftRaw = (t0 / duration) * width;
  const winWidth = Math.max(MIN_WINDOW_PX, ((t1 - t0) / duration) * width);
  const winLeft = Math.min(winLeftRaw, width - winWidth);
  const resizable = winWidth >= EDGE_MIN_PX;

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const target = e.target as HTMLElement;
    const edge = target.dataset.edge as 'start' | 'end' | undefined;
    let origin = range;
    if (!edge && !windowRef.current?.contains(target)) {
      // A press beside the window recentres it there, then drags it like a press on it.
      const at = timeAt(e.clientX);
      origin = clampRange([at - (t1 - t0) / 2, at + (t1 - t0) / 2], duration);
      onRange(origin);
    }
    drag.current = { kind: edge ?? 'pan', originX: e.clientX, origin };
    e.currentTarget.setPointerCapture(e.pointerId);
    windowRef.current?.focus();
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || width === 0) return;
    const [a, b] = d.origin;
    if (d.kind === 'pan') {
      const dt = ((e.clientX - d.originX) / width) * duration;
      onRange(clampRange([a + dt, b + dt], duration));
    } else if (d.kind === 'start') {
      onRange(clampRange([Math.min(timeAt(e.clientX), b - duration / width), b], duration));
    } else {
      const end = Math.max(timeAt(e.clientX), a + duration / width);
      onRange(clampRange([a, Math.min(duration, end)], duration));
    }
  };

  const endDrag = () => {
    drag.current = null;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const span = t1 - t0;
    const shift = span * (e.shiftKey ? 0.5 : 0.1);
    const targets: Record<string, Range> = {
      ArrowLeft: [t0 - shift, t1 - shift],
      ArrowDown: [t0 - shift, t1 - shift],
      ArrowRight: [t0 + shift, t1 + shift],
      ArrowUp: [t0 + shift, t1 + shift],
      Home: [0, span],
      End: [duration - span, duration],
      '+': [t0 + span / 4, t1 - span / 4],
      '=': [t0 + span / 4, t1 - span / 4],
      '-': [t0 - span / 2, t1 + span / 2],
    };
    if (!(e.key in targets)) return;
    e.preventDefault();
    onRange(clampRange(targets[e.key], duration));
  };

  return (
    <div className="pv-minimap" ref={rootRef}>
      {area && width > 0 && (
        <div className="pv-mm-inner" style={{ marginLeft: area.left, width }}>
          <div className="pv-mm-label">
            <span>
              Visible{' '}
              <span className="pv-mm-range">
                {t0.toFixed(3)}&ndash;{formatSeconds(t1)}
              </span>
            </span>
            <span className="pv-mm-source">
              <span className="pv-dot" style={{ background: spec.color }} aria-hidden="true" />
              <span className="pv-mm-source-name">{spec.info.name}</span>
            </span>
          </div>
          <div
            className="pv-mm-track"
            ref={trackRef}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          >
            <canvas ref={canvasRef} style={{ width, height: TRACK_H }} aria-hidden="true" />
            <div
              ref={windowRef}
              className="pv-mm-window"
              style={{ left: winLeft, width: winWidth }}
              role="slider"
              tabIndex={0}
              aria-label="Visible range"
              aria-orientation="horizontal"
              aria-valuemin={0}
              aria-valuemax={Math.max(0, duration - (t1 - t0))}
              aria-valuenow={t0}
              aria-valuetext={`${formatSeconds(t0)} to ${formatSeconds(t1)} of ${formatDuration(duration)}`}
              title="Drag to pan, or drag an edge to resize. Arrow keys pan; + and - zoom."
              onKeyDown={onKeyDown}
            >
              {resizable && <span className="pv-mm-edge start" data-edge="start" aria-hidden="true" />}
              {resizable && <span className="pv-mm-edge end" data-edge="end" aria-hidden="true" />}
            </div>
          </div>
          <div className="pv-mm-ticks" aria-hidden="true">
            {axis.ticks.map((t, i) => (
              <span key={t} className={i === 0 ? 'first' : undefined} style={{ left: `${(t / duration) * 100}%` }}>
                {formatTick(t, axis.step)}
              </span>
            ))}
            <span className="last" style={{ left: '100%' }}>
              {formatDuration(duration)}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
