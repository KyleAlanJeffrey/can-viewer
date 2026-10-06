import { useEffect, useMemo, useState } from 'react';
import { BitHeatmap } from '../../components/BitHeatmap';
import { formatId, type ByteComparison, type ByteLane, type CompareOptions, type IdComparison, type LogInfo } from '../../core/api';
import { cssVar } from '../../format';
import { ReferencePlot } from '../reverse/ReferencePlot';
import { errorText, formatSeconds, hexByte, useDebounced } from '../reverse/bits';
import { useFrameAt } from '../reverse/useFrameAt';
import '../reverse/reverse.css';
import type { ViewContext } from '../types';
import { SIGNIFICANT, bitList } from './findings';
import { onLogB } from './logBWork';
import { useFrameAtB } from './useFrameAtB';

interface Props {
  ctx: ViewContext;
  comparison: IdComparison;
  logA: LogInfo;
  logB: LogInfo;
  options: CompareOptions;
  onOpenInReverse: (byte: number) => void;
  onExport: () => void;
}

const NO_SIGNALS: never[] = [];

/**
 * One ID in both logs: bit activity side by side with the differing bits outlined, the selected
 * byte's values over time in A and B, and every byte's value in each log at the cursor.
 */
export function ByteCompare({ ctx, comparison: c, logA, logB, options, onOpenInReverse, onExport }: Props) {
  const { core, logVersion, pinnedTime, setPinnedTime } = ctx;
  const [detail, setDetail] = useState<ByteComparison | null>(null);
  const [byte, setByte] = useState(() => c.bytes[0] ?? 0);
  const [lanes, setLanes] = useState<{ a: ByteLane | null; b: ByteLane | null } | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [width, setWidth] = useState(400);
  const buckets = useDebounced(Math.max(50, Math.round(width)), 150);
  const span = Math.max(logA.durationS, logB.durationS, 0.05);

  useEffect(() => {
    let live = true;
    setDetail(null);
    onLogB(core, core.compareBytes(c.keyA, c.keyB, options)).then(
      (d) => live && setDetail(d),
      (e) => live && ctx.setError(errorText(e)),
    );
    return () => {
      live = false;
    };
    // ctx.setError is stable; the logs change with logVersion and logB.
  }, [core, c.keyA, c.keyB, options, logVersion, logB]);

  useEffect(() => {
    let live = true;
    const none = Promise.resolve<ByteLane[]>([]);
    Promise.all([
      c.keyA === null ? none : core.byteLanes(c.keyA, byte, 1, 0, span, buckets),
      c.keyB === null ? none : core.compareByteLanes(c.keyB, byte, 1, 0, span, buckets),
    ]).then(
      ([a, b]) => live && setLanes({ a: a[0] ?? null, b: b[0] ?? null }),
      () => live && setLanes(null),
    );
    return () => {
      live = false;
    };
  }, [core, c.keyA, c.keyB, byte, span, buckets, logVersion, logB]);

  const cursor = hover ?? pinnedTime;
  const frameA = useFrameAt(core, c.keyA, cursor ?? logA.durationS, logVersion);
  const frameB = useFrameAtB(core, c.keyB, cursor ?? logB.durationS, logB);

  const len = detail?.len ?? 0;
  const changed = (k: number) => (detail?.byteScores[k] ?? 0) >= SIGNIFICANT;
  const marked = useMemo(() => {
    const bits = new Set<number>();
    detail?.bitScores.forEach((score, bit) => {
      if (Math.round(score * 100) >= SIGNIFICANT && detail.byteScores[bit >> 3] >= SIGNIFICANT) bits.add(bit);
    });
    return bits;
  }, [detail]);

  const findings = detail
    ? Array.from({ length: len }, (_, k) => k)
        .filter(changed)
        .sort((x, y) => detail.byteScores[y] - detail.byteScores[x] || x - y)
    : [];
  const title = formatId(c.id, c.extended);
  const both = c.presence === 'both';

  return (
    <section className="cmp-detail card" aria-labelledby="cmp-detail-title">
      <header className="cmp-detail-head">
        <h2 id="cmp-detail-title" className="pane-title">
          <span className="mono">{title}</span>
          {c.name ?? 'Unknown'}
        </h2>
        <p className="cmp-sub">
          {c.bus} &middot; {c.score}% &middot; {c.reason}
        </p>
      </header>

      <div className="cmp-section">
        <h3 className="section-title">Byte comparison</h3>
        <div className="cmp-grids">
          <Grid letter="A" log={logA} flips={detail?.flipsA} pairs={detail?.pairsA} payloads={detail?.payloadsA ?? 0} len={len} marked={marked} present={c.keyA !== null} />
          <Grid letter="B" log={logB} flips={detail?.flipsB} pairs={detail?.pairsB} payloads={detail?.payloadsB ?? 0} len={len} marked={marked} present={c.keyB !== null} />
        </div>
        {detail && both && (
          <ul className="cmp-findings">
            {findings.length === 0 && <li>No byte differs{options.ignoreCounters || options.ignoreChangesWithinA ? ' under the current ignore rules' : ''}.</li>}
            {findings.map((k) => {
              const bits = [];
              for (let bit = 0; bit < 8; bit++) if (marked.has(k * 8 + bit)) bits.push(bit);
              const values = detail.newValues[k];
              return (
                <li key={k}>
                  <b>Byte {k}</b> &middot; {detail.byteScores[k]}% &middot; {detail.byteReasons[k]}
                  {values.length > 0 && (
                    <>
                      {' '}
                      (B shows <span className="mono">{values.map(hexByte).join(' ')}</span>)
                    </>
                  )}
                  {bits.length > 0 && <>. {bits.length === 1 ? `Bit ${bits[0]} differs` : `Bits ${bitList(bits)} differ`}</>}
                </li>
              );
            })}
            {detail.ignored.map((i) => (
              <li key={`${i.byte}:${i.kind}`} className="cmp-ignored">
                Ignored as a {i.kind}: byte {i.byte}
                {i.mask === 0xff ? '' : `, bits ${bitList([0, 1, 2, 3, 4, 5, 6, 7].filter((b) => (i.mask >> b) & 1))}`}
              </li>
            ))}
          </ul>
        )}
      </div>

      {len > 0 && (
        <div className="cmp-section">
          <h3 className="section-title">Byte {byte} over time</h3>
          <div className="cmp-chart">
            <ReferencePlot
              trace={lanes?.b ?? null}
              color={cssVar('--series-1')}
              overlay={lanes?.a ?? null}
              window={[0, span]}
              cursor={cursor}
              range={null}
              showTimeAxis
              showCursorTime
              label={`Byte ${byte} of ${title} over time: log B solid, log A dashed`}
              onHover={setHover}
              onPark={(t) => setPinnedTime(Math.max(0, Math.min(span, t)))}
              onWidth={setWidth}
            />
          </div>
          <p className="cmp-legend">
            <span className="cmp-swatch solid" aria-hidden="true" />B &middot; {logB.name}
            <span className="cmp-swatch dashed" aria-hidden="true" />A &middot; {logA.name}
            <span className="cmp-legend-note">Seconds from the start of each log. Click to park the cursor; Escape clears it.</span>
          </p>
        </div>
      )}

      {len > 0 && (
        <div className="cmp-section">
          <h3 className="section-title">{cursor === null ? 'Byte values at the end of each log' : `Byte values at ${formatSeconds(cursor)}`}</h3>
          <div className="cmp-bytes" role="group" aria-label="Bytes; choose one to plot it">
            {Array.from({ length: len }, (_, k) => {
              const a = frameA && k < frameA.data.length ? hexByte(frameA.data[k]) : null;
              const b = frameB && k < frameB.length ? hexByte(frameB[k]) : null;
              return (
                <button
                  key={k}
                  type="button"
                  className={`cmp-byte${changed(k) ? ' changed' : ''}`}
                  aria-pressed={byte === k}
                  onClick={() => setByte(k)}
                >
                  <span className="cmp-byte-label">Byte {k}</span>
                  <span className="cmp-byte-value">
                    A <span className="mono">{a ?? '\u2014'}</span>
                  </span>
                  <span className={`cmp-byte-value${a !== null && b !== null && a !== b ? ' differs' : ''}`}>
                    B <span className="mono">{b ?? '\u2014'}</span>
                    {a !== null && b !== null && a !== b && <span className="sr-only"> (differs)</span>}
                  </span>
                  {changed(k) && <span className="cmp-byte-flag">Changed</span>}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <footer className="cmp-actions">
        {c.keyA === null && <p className="hint">Only in log B: swap the logs to open it in Reverse Engineer.</p>}
        <button type="button" className="button" onClick={onExport}>
          Export findings&hellip;
        </button>
        <button type="button" className="primary" onClick={() => onOpenInReverse(byte)} disabled={c.keyA === null}>
          Open in Reverse Engineer
        </button>
      </footer>
    </section>
  );
}

interface GridProps {
  letter: 'A' | 'B';
  log: LogInfo;
  flips: number[] | undefined;
  /** Per byte, the pairs of frames `flips` were counted over. */
  pairs: number[] | undefined;
  /** Frames that carry a payload, the frames `flips` pairs up. */
  payloads: number;
  len: number;
  marked: ReadonlySet<number>;
  present: boolean;
}

function Grid({ letter, log, flips, pairs, payloads, len, marked, present }: GridProps) {
  const counts = useMemo(() => Uint32Array.from(flips ?? []), [flips]);
  return (
    <div className="cmp-grid">
      <p className="cmp-grid-title" title={log.name}>
        {letter} &middot; {log.name}
      </p>
      {!present ? (
        <p className="hint cmp-grid-empty">Not in log {letter}.</p>
      ) : flips && (len === 0 || payloads === 0) ? (
        <p className="hint cmp-grid-empty">No payload bytes in log {letter}.</p>
      ) : flips ? (
        <BitHeatmap
          flips={counts}
          pairs={pairs ?? []}
          bytes={len}
          signals={NO_SIGNALS}
          colors={NO_SIGNALS}
          highlight={null}
          marked={marked}
          markedLabel="Differs between the logs"
          label={`Bit activity in log ${letter}, ${log.name}. Outlined bits differ between the logs.`}
        />
      ) : (
        <p className="hint cmp-grid-empty">Loading&hellip;</p>
      )}
    </div>
  );
}
