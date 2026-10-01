import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { ALL_IDS, formatId, isErrorFrame, type Candidate, type FindRule, type IdSummary } from '../../core/api';
import { formatCount, formatPeriod } from '../../format';
import { IdListSidebar } from '../shared/IdListSidebar';
import { useViewState } from '../shared/viewState';
import { InspectorSlot } from '../slots';
import type { ViewProps } from '../types';
import { FindSignalSheet } from './FindSignalSheet';
import { initialForm, useCandidateForms } from './SignalForm';
import { Workspace } from './Workspace';
import { clampWindow, defaultWindow, windowFits, type TimeWindow } from './bits';
import './reverse.css';

/** Work out an unknown ID's signals from how its bits change over a window of the log. */
export function ReverseView({ ctx }: ViewProps) {
  const { log, ids, messageOf, selected, logVersion } = ctx;
  const duration = log?.durationS ?? 0;
  // Null until moved. Saved state is stored apart from the log and can outlast it, so it is checked against this one.
  const [savedWin, setWin] = useViewState<TimeWindow | null>('re.window', null, 'log');
  const win = useMemo(() => (savedWin && windowFits(savedWin, duration) ? savedWin : defaultWindow(duration)), [savedWin, duration]);
  const [findOpen, setFindOpen] = useState(false);
  const [, setForms] = useCandidateForms();

  const unknown = useMemo(
    () => ids.filter((s) => !messageOf(s.key) && !isErrorFrame(s)).sort((a, b) => a.channel - b.channel || a.id - b.id),
    [ids, messageOf],
  );

  if (!log) return null;

  const summary = selected === ALL_IDS ? null : (ids.find((s) => s.key === selected) ?? null);
  const message = summary ? messageOf(summary.key) : null;

  const loadCandidate = (c: Candidate, rules: FindRule[]) => {
    // Frame the stretch the rules describe, with a little either side.
    const t0 = Math.min(...rules.map((r) => r.t0));
    const t1 = Math.max(...rules.map((r) => r.t1));
    const pad = (t1 - t0) * 0.1;
    setWin(clampWindow([t0 - pad, t1 + pad], duration));
    setForms((all) => ({ ...all, [c.key]: initialForm(c.spec) }));
    if (c.key !== selected) ctx.select(c.key);
    setFindOpen(false);
  };

  return (
    <>
      <IdListSidebar ctx={ctx} />
      <header className="content-header">
        {summary ? (
          <div className="re-heading">
            <h2 className="content-title re-title">
              <span className="mono">{formatId(summary.id, summary.extended)}</span>
              {message ? <span>{message.name}</span> : <span className="status unknown">Unknown</span>}
            </h2>
            <p className="content-sub">{describe(log.channels, summary, true)}</p>
          </div>
        ) : (
          <div className="re-heading">
            <h2 className="content-title">Choose an ID</h2>
            <p className="content-sub">
              {formatCount(unknown.length)} of {formatCount(ids.length)} IDs aren&rsquo;t in the database
            </p>
          </div>
        )}
        <div className="content-actions">
          <button type="button" className="button" onClick={() => setFindOpen(true)}>
            <Search size={16} strokeWidth={1.5} aria-hidden="true" />
            Find Signal&hellip;
          </button>
        </div>
      </header>

      {summary ? (
        <Workspace
          key={`${summary.key}:${logVersion}`}
          ctx={ctx}
          summary={summary}
          message={message}
          window={win}
          onWindowChange={setWin}
        />
      ) : (
        <div className="content-scroll re-scroll">
          <section className="card re-card re-pick" aria-labelledby="re-pick-title">
            <h3 className="section-title" id="re-pick-title">
              Pick an ID to reverse engineer
            </h3>
            <p className="hint">
              Choose an ID in the sidebar. Unknown IDs aren&rsquo;t described by the database yet, so they&rsquo;re the place to start. Or describe how a
              signal behaves and let Find Signal search for it.
            </p>
            {unknown.length > 0 ? (
              <ul className="re-pick-list">
                {unknown.slice(0, 8).map((s, i) => (
                  <li key={s.key}>
                    <button type="button" className="text-button" onClick={() => ctx.select(s.key)}>
                      {i === 0 ? 'Start with ' : 'Select '}
                      <span className="mono">{formatId(s.id, s.extended)}</span>
                    </button>
                    <span className="re-pick-meta">{describe(log.channels, s, false)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="hint">Every ID is in the database.</p>
            )}
          </section>
        </div>
      )}

      {!summary && (
        <InspectorSlot>
          <header className="inspector-head">
            <h2 className="pane-title">New Signal</h2>
            <p className="sub">No ID selected</p>
          </header>
          <div className="inspector-section">
            <p className="hint">Select an ID, then drag across its bits to define a signal.</p>
          </div>
        </InspectorSlot>
      )}

      <FindSignalSheet key={logVersion} open={findOpen} onClose={() => setFindOpen(false)} ctx={ctx} duration={duration} onUse={loadCandidate} />
    </>
  );
}

/** Bus, period, frame count and optionally payload length, separated by middle dots. */
function describe(channels: string[], s: IdSummary, withLength: boolean): string {
  const length = s.minLen === s.maxLen ? `${s.maxLen} bytes` : `${s.minLen}-${s.maxLen} bytes`;
  return [
    channels[s.channel],
    s.periodMs !== null ? `every ${formatPeriod(s.periodMs)}` : null,
    `${formatCount(s.count)} frames`,
    withLength ? length : null,
  ]
    .filter(Boolean)
    .join(' \u00b7 ');
}
