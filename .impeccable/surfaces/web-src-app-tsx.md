---
version: 1
slug: "web-src-app-tsx"
primary_target: "web/src/App.tsx"
related_targets: ["web/src/styles.css","web/src/components"]
---

# Surface: Workspace (web app)

**Mode:** Operate.

**Scope:** the main app window after a log loads. Toolbar, ID sidebar, trace table, stacked plots, inspector with Bit Activity and Signals. The later Overview, Plot, Reverse Engineer and Database views ([docs/screens.md](../../docs/screens.md)) inherit this surface's world and anatomy.

**Audience and job:** engineers first, hobbyists welcome. Open a large log, see what's on the bus, decode with a DBC, and find or define signals.

**Task:** scan dense rows, select an ID, read its bit activity, plot its signals, scrub through time.

**Constraints:**
- 10M+ frames: everything is virtualised or canvas-drawn.
- Light only.
- WCAG 2.2 AA.
- No third-party requests.

**Chosen direction:** "The Well-Lit Workbench" (Workshop). The approved comp is `docs/freecan-workshop-light-mockup.png`. Match its composition and density; the colour corrections recorded in DESIGN.md take precedence over the comp's pixels.

**Memorable moment:** selecting an ID lights up its bit grid in amber-to-ochre, with each DBC signal outlined in its plot colour. Then scrubbing the plots moves one cursor through every chart at once.

**Unresolved:**
- Vector master for the Twisted F mark.
- Error and success status colours.
- The Overview, Reverse Engineer and Database compositions.
- Where the view switcher (Overview · Trace · Plot · Reverse Engineer · Database) sits in this toolbar. The approved comp doesn't show it yet.
