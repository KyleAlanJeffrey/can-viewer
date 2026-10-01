import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
