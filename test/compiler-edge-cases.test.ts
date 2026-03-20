import { afterEach, describe, expect, it, vi } from 'vitest';

import { compileRust } from '../src/compiler.js';
import { FakeWorker, createRuntimeManifest, mirrorBitcode } from './helpers.js';

describe('wasm-rust compiler edge cases', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('rejects an empty source file before doing any runtime work', async () => {
		const loadManifest = vi.fn(async () => createRuntimeManifest());
		const createWorker = vi.fn(() => new FakeWorker());

		const result = await compileRust(
			{
				code: '   ',
				edition: '2024',
				crateType: 'bin'
			},
			{
				loadManifest,
				createWorker
			}
		);

		expect(result.success).toBe(false);
		expect(result.stderr).toContain('requires a non-empty Rust source file');
		expect(loadManifest).not.toHaveBeenCalled();
		expect(createWorker).not.toHaveBeenCalled();
	});

	it('fails fast when SharedArrayBuffer worker prerequisites are unavailable', async () => {
		const originalSharedArrayBuffer = globalThis.SharedArrayBuffer;
		vi.stubGlobal('SharedArrayBuffer', undefined);

		try {
			const result = await compileRust({
				code: 'fn main() { println!("hi"); }',
				edition: '2024',
				crateType: 'bin'
			});

			expect(result.success).toBe(false);
			expect(result.stderr).toContain('cross-origin-isolated worker environment');
		} finally {
			vi.stubGlobal('SharedArrayBuffer', originalSharedArrayBuffer);
		}
	});

	it('returns the llvm-wasm linker error when mirrored bitcode exists but linking fails', async () => {
		const bitcode = new Uint8Array([0x42, 0x43, 0xc0, 0xde]);
		const worker = new FakeWorker((message) => {
			mirrorBitcode(message.sharedBitcodeBuffer, bitcode);
		});

		const result = await compileRust(
			{
				code: 'fn main() { println!("hi"); }',
				edition: '2024',
				crateType: 'bin'
			},
			{
				loadManifest: async () => createRuntimeManifest(),
				createWorker: () => worker,
				linkBitcode: async () => {
					throw new Error('lld failed to produce main.wasm');
				}
			}
		);

		expect(result.success).toBe(false);
		expect(result.stderr).toContain('llvm-wasm link failed');
		expect(result.stderr).toContain('lld failed to produce main.wasm');
	});

	it('stops after the fifth transient worker failure and returns the last failure', async () => {
		let createWorkerCalls = 0;

		const result = await compileRust(
			{
				code: 'fn main() { println!("hi"); }',
				edition: '2024',
				crateType: 'bin'
			},
			{
				loadManifest: async () =>
					createRuntimeManifest({
						compileTimeoutMs: 1_000,
						artifactIdleMs: 250
					}),
				createWorker: () => {
					createWorkerCalls += 1;
					return new FakeWorker((_, worker) => {
						worker.emitMessage({
							type: 'error',
							message: 'memory access out of bounds'
						});
					});
				},
				sleep: async () => {
					await Promise.resolve();
				}
			}
		);

		expect(result.success).toBe(false);
		expect(result.stderr).toContain('memory access out of bounds');
		expect(createWorkerCalls).toBe(5);
	});

	it('surfaces worker bootstrap filename and location when the browser error event has no message', async () => {
		let createWorkerCalls = 0;

		const result = await compileRust(
			{
				code: 'fn main() { println!("hi"); }',
				edition: '2024',
				crateType: 'bin'
			},
			{
				loadManifest: async () => createRuntimeManifest(),
				createWorker: () => {
					createWorkerCalls += 1;
					return new FakeWorker((_, currentWorker) => {
						currentWorker.emitErrorEvent({
							filename: 'http://example.test/wasm-rust/compiler-worker.js',
							lineno: 91,
							colno: 17
						});
					});
				},
				sleep: async () => {
					await Promise.resolve();
				}
			}
		);

		expect(result.success).toBe(false);
		expect(result.stderr).toContain('worker script error at');
		expect(result.stderr).toContain('compiler-worker.js:91:17');
		expect(result.stderr).toContain('[worker=');
		expect(createWorkerCalls).toBe(5);
	});

	it('includes the attempted worker URL when the browser only reports a generic script error', async () => {
		let createWorkerCalls = 0;

		const result = await compileRust(
			{
				code: 'fn main() { println!("hi"); }',
				edition: '2024',
				crateType: 'bin'
			},
			{
				loadManifest: async () => createRuntimeManifest(),
				createWorker: () => {
					createWorkerCalls += 1;
					return new FakeWorker((_, currentWorker) => {
						currentWorker.emitErrorEvent({
							message: 'worker script error'
						});
					});
				},
				sleep: async () => {
					await Promise.resolve();
				}
			}
		);

		expect(result.success).toBe(false);
		expect(result.stderr).toContain('worker script error');
		expect(result.stderr).toContain('[worker=');
		expect(result.stderr).toContain('compiler-worker.js');
		expect(createWorkerCalls).toBe(5);
	});
});
