import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { formatDuration } from '../../format';
import { formatSeconds } from './filters';

type Edge = 't0' | 't1' | 'move';

const HALF_MS = 0.0005;

interface Props {
  duration: number;
  /** The range's ends in seconds; null is the start or end of the log. */
  t0: number | null;
  t1: number | null;
  onChange: (t0: number, t1: number) => void;
}

/**
 * A time range dragged on a strip. The strip zooms in around a narrow range, so its ends can be
 * placed to the millisecond; it rescales only between drags, never under the pointer.
 */
export function TimeRangeStrip({ duration, t0, t1, onChange }: Props) {
  const stripRef = useRef<HTMLDivElement>(null);
  const handles = useRef<Record<'t0' | 't1', HTMLDivElement | null>>({ t0: null, t1: null });
  const drag = useRef<{ edge: Edge; x0: number; from: [number, number] } | null>(null);
  const [dragEdge, setDragEdge] = useState<Edge | null>(null);
  const start = clamp(t0 ?? 0, 0, duration);
  const end = clamp(t1 ?? duration, start, duration);
  const [domain, setDomain] = useState(() => stripDomain(start, end, duration));

  useEffect(() => {
    if (!dragEdge) setDomain(stripDomain(start, end, duration));
  }, [start, end, duration, dragEdge]);

  const [lo, hi] = domain;
  const span = Math.max(hi - lo, 1e-9);
  const pct = (t: number) => clamp(((t - lo) / span) * 100, 0, 100);
  const timeAt = (clientX: number) => {
    const r = stripRef.current!.getBoundingClientRect();
    return lo + ((clientX - r.left) / Math.max(1, r.width)) * span;
  };

  // Rounded to the millisecond, except that the log's own end stays the end: rounded down, it
  // would leave out the last frames.
  const snap = (t: number) => {
    const rounded = ms(t);
    return rounded >= duration - HALF_MS ? duration : rounded;
  };

  const moved = (edge: Edge, [a, b]: [number, number], dt: number): [number, number] => {
    if (edge === 'move') {
      const shift = clamp(dt, -a, duration - b);
      return [snap(a + shift), snap(b + shift)];
    }
    if (edge === 't0') return [Math.min(snap(clamp(a + dt, 0, b)), b), b];
    return [a, snap(clamp(b + dt, a, duration))];
  };

  const onPointerDown = (e: PointerEvent<HTMLElement>, edge?: Edge) => {
    if (e.button !== 0 || !(duration > 0)) return;
    e.preventDefault();
    e.stopPropagation();
    let from: [number, number] = [start, end];
    let grabbed = edge;
    if (!grabbed) {
      // A press on the track brings the nearer end there, then drags it.
      const t = clamp(timeAt(e.clientX), 0, duration);
      grabbed = Math.abs(t - start) <= Math.abs(t - end) ? 't0' : 't1';
      from = grabbed === 't0' ? [Math.min(snap(t), end), end] : [start, snap(Math.max(t, start))];
      onChange(...from);
    }
    // The default focus change was prevented, to keep the drag from selecting text.
    if (grabbed !== 'move') handles.current[grabbed]?.focus();
    drag.current = { edge: grabbed, x0: e.clientX, from };
    setDragEdge(grabbed);
    stripRef.current?.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    const width = stripRef.current?.getBoundingClientRect().width ?? 0;
    if (!d || width === 0) return;
    onChange(...moved(d.edge, d.from, ((e.clientX - d.x0) / width) * span));
  };

  const endDrag = () => {
    drag.current = null;
    setDragEdge(null);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement>, edge: Edge) => {
    const step = Math.max(0.001, span / 100);
    const deltas: Record<string, number> = {
      ArrowLeft: -step,
      ArrowDown: -step,
      ArrowRight: step,
      ArrowUp: step,
      PageDown: -step * 10,
      PageUp: step * 10,
      Home: -duration,
      End: duration,
    };
    if (!(e.key in deltas)) return;
    e.preventDefault();
    const dt = deltas[e.key] * (e.shiftKey && e.key.startsWith('Arrow') ? 10 : 1);
    onChange(...moved(edge, [start, end], dt));
  };

  return (
    <div className="tv-range">
      <div
        ref={stripRef}
        className="tv-strip"
        data-drag={dragEdge ?? undefined}
        role="group"
        aria-label="Time range strip"
        onPointerDown={(e) => onPointerDown(e)}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <div className="tv-strip-track" />
        <div className="tv-strip-band" style={{ left: `${pct(start)}%`, width: `${pct(end) - pct(start)}%` }} onPointerDown={(e) => onPointerDown(e, 'move')} />
        <div
          ref={(el) => {
            handles.current.t0 = el;
          }}
          className="tv-strip-handle"
          role="slider"
          tabIndex={0}
          aria-label="From"
          aria-valuemin={0}
          aria-valuemax={end}
          aria-valuenow={start}
          aria-valuetext={`${formatSeconds(start)} seconds`}
          style={{ left: `${pct(start)}%` }}
          onPointerDown={(e) => onPointerDown(e, 't0')}
          onKeyDown={(e) => onKeyDown(e, 't0')}
        />
        <div
          ref={(el) => {
            handles.current.t1 = el;
          }}
          className="tv-strip-handle"
          role="slider"
          tabIndex={0}
          aria-label="To"
          aria-valuemin={start}
          aria-valuemax={duration}
          aria-valuenow={end}
          aria-valuetext={`${formatSeconds(end)} seconds`}
          style={{ left: `${pct(end)}%` }}
          onPointerDown={(e) => onPointerDown(e, 't1')}
          onKeyDown={(e) => onKeyDown(e, 't1')}
        />
      </div>
      <div className="tv-strip-axis" aria-hidden="true">
        <span>{axisLabel(lo, span)}</span>
        <span>{lo === 0 && hi === duration ? `Whole log, ${formatDuration(duration)}` : `Zoomed to ${formatDuration(hi - lo)}`}</span>
        <span>{axisLabel(hi, span)}</span>
      </div>
    </div>
  );
}

/**
 * The span the strip shows: the whole log for a wide or open range, else the range with a
 * quarter of its width either side, rounded out to a tidy step.
 */
export function stripDomain(start: number, end: number, duration: number): [number, number] {
  if (!(duration > 0)) return [0, 1];
  const width = end - start;
  if (width >= duration * 0.4) return [0, duration];
  const pad = Math.max(width * 0.25, duration * 0.005);
  const step = niceStep((width + 2 * pad) / 5);
  const lo = Math.max(0, Math.floor((start - pad) / step) * step);
  const hi = Math.min(duration, Math.ceil((end + pad) / step) * step);
  return [lo, hi];
}

function niceStep(raw: number): number {
  const power = 10 ** Math.floor(Math.log10(raw));
  const unit = raw / power;
  return (unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 5 ? 5 : 10) * power;
}

function axisLabel(t: number, span: number): string {
  const digits = span >= 10 ? 0 : span >= 1 ? 1 : 3;
  return `${t.toFixed(digits)} s`;
}

function ms(t: number): number {
  return Math.round(t * 1000) / 1000;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
