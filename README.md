# wasm-rust

`wasm-rust` is a browser-loadable ESM Rust compiler module.

It is designed to be consumed by `wasm-idle`, but it also owns its own standalone browser harness and
validation flow. The compiler uses a real `rustc.wasm` frontend and a packaged `llvm-wasm`
`llc`/`lld` backend to return either a runnable preview1 core wasm artifact (`wasm32-wasip1`) or a
preview2 component artifact (`wasm32-wasip2`).

## Status

- Browser compile and run works in Chromium.
- The minimal regression target `fn main() { println!("hi"); }` compiles in the browser and prints
  `hi\n`.
- Browser compile and run is verified for both `wasm32-wasip1` and `wasm32-wasip2`.
- The result is returned through the `wasm-idle` browser compiler contract:
  - module exports `default` and `createRustCompiler`
  - factory returns `{ compile(request) }`
  - `compile()` resolves to `{ success, stdout?, stderr?, diagnostics?, artifact }`
  - `artifact` contains `wasm`, `targetTriple`, and `format`

Current scope:

- single-file `bin`
- editions `2021` and `2024`
- targets `wasm32-wasip1` and `wasm32-wasip2`
- no Cargo dependency resolution
- cross-origin-isolated browser environment required

## Quick start

Build the shipped runtime bundle:

```bash
cd /home/seorii/dev/hancomac/wasm-rust
pnpm build
```

Package the dual-target runtime bundle, including `wasm32-wasip2`:

```bash
cd /home/seorii/dev/hancomac/wasm-rust
WASM_RUST_WASI_SDK_ROOT=/path/to/wasi-sdk-22-or-newer \
pnpm run prepare:runtime:wasip2
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
	crateType: 'bin',
	targetTriple: 'wasm32-wasip2'
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
    targetTriple: 'wasm32-wasip1' | 'wasm32-wasip2';
    format: 'core-wasm' | 'component';
  };
}
```

## How it works

1. `rustc.wasm` compiles Rust source in a browser worker.
2. The worker mirrors the emitted `.no-opt.bc` into shared memory.
3. `llvm-wasm` `llc` and `lld` lower and link that bitcode in the browser.
4. The final artifact is returned to the caller as either preview1 core wasm or a preview2
   component, depending on `targetTriple`.

Important runtime notes:

- `SharedArrayBuffer` and wasm threads are required.
- The shipped browser harness serves COOP/COEP headers for that reason.
- The compiler currently retries transient browser-rustc worker failures up to five attempts.
- Retry transitions are intentionally surfaced as visible warnings.
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
- `pnpm run release:upload -- --tag <tag> [asset...]`
  - uploads one or more assets to a GitHub release with `gh`, and can create the release first
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

## GitHub release upload

Upload one or more release assets with `gh`:

```bash
cd /home/seorii/dev/hancomac/wasm-rust
pnpm run release:upload -- --tag v0.1.0 ./dist/runtime/runtime-manifest.json
```

Create the release at the latest local commit and tag it:

```bash
cd /home/seorii/dev/hancomac/wasm-rust
pnpm run release:upload -- --tag v0.1.0 --create-release
```

Package `dist/` and upload it in one step:

```bash
cd /home/seorii/dev/hancomac/wasm-rust
pnpm run release:upload -- --tag v0.1.0 --create-release --build --pack-dist
```

Notes:

- `--create-release` tags the latest local `HEAD` commit by default.
- Use `--target <ref>` to create the release from a different commit or branch.
- Use `--repo owner/name` if `origin` does not point at the upload target.
- Use `--clobber` to replace an existing asset with the same name.

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
