import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from './worker';

class FakeSession {
  free() {}
  set_databases() {}
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
});
