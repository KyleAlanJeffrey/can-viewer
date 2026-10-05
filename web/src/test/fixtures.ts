import { dbcId, type ByteLane, type CoreApi, type IdSummary, type LogInfo, type MessageDef, type SeriesInfo, type SignalDef } from '../core/api';
import { ROW_STRIDE, RowBatch } from '../core/rows';

export interface RowSpec {
  t: number;
  /** DBC convention: bit 31 set for extended IDs. */
  id: number;
  index: number;
  channel?: number;
  flags?: number;
  data: number[];
  /** Payload length before truncation to the row; defaults to `data.length`. */
  fullLength?: number;
  /** Payload bytes that differ from the previous frame of the ID. */
  changed?: number[];
}

/** A RowBatch packed the way `Session::rows` packs it. */
export function makeRowBatch(key: number, start: number, rows: RowSpec[]): RowBatch {
  const buffer = new ArrayBuffer(rows.length * ROW_STRIDE);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  rows.forEach((row, i) => {
    const at = i * ROW_STRIDE;
    view.setFloat64(at, row.t, true);
    view.setUint32(at + 8, row.id >>> 0, true);
    view.setUint32(at + 12, row.index, true);
    bytes[at + 16] = row.channel ?? 0;
    bytes[at + 17] = row.flags ?? 0;
    bytes[at + 18] = row.data.length;
    view.setUint16(at + 20, row.fullLength ?? row.data.length, true);
    let low = 0;
    let high = 0;
    for (const b of row.changed ?? []) {
      if (b < 32) low |= 1 << b;
      else high |= 1 << (b - 32);
    }
    view.setUint32(at + 24, low >>> 0, true);
    view.setUint32(at + 28, high >>> 0, true);
    bytes.set(row.data, at + 32);
  });
  return new RowBatch(key, start, buffer);
}

export function summary(fields: Partial<IdSummary> & Pick<IdSummary, 'id'>): IdSummary {
  const channel = fields.channel ?? 0;
  const extended = fields.extended ?? false;
  return {
    key: channel * 2 ** 32 + dbcId({ id: fields.id, extended }),
    channel,
    extended,
    count: 100,
    periodMs: 10,
    jitterMs: 0.1,
    minLen: 8,
    maxLen: 8,
    flags: 0,
    name: null,
    dbc: null,
    messageId: null,
    ...fields,
  };
}

export function signal(name: string, fields: Partial<SignalDef> = {}): SignalDef {
  return {
    name,
    startBit: 0,
    size: 8,
    byteOrder: 'intel',
    kind: 'unsigned',
    factor: 1,
    offset: 0,
    min: 0,
    max: 255,
    unit: '',
    isMultiplexor: false,
    muxValue: null,
    valueTable: [],
    comment: null,
    ...fields,
  };
}

export function message(id: number, name: string, fields: Partial<MessageDef> = {}): MessageDef {
  return { id, name, size: 8, transmitter: null, comment: null, signals: [], ...fields };
}

export function logInfo(fields: Partial<LogInfo> = {}): LogInfo {
  return {
    name: 'test.log',
    format: 'candump',
    frames: 1000,
    bytes: 50_000,
    lines: 1000,
    rejected: 0,
    firstRejection: null,
    durationS: 100,
    channels: ['can0'],
    heapBytes: 0,
    parseMs: 10,
    wasmBytes: 0,
    errorFrames: 0,
    reassembledFrames: 0,
    ...fields,
  };
}

const notInFake = (method: string) => () => Promise.reject(new Error(`${method} isn't implemented in the fake core`));

/**
 * A CoreApi with canned answers. Every method rejects unless overridden, so a test fails loudly
 * when a component calls something it didn't expect.
 */
export function fakeCore(overrides: Partial<CoreApi> = {}): CoreApi {
  return {
    openLog: notInFake('openLog'),
    idSummary: notInFake('idSummary'),
    rowCount: notInFake('rowCount'),
    rows: notInFake('rows'),
    frameData: notInFake('frameData'),
    rowBytes: notInFake('rowBytes'),
    bitFlips: notInFake('bitFlips'),
    parseDbc: notInFake('parseDbc'),
    decodeSignal: notInFake('decodeSignal'),
    seriesView: notInFake('seriesView'),
    dropSeries: () => Promise.resolve(),
    byteLanes: notInFake('byteLanes'),
    rowAtTime: notInFake('rowAtTime'),
    rowCountBetween: notInFake('rowCountBetween'),
    busLoad: notInFake('busLoad'),
    bitFlipsBetween: notInFake('bitFlipsBetween'),
    changeActivity: notInFake('changeActivity'),
    decodeRaw: notInFake('decodeRaw'),
    findSignal: notInFake('findSignal'),
    setDatabases: () => Promise.resolve(),
    exportDbc: notInFake('exportDbc'),
    setTraceFilter: notInFake('setTraceFilter'),
    countFilterMatches: notInFake('countFilterMatches'),
    ...overrides,
  };
}

/** A byte lane with one point per value, evenly spread over [t0, t1]. */
export function lane(values: number[], t0: number, t1: number): ByteLane {
  const step = values.length > 1 ? (t1 - t0) / (values.length - 1) : 0;
  return { x: Float64Array.from(values, (_, i) => t0 + i * step), y: Float64Array.from(values) };
}

export function seriesInfo(handle: number, name: string): SeriesInfo {
  return { handle, name, unit: '', count: 2, min: 0, max: 255 };
}
