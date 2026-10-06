import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOG_SUPERSEDED, type BitFlips } from './api';
import type { Request } from './worker';

class FakeSession {
  static captures: [string, number][] = [];
  static filters: string[] = [];
  static made: FakeSession[] = [];
  pushed: Uint8Array[] = [];
  hasB = false;
  freed = false;
  finished = false;
  /** Bytes given to `push_chunk`. */
  read = 0;
  constructor() {
    FakeSession.made.push(this);
  }
  free() {
    this.freed = true;
  }
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
  /** Called after each chunk is pushed. */
  static onPush: (() => void) | null = null;
  push_chunk(chunk: Uint8Array) {
    this.read += chunk.length;
    FakeSession.onPush?.();
  }
  object_cuts() {
    return undefined;
  }
  compare_object_cuts() {
    return undefined;
  }
  segment_format() {
    return 'candump';
  }
  push_segment() {
    return true;
  }
  finish() {
    this.finished = true;
    return JSON.stringify({ frames: 10, durationS: 30 });
  }
  /** Calls to `compare_begin`. */
  compareBegun = 0;
  compare_begin(name: string) {
    if (name === 'broken.log') throw new Error('No CAN frames');
    this.compareBegun += 1;
  }
  /** Bytes given to `compare_push_chunk`. */
  compareRead = 0;
  compare_push_chunk(chunk: Uint8Array) {
    this.compareRead += chunk.length;
    FakeSession.onPush?.();
  }
  compare_segment_format() {
    return 'candump';
  }
  /** The part of log B `compare_push_segment` refuses, counted from 0. */
  static refusePart = -1;
  /** The part of log B that takes it over its memory budget, counted from 0. */
  static throwPart = -1;
  /** Parts of log B joined. */
  compareParts = 0;
  compare_push_segment() {
    if (this.compareParts === FakeSession.refusePart) return false;
    if (this.compareParts === FakeSession.throwPart) throw new Error('door-lock.log is too large to read beside the open log in this browser\'s memory.');
    this.compareParts += 1;
    return true;
  }
  compare_finish() {
    this.hasB = true;
    return JSON.stringify({ frames: 3, durationS: 28 });
  }
  compare_log_info() {
    return this.hasB ? JSON.stringify({ frames: 3, durationS: 28 }) : undefined;
  }
  /** Calls to `close_compare_log`. */
  compareClosed = 0;
  close_compare_log() {
    this.hasB = false;
    this.compareClosed += 1;
  }
  swap_compare_log() {
    return JSON.stringify({ frames: 3, durationS: 28 });
  }
  row_count(key: number): number {
    if (key === 1) throw new WebAssembly.RuntimeError('unreachable');
    if (key === 2) throw new Error('No such ID');
    return 7;
  }
  /** Each job takes one step before it is done. */
  jobs: { key: number; hints: unknown; stepped: boolean }[] = [];
  suggest_begin(key: number, hints: string): number {
    return this.jobs.push({ key, hints: JSON.parse(hints), stepped: false }) - 1;
  }
  suggest_step(job: number): string | undefined {
    const { key, hints, stepped } = this.jobs[job];
    this.jobs[job].stepped = true;
    return stepped ? JSON.stringify({ key, hints }) : undefined;
  }
  suggest_drop() {}
  private chunks: Uint8Array[] = [];
  export_log(format: string) {
    if (format !== 'csv') throw new Error('Not a format');
    this.chunks = [new Uint8Array([1, 2]), new Uint8Array([3])];
  }
  export_chunk(): Uint8Array | undefined {
    return this.chunks.shift();
  }
  /** Two bytes: 16 flips, then a pair count per byte. */
  bit_flips_between(): Uint32Array {
    const packed = new Uint32Array(18);
    packed[6] = 3;
    packed.set([3, 1], 16);
    return packed;
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

const started = vi.fn();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout'] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('core worker', () => {
  describe('reading a large log in parts', () => {
    const size = 33 << 20;
    const bigLog = () => new Blob([new Uint8Array(size).fill(10)]);

    for (const [how, PartWorker] of [
      [
        'cannot be created',
        class {
          constructor() {
            started();
            throw new Error('nested workers are not supported');
          }
        },
      ],
      [
        'fails to load its script',
        class {
          onerror: ((e: { message: string; preventDefault(): void }) => void) | null = null;
          constructor() {
            started();
            queueMicrotask(() => this.onerror?.({ message: 'An unknown error occurred when fetching the script', preventDefault() {} }));
          }
          postMessage() {}
          terminate() {}
        },
      ],
      [
        'cannot load the wasm',
        class {
          onmessage: ((e: { data: unknown }) => void) | null = null;
          constructor() {
            started();
            queueMicrotask(() => this.onmessage?.({ data: { startError: 'WebAssembly.instantiate(): Out of memory' } }));
          }
          postMessage() {}
          terminate() {}
        },
      ],
    ] as const) {
      it(`reads the log again in a fresh session when a part worker ${how}, and later logs in one worker`, async () => {
        const port = await startWorker();
        // The part worker's URL is resolved against the worker's own location.
        Object.assign(port, { location: 'http://localhost/assets/worker.js' });
        vi.stubGlobal('navigator', { hardwareConcurrency: 4 });
        vi.stubGlobal('Worker', PartWorker);
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        started.mockClear();
        FakeSession.made = [];

        expect(await call(port, 1, 'openLog', bigLog(), 'drive.log')).toMatchObject({ id: 1, result: { name: 'drive.log', frames: 10 } });
        expect(started).toHaveBeenCalledTimes(3);
        const [inParts, again] = FakeSession.made;
        expect(FakeSession.made).toHaveLength(2);
        expect(inParts.freed).toBe(true);
        expect(inParts.read).toBe(2 << 20);
        expect(again.freed).toBe(false);
        expect(again.read).toBe(size);

        FakeSession.made = [];
        expect(await call(port, 2, 'openLog', bigLog(), 'drive2.log')).toMatchObject({ id: 2, result: { name: 'drive2.log' } });
        expect(started).toHaveBeenCalledTimes(3);
        expect(FakeSession.made).toHaveLength(1);
        expect(FakeSession.made[0].read).toBe(size);
        vi.mocked(console.warn).mockRestore();
      });

      it(`reads log B again in one worker when a part worker ${how}, and later logs in one worker`, async () => {
        FakeSession.made = [];
        const port = await startWorker();
        Object.assign(port, { location: 'http://localhost/assets/worker.js' });
        vi.stubGlobal('navigator', { hardwareConcurrency: 4 });
        vi.stubGlobal('Worker', PartWorker);
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        started.mockClear();

        expect(await call(port, 1, 'openCompareLog', bigLog(), 'door-lock.log')).toMatchObject({ id: 1, result: { name: 'door-lock.log', frames: 3 } });
        expect(started).toHaveBeenCalledTimes(3);
        // Log B is read in the session the worker made as it loaded.
        const [withB] = FakeSession.made;
        expect(FakeSession.made).toHaveLength(1);
        expect(withB.compareBegun).toBe(2);
        expect(withB.compareRead).toBe((2 << 20) + size);
        expect(withB.hasB).toBe(true);

        expect(await call(port, 2, 'openLog', bigLog(), 'drive.log')).toMatchObject({ id: 2, result: { name: 'drive.log' } });
        expect(started).toHaveBeenCalledTimes(3);
        expect(FakeSession.made[1].read).toBe(size);
        vi.mocked(console.warn).mockRestore();
      });
    }

    describe('log B', () => {
      /** A part worker that loads, then answers each part with a segment. */
      class AnsweringPartWorker {
        static made = 0;
        onmessage: ((e: { data: unknown }) => void) | null = null;
        constructor() {
          AnsweringPartWorker.made += 1;
          queueMicrotask(() => this.onmessage?.({ data: { ready: true } }));
        }
        postMessage() {
          queueMicrotask(() => this.onmessage?.({ data: { segment: new Uint8Array(1) } }));
        }
        terminate() {}
      }
      /** The 2 MiB parts after the first, which the core worker reads itself. */
      const parts = Math.ceil((size - (2 << 20)) / (2 << 20));

      async function startAnswering() {
        FakeSession.made = [];
        const port = await startWorker();
        Object.assign(port, { location: 'http://localhost/assets/worker.js' });
        vi.stubGlobal('navigator', { hardwareConcurrency: 4 });
        vi.stubGlobal('Worker', AnsweringPartWorker);
        AnsweringPartWorker.made = 0;
        return port;
      }

      afterEach(() => {
        FakeSession.refusePart = -1;
        FakeSession.throwPart = -1;
      });

      it('is read in parts, each joined into log B, beside the open log', async () => {
        const port = await startAnswering();
        await call(port, 1, 'openLog', new Blob(['(1.0) can0 123#00\n']), 'idle.log');
        const withA = FakeSession.made[1];
        const read = withA.read;

        expect(await call(port, 2, 'openCompareLog', bigLog(), 'door-lock.log')).toMatchObject({ id: 2, result: { name: 'door-lock.log', frames: 3 } });
        expect(AnsweringPartWorker.made).toBe(3);
        expect(FakeSession.made).toHaveLength(2);
        expect(withA.compareBegun).toBe(1);
        expect(withA.compareRead).toBe(2 << 20);
        expect(withA.compareParts).toBe(parts);
        expect(withA.read).toBe(read);
        expect(withA.hasB).toBe(true);
      });

      it('is read again in one worker when a part is refused, and later logs still in parts', async () => {
        const port = await startAnswering();
        FakeSession.refusePart = 3;
        expect(await call(port, 1, 'openCompareLog', bigLog(), 'door-lock.log')).toMatchObject({ id: 1, result: { name: 'door-lock.log' } });
        const [withB] = FakeSession.made;
        expect(withB.compareBegun).toBe(2);
        expect(withB.compareRead).toBe((2 << 20) + size);
        expect(withB.compareParts).toBe(3);

        FakeSession.refusePart = -1;
        expect(await call(port, 2, 'openCompareLog', bigLog(), 'door-lock.log')).toMatchObject({ id: 2, result: { name: 'door-lock.log' } });
        expect(AnsweringPartWorker.made).toBe(6);
        expect(withB.compareParts).toBe(3 + parts);
      });

      it('is not read again when it outgrows its memory budget in parts, and later logs are still read in parts', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const port = await startAnswering();
        FakeSession.throwPart = 2;
        const reply = (await call(port, 1, 'openCompareLog', bigLog(), 'door-lock.log')) as { error?: string };
        expect(reply.error).toContain('too large');
        const [withB] = FakeSession.made;
        expect(withB.compareBegun).toBe(1);
        expect(withB.compareRead).toBe(2 << 20);
        expect(withB.compareClosed).toBe(1);
        expect(warn).not.toHaveBeenCalled();

        FakeSession.throwPart = -1;
        expect(await call(port, 2, 'openCompareLog', bigLog(), 'door-lock.log')).toMatchObject({ id: 2, result: { name: 'door-lock.log' } });
        expect(AnsweringPartWorker.made).toBe(6);
        warn.mockRestore();
      });
    });
  });

  describe('replacing a log that is still being read', () => {
    const size = 33 << 20;
    const bigLog = () => new Blob([new Uint8Array(size).fill(10)]);
    const superseded = (id: number) => ({ id, error: LOG_SUPERSEDED, aborted: true });

    /** A part worker that loads, then reads its part until it is terminated. */
    class BusyPartWorker {
      static made: BusyPartWorker[] = [];
      onmessage: ((e: { data: unknown }) => void) | null = null;
      tasks = 0;
      terminated = false;
      constructor() {
        BusyPartWorker.made.push(this);
        queueMicrotask(() => this.onmessage?.({ data: { ready: true } }));
      }
      postMessage() {
        this.tasks += 1;
      }
      terminate() {
        this.terminated = true;
      }
    }

    /** A worker whose replies, but not its progress events, land in `replies`. */
    async function startRecording() {
      const port = await startWorker();
      Object.assign(port, { location: 'http://localhost/assets/worker.js' });
      vi.stubGlobal('Worker', BusyPartWorker);
      const replies: unknown[] = [];
      port.postMessage.mockImplementation((message: { event?: string }) => message.event || replies.push(message));
      const send = (id: number, method: Request['method'], ...args: unknown[]) => port.onmessage?.({ data: { id, method, args } });
      return { replies, send };
    }

    const reading = (from: number) => () => BusyPartWorker.made.length === from + 3 && BusyPartWorker.made.slice(from).every((worker) => worker.tasks === 1);

    beforeEach(() => {
      BusyPartWorker.made = [];
      FakeSession.made = [];
      FakeSession.onPush = null;
      vi.stubGlobal('navigator', { hardwareConcurrency: 4 });
    });

    it('stops a read in parts at once, terminating its part workers, when another log is opened or a capture starts', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const { replies, send } = await startRecording();

      send(1, 'openLog', bigLog(), 'drive.log');
      await vi.waitUntil(reading(0));
      // The worker made one session as it loaded.
      const stale = FakeSession.made[1];
      send(2, 'openLog', new Blob(['(1.0) can0 123#00\n']), 'idle.log');
      await vi.waitUntil(() => replies.length === 2);
      expect(replies[0]).toEqual(superseded(1));
      expect(replies[1]).toMatchObject({ id: 2, result: { name: 'idle.log', frames: 10 } });
      expect(BusyPartWorker.made.every((worker) => worker.terminated)).toBe(true);
      expect(stale.freed).toBe(true);
      expect(stale.finished).toBe(false);
      // The stale read's, an empty one left in its place, and the new log's: no read again in one worker.
      expect(FakeSession.made).toHaveLength(4);

      // Stopping them is no failure, so the next large log is read in parts again.
      send(3, 'openLog', bigLog(), 'drive.log');
      await vi.waitUntil(reading(3));
      send(4, 'startCapture', 'capture-1.log', 'can0', 1000);
      await vi.waitUntil(() => replies.length === 4);
      expect(replies[2]).toEqual(superseded(3));
      expect(replies[3]).toMatchObject({ id: 4, result: { name: 'capture-1.log', format: 'capture' } });
      expect(BusyPartWorker.made.every((worker) => worker.terminated)).toBe(true);
      expect(FakeSession.made).toHaveLength(7);
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    });

    it('never starts an openLog that a newer one follows in the queue', async () => {
      const { replies, send } = await startRecording();
      send(1, 'openLog', bigLog(), 'drive.log');
      await vi.waitUntil(reading(0));
      send(2, 'openLog', bigLog(), 'drive2.log');
      send(3, 'openLog', new Blob(['(1.0) can0 123#00\n']), 'idle.log');
      await vi.waitUntil(() => replies.length === 3);
      expect(replies).toEqual([superseded(1), superseded(2), expect.objectContaining({ id: 3, result: expect.objectContaining({ name: 'idle.log' }) })]);
      // Only the first read started part workers.
      expect(BusyPartWorker.made).toHaveLength(3);
    });

    it('stops reading log B in parts when another log is opened, terminating its part workers', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const { replies, send } = await startRecording();
      send(1, 'openLog', new Blob(['(1.0) can0 123#00\n']), 'idle.log');
      await vi.waitUntil(() => replies.length === 1);
      send(2, 'openCompareLog', bigLog(), 'door-lock.log');
      await vi.waitUntil(reading(0));
      send(3, 'openLog', new Blob(['(1.0) can0 123#00\n']), 'idle2.log');
      await vi.waitUntil(() => replies.length === 3);
      expect(replies[1]).toEqual(superseded(2));
      expect(replies[2]).toMatchObject({ id: 3, result: { name: 'idle2.log' } });
      expect(BusyPartWorker.made.every((worker) => worker.terminated)).toBe(true);
      const withB = FakeSession.made[1];
      expect(withB.compareBegun).toBe(1);
      expect(withB.compareRead).toBe(2 << 20);
      expect(withB.compareClosed).toBe(1);
      send(4, 'compareLogInfo');
      await vi.waitUntil(() => replies.length === 4);
      expect(replies[3]).toEqual({ id: 4, result: null });
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    });

    it('stops reading log B in one worker between chunks when another log is opened', async () => {
      vi.stubGlobal('navigator', { hardwareConcurrency: 1 });
      const { replies, send } = await startRecording();
      send(1, 'openLog', new Blob(['(1.0) can0 123#00\n']), 'idle.log');
      await vi.waitUntil(() => replies.length === 1);
      FakeSession.onPush = () => {
        FakeSession.onPush = null;
        send(3, 'openLog', new Blob(['(1.0) can0 123#00\n']), 'idle2.log');
      };
      send(2, 'openCompareLog', bigLog(), 'door-lock.log');
      await vi.waitUntil(() => replies.length === 3);
      expect(replies[1]).toEqual(superseded(2));
      expect(replies[2]).toMatchObject({ id: 3, result: { name: 'idle2.log' } });
      const withB = FakeSession.made[1];
      expect(withB.compareRead).toBe(8 << 20);
      expect(withB.compareClosed).toBe(1);
      expect(BusyPartWorker.made).toHaveLength(0);
      send(4, 'compareLogInfo');
      await vi.waitUntil(() => replies.length === 4);
      expect(replies[3]).toEqual({ id: 4, result: null });
    });

    it('stops a read in one worker between chunks', async () => {
      vi.stubGlobal('navigator', { hardwareConcurrency: 1 });
      const { replies, send } = await startRecording();
      // Sent as the first chunk is read, as the page's message would arrive between chunks.
      FakeSession.onPush = () => {
        FakeSession.onPush = null;
        send(2, 'openLog', new Blob(['(1.0) can0 123#00\n']), 'idle.log');
      };
      send(1, 'openLog', bigLog(), 'drive.log');
      await vi.waitUntil(() => replies.length === 2);
      const stale = FakeSession.made[1];
      expect(replies[0]).toEqual(superseded(1));
      expect(replies[1]).toMatchObject({ id: 2, result: { name: 'idle.log' } });
      expect(stale.read).toBe(8 << 20);
      expect(stale.finished).toBe(false);
      expect(BusyPartWorker.made).toHaveLength(0);
    });
  });

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

  it("splits a window's bit flips from their pairs per byte, handing over their one buffer", async () => {
    const port = await startWorker();
    const reply = new Promise<{ result: BitFlips }>((resolve) => port.postMessage.mockImplementationOnce(resolve));
    port.onmessage?.({ data: { id: 1, method: 'bitFlipsBetween', args: [9, 0, 10] } });
    const { result } = await reply;
    expect(result.flips).toHaveLength(16);
    expect(result.flips[6]).toBe(3);
    expect([...result.pairs]).toEqual([3, 1]);
    expect(port.postMessage.mock.calls[0][1]).toEqual([result.flips.buffer]);
  });

  it('answers an ordinary error without rethrowing it, and keeps answering', async () => {
    const port = await startWorker();
    expect(await ask(port, 1, 2)).toEqual({ id: 1, error: 'No such ID' });
    expect(vi.getTimerCount()).toBe(0);
    expect(await ask(port, 2, 3)).toEqual({ id: 2, result: 7 });
  });

  it('passes discovery hints to the session as JSON, and none as an empty object, and steps a job until done', async () => {
    const port = await startWorker();
    const hints = { markers: [{ t: 12 }], reference: { key: 5, signal: 'Speed' } };
    expect(await ask(port, 1, 9, 'suggestBegin', hints)).toEqual({ id: 1, result: 0 });
    expect(await ask(port, 2, 9, 'suggestBegin')).toEqual({ id: 2, result: 1 });
    expect(await ask(port, 3, 0, 'suggestStep')).toEqual({ id: 3, result: null });
    expect(await ask(port, 4, 0, 'suggestStep')).toEqual({ id: 4, result: { key: 9, hints } });
    expect(await ask(port, 5, 1, 'suggestStep')).toEqual({ id: 5, result: null });
    expect(await ask(port, 6, 1, 'suggestStep')).toEqual({ id: 6, result: { key: 9, hints: {} } });
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

  it('posts the last progress of a read even when it came within 100 ms of the one before', async () => {
    vi.stubGlobal('navigator', { hardwareConcurrency: 1 });
    const port = await startWorker();
    const progress: { bytes: number; total: number }[] = [];
    const reply = new Promise((resolve) =>
      port.postMessage.mockImplementation((message: { event?: string; bytes: number; total: number }) =>
        message.event === 'progress' ? progress.push(message) : resolve(message),
      ),
    );
    // Two chunks, read well within 100 ms of each other.
    const size = (8 << 20) + 5;
    port.onmessage?.({ data: { id: 1, method: 'openLog', args: [new Blob([new Uint8Array(size).fill(10)]), 'drive.log'] } });
    expect(await reply).toMatchObject({ id: 1 });
    expect(progress.at(-1)).toEqual(expect.objectContaining({ bytes: size, total: size }));
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
