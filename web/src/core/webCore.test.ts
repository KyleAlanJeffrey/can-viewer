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

  it('names a capture, and hands its frames to the worker packed and transferred', async () => {
    const core = new WebCore();
    const [worker] = FakeWorker.all;
    const info = { format: 'capture', frames: 0 };

    const started = core.startCapture('capture.log', 'can0', 1000);
    expect(worker.requests[0]).toEqual(expect.objectContaining({ method: 'startCapture', args: ['can0', 1000] }));
    worker.reply('startCapture', { result: info });
    expect(await started).toEqual({ ...info, name: 'capture.log' });

    const appended = core.appendFrames([{ timeNs: 5, id: 0x123, extended: false, flags: 0, data: Uint8Array.of(9) }]);
    const [packed] = worker.requests[1].args as [Uint8Array];
    expect(packed.length).toBe(15);
    expect(worker.transfers[1]).toEqual([packed.buffer]);
    worker.reply('appendFrames', { result: { ...info, frames: 1 } });
    expect(await appended).toEqual({ ...info, frames: 1, name: 'capture.log' });

    const ended = core.endCapture();
    worker.reply('endCapture', { result: { ...info, frames: 1 } });
    expect((await ended).name).toBe('capture.log');
  });
});
