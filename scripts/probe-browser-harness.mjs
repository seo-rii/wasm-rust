import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright-core';

import { startBrowserHarnessServer } from './browser-harness-server.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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

function parseTargetTripleList(value) {
	return [...new Set(value.split(',').map((entry) => entry.trim()).filter(Boolean))];
}

async function resolveHarnessTargetTriples() {
	if (process.env.WASM_RUST_BROWSER_HARNESS_TARGET_TRIPLES) {
		return parseTargetTripleList(process.env.WASM_RUST_BROWSER_HARNESS_TARGET_TRIPLES);
	}
	const runtimeManifestV2Path = path.join(
		projectRoot,
		'dist',
		'runtime',
		'runtime-manifest.v3.json'
	);
	try {
		const manifest = JSON.parse(await fs.readFile(runtimeManifestV2Path, 'utf8'));
		const targets = Object.keys(manifest.targets || {});
		if (targets.length > 0) {
			return targets;
		}
	} catch {}
	const runtimeManifestV2FallbackPath = path.join(
		projectRoot,
		'dist',
		'runtime',
		'runtime-manifest.v2.json'
	);
	try {
		const manifest = JSON.parse(await fs.readFile(runtimeManifestV2FallbackPath, 'utf8'));
		const targets = Object.keys(manifest.targets || {});
		if (targets.length > 0) {
			return targets;
		}
	} catch {}
	const runtimeManifestV1Path = path.join(
		projectRoot,
		'dist',
		'runtime',
		'runtime-manifest.json'
	);
	const legacyManifest = JSON.parse(await fs.readFile(runtimeManifestV1Path, 'utf8'));
	return [legacyManifest.targetTriple || 'wasm32-wasip1'];
}

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
	const targetTriples = await resolveHarnessTargetTriples();
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
		const targetResults = [];
		for (const targetTriple of targetTriples) {
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
					{
						...harnessOptions,
						targetTriple
					}
				);
			} catch (error) {
				console.log(
					JSON.stringify(
						{
							success: false,
							harnessUrl,
							executablePath,
							runTimeoutMs,
							targetTriple,
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
			targetResults.push({
				targetTriple,
				...result
			});
		}

		const output = {
			success: targetResults.every(
				(entry) =>
					entry.ok &&
					Boolean(entry.result.compile?.success) &&
					entry.result.runtime?.exitCode === 0 &&
					entry.result.runtime?.stdout === 'hi\n'
			),
			harnessUrl,
			executablePath,
			runTimeoutMs,
			targets: targetResults,
			result: targetResults[0]?.result || null,
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
