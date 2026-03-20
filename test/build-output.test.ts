import fs from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const projectRoot = '/home/seorii/dev/hancomac/wasm-rust';
const distRoot = path.join(projectRoot, 'dist');

async function listFiles(rootPath: string): Promise<string[]> {
	const entries = await fs.readdir(rootPath, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const fullPath = path.join(rootPath, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await listFiles(fullPath)));
			continue;
		}
		if (entry.isFile()) {
			files.push(fullPath);
		}
	}
	return files.sort();
}

describe('built browser bundle', () => {
	it('does not leave bare package imports in shipped browser entrypoints', async () => {
		const files = (await listFiles(distRoot)).filter((filePath) => filePath.endsWith('.js'));
		for (const filePath of files) {
			const contents = await fs.readFile(filePath, 'utf8');
			expect(contents).not.toContain('@bjorn3/browser_wasi_shim');
			expect(contents).not.toMatch(/(?:^|\n)\s*import\s+[^'"\n]*['"]@/);
			expect(contents).not.toMatch(/(?:^|\n)\s*export\s+[^'"\n]*from\s+['"]@/);
		}
		await expect(
			fs.access(path.join(distRoot, 'vendor', 'browser_wasi_shim', 'index.js'))
		).resolves.toBeUndefined();
		await expect(
			fs.access(path.join(distRoot, 'vendor', 'preview2-shim', 'lib', 'browser', 'index.js'))
		).resolves.toBeUndefined();
		await expect(
			fs.access(path.join(distRoot, 'vendor', 'jco', 'src', 'browser.js'))
		).resolves.toBeUndefined();
	});

	it('keeps edition 2024 enabled for the rebuilt rustc.wasm toolchain', async () => {
		const contents = await fs.readFile(path.join(distRoot, 'compiler-worker.js'), 'utf8');
		expect(contents).toContain('-Zunstable-options');
	});

	it('publishes legacy v1 and normalized v2 runtime manifests without directory-only link assets', async () => {
		const legacyManifest = JSON.parse(
			await fs.readFile(path.join(distRoot, 'runtime', 'runtime-manifest.json'), 'utf8')
		) as {
			targetTriple: string;
			compileTimeoutMs: number;
			sysrootFiles: Array<{
				asset: string;
				runtimePath: string;
			}>;
			link: {
				files: Array<{
					asset: string;
					runtimePath: string;
				}>;
			};
		};
		const v2Manifest = JSON.parse(
			await fs.readFile(path.join(distRoot, 'runtime', 'runtime-manifest.v2.json'), 'utf8')
		) as {
			manifestVersion: number;
			defaultTargetTriple: string;
			compiler: {
				compileTimeoutMs: number;
			};
			targets: Record<
				string,
				{
					artifactFormat: string;
					sysrootFiles: Array<{
						asset: string;
						runtimePath: string;
					}>;
					compile: {
						link: {
							args: string[];
							files: Array<{
								asset: string;
								runtimePath: string;
							}>;
						};
					};
				}
			>;
		};

		expect(legacyManifest.targetTriple).toBe('wasm32-wasip1');
		expect(legacyManifest.compileTimeoutMs).toBe(120_000);
		expect(
			legacyManifest.sysrootFiles.every(
				(entry) => !entry.asset.includes('x86_64-unknown-linux-gnu') && !entry.runtimePath.includes('x86_64-unknown-linux-gnu')
			)
		).toBe(true);
		expect(v2Manifest.manifestVersion).toBe(2);
		expect(v2Manifest.defaultTargetTriple).toBe('wasm32-wasip1');
		expect(v2Manifest.compiler.compileTimeoutMs).toBe(120_000);
		expect(v2Manifest.targets['wasm32-wasip1']?.artifactFormat).toBe('core-wasm');
		for (const [targetTriple, targetConfig] of Object.entries(v2Manifest.targets)) {
			expect(
				targetConfig.compile.link.files.some(
					(entry) =>
						entry.asset.endsWith('/self-contained') || entry.runtimePath.endsWith('/self-contained')
				)
			).toBe(false);
			expect(targetConfig.compile.link.args.some((entry) => entry.startsWith('/tmp/'))).toBe(false);
			expect(
				targetConfig.sysrootFiles.every(
					(entry) =>
						entry.asset.includes(`/rustlib/${targetTriple}/`) &&
						entry.runtimePath.includes(`/rustlib/${targetTriple}/`)
				)
			).toBe(true);
		}
		for (const targetConfig of Object.values(v2Manifest.targets)) {
			for (const entry of targetConfig.compile.link.files) {
				await expect(fs.access(path.join(distRoot, 'runtime', entry.asset))).resolves.toBeUndefined();
			}
		}
	});
});
