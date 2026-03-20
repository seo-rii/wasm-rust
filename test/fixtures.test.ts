import { describe, expect, it } from 'vitest';

import {
	loadRuntimeManifest,
	parseRuntimeManifest,
	resolveRuntimeAssetUrl
} from '../src/runtime-manifest.js';
import { createRuntimeManifest } from './helpers.js';

describe('wasm-rust runtime manifest', () => {
	it('parses the generated manifest shape', () => {
		const manifest = parseRuntimeManifest(createRuntimeManifest());

		expect(manifest.targetTriple).toBe('wasm32-wasip1');
		expect(manifest.workerBitcodeFile.endsWith('.no-opt.bc')).toBe(true);
		expect(manifest.link.args).toContain('/work/main.wasm');
	});

	it('resolves asset URLs relative to the runtime base URL', () => {
		expect(
			resolveRuntimeAssetUrl('https://example.com/wasm-rust/runtime/', 'llvm/lld.js')
		).toBe('https://example.com/wasm-rust/runtime/llvm/lld.js');
	});

	it('loads and validates the manifest through fetch', async () => {
		const manifest = createRuntimeManifest();
		const loaded = await loadRuntimeManifest('https://example.com/runtime-manifest.json', async () => ({
			ok: true,
			json: async () => manifest
		}) as Response);

		expect(loaded.version).toBe(manifest.version);
		expect(loaded.sysrootFiles[0]?.asset).toBe(manifest.sysrootFiles[0]?.asset);
	});
});
