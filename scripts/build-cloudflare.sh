#!/bin/sh
# Builds web/dist for Cloudflare (see wrangler.jsonc). The Workers Builds image has Node but no
# Rust, so rustup, the wasm target and wasm-pack are installed when missing. Also runs on macOS.
set -eu

WASM_PACK_VERSION=0.15.0
PNPM_VERSION=10.18.2

cd "$(dirname "$0")/.."

if ! command -v cargo >/dev/null 2>&1; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable
  . "$HOME/.cargo/env"
fi
if command -v rustup >/dev/null 2>&1; then
  rustup target add wasm32-unknown-unknown
else
  echo "rustup not found; make sure your Rust has the wasm32-unknown-unknown target." >&2
fi

if ! command -v wasm-pack >/dev/null 2>&1; then
  # SHA-256s from https://github.com/wasm-bindgen/wasm-pack/releases/tag/v0.15.0
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64) target=x86_64-unknown-linux-musl sha=c09f971ecaed9a2efc80fdcea7a00ef6b53c7fadc8c57d1f61b53a6aa66b668a ;;
    Linux-aarch64 | Linux-arm64) target=aarch64-unknown-linux-musl sha=e17ef0806381c3a0acb9c9ddad643a49facaa5a2ecf657a421d4d8f3357a24b7 ;;
    Darwin-x86_64) target=x86_64-apple-darwin sha=d3f1a4a33e95f8f0d7801b024e08624c479999ac96aa150908b2394015cd0363 ;;
    Darwin-arm64) target=aarch64-apple-darwin sha=0abff4a03d670b6c00ea31d0e1608a72407e355f3d3765e9c30eb45cd5b7e318 ;;
    *) echo "No wasm-pack release for $(uname -s) $(uname -m). Install it with: cargo install wasm-pack" >&2; exit 1 ;;
  esac
  name="wasm-pack-v$WASM_PACK_VERSION-$target"
  tmp="$(mktemp -d)"
  curl --proto '=https' --tlsv1.2 -sSfL -o "$tmp/$name.tar.gz" \
    "https://github.com/wasm-bindgen/wasm-pack/releases/download/v$WASM_PACK_VERSION/$name.tar.gz"
  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$tmp/$name.tar.gz" | cut -d ' ' -f 1)"
  else
    actual="$(shasum -a 256 "$tmp/$name.tar.gz" | cut -d ' ' -f 1)"
  fi
  if [ "$actual" != "$sha" ]; then
    echo "The wasm-pack download doesn't match its checksum." >&2
    exit 1
  fi
  tar -xzf "$tmp/$name.tar.gz" -C "$tmp"
  mkdir -p "$HOME/.cargo/bin"
  mv "$tmp/$name/wasm-pack" "$HOME/.cargo/bin/wasm-pack"
  rm -rf "$tmp"
  export PATH="$HOME/.cargo/bin:$PATH"
fi

cd web
# The lockfile is pnpm's. npm can still run the package scripts.
if command -v pnpm >/dev/null 2>&1; then
  pnpm install --frozen-lockfile
else
  npx --yes "pnpm@$PNPM_VERSION" install --frozen-lockfile
fi
npm run wasm
npm run demo
npm run build
