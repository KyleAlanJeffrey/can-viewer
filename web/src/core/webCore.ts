import type { Candidate, CoreApi, Database, FindRule, IdSummary, LogInfo, Progress, RawSignalSpec, ScopedDatabase, SeriesInfo } from './api';
import { RowBatch } from './rows';
import type { Request } from './worker';

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

/** `CoreApi` backed by the wasm core running in a Web Worker. */
export class WebCore implements CoreApi {
  private readonly worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private onProgress: ((p: Progress) => void) | null = null;
  /** Set when the worker itself failed, for example its script didn't load; it won't answer again. */
  private failure: Error | null = null;

  constructor() {
    const fail = (message: string) => {
      this.failure = new Error(message);
      for (const p of this.pending.values()) p.reject(this.failure);
      this.pending.clear();
    };
    this.worker.onerror = (e) => fail(e.message || "The app's core stopped working. Reload the page to start it again.");
    this.worker.onmessageerror = () => fail("A reply from the app's core couldn't be read. Reload the page to start it again.");
    this.worker.onmessage = (e: MessageEvent) => {
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
  bitFlips = (key: number) => this.call<Uint32Array>('bitFlips', key);
  decodeSignal = (key: number, signal: string) => this.call<SeriesInfo>('decodeSignal', key, signal);
  dropSeries = (handle: number) => this.call<void>('dropSeries', handle);

  async rows(key: number, start: number, count: number): Promise<RowBatch> {
    const bytes = await this.call<Uint8Array>('rows', key, start, count);
    return new RowBatch(key, start, bytes.buffer as ArrayBuffer);
  }

  async parseDbc(file: Blob, name: string): Promise<Database> {
    return { ...(await this.call<Omit<Database, 'name'>>('parseDbc', file)), name };
  }

  seriesView(handle: number, t0: number, t1: number, buckets: number) {
    return this.call<[Float64Array, Float64Array]>('seriesView', handle, t0, t1, buckets);
  }

  rowAtTime = (key: number, t: number) => this.call<number>('rowAtTime', key, t);
  bitFlipsBetween = (key: number, t0: number, t1: number) => this.call<Uint32Array>('bitFlipsBetween', key, t0, t1);
  decodeRaw = (key: number, spec: RawSignalSpec) => this.call<SeriesInfo>('decodeRaw', key, spec);
  setDatabases = (dbs: ScopedDatabase[]) => this.call<void>('setDatabases', dbs);
  exportDbc = (db: Database) => this.call<string>('exportDbc', db);

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
