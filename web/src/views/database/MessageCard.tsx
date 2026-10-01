import { useId, useState } from 'react';
import { dbcId, type Database, type MessageDef } from '../../core/api';
import { EditField } from './EditField';
import {
  DLC_SIZES,
  MAX_STANDARD_ID,
  isExtended,
  messageIdError,
  messageIdText,
  messageNameError,
  nodesOf,
  parseHexId,
  rawId,
  sizeError,
  transmitterError,
} from './dbcModel';

interface Props {
  db: Database;
  message: MessageDef;
  /** Mean period measured in the log, already formatted; null when the message isn't in it. */
  period: string | null;
  /** Fields that changed. */
  onChange: (patch: Partial<MessageDef>) => void;
  onDelete: () => void;
}

/** The selected message's own fields. Every field commits on its own once valid. */
export function MessageCard({ db, message, period, onChange, onDelete }: Props) {
  const extendedId = useId();
  const sizeId = useId();
  const nodesId = useId();
  const [extendedError, setExtendedError] = useState<string | null>(null);
  const [sizeProblem, setSizeProblem] = useState<string | null>(null);
  const extended = isExtended(message);
  const nodes = nodesOf(db);

  const toggleExtended = (next: boolean) => {
    const problem =
      !next && rawId(message) > MAX_STANDARD_ID ? 'This ID needs 29 bits. Change the ID first.' : messageIdError(rawId(message), next, db, message);
    setExtendedError(problem);
    // J1939 needs a 29-bit ID.
    if (!problem) onChange({ id: dbcId({ id: rawId(message), extended: next }), ...(next ? {} : { j1939: false }) });
  };

  const changeSize = (bytes: number) => {
    const problem = sizeError(bytes, message);
    setSizeProblem(problem);
    if (!problem) onChange({ size: bytes });
  };

  return (
    <section className="card db-card" aria-labelledby="db-message-title">
      <div className="db-card-head">
        <h3 className="section-title" id="db-message-title">
          Message
        </h3>
        <button className="text-button" onClick={onDelete}>
          Delete Message&hellip;
        </button>
      </div>
      <div className="db-message-fields">
        <EditField
          layout="stack"
          className="db-f-name"
          label="Name"
          value={message.name}
          validate={(t) => messageNameError(t.trim(), db, message)}
          onCommit={(t) => onChange({ name: t.trim() })}
        />
        <EditField
          layout="stack"
          className="db-f-id"
          label="ID (hex)"
          mono
          value={messageIdText(message)}
          validate={(t) => messageIdError(parseHexId(t), extended, db, message)}
          onCommit={(t) => {
            const raw = parseHexId(t);
            if (raw !== null && raw !== rawId(message)) onChange({ id: dbcId({ id: raw, extended }) });
          }}
        />
        <div className="field db-f-switch">
          <label htmlFor={extendedId} className="field-label">
            29-bit
          </label>
          <div className="db-switch-control">
            <input
              id={extendedId}
              type="checkbox"
              role="switch"
              className="switch"
              checked={extended}
              aria-invalid={extendedError !== null}
              aria-describedby={extendedError ? `${extendedId}-error` : undefined}
              onChange={(e) => toggleExtended(e.target.checked)}
            />
          </div>
          {extendedError && (
            <p id={`${extendedId}-error`} className="field-error">
              {extendedError}
            </p>
          )}
        </div>
        <div className="field db-f-size">
          <label htmlFor={sizeId} className="field-label">
            Bytes
          </label>
          <select
            id={sizeId}
            className="select"
            value={message.size}
            aria-invalid={sizeProblem !== null}
            aria-describedby={sizeProblem ? `${sizeId}-error` : undefined}
            onChange={(e) => changeSize(Number(e.target.value))}
          >
            {(DLC_SIZES.includes(message.size) ? DLC_SIZES : [...DLC_SIZES, message.size].sort((a, b) => a - b)).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          {sizeProblem && (
            <p id={`${sizeId}-error`} className="field-error">
              {sizeProblem}
            </p>
          )}
        </div>
        <EditField
          layout="stack"
          className="db-f-node"
          label="Transmitter"
          placeholder="None"
          list={nodesId}
          value={message.transmitter ?? ''}
          validate={(t) => transmitterError(t.trim())}
          onCommit={(t) => onChange({ transmitter: t.trim() || null })}
        />
        <datalist id={nodesId}>
          {nodes.map((n) => (
            <option key={n} value={n} />
          ))}
        </datalist>
        {period !== null && (
          <div className="field db-f-period">
            <span className="field-label">Mean period</span>
            <p className="db-readonly">
              <span className="num">{period}</span>
              <span className="db-caption">from log</span>
            </p>
          </div>
        )}
        <EditField
          layout="stack"
          className="db-f-comment"
          label="Comment"
          placeholder="None"
          value={message.comment ?? ''}
          onCommit={(t) => onChange({ comment: t.trim() || null })}
        />
      </div>
    </section>
  );
}
