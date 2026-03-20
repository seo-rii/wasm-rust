import { describe, expect, it } from 'vitest';

import {
	loadRuntimeManifest,
	normalizeRuntimeManifest,
	parseRuntimeManifest,
	resolveTargetManifest
} from '../src/runtime-manifest.js';
import { createRuntimeManifest, createRuntimeManifestV2 } from './helpers.js';

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

	it('rejects malformed v2 target fields', () => {
		expect(() =>
			parseRuntimeManifest({
				...createRuntimeManifestV2(),
				defaultTargetTriple: 'wasm32-wasi'
			})
		).toThrow(/invalid defaultTargetTriple/);

		expect(() =>
			parseRuntimeManifest({
				...createRuntimeManifestV2(),
				targets: {
					...createRuntimeManifestV2().targets,
					'wasm32-wasip2': {
						...createRuntimeManifestV2().targets['wasm32-wasip2'],
						artifactFormat: 'wasm'
					}
				}
			})
		).toThrow(/invalid targets\.wasm32-wasip2\.artifactFormat/);
	});

	it('fails to resolve an unavailable target from the normalized manifest', () => {
		const manifest = normalizeRuntimeManifest(
			parseRuntimeManifest({
				...createRuntimeManifestV2(),
				targets: {
					'wasm32-wasip1': createRuntimeManifestV2().targets['wasm32-wasip1']
				}
			})
		);

		expect(() => resolveTargetManifest(manifest, 'wasm32-wasip2')).toThrow(
			/unsupported wasm-rust target wasm32-wasip2/
		);
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
