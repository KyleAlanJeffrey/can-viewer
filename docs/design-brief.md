# FreeCAN Studio: Design Brief

> **Superseded for colour, type and brand by [DESIGN.md](../DESIGN.md)** (the approved "Workshop" direction: amber and graphite, IBM Plex, light only). The blue palette, Inter, glass and dark-mode guidance below are historical. The layout, interaction and state guidance still applies where DESIGN.md is silent.

This brief makes the app feel friendly and Apple-like by following Apple's Human Interface Guidelines as of 2026: Liquid Glass (macOS 26), as refined for macOS 27. It covers the free web app and the desktop Pro app, which share one design. The full screen inventory, with a prompt per screen, is in [screens.md](screens.md).

## Principles

- **Content first, chrome defers.** Only navigation and controls (toolbar, sidebar, popovers) sit on translucent Liquid Glass. The trace table, plots, heatmap and inspector are opaque and crisp. Glass never sits on glass.
- **The standard Mac layout:** sidebar -> content -> inspector. Each pane keeps its selection highlighted, and each hidden pane can be brought back from the toolbar, a menu and a shortcut.
- **Friendly means calm and forgiving,** not cute:
  - Plain verbs ("Open Log...", "Try the Demo").
  - No "Oops".
  - Undo is always available.
  - Springy but restrained motion.
  - Rounded shapes whose corners nest concentrically.
- **Direct manipulation:**
  - Drag across bits to define a signal.
  - Drag across or scroll over a plot to zoom it.
  - Hover to read values, but never hide essential values behind hover.
- **Honest feedback:**
  - A determinate progress bar that names the task.
  - Inline errors next to the problem.
  - Alerts only for problems the user can act on.

## Layout (1440 x 900 reference)

| Region | Spec |
|---|---|
| Toolbar | 52px tall, on glass. Leading: sidebar toggle, then the document title "demo.log" with subtitle "10,000,000 frames - 5 h 2 min" (the status lives here, not in a bottom bar). Centre: search field "Filter IDs and signals". Trailing: "Open DBC..." (borderless icon + label), "Open Log..." (the only tinted, prominent button: blue capsule), inspector toggle. |
| Sidebar | 240px, full height and edge to edge (macOS 27 style), on glass. Top: small app mark + "FreeCAN Studio". Groups: "can0 - 10 IDs", "can1 - 1 ID". Rows 32px: accent-coloured waveform icon, hex ID in monospace, message name in secondary text, period ("10 ms") right-aligned in tertiary text. Selected row: blue rounded-rect fill, white semibold text. IDs missing from the DBC show "Unknown" plus a small orange dot. |
| Content, top | Trace table, opaque white. 28px pinned header, 24px rows, alternating #FFFFFF / #F4F5F5. Columns: Time - Bus - ID - Name - Len - Data. Hex bytes use a monospace font with tabular figures. Bytes that changed since the previous frame sit on a soft blue tinted rounded chip. |
| Content, bottom | Plots in a rounded (12px) opaque card: three stacked single-signal charts on one time axis, left edges aligned, about four light gridlines, Y labels on the trailing side. The scrub line is 30% gray and sits behind the data, with an annotation bubble kept inside the plot ("12.340 s - 2,140 rpm"). |
| Inspector | 270px, opaque. Header: "0C9 ENGINE_1" (15px semibold) and "can0 - every 10 ms - 8 bytes" (secondary). Section **Bit Activity**: an 8 x 8 grid of 4px-rounded squares shaded pale to deep blue by change rate, bit numbers 7...0 across the top and byte numbers down the side; each DBC signal has a rounded outline in its plot colour; legend "Rarely -> Every frame". Section **Signals**: rows with a colour dot, name, unit, DBC layout in tertiary monospace (`0\|16@1+`), and a Plot checkbox. A bordered button: "Define Signal from Selection". |

## Tokens

**Type**
- **UI font:** system stack `-apple-system, BlinkMacSystemFont, "Inter Variable", Inter, "Segoe UI", sans-serif`. SF appears on Macs without us shipping it.
- **Monospace:** `ui-monospace, "JetBrains Mono", Menlo, Consolas, monospace`.
- **Sizes:**
  - Body 13/16, Callout 12/15, Subheadline 11/14.
  - Headline 13/16 bold; Title 3 15/20 semibold; Title 1 22/26.
  - Minimum 10px.
- **Weights:** no Light weights.

**Colour (light / dark)**

| Role | Light | Dark |
|---|---|---|
| Window background | #F5F5F7 | #161617 |
| Content surface | #FFFFFF | #1E1E1E |
| Alternate row | #F4F5F5 | rgba(255,255,255,.05) |
| Primary label | rgba(0,0,0,.85) | rgba(255,255,255,.85) |
| Secondary label (text) | rgba(0,0,0,.60)[1] | rgba(255,255,255,.55) |
| Tertiary label | rgba(0,0,0,.35) | rgba(255,255,255,.25) |
| Separator | rgba(0,0,0,.10) | rgba(255,255,255,.10) |
| Accent / selection | #0088FF (fills), #0064E1 (selected row) | #0091FF, #0059D1 |
| Link / blue text | #0068DA | #419CFF |
| Plot series | Blue #0088FF, Orange #FF8D28, Green #34C759, Indigo #6155F5, Pink #FF2D55 | Blue #0091FF, Orange #FF9230, Green #30D158, Indigo #6D7CFF, Pink #FF375F |
| Changed-byte chip | rgba(0,136,255,.14) | rgba(0,145,255,.28) |
| Warning / unknown | Orange #FF8D28, always with a label | #FF9230 |

[1] Apple's 50% secondary label is 3.95:1 on white, below WCAG's 4.5:1 minimum, so we darken it for text.

System blue, green and orange are too light for text on white. Use them for fills and chart lines only. Blue text uses the link colour.

**Shape and depth**
- **Corners:** window/card 12px; controls 6-8px, or a capsule for large buttons; heatmap cells 4px. Nested corners are concentric: inner radius = outer radius - padding.
- **Shadows:** only on floating glass (toolbar, popovers), soft and wide: `0 8px 24px rgba(0,0,0,.08)`. None on content.
- **Glass:** `backdrop-filter: blur(24px) saturate(180%)` over a tinted translucent fill, on the toolbar and sidebar only.

**Motion**
- Springs over about 0.5s with a bounce of 0.15.
- Row selection is not animated.
- With Reduce Motion, use fades instead.

## States

- **First run:** centred in the content area:
  - A soft rounded-square icon (a document with a waveform).
  - Title "Open a CAN log to get started".
  - Body "Drop a candump, ASC, BLF, TRC, MF4 or CSV file here. Add a DBC to decode signals."
  - A row of format chips.
  - Buttons "Open Log..." (primary) and "Try the Demo".
  - A lock icon with "Files are processed on your computer and never uploaded."
- **Dragging a file over the window:** the drop zone gets a 2px blue rounded outline and a faint blue tint. They appear only while dragging.
- **Parsing:** a thin determinate bar under the toolbar title, "Parsing demo.log - 4.1M of 10M frames", and a Cancel button. Rows stream in as they parse.
- **Errors:** an inline banner above the table with a plain explanation, such as "1,204 lines weren't CAN frames and were skipped. Show lines".

## Don'ts (these make it look like a cheap knock-off)

- Fake traffic lights in the web app. Real ones appear only in the macOS desktop build.
- Shipping SF fonts or SF Symbols. Their licences limit them to apps on Apple platforms. Use Lucide or Phosphor icons at a matching stroke weight instead.
- Glass on content.
- Neon or heavy gradients.
- Pure-black dark mode.
- Heavy drop shadows.
- A bounce on every hover.
- Hamburger menus.
- 44px mobile rows or 17px body text.
- The hand cursor on buttons.
- Modal pop-ups for information.
- Missing focus rings.

## Image-generation prompts

### Hero: workspace, light mode
> A high-resolution product screenshot of a desktop web app called "FreeCAN Studio", shown in a clean Safari browser window at 16:10. The design follows Apple's macOS 27 Human Interface Guidelines with Liquid Glass. The toolbar and a full-height left sidebar are translucent frosted glass with a subtle blur and a soft shadow. The main content areas are opaque, crisp white.
>
> The toolbar shows a sidebar toggle, the document title "demo.log" with a small gray subtitle "10,000,000 frames - 5 h 2 min", a centred rounded search field, a borderless "Open DBC..." button, and one blue capsule "Open Log..." button.
>
> The left sidebar lists CAN message IDs under group headings "can0 - 10 IDs" and "can1 - 1 ID". Each row has a small blue waveform icon, a monospaced hex ID like "0C9", a gray message name like "ENGINE_1", and a light-gray period like "10 ms". The row "0C9 ENGINE_1" is selected with a rounded blue highlight and white text. One row reads "123 Unknown" with a small orange dot.
>
> The centre shows a dense data table with a pinned header "Time - Bus - ID - Name - Len - Data", 24px rows with very subtle alternating stripes, and monospaced hex bytes like "AF 0C 00 3C 00 00 00 F7". A few bytes have soft light-blue rounded highlight chips.
>
> Below the table, a rounded white card holds three stacked line charts on a shared time axis: "Engine Speed (rpm)" in blue, "Steering Angle (deg)" in orange, "Vehicle Speed (km/h)" in green. Each has thin 2px lines, a few faint gridlines, a thin vertical gray scrub line, and a small value bubble "12.340 s - 2,140 rpm".
>
> A right inspector panel shows "0C9 ENGINE_1", a heading "Bit Activity" above an 8 by 8 grid of small rounded squares shaded from pale to deep blue, with coloured rounded outlines grouping bits into signals, and a "Signals" list with coloured dots, names and checkboxes.
>
> Typography is the San Francisco-style system font, 13px body, generous but efficient spacing, 1px hairline separators, 12px concentric rounded corners, calm and friendly, precise, premium.
>
> No neon, no heavy gradients, no skeuomorphism, no clutter.

### Variant: dark mode
> Same layout and content as the hero, in macOS dark mode. The window background is near-black charcoal (#161617, not pure black) and the content surfaces are #1E1E1E. The glass toolbar and sidebar are smoky and translucent. The text is soft white, with brighter system blue, orange and green accents. The heatmap shades from deep navy to pale blue.

### Variant: first run and empty state
> The same FreeCAN Studio window with an empty sidebar and inspector. The centre shows a friendly, spacious empty state: a soft rounded-square icon of a document with a waveform, the title "Open a CAN log to get started", a gray line "Drop a candump, ASC, BLF, TRC, MF4 or CSV file here. Add a DBC to decode signals.", a row of small rounded format chips (candump, ASC, BLF, TRC, MF4, CSV, DBC), a blue capsule "Open Log..." button next to a bordered "Try the Demo" button, and small print with a lock icon: "Files are processed on your computer and never uploaded." The drop area has a faint 2px blue rounded dashed outline, as if a file is being dragged over it. Apple macOS 27 style, calm, lots of whitespace.

### Variant: reverse-engineering close-up
> A close-up crop of the FreeCAN Studio inspector panel in Apple macOS style. Under the heading "Bit Activity" for message "123 Unknown" sits an 8 by 8 grid of rounded squares: the top row is a counter pattern whose shading brightens from left to right; rows 3-4 are mid-blue; row 5 is empty gray; row 7 is uniformly bright, like noise. The user is dragging a translucent blue selection across rows 3-4. A small glass popover beside it says "New signal - 16 bits - Motorola" with a "Plot" button and a live mini sparkline. Crisp, friendly, precise.
