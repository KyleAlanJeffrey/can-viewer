import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from './worker';

class FakeSession {
  static captures: [string, number][] = [];
  static filters: string[] = [];
  pushed: Uint8Array[] = [];
  hasB = false;
  free() {}
  set_databases() {}
  start_capture(channel: string, startedAtMs: number) {
    FakeSession.captures.push([channel, startedAtMs]);
  }
  log_info() {
    return JSON.stringify({ format: 'capture', frames: this.pushed.length });
  }
  push_frames(packed: Uint8Array) {
    this.pushed.push(packed);
    return this.log_info();
  }
  finish_capture() {
    return this.log_info();
  }
  set_trace_filter(json: string): number {
    FakeSession.filters.push(json);
    return json === 'null' ? 0 : 3;
  }
  /** Steps each count takes before it is done. */
  static countSteps = 1;
  private counting: { steps: number } | null = null;
  count_begin(json: string) {
    FakeSession.filters.push(json);
    this.counting = { steps: FakeSession.countSteps };
  }
  count_step(): number | undefined {
    if (!this.counting) throw new Error('no count is running');
    if (--this.counting.steps > 0) return undefined;
    this.counting = null;
    return 5;
  }
  count_running() {
    return this.counting !== null;
  }
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
  suggest_signals(key: number, hints: string): string {
    return JSON.stringify({ key, hints: JSON.parse(hints) });
  }
  private chunks: Uint8Array[] = [];
  export_log(format: string) {
    if (format !== 'csv') throw new Error('Not a format');
    this.chunks = [new Uint8Array([1, 2]), new Uint8Array([3])];
  }
  export_chunk(): Uint8Array | undefined {
    return this.chunks.shift();
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

/** Sends a request (rowCount unless named) and resolves to the worker's reply. */
function ask(port: Port, id: number, key: number, method: Request['method'] = 'rowCount', ...rest: unknown[]): Promise<unknown> {
  // vi.waitFor would advance the fake timers and fire the rethrow too early.
  const reply = new Promise((resolve) => port.postMessage.mockImplementationOnce(resolve));
  port.onmessage?.({ data: { id, method, args: [key, ...rest] } });
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

  it('hands over an exported log as one Blob of every chunk', async () => {
    const port = await startWorker();
    const reply = new Promise<{ result: Blob }>((resolve) => port.postMessage.mockImplementationOnce(resolve));
    port.onmessage?.({ data: { id: 1, method: 'exportLog', args: ['csv'] } });
    const { result } = await reply;
    expect(result).toBeInstanceOf(Blob);
    expect([...new Uint8Array(await result.arrayBuffer())]).toEqual([1, 2, 3]);
  });

  it('answers an ordinary error without rethrowing it, and keeps answering', async () => {
    const port = await startWorker();
    expect(await ask(port, 1, 2)).toEqual({ id: 1, error: 'No such ID' });
    expect(vi.getTimerCount()).toBe(0);
    expect(await ask(port, 2, 3)).toEqual({ id: 2, result: 7 });
  });

  it('passes discovery hints to the session as JSON, and none as an empty object', async () => {
    const port = await startWorker();
    const hints = { markers: [{ t: 12 }], reference: { key: 5, signal: 'Speed' } };
    expect(await ask(port, 1, 9, 'suggestSignals', hints)).toEqual({ id: 1, result: { key: 9, hints } });
    expect(await ask(port, 2, 9, 'suggestSignals')).toEqual({ id: 2, result: { key: 9, hints: {} } });
  });

  it('runs a capture in a fresh session, without the old log B', async () => {
    const port = await startWorker();
    await call(port, 1, 'openLog', new Blob(['(1.0) can0 123#00\n']), 'idle.log');
    await call(port, 2, 'openCompareLog', new Blob(['(2.0) can0 123#01\n']), 'door-lock.log');
    const started = await call(port, 3, 'startCapture', 'capture-1.log', 'can0', 1000);
    expect(started).toEqual({ id: 3, result: { name: 'capture-1.log', format: 'capture', frames: 0, parseMs: 0, wasmBytes: 0 } });
    expect(FakeSession.captures.at(-1)).toEqual(['can0', 1000]);
    expect(await call(port, 4, 'compareLogInfo')).toEqual({ id: 4, result: null });
    expect(await call(port, 5, 'appendFrames', Uint8Array.of(1))).toMatchObject({ result: { name: 'capture-1.log', frames: 1 } });
    expect(await call(port, 6, 'endCapture')).toMatchObject({ result: { name: 'capture-1.log', frames: 1 } });
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

  it('runs only the newest of the filter counts waiting in the queue, and none a filter came after', async () => {
    FakeSession.filters = [];
    FakeSession.countSteps = 1;
    const port = await startWorker();
    const replies: unknown[] = [];
    port.postMessage.mockImplementation((reply: unknown) => replies.push(reply));
    const filter = { channels: null, keys: [1], kinds: null, rules: [], combine: 'all', t0: null, t1: null };
    port.onmessage?.({ data: { id: 1, method: 'countFilterMatches', args: [filter] } });
    port.onmessage?.({ data: { id: 2, method: 'countFilterMatches', args: [filter] } });
    port.onmessage?.({ data: { id: 3, method: 'countFilterMatches', args: [filter] } });
    port.onmessage?.({ data: { id: 4, method: 'setTraceFilter', args: [filter] } });
    port.onmessage?.({ data: { id: 5, method: 'countFilterMatches', args: [filter] } });
    port.onmessage?.({ data: { id: 6, method: 'setTraceFilter', args: [null] } });
    await vi.waitUntil(() => replies.length === 6);
    expect(replies).toEqual([
      { id: 1, result: null },
      { id: 2, result: null },
      { id: 3, result: null },
      { id: 4, result: 3 },
      { id: 5, result: null },
      { id: 6, result: 0 },
    ]);
    expect(FakeSession.filters).toEqual([JSON.stringify(filter), 'null']);
  });

  it('counts a step at a time, letting other requests run between steps, until a newer count stops it', async () => {
    FakeSession.filters = [];
    FakeSession.countSteps = 3;
    const port = await startWorker();
    const replies: { id: number }[] = [];
    port.postMessage.mockImplementation((reply: { id: number }) => replies.push(reply));
    const filter = (byte: number) => ({ channels: null, keys: null, kinds: null, rules: [{ type: 'byteEquals', byte, value: 0 }], combine: 'all', t0: null, t1: null });
    port.onmessage?.({ data: { id: 1, method: 'countFilterMatches', args: [filter(1)] } });
    // Sent while the first step runs: answered before the count goes on.
    port.onmessage?.({ data: { id: 2, method: 'rowCount', args: [3] } });
    await vi.waitUntil(() => replies.length === 1);
    expect(replies).toEqual([{ id: 2, result: 7 }]);

    port.onmessage?.({ data: { id: 3, method: 'countFilterMatches', args: [filter(2)] } });
    await vi.waitUntil(() => replies.length === 3);
    expect(replies.slice(1)).toEqual([
      { id: 1, result: null },
      { id: 3, result: 5 },
    ]);
    expect(FakeSession.filters).toEqual([JSON.stringify(filter(1)), JSON.stringify(filter(2))]);
  });
});
