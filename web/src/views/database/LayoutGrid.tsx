import { useMemo, useState, type CSSProperties } from 'react';
import { AlertTriangle } from 'lucide-react';
import type { MessageDef, SignalDef } from '../../core/api';
import { Segmented } from '../../components/Segmented';
import { signalBits } from '../../signalBits';
import { seriesTint } from '../shared/colors';
import { canShareBits, messageIdText, segmentsOf } from './dbcModel';

interface Props {
  message: MessageDef;
  /** Series colour per signal, same order as the message's signals. */
  colors: string[];
  selected: number | null;
  onSelect: (index: number) => void;
}

const COLUMNS = [0, 1, 2, 3, 4, 5, 6, 7];

/**
 * The payload as a byte-by-bit grid, MSB on the left, with each signal a tinted region outlined
 * in its series colour. Multiplexed messages show one page at a time.
 */
export function LayoutGrid({ message, colors, selected, onSelect }: Props) {
  const bytes = message.size;
  const muxValues = useMemo(
    () => [...new Set(message.signals.map((s) => s.muxValue).filter((v): v is number => v !== null))].sort((a, b) => a - b),
    [message],
  );
  const selectedMux = selected !== null ? (message.signals[selected]?.muxValue ?? null) : null;
  const [page, setPage] = useState<number | null>(selectedMux);
  const [followedMux, setFollowedMux] = useState(selectedMux);
  if (selectedMux !== followedMux) {
    setFollowedMux(selectedMux);
    if (selectedMux !== null) setPage(selectedMux);
  }
  const shownPage = page !== null && muxValues.includes(page) ? page : (muxValues[0] ?? null);

  const shown = useMemo(
    () =>
      message.signals
        .map((signal, index) => ({ signal, index, bits: signalBits(signal) }))
        .filter(({ signal }) => signal.muxValue === null || signal.muxValue === shownPage),
    [message, shownPage],
  );

  const clashes = useMemo(() => {
    const found: { a: SignalDef; b: SignalDef; bits: number[] }[] = [];
    shown.forEach((x, i) => {
      for (const y of shown.slice(i + 1)) {
        if (canShareBits(x.signal, y.signal)) continue;
        const bits = x.bits.filter((bit) => y.bits.includes(bit));
        if (bits.length > 0) found.push({ a: x.signal, b: y.signal, bits });
      }
    });
    return found;
  }, [shown]);

  const clashBits = [...new Set(clashes.flatMap((c) => c.bits))].filter((bit) => bit < bytes * 8);
  const clashPartners = (s: SignalDef) => clashes.flatMap((c) => (c.a === s ? [c.b.name] : c.b === s ? [c.a.name] : []));
  const notes = [
    ...clashes.map(({ a, b, bits }) => `${a.name} and ${b.name} share ${bits.length} ${bits.length === 1 ? 'bit' : 'bits'}.`),
    ...shown.filter(({ bits }) => bits.some((bit) => bit >= bytes * 8)).map(({ signal }) => `${signal.name} runs past the message's ${bytes} bytes.`),
  ];

  return (
    <section className="card db-card" aria-labelledby="db-layout-title">
      <div className="db-card-head">
        <h3 className="section-title" id="db-layout-title">
          Message layout{' '}
          <span className="db-title-sub">
            <span className="mono">{messageIdText(message)}</span> &middot; {bytes} {bytes === 1 ? 'byte' : 'bytes'}
          </span>
        </h3>
        {shown.length > 0 && (
          <ul className="db-legend" aria-label="Legend">
            {shown.map(({ signal, index }) => (
              <li key={index}>
                <span className="db-dot" style={{ background: colors[index] }} />
                {signal.name}
              </li>
            ))}
          </ul>
        )}
      </div>

      {muxValues.length > 0 && shownPage !== null && (
        <div className="db-mux-pages">
          <span className="field-label" aria-hidden="true">
            Multiplexed page
          </span>
          <Segmented
            label="Multiplexed page"
            className="small"
            options={muxValues.map((v) => ({ value: String(v), label: `m${v}` }))}
            value={String(shownPage)}
            onChange={(v) => setPage(Number(v))}
          />
        </div>
      )}

      {bytes === 0 ? (
        <p className="hint">This message has no data bytes.</p>
      ) : (
        <div className={`db-grid${bytes > 8 ? ' db-grid-dense' : ''}`} role="group" aria-label={`Bit layout of ${message.name}`}>
          <span className="db-grid-corner" aria-hidden="true">
            Bit
          </span>
          {COLUMNS.map((col) => (
            <span key={`h${col}`} className="db-grid-colhead" style={{ gridColumn: col + 2 }} aria-hidden="true">
              {7 - col}
            </span>
          ))}
          {Array.from({ length: bytes }, (_, byte) => (
            <GridRow key={byte} byte={byte} />
          ))}

          {shown.map(({ signal, index, bits }) => {
            const segments = segmentsOf(bits, bytes);
            if (segments.length === 0) return null;
            const largest = segments.reduce((best, s) => (s.rows * s.span > best.rows * best.span ? s : best));
            const color = colors[index];
            const regionStyle = { '--db-series': color, '--db-tint': seriesTint(color) } as CSSProperties;
            const low = Math.min(...bits);
            const high = Math.max(...bits);
            const partners = clashPartners(signal);
            const label =
              (signal.size === 1 ? `${signal.name}, bit ${low}` : `${signal.name}, bits ${low} to ${high}`) +
              (partners.length > 0 ? `, overlaps ${partners.join(' and ')}` : '');
            return segments.map((seg) => {
              const area = {
                ...regionStyle,
                gridRow: `${seg.byte + 2} / span ${seg.rows}`,
                gridColumn: `${seg.col + 2} / span ${seg.span}`,
              };
              const isSelected = index === selected;
              const className = `db-region${isSelected ? ' db-region-selected' : ''}`;
              // Only the largest piece is focusable and labelled, so each signal is one tab stop.
              if (seg !== largest) {
                return (
                  <div key={`${index}-${seg.byte}-${seg.col}`} className={className} style={area} aria-hidden="true" onClick={() => onSelect(index)} />
                );
              }
              return (
                <button
                  key={`${index}-${seg.byte}-${seg.col}`}
                  className={className}
                  style={area}
                  aria-label={label}
                  aria-pressed={isSelected}
                  title={signal.name}
                  onClick={() => onSelect(index)}
                >
                  <span className="db-region-label">
                    {signal.name}
                    <span className="db-region-bits">
                      {' \u00b7 '}
                      {signal.size} {signal.size === 1 ? 'bit' : 'bits'}
                    </span>
                  </span>
                </button>
              );
            });
          })}

          {clashBits.map((bit) => (
            <span
              key={`x${bit}`}
              className="db-overlap"
              style={{ gridRow: Math.floor(bit / 8) + 2, gridColumn: 7 - (bit % 8) + 2 }}
              aria-hidden="true"
            />
          ))}
        </div>
      )}

      {notes.length > 0 && (
        <div className="db-note" role="note">
          <AlertTriangle size={14} strokeWidth={1.75} aria-hidden="true" />
          <div>
            {clashes.length > 0 && (
              <p>
                <span className="db-hatch-swatch" aria-hidden="true" /> Overlapping bits are hatched.
              </p>
            )}
            {notes.map((note) => (
              <p key={note}>{note}</p>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function GridRow({ byte }: { byte: number }) {
  return (
    <>
      <span className="db-grid-rowhead" style={{ gridRow: byte + 2 }} aria-hidden="true">
        Byte {byte}
      </span>
      {COLUMNS.map((col) => (
        <span key={col} className="db-cell" style={{ gridRow: byte + 2, gridColumn: col + 2 }} aria-hidden="true" />
      ))}
    </>
  );
}
