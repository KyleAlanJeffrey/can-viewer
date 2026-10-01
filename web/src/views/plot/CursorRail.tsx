import type { KeyboardEvent, PointerEvent, RefObject } from 'react';
import { clampTime, formatSeconds, type CursorId, type PlotArea, type Range } from './model';

/** Closer than this many px, two handle labels would overlap, so they open away from each other. */
const LABEL_ROOM = 104;

interface Props {
  railRef: RefObject<HTMLDivElement | null>;
  /** The lanes' plotting area, relative to the rail. */
  area: PlotArea | null;
  range: Range;
  duration: number;
  cursors: { id: CursorId; time: number }[];
  onMove: (id: CursorId, time: number) => void;
}

type Anchor = 'start' | 'center' | 'end';

interface Placed {
  id: CursorId;
  time: number;
  x: number;
  /** Which side of the view the cursor is off, if it is. */
  off: 'before' | 'after' | null;
}

/** The strip above the lanes holding a draggable, keyboard-operable time handle for each cursor. */
export function CursorRail({ railRef, area, range, duration, cursors, onMove }: Props) {
  const [t0, t1] = range;
  const span = Math.max(t1 - t0, 1e-9);
  const placed: Placed[] = area
    ? cursors.map((c) => ({
        ...c,
        x: area.left + ((Math.min(t1, Math.max(t0, c.time)) - t0) / span) * area.width,
        off: c.time < t0 ? 'before' : c.time > t1 ? 'after' : null,
      }))
    : [];

  const anchorOf = (c: Placed, plotArea: PlotArea): Anchor => {
    const other = placed.find((o) => o.id !== c.id);
    if (other && Math.abs(other.x - c.x) < LABEL_ROOM) return c.x < other.x || (c.x === other.x && c.id === 'a') ? 'end' : 'start';
    if (c.x - plotArea.left < LABEL_ROOM / 2) return 'start';
    if (plotArea.left + plotArea.width - c.x < LABEL_ROOM / 2) return 'end';
    return 'center';
  };

  const timeAt = (clientX: number) => {
    const rail = railRef.current;
    if (!rail || !area) return null;
    const f = (clientX - rail.getBoundingClientRect().left - area.left) / area.width;
    return clampTime(t0 + Math.min(1, Math.max(0, f)) * (t1 - t0), duration);
  };

  return (
    <div className="pv-rail" ref={railRef}>
      {area &&
        placed.map((c) => {
          const key = c.id.toUpperCase();
          const time = formatSeconds(c.time);
          const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
            if (e.button !== 0) return;
            e.preventDefault();
            e.currentTarget.setPointerCapture(e.pointerId);
            e.currentTarget.focus();
          };
          const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
            if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
            const t = timeAt(e.clientX);
            if (t !== null) onMove(c.id, t);
          };
          const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
            const step = ((t1 - t0) / Math.max(1, area.width)) * (e.shiftKey ? 10 : 1);
            const page = (t1 - t0) / 10;
            const targets: Record<string, number> = {
              ArrowLeft: c.time - step,
              ArrowDown: c.time - step,
              ArrowRight: c.time + step,
              ArrowUp: c.time + step,
              PageDown: c.time - page,
              PageUp: c.time + page,
              Home: t0,
              End: t1,
            };
            if (!(e.key in targets)) return;
            e.preventDefault();
            onMove(c.id, clampTime(targets[e.key], duration));
          };
          return (
            <div key={c.id} className={`pv-cursor pv-cursor-${c.id}`} style={{ left: c.x }}>
              {!c.off && <span className="pv-stem" aria-hidden="true" />}
              <div
                role="slider"
                tabIndex={0}
                className={`pv-handle${c.off ? ' off' : ''}`}
                data-anchor={anchorOf(c, area)}
                aria-label={`Cursor ${key}`}
                aria-orientation="horizontal"
                aria-valuemin={0}
                aria-valuemax={duration}
                aria-valuenow={c.time}
                aria-valuetext={c.off ? `${time}, out of view` : time}
                title="Drag, or use the arrow keys (Shift for bigger steps)"
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onKeyDown={onKeyDown}
              >
                {c.off === 'before' && <span aria-hidden="true">&lsaquo;</span>}
                <span className="pv-handle-key">{key}</span>
                <span className="pv-handle-time">{time}</span>
                {c.off === 'after' && <span aria-hidden="true">&rsaquo;</span>}
              </div>
            </div>
          );
        })}
    </div>
  );
}
