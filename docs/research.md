# FreeCAN Studio: Research and Tech Stack

Researched 2026-09-30. Licenses, versions and activity were checked against GitHub, crates.io and npm on that date. Anything marked *(unverified)* was not confirmed. Nothing was compiled; the WASM-compatibility notes come from reading dependencies and source code.

## Product shape

- **Free web app.** A static site that does all processing in the browser. Log files never leave the user's machine, which is a selling point.
- **Paid desktop app.** The same UI and the same core, running natively. It adds live hardware, much larger files, automation and advanced reverse-engineering (RE) features.

## Recommended stack

| Layer | Choice | Why |
|---|---|---|
| Core engine | **Rust** workspace with no UI code | Compiles to wasm32 for the web and natively for desktop, so there is one codebase for parsing, decoding and analysis. Web cabana died because its JavaScript core couldn't handle CAN-FD volumes. |
| Web runtime | Core as **wasm32 in Web Workers** (`wasm-bindgen` 0.2.129, `wasm-pack --target web`) | Several workers, each with its own wasm instance, return results as transferable ArrayBuffers. This avoids SharedArrayBuffer and the COOP/COEP headers it needs. |
| UI | **TypeScript + React + Vite** (Solid is fine too) | The heavy rendering is canvas/WebGL, so the framework choice matters little; pick for ecosystem size. |
| Time-series plots | **uPlot** fed by min/max level-of-detail (LOD) pyramids computed in Rust | About 2xpixel-width points per series, whatever the underlying count. Cursor sync across plots comes free. If you need more than about 20-30 plots or 60 Hz live updates, move to one shared WebGL2 context. |
| Bit/byte heatmaps | Custom **WebGL2** texture (`texSubImage2D` updates) | Cheap live updates. WebGPU is not reliable in Tauri webviews or on Linux. |
| Trace table | Custom **canvas table with logical scrolling** calling `getRows(start, n)` on the core | DOM virtualization hits the browser's maximum element height at about 0.5-1.5M rows. Alternative: regular-table (Apache-2.0). |
| Browser storage | Stream the `File` via `Blob.slice` + `FileReaderSync` in a worker. Keep indexes and caches in **OPFS**. | wasm32 is capped at 4 GB. Memory64 is not in Safari stable and runs 10-100% slower. |
| Columnar store | Arrow-style column layout (arrow-rs if needed) | Parquet/Arrow export and a DuckDB SQL console can be added later without redesign. DuckDB-WASM is overkill for v1. |
| Desktop shell | **Tauri v2** (2.12.x) | The core runs natively, with no 4 GB cap and mmap for big files. About 3 MB installer. The updater requires signed updates. Fallback is Electron (with napi-rs) if WebKitGTK rendering on Linux causes trouble. |
| Native CAN drivers | `socketcan` (MIT), `peak-can` (MIT/Apache), `vxlapi-sys` (MIT/Apache), Kvaser CANlib, `nusb` for gs_usb/candleLight, `serialport` for SLCAN | Only socketcan and peak-can are mature, so plan to own the adapter layer. |
| Hosting (web) | **Cloudflare Pages** (or Netlify/Vercel) | Static hosting with custom headers via `_headers`. 25 MiB per-file limit, so keep the wasm under that. GitHub Pages can't set headers. |
| Payments | **Polar** or **Paddle** as merchant of record | They handle VAT and sales tax. |
| Desktop licensing | **Keygen** license files signed with Ed25519, checked offline against a public key built into the app | Free up to 100 active users, with a self-hosted Community Edition. Aim to stop casual sharing, not to build DRM. |
| Testing | `cargo test` against opendbc and sample logs. Differential tests against cantools, python-can and asammdf run as external oracles in CI. Playwright for the UI. | The copyleft tools are only run, never linked or shipped. |

### Why not all-Rust egui (the Rerun approach)?

It's viable: Rerun ships the same egui code natively and on the web. But on the web egui draws only to a canvas. You lose Ctrl-F, accessibility, IME and browser text handling. The free web app is the marketing funnel, so a web UI is the better trade.

## Architecture

```
                 +------------------------- TypeScript UI (React) -------------------------+
                 |  trace table (canvas) - uPlot charts - WebGL2 bit heatmap - DBC editor   |
                 +------------------------------+------------------------------------------+
                                                |  CoreApi (TS interface)
                        +-----------------------+-----------------------+
                        |                                               |
             WebCore: postMessage                            DesktopCore: Tauri invoke /
             -> Web Worker pool                              Channel / ipc::Response (ArrayBuffer)
                        |                                               |
              can-wasm (wasm32) -------- same Rust crates -------- src-tauri (native)
                        |                                               |  + pro features
                        +--------------+--------------------------------+  + hw drivers
                                       |
          can-core - can-formats - can-dbc-model - can-re   (no_std+alloc where possible)
```

Proposed workspace:

```
crates/
  can-core/       frame types, columnar frame store, LOD pyramids, RangeRead trait
  can-formats/    candump, ASC, TRC, BLF, MF4, GVRET CSV, pcap (streaming, RangeRead-based)
  can-dbc-model/  parse (via can-dbc) -> own editable model -> decoder -> lossless writer
  can-re/         bit-flip stats, boundary detection, counter/CRC detection, find-signal, correlation
  can-wasm/       wasm-bindgen bindings (web build)
  can-hw/         hardware adapters (desktop only)
src-tauri/        desktop shell; enables `pro` cargo feature
web/              TypeScript UI, shared by both builds
```

**Gating paid features.** Anything shipped to the browser can be inspected and unlocked, so paid code must not be in the web bundle at all. Put it behind a `pro` Cargo feature, build a separate wasm, strip Pro UI with Vite `define` flags plus tree-shaking, and add a CI step that greps `dist/` for Pro symbols.

## DBC and database formats

No permissive library does everything: parse, decode, lossless write, extended mux, floats, CAN FD and J1939. **Parse with `can-dbc`, then write our own model, decoder and writer.**

| Library | Lang | License | Notes |
|---|---|---|---|
| [can-dbc](https://github.com/oxibus/can-dbc) v10.0.0 | Rust | MIT/Apache | Best parser. Handles mux incl. `m3M`, extended mux (SG_MUL_VAL_), SIG_VALTYPE_, VAL_, BA_, CM_, extended IDs; FD-safe. **Doesn't decode or write.** Tested against opendbc. Escaped quotes are a TODO. Should be WASM-friendly (pest, encoding_rs, serde, no std::fs). |
| [dbcppp](https://github.com/xR3b0rn/dbcppp) | C++ | MIT | The best **reference for a complete writer** (`Network2DBC.cpp`) and a fast precomputed-mask decoder. Also reads KCD. |
| [dbc-rs](https://github.com/sigmatactical-org/dbc-rs) 0.10 | Rust | MIT/Apache | no_std; decodes and encodes. Skips SIG_VALTYPE_, and its writer drops some sections. |
| [autors-dbc](https://github.com/H2O2-IO/autors) 0.1 | Rust | Apache-2.0 | Two months old; no extended mux. |
| [candied](https://github.com/bit-dream/candied) | TS | MIT/ISC (the two files disagree) | **Avoid.** Stale, and its decoder ignores mux and floats and loses precision above 2^53. |
| [cantools](https://github.com/cantools/cantools) 44.1 | Python | MIT | **Test oracle.** Most complete: FD, J1939, KCD, SYM, ARXML read. |
| [canmatrix](https://github.com/ebroecker/canmatrix) | Python | BSD-2 | Reference for format conversion. |
| Vector_DBC, c-coderdbc, @viriciti/dbc-to-json | various | **GPL-3.0** | Don't use. |

**Test corpus:** [commaai/opendbc](https://github.com/commaai/opendbc) (MIT) has 58 committed `.dbc` files. The Honda/Acura, Subaru and Nissan files, including CAN FD ones, are generated from templates by `generator/generator.py`.

**Other formats**

| Format | Library | License | Notes |
|---|---|---|---|
| KCD | port cantools' `kcd.py`, reading the XML with DOMParser | - | Simple XML. |
| ARXML | [autosar-data](https://github.com/DanielT/autosar-data) | Rust, MIT/Apache | Paid tier. WASM size unverified. |
| SYM | port cantools' `sym.py` | - | No library in Rust or JS. |
| LDF (LIN) | [lin-ldf](https://github.com/zpg6/lin-ldf) | Rust, MIT | Has a WASM build but is self-described as not production-ready. |

### DBC gotchas to cover in tests

1. **Motorola start bit.** DBC stores the MSB using sawtooth numbering (7...0 | 15...8). Editors often show the LSB. KCD and SYM number bits differently again; see cantools' `sawtooth_to_network_bitnum`.
2. **Extended IDs** are flagged by bit 31 of the `BO_` ID.
3. **`VECTOR__INDEPENDENT_SIG_MSG`** is a pseudo-message (0xC0000000, DLC 0) whose signal names can be duplicates.
4. **CAN FD and J1939 are attributes, not syntax.** They come from `VFrameFormat` (StandardCAN_FD, J1939PG, ...) and `CANFD_BRS`. J1939 matching has to mask out the source address.
5. **Encoding is never declared.** Try UTF-8, fall back to cp1252, and write back in the original encoding.
6. **Non-standard files:** CRLF line endings, `;` vs ` ;`, opendbc's `CM_ "IMPORT ..."` includes. Float output must not depend on locale.
7. **64-bit raw values** need u64/i64. Keep decoding in Rust; JS would need BigInt.

## Log file formats

The mature, complete parsers are all **copyleft**, and the permissive Rust crates are weeks to months old or incomplete. Most assume `std::fs` or mmap, which doesn't exist in the browser. **Write our own streaming Rust parsers**, reading permissive code for reference and using copyleft tools only as black-box test oracles.

| Format | Permissive references to learn from | Copyleft (oracle only) | Spec / notes |
|---|---|---|---|
| candump `-L` + stdout | [can-utils](https://github.com/linux-can/can-utils) (per-file choice of GPL-2.0 or **BSD-3**), socketcan-rs `dump.rs` (MIT), cantools logreader (MIT) | python-can | `lib.h` documents the CC/FD/XL grammar |
| Vector ASC | Kvaser kvlclib (BSD-new/GPLv2), blf_asc (Rust, MIT/Apache) | python-can `asc.py`, vector_asc (GPL-3) | Variants: v8.1+ FD column (python-can can't read it), hex/dec base, abs/rel timestamps, German headers |
| Vector BLF | [vblf](https://github.com/zariiii9003/vblf) (Python, **MIT**, by a python-can maintainer), Kvaser kvlclib `VectorBlfFd` (BSD-new), SavvyCAN `blfhandler.cpp` (MIT) | Technica [vector_blf](https://github.com/Technica-Engineering/vector_blf) (GPL-3, ~140 object types), python-can `blf.py` | Free tier needs object types 1, 86, 73, 100, 101 plus error objects, inside zlib LOG_CONTAINER (10). Warning: Vector DMCA'd repos that redistributed binlog headers and docs in 2020. Don't use `binlog_objects.h` or Vector's PDF. |
| ASAM MF4 | [mdflib](https://github.com/ihedvall/mdflib) (C++, MIT), [mdf4-rs](https://github.com/sigmatactical-org/mdf4-rs) (Rust, MIT/Apache, no_std), [falcon_mdf](https://github.com/mohammad-albarham/falcon_mdf) (Rust+WASM, MIT/Apache, 2 months old), CSS [mdf4-converters](https://github.com/CSS-Electronics/mdf4-converters) (MIT) | asammdf (LGPL-3), mdfr (GPL-3) | CANedge writes **unsorted, unfinalized** MDF 4.11. Links are absolute offsets, so an index pass is needed. Consider forking mdf4-rs or falcon_mdf for the block layer. [ASAM MDF wiki](https://www.asam.net/standards/detail/mdf/wiki/) is free. |
| PEAK TRC | cantools (MIT), SavvyCAN (MIT) | python-can `trc.py` | [Official spec, free](https://www.peak-system.com/produktcd/Pdf/English/PEAK_CAN_TRC_File_Format.pdf), covers v1.0-3.0 |
| GVRET CSV, CRTD, CLX000, BusMaster, Kvaser txt, Lawicel, CANHacker ... | [SavvyCAN framefileio.cpp](https://github.com/collin80/SavvyCAN/blob/master/framefileio.cpp) (MIT): port its logic, not the Qt code | BUSMASTER (GPL-3) | Specs: [CRTD](https://docs.openvehicles.com/en/latest/crtd/index.html), [CLX000](https://canlogger.csselectronics.com/clx000-docs/cl1000/log/index.html) |
| pcap/pcapng (SocketCAN) | [pcap-parser](https://github.com/rusticata/pcap-parser) (MIT/Apache, pure Rust) | Wireshark | [LINKTYPE_CAN_SOCKETCAN (227)](https://www.tcpdump.org/linktypes/LINKTYPE_CAN_SOCKETCAN.html). The ID is big-endian. |
| Kvaser KME | Kvaser Linux SDK kvlclib source (BSD-new/GPLv2) | - | No public spec. Confirm the license in the official tarball. |
| Intrepid VSB | - ([ICS_VSBIO](https://github.com/intrepidcs/ICS_VSBIO) has no license) | - | [Spec](https://docs.intrepidcs.com/neovi-api/vehicle-spy-vsb-file-spec) |

There are effectively no real CAN log parsers on npm.

**Parser design:** a `no_std+alloc` core with a synchronous `RangeRead` trait, fed by `Blob.slice` + `FileReaderSync` in a worker on the web, or by mmap/pread on desktop. Use pure-Rust inflate (miniz_oxide or zune-inflate). BLF and the text formats stream sequentially; MF4 needs an index pass first.

**Sample files:**
- [python-can test/data](https://github.com/hardbyte/python-can/tree/main/test/data): ASC, BLF, TRC 1.0-2.1.
- vblf `tests/data`.
- CSS Electronics [MF4 samples](https://www.csselectronics.com/pages/mf4-mdf4-measurement-data-format) and their J1939 data pack.
- [Wireshark SampleCaptures](https://wiki.wireshark.org/SampleCaptures).
- Technica's binlog-generated BLFs are GPL: use them in internal tests only, never ship them.
- Generate more with `log2asc` and the python-can writers.

## Reverse engineering

### Prior art to learn from

- **[SavvyCAN](https://github.com/collin80/SavvyCAN)** (MIT, active) has the richest RE toolset:
  - **Sniffer:** green/red highlighting for rising/falling values, "notching" to hide bits you don't care about, fading of idle bytes.
  - **Flow View:** each byte over time, compared against a reference frame.
  - **Frame Details:** timing statistics and per-bit and per-byte histograms.
  - **Range State:** brute-forces start bit, length, byte order and signedness, and ranks candidates that vary coherently.
  - **Discrete State:** finds fields whose count of distinct values matches the number of states you toggled.
  - **Also:** file comparator, bisector, fuzzing, UDS scan, ISO-TP, DBC editor, JavaScript scripting.
- **[Web cabana](https://github.com/commaai/cabana)** (MIT, archived 2023): React, Vega, HLS video sync, drag across an 8x8 bit grid to define a signal. It was abandoned as hard to maintain and too slow for CAN-FD ([openpilot#25758](https://github.com/commaai/openpilot/issues/25758), [0.9.0 blog](https://blog.comma.ai/090release/)). That is the strongest argument for a Rust/WASM core.
- **New cabana** (`openpilot/tools/cabana`, MIT; moved from Qt to Dear ImGui in 2026-09):
  - Per-bit flip heatmaps.
  - **Find Signal:** a constraint search over start bit, size, byte order, signedness, factor and offset, narrowed step by step with Find Next and Undo.
  - **Find Similar Bits:** finds bits in other IDs that match the selected one.
  - Multi-camera video sync.
- **Vehicle Spy:** Suppress Highlighting, Change Magnitude colouring, Build Filter from Changing, Template Mode (apply a known decoding to an unknown ID).
- **CANalyzat0r** (GPL): subtracting background noise and binary-search replay to isolate the frames behind an action.

### Algorithms

| Method | Idea | Practical in the browser? |
|---|---|---|
| READ (Marchetti & Stabili, TIFS 2019) | A signal boundary sits where a bit's flip rate drops about 10x from its neighbour. Counters halve per bit, CRCs are flat. | Yes single pass |
| LibreCAN ([CCS 2019](https://mpese.com/publication/pese-2019-librecan/ACM_CCS_LibreCAN_Paper.pdf)) | A READ variant, then correlation against OBD-II PIDs or IMU data with a linear fit for scale and offset, then event diffing for body signals | Yes (the code has no license, so don't copy it) |
| TANG ([arXiv 1904.03078](https://arxiv.org/abs/1904.03078)) | Bit-transition n-grams plus greedy grouping. The pipeline is GPL-3. | Yes |
| ACTT ([arXiv 1811.07897](https://arxiv.org/abs/1811.07897)) | Tokenizes payloads and learns their meaning by matching OBD-II responses | Yes |
| **CAN-D** ([arXiv 2006.05993](https://arxiv.org/abs/2006.05993)) | Conditional flip-probability boundaries, byte order solved as an optimization, signedness from the top two bits, regression for meaning | Warning: **Patented, US11780389B2 (UT-Battelle, to about 2042).** Get legal review before shipping. |
| CANMatch (TVT 2022) | Match unknown IDs against known definitions, since frames are reused across 479 vehicles | Yes (use opendbc as the library) |
| CRC RevEng + `opendbc/car/crc.py` (MIT) | Brute-force CRC-8 parameters; known OEM CRCs | Yes |

### Feature split

**Table stakes (free):**
- Import all the free-tier formats.
- A per-ID list with count, period and DLC.
- A virtualized trace view with byte-change colouring.
- DBC import, decode and export.
- Plots and filters.

**Free differentiators (the reason people pick this tool):**
- Bit-level flip heatmaps, both cumulative and for a time window.
- A binary view you can scrub through time.
- Drag bits to define a signal and see it plotted instantly, with byte-order and signed toggles.
- Notching and suppression.
- A manual "Find Signal" constraint search.
- Automated signal discovery (shipped as Suggested signals): boundary detection, labels for counters, checksums and CRCs, and correlation against a reference signal.
- Full CAN-FD support.
- Privacy: files are never uploaded.

**Paid desktop:**
- Live capture across many drivers.
- Transmit, replay and fuzzing (with safety gating).
- UDS and ISO-TP scanning.
- Multi-camera video sync.
- Multi-GB files.
- Deeper discovery on top of the free Suggested signals: correlation against OBD/GPS references, the CRC solver, opendbc fingerprinting.
- Scripting and CLI automation.
- Multi-bus work.
- Advanced formats: ARXML, KME, CANedge MFC/MFE, VSB, LIN/Ethernet/FlexRay objects.

A free "taste" of live capture is possible via Web Serial with SLCAN/CANable adapters: Chromium, and Firefox 151+ *(gating unverified)*. There's no Safari support. WebUSB for gs_usb is Chromium-only and blocked on Linux by the kernel driver unless you add a udev rule.

## Competitive landscape

- **Free desktop:** SavvyCAN and cabana, both MIT. The paid desktop has to beat them on UX, automation, formats and driver coverage, not on the basic RE views.
- **Browser:**
  - [OpenCAN](https://www.opencan.tools/) supports ASC, BLF, MF4 and CSV and has a pricing page *(tiers unverified)*.
  - CSS Electronics' webCAN needs their hardware.
  - Several small single-page viewers exist.
  - None of the ones checked offers bit heatmaps, drag-to-define signals or automated labelling.
- **LLM-assisted RE:** CSS Electronics published [Claude Code RE skills](https://github.com/CSS-Electronics/can-bus-reverse-engineering-skills) (MIT, Jun 2026), so this is now vendor-marketed.
- **Rust desktop MDF4 viewer:** [sigma-diagnostics](https://github.com/sigmatactical-org/sigma-diagnostics) (MIT/Apache).

## Platform constraints and gotchas

- **Memory:** wasm32 has a 4 GB address space. At about 22 bytes per classic frame, 10M frames is about 220 MB. Decode signals only when needed and never hold the raw file in memory. Files beyond the web limit are the natural upsell to desktop.
- **SharedArrayBuffer and wasm threads** need COOP/COEP headers. These block third-party scripts that don't send CORP headers, and WebKitGTK (Tauri on Linux) only enabled SharedArrayBuffer in trunk in September 2026. **v1 avoids SharedArrayBuffer entirely** and uses a pool of workers with transferables.
- **File System Access API** (`showOpenFilePicker`, persistent file handles): Chromium only. Fall back to drag-and-drop or `<input>`.
- **OPFS:**
  - Available everywhere. The synchronous access handle is worker-only.
  - Quotas vary: Chrome allows up to 60% of disk; Firefox's default is the smaller of 10% of disk or 10 GiB.
  - **Safari deletes it after 7 days without a visit**, so treat it as a cache only.
- **WebGPU** isn't dependable in Tauri webviews or on Linux. Use WebGL2 as the baseline.
- **WebGL contexts:** browsers allow only about 8-16 per page. Don't give every plot its own (this rules out Plotly scattergl).

## Early spikes (to de-risk)

1. **Scale:** candump parser -> columnar store -> wasm worker -> canvas trace table scrolling 10M rows. Measure parse speed (MB/s) and memory.
2. **Plotting:** DBC decode (can-dbc) -> LOD pyramid -> uPlot with 10+ synced signals over 10M frames.
3. **Heatmap:** WebGL2 bit-flip heatmap updating while the user scrubs through time.
4. **Desktop:** Tauri shell running the same UI through `CoreApi`, with ArrayBuffer transfer over `ipc::Response`. Check performance on macOS WKWebView and Linux WebKitGTK.
5. **WASM builds:** `cargo check --target wasm32-unknown-unknown` on can-dbc, pcap-parser, miniz_oxide and mdf4-rs.

## Unverified items

- No crate was actually compiled to WASM.
- LightningChart and SciChart pricing (not needed if we use uPlot).
- WebGPU inside WKWebView and WebKitGTK.
- The WebKitGTK `JSC_useSharedArrayBuffer` workaround.
- OpenCAN's pricing tiers.
- Which Kvaser kvlclib licenses appear in the official tarball.
- Whether READ, LibreCAN or TANG are patented. Only CAN-D's patent was confirmed.
