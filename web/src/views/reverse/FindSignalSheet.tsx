import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Plus, X } from 'lucide-react';
import { ALL_IDS, formatId, isErrorFrame, type Behaviour, type Candidate, type FindRule } from '../../core/api';
import { Segmented } from '../../components/Segmented';
import { Sheet } from '../../components/Sheet';
import { formatCount } from '../../format';
import { useViewState } from '../shared/viewState';
import type { ViewContext } from '../types';
import { errorText, layoutString, parseNumber, rangeBits } from './bits';
import { Sparkline } from './Sparkline';

/** The core ranks this many, so shifted copies of a strong match can be folded away and still leave a full list. */
const SEARCH_LIMIT = 100;
const SHOWN = 20;
const PREVIEW_BUCKETS = 48;

type Scope = 'selected' | 'unknown' | 'all';

interface RuleDraft {
  id: number;
  behaviour: Behaviour;
  t0: string;
  t1: string;
}

const BEHAVIOURS: { value: Behaviour; label: string }[] = [
  { value: 'increases', label: 'increases' },
  { value: 'decreases', label: 'decreases' },
  { value: 'constant', label: 'stays constant' },
  { value: 'changes', label: 'changes' },
];

interface Props {
  open: boolean;
  onClose: () => void;
  ctx: ViewContext;
  duration: number;
  /** Load a candidate into the workspace; `rules` are the ones it was found with. */
  onUse: (candidate: Candidate, rules: FindRule[]) => void;
}

interface Search {
  rules: FindRule[];
  shown: Candidate[];
  /** Candidates folded into a better one of the same ID that shares bits with it. */
  hidden: number;
}

/** Describe how a signal behaves over time; the core ranks the bit ranges that behave that way. */
export function FindSignalSheet({ open, onClose, ctx, duration, onUse }: Props) {
  const { core, ids, messageOf, selected } = ctx;
  const [rules, setRules] = useViewState<RuleDraft[]>('re.findRules', () => exampleRules(duration), 'log');
  const [scope, setScope] = useViewState<Scope>('re.findScope', selected === ALL_IDS ? 'unknown' : 'selected', 'log');
  const [search, setSearch] = useState<Search | null>(null);
  const [picked, setPicked] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [previews, setPreviews] = useState<([Float64Array, Float64Array] | null)[]>([]);
  const tableRef = useRef<HTMLTableSectionElement>(null);
  const formId = useId();

  useEffect(() => {
    if (open && selected === ALL_IDS && scope === 'selected') setScope('unknown');
  }, [open, selected, scope, setScope]);

  const unknownKeys = useMemo(() => ids.filter((s) => !messageOf(s.key) && !isErrorFrame(s)).map((s) => s.key), [ids, messageOf]);
  const keys = scope === 'selected' ? [selected] : scope === 'unknown' ? unknownKeys : [];
  const scopeProblem =
    scope === 'selected' && selected === ALL_IDS
      ? 'Select an ID first, or search all IDs.'
      : scope === 'unknown' && unknownKeys.length === 0
        ? 'Every ID is in the database. Search all IDs instead.'
        : null;
  const ruleErrors = rules.map((r) => ruleError(r, duration));
  const valid = ruleErrors.every((e) => e === null) && !scopeProblem;

  // Editing the question makes the old answers stale.
  const edit = (change: () => void) => {
    change();
    setSearch(null);
    setError(null);
  };
  const updateRule = (id: number, patch: Partial<RuleDraft>) => edit(() => setRules((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r))));

  const find = () => {
    if (!valid || searching) return;
    const parsed = rules.map((r) => ({ behaviour: r.behaviour, t0: Number(r.t0), t1: Number(r.t1) }));
    setSearching(true);
    setError(null);
    ctx.run('Finding signals\u2026', async () => {
      try {
        const found = await core.findSignal(parsed, keys, SEARCH_LIMIT);
        const { shown, hidden } = foldOverlaps(found);
        setSearch({ rules: parsed, shown, hidden });
        setPicked(0);
      } catch (e) {
        // Shown here rather than in the window's banner, which the sheet covers.
        setError(errorText(e));
      } finally {
        setSearching(false);
      }
    });
  };

  // Each preview decodes, samples and drops its series straight away, so at most one is held at a time.
  useEffect(() => {
    setPreviews([]);
    if (!search || search.shown.length === 0) return;
    let stale = false;
    const [t0, t1] = ruleSpan(search.rules);
    (async () => {
      for (let i = 0; i < search.shown.length && !stale; i++) {
        const c = search.shown[i];
        try {
          const info = await core.decodeRaw(c.key, c.spec);
          try {
            const view = await core.seriesView(info.handle, t0, t1, PREVIEW_BUCKETS);
            if (!stale) {
              setPreviews((p) => {
                const next = [...p];
                next[i] = view;
                return next;
              });
            }
          } finally {
            core.dropSeries(info.handle);
          }
        } catch {
          // A missing preview is fine; the score and bits still say what matched.
        }
      }
    })();
    return () => {
      stale = true;
    };
  }, [core, search]);

  const results = search?.shown ?? null;
  const previewSpan = search ? ruleSpan(search.rules) : [0, 0];
  const use = (i: number) => {
    if (!search || !results?.[i]) return;
    onUse(results[i], search.rules);
  };

  const onRowKey = (e: KeyboardEvent<HTMLTableRowElement>, i: number) => {
    if (!results) return;
    const next = e.key === 'ArrowDown' ? i + 1 : e.key === 'ArrowUp' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? results.length - 1 : null;
    if (next !== null) {
      e.preventDefault();
      const clamped = Math.min(results.length - 1, Math.max(0, next));
      setPicked(clamped);
      tableRef.current?.querySelectorAll<HTMLTableRowElement>('tr')[clamped]?.focus();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      use(i);
    }
  };

  const summaryOf = (key: number) => ids.find((s) => s.key === key);
  const messageCount = results ? new Set(results.map((c) => c.key)).size : 0;
  const hasResults = !!results && results.length > 0;

  return (
    <Sheet
      open={open}
      onClose={onClose}
      size="large"
      title="Find Signal"
      description="Describe how the signal behaves over time. Bit ranges that follow every rule rank first."
      footer={
        <>
          <span className="re-find-count">
            {results &&
              (results.length === 0
                ? 'No matches'
                : `${results.length} ${results.length === 1 ? 'candidate' : 'candidates'} in ${messageCount} ${messageCount === 1 ? 'message' : 'messages'}`)}
          </span>
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          {hasResults ? (
            <button type="button" className="primary" onClick={() => use(picked)}>
              Use Signal
            </button>
          ) : (
            <button type="submit" form={formId} className="primary" disabled={!valid || searching}>
              {searching ? 'Finding\u2026' : 'Find Signals'}
            </button>
          )}
        </>
      }
    >
      <form
        id={formId}
        className="re-find"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          find();
        }}
      >
        <fieldset className="re-rules">
          <legend className="sr-only">Rules</legend>
          {rules.map((r, i) => {
            const err = ruleErrors[i];
            const errId = `${formId}-rule-${r.id}`;
            const bad = badFields(r, duration);
            return (
              <div className="re-rule" key={r.id}>
                <div className="re-rule-line">
                  <span className="re-rule-lead">{i === 0 ? 'Find a signal that' : 'and'}</span>
                  <select
                    className="select"
                    aria-label={`Rule ${i + 1} behaviour`}
                    value={r.behaviour}
                    onChange={(e) => updateRule(r.id, { behaviour: e.target.value as Behaviour })}
                  >
                    {BEHAVIOURS.map((b) => (
                      <option key={b.value} value={b.value}>
                        {b.label}
                      </option>
                    ))}
                  </select>
                  <span>between</span>
                  <span className="re-seconds">
                    <input
                      className="input mono"
                      inputMode="decimal"
                      spellCheck={false}
                      aria-label={`Rule ${i + 1} start, seconds`}
                      aria-invalid={bad.start}
                      aria-describedby={err ? errId : undefined}
                      value={r.t0}
                      onChange={(e) => updateRule(r.id, { t0: e.target.value })}
                    />
                    <span aria-hidden="true">s</span>
                  </span>
                  <span>and</span>
                  <span className="re-seconds">
                    <input
                      className="input mono"
                      inputMode="decimal"
                      spellCheck={false}
                      aria-label={`Rule ${i + 1} end, seconds`}
                      aria-invalid={bad.end}
                      aria-describedby={err ? errId : undefined}
                      value={r.t1}
                      onChange={(e) => updateRule(r.id, { t1: e.target.value })}
                    />
                    <span aria-hidden="true">s</span>
                  </span>
                  {rules.length > 1 && (
                    <button
                      type="button"
                      className="icon-button small re-rule-remove"
                      aria-label={`Remove rule ${i + 1}`}
                      onClick={() => edit(() => setRules((rs) => rs.filter((x) => x.id !== r.id)))}
                    >
                      <X size={14} strokeWidth={1.75} />
                    </button>
                  )}
                </div>
                {err && (
                  <p className="field-error" id={errId}>
                    {err}
                  </p>
                )}
              </div>
            );
          })}
          <div className="re-rules-foot">
            <button
              type="button"
              className="button"
              onClick={() => edit(() => setRules((rs) => [...rs, nextRule(Math.max(0, ...rs.map((r) => r.id)) + 1, rs[rs.length - 1], duration)]))}
            >
              <Plus size={16} strokeWidth={1.5} aria-hidden="true" />
              Add Rule
            </button>
            <span className="re-rules-note">Log runs 0 to {duration.toFixed(1)} s</span>
          </div>
        </fieldset>

        <div className="re-scope">
          <span className="field-label" aria-hidden="true">
            Search in
          </span>
          <Segmented<Scope>
            label="Search in"
            options={[
              { value: 'selected', label: 'Selected ID', disabled: selected === ALL_IDS },
              { value: 'unknown', label: 'All unknown IDs' },
              { value: 'all', label: 'All IDs' },
            ]}
            value={scope}
            onChange={(s) => edit(() => setScope(s))}
          />
          {scopeProblem && <span className="field-error">{scopeProblem}</span>}
        </div>
      </form>

      {error && <p className="re-quiet">Find Signal: {error}</p>}

      {results && results.length === 0 && (
        <p className="hint">No bit range follows every rule. Try longer stretches of time or fewer rules.</p>
      )}

      {hasResults && (
        <div className="re-results-wrap">
          <div className="re-results-scroll">
            <table className="re-results" role="grid" aria-label="Ranked matches" aria-readonly="true">
              <thead>
                <tr>
                  <th scope="col">ID</th>
                  <th scope="col">Bits</th>
                  <th scope="col">Preview</th>
                  <th scope="col" className="re-num">
                    Match
                  </th>
                </tr>
              </thead>
              <tbody ref={tableRef}>
                {results.map((c, i) => {
                  const s = summaryOf(c.key);
                  const name = messageOf(c.key)?.name ?? null;
                  const preview = previews[i];
                  return (
                    <tr
                      key={`${c.key}:${c.spec.startBit}:${c.spec.size}:${c.spec.byteOrder}`}
                      aria-selected={i === picked}
                      tabIndex={i === picked ? 0 : -1}
                      onClick={() => setPicked(i)}
                      onDoubleClick={() => use(i)}
                      onKeyDown={(e) => onRowKey(e, i)}
                    >
                      <td>
                        <span className="mono">{s ? formatId(s.id, s.extended) : '?'}</span>
                        <span className="re-cell-sub">
                          {s ? ctx.log?.channels[s.channel] : ''}
                          {name ? ` \u00b7 ${name}` : ' \u00b7 Unknown'}
                        </span>
                      </td>
                      <td>
                        <span className="mono">{layoutString(c.spec, c.spec.signed)}</span>
                        <span className="re-cell-sub">
                          {c.spec.byteOrder === 'intel' ? 'Intel' : 'Motorola'} &middot; {c.spec.signed ? 'signed' : 'unsigned'} &middot; {c.spec.size} bits
                        </span>
                      </td>
                      <td className="re-preview">
                        {preview ? (
                          <Sparkline x={preview[0]} y={preview[1]} x0={previewSpan[0]} x1={previewSpan[1]} />
                        ) : (
                          <span className="re-spark" />
                        )}
                      </td>
                      <td className="re-num re-score">{Math.round(Math.min(1, Math.max(0, c.score)) * 100)}%</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="re-results-note">
            Double-click a match, or select it and press Enter, to load it into the grid.
            {search && search.hidden > 0 && ` ${formatCount(search.hidden)} overlapping ${search.hidden === 1 ? 'range' : 'ranges'} hidden.`}
          </p>
        </div>
      )}
    </Sheet>
  );
}

function ruleSpan(rules: FindRule[]): [number, number] {
  return [Math.min(...rules.map((r) => r.t0)), Math.max(...rules.map((r) => r.t1))];
}

function exampleRules(duration: number): RuleDraft[] {
  // The demo's unknown 0x123 speeds up from 40 s and holds from 70 s; shorter logs get the same shape scaled down.
  const at = (seconds: number, fraction: number) => (duration >= 80 ? seconds : duration * fraction).toFixed(1);
  return [
    { id: 1, behaviour: 'increases', t0: at(40, 0.2), t1: at(55, 0.4) },
    { id: 2, behaviour: 'constant', t0: at(70, 0.6), t1: at(80, 0.8) },
  ];
}

function nextRule(id: number, after: RuleDraft | undefined, duration: number): RuleDraft {
  const start = Math.min(parseNumber(after?.t1 ?? '') ?? 0, duration);
  const end = Math.min(duration, start + 10);
  return { id, behaviour: 'changes', t0: start.toFixed(1), t1: end.toFixed(1) };
}

function badFields(r: RuleDraft, duration: number): { start: boolean; end: boolean } {
  const a = parseNumber(r.t0);
  const b = parseNumber(r.t1);
  return {
    start: a === null || a < 0 || a > duration || (b !== null && a >= b),
    end: b === null || b < 0 || b > duration || (a !== null && a >= b),
  };
}

function ruleError(r: RuleDraft, duration: number): string | null {
  const a = parseNumber(r.t0);
  const b = parseNumber(r.t1);
  if (a === null || b === null) return 'Enter both times in seconds.';
  if (a < 0 || b > duration) return `Times must fall within the log, 0 to ${duration.toFixed(1)} s.`;
  if (a >= b) return 'The start must come before the end.';
  return null;
}

/** Keeps the best of each set of same-ID candidates whose bits overlap, best first. */
function foldOverlaps(found: Candidate[]): { shown: Candidate[]; hidden: number } {
  const kept: { candidate: Candidate; bits: Set<number> }[] = [];
  let hidden = 0;
  for (const c of [...found].sort((a, b) => b.score - a.score)) {
    const bits = rangeBits(c.spec);
    if (kept.some((k) => k.candidate.key === c.key && bits.some((b) => k.bits.has(b)))) {
      hidden++;
      continue;
    }
    if (kept.length < SHOWN) kept.push({ candidate: c, bits: new Set(bits) });
  }
  return { shown: kept.map((k) => k.candidate), hidden };
}
