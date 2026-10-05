import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from './worker';

class FakeSession {
  hasB = false;
  free() {}
  set_databases() {}
  set_file_name() {}
  reserve_for_bytes() {}
  push_chunk() {}
  finish() {
    return JSON.stringify({ frames: 10, durationS: 30 });
  }
  compare_begin(name: string) {
    if (name === 'broken.log') throw new Error('No CAN frames');
  }
  compare_push_chunk() {}
  compare_finish() {
    this.hasB = true;
    return JSON.stringify({ frames: 3, durationS: 28 });
  }
  compare_log_info() {
    return this.hasB ? JSON.stringify({ frames: 3, durationS: 28 }) : undefined;
  }
  close_compare_log() {
    this.hasB = false;
  }
  swap_compare_log() {
    return JSON.stringify({ frames: 3, durationS: 28 });
  }
  row_count(key: number): number {
    if (key === 1) throw new WebAssembly.RuntimeError('unreachable');
    if (key === 2) throw new Error('No such ID');
    return 7;
  }
}

vi.mock('./pkg/can_wasm.js', () => ({
  default: async () => ({ memory: null }),
  Session: FakeSession,
  export_dbc: () => '',
  parse_dbc: () => '{}',
}));

interface Port {
  onmessage: ((e: { data: Request }) => void) | null;
  postMessage: ReturnType<typeof vi.fn>;
}

/** Loads a fresh copy of the worker module with `self` as a port the test drives. */
async function startWorker(): Promise<Port> {
  const port: Port = { onmessage: null, postMessage: vi.fn() };
  vi.stubGlobal('self', port);
  vi.resetModules();
  await import('./worker');
  return port;
}

/** Sends a rowCount request and resolves to the worker's reply. */
function ask(port: Port, id: number, key: number): Promise<unknown> {
  // vi.waitFor would advance the fake timers and fire the rethrow too early.
  const reply = new Promise((resolve) => port.postMessage.mockImplementationOnce(resolve));
  port.onmessage?.({ data: { id, method: 'rowCount', args: [key] } });
  return reply;
}

/** Sends any request and resolves to the worker's reply. */
function call(port: Port, id: number, method: Request['method'], ...args: unknown[]): Promise<unknown> {
  const reply = new Promise((resolve) => port.postMessage.mockImplementation((message: { event?: string }) => message.event || resolve(message)));
  port.onmessage?.({ data: { id, method, args } });
  return reply;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout'] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('core worker', () => {
  it('answers a call that trapped, then rethrows the trap outside the call for the page to restart it', async () => {
    const port = await startWorker();
    expect(await ask(port, 1, 1)).toEqual({ id: 1, error: 'unreachable' });
    expect(() => vi.runAllTimers()).toThrow(WebAssembly.RuntimeError);
  });

  it('answers an ordinary error without rethrowing it, and keeps answering', async () => {
    const port = await startWorker();
    expect(await ask(port, 1, 2)).toEqual({ id: 1, error: 'No such ID' });
    expect(vi.getTimerCount()).toBe(0);
    expect(await ask(port, 2, 3)).toEqual({ id: 2, result: 7 });
  });

  it("reads log B beside the open log and keeps each log's name through a swap", async () => {
    const port = await startWorker();
    await call(port, 1, 'openLog', new Blob(['(1.0) can0 123#00\n']), 'idle.log');
    expect(await call(port, 2, 'compareLogInfo')).toEqual({ id: 2, result: null });

    const opened = (await call(port, 3, 'openCompareLog', new Blob(['(2.0) can0 123#01\n']), 'door-lock.log')) as { result: Record<string, unknown> };
    expect(opened.result).toMatchObject({ name: 'door-lock.log', frames: 3 });
    expect(await call(port, 4, 'compareLogInfo')).toMatchObject({ result: { name: 'door-lock.log', durationS: 28 } });

    expect(await call(port, 5, 'swapCompareLog')).toMatchObject({ result: { name: 'door-lock.log' } });
    expect(await call(port, 6, 'compareLogInfo')).toMatchObject({ result: { name: 'idle.log' } });

    await call(port, 7, 'closeCompareLog');
    expect(await call(port, 8, 'compareLogInfo')).toEqual({ id: 8, result: null });
  });

  it('leaves no log B after a failed read', async () => {
    const port = await startWorker();
    expect(await call(port, 1, 'openCompareLog', new Blob(['x']), 'broken.log')).toEqual({ id: 1, error: 'No CAN frames' });
    expect(await call(port, 2, 'compareLogInfo')).toEqual({ id: 2, result: null });
  });
});
