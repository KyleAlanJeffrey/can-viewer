# Mockup prompts for the medium features

Prompts for mockups of the next medium-sized features. Each says what must be on the page and which states to show; layout and visual design are left to the mockup. All four use the existing FreeCAN Studio "Workshop" light style (see [DESIGN.md](../DESIGN.md)), and the example data comes from the demo log.

Every mockup keeps the shared constraints:

- One amber primary button per view.
- Light theme only, IBM Plex type.
- Everything works by keyboard, with a visible focus ring.
- Colour is never the only carrier of meaning.

## 1. Trace filters

Mockup of the FreeCAN Studio Trace view (a CAN frame table: Time, Bus, ID, Name, Len, Data columns) with a new filter capability, in the existing Workshop light style. Show the filter controls and the table responding to them.

Must include:

- Ways to filter by:
  - bus (can0, can1);
  - one or more message IDs or names;
  - a data pattern on specific bytes (example: "byte 2 = 1F", "byte 0 bit 3 is set", "any byte changes");
  - a time range (from 12.000 s to 18.500 s);
  - frame kind (data, remote, error, J1939 reassembled).
- The active filters visible at a glance as removable chips or a summary line, with a "Clear all".
- A live count: "2,481 of 1,000,000 frames match".
- In the table, matched bytes subtly highlighted, so you can see why a row matched.
- An empty state: "No frames match these filters", with a way to loosen them.
- A time range that can be set both by typing and by dragging on the existing time strip.

Show two states: filters being edited, and filters applied with results.

## 2. Video sync

Mockup of FreeCAN Studio with a video lined up against a CAN log, in the existing Workshop light style. Use case: a dashcam or a phone recording of the dashboard, played in step with the log's time cursor (cursor at 52.340 s).

Must include:

- A video panel next to one of the existing views. Show it beside Plot, with ENGINE_1.EngineSpeed and WHEEL_SPEEDS plotted. The panel has play/pause, a scrubber and the current video time.
- The shared time cursor: moving the cursor in the plot seeks the video, and playing the video moves the cursor.
- An alignment step, because the video and the log start at different times:
  - A small "Sync" flow: "Find a moment you can see in both (e.g. the brake light coming on), pause the video there, click the matching point in the log."
  - The resulting offset: "Video starts 3.2 s after the log", with a nudge control (+/- 0.1 s) and Reset.
- A note that the video stays on this computer and is never uploaded.
- States: no video loaded (a drop zone or an "Add video..." button), video loaded but not synced, and synced.
- A video panel that can be resized or popped to a smaller corner size.

## 3. Compare two logs

Mockup of a FreeCAN Studio "Compare" view, in the existing Workshop light style. Use case: a hobbyist records the car doing nothing, then records it with the doors locking, and wants to know which messages and bytes differ.

Must include:

- Two logs, named and labelled A and B ("idle.log", 30 s, and "door-lock.log", 28 s), with a way to swap them or replace one.
- A ranked list of message IDs by how differently they behave between A and B:
  - grouped as IDs only in A, only in B, and in both but with different bytes;
  - columns like ID, Name (if a DBC knows it), count or rate in A and in B;
  - a "difference" score with a short reason ("byte 3 takes new values", "appears only in B", "rate doubled").
- For the selected ID, a byte-level comparison: each byte's values or bit activity in A next to B, with the bytes and bits that differ clearly called out. Reuse the look of the existing Bit Activity grid if it fits.
- Optional ignore rules: "Ignore counters and checksums", and "Ignore IDs that also change within A alone".
- A path to act on a finding: "Open in Reverse Engineer" or "Add to Database" for the selected bits.
- States: picking the second log, results, and "these logs look the same".

## 4. Automated signal discovery

Mockup of the FreeCAN Studio Reverse Engineer view with a new "Suggested signals" panel, in the existing Workshop light style. The app has scanned the unknown messages and proposes likely signals.

Must include:

- For the selected unknown message (example: ID 123 on can0, 8 bytes), a ranked list of suggestions, each with:
  - kind: Counter, Checksum, Flag, Enum, Continuous value or Signed value;
  - location: "bits 16-31, Intel, unsigned";
  - a confidence ("High", or 94%);
  - a sparkline of its values over the log;
  - a one-line reason ("increments by 1 each frame and wraps at 15", "matches CRC-8 SAE J1850 over bytes 0-6").
- The suggestions drawn on the existing 8x8 bit grid as outlined regions. Hovering a suggestion highlights its bits, and hovering the bits highlights the suggestion.
- Actions per suggestion: Accept (goes into the existing Add to Database flow, with a name to fill in), Dismiss, and Plot it.
- An overview across all unknown IDs: "37 suggestions across 9 unknown messages", so you can jump to the most promising one.
- Optional hints the user can give:
  - event markers ("I pressed the brake at 12 s") that boost matching bits;
  - a known reference signal to fit a scale ("compare with WHEEL_SPEEDS.FrontLeft").
- States: scanning ("Scanning 9 messages..."), suggestions ready, nothing found for this message, and a suggestion already accepted.
- Copy that makes clear these are guesses to check, not facts.
