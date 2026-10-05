import { useEffect, useMemo, useRef, useState } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import type { CoreApi, LogInfo } from '../../core/api';
import { cssVar, formatDuration, useFontsReady } from '../../format';

const BITRATE = 500_000;
const MAX_BUCKETS = 600;
/** Shorter buckets hold only a frame or two, so the line would jump between 0 and 100%. */
const MIN_BUCKET_S = 0.1;
const PLOT_H = 150;
const AXIS_H = 26;
const SERIES_SLOTS = 6;

// Minute-friendly steps, so a long log gets ticks at 5 min rather than every 200 s.
const TIME_INCRS = [
  0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200,
  10800, 21600, 43200, 86400,
];

type LoadState =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'ready'; x: Float64Array; loads: Float64Array[] };

interface Bus {
  name: string;
  color: string;
  load: Float64Array;
  mean: number;
  peak: number;
}

interface Props {
  core: CoreApi;
  log: LogInfo;
  logVersion: number;
}

/** Estimated load of each bus across the whole log, one thin line per bus. */
export function BusLoadCard({ core, log, logVersion }: Props) {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const { channels, durationS } = log;
  // A live capture redraws as it grows without going back to loading in between.
  const shownLog = useRef(logVersion);

  useEffect(() => {
    if (shownLog.current !== logVersion) {
      shownLog.current = logVersion;
      setState({ status: 'loading' });
    }
    if (durationS <= 0 || channels.length === 0) {
      setState({ status: 'ready', x: new Float64Array(0), loads: [] });
      return;
    }
    let stale = false;
    const buckets = Math.max(1, Math.min(MAX_BUCKETS, Math.floor(durationS / MIN_BUCKET_S)));
    Promise.all(channels.map((_, channel) => core.busLoad(channel, 0, durationS, buckets, BITRATE)))
      .then((results) => {
        if (!stale) setState({ status: 'ready', x: results[0][0], loads: results.map(([, load]) => load) });
      })
      .catch(() => {
        if (!stale) setState({ status: 'failed' });
      });
    return () => {
      stale = true;
    };
  }, [core, channels, durationS, logVersion]);

  const buses = useMemo<Bus[]>(() => {
    if (state.status !== 'ready') return [];
    return state.loads.map((load, i) => ({
      name: channels[i] ?? `Bus ${i}`,
      color: cssVar(`--series-${(i % SERIES_SLOTS) + 1}`),
      load,
      mean: load.length ? load.reduce((sum, v) => sum + v, 0) / load.length : 0,
      peak: load.length ? Math.max(...load) : 0,
    }));
  }, [state, channels]);

  const hasData = state.status === 'ready' && state.x.length > 0 && buses.length > 0;
  const summary = buses
    .map((b) => `${b.name}: average ${formatLoad(b.mean)}, peak ${formatLoad(b.peak)}`)
    .join('. ');

  return (
    <section className="ov-load card" aria-labelledby="ov-load-title">
      <div className="ov-card-head">
        <h2 id="ov-load-title" className="ov-card-title">
          Bus load
        </h2>
        <span className="ov-card-note">Estimated at 500 kbit/s, before bit stuffing</span>
        {hasData && (
          <ul className="ov-legend" aria-label="Average load per bus">
            {buses.map((b) => (
              <li key={b.name}>
                {buses.length > 1 && <span className="ov-key" style={{ background: b.color }} aria-hidden="true" />}
                <span className="mono">{b.name}</span>
                <span className="ov-legend-stat">avg {formatLoad(b.mean)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="ov-load-body" aria-busy={state.status === 'loading'}>
        {hasData ? (
          <LoadChart x={state.x} buses={buses} duration={durationS} label={`Estimated bus load over the log. ${summary}.`} />
        ) : (
          <p className="ov-load-message">
            {state.status === 'loading'
              ? 'Estimating bus load\u2026'
              : state.status === 'failed'
                ? "Bus load isn't available for this log yet."
                : 'Not enough of the log to estimate bus load.'}
          </p>
        )}
      </div>
    </section>
  );
}

interface Hover {
  idx: number;
  /** Cursor position within the chart host, in CSS px. */
  left: number;
}

function LoadChart({ x, buses, duration, label }: { x: Float64Array; buses: Bus[]; duration: number; label: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const [width, setWidth] = useState(0);
  const fontsReady = useFontsReady();

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const font = `400 11px ${cssVar('--font-ui')}`;
    const grid = { stroke: cssVar('--gridline'), width: 1 };
    const slate = cssVar('--slate');
    const u = new uPlot(
      {
        width: host.clientWidth,
        height: PLOT_H + AXIS_H,
        legend: { show: false },
        padding: [8, 0, 0, 14],
        scales: {
          x: { time: false, range: [0, duration] },
          y: { range: (_self, _min, max) => [0, yMax(max)] },
        },
        series: [{}, ...buses.map((b) => ({ label: b.name, stroke: b.color, width: 1.5, points: { show: false } }))],
        axes: [
          {
            stroke: slate,
            font,
            grid,
            ticks: { show: false },
            size: AXIS_H,
            space: 60,
            incrs: TIME_INCRS,
            values: (_self, ticks, _axis, _space, step) => ticks.map((t) => formatTimeTick(t, step)),
          },
          {
            side: 1,
            stroke: slate,
            font,
            grid,
            ticks: { show: false },
            size: 48,
            space: 28,
            values: (_self, ticks, _axis, _space, step) => ticks.map((t) => formatLoadTick(t, step)),
          },
        ],
        cursor: {
          drag: { x: false, y: false, setScale: false },
          points: { size: 7, width: 2, fill: (_self, i) => buses[i - 1]?.color ?? slate, stroke: cssVar('--paper') },
        },
        hooks: {
          setCursor: [
            (self) => {
              const { left, idx } = self.cursor;
              setHover(left != null && left >= 0 && idx != null ? { idx, left: self.over.offsetLeft + left } : null);
            },
          ],
        },
      },
      [x, ...buses.map((b) => b.load)],
      host,
    );

    const ro = new ResizeObserver(([entry]) => {
      const w = Math.floor(entry.contentRect.width);
      if (w > 0 && w !== u.width) u.setSize({ width: w, height: PLOT_H + AXIS_H });
      setWidth(w);
    });
    ro.observe(host);
    return () => {
      ro.disconnect();
      u.destroy();
      setHover(null);
    };
  }, [x, buses, duration, fontsReady]);

  const time = hover ? x[hover.idx] : undefined;
  return (
    <div className="ov-load-host" ref={hostRef} role="img" aria-label={label}>
      {hover && time !== undefined && (
        <div className={`ov-callout${hover.left > width * 0.66 ? ' flip' : ''}`} style={{ left: hover.left }} aria-hidden="true">
          <span className="ov-callout-time">{formatDuration(time)}</span>
          {buses.map((b) => (
            <span key={b.name} className="ov-callout-row">
              <span className="ov-key" style={{ background: b.color }} />
              <b>{formatLoad(b.load[hover.idx])}</b>
              <span className="mono">{b.name}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** Top of the load axis: the peak plus headroom, rounded up to 5%, with at least 10% shown. */
function yMax(peak: number | null): number {
  if (peak == null || !(peak > 0)) return 0.1;
  return Math.max(0.1, Math.ceil(peak * 1.15 * 20) / 20);
}

function formatLoad(fraction: number | undefined): string {
  return fraction === undefined || Number.isNaN(fraction) ? '\u2014' : `${(fraction * 100).toFixed(1)}%`;
}

function formatLoadTick(fraction: number, step: number): string {
  return `${(fraction * 100).toFixed(decimalsOf(step * 100))}%`;
}

function formatTimeTick(t: number, step: number): string {
  if (step >= 60) {
    const minutes = Math.round(t / 60);
    if (minutes < 60) return `${minutes} min`;
    const rest = minutes % 60;
    return rest ? `${Math.floor(minutes / 60)} h ${rest} min` : `${minutes / 60} h`;
  }
  return `${t.toFixed(decimalsOf(step))} s`;
}

/** Decimal places a tick step needs: 2.5 needs one and 0.25 needs two, beyond what the decade suggests. */
function decimalsOf(step: number): number {
  return (String(Number(step.toFixed(6))).split('.')[1] ?? '').length;
}
