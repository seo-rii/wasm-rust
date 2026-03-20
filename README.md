# wasm-rust

`wasm-rust` is a browser-loadable ESM Rust compiler module.

It is designed to be consumed by `wasm-idle`, but it also owns its own standalone browser harness and
validation flow. The compiler uses a real `rustc.wasm` frontend and a packaged `llvm-wasm`
`llc`/`lld` backend to return a runnable WASI `wasm` artifact.

## Status

- Browser compile and run works in Chromium.
- The minimal regression target `fn main() { println!("hi"); }` compiles in the browser and prints
  `hi\n`.
- The result is returned through the `wasm-idle` browser compiler contract:
  - module exports `default` and `createRustCompiler`
  - factory returns `{ compile(request) }`
  - `compile()` resolves to `{ success, stdout?, stderr?, diagnostics?, artifact }`
  - `artifact` currently contains `wasm`

Current scope:

- single-file `bin`
- editions `2021` and `2024`
- target `wasm32-wasip1`
- no Cargo dependency resolution
- cross-origin-isolated browser environment required

## Quick start

Build the shipped runtime bundle:

```bash
cd /home/seorii/dev/hancomac/wasm-rust
pnpm build
```

Run the full standalone validation sequence:

```bash
cd /home/seorii/dev/hancomac/wasm-rust
pnpm run validate:standalone-browser
```

That command runs:

1. `pnpm build`
2. `pnpm test`
3. `pnpm run probe:browser-harness`
4. `WASM_RUST_RUN_REAL_BROWSER_HARNESS=1 pnpm exec vitest run test/browser-harness.test.ts`
5. `WASM_RUST_RUN_REAL_BROWSER_HARNESS=1 pnpm exec vitest run test/browser-playwright-integration.test.ts`

Latest verified browser result:

- `compile.success: true`
- `compile.hasWasm: true`
- `runtime.exitCode: 0`
- `runtime.stdout: "hi\n"`

## API

The published browser module exports `default` and `createRustCompiler`.

```ts
import createRustCompiler from './dist/index.js';

const compiler = await createRustCompiler();
const result = await compiler.compile({
	code: 'fn main() { println!("hi"); }',
	edition: '2021',
	crateType: 'bin'
});
```

Result shape:

```ts
{
  success: boolean;
  stdout?: string;
  stderr?: string;
  diagnostics?: Array<{
    lineNumber: number;
    columnNumber: number;
    severity: 'error' | 'warning' | 'other';
    message: string;
  }>;
  artifact?: {
    wasm?: Uint8Array | ArrayBuffer;
    wat?: string;
  };
}
```

## How it works

1. `rustc.wasm` compiles Rust source in a browser worker.
2. The worker mirrors the emitted `.no-opt.bc` into shared memory.
3. `llvm-wasm` `llc` and `lld` lower and link that bitcode in the browser.
4. The final WASI `wasm` artifact is returned to the caller.

Important runtime notes:

- `SharedArrayBuffer` and wasm threads are required.
- The shipped browser harness serves COOP/COEP headers for that reason.
- The compiler currently retries transient browser-rustc worker failures up to five attempts.
- Retry transitions are intentionally surfaced as warnings with the retry reason.
- Internal worker assets are spawned as direct same-origin module workers, not `blob:` wrappers.
  This avoids deployment-only CSP failures that otherwise show up as a generic `worker script error`.
- Successful compile results are still authoritative even if one or more transient browser-rustc
  retries happened beforehand.

## Standalone browser harness

Serve the standalone harness:

```bash
cd /home/seorii/dev/hancomac/wasm-rust
pnpm run serve:browser-harness
```

Probe it with Chromium:

```bash
cd /home/seorii/dev/hancomac/wasm-rust
pnpm run probe:browser-harness
```

## Scripts

- `pnpm build`
  - builds TypeScript and prepares runtime assets under `dist/runtime/`
- `pnpm test`
  - runs the normal test suite
- `pnpm run validate:standalone-browser`
  - full repo-owned browser validation
- `pnpm run serve:browser-harness`
  - local COOP/COEP harness server
- `pnpm run probe:browser-harness`
  - Playwright Chromium probe for the harness
- `pnpm run test:browser:playwright`
  - direct Vitest integration test that launches Playwright/Chromium in-process
- `pnpm run probe:browser-rustc-llvm-wasm-split`
  - low-level browser split-pipeline probe
- `pnpm run probe:llvm-wasm-rust-split`
  - backend-only `llvm-wasm` link probe

## Project layout

- `src/`
  - browser compiler, runtime, workers, and linker
- `browser-harness/`
  - standalone debug and validation page
- `scripts/`
  - reproducible probes, server, and runtime preparation
- `test/`
  - unit, integration, and browser-facing regressions
- `docs/`
  - architecture notes and reproduction details

## Documentation

- [docs/browser-compiler.md](./docs/browser-compiler.md)
  - architecture, invariants, transient browser behavior, latest browser validation evidence
- [docs/consumer-integration.md](./docs/consumer-integration.md)
  - stable browser-consumer contract, runtime expectations, retry semantics, vendored-asset refresh flow
- [docs/reproduction.md](./docs/reproduction.md)
  - exact reproduction commands, cache/toolchain expectations, environment overrides
- [PROGRESS.md](./PROGRESS.md)
  - current verified state, open limitation, and next decision
- [docs/real-rustc-history.md](./docs/real-rustc-history.md)
  - historical real-rustc blocker chain and the remaining runtime limitation
