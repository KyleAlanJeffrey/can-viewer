/// Core worker: owns the wasm Session. Requests arrive as `{ id, method, args }` and are
/// answered with `{ id, result }` or `{ id, error }`; parse progress is pushed as events.

import type { CompareOptions, Database, DiscoveryHints, ExportFormat, FindRule, FrameFilter, LogInfo, RawSignalSpec, ScopedDatabase } from './api';
import init, { Session, export_dbc, parse_dbc } from './pkg/can_wasm.js';
import { readChunks as readChunksFrom, readInParts, type PartTask, type PartWorker } from './readInParts';

/** Smaller logs are read in this worker alone: starting part workers would cost more than they save. */
const PARTS_MIN_BYTES = 32 << 20;
/** Part workers at most, each holding a part's text and frames (tens of MB) while it reads. */
const MAX_PART_WORKERS = 6;
/** Frames a filter count goes through before the requests sent meanwhile may run. */
const COUNT_STEP_FRAMES = 1 << 19;

interface WorkerPort {
  onmessage: ((e: MessageEvent<Request>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

export interface Request {
  id: number;
  method: keyof typeof handlers | 'countFilterMatches';
  args: unknown[];
}

const port = self as unknown as WorkerPort;
const ready = init();
let memory: WebAssembly.Memory | null = null;
/** Created once wasm has loaded; every handler runs after that (see `queue`). */
let session: Session;
/** The current databases as JSON, kept so they (with any edits) survive opening another log. */
let databasesJson: string | null = null;

/** What the engine doesn't know about a log it read: its name and how long it took. */
type LogMeta = Pick<LogInfo, 'name' | 'parseMs'>;
let logMeta: LogMeta = { name: '', parseMs: 0 };
let compareMeta: LogMeta | null = null;

const withMemory = (json: string, meta: LogMeta) => ({ ...JSON.parse(json), ...meta, wasmBytes: memory?.buffer.byteLength ?? 0 });

/** The request being answered, so its progress events reach the right listener. */
let currentId = 0;

/**
 * Reports the bytes of `file` read so far, at most every 100 ms. A log read again in one worker
 * after its parts failed starts from 0, so the bar holds at the most it showed until then.
 */
function progressOf(file: Blob): (bytes: number) => void {
  let lastReport = 0;
  let most = 0;
  return (bytes) => {
    most = Math.max(most, bytes);
    const now = performance.now();
    if (now - lastReport > 100) {
      lastReport = now;
      port.postMessage({ event: 'progress', id: currentId, bytes: most, total: file.size });
    }
  };
}

/** Reads `file` in chunks through `push`, reporting progress. */
function readChunks(file: Blob, push: (chunk: Uint8Array) => void, onProgress = progressOf(file)) {
  return readChunksFrom(file, push, onProgress);
}

/**
 * Set when a part worker can't start (it can't be created, its script or wasm fails to load, or it
 * doesn't load in `READY_MS`), so later logs are read in this worker alone. Some browsers,
 * Electron's among them, start no workers from a worker.
 */
let partWorkersFailed = false;

/** How many part workers to read `file` with, or 0 to read it here. One core is left for this worker. */
function partWorkerCount(file: Blob): number {
  if (file.size < PARTS_MIN_BYTES || typeof Worker === 'undefined' || partWorkersFailed) return 0;
  const workers = Math.min(MAX_PART_WORKERS, (navigator.hardwareConcurrency || 1) - 1);
  return workers > 1 ? workers : 0;
}

/** What a part worker posts: that it loaded or couldn't, then a part or the error reading it. */
type PartReply = { ready: true } | { startError: string } | { segment: Uint8Array } | { error: string };

function startPartWorker(): PartWorker {
  let worker: Worker;
  try {
    worker = new Worker(new URL('./partWorker.ts', import.meta.url), { type: 'module' });
  } catch (err) {
    partWorkersFailed = true;
    const failure = new Error(`a part worker couldn't start: ${err instanceof Error ? err.message : String(err)}`);
    return { ready: Promise.reject(failure), read: () => Promise.reject(failure), close() {} };
  }
  let started: { resolve: () => void; reject: (err: Error) => void } | null = null;
  const ready = new Promise<void>((resolve, reject) => {
    started = { resolve, reject };
  });
  const cannotStart = (message: string) => {
    started?.reject(new Error(message));
    started = null;
  };
  let pending: { resolve: (segment: Uint8Array) => void; reject: (err: Error) => void } | null = null;
  const fail = (message: string) => {
    pending?.reject(new Error(message));
    pending = null;
  };
  worker.onmessage = (e: MessageEvent<PartReply>) => {
    if ('ready' in e.data) {
      started?.resolve();
      started = null;
      return;
    }
    if ('startError' in e.data) {
      partWorkersFailed = true;
      cannotStart(e.data.startError);
      return;
    }
    if ('error' in e.data) fail(e.data.error);
    else pending?.resolve(e.data.segment);
    pending = null;
  };
  worker.onerror = (e) => {
    // Handled here, so it doesn't reach the page as a failure of this worker.
    e.preventDefault();
    partWorkersFailed = true;
    const message = e.message || 'a part worker stopped';
    cannotStart(message);
    fail(message);
  };
  worker.onmessageerror = () => fail("a part worker's reply couldn't be read");
  return {
    ready,
    read(task: PartTask) {
      return new Promise<Uint8Array>((resolve, reject) => {
        pending = { resolve, reject };
        worker.postMessage(task);
      });
    },
    close() {
      worker.terminate();
      cannotStart('closed');
      fail('closed');
    },
  };
}

function freshSession(): Session {
  const next = new Session();
  if (databasesJson) next.set_databases(databasesJson);
  return next;
}

/** A result plus the buffers to transfer rather than copy. */
function transfer<T extends ArrayBufferView>(view: T): [T, Transferable[]] {
  return [view, [view.buffer]];
}

/** Splits `[x..., y...]` into its two halves, transferring the shared buffer. */
function halves(xy: Float64Array): [[Float64Array, Float64Array], Transferable[]] {
  const n = xy.length / 2;
  return [[xy.subarray(0, n), xy.subarray(n)], [xy.buffer]];
}

const handlers = {
  async openLog(file: Blob, name: string) {
    session.free();
    session = freshSession();
    compareMeta = null;
    const started = performance.now();
    try {
      session.set_file_name(name);
      session.reserve_for_bytes(file.size);
      const workers = partWorkerCount(file);
      const progress = progressOf(file);
      const onStalled = () => {
        partWorkersFailed = true;
      };
      const read = workers > 0 && (await readInParts(file, session, { workers, startWorker: startPartWorker, onStalled }, progress));
      if (!read) {
        if (workers > 0) {
          // It holds part of the log.
          session.free();
          session = freshSession();
          session.set_file_name(name);
          session.reserve_for_bytes(file.size);
        }
        await readChunks(file, (chunk) => session.push_chunk(chunk), progress);
      }
      const json = session.finish();
      logMeta = { name, parseMs: performance.now() - started };
      return withMemory(json, logMeta);
    } catch (err) {
      // Leave no log rather than part of one; the app shows no log after a failed open.
      try {
        session.free();
      } catch {
        // A session that trapped mid-call can't be freed.
      }
      session = freshSession();
      throw err;
    }
  },
  startCapture(name: string, channel: string, startedAtMs: number) {
    session.free();
    session = freshSession();
    compareMeta = null;
    logMeta = { name, parseMs: 0 };
    session.start_capture(channel, startedAtMs);
    return withMemory(session.log_info(), logMeta);
  },
  appendFrames: (packed: Uint8Array) => withMemory(session.push_frames(packed), logMeta),
  trimCapture: (beforeNs: number) => withMemory(session.trim_capture(beforeNs), logMeta),
  endCapture: () => withMemory(session.finish_capture(), logMeta),
  idSummary: () => JSON.parse(session.id_summary()),
  rowCount: (key: number) => session.row_count(key),
  rows: (key: number, start: number, count: number) => transfer(session.rows(key, start, count)),
  frameData: (key: number, row: number) => transfer(session.frame_data(key, row)),
  rowBytes: (key: number, start: number, count: number, first: number, byteCount: number) =>
    transfer(session.row_bytes(key, start, count, first, byteCount)),
  bitFlips: (key: number) => transfer(session.bit_flips(key)),
  parseDbc: async (file: Blob) => JSON.parse(parse_dbc(new Uint8Array(await file.arrayBuffer()))),
  decodeSignal: (key: number, signal: string) => JSON.parse(session.decode_signal(key, signal)),
  seriesView: (handle: number, t0: number, t1: number, buckets: number) =>
    halves(session.series_view(handle, t0, t1, buckets)),
  dropSeries: (handle: number) => session.drop_series(handle),
  byteLanes: (key: number, first: number, count: number, t0: number, t1: number, buckets: number) =>
    transfer(session.byte_lanes(key, first, count, t0, t1, buckets)),
  rowAtTime: (key: number, t: number) => session.row_at_time(key, t),
  rowCountBetween: (key: number, t0: number, t1: number) => session.row_count_between(key, t0, t1),
  busLoad: (channel: number, t0: number, t1: number, buckets: number, bitrate: number) =>
    halves(session.bus_load(channel, t0, t1, buckets, bitrate)),
  bitFlipsBetween: (key: number, t0: number, t1: number) => transfer(session.bit_flips_between(key, t0, t1)),
  flipPairsBetween: (key: number, t0: number, t1: number) => session.flip_pairs_between(key, t0, t1),
  changeActivity: (key: number, t0: number, t1: number, buckets: number) =>
    transfer(session.change_activity(key, t0, t1, buckets)),
  decodeRaw: (key: number, spec: RawSignalSpec) => JSON.parse(session.decode_raw(key, JSON.stringify(spec))),
  findSignal: (rules: FindRule[], keys: number[], limit: number) =>
    JSON.parse(session.find_signal(JSON.stringify(rules), Float64Array.from(keys), limit)),
  suggestBegin: (key: number, hints: DiscoveryHints) => session.suggest_begin(key, JSON.stringify(hints ?? {})),
  suggestStep(job: number) {
    const json = session.suggest_step(job);
    return json === undefined ? null : JSON.parse(json);
  },
  suggestDrop: (job: number) => session.suggest_drop(job),
  setDatabases(dbs: ScopedDatabase[]) {
    const json = JSON.stringify(dbs);
    session.set_databases(json);
    databasesJson = json;
  },
  exportDbc: (db: Database) => export_dbc(JSON.stringify(db)),
  async openCompareLog(file: Blob, name: string) {
    compareMeta = null;
    const started = performance.now();
    try {
      session.compare_begin(name, file.size);
      await readChunks(file, (chunk) => session.compare_push_chunk(chunk));
      const json = session.compare_finish();
      compareMeta = { name, parseMs: performance.now() - started };
      return withMemory(json, compareMeta);
    } catch (err) {
      try {
        session.close_compare_log();
      } catch {
        // A session that trapped mid-call is replaced anyway.
      }
      throw err;
    }
  },
  compareLogInfo() {
    const json = session.compare_log_info();
    return json && compareMeta ? withMemory(json, compareMeta) : null;
  },
  closeCompareLog() {
    session.close_compare_log();
    compareMeta = null;
  },
  swapCompareLog() {
    const json = session.swap_compare_log();
    [logMeta, compareMeta] = [compareMeta ?? logMeta, logMeta];
    return withMemory(json, logMeta);
  },
  compareLogs: (options: CompareOptions) => JSON.parse(session.compare_logs(JSON.stringify(options))),
  compareBytes: (keyA: number | null, keyB: number | null, options: CompareOptions) =>
    JSON.parse(session.compare_bytes(keyA ?? -1, keyB ?? -1, JSON.stringify(options))),
  compareByteLanes: (key: number, first: number, count: number, t0: number, t1: number, buckets: number) =>
    transfer(session.compare_byte_lanes(key, first, count, t0, t1, buckets)),
  compareFrameAt: (key: number, t: number) => transfer(session.compare_frame_at(key, t)),
  setTraceFilter: (filter: FrameFilter | null) => session.set_trace_filter(JSON.stringify(filter)),
  filteredRowCount: () => session.filtered_row_count() ?? null,
  exportLog(format: ExportFormat) {
    session.export_log(format);
    // Taken a chunk at a time, so the core frees each as it is copied out, and added to the
    // Blob at once, so each copy can be collected rather than all being held to the end. A
    // Blob made from a Blob shares its data, and so does posting the result to the page.
    let file = new Blob([]);
    for (let part = session.export_chunk(); part; part = session.export_chunk()) {
      // wasm-bindgen copies each chunk into an ArrayBuffer of its own, never a shared one.
      file = new Blob([file, part as Uint8Array<ArrayBuffer>]);
    }
    return file;
  },
};

const withTransfer = new Set(['rows', 'frameData', 'rowBytes', 'bitFlips', 'seriesView', 'busLoad', 'bitFlipsBetween', 'changeActivity', 'byteLanes', 'compareByteLanes', 'compareFrameAt']);

// Requests run one at a time so a request never observes a half-parsed log.
let initError: unknown = null;
let queue: Promise<void> = ready.then(
  (exports) => {
    memory = exports.memory;
    session = new Session();
  },
  (err) => {
    initError = err;
  },
);

function enqueue(task: () => Promise<void>) {
  queue = queue.then(task);
}

function answerError(id: number, err: unknown) {
  port.postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  // A trapped instance can't be trusted afterwards. Thrown uncaught, it reaches the page's
  // worker.onerror, which starts a new worker.
  if (err instanceof WebAssembly.RuntimeError) {
    setTimeout(() => {
      throw err;
    });
  }
}

async function run(id: number, method: keyof typeof handlers, args: unknown[]) {
  try {
    if (initError) throw initError;
    currentId = id;
    const handler = handlers[method] as (...a: unknown[]) => unknown;
    const out = await handler(...args);
    if (withTransfer.has(method)) {
      const [result, buffers] = out as [unknown, Transferable[]];
      port.postMessage({ id, result }, buffers);
    } else {
      port.postMessage({ id, result: out });
    }
  } catch (err) {
    answerError(id, err);
  }
}

/** The newest count or filter request: a count older than it stops, answered with null. */
let latestCount = 0;
/** The count the session holds, if it is still running. */
let runningCount = 0;

/**
 * One step of a filter count. The next step joins the queue behind the requests sent
 * meanwhile, so a count delays them by one step at most, and a newer count or filter stops it.
 */
async function countStep(id: number, filter: FrameFilter) {
  if (id !== latestCount) {
    port.postMessage({ id, result: null });
    return;
  }
  try {
    if (initError) throw initError;
    // A new log, or the end of a capture, drops the count the session held; it starts over.
    if (runningCount !== id || !session.count_running()) {
      runningCount = id;
      session.count_begin(JSON.stringify(filter));
    }
    const count = session.count_step(COUNT_STEP_FRAMES);
    if (count === undefined) {
      await new Promise((resolve) => setTimeout(resolve));
      enqueue(() => countStep(id, filter));
      return;
    }
    port.postMessage({ id, result: count });
  } catch (err) {
    answerError(id, err);
  }
}

port.onmessage = (e) => {
  const { id, method, args } = e.data;
  if (method === 'countFilterMatches' || method === 'setTraceFilter') latestCount = id;
  if (method === 'countFilterMatches') enqueue(() => countStep(id, args[0] as FrameFilter));
  else enqueue(() => run(id, method, args));
};
