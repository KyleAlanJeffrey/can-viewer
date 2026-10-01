# Contributing to FreeCAN Studio

FreeCAN Studio is a browser CAN bus log viewer and reverse-engineering tool. A Rust core (`crates/`) is compiled to WebAssembly and runs in a Web Worker; the React, Vite and TypeScript UI lives in `web/`. Read [README.md](README.md) for the layout, [PRODUCT.md](PRODUCT.md) for scope and [DESIGN.md](DESIGN.md) for the design system before making a change.

Related: [VERSIONING.md](VERSIONING.md), [COMPATIBILITY.md](COMPATIBILITY.md), [API.md](API.md).

## Prerequisites

- Rust stable, installed with `rustup`.
- The wasm target: `rustup target add wasm32-unknown-unknown`.
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

For a bigger demo log, run the two demo steps by hand with a frame count:

```bash
cd web
cargo run --release -p sample-gen -- generate ../target/demo/demo.log public/demo/demo.dbc 10000000
node scripts/gzip.mjs ../target/demo/demo.log public/demo/demo.log.gz
```

## Checks

Run the checks for the areas you touched before opening a pull request. From the repository root:

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets
cargo test --workspace
cd web && npx tsc -b
```

- Fix any clippy warning your change introduces.
- There are no automated UI tests yet. Check UI changes by hand in `pnpm dev`, including keyboard use and focus.
- If you change the DBC decoder, cross-check it against cantools (`pip install cantools`, after `pnpm demo`):

```bash
cargo run --release -p sample-gen -- decode target/demo/demo.log web/public/demo/demo.dbc 300000 > /tmp/ours.csv
python scripts/crosscheck_cantools.py target/demo/demo.log web/public/demo/demo.dbc /tmp/ours.csv 300000
```

If you could not run a check, say which one and why in the pull request.

## Branches and commits

- Branch names never contain `/`. Use `-` instead: `feat-asc-parser`, `fix-trace-scroll`.
- Commit messages follow [Conventional Commits 1.0](https://www.conventionalcommits.org/en/v1.0.0/#specification): `<type>(<optional scope>): <description>`.
  - Types: `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `build`, `ci`, `style`, `chore`.
  - Useful scopes are crate or view names: `core`, `formats`, `dbc`, `wasm`, `sample-gen`, `web`, `overview`, `trace`, `plot`, `reverse`, `database`.
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
| `web/src/styles.css` | Design tokens and shared styles |

Views live in `web/src/views/<view>/` with their own CSS file and class prefix: `overview/overview.css` uses `ov-`, `plot/plot.css` uses `pv-`, `reverse/reverse.css` uses `re-` and `database/database.css` uses `db-`. To add a view:

1. Create `web/src/views/<view>/` with its component and stylesheet, using a new class prefix.
2. Register it in `VIEWS` in `web/src/views/index.ts`.
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
- That script installs Rust stable, the wasm target and wasm-pack 0.15.0 when they are missing, then in `web/` runs `pnpm install --frozen-lockfile` (through `npx` when pnpm isn't installed), then the `wasm`, `demo` and `build` scripts. It is safe to run locally to reproduce a deploy build.
- The install fails if `web/pnpm-lock.yaml` is out of step with `web/package.json`, so commit them together.
- `web/public/_headers` is copied into `web/dist` and sets the Content-Security-Policy and long-lived caching for `/assets/*`. Every asset must be under Cloudflare's 25 MiB per-file limit.
