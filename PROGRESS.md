# Progress

This file records the current checked-in state only. Historical investigation detail lives in
`docs/real-rustc-history.md`.

## Current state

- `wasm-rust` now uses the real-rustc split browser pipeline in `src/`.
- The standalone Chromium harness succeeds end to end without `wasm-idle`.
- `wasm-idle` now consumes the returned Rust artifact through `browser_wasi_shim` on its Rust worker
  path instead of the generic `App` host.
- The shipped module returns a runnable WASI `wasm` artifact through the browser compiler contract.
- The internal compile/thread workers now use direct same-origin module workers instead of `blob:`
  wrappers so deployed pages with stricter CSP do not fail at browser worker bootstrap.
- Browser retries are now surfaced as visible warnings with the retry reason instead of only debug
  transitions into attempts `2/5`, `3/5`, and so on.
- `dist/` is the distributable output:
  - `dist/index.js`
  - `dist/compiler-worker.js`
  - `dist/rustc-thread-worker.js`
  - `dist/runtime/runtime-manifest.json`

## Last verified results

Validated command:

```bash
cd /home/seorii/dev/hancomac/wasm-rust
pnpm run validate:standalone-browser
```

Latest verified outcome:

- `build` passed
- targeted `vitest` and real-browser regressions passed
- Playwright Chromium harness probe passed
- Vitest real-browser harness passed
- direct Playwright integration test passed
- final browser result:
  - `compile.success: true`
  - `compile.hasWasm: true`
  - `runtime.exitCode: 0`
  - `runtime.stdout: "hi\n"`
- the linked `wasm-idle` localhost route also succeeded with line-based stdin on Enter alone for the
  default Rust sample and without requiring EOF

## Known limitation

The browser-hosted `rustc.wasm` worker still has intermittent LLVM-worker failures, including:

- `memory access out of bounds`
- `operation does not support unaligned accesses`

Current product behavior:

- the compiler retries transient failures up to `5` attempts
- mirrored `.no-opt.bc` recovery plus `llvm-wasm` linking is what makes the standalone browser path
  reliable enough today

## Next decision

- Decide whether the current retry-based stabilization is acceptable as the long-term `wasm-idle`
  integration story.
- If not, keep reducing the underlying browser-rustc LLVM-worker failure rate.

## Related docs

- `README.md`
- `docs/browser-compiler.md`
- `docs/reproduction.md`
- `docs/real-rustc-history.md`
