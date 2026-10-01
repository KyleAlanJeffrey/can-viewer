import { useId, useState, type FormEvent } from 'react';
import { dbcId, type Database, type MessageDef } from '../../core/api';
import { Sheet } from '../../components/Sheet';
import type { LoadedDbc } from '../types';
import { DLC_SIZES, UNTITLED_DBC, messageIdError, messageNameError, nodesOf, parseHexId, transmitterError } from './dbcModel';

export interface MessageDraft {
  name: string;
  /** Hex, as typed. */
  id: string;
  extended: boolean;
  size: number;
}

export const BLANK_MESSAGE: MessageDraft = { name: '', id: '', extended: false, size: 8 };

const NO_DBC: Database = { name: UNTITLED_DBC, messages: [] };

interface Props {
  /** Where the message can go, in lookup order. Empty means a new DBC. */
  dbcs: LoadedDbc[];
  /** Id of the DBC chosen at first. */
  initialDbc: string | null;
  initial: MessageDraft;
  onCancel: () => void;
  /** `dbc` is null when the message should go into a new DBC. */
  onAdd: (dbc: LoadedDbc | null, message: MessageDef) => void;
}

export function NewMessageSheet({ dbcs, initialDbc, initial, onCancel, onAdd }: Props) {
  const formId = useId();
  const ids = { dbc: useId(), name: useId(), id: useId(), extended: useId(), size: useId(), transmitter: useId(), nodes: useId() };
  const [target, setTarget] = useState(() => initialDbc ?? dbcs[0]?.id ?? null);
  const [name, setName] = useState(initial.name);
  const [id, setId] = useState(initial.id);
  const [extended, setExtended] = useState(initial.extended);
  const [size, setSize] = useState(initial.size);
  const [transmitter, setTransmitter] = useState('');
  const [submitted, setSubmitted] = useState(false);

  const dbc = dbcs.find((d) => d.id === target) ?? dbcs[0] ?? null;
  const db = dbc?.db ?? NO_DBC;
  const raw = parseHexId(id);
  const errors = {
    name: messageNameError(name.trim(), db, null),
    id: messageIdError(raw, extended, db, null),
    transmitter: transmitterError(transmitter.trim()),
  };
  const shown = (field: keyof typeof errors) => (submitted ? errors[field] : null);
  const nodes = nodesOf(db);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    const firstInvalid = (Object.keys(errors) as (keyof typeof errors)[]).find((field) => errors[field] !== null);
    if (firstInvalid || raw === null) {
      if (firstInvalid) document.getElementById(ids[firstInvalid])?.focus();
      return;
    }
    onAdd(dbc, { id: dbcId({ id: raw, extended }), name: name.trim(), size, transmitter: transmitter.trim() || null, comment: null, signals: [] });
  };

  const errorProps = (field: keyof typeof errors) => ({
    'aria-invalid': shown(field) !== null,
    'aria-describedby': shown(field) !== null ? `${ids[field]}-error` : undefined,
  });
  const errorText = (field: keyof typeof errors) =>
    shown(field) !== null && (
      <p id={`${ids[field]}-error`} className="field-error">
        {shown(field)}
      </p>
    );

  return (
    <Sheet
      open
      onClose={onCancel}
      title="New Message"
      description="Describe a CAN frame. Add its signals once it exists."
      footer={
        <>
          <button type="button" className="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="primary" form={formId}>
            Add Message
          </button>
        </>
      }
    >
      <form id={formId} className="db-sheet-form" onSubmit={submit} noValidate>
        <div className="field db-span-2">
          {dbc ? (
            <>
              <label htmlFor={ids.dbc} className="field-label">
                DBC
              </label>
              <select id={ids.dbc} className="select" value={dbc.id} onChange={(e) => setTarget(e.target.value)}>
                {dbcs.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.channel === null ? d.db.name : `${d.db.name} (${d.channel})`}
                  </option>
                ))}
              </select>
            </>
          ) : (
            <>
              <span className="field-label">DBC</span>
              <p className="db-readonly">A new {NO_DBC.name}</p>
            </>
          )}
        </div>
        <div className="field db-span-2">
          <label htmlFor={ids.name} className="field-label">
            Name
          </label>
          <input
            id={ids.name}
            className="input"
            placeholder="e.g. ENGINE_2"
            autoComplete="off"
            spellCheck={false}
            value={name}
            onChange={(e) => setName(e.target.value)}
            {...errorProps('name')}
          />
          {errorText('name')}
        </div>
        <div className="field">
          <label htmlFor={ids.id} className="field-label">
            ID (hex)
          </label>
          <input
            id={ids.id}
            className="input mono"
            placeholder="e.g. 1F5"
            autoComplete="off"
            spellCheck={false}
            value={id}
            onChange={(e) => setId(e.target.value)}
            {...errorProps('id')}
          />
          {errorText('id')}
        </div>
        <div className="db-sheet-pair">
          <div className="field">
            <label htmlFor={ids.extended} className="field-label">
              29-bit
            </label>
            <div className="db-switch-control">
              <input id={ids.extended} type="checkbox" role="switch" className="switch" checked={extended} onChange={(e) => setExtended(e.target.checked)} />
            </div>
          </div>
          <div className="field">
            <label htmlFor={ids.size} className="field-label">
              Bytes
            </label>
            <select id={ids.size} className="select" value={size} onChange={(e) => setSize(Number(e.target.value))}>
              {DLC_SIZES.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="field db-span-2">
          <label htmlFor={ids.transmitter} className="field-label">
            Transmitter
          </label>
          <input
            id={ids.transmitter}
            className="input"
            placeholder="None"
            autoComplete="off"
            spellCheck={false}
            list={ids.nodes}
            value={transmitter}
            onChange={(e) => setTransmitter(e.target.value)}
            {...errorProps('transmitter')}
          />
          <datalist id={ids.nodes}>
            {nodes.map((n) => (
              <option key={n} value={n} />
            ))}
          </datalist>
          {errorText('transmitter')}
        </div>
      </form>
    </Sheet>
  );
}
