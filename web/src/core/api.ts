import type { RowBatch } from './rows';

/** Pass as an ID key to mean "every frame" rather than one ID. */
export const ALL_IDS = -1;
/** Pass as a key to mean the rows the last `CoreApi.setTraceFilter` kept. */
export const FILTERED_ROWS = -2;

export const FLAG_FD = 1 << 0;
export const FLAG_BRS = 1 << 1;
/** CAN FD error state indicator: the sender was error passive. */
export const FLAG_ESI = 1 << 2;
export const FLAG_RTR = 1 << 3;
export const FLAG_ERROR = 1 << 4;
/** Not from the log: a J1939 parameter group reassembled from its transport protocol packets. */
export const FLAG_REASSEMBLED = 1 << 6;
export const EXT_FLAG = 0x8000_0000;
/** What `CoreApi.rowBytes` gives for a byte past the end of a frame. */
export const NO_BYTE = 0xffff;

/** A log file format the engine reads, or `capture` for frames recorded live (`startCapture`). */
export type LogFormat = 'candump' | 'asc' | 'trc' | 'csv' | 'blf' | 'mf4' | 'capture';
/** A format `exportLog` writes: every file format, not `capture`. */
export type ExportFormat = Exclude<LogFormat, 'capture'>;

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
  /**
   * J1939 transport protocol transfers reassembled into frames of their own (`FLAG_REASSEMBLED`),
   * counted in `frames` as well.
   */
  reassembledFrames: number;
}

/** One frame received by a live capture adapter. See `CoreApi.appendFrames`. */
export interface CaptureFrame {
  /** Nanoseconds since the capture started (`startedAtMs` of `startCapture`). */
  timeNs: number;
  /** The ID without flags: 11 or 29 bits. For an error frame, its error class. */
  id: number;
  extended: boolean;
  /** `FLAG_FD`, `FLAG_BRS`, `FLAG_ESI`, `FLAG_RTR` and `FLAG_ERROR`, as received. */
  flags: number;
  /** The payload, at most 64 bytes; empty for a remote frame. */
  data: Uint8Array;
  /** For a remote frame, the DLC it asks for (0 to 15). */
  dlc?: number;
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
  /**
   * Extended multiplexing (DBC `SG_MUL_VAL_`): the multiplexor that switches this signal and the
   * raw values of it under which the signal is present. Takes precedence over `muxValue`. Absent
   * or null means simple multiplexing by the message's multiplexor.
   */
  muxSwitch?: MuxSwitch | null;
  /** Attribute values (DBC `BA_ ... SG_`), kept for export. Absent means none. */
  attributes?: Attribute[];
}

/** An attribute value on one object (a DBC `BA_` line). Enum values are the choice's index. */
export interface Attribute {
  name: string;
  value: number | string;
}

/** What an attribute applies to; `network` is a `BA_DEF_` with no object type. */
export type AttributeObject = 'network' | 'node' | 'message' | 'signal' | 'envVar';

export type AttributeType =
  | { type: 'int'; min: number; max: number }
  | { type: 'hex'; min: number; max: number }
  | { type: 'float'; min: number; max: number }
  | { type: 'string' }
  | { type: 'enum'; choices: string[] };

/** A DBC `BA_DEF_` line with its `BA_DEF_DEF_` default. */
export interface AttributeDefinition {
  name: string;
  object: AttributeObject;
  kind: AttributeType;
  default: number | string | null;
}

/** A node declared in `BU_`. */
export interface NodeDef {
  name: string;
  comment?: string | null;
  attributes?: Attribute[];
}

/** A named value table (DBC `VAL_TABLE_`), kept for export; signals hold their own copies. */
export interface ValueTable {
  name: string;
  entries: [number, string][];
}

/** Which multiplexor switches a signal in, and when. The multiplexor may itself be multiplexed. */
export interface MuxSwitch {
  /** Name of the multiplexor signal, in the same message. */
  signal: string;
  /** Inclusive [low, high] raw value ranges of that signal under which this one is present. */
  ranges: [number, number][];
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
  /**
   * Sent as CAN FD (DBC `VFrameFormat` StandardCAN_FD or ExtendedCAN_FD). Only kept for export;
   * `j1939` wins when both are set. Absent means false.
   */
  fd?: boolean;
  /** Attribute values (DBC `BA_ ... BO_`) other than `VFrameFormat`. Absent means none. */
  attributes?: Attribute[];
}

export interface Database {
  name: string;
  messages: MessageDef[];
  /** Nodes declared in `BU_`. Export also lists any transmitter or receiver missing from here. */
  nodes?: NodeDef[];
  valueTables?: ValueTable[];
  /** `BA_DEF_` lines other than `VFrameFormat`, which export derives from `j1939` and `fd`. */
  attributeDefinitions?: AttributeDefinition[];
  /** Network attribute values (`BA_ "name" value;`). */
  attributes?: Attribute[];
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

/** What a suggested signal looks like it is. */
export type SuggestionKind = 'counter' | 'checksum' | 'flag' | 'enum' | 'continuous' | 'signed';

/** Optional help for `suggestSignals` and `scanSignals`. */
export interface DiscoveryHints {
  /** Times, in seconds, when something happened, such as a press of the brake pedal. The first 20 are used. */
  markers?: { t: number }[];
  /** A decoded signal (a `decodeSignal` pair) to compare value candidates with and fit a scale to. */
  reference?: { key: number; signal: string } | null;
}

/** A scale fitted from a reference signal: `reference = raw * factor + offset`. */
export interface SignalFit {
  /** The reference signal's name and unit. */
  reference: string;
  unit: string;
  /** Pearson correlation of the raw value with the reference, at least 0.8 in size. */
  r: number;
  factor: number;
  offset: number;
}

/** A likely signal in one message: a guess from how its bits change, to check before use. */
export interface Suggestion {
  kind: SuggestionKind;
  /** The bit range, with `factor` and `offset` from `fit` when there is one, else 1 and 0. */
  spec: RawSignalSpec;
  /** 0..1, how sure the guess is. */
  confidence: number;
  /** `confidence` in words: high from 0.85, medium from 0.6. */
  level: 'high' | 'medium' | 'low';
  /** One line on why, such as "Increments by 1 each frame; wraps at 255". */
  reason: string;
  /** A checksum whose rule held on only most frames, or that matched no known rule. */
  unconfirmed: boolean;
  /** About 64 evenly spaced values across the whole log, scaled by `spec`; times in seconds. */
  sparkline: { t: number[]; v: number[] };
  fit: SignalFit | null;
}

export interface MessageSuggestions {
  key: number;
  /** Frames of the ID in the log, and how many of them were read. */
  frames: number;
  sampledFrames: number;
  /** Best first; their bit ranges never overlap. */
  suggestions: Suggestion[];
}

/** What a frame is. Every frame is one kind; a CAN FD frame is a data frame. */
export type FrameKind = 'data' | 'remote' | 'error' | 'reassembled';

/** A condition on a frame's payload. Bit 0 is the least significant bit of its byte. */
export type DataRule =
  | { type: 'byteEquals'; byte: number; value: number }
  | { type: 'bit'; byte: number; bit: number; set: boolean }
  /** Some byte differs from the previous frame of the same ID and kind, over the bytes both have. */
  | { type: 'changes' };

/**
 * Which frames a filtered trace keeps; every part must match. A null list means no restriction,
 * and an empty list matches nothing.
 */
export interface FrameFilter {
  /** Bus indexes into `LogInfo.channels`. */
  channels: number[] | null;
  /** ID keys. */
  keys: number[] | null;
  kinds: FrameKind[] | null;
  /** No rules means no condition on the payload. */
  rules: DataRule[];
  /** Whether every rule must match, or any one of them. */
  combine: 'all' | 'any';
  /** Inclusive time window in seconds; null leaves that end open. */
  t0: number | null;
  t1: number | null;
}

/** One byte's decimated points across a window; see `CoreApi.byteLanes`. */
export interface ByteLane {
  x: Float64Array;
  y: Float64Array;
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

/** Ignore rules for `CoreApi.compareLogs` and `CoreApi.compareBytes`. */
export interface CompareOptions {
  /** Leave out bits that behave like a counter or a checksum in both logs. */
  ignoreCounters: boolean;
  /** Subtract what each part of the score is between the first and second halves of log A. */
  ignoreChangesWithinA: boolean;
}

/** Whether an ID is in both logs or only one. */
export type Presence = 'both' | 'onlyA' | 'onlyB';

/** One bus/ID pair of the open log (A) or the comparison log (B), scored by how differently it behaves. */
export interface IdComparison {
  /** Bus name, as in log A's `LogInfo.channels` (log B's bus when the ID is only in B). */
  bus: string;
  /**
   * Log B's name for the bus, or null when the ID is only in A. It differs from `bus` when the
   * logs share no bus name and their buses were matched in order of name.
   */
  busB: string | null;
  /** ID without the extended flag. */
  id: number;
  extended: boolean;
  /** The ID's key in log A, or null when it is only in B. */
  keyA: number | null;
  /** The ID's key in log B, for the `compare...` calls, or null when it is only in A. */
  keyB: number | null;
  presence: Presence;
  /** Message name from the loaded databases, or null. */
  name: string | null;
  framesA: number;
  framesB: number;
  /** Frames per second of each log's duration, so logs of different lengths compare; null for a log of no duration. */
  rateA: number | null;
  rateB: number | null;
  /** 0 to 100: how differently the ID behaves. Below 10 is no significant difference. */
  score: number;
  /** Why, in a few words, such as `Byte 3 takes new values` or `Rate doubled`. */
  reason: string;
  /** Payload bytes that differ, most different first. */
  bytes: number[];
  /** Either log has fewer than 8 frames of the ID, so it is not scored. */
  tooFewFrames: boolean;
  /** With `tooFewFrames`: the logs' payloads take different values or lengths anyway. */
  payloadsDiffer: boolean;
  /** The ID differs, but `ignoreChangesWithinA` left every difference out as a change within log A. */
  changesWithinA: boolean;
}

/** Bits the ignore rules left out of a comparison. */
export interface IgnoredBits {
  byte: number;
  /** Bit mask within the byte, bit 0 the least significant. */
  mask: number;
  kind: 'counter' | 'checksum';
}

/** One ID compared byte by byte; see `CoreApi.compareBytes`. */
export interface ByteComparison {
  /** Bytes described: the longer payload of the two logs, at most 64. */
  len: number;
  framesA: number;
  framesB: number;
  /** Bit toggles between consecutive frames in each log, indexed `byte * 8 + bit` as in `bitFlips`. */
  flipsA: number[];
  flipsB: number[];
  /** 0 to 1 per bit, indexed the same way: how differently the bit behaves. 0 for ignored bits. */
  bitScores: number[];
  /** 0 to 100 per byte, after the ignore rules. */
  byteScores: number[];
  /** Why each byte scores as it does. */
  byteReasons: string[];
  /** Per byte, up to 16 values log B shows that log A never does. */
  newValues: number[][];
  /** Per byte, seconds into log A of its first frame showing a value log B never does, or null. */
  firstOnlyInA: (number | null)[];
  ignored: IgnoredBits[];
}

/**
 * Everything the UI needs from the engine. The web build talks to a wasm Web Worker; the
 * desktop build will implement this over Tauri commands with the same Rust crates running
 * natively.
 */
export interface CoreApi {
  openLog(file: Blob, name: string, onProgress: (p: Progress) => void): Promise<LogInfo>;
  /**
   * Start a live capture of one bus, named `channel`, in place of the log, as `openLog` replaces
   * it: series are freed and the databases kept. `startedAtMs` is the wall-clock time (ms since
   * the Unix epoch) that frame times count from. Returns the empty capture's `LogInfo`, with
   * `format` 'capture' and `name` set to `name`.
   */
  startCapture(name: string, channel: string, startedAtMs: number): Promise<LogInfo>;
  /**
   * Add frames to the running capture, in the order received. Every other call sees them once
   * this resolves. Returns the capture so far. Rejects when no capture is running.
   */
  appendFrames(frames: CaptureFrame[]): Promise<LogInfo>;
  /**
   * For a rolling capture: drop the running capture's frames timed before `beforeNs`
   * nanoseconds since it started, from the front of the store up to the first frame at or after
   * it. Per-ID statistics are redone from the frames kept, so this takes time in proportion to
   * them. Returns the capture so far. Rejects when no capture is running.
   */
  trimCapture(beforeNs: number): Promise<LogInfo>;
  /** End the running capture, putting its frames in time order if they are not. Returns it. */
  endCapture(): Promise<LogInfo>;
  idSummary(): Promise<IdSummary[]>;
  rowCount(key: number): Promise<number>;
  rows(key: number, start: number, count: number): Promise<RowBatch>;
  /**
   * The whole payload of row `row` of `key` (or ALL_IDS), numbered as in `rows`, which cuts a
   * payload at 64 bytes. Empty for an unknown key or a row past the end.
   */
  frameData(key: number, row: number): Promise<Uint8Array>;
  /**
   * Payload bytes `first..first + byteCount` of rows `start..start + count` of `key` (or ALL_IDS),
   * not cut at 64 bytes like `rows`: `byteCount` values per row, row after row, with `NO_BYTE`
   * for a byte past the end of the frame. Rows are clamped to those that exist, as in `rows`.
   * Empty when `byteCount` is above 1785, the longest payload.
   */
  rowBytes(key: number, start: number, count: number, first: number, byteCount: number): Promise<Uint16Array>;
  /** Per-bit change counts of one ID, each frame compared with the previous frame of its kind. */
  bitFlips(key: number): Promise<Uint32Array>;
  /** Parse a DBC file. Nothing changes until it is passed to `setDatabases`. */
  parseDbc(file: Blob, name: string): Promise<Database>;
  decodeSignal(key: number, signal: string): Promise<SeriesInfo>;
  /** Min/max-decimated points between t0 and t1 seconds, about `2 * buckets` of them. */
  seriesView(handle: number, t0: number, t1: number, buckets: number): Promise<[Float64Array, Float64Array]>;
  dropSeries(handle: number): Promise<void>;
  /**
   * Views of payload bytes `first..first + count` of ID `key` between t0 and t1 seconds, each
   * decimated like `seriesView`, in one round trip and with nothing to drop afterwards. A frame
   * too short to carry a byte adds no point to it.
   */
  byteLanes(key: number, first: number, count: number, t0: number, t1: number, buckets: number): Promise<ByteLane[]>;

  /** Index of the first row of `key` (or ALL_IDS) at or after `t` seconds, clamped to the last row. */
  rowAtTime(key: number, t: number): Promise<number>;
  /** Rows of `key` (or ALL_IDS) timestamped within [t0, t1] seconds; for an ID key, the frames `bitFlipsBetween` compares. */
  rowCountBetween(key: number, t0: number, t1: number): Promise<number>;
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
   * Each frame is compared with the previous frame of the ID and kind, even if that one is before t0.
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
   * Suggested signals for one ID: likely counters, checksums, flags, enums and values, judged
   * from how its bits change over a sample of about 20,000 frames. Guesses to check, not
   * decodes. Rejects for an unknown key, or a reference no loaded DBC decodes. See `suggest` in
   * crates/can-wasm/src/discover.rs.
   */
  suggestSignals(key: number, hints?: DiscoveryHints): Promise<MessageSuggestions>;
  /**
   * `suggestSignals` for each of `keys` in turn, calling `onProgress` with each message's
   * suggestions as they arrive. Aborting `signal` rejects with an `AbortError` once the message
   * in hand is done; the messages already passed to `onProgress` stay valid. A key for which
   * `skip` returns true when its turn comes, such as one suggested for meanwhile, is passed over
   * but counts as done, with `latest` null.
   */
  scanSignals(
    keys: number[],
    hints: DiscoveryHints,
    onProgress: (done: number, total: number, latest: MessageSuggestions | null) => void,
    signal?: AbortSignal,
    skip?: (key: number) => boolean,
  ): Promise<MessageSuggestions[]>;
  /**
   * Replace the loaded databases. A message is looked up in order, in the first database whose
   * `channel` is null or names its bus. Series handles stay valid; series decoded under the old
   * databases keep their values until decoded again. Survives opening another log.
   */
  setDatabases(dbs: ScopedDatabase[]): Promise<void>;
  /** `db` as DBC text. */
  exportDbc(db: Database): Promise<string>;

  /**
   * Read a second log, B, to compare the open log (A) with, replacing any earlier one. Read like
   * `openLog`, in chunks with progress. Opening another log with `openLog` drops it.
   */
  openCompareLog(file: Blob, name: string, onProgress: (p: Progress) => void): Promise<LogInfo>;
  /** Log B, or null when there is none. */
  compareLogInfo(): Promise<LogInfo | null>;
  closeCompareLog(): Promise<void>;
  /** Make log B the open log and the open log log B, dropping every series. Returns the new open log. */
  swapCompareLog(): Promise<LogInfo>;
  /** Every ID of either log, error frames aside, scored, most different first. Empty without log B. */
  compareLogs(options: CompareOptions): Promise<IdComparison[]>;
  /** One ID byte by byte: `keyA` in log A and `keyB` in log B, either null when that log lacks it. */
  compareBytes(keyA: number | null, keyB: number | null, options: CompareOptions): Promise<ByteComparison>;
  /** Like `byteLanes`, for ID `key` of log B, in seconds from log B's first frame. */
  compareByteLanes(key: number, first: number, count: number, t0: number, t1: number, buckets: number): Promise<ByteLane[]>;
  /** The payload of log B's last frame of `key` at or before `t` seconds (its first frame before that). */
  compareFrameAt(key: number, t: number): Promise<Uint8Array>;
  /**
   * Keep the frames that match `filter`, in time order, as the rows of `FILTERED_ROWS` for
   * `rowCount`, `rows`, `frameData`, `rowBytes`, `rowAtTime` and `rowCountBetween`, and resolve to
   * how many there are. Null drops them. Opening a log drops them too. Applying the filter the
   * last `countFilterMatches` counted takes its matches rather than filtering again. During a
   * capture, each frame `appendFrames` adds that matches joins them, and `endCapture` finds them
   * again.
   */
  setTraceFilter(filter: FrameFilter | null): Promise<number>;
  /**
   * `rowCount(FILTERED_ROWS)`, or null when the engine holds no trace filter: none was set, or
   * it was dropped because there was no memory to match a capture's new frames or to filter it
   * again when it ended.
   */
  filteredRowCount(): Promise<number | null>;
  /**
   * How many frames match `filter`, keeping nothing: a preview. It runs in steps, letting other
   * calls run between them. Resolves null when a later count or `setTraceFilter` stopped it.
   */
  countFilterMatches(filter: FrameFilter): Promise<number | null>;
  /**
   * The open log written as a file in `format`, leaving out the frames reassembled from J1939
   * transfers (`FLAG_REASSEMBLED`), which reading the file again reassembles. What each format
   * keeps is in COMPATIBILITY.md. The engine builds the whole file in its memory before handing
   * it over, so a log needs about the file's size on top of itself; a log too large for that
   * rejects, and stays open.
   */
  exportLog(format: ExportFormat): Promise<Blob>;
  /**
   * Called after the engine stopped and was started again: the log and every series are gone,
   * calls in flight were rejected, and the databases were set again. Returns an unsubscribe.
   * Absent in an implementation whose engine never restarts.
   */
  onReset?(listener: () => void): () => void;
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

/**
 * What an ID list shows for a summary: its hex ID, or for error frames their class in hex under
 * the error flag, such as `Error 080` (bus error), so the flag never reads as a 29-bit ID.
 */
export function idLabel(s: Pick<IdSummary, 'id' | 'extended' | 'flags'>): string {
  if (!isErrorFrame(s)) return formatId(s.id, s.extended);
  const errorClass = s.id & 0x1fff_ffff;
  return errorClass === 0 ? 'Error frames' : `Error ${errorClass.toString(16).toUpperCase().padStart(3, '0')}`;
}
