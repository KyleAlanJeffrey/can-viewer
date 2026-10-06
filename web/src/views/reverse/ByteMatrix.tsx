import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { ArrowRight, Pin as PinIcon, PinOff } from 'lucide-react';
import { FLAG_FD, FLAG_REASSEMBLED, formatId, type ByteLane, type IdSummary, type MessageDef } from '../../core/api';
import { formatCount } from '../../format';
import { useViewState } from '../shared/viewState';
import type { ViewContext } from '../types';
import { changesIn, hexByte, lastIn, type TimeWindow } from './bits';
import { LaneSpark } from './LaneSpark';
import { pinId, type Pin } from './pins';
import { describeBytes } from './suggestionList';
import { useFrameAt } from './useFrameAt';

const BUCKETS = 80;
const LANES = 8;
/** Rows beyond this are left out with a note; a search or bus filter brings them in. */
const MAX_ROWS = 200;
/** Rows fetched per round trip, so a long list fills in progressively. */
const FETCH_BATCH = 12;
/** How long a pick waits for its row's sparklines before scrolling to it anyway. */
const MARK_SCROLL_WAIT_MS = 1500;

export interface SelectedByte {
  key: number;
  byte: number;
}

/** The selected suggestion, outlined over the bytes it covers in its message's row. */
export interface SuggestionMark {
  key: number;
  number: number;
  bytes: number[];
  /** Its bits, such as `bit 12` or `bits 16-31`. */
  bits: string;
}

interface Props {
  ctx: ViewContext;
  /** Messages to show, already filtered and sorted. */
  rows: IdSummary[];
  window: TimeWindow;
  cursor: number | null;
  bus: string | null;
  onBus: (bus: string | null) => void;
  selectedByte: SelectedByte | null;
  suggestion: SuggestionMark | null;
  pins: Pin[];
  onSelectRow: (key: number) => void;
  onSelectByte: (selected: SelectedByte) => void;
  onHover: (t: number | null) => void;
  onPark: (t: number) => void;
  onTogglePin: (pin: Pin) => void;
  onOpenAdvanced: () => void;
}

/** Whether the selection is the suggestion's. Picking another byte selects that byte; the outline stays. */
export function onSuggestion(mark: SuggestionMark, selectedByte: SelectedByte | null): boolean {
  return !selectedByte || (selectedByte.key === mark.key && mark.bytes.includes(selectedByte.byte));
}

/** One table row: a message's first eight bytes, or a further group of eight of a longer payload. */
interface RowSpec {
  summary: IdSummary;
  message: MessageDef | null;
  first: number;
}

const specKey = (key: number, first: number) => `${key}:${first}`;

/**
 * Every message's bytes across the window as a matrix of sparklines, on one shared time
 * window and cursor. Selecting a byte never hides other rows; the bus and search filters do.
 */
export function ByteMatrix(props: Props) {
  const { ctx, rows, window: win, cursor, bus, onBus, selectedByte, suggestion, pins, onSelectRow, onSelectByte, onHover, onPark, onTogglePin, onOpenAdvanced } = props;
  const { core, log, logVersion, messageOf, selected } = ctx;
  const [changingOnly, setChangingOnly] = useViewState('re.changingOnly', false);
  const [expanded, setExpanded] = useViewState<number[]>('re.expanded', [], 'log');
  const [t0, t1] = win;

  const specs = useMemo<RowSpec[]>(
    () =>
      rows.flatMap((summary) => {
        const message = messageOf(summary.key);
        const groups = expanded.includes(summary.key) ? Math.ceil(summary.maxLen / LANES) : 1;
        return Array.from({ length: Math.max(1, groups) }, (_, g) => ({ summary, message, first: g * LANES }));
      }),
    [rows, messageOf, expanded],
  );

  const lanes = useByteLanes(core, specs, win, logVersion);
  const markedCell = useRef<HTMLButtonElement>(null);
  const markId = suggestion ? `${suggestion.key}:${suggestion.number}` : null;
  const lastMark = useRef(markId);
  // Rows grow once their sparklines arrive, so scrolling waits for the marked row's.
  const markReady = suggestion !== null && lanes.has(specKey(suggestion.key, suggestion.bytes[0] - (suggestion.bytes[0] % LANES)));
  // A suggestion picked across all messages can be for a row out of view, or a byte the table
  // has scrolled sideways past. Only a new pick scrolls, so coming back keeps the position.
  useEffect(() => {
    if (markId === null || markId === lastMark.current) return;
    const scroll = () => {
      lastMark.current = markId;
      markedCell.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    };
    if (markReady) {
      scroll();
      return;
    }
    // Sparklines that fail, or are slow, still let the pick scroll.
    const fallback = setTimeout(scroll, MARK_SCROLL_WAIT_MS);
    return () => clearTimeout(fallback);
  }, [markId, markReady]);
  const frame = useFrameAt(core, selected === -1 ? null : selected, cursor, logVersion);
  const pinnedBytes = useMemo(() => new Set(pins.filter((p) => p.kind === 'byte').map(pinId)), [pins]);

  const shown = useMemo(() => {
    if (!changingOnly) return specs;
    const changing = new Set<number>();
    for (const spec of specs) {
      const row = lanes.get(specKey(spec.summary.key, spec.first));
      if (!row || row.some((lane) => changesIn(lane, win))) changing.add(spec.summary.key);
    }
    return specs.filter((spec) => changing.has(spec.summary.key));
  }, [specs, lanes, changingOnly, win]);
  const visible = shown.slice(0, MAX_ROWS);
  // The bus filter, the search or Changing bytes only can leave the outline nowhere to show.
  const markHidden = suggestion !== null && !visible.some((spec) => spec.summary.key === suggestion.key);
  const hiddenCount = shown.length - visible.length;

  const timeAt = (e: MouseEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return t0 + (Math.min(Math.max(0, e.clientX - r.left), r.width) / Math.max(1, r.width)) * (t1 - t0);
  };
  const toggleExpanded = (key: number) => setExpanded((keys) => (keys.includes(key) ? keys.filter((k) => k !== key) : [...keys, key]));

  const selectedSummary = selected === -1 ? null : (rows.find((s) => s.key === selected) ?? null);
  const bytePin: Pin | null = selectedByte ? { kind: 'byte', key: selectedByte.key, byte: selectedByte.byte } : null;
  const bytePinned = bytePin ? pinnedBytes.has(pinId(bytePin)) : false;
  const selectionLabel = suggestion && onSuggestion(suggestion, selectedByte)
    ? `${idText(ctx.ids, suggestion.key)} \u00b7 ${describeBytes(suggestion.bytes)} \u00b7 ${suggestion.bits}`
    : selectedByte
    ? `${idText(ctx.ids, selectedByte.key)} \u00b7 Byte ${selectedByte.byte}`
    : selectedSummary
      ? idText(rows, selectedSummary.key)
      : null;

  return (
    <>
      <section className="card re-card re-matrix" aria-labelledby="re-matrix-title">
        <div className="re-card-head">
          <h3 className="section-title" id="re-matrix-title">
            Byte values
          </h3>
          <span className="re-card-note">
            Each cell shows {t0.toFixed(t0 % 1 ? 1 : 0)} to {t1.toFixed(t1 % 1 ? 1 : 0)} s {'\u00b7'} raw values 0 to 255
          </span>
          <div className="re-matrix-tools">
            <label>
              <span className="sr-only">Bus</span>
              <select className="select" value={bus ?? ''} onChange={(e) => onBus(e.target.value || null)}>
                <option value="">All buses</option>
                {log?.channels.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <label className="re-check">
              <input type="checkbox" checked={changingOnly} onChange={(e) => setChangingOnly(e.target.checked)} />
              Changing bytes only
            </label>
          </div>
        </div>
        {visible.length === 0 ? (
          <p className="hint">{rows.length === 0 ? 'No messages match.' : 'No byte changes in this window. Widen it, or turn off Changing bytes only.'}</p>
        ) : (
          <div className="re-table-scroll">
            <table className="re-table">
              <thead>
                <tr>
                  <th scope="col" className="re-th-msg">
                    Message
                  </th>
                  {Array.from({ length: LANES }, (_, k) => (
                    <th key={k} scope="col" className="mono">
                      B{k}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visible.map((spec) => {
                  const { summary, message, first } = spec;
                  const key = summary.key;
                  const row = lanes.get(specKey(key, first)) ?? null;
                  const isSelectedRow = key === selected;
                  const id = formatId(summary.id, summary.extended);
                  const long = summary.maxLen > LANES;
                  const isExpanded = expanded.includes(key);
                  const mark = suggestion?.key === key ? suggestion : null;
                  return (
                    <tr key={specKey(key, first)} className={isSelectedRow ? 're-row-selected' : undefined}>
                      <th scope="row">
                        {first === 0 ? (
                          <button type="button" className="re-row-head" onClick={() => onSelectRow(key)} aria-pressed={isSelectedRow}>
                            <span className="re-row-id">
                              <span className="mono">{id}</span>
                              {message ? (
                                <span className="re-row-name">{message.name}</span>
                              ) : (
                                <span className="status unknown">Unknown</span>
                              )}
                              <span className="re-row-bus mono">{log?.channels[summary.channel]}</span>
                            </span>
                          </button>
                        ) : (
                          <span className="re-row-group mono">
                            B{first}-{Math.min(first + LANES, summary.maxLen) - 1}
                          </span>
                        )}
                        {first === 0 && long && (
                          <span className="re-row-note">
                            <span>
                              {lengthNote(summary, isExpanded)}
                            </span>
                            <button type="button" className="text-button" onClick={() => toggleExpanded(key)}>
                              {isExpanded ? 'Fewer' : 'View all'}
                            </button>
                          </span>
                        )}
                      </th>
                      {Array.from({ length: LANES }, (_, k) => {
                        const byte = first + k;
                        const lane = row?.[k] ?? null;
                        const carried = byte < summary.maxLen;
                        const isSelected = selectedByte?.key === key && selectedByte.byte === byte;
                        const still = changingOnly && row !== null && (!lane || !changesIn(lane, win));
                        const pinned = pinnedBytes.has(pinId({ kind: 'byte', key, byte }));
                        const marked = mark !== null && mark.bytes.includes(byte);
                        const value = isSelectedRow ? valueText(frame?.key === key ? frame.data : null, byte, lane, win, cursor) : null;
                        return (
                          <td key={k}>
                            {carried ? (
                              <button
                                ref={marked && byte === mark.bytes[0] ? markedCell : undefined}
                                type="button"
                                className={`re-cell${isSelected ? ' selected' : ''}${marked ? ' suggested' : ''}${still ? ' still' : ''}`}
                                aria-pressed={isSelected}
                                aria-label={`${id} byte ${byte}${value ? `, ${value} hex` : ''}${pinned ? ', pinned' : ''}${marked ? `, suggestion ${mark.number}` : ''}`}
                                onClick={(e) => {
                                  onSelectByte({ key, byte });
                                  onPark(timeAt(e));
                                }}
                                onMouseMove={(e) => onHover(timeAt(e))}
                                onMouseLeave={() => onHover(null)}
                              >
                                <LaneSpark trace={lane} window={win} cursor={cursor} />
                                {marked && (
                                  <span className="re-cell-badge" aria-hidden="true">
                                    {mark.number}
                                  </span>
                                )}
                                {pinned && <PinIcon className="re-cell-pin" size={12} strokeWidth={2} aria-hidden="true" />}
                                {value && <span className="re-cell-value mono">{value}</span>}
                              </button>
                            ) : (
                              <span className="re-cell none" title="No frame carries this byte" />
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {hiddenCount > 0 && (
              <p className="hint re-matrix-more">
                {formatCount(hiddenCount)} more {hiddenCount === 1 ? 'message' : 'messages'}. Filter by bus or search to see them.
              </p>
            )}
          </div>
        )}
      </section>
      <div className="re-matrix-foot">
        {selectionLabel ? (
          <span className="re-matrix-sel">
            <span className="mono">{selectionLabel}</span>
            {markHidden && <span className="re-matrix-hint"> Its row is filtered out of the table.</span>}
          </span>
        ) : (
          <span className="re-matrix-hint">Select a byte to pin it beside the references, or open its message in Advanced.</span>
        )}
        <button type="button" className="button" disabled={!bytePin} onClick={() => bytePin && onTogglePin(bytePin)}>
          {bytePinned ? <PinOff size={16} strokeWidth={1.5} aria-hidden="true" /> : <PinIcon size={16} strokeWidth={1.5} aria-hidden="true" />}
          {bytePinned ? 'Unpin byte' : 'Pin byte'}
        </button>
        <button type="button" className="button" disabled={!selectedSummary} onClick={onOpenAdvanced}>
          Open in Advanced
          <ArrowRight size={16} strokeWidth={1.5} aria-hidden="true" />
        </button>
      </div>
    </>
  );
}

/** The length of a payload longer than eight bytes, after what carries it. */
function lengthNote(s: IdSummary, expanded: boolean): string {
  const kind = s.flags & FLAG_FD ? 'CAN FD \u00b7 ' : s.flags & FLAG_REASSEMBLED ? 'J1939 TP \u00b7 ' : '';
  return kind + (expanded ? `${s.maxLen} bytes` : `B0-7 of ${s.maxLen}`);
}

function idText(rows: IdSummary[], key: number): string {
  const s = rows.find((r) => r.key === key);
  return s ? formatId(s.id, s.extended) : '?';
}

/** The byte at the cursor from the frame there, else the window's last value from the sparkline's points. */
function valueText(data: Uint8Array | null, byte: number, lane: ByteLane | null, win: TimeWindow, cursor: number | null): string | null {
  if (cursor !== null && data) return byte < data.length ? hexByte(data[byte]) : '--';
  if (cursor !== null) return null;
  const last = lane ? lastIn(lane, win) : null;
  return last ? hexByte(last.v) : null;
}

/** Sparkline data for every row, fetched in batches so long lists fill in as they arrive. */
function useByteLanes(core: ViewContext['core'], specs: RowSpec[], [t0, t1]: TimeWindow, logVersion: number): Map<string, ByteLane[]> {
  const [lanes, setLanes] = useState(new Map<string, ByteLane[]>());
  const generation = useRef(0);
  const wanted = specs.map((s) => specKey(s.summary.key, s.first)).join(',');

  useEffect(() => {
    const run = ++generation.current;
    setLanes(new Map());
    void (async () => {
      for (let at = 0; at < specs.length && run === generation.current; at += FETCH_BATCH) {
        const batch = specs.slice(at, at + FETCH_BATCH);
        const results = await Promise.all(
          batch.map((spec) => core.byteLanes(spec.summary.key, spec.first, LANES, t0, t1, BUCKETS).catch(() => null)),
        );
        if (run !== generation.current) return;
        setLanes((prev) => {
          const next = new Map(prev);
          batch.forEach((spec, i) => {
            const got = results[i];
            if (got) next.set(specKey(spec.summary.key, spec.first), got);
          });
          return next;
        });
      }
    })();
  }, [core, wanted, t0, t1, logVersion]);

  return lanes;
}
