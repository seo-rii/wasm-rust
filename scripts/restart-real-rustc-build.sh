#!/usr/bin/env bash
set -euo pipefail

ROOT="${WASM_RUST_REAL_RUSTC_ROOT:-/home/seorii/.cache/wasm-rust-real-rustc-20260317}"
RUST_ROOT="$ROOT/rust"
LLVM_BUILD="$RUST_ROOT/build/wasm32-wasip1-threads/llvm/build"
LOG="$ROOT/wasm-rust-emit-ir-build.log"
PID="$ROOT/wasm-rust-emit-ir.pid"
EXIT="$ROOT/wasm-rust-emit-ir-exit.txt"

if [[ "${1:-}" != "--foreground" ]]; then
  printf '%s\n' "NO_EXIT_STATUS_YET" > "$EXIT"
  nohup /bin/bash "$0" --foreground >/dev/null 2>&1 &
  child_pid=$!
  printf '%s\n' "$child_pid" > "$PID"
  printf '%s\n' "$child_pid"
  exit 0
fi

if [[ ! -d "$LLVM_BUILD" ]]; then
  printf '[%s] missing LLVM build dir: %s\n' "$(date -Is)" "$LLVM_BUILD" >> "$LOG"
  printf '%s\n' "2" > "$EXIT"
  exit 2
fi

status=0

{
  printf '[%s] restart-real-rustc-build: resume target LLVM install\n' "$(date -Is)"
  cd "$LLVM_BUILD"
  DESTDIR= cmake --build . --target install --config Release -- -j 8
} >> "$LOG" 2>&1 || status=$?

if [[ "$status" -eq 0 ]]; then
  {
    printf '[%s] restart-real-rustc-build: resume rust install\n' "$(date -Is)"
    cd "$RUST_ROOT"
    ./x.py install --config config.wasm-rust-emit-ir.toml
  } >> "$LOG" 2>&1 || status=$?
fi

printf '%s\n' "$status" > "$EXIT"
exit "$status"
