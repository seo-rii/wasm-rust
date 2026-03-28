import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('ci script contract', () => {
	it('keeps the fast ci lane independent from runtime builds', async () => {
		const packageJson = JSON.parse(
			await readFile(path.join(projectRoot, 'package.json'), 'utf8')
		) as {
			scripts?: Record<string, string>;
			devDependencies?: Record<string, string>;
		};
		const workflow = await readFile(path.join(projectRoot, '.github/workflows/ci.yml'), 'utf8');
		const fastScript = packageJson.scripts?.['test:ci:fast'];
		const playwrightVersion =
			packageJson.devDependencies?.['playwright-core']?.replace(/^[^\d]*/, '') || '';

		expect(packageJson.scripts?.['test:ci']).toBe('pnpm run test:ci:fast');
		expect(packageJson.scripts?.['test:ci:browser']).toBe(
			'pnpm run test:browser && pnpm run test:browser:vitest && pnpm run test:browser:playwright'
		);
		expect(packageJson.scripts?.['validate:standalone-browser']).toBe(
			'node ./scripts/validate-standalone-browser.mjs'
		);
		expect(packageJson.scripts?.['build:all-compressed']).toBe(
			'WASM_RUST_PRECOMPRESS_SCOPES=all pnpm run build'
		);
		expect(packageJson.scripts?.['build:uncompressed']).toBe(
			'WASM_RUST_PRECOMPRESS_SCOPES=none pnpm run build'
		);
		expect(packageJson.scripts?.['prepare:runtime:all-compressed']).toBe(
			'WASM_RUST_PRECOMPRESS_SCOPES=all node scripts/prepare-runtime.mjs'
		);
		expect(packageJson.scripts?.['prepare:runtime:uncompressed']).toBe(
			'WASM_RUST_PRECOMPRESS_SCOPES=none node scripts/prepare-runtime.mjs'
		);
		expect(fastScript).toContain('WASM_RUST_SKIP_DIST_TESTS=1');
		expect(fastScript).not.toContain('pnpm build');
		expect(fastScript).toContain('test/build-output.test.ts');
		expect(fastScript).toContain('test/runtime-compression-config.test.ts');
		expect(fastScript).toContain('test/rustc-runtime.test.ts');
		expect(workflow).toContain('gh release download --pattern \'wasm-rust-*.tgz\'');
		expect(workflow).toContain("WASM_RUST_ALLOW_PREBUILT_RUNTIME_FALLBACK: '1'");
		expect(workflow).toContain('uses: actions/checkout@v6');
		expect(workflow).toContain('uses: actions/setup-node@v6');
		expect(workflow).toContain(
			`pnpm dlx playwright@${playwrightVersion} install --with-deps chromium`
		);
		expect(workflow).toContain('pnpm run validate:standalone-browser');
	});
});
