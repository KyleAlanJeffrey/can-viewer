import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from './worker';

class FakeSession {
  static captures: [string, number][] = [];
  pushed: Uint8Array[] = [];
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
  export_candump() {
    return Uint8Array.of(0x28);
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

/** Sends a request and resolves to the worker's reply and what it transferred. */
function request(port: Port, id: number, method: Request['method'], args: unknown[]): Promise<unknown[]> {
  const reply = new Promise<unknown[]>((resolve) => port.postMessage.mockImplementationOnce((...a: unknown[]) => resolve(a)));
  port.onmessage?.({ data: { id, method, args } });
  return reply;
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

  it('answers an ordinary error without rethrowing it, and keeps answering', async () => {
    const port = await startWorker();
    expect(await ask(port, 1, 2)).toEqual({ id: 1, error: 'No such ID' });
    expect(vi.getTimerCount()).toBe(0);
    expect(await ask(port, 2, 3)).toEqual({ id: 2, result: 7 });
  });

  it('runs a capture in a fresh session and transfers the candump export', async () => {
    const port = await startWorker();
    const [started] = await request(port, 1, 'startCapture', ['can0', 1000]);
    expect(started).toEqual({ id: 1, result: { format: 'capture', frames: 0, parseMs: 0, wasmBytes: 0 } });
    expect(FakeSession.captures.at(-1)).toEqual(['can0', 1000]);
    const [appended] = await request(port, 2, 'appendFrames', [Uint8Array.of(1)]);
    expect(appended).toMatchObject({ id: 2, result: { frames: 1 } });
    const [ended] = await request(port, 3, 'endCapture', []);
    expect(ended).toMatchObject({ id: 3, result: { frames: 1 } });
    const [exported, transfer] = await request(port, 4, 'exportCandump', []);
    expect(exported).toEqual({ id: 4, result: Uint8Array.of(0x28) });
    expect(transfer).toEqual([(exported as { result: Uint8Array }).result.buffer]);
  });
});
