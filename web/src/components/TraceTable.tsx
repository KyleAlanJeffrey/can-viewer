import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { EXT_FLAG, FLAG_ERROR, FLAG_FD, FLAG_RTR, formatId, idLabel, type CoreApi } from '../core/api';
import type { RowBatch } from '../core/rows';
import { cssVar, useFontsReady } from '../format';

const ROW_H = 24;
const HEADER_H = 28;
const PAD = 12;

type ColumnKey = 'time' | 'bus' | 'id' | 'name' | 'len' | 'data';

interface Column {
  key: ColumnKey;
  title: string;
  width: number;
  align?: 'right';
}

const COLUMNS: Column[] = [
  { key: 'time', title: 'Time', width: 120 },
  { key: 'bus', title: 'Bus', width: 72 },
  { key: 'id', title: 'ID', width: 96 },
  { key: 'name', title: 'Name', width: 156 },
  { key: 'len', title: 'Len', width: 56 },
  { key: 'data', title: 'Data', width: 0 },
];

/** Columns dropped first when there's no room for 8 data bytes. */
const DROP_ORDER: ColumnKey[] = ['name', 'bus', 'len'];
/** Room for eight data bytes. */
const MIN_DATA_W = 248;

function fitColumns(width: number): Column[] {
  let cols = COLUMNS;
  for (const key of DROP_ORDER) {
    const fixed = cols.reduce((sum, c) => sum + c.width, 0);
    if (width - fixed >= MIN_DATA_W) break;
    cols = cols.filter((c) => c.key !== key);
  }
  return cols;
}

interface Props {
  core: CoreApi;
  /** ID key to show, or ALL_IDS. */
  filterKey: number;
  rowCount: number;
  /** Changes whenever a new log is loaded. */
  logVersion: number;
  channels: string[];
  /** Message name of an ID (DBC convention, bit 31 for extended) on a bus, if a DBC names it. */
  nameOf: (channel: number, id: number) => string | undefined;
  /** Plot scrubber time; the nearest row is selected and scrolled into view. */
  pinnedTime: number | null;
  /** Moves the pin to a clicked row's time. Absent when there are no plots to pin. */
  onPin?: (time: number) => void;
}

/**
 * Canvas trace view with a logical scrollbar: only the visible rows are ever fetched, so it
 * scrolls tens of millions of frames without hitting the browser's maximum element height.
 */
export function TraceTable({ core, filterKey, rowCount, logVersion, channels, nameOf, pinnedTime, onPin }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [top, setTop] = useState(0);
  const [batch, setBatch] = useState<RowBatch | null>(null);
  const [dragging, setDragging] = useState(false);
  const [selectedFrame, setSelectedFrame] = useState<number | null>(null);
  // The pin and filter the selection already matches, so a pin made by clicking a row isn't searched for.
  const matchedPin = useRef<{ time: number; key: number } | null>(null);
  const wheelRemainder = useRef(0);
  const fontsReady = useFontsReady();

  const visible = Math.max(0, Math.floor((size.height - HEADER_H) / ROW_H));
  const maxTop = Math.max(0, rowCount - visible);
  const clampTop = useCallback((t: number) => Math.max(0, Math.min(maxTop, Math.round(t))), [maxTop]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      setSize({ width: entry.contentRect.width - 10, height: entry.contentRect.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => setTop(0), [filterKey, logVersion]);
  useEffect(() => {
    setSelectedFrame(null);
    matchedPin.current = null;
  }, [logVersion]);
  useEffect(() => setTop((t) => Math.min(t, maxTop)), [maxTop]);

  useEffect(() => {
    if (pinnedTime === null || rowCount === 0) return;
    const matched = matchedPin.current;
    if (matched && matched.time === pinnedTime && matched.key === filterKey) return;
    let stale = false;
    nearestRow(core, filterKey, rowCount, pinnedTime).then(({ row, frame }) => {
      if (stale) return;
      matchedPin.current = { time: pinnedTime, key: filterKey };
      setSelectedFrame(frame);
      setTop((t) => (row >= t && row < t + visible ? t : clampTop(row - Math.floor(visible / 2))));
    });
    return () => {
      stale = true;
    };
  }, [core, filterKey, rowCount, pinnedTime, visible, clampTop]);

  useEffect(() => {
    if (visible === 0 || rowCount === 0) {
      setBatch(null);
      return;
    }
    let stale = false;
    core.rows(filterKey, top, visible + 1).then((b) => {
      if (!stale) setBatch(b);
    });
    return () => {
      stale = true;
    };
  }, [core, filterKey, top, visible, rowCount, logVersion]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rows = e.deltaMode === 1 ? e.deltaY : e.deltaMode === 2 ? e.deltaY * visible : e.deltaY / ROW_H;
      wheelRemainder.current += rows;
      const whole = Math.trunc(wheelRemainder.current);
      if (whole !== 0) {
        wheelRemainder.current -= whole;
        setTop((t) => clampTop(t + whole));
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [clampTop, visible]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const step: Record<string, number> = {
      ArrowDown: 1,
      ArrowUp: -1,
      PageDown: visible,
      PageUp: -visible,
      Home: -Infinity,
      End: Infinity,
    };
    if (!(e.key in step)) return;
    e.preventDefault();
    const d = step[e.key];
    setTop((t) => clampTop(Number.isFinite(d) ? t + d : d > 0 ? maxTop : 0));
  };

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || size.width <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(size.width * dpr);
    canvas.height = Math.round(size.height * dpr);
    canvas.style.width = `${size.width}px`;
    canvas.style.height = `${size.height}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const rows = batch?.key === filterKey ? batch : null;
    draw(ctx, size.width, size.height, visible, rows, channels, nameOf, selectedFrame);
  }, [size, batch, visible, filterKey, channels, nameOf, selectedFrame, fontsReady]);

  const rowAt = (e: React.MouseEvent<HTMLCanvasElement>): number | null => {
    const y = e.clientY - e.currentTarget.getBoundingClientRect().top;
    const row = Math.floor((y - HEADER_H) / ROW_H);
    return batch && y >= HEADER_H && row < batch.length ? row : null;
  };

  const onCanvasPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.style.cursor = rowAt(e) === null ? '' : 'pointer';
  };

  const onCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const row = rowAt(e);
    if (!batch || row === null) return;
    const frame = batch.index(row);
    if (frame === selectedFrame) {
      setSelectedFrame(null);
      return;
    }
    setSelectedFrame(frame);
    if (onPin) {
      const time = batch.time(row);
      matchedPin.current = { time, key: batch.key };
      onPin(time);
    }
  };

  // Scrollbar geometry.
  const track = size.height;
  const thumbH = rowCount > 0 ? Math.max(24, Math.min(track, (track * visible) / rowCount)) : track;
  const thumbTop = maxTop > 0 ? (top / maxTop) * (track - thumbH) : 0;

  const onThumbDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const startY = e.clientY;
    const startTop = top;
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    setDragging(true);
    const move = (ev: PointerEvent) => {
      const dy = ev.clientY - startY;
      const span = track - thumbH;
      if (span > 0) setTop(clampTop(startTop + (dy / span) * maxTop));
    };
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      setDragging(false);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
  };

  const onTrackDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const y = e.clientY - e.currentTarget.getBoundingClientRect().top;
    setTop((t) => clampTop(y < thumbTop ? t - visible : t + visible));
  };

  return (
    <div
      className="trace"
      ref={wrapRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      role="grid"
      aria-rowcount={rowCount}
      aria-label="Frame trace"
    >
      <canvas ref={canvasRef} onClick={onCanvasClick} onPointerMove={onCanvasPointerMove} />
      <div className="scrollbar" onPointerDown={onTrackDown}>
        {maxTop > 0 && (
          <div
            className={`thumb${dragging ? ' dragging' : ''}`}
            style={{ top: thumbTop, height: thumbH }}
            onPointerDown={onThumbDown}
          />
        )}
      </div>
    </div>
  );
}

function draw(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  visible: number,
  batch: RowBatch | null,
  channels: string[],
  nameOf: (channel: number, id: number) => string | undefined,
  selectedFrame: number | null,
) {
  const c = {
    bg: cssVar('--paper'),
    alt: cssVar('--alt-row'),
    selected: cssVar('--selected-row'),
    border: cssVar('--hairline'),
    text: cssVar('--graphite'),
    secondary: cssVar('--slate'),
    changed: cssVar('--changed-byte'),
    changedSelected: cssVar('--changed-byte-selected'),
    warning: cssVar('--rust'),
  };
  const mono = cssVar('--font-mono');
  const ui = cssVar('--font-ui');

  ctx.fillStyle = c.bg;
  ctx.fillRect(0, 0, width, height);
  ctx.textBaseline = 'middle';

  // Header
  ctx.fillStyle = c.border;
  ctx.fillRect(0, HEADER_H - 1, width, 1);
  ctx.font = `500 12px ${ui}`;
  ctx.fillStyle = c.secondary;
  const cols = fitColumns(width);
  const at = new Map<ColumnKey, { x: number; w: number }>();
  let x = 0;
  for (const col of cols) {
    const w = col.width || width - x;
    at.set(col.key, { x, w });
    ctx.textAlign = col.align === 'right' ? 'right' : 'left';
    ctx.fillText(col.title, col.align === 'right' ? x + w - PAD : x + PAD, HEADER_H / 2);
    x += col.width;
  }
  if (!batch) return;

  ctx.font = `13px ${mono}`;
  const cw = ctx.measureText('0').width;
  const pitch = cw * 2 + 12;
  const n = Math.min(batch.length, visible + 1);
  for (let i = 0; i < n; i++) {
    const y = HEADER_H + i * ROW_H;
    const mid = y + ROW_H / 2 + 0.5;
    const isSelected = batch.index(i) === selectedFrame;
    if (isSelected || (batch.start + i) % 2 === 1) {
      ctx.fillStyle = isSelected ? c.selected : c.alt;
      ctx.fillRect(0, y, width, ROW_H);
    }
    const id = batch.id(i);
    const flags = batch.flags(i);
    const extended = (id & EXT_FLAG) !== 0;
    const len = batch.fullLength(i);
    for (const [key, { x: cx, w }] of at) {
      const left = cx + PAD;
      switch (key) {
        case 'time':
          cell(ctx, batch.time(i).toFixed(6), left, mid, c.text, 'left');
          break;
        case 'bus':
          cell(ctx, channels[batch.channel(i)] ?? '?', left, mid, c.secondary, 'left');
          break;
        case 'id':
          if (flags & FLAG_ERROR) cell(ctx, 'ERR', left, mid, c.warning, 'left');
          else cell(ctx, formatId(id & 0x1fff_ffff, extended), left, mid, c.text, 'left');
          break;
        case 'name': {
          const name = flags & FLAG_ERROR ? idLabel({ id: (id & ~EXT_FLAG) >>> 0, extended, flags }) : (nameOf(batch.channel(i), id >>> 0) ?? '');
          cell(ctx, clip(ctx, name, w - PAD * 2), left, mid, c.text, 'left');
          break;
        }
        case 'len':
          cell(ctx, flags & FLAG_RTR ? 'RTR' : String(len), left, mid, c.text, 'left');
          break;
        case 'data': {
          // The length label is drawn whole even when no byte fits, so the column clips it.
          ctx.save();
          ctx.beginPath();
          ctx.rect(cx, y, w, ROW_H);
          ctx.clip();
          ctx.textAlign = 'left';
          let dx = left;
          if (flags & FLAG_FD) {
            cell(ctx, 'FD', dx, mid, c.secondary, 'left');
            dx += pitch;
          }
          const data = batch.data(i);
          // A reassembled J1939 transfer longer than the row's 64 bytes says how long it is.
          const cut = len > data.length ? `\u2026 (${len} bytes)` : null;
          const room = cx + w - dx - (cut ? ctx.measureText(cut).width : 0);
          const fits = Math.max(0, Math.floor(room / pitch));
          const shown = Math.min(data.length, fits);
          for (let k = 0; k < shown; k++) {
            const bx = dx + k * pitch;
            if (batch.changed(i, k)) {
              ctx.fillStyle = isSelected ? c.changedSelected : c.changed;
              ctx.beginPath();
              ctx.roundRect(bx - 4, y + 3, cw * 2 + 8, ROW_H - 6, 4);
              ctx.fill();
            }
            cell(ctx, HEX[data[k]], bx, mid, c.text, 'left');
          }
          if (cut) cell(ctx, cut, dx + shown * pitch, mid, c.secondary, 'left');
          else if (data.length > fits && fits > 0) cell(ctx, '\u2026', dx + fits * pitch - cw, mid, c.secondary, 'left');
          ctx.restore();
          break;
        }
      }
    }
  }
}

/** The row closest in time to `time`, by binary search over rows in time order. */
async function nearestRow(core: CoreApi, key: number, count: number, time: number): Promise<{ row: number; frame: number }> {
  let lo = 0;
  let hi = count - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((await core.rows(key, mid, 1)).time(0) < time) lo = mid + 1;
    else hi = mid;
  }
  // `lo` is the first row at or after `time` (or the last row); the one before it may be closer.
  const start = Math.max(0, lo - 1);
  const pair = await core.rows(key, start, lo - start + 1);
  const i = pair.length > 1 && time - pair.time(0) > pair.time(1) - time ? 1 : 0;
  return { row: start + i, frame: pair.index(i) };
}

function cell(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string, align: CanvasTextAlign) {
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.fillText(text, x, y);
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).toUpperCase().padStart(2, '0'));

function clip(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(`${s}\u2026`).width > max) s = s.slice(0, -1);
  return `${s}\u2026`;
}
