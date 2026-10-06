# CoreApi reference

`CoreApi` (`web/src/core/api.ts`) is the only interface between the FreeCAN Studio UI and its engine. The UI never calls the wasm module directly. This page documents every method and type. For the rules on changing it, see [COMPATIBILITY.md](COMPATIBILITY.md#coreapi).

## How it works

- The web build implements `CoreApi` with `WebCore` (`web/src/core/webCore.ts`). `WebCore` starts one module Web Worker (`web/src/core/worker.ts`). The worker loads the wasm build of `crates/can-wasm` and owns a single `Session`, which holds the parsed log, the loaded databases and the decoded series.
- Each call posts `{ id, method, args }` to the worker. The worker answers with `{ id, result }` or `{ id, error }`, and pushes parse progress as `{ event: 'progress', bytes, total }`.
- Requests run one at a time, in the order they were sent, so no request sees a half-parsed log. A long `openLog` delays every call queued behind it. The one exception is [`countFilterMatches`](#countfiltermatches): a count still waiting when a newer count arrives is answered with null instead of run.
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
- **ID keys** (`key`) name one arbitration ID on one bus: `(channel << 32) | id`, where `id` has bit 31 set for extended IDs. Take keys from [`idSummary`](#idsummary) rather than building them, because JavaScript's bitwise operators work on 32 bits. Where a method says so, pass `ALL_IDS` (-1) to mean every frame, or `FILTERED_ROWS` (-2) to mean the frames the last [`setTraceFilter`](#settracefilter) kept.
- **Channels** are bus indexes into [`LogInfo.channels`](#the-loginfo-object), numbered in order of first appearance in the log. Databases are scoped by bus name instead (see [`ScopedDatabase`](#the-scopeddatabase-object)).
- **Message IDs** in a [`Database`](#the-database-object) follow the DBC convention: bit 31 set for extended IDs. `dbcId(summary)` converts an `IdSummary` to one.
- **Errors**: a failed call rejects with an `Error` whose message comes from the engine. If the wasm module failed to load, every call rejects with that load error. Most read methods do not reject on an unknown key; they return an empty or zero result, as noted below.

## Constants and helpers

Exported from `web/src/core/api.ts`:

| Name | Value | Meaning |
|---|---|---|
| `ALL_IDS` | `-1` | Pass as a key to mean every frame |
| `FILTERED_ROWS` | `-2` | Pass as a key to mean the frames the last [`setTraceFilter`](#settracefilter) kept |
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

Describes the current log, or the comparison log. Returned by [`openLog`](#openlog), [`swapCompareLog`](#swapcomparelog), [`openCompareLog`](#opencomparelog), [`compareLogInfo`](#compareloginfo) and the [live capture](#live-capture) methods.

**Attributes**

- **`name`** `string` - The name passed to `openLog` or `startCapture`.
- **`format`** `LogFormat` - The format the log was read as: `'candump'`, `'asc'` (Vector ASC), `'blf'` (Vector BLF), `'trc'` (PEAK TRC), `'mf4'` (ASAM MF4) or `'csv'`. The engine chooses it from the file name's extension, confirmed or corrected by the file's first bytes (see "Log formats" in COMPATIBILITY.md). `'capture'` for frames recorded live with [`startCapture`](#startcapture).
- **`frames`** `number` - Frames stored.
- **`bytes`** `number` - Bytes read from the file. 0 for a capture.
- **`lines`** `number` - Lines read, including blank lines, or for a binary format (BLF, MF4) the frame records read plus any rejected records. For a capture, the frames received.
- **`rejected`** `number` - Lines or records that did not parse as a frame.
- **`firstRejection`** `[number, string] | null` - The 1-based line number (for a binary format, record number) and reason of the first rejected line or record, or null if none.
- **`durationS`** `number` - Seconds from the first frame to the last.
- **`channels`** `string[]` - Bus names from the log, such as `can0`. The index is the channel number.
- **`heapBytes`** `number` - Bytes the frame store has allocated.
- **`parseMs`** `number` - Wall-clock parse time in the worker, in milliseconds.
- **`wasmBytes`** `number` - Size of the wasm memory after parsing, in bytes.
- **`errorFrames`** `number` - Frames flagged as CAN error frames.
- **`reassembledFrames`** `number` - J1939 transport protocol transfers that were reassembled into frames of their own (flag `FLAG_REASSEMBLED`). They are counted in `frames` too.

### The CaptureFrame object

One frame received by a live capture adapter. Passed to [`appendFrames`](#appendframes).

**Attributes**

- **`timeNs`** `number` - Nanoseconds since the capture started (`startedAtMs` of [`startCapture`](#startcapture)).
- **`id`** `number` - The ID without flags: 11 or 29 bits. For an error frame, its error class.
- **`extended`** `boolean` - Whether the ID is a 29-bit extended ID.
- **`flags`** `number` - `FLAG_FD`, `FLAG_BRS`, `FLAG_RTR` and `FLAG_ERROR`, as received. `FLAG_REASSEMBLED` is ignored: the engine reassembles J1939 transfers itself.
- **`data`** `Uint8Array` - The payload, at most 64 bytes; empty for a remote frame.

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
- **`float`** `boolean`, optional - Read the raw value as an IEEE 754 single float, before the scale; `size` must then be 32 and `signed` is ignored. Absent means false, and it is left out when false. `decodeRaw` rejects a float that isn't 32 bits.
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

### The DiscoveryHints object

Optional help for [`suggestSignals`](#suggestsignals) and [`scanSignals`](#scansignals). Pass `{}` for none.

**Attributes**

- **`markers`** `{ t: number }[]`, optional - Times, in seconds, when something happened, such as a press of the brake pedal. A candidate that changes unusually often within 1 s of a marker scores higher, and its `reason` says so. In a sampled log, the frames around each marker are added to the sample. Only the first 20 markers are used. Other fields on a marker are ignored.
- **`reference`** `{ key: number; signal: string } | null`, optional - A decoded signal, named as for [`decodeSignal`](#decodesignal), to compare value candidates with. A candidate whose raw value correlates with it (|r| at least 0.8) scores higher and gets a fitted scale in `fit`.

### The Suggestion object

A likely signal in one message: a guess from how its bits change, for a person to check against the log before using it. Returned in a [`MessageSuggestions`](#the-messagesuggestions-object).

**Attributes**

- **`kind`** `'counter' | 'checksum' | 'flag' | 'enum' | 'continuous' | 'signed' | 'float'` - What it looks like: a counter that steps by a fixed amount each frame, a checksum byte, a single bit that switches rarely or toggles on up to 30% of frames, a field with a few values, a smoothly changing unsigned value, a two's complement value that crosses zero, or a 32-bit IEEE 754 float (its `spec` has `float: true`).
- **`spec`** [`RawSignalSpec`](#the-rawsignalspec-object) - The bit range. `factor` and `offset` come from `fit` when there is one, and are otherwise 1 and 0. Pass it to `decodeRaw` to plot it.
- **`confidence`** `number` - From 0 to 1, to two decimals: how sure the guess is.
- **`level`** `'high' | 'medium' | 'low'` - `confidence` in words: high from 0.85, medium from 0.6.
- **`reason`** `string` - One line on why, such as `Increments by 1 each frame; wraps at 255` or `Matches CRC-8 SAE J1850 over bytes 0-6`. A counter with at most 8 values ends `: a counter or multiplexer selector`. For a sampled log, a continuous value's range (`Changes smoothly from 0 to 1023`) is over the whole log.
- **`unconfirmed`** `boolean` - True for a checksum whose rule held on only most frames (90% or more), or that matched no rule and only looks random.
- **`sparkline`** `{ t: number[]; v: number[] }` - About 64 values evenly spaced across the whole log, scaled by `spec`, with their times in seconds.
- **`fit`** [`SignalFit`](#the-signalfit-object)` | null` - The scale fitted to the hints' reference, or null.

### The SignalFit object

A scale fitted from a reference signal, as `reference = raw * factor + offset`. Returned in a [`Suggestion`](#the-suggestion-object).

**Attributes**

- **`reference`** `string` - The reference signal's name.
- **`unit`** `string` - The reference signal's unit, possibly empty.
- **`r`** `number` - Pearson correlation of the raw value with the reference, to three decimals; at least 0.8 in size.
- **`factor`** `number` - The fitted factor, to three significant digits, or a round value such as 0.01 or 0.25 when it is within 3% of one.
- **`offset`** `number` - The fitted offset for the rounded `factor`, to three significant digits; 0 when it is no bigger than one step of the factor.

### The MessageSuggestions object

The suggested signals for one message. Returned by [`suggestSignals`](#suggestsignals) and [`scanSignals`](#scansignals).

**Attributes**

- **`key`** `number` - ID key of the message.
- **`frames`** `number` - Frames of the ID in the log.
- **`sampledFrames`** `number` - Frames read to judge the candidates: all of them up to 20,000, or 20 blocks of 1,000 consecutive frames spread across the log, plus a block around each event marker. Payloads longer than 8 bytes get proportionally fewer: 2,500 for 64 bytes. Fields that rarely change are also read wherever they change across the whole log, within a fixed budget of frames per ID.
- **`suggestions`** [`Suggestion[]`](#the-suggestion-object) - At most 16, or one per payload byte when that is more, best first. Their bit ranges never overlap.

### The FrameFilter object

Which frames a filtered trace keeps. Passed to [`setTraceFilter`](#settracefilter) and [`countFilterMatches`](#countfiltermatches). A frame is kept when every part matches. A list that is null puts no restriction on the frames; an empty list matches no frame.

**Attributes**

- **`channels`** `number[] | null` - Bus indexes into `LogInfo.channels`.
- **`keys`** `number[] | null` - ID keys, as from `idSummary`. Unknown keys match nothing.
- **`kinds`** `FrameKind[] | null` - Frame kinds: `'data'`, `'remote'`, `'error'` or `'reassembled'`. Every frame is exactly one kind: an error frame (`FLAG_ERROR`) is `error`, a reassembled J1939 transfer (`FLAG_REASSEMBLED`) is `reassembled`, a remote frame (`FLAG_RTR`) is `remote`, and every other frame, CAN FD included, is `data`.
- **`rules`** [`DataRule[]`](#the-datarule-object) - Conditions on the payload. With none, the payload is not looked at.
- **`combine`** `'all' | 'any'` - Whether a frame must match every rule or at least one.
- **`t0`** `number | null` - Window start in seconds, inclusive, or null for the start of the log.
- **`t1`** `number | null` - Window end in seconds, inclusive, or null for the end of the log. A window that ends before it starts matches nothing.

### The DataRule object

One condition on a frame's payload, told apart by `type`. Bytes count from 0, over the whole payload (a reassembled J1939 transfer included), and bit 0 is the least significant bit of its byte, as in [`bitFlips`](#bitflips). A frame too short to have the byte matches neither a byte rule nor a bit rule, whether the bit is wanted set or clear.

**Variants**

- **`{ type: 'byteEquals', byte: number, value: number }`** - Byte `byte` holds `value` (0 to 255).
- **`{ type: 'bit', byte: number, bit: number, set: boolean }`** - Bit `bit` (0 to 7) of byte `byte` is set (`set: true`) or clear (`set: false`).
- **`{ type: 'changes' }`** - Some byte differs from the previous frame of the same ID and kind in the log (so a remote frame between two data frames is skipped), over the bytes both frames have; a payload that only grows or shrinks is no change. It matches when `changed(i, byte)` in a [`RowBatch`](#the-rowbatch-object) is true for some byte. The previous frame may be outside the filter's time window. An ID's first frame of a kind never matches.

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
- **`changed(i, byte)`** `boolean` - True if this payload byte differs from the previous frame of the same ID and kind (data, remote, error or reassembled), so a polled ID's remote frames are skipped. Always false for an ID's first frame of a kind.
- **`data(i)`** `Uint8Array` - The payload, as a view into the batch.

A row holds at most 64 bytes of payload. A reassembled J1939 transfer (`FLAG_REASSEMBLED`) longer than that is cut at 64 bytes in `len(i)`, `data(i)` and `changed(i, byte)`; `fullLength(i)` gives its whole length, [`frameData`](#framedata) fetches the whole payload, and [`rowBytes`](#rowbytes) fetches a range of bytes of many rows. `decodeRaw` and `decodeSignal` work on the whole payload.

### The CompareOptions object

Ignore rules for [`compareLogs`](#comparelogs) and [`compareBytes`](#comparebytes).

**Attributes**

- **`ignoreCounters`** `boolean` - Leave out bits that behave like a counter or a checksum in both logs. A counter is a 4-bit nibble that takes at least 4 values and steps by the same non-zero amount between at least 80% of consecutive frames, judged on at least 8 pairs of consecutive frames. A whole byte counts as a counter only when it also takes more than 16 values and carries from the low nibble into the high one (fewer than 5% of its steps are off by 16 from the usual step); a nibble counter beside other bits, such as a state in bit 7, is left out as a nibble, and the other bits are kept. A checksum is the first or last byte, taking at least 4 values while at least 2 other bytes change, when in at least 95% of the frames of the ID's longest length it is the sum or the XOR of the other bytes plus a constant. When the sum relation holds for both end bytes, only the last byte is taken as the checksum. A first or last byte that takes at least 16 values and changes between at least 90% of consecutive frames (32 or more) with every bit toggling on 25% to 75% of them is taken as a CRC. A byte that counts in one log and not the other is a real difference and is kept.
- **`ignoreChangesWithinA`** `boolean` - Use log A as its own baseline: leave out what log A's own changes between the first and second half of its time span explain (see [`compareLogs`](#comparelogs)). An ID whose differences are all explained that way scores near 0 with the reason `Also changes within A` and `changesWithinA` set. The Compare view turns both rules on by default.

### The IdComparison object

One bus/ID pair of the open log (A) or the comparison log (B). Returned by [`compareLogs`](#comparelogs).

**Attributes**

- **`bus`** `string` - The bus name. IDs match across the logs by bus name and ID. Buses that carry only error frames are left out of the matching. When both logs carry data on the same number of buses and either that number is 1 or the logs share no bus name, the buses match in order of name whatever they are called (so `can0` pairs with `vcan0` and `can1` with `vcan1` whichever shows first), and the name is log A's (log B's when the ID is only in B).
- **`busB`** `string | null` - Log B's name for the bus, or null when the ID is only in A. It differs from `bus` only when buses were matched in order.
- **`id`** `number` - The ID without the extended flag.
- **`extended`** `boolean` - True for a 29-bit ID.
- **`keyA`** `number | null` - The ID's key in log A, for the other CoreApi calls, or null when it is only in B.
- **`keyB`** `number | null` - The ID's key in log B, for [`compareByteLanes`](#comparebytelanes) and [`compareFrameAt`](#compareframeat), or null when it is only in A.
- **`presence`** `'both' | 'onlyA' | 'onlyB'` - Which logs have the ID.
- **`name`** `string | null` - Message name from the loaded databases, looked up as for [`setDatabases`](#setdatabases) on the bus named by `bus`, or null.
- **`framesA`** `number` - Frames in log A; 0 when only in B.
- **`framesB`** `number` - Frames in log B; 0 when only in A.
- **`rateA`** `number | null` - Frames per second of log A's duration, so logs of different lengths compare. Null when log A has no duration (all its frames have one timestamp); the rate then plays no part in the score.
- **`rateB`** `number | null` - The same for log B.
- **`score`** `number` - From 0 to 100, how differently the ID behaves. Below 10 is no significant difference. See [`compareLogs`](#comparelogs).
- **`reason`** `string` - Why, in a few words: `Appears only in A`, `Appears only in B`, `Byte 3 takes new values`, `Byte 3 has values only in A`, `Byte 3 holds a different value`, `Byte 3 changes more often`, `Byte 3 changes less often`, `Byte 3 values shift`, `Small value changes`, `Length changes from 8 to 6 bytes`, `Changes from classic CAN to CAN FD`, `Changes from CAN FD to classic CAN`, `Rate doubled`, `Rate halved`, `Rate up 3.1x`, `Rate down 3.1x`, `Too few frames to compare`, `Too few frames to compare; payloads differ`, `Also changes within A` or `No significant changes`.
- **`bytes`** `number[]` - Payload bytes scoring 10 or more, most different first.
- **`tooFewFrames`** `boolean` - True when either log has fewer than 8 frames of the ID, so it is not scored. The reason then adds `; payloads differ` when the logs' payloads take different values or lengths.
- **`changesWithinA`** `boolean` - True when the ID differs between the logs but `ignoreChangesWithinA` left every difference out as a change within log A. Always false without that rule.

### The ByteComparison object

One ID compared byte by byte. Returned by [`compareBytes`](#comparebytes). Per-bit arrays are indexed `byte * 8 + bit`, bit 0 the least significant bit of the byte, as in [`bitFlips`](#bitflips).

**Attributes**

- **`len`** `number` - Bytes described: the longer payload of the two logs, at most 64.
- **`framesA`** `number` - Frames of the ID in log A, 0 if none.
- **`framesB`** `number` - Frames of the ID in log B, 0 if none.
- **`flipsA`** `number[]` - How often each bit toggled between consecutive frames in log A; `len * 8` counts, zeros when log A lacks the ID.
- **`flipsB`** `number[]` - The same for log B.
- **`bitScores`** `number[]` - From 0 to 1 per bit, how differently it behaves (see [`compareLogs`](#comparelogs)), before the log A baseline. 0 for ignored bits and when either log lacks the ID or the byte.
- **`byteScores`** `number[]` - From 0 to 100 per byte, after both ignore rules.
- **`byteReasons`** `string[]` - Each byte's reason, worded as `IdComparison.reason`; `No significant changes` below 10, `Too few frames to compare` for every byte when either log has fewer than 8 frames of the ID, and empty when either log lacks the byte.
- **`newValues`** `number[][]` - Per byte, up to 16 values log B shows and log A never does, with ignored bits cleared.
- **`ignored`** `{ byte: number, mask: number, kind: 'counter' | 'checksum' }[]` - Bits left out by `ignoreCounters`, as a bit mask per byte.

## Logs

### openLog

```ts
openLog(file: Blob, name: string, onProgress: (p: Progress) => void): Promise<LogInfo>
```

Parses a CAN log and makes it the current log. It replaces the previous log, drops the comparison log (see [Compare logs](#compare-logs)) and frees every decoded series. The loaded databases are kept and apply to the new log. The format is chosen from `name`'s extension and the file's first bytes, and reported in `LogInfo.format`; see "Log formats" in COMPATIBILITY.md for the formats and how one is chosen. The file is read in 8 MiB chunks, so a text log is never held in memory whole. Lines that do not parse do not fail the call; they are counted in `LogInfo.rejected`.

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

### exportLog

```ts
exportLog(format: ExportFormat): Promise<Blob>
```

Writes the current log as a file in `format`, so it can be saved in another format. The frames are written in time order, leaving out the J1939 transfers the engine reassembled (`FLAG_REASSEMBLED`): their packets are written, and opening the file reassembles them again. It neither reads nor changes anything else; the log stays open. What each format keeps and loses is under "Log export" in [COMPATIBILITY.md](COMPATIBILITY.md#log-export).

The engine builds the whole file in its memory, in chunks of at most 8 MiB, then hands the chunks over one at a time, freeing each, and each is added to the Blob as it is handed over, without one large copy. So the call needs memory for the file on top of the log; COMPATIBILITY.md gives sizes. With no log open, the file holds only the format's header (nothing, for candump; an empty data frame group, for MF4).

**Parameters**

- **`format`** `ExportFormat` - The format to write: `'candump'`, `'asc'`, `'trc'`, `'csv'`, `'blf'` or `'mf4'`, as in `LogInfo.format`. `ExportFormat` is `LogFormat` without `'capture'`, which names no file format; a capture is exported like any log, usually as `'candump'`.

**Returns** the file as a `Blob` with no type.

**Errors** Rejects with `There isn't enough memory to build the exported file.` when the file, or the few MB of buffers a BLF or MF4 writer needs, does not fit in the engine's memory; the log stays open. Rejects if `format` is not one of the names above.

```ts
const file = await core.exportLog('blf');
downloadBlob(log.name.replace(/\.[^.]*$/, '') + '.blf', file); // web/src/download.ts
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

## Live capture

A capture is a log the page fills as an adapter receives frames, rather than one read from a file. Every read method works on it while it runs and sees the frames appended so far. The web app reads the adapter on the main thread (see "Live capture" in COMPATIBILITY.md) and calls `appendFrames` about every 100 ms.

### startCapture

```ts
startCapture(name: string, channel: string, startedAtMs: number): Promise<LogInfo>
```

Starts a live capture of one bus in place of the log, as [`openLog`](#openlog) replaces it: the previous log, any [log B](#compare-logs) and every decoded series are freed, and the loaded databases are kept. Series handles restart from 0.

**Parameters**

- **`name`** `string` - What to call the capture; returned as `LogInfo.name`. The web app uses `capture-YYYYMMDD-HHMMSS.log`.
- **`channel`** `string` - The bus name, such as `can0`. It is the capture's only channel, so databases scoped to it apply.
- **`startedAtMs`** `number` - The wall-clock time, in milliseconds since the Unix epoch, that frame times count from. It becomes the absolute time of frames in an exported candump file.

**Returns** the empty capture's [`LogInfo`](#the-loginfo-object), with `format` `'capture'`.

```ts
const log = await core.startCapture('capture-20261005-143000.log', 'can0', Date.now());
```

### appendFrames

```ts
appendFrames(frames: CaptureFrame[]): Promise<LogInfo>
```

Adds frames to the running capture, in the order received. Once it resolves, every other call sees them. `WebCore` packs the batch into one buffer and transfers it to the worker. Times are expected to rise, as a monotonic clock gives them; [`endCapture`](#endcapture) sorts the frames in case they do not.

**Parameters**

- **`frames`** [`CaptureFrame[]`](#the-captureframe-object) - The frames received since the last call.

**Returns** the capture so far.

**Errors** Rejects with `no capture is running` or `the capture has ended`, and with `a captured frame is longer than 64 bytes` or `a captured frame has no time` for a frame that cannot be stored; frames before it in the batch are kept. Rejects with `there is no memory left for more frames` when the engine can't grow its frame store for the batch; then none of the batch is kept, and the frames appended before stay intact.

```ts
const log = await core.appendFrames([{ timeNs: 1_250_000, id: 0x123, extended: false, flags: 0, data: Uint8Array.of(0xde, 0xad) }]);
```

### endCapture

```ts
endCapture(): Promise<LogInfo>
```

Ends the running capture and puts its frames in time order. The capture stays the current log, so it can be viewed and exported with [`exportLog`](#exportlog) (the web app's Save Capture... writes `'candump'`); `appendFrames` rejects from then on.

**Returns** the finished capture.

**Errors** Rejects with `no capture is running`.

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

The number of rows in the trace: the frames of one ID, every frame for `ALL_IDS`, or the frames the last [`setTraceFilter`](#settracefilter) kept for `FILTERED_ROWS`.

**Parameters**

- **`key`** `number` - An ID key, `ALL_IDS` or `FILTERED_ROWS`.

**Returns** the row count. It is 0 for an unknown key.

```ts
const total = await core.rowCount(ALL_IDS);
```

### rows

```ts
rows(key: number, start: number, count: number): Promise<RowBatch>
```

Rows `start` to `start + count - 1` of the trace, clamped to the rows that exist. Row numbers count within the key: with an ID key, row 0 is that ID's first frame, and with `FILTERED_ROWS`, the first frame the trace filter kept. `changed(i, byte)` always compares with the previous frame of the same ID and kind in the log, whichever key the rows are for.

**Parameters**

- **`key`** `number` - An ID key, `ALL_IDS` or `FILTERED_ROWS`.
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

- **`key`** `number` - An ID key, `ALL_IDS` or `FILTERED_ROWS`.
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

- **`key`** `number` - An ID key, `ALL_IDS` or `FILTERED_ROWS`.
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

The index of the first row of `key` (or `ALL_IDS`, or `FILTERED_ROWS`) at or after `t` seconds, clamped to the last row. It uses a binary search, since rows are in time order (a log out of order is sorted when it opens).

**Parameters**

- **`key`** `number` - An ID key, `ALL_IDS` or `FILTERED_ROWS`.
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

The number of rows of `key` (or `ALL_IDS`, or `FILTERED_ROWS`) timestamped inside `[t0, t1]` seconds, both ends included. For an ID key these are the frames [`bitFlipsBetween`](#bitflipsbetween) compares, so a bit changes at most `rowCountBetween - 1` times. The difference of two `rowAtTime` calls is not a substitute: it leaves out a frame exactly at `t1`, and the last frame when the window reaches past it.

**Parameters**

- **`key`** `number` - An ID key, `ALL_IDS` or `FILTERED_ROWS`.
- **`t0`** `number` - Window start, in seconds.
- **`t1`** `number` - Window end, in seconds.

**Returns** a row count. It is 0 for an unknown key or a window with no frames.

```ts
const frames = await core.rowCountBetween(summary.key, 120, 135);
const flips = await core.bitFlipsBetween(summary.key, 120, 135);
const share = flips[0] / Math.max(1, frames - 1);
```

## Trace filters

### setTraceFilter

```ts
setTraceFilter(filter: FrameFilter | null): Promise<number>
```

Picks the frames that match `filter` and keeps them, in time order, as the rows of the key `FILTERED_ROWS`: pass that key to [`rowCount`](#rowcount), [`rows`](#rows), [`frameData`](#framedata), [`rowBytes`](#rowbytes), [`rowAtTime`](#rowattime) and [`rowCountBetween`](#rowcountbetween) to page through them. Each call replaces the rows of the call before. Null drops them, and so does opening a log, swapping logs with [`swapCompareLog`](#swapcomparelog), starting a capture or ending one (which may reorder its frames); until a filter is set, `FILTERED_ROWS` has no rows. The work is done in the engine, a pass over the frames of the IDs the filter allows, so the UI never holds a list of frames. The kept rows cost 4 bytes per matching frame. During a capture, frames appended after the call do not join the rows; the web app turns filters off while recording.

**Parameters**

- **`filter`** [`FrameFilter`](#the-framefilter-object)` | null` - The frames to keep, or null to drop the filtered rows.

**Returns** the number of rows kept: what `rowCount(FILTERED_ROWS)` now gives. It is 0 for null.

**Errors** Rejects with a JSON error if `filter` does not have the shape of `FrameFilter`, for example a byte value above 255, with `a bit must be 0 to 7` for a bit rule outside a byte, and with `not enough memory to filter this log` when the engine can't hold the matches. In every case the filtered rows of the call before are dropped, so `rowCount(FILTERED_ROWS)` is 0.

```ts
const matches = await core.setTraceFilter({
  channels: [0],
  keys: null,
  kinds: ['data'],
  rules: [{ type: 'byteEquals', byte: 2, value: 0x1f }],
  combine: 'all',
  t0: 12,
  t1: 18.5,
});
console.log(`${matches} of ${log.frames} frames match`);
const batch = await core.rows(FILTERED_ROWS, 0, 40);
```

### countFilterMatches

```ts
countFilterMatches(filter: FrameFilter): Promise<number | null>
```

How many frames match `filter`, without keeping them or changing the rows of `FILTERED_ROWS`: a preview while a filter is edited. Requests still run in order, so send a count only when the edit settles (the Trace view waits 250 ms). If another count arrives while this one is still waiting behind other work, this one is skipped and resolves to null, so only the newest count costs a pass over the log.

**Parameters**

- **`filter`** [`FrameFilter`](#the-framefilter-object) - The frames to count.

**Returns** the number of matching frames, or null when a later count replaced this one before it ran.

**Errors** Rejects for a malformed `filter` as [`setTraceFilter`](#settracefilter) does. A count never changes the rows of `FILTERED_ROWS`, even when it fails.

```ts
const count = await core.countFilterMatches(draft);
if (count !== null) showPreview(`${count} of ${log.frames} frames match`);
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

## Compare logs

A second log, B, can be read beside the open log, A, to find what differs between them: for example the car idle in A and the doors locking in B. Log B belongs to the open log: [`openLog`](#openlog) and [`startCapture`](#startcapture) drop it, and the engine restarting loses it with the open log. A stopped capture can be log A; the web app reads no log B while a capture runs. Times for log B are seconds from log B's first frame.

### openCompareLog

```ts
openCompareLog(file: Blob, name: string, onProgress: (p: Progress) => void): Promise<LogInfo>
```

Reads `file` as log B, replacing any log B before it. The file is read as [`openLog`](#openlog) reads one: in 8 MiB chunks, with the format chosen the same way and the same limits. Both logs are held in the engine's memory at once, so log B gets what is left of a 2 GiB budget once log A is counted. A log B estimated from its size and format to need more is refused before any frame is stored, and the frame store for log B is reserved in a way that can fail without harm, so log A stays open (see "Browsers" in COMPATIBILITY.md).

**Parameters**

- **`file`** `Blob` - The log file.
- **`name`** `string` - The file name. Its extension suggests the format; it is also returned as `LogInfo.name`.
- **`onProgress`** `(p: Progress) => void` - Called as the file is read, at most about every 100 ms.

**Returns** log B's [`LogInfo`](#the-loginfo-object). A log with no frames is still kept; check `frames`.

**Errors** Rejects if the file cannot be read, with `<name> is too large to read beside the open log in this browser's memory. Compare a shorter log, or open a smaller log A.` when log B does not fit the budget, or if the engine fails. Log B is then gone and log A stays open. If the engine runs out of memory anyway, as a log with far more frames than its size suggests can make it, the engine restarts (see [`onReset`](#onreset)) and both logs are gone.

```ts
const b = await core.openCompareLog(file, file.name, (p) => showProgress(p.bytes / p.total));
```

### compareLogInfo

```ts
compareLogInfo(): Promise<LogInfo | null>
```

Log B's [`LogInfo`](#the-loginfo-object), or null when there is none.

```ts
const b = await core.compareLogInfo();
if (!b) askForLogB();
```

### closeCompareLog

```ts
closeCompareLog(): Promise<void>
```

Drops log B and frees its memory. Does nothing without one.

### swapCompareLog

```ts
swapCompareLog(): Promise<LogInfo>
```

Makes log B the open log and the open log log B, without reading either again. Every series and the trace filter's rows are dropped and handles restart from 0, as after [`openLog`](#openlog), and ID keys now name the new open log's IDs: call [`idSummary`](#idsummary) again.

**Returns** the new open log's [`LogInfo`](#the-loginfo-object).

**Errors** Rejects when there is no log B, and with `a capture can't be swapped; save it and open the file instead` when the open log is a live capture, running or stopped.

```ts
const log = await core.swapCompareLog();
const ids = await core.idSummary();
```

### compareLogs

```ts
compareLogs(options: CompareOptions): Promise<IdComparison[]>
```

Every bus/ID pair of either log, error frames aside, scored from 0 to 100 by how differently it behaves in the two logs. An ID with fewer than 8 frames in either log scores 0 with the reason `Too few frames to compare` and `tooFewFrames` set. Otherwise the score is the largest of these parts:

- **Only one log has the ID:** 100.
- **Rate:** rates are frames per second of each log's duration. The ratio of the larger rate to the smaller scores 0 up to a tolerance of 1.1 plus 2 divided by the smaller frame count, rising in a straight line to 80 at 2 (doubled or halved) and above. Skipped when either log has no duration.
- **Length:** 90 when the ID's longest payload differs.
- **Classic CAN or CAN FD:** 90 when one log sends the ID as CAN FD and the other never does.
- **Each payload byte** both logs carry (the first 64), over the bits the ignore rules keep, scores the largest of:
  - **New values:** values log B shows that log A never does (and, as `has values only in A`, the other way round). When log A takes 8 or more values of the byte (a measurement), a value in a hole of at most 4 steps between them, or one step past either end of a spread of them, is not new, and nor are values trailing on past an end whose own values thin out (fewer frames than average), as long as they reach no further past it than that thinning reaches in from it, the way sensor noise spreads. A spread crosses from 255 to 0 only when log A shows values on both sides of that seam, as a signed byte around 0 does. Any other value is new, so a state that takes 7 after 1 to 6, or 0xFF after 0 to 5, scores in full, and so does a sweep beyond a reading's range. A new value scores 75 to 100 times how sure it is that log A would have shown it had it come up as often there: from how many separate times it comes up in log B (each log is cut into 64 stretches of frames, and neighbouring stretches showing the value count once) and how long log A ran next to log B, and at most what log A's frame count allows. The 25 above 75 rise as the value's frames reach a quarter of log B. When log B takes 4 or more values (a reading, which comes back to its values as it moves), a log A shorter than log B gets no more chances than the share of log B's time it covers. A log with no duration is taken to have run as long as the other. A byte that holds one value in each log reads `holds a different value`.
  - **Shifts:** per bit, the difference between the logs in the share of frames with the bit set, and in the share of consecutive frames where it toggles, each scoring at most 50, scaled by the square root of the shorter log's time span over the longer's.

With `ignoreChangesWithinA`, log A is split at the middle of its time span, when each half has at least 8 frames of the ID (otherwise the rule leaves the ID alone, so an ID that starts or stops partway through log A keeps its differences):

- New values in B are left out when log A drifts on: it ends near one end of the spread of values it ends in, on a value only its second half shows. B's values past that end, chained with gaps of at most 4 steps from the nearest, are then the reading still moving, and log A's own values are where it has been. A different new value in B, such as a value two steps from an event A shows, is kept.
- Values only in A are left out when log A shows them in both halves while its halves differ, as A keeps varying over them. A value of only one half is an event in A and is kept.
- Shifts lose the largest byte part that the halves score against each other, and the rate, length and CAN FD parts lose their own score between the halves.

An ID that the rule takes from 10 or more to under 10 reads `Also changes within A`. The reason names the part that scored highest; a byte reason for a shift or a change of toggling under 35 reads `Small value changes`. See `compare.rs` in `crates/can-wasm`.

**Parameters**

- **`options`** [`CompareOptions`](#the-compareoptions-object) - Ignore rules.

**Returns** an array of [`IdComparison`](#the-idcomparison-object), highest score first. It is empty without log B.

```ts
const found = await core.compareLogs({ ignoreCounters: true, ignoreChangesWithinA: true });
const changed = found.filter((c) => c.presence === 'both' && c.score >= 10);
```

### compareBytes

```ts
compareBytes(keyA: number | null, keyB: number | null, options: CompareOptions): Promise<ByteComparison>
```

One ID compared byte by byte, scored as by [`compareLogs`](#comparelogs).

**Parameters**

- **`keyA`** `number | null` - The ID's key in log A (`IdComparison.keyA`), or null.
- **`keyB`** `number | null` - The ID's key in log B (`IdComparison.keyB`), or null.
- **`options`** [`CompareOptions`](#the-compareoptions-object) - Ignore rules.

**Returns** a [`ByteComparison`](#the-bytecomparison-object). With one key null or unknown, only the other log's bit toggles are filled in.

```ts
const detail = await core.compareBytes(found[0].keyA, found[0].keyB, options);
const loudest = detail.byteScores.indexOf(Math.max(...detail.byteScores));
```

### compareByteLanes

```ts
compareByteLanes(key: number, first: number, count: number, t0: number, t1: number, buckets: number): Promise<ByteLane[]>
```

Like [`byteLanes`](#bytelanes), for ID `key` of log B, with times in seconds from log B's first frame. Empty without log B or for an unknown key.

```ts
const [a] = await core.byteLanes(c.keyA, 3, 1, 0, 30, 400);
const [b] = await core.compareByteLanes(c.keyB, 3, 1, 0, 30, 400);
```

### compareFrameAt

```ts
compareFrameAt(key: number, t: number): Promise<Uint8Array>
```

The whole payload of log B's last frame of ID `key` at or before `t` seconds from log B's first frame, or its first frame when `t` is earlier. Empty without log B or for an unknown key.

```ts
const bytesB = await core.compareFrameAt(c.keyB, 12);
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

## Suggested signals

### suggestSignals

```ts
suggestSignals(key: number, hints?: DiscoveryHints, signal?: AbortSignal): Promise<MessageSuggestions>
```

Proposes likely signals in one message from how its bits change: counters, checksums, flags, enums, unsigned and signed values, and floats. Every suggestion is a guess to check against the log, not a decode. The result is the same each time for the same log, databases and hints.

The worker does the work in steps of a few milliseconds each, every step a request of its own, so other calls run between them and a long payload never holds the worker for long: one step samples the frames, the next ones score about 200,000 sampled frame reads' worth of candidates each, and the last picks the suggestions (see `Job` in `crates/can-wasm/src/discover.rs`, and `suggest_begin`, `suggest_step` and `suggest_drop` in `crates/can-wasm/src/suggest.rs`).

How it works (see `suggest` in `crates/can-wasm/src/discover.rs`):

- Remote and empty frames are ignored, and only the bytes that 99% of the other frames carry are looked at, up to 64. Shorter frames are left out.
- The bits are split into fields by how often each changes over the whole log: within a counter or a value, each more significant bit changes less often than the one below it. Both byte orders are tried, and neighbouring fields are joined, so a value's busy low bits stay with it.
- Each field, its pieces and its whole-byte widths are read over a sample of frames (see `sampledFrames`) and tested as a counter (the same step on 90% or more of frames), a signed or unsigned value (small steps on 85% or more of changes, with the low bits carrying into the high ones), or an enum (2 to 16 values, changing on at most 20% of frames, and not just separate bits that almost never change on the same frame). A single bit that changes on fewer than 5% of frames is a flag, and on fewer than 30% a toggle, also suggested as a flag, unless it mostly changes along with a neighbouring bit. A signed value with constant bits above it is suggested at its own width, not as a wider unsigned value.
- Each byte that changes on most frames is tested as a checksum over the message's other bytes: CRC-8 with the polynomials 0x1D (SAE J1850), 0x2F (AUTOSAR), 0x07 and 0x9B with any start value or final XOR, XOR, sum, sum plus a constant, and the complemented sum.
- A 32-bit word, in either byte order, is a float when read as an IEEE 754 single it takes plausible values (0, or 1e-6 to 1e6 in size, on 99% of frames), at least 16 of them, changing smoothly, and either crosses an exponent or has a mantissa that carries as one number. Nothing else is suggested inside such a word. It is suggested as a `float` only on stricter evidence: it overlaps no counter or checksum, keeps within six decades (bar the smallest 5% of values), and its low 16 bits don't change smoothly on their own unless they carry into the bits above, as a second value packed beside the first would. Overlapping float words give way to the smoother one.
- When a counter with at most 8 values looks like a multiplexer selector, bytes that change much more from frame to frame than from one frame of a page to the next one of that page get no suggestions.
- The best-scoring candidates are kept, with no two overlapping. A candidate that straddles two others gives way when they and a range inside it score about as well.
- An unsigned value whose next more significant bits are 0 in every frame, and taken by no other suggestion, is widened over them to the end of a nibble, or of a byte when the value starts on one: a value that never reaches its top bits in the log would otherwise read narrower than its field. Its `reason` then says the width was inferred. Constant bits that aren't 0 are left alone, as they may be another field.

**Parameters**

- **`key`** `number` - The ID key. Any ID works, decoded or not; the UI asks about IDs no DBC describes.
- **`hints`** [`DiscoveryHints`](#the-discoveryhints-object), optional - Event markers and a reference signal.
- **`signal`** `AbortSignal`, optional - Aborting it gives the work up at the next step.

**Returns** a [`MessageSuggestions`](#the-messagesuggestions-object). An ID whose bits never change, or with a single frame, has no suggestions.

**Errors** Rejects with `unknown ID` for an unknown key, `unknown reference ID` or `unknown reference signal` for a reference the log doesn't have, `no loaded DBC defines the reference's message` for a reference no DBC decodes, `the log changed` when frames were added or another log opened between steps, and a `DOMException` named `AbortError` when aborted.

```ts
const { suggestions } = await core.suggestSignals(summary.key, { markers: [{ t: 12 }] });
for (const s of suggestions) console.log(s.kind, s.spec.startBit, s.spec.size, s.level, s.reason);
const info = await core.decodeRaw(summary.key, suggestions[0].spec);
```

### scanSignals

```ts
scanSignals(
  keys: number[],
  hints: DiscoveryHints,
  onProgress: (done: number, total: number, latest: MessageSuggestions | null) => void,
  signal?: AbortSignal,
  skip?: (key: number) => boolean,
): Promise<MessageSuggestions[]>
```

Runs [`suggestSignals`](#suggestsignals) for each ID in turn, so a scan of many messages shows progress and can be cancelled. Other calls can run between the messages, and between the steps of each.

**Parameters**

- **`keys`** `number[]` - The ID keys to scan, in order. The UI passes the IDs no DBC describes.
- **`hints`** [`DiscoveryHints`](#the-discoveryhints-object) - Applied to every message.
- **`onProgress`** `(done: number, total: number, latest: MessageSuggestions | null) => void` - Called after each message with its suggestions, so a cancelled scan keeps what it found, and with `null` for a key passed over.
- **`signal`** `AbortSignal`, optional - Aborting it stops the scan at the next step of the message in hand, whose suggestions are then not reported.
- **`skip`** `(key: number) => boolean`, optional - Asked as each key's turn comes; a key it returns true for is passed over but counts towards `done`, and `onProgress` is called for it with `null`. The UI skips a message it suggested for meanwhile, such as one opened during the scan.

**Returns** one [`MessageSuggestions`](#the-messagesuggestions-object) per key scanned, in the order given.

**Errors** Rejects with a `DOMException` named `AbortError` when cancelled, and otherwise as `suggestSignals` does for the first key that fails.

```ts
const controller = new AbortController();
const unknown = ids.filter((s) => s.name === null).map((s) => s.key);
const results = await core.scanSignals(unknown, {}, (done, total) => console.log(`${done} of ${total}`), controller.signal);
const total = results.reduce((n, m) => n + m.suggestions.length, 0);
```
