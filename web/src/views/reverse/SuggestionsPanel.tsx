import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { formatId, type IdSummary } from '../../core/api';
import { Segmented } from '../../components/Segmented';
import { formatCount } from '../../format';
import type { ViewContext } from '../types';
import { pinId, type Pin } from './pins';
import { ScanOverview, SuggestionRow, promise, suggestedName, undoAccepted } from './Suggestions';
import { PANEL_WIDTH, describeBytes, shownSuggestions, suggestionBytes, suggestionPin, type ShownSuggestion, type SuggestionScope } from './suggestionList';
import type { Discovery } from './useDiscovery';
import './suggestions.css';

interface Props {
  ctx: ViewContext;
  discovery: Discovery;
  unknown: IdSummary[];
  /** The selected message, or null. */
  summary: IdSummary | null;
  scope: SuggestionScope;
  onScope: (scope: SuggestionScope) => void;
  /** The suggestion outlined in the table. */
  selected: string | null;
  onSelect: (key: number, s: ShownSuggestion) => void;
  /** Put the suggestion in the New Signal form under this name. */
  onAccept: (key: number, s: ShownSuggestion, name: string) => void;
  pins: Pin[];
  onPlot: (key: number, s: ShownSuggestion) => void;
  /** Select a message, as Most promising does. */
  onPick: (key: number) => void;
  onHide: () => void;
  width: number;
  onWidth: (width: number) => void;
}

/**
 * Suggested signals beside the Byte Values matrix, for the selected message or across every
 * message scanned. Selecting a card outlines its bytes in the table.
 */
export function SuggestionsPanel(props: Props) {
  const { ctx, discovery, unknown, summary, scope, onScope, selected, onSelect, onAccept, pins, onPlot, onPick, onHide, width, onWidth } = props;
  const ids = useId();
  const [showDismissed, setShowDismissed] = useState(false);
  const [refocus, setRefocus] = useState<string | null>(null);
  const drag = useRef<{ x: number; width: number } | null>(null);
  const key = summary?.key ?? null;
  const { ensure } = discovery;
  const { capturing } = ctx;

  // A capture's messages are still growing, so suggesting waits until it stops.
  useEffect(() => {
    if (key !== null && !capturing) ensure(key);
  }, [ensure, key, capturing]);
  useEffect(() => {
    setShowDismissed(false);
  }, [key]);

  const pinned = new Set(pins.map(pinId));
  const listFor = (s: IdSummary, withDismissed = false) => shownSuggestions(discovery, s.key, ctx.messageOf(s.key), s.maxLen * 8, withDismissed);

  const cards = (s: IdSummary, items: ShownSuggestion[]) => (
    <ol className="re-sug-list">
      {items.map((item) => {
        const isSelected = selected === item.id;
        return (
          <SuggestionRow
            key={item.id}
            ctx={ctx}
            item={item}
            discovery={discovery}
            active={false}
            selected={isSelected}
            plotted={pinned.has(pinId(suggestionPin(s.key, item)))}
            onActive={() => {}}
            onSelect={(x) => onSelect(s.key, x)}
            onAccept={(x) => onAccept(s.key, x, suggestedName(x, ctx.messageOf(s.key)))}
            onUndo={(x) => undoAccepted(ctx, discovery, x.id, () => setRefocus(x.id))}
            focusAccept={refocus === item.id}
            onFocused={() => setRefocus(null)}
            onPlot={(x) => onPlot(s.key, x)}
            primaryAccept={isSelected}
            note={isSelected ? `Highlights ${describeBytes(suggestionBytes(item))} in the table.` : null}
            of={scope === 'all' ? formatId(s.id, s.extended) : undefined}
          />
        );
      })}
    </ol>
  );

  // Arrow keys move between the cards; Enter or Space on one selects it, as a button does.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
    const target = e.target as HTMLElement;
    if (step === 0 || !target.classList.contains('re-sug-main')) return;
    const all = [...e.currentTarget.querySelectorAll<HTMLElement>('.re-sug-main')];
    const next = all[all.indexOf(target) + step];
    if (!next) return;
    e.preventDefault();
    next.focus();
  };

  const startDrag = (e: PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, width };
  };
  const resize = (to: number) => onWidth(Math.round(Math.min(PANEL_WIDTH.max, Math.max(PANEL_WIDTH.min, to))));

  return (
    <aside className="re-sugpanel" aria-labelledby={`${ids}title`} style={{ '--re-sug-width': `${width}px` } as CSSProperties}>
      <div
        className="re-sugpanel-grip"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize Suggested signals"
        aria-valuemin={PANEL_WIDTH.min}
        aria-valuemax={PANEL_WIDTH.max}
        aria-valuenow={width}
        tabIndex={0}
        onPointerDown={startDrag}
        onPointerMove={(e) => drag.current && resize(drag.current.width - (e.clientX - drag.current.x))}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
        onKeyDown={(e) => {
          const step = e.key === 'ArrowLeft' ? 16 : e.key === 'ArrowRight' ? -16 : 0;
          if (step === 0) return;
          e.preventDefault();
          resize(width + step);
        }}
      />
      <div className="re-sugpanel-scroll" onKeyDown={onKeyDown}>
        <div className="re-sugpanel-head">
          <h2 className="pane-title" id={`${ids}title`}>
            Suggested signals
          </h2>
          <button type="button" className="icon-button" aria-label="Hide Suggested signals" title="Hide Suggested signals" onClick={onHide}>
            <ChevronDown size={18} strokeWidth={1.5} aria-hidden="true" />
          </button>
        </div>
        {capturing ? (
          <p className="hint">Suggestions are made once the capture stops.</p>
        ) : (
          <>
            {summary && <MessageLine ctx={ctx} summary={summary} discovery={discovery} count={listFor(summary).length} />}
            <Segmented
              label="Suggestions for"
              className="re-sugpanel-scope"
              options={[
                { value: 'selected', label: 'Selected message' },
                { value: 'all', label: 'All messages' },
              ]}
              value={scope}
              onChange={onScope}
            />
            <p className="re-sug-caution">Suggestions are guesses. Check them against the log before accepting.</p>
            <ScanOverview ctx={ctx} discovery={discovery} unknown={unknown} current={key} onPick={onPick} />
            {scope === 'all' ? (
              <AllMessages ctx={ctx} discovery={discovery} listFor={listFor} cards={cards} onPick={onPick} />
            ) : summary ? (
              <SelectedMessage
                discovery={discovery}
                summary={summary}
                listed={listFor(summary, true)}
                showDismissed={showDismissed}
                onShowDismissed={setShowDismissed}
                cards={cards}
              />
            ) : (
              <p className="hint re-sug-state">Select a message in the table to see what it might carry, or look across All messages.</p>
            )}
          </>
        )}
      </div>
      <p className="re-sugpanel-foot">Plot it adds the candidate to pinned references.</p>
    </aside>
  );
}

function MessageLine({ ctx, summary, discovery, count }: { ctx: ViewContext; summary: IdSummary; discovery: Discovery; count: number }) {
  const message = ctx.messageOf(summary.key);
  const result = discovery.results[summary.key];
  const frames = result
    ? result.sampledFrames < result.frames
      ? `from ${formatCount(result.sampledFrames)} of ${formatCount(result.frames)} frames`
      : `from ${formatCount(result.frames)} ${result.frames === 1 ? 'frame' : 'frames'}`
    : null;
  return (
    <div className="re-sugpanel-msg">
      <p className="re-sugpanel-id">
        <span className="mono">{formatId(summary.id, summary.extended)}</span>
        {message ? <span>{message.name}</span> : <span className="status unknown">Unknown</span>}
        <span className="re-row-bus mono">{ctx.log?.channels[summary.channel]}</span>
      </p>
      {result && (
        <p className="re-sugpanel-count">
          {formatCount(count)} {count === 1 ? 'suggestion' : 'suggestions'} {'\u00b7'} {frames}
        </p>
      )}
    </div>
  );
}

interface SelectedProps {
  discovery: Discovery;
  summary: IdSummary;
  /** Its suggestions, dismissed ones too. */
  listed: ShownSuggestion[];
  showDismissed: boolean;
  onShowDismissed: (show: boolean) => void;
  cards: (s: IdSummary, items: ShownSuggestion[]) => ReactNode;
}

function SelectedMessage({ discovery, summary, listed, showDismissed, onShowDismissed, cards }: SelectedProps) {
  const key = summary.key;
  const result = discovery.results[key];
  const error = discovery.errors[key] ?? null;
  const running = discovery.running.includes(key);
  const shown = showDismissed ? listed : listed.filter((s) => !discovery.dismissed.has(s.id));
  const dismissedCount = listed.filter((s) => discovery.dismissed.has(s.id)).length;
  const id = formatId(summary.id, summary.extended);

  if (error) {
    return (
      <div className="re-sug-state">
        <p className="re-quiet">Suggestions: {error}</p>
        <button type="button" className="button" onClick={() => discovery.rescan(key)}>
          Scan again
        </button>
      </div>
    );
  }
  if (!result) {
    return running || discovery.progress ? (
      <p className="hint re-sug-state" role="status">
        Looking for signals in <span className="mono">{id}</span>&hellip;
      </p>
    ) : (
      <div className="re-sug-state">
        <p className="hint">Not scanned yet.</p>
        <button type="button" className="button" onClick={() => discovery.rescan(key)}>
          Suggest signals
        </button>
      </div>
    );
  }
  const foot = (
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
  );
  if (shown.length === 0) {
    return (
      <div className="re-sug-state">
        <p className="re-sug-empty">No suggestions for this message</p>
        <p className="hint">
          {dismissedCount > 0
            ? `${dismissedCount} dismissed.`
            : (result.suggestions.length > 0 ? 'What it found overlaps signals the database already has. ' : '') +
              'Try a longer log, or add an event hint in Advanced.'}
        </p>
        {foot}
      </div>
    );
  }
  return (
    <>
      {cards(summary, shown)}
      {foot}
    </>
  );
}

interface AllProps {
  ctx: ViewContext;
  discovery: Discovery;
  listFor: (s: IdSummary) => ShownSuggestion[];
  cards: (s: IdSummary, items: ShownSuggestion[]) => ReactNode;
  onPick: (key: number) => void;
}

/** Every scanned message with suggestions, most promising first. */
function AllMessages({ ctx, discovery, listFor, cards, onPick }: AllProps) {
  const groups = Object.keys(discovery.results)
    .map((k) => ctx.ids.find((s) => s.key === Number(k)))
    .filter((s): s is IdSummary => s !== undefined)
    .map((s) => ({ summary: s, items: listFor(s) }))
    .filter((g) => g.items.length > 0)
    .sort((a, b) => promise(discovery, b.summary.key) - promise(discovery, a.summary.key) || a.summary.key - b.summary.key);
  if (groups.length === 0) {
    return <p className="hint re-sug-state">{Object.keys(discovery.results).length === 0 ? 'Nothing scanned yet.' : 'Nothing suggested yet.'}</p>;
  }
  return (
    <ul className="re-sugpanel-groups">
      {groups.map(({ summary, items }) => {
        const message = ctx.messageOf(summary.key);
        return (
          <li key={summary.key}>
            <button
              type="button"
              className="re-sugpanel-group"
              aria-pressed={ctx.selected === summary.key}
              onClick={() => onPick(summary.key)}
            >
              <span className="mono">{formatId(summary.id, summary.extended)}</span>
              {message ? <span>{message.name}</span> : <span className="status unknown">Unknown</span>}
              <span className="re-row-bus mono">{ctx.log?.channels[summary.channel]}</span>
              <span className="re-sugpanel-group-count">
                {formatCount(items.length)} {items.length === 1 ? 'suggestion' : 'suggestions'}
              </span>
            </button>
            {cards(summary, items)}
          </li>
        );
      })}
    </ul>
  );
}
