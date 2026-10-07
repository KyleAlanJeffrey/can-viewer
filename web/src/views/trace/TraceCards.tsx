import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type Ref } from 'react';
import { ChartLine, ChevronDown, ChevronRight } from 'lucide-react';
import { EXT_FLAG, FLAG_ERROR, FLAG_FD, FLAG_RTR, formatId, idLabel, type CoreApi, type FrameValue, type MessageDef } from '../../core/api';
import type { RowBatch } from '../../core/rows';
import { HEX, nearestRow } from '../../components/TraceTable';
import { formatValue } from '../plot/model';

/** A collapsed card's height and the gap under it. Keep in step with .tc-card in trace.css. */
export const CARD_H = 84;
const GAP = 8;
const PITCH = CARD_H + GAP;
/** Room above the first card and below the last. */
const PAD = 12;
/** Rows fetched either side of those in view, so a fling seldom waits for the core. */
const OVERSCAN = 8;
/** A touch that moves less than this many px is a tap, not a drag. */
const DRAG_SLOP = 8;
/** How much of its speed a fling keeps per millisecond. */
const FLING_DECAY = 0.996;
/** Bytes a collapsed card shows: a classic frame's whole payload. */
const SHOWN_BYTES = 8;

/** What the card of a frame says about its ID on its bus. */
export interface FrameLookup {
  /** The message name, if a DBC names it. */
  name?: string;
  /** The message that decodes it, if a DBC does. */
  message: MessageDef | null;
  /** The ID's key, for plotting its signals. */
  key: number | null;
}

interface Props {
  core: CoreApi;
  /** ID key to show, ALL_IDS or FILTERED_ROWS. */
  filterKey: number;
  rowCount: number;
  /** Changes whenever a new log is loaded. */
  logVersion: number;
  /** `LogInfo.droppedFrames`: frames a rolling capture dropped, which moved the rest down. */
  droppedFrames?: number;
  /** Keep the newest frames in view as they arrive, unless scrolled away from the end. */
  follow?: boolean;
  channels: string[];
  /** Whether any DBC is loaded, so a frame no DBC describes reads as Unknown. */
  hasDbc: boolean;
  /** The ID (DBC convention, bit 31 for extended) on a bus. */
  lookup: (channel: number, id: number) => FrameLookup;
  /** Plot cursor time; the nearest frame is selected and scrolled into view. */
  pinnedTime: number | null;
  /** Moves the pin to an opened frame's time. Absent when there are no plots to pin. */
  onPin?: (time: number) => void;
  /** Plot every signal of the ID `key` with the cursor at `time`. */
  onPlotMessage: (key: number, time: number) => void;
  /** Payload bytes of row `i` that a filter matched; they are outlined and set in bold. */
  matchedBytes?: (batch: RowBatch, i: number) => number[];
}

interface Opened {
  row: number;
  frame: number;
}

/**
 * The trace as cards for phones: time, ID and bus, name and length, then the bytes. A tapped card
 * opens in place with every byte and the decoded values. Like the canvas table, only the cards in
 * view exist, placed by arithmetic over a logical scroll position, so a million frames scroll as
 * easily as ten; every card is the same height but the one open, whose height is measured.
 */
export function TraceCards({ core, filterKey, rowCount, logVersion, droppedFrames = 0, follow = false, channels, hasDbc, lookup, pinnedTime, onPin, onPlotMessage, matchedBytes }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const openRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [scrollY, setScrollY] = useState(0);
  const [batch, setBatch] = useState<RowBatch | null>(null);
  const [opened, setOpened] = useState<Opened | null>(null);
  /** How much taller than a collapsed card the open one is. */
  const [extra, setExtra] = useState(0);
  /** The open card's payload past the 64 bytes a row carries, for a long J1939 transfer. */
  const [fullData, setFullData] = useState<{ frame: number; data: Uint8Array } | null>(null);
  /** The open card's signals, as the core decodes them from its whole payload. */
  const [decoded, setDecoded] = useState<{ frame: number; values: FrameValue[] } | null>(null);
  const [selectedFrame, setSelectedFrame] = useState<number | null>(null);
  const [focusRow, setFocusRow] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  /** Set when a card was just opened, to bring all of it into view once measured. */
  const revealOpened = useRef(false);
  const matchedPin = useRef<{ time: number; key: number } | null>(null);
  const atEnd = useRef(true);

  const openExtra = opened ? extra : 0;
  const total = PAD * 2 + rowCount * PITCH - (rowCount > 0 ? GAP : 0) + openExtra;
  const maxScroll = Math.max(0, total - size.height);
  const rowTop = (row: number) => PAD + row * PITCH + (opened && row > opened.row ? extra : 0);
  const rowAt = (y: number) => {
    let at = y - PAD;
    if (opened) {
      const top = opened.row * PITCH;
      if (at >= top + PITCH + extra) at -= extra;
      else if (at >= top) return opened.row;
    }
    return Math.max(0, Math.min(rowCount - 1, Math.floor(at / PITCH)));
  };

  // Read by the pointer handlers, the fling and the pin lookup, which outlive renders.
  const maxRef = useRef(maxScroll);
  maxRef.current = maxScroll;
  const rowTopRef = useRef(rowTop);
  rowTopRef.current = rowTop;
  const openedRef = useRef(opened);
  openedRef.current = opened;
  const extraRef = useRef(extra);
  extraRef.current = extra;
  const scrollTo = useCallback((y: number) => setScrollY(Math.max(0, Math.min(maxRef.current, y))), []);
  const scrollBy = useCallback((dy: number) => setScrollY((y) => Math.max(0, Math.min(maxRef.current, y + dy))), []);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // A new filter or log starts over, at the newest frames while following a capture.
  useEffect(() => {
    atEnd.current = true;
    setOpened(null);
    setExtra(0);
    setScrollY(follow ? maxRef.current : 0);
    // `follow` is read as it is then.
  }, [filterKey, logVersion]);
  useEffect(() => {
    setSelectedFrame(null);
    matchedPin.current = null;
  }, [logVersion]);
  // Rows are numbered from the oldest frame kept, so a trim moves every one.
  const droppedSeen = useRef(droppedFrames);
  useEffect(() => {
    if (droppedFrames === droppedSeen.current) return;
    droppedSeen.current = droppedFrames;
    setOpened(null);
    setSelectedFrame(null);
  }, [droppedFrames]);
  useEffect(() => {
    if (follow && atEnd.current) setScrollY(maxScroll);
    else setScrollY((y) => Math.min(y, maxScroll));
  }, [maxScroll, follow]);
  useEffect(() => {
    atEnd.current = scrollY >= maxScroll - 1;
    // Judged when the cards move, not when more arrive.
  }, [scrollY]);

  const first = rowCount > 0 ? rowAt(scrollY) : 0;
  const last = rowCount > 0 ? rowAt(scrollY + size.height) : -1;
  const fetchCount = Math.ceil(size.height / PITCH) + 3 * OVERSCAN;
  // Moved in steps, so scrolling fetches again only every few cards.
  const fetchStart = Math.max(0, Math.floor(first / OVERSCAN) * OVERSCAN - OVERSCAN);

  useEffect(() => {
    if (size.height === 0 || rowCount === 0) {
      setBatch(null);
      return;
    }
    let stale = false;
    core.rows(filterKey, fetchStart, fetchCount).then((b) => {
      if (!stale) setBatch(b);
    });
    return () => {
      stale = true;
    };
    // `follow` ends with a capture, which may sort its frames, so the rows are fetched again.
  }, [core, filterKey, fetchStart, fetchCount, size.height, rowCount, logVersion, follow]);

  useEffect(() => {
    if (pinnedTime === null || rowCount === 0) return;
    const matched = matchedPin.current;
    if (matched && matched.time === pinnedTime && matched.key === filterKey) return;
    let stale = false;
    nearestRow(core, filterKey, rowCount, pinnedTime).then(({ row, frame }) => {
      if (stale) return;
      matchedPin.current = { time: pinnedTime, key: filterKey };
      setSelectedFrame(frame);
      const top = rowTopRef.current(row);
      const height = CARD_H + (openedRef.current?.row === row ? extraRef.current : 0);
      setScrollY((y) => (top >= y && top + height <= y + size.height ? y : Math.max(0, Math.min(maxRef.current, top - (size.height - height) / 2))));
    });
    return () => {
      stale = true;
    };
    // Only a new pin is looked for; the view's height is read as it is then.
  }, [core, filterKey, rowCount, pinnedTime]);

  // The open card's height decides where every card after it goes.
  useLayoutEffect(() => {
    const el = openRef.current;
    if (!opened || !el) return;
    const measure = () => setExtra(Math.max(0, el.offsetHeight - CARD_H));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [opened, first, last]);

  useLayoutEffect(() => {
    const el = openRef.current;
    if (!revealOpened.current || !opened || !el) return;
    revealOpened.current = false;
    // Measured here, as the height this render placed the cards with may not have caught up yet.
    const top = rowTop(opened.row);
    const bottom = top + el.offsetHeight;
    if (bottom > scrollY + size.height) setScrollY(Math.max(0, Math.min(top - PAD, bottom - size.height + PAD)));
  });

  useEffect(() => {
    if (focusRow === null) return;
    const card = wrapRef.current?.querySelector<HTMLElement>(`[data-row="${focusRow}"]`);
    if (!card) return;
    // The list places the cards itself; a browser scroll to the focused one would undo that.
    card.focus({ preventScroll: true });
    setFocusRow(null);
  });

  const rows = batch?.key === filterKey ? batch : null;
  const indexIn = (row: number) => (rows && row >= rows.start && row < rows.start + rows.length ? row - rows.start : null);

  // A long J1939 transfer carries more than the row's 64 bytes; the open card shows them all.
  const openAt = opened ? indexIn(opened.row) : null;
  const needsFull = rows !== null && openAt !== null && rows.fullLength(openAt) > rows.len(openAt);
  useEffect(() => {
    if (!opened || !needsFull) return;
    let stale = false;
    core.frameData(filterKey, opened.row).then((data) => {
      if (!stale) setFullData({ frame: opened.frame, data });
    });
    return () => {
      stale = true;
    };
  }, [core, filterKey, opened, needsFull]);

  // Fetched again when the DBCs change, which `lookup` follows.
  useEffect(() => {
    if (!opened) return;
    let stale = false;
    core.decodeFrame(filterKey, opened.row).then((values) => {
      if (!stale) setDecoded({ frame: opened.frame, values });
    });
    return () => {
      stale = true;
    };
  }, [core, filterKey, opened, lookup]);

  const toggle = (row: number) => {
    const i = indexIn(row);
    if (!rows || i === null) return;
    const frame = rows.index(i);
    setFullData(null);
    setDecoded(null);
    if (opened?.row === row) {
      setOpened(null);
      setExtra(0);
      return;
    }
    setOpened({ row, frame });
    setExtra(0);
    setSelectedFrame(frame);
    revealOpened.current = true;
    if (onPin) {
      const time = rows.time(i);
      matchedPin.current = { time, key: rows.key };
      onPin(time);
    }
  };

  // Touch scrolling, with a fling. The cards are buttons, so a tap reaches them as a click.
  const gesture = useRef<{ id: number; startY: number; lastY: number; lastT: number; velocity: number; moved: boolean } | null>(null);
  const fling = useRef(0);
  /** A drag or a touch that stopped a fling; the click that follows it opens nothing. */
  const swallowClick = useRef(false);
  const stopFling = () => {
    if (!fling.current) return false;
    cancelAnimationFrame(fling.current);
    fling.current = 0;
    return true;
  };
  useEffect(() => () => void stopFling(), []);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' || !e.isPrimary) return;
    swallowClick.current = stopFling();
    gesture.current = { id: e.pointerId, startY: e.clientY, lastY: e.clientY, lastT: e.timeStamp, velocity: 0, moved: false };
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g || g.id !== e.pointerId) return;
    if (!g.moved) {
      if (Math.abs(e.clientY - g.startY) < DRAG_SLOP) return;
      g.moved = true;
      swallowClick.current = true;
      e.currentTarget.setPointerCapture(e.pointerId);
    }
    const dy = e.clientY - g.lastY;
    const dt = Math.max(1, e.timeStamp - g.lastT);
    // Smoothed, so one late event doesn't decide the fling.
    g.velocity = 0.8 * (dy / dt) + 0.2 * g.velocity;
    g.lastY = e.clientY;
    g.lastT = e.timeStamp;
    scrollBy(-dy);
  };
  const onPointerEnd = (e: PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g || g.id !== e.pointerId) return;
    gesture.current = null;
    if (!g.moved || e.type === 'pointercancel' || Math.abs(g.velocity) < 0.05) return;
    let velocity = g.velocity;
    let last = performance.now();
    const step = (now: number) => {
      const dt = now - last;
      last = now;
      velocity *= FLING_DECAY ** dt;
      scrollBy(-velocity * dt);
      fling.current = Math.abs(velocity) > 0.02 ? requestAnimationFrame(step) : 0;
    };
    fling.current = requestAnimationFrame(step);
  };

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      stopFling();
      scrollBy(e.deltaMode === 1 ? e.deltaY * 32 : e.deltaMode === 2 ? e.deltaY * el.clientHeight : e.deltaY);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [scrollBy]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const from = (e.target as HTMLElement).closest<HTMLElement>('[data-row]')?.dataset.row;
    if (from === undefined || e.ctrlKey || e.metaKey || e.altKey) return;
    const page = Math.max(1, Math.floor(size.height / PITCH) - 1);
    const step: Record<string, number> = { ArrowDown: 1, ArrowUp: -1, PageDown: page, PageUp: -page, Home: -Infinity, End: Infinity };
    if (!(e.key in step)) return;
    e.preventDefault();
    stopFling();
    const row = Math.max(0, Math.min(rowCount - 1, Number(from) + step[e.key]));
    const top = rowTop(row);
    const bottom = top + CARD_H + (opened?.row === row ? extra : 0);
    if (top < scrollY + PAD) scrollTo(top - PAD);
    else if (bottom > scrollY + size.height - PAD) scrollTo(bottom - size.height + PAD);
    setFocusRow(row);
  };

  // Scrollbar thumb, which a finger can drag through a long log far faster than flinging.
  const track = size.height;
  const thumbH = total > 0 ? Math.max(44, Math.min(track, (track * size.height) / total)) : track;
  const thumbTop = maxScroll > 0 ? (scrollY / maxScroll) * (track - thumbH) : 0;
  const onThumbDown = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    stopFling();
    const startY = e.clientY;
    const startScroll = scrollY;
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    setDragging(true);
    const move = (ev: globalThis.PointerEvent) => {
      const span = track - thumbH;
      if (span > 0) scrollTo(startScroll + ((ev.clientY - startY) / span) * maxRef.current);
    };
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', up);
      setDragging(false);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
  };

  const cards = [];
  for (let row = first; row <= last; row++) {
    const i = indexIn(row);
    const top = rowTop(row) - scrollY;
    if (!rows || i === null) {
      cards.push(<div key={row} role="listitem" className="tc-card tc-loading" style={{ top }} aria-busy="true" aria-setsize={rowCount} aria-posinset={row + 1} />);
      continue;
    }
    const isOpen = opened?.row === row;
    cards.push(
      <FrameCard
        key={row}
        ref={isOpen ? openRef : undefined}
        rows={rows}
        i={i}
        row={row}
        rowCount={rowCount}
        top={top}
        open={isOpen}
        selected={rows.index(i) === selectedFrame}
        fullData={isOpen && fullData?.frame === rows.index(i) ? fullData.data : null}
        values={isOpen && decoded?.frame === rows.index(i) ? decoded.values : null}
        channels={channels}
        hasDbc={hasDbc}
        lookup={lookup}
        matched={matchedBytes?.(rows, i) ?? []}
        onToggle={() => toggle(row)}
        onPlotMessage={onPlotMessage}
      />,
    );
  }

  return (
    <div
      ref={wrapRef}
      className="tc"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onClickCapture={(e) => {
        if (!swallowClick.current) return;
        swallowClick.current = false;
        e.stopPropagation();
        e.preventDefault();
      }}
      onKeyDown={onKeyDown}
    >
      <div role="list" aria-label="Frames">
        {cards}
      </div>
      <div className="scrollbar tc-scrollbar" aria-hidden>
        {maxScroll > 0 && <div className={`thumb${dragging ? ' dragging' : ''}`} style={{ top: thumbTop, height: thumbH }} onPointerDown={onThumbDown} />}
      </div>
    </div>
  );
}

interface CardProps {
  ref?: Ref<HTMLDivElement>;
  rows: RowBatch;
  i: number;
  row: number;
  rowCount: number;
  top: number;
  open: boolean;
  selected: boolean;
  fullData: Uint8Array | null;
  /** The open card's decoded signals; null while they load. */
  values: FrameValue[] | null;
  channels: string[];
  hasDbc: boolean;
  lookup: (channel: number, id: number) => FrameLookup;
  matched: number[];
  onToggle: () => void;
  onPlotMessage: (key: number, time: number) => void;
}

const MISSING_TEXT: Record<Exclude<FrameValue['missing'], null | 'absent'>, string> = {
  short: 'Not in this frame',
  reserved: 'Reserved',
  error: 'Error',
  notAvailable: 'Not available',
};

/** A decoded value as the card shows it: its label, its value and unit, or why it has none. */
function valueText(v: FrameValue): string {
  if (v.missing && v.missing !== 'absent') return MISSING_TEXT[v.missing];
  if (v.label !== null) return v.label;
  const value = formatValue(v.value ?? NaN);
  return v.unit ? `${value} ${v.unit}` : value;
}

function FrameCard({ ref, rows, i, row, rowCount, top, open, selected, fullData, values, channels, hasDbc, lookup, matched, onToggle, onPlotMessage }: CardProps) {
  const id = rows.id(i);
  const flags = rows.flags(i);
  const channel = rows.channel(i);
  const extended = (id & EXT_FLAG) !== 0;
  const error = (flags & FLAG_ERROR) !== 0;
  const remote = (flags & FLAG_RTR) !== 0;
  const data = fullData ?? rows.data(i);
  const length = rows.fullLength(i);
  const found = error ? null : lookup(channel, id >>> 0);
  const name = error ? idLabel({ id: (id & ~EXT_FLAG) >>> 0, extended, flags }) : (found?.name ?? (hasDbc ? 'Unknown' : null));
  const more = !open && length > SHOWN_BYTES;
  const time = rows.time(i);
  const shown = open ? data : data.subarray(0, SHOWN_BYTES);
  const detailParts = [name, flags & FLAG_FD ? 'FD' : null, remote ? 'Remote frame' : `${length} ${length === 1 ? 'byte' : 'bytes'}`].filter(Boolean);
  const where = `${error ? 'Error frame' : formatId(id & 0x1fff_ffff, extended)} on ${channels[channel] ?? 'an unknown bus'}`;
  const label = [`${time.toFixed(6)} s`, where, ...detailParts].join(', ');
  const decoding = open && !!found?.message && !remote;
  const shownValues = decoding && values ? values.filter((v) => v.missing !== 'absent') : null;

  return (
    <div
      ref={ref}
      role="listitem"
      className={`tc-card${open ? ' open' : ''}${selected ? ' selected' : ''}${more ? ' more' : ''}`}
      style={{ top }}
      aria-setsize={rowCount}
      aria-posinset={row + 1}
    >
      <button type="button" className="tc-head" data-row={row} aria-label={label} aria-expanded={open} onClick={onToggle}>
        <span className="tc-line">
          <span className="tc-time num">{time.toFixed(6)} s</span>
          <span className="tc-where">
            <span className={`mono${error ? ' tc-error' : ''}`}>{error ? 'ERR' : formatId(id & 0x1fff_ffff, extended)}</span> &middot; {channels[channel] ?? '?'}
          </span>
        </span>
        <span className="tc-line tc-details">{detailParts.join(' \u00b7 ')}</span>
        {shown.length > 0 && (
          <span className={`tc-bytes mono${open ? ' all' : ''}`}>
            {Array.from(shown, (b, k) => (
              <span key={k} className={`tc-byte${rows.changed(i, k) ? ' changed' : ''}${matched.includes(k) ? ' matched' : ''}`}>
                {HEX[b]}
              </span>
            ))}
          </span>
        )}
        <span className="tc-chevron" aria-hidden="true">
          {open ? <ChevronDown size={18} strokeWidth={1.5} /> : <ChevronRight size={18} strokeWidth={1.5} />}
        </span>
      </button>
      {more && (
        <button type="button" className="tc-more" onClick={onToggle}>
          View all {length} bytes
        </button>
      )}
      {open && (
        <div className="tc-detail">
          {length > data.length && <p className="tc-note">Showing the first {data.length} of {length} bytes.</p>}
          {decoding && !shownValues && (
            <p className="tc-note" aria-busy="true">
              Decoding&hellip;
            </p>
          )}
          {shownValues && shownValues.length > 0 && (
            <section aria-label="Decoded values">
              <h3 className="tc-detail-title">Decoded values</h3>
              <dl className="tc-values">
                {shownValues.map((v) => (
                  <div key={v.name} className="tc-value">
                    <dt>{v.name}</dt>
                    <dd className="mono">{valueText(v)}</dd>
                  </div>
                ))}
              </dl>
            </section>
          )}
          {!error && !found?.message && <p className="tc-note">{hasDbc ? 'No loaded DBC describes this ID.' : 'Open a DBC to decode this frame.'}</p>}
          {found?.message && found.key !== null && found.message.signals.length > 0 && (
            <button type="button" className="tc-plot" onClick={() => onPlotMessage(found.key!, time)}>
              <ChartLine size={16} strokeWidth={1.5} aria-hidden="true" />
              Plot this message
              <ChevronRight size={16} strokeWidth={1.5} aria-hidden="true" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
