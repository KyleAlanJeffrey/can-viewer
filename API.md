# CoreApi reference

`CoreApi` (`web/src/core/api.ts`) is the only interface between the FreeCAN Studio UI and its engine. The UI never calls the wasm module directly. This page documents every method and type. For the rules on changing it, see [COMPATIBILITY.md](COMPATIBILITY.md#coreapi).

## How it works

- The web build implements `CoreApi` with `WebCore` (`web/src/core/webCore.ts`). `WebCore` starts one module Web Worker (`web/src/core/worker.ts`). The worker loads the wasm build of `crates/can-wasm` and owns a single `Session`, which holds the parsed log, the loaded databases and the decoded series.
- Each call posts `{ id, method, args }` to the worker. The worker answers with `{ id, result }` or `{ id, error }`, and pushes parse progress as `{ event: 'progress', bytes, total }`.
- Requests run one at a time, in the order they were sent, so no request sees a half-parsed log. A long `openLog` delays every call queued behind it.
- Bulk results (trace rows, bit counts, series points, bus load) arrive as typed arrays whose buffers are transferred, not copied. Small structured results cross the wasm boundary as JSON.
- If the worker itself stops (an uncaught error or a reply that cannot be read), `WebCore` terminates it and starts another: every call in flight rejects with `The CAN core stopped and was restarted. Open the log again.`, the databases from the last `setDatabases` are set again, and the listeners given to [`onReset`](#onreset) are called. The log and every series are gone. A worker that stopped before it ever answered is not replaced, since another would fail the same way; every later call then rejects with the worker's error.
- The planned desktop app will implement the same interface over Tauri commands, with the same crates running natively.

```ts
import type { CoreApi } from './core/api';
import { WebCore } from './core/webCore';

const core: CoreApi = new WebCore();
```

The examples below use this `core`, `log` (the `LogInfo` from `openLog`) and `summary` (an `IdSummary` from `idSummary`).

## Conventions

- **Times** are seconds from the first frame of the log, as floating-point numbers. This applies to every `t`, `t0` and `t1` argument and to every time returned. Times beyond about 30 years either side of the first frame are clamped.
- **ID keys** (`key`) name one arbitration ID on one bus: `(channel << 32) | id`, where `id` has bit 31 set for extended IDs. Take keys from [`idSummary`](#idsummary) rather than building them, because JavaScript's bitwise operators work on 32 bits. Where a method says so, pass `ALL_IDS` (-1) to mean every frame.
- **Channels** are bus indexes into [`LogInfo.channels`](#the-loginfo-object), numbered in order of first appearance in the log. Databases are scoped by bus name instead (see [`ScopedDatabase`](#the-scopeddatabase-object)).
- **Message IDs** in a [`Database`](#the-database-object) follow the DBC convention: bit 31 set for extended IDs. `dbcId(summary)` converts an `IdSummary` to one.
- **Errors**: a failed call rejects with an `Error` whose message comes from the engine. If the wasm module failed to load, every call rejects with that load error. Most read methods do not reject on an unknown key; they return an empty or zero result, as noted below.

## Constants and helpers

Exported from `web/src/core/api.ts`:

| Name | Value | Meaning |
|---|---|---|
| `ALL_IDS` | `-1` | Pass as a key to mean every frame |
| `FLAG_FD` | `1 << 0` | CAN FD frame |
| `FLAG_BRS` | `1 << 1` | CAN FD bit rate switch |
| `FLAG_RTR` | `1 << 3` | Remote frame |
| `FLAG_ERROR` | `1 << 4` | Error frame |
| `FLAG_REASSEMBLED` | `1 << 6` | Not from the log: a J1939 parameter group reassembled from its transport protocol packets (see "J1939 transport protocol" in COMPATIBILITY.md) |
| `EXT_FLAG` | `0x8000_0000` | Bit 31: extended ID |
| `NO_BYTE` | `0xffff` | What [`rowBytes`](#rowbytes) gives for a byte past the end of a frame |
| `dbcId(s)` | function | The ID of an `IdSummary` with `EXT_FLAG` set when extended, as used in DBC files |
| `isErrorFrame(s)` | function | Whether an `IdSummary` is for CAN error frames (`FLAG_ERROR` in its flags) |
| `formatId(id, extended)` | function | Upper-case hex: 3 digits for standard IDs, 8 for extended |
| `idLabel(s)` | function | What an ID list shows for an `IdSummary`: `formatId` text, or for error frames their class under the error flag, such as `Error 080` (`Error frames` when the class is 0) |

Frame flags can also carry bits with no constant in `api.ts`: ESI (`1 << 2`) and transmitted (`1 << 5`, from `candump -x`). See `flags` in `crates/can-core/src/lib.rs`.

## Types

### The LogInfo object

Describes the current log. Returned by [`openLog`](#openlog).

**Attributes**

- **`name`** `string` - The name passed to `openLog`.
- **`format`** `LogFormat` - The format the log was read as: `'candump'`, `'asc'` (Vector ASC), `'blf'` (Vector BLF), `'trc'` (PEAK TRC), `'mf4'` (ASAM MF4) or `'csv'`. The engine chooses it from the file name's extension, confirmed or corrected by the file's first bytes (see "Log formats" in COMPATIBILITY.md).
- **`frames`** `number` - Frames stored.
- **`bytes`** `number` - Bytes read from the file.
- **`lines`** `number` - Lines read, including blank lines, or for a binary format (BLF, MF4) the frame records read plus any rejected records.
- **`rejected`** `number` - Lines or records that did not parse as a frame.
- **`firstRejection`** `[number, string] | null` - The 1-based line number (for a binary format, record number) and reason of the first rejected line or record, or null if none.
- **`durationS`** `number` - Seconds from the first frame to the last.
- **`channels`** `string[]` - Bus names from the log, such as `can0`. The index is the channel number.
- **`heapBytes`** `number` - Bytes the frame store has allocated.
- **`parseMs`** `number` - Wall-clock parse time in the worker, in milliseconds.
- **`wasmBytes`** `number` - Size of the wasm memory after parsing, in bytes.
- **`errorFrames`** `number` - Frames flagged as CAN error frames.
- **`reassembledFrames`** `number` - J1939 transport protocol transfers that were reassembled into frames of their own (flag `FLAG_REASSEMBLED`). They are counted in `frames` too.

### The Progress object

Passed to the `onProgress` callback of [`openLog`](#openlog).

**Attributes**

- **`bytes`** `number` - Bytes read so far.
- **`total`** `number` - Size of the file in bytes.

### The IdSummary object

One arbitration ID on one bus. Returned by [`idSummary`](#idsummary).

**Attributes**

- **`key`** `number` - `(channel << 32) | id`, unique per channel/ID pair. Bit 31 of the `id` part is set for extended IDs.
- **`channel`** `number` - Bus index into `LogInfo.channels`.
- **`id`** `number` - The ID without the extended flag. An error frame keeps the CAN error flag (`0x20000000`), so its ID never equals a real frame's, and no database decodes it.
- **`extended`** `boolean` - True for a 29-bit ID.
- **`count`** `number` - Frames with this ID on this bus.
- **`periodMs`** `number | null` - Mean interval between frames in milliseconds, or null with fewer than two frames.
- **`jitterMs`** `number | null` - Population standard deviation of the interval between frames in milliseconds, or null with fewer than three frames.
- **`minLen`** `number` - Shortest payload in bytes.
- **`maxLen`** `number` - Longest payload in bytes. Above 64 only for reassembled J1939 transfers, which go up to 1785.
- **`flags`** `number` - The frame flags of every frame, ORed together.
- **`name`** `string | null` - Message name from the loaded databases, by the lookup order of [`setDatabases`](#setdatabases), or null if none defines it.
- **`dbc`** `number | null` - Index, in the last array passed to [`setDatabases`](#setdatabases), of the database that decodes this ID, or null.
- **`messageId`** `number | null` - That database's message ID in the DBC convention, or null. It differs from this ID when a J1939 message matches by PGN.

### The Database object

A CAN database, as parsed from or exported to DBC.

**Attributes**

- **`name`** `string` - Display name, usually the file name. Set by the caller of `parseDbc`; the engine ignores it.
- **`messages`** [`MessageDef[]`](#the-messagedef-object) - The messages, in file order.
- **`nodes`** [`NodeDef[]`](#the-nodedef-object), optional - The nodes declared in `BU_`, in file order. Absent means none; `exportDbc` also lists any transmitter or receiver missing from here. `parseDbc` always fills it.
- **`valueTables`** [`ValueTable[]`](#the-valuetable-object), optional - Named value tables (`VAL_TABLE_`), kept for export. Absent means none.
- **`attributeDefinitions`** [`AttributeDefinition[]`](#the-attributedefinition-object), optional - Attribute definitions (`BA_DEF_`) with their defaults, in file order, except `VFrameFormat`, which `exportDbc` derives from each message's `j1939` and `fd`. Absent means none.
- **`attributes`** [`Attribute[]`](#the-attribute-object), optional - Network attribute values (`BA_ "name" value;`). Absent means none.

The engine keeps nodes, value tables and attributes as data for export; nothing decodes them.

### The NodeDef object

**Attributes**

- **`name`** `string` - Node name.
- **`comment`** `string | null`, optional - Node comment (`CM_ BU_`), or null if none.
- **`attributes`** [`Attribute[]`](#the-attribute-object), optional - Attribute values on the node (`BA_ ... BU_`). Absent means none.

### The ValueTable object

**Attributes**

- **`name`** `string` - Table name.
- **`entries`** `[number, string][]` - (raw value, text) pairs. Signals hold their own copies in `valueTable`; the table is only kept for export.

### The AttributeDefinition object

A DBC `BA_DEF_` line and its `BA_DEF_DEF_` default.

**Attributes**

- **`name`** `string` - Attribute name.
- **`object`** `'network' | 'node' | 'message' | 'signal' | 'envVar'` - What the attribute applies to. `network` is a definition with no object type. Environment variables are not kept, so an `envVar` definition survives without values.
- **`kind`** `AttributeType` - The type and range, as one of `{ type: 'int', min, max }`, `{ type: 'hex', min, max }`, `{ type: 'float', min, max }`, `{ type: 'string' }` or `{ type: 'enum', choices: string[] }`.
- **`default`** `number | string | null` - The default value, or null if the file gives none. An enum default is usually the label.

### The Attribute object

An attribute value on one object (a DBC `BA_` line).

**Attributes**

- **`name`** `string` - Attribute name, as in an `AttributeDefinition`.
- **`value`** `number | string` - The value. Enum values are the index of the choice.

### The MessageDef object

**Attributes**

- **`id`** `number` - Message ID in the DBC convention: bit 31 set for extended IDs.
- **`name`** `string` - Message name.
- **`size`** `number` - Declared payload length in bytes.
- **`transmitter`** `string | null` - Transmitting node, or null if none.
- **`comment`** `string | null` - Message comment, or null if none.
- **`signals`** [`SignalDef[]`](#the-signaldef-object) - The message's signals.
- **`j1939`** `boolean`, optional - A J1939 parameter group (`VFrameFormat` J1939PG). It decodes every frame with its PGN, and values that SAE J1939-71 reserves for error and not available (a byte-sized unsigned signal whose top byte is above 0xFA) decode as no value; see "J1939 decoding" in COMPATIBILITY.md. Absent means false. `parseDbc` always fills it.
- **`fd`** `boolean`, optional - Sent as CAN FD (`VFrameFormat` StandardCAN_FD or ExtendedCAN_FD). Only kept for export, where `j1939` wins if both are set. Absent means false. `parseDbc` always fills it.
- **`attributes`** [`Attribute[]`](#the-attribute-object), optional - Attribute values on the message (`BA_ ... BO_`) other than `VFrameFormat`, which `j1939` and `fd` stand for. Absent means none.

### The SignalDef object

**Attributes**

- **`name`** `string` - Signal name, unique within its message.
- **`startBit`** `number` - DBC start bit: the least significant bit for Intel signals, the most significant bit for Motorola signals.
- **`size`** `number` - Width in bits.
- **`byteOrder`** `'intel' | 'motorola'` - Little-endian (Intel) or big-endian (Motorola).
- **`kind`** `'unsigned' | 'signed' | 'float32' | 'float64'` - How the raw bits are read.
- **`factor`** `number` - Scale: physical value = raw * factor + offset.
- **`offset`** `number` - Offset added after scaling.
- **`min`** `number` - Declared minimum physical value.
- **`max`** `number` - Declared maximum physical value.
- **`unit`** `string` - Unit text, possibly empty.
- **`isMultiplexor`** `boolean` - True if this signal selects which multiplexed signals are present.
- **`muxValue`** `number | null` - The signal is present only when the message's multiplexor has this raw value; null if it is not multiplexed. Ignored when `muxSwitch` is set.
- **`valueTable`** `[number, string][]` - Value descriptions as (raw value, text) pairs.
- **`comment`** `string | null` - Signal comment, or null if none.
- **`receivers`** `string[]`, optional - Receiving nodes. Absent means none. `parseDbc` always fills it.
- **`muxSwitch`** [`MuxSwitch`](#the-muxswitch-object)` | null`, optional - Extended multiplexing (DBC `SG_MUL_VAL_`): the multiplexor that switches this signal and the raw values of it under which the signal is present. The multiplexor may itself be multiplexed, and then the signal is present only when the whole chain is. Absent or null means simple multiplexing by `muxValue`. `parseDbc` always fills it.
- **`attributes`** [`Attribute[]`](#the-attribute-object), optional - Attribute values on the signal (`BA_ ... SG_`), such as `GenSigStartValue`. Absent means none.

### The MuxSwitch object

**Attributes**

- **`signal`** `string` - Name of the multiplexor signal, in the same message.
- **`ranges`** `[number, number][]` - Inclusive (low, high) raw value ranges of that signal under which this one is present.

### The ScopedDatabase object

One loaded DBC and the bus it applies to. Passed to [`setDatabases`](#setdatabases).

**Attributes**

- **`channel`** `string | null` - The bus name (as in `LogInfo.channels`) this database applies to, or null for every bus.
- **`db`** [`Database`](#the-database-object) - The database.

### The RawSignalSpec object

A bit range of one message, decoded without a database entry. Passed to [`decodeRaw`](#decoderaw) and returned in a [`Candidate`](#the-candidate-object).

**Attributes**

- **`startBit`** `number` - DBC start bit, as in `SignalDef.startBit`.
- **`size`** `number` - Width in bits, 1 to 64.
- **`byteOrder`** `'intel' | 'motorola'` - Byte order.
- **`signed`** `boolean` - Read the raw value as two's complement.
- **`factor`** `number` - Scale: value = raw * factor + offset.
- **`offset`** `number` - Offset added after scaling.

### The FindRule object

One clause of a Find Signal query: the signal does `behaviour` between `t0` and `t1` seconds. Passed to [`findSignal`](#findsignal).

**Attributes**

- **`behaviour`** `'increases' | 'decreases' | 'constant' | 'changes'` - What the value does in the window.
- **`t0`** `number` - Window start, in seconds.
- **`t1`** `number` - Window end, in seconds.

### The Candidate object

A bit range that matches a Find Signal query. Returned by [`findSignal`](#findsignal).

**Attributes**

- **`key`** `number` - ID key of the message.
- **`spec`** [`RawSignalSpec`](#the-rawsignalspec-object) - The bit range: 8 or 16 bits, unsigned, factor 1, offset 0. Pass it to `decodeRaw` to plot it.
- **`score`** `number` - From 0 to 1: how well the range follows every rule.

### The SeriesInfo object

A decoded signal held in the worker. Returned by [`decodeSignal`](#decodesignal) and [`decodeRaw`](#decoderaw).

**Attributes**

- **`handle`** `number` - Pass to `seriesView` and `dropSeries`.
- **`name`** `string` - The signal name. For a raw decode it is the range in DBC notation, such as `bits 7|16@0+`.
- **`unit`** `string` - The signal's unit; empty for a raw decode.
- **`count`** `number` - Points decoded.
- **`min`** `number | null` - Smallest value, or null when `count` is 0 (for example, every J1939 value was not available).
- **`max`** `number | null` - Largest value, or null when `count` is 0.

### The RowBatch object

A block of trace rows, from `web/src/core/rows.ts`. Returned by [`rows`](#rows). Each row is packed into 96 bytes (`ROW_STRIDE`); read rows through the accessors, with `i` from 0 to `length - 1`.

**Attributes and accessors**

- **`key`** `number` - The key the rows were requested for.
- **`start`** `number` - Row index of the first row in the batch.
- **`length`** `number` - Rows in the batch.
- **`time(i)`** `number` - Seconds from the first frame of the log.
- **`id(i)`** `number` - Arbitration ID, bit 31 set for extended IDs.
- **`index(i)`** `number` - The frame's index in the whole log.
- **`channel(i)`** `number` - Bus index.
- **`flags(i)`** `number` - Frame flags.
- **`len(i)`** `number` - Bytes of payload in the row, at most 64.
- **`fullLength(i)`** `number` - The frame's whole payload length in bytes. It equals `len(i)` except for a reassembled J1939 transfer longer than 64 bytes, up to 1785.
- **`changed(i, byte)`** `boolean` - True if this payload byte differs from the previous frame of the same ID. Always false for an ID's first frame.
- **`data(i)`** `Uint8Array` - The payload, as a view into the batch.

A row holds at most 64 bytes of payload. A reassembled J1939 transfer (`FLAG_REASSEMBLED`) longer than that is cut at 64 bytes in `len(i)`, `data(i)` and `changed(i, byte)`; `fullLength(i)` gives its whole length, [`frameData`](#framedata) fetches the whole payload, and [`rowBytes`](#rowbytes) fetches a range of bytes of many rows. `decodeRaw` and `decodeSignal` work on the whole payload.

## Logs

### openLog

```ts
openLog(file: Blob, name: string, onProgress: (p: Progress) => void): Promise<LogInfo>
```

Parses a CAN log and makes it the current log. It replaces the previous log and frees every decoded series. The loaded databases are kept and apply to the new log. The format is chosen from `name`'s extension and the file's first bytes, and reported in `LogInfo.format`; see "Log formats" in COMPATIBILITY.md for the formats and how one is chosen. The file is read in 8 MiB chunks, so a text log is never held in memory whole. Lines that do not parse do not fail the call; they are counted in `LogInfo.rejected`.

Series handles restart from 0 for each log. Forget every handle from before the call, and do not pass one to `dropSeries`: it could name a new series.

To close a log, open an empty Blob.

**Parameters**

- **`file`** `Blob` - The log file.
- **`name`** `string` - The file name. Its extension suggests the format; it is also returned as `LogInfo.name`.
- **`onProgress`** `(p: Progress) => void` - Called as the file is read, at most about every 100 ms.

**Returns** a [`LogInfo`](#the-loginfo-object).

**Errors** Rejects if the file cannot be read or the engine fails, for example when wasm runs out of memory.

```ts
const log = await core.openLog(file, file.name, (p) => {
  console.log(`Parsing... ${Math.round((100 * p.bytes) / p.total)}%`);
});
console.log(`${log.frames} frames on ${log.channels.join(', ')}; ${log.rejected} lines skipped`);
```

### busLoad

```ts
busLoad(channel: number, t0: number, t1: number, buckets: number, bitrate: number): Promise<[Float64Array, Float64Array]>
```

Estimated load (0 to 1) of one bus at `bitrate` bit/s, in `buckets` equal buckets between `t0` and `t1` seconds. It counts the bits of each frame without bit stuffing, plus the interframe space. CAN FD frames are counted as if sent entirely at `bitrate`, which overestimates frames sent with bit rate switching. Error frames are skipped. Each frame counts towards the bucket of its timestamp, so very short buckets can read high; loads are capped at 1.

**Parameters**

- **`channel`** `number` - Bus index into `LogInfo.channels`.
- **`t0`** `number` - Start, in seconds.
- **`t1`** `number` - End, in seconds.
- **`buckets`** `number` - Number of buckets.
- **`bitrate`** `number` - Nominal bus bitrate in bit/s.

**Returns** `[times, loads]`: two arrays of `buckets` values, the bucket centre times in seconds and the loads. Both are empty if `buckets` is 0 or `t1 <= t0`. Every load is 0 if `bitrate` is 0 or less.

```ts
const [times, loads] = await core.busLoad(0, 0, log.durationS, 200, 500_000);
const peak = Math.max(...loads);
```

## IDs and frames

### idSummary

```ts
idSummary(): Promise<IdSummary[]>
```

One summary per bus/ID pair in the current log, in order of first appearance. Names come from the current databases, so call it again after `setDatabases`.

**Parameters** None.

**Returns** an array of [`IdSummary`](#the-idsummary-object). It is empty when no log is open.

```ts
for (const s of await core.idSummary()) {
  console.log(log.channels[s.channel], formatId(s.id, s.extended), s.name ?? 'unknown', s.periodMs);
}
```

### rowCount

```ts
rowCount(key: number): Promise<number>
```

The number of rows in the trace: the frames of one ID, or every frame for `ALL_IDS`.

**Parameters**

- **`key`** `number` - An ID key, or `ALL_IDS`.

**Returns** the row count. It is 0 for an unknown key.

```ts
const total = await core.rowCount(ALL_IDS);
```

### rows

```ts
rows(key: number, start: number, count: number): Promise<RowBatch>
```

Rows `start` to `start + count - 1` of the trace, clamped to the rows that exist. Row numbers count within the filter: with an ID key, row 0 is that ID's first frame.

**Parameters**

- **`key`** `number` - An ID key, or `ALL_IDS`.
- **`start`** `number` - First row.
- **`count`** `number` - Number of rows.

**Returns** a [`RowBatch`](#the-rowbatch-object). It is empty for an unknown key.

```ts
const batch = await core.rows(ALL_IDS, 0, 40);
for (let i = 0; i < batch.length; i++) {
  console.log(batch.time(i).toFixed(6), log.channels[batch.channel(i)], batch.data(i));
}
```

### frameData

```ts
frameData(key: number, row: number): Promise<Uint8Array>
```

The whole payload of one trace row. [`rows`](#rows) cuts a payload at 64 bytes, which only a reassembled J1939 transfer exceeds; fetch it with this when `fullLength(i) > len(i)`.

**Parameters**

- **`key`** `number` - An ID key, or `ALL_IDS`.
- **`row`** `number` - Row index, counted within the filter as in `rows`.

**Returns** the payload, up to 1785 bytes. It is empty for an unknown key or a row past the end.

```ts
const batch = await core.rows(key, 0, 1);
const payload = batch.fullLength(0) > batch.len(0) ? await core.frameData(key, batch.start) : batch.data(0);
```

### rowBytes

```ts
rowBytes(key: number, start: number, count: number, first: number, byteCount: number): Promise<Uint16Array>
```

Payload bytes `first` to `first + byteCount - 1` of rows `start` to `start + count - 1`, in one round trip. Unlike [`rows`](#rows), it does not cut a payload at 64 bytes, so it reads a byte range of a long reassembled J1939 transfer across many rows without a `frameData` call per row. Rows are clamped to the rows that exist, as in `rows`.

**Parameters**

- **`key`** `number` - An ID key, or `ALL_IDS`.
- **`start`** `number` - First row, counted within the filter as in `rows`.
- **`count`** `number` - Number of rows.
- **`first`** `number` - The first byte index.
- **`byteCount`** `number` - How many bytes of each row, at most 1785 (the longest payload, a full J1939 transfer).

**Returns** `byteCount` values per row, row after row: value `r * byteCount + j` is byte `first + j` of row `start + r`. Each is 0 to 255, or `NO_BYTE` for a byte past the end of that frame. The array is empty for an unknown key, a start past the end, a `byteCount` of 0 or above 1785, or a `first + byteCount` above 2^32 - 1.

```ts
const values = await core.rowBytes(key, 0, 400, 96, 4);
const b97OfRow2 = values[2 * 4 + 1];
if (b97OfRow2 !== NO_BYTE) console.log(b97OfRow2);
```

### rowAtTime

```ts
rowAtTime(key: number, t: number): Promise<number>
```

The index of the first row of `key` (or `ALL_IDS`) at or after `t` seconds, clamped to the last row. It uses a binary search, since rows are in time order (a log out of order is sorted when it opens).

**Parameters**

- **`key`** `number` - An ID key, or `ALL_IDS`.
- **`t`** `number` - Time in seconds.

**Returns** a row index. It is 0 for an unknown key or an empty log.

```ts
const row = await core.rowAtTime(ALL_IDS, 12.5);
const batch = await core.rows(ALL_IDS, row, 1);
```

### rowCountBetween

```ts
rowCountBetween(key: number, t0: number, t1: number): Promise<number>
```

The number of rows of `key` (or `ALL_IDS`) timestamped inside `[t0, t1]` seconds, both ends included. For an ID key these are the frames [`bitFlipsBetween`](#bitflipsbetween) compares, so a bit changes at most `rowCountBetween - 1` times. The difference of two `rowAtTime` calls is not a substitute: it leaves out a frame exactly at `t1`, and the last frame when the window reaches past it.

**Parameters**

- **`key`** `number` - An ID key, or `ALL_IDS`.
- **`t0`** `number` - Window start, in seconds.
- **`t1`** `number` - Window end, in seconds.

**Returns** a row count. It is 0 for an unknown key or a window with no frames.

```ts
const frames = await core.rowCountBetween(summary.key, 120, 135);
const flips = await core.bitFlipsBetween(summary.key, 120, 135);
const share = flips[0] / Math.max(1, frames - 1);
```

## Bit activity

### bitFlips

```ts
bitFlips(key: number): Promise<Uint32Array>
```

How often each payload bit of one ID changed between consecutive frames, over the whole log. The counts are kept while parsing, so this is cheap.

**Parameters**

- **`key`** `number` - An ID key. `ALL_IDS` is not accepted.

**Returns** a `Uint32Array` indexed `byte * 8 + bit`, where bit 0 is the least significant bit of the byte. Its length is 8 times the ID's longest payload. It is empty for `ALL_IDS` or an unknown key.

```ts
const flips = await core.bitFlips(summary.key);
const busiest = flips.indexOf(Math.max(...flips));
console.log(`byte ${busiest >> 3}, bit ${busiest & 7}`);
```

### bitFlipsBetween

```ts
bitFlipsBetween(key: number, t0: number, t1: number): Promise<Uint32Array>
```

Like [`bitFlips`](#bitflips), counting only changes between consecutive frames that are both inside `[t0, t1]` seconds.

**Parameters**

- **`key`** `number` - An ID key. `ALL_IDS` is not accepted.
- **`t0`** `number` - Window start, in seconds.
- **`t1`** `number` - Window end, in seconds.

**Returns** a `Uint32Array` laid out as for `bitFlips`. It is empty for `ALL_IDS` or an unknown key.

```ts
const flips = await core.bitFlipsBetween(summary.key, 120, 135);
```

### changeActivity

```ts
changeActivity(key: number, t0: number, t1: number, buckets: number): Promise<Uint32Array>
```

The number of payload bits that changed, per time bucket, for one ID across `[t0, t1]` seconds: an activity strip. Buckets are equal in width, and `t1` falls in the last one. Each frame is compared with the previous frame of the ID, even if that one is before `t0`. The ID's first frame in the log adds nothing.

**Parameters**

- **`key`** `number` - An ID key. `ALL_IDS` is not accepted.
- **`t0`** `number` - Start, in seconds.
- **`t1`** `number` - End, in seconds.
- **`buckets`** `number` - Number of buckets.

**Returns** a `Uint32Array` of `buckets` counts. It holds only zeros for `ALL_IDS`, an unknown key, or `t1 <= t0`.

```ts
const strip = await core.changeActivity(summary.key, 0, log.durationS, 400);
```

### byteLanes

```ts
byteLanes(key: number, first: number, count: number, t0: number, t1: number, buckets: number): Promise<ByteLane[]>
```

The raw values of `count` payload bytes from byte `first`, for one ID between `t0` and `t1` seconds: one sparkline per byte, without keeping a series in the worker. Each lane is decimated as by [`seriesView`](#seriesview) and includes one neighbouring frame on each side of the window. Frames too short to carry a byte give that lane no point.

**Parameters**

- **`key`** `number` - An ID key. `ALL_IDS` is not accepted.
- **`first`** `number` - The first byte index.
- **`count`** `number` - How many bytes, usually 8.
- **`t0`** `number` - Start, in seconds.
- **`t1`** `number` - End, in seconds.
- **`buckets`** `number` - Target resolution per lane.

**Returns** `count` lanes, each `{ x: Float64Array, y: Float64Array }` with times in seconds and byte values 0 to 255. The array is empty for `ALL_IDS`, an unknown key, or a window that isn't finite.

```ts
const lanes = await core.byteLanes(summary.key, 0, 8, 40, 70, 80);
const lastB2 = lanes[2].y.at(-1);
```

## Signals and series

### decodeSignal

```ts
decodeSignal(key: number, signal: string): Promise<SeriesInfo>
```

Decodes one database signal of one ID across the whole log and keeps the series in the worker. The message comes from the loaded databases, by the lookup order of [`setDatabases`](#setdatabases). Frames too short for the signal, and frames where a multiplexed signal is switched out, give no point. Each call creates a new series; free series you no longer need with `dropSeries`.

**Parameters**

- **`key`** `number` - An ID key. `ALL_IDS` is not accepted.
- **`signal`** `string` - The signal name, as in `SignalDef.name`.

**Returns** a [`SeriesInfo`](#the-seriesinfo-object).

**Errors**

- `unknown ID` - the key is `ALL_IDS` or not in the log.
- `no loaded DBC defines this ID on this bus`.
- `unknown signal` - the message has no signal with that name.

```ts
const info = await core.decodeSignal(summary.key, 'SteeringAngle');
const [x, y] = await core.seriesView(info.handle, 0, log.durationS, 800);
```

### decodeRaw

```ts
decodeRaw(key: number, spec: RawSignalSpec): Promise<SeriesInfo>
```

Decodes any bit range of one ID across the log, for signals not (yet) in a database. Each value is the raw field, sign-extended if `signed`, times `factor` plus `offset`. Frames too short for the range give no point. Each call creates a new series.

**Parameters**

- **`key`** `number` - An ID key. `ALL_IDS` is not accepted.
- **`spec`** [`RawSignalSpec`](#the-rawsignalspec-object) - The bit range and scaling.

**Returns** a [`SeriesInfo`](#the-seriesinfo-object) named after the range, such as `bits 7|16@0+`.

**Errors**

- `unknown ID` - the key is `ALL_IDS` or not in the log.
- `the bit range must be 1 to 64 bits and fit in this ID's frames` - the range must fit the ID's longest frame.
- A JSON error if `spec` is malformed, for example an unknown `byteOrder`.

```ts
const info = await core.decodeRaw(summary.key, {
  startBit: 7,
  size: 16,
  byteOrder: 'motorola',
  signed: false,
  factor: 1,
  offset: 0,
});
```

### seriesView

```ts
seriesView(handle: number, t0: number, t1: number, buckets: number): Promise<[Float64Array, Float64Array]>
```

The points of a series between `t0` and `t1` seconds, plus one neighbour on each side so lines reach the plot edges. Above `2 * buckets` points, each time bucket keeps only its minimum and maximum, in time order, so spikes stay visible. With `buckets` of 0 or `t1 <= t0`, the points are returned without decimation.

**Parameters**

- **`handle`** `number` - From `SeriesInfo.handle`.
- **`t0`** `number` - Start, in seconds.
- **`t1`** `number` - End, in seconds.
- **`buckets`** `number` - Target resolution, usually the plot width in pixels. About `2 * buckets` points come back.

**Returns** `[x, y]`: times in seconds and values, of equal length. Both are empty for an unknown or dropped handle, or an empty series.

```ts
const [x, y] = await core.seriesView(info.handle, 10, 20, plotWidth);
```

### dropSeries

```ts
dropSeries(handle: number): Promise<void>
```

Frees a series. Unknown handles are ignored. Do not pass a handle from before the last `openLog`: handles restart from 0 for each log, so an old handle can name a new series.

**Parameters**

- **`handle`** `number` - From `SeriesInfo.handle`.

**Returns** nothing.

```ts
await core.dropSeries(info.handle);
```

## Databases

### parseDbc

```ts
parseDbc(file: Blob, name: string): Promise<Database>
```

Parses a DBC file. Nothing changes in the engine until the result is passed to [`setDatabases`](#setdatabases). The text is read as UTF-8, skipping a byte-order mark, and falls back to Windows-1252. See [COMPATIBILITY.md](COMPATIBILITY.md#dbc-files) for what is kept.

**Parameters**

- **`file`** `Blob` - The DBC file.
- **`name`** `string` - Returned as `Database.name`.

**Returns** a [`Database`](#the-database-object).

**Errors** Rejects with the parser's message if the file is not valid DBC.

```ts
const db = await core.parseDbc(file, file.name);
await core.setDatabases([{ channel: null, db }]);
```

### setDatabases

```ts
setDatabases(dbs: ScopedDatabase[]): Promise<void>
```

Replaces the loaded databases. A frame's message is looked up in order: the first database whose `channel` is null or names the frame's bus, and that defines the ID, wins. Failing that, the first such database with a J1939 message for the frame's PGN wins (see "J1939 decoding" in COMPATIBILITY.md). A database scoped to a bus name that is not in the log applies to nothing.

Series handles stay valid. Series decoded under the old databases keep their values until decoded again. The databases survive opening another log. Call [`idSummary`](#idsummary) again to pick up new message names.

**Parameters**

- **`dbs`** [`ScopedDatabase[]`](#the-scopeddatabase-object) - The databases in lookup order. Pass `[]` to unload them all.

**Returns** nothing.

**Errors** Rejects with a JSON error if an entry does not have the shape of `ScopedDatabase`. The previous databases stay loaded.

```ts
await core.setDatabases([
  { channel: 'can1', db: chassis }, // frames on can1 only
  { channel: null, db: powertrain }, // every bus
]);
const ids = await core.idSummary();
```

### exportDbc

```ts
exportDbc(db: Database): Promise<string>
```

Writes `db` as DBC text. It neither reads nor changes the session. Parsing the text again gives an equal database, apart from the [known export limits](COMPATIBILITY.md#dbc-files).

**Parameters**

- **`db`** [`Database`](#the-database-object) - The database to write.

**Returns** the DBC text.

**Errors** Rejects with a JSON error if `db` does not have the shape of `Database`.

```ts
const text = await core.exportDbc(db);
downloadText('vehicle.dbc', text); // web/src/download.ts
```

## Engine lifecycle

### onReset

```ts
onReset?(listener: () => void): () => void
```

Registers `listener` to be called after the engine stopped and was started again. By then every call that was in flight has rejected, the databases from the last `setDatabases` are loaded again, and the log and every series are gone, so the app shows no log and asks for it to be opened again. The method is optional: an implementation whose engine never restarts leaves it out, and callers use `core.onReset?.(...)`.

**Parameters**

- **`listener`** `() => void` - Called once per restart.

**Returns** a function that removes the listener.

```ts
const stop = core.onReset?.(() => {
  showNoLog();
  showError('The CAN core stopped and was restarted. Open the log again.');
});
```

## Find Signal

### findSignal

```ts
findSignal(rules: FindRule[], keys: number[], limit: number): Promise<Candidate[]>
```

Ranks bit ranges of the given IDs by how well their value follows every rule, best first. The candidates are the unsigned 8-bit and 16-bit ranges, in both byte orders, that fit the ID's shortest frame. A byte-aligned 8-bit range appears once, in Intel order, because it reads the same in both orders.

Each rule looks at the `n` steps between consecutive frames of the ID inside its window. `up` of them raise the value, `down` lower it, and `moves = up + down`. A rule scores:

- `increases`: `(up - down) / (moves + 1)`, or 0 if negative.
- `decreases`: `(down - up) / (moves + 1)`, or 0 if negative.
- `changes`: `moves / n`.
- `constant`: `1 - moves / n`.

A candidate's score is the product of its rule scores. If any rule's window holds fewer than two frames of an ID, that ID gives no candidates. Only scores above 0 are returned, and ties go to the narrower range. See `find_signal` in `crates/can-wasm/src/find.rs`.

**Parameters**

- **`rules`** [`FindRule[]`](#the-findrule-object) - The behaviour to look for. With no rules, the result is empty.
- **`keys`** `number[]` - The ID keys to search, or `[]` for every ID. Unknown keys are ignored.
- **`limit`** `number` - The most candidates to return. With 0, the result is empty.

**Returns** an array of [`Candidate`](#the-candidate-object), best first.

**Errors** Rejects with a JSON error if a rule is malformed, for example an unknown `behaviour`.

```ts
// Holds still for the first 10 s, then rises.
const found = await core.findSignal(
  [
    { behaviour: 'constant', t0: 0, t1: 10 },
    { behaviour: 'increases', t0: 10, t1: 20 },
  ],
  [],
  50,
);
if (found.length > 0) {
  const info = await core.decodeRaw(found[0].key, found[0].spec);
}
```
