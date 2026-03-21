#!/usr/bin/env bash
set -euo pipefail

ROOT="${WASM_RUST_CUSTOM_TOOLCHAIN_ROOT:-${WASM_RUST_REAL_RUSTC_ROOT:-$HOME/.cache/wasm-rust-custom-toolchain}}"
RUST_ROOT="${WASM_RUST_RUST_SOURCE_ROOT:-$ROOT/rust}"
CONFIG_PATH="${WASM_RUST_RUST_CONFIG:-$RUST_ROOT/config.wasm-rust-browser.toml}"
COMPILER_HOST_TARGET="${WASM_RUST_COMPILER_HOST_TARGET:-wasm32-wasip1-threads}"
INSTALL_TARGETS="${WASM_RUST_INSTALL_TARGETS:-x86_64-unknown-linux-gnu,wasm32-wasip1,wasm32-wasip2}"
LLVM_BUILD="${WASM_RUST_LLVM_BUILD_DIR:-$RUST_ROOT/build/$COMPILER_HOST_TARGET/llvm/build}"
BUILD_JOBS="${WASM_RUST_BUILD_JOBS:-8}"
LOG="${WASM_RUST_BUILD_LOG:-$ROOT/wasm-rust-custom-toolchain.log}"
PID="${WASM_RUST_BUILD_PID_FILE:-$ROOT/wasm-rust-custom-toolchain.pid}"
EXIT="${WASM_RUST_BUILD_EXIT_FILE:-$ROOT/wasm-rust-custom-toolchain.exit.txt}"

if [[ "${1:-}" != "--foreground" ]]; then
  mkdir -p "$ROOT"
  printf '%s\n' "NO_EXIT_STATUS_YET" > "$EXIT"
  nohup /bin/bash "$0" --foreground >/dev/null 2>&1 &
  child_pid=$!
  printf '%s\n' "$child_pid" > "$PID"
  printf '%s\n' "$child_pid"
  exit 0
fi

if [[ ! -d "$RUST_ROOT" ]]; then
  printf '[%s] missing rust source root: %s\n' "$(date -Is)" "$RUST_ROOT" >> "$LOG"
  printf '%s\n' "2" > "$EXIT"
  exit 2
fi

if [[ ! -f "$CONFIG_PATH" ]]; then
  printf '[%s] missing x.py config: %s\n' "$(date -Is)" "$CONFIG_PATH" >> "$LOG"
  printf '%s\n' "2" > "$EXIT"
  exit 2
fi

if [[ ! -d "$LLVM_BUILD" ]]; then
  printf '[%s] missing LLVM build dir: %s\n' "$(date -Is)" "$LLVM_BUILD" >> "$LOG"
  printf '%s\n' "2" > "$EXIT"
  exit 2
fi

status=0

if [[ "$INSTALL_TARGETS" == *"wasm32-wasip3"* ]]; then
  {
    printf '[%s] build-custom-rustc-toolchain: wasm32-wasip3 requested\n' "$(date -Is)"
    printf '[%s] build-custom-rustc-toolchain: note rustc docs say wasm32-wasip3 still needs a libc [patch] as of 2025-10-01; ensure your rust source/toolchain inputs already include that patch before expecting a usable sysroot\n' "$(date -Is)"
  } >> "$LOG"
fi

{
  printf '[%s] build-custom-rustc-toolchain: root=%s config=%s host=%s targets=%s\n' \
    "$(date -Is)" "$ROOT" "$CONFIG_PATH" "$COMPILER_HOST_TARGET" "$INSTALL_TARGETS"
  printf '[%s] build-custom-rustc-toolchain: resume target LLVM install\n' "$(date -Is)"
  cd "$LLVM_BUILD"
  DESTDIR="${WASM_RUST_INSTALL_DESTDIR:-}" cmake --build . --target install --config Release -- -j "$BUILD_JOBS"
} >> "$LOG" 2>&1 || status=$?

if [[ "$status" -eq 0 ]]; then
  {
    printf '[%s] build-custom-rustc-toolchain: resume rust install\n' "$(date -Is)"
    cd "$RUST_ROOT"
    ./x.py install --config "$CONFIG_PATH"
  } >> "$LOG" 2>&1 || status=$?
fi

printf '%s\n' "$status" > "$EXIT"
exit "$status"
