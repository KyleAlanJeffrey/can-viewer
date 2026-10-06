import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Search } from 'lucide-react';
import { ALL_IDS, formatId, isErrorFrame, type Candidate, type FindRule } from '../../core/api';
import { ChunkBoundary } from '../../components/ChunkBoundary';
import { formatCount } from '../../format';
import { IdListSidebar } from '../shared/IdListSidebar';
import { useViewState } from '../shared/viewState';
import { InspectorSlot } from '../slots';
import type { ViewProps } from '../types';
import { AnalysisWindow } from './AnalysisWindow';
import { BaselineSheet } from './BaselineSheet';
import { ByteMatrix, onSuggestion, type SelectedByte, type SuggestionMark } from './ByteMatrix';
import { FindSignalSheet } from './FindSignalSheet';
import { PinSignalSheet } from './PinSignalSheet';
import { References } from './References';
import { initialForm, useCandidateForms } from './SignalForm';
import { Workspace } from './Workspace';
import { clampTime, clampWindow, defaultWindow, describeId, matchesQuery, windowFits, type TimeWindow } from './bits';
import { pinId, useReferences, type Pin } from './pins';
import {
  PANEL_WIDTH,
  describeBits,
  shownSuggestions,
  suggestionBytes,
  suggestionForm,
  suggestionPin,
  type ShownSuggestion,
  type SuggestionScope,
} from './suggestionList';
import { useDiscovery } from './useDiscovery';
import './reverse.css';

type Mode = 'bytes' | 'advanced';

/** The Byte Values scroll position, restored when coming back to it from Advanced or another view. */
let savedScroll = 0;
/** A CAN FD payload's bits. */
const MAX_BITS = 512;
// Loaded on first use to keep the main bundle small.
const SuggestionsPanel = lazy(() => import('./SuggestionsPanel').then((m) => ({ default: m.SuggestionsPanel })));

/**
 * Byte Values compares every message's bytes with pinned references; Advanced works out one
 * message's signals from its bits. Both share the analysis window, cursor and pins.
 */
export function ReverseView({ ctx }: ViewProps) {
  const { log, ids, messageOf, selected, logVersion, query, pinnedTime, setPinnedTime, setInspectorHidden } = ctx;
  const duration = log?.durationS ?? 0;
  const [mode, setMode] = useViewState<Mode>('re.mode', 'bytes');
  // Null until moved. Saved state is stored apart from the log and can outlast it, so it is checked against this one.
  const [savedWin, setWin] = useViewState<TimeWindow | null>('re.window', null, 'log');
  const win = useMemo(() => (savedWin && windowFits(savedWin, duration) ? savedWin : defaultWindow(duration)), [savedWin, duration]);
  const [pins, setPins] = useViewState<Pin[]>('re.pins', [], 'log');
  const [selectedByte, setSelectedByte] = useViewState<SelectedByte | null>('re.byte', null, 'log');
  const [bus, setBus] = useViewState<string | null>('re.bus', null, 'log');
  const [savedBaseline, setBaseline] = useViewState<TimeWindow | null>('re.baseline', null, 'log');
  const baseline = savedBaseline && windowFits(savedBaseline, duration) ? savedBaseline : null;
  const [hover, setHover] = useState<number | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [pinOpen, setPinOpen] = useState(false);
  const [baselineOpen, setBaselineOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useViewState('re.suggestionsOpen', true);
  const [panelScope, setPanelScope] = useViewState<SuggestionScope>('re.suggestionsScope', 'selected');
  const [panelWidth, setPanelWidth] = useViewState('re.suggestionsWidth', PANEL_WIDTH.initial);
  const [pickedId, setPickedId] = useViewState<string | null>('re.suggestion', null, 'log');
  const [, setExpanded] = useViewState<number[]>('re.expanded', [], 'log');
  const [focusName, setFocusName] = useState(false);
  const nameFocused = useCallback(() => setFocusName(false), []);
  const [, setForms] = useCandidateForms();
  const scroller = useRef<HTMLDivElement>(null);
  const panelSwitch = useRef<HTMLInputElement>(null);
  const references = useReferences(ctx, pins);

  useEffect(() => {
    setInspectorHidden(mode === 'bytes');
  }, [setInspectorHidden, mode]);

  useLayoutEffect(() => {
    if (mode === 'bytes' && scroller.current) scroller.current.scrollTop = savedScroll;
  }, [mode]);

  // Pins and the selected byte can name IDs a newly opened log doesn't have.
  useEffect(() => {
    if (ids.length === 0) return;
    const present = new Set(ids.map((s) => s.key));
    setPins((all) => (all.every((p) => present.has(p.key)) ? all : all.filter((p) => present.has(p.key))));
    setSelectedByte((b) => (b && !present.has(b.key) ? null : b));
  }, [ids, setPins, setSelectedByte]);

  const parked = pinnedTime === null ? null : clampTime(pinnedTime, duration);
  const cursor = hover ?? parked;
  const park = (t: number) => setPinnedTime(clampTime(t, duration));

  useEffect(() => {
    if (findOpen || pinOpen || baselineOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && pinnedTime !== null) setPinnedTime(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [findOpen, pinOpen, baselineOpen, pinnedTime, setPinnedTime]);

  const channels = useMemo(() => log?.channels ?? [], [log]);
  const messages = useMemo(() => ids.filter((s) => !isErrorFrame(s)).sort((a, b) => a.channel - b.channel || a.id - b.id), [ids]);
  const rows = useMemo(
    () => messages.filter((s) => (bus === null || channels[s.channel] === bus) && matchesQuery(s, messageOf(s.key), query)),
    [messages, bus, channels, messageOf, query],
  );
  const unknown = useMemo(() => messages.filter((s) => !messageOf(s.key)), [messages, messageOf]);
  const unknownKeys = useMemo(() => unknown.map((s) => s.key), [unknown]);
  const discovery = useDiscovery(ctx, unknownKeys);
  const { results, dismissed, accepted } = discovery;

  const summary = selected === ALL_IDS ? null : (ids.find((s) => s.key === selected) ?? null);
  const message = summary ? messageOf(summary.key) : null;
  const listed = useMemo(
    () => (summary ? shownSuggestions({ results, dismissed, accepted }, summary.key, message, summary.maxLen * 8) : []),
    [results, dismissed, accepted, summary, message],
  );
  // Across every message scanned when none is selected.
  const suggestionCount = useMemo(() => {
    if (summary) return results[summary.key] ? listed.length : null;
    const scanned = Object.values(results);
    if (scanned.length === 0) return null;
    return scanned.reduce((n, found) => n + shownSuggestions({ results, dismissed, accepted }, found.key, messageOf(found.key), MAX_BITS).length, 0);
  }, [summary, listed, results, dismissed, accepted, messageOf]);

  if (!log) return null;

  const picked = panelOpen ? (listed.find((s) => s.id === pickedId) ?? null) : null;
  const mark: SuggestionMark | null =
    summary && picked ? { key: summary.key, number: picked.number, bytes: suggestionBytes(picked), bits: describeBits(picked.suggestion.spec) } : null;

  const togglePin = (pin: Pin) => {
    const id = pinId(pin);
    setPins((all) => (all.some((p) => pinId(p) === id) ? all.filter((p) => pinId(p) !== id) : [...all, pin]));
  };
  const unpin = (pin: Pin) => setPins((all) => all.filter((p) => pinId(p) !== pinId(pin)));

  const selectRow = (key: number) => {
    if (key !== selected) ctx.select(key);
    if (selectedByte && selectedByte.key !== key) setSelectedByte(null);
  };
  const selectByte = (b: SelectedByte) => {
    setSelectedByte(b);
    if (b.key !== selected) ctx.select(b.key);
  };

  const selectSuggestion = (key: number, s: ShownSuggestion) => {
    const bytes = suggestionBytes(s);
    setPickedId(s.id);
    setSelectedByte({ key, byte: bytes[0] });
    // Bytes past B7 show only in the message's further rows.
    if (bytes[bytes.length - 1] >= 8) setExpanded((keys) => (keys.includes(key) ? keys : [...keys, key]));
    if (key !== selected) ctx.select(key);
  };
  const acceptSuggestion = (key: number, s: ShownSuggestion, name: string) => {
    setForms((all) => ({ ...all, [key]: { ...(all[key] ?? initialForm(null)), ...suggestionForm(s.suggestion), name } }));
    if (key !== selected) ctx.select(key);
    setFocusName(true);
    ctx.openInspector();
    setMode('advanced');
  };

  const openAdvanced = () => {
    if (summary && picked && mark && onSuggestion(mark, selectedByte)) {
      const form = suggestionForm(picked.suggestion);
      setForms((all) => ({ ...all, [summary.key]: { ...(all[summary.key] ?? initialForm(null)), ...form } }));
    } else if (summary && selectedByte?.key === summary.key) {
      const byte = selectedByte.byte;
      setForms((all) => ({
        ...all,
        [summary.key]: { ...(all[summary.key] ?? initialForm(null)), startBit: String(byte * 8), size: '8', byteOrder: 'intel', fromGrid: true, limits: null },
      }));
    }
    setMode('advanced');
  };

  const loadCandidate = (c: Candidate, rules: FindRule[]) => {
    // Frame the stretch the rules describe, with a little either side.
    const t0 = Math.min(...rules.map((r) => r.t0));
    const t1 = Math.max(...rules.map((r) => r.t1));
    const pad = (t1 - t0) * 0.1;
    setWin(clampWindow([t0 - pad, t1 + pad], duration));
    setForms((all) => ({ ...all, [c.key]: initialForm(c.spec) }));
    if (c.key !== selected) ctx.select(c.key);
    setMode('advanced');
    setFindOpen(false);
  };

  const buses = new Set(rows.map((s) => s.channel)).size;
  const scope = `${bus ?? 'All messages'} \u00b7 ${formatCount(rows.length)} ${rows.length === 1 ? 'ID' : 'IDs'} \u00b7 ${buses} ${buses === 1 ? 'bus' : 'buses'}${query.trim() ? ' (filtered)' : ''}`;

  return (
    <>
      <IdListSidebar ctx={ctx} />
      <header className="content-header re-header">
        <div className="re-modes" role="tablist" aria-label="Reverse Engineer mode">
          {(
            [
              ['bytes', 'Byte Values'],
              ['advanced', 'Advanced'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="tab"
              className="re-mode"
              aria-selected={mode === value}
              onClick={() => setMode(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="content-actions">
          {mode === 'bytes' ? (
            <>
              <span className="re-scope-note">{scope}</span>
              <label className="re-sug-toggle">
                <input ref={panelSwitch} type="checkbox" role="switch" className="switch" checked={panelOpen} onChange={(e) => setPanelOpen(e.target.checked)} />
                Suggested signals{suggestionCount !== null && ` \u00b7 ${formatCount(suggestionCount)}`}
              </label>
            </>
          ) : (
            <>
              <button type="button" className="button" onClick={() => setMode('bytes')}>
                <ArrowLeft size={16} strokeWidth={1.5} aria-hidden="true" />
                All byte values
              </button>
              <button type="button" className="button" onClick={() => setBaselineOpen(true)}>
                {baseline ? 'Ignore Baseline (On)\u2026' : 'Ignore Baseline\u2026'}
              </button>
            </>
          )}
          <button type="button" className="button" onClick={() => setFindOpen(true)}>
            <Search size={16} strokeWidth={1.5} aria-hidden="true" />
            Find Signal&hellip;
          </button>
        </div>
      </header>

      {mode === 'bytes' ? (
        <div className="re-split">
          <div className="re-split-body">
            <div
              ref={scroller}
              className="content-scroll re-scroll re-bytes"
              role="tabpanel"
              aria-label="Byte Values"
              onScroll={(e) => {
                savedScroll = e.currentTarget.scrollTop;
              }}
            >
              <References
                core={ctx.core}
                references={references}
                window={win}
                cursor={cursor}
                onHover={setHover}
                onPark={park}
                onUnpin={unpin}
                onPinSignal={() => setPinOpen(true)}
              >
                <AnalysisWindow window={win} duration={duration} onChange={setWin} />
              </References>
              <ByteMatrix
                ctx={ctx}
                rows={rows}
                window={win}
                cursor={cursor}
                bus={bus}
                onBus={setBus}
                selectedByte={selectedByte}
                suggestion={mark}
                pins={pins}
                onSelectRow={selectRow}
                onSelectByte={selectByte}
                onHover={setHover}
                onPark={park}
                onTogglePin={togglePin}
                onOpenAdvanced={openAdvanced}
              />
            </div>
            {panelOpen && (
              <ChunkBoundary message="Couldn't load the suggestions." frame={(fallback) => <div className="re-sugpanel">{fallback}</div>}>
                <Suspense
                  fallback={
                    <div className="re-sugpanel">
                      <p className="hint re-sugpanel-loading">Loading suggestions&hellip;</p>
                    </div>
                  }
                >
                  <SuggestionsPanel
                    ctx={ctx}
                    discovery={discovery}
                    unknown={unknown}
                    summary={summary}
                    scope={panelScope}
                    onScope={setPanelScope}
                    selected={picked?.id ?? null}
                    onSelect={selectSuggestion}
                    onAccept={acceptSuggestion}
                    pins={pins}
                    onPlot={(key, s) => togglePin(suggestionPin(key, s))}
                    onPick={selectRow}
                    onHide={() => {
                      setPanelOpen(false);
                      // The panel took its focused button with it.
                      requestAnimationFrame(() => panelSwitch.current?.focus());
                    }}
                    width={panelWidth}
                    onWidth={setPanelWidth}
                  />
                </Suspense>
              </ChunkBoundary>
            )}
          </div>
        </div>
      ) : summary ? (
        <Workspace
          key={`${summary.key}:${logVersion}`}
          ctx={ctx}
          summary={summary}
          message={message}
          window={win}
          onWindowChange={setWin}
          references={references}
          cursor={cursor}
          onHover={setHover}
          onPark={park}
          onUnpin={unpin}
          onPinSignal={() => setPinOpen(true)}
          baseline={baseline}
          discovery={discovery}
          unknown={unknown}
          pins={pins}
          onTogglePin={togglePin}
          parked={parked}
          focusName={focusName}
          onNameFocused={nameFocused}
        />
      ) : (
        <div className="content-scroll re-scroll" role="tabpanel" aria-label="Advanced">
          <section className="card re-card re-pick" aria-labelledby="re-pick-title">
            <h3 className="section-title" id="re-pick-title">
              Select a message
            </h3>
            <p className="hint">
              Advanced works on one message at a time. Choose one in the sidebar or in Byte Values. Unknown IDs aren&rsquo;t described by the database yet,
              so they&rsquo;re the place to start. Or describe how a signal behaves and let Find Signal search for it.
            </p>
            {unknown.length > 0 ? (
              <ul className="re-pick-list">
                {unknown.slice(0, 8).map((s, i) => (
                  <li key={s.key}>
                    <button type="button" className="text-button" onClick={() => ctx.select(s.key)}>
                      {i === 0 ? 'Start with ' : 'Select '}
                      <span className="mono">{formatId(s.id, s.extended)}</span>
                    </button>
                    <span className="re-pick-meta">{describeId(channels, s, false)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="hint">Every ID is in the database.</p>
            )}
          </section>
        </div>
      )}

      {mode === 'advanced' && !summary && (
        <InspectorSlot>
          <header className="inspector-head">
            <h2 className="pane-title">New Signal</h2>
            <p className="sub">No message selected</p>
          </header>
          <div className="inspector-section">
            <p className="hint">Select a message, then drag across its bits to define a signal.</p>
          </div>
        </InspectorSlot>
      )}

      <BaselineSheet
        open={baselineOpen}
        onClose={() => setBaselineOpen(false)}
        ctx={ctx}
        duration={duration}
        baseline={baseline}
        onApply={setBaseline}
      />
      <PinSignalSheet open={pinOpen} onClose={() => setPinOpen(false)} ctx={ctx} pins={pins} onToggle={togglePin} />
      <FindSignalSheet key={logVersion} open={findOpen} onClose={() => setFindOpen(false)} ctx={ctx} duration={duration} onUse={loadCandidate} />
    </>
  );
}
