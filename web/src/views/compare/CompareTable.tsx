import { Fragment, useEffect, useMemo, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { formatId, type CompareOptions, type IdComparison } from '../../core/api';
import { useViewState } from '../shared/viewState';
import { IgnoreRules } from './IgnoreRules';
import { GROUPS, SHOW_OPTIONS, formatRate, groupOf, matchesQuery, rowKey, SIGNIFICANT, withinANote, type GroupId, type Show } from './findings';

interface Props {
  /** Null while the comparison runs. */
  results: IdComparison[] | null;
  show: Show;
  query: string;
  selected: string | null;
  onSelect: (c: IdComparison) => void;
  /** Enter on a row. */
  onOpen: (c: IdComparison) => void;
  hasDbc: boolean;
  options: CompareOptions;
  onOptions: (options: CompareOptions) => void;
  /** Says how buses were paired when the logs name them differently. */
  busNote: string | null;
}

const COLUMNS = 6;

/** Every compared ID in groups, most different first, with the ignore rules at the foot. */
export function CompareTable({ results, show, query, selected, onSelect, onOpen, hasDbc, options, onOptions, busNote }: Props) {
  const [collapsed, setCollapsed] = useViewState<GroupId[]>('cmp.collapsed', []);
  const bodyRef = useRef<HTMLTableSectionElement>(null);

  const groups = useMemo(() => {
    const wanted = SHOW_OPTIONS.find((o) => o.id === show)?.groups ?? [];
    return GROUPS.filter((g) => wanted.includes(g.id)).map((g) => ({
      ...g,
      rows: (results ?? []).filter((c) => groupOf(c) === g.id && matchesQuery(c, query)),
    }));
  }, [results, show, query]);

  const manyBuses = new Set((results ?? []).map((c) => c.bus)).size > 1;
  const visible = groups.flatMap((g) => (collapsed.includes(g.id) ? [] : g.rows));
  // One tab stop for the whole table; the arrow keys move between rows.
  const focusKey = visible.some((c) => rowKey(c) === selected) ? selected : visible[0] ? rowKey(visible[0]) : null;

  useEffect(() => {
    bodyRef.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const toggle = (id: GroupId) => setCollapsed((all) => (all.includes(id) ? all.filter((g) => g !== id) : [...all, id]));

  const onRowKeyDown = (e: KeyboardEvent<HTMLTableRowElement>, c: IdComparison) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      onOpen(c);
    } else if (e.key === ' ') {
      e.preventDefault();
      onSelect(c);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const rows = [...(bodyRef.current?.querySelectorAll<HTMLElement>('tr[data-row]') ?? [])];
      const next = rows[rows.indexOf(e.currentTarget) + (e.key === 'ArrowDown' ? 1 : -1)];
      const target = next && visible.find((v) => rowKey(v) === next.dataset.row);
      if (target) {
        next.focus();
        onSelect(target);
      }
    }
  };

  const total = groups.reduce((n, g) => n + g.rows.length, 0);
  const noneDifferent = !!results && !results.some((c) => groupOf(c) === 'different');
  const hiddenWithinA = noneDifferent ? withinANote(results) : null;
  let body: ReactNode;
  if (results === null) {
    body = <EmptyRow>Comparing the logs&hellip;</EmptyRow>;
  } else if (total === 0) {
    body = (
      <EmptyRow>
        {query.trim() ? 'No IDs or names match.' : 'No IDs to show here.'}
        {hiddenWithinA && ` ${hiddenWithinA}`}
      </EmptyRow>
    );
  } else {
    body = groups.map((g) =>
      g.rows.length === 0 ? null : (
        <Fragment key={g.id}>
          <tr className="cmp-group">
            <th colSpan={COLUMNS} scope="rowgroup">
              <button type="button" className="cmp-group-head" aria-expanded={!collapsed.includes(g.id)} onClick={() => toggle(g.id)}>
                {collapsed.includes(g.id) ? <ChevronRight size={14} strokeWidth={1.75} aria-hidden="true" /> : <ChevronDown size={14} strokeWidth={1.75} aria-hidden="true" />}
                {g.label}
                <span className="cmp-count">({g.rows.length})</span>
              </button>
            </th>
          </tr>
          {!collapsed.includes(g.id) &&
            g.rows.map((c) => {
              const key = rowKey(c);
              return (
                <tr
                  key={key}
                  data-row={key}
                  tabIndex={key === focusKey ? 0 : -1}
                  aria-current={selected === key ? 'true' : undefined}
                  onClick={() => onSelect(c)}
                  onKeyDown={(e) => onRowKeyDown(e, c)}
                >
                  <td>
                    {formatId(c.id, c.extended)}
                    {manyBuses && <span className="cmp-bus"> {c.bus}</span>}
                  </td>
                  <td className="cmp-name">
                    {c.name ? (
                      c.name
                    ) : hasDbc ? (
                      <span className="status unknown cmp-human">Unknown</span>
                    ) : (
                      <Dash label="No DBC loaded" />
                    )}
                  </td>
                  <td className="cmp-num">{c.presence === 'onlyB' ? <Dash label="Not in log A" /> : <Rate perSecond={c.rateA} />}</td>
                  <td className="cmp-num">{c.presence === 'onlyA' ? <Dash label="Not in log B" /> : <Rate perSecond={c.rateB} />}</td>
                  <td className={`cmp-num${c.score >= SIGNIFICANT ? ' cmp-strong' : ''}`}>{c.score}%</td>
                  <td className="cmp-reason cmp-human" title={c.reason}>
                    {c.reason}
                  </td>
                </tr>
              );
            })}
        </Fragment>
      ),
    );
  }

  return (
    <section className="cmp-table card" aria-labelledby="cmp-table-title">
      <div className="cmp-card-head">
        <h2 id="cmp-table-title" className="section-title">
          Message comparison
        </h2>
        <p className="cmp-note">Rates are frames per second of each log, so logs of different lengths compare.</p>
        {busNote && <p className="cmp-note">{busNote}</p>}
        {hiddenWithinA && total > 0 && <p className="cmp-note">{hiddenWithinA}</p>}
      </div>
      <div className="cmp-table-scroll">
        <table>
          <caption className="sr-only">
            Message IDs by how differently they behave in logs A and B. Arrow keys select a row; Enter opens it in Reverse Engineer.
          </caption>
          <thead>
            <tr>
              <th scope="col">ID</th>
              <th scope="col">Name</th>
              <th scope="col" className="cmp-num">
                A <span className="cmp-unit">(frames/s)</span>
              </th>
              <th scope="col" className="cmp-num">
                B <span className="cmp-unit">(frames/s)</span>
              </th>
              <th scope="col" className="cmp-num">
                Difference
              </th>
              <th scope="col">Reason</th>
            </tr>
          </thead>
          <tbody ref={bodyRef}>{body}</tbody>
        </table>
      </div>
      <IgnoreRules options={options} onChange={onOptions} />
    </section>
  );
}

function EmptyRow({ children }: { children: ReactNode }) {
  return (
    <tr>
      <td colSpan={COLUMNS} className="cmp-empty">
        {children}
      </td>
    </tr>
  );
}

function Rate({ perSecond }: { perSecond: number | null }) {
  return perSecond === null ? <Dash label="The log has no duration" /> : <>{formatRate(perSecond)}</>;
}

function Dash({ label }: { label: string }) {
  return (
    <span className="cmp-dash">
      <span aria-hidden="true">&mdash;</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}
