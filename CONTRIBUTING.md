# Contributing to FreeCAN Studio

FreeCAN Studio is a browser CAN bus log viewer and reverse-engineering tool. A Rust core (`crates/`) is compiled to WebAssembly and runs in a Web Worker; the React, Vite and TypeScript UI lives in `web/`. Read [README.md](README.md) for the layout, [PRODUCT.md](PRODUCT.md) for scope and [DESIGN.md](DESIGN.md) for the design system before making a change.

Related: [VERSIONING.md](VERSIONING.md), [COMPATIBILITY.md](COMPATIBILITY.md), [API.md](API.md).

## Prerequisites

- Rust, installed with `rustup`. `rust-toolchain.toml` pins the version, with rustfmt, clippy and the wasm32-unknown-unknown target; run `rustup toolchain install` in the repository to install it. Bump the pin in its own pull request, since CI fails on any new clippy warning.
- [wasm-pack](https://github.com/wasm-bindgen/wasm-pack). The Cloudflare build installs 0.15.0.
- Node 22 or later, and pnpm 10.

## Setup and development

All package scripts run from `web/`.

```bash
cd web
pnpm install
pnpm wasm    # build the wasm core into web/src/core/pkg
pnpm demo    # generate the demo log and DBC
pnpm dev     # start the Vite dev server
```

- `pnpm wasm` runs wasm-pack on `crates/can-wasm`. Rerun it after any Rust change; the dev server does not rebuild Rust.
- `pnpm demo` runs `crates/sample-gen` to write a 1M-frame candump log to `target/demo/demo.log` and the DBC to `web/public/demo/demo.dbc`, then gzips the log to `web/public/demo/demo.log.gz`. It ships gzipped because the raw log is over Cloudflare's 25 MiB per-asset limit. The generated files are git-ignored.
- `pnpm dev` serves the app. Open the URL Vite prints and click **Try the Demo**, or drop a candump log and a DBC on the window.
- `pnpm typecheck` (`tsc -b`) type-checks the UI. `pnpm build` type-checks and builds `web/dist`.
- `pnpm test` runs the UI tests once with Vitest; `pnpm exec vitest` watches.

For a bigger demo log, run the two demo steps by hand with a frame count:

```bash
cd web
cargo run --release -p sample-gen -- generate ../target/demo/demo.log public/demo/demo.dbc 10000000
node scripts/gzip.mjs ../target/demo/demo.log public/demo/demo.log.gz
```

## Checks

Run the checks for the areas you touched before opening a pull request. From the repository root:

```bash
sh scripts/check-csp-quote.sh
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
pnpm --dir web typecheck
pnpm --dir web test
```

- Fix any clippy warning your change introduces. CI fails on warnings.
- `.github/workflows/ci.yml` runs all of these, plus the wasm and Vite builds, on every pull request. Its `screenshots` job then takes screenshots of the landing site and the built app (see [Screenshots](#screenshots)).
- UI tests are Vitest with jsdom and Testing Library. They sit next to the code as `*.test.ts` or `*.test.tsx`; shared fixtures, including a fake `CoreApi`, are in `web/src/test/fixtures.ts`; `web/src/test/shell.tsx` renders a view inside a stand-in for the app shell, which owns the `ViewContext` state and gives the view its sidebar, inspector and search field; and `web/src/test/setup.ts` stubs the browser APIs jsdom lacks (canvas, `ResizeObserver`, `matchMedia`, `document.fonts`, `scrollIntoView`, modal dialogs, `IDBKeyRange`). Session tests use `fake-indexeddb`, and tests of kept captures give `navigator` the shared Web Locks of `web/src/test/fakeLocks.ts`. Test files are type-checked with the app, but the Vite build never imports them.
- The tests don't draw canvases or check layout, so still check UI changes by hand in `pnpm dev`, including keyboard use and focus.
- If you change the DBC decoder, cross-check it against cantools (`pip install cantools`, after `pnpm demo`):

```bash
cargo run --release -p sample-gen -- decode target/demo/demo.log web/public/demo/demo.dbc 300000 > /tmp/ours.csv
python scripts/crosscheck_cantools.py target/demo/demo.log web/public/demo/demo.dbc /tmp/ours.csv 300000
```

The demo has no extended multiplexing, so also check a generated log with three levels of nested multiplexors (`SG_MUL_VAL_`), Motorola multiplexors and a 64-byte CAN FD message:

```bash
python scripts/gen_extended_mux.py /tmp/mux.log /tmp/mux.dbc 30000
cargo run --release -p sample-gen -- decode /tmp/mux.log /tmp/mux.dbc 30000 > /tmp/ours_mux.csv
python scripts/crosscheck_cantools.py /tmp/mux.log /tmp/mux.dbc /tmp/ours_mux.csv 30000
```

Last run (cantools 44.1.0): the whole demo log, 5,408,346 values, all equal; the extended multiplexing log, 81,891 values, all equal, with 1,302 frames left out because their multiplexor values switch in no signal and cantools refuses to decode them.

If you could not run a check, say which one and why in the pull request.

### Screenshots

`scripts/screenshots.mjs` serves `site/public` and `web/dist`, each with its `_headers` (so under its real Content-Security-Policy), and takes PNGs in headless Chrome at 1440 px and at 390 px with phone emulation: every site page in full, and the app empty, with the demo loaded, on each view and with the Capture sheet open. It fails on any console error, CSP violation, uncaught exception (in the page, its workers or the service worker), failed same-origin request or service worker that doesn't install, and on a site page wider than the window. Phones are out of scope for the app (PRODUCT.md), so a view it can't reach at 390 px is only noted. It needs Node 22 and Chrome, and no npm packages. From the repository root:

```bash
pnpm --dir web wasm && pnpm --dir web demo && pnpm --dir web build
node scripts/screenshots.mjs
```

- The PNGs and an `index.md` listing them and any problems go to `target/screenshots` (set `SCREENSHOTS_DIR` to change it). Chrome runs with a throwaway profile, deleted on exit.
- Set `CHROME` to Chrome's path if it is not in `/Applications` (macOS) or `google-chrome` on the `PATH`.
- In CI, the `screenshots` job in `.github/workflows/ci.yml` runs it on the `web/dist` the `check` job built (the `web-dist` artifact, kept 3 days so the job can be re-run on its own), writes the list to the run's summary and uploads the PNGs as the `screenshots` artifact, kept 14 days, even when it fails.
- `node scripts/serve-static.mjs site/public --404-page` (or `web/dist --spa`) serves either one the same way on port 8000 for a look by hand.

## Branches and commits

- Branch names never contain `/`. Use `-` instead: `feat-asc-parser`, `fix-trace-scroll`.
- Commit messages follow [Conventional Commits 1.0](https://www.conventionalcommits.org/en/v1.0.0/#specification): `<type>(<optional scope>): <description>`.
  - Types: `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `build`, `ci`, `style`, `chore`.
  - Useful scopes are crate or view names: `core`, `formats`, `dbc`, `wasm`, `sample-gen`, `web`, `overview`, `trace`, `plot`, `reverse`, `compare`, `database`.
  - Mark breaking changes with `!` after the type or scope, or a `BREAKING CHANGE:` footer. Any change to the CoreApi is breaking (see [COMPATIBILITY.md](COMPATIBILITY.md#coreapi)).
  - Examples: `fix(trace): keep the selected row after filtering`, `feat(core)!: count rejected lines per bus in LogInfo`.
- Keep each change small and focused: one concern per pull request, no drive-by rewrites.

## Pull requests

- Describe what changed and why, how you tested it, and any risks or follow-ups.
- CodeRabbit reviews every pull request. Address every comment before merging: fix it, or reply with the reason it does not apply.

## Code style

- Prefer clear, readable code over clever one-liners. Write for a maintainer who has none of your context.
- Name variables, types and functions for what they are. A good name removes the need for a comment.
- Comment sparingly. Comment only what the code cannot say: a non-obvious why, a workaround, a subtle invariant, a deliberate deviation. Do not narrate what the code does. Keep comments terse.
- Keep existing comments unless they become wrong or redundant.
- Preserve the existing architecture and conventions. Avoid new dependencies unless they bring clear value.
- ASCII only in code and Markdown: straight quotes, `-` or `--` instead of em dashes, `->` instead of arrows. When UI copy needs a non-ASCII character, such as the ellipsis that marks a dialog ("Open Log..."), write it as an escape: `\u2026` in a JS string, `&hellip;` in JSX text. To find stray characters in the files you changed:

```bash
LC_ALL=C grep -n '[^[:print:][:space:]]' <files>
```

- Rust is formatted with `rustfmt`. TypeScript is strict (`web/tsconfig.json`), with unused locals and parameters as errors.

## Design rules

[DESIGN.md](DESIGN.md) is normative for the UI. In particular:

- **One amber primary per view.** Each view or sheet has exactly one filled Workshop Amber button. Open Log... is the default primary; a view with its own action (Add to Database, Export DBC...) demotes Open Log to an outline button. Selection uses pale amber tints, never solid amber, and amber is never text or a thin line.
- **Tokens, not values.** Colours, type and spacing come from the CSS custom properties in `web/src/styles.css`. Do not hard-code hex values. Canvas views read the same tokens with `cssVar` from `web/src/format.ts`.
- **No third-party CDNs.** Fonts, icons and scripts ship from the app's own origin. IBM Plex is self-hosted through `@fontsource`. The Content-Security-Policy in `web/public/_headers` blocks other origins in production anyway.
- **Light only.** No dark mode or dark panels.
- **Accessible.** WCAG 2.2 AA (see [PRODUCT.md](PRODUCT.md#accessibility--inclusion)): everything works by keyboard with a visible focus ring, colour is never the only carrier of meaning, and reduced motion is respected.
- **Plain copy.** Plain verbs, an ellipsis only when a dialog follows, and errors that say what happened and what to do next.

## Where code lives

| Path | What |
|---|---|
| `crates/can-core` | Frame types and the columnar frame store |
| `crates/can-formats` | Streaming log parsers |
| `crates/can-dbc-model` | DBC model, decode, encode and DBC export |
| `crates/can-wasm` | The wasm `Session` behind the worker |
| `web/src/core/` | The CoreApi (`api.ts`), its worker implementation and the row format. Documented in [API.md](API.md) |
| `web/src/views/<view>/` | One folder per view, each with its own stylesheet and class prefix |
| `web/src/views/shared/` | Helpers shared by views |
| `web/src/components/` | Shared components, such as `Sheet` and `Segmented` |
| `web/src/capture/` | Live capture: the adapter interface, slcan and gs_usb adapters, frame batching and the Capture sheet. Tests drive a simulated serial port (`web/src/test/fakeSerial.ts`) |
| `web/src/offline/` | The service worker, its registration and the build plugin that writes its precache list |
| `web/src/styles.css` | Design tokens and shared styles |

Views live in `web/src/views/<view>/` with their own CSS file and class prefix: `overview/overview.css` uses `ov-`, `plot/plot.css` uses `pv-`, `reverse/reverse.css` uses `re-`, `compare/compare.css` uses `cmp-` and `database/database.css` uses `db-`. To add a view:

1. Create `web/src/views/<view>/` with its component and stylesheet, using a new class prefix.
2. Register it in `VIEWS` in `web/src/views/index.ts`. A view most sessions never open can load on first use with `lazyView` (`web/src/views/lazyView.tsx`), as Compare and Database do, which keeps the main bundle under Vite's 500 kB warning; `ChunkBoundary` offers a reload if its chunk fails to load.
3. Read and change app state through `ViewContext` (`web/src/views/types.ts`), and render sidebar and inspector content through `SidebarSlot` and `InspectorSlot` (`web/src/views/slots.tsx`).

## Product rules

From [PRODUCT.md](PRODUCT.md):

- **Private by construction.** No feature may upload a user's log or DBC. Everything runs in the browser.
- **Closed source.** FreeCAN Studio is commercial and closed-source. Do not copy in GPL or LGPL code, and do not add GPL or LGPL dependencies, whether Rust crates or npm packages. Check the license of every new dependency.
- **Pro stays out of the web bundle.** Pro-only features belong behind the Cargo `pro` feature or in desktop-only crates.
- **Licensed assets only.** Fonts and icons must be licensed for web and desktop use. Apple's SF fonts and SF Symbols are not.

## Deployment

There are two Cloudflare Workers static-assets projects, deployed separately:

| Project | Config | Serves | Domain |
|---|---|---|---|
| `freecan-studio` (the app) | `wrangler.jsonc` at the repository root | `web/dist`, built by `scripts/build-cloudflare.sh` | `app.freecanstudio.com` |
| `freecan-site` (the landing site) | `site/wrangler.jsonc` | `site/public`, plain files with no build | `freecanstudio.com` |

`freecan.studio` and `freecan.app` redirect to `freecanstudio.com` through Cloudflare redirect rules, which the owner configures in the dashboard. The site links into the app; it never opens files itself. The landing site is described in [site/README.md](site/README.md).

Both projects build from the same repository, so each needs build watch paths in its Cloudflare build settings, or every push rebuilds both: `freecan-studio` excludes `site/*`, and `freecan-site` includes only `site/*`.

The app is a static site on Cloudflare Workers static assets, configured in `wrangler.jsonc`: an assets-only Worker named `freecan-studio` serving `web/dist`, with single-page-application fallback.

- Cloudflare Workers Builds runs `npx wrangler deploy`, which first runs the `build.command`: `sh scripts/build-cloudflare.sh`.
- That script installs the Rust toolchain from `rust-toolchain.toml`, the wasm target and wasm-pack 0.15.0 when they are missing, then in `web/` runs `pnpm install --frozen-lockfile` (through `npx` when pnpm isn't installed), then the `wasm`, `demo` and `build` scripts. It is safe to run locally to reproduce a deploy build.
- The install fails if `web/pnpm-lock.yaml` is out of step with `web/package.json`, so commit them together.
- `web/public/_headers` is copied into `web/dist` and sets the Content-Security-Policy and long-lived caching for `/assets/*`. Every asset must be under Cloudflare's 25 MiB per-file limit.
- `/sw.js` and `/manifest.webmanifest` are served with `Cache-Control: no-cache` (also in `_headers`), so browsers check them on every visit and pick up a deploy. Never give `sw.js` long-lived caching: a browser would keep running an old service worker, and with it the old app.
- `/sw.js` must always be served as real JavaScript. Never delete it from the build: Cloudflare's single-page-application fallback would then answer `/sw.js` with the page and a 200, the browser's update check would fail, and the service worker already installed would keep serving the old app indefinitely. To take a service worker out of users' browsers, ship the kill switch below.
- The service worker is built from `web/src/offline/sw.ts` by the `precachePlugin` in `web/src/offline/precachePlugin.ts`, which writes the list of built files to precache into it. Files from `web/public` that the app needs offline are listed in `PRECACHED_PUBLIC_FILES` in `web/vite.config.ts`; add to it when the page starts using another one (the build fails if one is missing). The demo is left out on purpose and cached at runtime; bump `DEMO_CACHE` in `web/src/offline/swRules.ts` if the demo's paths change. Each build gets its own cache, named from a hash of its files, the page and the public files. When a new version takes over it deletes older caches but keeps the previous version's, so a tab still running it can load its files until it reloads.
- The install fails, and the old version stays, if any file comes back with an error or as HTML in place of a script (Cloudflare answers a missing `/assets` file with the page and a 200). `sw.js` must not import other chunks, since it is registered as a classic script; the build fails if it does.
- Kill switch: if a deployed service worker misbehaves, replace it with `web/scripts/sw-kill-switch.js`, served at the same `/sw.js`. It takes over at once, deletes the `freecan-studio-*` caches, unregisters itself and reloads the tabs it controlled, which then load from the network. To ship it, add `cp scripts/sw-kill-switch.js dist/sw.js` after `npm run build` in `scripts/build-cloudflare.sh`, and remove the `registerServiceWorker` call from `web/src/main.tsx` so pages stop registering a worker. Keep the kill switch deployed until users have picked it up (days to weeks), then restore both.
- To check offline use locally: `pnpm build`, then `pnpm exec vite preview --port 5352`, open the page once, stop the server and reload. The service worker is never registered by `pnpm dev`.
- The app icons in `web/public/icons` are rendered from `web/public/favicon.svg` (the Twisted F, as in `site/public`) by `node scripts/icons.mjs` in `web/`, which uses headless Chrome (set `CHROME` to its path if it is not in `/Applications`).
