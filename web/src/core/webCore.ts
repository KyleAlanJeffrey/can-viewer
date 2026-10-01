import type { ByteLane, Candidate, CoreApi, Database, FindRule, IdSummary, LogInfo, Progress, RawSignalSpec, ScopedDatabase, SeriesInfo } from './api';
import { RowBatch } from './rows';
import type { Request } from './worker';

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

const RESTARTED = 'The CAN core stopped and was restarted. Open the log again.';
const NOT_STARTED = "The app's core stopped working. Reload the page to start it again.";

/** `CoreApi` backed by the wasm core running in a Web Worker. */
export class WebCore implements CoreApi {
  private worker!: Worker;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private onProgress: ((p: Progress) => void) | null = null;
  /** Set when a worker died before answering anything, so another would only fail the same way. */
  private failure: Error | null = null;
  /** The last databases set, so a restarted worker gets them back. */
  private databases: ScopedDatabase[] | null = null;
  private readonly resetListeners = new Set<() => void>();

  constructor() {
    this.start();
  }

  private start() {
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    let answered = false;
    worker.onerror = (e) => this.died(worker, answered, e.message);
    worker.onmessageerror = () => this.died(worker, answered, "A reply from the app's core couldn't be read.");
    worker.onmessage = (e: MessageEvent) => {
      answered = true;
      const msg = e.data;
      if (msg.event === 'progress') {
        this.onProgress?.(msg as Progress);
        return;
      }
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if ('error' in msg) p.reject(new Error(msg.error));
      else p.resolve(msg.result);
    };
    this.worker = worker;
  }

  /** `dead` won't answer again: fail what it owed, then start another unless it never worked. */
  private died(dead: Worker, answered: boolean, detail: string) {
    if (dead !== this.worker) return;
    dead.terminate();
    console.error(`The core worker stopped: ${detail || 'no detail'}`);
    this.onProgress = null;
    if (!answered) this.failure = new Error(detail || NOT_STARTED);
    const reason = this.failure ?? new Error(RESTARTED);
    for (const p of this.pending.values()) p.reject(reason);
    this.pending.clear();
    if (this.failure) return;
    this.start();
    if (this.databases) this.setDatabases(this.databases).catch(() => undefined);
    for (const listener of this.resetListeners) listener();
  }

  onReset(listener: () => void): () => void {
    this.resetListeners.add(listener);
    return () => {
      this.resetListeners.delete(listener);
    };
  }

  private call<T>(method: Request['method'], ...args: unknown[]): Promise<T> {
    const id = this.nextId++;
    if (this.failure) return Promise.reject(this.failure);
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.worker.postMessage({ id, method, args } satisfies Request);
    });
  }

  async openLog(file: Blob, name: string, onProgress: (p: Progress) => void): Promise<LogInfo> {
    this.onProgress = onProgress;
    try {
      return { ...(await this.call<LogInfo>('openLog', file)), name };
    } finally {
      this.onProgress = null;
    }
  }

  idSummary = () => this.call<IdSummary[]>('idSummary');
  rowCount = (key: number) => this.call<number>('rowCount', key);
  frameData = (key: number, row: number) => this.call<Uint8Array>('frameData', key, row);
  bitFlips = (key: number) => this.call<Uint32Array>('bitFlips', key);
  decodeSignal = (key: number, signal: string) => this.call<SeriesInfo>('decodeSignal', key, signal);
  dropSeries = (handle: number) => this.call<void>('dropSeries', handle);

  async rows(key: number, start: number, count: number): Promise<RowBatch> {
    const bytes = await this.call<Uint8Array>('rows', key, start, count);
    return new RowBatch(key, start, bytes.buffer as ArrayBuffer);
  }

  rowBytes(key: number, start: number, count: number, first: number, byteCount: number) {
    return this.call<Uint16Array>('rowBytes', key, start, count, first, byteCount);
  }

  async parseDbc(file: Blob, name: string): Promise<Database> {
    return { ...(await this.call<Omit<Database, 'name'>>('parseDbc', file)), name };
  }

  seriesView(handle: number, t0: number, t1: number, buckets: number) {
    return this.call<[Float64Array, Float64Array]>('seriesView', handle, t0, t1, buckets);
  }

  async byteLanes(key: number, first: number, count: number, t0: number, t1: number, buckets: number): Promise<ByteLane[]> {
    const packed = await this.call<Float64Array>('byteLanes', key, first, count, t0, t1, buckets);
    const lanes: ByteLane[] = [];
    for (let at = 0; at < packed.length; ) {
      const n = packed[at];
      lanes.push({ x: packed.subarray(at + 1, at + 1 + n), y: packed.subarray(at + 1 + n, at + 1 + 2 * n) });
      at += 1 + 2 * n;
    }
    return lanes;
  }

  rowAtTime = (key: number, t: number) => this.call<number>('rowAtTime', key, t);
  rowCountBetween = (key: number, t0: number, t1: number) => this.call<number>('rowCountBetween', key, t0, t1);
  bitFlipsBetween = (key: number, t0: number, t1: number) => this.call<Uint32Array>('bitFlipsBetween', key, t0, t1);
  decodeRaw = (key: number, spec: RawSignalSpec) => this.call<SeriesInfo>('decodeRaw', key, spec);
  exportDbc = (db: Database) => this.call<string>('exportDbc', db);

  setDatabases(dbs: ScopedDatabase[]) {
    this.databases = dbs;
    return this.call<void>('setDatabases', dbs);
  }

  busLoad(channel: number, t0: number, t1: number, buckets: number, bitrate: number) {
    return this.call<[Float64Array, Float64Array]>('busLoad', channel, t0, t1, buckets, bitrate);
  }

  changeActivity(key: number, t0: number, t1: number, buckets: number) {
    return this.call<Uint32Array>('changeActivity', key, t0, t1, buckets);
  }

  findSignal(rules: FindRule[], keys: number[], limit: number) {
    return this.call<Candidate[]>('findSignal', rules, keys, limit);
  }
}
