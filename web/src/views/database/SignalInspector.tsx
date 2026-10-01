import { useId, useState } from 'react';
import { LineChart, Plus, X } from 'lucide-react';
import type { MessageDef, SignalDef } from '../../core/api';
import { Segmented } from '../../components/Segmented';
import { EditField } from './EditField';
import { layoutError, messageIdText, nodeListError, parseInteger, parseNodeList, parseNumber, receiversOf, signalNameError } from './dbcModel';

interface Props {
  message: MessageDef;
  index: number;
  color: string;
  /** Fields that changed. */
  onChange: (patch: Partial<SignalDef>) => void;
  /** Focus and select the name, for a signal that was just added. */
  focusName: boolean;
  /** Present when the message is in the open log. */
  plot: { plotted: boolean; onPlot: () => void } | null;
}

type ByteOrder = SignalDef['byteOrder'];

const numberError = (text: string) => (parseNumber(text) === null ? 'Enter a number.' : null);

/** Every field of one signal. A field commits on blur or Enter once it's valid. */
export function SignalInspector({ message, index, color, onChange, focusName, plot }: Props) {
  const signal = message.signals[index];
  const signedId = useId();
  const [orderError, setOrderError] = useState<string | null>(null);

  const commitNumber = (text: string, field: 'factor' | 'offset' | 'min' | 'max') => {
    const n = parseNumber(text);
    if (n !== null && n !== signal[field]) onChange({ [field]: n });
  };

  const commitLayout = (text: string, field: 'startBit' | 'size') => {
    const n = parseInteger(text);
    if (n !== null && n !== signal[field]) onChange({ [field]: n });
  };

  const layoutCheck = (text: string, field: 'startBit' | 'size') => {
    const n = parseInteger(text);
    if (n === null) return 'Enter a whole number.';
    return layoutError({ ...signal, [field]: n }, message.size);
  };

  const changeOrder = (byteOrder: ByteOrder) => {
    const problem = layoutError({ ...signal, byteOrder }, message.size);
    setOrderError(problem === null ? null : `${problem} Move the start bit first.`);
    if (problem === null) onChange({ byteOrder });
  };

  const isFloat = signal.kind === 'float32' || signal.kind === 'float64';

  return (
    <>
      <header className="inspector-head">
        <h2 className="pane-title db-pane-title">
          <span className="db-dot" style={{ background: color }} />
          <span className="db-pane-name">{signal.name}</span>
        </h2>
        <p className="sub">
          <span className="mono">{messageIdText(message)}</span> {message.name}
          {signal.isMultiplexor && <> &middot; multiplexor</>}
          {signal.muxValue !== null && <> &middot; page m{signal.muxValue}</>}
        </p>
        {plot && (
          <button className="button db-plot-button" onClick={plot.onPlot}>
            <LineChart size={16} strokeWidth={1.5} aria-hidden="true" />
            {plot.plotted ? 'Show in Plot' : 'Plot Signal'}
          </button>
        )}
      </header>

      <section className="db-props" aria-label="Signal">
        <EditField
          layout="row"
          label="Name"
          value={signal.name}
          autoFocus={focusName}
          validate={(t) => signalNameError(t.trim(), message, index)}
          onCommit={(t) => onChange({ name: t.trim() })}
        />
        <EditField
          layout="row"
          label="Start bit"
          mono
          numeric
          value={String(signal.startBit)}
          validate={(t) => layoutCheck(t, 'startBit')}
          onCommit={(t) => commitLayout(t, 'startBit')}
        />
        <EditField
          layout="row"
          label="Length"
          mono
          numeric
          value={String(signal.size)}
          validate={(t) => layoutCheck(t, 'size')}
          onCommit={(t) => commitLayout(t, 'size')}
        />
        <span className="field-label">Byte order</span>
        <div className="db-control">
          <Segmented<ByteOrder>
            label="Byte order"
            className="small"
            options={[
              { value: 'intel', label: 'Intel' },
              { value: 'motorola', label: 'Motorola' },
            ]}
            value={signal.byteOrder}
            onChange={changeOrder}
          />
          {orderError && <p className="field-error">{orderError}</p>}
        </div>
        {isFloat ? (
          <span className="field-label">Signed</span>
        ) : (
          <label htmlFor={signedId} className="field-label">
            Signed
          </label>
        )}
        <div className="db-control db-switch-control">
          {isFloat ? (
            <span className="db-readonly-text">IEEE {signal.kind === 'float32' ? '32-bit' : '64-bit'} float</span>
          ) : (
            <input
              id={signedId}
              type="checkbox"
              role="switch"
              className="switch"
              checked={signal.kind === 'signed'}
              onChange={(e) => onChange({ kind: e.target.checked ? 'signed' : 'unsigned' })}
            />
          )}
        </div>
        <EditField
          layout="row"
          label="Factor"
          mono
          numeric
          value={String(signal.factor)}
          validate={(t) => numberError(t) ?? (parseNumber(t) === 0 ? "Factor can't be 0." : null)}
          onCommit={(t) => commitNumber(t, 'factor')}
        />
        <EditField
          layout="row"
          label="Offset"
          mono
          numeric
          value={String(signal.offset)}
          validate={numberError}
          onCommit={(t) => commitNumber(t, 'offset')}
        />
        <EditField
          layout="row"
          label="Minimum"
          mono
          numeric
          value={String(signal.min)}
          validate={(t) => numberError(t) ?? ((parseNumber(t) ?? 0) > signal.max ? `Must be at most the maximum, ${signal.max}.` : null)}
          onCommit={(t) => commitNumber(t, 'min')}
        />
        <EditField
          layout="row"
          label="Maximum"
          mono
          numeric
          value={String(signal.max)}
          validate={(t) => numberError(t) ?? ((parseNumber(t) ?? 0) < signal.min ? `Must be at least the minimum, ${signal.min}.` : null)}
          onCommit={(t) => commitNumber(t, 'max')}
        />
        <EditField
          layout="row"
          label="Unit"
          placeholder="None"
          value={signal.unit}
          onCommit={(t) => onChange({ unit: t.trim() })}
        />
        <EditField
          layout="row"
          label="Receivers"
          placeholder="None"
          value={receiversOf(signal).join(', ')}
          validate={nodeListError}
          onCommit={(t) => onChange({ receivers: parseNodeList(t) })}
        />
        <EditField
          layout="row"
          label="Comment"
          placeholder="None"
          multiline
          value={signal.comment ?? ''}
          onCommit={(t) => onChange({ comment: t.trim() || null })}
        />
      </section>

      <ValueDescriptions signal={signal} onChange={(valueTable) => onChange({ valueTable })} />
    </>
  );
}

function ValueDescriptions({ signal, onChange }: { signal: SignalDef; onChange: (table: [number, string][]) => void }) {
  const [focusRow, setFocusRow] = useState<number | null>(null);
  const table = signal.valueTable;

  const add = () => {
    const next = table.length === 0 ? 0 : Math.max(...table.map(([v]) => v)) + 1;
    onChange([...table, [next, '']]);
    setFocusRow(table.length);
  };

  const valueError = (text: string, row: number) => {
    const v = parseInteger(text);
    if (v === null) return 'Enter a whole number.';
    return table.some(([other], i) => i !== row && other === v) ? 'This value already has a description.' : null;
  };

  return (
    <section className="inspector-section db-values-section" aria-labelledby="db-values-title">
      <div className="section-head">
        <h3 className="section-title" id="db-values-title">
          Value descriptions
        </h3>
        <button className="text-button db-add" onClick={add}>
          <Plus size={14} strokeWidth={1.75} aria-hidden="true" />
          Add value
        </button>
      </div>
      {table.length === 0 ? (
        <p className="db-values-empty">No descriptions</p>
      ) : (
        <table className="db-values">
          <thead>
            <tr>
              <th scope="col" className="db-values-value">
                Value
              </th>
              <th scope="col">Description</th>
              <th scope="col" className="db-col-action">
                <span className="sr-only">Remove</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {table.map(([value, text], row) => (
              <tr key={row}>
                <td>
                  <EditField
                    layout="cell"
                    label={`Value in row ${row + 1}`}
                    mono
                    numeric
                    value={String(value)}
                    validate={(t) => valueError(t, row)}
                    onCommit={(t) => {
                      const v = parseInteger(t);
                      if (v !== null && v !== value) onChange(table.map((entry, i) => (i === row ? [v, entry[1]] : entry)));
                    }}
                  />
                </td>
                <td>
                  <EditField
                    layout="cell"
                    label={`Description of ${value}`}
                    placeholder="Description"
                    autoFocus={row === focusRow}
                    value={text}
                    onCommit={(t) => onChange(table.map((entry, i) => (i === row ? [entry[0], t.trim()] : entry)))}
                  />
                </td>
                <td className="db-col-action">
                  <button
                    className="icon-button small"
                    aria-label={`Remove value ${value}`}
                    title={`Remove value ${value}`}
                    onClick={() => {
                      setFocusRow(null);
                      onChange(table.filter((_, i) => i !== row));
                    }}
                  >
                    <X size={14} strokeWidth={1.75} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
