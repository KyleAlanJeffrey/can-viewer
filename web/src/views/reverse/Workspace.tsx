import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { formatId, type ByteLane, type IdSummary, type MessageDef, type RawSignalSpec, type SeriesInfo } from '../../core/api';
import { formatCount } from '../../format';
import { signalBits } from '../../signalBits';
import { InspectorSlot } from '../slots';
import type { ViewContext } from '../types';
import { BitGrid, HeatLegend } from './BitGrid';
import { BitHistory } from './BitHistory';
import { ByteStrip } from './ByteStrip';
import { References, type Candidate } from './References';
import { SignalForm, initialForm, parseRange, parseScale, useCandidateForms, type AddedSignal, type FormState } from './SignalForm';
import { ChunkBoundary } from '../../components/ChunkBoundary';
import { KIND_LABELS, shownSuggestions, type ShownSuggestion } from './suggestionList';
import { WindowStrip } from './WindowStrip';
import {
  coveringRange,
  describeId,
  errorText,
  formatSeconds,
  layoutString,
  plainNumber,
  rangeBits,
  rectBits,
  useDebounced,
  windowStats,
  type BitRange,
  type ByteOrder,
  type TimeWindow,
  type Trace,
  type WindowStats,
} from './bits';
import { pinId, type Pin, type Reference } from './pins';
import type { Discovery } from './useDiscovery';
import { useFrameAt } from './useFrameAt';

/** Points per candidate view. Typical windows come back undecimated, so their changes count exactly. */
const VIEW_BUCKETS = 20000;
const LANES = 8;
const STRIP_BUCKETS = 80;
const BLANK_FORM = initialForm(null);
// Loaded on first use to keep the main bundle small.
const Suggestions = lazy(() => import('./Suggestions').then((m) => ({ default: m.Suggestions })));

interface Props {
  ctx: ViewContext;
  summary: IdSummary;
  message: MessageDef | null;
  window: TimeWindow;
  onWindowChange: (w: TimeWindow) => void;
  references: Reference[];
  cursor: number | null;
  onHover: (t: number | null) => void;
  onPark: (t: number) => void;
  onUnpin: (pin: Pin) => void;
  onPinSignal: () => void;
  /** A quiet stretch whose changing bits are dimmed, or null. */
  baseline: TimeWindow | null;
  discovery: Discovery;
  /** Messages no loaded DBC describes. */
  unknown: IdSummary[];
  pins: Pin[];
  onTogglePin: (pin: Pin) => void;
  /** The parked cursor, or null. */
  parked: number | null;
}

interface Activity {
  flips: Uint32Array;
  /** Frames the counts cover. */
  frames: number;
  seconds: number;
  /** The counts cover the whole log because the core can't count a window. */
  wholeLog: boolean;
}

interface CandidateView {
  key: string;
  x: Float64Array;
  y: Float64Array;
  stats: WindowStats;
}

/**
 * Advanced: one message's bit activity and history with the New Signal inspector. Mounted per
 * ID and log; its bit selection and form are kept per ID.
 */
export function Workspace(props: Props) {
  const { ctx, summary, message, window: win, onWindowChange, references, cursor, onHover, onPark, onUnpin, onPinSignal, baseline } = props;
  const { discovery, unknown, pins, onTogglePin, parked } = props;
  const { core, logVersion, log } = ctx;
  const duration = log?.durationS ?? 0;
  const bytes = summary.maxLen;
  const [forms, setForms] = useCandidateForms();
  const form = forms[summary.key] ?? BLANK_FORM;
  // The strip follows the pointer; the heavier queries wait for it to settle.
  const settled = useDebounced(win, 80);

  const [activity, setActivity] = useState<Activity | null>(null);
  const [activityError, setActivityError] = useState<string | null>(null);
  useEffect(() => {
    let stale = false;
    const [t0, t1] = settled;
    (async (): Promise<Activity> => {
      try {
        const [flips, frames] = await Promise.all([core.bitFlipsBetween(summary.key, t0, t1), core.rowCountBetween(summary.key, t0, t1)]);
        return { flips, frames, seconds: t1 - t0, wholeLog: false };
      } catch {
        return { flips: await core.bitFlips(summary.key), frames: summary.count, seconds: duration, wholeLog: true };
      }
    })().then(
      (a) => {
        if (stale) return;
        setActivity(a);
        setActivityError(null);
      },
      (e) => !stale && setActivityError(errorText(e)),
    );
    return () => {
      stale = true;
    };
  }, [core, summary, settled, duration, logVersion]);

  const [baselineCounts, setBaselineCounts] = useState<{ flips: Uint32Array; frames: number } | null>(null);
  const [b0, b1] = baseline ?? [0, 0];
  useEffect(() => {
    setBaselineCounts(null);
    if (b1 <= b0) return;
    let stale = false;
    Promise.all([core.bitFlipsBetween(summary.key, b0, b1), core.rowCountBetween(summary.key, b0, b1)]).then(
      ([flips, frames]) => !stale && setBaselineCounts({ flips, frames }),
      // Without window counts there is nothing to dim.
      () => {},
    );
    return () => {
      stale = true;
    };
  }, [core, summary, b0, b1, logVersion]);
  // With fewer than two frames nothing can change, so nothing would dim.
  const baselineFlips = baselineCounts && baselineCounts.frames >= 2 ? baselineCounts.flips : null;

  const { range, error: rangeError } = useMemo(
    () => parseRange(form.startBit, form.size, form.byteOrder, bytes),
    [form.startBit, form.size, form.byteOrder, bytes],
  );
  const selected = useMemo(() => (range ? rangeBits(range) : []), [range]);
  const scale = parseScale(form);
  const spec: RawSignalSpec | null = range && scale ? { ...range, signed: form.signed, ...scale } : null;
  const currentKey = spec ? JSON.stringify(spec) : '';
  const specKey = useDebounced(currentKey, 200);

  const [decoded, setDecoded] = useState<{ key: string; info: SeriesInfo } | null>(null);
  const [decodeError, setDecodeError] = useState<string | null>(null);
  useEffect(() => {
    setDecoded(null);
    setDecodeError(null);
    if (!specKey) return;
    let stale = false;
    let handle: number | null = null;
    core.decodeRaw(summary.key, JSON.parse(specKey) as RawSignalSpec).then(
      (info) => {
        if (stale) {
          core.dropSeries(info.handle);
          return;
        }
        handle = info.handle;
        setDecoded({ key: specKey, info });
      },
      (e) => !stale && setDecodeError(errorText(e)),
    );
    return () => {
      stale = true;
      if (handle !== null) core.dropSeries(handle);
    };
    // The ID's count grows during a live capture, which calls for decoding again.
  }, [core, summary.key, summary.count, specKey, logVersion]);

  const [view, setView] = useState<CandidateView | null>(null);
  useEffect(() => {
    if (!decoded) return;
    let stale = false;
    core.seriesView(decoded.info.handle, settled[0], settled[1], VIEW_BUCKETS).then(
      ([x, y]) => !stale && setView({ key: decoded.key, x, y, stats: windowStats(x, y, settled) }),
      // The series was replaced while this was in flight; the next view is on its way.
      () => {},
    );
    return () => {
      stale = true;
    };
  }, [core, decoded, settled]);

  const laneStart = selected.length > 0 ? Math.floor((Math.min(...selected) >> 3) / LANES) * LANES : 0;
  const laneCount = Math.max(0, Math.min(LANES, bytes - laneStart));
  const [lanes, setLanes] = useState<ByteLane[] | null>(null);
  const [lanesError, setLanesError] = useState<string | null>(null);
  useEffect(() => {
    setLanes(null);
    setLanesError(null);
    if (laneCount === 0) return;
    let stale = false;
    core.byteLanes(summary.key, laneStart, laneCount, settled[0], settled[1], STRIP_BUCKETS).then(
      (got) => !stale && setLanes(got),
      (e) => !stale && setLanesError(errorText(e)),
    );
    return () => {
      stale = true;
    };
  }, [core, summary.key, laneStart, laneCount, settled, logVersion]);
  const frame = useFrameAt(core, summary.key, cursor, logVersion);

  const owners = useMemo(() => {
    const owner = new Array<string | null>(bytes * 8).fill(null);
    for (const s of message?.signals ?? []) {
      for (const b of signalBits(s)) if (b >= 0 && b < owner.length && owner[b] === null) owner[b] = s.name;
    }
    return owner;
  }, [message, bytes]);

  const wholeBytes = useMemo(() => {
    const set = new Set(selected);
    const full = new Set<number>();
    for (const b of set) if (Array.from({ length: 8 }, (_, k) => set.has((b & ~7) + k)).every(Boolean)) full.add(b >> 3);
    return full;
  }, [selected]);

  const patch = (p: Partial<FormState>) => setForms((all) => ({ ...all, [summary.key]: { ...(all[summary.key] ?? BLANK_FORM), ...p } }));
  const setRange = (r: BitRange | null) => {
    if (r) patch({ startBit: String(r.startBit), size: String(r.size), fromGrid: true, limits: null });
  };
  const selectByte = (byte: number) => setRange(coveringRange(rectBits(byte * 8 + 7, byte * 8), form.byteOrder));
  const changeOrder = (order: ByteOrder) => {
    // Cells picked on the grid stay picked; typed numbers keep their DBC meaning in the new order.
    const kept = form.fromGrid && range ? coveringRange(selected, order) : null;
    patch({ byteOrder: order, limits: null, ...(kept && { startBit: String(kept.startBit), size: String(kept.size) }) });
  };

  const { ensure } = discovery;
  useEffect(() => ensure(summary.key), [ensure, summary.key]);
  const [activeSuggestion, setActiveSuggestion] = useState<string | null>(null);
  const [showDismissed, setShowDismissed] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  // Remounting the form after an undo drops its note of the add.
  const [formEpoch, setFormEpoch] = useState(0);
  const { results, dismissed, accepted } = discovery;
  // Held steady across renders so the grid redraws only when the suggestions change.
  const listed = useMemo(
    () => shownSuggestions({ results, dismissed, accepted }, summary.key, owners, true),
    [results, dismissed, accepted, summary.key, owners],
  );
  const shown = showDismissed ? listed : listed.filter((s) => !dismissed.has(s.id));
  const dismissedCount = listed.length - listed.filter((s) => !dismissed.has(s.id)).length;
  const regions = useMemo(
    () =>
      listed
        .filter((s) => !dismissed.has(s.id))
        .map((s) => ({ id: s.id, number: s.number, label: `Suggestion ${s.number}, ${KIND_LABELS[s.suggestion.kind]}`, bits: s.bits })),
    [listed, dismissed],
  );
  const selectedSuggestion = range ? (shown.find((s) => sameBits(s.suggestion.spec, range))?.id ?? null) : null;
  const plotPin = (s: ShownSuggestion): Pin => ({
    kind: 'range',
    key: summary.key,
    spec: s.suggestion.spec,
    label: `Suggested ${KIND_LABELS[s.suggestion.kind].toLowerCase()}`,
    unit: s.suggestion.fit?.unit ?? '',
  });
  const pinned = new Set(pins.map(pinId));
  const plotted = new Set(shown.filter((s) => pinned.has(pinId(plotPin(s)))).map((s) => s.id));

  const selectSuggestion = (s: ShownSuggestion, extra: Partial<FormState> = {}) => {
    const { spec, fit } = s.suggestion;
    patch({
      startBit: String(spec.startBit),
      size: String(spec.size),
      byteOrder: spec.byteOrder,
      signed: spec.signed,
      fromGrid: false,
      limits: null,
      ...(fit && { factor: plainNumber(spec.factor), offset: plainNumber(spec.offset), unit: fit.unit }),
      ...extra,
    });
  };
  const acceptSuggestion = (s: ShownSuggestion, name: string) => {
    selectSuggestion(s, { name });
    requestAnimationFrame(() => {
      nameRef.current?.focus();
      nameRef.current?.select();
    });
  };
  // Whatever way its bits got into the form, a suggestion added to a DBC counts as accepted.
  const onAdded = (added: AddedSignal) => {
    const match = shown.find((s) => sameBits(s.suggestion.spec, added.signal));
    if (!match) return;
    const { dbc, messageId, createdMessage, createdDbc } = added;
    discovery.markAccepted(match.id, { signal: added.signal.name, dbc, messageId, createdMessage, createdDbc });
  };

  const windowFrames = activity && !activity.wholeLog ? activity.frames : (summary.count * (settled[1] - settled[0])) / Math.max(duration, 1e-9);
  const layout = range ? layoutString(range, form.signed) : null;
  const matching = <T extends { key: string }>(x: T | null) => (x && x.key === currentKey ? x : null);
  const trace: Trace | null = matching(view);

  // The candidate overlays the first pinned signal in its unit, when asked to; otherwise it gets a row of its own.
  const unit = form.unit.trim();
  const overlayTarget = unit ? (references.find((r) => r.pin.kind === 'signal' && r.unit.trim().toLowerCase() === unit.toLowerCase()) ?? null) : null;
  const candidate: Candidate | null = range
    ? { name: form.name.trim() || `Candidate ${layout}`, unit, trace, overlayOn: form.overlay && overlayTarget ? overlayTarget.id : null }
    : null;

  return (
    <>
      <div className="content-scroll re-scroll">
        <div className="re-message-head">
          <h2 className="content-title re-title">
            <span className="mono">{formatId(summary.id, summary.extended)}</span>
            {message ? <span>{message.name}</span> : <span className="status unknown">Unknown</span>}
          </h2>
          <p className="content-sub">{describeId(log?.channels ?? [], summary, true)}</p>
        </div>

        <References
          core={core}
          references={references}
          window={settled}
          cursor={cursor}
          candidate={candidate}
          onHover={onHover}
          onPark={onPark}
          onUnpin={onUnpin}
          onPinSignal={onPinSignal}
        />

        <section className="card re-card" aria-labelledby="re-bytes-title">
          <div className="re-card-head">
            <h3 className="section-title" id="re-bytes-title">
              Byte values
            </h3>
            <span className="re-card-note">
              {bytes > LANES ? `Bytes ${laneStart} to ${laneStart + laneCount - 1} \u00b7 ` : ''}
              selected time range {'\u00b7'} raw values 0 to 255 {'\u00b7'} click one to select its bits
            </span>
          </div>
          {bytes === 0 ? (
            <p className="hint">These frames carry no payload.</p>
          ) : lanesError ? (
            <p className="re-quiet">Byte values: {lanesError}</p>
          ) : (
            <ByteStrip
              lanes={lanes}
              firstByte={laneStart}
              count={laneCount}
              window={settled}
              cursor={cursor}
              frame={frame}
              selectedBytes={wholeBytes}
              onSelectByte={selectByte}
              onHover={onHover}
              onPark={onPark}
            />
          )}
        </section>

        <div className="re-pair">
          <section className="card re-card" aria-labelledby="re-activity-title">
            <div className="re-card-head">
              <h3 className="section-title" id="re-activity-title">
                Bit Activity
              </h3>
              <span className="re-card-note">
                {activity && (activity.wholeLog ? 'Whole log; window counts are not available yet' : `${formatCount(activity.frames)} ${activity.frames === 1 ? 'frame' : 'frames'} in the window`)}
              </span>
            </div>
            {bytes === 0 ? (
              <p className="hint">These frames carry no payload.</p>
            ) : activity ? (
              <>
                <BitGrid
                  flips={activity.flips}
                  bytes={bytes}
                  transitions={Math.max(1, activity.frames - 1)}
                  seconds={activity.seconds}
                  selected={selected}
                  owners={owners}
                  dimmed={baselineFlips}
                  onSelect={(a, b) => setRange(coveringRange(rectBits(a, b), form.byteOrder))}
                  onClear={() => patch({ startBit: '', size: '', fromGrid: true, limits: null })}
                  regions={regions}
                  activeRegion={activeSuggestion}
                  onRegionHover={setActiveSuggestion}
                  onRegionActivate={(id) => {
                    const s = shown.find((x) => x.id === id);
                    if (s) selectSuggestion(s);
                  }}
                />
                <HeatLegend
                  baseline={baselineFlips ? `${formatSeconds(b0)} to ${formatSeconds(b1)}` : null}
                  baselineNote={baselineCounts && !baselineFlips ? 'Too few frames in the baseline to compare' : null}
                  selection={range ? `${range.size} ${range.size === 1 ? 'bit' : 'bits'} selected \u00b7 ${layout}` : null}
                />
              </>
            ) : (
              <p className={activityError ? 're-quiet' : 'hint'}>{activityError ?? 'Counting bit changes\u2026'}</p>
            )}
            <div className="re-subhead">
              <WindowStrip compact core={core} idKey={summary.key} logVersion={logVersion} duration={duration} window={win} onChange={onWindowChange} />
            </div>
          </section>

          <ChunkBoundary message="Couldn't load the suggestions.">
            <Suspense fallback={<p className="hint re-sug-loading">Loading suggestions&hellip;</p>}>
              <Suggestions
                ctx={ctx}
                summary={summary}
                discovery={discovery}
                unknown={unknown}
                shown={shown}
                dismissedCount={dismissedCount}
                showDismissed={showDismissed}
                onShowDismissed={setShowDismissed}
                active={activeSuggestion}
                onActive={setActiveSuggestion}
                selected={selectedSuggestion}
                onSelect={(s) => selectSuggestion(s)}
                message={message}
                onAccept={acceptSuggestion}
                onUndone={() => setFormEpoch((n) => n + 1)}
                plotted={plotted}
                onPlot={(s) => onTogglePin(plotPin(s))}
                parked={parked}
              />
            </Suspense>
          </ChunkBoundary>
        </div>

        <section className="card re-card" aria-labelledby="re-history-title">
          <div className="re-card-head">
            <h3 className="section-title" id="re-history-title">
              Bit History
            </h3>
            <span className="re-card-note">Newest frame on the right</span>
          </div>
          <BitHistory core={core} summary={summary} duration={duration} window={settled} logVersion={logVersion} selected={selected} />
        </section>
      </div>

      <InspectorSlot>
        <SignalForm
          key={formEpoch}
          ctx={ctx}
          summary={summary}
          form={form}
          onChange={patch}
          onByteOrder={changeOrder}
          range={range}
          rangeError={rangeError}
          decoded={matching(decoded)?.info ?? null}
          stats={matching(view)?.stats ?? null}
          statsExact={windowFrames + 2 <= 2 * VIEW_BUCKETS}
          decodeError={decodeError}
          window={settled}
          cursor={cursor}
          trace={trace}
          overlayTarget={overlayTarget?.name ?? null}
          nameRef={nameRef}
          onAdded={onAdded}
        />
      </InspectorSlot>
    </>
  );
}

function sameBits(a: BitRange, b: BitRange): boolean {
  return a.startBit === b.startBit && a.size === b.size && a.byteOrder === b.byteOrder;
}
