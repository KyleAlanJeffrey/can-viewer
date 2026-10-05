import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Plus, Search, X } from 'lucide-react';
import { formatId, idLabel, type CoreApi, type DataRule, type FrameKind, type IdSummary } from '../../core/api';
import { Segmented } from '../../components/Segmented';
import { Sheet } from '../../components/Sheet';
import { formatCount } from '../../format';
import { KINDS, formatSeconds, hasFilters, hexByte, toFrameFilter, type TraceFilters } from './filters';
import { TimeRangeStrip } from './TimeRangeStrip';
import './filter-sheet.css';

/** How long the draft must stay unchanged before its matches are counted. */
const PREVIEW_DELAY_MS = 250;
const SHOWN_OPTIONS = 8;
/** The longest payload, a full J1939 transfer, has bytes 0 to 1784. */
const MAX_BYTE = 1784;

type RuleType = 'byteEquals' | 'bitSet' | 'bitClear' | 'changes';

const RULE_TYPES: { value: RuleType; label: string }[] = [
  { value: 'byteEquals', label: 'Byte equals' },
  { value: 'bitSet', label: 'Bit is set' },
  { value: 'bitClear', label: 'Bit is clear' },
  { value: 'changes', label: 'Any byte changes' },
];

interface RuleDraft {
  id: number;
  type: RuleType;
  byte: string;
  value: string;
  bit: number;
}

interface Draft {
  /** Checked buses. */
  channels: number[];
  keys: number[];
  kinds: FrameKind[];
  rules: RuleDraft[];
  combine: 'all' | 'any';
  from: string;
  to: string;
}

interface DraftErrors {
  rules: Map<number, { byte?: string; value?: string }>;
  from?: string;
  to?: string;
}

type Preview = { state: 'counting' } | { state: 'counted'; count: number } | { state: 'failed'; message: string } | { state: 'invalid' };

interface Props {
  open: boolean;
  onClose: () => void;
  core: CoreApi;
  channels: string[];
  ids: IdSummary[];
  duration: number;
  /** The ID picked in the sidebar, or ALL_IDS; the trace shows only its frames. */
  selected: number;
  /** Frames in the trace before filtering. */
  total: number;
  filters: TraceFilters | null;
  onApply: (filters: TraceFilters | null) => void;
}

/** Edits the Trace view's filters, with a live count of the frames they match. */
export function FilterSheet({ open, onClose, core, channels, ids, duration, selected, total, filters, onApply }: Props) {
  const [draft, setDraft] = useState(() => draftOf(filters, channels.length));
  const [attempted, setAttempted] = useState(false);
  const [preview, setPreview] = useState<Preview>({ state: 'counting' });
  const formId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const nextRuleId = useRef(draft.rules.length + 1);

  const { filters: parsed, errors } = useMemo(() => parseDraft(draft, channels.length), [draft, channels.length]);
  const valid = parsed !== null;
  const query = parsed && hasFilters(parsed) ? JSON.stringify(toFrameFilter(parsed, selected)) : null;

  useEffect(() => {
    if (!open) return;
    if (!valid) {
      setPreview({ state: 'invalid' });
      return;
    }
    if (query === null) {
      setPreview({ state: 'counted', count: total });
      return;
    }
    let stale = false;
    setPreview({ state: 'counting' });
    const timer = setTimeout(() => {
      core.countFilterMatches(JSON.parse(query)).then(
        (count) => {
          if (!stale && count !== null) setPreview({ state: 'counted', count });
        },
        (e) => {
          if (!stale) setPreview({ state: 'failed', message: e instanceof Error ? e.message : String(e) });
        },
      );
    }, PREVIEW_DELAY_MS);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [open, core, query, total, valid]);

  const update = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const updateRule = (id: number, patch: Partial<RuleDraft>) => setDraft((d) => ({ ...d, rules: d.rules.map((r) => (r.id === id ? { ...r, ...patch } : r)) }));
  const toggle = <T,>(list: T[], item: T, on: boolean) => (on ? [...list, item] : list.filter((x) => x !== item));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!parsed) {
      setAttempted(true);
      // After the render that marks the fields.
      setTimeout(() => formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
      return;
    }
    onApply(hasFilters(parsed) ? parsed : null);
  };

  const show = (error: string | undefined, text: string) => (error && (attempted || text.trim() !== '') ? error : undefined);
  const fromError = show(errors.from, draft.from);
  const toError = show(errors.to, draft.to);
  const scopeSummary = ids.find((s) => s.key === selected);
  const scopeNote = scopeSummary
    ? ` Only frames of ${idLabel(scopeSummary)}${scopeSummary.name ? ` ${scopeSummary.name}` : ''}, picked in the sidebar, are counted.`
    : '';
  const stripT0 = parseSeconds(draft.from);
  const stripT1 = parseSeconds(draft.to);

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Trace filters"
      description={`Show only the frames that match. Filters stay with this log.${scopeNote}`}
      footer={
        <>
          <p className="tv-preview" role="status">
            <PreviewText preview={preview} total={total} />
          </p>
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form={formId} className="primary">
            Apply filters
          </button>
        </>
      }
    >
      <form id={formId} ref={formRef} className="tv-filter-form" noValidate onSubmit={submit}>
        <fieldset className="tv-section">
          <legend className="tv-legend">Bus</legend>
          <div className="tv-checks">
            {channels.map((name, channel) => (
              <label key={name} className="tv-check">
                <input
                  type="checkbox"
                  checked={draft.channels.includes(channel)}
                  onChange={(e) => update({ channels: toggle(draft.channels, channel, e.target.checked).sort((a, b) => a - b) })}
                />
                <span className="mono">{name}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="tv-section">
          <legend className="tv-legend">IDs or names</legend>
          <IdPicker ids={ids} channels={channels} picked={draft.keys} onChange={(keys) => update({ keys })} />
        </fieldset>

        <fieldset className="tv-section">
          <legend className="tv-legend">Data rules</legend>
          {draft.rules.length === 0 && <p className="tv-hint">No rules: any payload matches.</p>}
          {draft.rules.map((rule, i) => {
            const n = i + 1;
            const ruleErrors = errors.rules.get(rule.id) ?? {};
            const byteError = show(ruleErrors.byte, rule.byte);
            const valueError = show(ruleErrors.value, rule.value);
            const errorId = `${formId}-rule-${rule.id}`;
            return (
              <div key={rule.id} className="tv-rule" role="group" aria-label={`Rule ${n}`}>
                <div className="tv-rule-line">
                  <select className="select tv-rule-type" aria-label={`Rule ${n} type`} value={rule.type} onChange={(e) => updateRule(rule.id, { type: e.target.value as RuleType })}>
                    {RULE_TYPES.map((t) => (
                      <option key={t.value} value={t.value}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                  {rule.type !== 'changes' && (
                    <label className="tv-inline">
                      <span>Byte</span>
                      <input
                        className="input mono tv-narrow"
                        inputMode="numeric"
                        spellCheck={false}
                        aria-label={`Rule ${n} byte`}
                        aria-invalid={!!byteError}
                        aria-describedby={byteError || valueError ? errorId : undefined}
                        value={rule.byte}
                        onChange={(e) => updateRule(rule.id, { byte: e.target.value })}
                      />
                    </label>
                  )}
                  {rule.type === 'byteEquals' && (
                    <label className="tv-inline">
                      <span aria-hidden="true">=</span>
                      <input
                        className="input mono tv-narrow"
                        spellCheck={false}
                        autoCapitalize="characters"
                        placeholder="1F"
                        aria-label={`Rule ${n} value, hex`}
                        aria-invalid={!!valueError}
                        aria-describedby={byteError || valueError ? errorId : undefined}
                        value={rule.value}
                        onChange={(e) => updateRule(rule.id, { value: e.target.value })}
                      />
                    </label>
                  )}
                  {(rule.type === 'bitSet' || rule.type === 'bitClear') && (
                    <label className="tv-inline">
                      <span>bit</span>
                      <select className="select mono" aria-label={`Rule ${n} bit`} value={rule.bit} onChange={(e) => updateRule(rule.id, { bit: Number(e.target.value) })}>
                        {[0, 1, 2, 3, 4, 5, 6, 7].map((b) => (
                          <option key={b} value={b}>
                            {b}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <button
                    type="button"
                    className="icon-button small"
                    aria-label={`Remove rule ${n}`}
                    onClick={() => update({ rules: draft.rules.filter((r) => r.id !== rule.id) })}
                  >
                    <X size={14} strokeWidth={1.75} />
                  </button>
                </div>
                {(byteError || valueError) && (
                  <p className="field-error" id={errorId}>
                    {byteError ?? valueError}
                  </p>
                )}
              </div>
            );
          })}
          {draft.rules.some((r) => r.type === 'changes') && (
            <p className="tv-hint">Any byte changes compares each frame with the previous frame of its ID and kind, over the bytes both have.</p>
          )}
          <div className="tv-rules-foot">
            <button
              type="button"
              className="button"
              onClick={() => update({ rules: [...draft.rules, { id: nextRuleId.current++, type: 'byteEquals', byte: '0', value: '', bit: 0 }] })}
            >
              <Plus size={16} strokeWidth={1.5} aria-hidden="true" />
              Add rule
            </button>
            {draft.rules.length > 1 && (
              <Segmented<'all' | 'any'>
                className="small"
                label="Match"
                options={[
                  { value: 'all', label: 'All rules' },
                  { value: 'any', label: 'Any rule' },
                ]}
                value={draft.combine}
                onChange={(combine) => update({ combine })}
              />
            )}
          </div>
        </fieldset>

        <fieldset className="tv-section">
          <legend className="tv-legend">Frame kind</legend>
          <div className="tv-checks">
            {KINDS.map(({ kind, label }) => (
              <label key={kind} className="tv-check">
                <input type="checkbox" checked={draft.kinds.includes(kind)} onChange={(e) => update({ kinds: toggle(draft.kinds, kind, e.target.checked) })} />
                {label}
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="tv-section">
          <legend className="tv-legend">Time range</legend>
          <div className="tv-times">
            <SecondsField label="From" placeholder="0.000" value={draft.from} error={fromError} onChange={(from) => update({ from })} />
            <SecondsField label="To" placeholder={formatSeconds(duration)} value={draft.to} error={toError} onChange={(to) => update({ to })} />
            {(draft.from !== '' || draft.to !== '') && (
              <button type="button" className="text-button" onClick={() => update({ from: '', to: '' })}>
                Whole log
              </button>
            )}
          </div>
          <TimeRangeStrip
            duration={duration}
            t0={Number.isFinite(stripT0) ? stripT0 : null}
            t1={Number.isFinite(stripT1) ? stripT1 : null}
            onChange={(t0, t1) => update({ from: t0 > 0 ? formatSeconds(t0) : '', to: t1 < duration ? formatSeconds(t1) : '' })}
          />
        </fieldset>
      </form>
    </Sheet>
  );
}

function PreviewText({ preview, total }: { preview: Preview; total: number }) {
  switch (preview.state) {
    case 'counting':
      return <>Counting matches&hellip;</>;
    case 'invalid':
      return <>Fix the marked fields to see how many frames match.</>;
    case 'failed':
      return <>Couldn't count the matches: {preview.message}</>;
    case 'counted':
      return (
        <>
          Preview: <b className="num">{formatCount(preview.count)}</b> of <span className="num">{formatCount(total)}</span> frames match
        </>
      );
  }
}

function SecondsField({ label, placeholder, value, error, onChange }: { label: string; placeholder: string; value: string; error?: string; onChange: (v: string) => void }) {
  const errorId = useId();
  return (
    <label className="field tv-seconds">
      <span className="field-label">{label}</span>
      <span className="tv-seconds-input">
        <input
          className="input mono"
          inputMode="decimal"
          spellCheck={false}
          placeholder={placeholder}
          aria-invalid={!!error}
          aria-describedby={error ? errorId : undefined}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        <span aria-hidden="true">s</span>
      </span>
      {error && (
        <span className="field-error" id={errorId}>
          {error}
        </span>
      )}
    </label>
  );
}

/** A searchable list of the log's IDs; picked ones show as removable chips. */
function IdPicker({ ids, channels, picked, onChange }: { ids: IdSummary[]; channels: string[]; picked: number[]; onChange: (keys: number[]) => void }) {
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const multiBus = channels.length > 1;

  const matches = useMemo(() => {
    const q = text.trim().toLowerCase().replace(/^0x/, '');
    return ids
      .filter((s) => {
        if (picked.includes(s.key)) return false;
        if (!q) return true;
        return idLabel(s).toLowerCase().includes(q) || formatId(s.id, s.extended).toLowerCase().includes(q) || (s.name ?? '').toLowerCase().includes(q);
      })
      .sort((a, b) => a.channel - b.channel || a.id - b.id);
  }, [ids, picked, text]);
  const shown = matches.slice(0, SHOWN_OPTIONS);
  const activeIndex = Math.min(active, shown.length - 1);
  const expanded = open && shown.length > 0;

  const pick = (s: IdSummary) => {
    onChange([...picked, s.key]);
    setText('');
    setActive(0);
    inputRef.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActive(Math.max(0, Math.min(shown.length - 1, activeIndex + step)));
    } else if ((e.key === 'Home' || e.key === 'End') && expanded) {
      e.preventDefault();
      setActive(e.key === 'Home' ? 0 : shown.length - 1);
    } else if (e.key === 'Enter') {
      // Never submits the sheet: Enter here is for picking.
      e.preventDefault();
      if (expanded) pick(shown[activeIndex]);
      else setOpen(true);
    } else if (e.key === 'Escape' && (expanded || text !== '')) {
      // Closes the list, not the sheet.
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      setText('');
    }
  };

  const describe = (s: IdSummary) => `${idLabel(s)}${s.name ? ` ${s.name}` : ''}${multiBus ? ` on ${channels[s.channel]}` : ''}`;

  return (
    <div className="tv-picker">
      <div className="tv-search">
        <Search size={16} strokeWidth={1.5} aria-hidden="true" />
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-label="Search IDs or names"
          aria-expanded={expanded}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={expanded ? `${listId}-${activeIndex}` : undefined}
          placeholder="Search IDs or names"
          spellCheck={false}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setActive(0);
            setOpen(true);
          }}
          // Not on focus: tabbing through the sheet shouldn't drop a list open.
          onClick={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={onKeyDown}
        />
      </div>
      <ul id={listId} role="listbox" aria-label="Matching IDs" className="tv-options" hidden={!expanded}>
        {shown.map((s, i) => (
          <li
            key={s.key}
            id={`${listId}-${i}`}
            role="option"
            aria-selected={i === activeIndex}
            className="tv-option"
            // Keeps focus in the field, so the list stays open.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => pick(s)}
          >
            <span className="mono">{idLabel(s)}</span>
            <span className="tv-option-name">{s.name ?? 'Unknown'}</span>
            {multiBus && <span className="tv-option-bus mono">{channels[s.channel]}</span>}
          </li>
        ))}
        {matches.length > shown.length && (
          <li role="presentation" className="tv-option-more">
            {matches.length - shown.length} more; keep typing to narrow the list
          </li>
        )}
      </ul>
      {picked.length > 0 && (
        <ul className="tv-picked" aria-label="Picked IDs">
          {picked.map((key) => {
            const s = ids.find((i) => i.key === key);
            const label = s ? describe(s) : String(key);
            return (
              <li key={key} className="tv-chip">
                <span className="mono">{s ? idLabel(s) : key}</span>
                {s && <span className="tv-chip-name">{s.name ?? 'Unknown'}</span>}
                <button type="button" className="icon-button small" aria-label={`Remove ${label}`} onClick={() => onChange(picked.filter((k) => k !== key))}>
                  <X size={14} strokeWidth={1.75} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function draftOf(filters: TraceFilters | null, channelCount: number): Draft {
  const f = filters;
  return {
    channels: f?.channels ?? Array.from({ length: channelCount }, (_, i) => i),
    keys: f?.keys ?? [],
    kinds: f?.kinds ?? KINDS.map((k) => k.kind),
    rules: (f?.rules ?? []).map((rule, i) => ruleDraft(rule, i + 1)),
    combine: f?.combine ?? 'all',
    // As typed: String gives back the shortest text for the number, never rounding it.
    from: f?.t0 != null ? String(f.t0) : '',
    to: f?.t1 != null ? String(f.t1) : '',
  };
}

function ruleDraft(rule: DataRule, id: number): RuleDraft {
  switch (rule.type) {
    case 'byteEquals':
      return { id, type: 'byteEquals', byte: String(rule.byte), value: hexByte(rule.value), bit: 0 };
    case 'bit':
      return { id, type: rule.set ? 'bitSet' : 'bitClear', byte: String(rule.byte), value: '', bit: rule.bit };
    case 'changes':
      return { id, type: 'changes', byte: '0', value: '', bit: 0 };
  }
}

function parseSeconds(text: string): number {
  return text.trim() === '' ? NaN : Number(text);
}

/** The filters a draft stands for, or null with the reasons when a field is not valid. */
function parseDraft(d: Draft, channelCount: number): { filters: TraceFilters | null; errors: DraftErrors } {
  const errors: DraftErrors = { rules: new Map() };
  const rules: DataRule[] = [];
  for (const r of d.rules) {
    if (r.type === 'changes') {
      rules.push({ type: 'changes' });
      continue;
    }
    const byte = /^\d+$/.test(r.byte.trim()) ? Number(r.byte) : NaN;
    const ruleErrors: { byte?: string; value?: string } = {};
    if (!(byte <= MAX_BYTE)) ruleErrors.byte = `Enter a byte number from 0 to ${MAX_BYTE}.`;
    if (r.type === 'byteEquals') {
      const hex = r.value.trim().replace(/^0x/i, '');
      if (!/^[0-9a-f]{1,2}$/i.test(hex)) ruleErrors.value = 'Enter the value as a hex byte, 00 to FF.';
      else if (!ruleErrors.byte) rules.push({ type: 'byteEquals', byte, value: parseInt(hex, 16) });
    } else if (!ruleErrors.byte) {
      rules.push({ type: 'bit', byte, bit: r.bit, set: r.type === 'bitSet' });
    }
    if (ruleErrors.byte || ruleErrors.value) errors.rules.set(r.id, ruleErrors);
  }

  const t0 = parseSeconds(d.from);
  const t1 = parseSeconds(d.to);
  if (d.from.trim() !== '' && !(t0 >= 0)) errors.from = 'Enter seconds from the start of the log, such as 12.5.';
  if (d.to.trim() !== '' && !(t1 >= 0)) errors.to = 'Enter seconds from the start of the log, such as 18.5.';
  else if (t1 < t0) errors.to = 'The range ends before it starts.';

  if (errors.rules.size > 0 || errors.from || errors.to) return { filters: null, errors };
  return {
    filters: {
      channels: d.channels.length === channelCount ? null : d.channels,
      keys: d.keys,
      kinds: d.kinds.length === KINDS.length ? null : KINDS.map((k) => k.kind).filter((k) => d.kinds.includes(k)),
      rules,
      combine: rules.length > 1 ? d.combine : 'all',
      t0: Number.isFinite(t0) ? t0 : null,
      t1: Number.isFinite(t1) ? t1 : null,
    },
    errors,
  };
}
