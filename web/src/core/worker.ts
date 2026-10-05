/// Core worker: owns the wasm Session. Requests arrive as `{ id, method, args }` and are
/// answered with `{ id, result }` or `{ id, error }`; parse progress is pushed as events.

import type { CompareOptions, Database, FindRule, FrameFilter, LogFormat, LogInfo, RawSignalSpec, ScopedDatabase } from './api';
import init, { Session, export_dbc, parse_dbc } from './pkg/can_wasm.js';

const CHUNK_BYTES = 8 << 20;

interface WorkerPort {
  onmessage: ((e: MessageEvent<Request>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

export interface Request {
  id: number;
  method: keyof typeof handlers;
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

/** Reads `file` in chunks through `push`, reporting progress at most every 100 ms. */
async function readChunks(file: Blob, push: (chunk: Uint8Array) => void) {
  let lastReport = 0;
  for (let at = 0; at < file.size; at += CHUNK_BYTES) {
    const chunk = new Uint8Array(await file.slice(at, at + CHUNK_BYTES).arrayBuffer());
    push(chunk);
    const now = performance.now();
    if (now - lastReport > 100) {
      lastReport = now;
      port.postMessage({ event: 'progress', id: currentId, bytes: at + chunk.length, total: file.size });
    }
  }
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
      await readChunks(file, (chunk) => session.push_chunk(chunk));
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
  changeActivity: (key: number, t0: number, t1: number, buckets: number) =>
    transfer(session.change_activity(key, t0, t1, buckets)),
  decodeRaw: (key: number, spec: RawSignalSpec) => JSON.parse(session.decode_raw(key, JSON.stringify(spec))),
  findSignal: (rules: FindRule[], keys: number[], limit: number) =>
    JSON.parse(session.find_signal(JSON.stringify(rules), Float64Array.from(keys), limit)),
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
  countFilterMatches: (filter: FrameFilter) => session.count_filter_matches(JSON.stringify(filter)),
  exportLog(format: LogFormat) {
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

/** The newest count request; older ones still queued behind work are answered null unrun. */
let latestCount = 0;

port.onmessage = (e) => {
  const { id, method, args } = e.data;
  if (method === 'countFilterMatches') latestCount = id;
  queue = queue.then(async () => {
    try {
      if (initError) throw initError;
      if (method === 'countFilterMatches' && id !== latestCount) {
        port.postMessage({ id, result: null });
        return;
      }
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
      port.postMessage({ id, error: err instanceof Error ? err.message : String(err) });
      // A trapped instance can't be trusted afterwards. Thrown uncaught, it reaches the page's
      // worker.onerror, which starts a new worker.
      if (err instanceof WebAssembly.RuntimeError) {
        setTimeout(() => {
          throw err;
        });
      }
    }
  });
};
