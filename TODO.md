# TODO

Tasks and bugs for FreeCAN Studio. This file is the source of truth for open work: add an item when it comes up, and tick it when it's done.

## Current work

- [x] Several DBCs at once, each for every bus or for one bus
- [x] Keep the open log, DBCs and view state across a page reload
- [x] Cloudflare deployment (`wrangler.jsonc`, `scripts/build-cloudflare.sh`, `web/public/_headers`)
- [x] Overview: the whole page scrolled when the log had many IDs
- [x] Decode J1939 messages by PGN, whatever the priority and source address
- [x] Match proprietary J1939 PGNs (PF 239 and 255) by source address too
- [x] Decode out-of-range J1939 values as not available instead of plotting 0xFFFF spikes
- [x] Keep `VFrameFormat` (which messages are J1939) on DBC export
- [x] Reopening an edited DBC's file no longer discards the unexported edits
- [x] Build installs with pnpm (the repo has `pnpm-lock.yaml`, not `package-lock.json`)
- [x] Repo docs: CONTRIBUTING.md, VERSIONING.md, VERSION, COMPATIBILITY.md, API.md
- [x] Check the Database view by hand: Move and its focus, New DBC, New Message, Remove with its confirmation and focus
- [x] Check Export DBC... in a browser (the exported text is covered by Rust tests). Checked on the live app with the save picker: a cancelled save keeps the unexported-edits mark, and a save writes the edited text. The download fallback for browsers without `showSaveFilePicker` was not checked
- [x] Commit to `main`, push, and open the first PR from a feature branch: https://github.com/KyleAlanJeffrey/can-viewer/pull/1
- [x] CodeRabbit review, with every comment addressed (fixed, or answered on the PR)
- [x] Connect Cloudflare Workers Builds to the repo (deploy command: `npx wrangler deploy`)
- [x] After the first deploy, check the demo, reload restore and the CSP on the live site
- [ ] Exclude `app.freecanstudio.com` from Cloudflare Web Analytics; it injects a beacon that the app's CSP blocks (owner)
- [ ] Workers Builds fails at once on every non-production branch for both projects while `main` deploys fine; check the non-production branch build settings in the dashboard (owner)
- [x] Update the Reverse Engineer view to the v4 mockups (Byte Values and Advanced)
- [x] Reverse Engineer Advanced: Suggested signals (counters, checksums, flags, enums, continuous and signed values) with Accept, Dismiss and Plot it, event and reference hints, and a scan of the unknown messages (`suggestSignals`, `scanSignals`)
- [ ] Suggested signals: float32 values are left out on purpose, a multiplexed message's selector is suggested as a counter and its cells get nothing, and a value whose top bits never change in the log comes out narrower than its real field (VEHICLE_STATE in the demo)
- [ ] Suggested signals: a 64-byte CAN FD message takes about 110 ms to suggest for in the browser (measured with 32 changing 16-bit values; about 1.5 s before the sample was cut for long payloads), and Cancel only lands between messages; move the scan off the main request queue or split the work if logs with many large unknown IDs make it drag
- [x] Compare view: open a second log (B) and rank IDs and bytes by how differently they behave, with ignore rules for counters, checksums and changes within A, Swap, and Open in Reverse Engineer
- [ ] Compare: check the counter and checksum detection, and the scores, against real before-and-after logs (the tests and the smoke test use the generated demo) (owner, with your own logs)
- [ ] Compare: Open in Reverse Engineer selects the ID and byte, but the Advanced window stays where it was; move it to where the byte differs (the first frame of a value log A never shows, say)
- [x] Compare: refuse a log B that would not fit beside log A in wasm memory, before reading it, rather than losing both logs
- [x] Video sync: play a local video beside the Plot view, synced to cursor A by one matched moment, with offset nudges, a corner view and Space to play
- [ ] Video sync: check by hand in Firefox and Safari (codecs, Space, the corner view and the resize handle); only Chromium was checked
- [x] Export log as other formats (Export Log...: candump, ASC, BLF, TRC, MF4, CSV)
- [x] Works offline and installable: a web app manifest with icons, and a service worker that precaches the app shell, keeps the demo after its first run and offers Reload when a new version is ready

## Landing page

A separate static site on `freecanstudio.com`, with the app moving to `app.freecanstudio.com`. Two Cloudflare deployments; the owner sets them up.

- [x] New `site/` folder for the landing page (plain static HTML, no build step), deployed on its own so copy edits don't rebuild Rust and wasm
- [x] Main button goes straight into the app; add a demo link (`app.freecanstudio.com/?demo=1`) and make the app open the demo log from it
- [x] Content pages for the searches people make: BLF viewer online, MF4 viewer online, DBC viewer, CANalyzer alternative; each with a big "Open a BLF file" style button into the app
- [x] No drop zone on the landing page (a dropped file can't be handed to another site); send people to the app to open files
- [x] Analytics, newsletter signup or video embeds stay on the landing page only; the app keeps its strict CSP in `web/public/_headers` and loads nothing from third parties
- [x] State the privacy claim on the landing page: the app domain loads nothing from anyone else
- [ ] Cloudflare: keep `wrangler.jsonc` as the app project with custom domain `app.freecanstudio.com`; second project for the site on the main domain, with `www.freecanstudio.com`, `freecan.studio` and `freecan.app` redirecting to it (none of the three answer yet), and build watch paths so a push to `site/` only rebuilds the site (owner)
- [ ] Later: downloads, pricing and Pro license pages on the main site. Paid features are hidden for now: the `pro/` page and every Pro link were taken off the site (restore them from git history, `site/public/pro/index.html`, when Pro is back on the table) (owner)
- [x] Recheck the site's format claims (ASC, BLF, TRC, MF4, CSV) against the app once those importers land
- [x] Recheck the CSP quoted on the home page if `web/public/_headers` changes (CI now runs `scripts/check-csp-quote.sh`)

## Live capture

- [x] Live capture in the web app: slcan adapters over Web Serial and gs_usb (candleLight) adapters over WebUSB, frames batched into the core about every 100 ms, live Trace, Overview and Plot, Stop, and Save Capture... as a candump log. Tested against simulated devices only
- [ ] Try live capture with real adapters (owner): a CANable with slcan firmware and one with candleLight firmware at least, a USBtin or Lawicel CANUSB if at hand; Chrome or Edge on macOS, Windows and Linux (Linux needs the `gs_usb` driver unbound and udev access, see COMPATIBILITY.md). Check each bitrate used in practice, listen only (`L` on a USBtin; `M1` and the "Start anyway?" question on a CANable, whose slcan firmware answers only `V`; that a CANable in `M1` really sends no ACK), the frame count against `candump` on the same bus, unplugging mid-capture, Stop, Save Capture... and reopening the file, and a long capture on a busy bus
- [x] Site copy: the CANalyzer alternative page said the app works on recorded logs only and can't connect to CAN hardware or capture; it and the home page now mention live capture in Chrome and Edge
- [ ] Trace filters while recording: extend the filtered rows as frames are appended, rather than turning filters off until Stop
- [ ] Use the adapter's own timestamps when it has them (slcan `Z1`, unwrapping its 60 s counter; gs_usb hardware timestamps) for sub-millisecond timing; today frames get the host clock when their bytes arrive
- [ ] gs_usb: CAN FD (data bitrate through `BT_CONST_EXT` and `DATA_BITTIMING`) and a choice of channel on multi-channel adapters; today classic CAN on the first channel
- [ ] slcan: a serial speed setting for adapters behind a UART at a baud rate other than 115200, and custom bit timing (`s`) for bitrates outside `S0` to `S8`
- [ ] Name the capture's bus (always `can0` today), so a DBC scoped to another bus applies to it
- [ ] Overview bus load assumes 500 kbit/s for every log; use the capture's bitrate, and let the user set it for opened logs
- [x] Warn before a long capture reaches the wasm memory cap (about 65 bytes a frame), and stop it by itself before it does
- [x] slcan on a CANable: learn whether the adapter answers from `S` rather than `V`, confirm listen-only only through `L`, read frames only once the open command is written, write `C` before closing the port, and give up on an adapter that doesn't start within 10 s (PR #39)
- [ ] Offer a rolling capture that keeps the last N minutes
- [ ] Keep a remote frame's DLC (slcan `r1238`, gs_usb `can_dlc`), so candump export writes `123#R8`; the frame store has no field for it, so every format's reader drops it today
- [ ] slcan CAN FD: set the data bitrate (the `Y` command of CANable 2 firmware) for FD buses
- [ ] Decide whether an unsaved capture should survive a reload (writing it to IndexedDB in chunks as it runs); today only a saved one comes back

## Bugs

- [x] DBCs saved in the browser before J1939 support have no `j1939` flag, so they only match by exact ID until they are opened again
- [x] Database view: "Overridden by" compares exact IDs only, so it misses a J1939 message whose PGN an earlier DBC decodes
- [x] Extended multiplexing (`SG_MUL_VAL_`) is not decoded; every multiplexed signal is switched by the message's one multiplexor
- [x] DBC export drops attributes other than `VFrameFormat`, including CAN FD frame formats
- [x] A DBC with two `BO_` lines for the same ID loads, but the Database view selects, edits and deletes messages by ID, so both change together (PR #1 review)
- [x] Export DBC... marks the DBC clean before the file is saved, so a cancelled save dialog loses the "unexported edits" guard on Remove and on reopening the file (PR #1 review; use `showSaveFilePicker` where available)
- [x] Two tabs both save their DBC list to IndexedDB, so an older tab can overwrite the other's edits (PR #1 review)
- [x] J1939 RTS/CTS transfers time out after T1 (750 ms) where J1939-21 allows T2 or T3 (1250 ms) after a CTS, an RTS or the end of a block (PR #7 review)
- [x] A J1939 Conn Abort also drops an unrelated transfer the other way between the same two nodes; match the PGN in bytes 5 to 7 (PR #7 review)
- [x] Unfinished J1939 transfers are never swept, so a log of announcements alone can hold about 117 MB per bus (PR #7 review)
- [x] A TP.DT shorter than 8 bytes shifts the reassembled data (PR #7 review)
- [x] Reverse Engineer Bit History reads only the row's 64 bytes but offers bytes up to the message length, drawing nothing past 64 (PR #7 review; capped at 64 with a note)
- [x] The Trace view's "(N bytes)" label is not clipped to the Data column (PR #7 review)
- [x] Reverse Engineer Byte Values labels every payload longer than 8 bytes "CAN FD", including a reassembled J1939 transfer; it now reads "J1939 TP" for those
- [x] Negative and pre-1970 times: candump reads negative timestamps again, MF4, ASC and BLF exports keep times before 1970, and ASC, BLF, TRC and MF4 exports refuse logs before 1900 (PR #38)
- [x] Reverse Engineer Bit Activity counts the window's frames with `rowAtTime`, which leaves out a frame on the window's end and the last frame when the window reaches it, so a bit could change "133% of frames" and the header said one frame fewer than Bit History; the core now counts them (`rowCountBetween`)

## Follow-ups

- [x] Interaction: make the mouse cursor show what a press or drag will do, in every view and kept in step with state changes: `pointer` on buttons, clickable rows, toggles and switch labels; `crosshair` where a click parks the time cursor (plots, byte cells, reference plots) and where a click in the bit grid selects bits; `grab` / `grabbing` on draggable windows; `ew-resize` on window handles, held for the whole drag; `text` on fields; `default` (not `pointer`) on disabled controls, empty-state rows and read-only cells, even while busy; `progress` elsewhere while busy. Audit the CSS and canvas hit areas (BitGrid cells, WindowStrip, Trace rows, uPlot overlays)
- [x] Rows of reassembled J1939 transfers carry only their first 64 bytes; read the full length (row bytes 20 to 22) in `web/src/core/rows.ts` so Trace and Reverse Engineer can show longer payloads
- [x] Run `scripts/crosscheck_cantools.py` against a DBC with extended multiplexing (`SG_MUL_VAL_`) once cantools is installed
- [x] J1939 transport protocol: TP timeouts and RTS/CTS retransmission (a resent packet drops the transfer today)
- [x] Reverse Engineer: Ignore Baseline sheet (dim bits that change in a quiet period)
- [x] Reverse Engineer Bit History: show bytes past 64 of a long reassembled J1939 transfer (fetch them with `frameData`, or a core call for a byte range of many rows)

- [x] Database view: show and edit whether a message is J1939
- [x] J1939 transport protocol (TP.CM / TP.DT) reassembly, so multi-packet messages such as DM1 decode in full
- [x] Log formats beyond candump: ASC, BLF, TRC, MF4, CSV
- [ ] Check BLF and MF4 import against files from real loggers and tools (the tests use synthetic files; BLF matches python-can on its own files) (owner, with your own logs)
- [x] MF4: repair unfinalized files (UnFinMF) whose last DT block or DL list was never updated; today the tail may be lost, and flags other than 0x01, 0x02 and 0x20 are rejected
- [x] MF4: an unsorted data group with records more than 65,536 frames out of order (a window shared by all such data groups) keeps the file's order (after the unfinalized repair, as both change `mf4.rs`). Fixed in the store: a log whose times go backwards is sorted once read (`FrameStore::sort_by_time`), for every format
- [x] MF4: data groups that all link the same large DL list each build their own list of its blocks (`data_blocks` in `mf4.rs`) before the data budget applies, so memory grows with the number of data groups times the list's links: a 628 KB file of 600 data groups over one 32,768-link DL reached 200 MB. Charge the links listed to a budget of the file's size, or share the block lists of a DL read before
- [x] BLF: CAN_FD_ERROR_64 error frames drop the corrupted frame's original ID, direction and extended data. Won't do: error frames are grouped by error class in the ID field, as candump's are, so the original ID is not kept by design
- [x] CSV: a 13-digit whole-number time (Unix milliseconds) is read as microseconds
- [ ] Trace: check the accessible rows with a real screen reader (VoiceOver or NVDA) and in Windows High Contrast. In Chrome the accessibility tree has the header and frame rows with all six cells, and Home, End and the arrows move the active row without dropping it (owner)
- [x] BLF: read the data bytes of CAN_FD_ERROR_64 objects (today an error frame without data)
- [x] MF4: size the file buffer from the file's size instead of letting it double, so a file near 1 GiB peaks around 1.7 GB of wasm memory instead of 2.2 GB (needs a size hint on `AnyParser`)
- [x] Automated UI tests: Vitest setup, with Byte Values and Pin signal covered
- [x] UI tests for Trace, Plot, Overview and Database, and for the worker restart after a wasm trap in `web/src/core/webCore.ts`
- [x] Trace: the canvas rows are not in the accessibility tree. The `grid` has `aria-rowcount` but no rows, so a screen reader hears none of the frames, and the UI tests can only check which rows are fetched and what a click pins
- [x] Plot: the cursor rail, drag to zoom and the minimap need layout jsdom lacks, so no UI test covers them; check them by hand
- [x] Database view: show when a DBC was last exported
- [x] Exporting a DBC marks it clean, which resends every DBC to the core and refreshes the ID summaries even when nothing changed
- [x] Show error frames as their own kind of row in the ID lists (today they appear as ID `20000080` and so on, kept apart from data IDs and never counted as unknown)
- [x] Start a new core worker after a wasm trap (an out-of-memory parse, say); today the failed open leaves a fresh session, but a trapped instance may stay unusable until a reload (PR #1 review)
- [x] Trace filters: bus, IDs or names, data rules, frame kind and time range, filtered in the core (`setTraceFilter`, `countFilterMatches`), with chips, a match count and an empty state
- [x] Trace filters: "Remove last filter" drops the filter edited last: the filters keep an edit order of their chips (`TraceFilters.edited`), updated by each edit in the sheet and each chip removed; filters saved before it count as edited in display order
- [ ] Trace filters: a preview count that is already running in the worker is not stopped, only ignored; one queued behind it is skipped. On a 10M-frame log a count with data rules takes about 0.5 s natively (more in wasm), so a running count can delay the next table fetch by that much
- [ ] Trace filters: data rules match any byte of a reassembled J1939 transfer, but matched bytes are only outlined in the first 64 the row carries
- [ ] Trace filters: Apply filters the log again even when the preview just counted the same filters; keeping the preview's matches would cost 4 bytes per match for every draft
- [x] Trace filters: "Any byte changes" ignores a payload that only grows or shrinks, matching the changed bytes the trace highlights (a length change has no changed byte to show); the sheet's hint now says so
- [x] Bit flips (`IdStats::bit_flips`, `bitFlipsBetween`) and change activity compare each frame with the previous frame of its ID and kind, as the trace's changed bytes and the filter do, so a polled ID's remote frames no longer hide the changes between its data frames; the Inspector heatmap, Reverse Engineer's Bit Activity and window strip, and Suggested signals all read these counts
- [ ] Trace filters: check the sheet, the ID combobox and the range handles with a real screen reader (VoiceOver or NVDA) (owner)
- [ ] Memory: the store's columns are plain `Vec`s, and doubling on growth nearly doubles peak memory; switch to fixed-size chunked columns
- [ ] Parallel parsing: a pool of workers parsing `Blob.slice` ranges for multi-core throughput
- [ ] Plot queries: level-of-detail pyramids, so a query no longer scales linearly with the points in range
