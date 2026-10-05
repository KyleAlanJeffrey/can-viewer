/// Core worker: owns the wasm Session. Requests arrive as `{ id, method, args }` and are
/// answered with `{ id, result }` or `{ id, error }`; parse progress is pushed as events.

import type { Database, DiscoveryHints, FindRule, RawSignalSpec, ScopedDatabase } from './api';
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
    const started = performance.now();
    let lastReport = 0;
    try {
      session.set_file_name(name);
      session.reserve_for_bytes(file.size);
      for (let at = 0; at < file.size; at += CHUNK_BYTES) {
        const chunk = new Uint8Array(await file.slice(at, at + CHUNK_BYTES).arrayBuffer());
        session.push_chunk(chunk);
        const now = performance.now();
        if (now - lastReport > 100) {
          lastReport = now;
          port.postMessage({ event: 'progress', bytes: at + chunk.length, total: file.size });
        }
      }
      const info = JSON.parse(session.finish());
      return { ...info, parseMs: performance.now() - started, wasmBytes: memory?.buffer.byteLength ?? 0 };
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
  suggestSignals: (key: number, hints: DiscoveryHints) => JSON.parse(session.suggest_signals(key, JSON.stringify(hints ?? {}))),
  setDatabases(dbs: ScopedDatabase[]) {
    const json = JSON.stringify(dbs);
    session.set_databases(json);
    databasesJson = json;
  },
  exportDbc: (db: Database) => export_dbc(JSON.stringify(db)),
};

const withTransfer = new Set(['rows', 'frameData', 'rowBytes', 'bitFlips', 'seriesView', 'busLoad', 'bitFlipsBetween', 'changeActivity', 'byteLanes']);

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

port.onmessage = (e) => {
  const { id, method, args } = e.data;
  queue = queue.then(async () => {
    try {
      if (initError) throw initError;
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
