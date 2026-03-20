import { describe, expect, it } from 'vitest';

import { loadRuntimeManifest, parseRuntimeManifest } from '../src/runtime-manifest.js';
import { createRuntimeManifest } from './helpers.js';

describe('runtime manifest edge cases', () => {
	it('rejects malformed runtime manifest fields', () => {
		expect(() =>
			parseRuntimeManifest({
				...createRuntimeManifest(),
				rustcWasm: ''
			})
		).toThrow(/invalid rustcWasm/);

		expect(() =>
			parseRuntimeManifest({
				...createRuntimeManifest(),
				rustcMemory: {
					initialPages: 8,
					maximumPages: 0
				}
			})
		).toThrow(/invalid rustcMemory.maximumPages/);

		expect(() =>
			parseRuntimeManifest({
				...createRuntimeManifest(),
				link: {
					...createRuntimeManifest().link,
					args: ['-o', '']
				}
			})
		).toThrow(/invalid link.args/);

		expect(() =>
			parseRuntimeManifest({
				...createRuntimeManifest(),
				sysrootFiles: [{ asset: '', runtimePath: '/libstd.rlib' }]
			})
		).toThrow(/invalid sysrootFiles\[0\]\.asset/);
	});

	it('fails when runtime-manifest fetch returns a non-ok response', async () => {
		await expect(
			loadRuntimeManifest('https://example.com/runtime-manifest.json', async () => ({
				ok: false
			}) as Response)
		).rejects.toThrow(
			'failed to load wasm-rust runtime manifest from https://example.com/runtime-manifest.json'
		);
	});
});
