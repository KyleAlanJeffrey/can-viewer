# FreeCAN Studio: Screens

This is the full inventory of screens across the three surfaces: the marketing site, the free web app and the Pro desktop app. All of them follow [design-brief.md](design-brief.md).

## Approved Workshop Light mockups

Start with the [brand sheet: logo, fonts, and colors](freecan-workshop-brand-guide-v2.png) and the [current design system](../DESIGN.md). These are revised ImageGen concepts after the mockup review. Exact tokens and component behavior come from the design system; verified counts and readouts come from [mockup-data.json](mockup-data.json). PNG chart curves, activity patterns, and Find Signal rankings remain illustrative. Older image versions are retained for comparison, not as current implementation references.

| Screen | Image |
|---|---|
| Overview | [View mockup](freecan-workshop-overview-v3-mockup.png) |
| Reverse Engineer | [View mockup](freecan-workshop-reverse-engineer-v3-mockup.png) |
| Database | [View mockup](freecan-workshop-database-v2-mockup.png) |
| Plot | [View mockup](freecan-workshop-plot-v2-mockup.png) |
| Home website | [View mockup](freecan-workshop-home-v2-mockup.png) |
| Pro and pricing website | [View mockup](freecan-workshop-pricing-v2-mockup.png) |
| Pro welcome and live capture | [View mockup](freecan-workshop-pro-welcome-live-capture-v2-mockup.png) |
| Find Signal | [View mockup](freecan-workshop-find-signal-v2-mockup.png) |

Priority:
- **P0:** needed for launch.
- **P1:** soon after launch.
- **P2:** later.

## Navigation model (applies to every app screen)

- **Five views.** After a log loads, a segmented control in the centre of the toolbar switches between **Overview · Trace · Plot · Reverse Engineer · Database**. The same views are in the View menu with ⌘1–⌘5.
- **The sidebar is always the source list,** and its content depends on the view:

  | View | Sidebar shows |
  |---|---|
  | Overview, Trace, Reverse Engineer | IDs grouped by bus |
  | Plot | A signal tree with checkboxes |
  | Database | The DBC's messages, including ones that aren't in the log |

  The selection carries across views: pick 0C9 in Trace, switch to Reverse Engineer, and 0C9 is still selected.
- **The inspector always describes the current selection.**
- **Search and ⌘K:** one search field at the top of the sidebar filters its source list. ⌘K opens a command palette for jumping to an ID or signal, or running any command.
- **No accounts in the free web app.** There's no sign-in, no cloud and nothing to upload. That's a selling point, so it shows on the welcome screen and on the marketing pages.

## Web app (free)

| # | Screen | Pri | What's on it |
|---|---|---|---|
| A1 | Welcome / empty | P0 | Covered in the design brief: the drop zone, format chips, "Open Log…", "Try the Demo", and the privacy line. |
| A2 | Parsing | P0 | A determinate bar under the toolbar title ("Parsing demo.log — 4.1M of 10M frames") with Cancel. The Overview fills in as the parse runs. |
| A3 | **Overview** | P0 | The default view after loading. **Stat tiles:** Duration, Frames, IDs, Buses, Error frames. **Charts:** bus load per bus over time. **"Decoding":** "9 of 11 IDs match your DBC", with a button "Reverse engineer the 2 unknown IDs". **ID table:** ID, Name, Bus, Count, Period, Jitter, DLC, Decoded ✓. |
| A4 | Trace | P0 | The hero mockup. Two toggles: **Chronological** (every frame) and **By ID** (one live-updating row per ID, like cabana or SavvyCAN). |
| A5 | **Plot** | P0 | **Sidebar:** a signal tree by message, with search and checkboxes. **Content:** 3–6 stacked plots on a shared time axis. Two cursors with Δt and Δvalue readouts, markers you can name, and a time range bar with an overview minimap. |
| A6 | **Reverse Engineer** | P0 | Main content order: **Pinned references**, **Byte values**, **Bit Activity** with a time-window scrubber, then scrolling **Bit history**. Pin known signals from other messages or buses for synchronized comparison while investigating the selected ID. Drag across bits to define a signal. **Inspector:** live candidate, start bit, length, Intel/Motorola, Signed, factor, offset, name, unit, optional overlay on a compatible pinned reference, and "Add to Database". Content-header actions: "Ignore Baseline…" and "Find Signal…". |
| A7 | Find Signal sheet | P1 | A sentence-style rule builder: "Find a signal that [increases ▾] between [12.0 s] and [18.5 s] and [stays constant ▾] between [20 s] and [25 s]". Results are ranked candidates, each with a sparkline, a match score and "Show". |
| A8 | Ignore Baseline sheet | P1 | "Pick a quiet period (nothing pressed, nothing moving). Bits that change there will be dimmed." It shows a time range picker over the bus load chart. |
| A9 | **Database** (DBC editor) | P0 | **Content:** a message header (name, ID, DLC, sender, cycle time); a signal table (name, start, length, byte order, signed, factor, offset, min, max, unit); a colour-coded 8×8 layout grid for the message. **Inspector:** the selected signal's properties and value table editor ("0 = Off, 1 = On"). **Toolbar:** "New Message", "Export DBC…". Changes re-decode immediately. |
| A10 | Filter popover | P0 | ID or name, bus, data pattern (`xx 0C ?? ?? …`), direction and time range. Active filters show as removable tokens in the search field. |
| A11 | Export sheet | P0 | **What:** decoded signals as CSV, the filtered log as candump, the database as DBC, or the plot as PNG/SVG. **Range:** All, Visible or Selection. For CSV, the signals and a resample rate. |
| A12 | Command palette (⌘K) | P1 | A glass popover with results grouped as IDs · Signals · Commands, each command showing its shortcut. |
| A13 | Settings sheet | P1 | **Appearance:** System, Light or Dark. **Time:** absolute or relative to the start. **ID format:** `0x0C9` or `0C9`. **Numbers:** decimal separator. **Plots:** line width. A **Keyboard Shortcuts** tab. |
| A14 | Connect adapter (Web Serial) | P1 | A taste of live capture. The sheet reads "Connect a CAN Adapter": adapter (CANable / SLCAN), bitrate, and a Chromium-only note. Then a live trace with a red "Recording" pill, frames/s, bus load and Stop. |
| A15 | Pro feature sheet | P1 | Shown only when someone clicks a Pro-only action, such as "Auto-label counters and checksums". It has one sentence, a small image, "Learn About FreeCAN Studio Pro" and "Not Now". Rules: never a timed nag, never blocking a free feature, and never calling Pro "free". |
| A16 | Errors | P0 | **Inline banner** for skipped lines (see the design brief). **Unsupported file:** "This looks like a PDF, not a CAN log. FreeCAN Studio opens candump, ASC, BLF, TRC, MF4, CSV." **DBC mismatch:** "None of the 42 messages in this DBC appear in the log. Check the bus or ID format." **Browser too old:** needs WebAssembly and module workers. **File too big for the browser:** says honestly what the limit is, and mentions Pro. |
| A17 | Small screen | P2 | Phone width: "FreeCAN Studio needs a desktop browser". Phones are out of scope, so there is no phone layout behind it. |
| A18 | About | P2 | Version, build, credits, and a link to third-party licences. |

## Marketing site (freecan.studio)

| # | Page | Pri | What's on it |
|---|---|---|---|
| M1 | **Home** | P0 | **Hero:** a big product screenshot, the headline "The CAN log viewer that lives in your browser.", a subhead of the tagline, "Open FreeCAN Studio" (primary) and "Try the Demo". **Sections:** "Files never leave your computer"; format logos; three feature rows (Decode with DBC · Plot anything · Reverse engineer unknown messages); a Pro teaser; the footer. |
| M2 | **Pro and pricing** | P0 | Free vs Pro comparison. The Free column is complete and says so ("Free forever. No account."). Pro lists live capture, transmit and replay, UDS scanning, video sync, auto-labels, multi-GB files, scripting and more formats. Buttons: "Buy Pro" and "Download". Checkout and the customer portal are hosted by the payment provider (Paddle or Lemon Squeezy, which also handle VAT), so we don't build them. |
| M3 | Download | P1 | macOS, Windows and Linux buttons (the user's platform is detected), system requirements, and a link to release notes. |
| M4 | **SEO landing template** | P0 | One template, about 8 pages: BLF viewer online, MF4 viewer online, ASC/TRC viewer, DBC viewer and editor online, CAN bus reverse engineering, J1939 decoder, CANalyzer alternative, SavvyCAN alternative. Each has an H1 matching the search term, a **live drop zone** that opens the app in place, a how-to section in 3 steps, an FAQ and links to the other pages. Keep them same-origin as the app, so a dropped `File` object isn't lost across a page navigation. |
| M5 | Docs | P1 | Getting started, supported formats, working with DBCs, the reverse-engineering guide, keyboard shortcuts. Uses the same sidebar layout as the app. |
| M6 | Changelog | P1 | Dated entries with small screenshots. |
| M7 | Legal | P0 | Privacy (short, because nothing is collected), Terms, the Pro EULA, and **third-party licences** (the MIT and Apache licences we use require attribution). |
| M8 | 404 | P2 | Friendly, with a link to open the app. |

## Pro desktop (FreeCAN Studio Pro)

All the web app screens, plus:

| # | Screen | Pri | What's on it |
|---|---|---|---|
| P1 | Welcome window | P0 | A small window like Xcode's: the app icon, "FreeCAN Studio Pro", and actions (Open Log…, Start Live Capture…, Try the Demo). On the right, a list of recent files with size and date. |
| P2 | License | P0 | **Sheet:** "Enter your license key" or "Buy Pro…". **Preferences › License:** status, seat, and "Manage Subscription" (opens the payment provider's portal). |
| P3 | **Live capture** | P0 | **Setup sheet:** a list of interfaces (PCAN, Kvaser, Vector, SocketCAN, gs_usb, SLCAN) with a status dot, plus bitrate or FD data rate and listen-only mode. **Workspace:** the normal views with a red Recording pill and live bus load, plus Pause, Stop, "Save Capture…". |
| P4 | Transmit and replay | P1 | **A transmit list:** ID, data, period, enabled toggle and Send. **A replay bar:** a log, playback speed, loop, and a filter of which IDs to replay. **Safety:** the first transmit opens a confirmation sheet ("You are about to send frames on can0 at 500 kbit/s. Only do this on a bench or a vehicle you're allowed to modify.") with a checkbox to remember. |
| P5 | UDS / ISO-TP scanner | P2 | ECU discovery results in a table (address, response, services), with a detail inspector. |
| P6 | Video sync | P2 | A video panel docked above the plots, locked to the shared cursor. Drag to align offsets. |
| P7 | Auto-discovery | P1 | Results for one ID or the whole log: a list of suggested signals labelled Counter, Checksum/CRC, Constant, Correlates with vehicle speed (r = 0.98). Each one can be accepted into the Database or dismissed. |
| P8 | Compare logs | P2 | Two logs side by side: IDs present in only one log, period changes, bit-activity differences. |
| P9 | Scripting | P2 | A console pane with an editor and output; later a CLI. |
| P10 | Preferences window | P0 | Native tabs: General, Interfaces, Appearance, License, Updates. |
| P11 | Update available | P1 | A sheet with version, release notes, "Install and Relaunch" and "Later". |

## Mockups to generate next

These cover the navigation model and every distinct layout:

1. A3 Overview
2. A6 Reverse Engineer
3. A9 Database
4. A5 Plot
5. M1 Home
6. M2 Pro and pricing
7. P1 Welcome window and P3 Live capture setup (one image)
8. A7 Find Signal sheet

Screens not listed reuse these layouts.

## Image prompts

The corrected source of truth is [mockup-style.txt](mockup-style.txt), with measured demo data in [mockup-data.json](mockup-data.json). The current design rules override old image references. Attach each screen's earlier mockup for layout only; do not inherit its colors, text, statistics, or supported-format claims.

The eight self-contained generation prompts include the same canonical style block:

| Screen | Prompt |
|---|---|
| Overview | [Prompt](freecan-workshop-overview-v2-generation-prompt.txt) |
| Reverse Engineer | [Prompt](freecan-workshop-reverse-engineer-v3-generation-prompt.txt) |
| Database | [Prompt](freecan-workshop-database-generation-prompt.txt) |
| Plot | [Prompt](freecan-workshop-plot-generation-prompt.txt) |
| Home | [Prompt](freecan-workshop-home-generation-prompt.txt) |
| Pro and pricing | [Prompt](freecan-workshop-pricing-generation-prompt.txt) |
| Pro welcome and live capture | [Prompt](freecan-workshop-pro-welcome-live-capture-generation-prompt.txt) |
| Find Signal | [Prompt](freecan-workshop-find-signal-generation-prompt.txt) |

### Decisions applied after mockup review

- No tagline. Marketing uses “Free. No account.” Pro format and size promises remain undecided and are omitted.
- The shipped demo has 1,000,000 frames, 55,165,145 bytes, 1,814.872973 seconds, 11 IDs, and nine DBC matches. Values come from the log rather than the 10M-frame benchmark.
- Bus load, jitter, and error-frame counts remain in Overview as clearly Planned placeholders, without invented readings.
- Current parsing supports candump; DBC is a signal database. Other log formats are marked Planned.
- Drag-to-define, DBC editing/export, Find Signal, and Pro workflows are proposed screen designs, not assertions of released functionality.
- Plot uses the demo's WheelSpeedFL instead of the nonexistent Brake Pressure signal. DBC identifiers retain their exact names.
- Both Twisted F terminals stay Amber, matching the current Logo component. This does not declare a new vector master.

### Reverse Engineer reference pinning — planned interaction

The [v3 mockup](freecan-workshop-reverse-engineer-v3-mockup.png) adds reference signals without changing the selected message.

- **Pin signal…** opens a searchable signal picker across the loaded database and buses. Each result identifies signal name, message ID, bus, and unit. Already pinned signals are marked; pinning does not navigate away from the unknown message.
- Pinned signals remain visible when selecting another message or changing the time window within the same log. Each row shows its source, unit, current value, trace, and a remove action.
- References, byte plots, candidate preview, and bit history share the analysis window and cursor. Different-unit references use separate y-scales; values keep their original units.
- An explicitly enabled **Overlay on VehicleSpeed** control draws the candidate as a dashed Graphite trace on the compatible reference's scale. The candidate and reference retain separate names and values. Offer overlays only for compatible units; do not silently normalize unlike units.
- **Byte values** sits directly above **Bit Activity**. The reference card precedes both; Bit history follows the activity grid.
- Pins belong to the loaded log. Changing the selected ID preserves them; opening a different log clears unavailable references. No cross-session persistence is promised by this mockup.
- The displayed examples pin VehicleSpeed from 3E9 on can0 and EngineSpeed from 0C9 on can0. This is a proposed interaction, not an implemented feature.
