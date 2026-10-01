import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { cssVar, formatCount, useFontsReady } from '../../format';
import { heatStep } from './bits';

const LABEL_W = 56;
const GAP = 6;
/** Room around the cells for the selection outline and its halo. */
const PAD = 4;
const RAMP_STEPS = 6;
const VISIBLE_ROWS = 8;

interface Props {
  flips: Uint32Array;
  bytes: number;
  /** Frame-to-frame transitions the counts cover. */
  transitions: number;
  /** Seconds the counts cover. */
  seconds: number;
  /** Selected bits, `byte * 8 + bit`. */
  selected: number[];
  /** DBC signal name per bit, for the tooltip. */
  owners: (string | null)[];
  /** Select the range covering the rectangle from `anchor` to `focus`. */
  onSelect: (anchor: number, focus: number) => void;
  onClear: () => void;
}

/**
 * How often each payload bit changed in the window, one row per byte with bit 7 on the left.
 * Drag, or use Shift with the arrow keys, to select a bit range.
 */
export function BitGrid({ flips, bytes, transitions, seconds, selected, owners, onSelect, onClear }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [available, setAvailable] = useState(0);
  const [hover, setHover] = useState<{ bit: number; x: number; y: number } | null>(null);
  const [focusBit, setFocusBit] = useState<number | null>(null);
  const [showFocus, setShowFocus] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const anchor = useRef<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const fontsReady = useFontsReady();
  const helpId = useId();

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setAvailable(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const pitch = Math.max(28, Math.min(96, Math.floor((available - LABEL_W - PAD) / 8)));
  const rowPitch = bytes > VISIBLE_ROWS ? 24 : 30;
  const width = LABEL_W + pitch * 8 + PAD;
  const height = PAD * 2 + rowPitch * bytes;
  const selectedSet = useMemo(() => new Set(selected), [selected]);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const g = canvas?.getContext('2d');
    if (!canvas || !g || available === 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, width, height);

    const ramp = Array.from({ length: RAMP_STEPS }, (_, i) => cssVar(`--heat-${i + 1}`));
    const unset = cssVar('--unset-cell');
    const hairline = cssVar('--hairline');
    g.font = `400 12px ${cssVar('--font-ui')}`;
    g.textBaseline = 'middle';
    g.textAlign = 'right';

    for (let byte = 0; byte < bytes; byte++) {
      const y = PAD + byte * rowPitch;
      g.fillStyle = cssVar('--slate');
      g.fillText(`Byte ${byte}`, LABEL_W - 10, y + rowPitch / 2);
      for (let col = 0; col < 8; col++) {
        const count = flips[byte * 8 + (7 - col)] ?? 0;
        const cell = cellRect(byte, col, pitch, rowPitch);
        g.beginPath();
        g.roundRect(cell.x, cell.y, cell.w, cell.h, 4);
        if (count === 0) {
          g.fillStyle = unset;
          g.fill();
          g.strokeStyle = hairline;
          g.lineWidth = 1;
          g.stroke();
        } else {
          g.fillStyle = ramp[heatStep(count, transitions, RAMP_STEPS)];
          g.fill();
        }
      }
    }

    // The outline runs along the gutters, on a paper halo so it reads against dark cells.
    if (selectedSet.size > 0) {
      traceOutline(g, selectedSet, bytes, pitch, rowPitch);
      g.setLineDash([]);
      g.lineJoin = 'miter';
      g.strokeStyle = cssVar('--paper');
      g.lineWidth = 6;
      g.stroke();
      g.setLineDash([5, 3]);
      g.strokeStyle = cssVar('--graphite');
      g.lineWidth = 2;
      g.stroke();
      g.setLineDash([]);
    }

    if (showFocus && focusBit !== null && focusBit < bytes * 8) {
      const cell = cellRect(focusBit >> 3, 7 - (focusBit & 7), pitch, rowPitch);
      g.lineWidth = 4;
      g.strokeStyle = cssVar('--paper');
      g.strokeRect(cell.x + 2, cell.y + 2, cell.w - 4, cell.h - 4);
      g.lineWidth = 2;
      g.strokeStyle = cssVar('--ochre-control');
      g.strokeRect(cell.x + 1, cell.y + 1, cell.w - 2, cell.h - 2);
    }
  }, [flips, bytes, transitions, selectedSet, width, height, pitch, rowPitch, available, focusBit, showFocus, fontsReady]);

  /** The cell under the pointer, with the pointer's position in the wrapper for the tooltip. */
  const cellAt = (e: PointerEvent<HTMLCanvasElement>, clamp: boolean) => {
    const r = e.currentTarget.getBoundingClientRect();
    let col = Math.floor((e.clientX - r.left - LABEL_W) / pitch);
    let byte = Math.floor((e.clientY - r.top - PAD) / rowPitch);
    if (clamp) {
      col = Math.min(7, Math.max(0, col));
      byte = Math.min(bytes - 1, Math.max(0, byte));
    } else if (col < 0 || col > 7 || byte < 0 || byte >= bytes) {
      return null;
    }
    const w = wrapRef.current!.getBoundingClientRect();
    return { bit: byte * 8 + (7 - col), x: e.clientX - w.left, y: e.clientY - w.top };
  };

  const onPointerDown = (e: PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    const hit = cellAt(e, false);
    if (!hit) return;
    e.preventDefault();
    wrapRef.current?.focus({ preventScroll: true });
    const from = e.shiftKey && anchor.current !== null ? anchor.current : hit.bit;
    anchor.current = from;
    setDragging(true);
    e.currentTarget.setPointerCapture(e.pointerId);
    setShowFocus(false);
    setFocusBit(hit.bit);
    onSelect(from, hit.bit);
  };

  const onPointerMove = (e: PointerEvent<HTMLCanvasElement>) => {
    setHover(cellAt(e, false));
    if (!dragging || anchor.current === null) return;
    const hit = cellAt(e, true);
    if (hit && hit.bit !== focusBit) {
      setFocusBit(hit.bit);
      onSelect(anchor.current, hit.bit);
    }
  };

  const describe = (bit: number) => {
    const count = flips[bit] ?? 0;
    const owner = owners[bit];
    return `Byte ${bit >> 3}, bit ${bit & 7}. ${
      count === 0 ? 'Never changes' : `Changed ${formatCount(count)} times, ${percent(count, transitions)} of frames`
    }.${owner ? ` In ${owner}.` : ''}${selectedSet.has(bit) ? ' Selected.' : ''}`;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const moves: Record<string, [number, number]> = {
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
    };
    const current = focusBit ?? selected[0] ?? 7;
    if (e.key in moves) {
      e.preventDefault();
      const [dRow, dCol] = moves[e.key];
      const byte = Math.min(bytes - 1, Math.max(0, (current >> 3) + dRow));
      const col = Math.min(7, Math.max(0, 7 - (current & 7) + dCol));
      const next = byte * 8 + (7 - col);
      setFocusBit(next);
      setShowFocus(true);
      if (e.shiftKey) {
        if (anchor.current === null) anchor.current = current;
        onSelect(anchor.current, next);
      } else {
        anchor.current = next;
      }
      setAnnouncement(describe(next));
      keepRowVisible(byte);
    } else if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      anchor.current = current;
      setFocusBit(current);
      setShowFocus(true);
      onSelect(current, current);
    } else if (e.key === 'Escape' && selected.length > 0) {
      onClear();
      setAnnouncement('Selection cleared.');
    }
  };

  const keepRowVisible = (byte: number) => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const top = PAD + byte * rowPitch;
    if (top < scroller.scrollTop) scroller.scrollTop = top - PAD;
    else if (top + rowPitch > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = top + rowPitch + PAD - scroller.clientHeight;
  };

  const hovered = hover && {
    byte: hover.bit >> 3,
    bit: hover.bit & 7,
    flips: flips[hover.bit] ?? 0,
    owner: owners[hover.bit] ?? null,
  };

  return (
    <div
      ref={wrapRef}
      className="re-grid"
      tabIndex={0}
      role="application"
      aria-roledescription="bit grid"
      aria-label={`Bit activity for ${bytes} ${bytes === 1 ? 'byte' : 'bytes'}`}
      aria-describedby={helpId}
      onKeyDown={onKeyDown}
      onFocus={(e) => {
        if (focusBit === null) setFocusBit(selected[0] ?? 7);
        if (e.currentTarget.matches(':focus-visible')) setShowFocus(true);
      }}
      onBlur={() => setShowFocus(false)}
    >
      <p id={helpId} className="sr-only">
        Each cell is one payload bit, bit 7 on the left. Darker cells change more often. Arrow keys move between bits, Shift with an arrow key
        selects a range, Space selects one bit and Escape clears the selection.
      </p>
      <div className="re-grid-head" aria-hidden="true" style={{ width }}>
        <span className="re-grid-corner" style={{ width: LABEL_W }}>
          Bit
        </span>
        {[7, 6, 5, 4, 3, 2, 1, 0].map((b) => (
          <span key={b} style={{ width: pitch }}>
            {b}
          </span>
        ))}
      </div>
      <div
        className="re-grid-scroll"
        ref={scrollRef}
        style={bytes > VISIBLE_ROWS ? { maxHeight: PAD * 2 + rowPitch * (VISIBLE_ROWS + 0.5) } : undefined}
      >
        <canvas
          ref={canvasRef}
          aria-hidden="true"
          style={{ cursor: hover || dragging ? 'crosshair' : 'default' }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={() => setDragging(false)}
          onPointerCancel={() => setDragging(false)}
          onPointerLeave={() => setHover(null)}
        />
      </div>
      {hovered && hover && (
        <div
          className="tooltip"
          style={hover.x > width / 2 ? { right: available - hover.x + 12, top: hover.y + 14 } : { left: hover.x + 12, top: hover.y + 14 }}
        >
          <div>
            Byte {hovered.byte}, bit {hovered.bit} <span className="muted">(bit {hover.bit})</span>
          </div>
          <div className="muted">
            {hovered.flips === 0
              ? 'Never changes in this window'
              : `Changed ${formatCount(hovered.flips)} times \u00b7 ${percent(hovered.flips, transitions)} of frames \u00b7 ${rate(hovered.flips, seconds)}`}
          </div>
          {hovered.owner && <div className="muted">In {hovered.owner}</div>}
        </div>
      )}
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>
    </div>
  );
}

/** Horizontal key for the heat ramp and the selection outline. */
export function HeatLegend({ selection }: { selection: string | null }) {
  return (
    <div className="re-legend">
      <span className="re-legend-item">
        <span className="re-swatch unset" aria-hidden="true" />
        No change
      </span>
      <span className="re-legend-item">
        Rarely
        <span className="re-ramp" aria-hidden="true">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <span key={i} className="re-swatch" style={{ background: `var(--heat-${i})` }} />
          ))}
        </span>
        Every frame
      </span>
      <span className="re-legend-item re-legend-selection">
        <span className="re-swatch dashed" aria-hidden="true" />
        {selection ?? 'Drag across bits to select a range'}
      </span>
    </div>
  );
}

function cellRect(byte: number, col: number, pitch: number, rowPitch: number) {
  return {
    x: LABEL_W + col * pitch + GAP / 2,
    y: PAD + byte * rowPitch + GAP / 2,
    w: pitch - GAP,
    h: rowPitch - GAP,
  };
}

/**
 * Adds the boundary of the selected cells to the current path as closed loops along the gutter
 * centrelines, so a dashed stroke runs on unbroken around ranges that wrap between bytes.
 */
function traceOutline(g: CanvasRenderingContext2D, selected: Set<number>, bytes: number, pitch: number, rowPitch: number) {
  const has = (row: number, col: number) => row >= 0 && row < bytes && col >= 0 && col < 8 && selected.has(row * 8 + (7 - col));
  // Clockwise edges between lattice points (row, col), keyed by their start point.
  const edges = new Map<string, [number, number][]>();
  const add = (r0: number, c0: number, r1: number, c1: number) => {
    const key = `${r0},${c0}`;
    edges.set(key, [...(edges.get(key) ?? []), [r1, c1]]);
  };
  for (let row = 0; row < bytes; row++) {
    for (let col = 0; col < 8; col++) {
      if (!has(row, col)) continue;
      if (!has(row - 1, col)) add(row, col, row, col + 1);
      if (!has(row, col + 1)) add(row, col + 1, row + 1, col + 1);
      if (!has(row + 1, col)) add(row + 1, col + 1, row + 1, col);
      if (!has(row, col - 1)) add(row + 1, col, row, col);
    }
  }
  const px = (col: number) => LABEL_W + col * pitch;
  const py = (row: number) => PAD + row * rowPitch;
  g.beginPath();
  for (const startKey of edges.keys()) {
    while ((edges.get(startKey)?.length ?? 0) > 0) {
      let [row, col] = startKey.split(',').map(Number);
      g.moveTo(px(col), py(row));
      for (;;) {
        const out = edges.get(`${row},${col}`);
        const next = out?.pop();
        if (!next) break;
        [row, col] = next;
        g.lineTo(px(col), py(row));
      }
      g.closePath();
    }
  }
}

function percent(count: number, transitions: number): string {
  return `${((100 * count) / Math.max(1, transitions)).toFixed(count >= transitions / 10 ? 0 : 2)}%`;
}

function rate(count: number, seconds: number): string {
  if (!(seconds > 0)) return '';
  const perSecond = count / seconds;
  return perSecond >= 1 ? `${perSecond.toFixed(1)} per s` : `every ${(1 / perSecond).toFixed(1)} s`;
}
