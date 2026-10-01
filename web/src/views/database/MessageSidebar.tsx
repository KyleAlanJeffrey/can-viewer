import { useId, useMemo, useRef } from 'react';
import { ArrowDown, ArrowUp, ChevronRight, Download, Plus, X } from 'lucide-react';
import { dbcId, formatId, type IdSummary, type MessageDef } from '../../core/api';
import { formatPeriod } from '../../format';
import type { LoadedDbc } from '../types';
import { isExtended, messageIdText } from './dbcModel';

/** What a DBC group's header can do to its DBC. */
export interface DbcActions {
  setChannel: (dbc: LoadedDbc, channel: string | null) => void;
  move: (dbc: LoadedDbc, delta: -1 | 1) => Promise<unknown>;
  export: (dbc: LoadedDbc) => void;
  remove: (dbc: LoadedDbc) => void;
}

interface Props {
  /** In lookup order. */
  dbcs: LoadedDbc[];
  /** Buses of the open log; null without one. */
  channels: string[] | null;
  /** IDs in the open log; empty without one. */
  ids: IdSummary[];
  /** IDs in the log that no loaded DBC decodes. */
  unknown: IdSummary[];
  /** Per DBC id, the message IDs it decodes in the log, including J1939 matches by PGN. */
  decoded: Map<string, Set<number>>;
  /** Per DBC id, its message IDs an earlier DBC decodes instead, with that DBC's name. */
  overridden: Map<string, Map<number, string>>;
  query: string;
  selected: { dbc: string; message: number | null } | null;
  /** Ids of collapsed DBC groups. */
  collapsed: string[];
  onToggle: (dbc: LoadedDbc) => void;
  onSelect: (dbc: LoadedDbc, message: number) => void;
  onNewMessage: () => void;
  onNewDbc: () => void;
  /** Offer to describe an ID the log has and no DBC decodes. */
  onAddUnknown: (summary: IdSummary) => void;
  actions: DbcActions;
}

export function MessageSidebar({
  dbcs,
  channels,
  ids,
  unknown,
  decoded,
  overridden,
  query,
  selected,
  collapsed,
  onToggle,
  onSelect,
  onNewMessage,
  onNewDbc,
  onAddUnknown,
  actions,
}: Props) {
  const q = query.trim().toLowerCase();
  const unknownShown = unknown.filter((s) => q === '' || formatId(s.id, s.extended).toLowerCase().includes(q));
  const manyBuses = (channels?.length ?? 0) > 1;

  return (
    <div className="db-side">
      <div className="db-side-head">
        <button className="button db-small" onClick={onNewMessage}>
          <Plus size={14} strokeWidth={1.75} aria-hidden="true" />
          New Message
        </button>
        <button className="button db-small" data-db-new-dbc onClick={onNewDbc}>
          <Plus size={14} strokeWidth={1.75} aria-hidden="true" />
          New DBC
        </button>
      </div>

      <nav aria-label="Messages">
        {dbcs.length === 0 && <p className="sidebar-empty">No DBC open.</p>}
        {dbcs.map((dbc, index) => (
          <DbcGroup
            key={dbc.id}
            dbc={dbc}
            first={index === 0}
            last={index === dbcs.length - 1}
            channels={channels}
            ids={ids}
            decoded={decoded}
            overridden={overridden.get(dbc.id)}
            query={q}
            selectedMessage={selected?.dbc === dbc.id ? selected.message : null}
            open={!collapsed.includes(dbc.id)}
            onToggle={() => onToggle(dbc)}
            onSelect={(id) => onSelect(dbc, id)}
            actions={actions}
          />
        ))}

        {channels && unknownShown.length > 0 && (
          <>
            <h2 className="db-group-head">
              In log, not in DBC <span className="db-count">&middot; {unknown.length}</span>
            </h2>
            <ul className="db-list">
              {unknownShown.map((s) => (
                <li key={s.key}>
                  <button className="db-msg-row" onClick={() => onAddUnknown(s)} title="Add a message for this ID">
                    <span className="sr-only">Add a message for </span>
                    <span className="db-msg-id">{formatId(s.id, s.extended)}</span>
                    <span className="status unknown db-msg-name">Unknown</span>
                    <span className="db-msg-count">{formatPeriod(s.periodMs)}</span>
                    {manyBuses && (
                      <span className="db-msg-caption">
                        <span className="sr-only">on </span>
                        {channels[s.channel]}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </nav>
    </div>
  );
}

interface GroupProps {
  dbc: LoadedDbc;
  first: boolean;
  last: boolean;
  channels: string[] | null;
  ids: IdSummary[];
  decoded: Map<string, Set<number>>;
  overridden: Map<number, string> | undefined;
  /** Lower-cased search text. */
  query: string;
  selectedMessage: number | null;
  open: boolean;
  onToggle: () => void;
  onSelect: (id: number) => void;
  actions: DbcActions;
}

function DbcGroup({ dbc, first, last, channels, ids, decoded, overridden, query, selectedMessage, open, onToggle, onSelect, actions }: GroupProps) {
  const listId = useId();
  const up = useRef<HTMLButtonElement>(null);
  const down = useRef<HTMLButtonElement>(null);
  const name = dbc.db.name;

  // Messages the log carries on the buses this DBC applies to, including J1939 ones whose PGN
  // arrives from another sender.
  const inLog = useMemo(() => {
    const found = new Set(decoded.get(dbc.id));
    for (const s of ids) if (dbc.channel === null || channels?.[s.channel] === dbc.channel) found.add(dbcId(s));
    return found;
  }, [ids, channels, dbc.channel, dbc.id, decoded]);

  const messages = dbc.db.messages.filter(
    (m) =>
      query === '' ||
      m.name.toLowerCase().includes(query) ||
      messageIdText(m).toLowerCase().includes(query) ||
      m.signals.some((s) => s.name.toLowerCase().includes(query)),
  );

  const buses = channels ?? [];
  const strayBus = dbc.channel !== null && !buses.includes(dbc.channel) ? dbc.channel : null;

  // Reordering can move this group's buttons in the DOM, which drops focus; put it back, on the
  // other arrow when this one has just become disabled.
  const move = async (delta: -1 | 1) => {
    await actions.move(dbc, delta);
    requestAnimationFrame(() => {
      const [pressed, other] = delta < 0 ? [up.current, down.current] : [down.current, up.current];
      (pressed && !pressed.disabled ? pressed : other)?.focus();
    });
  };

  return (
    <section className="db-dbc">
      <h2 className="db-dbc-title">
        <button
          className="db-dbc-toggle"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          data-dbc-toggle={dbc.id}
          onClick={onToggle}
        >
          <ChevronRight className="db-chevron" size={14} strokeWidth={1.75} aria-hidden="true" />
          <span className="db-dbc-name" title={name}>
            {name}
          </span>
          {dbc.edited && <span className="db-edited">Edited</span>}
          <span className="db-count">
            <span className="sr-only">, </span>
            {dbc.db.messages.length}
            <span className="sr-only"> {dbc.db.messages.length === 1 ? 'message' : 'messages'}</span>
          </span>
        </button>
      </h2>
      <div className="db-dbc-tools">
        <select
          className="select db-bus"
          aria-label={`Bus ${name} applies to`}
          value={dbc.channel ?? ''}
          disabled={buses.length === 0 && strayBus === null}
          onChange={(e) => actions.setChannel(dbc, e.target.value === '' ? null : e.target.value)}
        >
          <option value="">All buses</option>
          {buses.map((bus) => (
            <option key={bus} value={bus}>
              {bus}
            </option>
          ))}
          {strayBus !== null && <option value={strayBus}>{strayBus} (not in log)</option>}
        </select>
        <button ref={up} className="icon-button small" aria-label={`Move ${name} up`} title="Move up" disabled={first} onClick={() => void move(-1)}>
          <ArrowUp size={14} strokeWidth={1.75} />
        </button>
        <button ref={down} className="icon-button small" aria-label={`Move ${name} down`} title="Move down" disabled={last} onClick={() => void move(1)}>
          <ArrowDown size={14} strokeWidth={1.75} />
        </button>
        <button className="icon-button small" aria-label={`Export ${name}\u2026`} title="Export&hellip;" onClick={() => actions.export(dbc)}>
          <Download size={14} strokeWidth={1.75} />
        </button>
        <button className="icon-button small" aria-label={`Remove ${name}`} title="Remove" onClick={() => actions.remove(dbc)}>
          <X size={14} strokeWidth={1.75} />
        </button>
      </div>

      {open && (
        <div id={listId}>
          {messages.length > 0 ? (
            <ul className="db-list">
              {messages.map((m) => (
                <li key={m.id}>
                  <MessageRow
                    dbc={dbc.id}
                    message={m}
                    selected={m.id === selectedMessage}
                    notInLog={channels !== null && !inLog.has(m.id)}
                    overriddenBy={overridden?.get(m.id) ?? null}
                    onSelect={onSelect}
                  />
                </li>
              ))}
            </ul>
          ) : (
            <p className="sidebar-empty db-group-empty">{query === '' || dbc.db.messages.length === 0 ? 'No messages yet' : 'No messages or signals match'}</p>
          )}
        </div>
      )}
    </section>
  );
}

interface RowProps {
  dbc: string;
  message: MessageDef;
  selected: boolean;
  notInLog: boolean;
  /** Name of the earlier DBC that decodes this ID instead on some bus. */
  overriddenBy: string | null;
  onSelect: (id: number) => void;
}

function MessageRow({ dbc, message, selected, notInLog, overriddenBy, onSelect }: RowProps) {
  const count = message.signals.length;
  const notes = [isExtended(message) ? '29-bit' : null, message.size > 8 ? `CAN FD \u00b7 ${message.size} bytes` : null].filter(Boolean);
  return (
    <button className="db-msg-row" aria-current={selected} data-db-message={messageRowKey(dbc, message.id)} onClick={() => onSelect(message.id)}>
      <span className="db-msg-id">{messageIdText(message)}</span>
      <span className="db-msg-name">{message.name}</span>
      <span className="db-msg-count">
        {count} {count === 1 ? 'signal' : 'signals'}
      </span>
      {(notes.length > 0 || notInLog || overriddenBy) && (
        <span className="db-msg-caption">
          {notes.length > 0 && <span>{notes.join(' \u00b7 ')}</span>}
          {notInLog && <span className="db-tag">Not in log</span>}
          {overriddenBy && <span className="db-tag">Overridden by {overriddenBy}</span>}
        </span>
      )}
    </button>
  );
}

/** The `data-db-message` value of a message's row, to find it for focus. */
export function messageRowKey(dbc: string, id: number): string {
  return `${dbc}:${id}`;
}
