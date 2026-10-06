import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { SignalDef } from '../core/api';
import { cssVar, formatCount, useFontsReady } from '../format';
import { signalBits } from '../signalBits';

const LABEL_W = 22;
const HEAD_H = 22;
const GAP = 6;
const RAMP_STEPS = 6;

interface Props {
  flips: Uint32Array;
  /** Pairs of frames `flips` were counted over, the denominator of each bit's share. */
  pairs: number;
  bytes: number;
  signals: SignalDef[];
  /** Colour per signal, same order as `signals`. */
  colors: string[];
  highlight: string | null;
  /** Bits (`byte * 8 + bit`) to call out with a dashed outline, described in the tooltip as `markedLabel`. */
  marked?: ReadonlySet<number>;
  markedLabel?: string;
  /** Names the grid for assistive technology. */
  label?: string;
}

/**
 * How often each payload bit changes between consecutive frames, one row per byte with the
 * MSB on the left. Changing bits stand out against constant ones; DBC signals are outlined.
 */
export function BitHeatmap({ flips, pairs, bytes, signals, colors, highlight, marked, markedLabel, label }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [available, setAvailable] = useState(0);
  const [hover, setHover] = useState<{ bit: number; x: number; y: number } | null>(null);
  const fontsReady = useFontsReady();

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setAvailable(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const pitch = Math.max(24, Math.min(36, Math.floor((available - LABEL_W) / 8)));
  const rowPitch = bytes > 16 ? 16 : bytes > 8 ? 22 : pitch;
  const width = LABEL_W + pitch * 8;
  const height = HEAD_H + rowPitch * bytes;

  const owners = useMemo(() => {
    const owner = new Array<number>(bytes * 8).fill(-1);
    signals.forEach((s, i) => {
      for (const b of signalBits(s)) if (b < owner.length && owner[b] === -1) owner[b] = i;
    });
    return owner;
  }, [signals, bytes]);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx || available === 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const ramp = Array.from({ length: RAMP_STEPS }, (_, i) => cssVar(`--heat-${i + 1}`));
    const unset = cssVar('--unset-cell');
    const unsetEdge = cssVar('--hairline');
    const label = cssVar('--slate');
    const radius = rowPitch >= 20 ? 4 : 2;

    ctx.font = `400 11px ${cssVar('--font-ui')}`;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = label;
    ctx.textAlign = 'center';
    for (let col = 0; col < 8; col++) ctx.fillText(String(7 - col), LABEL_W + col * pitch + pitch / 2, HEAD_H / 2 - 2);

    const denom = Math.max(1, pairs);
    for (let byte = 0; byte < bytes; byte++) {
      const y = HEAD_H + byte * rowPitch;
      ctx.fillStyle = label;
      ctx.textAlign = 'left';
      ctx.fillText(String(byte), 0, y + rowPitch / 2);
      for (let col = 0; col < 8; col++) {
        const count = flips[byte * 8 + (7 - col)] ?? 0;
        const x = LABEL_W + col * pitch + GAP / 2;
        const w = pitch - GAP;
        const h = rowPitch - Math.min(GAP, rowPitch / 4);
        const top = y + (rowPitch - h) / 2;
        ctx.beginPath();
        ctx.roundRect(x, top, w, h, radius);
        if (count === 0) {
          ctx.fillStyle = unset;
          ctx.fill();
          ctx.strokeStyle = unsetEdge;
          ctx.lineWidth = 1;
          ctx.stroke();
        } else {
          ctx.fillStyle = ramp[Math.min(RAMP_STEPS - 1, Math.floor(heat(count / denom) * RAMP_STEPS))];
          ctx.fill();
        }
      }
    }

    // One rounded outline per rectangular block of a signal's bits, in the signal's colour.
    // A paper halo goes down first so an ochre outline still reads against ochre cells.
    const blocks = signalBlocks(owners, bytes);
    const outline = (block: Block) => {
      ctx.beginPath();
      ctx.roundRect(
        LABEL_W + block.col0 * pitch + 1,
        HEAD_H + block.row0 * rowPitch + 1,
        (block.col1 - block.col0 + 1) * pitch - 2,
        (block.row1 - block.row0 + 1) * rowPitch - 2,
        Math.min(6, rowPitch / 3),
      );
    };
    const strokeWidth = (block: Block) => (signals[block.owner].name === highlight ? 3 : 2);
    ctx.strokeStyle = cssVar('--paper');
    for (const block of blocks) {
      ctx.lineWidth = strokeWidth(block) + 4;
      outline(block);
      ctx.stroke();
    }
    for (const block of blocks) {
      ctx.strokeStyle = colors[block.owner];
      ctx.lineWidth = strokeWidth(block);
      outline(block);
      ctx.stroke();
    }

    // Marked cells: a dashed graphite outline on a paper halo, so the call-out never relies on colour.
    for (const bit of marked ?? []) {
      const byte = bit >> 3;
      if (byte >= bytes) continue;
      const cell = () => {
        ctx.beginPath();
        ctx.roundRect(LABEL_W + (7 - (bit & 7)) * pitch + 1, HEAD_H + byte * rowPitch + 1, pitch - 2, rowPitch - 2, radius);
      };
      ctx.setLineDash([]);
      ctx.strokeStyle = cssVar('--paper');
      ctx.lineWidth = 4;
      cell();
      ctx.stroke();
      ctx.setLineDash([3, 2]);
      ctx.strokeStyle = cssVar('--graphite');
      ctx.lineWidth = 2;
      cell();
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }, [flips, pairs, bytes, owners, signals, colors, highlight, marked, width, height, pitch, rowPitch, available, fontsReady]);

  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const col = Math.floor((x - LABEL_W) / pitch);
    const byte = Math.floor((y - HEAD_H) / rowPitch);
    if (col < 0 || col > 7 || byte < 0 || byte >= bytes) setHover(null);
    else setHover({ bit: byte * 8 + (7 - col), x, y });
  };

  const hovered = hover && {
    byte: hover.bit >> 3,
    bit: hover.bit & 7,
    flips: flips[hover.bit] ?? 0,
    owner: owners[hover.bit] >= 0 ? signals[owners[hover.bit]] : null,
  };

  return (
    <div className="heatmap" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
        role="img"
        aria-label={label ?? `Bit change rates for ${bytes} bytes`}
      />
      {hovered && hover && (
        <div
          className="tooltip"
          style={hover.x > width / 2 ? { right: width - hover.x + 12, top: hover.y + 14 } : { left: hover.x + 12, top: hover.y + 14 }}
        >
          <div>
            Byte {hovered.byte}, bit {hovered.bit} <span className="muted">(DBC bit {hover.bit})</span>
          </div>
          <div className="muted">
            {hovered.flips === 0
              ? 'Never changes'
              : `Changed ${formatCount(hovered.flips)} times \u00b7 ${((100 * hovered.flips) / Math.max(1, pairs)).toFixed(2)}% of frames`}
          </div>
          {hovered.owner && <div className="muted">Signal {hovered.owner.name}</div>}
          {markedLabel && marked?.has(hover.bit) && <div>{markedLabel}</div>}
        </div>
      )}
    </div>
  );
}

interface Block {
  owner: number;
  row0: number;
  row1: number;
  col0: number;
  col1: number;
}

/** Group each signal's cells into row runs, then merge runs that repeat on consecutive rows. */
function signalBlocks(owners: number[], bytes: number): Block[] {
  const blocks: Block[] = [];
  const open = new Map<string, Block>();
  for (let row = 0; row < bytes; row++) {
    const seen = new Set<string>();
    let col = 0;
    while (col < 8) {
      const owner = owners[row * 8 + (7 - col)];
      if (owner < 0) {
        col++;
        continue;
      }
      let end = col;
      while (end + 1 < 8 && owners[row * 8 + (7 - (end + 1))] === owner) end++;
      const key = `${owner}:${col}:${end}`;
      const prev = open.get(key);
      if (prev && prev.row1 === row - 1) prev.row1 = row;
      else {
        const block = { owner, row0: row, row1: row, col0: col, col1: end };
        blocks.push(block);
        open.set(key, block);
      }
      seen.add(key);
      col = end + 1;
    }
    for (const key of open.keys()) if (!seen.has(key)) open.delete(key);
  }
  return blocks;
}

/**
 * Map a change rate to 0..1 on a log scale, so a bit that changes once in 10,000 frames is
 * still visible next to a counter's LSB that changes every frame.
 */
function heat(rate: number): number {
  return Math.min(1, Math.max(0, (Math.log10(rate) + 4) / 4));
}
