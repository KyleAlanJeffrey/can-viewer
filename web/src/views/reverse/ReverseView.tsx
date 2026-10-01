import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Search } from 'lucide-react';
import { ALL_IDS, formatId, isErrorFrame, type Candidate, type FindRule } from '../../core/api';
import { formatCount } from '../../format';
import { IdListSidebar } from '../shared/IdListSidebar';
import { useViewState } from '../shared/viewState';
import { InspectorSlot } from '../slots';
import type { ViewProps } from '../types';
import { AnalysisWindow } from './AnalysisWindow';
import { BaselineSheet } from './BaselineSheet';
import { ByteMatrix, type SelectedByte } from './ByteMatrix';
import { FindSignalSheet } from './FindSignalSheet';
import { PinSignalSheet } from './PinSignalSheet';
import { References } from './References';
import { initialForm, useCandidateForms } from './SignalForm';
import { Workspace } from './Workspace';
import { clampTime, clampWindow, defaultWindow, describeId, matchesQuery, windowFits, type TimeWindow } from './bits';
import { pinId, useReferences, type Pin } from './pins';
import './reverse.css';

type Mode = 'bytes' | 'advanced';

/** The Byte Values scroll position, restored when coming back to it from Advanced or another view. */
let savedScroll = 0;

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
  const [, setForms] = useCandidateForms();
  const scroller = useRef<HTMLDivElement>(null);
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

  if (!log) return null;

  const summary = selected === ALL_IDS ? null : (ids.find((s) => s.key === selected) ?? null);
  const message = summary ? messageOf(summary.key) : null;

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

  const openAdvanced = () => {
    if (summary && selectedByte?.key === summary.key) {
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
            <span className="re-scope-note">{scope}</span>
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
            pins={pins}
            onSelectRow={selectRow}
            onSelectByte={selectByte}
            onHover={setHover}
            onPark={park}
            onTogglePin={togglePin}
            onOpenAdvanced={openAdvanced}
          />
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
