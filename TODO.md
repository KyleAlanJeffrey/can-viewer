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

## Landing page

A separate static site on `freecanstudio.com`, with the app moving to `app.freecanstudio.com`. Two Cloudflare deployments; the owner sets them up.

- [x] New `site/` folder for the landing page (plain static HTML, no build step), deployed on its own so copy edits don't rebuild Rust and wasm
- [x] Main button goes straight into the app; add a demo link (`app.freecanstudio.com/?demo=1`) and make the app open the demo log from it
- [x] Content pages for the searches people make: BLF viewer online, MF4 viewer online, DBC viewer, CANalyzer alternative; each with a big "Open a BLF file" style button into the app
- [x] No drop zone on the landing page (a dropped file can't be handed to another site); send people to the app to open files
- [x] Analytics, newsletter signup or video embeds stay on the landing page only; the app keeps its strict CSP in `web/public/_headers` and loads nothing from third parties
- [x] State the privacy claim on the landing page: the app domain loads nothing from anyone else
- [ ] Cloudflare: keep `wrangler.jsonc` as the app project with custom domain `app.freecanstudio.com`; second project for the site on the main domain, with `www.freecanstudio.com`, `freecan.studio` and `freecan.app` redirecting to it (none of the three answer yet), and build watch paths so a push to `site/` only rebuilds the site (owner)
- [ ] Later: downloads, pricing and Pro license pages on the main site (a `pro/` page describing the planned app is in)
- [ ] Recheck the site's format claims (ASC, BLF, TRC, MF4, CSV) against the app once those importers land, and the CSP quoted on the home page if `web/public/_headers` changes

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

## Follow-ups

- [x] Interaction: make the mouse cursor show what a press or drag will do, in every view and kept in step with state changes: `pointer` on buttons, clickable rows, toggles and switch labels; `crosshair` where a click parks the time cursor (plots, byte cells, reference plots) and where a click in the bit grid selects bits; `grab` / `grabbing` on draggable windows; `ew-resize` on window handles, held for the whole drag; `text` on fields; `default` (not `pointer`) on disabled controls, empty-state rows and read-only cells, even while busy; `progress` elsewhere while busy. Audit the CSS and canvas hit areas (BitGrid cells, WindowStrip, Trace rows, uPlot overlays)
- [x] Rows of reassembled J1939 transfers carry only their first 64 bytes; read the full length (row bytes 20 to 22) in `web/src/core/rows.ts` so Trace and Reverse Engineer can show longer payloads
- [x] Run `scripts/crosscheck_cantools.py` against a DBC with extended multiplexing (`SG_MUL_VAL_`) once cantools is installed
- [x] J1939 transport protocol: TP timeouts and RTS/CTS retransmission (a resent packet drops the transfer today)
- [x] Reverse Engineer: Ignore Baseline sheet (dim bits that change in a quiet period)
- [ ] Reverse Engineer Bit History: show bytes past 64 of a long reassembled J1939 transfer (fetch them with `frameData`, or a core call for a byte range of many rows)

- [x] Database view: show and edit whether a message is J1939
- [x] J1939 transport protocol (TP.CM / TP.DT) reassembly, so multi-packet messages such as DM1 decode in full
- [ ] Log formats beyond candump: ASC, BLF, TRC, MF4, CSV
- [x] Automated UI tests: Vitest setup, with Byte Values and Pin signal covered
- [ ] UI tests for Trace, Plot, Overview and Database, and for the worker restart after a wasm trap in `web/src/core/webCore.ts`
- [x] Database view: show when a DBC was last exported
- [x] Exporting a DBC marks it clean, which resends every DBC to the core and refreshes the ID summaries even when nothing changed
- [x] Show error frames as their own kind of row in the ID lists (today they appear as ID `20000080` and so on, kept apart from data IDs and never counted as unknown)
- [x] Start a new core worker after a wasm trap (an out-of-memory parse, say); today the failed open leaves a fresh session, but a trapped instance may stay unusable until a reload (PR #1 review)
