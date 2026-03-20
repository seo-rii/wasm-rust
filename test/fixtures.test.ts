import { describe, expect, it } from 'vitest';

import {
	loadRuntimeManifest,
	normalizeRuntimeManifest,
	parseRuntimeManifest,
	resolveRuntimeAssetUrl
} from '../src/runtime-manifest.js';
import { createRuntimeManifest, createRuntimeManifestV2 } from './helpers.js';

describe('wasm-rust runtime manifest', () => {
	it('parses the generated manifest shape', () => {
		const manifest = normalizeRuntimeManifest(parseRuntimeManifest(createRuntimeManifest()));

		expect(manifest.defaultTargetTriple).toBe('wasm32-wasip1');
		expect(manifest.compiler.workerBitcodeFile.endsWith('.no-opt.bc')).toBe(true);
		expect(manifest.targets['wasm32-wasip1']?.compile.link.args).toContain('/work/main.wasm');
	});

	it('parses and normalizes the v2 manifest shape', () => {
		const manifest = normalizeRuntimeManifest(parseRuntimeManifest(createRuntimeManifestV2()));

		expect(manifest.manifestVersion).toBe(2);
		expect(manifest.defaultTargetTriple).toBe('wasm32-wasip1');
		expect(manifest.targets['wasm32-wasip2']?.artifactFormat).toBe('component');
		expect(manifest.targets['wasm32-wasip2']?.execution.kind).toBe('preview2-component');
	});

	it('resolves asset URLs relative to the runtime base URL', () => {
		expect(
			resolveRuntimeAssetUrl('https://example.com/wasm-rust/runtime/', 'llvm/lld.js')
		).toBe('https://example.com/wasm-rust/runtime/llvm/lld.js');
	});

	it('loads and validates the manifest through fetch', async () => {
		const manifest = createRuntimeManifestV2();
		const loaded = await loadRuntimeManifest('https://example.com/runtime-manifest.json', async () => ({
			ok: true,
			json: async () => manifest
		}) as Response);

		expect(loaded.version).toBe(manifest.version);
		expect(normalizeRuntimeManifest(loaded).targets['wasm32-wasip1']?.sysrootFiles[0]?.asset).toBe(
			manifest.targets['wasm32-wasip1']?.sysrootFiles[0]?.asset
		);
	});
});
