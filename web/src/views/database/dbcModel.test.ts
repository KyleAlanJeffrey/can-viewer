import { describe, expect, it } from 'vitest';
import { EXT_FLAG, type MessageDef } from '../../core/api';
import { message } from '../../test/fixtures';
import type { LoadedDbc } from '../types';
import { decoderOf, j1939Matches, j1939Message, messageMatches, overriddenMessages, pgn, sourceAddress } from './dbcModel';

const ext = (id: number) => (id | EXT_FLAG) >>> 0;

const j1939 = (id: number, name: string): MessageDef => message(id, name, { j1939: true });

function loaded(name: string, messages: MessageDef[], channel: string | null = null): LoadedDbc {
  return { id: name, db: { name, messages }, channel, edited: false };
}

// These mirror the tests in crates/can-dbc-model/src/j1939.rs and lib.rs, so the port and the core agree.

describe('pgn', () => {
  it('drops priority, source and the PDU1 destination', () => {
    expect(pgn(0x0cf00400)).toBe(0xf004);
    expect(pgn(ext(0x18f004fe))).toBe(0xf004);
    expect(pgn(0x0c000003)).toBe(0);
    expect(pgn(0x0c002a03)).toBe(0);
  });

  it('keeps the data page and extended data page bits', () => {
    expect(pgn(0x09f80110)).toBe(0x1f801);
    expect(pgn(0x1bfef100)).toBe(0x3fef1);
  });
});

describe('sourceAddress', () => {
  it('is the low byte', () => {
    expect(sourceAddress(ext(0x18fef117))).toBe(0x17);
  });
});

describe('j1939Matches', () => {
  const eec1 = 0x8cf004fe;

  it('matches by PGN whatever the priority and source', () => {
    expect(j1939Matches(eec1, ext(0x0cf00400))).toBe(true);
    expect(j1939Matches(eec1, ext(0x18f00417))).toBe(true);
    expect(j1939Matches(eec1, ext(0x0cf00500))).toBe(false);
  });

  it('never matches a standard frame', () => {
    expect(j1939Matches(eec1, 0x0cf00400)).toBe(false);
  });

  it('needs the same source for proprietary groups', () => {
    const clusterSpeed = ext(0x18ff1d17);
    expect(j1939Matches(clusterSpeed, ext(0x0cff1d17))).toBe(true);
    expect(j1939Matches(clusterSpeed, ext(0x18ff1d03))).toBe(false);
    const proprietaryA = ext(0x18ef0017);
    expect(j1939Matches(proprietaryA, ext(0x18ef2a17))).toBe(true);
    expect(j1939Matches(proprietaryA, ext(0x18ef0018))).toBe(false);
  });
});

describe('messageMatches', () => {
  it('matches the exact ID, and by PGN only for J1939 messages', () => {
    const plain = message(ext(0x0cf004fe), 'EEC1');
    expect(messageMatches(plain, ext(0x0cf004fe))).toBe(true);
    expect(messageMatches(plain, ext(0x18f00417))).toBe(false);
    expect(messageMatches({ ...plain, j1939: true }, ext(0x18f00417))).toBe(true);
  });
});

describe('j1939Message', () => {
  const name = (messages: MessageDef[], id: number) => j1939Message({ name: 'db', messages }, id)?.name ?? null;

  it('prefers the frame ID apart from priority, then its source address', () => {
    const ccvs = [j1939(0x98fef100, 'CCVS_ENGINE'), j1939(0x98fef117, 'CCVS_CLUSTER')];
    expect(name(ccvs, 0x8cfef117)).toBe('CCVS_CLUSTER');
    expect(name(ccvs, 0x8cfef100)).toBe('CCVS_ENGINE');
    expect(name(ccvs, 0x8cfef121)).toBe('CCVS_ENGINE');
  });

  it('ranks PDU1 groups by destination and source, then the first defined', () => {
    const tsc1 = [j1939(0x8c000027, 'TSC1_27_TO_ENGINE'), j1939(0x8c000003, 'TSC1_TO_ENGINE'), j1939(0x8c000103, 'TSC1_TO_RETARDER')];
    expect(name(tsc1, 0x98000103)).toBe('TSC1_TO_RETARDER');
    expect(name(tsc1, 0x98000003)).toBe('TSC1_TO_ENGINE');
    expect(name(tsc1, 0x8c000f03)).toBe('TSC1_TO_ENGINE');
    expect(name(tsc1, 0x8c000199)).toBe('TSC1_27_TO_ENGINE');
  });

  it('ignores messages not marked J1939', () => {
    expect(name([message(0x98fef100, 'CCVS')], 0x8cfef117)).toBeNull();
  });
});

describe('decoderOf', () => {
  // As in j1939_messages_match_by_pgn_after_exact_ids in crates/can-wasm/src/lib.rs.
  const generic = loaded('generic.dbc', [j1939(0x8cf004fe, 'EEC1'), j1939(0x98ff1d17, 'CLUSTER'), j1939(0x98fef1fe, 'CCVS')]);
  const exact = loaded('exact.dbc', [message(0x98fef100, 'CCVS_EXACT')]);
  const decoder = (id: number) => {
    const found = decoderOf([generic, exact], id);
    return found ? `${found.dbc.db.name}:${found.message.name}` : null;
  };

  it('matches J1939 messages by PGN', () => {
    expect(decoder(ext(0x0cf00400))).toBe('generic.dbc:EEC1');
    expect(decoder(ext(0x18ff1d17))).toBe('generic.dbc:CLUSTER');
  });

  it('leaves a proprietary group from another sender undecoded', () => {
    expect(decoder(ext(0x18ff1d03))).toBeNull();
  });

  it('takes an exact ID in a later DBC over a J1939 match in an earlier one', () => {
    expect(decoder(ext(0x18fef100))).toBe('exact.dbc:CCVS_EXACT');
  });
});

describe('overriddenMessages', () => {
  it('reports a message whose ID an earlier DBC already defines', () => {
    const first = loaded('first.dbc', [message(0x100, 'A_100')]);
    const second = loaded('second.dbc', [message(0x100, 'B_100'), message(0x200, 'B_200')]);
    const result = overriddenMessages([first, second]);
    expect([...result.get('first.dbc')!]).toEqual([]);
    expect([...result.get('second.dbc')!]).toEqual([[0x100, 'first.dbc']]);
  });

  it('only compares DBCs whose buses overlap', () => {
    const can0 = loaded('can0.dbc', [message(0x100, 'A')], 'can0');
    const can1 = loaded('can1.dbc', [message(0x100, 'B')], 'can1');
    const everyBus = loaded('all.dbc', [message(0x100, 'C')]);
    expect(overriddenMessages([can0, can1]).get('can1.dbc')!.size).toBe(0);
    expect([...overriddenMessages([can0, everyBus]).get('all.dbc')!]).toEqual([[0x100, 'can0.dbc']]);
    expect([...overriddenMessages([everyBus, can1]).get('can1.dbc')!]).toEqual([[0x100, 'all.dbc']]);
  });

  it('reports a J1939 message whose PGN an earlier J1939 message takes', () => {
    const first = loaded('first.dbc', [j1939(0x8cf004fe, 'EEC1')]);
    const second = loaded('second.dbc', [j1939(ext(0x18f00417), 'EEC1_OTHER')]);
    expect([...overriddenMessages([first, second]).get('second.dbc')!]).toEqual([[ext(0x18f00417), 'first.dbc']]);
  });

  it('keeps a plain message that only an earlier J1939 message matches by PGN', () => {
    const first = loaded('first.dbc', [j1939(0x8cf004fe, 'EEC1')]);
    const second = loaded('second.dbc', [message(ext(0x18f00417), 'EEC1_EXACT')]);
    expect(overriddenMessages([first, second]).get('second.dbc')!.size).toBe(0);
  });
});
