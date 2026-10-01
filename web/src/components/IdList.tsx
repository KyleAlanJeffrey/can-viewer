import { useMemo, useState } from 'react';
import { Activity, ChevronDown, ChevronRight, List } from 'lucide-react';
import { ALL_IDS, FLAG_FD, idLabel, isErrorFrame, type IdSummary } from '../core/api';
import { formatCount, formatPeriod } from '../format';

type SortKey = 'id' | 'count' | 'period';

interface Props {
  ids: IdSummary[];
  channels: string[];
  totalFrames: number;
  /** With a DBC loaded, IDs it doesn't describe are marked Unknown. */
  hasDbc: boolean;
  filtered: boolean;
  selected: number;
  onSelect: (key: number) => void;
}

/** The sidebar's source list: IDs grouped by bus, sortable within each bus. */
export function IdList({ ids, channels, totalFrames, hasDbc, filtered, selected, onSelect }: Props) {
  const [sort, setSort] = useState<SortKey>('id');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const groups = useMemo(() => {
    const by: Record<SortKey, (a: IdSummary, b: IdSummary) => number> = {
      id: (a, b) => a.id - b.id,
      count: (a, b) => b.count - a.count,
      period: (a, b) => (a.periodMs ?? Infinity) - (b.periodMs ?? Infinity),
    };
    return channels
      .map((name, channel) => ({ name, ids: ids.filter((s) => s.channel === channel).sort(by[sort]) }))
      .filter((g) => g.ids.length > 0 || !filtered);
  }, [ids, channels, sort, filtered]);

  const toggle = (name: string) =>
    setCollapsed((c) => {
      const next = new Set(c);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  return (
    <nav className="id-list" aria-label="Messages">
      <div className="sort">
        <label htmlFor="id-sort">Sort by</label>
        <select id="id-sort" value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
          <option value="id">ID</option>
          <option value="count">Frame count</option>
          <option value="period">Period</option>
        </select>
      </div>
      <button
        className="id-row"
        aria-current={selected === ALL_IDS}
        onClick={() => onSelect(ALL_IDS)}
        style={{ gridTemplateColumns: '16px minmax(0, 1fr) auto' }}
      >
        <List size={16} strokeWidth={1.5} />
        <span className="name">All frames</span>
        <span className="period">{formatCount(totalFrames)}</span>
      </button>
      {filtered && groups.length === 0 && <p className="sidebar-empty">No IDs or signals match.</p>}
      {groups.map((g) => {
        const open = !collapsed.has(g.name);
        // Size the ID column to the bus's 11-bit IDs when it has any; a wider ID (or one with
        // a tag) takes the room it needs on its own row rather than pushing every name aside.
        const sized = g.ids.some((s) => !s.extended) ? g.ids.filter((s) => !s.extended) : g.ids;
        const idChars = Math.max(3, ...sized.map((s) => idLabel(s).length));
        return (
          <section key={g.name} style={{ '--id-col': `${idChars + 0.2}ch` } as React.CSSProperties}>
            <button className="group-head" aria-expanded={open} onClick={() => toggle(g.name)}>
              {open ? <ChevronDown size={14} strokeWidth={1.5} /> : <ChevronRight size={14} strokeWidth={1.5} />}
              {g.name}
              <span className="count">
                &middot; {g.ids.length} {g.ids.length === 1 ? 'ID' : 'IDs'}
              </span>
            </button>
            {open && (
              <ul>
                {g.ids.map((s) => (
                  <li key={s.key}>
                    <button
                      className={`id-row${idLabel(s).length > idChars || s.flags & FLAG_FD ? ' wide' : ''}`}
                      aria-current={selected === s.key}
                      onClick={() => onSelect(s.key)}
                      title={`${s.name ? `${s.name} \u00b7 ` : ''}${formatCount(s.count)} frames`}
                    >
                      <Activity size={16} strokeWidth={1.5} />
                      <span className="id">
                        {idLabel(s)}
                        {s.flags & FLAG_FD ? <span className="tag">FD</span> : null}
                      </span>
                      {s.name ? (
                        <span className="name">{s.name}</span>
                      ) : isErrorFrame(s) ? (
                        <span className="name">Error frames</span>
                      ) : hasDbc ? (
                        <span className="name unknown">
                          Unknown <span className="status-dot" aria-hidden="true" />
                        </span>
                      ) : (
                        <span className="name" />
                      )}
                      <span className="period">{formatPeriod(s.periodMs)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </nav>
  );
}
