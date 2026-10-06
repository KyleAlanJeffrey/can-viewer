/// Reading a log file into the core's session: in chunks, or, for a large text or BLF log, in
/// parts parsed by a pool of workers and joined by the session in file order. The session checks
/// that each part was read as it would be in the whole file, so a log read in parts is the same
/// log, with the same `LogInfo`, as one read in chunks (see `crates/can-wasm/src/parts.rs`).

/** Bytes read at a time when a log is read in one worker. */
export const CHUNK_BYTES = 8 << 20;
/**
 * Bytes in each part, and in the start of the log the core worker reads itself while the part
 * workers start. Small enough for a log of tens of MB to give every worker several parts.
 */
export const PART_BYTES = 2 << 20;
/** The start of the file each part worker reads for the header, up to its last line break. */
const HEAD_BYTES = 64 << 10;
/** Bytes searched at a time for the line break that ends a part. */
const SCAN_BYTES = 64 << 10;
/** A part worker that hasn't loaded its script and wasm by then is taken to have failed to start. */
export const READY_MS = 15_000;

/** The `Session` calls a read uses. */
export interface ReadSession {
  push_chunk(chunk: Uint8Array): void;
  segment_format(): string | undefined;
  push_segment(segment: Uint8Array): boolean;
  object_cuts(chunk: Uint8Array, partBytes: number): Float64Array | undefined;
}

/**
 * One part for a worker: the lines of `file` that start in `[start, end)`, or, when `exact`,
 * the bytes in `[start, end)`, which begin and end where objects of the file end (BLF).
 */
export interface PartTask {
  file: Blob;
  /** `LogInfo.format` of the log. */
  format: string;
  head: Uint8Array;
  start: number;
  end: number;
  exact: boolean;
}

/** A worker that reads parts, one at a time. */
export interface PartWorker {
  /** Resolves once the worker has loaded; rejects when it can't start or is closed first. */
  ready: Promise<void>;
  /** The part read by `parse_segment`; rejects when the worker fails or is closed. */
  read(task: PartTask): Promise<Uint8Array>;
  close(): void;
}

export interface PartOptions {
  workers: number;
  startWorker: () => PartWorker;
  /** Bytes in the first chunk and in each part, `PART_BYTES` unless set. */
  partSize?: number;
  /** Called when a part worker hasn't loaded within `READY_MS`. */
  onStalled?: () => void;
  /** Aborting it closes the part workers at once and rejects the read with its reason. */
  signal?: AbortSignal;
}

class Stalled extends Error {}

/** `ready`, or a `Stalled` rejection once `ms` have passed without it. */
function withDeadline(ready: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Stalled(`a part worker didn't start in ${ms / 1000} s`)), ms);
  });
  return Promise.race([ready, late]).finally(() => clearTimeout(timer));
}

async function bytesOf(file: Blob, start: number, end: number): Promise<Uint8Array> {
  return new Uint8Array(await file.slice(start, end).arrayBuffer());
}

/**
 * Reads `file` from `from` in chunks through `push`, reporting the bytes read. Aborting `signal`
 * rejects with its reason before the next chunk is pushed.
 */
export async function readChunks(file: Blob, push: (chunk: Uint8Array) => void, onProgress: (bytes: number) => void, from = 0, signal?: AbortSignal) {
  for (let at = from; at < file.size; at += CHUNK_BYTES) {
    const chunk = await bytesOf(file, at, at + CHUNK_BYTES);
    signal?.throwIfAborted();
    push(chunk);
    onProgress(at + chunk.length);
  }
}

/** The first line start at or after `at`: just after the first line break at or after `at - 1`. */
export async function lineStart(file: Blob, at: number, scanBytes = SCAN_BYTES): Promise<number> {
  if (at <= 0) return 0;
  for (let from = at - 1; from < file.size; from += scanBytes) {
    const newline = (await bytesOf(file, from, from + scanBytes)).indexOf(10);
    if (newline >= 0) return from + newline + 1;
  }
  return file.size;
}

/**
 * The lines of `file` that start in `[start, end)`, running to the line break that ends the last
 * of them. Parts that meet at `end` tile the file whatever bytes they meet on.
 */
export async function partBytes(file: Blob, start: number, end: number, scanBytes = SCAN_BYTES): Promise<Uint8Array> {
  const from = await lineStart(file, start, scanBytes);
  const to = end >= file.size ? file.size : Math.max(from, await lineStart(file, end, scanBytes));
  return bytesOf(file, from, to);
}

/** The bytes a part worker reads for `task`. */
export function taskBytes(task: PartTask): Promise<Uint8Array> {
  return task.exact ? bytesOf(task.file, task.start, task.end) : partBytes(task.file, task.start, task.end);
}

/** The parts after the start of the log, `[start, end)` each, in file order. */
interface Ranges {
  /** The part at `index`, once it is known; undefined past the last. */
  get(index: number): Promise<[number, number] | undefined>;
  /** How many parts there are, once `get` has given undefined. */
  count(): number;
  /** Stops finding parts: `get` gives undefined from now on. */
  stop(): void;
  /** Settles once no more of the file is read to find parts. */
  readonly settled: Promise<void>;
}

/** Ranges of `partSize` from `cut`: a text log's parts, each the lines that start in one. */
function lineRanges(cut: number, partSize: number, size: number): Ranges {
  const starts: number[] = [];
  for (let at = cut; at < size; at += partSize) starts.push(at);
  return {
    get: async (index) => (index < starts.length ? [starts[index], Math.min(starts[index] + partSize, size)] : undefined),
    count: () => starts.length,
    stop() {},
    settled: Promise.resolve(),
  };
}

/**
 * The parts of a BLF log, cut where its objects end: `cuts`, found in the start of the file,
 * then those the session finds as the rest is read here, a chunk at a time from `from`, while
 * the workers read the parts found so far.
 */
function objectRanges(file: Blob, session: ReadSession, cuts: Float64Array, from: number, partSize: number): Ranges {
  const bounds = [...cuts];
  let found = false;
  let stopped = false;
  let error: unknown;
  let waiting: (() => void)[] = [];
  const wake = () => {
    for (const resume of waiting) resume();
    waiting = [];
  };
  const settled = (async () => {
    try {
      for (let at = from; at < file.size && !stopped; ) {
        const chunk = await bytesOf(file, at, at + CHUNK_BYTES);
        if (stopped) return;
        bounds.push(...(session.object_cuts(chunk, partSize) ?? []));
        at += chunk.length;
        wake();
      }
      if (bounds[bounds.length - 1] < file.size) bounds.push(file.size);
    } catch (err) {
      error = err;
    } finally {
      found = true;
      wake();
    }
  })();
  return {
    async get(index) {
      while (!stopped && !found && index + 1 >= bounds.length) await new Promise<void>((resume) => waiting.push(resume));
      if (error !== undefined) throw error;
      return !stopped && index + 1 < bounds.length ? [bounds[index], bounds[index + 1]] : undefined;
    },
    count: () => bounds.length - 1,
    stop() {
      stopped = true;
      wake();
    },
    settled,
  };
}

/**
 * Reads `file` into `session`, which was given its name and size. The first part is read here, up
 * to its last line break, or for a BLF log to the last object that ends in it; when it shows a log
 * that can be read in parts, the rest is read in parts of about `PART_BYTES` by `workers` workers,
 * and each joined as soon as the parts before it are. Otherwise the rest is read here in chunks.
 *
 * Returns false when a part was refused or a worker failed or didn't load in `READY_MS`: the
 * session then holds part of the log, and the log must be read again in a new session. Rejects
 * with the reason of `options.signal` once it is aborted, the session again holding part of the log.
 */
export async function readInParts(file: Blob, session: ReadSession, options: PartOptions, onProgress: (bytes: number) => void): Promise<boolean> {
  const { signal } = options;
  const partSize = options.partSize ?? PART_BYTES;
  const first = await bytesOf(file, 0, partSize);
  signal?.throwIfAborted();
  const firstCuts = session.object_cuts(first, partSize);
  const cut = firstCuts ? (firstCuts[0] ?? 0) : first.lastIndexOf(10) + 1;
  session.push_chunk(first.subarray(0, cut));
  const format = cut > 0 ? session.segment_format() : undefined;
  if (!format || cut === file.size) {
    session.push_chunk(first.subarray(cut));
    onProgress(first.length);
    await readChunks(file, (chunk) => session.push_chunk(chunk), onProgress, first.length, signal);
    return true;
  }
  onProgress(cut);

  const exact = firstCuts !== undefined;
  const ranges = exact ? objectRanges(file, session, firstCuts, first.length, partSize) : lineRanges(cut, partSize, file.size);
  const head = first.slice(0, Math.min(HEAD_BYTES, cut));
  // Parts read ahead of the next to join wait here, so that at most this many are held.
  const ahead = 2 * options.workers;
  const done = new Map<number, { segment: Uint8Array; end: number }>();
  let next = 0;
  let joined = 0;
  let failed = false;
  let wake: (() => void)[] = [];
  const workers: PartWorker[] = [];

  const fail = () => {
    failed = true;
    ranges.stop();
    for (const worker of workers) worker.close();
    for (const resume of wake) resume();
    wake = [];
  };

  const join = () => {
    for (let part = done.get(joined); part && !failed; part = done.get(joined)) {
      done.delete(joined);
      let joinedPart = false;
      try {
        joinedPart = session.push_segment(part.segment);
      } finally {
        if (!joinedPart) fail();
      }
      if (!joinedPart) return;
      joined += 1;
      onProgress(part.end);
    }
    for (const resume of wake) resume();
    wake = [];
  };

  const giveUp = (err: unknown) => {
    if (!failed) {
      console.warn(`Reading the log in parts failed, so it is read again in one worker: ${err instanceof Error ? err.message : String(err)}`);
      if (err instanceof Stalled) options.onStalled?.();
    }
    fail();
  };

  const lane = async (worker: PartWorker) => {
    try {
      await withDeadline(worker.ready, READY_MS);
    } catch (err) {
      giveUp(err);
      return;
    }
    while (!failed) {
      const index = next++;
      while (!failed && index - joined >= ahead) await new Promise<void>((resume) => wake.push(resume));
      if (failed) return;
      try {
        const range = await ranges.get(index);
        if (!range || failed) return;
        const [start, end] = range;
        done.set(index, { segment: await worker.read({ file, format, head, start, end, exact }), end });
      } catch (err) {
        giveUp(err);
        return;
      }
      join();
    }
  };

  // Failing first means the parts the closed workers no longer read draw no warning.
  const stop = () => fail();
  signal?.addEventListener('abort', stop);
  try {
    const parts = Math.ceil((file.size - cut) / partSize);
    for (let i = 0; i < Math.min(options.workers, parts); i++) workers.push(options.startWorker());
    await Promise.all(workers.map(lane));
  } finally {
    signal?.removeEventListener('abort', stop);
    ranges.stop();
    for (const worker of workers) worker.close();
    // The session must not be read from once this returns.
    await ranges.settled;
  }
  signal?.throwIfAborted();
  return !failed && joined === ranges.count();
}
