import { useEffect, useMemo, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import { ALL_IDS, dbcId, formatId, isErrorFrame, type Database, type IdSummary, type MessageDef, type SignalDef } from '../../core/api';
import { Sheet } from '../../components/Sheet';
import { cssVar, formatPeriod } from '../../format';
import { InspectorSlot, SidebarSlot } from '../slots';
import { DetailsToggle } from '../shared/DetailsToggle';
import { startTextSave } from '../shared/saveFile';
import { useViewState } from '../shared/viewState';
import type { LoadedDbc, ViewProps } from '../types';
import { DLC_SIZES, UNTITLED_DBC, dbcFileName, firstFreeRun, messageIdText, messageMatches, newSignal, overriddenMessages, uniqueName } from './dbcModel';
import { ExportStatus } from './ExportStatus';
import { LayoutGrid } from './LayoutGrid';
import { MessageCard } from './MessageCard';
import { MessageSidebar, messageRowKey, type DbcActions } from './MessageSidebar';
import { BLANK_MESSAGE, NewMessageSheet, type MessageDraft } from './NewMessageSheet';
import { SignalInspector } from './SignalInspector';
import { SignalTable } from './SignalTable';
import { useWorkingDbcs } from './workingDbcs';
import './database.css';

const EXPORT_NOTE = 'Writes nodes, messages, signals, comments, value descriptions and which messages are J1939. Other attributes (BA_) are not written yet.';
const DBC_FILE = { description: 'DBC file', mime: 'application/octet-stream', extension: '.dbc' };

interface Selection {
  /** LoadedDbc id. */
  dbc: string | null;
  message: number | null;
  /** Null for the message's first signal. */
  signal: string | null;
  /** ctx.selected when this was chosen; a different one means an ID was picked in another view. */
  key: number;
}

const NO_SELECTION: Selection = { dbc: null, message: null, signal: null, key: ALL_IDS };

type Dialog =
  | { kind: 'new-message'; initial: MessageDraft }
  | { kind: 'delete-signal'; name: string }
  | { kind: 'delete-message' }
  | { kind: 'remove-dbc'; dbc: LoadedDbc }
  | null;

export function DatabaseView({ ctx }: ViewProps) {
  const { dbcs, edit } = useWorkingDbcs(ctx);
  const [selection, setSelection] = useViewState<Selection>('db.selection', NO_SELECTION);
  const [collapsed, setCollapsed] = useViewState<string[]>('db.collapsed', []);
  const [focusName, setFocusName] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const dialogOpener = useRef<HTMLElement | null>(null);
  const seriesColors = useMemo(() => [1, 2, 3, 4, 5, 6].map((i) => cssVar(`--series-${i}`)), []);
  const overridden = useMemo(() => overriddenMessages(dbcs), [dbcs]);
  // Error frames have no message to describe.
  const unknown = useMemo(() => ctx.ids.filter((s) => !ctx.messageOf(s.key) && !isErrorFrame(s)), [ctx.ids, ctx.messageOf]);
  const decodedInLog = useMemo(() => {
    const byDbc = new Map<string, Set<number>>();
    for (const s of ctx.ids) {
      const from = ctx.dbcOf(s.key);
      const decoded = ctx.messageOf(s.key);
      if (!from || !decoded) continue;
      const set = byDbc.get(from.id) ?? new Set<number>();
      byDbc.set(from.id, set.add(decoded.id));
    }
    return byDbc;
  }, [ctx.ids, ctx.dbcOf, ctx.messageOf]);

  const expand = (id: string) => setCollapsed((c) => c.filter((x) => x !== id));

  // Follow an ID picked in another view, when a DBC decodes it.
  useEffect(() => {
    if (ctx.selected === selection.key) return;
    const from = ctx.dbcOf(ctx.selected);
    const decoded = ctx.messageOf(ctx.selected);
    if (!from || !decoded) return;
    setSelection({ dbc: from.id, message: decoded.id, signal: null, key: ctx.selected });
    expand(from.id);
  }, [ctx.selected]);

  const dbc = dbcs.find((d) => d.id === selection.dbc) ?? dbcs[0] ?? null;
  const message = dbc ? (dbc.db.messages.find((m) => m.id === selection.message) ?? dbc.db.messages[0] ?? null) : null;
  const messageIndex = dbc && message ? dbc.db.messages.indexOf(message) : -1;
  const signalIndex =
    message && message.signals.length > 0 ? Math.max(0, message.signals.findIndex((s) => s.name === selection.signal)) : null;

  // The inspector edits a signal, so it gives its room back while there is none.
  const { setInspectorHidden } = ctx;
  const noSignal = signalIndex === null;
  useEffect(() => {
    setInspectorHidden(noSignal);
  }, [setInspectorHidden, noSignal]);

  /** Whether the core decodes log ID `s` with message `id` of `of`. */
  const decodes = (s: IdSummary, of: LoadedDbc, id: number) => ctx.dbcOf(s.key)?.id === of.id && ctx.messageOf(s.key)?.id === id;

  /**
   * The log's IDs for message `id`: those `of` decodes (several for a J1939 message, one per
   * sender), the selected one first, then those the message would match (its ID, or its PGN
   * when J1939) that another DBC decodes instead.
   */
  const summariesFor = (of: LoadedDbc, id: number): IdSummary[] => {
    const channels = ctx.log?.channels ?? [];
    const message = of.db.messages.find((m) => m.id === id);
    const decoded = ctx.ids.filter((s) => decodes(s, of, id)).sort((a, b) => Number(b.key === ctx.selected) - Number(a.key === ctx.selected));
    const shadowed = ctx.ids.filter(
      (s) =>
        !decodes(s, of, id) &&
        ctx.dbcOf(s.key)?.id !== of.id &&
        (message ? messageMatches(message, dbcId(s)) : dbcId(s) === id) &&
        (of.channel === null || channels[s.channel] === of.channel),
    );
    return [...decoded, ...shadowed];
  };

  const summary = dbc && message ? (summariesFor(dbc, message.id)[0] ?? null) : null;
  // Plot colours and plotting need the log ID this exact message decodes.
  const decoded = summary && dbc && message && decodes(summary, dbc, message.id) ? summary : null;
  const colors = message
    ? message.signals.map((s, i) => (decoded ? ctx.signalColor(decoded.key, s.name) : seriesColors[i % seriesColors.length]))
    : [];

  /** Keep the shown DBC and message selected, changing only `patch`. */
  const reselect = (patch: Partial<Selection>) =>
    setSelection((s) => ({ ...s, dbc: dbc?.id ?? null, message: message?.id ?? null, ...patch }));

  const selectMessage = (of: LoadedDbc, id: number) => {
    const inLog = summariesFor(of, id)[0];
    if (inLog) ctx.select(inLog.key);
    setSelection({ dbc: of.id, message: id, signal: null, key: inLog?.key ?? ctx.selected });
    setFocusName(false);
  };

  const selectSignal = (index: number) => {
    reselect({ signal: message?.signals[index]?.name ?? null });
    setFocusName(false);
  };

  const openDialog = (next: NonNullable<Dialog>) => {
    dialogOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setDialog(next);
  };

  // Sheets unmount rather than close, so the browser doesn't hand focus back on its own.
  const closeDialog = () => {
    setDialog(null);
    const opener = dialogOpener.current;
    requestAnimationFrame(() => {
      if (opener?.isConnected) opener.focus();
    });
  };

  const updateMessage = (of: LoadedDbc, id: number, change: (m: MessageDef) => MessageDef) =>
    edit(of.id, (db) => ({ ...db, messages: db.messages.map((m) => (m.id === id ? change(m) : m)) }));

  const changeMessage = (patch: Partial<MessageDef>) => {
    if (!dbc || !message) return;
    updateMessage(dbc, message.id, (m) => ({ ...m, ...patch }));
    if (patch.id !== undefined && patch.id !== message.id) {
      const moved = summariesFor(dbc, patch.id)[0];
      if (moved) ctx.select(moved.key);
      reselect({ message: patch.id, key: moved?.key ?? ctx.selected });
    }
  };

  const changeSignal = (name: string, patch: Partial<SignalDef>) => {
    if (!dbc || !message) return;
    updateMessage(dbc, message.id, (m) => ({ ...m, signals: m.signals.map((s) => (s.name === name ? { ...s, ...patch } : s)) }));
    if (patch.name !== undefined) reselect({ signal: patch.name });
  };

  const addSignal = () => {
    if (!dbc || !message) return;
    const room = firstFreeRun(message);
    if (!room) {
      ctx.setError(`${message.name} has no free bits. Give it more bytes to add a signal.`);
      return;
    }
    const name = uniqueName('NewSignal', message.signals.map((s) => s.name));
    const signal = newSignal(name, room.start, room.size);
    updateMessage(dbc, message.id, (m) => (m.signals.some((s) => s.name === name) ? m : { ...m, signals: [...m.signals, signal] }));
    reselect({ signal: name });
    setFocusName(true);
  };

  const deleteSignal = (name: string) => {
    if (!dbc || !message) return;
    const index = message.signals.findIndex((s) => s.name === name);
    const rest = message.signals.filter((s) => s.name !== name);
    updateMessage(dbc, message.id, (m) => ({ ...m, signals: m.signals.filter((s) => s.name !== name) }));
    reselect({ signal: rest[Math.max(0, index - 1)]?.name ?? null });
  };

  // The row that opened the sheet can be an unknown ID, which goes away once it's described.
  const focusMessageRow = (of: string, id: number) =>
    requestAnimationFrame(() =>
      document.querySelector<HTMLElement>(`[data-db-message="${CSS.escape(messageRowKey(of, id))}"]`)?.focus(),
    );

  const addMessage = (target: LoadedDbc | null, next: MessageDef) => {
    if (!target) {
      void ctx.run('Adding the message\u2026', async () => {
        const id = await ctx.addDbc({ name: UNTITLED_DBC, messages: [next] });
        selectMessage({ id, db: { name: UNTITLED_DBC, messages: [next] }, channel: null, edited: true }, next.id);
        focusMessageRow(id, next.id);
      });
      return;
    }
    edit(target.id, (db) => (db.messages.some((m) => m.id === next.id) ? db : { ...db, messages: [...db.messages, next] }));
    expand(target.id);
    selectMessage(target, next.id);
    focusMessageRow(target.id, next.id);
  };

  const deleteMessage = () => {
    if (!dbc || !message) return;
    const id = message.id;
    const rest = dbc.db.messages.filter((m) => m.id !== id);
    edit(dbc.id, (db) => ({ ...db, messages: db.messages.filter((m) => m.id !== id) }));
    const neighbour = rest[Math.min(messageIndex, rest.length - 1)];
    if (neighbour) selectMessage(dbc, neighbour.id);
    else reselect({ message: null, signal: null });
  };

  const newDbc = () =>
    void ctx.run('Adding a DBC\u2026', async () => {
      const id = await ctx.addDbc({ name: UNTITLED_DBC, messages: [] });
      setSelection({ dbc: id, message: null, signal: null, key: ctx.selected });
    });

  const exportDbc = (of: LoadedDbc) => {
    // The save dialog must open straight from the click, before the text is ready.
    const write = startTextSave(dbcFileName(of.db.name), DBC_FILE);
    void ctx.run('Exporting\u2026', async () => {
      // Read in queue order, so the file holds the version every edit in flight lands on.
      let exported = null as Database | null;
      await ctx.updateDbc(of.id, (current) => {
        exported = current.db;
        return {};
      });
      if (!exported) return;
      const text = await ctx.core.exportDbc(exported);
      if (!(await write(text))) return;
      // Clean only if nothing changed while the file was being saved.
      await ctx.updateDbc(of.id, (current) => ({ exportedAt: Date.now(), ...(current.db === exported ? { edited: false } : {}) }));
    });
  };

  const removeDbc = async (of: LoadedDbc) => {
    const at = dbcs.findIndex((d) => d.id === of.id);
    const neighbour = dbcs[at + 1] ?? dbcs[at - 1] ?? null;
    if (!(await ctx.run(`Removing ${of.db.name}\u2026`, () => ctx.removeDbc(of.id)))) return;
    setCollapsed((c) => c.filter((x) => x !== of.id));
    // Its header is gone, so focus moves to the next DBC's, or to New DBC.
    requestAnimationFrame(() => {
      const header = neighbour ? document.querySelector<HTMLElement>(`[data-dbc-toggle="${CSS.escape(neighbour.id)}"]`) : null;
      (header ?? document.querySelector<HTMLElement>('[data-db-new-dbc]'))?.focus();
    });
  };

  const actions: DbcActions = {
    setChannel: (of, channel) => void ctx.run('Updating the database\u2026', () => ctx.updateDbc(of.id, { channel })),
    move: (of, delta) => ctx.run('Reordering DBCs\u2026', () => ctx.moveDbc(of.id, delta)),
    export: exportDbc,
    remove: (of) => (of.edited ? openDialog({ kind: 'remove-dbc', dbc: of }) : void removeDbc(of)),
  };

  const offerUnknown = (s: IdSummary) =>
    openDialog({
      kind: 'new-message',
      initial: {
        name: `MSG_${formatId(s.id, s.extended)}`,
        id: formatId(s.id, s.extended),
        extended: s.extended,
        size: DLC_SIZES.find((n) => n >= s.maxLen) ?? 64,
      },
    });

  const plotFor = (signal: SignalDef) => {
    if (!decoded) return null;
    const plotted = ctx.plots.some((p) => p.id === `${decoded.key}:${signal.name}`);
    return {
      plotted,
      onPlot: async () => {
        if (!plotted) await ctx.togglePlot(decoded.key, signal.name);
        ctx.setView('plot');
      },
    };
  };

  const sidebar = (
    <SidebarSlot>
      <MessageSidebar
        dbcs={dbcs}
        channels={ctx.log?.channels ?? null}
        ids={ctx.ids}
        unknown={unknown}
        decoded={decodedInLog}
        overridden={overridden}
        query={ctx.query}
        selected={dbc ? { dbc: dbc.id, message: message?.id ?? null } : null}
        collapsed={collapsed}
        onToggle={(of) => setCollapsed((c) => (c.includes(of.id) ? c.filter((x) => x !== of.id) : [...c, of.id]))}
        onSelect={selectMessage}
        onNewMessage={() => openDialog({ kind: 'new-message', initial: BLANK_MESSAGE })}
        onNewDbc={newDbc}
        onAddUnknown={offerUnknown}
        actions={actions}
      />
    </SidebarSlot>
  );

  const dialogs = (
    <>
      {dialog?.kind === 'new-message' && (
        <NewMessageSheet
          dbcs={dbcs}
          initialDbc={dbc?.id ?? null}
          initial={dialog.initial}
          onCancel={closeDialog}
          onAdd={(target, next) => {
            closeDialog();
            addMessage(target, next);
          }}
        />
      )}
      {dialog?.kind === 'remove-dbc' && (
        <ConfirmDelete
          title={`Remove ${dialog.dbc.db.name}?`}
          body="Its edits haven't been exported."
          action="Remove DBC"
          onCancel={closeDialog}
          onConfirm={() => {
            closeDialog();
            void removeDbc(dialog.dbc);
          }}
        />
      )}
    </>
  );

  if (!dbc) {
    return (
      <>
        {sidebar}
        <div className="empty">
          <div className="empty-inner">
            <h2 className="empty-title">No DBC open</h2>
            <p className="lede">Open a DBC to edit it, or start a new one.</p>
            <div className="db-empty-actions">
              <button className="button" onClick={ctx.openDbcPicker}>
                Open DBC&hellip;
              </button>
              <button className="button" onClick={newDbc}>
                New DBC
              </button>
            </div>
          </div>
        </div>
        {dialogs}
      </>
    );
  }

  const signal = message && signalIndex !== null ? message.signals[signalIndex] : null;
  const period = summary ? formatPeriod(summary.periodMs) || null : null;
  const overriddenBy = message ? (overridden.get(dbc.id)?.get(message.id) ?? null) : null;

  return (
    <>
      {sidebar}

      <header className="content-header db-header">
        <div className="db-heading">
          <h2 className="content-title db-title">{message?.name ?? dbc.db.name}</h2>
          <p className="content-sub">
            {message ? (
              <>
                <span className="mono">{messageIdText(message)}</span> &middot; {message.size} {message.size === 1 ? 'byte' : 'bytes'}
                {message.transmitter && <> &middot; {message.transmitter}</>}
                {period && <> &middot; every {period}</>} &middot; in {dbc.db.name}
              </>
            ) : (
              'No messages yet'
            )}
            {overriddenBy && (
              <>
                {' '}
                <span className="db-tag">Overridden by {overriddenBy}</span>
              </>
            )}
          </p>
        </div>
        <div className="content-actions">
          <ExportStatus dbc={dbc} />
          <button className="button" onClick={addSignal} disabled={!message}>
            <Plus size={16} strokeWidth={1.5} aria-hidden="true" />
            Add Signal
          </button>
          <button className="primary" onClick={() => exportDbc(dbc)} title={EXPORT_NOTE}>
            Export DBC&hellip;
          </button>
          <DetailsToggle ctx={ctx} emptyReason={signal ? null : message ? 'Add a signal to edit its details' : 'Add a message to start'} />
        </div>
      </header>

      <div className="content-scroll db-scroll">
        {message ? (
          <>
            <MessageCard
              key={`${dbc.id}:${messageIndex}`}
              db={dbc.db}
              message={message}
              period={period}
              onChange={changeMessage}
              onDelete={() => openDialog({ kind: 'delete-message' })}
            />
            <section className="card db-card" aria-labelledby="db-signals-title">
              <div className="db-card-head">
                <h3 className="section-title" id="db-signals-title">
                  Signals <span className="db-title-sub">&middot; {message.signals.length}</span>
                </h3>
              </div>
              <SignalTable
                message={message}
                colors={colors}
                selected={signalIndex}
                onSelect={selectSignal}
                onDelete={(index) => openDialog({ kind: 'delete-signal', name: message.signals[index].name })}
              />
            </section>
            <LayoutGrid message={message} colors={colors} selected={signalIndex} onSelect={selectSignal} />
          </>
        ) : (
          <div className="empty">
            <div className="empty-inner">
              <p className="lede">This DBC has no messages yet.</p>
              <button className="button" onClick={() => openDialog({ kind: 'new-message', initial: BLANK_MESSAGE })}>
                <Plus size={16} strokeWidth={1.5} aria-hidden="true" />
                New Message
              </button>
            </div>
          </div>
        )}
      </div>

      {message && signal && signalIndex !== null && (
        <InspectorSlot>
          <SignalInspector
            key={`${dbc.id}:${messageIndex}:${signalIndex}`}
            message={message}
            index={signalIndex}
            color={colors[signalIndex]}
            focusName={focusName}
            onChange={(patch) => changeSignal(signal.name, patch)}
            plot={plotFor(signal)}
          />
        </InspectorSlot>
      )}

      {dialogs}
      {dialog?.kind === 'delete-signal' && message?.signals.some((s) => s.name === dialog.name) && (
        <ConfirmDelete
          title={`Delete ${dialog.name}?`}
          body={`It is removed from ${message.name}. Export DBC\u2026 to keep the change in a file.`}
          action="Delete Signal"
          onCancel={closeDialog}
          onConfirm={() => {
            closeDialog();
            deleteSignal(dialog.name);
          }}
        />
      )}
      {dialog?.kind === 'delete-message' && message && (
        <ConfirmDelete
          title={`Delete ${message.name}?`}
          body={`Its ${message.signals.length} ${message.signals.length === 1 ? 'signal goes' : 'signals go'} with it. Export DBC\u2026 to keep the change in a file.`}
          action="Delete Message"
          onCancel={closeDialog}
          onConfirm={() => {
            closeDialog();
            deleteMessage();
          }}
        />
      )}
    </>
  );
}

function ConfirmDelete({ title, body, action, onCancel, onConfirm }: { title: string; body: string; action: string; onCancel: () => void; onConfirm: () => void }) {
  return (
    <Sheet
      open
      onClose={onCancel}
      title={title}
      footer={
        <>
          <button className="button" onClick={onCancel}>
            Cancel
          </button>
          <button className="primary" onClick={onConfirm}>
            {action}
          </button>
        </>
      }
    >
      <p>{body}</p>
    </Sheet>
  );
}
