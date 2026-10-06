import { describe, expect, it } from 'vitest';
import type { IdComparison } from '../../core/api';
import { logInfo } from '../../test/fixtures';
import { bitList, busesMatchedByOrder, findingsCsv, formatRate, groupOf, looksTheSame, matchesQuery, rowKey, stem, withinANote } from './findings';

function comparison(fields: Partial<IdComparison> = {}): IdComparison {
  return {
    bus: 'can0',
    id: 0x450,
    extended: false,
    keyA: 0x450,
    keyB: 0x450,
    presence: 'both',
    name: null,
    framesA: 100,
    framesB: 100,
    rateA: 10,
    rateB: 10,
    busB: 'can0',
    score: 0,
    reason: 'No significant changes',
    bytes: [],
    tooFewFrames: false,
    changesWithinA: false,
    ...fields,
  };
}

describe('groupOf', () => {
  it('splits IDs in both logs at a score of 10', () => {
    expect(groupOf(comparison({ score: 9 }))).toBe('same');
    expect(groupOf(comparison({ score: 10 }))).toBe('different');
    expect(groupOf(comparison({ presence: 'onlyA', score: 100 }))).toBe('onlyA');
    expect(groupOf(comparison({ presence: 'onlyB', score: 100 }))).toBe('onlyB');
  });

  it('keeps IDs with too few frames apart', () => {
    expect(groupOf(comparison({ tooFewFrames: true, reason: 'Too few frames to compare' }))).toBe('tooFew');
  });

  it('calls the logs the same only when no ID differs', () => {
    expect(looksTheSame([comparison(), comparison({ id: 0x451, score: 5 })])).toBe(true);
    expect(looksTheSame([comparison(), comparison({ presence: 'onlyB', score: 100 })])).toBe(false);
    expect(looksTheSame([])).toBe(false);
  });

  it('lets IDs with too few frames say nothing either way', () => {
    const tooFew = comparison({ id: 0x5a0, tooFewFrames: true, reason: 'Too few frames to compare; payloads differ' });
    expect(looksTheSame([comparison(), tooFew])).toBe(true);
    expect(looksTheSame([tooFew])).toBe(false);
  });
});

describe('withinANote', () => {
  it('counts the IDs the within-A rule left out', () => {
    const left = comparison({ score: 2, reason: 'Also changes within A', changesWithinA: true });
    expect(withinANote([comparison()])).toBeNull();
    expect(withinANote([left, comparison()])).toBe('1 ID changes within A; turn off the rule to see it.');
    expect(withinANote([left, { ...left, id: 0x451 }])).toBe('2 IDs change within A; turn off the rule to see them.');
  });
});

describe('busesMatchedByOrder', () => {
  it('lists the buses log B names differently, once each', () => {
    expect(busesMatchedByOrder([comparison(), comparison({ presence: 'onlyA', busB: null })])).toBeNull();
    const renamed = [
      comparison({ bus: 'can1', busB: 'vcan1' }),
      comparison({ busB: 'vcan0' }),
      comparison({ id: 0x451, busB: 'vcan0' }),
      comparison({ presence: 'onlyB', bus: 'vcan2', busB: 'vcan2' }),
    ];
    expect(busesMatchedByOrder(renamed)).toBe('can0 = vcan0, can1 = vcan1');
  });
});

describe('rowKey', () => {
  it('names a row by bus and ID, not by the keys a swap changes', () => {
    expect(rowKey(comparison({ keyA: 1, keyB: 2 }))).toBe(rowKey(comparison({ keyA: 2, keyB: 1 })));
    expect(rowKey(comparison())).not.toBe(rowKey(comparison({ extended: true })));
    expect(rowKey(comparison())).not.toBe(rowKey(comparison({ bus: 'can1' })));
  });
});

describe('matchesQuery', () => {
  it('matches the ID or the name, ignoring case', () => {
    const c = comparison({ name: 'BODY' });
    expect(matchesQuery(c, '')).toBe(true);
    expect(matchesQuery(c, '45')).toBe(true);
    expect(matchesQuery(c, 'bod')).toBe(true);
    expect(matchesQuery(c, '7DF')).toBe(false);
  });
});

describe('formatting', () => {
  it('rounds rates to what a reader can compare', () => {
    expect(formatRate(100.4)).toBe('100');
    expect(formatRate(2.04)).toBe('2.0');
    expect(formatRate(0.25)).toBe('0.25');
    expect(formatRate(0)).toBe('0');
    expect(formatRate(null)).toBe('-');
  });

  it('lists bits as ranges', () => {
    expect(bitList([7, 0, 1, 2, 5])).toBe('0-2, 5, 7');
    expect(bitList([3])).toBe('3');
  });

  it('drops only the last extension from a file name', () => {
    expect(stem('door.lock.log')).toBe('door.lock');
    expect(stem('.hidden')).toBe('.hidden');
  });
});

describe('findingsCsv', () => {
  it('writes the logs, the rules and one quoted row per ID', () => {
    const csv = findingsCsv(
      [comparison({ name: 'BODY', score: 100, reason: 'Byte 3 takes new values', bytes: [3, 4] }), comparison({ id: 0x7df, presence: 'onlyB', keyA: null, reason: 'Rate up, "a lot"' })],
      logInfo({ name: 'idle.log', durationS: 60 }),
      logInfo({ name: 'lock.log', durationS: 30 }),
      { ignoreCounters: true, ignoreChangesWithinA: false },
    );
    const lines = csv.trimEnd().split('\n');
    expect(lines.slice(0, 3)).toEqual(['log A,idle.log,60.0 s', 'log B,lock.log,30.0 s', 'rules,counters and checksums ignored']);
    expect(lines[4]).toBe('bus,id,name,in,a_frames_per_s,b_frames_per_s,score,reason,bytes');
    expect(lines[5]).toBe('can0,450,BODY,both,10.000,10.000,100,Byte 3 takes new values,3 4');
    expect(lines[6]).toBe('can0,7DF,,only B,10.000,10.000,0,"Rate up, ""a lot""",');
  });

  it('leaves the rate of a log of no duration blank', () => {
    const csv = findingsCsv([comparison({ rateB: null })], logInfo(), logInfo(), { ignoreCounters: false, ignoreChangesWithinA: false });
    expect(csv.trimEnd().split('\n')[5]).toBe('can0,450,,both,10.000,,0,No significant changes,');
  });
});
