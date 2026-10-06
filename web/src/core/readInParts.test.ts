import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHUNK_BYTES, READY_MS, WHOLE_READ_SHARE, lineStart, partBytes, rangeBytes, readChunks, readInParts, taskBytes, type FramePartTask, type PartTask, type PartWorker, type ReadSession } from './readInParts';

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const realSetTimeout = globalThis.setTimeout;

/** A CRLF log of numbered lines, one of them longer than a scan window. */
function log(lines = 40): string {
  const out: string[] = [];
  for (let i = 0; i < lines; i++) out.push(i === 17 ? `(${i}.0) can0 ${'7'.repeat(100)}` : `(${i}.0) can${i % 3} 123#${i}`);
  return out.join('\r\n') + '\r\n';
}

/**
 * A session that keeps the bytes it was given, the chunks and the parts' lines in the order it
 * joined them, so a read in parts can be checked against the file. Parts come from `EchoWorker`.
 */
class RecordingSession implements ReadSession {
  bytes = '';
  joined: number[] = [];
  constructor(
    private readonly format: string | undefined,
    private readonly refuse = -1,
  ) {}
  push_chunk(chunk: Uint8Array) {
    expect(this.joined).toEqual([]);
    this.bytes += text(chunk);
  }
  segment_format() {
    return this.format;
  }
  push_segment(segment: Uint8Array) {
    const { index, body } = JSON.parse(text(segment)) as { index: number; body: string };
    if (index === this.refuse) return false;
    this.joined.push(index);
    this.bytes += body;
    return true;
  }
  object_cuts(_chunk: Uint8Array, _partBytes: number): Float64Array | undefined {
    return undefined;
  }
  plan_parts(_partBytes: number): number | undefined {
    return undefined;
  }
  part_task(_index: number): Uint8Array | undefined {
    return undefined;
  }
  part_ranges(_index: number): Float64Array | undefined {
    return undefined;
  }
  join_part(_index: number, _part: Uint8Array) {
    return -2;
  }
}

/**
 * A session for a log whose frames it reads in parts once the whole file is pushed, as an MF4
 * log's are: part `i` is the bytes of the file in `ranges(i)`, and it asks for the parts in
 * `order`, as it would merging them by time.
 */
class FrameSession extends RecordingSession {
  constructor(
    readonly order: number[],
    private readonly refuseNth = -1,
    /** Parts planned, when the log ends at a limit before the session asks for them all. */
    private readonly count = order.length,
  ) {
    super(undefined);
  }
  ranges(index: number) {
    return Float64Array.from([index * 9, index * 9 + 4, index * 9 + 6, index * 9 + 7]);
  }
  plan_parts(_partBytes: number) {
    return this.count;
  }
  part_task(index: number) {
    return index < this.count ? Uint8Array.of(index) : undefined;
  }
  part_ranges(index: number) {
    return index < this.count ? this.ranges(index) : undefined;
  }
  join_part(index: number, part: Uint8Array) {
    const { task, body } = JSON.parse(text(part)) as { task: number; body: string };
    if (this.joined.length === this.refuseNth) return -2;
    expect(index).toBe(this.order[this.joined.length]);
    expect(task).toBe(index);
    const [a, b, c, d] = this.ranges(index);
    expect(body).toBe(this.bytes.slice(a, b) + this.bytes.slice(c, d));
    this.joined.push(index);
    return this.order[this.joined.length] ?? -1;
  }
}

/** Reads a part of a log's frames as the real worker does, answering after `delay(index)` ms. */
class FrameWorker implements PartWorker {
  static reading = 0;
  static mostReading = 0;
  /** The parts read, in the order their reads started, each with the part the session awaited then. */
  static starts: { part: number; awaited: number }[] = [];
  closed = false;
  /** The parts whose reads got past their delay. */
  partsRead: number[] = [];
  private stops: (() => void)[] = [];
  ready = Promise.resolve();
  constructor(
    private readonly delay: (index: number) => number = () => 0,
    private readonly failAt = -1,
    private readonly session?: FrameSession,
  ) {}
  async read(task: PartTask | FramePartTask) {
    if (!('ranges' in task)) throw new Error('not a part of frames');
    FrameWorker.reading += 1;
    // Parts read or reading but not yet joined, which the session last asked for counted out.
    const held = FrameWorker.reading - (this.session?.joined.length ?? 0);
    FrameWorker.mostReading = Math.max(FrameWorker.mostReading, held);
    if (this.session) FrameWorker.starts.push({ part: task.task[0], awaited: this.session.order[this.session.joined.length] });
    const body = text(await rangeBytes(task.file, task.ranges));
    // Closing stops a read at once, as terminating the real worker does.
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, this.delay(task.task[0]));
      this.stops.push(() => {
        clearTimeout(timer);
        reject(new Error('closed'));
      });
    });
    if (this.closed) throw new Error('closed');
    this.partsRead.push(task.task[0]);
    if (task.task[0] === this.failAt) throw new Error('out of memory');
    return new TextEncoder().encode(JSON.stringify({ task: task.task[0], body }));
  }
  close() {
    this.closed = true;
    const stops = this.stops;
    this.stops = [];
    for (const stop of stops) stop();
  }
}

/** A `FrameWorker` that is still loading until it is closed, which fails its load as a real one's. */
class LoadingFrameWorker extends FrameWorker {
  private stopLoading: (err: Error) => void = () => undefined;
  ready = new Promise<void>((_, reject) => {
    this.stopLoading = reject;
  });
  close() {
    super.close();
    this.stopLoading(new Error('closed'));
  }
}

/**
 * A session for a log cut where its objects end, as a BLF file is: here each line is an object,
 * and the file is cut as `ObjectCuts` cuts it, at the last line end within `partBytes` of the
 * cut before, or the first past it when none is.
 */
class ObjectSession extends RecordingSession {
  seen = 0;
  last = 0;
  cutsAfterRead = false;
  done = false;
  constructor(private readonly refuseNth = -1) {
    super('blf');
  }
  push_segment(segment: Uint8Array) {
    const { index, body } = JSON.parse(text(segment)) as { index: number; body: string };
    if (this.joined.length === this.refuseNth) return false;
    expect(index).toBe(new TextEncoder().encode(this.bytes).length);
    this.joined.push(index);
    this.bytes += body;
    return true;
  }
  pending: number | undefined;
  object_cuts(chunk: Uint8Array, partBytes: number) {
    if (this.done) this.cutsAfterRead = true;
    const cuts: number[] = [];
    const cut = (at: number) => {
      cuts.push(at);
      this.last = at;
      this.pending = undefined;
    };
    chunk.forEach((byte, i) => {
      const end = this.seen + i + 1;
      if (byte !== 10) return;
      if (end - this.last > partBytes && this.pending !== undefined) cut(this.pending);
      if (end - this.last > partBytes) cut(end);
      else this.pending = end;
    });
    this.seen += chunk.length;
    if (this.seen >= this.last + partBytes && this.pending !== undefined) cut(this.pending);
    return Float64Array.from(cuts);
  }
}

/**
 * `content` as a file whose reads of a whole chunk, which only the walk for where objects end
 * makes here, first wait for `walk`, or fail with it.
 */
function walkedFile(content: string, walk: () => Promise<void>): Blob {
  const blob = new Blob([content]);
  const slice = (start: number, end: number) => {
    const part = blob.slice(start, end);
    if (end - start !== CHUNK_BYTES) return part;
    return { arrayBuffer: () => walk().then(() => part.arrayBuffer()) };
  };
  return { size: blob.size, slice } as unknown as Blob;
}

/** Reads its part's lines as the real worker does, answering after `delay(task)` ms. */
class EchoWorker implements PartWorker {
  static tasks: PartTask[] = [];
  closed = false;
  ready = Promise.resolve();
  constructor(
    private readonly partSize: number,
    private readonly delay: (task: PartTask) => number = () => 0,
    private readonly failAt = -1,
  ) {}
  async read(task: PartTask) {
    EchoWorker.tasks.push(task);
    const body = text(task.exact ? await taskBytes(task) : await partBytes(task.file, task.start, task.end, 7));
    await new Promise((resolve) => setTimeout(resolve, this.delay(task)));
    if (this.closed) throw new Error('closed');
    // Parts cut where objects end vary in size, so they go by where they start.
    const index = task.exact ? task.start : Math.round((task.start - EchoWorker.tasks[0].start) / this.partSize);
    if (index === this.failAt) throw new Error('out of memory');
    return new TextEncoder().encode(JSON.stringify({ index, body }));
  }
  close() {
    this.closed = true;
  }
}

describe('reading a log in parts', () => {
  it('finds the start of the line at or after any byte, past lines longer than a scan', async () => {
    const file = new Blob(['ab\r\ncd\n', 'x'.repeat(30), '\nlast']);
    expect(await lineStart(file, 0)).toBe(0);
    expect(await lineStart(file, 1, 4)).toBe(4);
    expect(await lineStart(file, 3, 4)).toBe(4); // on the CR
    expect(await lineStart(file, 4, 4)).toBe(4); // just after the LF
    expect(await lineStart(file, 5, 4)).toBe(7);
    expect(await lineStart(file, 8, 4)).toBe(38);
    expect(await lineStart(file, 39, 4)).toBe(file.size);
  });

  it('tiles the file with whole lines wherever the parts meet: mid-line, on a CRLF, in the header', async () => {
    const content = `;$FILEVERSION=2.1\r\n;$COLUMNS=N,O,T,B,I,d,R,L,D\r\n${log()}tail without a line break`;
    const file = new Blob([content]);
    for (const size of [1, 2, 3, 5, 8, 13, 31, 97, 400]) {
      for (const phase of [0, 1, 2, 19, 20, 21]) {
        const starts = [phase];
        for (let at = phase + size; at < file.size; at += size) starts.push(at);
        let joined = content.slice(0, await lineStart(file, phase, 7));
        for (const [i, start] of starts.entries()) {
          const part = text(await partBytes(file, start, starts[i + 1] ?? file.size, 7));
          if (part && joined) expect(joined.endsWith('\n')).toBe(true);
          joined += part;
        }
        expect(joined).toBe(content);
      }
    }
  });

  it('joins the parts in file order, whatever order the workers finish in', async () => {
    const content = log(400);
    const file = new Blob([content]);
    const partSize = 300;
    EchoWorker.tasks = [];
    const session = new RecordingSession('candump');
    const progress: number[] = [];
    const workers: EchoWorker[] = [];
    const read = await readInParts(
      file,
      session,
      {
        workers: 3,
        partSize,
        startWorker: () => {
          // Later parts first, and some parts much slower than others.
          const worker = new EchoWorker(partSize, (task) => ((task.start * 7) % 5) + (task.start % 3 === 0 ? 4 : 0));
          workers.push(worker);
          return worker;
        },
      },
      (bytes) => progress.push(bytes),
    );
    expect(read).toBe(true);
    expect(session.bytes).toBe(content);
    expect(session.joined).toEqual([...session.joined.keys()]);
    expect(session.joined.length).toBeGreaterThan(10);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
    expect(progress.at(-1)).toBe(file.size);
    expect(workers).toHaveLength(3);
    expect(workers.every((worker) => worker.closed)).toBe(true);
    // Every part gets the start of the file up to the first part, for its header.
    expect(new Set(EchoWorker.tasks.map((task) => text(task.head)))).toEqual(new Set([content.slice(0, EchoWorker.tasks[0].start)]));
  });

  it('reads a log cut where its objects end in exactly those parts, found as the file is read', async () => {
    const content = log(400);
    const file = new Blob([content]);
    for (const partSize of [97, 300, 2000]) {
      EchoWorker.tasks = [];
      const session = new ObjectSession();
      const progress: number[] = [];
      const read = await readInParts(file, session, { workers: 3, partSize, startWorker: () => new EchoWorker(partSize, (task) => (task.start * 7) % 5) }, (bytes) => progress.push(bytes));
      session.done = true;
      expect(read).toBe(true);
      expect(session.bytes).toBe(content);
      expect(session.joined.length).toBeGreaterThan(3);
      expect(progress).toEqual([...progress].sort((a, b) => a - b));
      expect(progress.at(-1)).toBe(file.size);
      const tasks = [...EchoWorker.tasks].sort((a, b) => a.start - b.start);
      expect(tasks.every((task) => task.exact && task.format === 'blf')).toBe(true);
      // The parts meet where objects end, and the core read the first up to one.
      expect(content[tasks[0].start - 1]).toBe('\n');
      expect(tasks[0].start).toBeLessThanOrEqual(partSize);
      for (const [i, task] of tasks.entries()) expect(task.end).toBe(tasks[i + 1]?.start ?? file.size);
      expect(text(tasks[0].head)).toBe(content.slice(0, tasks[0].start));
    }
  });

  it('reads a log cut where its objects end in one worker when none ends in the first part', async () => {
    const content = 'x'.repeat(500) + '\n' + log(40);
    const startWorker = vi.fn();
    const session = new ObjectSession();
    expect(await readInParts(new Blob([content]), session, { workers: 3, partSize: 200, startWorker }, () => undefined)).toBe(true);
    expect(session.bytes).toBe(content);
    expect(startWorker).not.toHaveBeenCalled();
  });

  it('stops looking for where objects end once a part is refused', async () => {
    const file = new Blob([log(400)]);
    EchoWorker.tasks = [];
    const session = new ObjectSession(2);
    const read = await readInParts(file, session, { workers: 2, partSize: 100, startWorker: () => new EchoWorker(100) }, () => undefined);
    session.done = true;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(read).toBe(false);
    expect(session.cutsAfterRead).toBe(false);
  });

  it('lets the walk for where objects end finish its read, then stop, before an aborted read rejects', async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const session = new ObjectSession();
    const cuts = vi.spyOn(session, 'object_cuts');
    const stop = new AbortController();
    let settled = false;
    const reading = readInParts(walkedFile(log(400), () => gate), session, { workers: 2, partSize: 100, signal: stop.signal, startWorker: () => new EchoWorker(100) }, () => undefined);
    reading.catch(() => undefined).finally(() => (settled = true));
    await vi.waitUntil(() => cuts.mock.calls.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const reason = new DOMException('superseded', 'AbortError');
    stop.abort(reason);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    release();
    await expect(reading).rejects.toBe(reason);
    expect(cuts).toHaveBeenCalledTimes(1);
  });

  it('reads the log again in one worker when the walk for where objects end fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const options = { workers: 2, partSize: 100, startWorker: () => new EchoWorker(100) };
    const unreadable = walkedFile(log(400), () => Promise.reject(new Error('NotReadableError')));
    expect(await readInParts(unreadable, new ObjectSession(), options, () => undefined)).toBe(false);

    const session = new ObjectSession();
    const cuts = session.object_cuts.bind(session);
    session.object_cuts = (chunk, partBytes) => {
      if (session.seen > 0) throw new WebAssembly.RuntimeError('unreachable');
      return cuts(chunk, partBytes);
    };
    expect(await readInParts(new Blob([log(400)]), session, options, () => undefined)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('holds at most two parts per worker ahead of the next to join', async () => {
    const file = new Blob([log(400)]);
    const partSize = 200;
    EchoWorker.tasks = [];
    let outstanding = 0;
    let most = 0;
    let laterPartsRead = 0;
    let releaseFirst = () => {};
    const firstHeld = new Promise<void>((resolve) => (releaseFirst = resolve));
    const session = new RecordingSession('candump');
    const pushSegment = session.push_segment.bind(session);
    session.push_segment = (segment) => {
      outstanding -= 1;
      return pushSegment(segment);
    };
    const reading = readInParts(
      file,
      session,
      {
        workers: 2,
        partSize,
        startWorker: () => {
          const worker = new EchoWorker(partSize);
          const readPart = worker.read.bind(worker);
          worker.read = async (task) => {
            const first = EchoWorker.tasks.length === 0;
            outstanding += 1;
            most = Math.max(most, outstanding);
            const part = await readPart(task);
            if (first) await firstHeld;
            else laterPartsRead += 1;
            return part;
          };
          return worker;
        },
      },
      () => undefined,
    );
    // While the first part is held, the other worker reads three more and then waits for it,
    // rather than starting a fifth read.
    await vi.waitFor(() => expect(laterPartsRead).toBeGreaterThanOrEqual(3), { timeout: 3000 });
    expect(outstanding).toBe(4);
    releaseFirst();
    expect(await reading).toBe(true);
    expect(most).toBe(4);
  });

  it('reads a log that the session says cannot be split, or a small one, whole and in order', async () => {
    const content = log(30);
    const startWorker = vi.fn();
    // Parsed as it is pushed, so its progress is the bytes read, whatever the session says next.
    const unsplittable = new RecordingSession(undefined);
    const wholeProgress: number[] = [];
    expect(await readInParts(new Blob([content]), unsplittable, { workers: 4, partSize: 50, startWorker }, (bytes) => wholeProgress.push(bytes))).toBe(true);
    expect(unsplittable.bytes).toBe(content);
    expect(wholeProgress).toEqual([50, content.length]);
    const small = new RecordingSession('candump');
    const progress: number[] = [];
    expect(await readInParts(new Blob([content]), small, { workers: 4, partSize: 1 << 20, startWorker }, (bytes) => progress.push(bytes))).toBe(true);
    expect(small.bytes).toBe(content);
    expect(progress).toEqual([content.length]);
    expect(startWorker).not.toHaveBeenCalled();
  });

  it('gives up, closing every worker, when a part is refused or a worker fails', async () => {
    const file = new Blob([log(400)]);
    for (const [refuse, failAt] of [
      [3, -1],
      [-1, 5],
    ]) {
      EchoWorker.tasks = [];
      const workers: EchoWorker[] = [];
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const read = await readInParts(
        file,
        new RecordingSession('candump', refuse),
        {
          workers: 3,
          partSize: 250,
          startWorker: () => {
            const worker = new EchoWorker(250, () => 1, failAt);
            workers.push(worker);
            return worker;
          },
        },
        () => undefined,
      );
      expect(read).toBe(false);
      expect(workers.every((worker) => worker.closed)).toBe(true);
      expect(warn).toHaveBeenCalledTimes(failAt >= 0 ? 1 : 0);
      warn.mockRestore();
    }
  });

  describe('with a worker that loads slowly or never', () => {
    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it(`gives up once a worker has not loaded in ${READY_MS / 1000} s`, async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const onStalled = vi.fn();
      const workers: PartWorker[] = [];
      const startWorker = () => {
        let closed = (_: Error) => {};
        const worker = {
          // Never loads, as a part worker whose script never arrives; closing it rejects.
          ready: new Promise<void>((_, reject) => {
            closed = reject;
          }),
          read: vi.fn(() => new Promise<Uint8Array>(() => undefined)),
          close: vi.fn(() => closed(new Error('closed'))),
        };
        workers.push(worker);
        return worker;
      };
      let settled: boolean | undefined;
      void readInParts(new Blob([log(400)]), new RecordingSession('candump'), { workers: 2, partSize: 250, startWorker, onStalled }, () => undefined).then((read) => {
        settled = read;
      });
      // Not vi.waitUntil, which would run the fake timers.
      while (workers.length < 2) {
        await new Promise((resolve) => realSetTimeout(resolve, 0));
      }
      await vi.advanceTimersByTimeAsync(READY_MS - 1);
      expect(settled).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(false);
      expect(onStalled).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(workers.every((worker) => vi.mocked(worker.close).mock.calls.length > 0)).toBe(true);
      expect(workers.every((worker) => vi.mocked(worker.read).mock.calls.length === 0)).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('gives up without calling it a stall when a worker reports it could not start', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const onStalled = vi.fn();
      const startWorker = () => {
        const worker = new EchoWorker(250);
        worker.ready = Promise.reject(new Error("couldn't load the wasm"));
        return worker;
      };
      expect(await readInParts(new Blob([log(400)]), new RecordingSession('candump'), { workers: 2, partSize: 250, startWorker, onStalled }, () => undefined)).toBe(false);
      expect(onStalled).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('waits as long as a part takes once a worker has loaded, the first part too', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const onStalled = vi.fn();
      EchoWorker.tasks = [];
      const session = new RecordingSession('candump');
      const content = log(60);
      const partSize = 400;
      // Parts take far longer than a worker has to load, as on a slow network share.
      const startWorker = () => new EchoWorker(partSize, () => 2 * READY_MS);
      const reading = readInParts(new Blob([content]), session, { workers: 1, partSize, startWorker, onStalled }, () => undefined);
      await vi.runAllTimersAsync();
      expect(await reading).toBe(true);
      expect(session.bytes).toBe(content);
      expect(onStalled).not.toHaveBeenCalled();
    });
  });

  it('closes every worker at once and rejects with the reason when the read is aborted', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const workers: PartWorker[] = [];
    const startWorker = () => {
      // Reads a part until closed, as the real part worker does with a large part.
      let closed = (_: Error) => {};
      const worker = {
        ready: Promise.resolve(),
        read: vi.fn(
          () =>
            new Promise<Uint8Array>((_, reject) => {
              closed = reject;
            }),
        ),
        close: vi.fn(() => closed(new Error('closed'))),
      };
      workers.push(worker);
      return worker;
    };
    const session = new RecordingSession('candump');
    const stop = new AbortController();
    const reading = readInParts(new Blob([log(400)]), session, { workers: 3, partSize: 250, signal: stop.signal, startWorker }, () => undefined);
    await vi.waitUntil(() => workers.length === 3 && workers.every((worker) => vi.mocked(worker.read).mock.calls.length === 1));
    const reason = new DOMException('superseded', 'AbortError');
    stop.abort(reason);
    expect(workers.every((worker) => vi.mocked(worker.close).mock.calls.length > 0)).toBe(true);
    await expect(reading).rejects.toBe(reason);
    expect(session.joined).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('stops a read in chunks before the next chunk once aborted', async () => {
    const file = new Blob([new Uint8Array(2 * CHUNK_BYTES + 1)]);
    const stop = new AbortController();
    const pushed: number[] = [];
    const reading = readChunks(
      file,
      (chunk) => {
        pushed.push(chunk.length);
        stop.abort(new Error('superseded'));
      },
      () => undefined,
      0,
      stop.signal,
    );
    await expect(reading).rejects.toThrow('superseded');
    expect(pushed).toEqual([CHUNK_BYTES]);
  });

  it('stops the other workers, without a warning, when joining a part throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    EchoWorker.tasks = [];
    const workers: EchoWorker[] = [];
    const session = new RecordingSession('candump');
    session.push_segment = () => {
      throw new WebAssembly.RuntimeError('unreachable');
    };
    const reading = readInParts(
      new Blob([log(400)]),
      session,
      {
        workers: 3,
        partSize: 250,
        startWorker: () => {
          const worker = new EchoWorker(250, (task) => (task === EchoWorker.tasks[0] ? 0 : 5));
          workers.push(worker);
          return worker;
        },
      },
      () => undefined,
    );
    await expect(reading).rejects.toThrow('unreachable');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(workers.every((worker) => worker.closed)).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  describe('of frames planned once the whole log is read', () => {
    // Asks for part 0 first, then the rest out of plan order, as merging the parts by time does.
    const order = [0, 3, 1, 7, 2, 4, 9, 5, 6, 8, 10, 11, 13, 12];
    const content = log(40);

    it('reads the parts in the ranges the session gives, joining each when the session asks for it', async () => {
      FrameWorker.reading = 0;
      FrameWorker.mostReading = 0;
      const session = new FrameSession(order);
      const workers: FrameWorker[] = [];
      const progress: number[] = [];
      const read = await readInParts(
        new Blob([content]),
        session,
        {
          workers: 2,
          startWorker: () => {
            const worker = new FrameWorker((index) => (index * 7) % 5, -1, session);
            workers.push(worker);
            return worker;
          },
        },
        (bytes) => progress.push(bytes),
      );
      expect(read).toBe(true);
      expect(session.bytes).toBe(content);
      expect(session.joined).toEqual(order);
      expect(progress.at(-1)).toBe(content.length);
      expect(workers).toHaveLength(2);
      expect(workers.every((worker) => worker.closed)).toBe(true);
      // Two per worker read ahead, and the part the session waits for.
      expect(FrameWorker.mostReading).toBeLessThanOrEqual(2 * 2 + 1);
    });

    it('reads ahead in plan order, the part the session waits for first, so a plan in the order the session asks keeps ahead', async () => {
      // Two data groups one after another in time: the session asks for the first part of each, then
      // for the rest of the first group's parts before the second's.
      const asked = [0, 1, 2, 4, 6, 8, 10, 12, 3, 5, 7, 9, 11, 13];
      // Planned by when each part starts, as the core plans them, and by place in each group's stream.
      const byTime = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];
      const waits: number[] = [];
      for (const order of [byTime, asked]) {
        FrameWorker.starts = [];
        const session = new FrameSession(order);
        const startWorker = () => new FrameWorker((index) => 2 + ((index * 7) % 5), -1, session);
        expect(await readInParts(new Blob([content]), session, { workers: 2, startWorker }, () => undefined)).toBe(true);
        expect(session.joined).toEqual(order);
        const started = new Set<number>();
        for (const { part, awaited } of FrameWorker.starts) {
          let nextInPlan = 0;
          while (started.has(nextInPlan)) nextInPlan++;
          expect([awaited, nextInPlan]).toContain(part);
          started.add(part);
        }
        // Reads started only once the session waited for them, part 0 among them.
        waits.push(FrameWorker.starts.filter(({ part, awaited }) => part === awaited).length);
      }
      expect(waits[0]).toBe(1);
      expect(waits[1]).toBeGreaterThan(2);
    });

    it('counts reading an MF4 file as a share of the progress and each part joined as an even share of the rest', async () => {
      for (const id of ['MDF     ', 'UnFinMF ']) {
        const mf4 = id + content;
        const session = new FrameSession(order);
        const progress: number[] = [];
        const startWorker = () => new FrameWorker((index) => index % 3);
        expect(await readInParts(new Blob([mf4]), session, { workers: 3, startWorker }, (bytes) => progress.push(bytes))).toBe(true);
        const size = mf4.length;
        const joined = order.map((_, i) => size * (WHOLE_READ_SHARE + ((1 - WHOLE_READ_SHARE) * (i + 1)) / order.length));
        expect(progress).toEqual([size * WHOLE_READ_SHARE, ...joined].map(Math.round));
      }
    });

    it('ends the progress of an MF4 file whose parts the session cannot plan at its size', async () => {
      const mf4 = 'MDF     ' + content;
      const session = new RecordingSession(undefined);
      const progress: number[] = [];
      expect(await readInParts(new Blob([mf4]), session, { workers: 3, startWorker: () => new FrameWorker() }, (bytes) => progress.push(bytes))).toBe(true);
      expect(progress).toEqual([Math.round(mf4.length * WHOLE_READ_SHARE), mf4.length]);
    });

    it('starts no more workers than there are parts', async () => {
      const workers: FrameWorker[] = [];
      const session = new FrameSession([0, 1]);
      const startWorker = () => {
        const worker = new FrameWorker();
        workers.push(worker);
        return worker;
      };
      expect(await readInParts(new Blob([content]), session, { workers: 6, startWorker }, () => undefined)).toBe(true);
      expect(session.joined).toEqual([0, 1]);
      expect(workers).toHaveLength(2);
    });

    it('stops reading parts, without a warning, once the session has every frame it will join', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const workers: FrameWorker[] = [];
      const session = new FrameSession([0, 2, 1], -1, 40);
      const startWorker = () => {
        const worker = new FrameWorker((index) => (index < 3 ? 0 : 50));
        workers.push(worker);
        return worker;
      };
      const progress: number[] = [];
      expect(await readInParts(new Blob([content]), session, { workers: 3, startWorker }, (bytes) => progress.push(bytes))).toBe(true);
      expect(progress.at(-1)).toBe(content.length);
      expect(session.joined).toEqual([0, 2, 1]);
      expect(workers.every((worker) => worker.closed)).toBe(true);
      // The slow reads of the parts after them were stopped, not waited for.
      expect(workers.flatMap((worker) => worker.partsRead).sort()).toEqual([0, 1, 2]);
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    });

    it('ends, without a warning, when the session has every frame while the read-ahead is full', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const workers: FrameWorker[] = [];
      // Part 9 is asked for once the read-ahead is full, and the read of part 3 is closed unfinished.
      const session = new FrameSession([0, 1, 9], -1, 12);
      const startWorker = () => {
        const worker = new FrameWorker((index) => (index === 1 ? 10 : index === 3 ? 1000 : 0));
        workers.push(worker);
        return worker;
      };
      expect(await readInParts(new Blob([content]), session, { workers: 3, startWorker }, () => undefined)).toBe(true);
      expect(session.joined).toEqual([0, 1, 9]);
      expect(workers.every((worker) => worker.closed)).toBe(true);
      expect(workers.flatMap((worker) => worker.partsRead)).not.toContain(3);
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    });

    it('counts a worker still loading when the session has every frame as closed, not failed', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const workers: FrameWorker[] = [];
      const session = new FrameSession([0, 1], -1, 5);
      const startWorker = () => {
        const worker = workers.length < 2 ? new FrameWorker() : new LoadingFrameWorker();
        workers.push(worker);
        return worker;
      };
      expect(await readInParts(new Blob([content]), session, { workers: 3, startWorker }, () => undefined)).toBe(true);
      expect(session.joined).toEqual([0, 1]);
      expect(workers.every((worker) => worker.closed)).toBe(true);
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    });

    it('gives up, closing every worker, when a part is refused or a worker fails', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      for (const [refuseNth, failAt] of [
        [4, -1],
        [-1, 7],
        [0, -1],
      ]) {
        const workers: FrameWorker[] = [];
        const session = new FrameSession(order, refuseNth);
        const startWorker = () => {
          const worker = new FrameWorker((index) => index % 3, failAt);
          workers.push(worker);
          return worker;
        };
        expect(await readInParts(new Blob([content]), session, { workers: 3, startWorker }, () => undefined)).toBe(false);
        expect(session.joined.length).toBeLessThan(order.length);
        expect(workers.every((worker) => worker.closed)).toBe(true);
      }
      warn.mockRestore();
    });

    it('closes every worker at once and rejects with the reason when the read is aborted', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const workers: PartWorker[] = [];
      const startWorker = () => {
        let closed = (_: Error) => {};
        const worker = {
          ready: Promise.resolve(),
          read: vi.fn(
            () =>
              new Promise<Uint8Array>((_, reject) => {
                closed = reject;
              }),
          ),
          close: vi.fn(() => closed(new Error('closed'))),
        };
        workers.push(worker);
        return worker;
      };
      const session = new FrameSession(order);
      const stop = new AbortController();
      const reading = readInParts(new Blob([content]), session, { workers: 3, signal: stop.signal, startWorker }, () => undefined);
      await vi.waitUntil(() => workers.length === 3 && workers.every((worker) => vi.mocked(worker.read).mock.calls.length === 1));
      const reason = new DOMException('superseded', 'AbortError');
      stop.abort(reason);
      expect(workers.every((worker) => vi.mocked(worker.close).mock.calls.length > 0)).toBe(true);
      await expect(reading).rejects.toBe(reason);
      expect(session.joined).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    });

    it('stops the other workers, without a warning, when joining a part throws', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const workers: FrameWorker[] = [];
      const session = new FrameSession(order);
      session.join_part = () => {
        throw new Error('log B is too large');
      };
      const startWorker = () => {
        const worker = new FrameWorker((index) => (index === 0 ? 0 : 5));
        workers.push(worker);
        return worker;
      };
      await expect(readInParts(new Blob([content]), session, { workers: 3, startWorker }, () => undefined)).rejects.toThrow('too large');
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(workers.every((worker) => worker.closed)).toBe(true);
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    });
  });

  it('joins the bytes of a file in ranges', async () => {
    const file = new Blob(['0123456789']);
    expect(text(await rangeBytes(file, Float64Array.from([1, 3, 3, 4, 8, 10])))).toBe('12389');
    expect(await rangeBytes(file, new Float64Array())).toHaveLength(0);
  });
});
