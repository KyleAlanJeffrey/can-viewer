import { formatId, type CompareOptions, type IdComparison, type LogInfo } from '../../core/api';
import { formatCount } from '../../format';

/** Scores from here up count as a difference, as the core reports them. */
export const SIGNIFICANT = 10;

export const DEFAULT_OPTIONS: CompareOptions = { ignoreCounters: true, ignoreChangesWithinA: true };

export type GroupId = 'different' | 'onlyB' | 'onlyA' | 'same' | 'tooFew';
export type Show = 'all' | 'both' | 'onlyA' | 'onlyB';

export const GROUPS: { id: GroupId; label: string }[] = [
  { id: 'different', label: 'In both \u00b7 different bytes' },
  { id: 'onlyB', label: 'Only in B' },
  { id: 'onlyA', label: 'Only in A' },
  { id: 'same', label: 'In both \u00b7 no significant differences' },
  { id: 'tooFew', label: 'Too few frames to compare' },
];

export const SHOW_OPTIONS: { id: Show; label: string; groups: GroupId[] }[] = [
  { id: 'all', label: 'All messages', groups: ['different', 'onlyB', 'onlyA', 'same', 'tooFew'] },
  { id: 'both', label: 'In both logs', groups: ['different', 'same', 'tooFew'] },
  { id: 'onlyA', label: 'Only in A', groups: ['onlyA'] },
  { id: 'onlyB', label: 'Only in B', groups: ['onlyB'] },
];

export function groupOf(c: IdComparison): GroupId {
  if (c.presence === 'onlyA') return 'onlyA';
  if (c.presence === 'onlyB') return 'onlyB';
  if (c.tooFewFrames) return 'tooFew';
  return c.score >= SIGNIFICANT ? 'different' : 'same';
}

/** Identifies a row across recomputations and swaps, which change its keys. */
export function rowKey(c: Pick<IdComparison, 'bus' | 'id' | 'extended'>): string {
  return `${c.bus}:${c.extended ? 'x' : 's'}:${c.id.toString(16)}`;
}

export function matchesQuery(c: IdComparison, query: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || formatId(c.id, c.extended).toLowerCase().includes(q) || (c.name ?? '').toLowerCase().includes(q);
}

/**
 * No ID differs under the current ignore rules, and there was something to compare. IDs with
 * too few frames say nothing either way.
 */
export function looksTheSame(results: IdComparison[]): boolean {
  const groups = results.map(groupOf);
  return groups.includes('same') && groups.every((g) => g === 'same' || g === 'tooFew');
}

/** How many IDs the within-A rule left out, for the states that show no differences, or null. */
export function withinANote(results: IdComparison[]): string | null {
  const n = results.filter((c) => c.changesWithinA).length;
  if (n === 0) return null;
  return `${formatCount(n)} ${n === 1 ? 'ID changes' : 'IDs change'} within A; turn off the rule to see ${n === 1 ? 'it' : 'them'}.`;
}

/**
 * How log B's buses were paired with log A's when the logs share no bus name, such as
 * `can0 = vcan0`, or null when every bus kept its name.
 */
export function busesMatchedByOrder(results: IdComparison[]): string | null {
  const pairs = new Map<string, string>();
  for (const c of results) {
    if (c.presence === 'both' && c.busB !== null && c.busB !== c.bus) pairs.set(c.bus, c.busB);
  }
  if (pairs.size === 0) return null;
  return [...pairs].sort(([a], [b]) => a.localeCompare(b)).map(([a, b]) => `${a} = ${b}`).join(', ');
}

/** Frames per second, or a dash for a log of no duration. */
export function formatRate(perSecond: number | null): string {
  if (perSecond === null) return '-';
  if (perSecond >= 9.95) return String(Math.round(perSecond));
  if (perSecond >= 0.995) return perSecond.toFixed(1);
  return perSecond === 0 ? '0' : perSecond.toPrecision(2);
}

/** Bit indexes as short ranges, such as `0-3, 7`. */
export function bitList(bits: number[]): string {
  const sorted = [...bits].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    parts.push(j > i ? `${sorted[i]}-${sorted[j]}` : String(sorted[i]));
    i = j + 1;
  }
  return parts.join(', ');
}

const csvCell = (value: string | number) => {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

const PRESENCE: Record<IdComparison['presence'], string> = { both: 'both', onlyA: 'only A', onlyB: 'only B' };

/** Every compared ID as CSV, with the logs and ignore rules in the first lines. */
export function findingsCsv(results: IdComparison[], a: LogInfo, b: LogInfo, options: CompareOptions): string {
  const rules = [options.ignoreCounters && 'counters and checksums ignored', options.ignoreChangesWithinA && 'changes within A ignored'].filter(Boolean);
  const lines = [
    ['log A', a.name, `${a.durationS.toFixed(1)} s`],
    ['log B', b.name, `${b.durationS.toFixed(1)} s`],
    ['rules', rules.length > 0 ? rules.join('; ') : 'none'],
    [],
    ['bus', 'id', 'name', 'in', 'a_frames_per_s', 'b_frames_per_s', 'score', 'reason', 'bytes'],
    ...results.map((c) => [
      c.bus,
      formatId(c.id, c.extended),
      c.name ?? '',
      PRESENCE[c.presence],
      c.rateA?.toFixed(3) ?? '',
      c.rateB?.toFixed(3) ?? '',
      c.score,
      c.reason,
      c.bytes.join(' '),
    ]),
  ];
  return lines.map((row) => row.map(csvCell).join(',')).join('\n') + '\n';
}

/** A file name stem: the name without its extension. */
export function stem(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}
