import { useId, useMemo, useRef, useState, type RefObject } from 'react';
import { Check, X } from 'lucide-react';
import { formatId, type IdSummary, type MessageDef, type Suggestion } from '../../core/api';
import { formatCount } from '../../format';
import type { ViewContext } from '../types';
import { Sparkline } from './Sparkline';
import { layoutString, plainNumber, rangeBits } from './bits';
import { KIND_LABELS, type ShownSuggestion } from './suggestionList';
import './suggestions.css';
import { suggestionId, type Discovery, type MessageHints } from './useDiscovery';

const LEVEL_LABELS = { high: 'High', medium: 'Medium', low: 'Low' } as const;

/** Where its bits are, such as `bits 16-31 \u00b7 Motorola \u00b7 unsigned`. */
export function describePlace(s: Suggestion): string {
  const bits = rangeBits(s.spec);
  const lo = Math.min(...bits);
  const hi = Math.max(...bits);
  const where = bits.length === 1 ? `bit ${lo}` : hi - lo + 1 === bits.length ? `bits ${lo}-${hi}` : layoutString(s.spec, s.spec.signed);
  return `${where} \u00b7 ${s.spec.byteOrder === 'intel' ? 'Intel' : 'Motorola'} \u00b7 ${s.spec.signed ? 'signed' : 'unsigned'}`;
}

/** The unknown message other than `current` with the most likely suggestions. */
function mostPromising(discovery: Discovery, unknown: IdSummary[], current: number): IdSummary | null {
  let best: IdSummary | null = null;
  let bestScore = 0;
  for (const s of unknown) {
    if (s.key === current) continue;
    const score = (discovery.results[s.key]?.suggestions ?? []).reduce((n, x) => n + (x.level === 'high' ? 10 : 0) + x.confidence, 0);
    if (score > bestScore) [best, bestScore] = [s, score];
  }
  return best;
}

const NAME_STEMS: Record<Suggestion['kind'], string> = {
  counter: 'Counter',
  checksum: 'Checksum',
  flag: 'Flag',
  enum: 'Enum',
  continuous: 'Value',
  signed: 'Signed',
};

/** `Counter`, or `Value_16` for kinds a message often has several of, made unique in `message`. */
function suggestedName(s: ShownSuggestion, message: MessageDef | null): string {
  const { kind } = s.suggestion;
  const base = kind === 'counter' || kind === 'checksum' ? NAME_STEMS[kind] : `${NAME_STEMS[kind]}_${Math.min(...s.bits)}`;
  const taken = new Set((message?.signals ?? []).map((x) => x.name));
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base}_${n}`;
  return name;
}

/** Takes an accepted suggestion's signal out of its DBC again, and the message or DBC the add created once empty. */
function undoAccepted(ctx: ViewContext, discovery: Discovery, id: string, onUndone: () => void) {
  const accepted = discovery.accepted[id];
  if (!accepted) return;
  void ctx.run(`Removing ${accepted.signal}\u2026`, async () => {
    const loaded = ctx.dbcs.find((d) => d.id === accepted.dbc);
    const without = (messages: MessageDef[]) =>
      messages
        .map((m) => (m.id === accepted.messageId ? { ...m, signals: m.signals.filter((x) => x.name !== accepted.signal) } : m))
        .filter((m) => !(m.id === accepted.messageId && accepted.createdMessage && m.signals.length === 0));
    if (loaded && accepted.createdDbc && without(loaded.db.messages).length === 0) await ctx.removeDbc(loaded.id);
    else if (loaded) await ctx.updateDbc(loaded.id, ({ db }) => ({ db: { ...db, messages: without(db.messages) } }));
    discovery.markAccepted(id, null);
    onUndone();
  });
}

/** The first number in `text`, as seconds: "12", "12.5 s" or "I pressed the brake at 12 s". */
export function parseMarker(text: string): number | null {
  const match = /-?\d+(?:\.\d+)?/.exec(text);
  return match ? Number(match[0]) : null;
}

interface Props {
  ctx: ViewContext;
  summary: IdSummary;
  discovery: Discovery;
  unknown: IdSummary[];
  shown: ShownSuggestion[];
  /** Suggestions dismissed for this message, listed when asked for. */
  dismissedCount: number;
  showDismissed: boolean;
  onShowDismissed: (show: boolean) => void;
  /** The suggestion under the pointer or focus, here or on the bit grid. */
  active: string | null;
  onActive: (id: string | null) => void;
  /** The suggestion whose bits are in the form. */
  selected: string | null;
  onSelect: (s: ShownSuggestion) => void;
  /** The message the suggestions are for, when a DBC already has it. */
  message: MessageDef | null;
  /** Put the suggestion in the form under this name. */
  onAccept: (s: ShownSuggestion, name: string) => void;
  /** An accepted suggestion was taken out of its DBC again. */
  onUndone: () => void;
  plotted: Set<string>;
  onPlot: (s: ShownSuggestion) => void;
  /** The parked cursor, offered as the time of an event. */
  parked: number | null;
}

/** Suggested signals for one message, from how its bits change, with hints to sharpen them. */
export function Suggestions(props: Props) {
  const { ctx, summary, discovery, unknown, shown, dismissedCount, showDismissed, onShowDismissed, active, onActive, selected } = props;
  const { message, onSelect, onAccept, onUndone, plotted, onPlot, parked } = props;
  const key = summary.key;
  const result = discovery.results[key];
  const error = discovery.errors[key] ?? null;
  const running = discovery.running.includes(key);
  const progress = discovery.progress;
  const hints = discovery.hintsFor(key);
  const hasHints = hints.markers.length > 0 || hints.reference !== null;
  const [hintsOpen, setHintsOpen] = useState(hasHints);
  const hintRef = useRef<HTMLInputElement>(null);
  const ids = useId();

  const unknownKeys = useMemo(() => new Set(unknown.map((s) => s.key)), [unknown]);
  let total = 0;
  let messages = 0;
  for (const s of unknown) {
    const n = (discovery.results[s.key]?.suggestions ?? []).filter((x) => !discovery.dismissed.has(suggestionId(s.key, x))).length;
    total += n;
    if (n > 0) messages++;
  }
  const scanned = unknown.filter((s) => discovery.results[s.key]).length;
  const next = mostPromising(discovery, unknown, key);
  const openHints = () => {
    setHintsOpen(true);
    requestAnimationFrame(() => hintRef.current?.focus());
  };

  return (
    <section className="card re-card re-sug" aria-labelledby={`${ids}title`}>
      <div className="re-card-head">
        <h3 className="section-title" id={`${ids}title`}>
          Suggested signals
        </h3>
        {result && (
          <span className="re-card-note">
            {result.sampledFrames < result.frames
              ? `From ${formatCount(result.sampledFrames)} of ${formatCount(result.frames)} frames`
              : `From ${formatCount(result.frames)} ${result.frames === 1 ? 'frame' : 'frames'}`}
          </span>
        )}
      </div>
      <p className="re-sug-caution">Suggestions are guesses. Check them against the log before accepting.</p>

      {unknown.length > 0 && (
        <div className="re-sug-overview">
          {progress ? (
            <div className="re-sug-progress">
              <span role="status">
                Scanning {formatCount(progress.total)} {progress.total === 1 ? 'message' : 'messages'}&hellip; {progress.done} of {progress.total}
              </span>
              <span
                className="re-sug-bar"
                role="progressbar"
                aria-label="Scan progress"
                aria-valuemin={0}
                aria-valuemax={progress.total}
                aria-valuenow={progress.done}
              >
                <span
                  style={{
                    transform: `scaleX(${progress.done / Math.max(1, progress.total)})`,
                  }}
                />
              </span>
              <button type="button" className="button" onClick={discovery.cancel}>
                Cancel
              </button>
            </div>
          ) : (
            <p className="re-sug-summary">
              {discovery.scanError && <span className="re-quiet">The scan stopped: {discovery.scanError}. </span>}
              {scanned === 0 ? (
                `${formatCount(unknown.length)} unknown ${unknown.length === 1 ? 'message' : 'messages'} not scanned yet.`
              ) : total === 0 ? (
                `Nothing suggested for the ${formatCount(scanned)} unknown ${scanned === 1 ? 'message' : 'messages'} scanned.`
              ) : (
                <>
                  <strong>
                    {formatCount(total)} {total === 1 ? 'suggestion' : 'suggestions'} across {formatCount(messages)} unknown{' '}
                    {messages === 1 ? 'message' : 'messages'}
                  </strong>
                  {scanned < unknown.length && ` \u00b7 ${formatCount(unknown.length - scanned)} not scanned`}
                </>
              )}
              {scanned < unknown.length && (
                <button type="button" className="text-button" onClick={() => discovery.scanAll(unknownKeys.has(key) ? key : undefined)}>
                  {scanned === 0 ? 'Scan them' : 'Scan the rest'}
                </button>
              )}
              {next && (
                <button type="button" className="text-button" onClick={() => ctx.select(next.key)}>
                  Most promising: <span className="mono">{formatId(next.id, next.extended)}</span>
                </button>
              )}
            </p>
          )}
        </div>
      )}

      {error ? (
        <div className="re-sug-state">
          <p className="re-quiet">Suggestions: {error}</p>
          <button type="button" className="button" onClick={() => discovery.rescan(key)}>
            Scan again
          </button>
        </div>
      ) : !result ? (
        running || progress ? (
          <p className="hint re-sug-state" role="status">
            Looking for signals in <span className="mono">{formatId(summary.id, summary.extended)}</span>
            &hellip;
          </p>
        ) : (
          <div className="re-sug-state">
            <p className="hint">Not scanned yet.</p>
            <button type="button" className="button" onClick={() => discovery.rescan(key)}>
              Suggest signals
            </button>
          </div>
        )
      ) : shown.length === 0 ? (
        <div className="re-sug-state">
          <p className="re-sug-empty">No suggestions for this message</p>
          <p className="hint">
            {dismissedCount > 0
              ? `${dismissedCount} dismissed.`
              : (result.suggestions.length > 0 ? 'What it found overlaps signals the database already has. ' : '') + 'Try a longer log, or add an event hint.'}
          </p>
          <div className="re-sug-actions">
            <button type="button" className="button" onClick={openHints}>
              Add hint
            </button>
            <button type="button" className="button" onClick={() => discovery.rescan(key)} disabled={running}>
              Scan again
            </button>
            {dismissedCount > 0 && (
              <button type="button" className="text-button" onClick={() => onShowDismissed(true)}>
                Show dismissed
              </button>
            )}
          </div>
        </div>
      ) : (
        <>
          <ol className="re-sug-list" aria-busy={running}>
            {shown.map((s) => (
              <SuggestionRow
                key={s.id}
                ctx={ctx}
                item={s}
                discovery={discovery}
                active={active === s.id}
                selected={selected === s.id}
                plotted={plotted.has(s.id)}
                onActive={onActive}
                onSelect={onSelect}
                onAccept={(s) => onAccept(s, suggestedName(s, message))}
                onUndo={(s) => undoAccepted(ctx, discovery, s.id, onUndone)}
                onPlot={onPlot}
              />
            ))}
          </ol>
          <p className="re-sug-foot">
            {running ? (
              <span role="status">Scanning again&hellip;</span>
            ) : (
              <button type="button" className="text-button" onClick={() => discovery.rescan(key)}>
                Scan again
              </button>
            )}
            {dismissedCount > 0 && (
              <button type="button" className="text-button" aria-pressed={showDismissed} onClick={() => onShowDismissed(!showDismissed)}>
                {showDismissed ? 'Hide dismissed' : `Show ${dismissedCount} dismissed`}
              </button>
            )}
          </p>
        </>
      )}

      <Hints
        key={key}
        ctx={ctx}
        summary={summary}
        hints={hints}
        open={hintsOpen || hasHints}
        onOpen={setHintsOpen}
        inputRef={hintRef}
        parked={parked}
        busy={running}
        onChange={(h) => discovery.rescan(key, h)}
      />
    </section>
  );
}

interface RowProps {
  ctx: ViewContext;
  item: ShownSuggestion;
  discovery: Discovery;
  active: boolean;
  selected: boolean;
  plotted: boolean;
  onActive: (id: string | null) => void;
  onSelect: (s: ShownSuggestion) => void;
  onAccept: (s: ShownSuggestion) => void;
  onUndo: (s: ShownSuggestion) => void;
  onPlot: (s: ShownSuggestion) => void;
}

function SuggestionRow({ ctx, item, discovery, active, selected, plotted, onActive, onSelect, onAccept, onUndo, onPlot }: RowProps) {
  const { id, number, suggestion: s } = item;
  const accepted = discovery.accepted[id] ?? null;
  const dismissed = discovery.dismissed.has(id);
  const kind = KIND_LABELS[s.kind];
  const t = s.sparkline.t;
  return (
    <li
      className="re-sug-item"
      data-active={active || undefined}
      data-selected={selected || undefined}
      data-dismissed={dismissed || undefined}
      onPointerEnter={() => onActive(id)}
      onPointerLeave={() => onActive(null)}
      onFocus={() => onActive(id)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onActive(null);
      }}
    >
      <button
        type="button"
        className="re-sug-main"
        aria-pressed={selected}
        aria-label={`${number}. ${kind}, ${describePlace(s)}, ${LEVEL_LABELS[s.level]} confidence ${Math.round(s.confidence * 100)}%. Select its bits.`}
        onClick={() => onSelect(item)}
      >
        <span className="re-sug-badge" aria-hidden="true">
          {number}
        </span>
        <span className="re-sug-what">
          <span className="re-sug-kind">
            {kind}
            {s.unconfirmed && <span className="tag">Unconfirmed</span>}
            {dismissed && <span className="tag">Dismissed</span>}
          </span>
          <span className="re-sug-place">{describePlace(s)}</span>
        </span>
        <span className="re-sug-level">
          {LEVEL_LABELS[s.level]} {'\u00b7'} {Math.round(s.confidence * 100)}%
        </span>
      </button>
      <div className="re-sug-body">
        <span className="re-sug-spark" aria-hidden="true">
          {t.length > 1 && <Sparkline x={t} y={s.sparkline.v} x0={t[0]} x1={t[t.length - 1]} />}
        </span>
        <p className="re-sug-reason">{s.reason}.</p>
        {s.fit && (
          <p className="re-sug-fit">
            Fitted to {s.fit.reference}: factor {plainNumber(s.fit.factor)}, offset {plainNumber(s.fit.offset)}
            {s.fit.unit ? ` (${s.fit.unit})` : ''}.
          </p>
        )}
      </div>
      {accepted ? (
        <div className="re-sug-accepted">
          <Check size={14} strokeWidth={2} aria-hidden="true" />
          <span role="status">
            Accepted {'\u00b7'} <span className="mono">{accepted.signal}</span>
          </span>
          <button type="button" className="text-button" onClick={() => ctx.setView('database')}>
            Review in Database
          </button>
          <button type="button" className="text-button" aria-label={`Undo ${accepted.signal}`} onClick={() => onUndo(item)}>
            Undo
          </button>
        </div>
      ) : (
        <div className="re-sug-actions">
          <button type="button" className="button" aria-label={`Accept suggestion ${number}`} onClick={() => onAccept(item)}>
            Accept
          </button>
          <button
            type="button"
            className="button"
            aria-label={`${dismissed ? 'Restore' : 'Dismiss'} suggestion ${number}`}
            onClick={() => discovery.dismiss(id, !dismissed)}
          >
            {dismissed ? 'Restore' : 'Dismiss'}
          </button>
          <button type="button" className="button" aria-pressed={plotted} aria-label={`Plot it: suggestion ${number}`} onClick={() => onPlot(item)}>
            {plotted && <Check size={14} strokeWidth={2} aria-hidden="true" />}
            Plot it
          </button>
        </div>
      )}
    </li>
  );
}

interface HintsProps {
  ctx: ViewContext;
  summary: IdSummary;
  hints: MessageHints;
  open: boolean;
  onOpen: (open: boolean) => void;
  inputRef: RefObject<HTMLInputElement | null>;
  parked: number | null;
  busy: boolean;
  onChange: (hints: MessageHints) => void;
}

/** Event markers and a reference signal, which raise what changes near the events and fit a scale. */
function Hints({ ctx, summary, hints, open, onOpen, inputRef, parked, busy, onChange }: HintsProps) {
  const ids = useId();
  const [text, setText] = useState('');
  const [markerError, setMarkerError] = useState<string | null>(null);
  const duration = ctx.log?.durationS ?? 0;
  const references = useMemo(
    () =>
      ctx.ids
        .filter((s) => s.key !== summary.key)
        .flatMap((s) => {
          const m = ctx.messageOf(s.key);
          return m
            ? m.signals.map((sig) => ({
                key: s.key,
                signal: sig.name,
                label: `${m.name}.${sig.name}`,
              }))
            : [];
        })
        .sort((a, b) => a.label.localeCompare(b.label)),
    [ctx, summary.key],
  );
  const current = hints.reference ? `${hints.reference.key}|${hints.reference.signal}` : '';
  const [choice, setChoice] = useState(current);

  if (!open) {
    return (
      <div className="re-sug-hints-closed">
        <button type="button" className="text-button" onClick={() => onOpen(true)}>
          Add a hint&hellip;
        </button>
      </div>
    );
  }

  const addMarker = () => {
    const t = text.trim() === '' ? parked : parseMarker(text);
    if (t === null || !(t >= 0 && t <= duration)) {
      setMarkerError(`Give a time from 0 to ${plainNumber(Number(duration.toFixed(3)))} s, or park the cursor on one.`);
      return;
    }
    setMarkerError(null);
    setText('');
    if (!hints.markers.includes(t))
      onChange({
        ...hints,
        markers: [...hints.markers, t].sort((a, b) => a - b),
      });
  };
  const fit = () => {
    const [k, ...rest] = choice.split('|');
    onChange({
      ...hints,
      reference: choice ? { key: Number(k), signal: rest.join('|') } : null,
    });
  };

  return (
    <div className="re-sug-hints">
      <h4 className="re-sug-hints-title">Add a hint</h4>
      <div className="field">
        <label className="field-label" htmlFor={`${ids}event`}>
          Something happened at
        </label>
        <div className="re-sug-hint-row">
          <input
            ref={inputRef}
            id={`${ids}event`}
            className="input"
            value={text}
            placeholder={
              parked !== null ? `e.g. I pressed the brake at 12 s (blank: ${plainNumber(Number(parked.toFixed(3)))} s)` : 'e.g. I pressed the brake at 12 s'
            }
            autoComplete="off"
            aria-invalid={!!markerError}
            aria-describedby={markerError ? `${ids}event-error` : undefined}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addMarker();
              }
            }}
          />
          <button type="button" className="button" onClick={addMarker} disabled={busy}>
            Add marker
          </button>
        </div>
        {markerError && (
          <p className="field-error" id={`${ids}event-error`}>
            {markerError}
          </p>
        )}
        {hints.markers.length > 0 && (
          <ul className="re-sug-markers" aria-label="Event markers">
            {hints.markers.map((t) => (
              <li key={t}>
                <span className="mono">{plainNumber(t)} s</span>
                <button
                  type="button"
                  className="icon-button small"
                  aria-label={`Remove the marker at ${plainNumber(t)} s`}
                  disabled={busy}
                  onClick={() =>
                    onChange({
                      ...hints,
                      markers: hints.markers.filter((m) => m !== t),
                    })
                  }
                >
                  <X size={14} strokeWidth={1.5} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="field">
        <label className="field-label" htmlFor={`${ids}ref`}>
          Compare with
        </label>
        <div className="re-sug-hint-row">
          <select id={`${ids}ref`} className="select" value={choice} onChange={(e) => setChoice(e.target.value)} disabled={references.length === 0}>
            <option value="">{references.length === 0 ? 'No decoded signals in this log' : 'No reference'}</option>
            {references.map((r) => (
              <option key={`${r.key}|${r.signal}`} value={`${r.key}|${r.signal}`}>
                {r.label}
              </option>
            ))}
          </select>
          <button type="button" className="button" onClick={fit} disabled={busy || choice === current}>
            {choice === '' && current ? 'Clear' : 'Fit scale'}
          </button>
        </div>
        <p className="re-quiet">Values that track it get a fitted factor and offset. Check them before adding.</p>
      </div>
    </div>
  );
}
