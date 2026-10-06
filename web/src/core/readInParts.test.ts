import { afterEach, describe, expect, it, vi } from 'vitest';
import { FIRST_REPLY_MS, lineStart, partBytes, readInParts, type PartTask, type PartWorker, type ReadSession } from './readInParts';

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
}

/** Reads its part's lines as the real worker does, answering after `delay(task)` ms. */
class EchoWorker implements PartWorker {
  static tasks: PartTask[] = [];
  closed = false;
  constructor(
    private readonly partSize: number,
    private readonly delay: (task: PartTask) => number = () => 0,
    private readonly failAt = -1,
  ) {}
  async read(task: PartTask) {
    EchoWorker.tasks.push(task);
    const body = text(await partBytes(task.file, task.start, task.end, 7));
    await new Promise((resolve) => setTimeout(resolve, this.delay(task)));
    if (this.closed) throw new Error('closed');
    const index = Math.round((task.start - EchoWorker.tasks[0].start) / this.partSize);
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

  it('holds at most two parts per worker ahead of the next to join', async () => {
    const file = new Blob([log(400)]);
    const partSize = 200;
    EchoWorker.tasks = [];
    let outstanding = 0;
    let most = 0;
    const session = new RecordingSession('candump');
    const pushSegment = session.push_segment.bind(session);
    session.push_segment = (segment) => {
      outstanding -= 1;
      return pushSegment(segment);
    };
    const read = await readInParts(
      file,
      session,
      {
        workers: 2,
        partSize,
        startWorker: () => {
          const worker = new EchoWorker(partSize, (task) => (task === EchoWorker.tasks[0] ? 30 : 0));
          const readPart = worker.read.bind(worker);
          worker.read = (task) => {
            outstanding += 1;
            most = Math.max(most, outstanding);
            return readPart(task);
          };
          return worker;
        },
      },
      () => undefined,
    );
    expect(read).toBe(true);
    expect(most).toBe(4);
  });

  it('reads a log that the session says cannot be split, or a small one, whole and in order', async () => {
    const content = log(30);
    const startWorker = vi.fn();
    const unsplittable = new RecordingSession(undefined);
    expect(await readInParts(new Blob([content]), unsplittable, { workers: 4, partSize: 50, startWorker }, () => undefined)).toBe(true);
    expect(unsplittable.bytes).toBe(content);
    const small = new RecordingSession('candump');
    expect(await readInParts(new Blob([content]), small, { workers: 4, partSize: 1 << 20, startWorker }, () => undefined)).toBe(true);
    expect(small.bytes).toBe(content);
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

  describe('with a worker that never answers', () => {
    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it(`gives up once a worker has not answered its first part in ${FIRST_REPLY_MS / 1000} s`, async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const onStalled = vi.fn();
      const workers: PartWorker[] = [];
      const startWorker = () => {
        const worker = {
          read: vi.fn(() => new Promise<Uint8Array>(() => undefined)),
          close: vi.fn(),
        };
        workers.push(worker);
        return worker;
      };
      let settled: boolean | undefined;
      void readInParts(new Blob([log(400)]), new RecordingSession('candump'), { workers: 2, partSize: 250, startWorker, onStalled }, () => undefined).then((read) => {
        settled = read;
      });
      // Not vi.waitUntil, which would run the fake timers.
      while (!(workers.length === 2 && workers.every((worker) => vi.mocked(worker.read).mock.calls.length === 1))) {
        await new Promise((resolve) => realSetTimeout(resolve, 0));
      }
      await vi.advanceTimersByTimeAsync(FIRST_REPLY_MS - 1);
      expect(settled).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(false);
      expect(onStalled).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(workers.every((worker) => vi.mocked(worker.close).mock.calls.length > 0)).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('waits as long as a part takes once a worker has answered', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const onStalled = vi.fn();
      EchoWorker.tasks = [];
      const session = new RecordingSession('candump');
      const content = log(60);
      const partSize = 400;
      // The second part each worker reads takes far longer than the first-reply limit.
      const startWorker = () => {
        let reads = 0;
        return new EchoWorker(partSize, () => (++reads === 2 ? 2 * FIRST_REPLY_MS : 0));
      };
      const reading = readInParts(new Blob([content]), session, { workers: 1, partSize, startWorker, onStalled }, () => undefined);
      await vi.runAllTimersAsync();
      expect(await reading).toBe(true);
      expect(session.bytes).toBe(content);
      expect(onStalled).not.toHaveBeenCalled();
    });
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
});
