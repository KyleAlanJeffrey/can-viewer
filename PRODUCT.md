# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

Desktop browsers first, with phones coming in progressively. On phones (600px wide and below) Overview, Trace and Plot have phone layouts; Reverse Engineer, Compare and Database don't yet, though they stay reachable and inside the window. Live capture on phones is experimental and follows the browser: iOS browsers can't reach serial or USB devices, so the app says it isn't available there. Tablets get the desktop layout.

FreeCAN Studio Pro, the paid desktop app, will wrap the same web UI in Tauri, so its design language stays web rather than native macOS or Windows.

## Users

- **Primary:** working engineers (automotive, embedded, test and validation) who analyse CAN logs at a desk as part of their job. They are the likely buyers of Pro.
- **Welcome:** hobbyists and car hackers reverse-engineering their own vehicles, often with a CANable-class adapter and a laptop. Onboarding and copy must not assume professional tooling knowledge, but the tool is never simplified at the engineers' expense.

The job: open a log (often hundreds of MB), find out what's on the bus, decode it with a DBC if one exists, and work out unknown messages bit by bit when one doesn't.

## Product Purpose

FreeCAN Studio is a free, browser-based CAN bus log viewer and reverse-engineering tool. It opens candump, Vector ASC and BLF, PEAK TRC, ASAM MF4 and CSV logs, and exports the open log in any of those formats. It decodes with imported DBC files, plots signals, makes bit-level activity visible and suggests likely signals, so unknown messages can be defined quickly. It also records live from a CAN adapter (slcan over Web Serial, candleLight/gs_usb over WebUSB) in Chrome and Edge, still experimental until tried with real hardware: live capture moved from the Pro plan into the free web app. FreeCAN Studio Pro is a planned paid desktop app on the same core that adds transmit and replay, UDS scanning, multi-GB files and scripting. Paid features are hidden for now: the web app shows no Pro features or upsell.

Success: an engineer drops a large log into a browser tab and is reading decoded signals, or has defined an unknown one, within minutes, with nothing installed and nothing uploaded.

## Positioning

- Everything runs client-side: a Rust core compiled to WebAssembly in a Web Worker. Log files never leave the user's computer.
- Bit-level reverse-engineering tools are free: flip heatmaps, drag-to-define signals, notching, and automated signal discovery (Suggested signals).
- Real-world scale in a tab: the spike parses 10M frames (552 MB) in about 2.7 s.

## Operating Context

- **Engineers:** long desk sessions with large logs from loggers and interfaces (SocketCAN candump, Vector BLF/ASC, PEAK TRC, ASAM MF4) and DBCs from OEMs, suppliers or opendbc. They switch between trace, plots and the DBC while tracking a behaviour down.
- **Hobbyists:** a laptop in a car or garage, capturing with an adapter (in the app, or with another tool) and then reverse-engineering at home.

## Capabilities and Constraints

- **Built so far:**
  - log parsing for candump, Vector ASC and BLF, PEAK TRC, ASAM MF4 and CSV, and Export Log... to any of the same formats (see [COMPATIBILITY.md](COMPATIBILITY.md#log-export));
  - a columnar frame store with per-ID stats, bit-flip counts, jitter, bus load and error-frame counts;
  - DBC decode (Intel/Motorola, signed, float, simple and extended multiplexing), with several DBCs per log, each for every bus or one bus, J1939 messages matched by PGN and J1939 multi-packet (TP) messages reassembled;
  - six views: Overview, Trace, Plot, Reverse Engineer (drag-to-define signals, Find Signal and Suggested signals), Compare (what differs between two logs, such as idle and one action) and Database (DBC editing and export);
  - a virtualized canvas trace table, a bit heatmap, and uPlot plots with decimation;
  - trace filters by bus, ID or name, data rules, frame kind and time range, run in the core;
  - the open log, DBCs and view state kept across reloads;
  - offline use and install as an app (a service worker and a web app manifest; see [COMPATIBILITY.md](COMPATIBILITY.md#offline-and-install));
  - live capture from slcan (Web Serial) and gs_usb (WebUSB) adapters in Chrome and Edge, saved as candump logs, experimental until tried with real adapters (see "Live capture" in [COMPATIBILITY.md](COMPATIBILITY.md#live-capture));
  - video sync in the Plot view: a local video plays beside the plots, lined up with the log by one matched moment, and moves with the plot cursor. The video stays in the tab and is never stored or uploaded.
- **Planned:** see [docs/screens.md](docs/screens.md), [docs/research.md](docs/research.md) and [TODO.md](TODO.md). Key items are parallel parsing and the Pro desktop app (transmit and replay, UDS scanning, multi-GB files and scripting).
- **Licensing:**
  - The product is closed-source and commercial, so no GPL or LGPL code can be copied in.
  - Pro-only features must not ship in the web bundle (the Cargo `pro` feature or desktop-only crates). Automated signal discovery is not one of them: it ships free in the web app.
  - Fonts and icons must be licensed for web and desktop use. Apple's SF fonts and SF Symbols are not.
- **Pricing and the tagline** are undecided.
- **Mockup decisions (2026-09-30):** omit taglines; use "Free. No account." rather than a forever promise; omit undecided Pro format and file-size claims. Use the shipped 1M-frame demo (55 MB, about 30 min 15 s) across all screens. Keep bus load, jitter, and error-frame counts visible only as explicitly Planned placeholders until the core computes them (it now does).
- **Domain:** the landing site is `freecanstudio.com` and the app `app.freecanstudio.com`; `freecan.studio` and `freecan.app` redirect to the site (see "Deploy" in [README.md](README.md#deploy)). The URL shown in mockups, `studio.freecan.app`, is an image-generator artifact, not a real domain.

## Brand Commitments

- **Names:** "FreeCAN Studio" for the free web app and "FreeCAN Studio Pro" for the paid desktop app. Pro is never described as free. The web app stays free with no caps, trials, nags or account.
- **Mark:** the Twisted F, a capital F whose upright is two intertwined conductor ribbons (the CAN-H/CAN-L twisted pair). Two arms extend right and end in round terminals separated by negative-space gaps. The wordmark is "FreeCAN" in semibold and "Studio" in regular. The concepts are in `docs/freecan-twisted-f-*.png`, and a vector master does not exist yet.
- **Voice:** calm and plain.
  - Plain verbs: "Open Log...", "Try the Demo".
  - An ellipsis means a dialog follows.
  - No "Oops", no hype.
  - Errors explain what happened and what to do next.
- **Privacy wording:** "Files are processed on your computer and never uploaded."
- **Tagline:** none in current mockups or UI. Earlier candidates are not approved.

## Evidence on Hand

- **Performance and correctness:**
  - spike benchmarks in [README.md](README.md);
  - decoder cross-checked against cantools: 1,622,498 values, all equal;
  - a synthetic 10M-frame demo log and demo DBC from `crates/sample-gen`.
- **Brand and mockups:** raster concepts in `docs/`. The approved workspace direction is `docs/freecan-workshop-light-mockup.png`.
- **Not available, so never fabricate:** customers, testimonials, press, prices and usage numbers.

## Product Principles

1. **Private by construction.** No feature may require uploading a user's log or DBC. The privacy claim has to be true in the architecture, not only in the copy.
2. **Free means complete.** The web tier is a real tool, not a demo. Upsell appears only when someone reaches for a Pro-only action.
3. **Fast at real scale.** Design and engineering assume multi-hundred-MB logs and millions of frames, not toy files.
4. **Make the bits visible.** Reverse engineering starts from seeing what changes. Show the raw evidence before any automated interpretation.
5. **Honest feedback.** Determinate progress, inline errors, and exact limits stated plainly.

## Accessibility & Inclusion

- WCAG 2.2 AA:
  - 4.5:1 contrast for text, and 3:1 for UI components and meaningful graphics.
  - Everything reachable and operable by keyboard, with visible focus.
  - Colour is never the only carrier of meaning.
  - Reduced-motion preferences are respected.
- Canvas views (trace, heatmap, plots) need accessible text equivalents: table views, hover or focus readouts, and labelled values.
