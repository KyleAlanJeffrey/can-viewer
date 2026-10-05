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
| `BroadcastChannel` | Telling other tabs of this app that the saved DBCs changed (`web/src/session.ts`) |

Of these, the most recent addition in Firefox is module workers (Firefox 114), and in Safari it is `DecompressionStream` (Safari 16.4).

Used when present, with a fallback otherwise:

| Feature | Used for |
|---|---|
| `showSaveFilePicker` (File System Access API, Chromium only) | Export DBC... and Save Capture... save through the browser's save dialog, and the DBC counts as exported (the capture as saved) only once the file is written; a cancelled dialog leaves it as it was. Elsewhere they are downloads, which give no completion signal, so they count as done once the download starts. |
| Web Serial (`navigator.serial`, Chromium desktop only) | Live capture from slcan adapters (see "Live capture" below). Without it, Capture... explains that live capture needs Chrome or Edge on a desktop computer. |
| WebUSB (`navigator.usb`, Chromium only) | Live capture from gs_usb (candleLight) adapters. |

Notes:

- `crypto.randomUUID` exists only in secure contexts, so the app must be served over HTTPS or from `localhost`. A dev server opened over plain HTTP on a LAN address cannot load DBCs.
- When IndexedDB is unavailable (private windows, blocked site data) or full, the app still works but cannot restore the session after a reload. It tells the user when a log could not be kept.
- The production Content-Security-Policy (`web/public/_headers`) allows scripts only from the app's origin plus `'wasm-unsafe-eval'`, which wasm compilation needs. Live capture needs no other origin. The Permissions-Policy header there leaves `serial` and `usb` at their default, the app's own origin.
- The core runs on wasm32, so its memory is capped at 4 GiB, and a browser may allow less. In the spike, a 552 MB, 10M-frame candump log used about 654 MB of wasm memory (see [README.md](README.md)). An MF4 file is held whole while it is read, on top of its frames, in a buffer sized from the file's size: a 112 MB, 10M-frame MF4 from `sample-gen convert` uses about 610 MB, a 178 MB, 16M-frame one about 920 MB, and an uncompressed one near the 1 GiB limit (1.07 GB, 12.9M frames) about 1.7 GB. The frame store is pre-sized from the file size, for at most 20M frames (about 520 MB); a log with more grows it as it is read.

## Platforms

Desktop only. Phones and tablets are out of scope: no phone layout is designed, built or tested (see [PRODUCT.md](PRODUCT.md#platform)). FreeCAN Studio Pro, the planned desktop app, will wrap the same web UI in Tauri.

## Log formats

| Format | Extensions | Status |
|---|---|---|
| candump log files (`candump -l` / `-L`) | `.log`, `.txt`, `.candump` | Supported |
| Vector ASC | `.asc` | Supported |
| PEAK TRC (file versions 1.0 to 2.1) | `.trc` | Supported |
| CSV (python-can, SavvyCAN, generic) | `.csv` | Supported |
| Vector BLF (CAN and CAN FD objects) | `.blf` | Supported |
| ASAM MF4 (CAN bus logging, MDF 4.x) | `.mf4`, `.mdf` | Supported |

The landing site (`site/public/index.html` and the BLF, MF4 and CANalyzer pages) lists these formats too; change it with this table.

How the format is chosen (`Format::detect` in `crates/can-formats/src/detect.rs`): the file name's extension suggests a format, and the first 4 KiB of the file confirm or correct it, so a log with the wrong extension still opens. A file whose content identifies no format, or could be more than one, is read as what its extension says, or as candump if the extension is unknown too. The content rules, in order:

- Vector BLF: the file starts with `LOGG`.
- ASAM MF4: the file starts with `MDF` and five spaces, or `UnFinMF ` (unfinalized).
- candump: the first non-blank line starts with `(`.
- CSV: the first non-blank line that is not a `#` comment or Excel's `sep=,` line is a header with a time column, an ID column and data columns that the CSV reader knows (see below). This comes before the TRC and ASC rules, so a header such as `;time;id;data` (pandas with `sep=';'`) or `Date Time,Timestamp,ID,Data` is CSV.
- PEAK TRC: the first non-blank line starts with `;$` (`;$FILEVERSION=`), `;#` or `;-`. Any other `;` line is left to the extension.
- Vector ASC: the first non-blank line starts with `base hex`, `base dec` or `Begin Triggerblock` (case-insensitive), or is a `date` line whose date the ASC reader reads. A `date` line in another layout is left to the extension.

The result is reported as `LogInfo.format` (see [API.md](API.md)). Whatever the format, `LogInfo.lines` counts the lines of a text file or the records of a binary one, and the first line or record that does not parse is reported with its number and a reason.

Bus names: candump keeps the interface names from the file (`can0`, `vcan1`), and so does a CSV with a bus column of names. Formats that number their buses instead (ASC, BLF, TRC, MF4, a CSV bus column of numbers) give `can<number>` with the number as written in the file, so CANoe's channel 1 is `can1` and SavvyCAN's bus 0 is `can0`. Formats and files without bus information put every frame on `can1`. A DBC scoped to a bus is matched by that name.

Frame order: rows are in time order, which time lookups rely on. A log whose times go backwards anywhere (a logger merging buses or buffers, say) is sorted by time once it is read, with frames of the same time kept in the file's order, and its J1939 transfers and per-ID statistics are worked out again in time order. Sorting rebuilds the frame store a column at a time, so on top of the store it needs the payload bytes and their offsets (or one smaller column), 4 bytes per frame and the reassembled J1939 payloads; a log already in time order is not sorted. If that memory cannot be had, the log still loads, in the order it came. Bus numbers stay in order of first appearance in the file.

Error frames from formats other than candump get the ID `0x20000000`: the CAN error flag with no error class, because those formats carry no SocketCAN error class. They are flagged as error frames, counted in `LogInfo.errorFrames`, and never decoded.

candump support (`crates/can-formats/src/candump.rs`):

- Lines look like `(1436509052.249713) can0 123#DEADBEEF`.
- Classic frames (`<id>#<data>`), remote frames (`<id>#R`, with or without a length), an optional `_<dlc>` suffix, and CAN FD frames (`<id>##<flags><data>`) are read. Data bytes may be separated by `.`.
- Three hex digits mean an 11-bit ID; eight mean a 29-bit ID. Error frames (the CAN error flag in the ID) are kept and flagged. They keep the error flag in their ID, so error class 0x80 (reported as 20000080) never mixes with an 11-bit frame 080, and no DBC decodes them.
- The ` T` / ` R` suffix written by `candump -x` is read.
- CAN XL lines are rejected, and so is candump's default console output (without `-l` or `-L`).
- A line that does not parse does not stop the load. It is counted in `LogInfo.rejected`, and the first one is reported with its line number.
- Lines out of time order are sorted (see "Frame order" above).
- J1939 multi-packet transfers are reassembled into extra frames as the log loads; see "J1939 transport protocol" below.

Vector ASC support (`crates/can-formats/src/asc.rs`), as written by CANoe, CANalyzer and python-can:

- Header: `base hex` (the default) or `base dec` sets the number base of IDs, DLCs and data bytes. `timestamps absolute` (the default) means seconds from the start of measurement; `timestamps relative` means seconds since the previous event line, summed over every event line including skipped ones, and `Begin Triggerblock` restarts the sum. A `date` line in CANoe's layout (`Tue Sep 30 00:00:00.000 2025`, with or without the weekday, milliseconds and am/pm, with English or German month names) gives the absolute start time, taken as UTC because the file names no time zone. Without one, times count from zero.
- Classic lines: `<time> <channel> <id>[x] <Rx|Tx|TxRq> d <dlc> <bytes...>`, and remote frames with `r` in place of `d <dlc> <bytes...>`, with or without a DLC after the `r`. The `x` suffix marks a 29-bit ID; an ID above 0x7FF is read as 29-bit even without it. DLC codes 9 to 15 carry 8 bytes, as on a classic bus; CAN FD frames come on `CANFD` lines. Text after the data bytes (`Length = ...`) is ignored.
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

CSV support (`crates/can-formats/src/csv.rs`). There is no one CSV layout, so the header line (the first non-blank line that is not a `#` comment) names the columns, and the reader needs a time column, an ID column and data columns it knows:

- python-can's `CSVWriter` layout: `timestamp,arbitration_id,extended,remote,error,dlc,data`, with seconds, a `0x` hex ID and base64 data (hex data is read too).
- SavvyCAN's export: `Time Stamp,ID,Extended,Dir,Bus,LEN,D1,D2,...,D8`, with microseconds, hex IDs, `true`/`false` flags and one column per byte.
- Any other header whose names the reader knows. Names are matched case-insensitively, ignoring spaces, underscores and dashes, with a unit in parentheses allowed. Time: `t`, `ts` or a name starting with `time`. ID: `id`, `arbitration_id`, `can_id`, `identifier`, `frame_id`, `msg_id`, `message_id`, `arb_id`. Data: one column named `data`, `data_bytes`, `payload`, `bytes`, `hex_data` or `data_hex` holding every byte in hex (bytes optionally separated by spaces, colons, dashes or dots, with or without `0x`) or base64, or consecutive one-byte columns `D1..D8`, `byte0..`, `b0..` or `data[0]..`. Optional: `dlc`, `len`, `length`, `data_length`; `extended`, `ext`, `ide`, `is_extended`; `remote`, `rtr`; `error`, `err`; `fd`, `is_fd`, `canfd`, `edl`; `brs`; `esi`; `dir`, `direction`, `rx/tx`; `bus`, `channel`, `interface`, `chn`, `ch`. The first column of each kind wins. Flags read `1`/`0`, `true`/`false`, `yes`/`no`, `y`/`n`, `t`/`f`, `x`/`-` and empty (false). Direction `Tx` or `T` marks a transmitted frame.
- The time unit comes from the time column's name when its last word is one: `ns`, `us` (or written with the micro sign), `ms`, `s`, `sec`, `seconds` and the longer words, as in `Time (ms)`, `timestamp_us`, `time_s` or `t[s]`. Otherwise the first row whose time is not a whole zero decides it for the whole file (zero is the same in every unit): a value with a decimal point or an exponent (`1e-05`) is seconds, a whole number of 17 or more digits is nanoseconds (Unix time in nanoseconds has 19), a whole number from 946684800000 up to (not including) 4102444800000 is Unix milliseconds (2000-01-01 to 2100-01-01, 13 digits in practice), and any other whole number is microseconds, which covers relative counters (`0`, `1500`) and Unix microseconds (16 digits). Whole Unix seconds (10 digits) are read as microseconds, since they look the same as a microsecond counter at 16 to 68 minutes, as SavvyCAN's hardware timestamps often are; name the unit in the header (`time_s`) for such a file. A microsecond counter that has run 11 to 47 days when the deciding row is written is read as Unix milliseconds; name the unit (`time_us`) to keep it microseconds. Times may be negative. Times are taken as absolute Unix time when they are large enough to be, since a CSV carries no start date; nothing is added or subtracted.
- The delimiter is whichever of comma, semicolon and tab appears most in the header. Cells may be wrapped in double quotes, but a delimiter inside quotes is not supported. A UTF-8 byte order mark before the header is skipped.
- An ID above 0x7FF, or an extended flag that is true, gives a 29-bit ID. A true error flag gives an error frame (see the note on error frame IDs above) keeping the low 29 bits of the written ID, so python-can's `0x20000080` reads back as it was. A data length above 8, or a true FD, BRS or ESI flag, marks a CAN FD frame. A length column truncates the data to that many bytes. Byte columns end at the first empty one.
- A header the reader cannot use rejects every line of the file with the reason "the CSV header has no time, ID and data columns we know". A row with a bad time, ID, flag, length or data cell, or too few cells to reach the time, ID or data column, is rejected with a reason.
- Not read: quoted delimiters, columns of decoded signal values (a CSV of signals is not a frame log), and any time base other than the one in the header, so a file of wall-clock strings (`12:34:56.789`) is rejected row by row.

Vector BLF support (`crates/can-formats/src/blf.rs`), for files as CANoe, CANalyzer and python-can write them. It is tested with synthetic files from the unit tests and `sample-gen convert`, not yet with files from those tools:

- The file header's start time (a Windows SYSTEMTIME, millisecond precision) gives the absolute start, taken as UTC because the file names no time zone; when it is unset, times count from zero. Object timestamps are nanoseconds, or 10 microsecond units when the object's flags say so, from that start.
- Objects with version 1 or version 2 headers are read. Log containers (object type 10) holding zlib-compressed (method 2) or uncompressed (method 0) objects are unpacked as they arrive; an object that continues from one container into the next is joined. A container claiming more than 64 MiB uncompressed, or that does not inflate, is rejected as a record. Objects are read in order, and sorted by time afterwards only if their times go backwards (see "Frame order" above).
- Frame objects: CAN_MESSAGE (1) and CAN_MESSAGE2 (86) give classic frames, with the direction bit setting the transmitted flag and the remote bit a remote frame with no data. CAN_FD_MESSAGE (100) and CAN_FD_MESSAGE_64 (101) give CAN FD frames with the BRS and ESI flags, or classic frames when their EDL bit is clear; the data length comes from the DLC, limited by the valid-bytes count of a CAN_FD_MESSAGE_64. CAN_ERROR (2) gives an error frame with no data, CAN_ERROR_EXT (73) one with the DLC and data bytes the record holds, and CAN_FD_ERROR_64 (104) one with the valid-bytes count of data bytes, flagged CAN FD with BRS and ESI when its EDL bit is set (see the note on error frame IDs above). Bit 31 of an object's ID, or an ID above 0x7FF, marks a 29-bit ID. The bus is `can<channel>` with the channel number as written.
- Every other object type (app triggers, statistics, environment variables, LIN, FlexRay, Ethernet, the CAN overload, driver status and statistic objects) is skipped without counting as rejected. `LogInfo.lines` counts the frame objects read plus the rejected records.
- A frame object shorter than its type needs, an object with a bad header, more than 3 bytes of padding between objects, a timestamp outside the nanosecond range, and a file that ends inside an object are rejected with a reason. A file without the `LOGG` signature rejects a single record and reads no frames. Memory for one object is bounded at 32 MiB compressed and 64 MiB uncompressed.
- Not read: the file header's end time and object counts, and the application and driver information.

ASAM MF4 support (`crates/can-formats/src/mf4.rs`), for CAN bus logging as ASAM MDF 4.x describes it. It is tested with synthetic files built block by block in the unit tests and by `sample-gen convert`, not yet with files from real loggers:

- Because an MF4 file's blocks link to each other anywhere in the file, the file is held in memory and read when it ends, up to 1 GiB. A larger file rejects a single record and reads no frames. The progress bar fills while the file is read and the frames appear at the end. The data is then read one data block at a time, so there is no limit on the uncompressed size; the frames only have to fit in memory (see the wasm memory note under Notes above).
- Blocks read: ID, HD (the start time, taken as UTC nanoseconds), DG, CG, CN (with compositions, for the structure channel and its members), TX for names, CC (linear conversions of the time channel; other conversions count as none), DT, DV, SD, DZ (deflate, with or without transposition), DL lists and HL headers. Data groups may be sorted (one channel group, no record IDs) or unsorted (record IDs of 1, 2, 4 or 8 bytes).
- Frame channel groups are the ones with a channel named `CAN_DataFrame`, `CAN_RemoteFrame` or `CAN_ErrorFrame`, or with members named `CAN_DataFrame.<member>` and so on. Members read: `BusChannel`, `ID`, `IDE`, `DLC`, `DataLength`, `DataBytes`, `Dir`, `EDL` (or `FDF`), `BRS` and `ESI`, of any integer or float type and either byte order. `DataBytes` may be a fixed byte array or variable length data, held in an SD block (or a list of them) or in a VLSD channel group of the same data group. Every other channel group (decoded signals, LIN, FlexRay, Ethernet) is skipped.
- Time is the master channel (channel type 2 or 3, preferring sync type time) through its linear conversion, in seconds from the header's start time. A virtual master counts records. A group without one puts every frame at the start time.
- Frames from every data group are merged by time as they are read, since each group is stored separately. MDF has the times of a channel group never decrease, so a data group with one CAN frame channel group is read straight through. In an unsorted data group with several, whose records interleave as a logger writes them, the frames are put in time order within a window of 65,536 frames, shared by all such data groups in the file; frames further out of order than that are put in place when the log is sorted after it is read (see "Frame order" above). The data length is `DataLength`, else the DLC (a CAN FD length when EDL is set), and never more than the bytes the record holds. `IDE`, bit 31 of the ID, or an ID above 0x7FF marks a 29-bit ID. `Dir` 1 is transmitted. Error frames take the usual error ID (see the note above) with their data bytes, if any. The bus is `can<BusChannel>`, or `can1` without that member.
- An unfinalized file (`UnFinMF`, as a logger leaves it when stopped before it could finish the file) is read and repaired as it is read, going by its standard unfinalized flags (bytes 60 and 61 of the file):
  - 0x04, the length of the last DT block was not updated: the last DT block of each data group's data runs to the next block the file links to, or to the end of the file, whatever its length field says. A length field that reaches that point (but for padding to 8 bytes), or that ends where another block starts (a header with an MDF 4 block ID and a length that fits the file), is kept; one shorter than the block's header is not. A record cut short at the end of that block, which the logger was writing when it stopped, ends the data group quietly, and so does a record there whose bytes, record ID included, are all zero (or whose record ID is 0 when no channel group has that ID), as a logger that preallocates its file leaves zeros past what it wrote. A frame record that really is all zero bytes there is lost with them.
  - 0x10, the last DL block of a list was not updated: the last DL block of each list (data, or SD data) lists its links in order up to the first that is empty, leads past the end of the file or leads to a block other than DT, DZ, DV, SD or RD, whatever its count says. Earlier DL blocks of the list keep to their count.
  - 0x40, the offsets of VLSD values were not written: a frame record whose `DataBytes` are in a VLSD channel group takes that group's values in order, the first record the first value and so on, instead of the offset in the record.
  - 0x01, 0x02, 0x08 and 0x20 (cycle counters of CG, CA and SR blocks, the length of the last RD block, the data byte counts of VLSD channel groups) concern data the reader does not use, and are ignored.
  - The custom flags (bytes 62 and 63) are the writer's own and are ignored: the file is read as it is. A standard flag above 0x40 rejects a single record with "unfinalized MF4 file; finalize it with the logger's tool". The flags of a finalized file (`MDF`) are ignored.
- A file without the MDF signature, a version other than 4.x, a missing header, or a file with no CAN frame groups rejects a single record. A data group with a broken block, record ID or data list rejects one record and the other groups are still read. Links that lead back to a block already read (a data group, channel group, channel or data list), more channels than the file's size can hold (one per 32 bytes), a channel group with more than 65,536 channels named like CAN frame members, in an unfinalized file with flag 0x04 more links than the file has 8-byte words (each block's links counted once), more data list entries than the file has 8-byte words (each DL block and each block it lists counted every time a data group or SD data reads the list, so data groups sharing one large list end early), data blocks giving more than 100 bytes per byte of the file (a compressed block counts its compressed size when that is larger), and more frame records than the file has bytes are rejected with a reason, so a damaged file ends quickly. A frame record with a bad time, value or data offset is rejected with a reason, and a record cut short at the end of the data ends its data group with one.
- Not read: MDF 3 files, CAN XL frames, CAN_OverloadFrame and other bus events, signal-based (decoded) MF4 files, sample reduction blocks, invalidation bits, attachments, events and the header's time zone and local-time flags.

Written: Save Capture... writes a capture as a candump log (`candump -l` layout, the [`exportCandump`](API.md#exportcandump) format), which every tool that reads candump logs, this one included, can open:

- Times are absolute (seconds since the Unix epoch) to the microsecond, from the computer's clock at the start of the capture.
- Classic frames are `<id>#<data>`, remote frames `<id>#R`, CAN FD frames `<id>##<flags><data>`, error frames keep the error flag in their 8-digit ID, and transmitted frames end in ` T`.
- J1939 transfers reassembled by the app are left out; their packets are written.

## Live capture

Capture... records frames from a CAN adapter plugged into the computer, in the browser. Nothing is uploaded: frames go from the adapter to the tab's own engine.

Browsers: Chrome or Edge on a desktop computer (Windows, macOS, Linux, ChromeOS), over HTTPS or from `localhost`. Live capture uses Web Serial (Chrome and Edge 89 and later) and WebUSB (61 and later); the app looks for the APIs rather than the browser, so another Chromium browser that has them works too. Firefox and Safari have neither: Capture... then explains what is needed, and the rest of the app works as before.

Adapters:

| Kind | Examples | Browser API | Notes |
|---|---|---|---|
| slcan (Lawicel) | CANable and CANable 2 with slcan firmware, USBtin, Lawicel CANUSB, other slcan adapters | Web Serial | Classic CAN, plus CAN FD frames (`d`, `D`, `b`, `B`) from adapters that send them |
| gs_usb | candleLight, CANable with candleLight firmware, other adapters the Linux `gs_usb` driver binds (USB IDs 1D50:606F, 1209:2323, 1CD2:606F, 16D0:10B8) | WebUSB | Classic CAN only; the first channel only |

slcan (`web/src/capture/slcan.ts`):

- The serial port is opened at 115200 baud. USB adapters that show up as a virtual serial port (CDC-ACM) ignore the baud rate; an adapter behind a UART at another baud rate is not supported yet.
- Start: `C` (close, in case the channel was left open; its answer is not checked), then `S0` to `S8` for 10, 20, 50, 100, 125, 250, 500, 800 kbit/s or 1 Mbit/s, then `L` (listen only) or `O`. An adapter that refuses `L` is opened with `O` and the user is told, since it then acknowledges frames. A CR answer means OK and BEL an error; a command unanswered within a second fails the start. Stop sends `C` and closes the port.
- Frames read: `t`/`T` (classic), `r`/`R` (remote), `d`/`D` (CAN FD) and `b`/`B` (CAN FD with bit rate switch), with FD lengths from DLC codes 9 to F. A 4-digit timestamp after the data (`Z1` mode) is skipped. A line that is not a frame, or a BEL from the adapter, is counted as a problem and the capture goes on.
- Bitrates other than the nine `S` codes (`s` with bit timing registers) are not offered.

gs_usb (`web/src/capture/gsUsb.ts`):

- The protocol of the Linux `gs_usb` driver: host format, then the device's bit timing limits (`BT_CONST`), then bit timing for the chosen bitrate at a sample point as near 87.5% as the limits allow, then `MODE` start, listen only when the device's features include it (otherwise opened normally, and the user is told). Stop resets the device.
- An overflow flag from the device is counted as a problem ("frames were lost").
- Linux: the kernel's `gs_usb` driver claims the adapter, so the browser cannot open it until the driver is unbound from it (for example `echo -n <bus-port>:1.0 | sudo tee /sys/bus/usb/drivers/gs_usb/unbind`), and the user needs write access to the USB device (a udev rule). Web Serial on Linux likewise needs access to the serial device, usually through the `dialout` group.
- Windows: candleLight firmware asks Windows for the WinUSB driver itself; an adapter given another driver cannot be opened from the browser.

Timestamps: frames are timed with the computer's monotonic clock (`performance.now()`) when their bytes reach the page, counted from the wall-clock time the capture started. The adapter's own timestamps (slcan `Z1`, gs_usb hardware timestamps) are not used: slcan's wrap every minute and need no setup to skip, and one clock for every adapter keeps captures comparable. Frames that arrive in the same USB transfer share a time, and USB polling and the browser add jitter of about a millisecond or more, so the times suit trends, plots and ordering, not microsecond timing analysis.

Limits:

- Frames are kept in the tab's memory, like an opened log, at about 65 bytes a frame (see "Browsers" above for the wasm memory cap). A busy 500 kbit/s bus (about 4,000 frames/s) fills about 1 GB an hour.
- Frames reach the engine in batches about every 100 ms, or at once when 5,000 are waiting, so a capture keeps up in a background tab whose timers the browser slows down. Views refresh about twice a second; plots of decoded signals about every 2 seconds.
- One adapter, one bus (stored as `can0`) and one capture at a time. The app never transmits a frame.
- A capture is not kept across a reload until it is saved (see "Saved sessions" below); the app asks before closing the tab, replacing or closing an unsaved capture.
- Real adapters have not been tested yet; the protocol handling is tested against simulated devices only.

## DBC files

Import (`crates/can-dbc-model`) reads:

- Messages with standard and extended IDs, with transmitters. Message IDs are unique after import: when a file defines the same ID twice (two `BO_` lines), the first definition is kept and the later ones are dropped, because the app selects, edits and deletes messages by ID.
- Signals: Intel and Motorola byte order; unsigned, signed, and IEEE float32 or float64 (`SIG_VALTYPE_`); factor, offset, range, unit and receivers.
- Multiplexing, simple (one multiplexor per message) and extended (`SG_MUL_VAL_`): a signal names the multiplexor that switches it and the raw value ranges under which it is present, and a multiplexor can itself be multiplexed. A signal with an `SG_MUL_VAL_` entry is present only when its whole chain of multiplexors is; one without is switched by the message's multiplexor and its `m<value>`. Decoding matches cantools (see Checks in CONTRIBUTING.md), with two differences: a frame whose multiplexor value switches in no signal still decodes its other signals, where cantools rejects the frame; and in a message with several multiplexors, a signal with `m<value>` but no `SG_MUL_VAL_` entry is switched by the first multiplexor, where cantools treats it as not multiplexed.
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
- Transfers are tracked per bus, source address and destination address, so interleaved senders do not mix. Packets without an announcement (a log that starts mid-transfer) are ignored.
- An unfinished transfer is dropped quietly on an abort that names its PGN (bytes 5 to 7 of the abort; a transfer the other way between the same two nodes is kept unless it carries that PGN), on a new announcement from the same sender to the same destination, or when its next frame comes too late after the one before. The limits are the J1939-21 timeouts: 750 ms (T1) between packets of a BAM, or of the block a CTS asked for; 1250 ms (T2) from a CTS to its first packet; 1250 ms (T3) from an RTS, or from the last packet of a block, to the next frame, which may be a CTS or, when the CTS messages are not in the log, the next packet. The 200 ms (Tr) that each side of an RTS should answer within is not enforced. Timeouts use the log's timestamps.
- Transfers that never finish are swept out once enough are open (256, then whenever the count has doubled since the last sweep), and a transfer holds only the bytes received so far, so a log full of announcements alone does not hold memory.
- A TP.DT packet must be 8 bytes long. A shorter or longer one drops a BAM transfer, and is ignored on an RTS connection as if out of order.
- A BAM packet out of order (missing or repeated) drops the transfer, since nothing can repair it.
- For an RTS, the receiver's CTS messages are followed: a CTS names the next packet and how many to send. A CTS for a packet already received rewinds the transfer, and the packets sent again replace the earlier ones. A CTS for no packets holds the connection, and the next frame may then come up to 1050 ms (T4) later. A CTS for a packet not sent yet, or for packet 0, drops the transfer. A packet out of order is ignored rather than dropping the transfer, since a CTS may ask for it again; the timeout still applies. The packet count of a CTS is not enforced, and a transfer whose CTS messages are not in the log reassembles from its packets alone.
- Reassembled frames count towards nothing on the bus: `busLoad` skips them, since their packets are already counted.
- The payload of a reassembled frame can be longer than 64 bytes. `decodeSignal` and `decodeRaw` work on the whole payload; a trace row carries the first 64 bytes and the full length, `frameData` returns the whole payload, and `rowBytes` a byte range of many rows (see `RowBatch`, `frameData` and `rowBytes` in API.md). The Trace view shows the first bytes and the full length; the Reverse Engineer view's cursor readouts use the whole payload, and so does its Bit History. Find Signal searches the first 64 bytes.

## CoreApi

`CoreApi` in `web/src/core/api.ts` is the only interface between the UI and the engine, documented in [API.md](API.md). The web build implements it with a wasm Web Worker. The planned desktop app will implement the same interface over Tauri commands, with the same crates running natively. Because two implementations share it, any change to the contract is a breaking change. That includes:

- Adding, removing or renaming a method.
- Changing a parameter, its order, its units or its meaning.
- Changing the fields, nullability, units or meaning of a type in `api.ts`.
- Changing the packed row layout (`ROW_STRIDE` and the offsets in `web/src/core/rows.ts` and `Session::rows` in `crates/can-wasm/src/lib.rs`).
- Changing the packed capture frame layout (`web/src/core/captureFrames.ts` and `Session::push_frames`).

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
  - `log`: the log file as a Blob, with its name. A live capture is written here only when it is saved (as the candump file saved), so an unsaved capture is not restored after a reload.
  - `dbcs`: `{ revision, dbcs }`: the loaded DBCs (`LoadedDbc[]`, including each full `Database`, whether it has unexported edits and when it was last exported) under a revision number. A tab writes the key only if the store still holds the revision it last read or wrote, checked in the same transaction, so two tabs cannot overwrite each other's edits; the losing tab keeps its changes in memory and asks for a reload. Each successful write is announced on the `freecan-studio` `BroadcastChannel` as `{ type: 'dbcs', revision }`. A bare array, as the first builds wrote, reads as revision 0.
  - `ui`: the open view, selection, pinned time and plots.
  - `views`: per-view state.

Users will have values written by earlier versions. When the shape of a stored value changes, keep reading the old shape, or bump the IndexedDB version and migrate in `web/src/session.ts`. New `Database` fields should be optional, as `SignalDef.receivers` is: `receivers?` in TypeScript and `#[serde(default)]` in Rust. A `MessageDef` saved without `j1939` is restored with it set for 29-bit messages, as the core treated them before the flag existed.
