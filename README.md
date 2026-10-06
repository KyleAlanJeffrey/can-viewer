# FreeCAN Studio

![Workshop Light brand reference: Twisted F logo, IBM Plex Sans and Mono, amber and graphite palette, and interface details](docs/freecan-workshop-brand-guide-v2.png)

**Approved identity: Workshop Light.** Twisted F mark - IBM Plex Sans for the interface - IBM Plex Mono for data - amber `#FFB547`, graphite `#20242B`, warm white `#F4F0E7`, and white content surfaces.

[Full-size brand sheet](docs/freecan-workshop-brand-guide-v2.png) - [Design system and exact color values](DESIGN.md) - [Screen mockups](docs/screens.md#approved-workshop-light-mockups)

A free, browser-based CAN bus analyzer and log viewer with reverse-engineering tools. FreeCAN Studio Pro, a paid desktop app on the same core, is planned. The stack rationale is in [docs/research.md](docs/research.md) and the naming research in [docs/naming.md](docs/naming.md).

It opens candump, Vector ASC and BLF, PEAK TRC, ASAM MF4 and CSV logs, and Export Log... saves the open log in any of those formats, so it doubles as a free log converter ([what each format keeps](COMPATIBILITY.md#log-export)). In Chrome and Edge it also records live from a CAN adapter (slcan over Web Serial, candleLight/gs_usb over WebUSB) and saves the capture as a candump log; see "Live capture" in [COMPATIBILITY.md](COMPATIBILITY.md#live-capture).

Everything runs client-side: a Rust core compiled to WebAssembly in a Web Worker, and a React/TypeScript UI. The desktop build will run the same crates natively under Tauri, behind the same `CoreApi` interface ([web/src/core/api.ts](web/src/core/api.ts)).

It works offline and can be installed as an app. After one visit, a service worker keeps the app itself, so it opens with no network (a laptop in a garage); the demo log is kept too once it has been opened. Chrome and Edge offer **Install** in the address bar, and Safari has **File > Add to Dock**. A new version downloads in the background and the app offers **Reload** when it is ready. See [COMPATIBILITY.md](COMPATIBILITY.md#offline-and-install).

## Layout

| Path | What |
|---|---|
| `crates/can-core` | Frame types; columnar frame store with per-ID stats and bit-flip counts |
| `crates/can-formats` | Streaming log parsers: candump, Vector ASC and BLF, PEAK TRC, ASAM MF4 and CSV, chosen by file name and content; writers for the same formats (`writer/`) |
| `crates/can-dbc-model` | DBC loading via `can-dbc`, our own editable model, signal decode and encode |
| `crates/can-wasm` | wasm-bindgen `Session` used by the web worker; min/max plot decimation over level-of-detail pyramids |
| `crates/sample-gen` | Dev tool: synthetic demo log + DBC, native benchmark, decode dumps, log conversion |
| `web/` | Vite + React UI: canvas trace table, bit heatmap, uPlot plots, video sync |
| `web/src/capture` | Live capture: slcan (Web Serial) and gs_usb (WebUSB) adapters, frame batching, the Capture sheet |
| `site/` | The landing site for `freecanstudio.com`: static HTML, no build ([site/README.md](site/README.md)) |
| `scripts/crosscheck_cantools.py` | Compares our decoder with cantools |
| `scripts/gen_extended_mux.py` | Test log + DBC with nested multiplexors, for the cantools cross-check |

## Develop

Needs Rust with the `wasm32-unknown-unknown` target, `wasm-pack`, Node and pnpm.

```bash
cd web && pnpm install
```

Build the wasm core. Rerun this after any Rust change.

```bash
cd web && pnpm wasm
```

Generate the demo: a 1M-frame log, gzipped to `web/public/demo/demo.log.gz` (the raw log stays in `target/demo/demo.log`), and `web/public/demo/demo.dbc`. CONTRIBUTING.md shows how to make a bigger one.

```bash
cd web && pnpm demo
```

Start the dev server, then open the page and click **Try the Demo** or drop a log and a DBC. The formats read are listed in [COMPATIBILITY.md](COMPATIBILITY.md#log-formats).

```bash
cd web && pnpm dev
```

Tests:

```bash
cargo test --workspace
```

Rewrite the demo in another format to try the parsers on it, with the writers Export Log... uses (the extension picks the format: `.log` for candump, `.asc`, `.trc`, `.csv`, `.blf` or `.mf4`):

```bash
cargo run --release -p sample-gen -- convert target/demo/demo.log target/demo/demo.asc
```

Cross-check the decoder against cantools (needs `pip install cantools`):

```bash
cargo run --release -p sample-gen -- decode target/demo/demo.log web/public/demo/demo.dbc 300000 > /tmp/ours.csv
python scripts/crosscheck_cantools.py target/demo/demo.log web/public/demo/demo.dbc /tmp/ours.csv 300000
```

## Deploy

The app and the landing site are two Cloudflare Workers projects. The app (`wrangler.jsonc`, project `freecan-studio`) is served on `app.freecanstudio.com`; the landing site (`site/wrangler.jsonc`, project `freecan-site`) on `freecanstudio.com`. `freecan.studio` and `freecan.app` redirect to `freecanstudio.com` through Cloudflare redirect rules set up by the owner. See "Deployment" in [CONTRIBUTING.md](CONTRIBUTING.md).

## Spike results (2026-09-30, Apple Silicon, Chromium)

These use the 10M-frame demo: a 552 MB candump file, about 5 h of driving, 11 IDs on two buses, including CAN FD and J1939.

| | Result |
|---|---|
| Native parse (`sample-gen bench`) | 285 MB/s, 5.2M frames/s |
| Browser parse (wasm, one worker) | 2.7 s, 207 MB/s |
| wasm memory after load | 383 MB with chunked columns (see below); 654 MB before them, mostly `Vec` growth slack |
| Trace page (40 rows) round trip | 0.5 ms |
| Plot re-query, 1.8M points decimated to 1,800 | 0.6 ms with the level-of-detail pyramid (see below); 9.7 ms before it |
| Decoder vs cantools | 1,622,498 values from 300k frames, all equal |
| Web bundle (gzip) | 99 kB JS + 117 kB wasm |

Plot queries were measured again on 2026-10-05 (Apple Silicon, the wasm build in Node, which runs the same V8 as Chromium, and natively), with the median of 31 views of one signal of 1.8M points; Cell1, a multiplexed signal present on 1 frame in 20, has 91k points:

| View (1,800 buckets) | wasm before | wasm after | native before | native after |
|---|---|---|---|---|
| Whole log, 1.8M points | 9.7 ms | 0.6 ms | 8.3 ms | 0.6 ms |
| Whole log, 1,000 buckets | 9.7 ms | 0.35 ms | 8.3 ms | 0.3 ms |
| A tenth of the log, 181k points | 0.88 ms | 0.30 ms | 0.76 ms | 0.24 ms |
| A hundredth, 18k points (scanned) | 0.06 ms | 0.07 ms | 0.05 ms | 0.05 ms |
| Cell1, whole log, 91k points | 0.39 ms | 0.25 ms | 0.32 ms | 0.20 ms |

The first view that uses a series' pyramid builds it: about 16 ms in wasm (11 ms natively) for 1.8M points, against 9.8 ms for one scan. It takes about 1.1 MB per million points, beside the 16 MB the series' times and values take. Views averaging under 32 points a bucket scan the points, which is quicker there.

The frame store's columns grow 4 MiB at a time rather than doubling, so wasm memory stays close to the frames' own size. Measured on 2026-10-05 (Apple Silicon, the wasm build in Node; best of three loads, wasm memory after the load):

| Log (10M frames unless noted) | wasm before | wasm after | memory before | memory after |
|---|---|---|---|---|
| 552 MB candump, in time order | 3.65 s | 3.73 s | 645 MB | 383 MB |
| 112 MB MF4 | 5.41 s | 5.44 s | 606 MB | 486 MB |
| 178 MB MF4, 16M frames | 8.76 s | 8.68 s | 921 MB | 781 MB |
| candump, first 1,000 lines moved to the end (sorted after reading) | 5.88 s | 6.29 s | 768 MB | 583 MB |
| The candump as Compare's log B beside itself | 3.63 s | 3.73 s | 1,167 MB | 817 MB |

Natively (`sample-gen bench`) the in-order candump parses at 268 MB/s against 274 MB/s, and the sorted one at 145 MB/s against 155 MB/s. Smaller chunks cost more in wasm, where every allocation that grows the memory costs the JavaScript side: 64 KiB chunks loaded the candump 15% slower and 1 MiB chunks 4% slower, against about 2% for 4 MiB.

## Known gaps / next steps

The larger ones; every open task is in [TODO.md](TODO.md).

- **Formats:** candump, Vector ASC, Vector BLF (CAN objects), PEAK TRC, ASAM MF4 (CAN bus logging) and CSV (python-can, SavvyCAN and generic header-named layouts) are supported, all through the `LogParser` interface. MF4 is buffered and read when the file ends, up to 1 GiB, because its blocks link anywhere in the file; its data is then read a block at a time and the frames merged by time, so a 112 MB, 10M-frame MF4 takes about 490 MB of wasm memory (the file plus the frames). Not read: CAN XL, LIN, FlexRay and Ethernet frames, and MF4 files of decoded signals rather than bus frames.
- **Parallel parsing:** large candump, TRC, CSV and ASC logs are read in 2 MiB parts by up to 6 workers and joined in order, 2 to 4 times faster on a 12-core machine (see "Reading logs in parts" in [COMPATIBILITY.md](COMPATIBILITY.md)); BLF, MF4 and Compare's log B are still read on one core.
- **Reverse engineering:** drag-to-define signals on the heatmap, a scrubbable time window for bit flips, and DBC export are in. Suggested signals guesses counters, checksums, flags, enums, values, 32-bit floats and multiplexed pages from bit activity; next is opendbc fingerprinting.
- **Live capture:** not yet tried with real adapters. One bus at a time, receive only, classic CAN on gs_usb, host-clock timestamps; see [TODO.md](TODO.md) for the follow-ups.
