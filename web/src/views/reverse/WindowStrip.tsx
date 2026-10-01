import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import type { CoreApi } from '../../core/api';
import { cssVar, formatDuration } from '../../format';
import { MIN_SPAN, clampWindow, errorText, type TimeWindow } from './bits';

const STRIP_H = 40;
/** Pixels per activity bar, gap included. */
const BAR_PITCH = 3;

type Edge = 'start' | 'end' | 'move';

interface Props {
  core: CoreApi;
  idKey: number;
  logVersion: number;
  duration: number;
  window: TimeWindow;
  onChange: (w: TimeWindow) => void;
  /** Without the title, for a strip that sits inside another card. */
  compact?: boolean;
}

/**
 * The analysis window over the whole log. Bars show how many payload bits of the ID changed in
 * each slice of the log, so busy stretches are easy to aim at; everything below uses the window.
 */
export function WindowStrip({ core, idKey, logVersion, duration, window: win, onChange, compact = false }: Props) {
  const stripRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);
  const [activity, setActivity] = useState<Uint32Array | null>(null);
  const [error, setError] = useState<string | null>(null);
  const drag = useRef<{ edge: Edge; x0: number; from: TimeWindow } | null>(null);
  const [dragEdge, setDragEdge] = useState<Edge | null>(null);
  const titleId = useId();
  const [t0, t1] = win;

  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Rounded so small resizes reuse the same request.
  const buckets = Math.floor(width / BAR_PITCH / 10) * 10;
  useEffect(() => {
    if (buckets < 1 || !(duration > 0)) return;
    let stale = false;
    core.changeActivity(idKey, 0, duration, buckets).then(
      (a) => {
        if (stale) return;
        setActivity(a);
        setError(null);
      },
      (e) => {
        if (stale) return;
        setActivity(null);
        setError(errorText(e));
      },
    );
    return () => {
      stale = true;
    };
  }, [core, idKey, logVersion, duration, buckets]);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const g = canvas?.getContext('2d');
    if (!canvas || !g || width === 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = STRIP_H * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${STRIP_H}px`;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, width, STRIP_H);
    if (!(duration > 0)) return;

    const x = (t: number) => (t / duration) * width;
    g.fillStyle = cssVar('--selected-row');
    g.fillRect(x(t0), 0, Math.max(1, x(t1) - x(t0)), STRIP_H);
    g.fillStyle = cssVar('--hairline');
    g.fillRect(0, STRIP_H - 1, width, 1);
    if (!activity || activity.length === 0) return;

    let peak = 1;
    for (const v of activity) peak = Math.max(peak, v);
    const inside = cssVar('--ochre-control');
    const outside = cssVar('--slate');
    const pitch = width / activity.length;
    for (let i = 0; i < activity.length; i++) {
      if (activity[i] === 0) continue;
      // Square root so quiet stretches still show beside bursts.
      const h = Math.max(1, Math.round(Math.sqrt(activity[i] / peak) * (STRIP_H - 6)));
      const centre = ((i + 0.5) / activity.length) * duration;
      g.fillStyle = centre >= t0 && centre <= t1 ? inside : outside;
      g.fillRect(Math.floor(i * pitch), STRIP_H - 1 - h, Math.max(1, Math.floor(pitch) - 1), h);
    }
  }, [activity, width, t0, t1, duration]);

  const resize = (edge: Edge, from: TimeWindow, dt: number): TimeWindow => {
    const [a, b] = from;
    if (edge === 'move') return clampWindow([a + dt, b + dt], duration);
    if (edge === 'start') return [clamp(a + dt, 0, Math.max(0, b - MIN_SPAN)), b];
    return [a, clamp(b + dt, Math.min(duration, a + MIN_SPAN), duration)];
  };

  const timeAt = (clientX: number) => {
    const r = stripRef.current!.getBoundingClientRect();
    return ((clientX - r.left) / Math.max(1, r.width)) * duration;
  };

  const onPointerDown = (e: PointerEvent<HTMLElement>, edge?: Edge) => {
    if (e.button !== 0 || !(duration > 0)) return;
    e.preventDefault();
    e.stopPropagation();
    let from = win;
    if (!edge) {
      // A press outside the window centres it there, then drags it.
      const span = t1 - t0;
      const t = timeAt(e.clientX);
      from = clampWindow([t - span / 2, t + span / 2], duration);
      onChange(from);
    }
    drag.current = { edge: edge ?? 'move', x0: e.clientX, from };
    setDragEdge(drag.current.edge);
    stripRef.current?.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || width === 0) return;
    onChange(resize(d.edge, d.from, ((e.clientX - d.x0) / width) * duration));
  };

  const endDrag = () => {
    drag.current = null;
    setDragEdge(null);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement>, edge: Edge) => {
    const step = duration >= 60 ? 1 : duration / 60;
    const page = Math.max(step, duration / 20);
    const deltas: Record<string, number> = {
      ArrowLeft: -step,
      ArrowDown: -step,
      ArrowRight: step,
      ArrowUp: step,
      PageDown: -page,
      PageUp: page,
      Home: -duration,
      End: duration,
    };
    if (!(e.key in deltas)) return;
    e.preventDefault();
    const dt = deltas[e.key] * (e.shiftKey && e.key.startsWith('Arrow') ? 10 : 1);
    onChange(resize(edge, win, dt));
  };

  const pct = (t: number) => (duration > 0 ? (t / duration) * 100 : 0);
  const range = `${t0.toFixed(1)} to ${t1.toFixed(1)} seconds`;

  return (
    <div className="re-window">
      <div className="re-card-head">
        <h3 className={compact ? 're-subtitle' : 'section-title'} id={titleId}>
          Time Window
        </h3>
        <div className="re-window-fields">
          <TimeField label="Window start, seconds" value={t0} onCommit={(t) => onChange(resize('start', win, t - t0))} />
          <span className="re-dash" aria-hidden="true">
            to
          </span>
          <TimeField label="Window end, seconds" value={t1} onCommit={(t) => onChange(resize('end', win, t - t1))} />
          <span className="re-window-span">{formatDuration(t1 - t0)} of {formatDuration(duration)}</span>
        </div>
      </div>
      <div
        ref={stripRef}
        className={duration > 0 ? 're-strip' : 're-strip empty'}
        data-drag={dragEdge ?? undefined}
        role="group"
        aria-labelledby={titleId}
        onPointerDown={(e) => onPointerDown(e)}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <canvas ref={canvasRef} aria-hidden="true" />
        <div
          className="re-strip-window"
          role="slider"
          tabIndex={0}
          aria-label="Window position"
          aria-valuemin={0}
          aria-valuemax={Math.max(0, duration - (t1 - t0))}
          aria-valuenow={t0}
          aria-valuetext={range}
          style={{ left: `${pct(t0)}%`, width: `${pct(t1) - pct(t0)}%` }}
          onPointerDown={(e) => onPointerDown(e, 'move')}
          onKeyDown={(e) => onKeyDown(e, 'move')}
        />
        <div
          className="re-handle start"
          role="slider"
          tabIndex={0}
          aria-label="Window start"
          aria-valuemin={0}
          aria-valuemax={t1}
          aria-valuenow={t0}
          aria-valuetext={`${t0.toFixed(1)} seconds`}
          style={{ left: `${pct(t0)}%` }}
          onPointerDown={(e) => onPointerDown(e, 'start')}
          onKeyDown={(e) => onKeyDown(e, 'start')}
        />
        <div
          className="re-handle end"
          role="slider"
          tabIndex={0}
          aria-label="Window end"
          aria-valuemin={t0}
          aria-valuemax={duration}
          aria-valuenow={t1}
          aria-valuetext={`${t1.toFixed(1)} seconds`}
          style={{ left: `${pct(t1)}%` }}
          onPointerDown={(e) => onPointerDown(e, 'end')}
          onKeyDown={(e) => onKeyDown(e, 'end')}
        />
      </div>
      <div className="re-strip-axis">
        <span>0 s</span>
        {error ? <span className="re-quiet">Change activity: {error}</span> : <span>Bars: payload bits changed</span>}
        <span>{formatDuration(duration)}</span>
      </div>
    </div>
  );
}

/** A seconds field that commits on Enter or blur, and reverts on Escape or bad input. */
export function TimeField({ label, value, onCommit }: { label: string; value: number; onCommit: (t: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const t = Number(draft);
    if (draft.trim() !== '' && Number.isFinite(t)) onCommit(t);
    setDraft(null);
  };
  return (
    <label className="re-time">
      <span className="sr-only">{label}</span>
      <input
        className="input mono"
        inputMode="decimal"
        spellCheck={false}
        value={draft ?? value.toFixed(3)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') setDraft(null);
        }}
      />
      <span aria-hidden="true">s</span>
    </label>
  );
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
