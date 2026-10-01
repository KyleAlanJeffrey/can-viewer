import type { MouseEvent } from 'react';
import type { ByteLane } from '../../core/api';
import { hexByte, lastIn, type TimeWindow } from './bits';
import { LaneSpark } from './LaneSpark';
import type { FrameAt } from './useFrameAt';

interface Props {
  /** One lane per byte from `firstByte`, or null while loading. */
  lanes: ByteLane[] | null;
  firstByte: number;
  count: number;
  window: TimeWindow;
  cursor: number | null;
  /** The selected message's frame at the cursor, for the hex readouts. */
  frame: FrameAt | null;
  selectedBytes: Set<number>;
  onSelectByte: (byte: number) => void;
  onHover: (t: number | null) => void;
  onPark: (t: number) => void;
}

/** The selected message's bytes across the window, each with its value at the cursor; click one to select its bits. */
export function ByteStrip({ lanes, firstByte, count, window: win, cursor, frame, selectedBytes, onSelectByte, onHover, onPark }: Props) {
  const [t0, t1] = win;
  const timeAt = (e: MouseEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return t0 + (Math.min(Math.max(0, e.clientX - r.left), r.width) / Math.max(1, r.width)) * (t1 - t0);
  };
  return (
    <div className="re-bstrip">
      {Array.from({ length: count }, (_, k) => {
        const byte = firstByte + k;
        const lane = lanes?.[k] ?? null;
        const value = cursor !== null && frame ? (byte < frame.data.length ? hexByte(frame.data[byte]) : '--') : lane ? hexOf(lastIn(lane, win)?.v) : null;
        const pressed = selectedBytes.has(byte);
        return (
          <button
            key={byte}
            type="button"
            className="re-bstrip-cell"
            aria-pressed={pressed}
            aria-label={`Byte ${byte}${value ? `, ${value} hex` : ''}. Select its 8 bits.`}
            onClick={(e) => {
              onSelectByte(byte);
              onPark(timeAt(e));
            }}
            onMouseMove={(e) => onHover(timeAt(e))}
            onMouseLeave={() => onHover(null)}
          >
            <span className="re-bstrip-head">
              <span className="mono">B{byte}</span>
              <span className="re-bstrip-value mono">{value ?? '\u2026'}</span>
            </span>
            <LaneSpark trace={lane} window={win} cursor={cursor} />
          </button>
        );
      })}
    </div>
  );
}

function hexOf(v: number | undefined): string | null {
  return v === undefined ? null : hexByte(v);
}
