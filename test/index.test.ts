import { describe, expect, it } from 'vitest';

import createRustCompiler, { createRustCompiler as createNamedCompiler } from '../src/index.js';
import { FakeWorker, createRuntimeManifest, mirrorBitcode } from './helpers.js';

describe('wasm-rust compiler contract', () => {
	it('exports both default and named factory functions', async () => {
		const defaultCompiler = await createRustCompiler();
		const namedCompiler = await createNamedCompiler();

		expect(typeof defaultCompiler.compile).toBe('function');
		expect(typeof namedCompiler.compile).toBe('function');
	});

	it('links mirrored LLVM bitcode into a wasm artifact through injected dependencies', async () => {
		let clock = 0;
		const bitcode = new Uint8Array([1, 2, 3, 4]);
		const compiler = await createRustCompiler({
			dependencies: {
				loadManifest: async () => createRuntimeManifest(),
				createWorker: () =>
					new FakeWorker((message) => {
						mirrorBitcode(message.sharedBitcodeBuffer, bitcode);
					}),
				linkBitcode: async (receivedBitcode) => {
					expect(receivedBitcode).toEqual(bitcode);
					return new Uint8Array([9, 8, 7]);
				},
				now: () => clock,
				sleep: async (milliseconds) => {
					clock += milliseconds;
				}
			}
		});
		const result = await compiler.compile({
			code: 'fn main() { println!("hi"); }',
			edition: '2024',
			crateType: 'bin'
		});

		expect(result.success).toBe(true);
		expect(result.artifact?.wasm).toEqual(new Uint8Array([9, 8, 7]));
		expect(result.artifact?.wat).toBeUndefined();
	});
});
