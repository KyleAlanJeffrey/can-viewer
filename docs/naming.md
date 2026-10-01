# Naming and search keywords

Researched 2026-09-30. The search data comes from Google Autocomplete (about 130 seed phrases, US English) and Google Trends (exact phrases, worldwide, Jan 2016 to Sep 2026). No absolute search volumes were available: Keyword Planner, Ahrefs and Semrush all require a login. Trends reports relative interest, with "can bus analyzer" set to 100.

## What people search for

| Rank | Cluster | Evidence | Notes |
|---|---|---|---|
| 1 | **CAN bus analyzer** | Trends 100 (anchor). Completions include "software free", "free download", "open source". **"free can bus analyzer software" is the top completion for both "free can bus" and "freecan bus".** | The largest search that isn't a brand name. |
| 2 | Brand / alternative searches | CANalyzer 784, BUSMASTER 314, candump 155, PCAN-View 117, asammdf 108, SavvyCAN 101. Completions include "free canalyzer alternative" and "savvycan mac". | Worth an "alternative to" page. |
| 3 | CAN bus sniffer | 37 | Mostly hardware (ESP32, Arduino). |
| 4 | DBC viewer / editor / decoder | "dbc editor" 20, "dbc viewer" 1.7. Many completions add "online", "free" or "mac". | "dbc file" alone is mostly Databricks noise. |
| 5 | Reverse engineering | 3.3. Completions include "…software", "…tools", "ai can bus reverse engineering". | |
| 6 | CAN log viewer / log analyzer | 0.8. Completions include "asc can log viewer", "can log file viewer". | High intent, little competition. |
| 7 | File-format viewers | Below the Trends threshold, but strong in autocomplete: "blf viewer online", "mf4 viewer online", "asc/trc file viewer online", "blf to asc converter online". | Long tail; cover these in H2s. |

The Mac/Linux signal is real ("can bus software mac", "dbc viewer linux", "savvycan macos").

## Titles of ranking competitors

- **OpenCAN** (closest competitor): "OpenCAN: Free CAN Bus Analyzer". Description: "CAN bus analyzer in your browser… Decode with DBC. No install, no license."
- **CSS Electronics:** "DBC Editor for CAN Bus Database Files [Online | 100% Free]", "CAN Bus Sniffer - Reverse Engineer Your Vehicle Data"
- **CanLover:** "CAN Bus Analyzer | Free CANalyzer Alternative for Linux & Windows"
- **Kvaser:** "CanKing - Kvaser's free CANbus monitor software"
- **CoderTools:** "Online CAN Bus & J1939 Decoder with DBC Parser"

## "freecan" as a search term

- It has no search demand of its own.
- Autocomplete for "freecan software" and "freecan tool" is rewritten to **FreeCAD**. A bare "freecan" suggests "free canvas", "freecanna" and "freecad".
- Current results for "freecan": a Toronto supplement exporter, a fluconazole brand, Beijer Electronics' FreeCAN driver, and a dormant GitHub repo.
- The Google results page itself was not checked; it served a CAPTCHA.

## Existing uses and availability

- **USPTO:** no FREECAN mark, live or dead. EU and WIPO were **not** checked.
- **Beijer Electronics "FreeCAN":** a CAN/J1939 driver for its HMI panels, still maintained (v5.08, Jan 2025). It's a driver name, not a marketed brand. Beijer is Swedish, so do an EU search before filing.
- **"CAN" in a name is fine:** Bosch's CAN FD and CAN CC marks disclaim the word. Avoid CANopen, CAN XL, CANsec, and Vector's CANalyzer, CANoe, CANape and CANdb.
- **FreeCAD** has a Benelux trademark and enforces it mainly against app-store fakes. A second word in our name plus a distinct visual identity keeps the two apart.

| Name | Status |
|---|---|
| freecan.com | Registered 2006; investor page ("contact us for business inquiries") |
| freecan.io | Registered 2026-08-21, GoDaddy parking page |
| freecan.net / .org | Registered, unrelated |
| freecan.dev, .app, .studio, .tools, .ai, .co | Available |
| freecanstudio.com, freecanlab.com, getfreecan.com | Available |
| npm / crates.io / PyPI `freecan` | Available |
| GitHub `freecan`, X `@freecan` | Taken (dormant) |
| GitHub / X `freecanstudio`, `freecanlab` | Available |

## Using "free" when a tier is paid

- **Precedents:**
  - FreeFileSync: the free version is complete; a paid edition adds extras.
  - FreeRTOS: the paid variants have different names.
- **Caution:** the FTC's January 2024 ruling against Intuit's "free" TurboTax.
- **Rules to follow:**
  - The web app stays free forever, with no caps or trials.
  - The paid desktop app is never called free.
  - The paid tier gets a clearly different name.

## Recommendation

- **Name:** **FreeCAN Studio** (free web app) and **FreeCAN Studio Pro** (paid desktop).
- **Domains:** use freecan.studio, and point freecanstudio.com at it.
- **Page title:** "FreeCAN Studio — Free Online CAN Bus Analyzer & Log Viewer (DBC, BLF, MF4)"
- **Tagline:** "Open candump, ASC, BLF, TRC, MF4 and CSV logs in your browser. Decode with DBC, plot signals, and reverse-engineer unknown CAN messages. Files never leave your computer."
- **Runner-up:** FreeCAN Lab / FreeCAN Lab Pro, which leans harder into reverse engineering.
