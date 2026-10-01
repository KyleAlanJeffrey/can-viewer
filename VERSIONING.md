# Versioning

FreeCAN Studio follows [Semantic Versioning 2.0.0](https://semver.org/). The web UI, the Rust crates and the CoreApi worker contract share one version.

## Source of truth

`VERSION` at the repository root holds the current version: one line, no `v` prefix. It must match:

- `version` under `[workspace.package]` in `Cargo.toml`. Every crate inherits it through `version.workspace = true`.
- `web/package.json`, if it ever carries a version. Today it has no `version` field (the package is private and never published), so there is nothing to update there. If one is added, keep it equal to `VERSION`.

Check the two that exist:

```bash
test "$(cat VERSION)" = "$(sed -n 's/^version = "\(.*\)"$/\1/p' Cargo.toml)" && echo ok
```

## What each number means

**MAJOR** - a change that breaks something users or the other CoreApi implementation rely on:

- Any change to the CoreApi contract in `web/src/core/api.ts`: a method or type added, removed or renamed, or changed in shape, units or meaning. This includes the packed row layout in `web/src/core/rows.ts`. See [COMPATIBILITY.md](COMPATIBILITY.md#coreapi).
- Dropping a supported log format, DBC feature or browser.
- A change that stops a saved session from an earlier version restoring.

**MINOR** - a new user-facing capability that leaves the CoreApi unchanged, such as a new view or a new export.

**PATCH** - bug fixes, performance work, and copy or style fixes that change neither the CoreApi nor what the app accepts.

While the major version is 0, a breaking change bumps MINOR and everything else bumps PATCH.

Conventional Commit types map onto this:

- `fix:` or `perf:` -> PATCH.
- `feat:` -> MINOR.
- `!` after the type or scope, or a `BREAKING CHANGE:` footer -> MAJOR (MINOR before 1.0.0).
- `docs:`, `refactor:`, `test:`, `build:`, `ci:`, `style:` and `chore:` alone do not call for a release.

## Cutting a release

1. Branch from `main` with a name like `release-v0.2.0`. Branch names never contain `/`.
2. Write the new version to `VERSION` and to `[workspace.package] version` in `Cargo.toml`.
3. Run `cargo test --workspace`. Cargo records the new crate versions in `Cargo.lock`; commit that too.
4. Commit with the message `chore(release): vX.Y.Z`.
5. Open a pull request. Once it merges, tag the merge commit on `main` and push the tag:

```bash
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin vX.Y.Z
```
