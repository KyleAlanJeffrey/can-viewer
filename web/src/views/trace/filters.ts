import { ALL_IDS, idLabel, type DataRule, type FrameFilter, type FrameKind, type IdSummary } from '../../core/api';

/** The filters applied to the Trace view, kept as view state for the open log. */
export interface TraceFilters {
  /** Bus indexes, or null for every bus. */
  channels: number[] | null;
  /** ID keys; empty means every ID. */
  keys: number[];
  kinds: FrameKind[] | null;
  rules: DataRule[];
  combine: 'all' | 'any';
  /** Seconds from the start of the log; null leaves that end open. */
  t0: number | null;
  t1: number | null;
}

export const NO_FILTERS: TraceFilters = { channels: null, keys: [], kinds: null, rules: [], combine: 'all', t0: null, t1: null };

export const KINDS: { kind: FrameKind; label: string }[] = [
  { kind: 'data', label: 'Data' },
  { kind: 'remote', label: 'Remote' },
  { kind: 'error', label: 'Error' },
  { kind: 'reassembled', label: 'J1939 reassembled' },
];

export function hasFilters(f: TraceFilters): boolean {
  return f.channels !== null || f.keys.length > 0 || f.kinds !== null || f.rules.length > 0 || f.t0 !== null || f.t1 !== null;
}

/** What the core is asked for: the filters, narrowed to the ID picked in the sidebar if there is one. */
export function toFrameFilter(f: TraceFilters, selected: number): FrameFilter {
  let keys: number[] | null = f.keys.length > 0 ? f.keys : null;
  if (selected !== ALL_IDS) keys = keys === null || keys.includes(selected) ? [selected] : [];
  return { channels: f.channels, keys, kinds: f.kinds, rules: f.rules, combine: f.combine, t0: f.t0, t1: f.t1 };
}

export function hexByte(value: number): string {
  return value.toString(16).toUpperCase().padStart(2, '0');
}

export function formatSeconds(t: number): string {
  return t.toFixed(3);
}

export function ruleLabel(rule: DataRule): string {
  switch (rule.type) {
    case 'byteEquals':
      return `Byte ${rule.byte} = ${hexByte(rule.value)}`;
    case 'bit':
      return `Byte ${rule.byte} bit ${rule.bit} ${rule.set ? 'set' : 'clear'}`;
    case 'changes':
      return 'Any byte changes';
  }
}

export function timeLabel(t0: number | null, t1: number | null): string {
  if (t0 !== null && t1 !== null) return `${formatSeconds(t0)} - ${formatSeconds(t1)} s`;
  if (t0 !== null) return `From ${formatSeconds(t0)} s`;
  return `Until ${formatSeconds(t1 ?? 0)} s`;
}

export interface FilterChip {
  id: string;
  label: string;
  /** The filters without this one. */
  without: TraceFilters;
}

/**
 * One removable chip per part of the filters, in a fixed order: bus, IDs, kinds, time, then
 * each data rule. "Remove last filter" takes the last one.
 */
export function filterChips(f: TraceFilters, channels: string[], ids: IdSummary[]): FilterChip[] {
  const chips: FilterChip[] = [];
  if (f.channels !== null) {
    const names = f.channels.map((c) => channels[c] ?? `bus ${c}`);
    chips.push({ id: 'bus', label: names.length > 0 ? names.join(', ') : 'No bus', without: { ...f, channels: null } });
  }
  if (f.keys.length > 0) {
    const labels = f.keys.map((key) => {
      const s = ids.find((i) => i.key === key);
      return s ? idLabel(s) : String(key);
    });
    const shown = labels.slice(0, 3).join(', ');
    chips.push({ id: 'ids', label: labels.length > 3 ? `${shown} +${labels.length - 3}` : shown, without: { ...f, keys: [] } });
  }
  if (f.kinds !== null) {
    const names = KINDS.filter((k) => f.kinds!.includes(k.kind)).map((k) => k.label);
    chips.push({ id: 'kinds', label: names.length > 0 ? names.join(', ') : 'No frame kind', without: { ...f, kinds: null } });
  }
  if (f.t0 !== null || f.t1 !== null) {
    chips.push({ id: 'time', label: timeLabel(f.t0, f.t1), without: { ...f, t0: null, t1: null } });
  }
  f.rules.forEach((rule, i) => {
    const rules = f.rules.filter((_, j) => j !== i);
    chips.push({ id: `rule-${i}`, label: ruleLabel(rule), without: { ...f, rules, combine: rules.length > 1 ? f.combine : 'all' } });
  });
  return chips;
}

/**
 * The payload bytes of a row that a data rule matched, so a filtered row shows why it matched.
 * With "any rule", only the rules this row meets count.
 */
export function matchedBytes(rules: DataRule[], data: Uint8Array, changed: (byte: number) => boolean): number[] {
  const bytes = new Set<number>();
  for (const rule of rules) {
    if (rule.type === 'changes') {
      for (let b = 0; b < data.length; b++) if (changed(b)) bytes.add(b);
    } else if (rule.byte < data.length) {
      const value = data[rule.byte];
      const met = rule.type === 'byteEquals' ? value === rule.value : ((value >> rule.bit) & 1) === (rule.set ? 1 : 0);
      if (met) bytes.add(rule.byte);
    }
  }
  return [...bytes].sort((a, b) => a - b);
}
