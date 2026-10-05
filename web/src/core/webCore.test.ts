import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScopedDatabase } from './api';
import { WebCore } from './webCore';
import type { Request } from './worker';

/** Stands in for the core worker: the test answers each request, or makes the worker fail. */
class FakeWorker {
  static all: FakeWorker[] = [];
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  readonly requests: Request[] = [];
  terminated = false;

  constructor() {
    FakeWorker.all.push(this);
  }

  postMessage(request: Request) {
    this.requests.push(request);
  }

  terminate() {
    this.terminated = true;
  }

  /** Answers the oldest request for `method`. */
  reply(method: Request['method'], answer: { result: unknown } | { error: string }) {
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
