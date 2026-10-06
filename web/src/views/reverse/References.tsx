import { useEffect, useState, type ReactNode } from 'react';
import { Pin as PinIcon, Plus, X } from 'lucide-react';
import type { CoreApi } from '../../core/api';
import { formatValue, lastIn, pointAt, type TimeWindow, type Trace } from './bits';
import type { Pin, Reference } from './pins';
import { ReferencePlot } from './ReferencePlot';

/** Zooming settles for this long before decimated data is fetched again. */
const REFETCH_DELAY_MS = 80;

/** The candidate being defined in Advanced, drawn with the references. */
export interface Candidate {
  name: string;
  unit: string;
  trace: Trace | null;
  /** The reference (by id) to draw it over, on that reference's scale; null gives it a row of its own. */
  overlayOn: string | null;
}

interface Props {
  core: CoreApi;
  references: Reference[];
  window: TimeWindow;
  cursor: number | null;
  candidate?: Candidate | null;
  onHover: (t: number | null) => void;
  onPark: (t: number) => void;
  onUnpin: (pin: Pin) => void;
  onPinSignal: () => void;
  /** Shown under the rows, such as the analysis window fields. */
  children?: ReactNode;
}

/** Pinned references on one time axis with separate value scales, and the shared cursor through all of them. */
export function References({ core, references, window: win, cursor, candidate, onHover, onPark, onUnpin, onPinSignal, children }: Props) {
  const ownRow = candidate && !candidate.overlayOn ? candidate : null;
  const rows = references.length + (ownRow ? 1 : 0);
  const unitOf = (unit: string) => (unit ? ` ${unit}` : '');

  return (
    <section className={`card re-card re-refs${rows === 0 ? ' collapsed' : ''}`} aria-label="Pinned references">
      <div className="re-card-head">
        <PinIcon size={16} strokeWidth={1.5} aria-hidden="true" className="re-refs-icon" />
        {/* With nothing pinned, the card shrinks to one row that says what it is for. */}
        <h3 className="section-title">{rows === 0 ? 'Pin a signal for comparison' : 'Pinned references'}</h3>
        {rows > 0 && <span className="re-card-note">Shared time {'\u00b7'} separate scales</span>}
        <button
          type="button"
          className="button re-refs-pin"
          onClick={onPinSignal}
          title={rows === 0 ? 'Compare a decoded signal or a raw byte with the bytes on the same timeline. Pins stay while you change messages.' : undefined}
        >
          <Plus size={16} strokeWidth={1.5} aria-hidden="true" />
          Pin signal&hellip;
        </button>
      </div>
      {rows > 0 && (
        <div className="re-ref-rows">
          {references.map((ref, i) => (
            <ReferenceRow
              key={ref.id}
              core={core}
              reference={ref}
              window={win}
              cursor={cursor}
              overlay={candidate?.overlayOn === ref.id ? candidate : null}
              first={i === 0}
              last={i === references.length - 1 && !ownRow}
              onHover={onHover}
              onPark={onPark}
              onUnpin={() => onUnpin(ref.pin)}
            />
          ))}
          {ownRow && (
            <div className="re-ref-row candidate">
              <div className="re-ref-meta">
                <span className="re-ref-swatch dashed" aria-hidden="true" />
                <span className="re-ref-name">{ownRow.name}</span>
                <span className="re-ref-sub">Candidate</span>
                <span className="re-ref-value readout">{readout(ownRow.trace, cursor, win, unitOf(ownRow.unit))}</span>
              </div>
              <ReferencePlot
                trace={ownRow.trace}
                color="var(--graphite)"
                dashed
                window={win}
                cursor={cursor}
                range={null}
                showTimeAxis
                showCursorTime={references.length === 0}
                label={`${ownRow.name}, the candidate, across the window`}
                onHover={onHover}
                onPark={onPark}
              />
              <div className="re-ref-actions" />
            </div>
          )}
        </div>
      )}
      {children}
    </section>
  );
}

interface RowProps {
  core: CoreApi;
  reference: Reference;
  window: TimeWindow;
  cursor: number | null;
  overlay: Candidate | null;
  first: boolean;
  last: boolean;
  onHover: (t: number | null) => void;
  onPark: (t: number) => void;
  onUnpin: () => void;
}

function ReferenceRow({ core, reference: ref, window: win, cursor, overlay, first, last, onHover, onPark, onUnpin }: RowProps) {
  const [width, setWidth] = useState(0);
  const [trace, setTrace] = useState<Trace | null>(null);
  const handle = ref.info?.handle ?? null;
  const [t0, t1] = win;

  useEffect(() => {
    if (handle === null || width === 0) return;
    let stale = false;
    const timer = window.setTimeout(() => {
      core.seriesView(handle, t0, t1, width).then(
        ([x, y]) => !stale && setTrace({ x, y }),
        () => !stale && setTrace(null),
      );
    }, REFETCH_DELAY_MS);
    return () => {
      stale = true;
      window.clearTimeout(timer);
    };
  }, [core, handle, t0, t1, width]);

  const unit = ref.unit ? ` ${ref.unit}` : '';
  const overlayValue = overlay ? readout(overlay.trace, cursor, win, overlay.unit ? ` ${overlay.unit}` : '') : null;
  return (
    <div className="re-ref-row">
      <div className="re-ref-meta">
        <span className="re-ref-swatch" style={{ background: ref.color }} aria-hidden="true" />
        <span className="re-ref-name" title={ref.name}>
          {ref.name}
        </span>
        <span className="re-ref-sub mono">{ref.source}</span>
        <span className="re-ref-value readout">{ref.error ? <span className="re-quiet">{ref.error}</span> : readout(trace, cursor, win, unit)}</span>
      </div>
      <div className="re-ref-plot-cell">
        <ReferencePlot
          trace={trace}
          color={ref.color}
          overlay={overlay?.trace ?? null}
          window={win}
          cursor={cursor}
          range={ref.range}
          showTimeAxis={last}
          showCursorTime={first}
          label={`${ref.name} from ${ref.source} across the window`}
          onHover={onHover}
          onPark={onPark}
          onWidth={setWidth}
        />
        {overlay && (
          <p className="re-overlay-legend">
            <span className="re-ref-swatch dashed" aria-hidden="true" />
            <span>{overlay.name}</span>
            <span className="re-overlay-value readout">{overlayValue}</span>
          </p>
        )}
      </div>
      <div className="re-ref-actions">
        <button type="button" className="icon-button small" onClick={onUnpin} aria-label={`Unpin ${ref.name}`}>
          <X size={14} strokeWidth={1.75} />
        </button>
      </div>
    </div>
  );
}

/** The value at the cursor, or the window's last value while there is no cursor. */
function readout(trace: Trace | null, cursor: number | null, win: TimeWindow, unit: string): string {
  if (!trace) return '\u2026';
  const p = cursor !== null ? pointAt(trace, cursor) : lastIn(trace, win);
  return p ? `${formatValue(p.v)}${unit}` : 'No values';
}
