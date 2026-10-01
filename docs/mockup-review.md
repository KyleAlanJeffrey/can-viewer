# Workshop mockup review

## Revision response — 2026-09-30

The owner selected no tagline, “Free. No account.”, the shipped 1M-frame demo, omission of undecided Pro format and size claims, and retention of uncomputed Overview statistics as explicitly Planned placeholders. Both Amber logo terminals were preserved to match the current component.

- Replaced the stale common block in all **eight** `*-generation-prompt.txt` files found in the repository. The separate brand-guide prompt is corrected too. The canonical style is [mockup-style.txt](mockup-style.txt); [screens.md](screens.md) now links these prompts rather than duplicating a stale block.
- Measured the shipped demo: 1,000,000 frames, 55,165,145 bytes, 1,814.872973 seconds. [mockup-data.json](mockup-data.json) records its checksum, ID counts, periods, lengths, and actual nearest cursor samples. The data includes the extended CCVS ID and 32-byte CAN FD RADAR_TRACKS.
- Generated new versions of all eight screens and the brand sheet; [the gallery](screens.md#approved-workshop-light-mockups) links the revised set. Original images remain available for comparison.
- Overview shows Planned bus load, error counts, and jitter with no invented readings. Database shows the five real ENGINE_1 signals, correct Counter bit placement, and an export reminder rather than automatic persistence. Plot uses WheelSpeedFL instead of nonexistent Brake Pressure, Graphite readouts, a full-log minimap, and cursor-only dots.
- Home distinguishes candump from planned formats and DBC databases. Pricing removes the duplicate comparison table and undecided exclusivity claims, uses neutral checks, and marks Pro capabilities as planned. Pro welcome uses the real demo file size and neutral connection status. Find Signal scores are explicitly illustrative.
- Removed invented slogans from the brand sheet and kept its revised version prominent in README and DESIGN. Updated PRODUCT with the owner's decisions. The implementation task refreshed DESIGN during this work; its shipped-state frontmatter and implementation record are preserved, with future mockup rules recorded separately.

**Remaining raster limitations:** generated images still have some color, weight, border and tiny-label drift; Plot's cursor labels can show spacing artifacts, and Home's embedded product preview is synthesized. Heatmap patterns, chart curves, and candidate scores are illustrations, not computed renderings of the JSON fixture. Use DESIGN's exact tokens, the canonical prompts, and the verified data for implementation; do not extract production colors or values from PNG pixels. This is not a pixel-perfect accessibility certification or a claim that proposed features have shipped.

The original review below is retained as the record of the earlier versions.

---

Reviewed 2026-09-30 against [DESIGN.md](../DESIGN.md), [PRODUCT.md](../PRODUCT.md) and [screens.md](screens.md). The hexes were sampled from the PNGs and are approximate. "S1"-"S10" refer to the systemic list.

## Verdict

The family reads as one product. Shell, Plex type, warm-white chrome, white data surfaces and the view switcher all hold. Find Signal, Overview v2 and Pro welcome are the strongest, with sound structure and local fixes. Plot, Database and Reverse Engineer need regenerating before anyone builds from them. They have off-palette series, coloured readouts, three amber fills and a false "Changes saved". Home and Pricing wait on owner copy decisions. Most colour drift comes from one stale preamble shared by every `docs/*-generation-prompt.txt`, so fix that first.

## Fix across all mockups

- **S1. Stale prompt preamble.** It lists the rejected palette (#397BA6, #24836E, iris #7160D8, rose #B45270), "#A56612 accent text", frosted translucency and "amber capsule" buttons. **Fix:** use the screens.md style block with all six series hexes, #8E5707 for text, Graphite readouts, no sample markers and a Rust Unknown dot.
- **S2. Series colour in text** (Text Wears Ink). This affects the Plot A/B readouts, RE "2,140" and "16 bits selected", and Find Signal "96%". **Fix:** Graphite or Slate text, with the dot carrying identity.
- **S3. Accent text drifts to rust**, around #9C4800-#A24200 instead of #8E5707. This affects the Overview CTA, "Try the Demo", "+ Add Signal" and "Search". Rust means Unknown. **Fix:** #8E5707.
- **S4. The Unknown dot is the uncorrected orange** (about #F66C06, 2.9:1) on every app screen. **Fix:** Rust #C2410C.
- **S5. Point markers on every sample.** The reference has them, so under "mockup wins" they would ship. **Fix:** the plot-marks rule.
- **S6. Green status reuses Bench Green** in Overview, Pricing and Pro. **Fix:** the status tokens.
- **S7. Amber overuse.**
  - RE has 3 fills, and Home and Pricing have 2 each.
  - The switcher underline, Pricing nav underline and Pro card rule are amber hairlines (about 2:1).
  - Accent-button borders are about #D8A260 (2.2:1).
  - **Fix:** the one-amber, segmented and accent-outline rules.
- **S8. Toolbar and search drift.**
  - Plot drops Open Log, Open DBC and the inspector toggle.
  - Database drops Open Log and Open DBC.
  - Overview drops the inspector toggle.
  - Search is a dropdown in Overview and a sidebar field elsewhere. DESIGN.md puts it in the toolbar centre, where the switcher now sits.
  - **Fix:** the toolbar slot rule.
- **S9. Off-scale type and axes.** Titles and marketing heads are about 28-64px at 700, and DESIGN.md has no 700. The Bus Load and Plot y labels sit left instead of right. **Fix:** the Sheet title token and the Persuade scale.
- **S10. Inconsistent fake data and unbacked claims.**
  - 10M frames over 5 h 2 min sit beside 0-30 s axes in RE, Plot and the bit history.
  - 123 is 15 ms in Overview and 100 ms elsewhere. Its "1,200,000 frames" fits only 15 ms.
  - 3E0 is 90 ms, 1 s, or DIAGNOSTICS, depending on the screen.
  - Signal names are prettified ("Engine Speed" for `EngineSpeed`).
  - No screen shows a 29-bit or CAN FD ID.
  - Jitter, bus load and error frames aren't computed. The core has count, mean period, min/max length and bit flips; the parser tags error frames but doesn't count them.
  - Our own `web/index.html` title "(DBC, BLF, MF4)" and its meta description overclaim the same way (not edited).
  - **Fix:** one data sheet from the real `demo.log`: 1,000,000 frames, 30 min 15 s and 55 MB. "9 of 11 IDs match your DBC" is true for it.

| ID (can0 unless noted) | Name | Period |
|---|---|---|
| 0C9 | ENGINE_1 | 10 ms |
| 123 | Unknown | 20 ms |
| 1F5 | WHEEL_SPEEDS | 20 ms |
| 2A0 | STEERING | 10 ms |
| 3E9 | VEHICLE_STATE | 50 ms |
| 450 | BODY | 100 ms |
| 456 | Unknown | 1 s |
| 5A0 | IMU | 10 ms |
| 6B0 | BATTERY | 100 ms |
| 18FEF100 | CCVS | 100 ms |
| 300 (can1) | RADAR_TRACKS, CAN FD, 32 bytes | 10 ms |

ENGINE_1 holds EngineSpeed `0|16@1+`, ThrottlePos `16|8@1+`, CoolantTemp `24|8@1+`, Counter `51|4@1+` and Checksum `56|8@1+`.

## Per mockup

### Reference (approved)
- Its sample markers and the light-orange border on "Define Signal from Selection" are uncorrected. Add both to DESIGN.md's "Deliberate corrections".

### Brand guide
- **Works:** the swatches and heat ramp match the validated hexes.
- It invents "Warm light. Precise tools." and "Clear signals. Clear decisions.". Its prompt asked for both while forbidding slogans.
- Both terminals are amber. `web/src/components/Logo.tsx` was redrawn to match: the rope-twist construction, with both terminals amber. Confirm, or pick a variant (see Decisions).

### Overview v2
- **Works:** the densest, most useful screen, and Decoded pairs a check with a dash.
- Jitter, Bus load and Error frames lack core support. Build them or cut them.
- The "Overview" title repeats the tab, and the Duration/Frames tiles repeat the subtitle. Drop both.
- Swap the "All IDs" dropdown for the sidebar search, and add the inspector toggle.
- Restore v1's "Processed on your computer" footer and its Matched/Unknown words.

### Reverse Engineer
- **Works:** the layout. Start 16, length 16, Intel correctly maps to bytes 2-3.
- **Three fills:** the Intel segment follows the segmented rule, and Open Log goes bordered.
- The bit-history cells are blue (about #4884AE), which is in no ramp. Use Graphite for 1-bits, Unset Cell for 0-bits, and the Selected Row tint for the selection.
- The selection outline (about #FC8A12) sits at 1.2:1 on the amber cells. Use a 2px dashed Graphite outline in the gutter, since ochre would collide with series 1.
- Make the vertical legend horizontal.
- Bit-history rows are 1 ms apart for a 20-100 ms ID.

### Find Signal
- **Works:** the sentence rule builder, one fill in the active layer, and an honest footer.
- Set "123 - bits 16-31" in Mono.
- The candidate sparklines use series colours. Use one neutral ink.
- The selected row has an amber border. Use the tint only.
- The dimmed inspector draws ENGINE_1's signal outlines on "123 Unknown".

### Plot
- **Works:** the shared axis, the A/B cursors with delta, a named marker and the minimap.
- Throttle (about #5A3CE4) and Brake (about #C02466) should be Plum #8F4AA6 and Olive #6B7A12.
- Each signal has a coloured checkbox, square swatch and line in three shades. Use an Ochre Control checkbox and a round dot.
- Rename "Single | Dual" to "1 cursor | 2 cursors".
- The minimap reads "Visible 0.0-30.0 s", but it highlights about 12-15 s on a 0-30 s axis under "Full log: 5 h 2 min". It should span the whole log.

### Database
- **Works:** the header, signal table and layout-grid structure.
- **"Changes saved" is false.** Show "Edited - Export DBC... to keep changes", and keep `demo.log` as the document title.
- **Layout fills:**
  - The EngineSpeed fill (about #F6D89C) is the sidebar selection tint.
  - The dots aren't series hexes (#F09612 is 2.3:1, and the teal #00AE8A is 2.8:1).
  - **Fix:** the series-tint rule.
- The selected table row should be #FFF3DA, not the sidebar tint.
- Show "0x0C9" as "0C9".
- 280 BODY_STATUS is missing from the list.

### Home
- **Works:** the hierarchy, the privacy band and the Pro teaser.
- The format strip lists five unsupported formats plus DBC, which isn't a log. Show candump now, and mark the rest as planned.
- The nav "Open App" should be bordered, and the hero (about 64px at 700) should use Display XL.
- "Free forever." is an owner decision. The subhead fills the tagline slot.

### Pricing
- **Works:** the "[price]" placeholder, the FAQ, and the "complete free viewer" line.
- The comparison table repeats the cards and drops four Pro items. Cut it.
- "Multi-GB files" and "more formats" as Pro clash with Home and PRODUCT.md. Owner decision.

### Pro welcome
- **Works:** the P1 layout, Listen only on by default, Ochre Control radios, and dots paired with words.
- Remove the invented "Your CAN workspace" (it came from the prompt).
- "(DBC, BLF, ASC, ...)" lists DBC as a log.
- The window titles should say "FreeCAN Studio Pro".
- `demo.log` shows 1.2 GB; the real file is 55 MB.
- The ochre terminals are a third logo variant.

## Proposed DESIGN.md additions

Contrast is given on #FFFFFF / #F4F0E7.

**Status tokens.**

| Token | Value | Contrast | Use |
|---|---|---|---|
| Rust (existing) | #C2410C | 5.18 / 4.55 | Unknown, warnings |
| Error | #A61B1B | 7.52 / 6.61 | Errors and the Pro Recording dot, with an icon and a word |
| OK | no hue | n/a | A Graphite check plus a word. Connected is a filled Graphite dot; Not connected is a Slate ring. |

Error stays separable from Rust: OKLab delta E is 9.1 for normal vision, 8.9 deutan and 10.0 protan. Green fails as an OK colour, because #2E7D32 and #1F7A3A fall within delta E 5.5 of Bench Green.

**Accent outline button.**
- 32px tall, with an 8px radius, a white fill, a Hairline border and #8E5707 text at 500.
- Contrast is 6.0:1, then 5.4:1 on the #FFF3DA hover and 4.9:1 on the #FCE7C0 press.
- One per pane. It is the shipped `.button` in `web/src/styles.css`.

**Segmented control.**
- The selected segment has a white fill, a `0 1px 2px rgba(32,36,43,.06)` shadow, Graphite 600 text and a 2px Ochre Control bottom bar (4.66:1).
- Unselected segments use Slate 500 (5.07:1).
- Never use an amber fill or line.

**Toolbar slots.**
- **Leading:** the sidebar toggle and the log title.
- **Centre:** the switcher.
- **Trailing:** Open DBC..., Open Log..., then the inspector toggle (disabled when the view has no inspector).
- View actions go in the content header, and search goes at the top of the sidebar.

**One amber, refined.**
- A view gets at most one fill. Open Log... is filled only where a view has no primary of its own.
- Selected states never use the fill.
- A sheet's primary replaces the window's.
- Marketing gets one filled CTA per viewport.

**Persuade scale (marketing only, Plex Sans).**

| Style | Weight | Size/line height | Notes |
|---|---|---|---|
| Display XL | 600 | 56/60 | -0.02em |
| Display L | 600 | 40/48 | |
| H2 | 600 | 28/36 | |
| Lead | 400 | 20/30 | Slate |
| Body | 400 | 16/26 | |
| Buttons | 600 | 15px | 40px tall |

There is still no 700. The app gets a **Sheet title** at 600 20/26.

**Series tint.**
- Fills are the series colour at 16% on white: #F1E7D9, #DDE7F4, #DAECE5, #EDE2F1, #E7EAD9, #D8EBF0.
- Each fill has a 2px series outline (3.7-4.5:1) and a Graphite label (12.4:1 or better).
- Selection uses the Ochre Control ring. Plots never use tints.

**Plot marks.**
- Lines only, with a dot at the cursor.
- Sample dots appear only when samples are 8px or more apart.
- Y labels go on the right.

## Decisions for the owner

1. **Tagline.** Three mockups invent one. Ship without one until you approve one?
2. **Logo terminals.** The app now ships amber and amber, per the brand guide. The alternatives are amber and graphite (the earlier build) or ochre (Pro welcome). Confirm before the vector master.
3. **"Free forever".** Approve it, or use "Free. No account."
4. **Pro positioning.** Are the planned formats free or Pro? What's the web size limit in numbers? Does "Download" run without a licence?
5. **Demo data.** Use the shipped 1M-frame demo, or the 10M-frame benchmark?
6. **Overview stats.** Build jitter, bus load and error-frame counting in the core, or drop them from v1?
