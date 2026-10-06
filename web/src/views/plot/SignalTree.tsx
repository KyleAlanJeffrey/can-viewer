import { useMemo, useState, type Ref } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { formatId, type IdSummary, type MessageDef, type SignalDef } from '../../core/api';
import { formatPeriod } from '../../format';
import { SidebarSlot } from '../slots';
import type { ViewContext } from '../types';

interface Entry {
  summary: IdSummary;
  message: MessageDef;
  /** The message's signals that pass the filter. */
  signals: SignalDef[];
}

const toggled = (set: Set<number>, key: number) => {
  const next = new Set(set);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
};

/** The sidebar's signal picker: DBC-described messages per bus, each expanding to checkable signals. */
export function SignalTree({ ctx, navRef }: { ctx: ViewContext; navRef?: Ref<HTMLElement> }) {
  const { ids, messageOf, query, log, dbcs, plots } = ctx;
  // Messages that already have a plotted signal start open.
  const [open, setOpen] = useState<Set<number>>(() => new Set(plots.map((p) => Number(p.id.slice(0, p.id.indexOf(':'))))));
  // While filtering every match is open, unless collapsed here.
  const [closedInSearch, setClosedInSearch] = useState<Set<number>>(new Set());
  const q = query.trim().toLowerCase();
  const plotted = new Set(plots.map((p) => p.id));

  const groups = useMemo(() => {
    if (!log) return [];
    return log.channels
      .map((name, channel) => {
        const entries: Entry[] = [];
        for (const summary of ids) {
          if (summary.channel !== channel) continue;
          const message = messageOf(summary.key);
          if (!message || message.signals.length === 0) continue;
          const messageMatches = !q || message.name.toLowerCase().includes(q) || formatId(summary.id, summary.extended).toLowerCase().includes(q);
          const signals = messageMatches ? message.signals : message.signals.filter((s) => s.name.toLowerCase().includes(q));
          if (signals.length > 0) entries.push({ summary, message, signals });
        }
        entries.sort((a, b) => a.summary.id - b.summary.id);
        return { name, entries };
      })
      .filter((g) => g.entries.length > 0);
  }, [log, ids, messageOf, q]);

  let body;
  if (dbcs.length === 0) {
    body = (
      <div className="pv-tree-empty">
        <p>Signals come from a DBC. Open one to list the signals in this log.</p>
        <button className="button" onClick={ctx.openDbcPicker}>
          Open DBC&hellip;
        </button>
      </div>
    );
  } else if (groups.length === 0) {
    const none = dbcs.length === 1 ? 'The DBC describes no message in this log.' : 'No loaded DBC describes a message in this log.';
    body = <p className="pv-tree-empty">{q ? 'No signals match.' : none}</p>;
  } else {
    body = groups.map((g) => (
      <section key={g.name} className="pv-bus">
        <h2 className="pv-bus-head">
          {g.name}
          <span className="pv-count">
            &middot; {g.entries.length} {g.entries.length === 1 ? 'message' : 'messages'}
          </span>
        </h2>
        <ul>
          {g.entries.map(({ summary, message, signals }) => {
            const expanded = q ? !closedInSearch.has(summary.key) : open.has(summary.key);
            const listId = `pv-signals-${summary.key}`;
            return (
              <li key={summary.key}>
                <button
                  className="pv-msg"
                  aria-expanded={expanded}
                  aria-controls={expanded ? listId : undefined}
                  onClick={() => (q ? setClosedInSearch((s) => toggled(s, summary.key)) : setOpen((s) => toggled(s, summary.key)))}
                >
                  {expanded ? <ChevronDown size={14} strokeWidth={1.5} /> : <ChevronRight size={14} strokeWidth={1.5} />}
                  <span className="pv-msg-id">{formatId(summary.id, summary.extended)}</span>
                  <span className="pv-msg-name">{message.name}</span>
                  <span className="pv-msg-period">{formatPeriod(summary.periodMs)}</span>
                </button>
                {expanded && (
                  <ul id={listId}>
                    {signals.map((s) => (
                      <li key={s.name}>
                        <label className="pv-sig">
                          <input
                            type="checkbox"
                            checked={plotted.has(`${summary.key}:${s.name}`)}
                            onChange={() => ctx.togglePlot(summary.key, s.name)}
                          />
                          <span className="pv-dot" style={{ background: ctx.signalColor(summary.key, s.name) }} aria-hidden="true" />
                          <span className="pv-sig-name">{s.name}</span>
                          <span className="pv-sig-unit">{s.unit}</span>
                        </label>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      </section>
    ));
  }

  return (
    <SidebarSlot>
      <nav ref={navRef} className="pv-tree" aria-label="Signals">
        {body}
      </nav>
    </SidebarSlot>
  );
}
