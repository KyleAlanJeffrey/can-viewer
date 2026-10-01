import { formatDuration } from '../../format';
import { MIN_SPAN, type TimeWindow } from './bits';
import { TimeField } from './WindowStrip';

interface Props {
  window: TimeWindow;
  duration: number;
  onChange: (w: TimeWindow) => void;
}

/** The analysis window as two seconds fields; every plot and sparkline shows this stretch of the log. */
export function AnalysisWindow({ window: [t0, t1], duration, onChange }: Props) {
  const setStart = (t: number) => onChange([clamp(t, 0, Math.max(0, t1 - MIN_SPAN)), t1]);
  const setEnd = (t: number) => onChange([t0, clamp(t, Math.min(duration, t0 + MIN_SPAN), duration)]);
  return (
    <div className="re-awin" role="group" aria-label="Analysis window">
      <span className="re-awin-label">Analysis window</span>
      <TimeField label="Window start, seconds" value={t0} onCommit={setStart} />
      <span className="re-awin-dash" aria-hidden="true">
        to
      </span>
      <TimeField label="Window end, seconds" value={t1} onCommit={setEnd} />
      <span className="re-awin-full">Full log: {formatDuration(duration)}</span>
    </div>
  );
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
