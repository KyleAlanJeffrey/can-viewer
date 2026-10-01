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

| Format | Extensions | Status |
|---|---|---|
| candump log files (`candump -l` / `-L`) | `.log`, `.txt`, `.candump` | Supported |
| Vector ASC | `.asc` | Supported |
| PEAK TRC (file versions 1.0 to 2.1) | `.trc` | Supported |
| CSV (python-can, SavvyCAN, generic) | `.csv` | Supported |
| Vector BLF, ASAM MF4 | | Planned. Not supported |

How the format is chosen (`Format::detect` in `crates/can-formats/src/detect.rs`): the file name's extension suggests a format, and the first 4 KiB of the file confirm or correct it, so a log with the wrong extension still opens. A file whose content identifies no format is read as what its extension says, or as candump if the extension is unknown too. The content rules are:

- candump: the first non-blank line starts with `(`.
- Vector ASC: the first non-blank line starts with `date `, `base hex`, `base dec` or `Begin Triggerblock` (case-insensitive).
- PEAK TRC: the first non-blank line starts with `;` (`;$FILEVERSION=` or a comment).
- CSV: the first non-blank line is a header with a time column, an ID column and data columns that the CSV reader knows (see below).

The result is reported as `LogInfo.format` (see [API.md](API.md)). Whatever the format, `LogInfo.lines` counts the lines of a text file or the records of a binary one, and the first line or record that does not parse is reported with its number and a reason.

Bus names: candump keeps the interface names from the file (`can0`, `vcan1`), and so does a CSV with a bus column of names. Formats that number their buses instead (ASC, TRC, a CSV bus column of numbers) give `can<number>` with the number as written in the file, so CANoe's channel 1 is `can1` and SavvyCAN's bus 0 is `can0`. Formats and files without bus information put every frame on `can1`. A DBC scoped to a bus is matched by that name.

Error frames from formats other than candump get the ID `0x20000000`: the CAN error flag with no error class, because those formats carry no SocketCAN error class. They are flagged as error frames, counted in `LogInfo.errorFrames`, and never decoded.

candump support (`crates/can-formats/src/candump.rs`):

- Lines look like `(1436509052.249713) can0 123#DEADBEEF`.
- Classic frames (`<id>#<data>`), remote frames (`<id>#R`, with or without a length), an optional `_<dlc>` suffix, and CAN FD frames (`<id>##<flags><data>`) are read. Data bytes may be separated by `.`.
- Three hex digits mean an 11-bit ID; eight mean a 29-bit ID. Error frames (the CAN error flag in the ID) are kept and flagged. They keep the error flag in their ID, so error class 0x80 (reported as 20000080) never mixes with an 11-bit frame 080, and no DBC decodes them.
- The ` T` / ` R` suffix written by `candump -x` is read.
- CAN XL lines are rejected, and so is candump's default console output (without `-l` or `-L`).
- A line that does not parse does not stop the load. It is counted in `LogInfo.rejected`, and the first one is reported with its line number.
- Time lookups assume frames are in time order, as loggers write them. Slightly out-of-order timestamps only shift lookups by those frames.

Vector ASC support (`crates/can-formats/src/asc.rs`), as written by CANoe, CANalyzer and python-can:

- Header: `base hex` (the default) or `base dec` sets the number base of IDs, DLCs and data bytes. `timestamps absolute` (the default) means seconds from the start of measurement; `timestamps relative` means seconds since the previous event line, summed over every event line including skipped ones, and `Begin Triggerblock` restarts the sum. A `date` line in CANoe's layout (`Tue Sep 30 00:00:00.000 2025`, with or without the weekday, milliseconds and am/pm, with English or German month names) gives the absolute start time, taken as UTC because the file names no time zone. Without one, times count from zero.
- Classic lines: `<time> <channel> <id>[x] <Rx|Tx|TxRq> d <dlc> <bytes...>`, and remote frames with `r` in place of `d <dlc> <bytes...>`, with or without a DLC after the `r`. The `x` suffix marks a 29-bit ID; an ID above 0x7FF is read as 29-bit even without it. DLC codes 9 to 15 mean CAN FD lengths (12 to 64 bytes). Text after the data bytes (`Length = ...`) is ignored.
- CAN FD lines: `<time> CANFD <channel> <Rx|Tx> <id>[x] [<name>] <brs> <esi> <dlc> <length> <bytes...> [<duration> <message length> <flags> ...]`. The symbolic name is optional. When the flags field is present and its EDL bit (0x1000) is clear, the line is a classic frame logged on an FD channel and loses its FD flags; its RTR bit (0x10) marks a remote frame.
- `ErrorFrame` lines, classic or CANFD, give an error frame with no data (see the note on error frame IDs above).
- `Tx` and `TxRq` set the transmitted flag.
- Lines that are not frames (`Statistic:`, `Start of measurement`, J1939 transport, chip status, comments, trigger block markers) are skipped without counting as rejected. A frame line that does not parse (bad ID, DLC or data byte, too few bytes, unknown frame type) is rejected with a reason.
- Not read: symbolic names, CAN XL, LIN, FlexRay and Ethernet lines, and the fields after a CAN FD line's data other than the flags.

PEAK TRC support (`crates/can-formats/src/trc.rs`), as written by PCAN-View, PCAN-Explorer and python-can:

- Header lines start with `;`. `;$STARTTIME=` (days since 1899-12-30, as PEAK writes it) gives the absolute start time, taken as UTC; without it, times count from zero. Time offsets are milliseconds from the start.
- Versions 2.0 and 2.1 declare their columns with `;$COLUMNS=`. Read columns: `O` (time offset), `T` (type), `B` (bus), `I` (ID), `d` (direction), `l` (data length in bytes) or `L` (DLC), and `D` (data), which must be last. Other columns (`N`, `R`) are skipped. A 2.x file without a usable `;$COLUMNS=` line rejects every frame line with that reason.
- 2.x types: `DT` (data frame), `FD`, `FB` (bit rate switch), `FE` (error state indicator), `BI` (both), `RR` (remote frame), and `ER`, `EC`, `EB` (error frames, with whatever data bytes the line holds). `ST`, `EV` and any other type are skipped without counting as rejected. With an `L` column, a DLC of 9 to 15 gives the CAN FD length for FD types and 8 bytes for others.
- Versions 1.0 to 1.3 are told apart by what follows the time offset (1.1: `Rx`/`Tx`; 1.2 and 1.3: bus number then `Rx`/`Tx`, 1.3 with a `-` after the ID; 1.0: the ID), so a file without `;$FILEVERSION=` is read as 1.0. `RTR` in place of the data bytes marks a remote frame. The bus status lines PCAN-View writes with ID `FFFFFFFF`, and lines whose type is `Warng` or `Error`, are skipped.
- An ID of more than four hex digits, or above 0x7FF, is 29-bit. A bus column names the bus `can<number>`; without one the bus is `can1`.
- A frame line that does not parse (bad offset, ID, DLC or data byte, too few bytes or columns) is rejected with a reason.
- Not read: `EV` user events, `ST` status lines, and the error details of `ER` lines beyond their data bytes.

CSV support (`crates/can-formats/src/csv.rs`). There is no one CSV layout, so the header line (the first non-blank line) names the columns, and the reader needs a time column, an ID column and data columns it knows:

- python-can's `CSVWriter` layout: `timestamp,arbitration_id,extended,remote,error,dlc,data`, with seconds, a `0x` hex ID and base64 data (hex data is read too).
- SavvyCAN's export: `Time Stamp,ID,Extended,Dir,Bus,LEN,D1,D2,...,D8`, with microseconds, hex IDs, `true`/`false` flags and one column per byte.
- Any other header whose names the reader knows. Names are matched case-insensitively, ignoring spaces, underscores and dashes, with a unit in parentheses allowed. Time: `t`, `ts` or a name starting with `time`. ID: `id`, `arbitration_id`, `can_id`, `identifier`, `frame_id`, `msg_id`, `message_id`, `arb_id`. Data: one column named `data`, `data_bytes`, `payload`, `bytes`, `hex_data` or `data_hex` holding every byte in hex (bytes optionally separated by spaces, colons, dashes or dots, with or without `0x`) or base64, or consecutive one-byte columns `D1..D8`, `byte0..`, `b0..` or `data[0]..`. Optional: `dlc`, `len`, `length`, `data_length`; `extended`, `ext`, `ide`, `is_extended`; `remote`, `rtr`; `error`, `err`; `fd`, `is_fd`, `canfd`, `edl`; `brs`; `esi`; `dir`, `direction`, `rx/tx`; `bus`, `channel`, `interface`, `chn`, `ch`. The first column of each kind wins. Flags read `1`/`0`, `true`/`false`, `yes`/`no`, `y`/`n`, `t`/`f`, `x`/`-` and empty (false). Direction `Tx` or `T` marks a transmitted frame.
- The time unit comes from the time column's name when it ends in one: `ns`, `us`, `ms`, `s`, `sec`, `seconds` and the longer words, as in `Time (ms)` or `timestamp_us`. Otherwise a value with a decimal point or an exponent (`1e-05`) is seconds and a whole number is microseconds. Times may be negative. Times are taken as absolute Unix time when they are large enough to be, since a CSV carries no start date; nothing is added or subtracted.
- The delimiter is whichever of comma, semicolon and tab appears most in the header. Cells may be wrapped in double quotes, but a delimiter inside quotes is not supported. A UTF-8 byte order mark before the header is skipped.
- An ID above 0x7FF, or an extended flag that is true, gives a 29-bit ID. A true error flag gives an error frame (see the note on error frame IDs above) keeping the low 29 bits of the written ID, so python-can's `0x20000080` reads back as it was. A data length above 8, or a true FD, BRS or ESI flag, marks a CAN FD frame. A length column truncates the data to that many bytes. Byte columns end at the first empty one.
- A header the reader cannot use rejects every line of the file with the reason "the CSV header has no time, ID and data columns we know". A row with a bad time, ID, flag, length or data cell, or too few cells to reach the time, ID or data column, is rejected with a reason.
- Not read: quoted delimiters, columns of decoded signal values (a CSV of signals is not a frame log), and any time base other than the one in the header, so a file of wall-clock strings (`12:34:56.789`) is rejected row by row.

## DBC files

Import (`crates/can-dbc-model`) reads:

- Messages with standard and extended IDs, with transmitters.
- Signals: Intel and Motorola byte order; unsigned, signed, and IEEE float32 or float64 (`SIG_VALTYPE_`); factor, offset, range, unit and receivers.
- Simple multiplexing: one multiplexor per message.
- Comments on messages and signals (`CM_ BO_`, `CM_ SG_`), and value descriptions (`VAL_`).
- J1939 messages: extended messages with `VFrameFormat` J1939PG, given per message or as the default. A file without `VFrameFormat` whose `ProtocolType` is "J1939" counts its extended messages as J1939. An 11-bit message is never J1939.
- Text in UTF-8 (a byte-order mark is skipped), falling back to Windows-1252.

Not supported:

- Extended multiplexing (`SG_MUL_VAL_`) is not decoded. Every multiplexed signal is assumed to be switched by the message's single multiplexor.
- Anything outside the model above is dropped on import, so it is also missing from an export. That includes attributes (`BA_DEF_`, `BA_`) other than `VFrameFormat`, `VAL_TABLE_`, signal groups, environment variables, node and network comments, `BO_TX_BU_` and the `VECTOR__INDEPENDENT_SIG_MSG` pseudo-message.

Known export limits (`crates/can-dbc-model/src/writer.rs`):

- The only attribute written is `VFrameFormat`, and only when some message is J1939: J1939PG for those, ExtendedCAN for other extended messages, and the default StandardCAN for the rest. CAN FD formats are not kept.
- `VERSION` is written as `""`.
- A double quote in a comment round-trips with a backslash. The writer escapes a bare `"` as `\"`, and the reader keeps the backslash, so after export and re-import the text holds `\"`. Units and value descriptions behave the same way.
- Float signals are written as signed (`-`), with `SIG_VALTYPE_` marking them as floats, as Vector tools do.
- A message with no transmitter, or a signal with no receivers, is written with `Vector__XXX`. `BU_` lists every transmitter and receiver in order of first mention.

Apart from these limits, exporting and re-importing gives an equal database. Tests in `crates/can-dbc-model/src/writer.rs` and `crates/can-wasm/src/lib.rs` cover this.

## J1939 decoding

A J1939 message decodes every extended frame with its PGN, whatever the frame's priority and source address. The exact CAN ID is tried first, across every DBC that applies to the bus, so a DBC written for one sender wins over a generic J1939 one. Proprietary PGNs (PDU format 239 and 255) mean whatever each sender defines, so they match only frames from the source address in the DBC. The PGN includes the data page and extended data page bits, and the PDU-specific byte only for PDU2 formats (240 and up).

When several J1939 messages share the frame's PGN, the one written for the same source address (and, for PDU1, the same destination) wins, then one for the same source address, then the first.

SAE J1939-71 reserves the top of a parameter's raw range for "error" and "not available". So for J1939 messages, an unsigned signal of 8, 16, 24, 32 or more bits (a multiple of 8) whose most significant byte is above 0xFA decodes as no value, which leaves a gap in a plot. The DBC's min and max are not used for this, so a narrow engineering range never hides real data. Smaller fields, such as 2-bit states, and signed or float signals decode as they are.

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
