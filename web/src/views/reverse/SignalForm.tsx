import { useId, useState, type ReactNode } from 'react';
import { dbcId, formatId, type Database, type IdSummary, type MessageDef, type RawSignalSpec, type SeriesInfo, type SignalDef } from '../../core/api';
import { Segmented } from '../../components/Segmented';
import { formatCount } from '../../format';
import { useViewState } from '../shared/viewState';
import { Sparkline } from './Sparkline';
import type { ViewContext } from '../types';
import {
  DBC_IDENTIFIER,
  MAX_BITS,
  layoutString,
  parseNumber,
  plainNumber,
  rangeFits,
  formatValue,
  formatSeconds,
  lastIn,
  pointAt,
  type BitRange,
  type ByteOrder,
  type TimeWindow,
  type Trace,
  type WindowStats,
} from './bits';

export interface FormState {
  name: string;
  startBit: string;
  size: string;
  byteOrder: ByteOrder;
  /**
   * Whether the range was last set on the grid. Switching byte order then keeps the same cells
   * selected; typed numbers keep their values instead.
   */
  fromGrid: boolean;
  signed: boolean;
  factor: string;
  offset: string;
  unit: string;
  /** Typed limits, or null while they follow the decoded values. */
  limits: { min: string; max: string } | null;
  /** For an ID no DBC defines: the loaded DBC to add it to, NEW_DBC, or null for the first that applies. */
  addTo: string | null;
  /** Draw the candidate over the first pinned signal in its unit. Missing in forms saved before it existed. */
  overlay?: boolean;
}

/** `addTo` for a new DBC. Loaded DBC ids are UUIDs, so it can't name one. */
export const NEW_DBC = 'new';

/** Each ID's bit selection and form, by ID key. Kept for the open log, so coming back to an ID restores them. */
export function useCandidateForms() {
  return useViewState<Record<string, FormState>>('re.candidates', {}, 'log');
}

export function initialForm(spec: RawSignalSpec | null): FormState {
  return {
    name: '',
    startBit: spec ? String(spec.startBit) : '',
    size: spec ? String(spec.size) : '',
    byteOrder: spec?.byteOrder ?? 'intel',
    fromGrid: false,
    signed: spec?.signed ?? false,
    factor: spec ? plainNumber(spec.factor) : '1',
    offset: spec ? plainNumber(spec.offset) : '0',
    unit: '',
    limits: null,
    addTo: null,
    overlay: false,
  };
}

/** The form's bit range, or why it isn't one. Both fields blank is no range and no error. */
export function parseRange(startText: string, sizeText: string, byteOrder: ByteOrder, bytes: number): { range: BitRange | null; error: string | null } {
  if (startText.trim() === '' && sizeText.trim() === '') return { range: null, error: null };
  const startBit = Number(startText);
  const size = Number(sizeText);
  if (startText.trim() === '' || !Number.isInteger(startBit) || startBit < 0 || startBit >= bytes * 8) {
    return { range: null, error: `Start bit must be a whole number from 0 to ${bytes * 8 - 1}.` };
  }
  if (sizeText.trim() === '' || !Number.isInteger(size) || size < 1 || size > MAX_BITS) {
    return { range: null, error: `Length must be 1 to ${MAX_BITS} bits.` };
  }
  const range = { startBit, size, byteOrder };
  if (!rangeFits(range, bytes)) return { range: null, error: `Those bits run past the ${bytes}-byte payload.` };
  return { range, error: null };
}

/** Factor and offset, or null while either isn't a usable number. */
export function parseScale(form: FormState): { factor: number; offset: number } | null {
  const factor = parseNumber(form.factor);
  const offset = parseNumber(form.offset);
  return factor !== null && factor !== 0 && offset !== null ? { factor, offset } : null;
}

interface Props {
  ctx: ViewContext;
  summary: IdSummary;
  form: FormState;
  onChange: (patch: Partial<FormState>) => void;
  onByteOrder: (order: ByteOrder) => void;
  range: BitRange | null;
  rangeError: string | null;
  /** Whole-log decode of the current candidate, once it has caught up with the form. */
  decoded: SeriesInfo | null;
  stats: WindowStats | null;
  /** False when the window holds too many frames to count changes exactly. */
  statsExact: boolean;
  decodeError: string | null;
  window: TimeWindow;
  cursor: number | null;
  /** The candidate's points across the window, once they have caught up with the form. */
  trace: Trace | null;
  /** The pinned signal the candidate can overlay, by name, or null when none shares its unit. */
  overlayTarget: string | null;
}

/** The New Signal inspector: the candidate's definition, its decoded values, and Add to Database. */
export function SignalForm(props: Props) {
  const { ctx, summary, form, onChange, onByteOrder, range, rangeError, decoded, stats, statsExact, decodeError } = props;
  const { window: win, cursor, trace, overlayTarget } = props;
  const [submitted, setSubmitted] = useState(false);
  /** `dbc` is the id of the DBC it went into; `file` its name, until the new DBC shows up in ctx. */
  const [added, setAdded] = useState<{ signal: string; message: string; dbc: string; file: string } | null>(null);
  const ids = useId();
  const bytes = summary.maxLen;

  const owner = ctx.dbcOf(summary.key);
  const target = ctx.messageOf(summary.key);
  const bus = ctx.log?.channels[summary.channel];
  const applicable = ctx.dbcs.filter((d) => d.channel === null || d.channel === bus);
  // A kept choice may name a DBC that has since been removed or moved to another bus.
  const kept = form.addTo === NEW_DBC || applicable.some((d) => d.id === form.addTo) ? form.addTo : null;
  const addTo = kept ?? applicable[0]?.id ?? NEW_DBC;
  // Null for a new DBC.
  const destination = owner ?? applicable.find((d) => d.id === addTo) ?? null;
  const messageName = target?.name ?? newMessageName(destination?.db ?? null, summary);
  const name = form.name.trim();
  const nameError = !name
    ? submitted
      ? 'Name the signal to add it.'
      : null
    : !DBC_IDENTIFIER.test(name)
      ? 'Use letters, digits and underscores, starting with a letter or underscore.'
      : target?.signals.some((s) => s.name === name)
        ? `${target.name} already has a signal named ${name}.`
        : null;

  const factor = parseNumber(form.factor);
  const factorError = factor === null ? 'Enter a number.' : factor === 0 ? "The factor can't be zero." : null;
  const offsetError = parseNumber(form.offset) === null ? 'Enter a number.' : null;

  const autoLimits =
    decoded && decoded.min !== null && decoded.max !== null ? { min: plainNumber(decoded.min), max: plainNumber(decoded.max) } : { min: '', max: '' };
  const limits = form.limits ?? autoLimits;
  // Blank limits are written as 0, which DBC files read as "no range given".
  const min = limits.min.trim() === '' ? 0 : parseNumber(limits.min);
  const max = limits.max.trim() === '' ? 0 : parseNumber(limits.max);
  const limitsError = min === null || max === null ? 'Enter numbers, or leave both blank.' : min > max ? 'Min must not be above max.' : null;

  const add = () => {
    setSubmitted(true);
    setAdded(null);
    if (!range || !name || nameError || factorError || offsetError || limitsError || factor === null || min === null || max === null) return;
    const signal: SignalDef = {
      name,
      startBit: range.startBit,
      size: range.size,
      byteOrder: range.byteOrder,
      kind: form.signed ? 'signed' : 'unsigned',
      factor,
      offset: parseNumber(form.offset) ?? 0,
      min,
      max,
      unit: form.unit.trim(),
      isMultiplexor: false,
      muxValue: null,
      valueTable: [],
      comment: null,
    };
    // The decoding message's own ID, which differs from this frame's for a J1939 match by PGN.
    const message: MessageDef = { id: target?.id ?? dbcId(summary), name: messageName, size: bytes, transmitter: null, comment: null, signals: [signal] };
    ctx.run(`Adding ${name}\u2026`, async () => {
      if (destination) {
        // Built from the latest copy, so an edit queued from the Database view isn't overwritten.
        await ctx.updateDbc(destination.id, ({ db }) => {
          const existing = db.messages.some((m) => m.id === message.id);
          const next: Database = existing
            ? { ...db, messages: db.messages.map((m) => (m.id === message.id ? { ...m, signals: [...m.signals, signal] } : m)) }
            : { ...db, messages: [...db.messages, message] };
          return { db: next };
        });
        setAdded({ signal: name, message: messageName, dbc: destination.id, file: destination.db.name });
      } else {
        const file = 'untitled.dbc';
        const id = await ctx.addDbc({ name: file, messages: [message] }, null);
        setAdded({ signal: name, message: messageName, dbc: id, file });
      }
      setSubmitted(false);
      onChange({ name: '' });
    });
  };

  const unit = form.unit.trim() ? ` ${form.unit.trim()}` : '';
  const current = trace ? (cursor !== null ? pointAt(trace, cursor) : lastIn(trace, win)) : null;
  return (
    <div className="re-inspector">
      <header className="inspector-head">
        <h2 className="pane-title">New Signal</h2>
        <p className="sub">{target && owner ? `Adds to ${target.name} in ${owner.db.name}` : `Adds message ${messageName}`}</p>
      </header>

      <form
        className="inspector-section re-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <div className="re-value">
          <div className="re-value-head">
            <span className="re-value-label">{cursor !== null ? `Value (at ${formatSeconds(cursor)})` : 'Value (end of window)'}</span>
            <span className="readout re-value-reading">{range ? (current ? `${formatValue(current.v)}${unit}` : '\u2026') : '\u2013'}</span>
          </div>
          <div className="re-value-spark">
            {trace && trace.x.length > 0 ? <Sparkline x={trace.x} y={trace.y} x0={win[0]} x1={win[1]} /> : <span className="hint">{range ? 'Decoding\u2026' : 'Select bits to preview.'}</span>}
          </div>
          {overlayTarget && (
            <label className="re-check">
              <input type="checkbox" checked={form.overlay ?? false} onChange={(e) => onChange({ overlay: e.target.checked })} />
              Overlay on {overlayTarget}
            </label>
          )}
        </div>

        <Field id={`${ids}name`} label="Name" error={nameError}>
          <input
            id={`${ids}name`}
            className="input mono"
            value={form.name}
            placeholder="e.g. VehicleSpeed"
            spellCheck={false}
            autoComplete="off"
            aria-invalid={!!nameError}
            aria-describedby={nameError ? `${ids}name-error` : undefined}
            onChange={(e) => onChange({ name: e.target.value })}
          />
        </Field>

        <Field id={`${ids}unit`} label="Unit">
          <input
            id={`${ids}unit`}
            className="input"
            value={form.unit}
            placeholder="e.g. km/h"
            autoComplete="off"
            onChange={(e) => onChange({ unit: e.target.value })}
          />
        </Field>

        <div className="re-pair">
          <Field id={`${ids}start`} label="Start bit">
            <input
              id={`${ids}start`}
              className="input mono"
              type="number"
              min={0}
              max={Math.max(0, bytes * 8 - 1)}
              step={1}
              value={form.startBit}
              aria-invalid={!!rangeError}
              aria-describedby={rangeError ? `${ids}range-error` : undefined}
              onChange={(e) => onChange({ startBit: e.target.value, fromGrid: false, limits: null })}
            />
          </Field>
          <Field id={`${ids}size`} label="Length">
            <input
              id={`${ids}size`}
              className="input mono"
              type="number"
              min={1}
              max={MAX_BITS}
              step={1}
              value={form.size}
              aria-invalid={!!rangeError}
              aria-describedby={rangeError ? `${ids}range-error` : undefined}
              onChange={(e) => onChange({ size: e.target.value, fromGrid: false, limits: null })}
            />
          </Field>
        </div>
        {rangeError ? (
          <p className="field-error" id={`${ids}range-error`}>
            {rangeError}
          </p>
        ) : (
          !range && <p className="hint re-form-hint">Drag across the bit grid, or type a start bit and length.</p>
        )}

        <div className="field">
          <span className="field-label" aria-hidden="true">
            Byte order
          </span>
          <Segmented<ByteOrder>
            label="Byte order"
            className="re-order"
            options={[
              { value: 'intel', label: 'Intel' },
              { value: 'motorola', label: 'Motorola' },
            ]}
            value={form.byteOrder}
            onChange={onByteOrder}
          />
        </div>

        <label className="re-switch-row">
          <span>Signed</span>
          <input
            type="checkbox"
            role="switch"
            className="switch"
            checked={form.signed}
            onChange={(e) => onChange({ signed: e.target.checked, limits: null })}
          />
        </label>

        <div className="re-pair">
          <Field id={`${ids}factor`} label="Factor" error={factorError}>
            <input
              id={`${ids}factor`}
              className="input mono"
              inputMode="decimal"
              spellCheck={false}
              value={form.factor}
              aria-invalid={!!factorError}
              aria-describedby={factorError ? `${ids}factor-error` : undefined}
              onChange={(e) => onChange({ factor: e.target.value, limits: null })}
            />
          </Field>
          <Field id={`${ids}offset`} label="Offset" error={offsetError}>
            <input
              id={`${ids}offset`}
              className="input mono"
              inputMode="decimal"
              spellCheck={false}
              value={form.offset}
              aria-invalid={!!offsetError}
              aria-describedby={offsetError ? `${ids}offset-error` : undefined}
              onChange={(e) => onChange({ offset: e.target.value, limits: null })}
            />
          </Field>
        </div>

        <div className="re-pair">
          <Field id={`${ids}min`} label="Min">
            <input
              id={`${ids}min`}
              className="input mono"
              inputMode="decimal"
              spellCheck={false}
              value={limits.min}
              placeholder="0"
              aria-invalid={!!limitsError}
              aria-describedby={limitsError ? `${ids}limits-error` : `${ids}limits-note`}
              onChange={(e) => onChange({ limits: { ...limits, min: e.target.value } })}
            />
          </Field>
          <Field id={`${ids}max`} label="Max">
            <input
              id={`${ids}max`}
              className="input mono"
              inputMode="decimal"
              spellCheck={false}
              value={limits.max}
              placeholder="0"
              aria-invalid={!!limitsError}
              aria-describedby={limitsError ? `${ids}limits-error` : `${ids}limits-note`}
              onChange={(e) => onChange({ limits: { ...limits, max: e.target.value } })}
            />
          </Field>
        </div>
        {limitsError ? (
          <p className="field-error" id={`${ids}limits-error`}>
            {limitsError}
          </p>
        ) : (
          <p className="hint re-form-hint" id={`${ids}limits-note`}>
            {form.limits ? 'Typed by you.' : 'From the values decoded across the whole log.'}
          </p>
        )}

        <dl className="re-stats" aria-label="Decoded values">
          <div>
            <dt>Layout</dt>
            <dd className="mono">{range ? layoutString(range, form.signed) : '\u2013'}</dd>
          </div>
          {decodeError ? (
            <div>
              <dt>Decoded</dt>
              <dd className="re-quiet">{decodeError}</dd>
            </div>
          ) : (
            range && (
              <>
                <div>
                  <dt>In window</dt>
                  <dd>
                    {!stats
                      ? '\u2026'
                      : stats.frames === 0
                        ? 'No frames'
                        : `${formatValue(stats.min)} to ${formatValue(stats.max)}${unit}`}
                  </dd>
                </div>
                <div>
                  <dt>Changes</dt>
                  <dd>
                    {!stats
                      ? '\u2026'
                      : statsExact
                        ? `${formatCount(stats.changes)} in ${formatCount(stats.frames)} frames`
                        : 'Narrow the window to count'}
                  </dd>
                </div>
                <div>
                  <dt>Whole log</dt>
                  <dd>
                    {!decoded
                      ? '\u2026'
                      : decoded.min === null || decoded.max === null
                        ? 'No values'
                        : `${formatValue(decoded.min)} to ${formatValue(decoded.max)}${unit}`}
                  </dd>
                </div>
              </>
            )
          )}
        </dl>

        <div className="re-add">
          {!owner && (
            <div className="field re-add-to">
              <label className="field-label" htmlFor={`${ids}add-to`}>
                Add to
              </label>
              <select id={`${ids}add-to`} className="select" value={addTo} onChange={(e) => onChange({ addTo: e.target.value })}>
                {applicable.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.db.name}
                  </option>
                ))}
                <option value={NEW_DBC}>New DBC</option>
              </select>
            </div>
          )}
          <button type="submit" className="primary" disabled={!range}>
            Add to Database
          </button>
          <p className="re-added" role="status">
            {added && (
              <>
                Added <span className="mono">{added.signal}</span> to <span className="mono">{added.message}</span> in{' '}
                {ctx.dbcs.find((d) => d.id === added.dbc)?.db.name ?? added.file}.{' '}
                <button type="button" className="text-button" onClick={() => ctx.setView('database')}>
                  View in Database
                </button>
              </>
            )}
          </p>
        </div>
      </form>
    </div>
  );
}

function Field({ id, label, error, children }: { id: string; label: string; error?: string | null; children: ReactNode }) {
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      {children}
      {error && (
        <p className="field-error" id={`${id}-error`}>
          {error}
        </p>
      )}
    </div>
  );
}

/** `MSG_123`, or with a suffix if a message of another ID already has that name. */
function newMessageName(db: Database | null, summary: IdSummary): string {
  const taken = new Set((db?.messages ?? []).map((m) => m.name));
  const base = `MSG_${formatId(summary.id, summary.extended)}`;
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base}_${n}`;
  return name;
}
