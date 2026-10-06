import { useEffect, useState } from 'react';
import { formatId, type BitFlips, type CoreApi, type IdSummary, type MessageDef } from '../core/api';
import { formatPeriod } from '../format';
import { signalLayout } from '../signalBits';
import { BitHeatmap } from './BitHeatmap';

interface Props {
  core: CoreApi;
  summary: IdSummary | null;
  channels: string[];
  message: MessageDef | null;
  logVersion: number;
  /** Colour per signal of `message`, in order; a plotted signal keeps its plot colour. */
  signalColors: string[];
  /** Signal names currently plotted for this ID. */
  plotted: Set<string>;
  onTogglePlot: (signal: string) => void;
}

export function DetailPanel({ core, summary, channels, message, logVersion, signalColors, plotted, onTogglePlot }: Props) {
  const [counts, setCounts] = useState<BitFlips | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);

  useEffect(() => {
    setCounts(null);
    if (!summary) return;
    let stale = false;
    core.bitFlips(summary.key).then((c) => {
      if (!stale) setCounts(c);
    });
    return () => {
      stale = true;
    };
  }, [core, summary, logVersion]);

  if (!summary) {
    return (
      <div className="inspector-section">
        <p className="hint">Select an ID to see which bits change and the signals it carries.</p>
      </div>
    );
  }

  const length = summary.minLen === summary.maxLen ? `${summary.maxLen} bytes` : `${summary.minLen}-${summary.maxLen} bytes`;
  return (
    <>
      <header className="inspector-head">
        <h2 className="pane-title">
          <span className="mono">{formatId(summary.id, summary.extended)}</span>
          {message?.name ?? 'Unknown'}
        </h2>
        <p className="sub">
          {channels[summary.channel]}
          {summary.periodMs !== null && <> &middot; every {formatPeriod(summary.periodMs)}</>} &middot; {length}
        </p>
        {message?.comment && <p className="sub">{message.comment}</p>}
      </header>

      <section className="inspector-section" aria-labelledby="bit-activity">
        <div className="section-head">
          <h3 className="section-title" id="bit-activity">
            Bit Activity
          </h3>
        </div>
        {counts && summary.maxLen > 0 ? (
          <>
            <BitHeatmap
              flips={counts.flips}
              pairs={counts.pairs}
              bytes={summary.maxLen}
              signals={message?.signals ?? []}
              colors={signalColors}
              highlight={hovered}
            />
            <div className="heat-legend">
              <span>Rarely &rarr; Every frame</span>
              <span className="swatches" aria-hidden="true">
                <span className="unset" title="Never changes" />
                {[1, 2, 3, 4, 5, 6].map((i) => (
                  <span key={i} style={{ background: `var(--heat-${i})` }} />
                ))}
              </span>
            </div>
          </>
        ) : (
          <p className="hint">{summary.maxLen === 0 ? 'No payload.' : 'Counting bit changes\u2026'}</p>
        )}
      </section>

      <section className="inspector-section" aria-labelledby="signals">
        <div className="section-head">
          <h3 className="section-title" id="signals">
            Signals
          </h3>
          {message && message.signals.length > 0 && <span className="col-label">Plot</span>}
        </div>
        {message ? (
          <ul className="signals">
            {message.signals.map((s, i) => (
              <li key={s.name}>
                <label
                  className="signal-row"
                  onPointerEnter={() => setHovered(s.name)}
                  onPointerLeave={() => setHovered(null)}
                  title={s.comment ?? undefined}
                >
                  <span className="dot" style={{ background: signalColors[i] }} />
                  <span className="name">
                    {s.name}
                    {s.unit && <span className="unit">{s.unit}</span>}
                  </span>
                  <span className="layout">
                    {s.muxValue !== null ? `m${s.muxValue} ` : s.isMultiplexor ? 'M ' : ''}
                    {signalLayout(s)}
                  </span>
                  <input
                    type="checkbox"
                    checked={plotted.has(s.name)}
                    onChange={() => onTogglePlot(s.name)}
                    aria-label={`Plot ${s.name}`}
                  />
                </label>
              </li>
            ))}
          </ul>
        ) : (
          <p className="hint">Not in the loaded DBC. Use Bit Activity to spot counters, checksums and signals.</p>
        )}
      </section>
    </>
  );
}
