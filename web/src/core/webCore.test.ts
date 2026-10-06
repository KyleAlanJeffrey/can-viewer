import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOG_SUPERSEDED, type FrameFilter, type MessageSuggestions, type ScopedDatabase } from './api';
import { WebCore } from './webCore';
import type { Request } from './worker';

/** Stands in for the core worker: the test answers each request, or makes the worker fail. */
class FakeWorker {
  static all: FakeWorker[] = [];
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  readonly requests: Request[] = [];
  readonly transfers: Transferable[][] = [];
  terminated = false;

  constructor() {
    FakeWorker.all.push(this);
  }

  postMessage(request: Request, transfer: Transferable[] = []) {
    this.requests.push(request);
    this.transfers.push(transfer);
  }

  terminate() {
    this.terminated = true;
  }

  /** Answers the oldest request for `method`. */
  reply(method: Request['method'], answer: { result: unknown } | { error: string; aborted?: boolean }) {
    const request = this.requests.find((r) => r.method === method);
    if (!request) throw new Error(`No ${method} request`);
    this.onmessage?.({ data: { id: request.id, ...answer } } as MessageEvent);
  }

  /** What the page sees when an error escapes the worker, as a rethrown wasm trap does. */
  fail(message: string) {
    this.onerror?.({ message } as ErrorEvent);
  }
}

const databases: ScopedDatabase[] = [{ channel: null, db: { name: 'car.dbc', messages: [] } }];

beforeEach(() => {
  FakeWorker.all = [];
  vi.stubGlobal('Worker', FakeWorker);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('WebCore', () => {
  it('starts another worker after a wasm trap, with the databases set again', async () => {
    const core = new WebCore();
    const [first] = FakeWorker.all;
    const reset = vi.fn();
    core.onReset(reset);

    const set = core.setDatabases(databases);
    first.reply('setDatabases', { result: undefined });
    await set;

    const open = core.openLog(new Blob(['x']), 'big.log', () => {});
    const count = core.rowCount(1);
    // The worker answers the trapped call, then rethrows the trap where the page sees it.
    first.reply('openLog', { error: 'unreachable' });
    await expect(open).rejects.toThrow('unreachable');
    expect(reset).not.toHaveBeenCalled();
    first.fail('Uncaught RuntimeError: unreachable');

    await expect(count).rejects.toThrow('The CAN core stopped and was restarted. Open the log again.');
    expect(first.terminated).toBe(true);
    expect(FakeWorker.all).toHaveLength(2);
    expect(reset).toHaveBeenCalledTimes(1);
    const second = FakeWorker.all[1];
    expect(second.requests).toEqual([expect.objectContaining({ method: 'setDatabases', args: [databases] })]);

    const ids = core.idSummary();
    second.reply('idSummary', { result: [] });
    await expect(ids).resolves.toEqual([]);
    expect(first.requests.some((r) => r.method === 'idSummary')).toBe(false);

    // A late error from the dead worker starts nothing more.
    first.fail('Uncaught RuntimeError: unreachable');
    expect(FakeWorker.all).toHaveLength(2);
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('rejects an openLog that a newer one superseded with an AbortError, and other errors as they are', async () => {
    const core = new WebCore();
    const [worker] = FakeWorker.all;
    const stale = core.openLog(new Blob(['x']), 'big.log', () => {});
    worker.reply('openLog', { error: LOG_SUPERSEDED, aborted: true });
    await expect(stale).rejects.toMatchObject({ name: 'AbortError', message: LOG_SUPERSEDED });
    const broken = core.openLog(new Blob(['x']), 'broken.log', () => {});
    worker.requests.shift();
    worker.reply('openLog', { error: 'No CAN frames' });
    await expect(broken).rejects.toMatchObject({ name: 'Error', message: 'No CAN frames' });
  });

  it('stops calling a listener once it unsubscribes', async () => {
    const core = new WebCore();
    const reset = vi.fn();
    const unsubscribe = core.onReset(reset);
    const ids = core.idSummary();
    FakeWorker.all[0].reply('idSummary', { result: [] });
    await ids;

    unsubscribe();
    FakeWorker.all[0].fail('Uncaught RuntimeError: unreachable');
    expect(FakeWorker.all).toHaveLength(2);
    expect(reset).not.toHaveBeenCalled();
  });

  it('passes trace filters to the worker and resolves to its counts', async () => {
    const core = new WebCore();
    const [worker] = FakeWorker.all;
    const filter: FrameFilter = {
      channels: [0],
      keys: null,
      kinds: ['data'],
      rules: [{ type: 'byteEquals', byte: 2, value: 0x1f }],
      combine: 'all',
      t0: 12,
      t1: null,
    };

    const preview = core.countFilterMatches(filter);
    const applied = core.setTraceFilter(filter);
    const cleared = core.setTraceFilter(null);
    expect(worker.requests.map((r) => [r.method, r.args])).toEqual([
      ['countFilterMatches', [filter]],
      ['setTraceFilter', [filter]],
      ['setTraceFilter', [null]],
    ]);
    const answer = (i: number, result: unknown) => worker.onmessage?.({ data: { id: worker.requests[i].id, result } } as MessageEvent);
    answer(0, 2481);
    answer(1, 2481);
    answer(2, 0);
    await expect(preview).resolves.toBe(2481);
    await expect(applied).resolves.toBe(2481);
    await expect(cleared).resolves.toBe(0);
  });

  it('gives up on a worker that fails before answering anything', async () => {
    const core = new WebCore();
    const reset = vi.fn();
    core.onReset(reset);
    const pending = core.idSummary();
    FakeWorker.all[0].fail('Failed to fetch the wasm module');

    await expect(pending).rejects.toThrow('Failed to fetch the wasm module');
    await expect(core.rowCount(1)).rejects.toThrow('Failed to fetch the wasm module');
    expect(FakeWorker.all).toHaveLength(1);
    expect(reset).not.toHaveBeenCalled();
  });

  /** Answers the next request, which must be `method`, and forgets it. */
  const answer = async (worker: FakeWorker, method: Request['method'], result: unknown) => {
    await vi.waitFor(() => expect(worker.requests.map((r) => r.method)).toContain(method));
    worker.reply(method, { result });
    worker.requests.splice(
      worker.requests.findIndex((r) => r.method === method),
      1,
    );
  };

  it('suggests for a message in steps, each a request of its own', async () => {
    const core = new WebCore();
    const worker = FakeWorker.all[0];
    const found: MessageSuggestions = { key: 1, frames: 10, sampledFrames: 10, suggestions: [] };
    const hints = { markers: [{ t: 3 }] };
    const suggest = core.suggestSignals(1, hints);
    await vi.waitFor(() => expect(worker.requests).toHaveLength(1));
    expect(worker.requests[0]).toEqual(expect.objectContaining({ method: 'suggestBegin', args: [1, hints] }));
    await answer(worker, 'suggestBegin', 7);
    await answer(worker, 'suggestStep', null);
    await vi.waitFor(() => expect(worker.requests).toEqual([expect.objectContaining({ method: 'suggestStep', args: [7] })]));
    await answer(worker, 'suggestStep', null);
    await answer(worker, 'suggestStep', found);
    await expect(suggest).resolves.toEqual(found);
  });

  it('scans messages one at a time with progress, and stops within one when cancelled', async () => {
    const core = new WebCore();
    const worker = FakeWorker.all[0];
    const found = (key: number): MessageSuggestions => ({ key, frames: 10, sampledFrames: 10, suggestions: [] });
    const progress = vi.fn();
    const scan = core.scanSignals([1, 2], {}, progress);
    await answer(worker, 'suggestBegin', 0);
    await answer(worker, 'suggestStep', found(1));
    await vi.waitFor(() => expect(progress).toHaveBeenLastCalledWith(1, 2, found(1)));
    await answer(worker, 'suggestBegin', 1);
    await answer(worker, 'suggestStep', found(2));
    await expect(scan).resolves.toEqual([found(1), found(2)]);
    expect(progress).toHaveBeenLastCalledWith(2, 2, found(2));

    const controller = new AbortController();
    const cancelled = core.scanSignals([3, 4, 5], {}, () => {}, controller.signal);
    await answer(worker, 'suggestBegin', 2);
    await vi.waitFor(() => expect(worker.requests.map((r) => r.method)).toEqual(['suggestStep']));
    controller.abort();
    await answer(worker, 'suggestStep', null);
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    expect(worker.requests).toEqual([expect.objectContaining({ method: 'suggestDrop', args: [2] })]);
  });

  it('passes over messages a scan finds already suggested for when their turn comes', async () => {
    const core = new WebCore();
    const worker = FakeWorker.all[0];
    const found = (key: number): MessageSuggestions => ({ key, frames: 10, sampledFrames: 10, suggestions: [] });
    const known = new Set([2]);
    const progress = vi.fn();
    const scan = core.scanSignals([1, 2, 3], {}, progress, undefined, (key) => known.has(key));
    await vi.waitFor(() => expect(worker.requests).toHaveLength(1));
    known.add(3);
    expect(worker.requests[0].args[0]).toBe(1);
    await answer(worker, 'suggestBegin', 0);
    await answer(worker, 'suggestStep', found(1));
    await expect(scan).resolves.toEqual([found(1)]);
    expect(worker.requests).toEqual([]);
    expect(progress.mock.calls).toEqual([
      [1, 3, found(1)],
      [2, 3, null],
      [3, 3, null],
    ]);
  });

  it('passes a capture its name, and its frames packed and transferred', async () => {
    const core = new WebCore();
    const [worker] = FakeWorker.all;
    const info = { format: 'capture', frames: 0 };

    const started = core.startCapture('capture.log', 'can0', 1000);
    expect(worker.requests[0]).toEqual(expect.objectContaining({ method: 'startCapture', args: ['capture.log', 'can0', 1000] }));
    worker.reply('startCapture', { result: info });
    expect(await started).toEqual(info);

    const appended = core.appendFrames([{ timeNs: 5, id: 0x123, extended: false, flags: 0, data: Uint8Array.of(9) }]);
    const [packed] = worker.requests[1].args as [Uint8Array];
    expect(packed.length).toBe(15);
    expect(worker.transfers[1]).toEqual([packed.buffer]);
    worker.reply('appendFrames', { result: { ...info, frames: 1 } });
    expect(await appended).toEqual({ ...info, frames: 1 });
  });

  it('passes the compare calls through and unpacks log B byte lanes', async () => {
    const core = new WebCore();
    const [worker] = FakeWorker.all;
    const progress = vi.fn();

    const open = core.openCompareLog(new Blob(['x']), 'door-lock.log', progress);
    const openId = worker.requests.at(-1)!.id;
    worker.onmessage?.({ data: { event: 'progress', id: openId, bytes: 1, total: 2 } } as MessageEvent);
    worker.reply('openCompareLog', { result: { name: 'door-lock.log', frames: 3 } });
    await expect(open).resolves.toMatchObject({ name: 'door-lock.log' });
    expect(progress).toHaveBeenCalledWith({ bytes: 1, total: 2 });

    const options = { ignoreCounters: true, ignoreChangesWithinA: false };
    const found = core.compareLogs(options);
    expect(worker.requests.at(-1)).toMatchObject({ method: 'compareLogs', args: [options] });
    worker.reply('compareLogs', { result: [] });
    await expect(found).resolves.toEqual([]);

    const detail = core.compareBytes(null, 7, options);
    expect(worker.requests.at(-1)).toMatchObject({ method: 'compareBytes', args: [null, 7, options] });
    worker.reply('compareBytes', { result: { len: 0 } });
    await detail;

    const lanes = core.compareByteLanes(7, 3, 2, 0, 10, 50);
    worker.reply('compareByteLanes', { result: Float64Array.from([1, 0.5, 9, 2, 0, 1, 1, 4]) });
    const [b3, b4] = await lanes;
    expect([...b3.x, ...b3.y]).toEqual([0.5, 9]);
    expect([...b4.x, ...b4.y]).toEqual([0, 1, 1, 4]);
  });

  it('sends each log read its own progress, even when one is queued behind the other', async () => {
    const core = new WebCore();
    const [worker] = FakeWorker.all;
    const progressB = vi.fn();
    const progressA = vi.fn();
    const openB = core.openCompareLog(new Blob(['b']), 'b.log', progressB);
    const openA = core.openLog(new Blob(['a']), 'a.log', progressA);
    const [idB, idA] = worker.requests.map((r) => r.id);

    worker.onmessage?.({ data: { event: 'progress', id: idB, bytes: 1, total: 4 } } as MessageEvent);
    worker.reply('openCompareLog', { error: 'Not a log' });
    await expect(openB).rejects.toThrow('Not a log');
    worker.onmessage?.({ data: { event: 'progress', id: idA, bytes: 2, total: 4 } } as MessageEvent);
    worker.reply('openLog', { result: { frames: 1 } });
    await openA;

    expect(progressB).toHaveBeenCalledTimes(1);
    expect(progressA).toHaveBeenCalledWith({ bytes: 2, total: 4 });
  });
});
