import { useEffect, useRef, useState } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { cssVar, useFontsReady } from '../../format';
import { formatSeconds, formatValue, type TimeWindow } from './bits';

const PLOT_H = 120;
const AXIS_H = 26;

interface Props {
  x: Float64Array;
  y: Float64Array;
  window: TimeWindow;
  unit: string;
  /** Names the plot for assistive technology. */
  label: string;
}

/** The candidate decoded across the window: one thin line, Y labels on the right, a dot only at the cursor. */
export function CandidatePlot({ x, y, window: win, unit, label }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const windowRef = useRef(win);
  windowRef.current = win;
  const [cursor, setCursor] = useState<{ t: number; v: number } | null>(null);
  const fontsReady = useFontsReady();

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const font = `400 11px ${cssVar('--font-ui')}`;
    const grid = { stroke: cssVar('--gridline'), width: 1 };
    const series = cssVar('--series-1');
    const u = new uPlot(
      {
        width: Math.max(1, host.clientWidth),
        height: PLOT_H + AXIS_H,
        legend: { show: false },
        padding: [6, 0, 0, 14],
        scales: { x: { time: false, range: () => windowRef.current } },
        series: [{}, { stroke: series, width: 1.5, points: { show: false } }],
        axes: [
          {
            stroke: cssVar('--slate'),
            font,
            grid,
            ticks: { show: false },
            size: AXIS_H,
            values: (_, ticks, _axis, _space, step) => ticks.map((t) => formatTick(t, step)),
          },
          { side: 1, stroke: cssVar('--slate'), font, grid, ticks: { show: false }, size: 56, space: 24 },
        ],
        cursor: {
          drag: { x: false, y: false, setScale: false },
          points: { size: 7, width: 2, fill: series, stroke: cssVar('--paper') },
        },
        hooks: {
          setCursor: [
            (self) => {
              const i = self.cursor.idx;
              const t = i == null ? null : self.data[0][i];
              const v = i == null ? null : self.data[1][i];
              setCursor(t == null || v == null || (self.cursor.left ?? -1) < 0 ? null : { t, v });
            },
          ],
        },
      },
      [new Float64Array(0), new Float64Array(0)],
      host,
    );
    plotRef.current = u;
    const ro = new ResizeObserver(([entry]) => {
      const w = Math.floor(entry.contentRect.width);
      if (w > 0 && w !== u.width) u.setSize({ width: w, height: PLOT_H + AXIS_H });
    });
    ro.observe(host);
    return () => {
      ro.disconnect();
      u.destroy();
      plotRef.current = null;
    };
  }, [fontsReady]);

  useEffect(() => {
    plotRef.current?.setData([x, y]);
  }, [x, y, fontsReady]);

  useEffect(() => {
    plotRef.current?.setScale('x', { min: win[0], max: win[1] });
  }, [win]);

  const lastInWindow = (() => {
    for (let i = x.length - 1; i >= 0; i--) if (x[i] <= win[1] && x[i] >= win[0]) return { t: x[i], v: y[i] };
    return null;
  })();
  const shown = cursor ?? lastInWindow;
  const suffix = unit ? ` ${unit}` : '';

  return (
    <div className="re-plot">
      <p className="re-plot-readout" aria-live="off">
        {shown ? (
          <>
            <span className="readout">
              {formatValue(shown.v)}
              {suffix}
            </span>
            <span className="re-plot-at mono">at {formatSeconds(shown.t)}</span>
          </>
        ) : (
          <span className="hint">No frames in this window</span>
        )}
      </p>
      <div className="re-plot-host" ref={hostRef} role="img" aria-label={label} />
    </div>
  );
}

/** Whole minutes while ticks are a minute or more apart; closer than that, seconds to the tick's precision. */
function formatTick(t: number, step: number): string {
  if (step >= 60) return `${Math.round(t / 60)} min`;
  // Steps run 1-2-2.5-5 per decade, so 2.5 or 0.25 needs one more place than the decade suggests.
  const decimals = (String(Number(step.toFixed(6))).split('.')[1] ?? '').length;
  return `${t.toFixed(decimals)} s`;
}
