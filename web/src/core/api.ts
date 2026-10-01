import type { RowBatch } from './rows';

/** Pass as an ID key to mean "every frame" rather than one ID. */
export const ALL_IDS = -1;

export const FLAG_FD = 1 << 0;
export const FLAG_BRS = 1 << 1;
export const FLAG_RTR = 1 << 3;
export const FLAG_ERROR = 1 << 4;
export const EXT_FLAG = 0x8000_0000;

/** A log file format the engine reads. */
export type LogFormat = 'candump' | 'asc' | 'trc' | 'csv';

export interface LogInfo {
  name: string;
  /** The format the log was read as, chosen from the file name and its first bytes. */
  format: LogFormat;
  frames: number;
  bytes: number;
  lines: number;
  rejected: number;
  firstRejection: [number, string] | null;
  durationS: number;
  channels: string[];
  heapBytes: number;
  parseMs: number;
  wasmBytes: number;
  /** Frames flagged as CAN error frames. */
  errorFrames: number;
}

export interface Progress {
  bytes: number;
  total: number;
}

export interface IdSummary {
  /** `(channel << 32) | id`, unique per channel/ID pair. */
  key: number;
  channel: number;
  /** ID without the extended flag. Error frames keep the CAN error flag (0x20000000). */
  id: number;
  extended: boolean;
  count: number;
  periodMs: number | null;
  /** Standard deviation (population) of the gap between frames, or null with fewer than three frames. */
  jitterMs: number | null;
  minLen: number;
  maxLen: number;
  flags: number;
  name: string | null;
  /** Index in the last `setDatabases` array of the DBC that decodes this ID, or null. */
  dbc: number | null;
  /** That DBC's message ID (DBC convention), which differs from this ID for a J1939 match. */
  messageId: number | null;
}

export interface SignalDef {
  name: string;
  startBit: number;
  size: number;
  byteOrder: 'intel' | 'motorola';
  kind: 'unsigned' | 'signed' | 'float32' | 'float64';
  factor: number;
  offset: number;
  min: number;
  max: number;
  unit: string;
  isMultiplexor: boolean;
  muxValue: number | null;
  valueTable: [number, string][];
  comment: string | null;
  /** Receiving nodes. Absent means none. */
  receivers?: string[];
}

export interface MessageDef {
  /** DBC convention: bit 31 set for extended IDs. */
  id: number;
  name: string;
  size: number;
  transmitter: string | null;
  comment: string | null;
  signals: SignalDef[];
  /**
   * A J1939 parameter group (DBC `VFrameFormat` J1939PG). It decodes every frame with its PGN,
   * whatever the priority and source address (the source must match for proprietary PGNs), and
   * raw values J1939 reserves for error and not available decode as no value. Absent means false.
   */
  j1939?: boolean;
}

export interface Database {
  name: string;
  messages: MessageDef[];
}

/** One loaded DBC and the bus it applies to. */
export interface ScopedDatabase {
  /** Bus name (as in `LogInfo.channels`) this DBC applies to, or null for every bus. */
  channel: string | null;
  db: Database;
}

/** A bit range of one message, decoded without a database entry. */
export interface RawSignalSpec {
  startBit: number;
  size: number;
  byteOrder: 'intel' | 'motorola';
  signed: boolean;
  factor: number;
  offset: number;
}

export type Behaviour = 'increases' | 'decreases' | 'constant' | 'changes';

/** One clause of a Find Signal query: the signal does `behaviour` between t0 and t1 seconds. */
export interface FindRule {
  behaviour: Behaviour;
  t0: number;
  t1: number;
}

export interface Candidate {
  key: number;
  spec: RawSignalSpec;
  /** 0..1, how well the candidate follows every rule. */
  score: number;
}

export interface SeriesInfo {
  handle: number;
  name: string;
  unit: string;
  count: number;
  /** Null when the series has no points, e.g. every J1939 value was not available. */
  min: number | null;
  max: number | null;
}

/**
 * Everything the UI needs from the engine. The web build talks to a wasm Web Worker; the
 * desktop build will implement this over Tauri commands with the same Rust crates running
 * natively.
 */
export interface CoreApi {
  openLog(file: Blob, name: string, onProgress: (p: Progress) => void): Promise<LogInfo>;
  idSummary(): Promise<IdSummary[]>;
  rowCount(key: number): Promise<number>;
  rows(key: number, start: number, count: number): Promise<RowBatch>;
  bitFlips(key: number): Promise<Uint32Array>;
  /** Parse a DBC file. Nothing changes until it is passed to `setDatabases`. */
  parseDbc(file: Blob, name: string): Promise<Database>;
  decodeSignal(key: number, signal: string): Promise<SeriesInfo>;
  /** Min/max-decimated points between t0 and t1 seconds, about `2 * buckets` of them. */
  seriesView(handle: number, t0: number, t1: number, buckets: number): Promise<[Float64Array, Float64Array]>;
  dropSeries(handle: number): Promise<void>;

  /** Index of the first row of `key` (or ALL_IDS) at or after `t` seconds, clamped to the last row. */
  rowAtTime(key: number, t: number): Promise<number>;
  /**
   * Estimated load (0..1) of one bus at `bitrate` bit/s, in `buckets` buckets between t0 and t1
   * seconds: [bucket centre times, load]. Counts frame bits without stuffing; CAN FD frames as if
   * sent entirely at `bitrate`. Error frames are skipped. Each frame counts towards the bucket of
   * its timestamp, so very short buckets can read high; loads are capped at 1.
   */
  busLoad(channel: number, t0: number, t1: number, buckets: number, bitrate: number): Promise<[Float64Array, Float64Array]>;
  /** Like `bitFlips`, counting only changes between consecutive frames inside [t0, t1] seconds. */
  bitFlipsBetween(key: number, t0: number, t1: number): Promise<Uint32Array>;
  /**
   * Payload bits that changed, per bucket, for one ID across [t0, t1] seconds: an activity strip.
   * Each frame is compared with the previous frame of the ID, even if that one is before t0.
   */
  changeActivity(key: number, t0: number, t1: number, buckets: number): Promise<Uint32Array>;
  /** Decode any bit range of one ID across the log, for signals not (yet) in the database. */
  decodeRaw(key: number, spec: RawSignalSpec): Promise<SeriesInfo>;
  /**
   * Rank bit ranges of `keys` (every ID when empty) by how well they follow every rule, best first.
   * Candidates are unsigned 8- and 16-bit ranges in both byte orders. Per rule, over the steps
   * between consecutive frames in its window: increases scores (up - down) / (moves + 1),
   * decreases the mirror, changes moves / steps, constant 1 - moves / steps. A candidate's score
   * is the product over rules; see `find_signal` in crates/can-wasm/src/find.rs.
   */
  findSignal(rules: FindRule[], keys: number[], limit: number): Promise<Candidate[]>;
  /**
   * Replace the loaded databases. A message is looked up in order, in the first database whose
   * `channel` is null or names its bus. Series handles stay valid; series decoded under the old
   * databases keep their values until decoded again. Survives opening another log.
   */
  setDatabases(dbs: ScopedDatabase[]): Promise<void>;
  /** `db` as DBC text. */
  exportDbc(db: Database): Promise<string>;
}

/** Key for the DBC message map: the ID with the extended flag, as in DBC files. */
export function dbcId(s: Pick<IdSummary, 'id' | 'extended'>): number {
  return s.extended ? (s.id | EXT_FLAG) >>> 0 : s.id;
}

/** Error frames come from no DBC message, so they are never unknown IDs to decode. */
export function isErrorFrame(s: Pick<IdSummary, 'flags'>): boolean {
  return (s.flags & FLAG_ERROR) !== 0;
}

export function formatId(id: number, extended: boolean): string {
  return extended ? id.toString(16).toUpperCase().padStart(8, '0') : id.toString(16).toUpperCase().padStart(3, '0');
}
