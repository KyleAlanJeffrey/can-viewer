/// Reading a log file into the core's session: in chunks, or, for a large text log, in parts
/// parsed by a pool of workers and joined by the session in file order. The session checks
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

/** The `Session` calls a read uses. */
export interface ReadSession {
  push_chunk(chunk: Uint8Array): void;
  segment_format(): string | undefined;
  push_segment(segment: Uint8Array): boolean;
}

/** One part for a worker: the lines of `file` that start in `[start, end)`. */
export interface PartTask {
  file: Blob;
  /** `LogInfo.format` of the log. */
  format: string;
  head: Uint8Array;
  start: number;
  end: number;
}

/** A worker that reads parts, one at a time. */
export interface PartWorker {
  /** The part read by `parse_segment`; rejects when the worker fails or is closed. */
  read(task: PartTask): Promise<Uint8Array>;
  close(): void;
}

export interface PartOptions {
  workers: number;
  startWorker: () => PartWorker;
  /** Bytes in the first chunk and in each part, `PART_BYTES` unless set. */
  partSize?: number;
}

async function bytesOf(file: Blob, start: number, end: number): Promise<Uint8Array> {
  return new Uint8Array(await file.slice(start, end).arrayBuffer());
}

/** Reads `file` from `from` in chunks through `push`, reporting the bytes read. */
export async function readChunks(file: Blob, push: (chunk: Uint8Array) => void, onProgress: (bytes: number) => void, from = 0) {
  for (let at = from; at < file.size; at += CHUNK_BYTES) {
    const chunk = await bytesOf(file, at, at + CHUNK_BYTES);
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

/**
 * Reads `file` into `session`, which was given its name and size. The first part is read here, up
 * to its last line break; when it shows a text log that can be read in parts, the rest is read in
 * parts of about `PART_BYTES` by `workers` workers, and each joined as soon as the parts before it
 * are. Otherwise the rest is read here in chunks.
 *
 * Returns false when a part was refused or a worker failed: the session then holds part of the
 * log, and the log must be read again in a new session.
 */
export async function readInParts(file: Blob, session: ReadSession, options: PartOptions, onProgress: (bytes: number) => void): Promise<boolean> {
  const partSize = options.partSize ?? PART_BYTES;
  const first = await bytesOf(file, 0, partSize);
  const cut = first.lastIndexOf(10) + 1;
  session.push_chunk(first.subarray(0, cut));
  const format = cut > 0 ? session.segment_format() : undefined;
  if (!format || cut === file.size) {
    session.push_chunk(first.subarray(cut));
    onProgress(first.length);
    await readChunks(file, (chunk) => session.push_chunk(chunk), onProgress, first.length);
    return true;
  }
  onProgress(cut);

  const starts: number[] = [];
  for (let at = cut; at < file.size; at += partSize) starts.push(at);
  const head = first.slice(0, Math.min(HEAD_BYTES, cut));
  // Parts read ahead of the next to join wait here, so that at most this many are held.
  const ahead = 2 * options.workers;
  const done = new Map<number, Uint8Array>();
  let next = 0;
  let joined = 0;
  let failed = false;
  let wake: (() => void)[] = [];
  const workers: PartWorker[] = [];

  const fail = () => {
    failed = true;
    for (const worker of workers) worker.close();
    for (const resume of wake) resume();
    wake = [];
  };

  const join = () => {
    for (let segment = done.get(joined); segment && !failed; segment = done.get(joined)) {
      done.delete(joined);
      if (!session.push_segment(segment)) {
        fail();
        return;
      }
      joined += 1;
      onProgress(Math.min(cut + joined * partSize, file.size));
    }
    for (const resume of wake) resume();
    wake = [];
  };

  const lane = async (worker: PartWorker) => {
    while (!failed && next < starts.length) {
      const index = next++;
      while (!failed && index - joined >= ahead) await new Promise<void>((resume) => wake.push(resume));
      if (failed) return;
      const start = starts[index];
      const end = Math.min(start + partSize, file.size);
      try {
        done.set(index, await worker.read({ file, format, head, start, end }));
      } catch (err) {
        if (!failed) console.warn(`Reading the log in parts failed, so it is read again in one worker: ${err instanceof Error ? err.message : String(err)}`);
        fail();
        return;
      }
      join();
    }
  };

  try {
    for (let i = 0; i < Math.min(options.workers, starts.length); i++) workers.push(options.startWorker());
    await Promise.all(workers.map(lane));
  } finally {
    for (const worker of workers) worker.close();
  }
  return !failed && joined === starts.length;
}
