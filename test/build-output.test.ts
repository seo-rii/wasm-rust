import fs from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const projectRoot = '/home/seorii/dev/hancomac/wasm-rust';
const distRoot = path.join(projectRoot, 'dist');

describe('built browser bundle', () => {
	it('does not leave bare package imports in shipped browser entrypoints', async () => {
		const files = ['index.js', 'compiler-worker.js', 'rustc-thread-worker.js'];
		for (const fileName of files) {
			const contents = await fs.readFile(path.join(distRoot, fileName), 'utf8');
			expect(contents).not.toContain('@bjorn3/browser_wasi_shim');
			expect(contents).not.toMatch(/from\s+['"]@/);
			expect(contents).not.toMatch(/import\s+['"]@/);
		}
		await expect(
			fs.access(path.join(distRoot, 'vendor', 'browser_wasi_shim', 'index.js'))
		).resolves.toBeUndefined();
	});

	it('keeps edition 2024 enabled for the rebuilt rustc.wasm toolchain', async () => {
		const contents = await fs.readFile(path.join(distRoot, 'compiler-worker.js'), 'utf8');
		expect(contents).toContain('-Zunstable-options');
	});

	it('does not publish directory-only link assets in the runtime manifest', async () => {
		const manifest = JSON.parse(
			await fs.readFile(path.join(distRoot, 'runtime', 'runtime-manifest.json'), 'utf8')
		) as {
			compileTimeoutMs: number;
			link: {
				files: Array<{
					asset: string;
					runtimePath: string;
				}>;
			};
		};

		expect(manifest.compileTimeoutMs).toBe(30_000);
		expect(
			manifest.link.files.some(
				(entry) =>
					entry.asset.endsWith('/self-contained') || entry.runtimePath.endsWith('/self-contained')
			)
		).toBe(false);
	});
});
