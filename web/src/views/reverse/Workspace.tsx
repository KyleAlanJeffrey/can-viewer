import { useEffect, useMemo, useState } from 'react';
import type { IdSummary, MessageDef, RawSignalSpec, SeriesInfo } from '../../core/api';
import { formatCount } from '../../format';
import { signalBits } from '../../signalBits';
import { InspectorSlot } from '../slots';
import type { ViewContext } from '../types';
import { BitGrid, HeatLegend } from './BitGrid';
import { BitHistory } from './BitHistory';
import { ByteLanes } from './ByteLanes';
import { CandidatePlot } from './CandidatePlot';
import { SignalForm, initialForm, parseRange, parseScale, useCandidateForms, type FormState } from './SignalForm';
import { WindowStrip } from './WindowStrip';
import {
  coveringRange,
  errorText,
  layoutString,
  rangeBits,
  rectBits,
  rowIndexAt,
  useDebounced,
  windowStats,
  type BitRange,
  type ByteOrder,
  type TimeWindow,
  type WindowStats,
} from './bits';

/** Points per candidate view. Typical windows come back undecimated, so their changes count exactly. */
const VIEW_BUCKETS = 20000;
const LANES = 8;
const BLANK_FORM = initialForm(null);

interface Props {
  ctx: ViewContext;
  summary: IdSummary;
  message: MessageDef | null;
  window: TimeWindow;
  onWindowChange: (w: TimeWindow) => void;
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

/** One ID's reverse-engineering workspace. Mounted per ID and log; its bit selection and form are kept per ID. */
export function Workspace({ ctx, summary, message, window: win, onWindowChange }: Props) {
  const { core, logVersion } = ctx;
  const duration = ctx.log?.durationS ?? 0;
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
        const flips = await core.bitFlipsBetween(summary.key, t0, t1);
        const [i0, i1] = await Promise.all([rowIndexAt(core, summary, t0, duration), rowIndexAt(core, summary, t1, duration)]);
        return { flips, frames: Math.max(1, i1 - i0), seconds: t1 - t0, wholeLog: false };
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
  }, [core, summary.key, specKey, logVersion]);

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

  const laneStart = selected.length > 0 ? Math.floor(Math.min(...selected) / 64) * LANES : 0;
  const laneCount = Math.max(0, Math.min(LANES, bytes - laneStart));
  const [lanes, setLanes] = useState<SeriesInfo[] | null>(null);
  const [lanesError, setLanesError] = useState<string | null>(null);
  useEffect(() => {
    setLanes(null);
    setLanesError(null);
    if (laneCount === 0) return;
    let stale = false;
    const held: number[] = [];
    (async () => {
      const infos: SeriesInfo[] = [];
      for (let k = 0; k < laneCount; k++) {
        const lane = { startBit: (laneStart + k) * 8, size: 8, byteOrder: 'intel', signed: false, factor: 1, offset: 0 } as const;
        const info = await core.decodeRaw(summary.key, lane);
        if (stale) {
          core.dropSeries(info.handle);
          return null;
        }
        held.push(info.handle);
        infos.push(info);
      }
      return infos;
    })().then(
      (infos) => !stale && infos && setLanes(infos),
      (e) => !stale && setLanesError(errorText(e)),
    );
    return () => {
      stale = true;
      held.forEach((h) => core.dropSeries(h));
    };
  }, [core, summary.key, laneStart, laneCount, logVersion]);

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

  const windowFrames = activity && !activity.wholeLog ? activity.frames : (summary.count * (settled[1] - settled[0])) / Math.max(duration, 1e-9);
  const layout = range ? layoutString(range, form.signed) : null;
  const matching = <T extends { key: string }>(x: T | null) => (x && x.key === currentKey ? x : null);

  return (
    <>
      <div className="content-scroll re-scroll">
        <section className="card re-card" aria-label="Time window">
          <WindowStrip core={core} idKey={summary.key} logVersion={logVersion} duration={duration} window={win} onChange={onWindowChange} />
        </section>

        <section className="card re-card" aria-labelledby="re-activity-title">
          <div className="re-card-head">
            <h3 className="section-title" id="re-activity-title">
              Bit Activity
            </h3>
            <span className="re-card-note">
              {activity && (activity.wholeLog ? 'Whole log; window counts are not available yet' : `${formatCount(activity.frames)} frames in the window`)}
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
                onSelect={(a, b) => setRange(coveringRange(rectBits(a, b), form.byteOrder))}
                onClear={() => patch({ startBit: '', size: '', fromGrid: true, limits: null })}
              />
              <HeatLegend selection={range ? `${range.size} ${range.size === 1 ? 'bit' : 'bits'} selected \u00b7 ${layout}` : null} />
            </>
          ) : (
            <p className={activityError ? 're-quiet' : 'hint'}>{activityError ?? 'Counting bit changes\u2026'}</p>
          )}
        </section>

        <section className="card re-card" aria-labelledby="re-history-title">
          <div className="re-card-head">
            <h3 className="section-title" id="re-history-title">
              Bit History
            </h3>
            <span className="re-card-note">Newest frame on the right</span>
          </div>
          <BitHistory core={core} summary={summary} duration={duration} window={settled} logVersion={logVersion} selected={selected} />
        </section>

        <section className="card re-card" aria-labelledby="re-candidate-title">
          <div className="re-card-head">
            <h3 className="section-title" id="re-candidate-title">
              Candidate
            </h3>
            <span className="re-card-note mono">{layout}</span>
          </div>
          {!range ? (
            <p className="hint re-plot-empty">Select bits in the grid to decode them across the window.</p>
          ) : decodeError ? (
            <p className="re-quiet re-plot-empty">Decoding: {decodeError}</p>
          ) : view ? (
            <CandidatePlot
              x={view.x}
              y={view.y}
              window={settled}
              unit={form.unit.trim()}
              label={`Candidate ${layout} decoded from ${settled[0].toFixed(1)} to ${settled[1].toFixed(1)} seconds`}
            />
          ) : (
            <p className="hint re-plot-empty">Decoding&hellip;</p>
          )}

          <div className="re-card-head re-subhead">
            <h4 className="re-subtitle">Byte Values</h4>
            <span className="re-card-note">
              {bytes > LANES ? `Bytes ${laneStart} to ${laneStart + laneCount - 1}, ` : ''}0 to 255; click one to select it
            </span>
          </div>
          {lanesError ? (
            <p className="re-quiet">Byte values: {lanesError}</p>
          ) : lanes ? (
            <ByteLanes core={core} lanes={lanes} firstByte={laneStart} window={settled} selectedBytes={wholeBytes} onSelectByte={selectByte} />
          ) : (
            bytes > 0 && <p className="hint">Decoding bytes&hellip;</p>
          )}
        </section>
      </div>

      <InspectorSlot>
        <SignalForm
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
        />
      </InspectorSlot>
    </>
  );
}
