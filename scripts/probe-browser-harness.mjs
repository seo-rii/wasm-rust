import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { chromium } from 'playwright-core';

import { startBrowserHarnessServer } from './browser-harness-server.mjs';

const projectRoot = '/home/seorii/dev/hancomac/wasm-rust';
const sampleProgram = process.env.WASM_RUST_SAMPLE_PROGRAM || 'fn main() { println!("hi"); }';
const compileTimeoutMs = process.env.WASM_RUST_BROWSER_HARNESS_COMPILE_TIMEOUT_MS
	? Number(process.env.WASM_RUST_BROWSER_HARNESS_COMPILE_TIMEOUT_MS)
	: undefined;
const artifactIdleMs = process.env.WASM_RUST_BROWSER_HARNESS_ARTIFACT_IDLE_MS
	? Number(process.env.WASM_RUST_BROWSER_HARNESS_ARTIFACT_IDLE_MS)
	: undefined;
const initialPages = process.env.WASM_RUST_BROWSER_HARNESS_INITIAL_PAGES
	? Number(process.env.WASM_RUST_BROWSER_HARNESS_INITIAL_PAGES)
	: undefined;
const maximumPages = process.env.WASM_RUST_BROWSER_HARNESS_MAXIMUM_PAGES
	? Number(process.env.WASM_RUST_BROWSER_HARNESS_MAXIMUM_PAGES)
	: undefined;
const runTimeoutMs = Number(
	process.env.WASM_RUST_BROWSER_HARNESS_RUN_TIMEOUT_MS ||
		String((compileTimeoutMs ?? 120000) + 120000)
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

async function main() {
	const server = await startBrowserHarnessServer();
	const consoleMessages = [];
	const pageErrors = [];
	let browser;

	try {
		const executablePath = await resolveChromiumExecutable();
		browser = await chromium.launch({
			headless: true,
			executablePath
		});
		const page = await browser.newPage();
		page.setDefaultTimeout(runTimeoutMs);
		page.on('console', (message) => {
			consoleMessages.push({
				type: message.type(),
				text: message.text(),
				location: message.location()
			});
		});
		page.on('pageerror', (error) => {
			pageErrors.push(String(error.stack || error.message || error));
		});

		const harnessUrl = `${server.origin}/browser-harness/`;
		await page.goto(harnessUrl, { waitUntil: 'domcontentloaded' });
		await page.waitForFunction(() => typeof window.runWasmRustHarness === 'function');
		const harnessOptions = {
			code: sampleProgram,
			log: true
		};
		if (compileTimeoutMs !== undefined) {
			harnessOptions.compileTimeoutMs = compileTimeoutMs;
		}
		if (artifactIdleMs !== undefined) {
			harnessOptions.artifactIdleMs = artifactIdleMs;
		}
		if (initialPages !== undefined) {
			harnessOptions.initialPages = initialPages;
		}
		if (maximumPages !== undefined) {
			harnessOptions.maximumPages = maximumPages;
		}
		let result;
		try {
			result = await page.evaluate(
				async (options) => {
					try {
						return {
							ok: true,
							result: await window.runWasmRustHarness(options)
						};
					} catch (error) {
						return {
							ok: false,
							error: {
								name: error instanceof Error ? error.name : typeof error,
								message: error instanceof Error ? error.message : String(error),
								stack: error instanceof Error ? error.stack || '' : ''
							}
						};
					}
				},
				harnessOptions
			);
		} catch (error) {
			console.log(
				JSON.stringify(
					{
						success: false,
						harnessUrl,
						executablePath,
						runTimeoutMs,
						error: error instanceof Error ? error.message : String(error),
						consoleMessages,
						pageErrors
					},
					null,
					2
				)
			);
			process.exitCode = 1;
			return;
		}
		if (!result.ok) {
			console.log(
				JSON.stringify(
					{
						success: false,
						harnessUrl,
						executablePath,
						runTimeoutMs,
						error: result.error,
						consoleMessages,
						pageErrors
					},
					null,
					2
				)
			);
			process.exitCode = 1;
			return;
		}

		const output = {
			success:
				Boolean(result.result.compile?.success) &&
				result.result.runtime?.exitCode === 0 &&
				result.result.runtime?.stdout === 'hi\n',
			harnessUrl,
			executablePath,
			runTimeoutMs,
			result: result.result,
			consoleMessages,
			pageErrors
		};
		console.log(JSON.stringify(output, null, 2));
		if (!output.success) {
			process.exitCode = 1;
		}
	} finally {
		await browser?.close();
		await server.close();
	}
}

await main();
