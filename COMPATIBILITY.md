# Compatibility

What FreeCAN Studio runs on, what it reads and writes, and which interfaces must stay stable. See [VERSIONING.md](VERSIONING.md) for how a compatibility break affects the version number.

## Browsers

Supported: current versions of Chrome, Edge, Firefox and Safari, on desktop. Older versions are not tested.

The app relies on these platform features:

| Feature | Used for |
|---|---|
| WebAssembly | The Rust core (`crates/can-wasm`) |
| Module Web Workers (`new Worker(url, { type: 'module' })`) | Running the core off the main thread (`web/src/core/webCore.ts`) |
| IndexedDB with Blob values | Keeping the last session, including the log file itself, so it survives a reload (`web/src/session.ts`) |
| `DecompressionStream('gzip')` | Unpacking the demo log, which ships gzipped |
| `crypto.randomUUID` | IDs for loaded DBCs |
| Native `<dialog>` with `showModal()` | Sheets (`web/src/components/Sheet.tsx`) |

Of these, the most recent addition in Firefox is module workers (Firefox 114), and in Safari it is `DecompressionStream` (Safari 16.4).

Notes:

- `crypto.randomUUID` exists only in secure contexts, so the app must be served over HTTPS or from `localhost`. A dev server opened over plain HTTP on a LAN address cannot load DBCs.
- When IndexedDB is unavailable (private windows, blocked site data) or full, the app still works but cannot restore the session after a reload. It tells the user when a log could not be kept.
- The production Content-Security-Policy (`web/public/_headers`) allows scripts only from the app's origin plus `'wasm-unsafe-eval'`, which wasm compilation needs.
- The core runs on wasm32, so its memory is capped at 4 GiB, and a browser may allow less. In the spike, a 552 MB, 10M-frame candump log used about 654 MB of wasm memory (see [README.md](README.md)).

## Platforms

Desktop only. Phones and tablets are out of scope: no phone layout is designed, built or tested (see [PRODUCT.md](PRODUCT.md#platform)). FreeCAN Studio Pro, the planned desktop app, will wrap the same web UI in Tauri.

## Log formats

| Format | Status |
|---|---|
| candump log files (`candump -l` / `-L`) | Supported |
| Vector ASC, Vector BLF, PEAK TRC, ASAM MF4, CSV | Planned. Not supported |

candump support (`crates/can-formats/src/candump.rs`):

- Lines look like `(1436509052.249713) can0 123#DEADBEEF`.
- Classic frames (`<id>#<data>`), remote frames (`<id>#R`, with or without a length), an optional `_<dlc>` suffix, and CAN FD frames (`<id>##<flags><data>`) are read. Data bytes may be separated by `.`.
- Three hex digits mean an 11-bit ID; eight mean a 29-bit ID. Error frames (the CAN error flag in the ID) are kept and flagged. They keep the error flag in their ID, so error class 0x80 (reported as 20000080) never mixes with an 11-bit frame 080, and no DBC decodes them.
- The ` T` / ` R` suffix written by `candump -x` is read.
- CAN XL lines are rejected, and so is candump's default console output (without `-l` or `-L`).
- A line that does not parse does not stop the load. It is counted in `LogInfo.rejected`, and the first one is reported with its line number.
- Time lookups assume frames are in time order, as loggers write them. Slightly out-of-order timestamps only shift lookups by those frames.
- J1939 multi-packet transfers are reassembled into extra frames as the log loads; see "J1939 transport protocol" below.

## DBC files

Import (`crates/can-dbc-model`) reads:

- Messages with standard and extended IDs, with transmitters. Message IDs are unique after import: when a file defines the same ID twice (two `BO_` lines), the first definition is kept and the later ones are dropped, because the app selects, edits and deletes messages by ID.
- Signals: Intel and Motorola byte order; unsigned, signed, and IEEE float32 or float64 (`SIG_VALTYPE_`); factor, offset, range, unit and receivers.
- Multiplexing, simple (one multiplexor per message) and extended (`SG_MUL_VAL_`): a signal names the multiplexor that switches it and the raw value ranges under which it is present, and a multiplexor can itself be multiplexed. A signal with an `SG_MUL_VAL_` entry is present only when its whole chain of multiplexors is; one without is switched by the message's multiplexor and its `m<value>`.
- Comments on nodes, messages and signals (`CM_ BU_`, `CM_ BO_`, `CM_ SG_`), and value descriptions (`VAL_`).
- The nodes declared in `BU_`, and named value tables (`VAL_TABLE_`).
- Attributes: definitions (`BA_DEF_`) for the network, nodes, messages, signals and environment variables, of type INT, HEX, FLOAT, STRING or ENUM; defaults (`BA_DEF_DEF_`); and values (`BA_`) on the network, nodes, messages and signals. They are kept as plain data (numbers and strings) for export; the app does not show or decode them. Numbers are held as doubles, so integers beyond 2^53 lose precision.
- J1939 messages: extended messages with `VFrameFormat` J1939PG, given per message or as the default. A file without `VFrameFormat` whose `ProtocolType` is "J1939" counts its extended messages as J1939. An 11-bit message is never J1939.
- CAN FD messages: `VFrameFormat` StandardCAN_FD or ExtendedCAN_FD sets the message's `fd` flag, which export writes back. The label is looked up in the file's own `VFrameFormat` enum, so a file that lists the labels in another order still works.
- Text in UTF-8 (a byte-order mark is skipped), falling back to Windows-1252.

Not supported:

- Anything outside the model above is dropped on import, so it is also missing from an export. That includes signal groups, environment variables and their attribute values, relation attributes (`BA_DEF_REL_`, `BA_REL_`), network comments (`CM_ "..."`), `BO_TX_BU_` and the `VECTOR__INDEPENDENT_SIG_MSG` pseudo-message. A `BA_DEF_DEF_` without a matching `BA_DEF_`, and a `BA_` on a node, message or signal the file does not define, are dropped too.

Known export limits (`crates/can-dbc-model/src/writer.rs`):

- `VFrameFormat` is not kept as an attribute but derived from each message: J1939PG for `j1939` messages, StandardCAN_FD or ExtendedCAN_FD for `fd` messages, ExtendedCAN for other extended messages, and the default StandardCAN for the rest. It is written only when some message is J1939 or CAN FD, always with Vector's 16-entry enum, so a file's own enum order and its default are not preserved, only what they meant for each message.
- `BU_` lists the declared nodes in their order, then any transmitter or receiver missing from them. After export and re-import those count as declared nodes.
- `SG_MUL_VAL_` lines are written for every signal with a `muxSwitch`. DBC wants an `m<value>` indicator on every multiplexed signal, so a signal that has a `muxSwitch` but no `muxValue` (only possible in a database built in the app) is written with the low end of its first range as its `muxValue`, and reads back with it.
- `VERSION` is written as `""`.
- A double quote in a comment round-trips with a backslash. The writer escapes a bare `"` as `\"`, and the reader keeps the backslash, so after export and re-import the text holds `\"`. Units and value descriptions behave the same way.
- Float signals are written as signed (`-`), with `SIG_VALTYPE_` marking them as floats, as Vector tools do.
- A message with no transmitter, or a signal with no receivers, is written with `Vector__XXX`. `BU_` lists every transmitter and receiver in order of first mention.

Apart from these limits, exporting and re-importing gives an equal database. Tests in `crates/can-dbc-model/src/writer.rs` and `crates/can-wasm/src/lib.rs` cover this.

## J1939 decoding

A J1939 message decodes every extended frame with its PGN, whatever the frame's priority and source address. The exact CAN ID is tried first, across every DBC that applies to the bus, so a DBC written for one sender wins over a generic J1939 one. Proprietary PGNs (PDU format 239 and 255) mean whatever each sender defines, so they match only frames from the source address in the DBC. The PGN includes the data page and extended data page bits, and the PDU-specific byte only for PDU2 formats (240 and up).

When several J1939 messages share the frame's PGN, the one written for the same source address (and, for PDU1, the same destination) wins, then one for the same source address, then the first.

SAE J1939-71 reserves the top of a parameter's raw range for "error" and "not available". So for J1939 messages, an unsigned signal of 8, 16, 24, 32 or more bits (a multiple of 8) whose most significant byte is above 0xFA decodes as no value, which leaves a gap in a plot. The DBC's min and max are not used for this, so a narrow engineering range never hides real data. Smaller fields, such as 2-bit states, and signed or float signals decode as they are.

## J1939 transport protocol

Parameter groups longer than 8 bytes (DM1 with several trouble codes is the common one) travel as a TP.CM announcement (PGN 0xEC00: a BAM to every node, or an RTS to one) followed by TP.DT data packets (PGN 0xEB00) of 7 bytes each, up to 1785 bytes in 255 packets. The core reassembles them while the log is loaded (`crates/can-core/src/tp.rs`):

- Each completed transfer becomes one frame of its own, stored right after its last packet with that packet's timestamp, flagged `FLAG_REASSEMBLED` (`1 << 6`). Its ID is the announced PGN in a 29-bit ID with the TP.CM frame's priority and source address and, for a PDU1 group, the destination address. So it appears in `idSummary` like any other ID, with the frame flag set, and decodes through the J1939 lookup above with the DBC's message for that PGN.
- The TP.CM and TP.DT frames stay in the log unchanged. `LogInfo.reassembledFrames` counts the frames added, which `LogInfo.frames` includes.
- Transfers are tracked per bus, source address and destination address, so interleaved senders do not mix. A missing or repeated packet, an abort, or a new announcement from the same sender to the same destination before the last packet drops the unfinished transfer quietly. Packets without an announcement (a log that starts mid-transfer) are ignored. There is no timeout.
- Reassembled frames count towards nothing on the bus: `busLoad` skips them, since their packets are already counted.
- The payload of a reassembled frame can be longer than 64 bytes. `decodeSignal` and `decodeRaw` work on the whole payload; a trace row carries the first 64 bytes (see `RowBatch` in API.md); Find Signal searches the first 64 bytes.

## CoreApi

`CoreApi` in `web/src/core/api.ts` is the only interface between the UI and the engine, documented in [API.md](API.md). The web build implements it with a wasm Web Worker. The planned desktop app will implement the same interface over Tauri commands, with the same crates running natively. Because two implementations share it, any change to the contract is a breaking change. That includes:

- Adding, removing or renaming a method.
- Changing a parameter, its order, its units or its meaning.
- Changing the fields, nullability, units or meaning of a type in `api.ts`.
- Changing the packed row layout (`ROW_STRIDE` and the offsets in `web/src/core/rows.ts` and `Session::rows` in `crates/can-wasm/src/lib.rs`).

When the contract changes:

- Mark the commit as breaking (`!` or a `BREAKING CHANGE:` footer) and bump the version accordingly (see [VERSIONING.md](VERSIONING.md)).
- Update every side in the same change: `api.ts`, `webCore.ts`, `worker.ts`, the `Session` bindings and serde types in `crates/can-wasm/src/lib.rs` (JSON field names are camelCase on both sides), and [API.md](API.md).
- Keep the shared conventions:
  - Times are seconds from the first frame of the log.
  - ID keys are `(channel << 32) | id`, with bit 31 of `id` set for extended IDs.
  - Message IDs in a `Database` use the DBC convention, with bit 31 set for extended IDs.

## Saved sessions

The last session is kept in the browser's IndexedDB:

- Database `freecan-studio`, version 1, object store `session`.
- Keys:
  - `log`: the log file as a Blob, with its name.
  - `dbcs`: the loaded DBCs, including each full `Database`.
  - `ui`: the open view, selection, pinned time and plots.
  - `views`: per-view state.

Users will have values written by earlier versions. When the shape of a stored value changes, keep reading the old shape, or bump the IndexedDB version and migrate in `web/src/session.ts`. New `Database` fields should be optional, as `SignalDef.receivers` is: `receivers?` in TypeScript and `#[serde(default)]` in Rust.
