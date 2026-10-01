import { Trash2 } from 'lucide-react';
import type { MessageDef, SignalDef } from '../../core/api';
import { receiversOf } from './dbcModel';

interface Props {
  message: MessageDef;
  /** Series colour per signal, same order as the message's signals. */
  colors: string[];
  selected: number | null;
  onSelect: (index: number) => void;
  onDelete: (index: number) => void;
}

export function SignalTable({ message, colors, selected, onSelect, onDelete }: Props) {
  return (
    <div className="db-table-wrap">
      <table className="db-table">
        <caption className="sr-only">Signals of {message.name}</caption>
        <thead>
          <tr>
            <th scope="col" className="db-col-dot">
              <span className="sr-only">Colour</span>
            </th>
            <th scope="col">Name</th>
            <th scope="col">Start|Len</th>
            <th scope="col" className="db-col-mid">
              Byte order
            </th>
            <th scope="col" className="db-col-mid">
              Signed
            </th>
            <th scope="col">Factor</th>
            <th scope="col" className="db-col-extra">
              Offset
            </th>
            <th scope="col" className="db-col-extra">
              Min
            </th>
            <th scope="col" className="db-col-extra">
              Max
            </th>
            <th scope="col">Unit</th>
            <th scope="col" className="db-col-extra">
              Receivers
            </th>
            <th scope="col" className="db-col-action">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {message.signals.map((s, i) => {
            const mux = muxLabel(s);
            const receivers = receiversOf(s);
            return (
              <tr key={i} className={`db-signal-row${i === selected ? ' db-selected' : ''}`} onClick={() => onSelect(i)}>
                <td className="db-col-dot">
                  <span className="db-dot" style={{ background: colors[i] }} />
                </td>
                <th scope="row">
                  <button className="db-row-name" aria-current={i === selected} onClick={() => onSelect(i)}>
                    {s.name}
                    {mux && <span className="db-mux">{mux}</span>}
                  </button>
                </th>
                <td className="db-num">
                  {s.startBit}|{s.size}
                </td>
                <td className="db-col-mid">{s.byteOrder === 'intel' ? 'Intel' : 'Motorola'}</td>
                <td className="db-col-mid">{s.kind === 'signed' ? 'Yes' : s.kind === 'unsigned' ? 'No' : 'Float'}</td>
                <td className="db-num">{s.factor}</td>
                <td className="db-num db-col-extra">{s.offset}</td>
                <td className="db-num db-col-extra">{s.min}</td>
                <td className="db-num db-col-extra">{s.max}</td>
                <td>{s.unit || <span className="db-none">&mdash;</span>}</td>
                <td className="db-col-extra">{receivers.length > 0 ? receivers.join(', ') : <span className="db-none">&mdash;</span>}</td>
                <td className="db-col-action">
                  <button
                    className="icon-button small db-delete"
                    aria-label={`Delete ${s.name}`}
                    title={`Delete ${s.name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onDelete(i);
                    }}
                  >
                    <Trash2 size={14} strokeWidth={1.5} />
                  </button>
                </td>
              </tr>
            );
          })}
          {message.signals.length === 0 && (
            <tr>
              <td colSpan={12} className="db-table-empty">
                No signals yet. Add Signal places one at the first free bits.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function muxLabel(s: SignalDef): string | null {
  if (s.isMultiplexor) return 'M';
  return s.muxValue !== null ? `m${s.muxValue}` : null;
}
