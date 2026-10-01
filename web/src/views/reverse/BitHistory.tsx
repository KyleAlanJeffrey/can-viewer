import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import { NO_BYTE, type CoreApi, type IdSummary } from '../../core/api';
import { ROW_PAYLOAD, type RowBatch } from '../../core/rows';
import { cssVar, formatCount, useFontsReady } from '../../format';
import { errorText, formatSeconds, rowIndexAt, type TimeWindow } from './bits';

const LABEL_W = 44;
const COL_W = 4;
const CELL_W = 3;
const BYTE_GAP = 5;
const PAD = 2;
const MAX_FRAMES = 400;
/** Most bytes shown at once: a full 64-bit selection plus a byte of context either side. */
const MAX_BYTES = 10;

interface Props {
  core: CoreApi;
  summary: IdSummary;
  duration: number;
  window: TimeWindow;
  logVersion: number;
  /** Selected bits, `byte * 8 + bit`. */
  selected: number[];
}

interface Frames {
  batch: RowBatch;
  /** Rows of `batch` to draw, oldest first. */
  first: number;
  end: number;
  /** Bytes past the 64 in a row, fetched with the rows when the drawn range reaches them. */
  long: LongBytes | null;
}

/** Bytes `firstByte..firstByte + byteCount` of rows `first..end`, from `CoreApi.rowBytes`. */
interface LongBytes {
  firstByte: number;
  byteCount: number;
  values: Uint16Array;
}

/**
 * The latest frames of the window as a logic-analyser strip: one lane per bit, MSB first in each
 * byte, one column per frame. Shows the selection's bytes with a byte of context either side.
 */
export function BitHistory({ core, summary, duration, window: win, logVersion, selected }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);
  const [frames, setFrames] = useState<Frames | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hover, setHover] = useState<{ row: number; x: number; y: number } | null>(null);
  const fontsReady = useFontsReady();
  const bytes = summary.maxLen;
  const [t0, t1] = win;

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const [firstByte, lastByte] = useMemo(() => {
    const selectedBytes = selected.map((b) => b >> 3).filter((b) => b < bytes);
    if (selectedBytes.length === 0) return [0, Math.min(bytes, 8) - 1];
    const lo = Math.max(0, Math.min(...selectedBytes) - 1);
    const hi = Math.min(bytes - 1, Math.max(...selectedBytes) + 1);
    return [lo, Math.min(hi, lo + MAX_BYTES - 1)];
  }, [selected, bytes]);
  const shownBytes = Math.max(0, lastByte - firstByte + 1);
  const lanes = shownBytes * 8;
  const laneH = lanes <= 16 ? 8 : lanes <= 32 ? 5 : lanes <= 64 ? 3 : 2;
  const lanePitch = laneH + 1;
  const bytePitch = 8 * lanePitch + BYTE_GAP;
  const height = PAD * 2 + shownBytes * bytePitch - BYTE_GAP;
  const columns = width === 0 ? 0 : Math.min(MAX_FRAMES, Math.max(8, Math.floor((width - LABEL_W - PAD) / COL_W)));
  // Rows stop at 64 bytes, so a range reaching past them is fetched with them. Kept constant
  // below that, so a selection there doesn't fetch the frames again.
  const pastRows = lastByte >= ROW_PAYLOAD;
  const longFirst = pastRows ? firstByte : 0;
  const longCount = pastRows ? shownBytes : 0;

  useEffect(() => {
    if (columns === 0 || summary.count === 0) return;
    let stale = false;
    (async () => {
      const [i0, i1] = await Promise.all([
        rowIndexAt(core, summary, t0, duration),
        rowIndexAt(core, summary, t1, duration),
      ]);
      const from = Math.max(i0, i1 - columns);
      const batch = await core.rows(summary.key, from, i1 - from + 1);
      // The row found for t1 is the first at or after it, so it may lie just past the window.
      let end = batch.length;
      while (end > 0 && batch.time(end - 1) > t1) end--;
      const first = Math.max(0, end - columns);
      let long: LongBytes | null = null;
      if (longCount > 0 && end > first) {
        const values = await core.rowBytes(summary.key, batch.start + first, end - first, longFirst, longCount);
        long = { firstByte: longFirst, byteCount: longCount, values };
      }
      return { batch, first, end, long };
    })().then(
      (f) => {
        if (stale) return;
        setFrames(f);
        setError(null);
      },
      (e) => {
        if (stale) return;
        setFrames(null);
        setError(errorText(e));
      },
    );
    return () => {
      stale = true;
    };
  }, [core, summary, duration, t0, t1, columns, logVersion, longFirst, longCount]);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const g = canvas?.getContext('2d');
    if (!canvas || !g || width === 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, width, height);

    const one = cssVar('--graphite');
    const zero = cssVar('--unset-cell');
    const band = cssVar('--changed-byte');
    g.font = `400 11px ${cssVar('--font-mono')}`;
    g.textBaseline = 'middle';
    g.textAlign = 'left';
    for (let b = firstByte; b <= lastByte; b++) {
      const top = PAD + (b - firstByte) * bytePitch;
      const touched = Array.from({ length: 8 }, (_, k) => selectedSet.has(b * 8 + k)).some(Boolean);
      g.fillStyle = cssVar(touched ? '--graphite' : '--slate');
      g.fillText(`B${b}`, 0, top + (8 * lanePitch) / 2);
    }

    if (frames) {
      const { first, end } = frames;
      for (let f = first; f < end; f++) {
        const x = LABEL_W + (f - first) * COL_W;
        for (let b = firstByte; b <= lastByte; b++) {
          const value = byteAt(frames, f, b);
          if (value === null) continue;
          const top = PAD + (b - firstByte) * bytePitch;
          for (let k = 0; k < 8; k++) {
            const bit = 7 - k;
            g.fillStyle = (value >> bit) & 1 ? one : selectedSet.has(b * 8 + bit) ? band : zero;
            g.fillRect(x, top + k * lanePitch, CELL_W, laneH);
          }
        }
      }
    }

    // A dashed bracket in the label gutter marks each run of selected lanes without relying on the tint.
    g.strokeStyle = cssVar('--graphite');
    g.lineWidth = 2;
    g.setLineDash([4, 2]);
    let runStart: number | null = null;
    const laneTop = (lane: number) => PAD + Math.floor(lane / 8) * bytePitch + (lane % 8) * lanePitch;
    for (let lane = 0; lane <= lanes; lane++) {
      const bit = lane < lanes ? (firstByte + Math.floor(lane / 8)) * 8 + (7 - (lane % 8)) : -1;
      const isSelected = lane < lanes && selectedSet.has(bit);
      if (isSelected && runStart === null) runStart = lane;
      if (!isSelected && runStart !== null) {
        const top = laneTop(runStart);
        const bottom = laneTop(lane - 1) + laneH;
        const x = LABEL_W - 7;
        g.beginPath();
        g.moveTo(x + 4, top);
        g.lineTo(x, top);
        g.lineTo(x, bottom);
        g.lineTo(x + 4, bottom);
        g.stroke();
        runStart = null;
      }
    }
    g.setLineDash([]);
  }, [frames, width, height, firstByte, lastByte, lanes, laneH, lanePitch, bytePitch, selectedSet, fontsReady]);

  const onPointerMove = (e: PointerEvent<HTMLCanvasElement>) => {
    if (!frames) return;
    const r = e.currentTarget.getBoundingClientRect();
    const row = frames.first + Math.floor((e.clientX - r.left - LABEL_W) / COL_W);
    setHover(row >= frames.first && row < frames.end ? { row, x: e.clientX - r.left, y: e.clientY - r.top } : null);
  };

  /** The hovered frame's payload, or for one longer than its row the drawn bytes, `--` where it has none. */
  const hoverBytes = (f: Frames, row: number): string => {
    const { batch } = f;
    const full = batch.fullLength(row);
    if (full <= batch.len(row)) return hex(batch.data(row));
    const drawn = Array.from({ length: shownBytes }, (_, i) => {
      const value = byteAt(f, row, firstByte + i);
      return value === null ? '--' : hex([value]);
    });
    return `B${firstByte}-B${lastByte}: ${drawn.join(' ')} (${full} bytes)`;
  };

  if (bytes === 0) return <p className="hint">These frames carry no payload.</p>;

  const shown = frames ? frames.end - frames.first : 0;
  const firstTime = frames && shown > 0 ? frames.batch.time(frames.first) : null;
  const lastTime = frames && shown > 0 ? frames.batch.time(frames.end - 1) : null;

  return (
    <div className="re-history" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={`Bit history of bytes ${firstByte} to ${lastByte} over the last ${shown} frames of the window${
          selected.length ? `, with the ${selected.length} selected bits marked` : ''
        }. Each column is a frame and each lane a bit, darker for 1.`}
        onPointerMove={onPointerMove}
        onPointerLeave={() => setHover(null)}
      />
      {hover && frames && (
        <div className="tooltip" style={hover.x > width / 2 ? { right: width - hover.x + 12, top: hover.y + 14 } : { left: hover.x + 12, top: hover.y + 14 }}>
          <div className="mono">{formatSeconds(frames.batch.time(hover.row))}</div>
          <div className="mono muted re-history-bytes">{hoverBytes(frames, hover.row)}</div>
        </div>
      )}
      <div className="re-history-axis" style={{ paddingLeft: LABEL_W }}>
        {error ? (
          <span className="re-quiet">Frames: {error}</span>
        ) : (
          <>
            <span className="mono">{firstTime !== null ? formatSeconds(firstTime) : ''}</span>
            <span>{frames ? (shown > 0 ? `Last ${formatCount(shown)} frames of the window` : 'No frames in this window') : 'Loading frames\u2026'}</span>
            <span className="mono">{lastTime !== null ? formatSeconds(lastTime) : ''}</span>
          </>
        )}
      </div>
      <div className="re-legend">
        <span className="re-legend-item">
          <span className="re-swatch one" aria-hidden="true" />1
        </span>
        <span className="re-legend-item">
          <span className="re-swatch unset" aria-hidden="true" />0
        </span>
        <span className="re-legend-item">
          <span className="re-swatch band" aria-hidden="true" />
          Selected bits, bracketed on the left
        </span>
      </div>
    </div>
  );
}

/** Byte `b` of row `f` of the frames' batch, or null if the frame is too short or the byte wasn't fetched. */
function byteAt({ batch, first, long }: Frames, f: number, b: number): number | null {
  if (long && b >= long.firstByte && b < long.firstByte + long.byteCount) {
    const value = long.values[(f - first) * long.byteCount + b - long.firstByte];
    return value === NO_BYTE ? null : value;
  }
  return b < batch.len(f) ? batch.data(f)[b] : null;
}

function hex(data: ArrayLike<number>): string {
  return Array.from(data, (b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
}
