import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from './worker';

class FakeSession {
  static filters: string[] = [];
  free() {}
  set_databases() {}
  set_trace_filter(json: string): number {
    FakeSession.filters.push(json);
    return json === 'null' ? 0 : 3;
  }
  count_filter_matches(json: string): number {
    FakeSession.filters.push(json);
    return 5;
  }
  row_count(key: number): number {
    if (key === 1) throw new WebAssembly.RuntimeError('unreachable');
    if (key === 2) throw new Error('No such ID');
    return 7;
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

/** Sends a rowCount request and resolves to the worker's reply. */
function ask(port: Port, id: number, key: number): Promise<unknown> {
  // vi.waitFor would advance the fake timers and fire the rethrow too early.
  const reply = new Promise((resolve) => port.postMessage.mockImplementationOnce(resolve));
  port.onmessage?.({ data: { id, method: 'rowCount', args: [key] } });
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

  it('runs only the newest of the filter counts waiting in the queue', async () => {
    FakeSession.filters = [];
    const port = await startWorker();
    const replies: unknown[] = [];
    port.postMessage.mockImplementation((reply: unknown) => replies.push(reply));
    const filter = { channels: null, keys: [1], kinds: null, rules: [], combine: 'all', t0: null, t1: null };
    port.onmessage?.({ data: { id: 1, method: 'countFilterMatches', args: [filter] } });
    port.onmessage?.({ data: { id: 2, method: 'countFilterMatches', args: [filter] } });
    port.onmessage?.({ data: { id: 3, method: 'setTraceFilter', args: [filter] } });
    port.onmessage?.({ data: { id: 4, method: 'setTraceFilter', args: [null] } });
    await vi.waitUntil(() => replies.length === 4);
    expect(replies).toEqual([
      { id: 1, result: null },
      { id: 2, result: 5 },
      { id: 3, result: 3 },
      { id: 4, result: 0 },
    ]);
    expect(FakeSession.filters).toEqual([JSON.stringify(filter), JSON.stringify(filter), 'null']);
  });
});
