import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { chromium } from 'playwright-core';
import { describe, expect, it } from 'vitest';

import { startBrowserHarnessServer } from '../scripts/browser-harness-server.mjs';

const sampleProgram = process.env.WASM_RUST_SAMPLE_PROGRAM || 'fn main() { println!("hi"); }';
const runTimeoutMs = Number(
	process.env.WASM_RUST_BROWSER_HARNESS_RUN_TIMEOUT_MS || String(120000 + 120000)
);
const chromiumExecutable = process.env.WASM_RUST_CHROMIUM_EXECUTABLE;

async function resolveChromiumExecutable() {
	if (chromiumExecutable) {
		return chromiumExecutable;
	}
	const cacheRoot = path.join(os.homedir(), '.cache', 'ms-playwright');
	const entries = await fs.readdir(cacheRoot, { withFileTypes: true });
	const chromiumFolder = entries
		.filter((entry) => entry.isDirectory() && entry.name.startsWith('chromium-'))
		.map((entry) => entry.name)
		.sort()
		.at(-1);
	if (!chromiumFolder) {
		throw new Error('failed to locate a cached Chromium build under ~/.cache/ms-playwright');
	}
	return path.join(cacheRoot, chromiumFolder, 'chrome-linux64', 'chrome');
}

describe('browser harness direct Playwright integration', () => {
	it(
		'compiles and runs hello world directly through Chromium and the standalone harness',
		async () => {
			if (process.env.WASM_RUST_RUN_REAL_BROWSER_HARNESS !== '1') {
				return;
			}

			const server = await startBrowserHarnessServer();
			const executablePath = await resolveChromiumExecutable();
			const browser = await chromium.launch({
				headless: true,
				executablePath
			});
			const consoleMessages: Array<{ type: string; text: string }> = [];
			const pageErrors: string[] = [];

			try {
				const page = await browser.newPage();
				page.setDefaultTimeout(runTimeoutMs);
				page.on('console', (message) => {
					consoleMessages.push({
						type: message.type(),
						text: message.text()
					});
				});
				page.on('pageerror', (error) => {
					pageErrors.push(String(error.stack || error.message || error));
				});

				await page.goto(`${server.origin}/browser-harness/`, {
					waitUntil: 'domcontentloaded'
				});
				await page.waitForFunction(() => typeof window.runWasmRustHarness === 'function');

				const result = await page.evaluate(async (code) => window.runWasmRustHarness({ code, log: true }), sampleProgram);

				expect(result.crossOriginIsolated).toBe(true);
				expect(result.compile.success).toBe(true);
				expect(result.compile.hasWasm).toBe(true);
				expect(result.compile.hasWat).toBe(false);
				expect(result.runtime?.exitCode).toBe(0);
				expect(result.runtime?.stdout).toBe('hi\n');
				expect(pageErrors).toEqual([]);
				expect(
					consoleMessages.some(
						(message) =>
							message.type === 'log' &&
							message.text.includes('mirrored bitcode settled; linking through llvm-wasm')
					)
				).toBe(true);
			} finally {
				await browser.close();
				await server.close();
			}
		},
		780_000
	);
});
