import { formatId, type CompareOptions, type IdComparison, type LogInfo } from '../../core/api';

/** Scores from here up count as a difference, as the core reports them. */
export const SIGNIFICANT = 10;

export const DEFAULT_OPTIONS: CompareOptions = { ignoreCounters: true, ignoreChangesWithinA: false };

export type GroupId = 'different' | 'onlyB' | 'onlyA' | 'same';
export type Show = 'all' | 'both' | 'onlyA' | 'onlyB';

export const GROUPS: { id: GroupId; label: string }[] = [
  { id: 'different', label: 'In both \u00b7 different bytes' },
  { id: 'onlyB', label: 'Only in B' },
  { id: 'onlyA', label: 'Only in A' },
  { id: 'same', label: 'In both \u00b7 no significant differences' },
];

export const SHOW_OPTIONS: { id: Show; label: string; groups: GroupId[] }[] = [
  { id: 'all', label: 'All messages', groups: ['different', 'onlyB', 'onlyA', 'same'] },
  { id: 'both', label: 'In both logs', groups: ['different', 'same'] },
  { id: 'onlyA', label: 'Only in A', groups: ['onlyA'] },
  { id: 'onlyB', label: 'Only in B', groups: ['onlyB'] },
];

export function groupOf(c: IdComparison): GroupId {
  if (c.presence === 'onlyA') return 'onlyA';
  if (c.presence === 'onlyB') return 'onlyB';
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

/** No ID differs under the current ignore rules. */
export function looksTheSame(results: IdComparison[]): boolean {
  return results.every((c) => groupOf(c) === 'same');
}

export function formatRate(perSecond: number): string {
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
      c.rateA.toFixed(3),
      c.rateB.toFixed(3),
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
