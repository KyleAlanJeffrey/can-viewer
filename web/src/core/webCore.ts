import type {
  BitFlips,
  ByteComparison,
  ByteLane,
  Candidate,
  CaptureFrame,
  CompareOptions,
  CoreApi,
  Database,
  DiscoveryHints,
  ExportFormat,
  FindRule,
  FrameFilter,
  IdComparison,
  IdSummary,
  LogInfo,
  MessageSuggestions,
  Progress,
  RawSignalSpec,
  ScopedDatabase,
  SeriesInfo,
} from './api';
import { packFrames } from './captureFrames';
import { scanEach, suggestInSteps } from './discovery';
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
  /** Progress listeners by request id, so a log read in the queue behind another gets its own. */
  private readonly progress = new Map<number, (p: Progress) => void>();
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
        this.progress.get(msg.id)?.({ bytes: msg.bytes, total: msg.total });
        return;
      }
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if ('error' in msg) p.reject(msg.aborted ? new DOMException(msg.error, 'AbortError') : new Error(msg.error));
      else p.resolve(msg.result);
    };
    this.worker = worker;
  }

  /** `dead` won't answer again: fail what it owed, then start another unless it never worked. */
  private died(dead: Worker, answered: boolean, detail: string) {
    if (dead !== this.worker) return;
    dead.terminate();
    console.error(`The core worker stopped: ${detail || 'no detail'}`);
    this.progress.clear();
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
    return this.send<T>(this.nextId++, method, args);
  }

  /** Like `call`, handing `transfer` to the worker rather than copying it. */
  private callTransferring<T>(method: Request['method'], args: unknown[], transfer: Transferable[]): Promise<T> {
    return this.send<T>(this.nextId++, method, args, transfer);
  }

  private async callWithProgress<T>(method: Request['method'], onProgress: (p: Progress) => void, ...args: unknown[]) {
    const id = this.nextId++;
    this.progress.set(id, onProgress);
    try {
      return await this.send<T>(id, method, args);
    } finally {
      this.progress.delete(id);
    }
  }

  private send<T>(id: number, method: Request['method'], args: unknown[], transfer: Transferable[] = []): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.worker.postMessage({ id, method, args } satisfies Request, transfer);
    });
  }

  async openLog(file: Blob, name: string, onProgress: (p: Progress) => void): Promise<LogInfo> {
    return { ...(await this.callWithProgress<LogInfo>('openLog', onProgress, file, name)), name };
  }

  startCapture = (name: string, channel: string, startedAtMs: number) =>
    this.call<LogInfo>('startCapture', name, channel, startedAtMs);

  appendFrames(frames: CaptureFrame[]): Promise<LogInfo> {
    const packed = packFrames(frames);
    return this.callTransferring<LogInfo>('appendFrames', [packed], [packed.buffer]);
  }

  trimCapture = (beforeNs: number) => this.call<LogInfo>('trimCapture', beforeNs);

  endCapture = () => this.call<LogInfo>('endCapture');

  idSummary = () => this.call<IdSummary[]>('idSummary');
  rowCount = (key: number) => this.call<number>('rowCount', key);
  frameData = (key: number, row: number) => this.call<Uint8Array>('frameData', key, row);
  bitFlips = (key: number) => this.call<BitFlips>('bitFlips', key);
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
    return unpackLanes(await this.call<Float64Array>('byteLanes', key, first, count, t0, t1, buckets));
  }

  rowAtTime = (key: number, t: number) => this.call<number>('rowAtTime', key, t);
  rowCountBetween = (key: number, t0: number, t1: number) => this.call<number>('rowCountBetween', key, t0, t1);
  bitFlipsBetween = (key: number, t0: number, t1: number) => this.call<BitFlips>('bitFlipsBetween', key, t0, t1);
  decodeRaw = (key: number, spec: RawSignalSpec) => this.call<SeriesInfo>('decodeRaw', key, spec);
  exportDbc = (db: Database) => this.call<string>('exportDbc', db);
  setTraceFilter = (filter: FrameFilter | null) => this.call<number>('setTraceFilter', filter);
  filteredRowCount = () => this.call<number | null>('filteredRowCount');
  countFilterMatches = (filter: FrameFilter) => this.call<number | null>('countFilterMatches', filter);
  exportLog = (format: ExportFormat) => this.call<Blob>('exportLog', format);

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

  suggestSignals = (key: number, hints: DiscoveryHints = {}, signal?: AbortSignal) =>
    suggestInSteps(
      {
        begin: (k, h) => this.call<number>('suggestBegin', k, h),
        step: (job) => this.call<MessageSuggestions | null>('suggestStep', job),
        drop: (job) => this.call<void>('suggestDrop', job),
      },
      key,
      hints,
      signal,
    );

  scanSignals(
    keys: number[],
    hints: DiscoveryHints,
    onProgress: (done: number, total: number, latest: MessageSuggestions | null) => void,
    signal?: AbortSignal,
    skip?: (key: number) => boolean,
  ) {
    return scanEach(this.suggestSignals, keys, hints, onProgress, signal, skip);
  }

  openCompareLog(file: Blob, name: string, onProgress: (p: Progress) => void): Promise<LogInfo> {
    return this.callWithProgress<LogInfo>('openCompareLog', onProgress, file, name);
  }

  compareLogInfo = () => this.call<LogInfo | null>('compareLogInfo');
  closeCompareLog = () => this.call<void>('closeCompareLog');
  swapCompareLog = () => this.call<LogInfo>('swapCompareLog');
  compareLogs = (options: CompareOptions) => this.call<IdComparison[]>('compareLogs', options);
  compareFrameAt = (key: number, t: number) => this.call<Uint8Array>('compareFrameAt', key, t);

  compareBytes(keyA: number | null, keyB: number | null, options: CompareOptions) {
    return this.call<ByteComparison>('compareBytes', keyA, keyB, options);
  }

  async compareByteLanes(key: number, first: number, count: number, t0: number, t1: number, buckets: number): Promise<ByteLane[]> {
    return unpackLanes(await this.call<Float64Array>('compareByteLanes', key, first, count, t0, t1, buckets));
  }
}

/** Splits the worker's `[n, x..., y..., n, ...]` lanes into views of the one buffer. */
function unpackLanes(packed: Float64Array): ByteLane[] {
  const lanes: ByteLane[] = [];
  for (let at = 0; at < packed.length; ) {
    const n = packed[at];
    lanes.push({ x: packed.subarray(at + 1, at + 1 + n), y: packed.subarray(at + 1 + n, at + 1 + 2 * n) });
    at += 1 + 2 * n;
  }
  return lanes;
}
