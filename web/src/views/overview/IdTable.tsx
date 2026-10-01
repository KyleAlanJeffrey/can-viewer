import { useEffect, useMemo, useRef, type CSSProperties, type KeyboardEvent } from 'react';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { FLAG_FD, idLabel, isErrorFrame, type IdSummary, type MessageDef } from '../../core/api';
import { formatCount, formatPeriod } from '../../format';
import { useViewState } from '../shared/viewState';
import type { ViewContext } from '../types';

type SortKey = 'bus' | 'id' | 'name' | 'bytes' | 'count' | 'period' | 'jitter' | 'rate' | 'dbc';
type Direction = 'ascending' | 'descending';

interface Sort {
  key: SortKey;
  dir: Direction;
}

const DEFAULT_SORT: Sort = { key: 'bus', dir: 'ascending' };

interface Column {
  key: SortKey;
  label: string;
  numeric?: boolean;
  /** Direction of the first click: biggest first where the biggest is the interesting end. */
  first: Direction;
}

const COLUMNS: Column[] = [
  { key: 'bus', label: 'Bus', first: 'ascending' },
  { key: 'id', label: 'ID', first: 'ascending' },
  { key: 'name', label: 'Name', first: 'ascending' },
  { key: 'bytes', label: 'Bytes', numeric: true, first: 'ascending' },
  { key: 'count', label: 'Count', numeric: true, first: 'descending' },
  { key: 'period', label: 'Period', numeric: true, first: 'ascending' },
  { key: 'jitter', label: 'Jitter', numeric: true, first: 'descending' },
  { key: 'rate', label: 'Rate', numeric: true, first: 'descending' },
  { key: 'dbc', label: 'DBC', first: 'ascending' },
];

const HEAD_H = 28;
const ROW_H = 24;

interface Row {
  summary: IdSummary;
  name: string | null;
  /** File name of the DBC that decodes it. */
  dbc: string | null;
  /** Frames per second averaged over the whole log. */
  rate: number | null;
}

const sortValue: Record<SortKey, (r: Row) => number | string | null> = {
  bus: (r) => r.summary.channel,
  id: (r) => r.summary.id,
  name: (r) => r.name?.toLowerCase() ?? null,
  bytes: (r) => r.summary.maxLen,
  count: (r) => r.summary.count,
  period: (r) => r.summary.periodMs,
  jitter: (r) => r.summary.jitterMs ?? null,
  rate: (r) => r.rate,
  dbc: (r) => r.dbc?.toLowerCase() ?? null,
};

/** Bus then ID, the order ties fall back to. */
const naturalOrder = (a: Row, b: Row) => a.summary.channel - b.summary.channel || a.summary.id - b.summary.id;

/** Same match as the sidebar list: ID, message name or any of its signal names. */
function matchesQuery(s: IdSummary, message: MessageDef | null, q: string): boolean {
  return (
    idLabel(s).toLowerCase().includes(q) ||
    (s.name ?? '').toLowerCase().includes(q) ||
    (message?.signals.some((sig) => sig.name.toLowerCase().includes(q)) ?? false)
  );
}

/** Every bus/ID pair with its timing, sortable, filtered by the sidebar search. */
export function IdTable({ ctx }: { ctx: ViewContext }) {
  const { ids, messageOf, dbcOf, dbcs, query, selected, select, setView, log } = ctx;
  const [savedSort, setSort] = useViewState<Sort>('ov.sort', DEFAULT_SORT);
  // A sort saved by an older version may name a column that no longer exists.
  const sort = savedSort.key in sortValue ? savedSort : DEFAULT_SORT;
  const bodyRef = useRef<HTMLTableSectionElement>(null);
  const channels = log?.channels ?? [];
  const durationS = log?.durationS ?? 0;

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all: Row[] = [];
    for (const summary of ids) {
      const message = messageOf(summary.key);
      if (q && !matchesQuery(summary, message, q)) continue;
      all.push({
        summary,
        // Error frames come from no message; they are named rather than left unknown.
        name: message?.name ?? summary.name ?? (isErrorFrame(summary) ? 'Error frames' : null),
        dbc: dbcOf(summary.key)?.db.name ?? null,
        rate: durationS > 0 ? summary.count / durationS : null,
      });
    }
    const value = sortValue[sort.key];
    const sign = sort.dir === 'ascending' ? 1 : -1;
    return all.sort((a, b) => {
      const va = value(a);
      const vb = value(b);
      // Missing values stay at the bottom in either direction.
      if (va === null || vb === null) return va === vb ? naturalOrder(a, b) : va === null ? 1 : -1;
      const order = typeof va === 'string' ? va.localeCompare(vb as string) : va - (vb as number);
      return sign * order || naturalOrder(a, b);
    });
  }, [ids, messageOf, dbcOf, query, sort, durationS]);

  useEffect(() => {
    bodyRef.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const onSort = (column: Column) =>
    setSort(
      sort.key === column.key
        ? { key: sort.key, dir: sort.dir === 'ascending' ? 'descending' : 'ascending' }
        : { key: column.key, dir: column.first },
    );

  const openInTrace = (key: number) => {
    select(key);
    setView('trace');
  };

  const onRowKeyDown = (e: KeyboardEvent<HTMLTableRowElement>, key: number) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      openInTrace(key);
    } else if (e.key === ' ') {
      e.preventDefault();
      select(key);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = (e.key === 'ArrowDown' ? e.currentTarget.nextElementSibling : e.currentTarget.previousElementSibling) as HTMLElement | null;
      if (next?.dataset.key) {
        next.focus();
        select(Number(next.dataset.key));
      }
    }
  };

  const fitHeight = HEAD_H + ROW_H * Math.max(1, rows.length) + 2;
  // One tab stop for the whole table; the arrow keys move between rows.
  const focusKey = rows.some((r) => r.summary.key === selected) ? selected : rows[0]?.summary.key;
  return (
    <div className="ov-table card" style={{ '--ov-table-h': `${fitHeight}px` } as CSSProperties}>
      <table>
        <caption className="sr-only">Message IDs. Arrow keys select a row; Enter opens it in Trace.</caption>
        <thead>
          <tr>
            {COLUMNS.map((c) => {
              const active = sort.key === c.key;
              const Arrow = sort.dir === 'ascending' ? ArrowUp : ArrowDown;
              const arrow = active ? <Arrow size={12} strokeWidth={2} aria-hidden="true" /> : null;
              return (
                <th key={c.key} scope="col" aria-sort={active ? sort.dir : undefined} className={c.numeric ? 'ov-num' : undefined}>
                  <button type="button" className="ov-sort" onClick={() => onSort(c)}>
                    {c.numeric && arrow}
                    {c.label}
                    {!c.numeric && arrow}
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody ref={bodyRef}>
          {rows.length === 0 && (
            <tr>
              <td colSpan={COLUMNS.length} className="ov-empty">
                {query.trim() ? 'No IDs or signals match.' : 'No IDs in this log.'}
              </td>
            </tr>
          )}
          {rows.map(({ summary: s, name, dbc, rate }) => (
            <tr
              key={s.key}
              data-key={s.key}
              tabIndex={s.key === focusKey ? 0 : -1}
              aria-current={selected === s.key ? 'true' : undefined}
              onClick={() => select(s.key)}
              onDoubleClick={() => openInTrace(s.key)}
              onKeyDown={(e) => onRowKeyDown(e, s.key)}
            >
              <td>{channels[s.channel] ?? s.channel}</td>
              <td>
                {idLabel(s)}
                {s.flags & FLAG_FD ? <span className="tag">FD</span> : null}
              </td>
              <td className="ov-name">
                {isErrorFrame(s) ? (
                  <span className="ov-human">{name}</span>
                ) : (
                  (name ?? (dbcs.length > 0 ? <span className="status unknown ov-human">Unknown</span> : <Dash label="No DBC loaded" />))
                )}
              </td>
              <td className="ov-num">{s.minLen === s.maxLen ? s.maxLen : `${s.minLen}\u2013${s.maxLen}`}</td>
              <td className="ov-num">{formatCount(s.count)}</td>
              <td className="ov-num">{s.periodMs === null ? <Dash label="Too few frames" /> : formatPeriod(s.periodMs)}</td>
              <td className="ov-num">{s.jitterMs == null ? <Dash label="Too few frames" /> : formatJitter(s.jitterMs)}</td>
              <td className="ov-num">{rate === null ? <Dash label="Log too short" /> : formatRate(rate)}</td>
              <td>
                {dbc ? (
                  <span className="ov-dbc-cell ov-human" title={dbc}>
                    {dbc}
                  </span>
                ) : (
                  <Dash label={isErrorFrame(s) ? 'Error frames have no message' : 'Not decoded'} />
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Dash({ label }: { label: string }) {
  return (
    <span className="ov-dash">
      <span aria-hidden="true">&mdash;</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}

function formatJitter(ms: number): string {
  if (ms < 1) return `${ms.toFixed(2)} ms`;
  if (ms < 10) return `${ms.toFixed(1)} ms`;
  return `${Math.round(ms)} ms`;
}

function formatRate(hz: number): string {
  if (hz >= 9.95) return `${Math.round(hz)} Hz`;
  if (hz >= 0.995) return `${hz.toFixed(1)} Hz`;
  return `${hz.toPrecision(2)} Hz`;
}
