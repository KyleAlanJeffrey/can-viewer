#!/bin/sh
# Builds web/dist for Cloudflare (see wrangler.jsonc). The Workers Builds image has Node but no
# Rust, so rustup, the wasm target and wasm-pack are installed when missing. Safe to run locally.
set -eu

WASM_PACK_VERSION=0.15.0
PNPM_VERSION=10.18.2

cd "$(dirname "$0")/.."

if ! command -v cargo >/dev/null 2>&1; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable
  . "$HOME/.cargo/env"
fi
rustup target add wasm32-unknown-unknown

if ! command -v wasm-pack >/dev/null 2>&1; then
  case "$(uname -m)" in
    x86_64) arch=x86_64 ;;
    aarch64 | arm64) arch=aarch64 ;;
    *) echo "No wasm-pack release for $(uname -m)" >&2; exit 1 ;;
  esac
  name="wasm-pack-v$WASM_PACK_VERSION-$arch-unknown-linux-musl"
  curl --proto '=https' --tlsv1.2 -sSfL \
    "https://github.com/wasm-bindgen/wasm-pack/releases/download/v$WASM_PACK_VERSION/$name.tar.gz" | tar -xz -C /tmp
  mkdir -p "$HOME/.cargo/bin"
  mv "/tmp/$name/wasm-pack" "$HOME/.cargo/bin/wasm-pack"
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
