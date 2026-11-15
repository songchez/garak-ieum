#!/bin/sh
# One-command Rust setup for macOS / Linux (docs/RUST.md).
#   sh scripts/setup-rust.sh [--skip-verify]
# Installs rustup from sh.rustup.rs (rust-lang's official installer) if missing, then exactly the
# toolchain pinned in rust/rust-toolchain.toml, and verifies with `cargo test`. Safe to re-run.
# Windows: use scripts/setup-rust.ps1 instead.
set -eu

case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    echo "On Windows run: powershell -ExecutionPolicy Bypass -File scripts/setup-rust.ps1" >&2
    exit 1 ;;
esac

verify=1
[ "${1:-}" = "--skip-verify" ] && verify=0

repo=$(cd "$(dirname "$0")/.." && pwd)
cargo_bin="${CARGO_HOME:-$HOME/.cargo}/bin"
PATH="$cargo_bin:$PATH"
export PATH

if [ "$(uname -s)" = "Darwin" ] && ! xcode-select -p >/dev/null 2>&1; then
  echo "Rust links with Apple's command line tools. Run: xcode-select --install  (then re-run this script)" >&2
  exit 1
fi
if ! command -v cc >/dev/null 2>&1; then
  echo "A C linker (cc) is required: install gcc or clang with your package manager." >&2
  exit 1
fi

if ! command -v rustup >/dev/null 2>&1; then
  echo "Installing rustup from https://sh.rustup.rs ..."
  # No default toolchain: the pinned one is installed below. Minimal profile keeps it small.
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain none --profile minimal
fi

cd "$repo/rust"
echo "Installing the pinned toolchain from rust/rust-toolchain.toml ..."
rustup toolchain install || rustup show active-toolchain
rustc --version
cargo --version
rustup target list --installed | grep -qx wasm32-unknown-unknown || rustup target add wasm32-unknown-unknown

if [ "$verify" = 1 ]; then
  echo "Verifying: cargo test --workspace"
  cargo test --workspace --quiet
fi

echo
echo "Rust is ready. Daily commands: pnpm rust:test | pnpm rust:wasm | pnpm rust:check"
echo "Open a new shell (or run: . \"\${CARGO_HOME:-\$HOME/.cargo}/env\") to use cargo directly."
