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
- [ ] Check Export DBC... in a browser (the exported text is covered by Rust tests)
- [x] Commit to `main`, push, and open the first PR from a feature branch: https://github.com/KyleAlanJeffrey/can-viewer/pull/1
- [x] CodeRabbit review, with every comment addressed (fixed, or answered on the PR)
- [ ] Connect Cloudflare Workers Builds to the repo (deploy command: `npx wrangler deploy`)
- [ ] After the first deploy, check the demo, reload restore and the CSP on the live site
- [ ] Update the views to the new mockups when they land (docs/ holds the current ones)

## Bugs

- [ ] DBCs saved in the browser before J1939 support have no `j1939` flag, so they only match by exact ID until they are opened again
- [ ] Database view: "Overridden by" compares exact IDs only, so it misses a J1939 message whose PGN an earlier DBC decodes
- [ ] Extended multiplexing (`SG_MUL_VAL_`) is not decoded; every multiplexed signal is switched by the message's one multiplexor
- [ ] DBC export drops attributes other than `VFrameFormat`, including CAN FD frame formats
- [ ] A DBC with two `BO_` lines for the same ID loads, but the Database view selects, edits and deletes messages by ID, so both change together (PR #1 review)
- [ ] Export DBC... marks the DBC clean before the file is saved, so a cancelled save dialog loses the "unexported edits" guard on Remove and on reopening the file (PR #1 review; use `showSaveFilePicker` where available)
- [ ] Two tabs both save their DBC list to IndexedDB, so an older tab can overwrite the other's edits (PR #1 review)

## Follow-ups

- [ ] Database view: show and edit whether a message is J1939
- [ ] J1939 transport protocol (TP.CM / TP.DT) reassembly, so multi-packet messages such as DM1 decode in full
- [ ] Log formats beyond candump: ASC, BLF, TRC, MF4, CSV
- [ ] Automated UI tests
- [ ] Database view: show when a DBC was last exported
- [ ] Exporting a DBC marks it clean, which resends every DBC to the core and refreshes the ID summaries even when nothing changed
- [ ] Show error frames as their own kind of row in the ID lists (today they appear as ID `20000080` and so on, kept apart from data IDs and never counted as unknown)
- [ ] Start a new core worker after a wasm trap (an out-of-memory parse, say); today the failed open leaves a fresh session, but a trapped instance may stay unusable until a reload (PR #1 review)
