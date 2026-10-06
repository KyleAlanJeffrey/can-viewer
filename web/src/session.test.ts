import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeLocks, installLocks, removeLocks } from './test/fakeLocks';

type Session = typeof import('./session');

/** Each import is a fresh copy of the module, like a separate tab of the app. */
async function openTab(): Promise<Session> {
  vi.resetModules();
  return import('./session');
}

/** Writes straight to the store, as an older version of the app would have. */
function putRaw(key: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('freecan-studio', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('session');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('session', 'readwrite');
      tx.objectStore('session').put(value, key);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
  });
}

/** In-memory BroadcastChannel: delivers to every other channel of the same name, as browsers do. */
class FakeBroadcastChannel {
  static open: FakeBroadcastChannel[] = [];
  onmessage: ((e: MessageEvent) => void) | null = null;

  constructor(readonly name: string) {
    FakeBroadcastChannel.open.push(this);
  }

  postMessage(data: unknown) {
    for (const other of FakeBroadcastChannel.open) {
      if (other !== this && other.name === this.name) queueMicrotask(() => other.onmessage?.(new MessageEvent('message', { data })));
    }
  }
}

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
  FakeBroadcastChannel.open = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('save and loadSaved', () => {
  it('round-trips values by key', async () => {
    const session = await openTab();
    expect(await session.loadSaved('ui')).toBeUndefined();
    const ui = { view: 'plot', selected: 3, pinnedTime: 1.5, plots: [{ key: 3, signal: 'Speed', color: '#000' }] };
    expect(await session.save('ui', ui)).toBe(true);
    expect(await session.save('views', [['re.mode', { scope: 'app', value: 'bytes' }]])).toBe(true);
    expect(await session.loadSaved('ui')).toEqual(ui);
    expect(await session.loadSaved('views')).toEqual([['re.mode', { scope: 'app', value: 'bytes' }]]);
  });

  it('forgets a key', async () => {
    const session = await openTab();
    await session.save('ui', { view: 'trace' });
    await session.forget('ui');
    expect(await session.loadSaved('ui')).toBeUndefined();
  });

  it('fails soft when storage is unavailable', async () => {
    vi.stubGlobal('indexedDB', {
      open: () => {
        throw new Error('storage is disabled');
      },
    });
    const session = await openTab();
    expect(await session.loadSaved('ui')).toBeUndefined();
    expect(await session.save('ui', {})).toBe(false);
    expect(await session.loadSavedDbcs()).toBeUndefined();
    expect(await session.saveDbcs([])).toBe('failed');
  });
});

describe('saved DBCs', () => {
  it('round-trips a list and bumps the revision on each save', async () => {
    const session = await openTab();
    expect(await session.loadSavedDbcs()).toBeUndefined();
    expect(await session.saveDbcs(['a.dbc'])).toBe('saved');
    expect(await session.saveDbcs(['a.dbc', 'b.dbc'])).toBe('saved');
    expect(await session.loadSavedDbcs()).toEqual(['a.dbc', 'b.dbc']);

    const reloaded = await openTab();
    expect(await reloaded.loadSavedDbcs()).toEqual(['a.dbc', 'b.dbc']);
  });

  it('reads a bare array from the first version as revision 0', async () => {
    await putRaw('dbcs', ['legacy.dbc']);
    const session = await openTab();
    expect(await session.loadSavedDbcs()).toEqual(['legacy.dbc']);
    expect(await session.saveDbcs(['legacy.dbc', 'new.dbc'])).toBe('saved');
    expect(await session.loadSavedDbcs()).toEqual(['legacy.dbc', 'new.dbc']);
  });

  it('refuses to overwrite DBCs another tab saved since this one read them', async () => {
    const tabA = await openTab();
    const tabB = await openTab();
    await tabA.loadSavedDbcs();
    await tabB.loadSavedDbcs();

    expect(await tabB.saveDbcs(['from B'])).toBe('saved');
    expect(await tabA.saveDbcs(['from A'])).toBe('conflict');
    expect(await tabA.loadSavedDbcs()).toEqual(['from B']);

    expect(await tabA.saveDbcs(['from B', 'from A'])).toBe('saved');
    expect(await tabB.saveDbcs(['stale B'])).toBe('conflict');
  });

  it('detects a revision bumped by a writer outside this module', async () => {
    const session = await openTab();
    await session.saveDbcs(['mine']);
    await putRaw('dbcs', { revision: 5, dbcs: ['theirs'] });
    expect(await session.saveDbcs(['mine again'])).toBe('conflict');
    expect(await session.loadSavedDbcs()).toEqual(['theirs']);
  });

  it('tells other tabs about a save until they unsubscribe', async () => {
    const tabA = await openTab();
    const tabB = await openTab();
    await tabA.loadSavedDbcs();
    await tabB.loadSavedDbcs();
    const changedForA = vi.fn();
    const changedForB = vi.fn();
    const unsubscribeA = tabA.onDbcsChangedElsewhere(changedForA);
    tabB.onDbcsChangedElsewhere(changedForB);

    await tabB.saveDbcs(['from B']);
    await vi.waitFor(() => expect(changedForA).toHaveBeenCalledTimes(1));
    expect(changedForB).not.toHaveBeenCalled();

    unsubscribeA();
    await tabB.saveDbcs(['from B', 'again']);
    await Promise.resolve();
    expect(changedForA).toHaveBeenCalledTimes(1);
  });
});

describe('kept captures', () => {
  let locks: FakeLocks;
  beforeEach(() => {
    locks = installLocks();
    localStorage.clear();
  });
  afterEach(() => removeLocks());

  const capture = (id: string, startedAtMs: number, frames = 1) => ({
    id,
    name: `${id}.log`,
    bus: 'can0',
    startedAtMs,
    bitrate: 500_000,
    layout: 1,
    frames,
    bytes: 0,
  });
  const chunk = (seq: number) => ({ seq, bytes: Uint8Array.of(seq).buffer });

  async function chunksOf(session: Session, id: string): Promise<number[]> {
    const read: number[] = [];
    await session.readCaptureChunks(id, async (bytes) => void read.push(bytes[0]));
    return read;
  }

  it('reads the chunks back in order, a few at a time, and drops the ones before a given chunk', async () => {
    const session = await openTab();
    const kept = capture('a', 1);
    for (let seq = 0; seq < 20; seq++) await session.writeKeptCapture(kept, chunk(seq));
    expect(await chunksOf(session, 'a')).toEqual([...Array(20).keys()]);
    await session.writeKeptCapture(kept, chunk(20), 15);
    expect(await chunksOf(session, 'a')).toEqual([15, 16, 17, 18, 19, 20]);
    expect(await session.keptCaptures()).toEqual([kept]);
  });

  it('forgets one capture, leaving the others and the saved session', async () => {
    const session = await openTab();
    await session.save('ui', { view: 'trace' });
    await session.writeKeptCapture(capture('a', 1), chunk(1));
    await session.writeKeptCapture(capture('b', 2), chunk(2));
    expect(await session.forgetCapture('a')).toBe(true);
    expect((await session.keptCaptures()).map((c) => c.id)).toEqual(['b']);
    expect(await chunksOf(session, 'a')).toEqual([]);
    expect(await chunksOf(session, 'b')).toEqual([2]);
    expect(await session.loadSaved('ui')).toEqual({ view: 'trace' });
  });

  it('claims the newest capture no tab holds, and only once', async () => {
    const session = await openTab();
    await session.writeKeptCapture(capture('old', 1), chunk(1));
    await session.writeKeptCapture(capture('new', 3), chunk(3));
    await session.writeKeptCapture(capture('live', 5), chunk(5));
    const liveTab = await session.lockCapture('live');
    expect(liveTab).not.toBeNull();

    const claimed = await session.claimKeptCapture();
    expect(claimed?.capture.id).toBe('new');
    expect(locks.holds('freecan-studio-capture-new')).toBe(true);
    // Another tab loading now gets the next one.
    const other = await (await openTab()).claimKeptCapture();
    expect(other?.capture.id).toBe('old');

    await claimed!.held.letGo();
    expect(claimed!.held.kept).toBe(true);
    expect((await session.claimKeptCapture())?.capture.id).toBe('new');
  });

  it('deletes, rather than offers, a capture no tab holds with no frames or another layout', async () => {
    const session = await openTab();
    await session.writeKeptCapture(capture('empty', 3, 0));
    await session.writeKeptCapture({ ...capture('future', 2), layout: 2 }, chunk(2));
    await session.writeKeptCapture(capture('good', 1), chunk(1));
    expect((await session.claimKeptCapture())?.capture.id).toBe('good');
    expect((await session.keptCaptures()).map((c) => c.id)).toEqual(['good']);
  });

  it('forgets a claimed capture before letting go of it', async () => {
    const session = await openTab();
    await session.writeKeptCapture(capture('a', 1), chunk(1));
    const claimed = await session.claimKeptCapture();
    await claimed!.held.forget();
    expect(claimed!.held.kept).toBe(false);
    expect(locks.holds('freecan-studio-capture-a')).toBe(false);
    expect(await session.keptCaptures()).toEqual([]);
    expect(await session.claimKeptCapture()).toBeUndefined();
  });

  it('passes over a capture its tab deleted just before letting go of it', async () => {
    const session = await openTab();
    const otherTab = await openTab();
    await session.writeKeptCapture(capture('gone', 2), chunk(2));
    await session.writeKeptCapture(capture('older', 1), chunk(1));
    const request = FakeLocks.prototype.request;
    vi.spyOn(locks, 'request').mockImplementationOnce(async (...args) => {
      await otherTab.forgetCapture('gone');
      return request.apply(locks, args);
    });
    expect((await session.claimKeptCapture())?.capture.id).toBe('older');
    expect(locks.holds('freecan-studio-capture-gone')).toBe(false);
  });

  it('tries a delete again, and holds on to a capture it still could not delete', async () => {
    const session = await openTab();
    await session.writeKeptCapture(capture('a', 1), chunk(1));
    const refuse = () => {
      throw new DOMException('Nope.', 'UnknownError');
    };
    vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementationOnce(refuse);
    expect(await session.forgetCapture('a')).toBe(true);
    expect(await session.keptCaptures()).toEqual([]);

    await session.writeKeptCapture(capture('b', 1), chunk(1));
    const claimed = await session.claimKeptCapture();
    vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementation(refuse);
    await claimed!.held.forget();
    vi.restoreAllMocks();
    expect(locks.holds('freecan-studio-capture-b')).toBe(true);
    expect(await session.keptCaptures()).toHaveLength(1);

    // The tab closes; the next page load deletes it rather than bringing it back unsaved.
    locks.dropAll();
    expect(await (await openTab()).claimKeptCapture()).toBeUndefined();
    expect(await session.keptCaptures()).toEqual([]);
    expect(localStorage.getItem('freecan-studio.forgotten-captures')).toBeNull();
  });

  it('tells a restore cut short by the page going away from one that crashed, once', async () => {
    const session = await openTab();
    expect(session.takeRestoreLeft('a')).toBe(false);
    session.markRestoreLeft('a');
    // Another tab's restore, cut short too, keeps its own note.
    (await openTab()).markRestoreLeft('b');
    expect(session.takeRestoreLeft('c')).toBe(false);
    expect(session.takeRestoreLeft('a')).toBe(true);
    expect(session.takeRestoreLeft('a')).toBe(false);
    expect(session.takeRestoreLeft('b')).toBe(true);
  });

  it('writes nothing for a capture being deleted, or no longer wanted, once storage is open', async () => {
    const session = await openTab();
    await session.writeKeptCapture(capture('a', 1), chunk(1), 0, () => false);
    expect(await session.keptCaptures()).toEqual([]);
    localStorage.setItem('freecan-studio.forgotten-captures', JSON.stringify(['a']));
    await session.writeKeptCapture(capture('a', 1), chunk(1));
    expect(await session.keptCaptures()).toEqual([]);
    expect(await chunksOf(session, 'a')).toEqual([]);
  });

  it('drops the notes of deletes that have since landed', async () => {
    const session = await openTab();
    await session.writeKeptCapture(capture('a', 1), chunk(1));
    await session.writeKeptCapture(capture('b', 2), chunk(2));
    // b's delete failed; gone's landed, but its note stayed.
    localStorage.setItem('freecan-studio.forgotten-captures', JSON.stringify(['gone', 'b']));
    expect((await session.claimKeptCapture())?.capture.id).toBe('a');
    expect(localStorage.getItem('freecan-studio.forgotten-captures')).toBeNull();
    expect((await session.keptCaptures()).map((c) => c.id)).toEqual(['a']);
  });

  it('claims nothing without Web Locks, as it could not tell whether another tab has the capture', async () => {
    const session = await openTab();
    await session.writeKeptCapture(capture('a', 1), chunk(1));
    removeLocks();
    expect(session.canKeepCaptures()).toBe(false);
    expect(await session.claimKeptCapture()).toBeUndefined();
    expect(await session.keptCaptures()).toHaveLength(1);
  });
});
