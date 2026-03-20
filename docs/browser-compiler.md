# Browser compiler

This document records the stable knowledge discovered while moving `wasm-rust` from a placeholder
compiler to a real browser-hosted `rustc.wasm` pipeline.

## Current architecture

`wasm-rust` now uses a split browser pipeline:

1. `src/compiler.ts`
   - top-level browser API surface
   - owns retries for transient browser-rustc failures
   - watches the shared mirrored `.no-opt.bc` buffer
2. `src/compiler-worker.ts`
   - launches the packaged `rustc.wasm`
   - creates the shared memory and preopened filesystem
   - starts the pooled rustc thread workers
   - uses direct same-origin module workers instead of `blob:` wrappers so stricter deployed CSP
     pages do not fail with a generic `worker script error`
3. `src/rustc-thread-worker.ts`
   - runs rustc wasm helper threads
   - reuses the shared pool for nested rustc thread spawns
4. `src/rustc-runtime.ts`
   - browser WASI host setup
   - mirrored bitcode inode preservation across rename/reopen paths
5. `src/browser-linker.ts`
   - links mirrored `.no-opt.bc` through packaged `llvm-wasm` `llc` + `lld`
   - returns final WASI `wasm`
6. `scripts/prepare-runtime.mjs`
   - packages the runtime assets into `dist/runtime/`
   - patches the shipped `rustc.wasm` memory maximum
   - generates the runtime link manifest

## Invariants

These are required for the browser path to work.

- The runtime must be cross-origin isolated.
  - `SharedArrayBuffer` and wasm threads are mandatory.
  - The standalone harness server sets COOP/COEP for this reason.
- The packaged `rustc.wasm` memory import maximum must match the runtime manifest.
  - Current packaged values:
    - initial pages: `8192`
    - maximum pages: `65536`
- The packaged runtime manifest must allow enough wall-clock time for real browser rustc startup.
  - Current packaged compile timeout: `120000ms`
- The mirrored bitcode file must survive:
  - direct rename into `/work/<bitcode>`
  - rename through the root preopen
  - rename after reopening `/work`
- The browser linker manifest must contain only materialized files.
  - `-L` directories stay in link args only.
  - directory-only entries in `link.files` cause browser fetch failures.

## Why the split backend exists

The browser frontend uses real `rustc.wasm`, but final code generation is not delegated to the old
browser clang/lld stack already present in `wasm-idle`.

Known reason:

- that stack is too old for Rust 1.79 LLVM IR
- the old browser clang/lld path fails on:
  - LLVM bitcode version mismatch
  - opaque-pointer-era textual LLVM IR

That is why the checked-in browser backend is:

- packaged `llvm-wasm` `llc`
- packaged `llvm-wasm` `lld`

## Browser-specific instability

The real browser-hosted `rustc.wasm` still has a transient failure mode:

- LLVM worker threads may throw `memory access out of bounds`
- this can happen before or during optimization/summary passes
- the failure is intermittent

Observed recovery behavior:

- rustc often still mirrors `.no-opt.bc` before the worker failure becomes terminal
- `llvm-wasm` can link that mirrored bitcode into runnable wasm
- retrying the browser rustc attempt materially improves success rate

Shipped mitigation:

- `src/compiler.ts` retries transient browser failures up to `5` attempts
- retries are currently triggered for:
  - `memory access out of bounds`
  - `browser rustc timed out before producing LLVM bitcode`
  - transient metadata decode / invalid-rlib panic surfaces such as:
    - `invalid enum variant tag while decoding`
    - `found invalid metadata files for crate`
    - `failed to parse rlib`
- helper-worker/transient retry diagnostics are now emitted as visible warnings with the retry
  reason
  - successful consumers should not surface those recovered internal failures as user-visible
    terminal errors
- when `compile({ log: true })` is used, compile-time browser-rustc log lines are returned through
  `result.stdout`
  - this includes high-level retry reasons and forwarded `compiler-worker` progress lines
  - consumers can print that stdout directly in their terminal surface without scraping browser
    console output
- successful recovered compiles also drop recovered compiler `stderr`
  - user-facing terminals should only show the final program output, not transient LLVM worker crash text

This is an intentional product behavior, not just a probe-only trick.

## Consumer-facing behavior

The browser retry path is now part of the consumer contract:

- compile retries are visible as warnings with the retry reason
- recovered internal worker failures should not be forwarded into user-facing program output
- a final `success: true` compile result is the only outcome the consumer should treat as decisive

For consumer-side stdin behavior:

- `wasm-rust` only produces the artifact
- line-based stdin vs EOF-based stdin depends on the consumer runtime and the Rust program
- the linked `wasm-idle` route now uses a line-based Rust sample by default so Enter alone is enough
  for the built-in example, while still exposing explicit EOF for read-to-end programs

## Latest standalone validation evidence

Latest fully-owned validation command:

```bash
cd /home/seorii/dev/hancomac/wasm-rust
pnpm run validate:standalone-browser
```

Latest observed outcome:

- `build` passed
- `vitest` passed with `16` files and `43` tests
- Playwright Chromium harness probe passed
- Vitest real-browser harness passed
- final browser result:
  - `compile.success: true`
  - `compile.hasWasm: true`
  - `compile.hasWat: false`
  - `runtime.exitCode: 0`
  - `runtime.stdout: "hi\n"`

Important observation from the same successful run:

- attempt `1/5` still hit transient browser-hosted LLVM worker failures
- observed failure texts included:
  - `memory access out of bounds`
  - `operation does not support unaligned accesses`
- despite that, the compiler mirrored `.no-opt.bc`, retried, and completed successfully on the next attempt

Observed recovery markers from the successful browser run:

- the worker logged `browser rustc attempt 1/5 failed; retrying reason=...`
- the shared mirror logged `mirrored artifact updated seq=2 bytes=4996 overflowed=false`
- the linker logged `mirrored bitcode settled; linking through llvm-wasm`

This confirms the current product behavior:

- transient browser-rustc worker faults are still expected
- the shipped retry plus mirrored-bitcode recovery path is what makes the standalone browser compile reliable enough today

Minor harness note:

- a `favicon.ico` `404` still appears in the browser probe console
- it is currently harmless and does not affect compile/run correctness

## Standalone browser validation surface

`wasm-rust` now owns a standalone browser validation path independent of `wasm-idle`.

Files:

- `browser-harness/index.html`
- `browser-harness/harness.js`
- `scripts/browser-harness-server.mjs`
- `scripts/probe-browser-harness.mjs`
- `test/browser-harness.test.ts`

What it proves:

- the shipped `/dist` module can compile Rust in Chromium
- the returned artifact is executable in-browser through WASI
- the minimal regression target `fn main() { println!("hi"); }` prints `hi\n`
- consumer-side browser regressions can also pin line-based stdin behavior without requiring EOF

## Accepted current state

What is now proven:

- browser compile+run succeeds inside Chromium without `wasm-idle`
- the shipped module returns `wasm`
- the standalone browser harness and Vitest browser regression both pass

What is still true:

- success currently relies on retrying around intermittent browser-rustc LLVM worker failures
- that is acceptable for `wasm-rust` standalone validation today
- consumer reintegration should treat that retry-based recovery as a conscious tradeoff
- consumers should prefer a preview1-compatible WASI host such as `browser_wasi_shim` for the returned
  Rust artifact; `wasm-idle` now does that on its Rust-specific path
