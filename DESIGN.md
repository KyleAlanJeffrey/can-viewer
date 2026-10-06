---
name: FreeCAN Studio
description: A warm, precise, light workbench for reading and reverse-engineering CAN bus logs.
colors:
  workshop-amber: "#FFB547"
  amber-hover: "#F7A93A"
  amber-pressed: "#EC9C28"
  deep-ochre: "#8E5707"
  ochre-control: "#A56612"
  selected-sidebar: "#FCE3B1"
  selected-row: "#FFF3DA"
  changed-byte: "#FCE7C0"
  changed-byte-selected: "#F8DA9E"
  warm-white: "#F4F0E7"
  paper: "#FFFFFF"
  plot-paper: "#FAF9F6"
  alt-row: "#FAF8F4"
  graphite: "#20242B"
  slate: "#62666D"
  hairline: "#E0DDD6"
  gridline: "#ECE9E2"
  scrubber: "#8A8D93"
  unset-cell: "#F3F1EC"
  rust: "#C2410C"
  error: "#A61B1B"
  hover-wash: "rgba(32, 36, 43, 0.05)"
  press-wash: "rgba(32, 36, 43, 0.09)"
  scrim: "rgba(32, 36, 43, 0.24)"
  series-1-deep-ochre: "#A56612"
  series-2-workshop-blue: "#2C6CB8"
  series-3-bench-green: "#16875F"
  series-4-plum: "#8F4AA6"
  series-5-olive: "#6B7A12"
  series-6-harbour-cyan: "#0A7FA3"
  tint-1: "#F1E7D9"
  tint-2: "#DDE7F4"
  tint-3: "#DAECE5"
  tint-4: "#EDE2F1"
  tint-5: "#E7EAD9"
  tint-6: "#D8EBF0"
  heat-1: "#E8A844"
  heat-2: "#D08B26"
  heat-3: "#B0700E"
  heat-4: "#8E5707"
  heat-5: "#6B4005"
  heat-6: "#4A2C03"
typography:
  wordmark:
    fontFamily: "IBM Plex Sans, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "20px"
    fontWeight: 600
    lineHeight: "24px"
    letterSpacing: "-0.01em"
  empty-title:
    fontFamily: "IBM Plex Sans, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "22px"
    fontWeight: 600
    lineHeight: "28px"
    letterSpacing: "-0.01em"
  pane-title:
    fontFamily: "IBM Plex Sans, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "17px"
    fontWeight: 600
    lineHeight: "22px"
  section-title:
    fontFamily: "IBM Plex Sans, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: "20px"
  readout:
    fontFamily: "IBM Plex Sans, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: "20px"
    fontFeature: "tnum"
  lede:
    fontFamily: "IBM Plex Sans, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: "20px"
  body:
    fontFamily: "IBM Plex Sans, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: "18px"
  label:
    fontFamily: "IBM Plex Sans, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: "16px"
  caption:
    fontFamily: "IBM Plex Sans, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: "14px"
  data-table:
    fontFamily: "IBM Plex Mono, ui-monospace, Menlo, Consolas, monospace"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: "24px"
    fontFeature: "tnum"
  data:
    fontFamily: "IBM Plex Mono, ui-monospace, Menlo, Consolas, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: "16px"
rounded:
  xs: "4px"
  sm: "6px"
  md: "8px"
  lg: "12px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  xxl: "32px"
components:
  button-primary:
    backgroundColor: "{colors.workshop-amber}"
    textColor: "{colors.graphite}"
    rounded: "{rounded.md}"
    padding: "0 16px"
    height: "32px"
  button-primary-hover:
    backgroundColor: "{colors.amber-hover}"
    textColor: "{colors.graphite}"
  button-primary-pressed:
    backgroundColor: "{colors.amber-pressed}"
    textColor: "{colors.graphite}"
  button-secondary:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.deep-ochre}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "32px"
  button-secondary-hover:
    backgroundColor: "{colors.selected-row}"
    textColor: "{colors.deep-ochre}"
  button-toolbar:
    textColor: "{colors.graphite}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "32px"
  button-toolbar-hover:
    backgroundColor: "{colors.hover-wash}"
  button-icon:
    textColor: "{colors.slate}"
    rounded: "{rounded.md}"
    size: "32px"
  search-field:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.graphite}"
    rounded: "{rounded.md}"
    padding: "0 10px"
    height: "32px"
  sidebar-row:
    textColor: "{colors.graphite}"
    rounded: "{rounded.md}"
    padding: "0 10px"
    height: "34px"
  sidebar-row-selected:
    backgroundColor: "{colors.selected-sidebar}"
    textColor: "{colors.graphite}"
  trace-row:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.graphite}"
    typography: "{typography.data-table}"
    height: "24px"
  trace-row-selected:
    backgroundColor: "{colors.selected-row}"
  plot-card:
    backgroundColor: "{colors.plot-paper}"
    rounded: "{rounded.lg}"
    padding: "8px 16px 12px"
  signal-row:
    textColor: "{colors.graphite}"
    rounded: "{rounded.md}"
    padding: "6px 8px"
    height: "36px"
  tag:
    textColor: "{colors.slate}"
    rounded: "{rounded.xs}"
    padding: "0 4px"
  tooltip:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.graphite}"
    rounded: "{rounded.md}"
    padding: "8px 10px"
  plot-callout:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.graphite}"
    rounded: "{rounded.sm}"
    padding: "3px 8px"
  segmented-selected:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.graphite}"
    rounded: "{rounded.sm}"
    padding: "0 12px"
    height: "28px"
  input-field:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.graphite}"
    rounded: "{rounded.md}"
    padding: "0 10px"
    height: "32px"
  sheet:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.graphite}"
    rounded: "{rounded.lg}"
    padding: "24px"
---

# Design System: FreeCAN Studio

![Workshop Light brand sheet: Twisted F, IBM Plex typography, brand palette, data colors, and interface examples](docs/freecan-workshop-brand-guide-v2.png)

[Open the full-size brand sheet](docs/freecan-workshop-brand-guide-v2.png) - [Browse all eight screen mockups](docs/screens.md#approved-workshop-light-mockups)

This file records the system as shipped in the web workspace (`web/src/styles.css` holds every token as a custom property; the canvas views read them with `cssVar`). The frontmatter is normative. The approved comp is [docs/freecan-workshop-light-mockup.png](docs/freecan-workshop-light-mockup.png), chosen as "03 / Workshop" from [docs/freecan-twisted-f-color-type-options.png](docs/freecan-twisted-f-color-type-options.png). Where the comp and the build differ, the build and the corrections below are the record. Earlier blue, teal and dark concepts in `docs/` are explorations, not the brand.

## Overview

**Creative North Star: "The Well-Lit Workbench"**

FreeCAN Studio feels like a clean engineering bench under warm light: tools laid out in order, nothing decorative, everything within reach. The warmth comes from the Warm White ground and a single amber accent, not from ornament. The precision comes from mono type for machine data, hairline structure and dense, even rows. It is technical and confident, but approachable enough for a hobbyist opening their first log.

The workspace is dense on purpose: engineers read thousands of rows and several plots at once. That density stays calm through restraint. There is one accent colour and one filled button per view. All data sits on opaque white, and the chrome is quiet Warm White. Amber marks where you act and what you have selected; everything else is Graphite, Slate and white.

This is a **light-only** system by the owner's decision. There is no dark mode and no dark panel inside the light UI. The earlier blue direction in [docs/design-brief.md](docs/design-brief.md) is superseded for colour and type; its interaction and state guidance still applies where this file is silent.

**Key Characteristics:**
- Warm White (#F4F0E7) chrome for the sidebar and frame; Paper White for every data surface.
- Workshop Amber fills exactly one button; selection is a pale amber tint, never solid amber.
- Graphite ink, Slate secondary text, and no text grey lighter than Slate.
- IBM Plex Sans for what people wrote, IBM Plex Mono for what the bus produced, self-hosted.
- Dense rows (24px trace, 34px sidebar), 1px hairlines, 12px cards, 8px controls.
- A fixed, colour-blind-validated six-hue series palette and a six-step amber-to-umber heat ramp.

## Colors

Warm neutrals, one amber accent with its ochre inks, and two separately validated data palettes.

### Primary
- **Workshop Amber** (`workshop-amber`): fills the single primary button of each view or sheet, with Graphite text (8.9:1). It is also the front strand and both terminals of the Twisted F, and, at 22% alpha, the drag-to-zoom selection band in plots. Never text, never a thin line on white (1.8:1).
- **Amber Hover / Amber Pressed** (`amber-hover`, `amber-pressed`): the primary button's hover and active fills. Text stays Graphite.
- **Deep Ochre** (`deep-ochre`): amber's ink. Secondary-button text and text buttons such as Reset Zoom and Clear (6.0:1 on white).
- **Ochre Control** (`ochre-control`): the focus ring, checked checkbox accent, the selected sidebar row's icon, the search field's focus border, the text caret, the drop-zone border, the load progress bar, the active option of a keyboard-driven list (in place of the focus ring its field keeps) and the outline of a payload byte a trace filter matched.

### Selection tints
- **Selected Sidebar** (`selected-sidebar`): the selected ID row, with Graphite text. Also the text-selection highlight.
- **Selected Row** (`selected-row`): the selected trace-table row, paler than the sidebar so the dense table stays readable. Also the secondary button's hover.
- **Changed Byte** (`changed-byte`): a 4px-rounded chip behind a hex byte that differs from the previous frame of the same ID. On a selected row it steps up to **Changed Byte on Selection** (`changed-byte-selected`).

### Neutral
- **Warm White** (`warm-white`): sidebar and window ground. Chrome only, never behind data.
- **Paper White** (`paper`): toolbar band, trace table, inspector, tooltips, callouts, search field and secondary buttons.
- **Plot Paper** (`plot-paper`): the plot card only.
- **Alternate Row** (`alt-row`): every other trace row.
- **Graphite** (`graphite`): primary text, the mark's ink, pressed toolbar toggles.
- **Slate** (`slate`): secondary text (subtitles, units, periods, counts, table headers, axis labels, placeholders) and resting icons. 5.8:1 on white, 5.1:1 on Warm White.
- **Hairline** (`hairline`): every 1px border and pane divider.
- **Gridline** (`gridline`): plot gridlines, lighter than Hairline so data dominates.
- **Scrubber** (`scrubber`): the 1px vertical time cursor through all plots.
- **Unset Cell** (`unset-cell`): bit-grid cells that never changed.
- **Hover Wash / Press Wash** (`hover-wash`, `press-wash`): translucent Graphite washes for hover and press on quiet controls (toolbar buttons, icon buttons, rows, group headers).
- **Scrim** (`scrim`): behind the floating sidebar or inspector in narrower windows.

### Status
- **Rust** (`rust`): the only status hue in the build. A 7px dot beside the word "Unknown" for IDs not in the loaded DBC, the warning icon in banners, and "ERR" for error frames in the table. Always paired with a word.
- **Error** (`error`): invalid form fields (border, ring and the message under the field) and error status words. Always with a word.
- **OK, Matched, Decoded:** a Graphite check plus the word. Connected is a filled Graphite dot; not connected is a Slate ring. Status is never green, and never borrows a series colour.

### Data: the series palette (fixed order)
Signals take `series-1` to `series-6` in order: Deep Ochre, Workshop Blue, Bench Green, Plum, Olive, Harbour Cyan. A colour follows its signal everywhere: plot line, plot-head dot, inspector dot, bit-grid outline, cursor point. The order passed the dataviz validator on Paper and Plot Paper (lightness band, chroma floor, adjacent-pair CVD separation, normal-vision floor, 3:1 contrast). Past six signals, stack or group; never generate a seventh hue.

### Data: layout tints
`tint-1` to `tint-6` are the series colours at 16% on white, in the same order. A signal's bit region in a layout grid is filled with its tint, outlined 2px in its series colour, and labelled in Graphite. Use `seriesTint(color)` from `web/src/views/shared/colors.ts` to get a series colour's tint. Plots never get area fills.

### Data: the bit-activity ramp (sequential)
`heat-1` to `heat-6`, light to dark, from "rarely" to "every frame", binned on a log scale of change count. Bits that never change use Unset Cell, so the ramp covers only real activity. It passed the ordinal checks (one hue, monotone lightness, visible steps, at least 2:1 at the light end). The finish review suggested ending darker (around #8C5506); the owner declined because the brand guide adopts this ramp. Keep it.

**Deliberate corrections to the comp** (WCAG AA), all honoured by the build:
- **Heat ramp:** the comp's cream-to-ochre steps were indistinguishable at the light end (1.17:1 on white); the ramp above replaces them.
- **Series:** the comp's blue #397BA6 and teal #24836E were too close (delta E 10.2); Workshop Blue and Bench Green replace them.
- **Unknown dot:** the comp's orange dot was 2.6:1; Rust replaces it.
- **Plot marks:** lines carry no sample markers; a point appears only at the cursor. Y labels stay on the right. A NaN or infinite value (a float signal's) breaks the line, and a value alone between such breaks shows as a dot. The value axis fits the finite values, and readouts show the value as decoded: "NaN", or the infinity sign.
- **Outline buttons:** the comp's orange borders become Hairline on Paper White with Deep Ochre text, 8px corners, 32px tall.

### Named Rules
**The Lamp, Not Floodlight Rule.** Amber covers less than 5% of any screen: the one primary button, selection tints, the mark. If a second element wants filled amber, it does not get it. Selected states use tints, never solid amber.

**The Amber Is Never Ink Rule.** Text is Graphite, Slate or Deep Ochre, never Workshop Amber. Text on an amber fill is Graphite, never white.

**The Text Wears Ink Rule.** Readouts, axis labels, legend and signal names are Graphite or Slate. The series colour lives in the line, the dot and the outline beside the text, never in the text.

## Typography

**UI Font:** IBM Plex Sans (with system-ui, -apple-system, Segoe UI, sans-serif)
**Data Font:** IBM Plex Mono (with ui-monospace, Menlo, Consolas, monospace)

**Character:** Plex is precise and human, an engineering face with clearly differentiated numerals, which matters where 0/O and 1/l mistakes cost hours. Both faces are self-hosted through `@fontsource` (Sans 400/500/600, Mono 400/600, Latin subset); nothing loads from a font CDN.

### Hierarchy
- **Empty title** (600, 22px/28px, -0.01em): the one headline in the app, "Open a CAN log to get started".
- **Wordmark** (20px/24px, -0.01em): "FreeCAN" at 600 plus "Studio" at 400, beside the mark.
- **Pane title** (600, 17px/22px): the inspector header, e.g. "0C9 ENGINE_1"; the ID is Plex Mono 600 at the same size.
- **Section title / Document title** (600, 15px/20px): "Bit Activity", "Signals", and "demo.log" in the toolbar.
- **Readout** (600, 15px/20px, tabular): live plot values, e.g. "4,471.5 rpm", in Graphite.
- **Lede** (400, 14px/20px, Slate): the empty-state explanation.
- **Body** (400, 13px/18px): all interface text, sidebar names, the toolbar subtitle (Slate), buttons (500; the primary is 600), plot names (500).
- **Label** (500, 12px/16px): trace-table headers in Slate; 400 at 12px for the Sort by row, plot range text, legends, tooltips and the callout.
- **Caption** (400, 11px/14px): plot axis ticks and bit/byte indices; 500 for the FD tag. Never smaller than 11px.
- **Data** (Plex Mono 400, 13px on 24px rows in the trace table; 12px/16px elsewhere): timestamps, IDs, hex bytes, DLC and DBC layout strings such as `0|16@1+`.

Weights are 400, 500 and 600 only. There is no light weight and no 700.

### Named Rules
**The Mono Means Machine Rule.** If the bus or a DBC produced it (IDs, hex bytes, timestamps, bit layouts), set it in Plex Mono. If a person wrote it (labels, units, sentences), set it in Plex Sans. DBC message and signal names are mono in the trace table and sans in the sidebar and inspector.

**The Tabular Rule.** Every number that updates or lines up in a column uses tabular figures: periods, readouts, the callout, table data.

## Layout

Three panes in a full-height grid on a 1440 x 900 reference.

- **Sidebar** (`clamp(240px, 19vw, 300px)`, Warm White, hairline right border):
  - A 60px brand row: the Twisted F at 40px tall and the 20px wordmark, 10px apart. No tagline.
  - The search field, "Filter IDs and signals", 32px tall, inset 12px. Search lives here, not in the toolbar.
  - A "Sort by" select row (12px Slate) and an "All frames" row with the total count.
  - Collapsible bus groups ("can0", then the ID count in Slate) with 12px above each header.
  - 34px ID rows inset 8px from the pane edges, 10px gaps: activity icon, mono ID, name, period right-aligned in Slate. The ID column is sized per bus group to its 11-bit IDs; a 29-bit ID or one with an FD tag gets its own auto-width column on that row.
- **Toolbar** (Paper White, hairline bottom border, 12px gaps), spanning content and inspector. With a log or DBC open it has two rows, so the log's name and status are never crushed: a 56px row with the document and its actions, then a 40px row of view tabs. Only when everything fits on one 60px row with room to spare (a toolbar of about 1500px: a wide window, or the sidebar hidden), and never while recording, do the tabs sit centred in the one row. `web/src/components/toolbarLayout.ts` decides, from the toolbar's width and the button widths measured in Chrome. The tabs stay the same element as they move between rows, so a focused tab keeps focus; on one row they come after the actions in tab order.
  - Leading: sidebar toggle, a 28px hairline divider, the document title over its Slate status subtitle (log format, frames, duration, DBC; progress text while busy).
  - Views: tabs (Overview / Trace / Plot / Reverse Engineer / Compare / Database), Slate 500 text, the selected one Graphite 600 with a 2px Ochre Control underline on the toolbar's bottom edge, as the Reverse Engineer mode tabs. It is still a radio group with arrow-key navigation (`Segmented`). Views that need a log are disabled until one is open; Database opens with a DBC alone.
  - Trailing: Open DBC... (quiet), Export Log... (quiet, disabled until a log is open and hidden while capturing; it opens a sheet to pick the format), Save Capture... (quiet, only while a capture is open), Connect live... (quiet; it opens the Live Capture sheet), Open Log..., then the More menu (a 32px icon button with a vertical ellipsis, "More actions"). Open Log is amber unless the view has its own primary, then it is an outline button.
  - The More menu holds Close <log> (under a hairline when other items are above it) and every quiet action the toolbar has no room for. As the toolbar narrows they move into it one by one with their labels, the least needed first: Connect live..., Export Log..., Open DBC..., Save Capture.... They never go icon-only. Paper White, Hairline, 8px corners, the Float shadow, 4px padding, 32px items with a 16px Slate icon and Hover Wash. Arrow keys, Home and End move through the items; a disabled item (while busy, say) stays focusable and is announced as unavailable (`aria-disabled`), dimmed to 45%, and does nothing. Escape, from an item or the button, closes it and returns focus to the button; a click elsewhere closes it, and so does its last item going. Close <log> carries the full name as a tooltip, as a long one is cut short.
  - There is no inspector toggle in the toolbar: views with an inspector put a Details toggle in their own header (see Inspector).
  - While a log is read, a Cancel outline button (an X and "Cancel", named "Cancel reading <log>") sits before Open Log... and stops the read. The log shown until then is read again from its saved copy, as after a reload, with its view, selection and plots, and the status reads "Reopening <log>..." meanwhile; with no saved copy (one too large to keep, an unsaved capture), or when the read was itself reopening a log, no log is left open. Focus stays on Cancel, which now cancels the reopen, or goes to Open Log... when nothing is reopened, as it does when Cancel goes away with focus because the read ended. A log that fails to open puts the log shown before back the same way, with its error still shown. Only when a reopen itself fails is no log left open and the saved copies forgotten, so a bad copy isn't tried again. Open Log... stays enabled during the read: opening another log, or the demo, reads it in place of the first. Close, Open DBC..., Export Log... and Connect live... stay disabled, as for any task. A read that has reached its last stage (sorting, or for MF4 the parsing itself) can't stop until it ends, so "Stopping the read..." or "Cancelling..." may show for a while, with Open Log... disabled.
  - While capturing, Stop Capture takes the place of Save Capture and Connect live and takes the amber (outline when the view has its own primary). Export Log and Open Log, which can't be used then, are hidden, and the views keep a row of their own, so the status line gets the first row. The subtitle reads "Recording" in Error with a 7px Error dot, then in Slate, most important first as the end may be cut off: any errors, "Listen only" (only when the adapter confirmed it), the frame count, the elapsed time as a stopwatch (`1:23`) and the rate. Its tooltip has the whole status: bus name, adapter (and channel), bitrate (and CAN FD data bitrate), listen-only state, the window of a rolling capture and the last error.
  - The Capture sheet (Live Capture) holds, top to bottom: Adapter type (a segmented control, only when the browser reaches both kinds), the adapter chosen with Choose Adapter..., Bitrate with CAN FD data bitrate beside it ("Off (classic CAN)" by default; the two selects wrap when narrow), Bus name (a mono text field, `can0` by default, suggesting the buses the DBCs are set to; an invalid name turns the field and its hint Error) with Keep beside it ("Every frame", or "Last 1 min" to "Last 60 min" for a rolling capture, whose hint then says older frames are dropped) the Listen only switch, and a closed Advanced disclosure (a 12px Slate summary): for gs_usb a Channel select (1 to 8), for slcan Serial speed and Bit timing (BTR0 BTR1, a mono field, "Off" when empty; while set, the Bitrate select is disabled and the hint gives the rate it works out). Start Capture is the amber button.
  - An unsaved capture's subtitle starts with "Not saved", and a capture's leaves out the format, which its name already says.
  - An unsaved capture comes back after a reload, a crashed tab or a restarted browser the way a saved log does: without asking, as the log shown, with the view, selection and plots it had, still "Not saved", with Save Capture... and the discard prompt. Meanwhile the status reads "Restoring <capture>... 42%" over the progress bar, with no Cancel. It isn't offered with a "Restore unsaved capture from <time>?" question: the app never asks before reopening the last session, Close and then Discard Capture undo it in two clicks, and a question left unanswered would leave the capture in limbo. A restore that fails says so in the error banner: "The unsaved capture <capture> couldn't be restored: <why>. Reload the page to try again.", or, when its stored frames are damaged, "...couldn't be restored, so it was deleted: <why>". The saved log, if any, then opens instead. A reload or close during a restore doesn't count against it, but after two restores that failed or crashed the page it isn't restored without asking: a banner reads "<capture> couldn't be restored after 2 tries." with "<why>." (or "The page stopped while restoring it.") and "It's still kept in this browser, unsaved." in its detail line, outline Try Again and Delete... buttons and a Dismiss X, while the saved log opens as usual. Dismiss hides it for the session only; the tab keeps holding the capture, so no other tab restores it meanwhile, and the next load asks again. Try Again restores it in place of the open log (asking first, as for any log, if that is an unsaved capture). Delete... asks first, as discarding an unsaved capture does: a "Delete the capture?" sheet ("<capture> hasn't been saved, and once deleted it can't be restored.") with Cancel and Delete Capture, both outline as in the discard sheet, and no primary, so a slip of Return deletes nothing; focus starts on Cancel. The app never deletes a capture just because it failed to restore.
  - About 340px stays for the sidebar toggle and the log's name and status before any action moves into the More menu; with the default sidebar, all of them fit down to about a 1280px window.
  - View actions never go in the toolbar; they sit in the view's content header.
  - There is no bottom status bar.
  - A 2px Ochre Control progress bar sits on the toolbar's bottom edge while loading.
- **Content** (fluid): each view renders here, and fills the sidebar and inspector through portals (`SidebarSlot`, `InspectorSlot` in `web/src/views/slots.tsx`). Views live in `web/src/views/<view>/`, each with its own stylesheet and class prefix (`ov-`, `pv-`, `re-`, `cmp-`, `db-`).
  - **Content header** (60px minimum, hairline bottom border): a contextual title at 20/26 600 (the selected ID or message, never the view's own name, which the switcher already shows), a Slate subtitle, and the view's actions on the right. When the actions don't fit beside the title they wrap onto a line of their own (8px apart), then onto more lines; they never run under the inspector or out of reach.
  - **Trace:** the trace table fills the space; the plot card sits below it, at most 52% of the height, inset 12px top and 16px sides and bottom, only while something is plotted (there is no empty placeholder). The filter bar ends with the Details toggle.
  - **Overview:** fact tiles (unique IDs, buses, error frames, DBC coverage), an estimated bus load card (its legend gives each bus's average load "at" a compact bitrate select, 500 kbit/s until set, or a capture's own bitrate), and a sortable ID table. No inspector, no primary.
  - **Plot:** a signal tree with checkboxes in the sidebar, stacked lanes on one time axis with A/B cursors, markers, a readout table and a full-log minimap. No inspector. Until a signal is plotted the view is an empty state: a 32px Slate chart icon, "Choose signals to plot" (17/22 600), a Slate lede ("Pick signals from your DBC to compare them over time."), Choose Signals as the view's primary (it shows the sidebar if hidden and moves focus to the signal tree; Open DBC... instead when no loaded DBC describes a message in the log, and then the signal tree only says why it is empty, without a second Open DBC... button), and Add video... (outline) under it. Open Log is an outline button meanwhile; once something is plotted the view has no primary. Add video... docks a video panel on the right (Paper White, a hairline resize handle) or floats it in the corner (12px corners, the Float shadow). Its status reads as a Graphite check with "Synced" or a Slate ring with "Not synced"; its buttons are outline buttons, so Open Log stays the view's one amber button.
  - **Reverse Engineer:** two modes under Byte Values / Advanced tabs with the Ochre Control underline. **Byte Values** (default, no inspector): Pinned references (decoded signals in their series colours, raw bytes in Graphite on a fixed 0 to 255 scale, one shared time axis with separate y-scales) with the analysis window fields at the card's foot; with nothing pinned the card is a single row, "Pin a signal for comparison" with Pin signal..., over the analysis window. Then a matrix of every message with a Graphite sparkline per byte, B0 to B7 per row (a 188px message column, at least 58px per byte) and CAN FD byte groups under View all. The selected byte has a 2px Ochre Control outline and constant bytes dim under Changing bytes only. Only once a message, a byte or a suggestion's bytes are selected does a sticky footer, at most 57px, name the selection ("123 - Byte 2", or just "123" for a message, mono 17px 600), give a byte's value at the parked cursor ("Value at 52.343 s: 2D (45)"), and hold Pin byte (for a byte), Open in Advanced and a Clear selection X. Clearing deselects the message too and hands focus to the byte's cell or the message's row, or to the matrix card when a filter has taken that row out. A collapsible Suggested signals panel (360px by default, 300 to 560px with its resize grip, which also takes the arrow keys, Home and End; Paper White, hairline left border, its own scroll; never so wide that the matrix needs to scroll sideways) sits to the right of the matrix below the mode tabs; the Suggested signals switch in the content header, which carries the count, hides and restores it. Below a 1028px content width (about a 1280px window with the sidebar open) it stacks under the matrix instead, at 40% of the height and at least 280px, with its title and hide chevron, message and scope on one line and the caution beside the scan overview so the first card shows. Resizing never goes past the width the panel can actually take. Selecting a card outlines each byte it covers in its message row with a 2px Deep Ochre border and the card's number in a small Paper badge, scrolls the first of them into view clear of the footer, and the footer then names the bits ("0C9 - Byte 6 - bits 51-54", middle dots in the build), adding "Its row is filtered out of the table." when a filter hides that row. Hiding the panel returns focus to its switch. **Advanced:** the message heading, Pinned references (the candidate as a dashed Graphite trace, on its own row or over a pinned signal of the same unit), the message's byte strip, the bit activity grid with drag-to-select and the time-window strip, then bit history; the New Signal form in the inspector, with Add to Database as the primary, and the Details toggle in the content header. With no message selected the inspector collapses. A hover cursor runs through every plot and sparkline; a click parks it and Escape clears it. Pin signal and Find Signal open as sheets.
  - **Compare:** the open log is A and a second log is B. The content header holds a card per log (name, duration, Replace...) with Swap between them; before B is chosen its card is an Ochre Control dashed drop zone, "Choose a second log", with Open log B... as the primary. The sidebar names both logs and filters the table (All / In both / Only in A / Only in B, as radios with counts). The body is two cards: the message comparison table, grouped In both - different bytes / Only in B / Only in A / In both - no significant differences / Too few frames to compare under collapsible group heads, with the ignore rules as checkboxes at its foot; and the selected ID's detail, with bit grids for A and B side by side (differing bits get the dashed Graphite outline on a Paper halo, and are listed in text below), the selected byte over time (B solid in Deep Ochre, A dashed Graphite), and every byte's A and B values at the cursor (a changed byte has a dashed Graphite border and a "Changed" label, never colour alone). Open in Reverse Engineer is the primary, with Export findings... beside it. Below 1280px the cards stack. When nothing differs, one card says "These logs look the same", with Review ignore rules... and Replace log B... as the primary. No inspector. While a capture runs the view only says it can compare the capture once it stops; starting one drops log B. A stopped capture can be log A, but Swap stays disabled for it, with a tooltip saying to save it and open the saved file.
  - **Database:** a message list in the sidebar, the message form, the signal table and the layout grid; the signal editor in the inspector, with Export DBC... as the primary and the Details toggle after it. With no signal to edit the inspector collapses.
- **Trace table:** 28px header, 24px rows, 12px cell padding. Columns are Time (120), Bus (72), ID (96), Name (156), Len (56), Data (fills, at least 248px for eight bytes). When narrow, Name, then Bus, then Len drop first.
- **Inspector** (`clamp(288px, 22vw, 360px)`, Paper White, hairline left border): a header (16px padding) with the pane title and a Slate line ("can0 - every 10 ms - 8 bytes" in content; the build separates with a middle dot), then Bit Activity and Signals sections (20px top padding, 16px sides, hairline between them).
  - An inspector with nothing to show collapses and gives its room back: Trace with All frames, Advanced with no message, Database with no signal. There is no "select something" pane.
  - The view's Details toggle (a quiet toolbar-style button with the panel icon and "Details", `aria-pressed`, Hover Wash while pressed) shows and hides it; it is disabled, with a tooltip saying what to select, while the inspector is collapsed. Shown or hidden carries across views.
- **Spacing:** a 4px base; steps of 4, 8, 12, 16, 24 and 32, plus 10px gaps inside dense rows. Pane padding is 16px.
- **Narrower windows (1240px and below):** the inspector (up to 360px, below the toolbar however many rows it has) floats as an overlay over a Scrim instead of squeezing the content, so view headers and tables keep their room. It starts closed at these widths, opens with the view's Details toggle and closes on a tap outside or Escape. At 900px and below the sidebar (up to 300px) floats the same way. The breakpoints are in `web/src/styles.css` and `web/src/App.tsx`, kept in step. Toolbar actions that don't fit are in the More menu. Phones are out of scope; there is no phone layout.

## Elevation & Depth

The workspace is flat and tonal. Depth comes from the step between Warm White chrome and white data, plus hairlines. Toolbar and sidebar are opaque; there is no frosted glass. One shadow exists, and only on layers that float above content.

### Shadow Vocabulary
- **Float** (`box-shadow: 0 1px 2px rgba(32,36,43,.06), 0 8px 24px rgba(32,36,43,.10)`): bit-grid tooltips, the plot callout, the More menu, and the sidebar and inspector when they float in narrower windows.

### Named Rules
**The Opaque Data Rule.** Data (table, plots, bit grid, inspector values) always sits on an opaque, flat surface. No blur, translucency, gradient or shadow under a number. The one translucent layer is the transient file-drop overlay, which carries no data.

## Shapes

Corners are gentle; borders are hairline.

- **12px:** the plot card, the drop overlay.
- **8px:** buttons, icon buttons, the search field, sidebar rows, signal rows, banners, tooltips, the More menu.
- **6px:** the plot callout, small icon buttons, text buttons, group headers, the sort select, menu items; the bit-grid signal outline caps at 6px.
- **4px:** bit-grid cells (2px when rows are very short), changed-byte chips, the FD tag, legend swatches, the scrollbar thumb.
- **Circles:** only status dots (7px) and series dots (10px).

There are no capsule buttons and no pills.

- **Borders:** 1px Hairline.
- **Iconography:** Lucide, 16px with a 1.5px stroke (18px for the pane toggles; 14px for chevrons and the remove X). The ID row icon is `activity`: Slate at rest, Ochre Control when selected.

### The Twisted F
The mark is a twisted pair drawn as rope. Every front strand slopes "/", and the wire on top alternates at each crossing. Ribbons are 19% of the mark's height, the top arm is a block, and amber appears only on the front strand below the floating middle arm. Both round terminals are amber (pending owner confirmation). The gaps between strands are painted in the colour behind the mark, so the component takes a `background` (Warm White in the sidebar, Paper White in the empty state). It is 40px tall in the brand row and 64px in the empty state. Don't alter the silhouette.

## Components

### Buttons
Quiet by default, with one amber exception.
- **Shape:** gently rounded (8px), 32px tall.
- **Primary:** Workshop Amber with Graphite 600 text, 16px side padding. Exactly one per view or sheet: Open Log... by default, or the view's own action (Add to Database, Export DBC...), which demotes Open Log to an outline button. A sheet's primary is the only one in its layer.
- **Secondary (outline):** Paper White, 1px Hairline, Deep Ochre 500 text, 12px padding; hover Selected Row, press Changed Byte. Never an orange border. Used for "Try the demo log" in the empty state.
- **Toolbar / icon:** no fill; Hover Wash on hover, Press Wash on press. Icon buttons are 32px square (24px small), Slate, Graphite when pressed.
- **Text button:** Deep Ochre 500 at 12px, 6px corners, Hover Wash (Reset Zoom, Clear).
- **Focus:** a 2px Ochre Control outline offset 2px on everything; the canvas table insets it by 2px.
- **Disabled:** 45% opacity.

### Inputs / Fields
- **Search:** Paper White, Hairline border, 8px corners, 32px tall, a 16px Slate search icon, Slate placeholder. Focus turns the border Ochre Control with a 1px ring of the same colour.
- **Checkbox:** native, 16px, `accent-color` Ochre Control. Where a checkbox stands for a series, a separate round series dot sits beside it; the checkbox itself is never series coloured.
- **Text and number fields** (`.input`, `.select`): Paper White, Hairline, 8px corners, 32px tall, 10px padding; mono for identifiers and numbers. Focus is an Ochre Control border plus 1px ring. Invalid fields get `aria-invalid` with an Error border and ring, and a 12px Error message under the field (`.field-error`). Labels are 12px Slate above the field (`.field-label`).
- **Switch** (`.switch` on a checkbox with `role="switch"`): 32 x 18, Hairline track, Ochre Control when on.

### Segmented Control
`web/src/components/Segmented.tsx`, a radio group with arrow-key navigation. The track is Unset Cell with a Hairline ring and 2px padding. The selected segment is Paper White, Graphite 600, with a subtle shadow (`0 1px 2px rgba(32,36,43,.06)` plus a Hairline ring) and a 2px Ochre Control underline. Unselected segments are Slate 500. Never an amber fill or amber underline. Used for Intel / Motorola, 1 cursor / 2 cursors and the Find Signal scope; `.small` makes 24px segments. The toolbar's view switcher is the same component drawn as tabs (see Toolbar).

### Sheet
`web/src/components/Sheet.tsx`, a native modal `dialog` (Escape, focus trap and inert background come from the browser). Paper White, Hairline, 12px corners, the Float shadow, Scrim backdrop, 24px padding. The title is 20/26 at 600, never 700, with a Slate description under it. The footer has a hairline top border with Cancel (outline) and then the sheet's one primary.

### Navigation (sidebar ID list)
- **Rows:** 34px, Graphite name, mono ID, Slate period. Hover is Hover Wash; selected is Selected Sidebar with an Ochre Control icon.
- **Unknown IDs:** the name reads "Unknown" in Slate with a Rust dot.
- **FD tag:** 11px/14px 500 Slate text in a Hairline box with 4px corners.

### Trace Table (signature, canvas)
Virtualised and canvas-drawn for 10M+ frames, with a custom 10px scrollbar (Graphite at 20%, 34% when hovered or dragged). Rows alternate Paper White and Alternate Row; the selected row is Selected Row. Changed bytes get a Changed Byte chip. Error frames show "ERR" in Rust.

### Plot Card (signature, uPlot)
- **Card:** Plot Paper, Hairline, 12px, max 52% of the content height. A 24px bar holds the Slate range text ("Showing 33.2 s of 30 min 15 s") and the Reset Zoom and Clear buttons.
- **Charts:** 96px charts stacked on one shared time axis, x-axis once at the bottom. Each chart has a 28px head: a 10px series dot, a 500 name with a Slate unit, and a readout on the right. Lines are 1.5px in the series colour with no sample markers. Gridlines are Gridline; ticks and labels are 11px Slate, with Y labels on the right.
- **X ticks:** whole minutes when ticks are 60 s or more apart; otherwise seconds at the step's precision.
- **Scrubber:**
  - Click (pointer moves less than 3px) to pin a time. A 1px Scrubber line and 7px cursor points (series fill, 2px Paper ring) park across every chart.
  - The readouts follow the pin. A Paper callout with the Float shadow ("t s - value unit"; the build uses a middle dot) sits on the top chart.
  - The nearest trace row is selected and scrolled into view; clicking a trace row moves the pin.
  - Escape unpins and hovering shows the live cursor.
  - A drag of 3px or more zooms (amber band at 22%), the wheel zooms or pans, and double-click resets.

### Bit Activity Grid (signature, canvas)
- **Grid:** 8 columns (bits 7 to 0) by one row per byte, with 11px Slate indices. Cells are rounded and filled from the heat ramp, or Unset Cell for bits that never changed.
- **Signal outlines:** each DBC signal's bit range gets a rounded outline in its series colour, 2px, or 3px while its signal row is hovered. The outline sits on a Paper White halo 4px wider than the stroke, so the ochre series 1 stays readable against ochre cells.
- **Legend:** "Rarely -> Every frame" in 12px Slate, with an Unset Cell swatch and six 14px ramp swatches.
- **Tooltip:** hover shows a Paper tooltip with the Float shadow.
- **Suggested regions** (Reverse Engineer Advanced): each suggested signal gets a solid 1.5px Slate outline on a Paper halo with its number in a small Paper badge at its top-left cell, matching the number in the Suggested signals list. Hovering or focusing it, on the grid or in the list, draws it 3px Graphite with the badge inverted, so the link never relies on colour. Signals on different pages of a multiplexed message share bits, so only the first of them is outlined; the list holds them all. The dashed selection draws on top.
- **Selection** (Reverse Engineer): dragging across cells selects a bit range, outlined as one shape by a 2px dashed Graphite line in the gutters, on a Paper halo. Arrow keys move a focus cell and Shift extends. In bit history, 1-bits are Graphite, 0-bits Unset Cell, and the selected bits sit on a pale amber band with a dashed bracket so the selection never relies on colour.

### Signals List
36px rows, inset by an 8px negative margin, with 8px corners and Hover Wash. Each row has a 10px series dot, the name at 500 with the unit in Slate, the mono 12px Slate layout (`0|16@1+`), and a Plot checkbox under a 12px Slate "Plot" column label. Defining a signal from a bit selection lives in Reverse Engineer, not here.

### Suggested Signals List
Beside the bit grid in Reverse Engineer Advanced, wrapping below it when narrow. Each suggestion is a Paper row with a Hairline border and 8px corners: a Graphite-outlined number badge, the kind at 600, the bits, byte order and any multiplexed page ("page m2") in 12px Slate, the confidence as a word and a percentage in Graphite (never a colour alone), a graphite sparkline and the reason. Its actions (Accept, Dismiss, Plot it) are outlined buttons; the view's one amber button stays Add to Database in the inspector. The hovered row takes a Graphite border; the selected one Selected Row. An accepted row swaps its actions for a Graphite check, "Accepted", Review in Database and Undo. The panel opens with "Suggestions are guesses. Check them against the log before accepting." While a live capture records, it holds only "Suggestions are made once the capture stops." The scan's progress bar is a plain Slate fill with no animation.

The same cards also fill the Suggested signals panel beside the Byte Values matrix: a 17px title with a Hide chevron, the selected message (mono ID, name or Unknown, bus) over "N suggestions - from M frames", a Selected message / All messages segmented control, the caution, the scan overview, then the cards. All messages groups the cards under a heading per message, most promising first; the heading selects that message. The selected card has a Deep Ochre border and the view's one amber button, its Accept, with "Highlights Byte N in the table." under its actions. The cards take a 2px Ochre Control focus ring around the whole card; Up and Down move between them and Enter selects. Plot it pins the decoded candidate in Pinned references; Accept carries the suggestion and a suggested name into Advanced's New Signal form, whose Add to Database finishes it; Accept, here or in Advanced, also opens the inspector if it was closed. A quiet footer reads "Plot it adds the candidate to pinned references." Hints stay in Advanced.

### Banner and Empty State
- **Banner:** Paper White, Hairline, 8px corners, with a Rust warning icon and a Slate detail line. When the browser can't keep an unsaved capture for a reload, one banner says so once, as for a log it couldn't keep: "This browser couldn't keep a copy of <capture>, so it won't reopen after a reload.", in the words of the log banner, then in the detail line why ("Its storage is full.", "The unsaved captures kept in this browser would need more than 512 MB.", "Its storage couldn't keep up with the capture." or "Its storage may be full or turned off.") and "Save Capture... keeps it in a file." While recording, screen readers hear its first sentence. The update banner ("A new version of FreeCAN Studio is ready", or "This tab is out of date. Reload to keep working." once another tab has moved to it, with an outline Reload button) is news, not a warning, so its icon is a Slate refresh icon.
- **Empty state:** centred, at most 440px wide. It holds the 64px mark on Paper, the empty title, a Slate lede, the secondary demo button, and a 12px Slate privacy line with a lock icon.
- **Drop overlay:** a 2px dashed Ochre Control border, 12px corners, inset 8px, over Selected Row at 72%.

### Cursor
The cursor shows what a press or drag will do.
- **Pointer:** anything a press activates: buttons, tabs, toggles, switch labels, clickable rows and cells.
- **Default:** disabled controls, including while the app is busy.
- **Text:** text fields.
- **Crosshair:** where a click places or parks a time cursor (plots, byte cells, reference plots) or selects bits.
- **Grab / grabbing:** a draggable window; **ew-resize** on its edges, held for the whole drag.
- **Progress:** everywhere else while the app is busy.

### Motion
Motion is minimal: 120ms ease-out background transitions on buttons. The progress bar animates `transform: scaleX` (120ms linear), never width.

## Do's and Don'ts

### Do:
- **Do** keep exactly one filled Workshop Amber button per view, with Graphite 600 text.
- **Do** put every table, plot, bit grid and inspector value on Paper White (#FFFFFF) or Plot Paper (#FAF9F6).
- **Do** use Plex Mono with tabular figures for IDs, hex, timestamps and bit layouts, and Plex Sans for human text.
- **Do** assign series colours in the fixed order (Deep Ochre, Workshop Blue, Bench Green, Plum, Olive, Harbour Cyan) and keep each colour on its signal across every view.
- **Do** put a Paper halo 4px wider than the stroke under any series outline drawn over heat cells.
- **Do** pair Rust with a word: a dot plus "Unknown", or "ERR".
- **Do** show focus with a 2px Ochre Control ring offset 2px on every interactive element.
- **Do** read canvas colours and fonts from the CSS custom properties so canvas and DOM stay in step.
- **Do** keep search at the top of the sidebar, the view tabs in the toolbar (their own row unless everything fits on one), and view actions, including the Details toggle, in the content header.
- **Do** collapse a pane, card or footer that has nothing to show yet, rather than filling it with a hint.
- **Do** animate progress and other continuous motion with transforms, not layout properties.
- **Do** re-run the dataviz validator whenever a series or ramp colour changes.

### Don't:
- **Don't** use Workshop Amber (#FFB547) for text, thin lines, icons on white, or status.
- **Don't** put white text on amber.
- **Don't** add a dark mode or dark panels; this system is light-only.
- **Don't** add graphite background panels, gradients, glass or heavy shadows to the workspace.
- **Don't** colour readout or label text with the series colour.
- **Don't** use a text grey lighter than Slate (#62666D), or type smaller than 11px.
- **Don't** draw sample markers on plot lines.
- **Don't** use capsule buttons or 44px touch-style rows in the desktop workspace.
- **Don't** alter the Twisted F silhouette, add a tagline under the wordmark, or use wire motifs as decoration inside the workspace.
- **Don't** load fonts, icons or scripts from third-party CDNs.
- **Don't** ship Apple's SF fonts or SF Symbols.

## Not yet built: marketing and Pro concept rules

The owner chose no tagline, "Free. No account.", the shipped 1M-frame demo, and no undecided Pro format or size claims. These rules apply to the marketing site and Pro concept screens, which are not built yet. The app rules above (status, outline buttons, segmented controls, toolbar slots, primary actions, tints, marks) were adopted from the same corrections and are now implemented.

- **Marketing type:** Plex Sans Display XL 600 at 56/60 (-0.02em); Display L 600 at 40/48; H2 600 at 28/36; Lead 400 at 20/30; Body 400 at 16/26; buttons 600 at 15px and 40px tall. No 700. Navigation's Open App is an outline button.

Exact mockup data is in [docs/mockup-data.json](docs/mockup-data.json), and the common generation style in [docs/mockup-style.txt](docs/mockup-style.txt). Generated PNGs are illustrative layouts, not exact sources for color tokens, font weights, bit activity, or calculated plot curves. Use the token definitions and data sheet when implementing. Signal colours follow the fixed series order per message (and the first free slot when plotting), so they can differ from the hand-picked colours in the mockups.
