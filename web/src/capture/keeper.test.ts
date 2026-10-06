import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CaptureFrame } from '../core/api';
import { unpackFrames } from '../core/captureFrames';
import { claimKeptCapture, forgetCapture, keptCaptures, readCaptureChunks, writeKeptCapture, type HeldCapture } from '../session';
import { installLocks, removeLocks, type FakeLocks } from '../test/fakeLocks';
import { CaptureKeeper, KEEPER_DEFAULTS, notKeptDetail } from './keeper';

const failure = vi.hoisted(() => ({ next: null as unknown, forget: false, hang: false }));
vi.mock('../session', async (importOriginal) => {
  const real = await importOriginal<typeof import('../session')>();
  return {
    ...real,
    writeKeptCapture: (...args: Parameters<typeof real.writeKeptCapture>) => {
      const error = failure.next;
      failure.next = null;
      if (failure.hang) return new Promise<void>(() => {});
      return error ? Promise.reject(error) : real.writeKeptCapture(...args);
    },
    forgetCapture: (id: string) => (failure.forget ? Promise.resolve(false) : real.forgetCapture(id)),
  };
});

const frame = (timeNs: number, byte = 0): CaptureFrame => ({ timeNs, id: 0x123, extended: false, flags: 0, data: Uint8Array.of(byte) });
const frames = (from: number, count: number) => Array.from({ length: count }, (_, i) => frame(from + i, (from + i) & 0xff));
const info = { name: 'capture.log', bus: 'can0', startedAtMs: 1_700_000_000_000, bitrate: 500_000 };
/** What a packed frame of `frame` takes: a 14-byte header and one payload byte. */
const FRAME_BYTES = 15;

async function storedTimes(id: string): Promise<number[]> {
  const times: number[] = [];
  await readCaptureChunks(id, async (bytes) => void times.push(...unpackFrames(bytes).map((f) => f.timeNs)));
  return times;
}

async function onlyKept() {
  const kept = await keptCaptures();
  expect(kept).toHaveLength(1);
  return kept[0];
}

let locks: FakeLocks;
beforeEach(async () => {
  failure.forget = false;
  failure.hang = false;
  localStorage.clear();
  vi.stubGlobal('indexedDB', new IDBFactory());
  locks = installLocks();
  // session.ts keeps the database it opened first, so what a test stored is deleted here.
  for (const kept of await keptCaptures()) await forgetCapture(kept.id);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  removeLocks();
});

describe('CaptureKeeper', () => {
  it('writes the frames as chunks, every interval or once enough wait, and the last ones on stop', async () => {
    // fake-indexeddb runs on timeouts, so only the keeper's interval is faked.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const keeper = new CaptureKeeper({ intervalMs: 1000, maxFrames: 10 });
    await keeper.begin(info);
    const kept = await onlyKept();
    expect(kept).toMatchObject({ ...info, layout: 1, frames: 0, bytes: 0 });
    expect(locks.holds(`freecan-studio-capture-${kept.id}`)).toBe(true);

    keeper.add(frames(0, 3));
    keeper.add(frames(3, 3));
    expect(await storedTimes(kept.id)).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await storedTimes(kept.id)).toEqual([0, 1, 2, 3, 4, 5]);

    keeper.add(frames(6, 10));
    await vi.waitFor(async () => expect(await storedTimes(kept.id)).toHaveLength(16));

    keeper.add(frames(16, 2));
    await keeper.stop();
    expect(await storedTimes(kept.id)).toEqual([...Array(18).keys()]);
    expect(await onlyKept()).toMatchObject({ frames: 18, bytes: 18 * FRAME_BYTES });
    // Stopped, the capture is still held, as it is still shown unsaved.
    expect(keeper.kept).toBe(true);
    expect(await claimKeptCapture()).toBeUndefined();
    keeper.add(frames(18, 1));
    await keeper.flush();
    expect(await storedTimes(kept.id)).toHaveLength(18);
  });

  it('forgets the capture it replaces once it begins', async () => {
    const replaced: HeldCapture = { kept: true, forget: vi.fn(async () => {}), letGo: vi.fn(async () => {}) };
    const keeper = new CaptureKeeper();
    keeper.replaces = replaced;
    await keeper.begin(info);
    expect(replaced.forget).toHaveBeenCalledTimes(1);
    await keeper.forget();
  });

  it('deletes what it stored, and lets go of it, when forgotten', async () => {
    const keeper = new CaptureKeeper();
    await keeper.begin(info);
    const { id } = await onlyKept();
    keeper.add(frames(0, 5));
    // A write under way still lands before the delete.
    void keeper.flush();
    await keeper.forget();
    expect(keeper.kept).toBe(false);
    expect(await keptCaptures()).toEqual([]);
    expect(await storedTimes(id)).toEqual([]);
    expect(locks.holds(`freecan-studio-capture-${id}`)).toBe(false);
    expect(await claimKeptCapture()).toBeUndefined();
  });

  it('leaves what it stored for a reload to restore when it lets go', async () => {
    const keeper = new CaptureKeeper();
    await keeper.begin(info);
    keeper.add(frames(0, 5));
    await keeper.letGo();
    const claimed = await claimKeptCapture();
    expect(claimed?.capture).toMatchObject({ name: 'capture.log', frames: 5 });
    expect(await storedTimes(claimed!.capture.id)).toEqual([0, 1, 2, 3, 4]);
  });

  it('stops keeping the capture, deleting what it stored, and says so once, when storage is full', async () => {
    const keeper = new CaptureKeeper();
    const notKept = vi.fn();
    keeper.onNotKept = notKept;
    await keeper.begin(info);
    keeper.add(frames(0, 5));
    await keeper.flush();
    keeper.add(frames(5, 5));
    failure.next = new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    await keeper.flush();
    expect(notKept).toHaveBeenCalledWith('full');
    expect(keeper.kept).toBe(false);
    expect(await keptCaptures()).toEqual([]);

    keeper.add(frames(10, 5));
    await keeper.stop();
    expect(await keptCaptures()).toEqual([]);
    expect(notKept).toHaveBeenCalledTimes(1);
    expect(notKeptDetail('full')).toBe('Its storage is full.');
  });

  it('counts any other refused write as storage that may be full or turned off', async () => {
    const keeper = new CaptureKeeper();
    const notKept = vi.fn();
    keeper.onNotKept = notKept;
    failure.next = new DOMException('Nope.', 'UnknownError');
    await keeper.begin(info);
    expect(notKept).toHaveBeenCalledWith('failed');
    expect(await keptCaptures()).toEqual([]);
  });

  it('stops keeping a capture that outgrows the storage left by every other capture kept', async () => {
    await writeKeptCapture({ ...info, id: 'other tab', layout: 1, frames: 10, bytes: 10 * FRAME_BYTES });
    const keeper = new CaptureKeeper({ maxBytes: 20 * FRAME_BYTES });
    const notKept = vi.fn();
    keeper.onNotKept = notKept;
    await keeper.begin(info);
    keeper.add(frames(0, 10));
    await keeper.flush();
    expect(notKept).not.toHaveBeenCalled();
    keeper.add(frames(10, 1));
    await keeper.flush();
    expect(notKept).toHaveBeenCalledWith('tooLarge');
    expect((await keptCaptures()).map((c) => c.id)).toEqual(['other tab']);
    expect(notKeptDetail('tooLarge', { ...KEEPER_DEFAULTS, maxBytes: 512 * 1024 ** 2 })).toBe('The unsaved captures kept in this browser would need more than 512 MB.');
  });

  it('counts again, before giving up, the storage other tabs have since let go of', async () => {
    await writeKeptCapture({ ...info, id: 'other tab', layout: 1, frames: 15, bytes: 15 * FRAME_BYTES });
    const keeper = new CaptureKeeper({ maxBytes: 20 * FRAME_BYTES });
    const notKept = vi.fn();
    keeper.onNotKept = notKept;
    await keeper.begin(info);
    await forgetCapture('other tab');
    keeper.add(frames(0, 10));
    await keeper.flush();
    expect(notKept).not.toHaveBeenCalled();
    expect(await onlyKept()).toMatchObject({ frames: 10 });
    await keeper.forget();
  });

  it('counts again, every few chunks, the storage other tabs have since taken', async () => {
    const keeper = new CaptureKeeper({ maxBytes: 20 * FRAME_BYTES, recountEvery: 2 });
    const notKept = vi.fn();
    keeper.onNotKept = notKept;
    await keeper.begin(info);
    await writeKeptCapture({ ...info, id: 'other tab', layout: 1, frames: 15, bytes: 15 * FRAME_BYTES });
    keeper.add(frames(0, 3));
    await keeper.flush();
    expect(notKept).not.toHaveBeenCalled();
    keeper.add(frames(3, 3));
    await keeper.flush();
    expect(notKept).toHaveBeenCalledWith('tooLarge');
    expect((await keptCaptures()).map((c) => c.id)).toEqual(['other tab']);
  });

  it('gives up once storage falls too far behind', async () => {
    const keeper = new CaptureKeeper({ maxFrames: 1000, maxWaitingBytes: 5 * FRAME_BYTES });
    const notKept = vi.fn();
    keeper.onNotKept = notKept;
    await keeper.begin(info);
    const { id } = await onlyKept();
    keeper.add(frames(0, 5));
    keeper.add(frames(5, 1));
    await keeper.flush();
    expect(notKept).toHaveBeenCalledWith('slow');
    expect(notKeptDetail('slow')).toBe("Its storage couldn't keep up with the capture.");
    expect(await keptCaptures()).toEqual([]);
    expect(locks.holds(`freecan-studio-capture-${id}`)).toBe(false);
  });

  it('keeps the frames that arrive before it has begun', async () => {
    const keeper = new CaptureKeeper();
    const begun = keeper.begin(info);
    keeper.add(frames(0, 3));
    await begun;
    keeper.add(frames(3, 2));
    await keeper.stop();
    expect(await storedTimes((await onlyKept()).id)).toEqual([0, 1, 2, 3, 4]);
    await keeper.forget();
  });

  it('keeps the frames of a capture stopped before it has begun', async () => {
    const keeper = new CaptureKeeper();
    void keeper.begin(info);
    keeper.add(frames(0, 3));
    await keeper.stop();
    expect(keeper.kept).toBe(true);
    expect(await storedTimes((await onlyKept()).id)).toEqual([0, 1, 2]);
    keeper.add(frames(3, 1));
    await keeper.flush();
    expect(await storedTimes((await onlyKept()).id)).toEqual([0, 1, 2]);
    await keeper.forget();
  });

  it('finishes a stop when storage hangs, giving up keeping the capture', async () => {
    const keeper = new CaptureKeeper({ stopWaitMs: 50 });
    const notKept = vi.fn();
    keeper.onNotKept = notKept;
    await keeper.begin(info);
    failure.hang = true;
    keeper.add(frames(0, 3));
    await keeper.stop();
    expect(notKept).toHaveBeenCalledWith('slow');
    expect(keeper.kept).toBe(false);
  });

  it('holds on to a capture it could not delete, so no other tab restores it', async () => {
    const keeper = new CaptureKeeper();
    await keeper.begin(info);
    const { id } = await onlyKept();
    failure.forget = true;
    await keeper.forget();
    expect(locks.holds(`freecan-studio-capture-${id}`)).toBe(true);
    expect(await claimKeptCapture()).toBeUndefined();
  });

  it('drops whole chunks a rolling capture has dropped', async () => {
    const keeper = new CaptureKeeper();
    await keeper.begin(info);
    for (const from of [0, 10, 20]) {
      keeper.add(frames(from, 10));
      await keeper.flush();
    }
    // Only part of the second chunk is past it, so that chunk stays.
    keeper.trim(15);
    await keeper.flush();
    const kept = await onlyKept();
    expect(await storedTimes(kept.id)).toEqual([...Array(20).keys()].map((i) => i + 10));
    expect(kept).toMatchObject({ frames: 20, bytes: 20 * FRAME_BYTES, trimmedBeforeNs: 15 });
    await keeper.forget();
  });

  it('keeps nothing in a browser without Web Locks', async () => {
    removeLocks();
    const keeper = new CaptureKeeper();
    await keeper.begin(info);
    keeper.add(frames(0, 5));
    await keeper.stop();
    expect(keeper.kept).toBe(false);
    expect(await keptCaptures()).toEqual([]);
  });

  it('lets go of the capture when forgotten while it begins', async () => {
    const keeper = new CaptureKeeper();
    // Forgotten as it looks up the other captures, holding the lock by then.
    const getAll = IDBObjectStore.prototype.getAll;
    vi.spyOn(IDBObjectStore.prototype, 'getAll').mockImplementationOnce(function (this: IDBObjectStore, ...args) {
      expect([...locks.heldNames()]).toHaveLength(1);
      void keeper.forget();
      return getAll.apply(this, args);
    });
    await keeper.begin(info);
    expect([...locks.heldNames()]).toEqual([]);
    expect(await keptCaptures()).toEqual([]);
    expect(keeper.kept).toBe(false);
  });

  it('never begins once stopped', async () => {
    const keeper = new CaptureKeeper();
    await keeper.stop();
    await keeper.begin(info);
    expect(await keptCaptures()).toEqual([]);
  });
});
