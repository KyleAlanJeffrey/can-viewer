import { X } from 'lucide-react';
import type { PlotSpec } from '../../components/Plots';
import { formatDelta, formatSeconds, formatValue, type LaneSamples, type Marker } from './model';

const MISSING = '\u2014';

interface Props {
  plots: PlotSpec[];
  cursorA: number | null;
  /** Null in one-cursor mode. */
  cursorB: number | null;
  samples: Record<string, LaneSamples>;
  markers: Marker[];
  onRemoveMarker: (id: number) => void;
}

/** The cursor readout table, one column per signal, beside the marker list. */
export function Readouts({ plots, cursorA, cursorB, samples, markers, onRemoveMarker }: Props) {
  const two = cursorB !== null;
  const valueAt = (p: PlotSpec, which: 'a' | 'b') => {
    const s = samples[p.id]?.[which];
    return s ? formatValue(s.value) : MISSING;
  };
  const delta = (p: PlotSpec) => {
    const s = samples[p.id];
    return s?.a && s.b ? formatDelta(s.b.value - s.a.value) : MISSING;
  };

  return (
    <div className="pv-footer">
      <div className="pv-readout-wrap">
        <table className="pv-readout">
          <caption className="sr-only">Signal values at the cursors</caption>
          <thead>
            <tr>
              <th scope="col">
                <span className="sr-only">Cursor</span>
              </th>
              <th scope="col">Time</th>
              {plots.map((p) => (
                <th scope="col" key={p.id} title={p.label}>
                  <span className="pv-col">
                    <span className="pv-dot" style={{ background: p.color }} aria-hidden="true" />
                    <span className="pv-col-name">{p.info.name}</span>
                    {p.info.unit && <span className="pv-col-unit">{p.info.unit}</span>}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">A</th>
              <td className="pv-time">{cursorA === null ? MISSING : formatSeconds(cursorA)}</td>
              {plots.map((p) => (
                <td key={p.id}>{valueAt(p, 'a')}</td>
              ))}
            </tr>
            {two && (
              <tr>
                <th scope="row">B</th>
                <td className="pv-time">{formatSeconds(cursorB)}</td>
                {plots.map((p) => (
                  <td key={p.id}>{valueAt(p, 'b')}</td>
                ))}
              </tr>
            )}
            {two && (
              <tr className="pv-delta">
                <th scope="row">&Delta; B&minus;A</th>
                <td className="pv-time">{cursorA === null ? MISSING : formatSeconds(cursorB - cursorA)}</td>
                {plots.map((p) => (
                  <td key={p.id}>{delta(p)}</td>
                ))}
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <section className="pv-markers" aria-labelledby="pv-markers-title">
        <h2 id="pv-markers-title" className="pv-markers-title">
          Markers
        </h2>
        {markers.length === 0 ? (
          <p className="pv-markers-empty">Add Marker drops one at cursor A.</p>
        ) : (
          <ul>
            {markers.map((m) => (
              <li key={m.id} className="pv-marker">
                <span className="pv-marker-label">{m.label}</span>
                <span className="pv-marker-time">{formatSeconds(m.time)}</span>
                <button className="icon-button small" onClick={() => onRemoveMarker(m.id)} aria-label={`Remove marker ${m.label}`}>
                  <X size={14} strokeWidth={1.75} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
