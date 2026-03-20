import { createRustCompiler } from '/dist/index.js';
import { loadRuntimeManifest } from '/dist/runtime-manifest.js';
import {
	Fd,
	File,
	Inode,
	OpenFile,
	PreopenDirectory,
	WASI,
	wasi
} from '/dist/vendor/browser_wasi_shim/index.js';

const sourceInput = document.querySelector('#source');
const compileTimeoutInput = document.querySelector('#compile-timeout');
const artifactIdleInput = document.querySelector('#artifact-idle');
const memoryInitialInput = document.querySelector('#memory-initial');
const memoryMaximumInput = document.querySelector('#memory-maximum');
const editionInput = document.querySelector('#edition');
const enableLogsInput = document.querySelector('#enable-logs');
const runButton = document.querySelector('#run-button');
const resultPanel = document.querySelector('#result-panel');
const logPanel = document.querySelector('#log-panel');
const isolationPill = document.querySelector('#isolation-pill');
const runPill = document.querySelector('#run-pill');
const runtimeManifestUrl = new URL('/dist/runtime/runtime-manifest.json', window.location.href);

const state = {
	lastResult: null
};

let manifestDefaultsPromise;

class CaptureFd extends Fd {
	constructor() {
		super();
		this.ino = Inode.issue_ino();
		this.decoder = new TextDecoder();
		this.chunks = [];
	}

	fd_filestat_get() {
		return {
			ret: wasi.ERRNO_SUCCESS,
			filestat: new wasi.Filestat(this.ino, wasi.FILETYPE_CHARACTER_DEVICE, 0n)
		};
	}

	fd_fdstat_get() {
		const fdstat = new wasi.Fdstat(wasi.FILETYPE_CHARACTER_DEVICE, 0);
		fdstat.fs_rights_base = BigInt(wasi.RIGHTS_FD_WRITE);
		return {
			ret: wasi.ERRNO_SUCCESS,
			fdstat
		};
	}

	fd_write(data) {
		this.chunks.push(this.decoder.decode(data, { stream: true }));
		return {
			ret: wasi.ERRNO_SUCCESS,
			nwritten: data.byteLength
		};
	}

	getText() {
		const trailing = this.decoder.decode();
		if (trailing) {
			this.chunks.push(trailing);
		}
		return this.chunks.join('');
	}
}

function appendLog(message, kind = 'info') {
	const line = `[${new Date().toISOString()}][${kind}] ${message}`;
	logPanel.textContent += `${line}\n`;
	logPanel.scrollTop = logPanel.scrollHeight;
	if (kind === 'error') {
		console.error(line);
		return;
	}
	if (kind === 'warn') {
		console.warn(line);
		return;
	}
	console.log(line);
}

async function loadHarnessManifest() {
	if (!manifestDefaultsPromise) {
		manifestDefaultsPromise = loadRuntimeManifest(runtimeManifestUrl);
	}
	return manifestDefaultsPromise;
}

function readNumericInput(input, fallback) {
	const parsed = Number.parseInt(input.value, 10);
	return Number.isFinite(parsed) ? parsed : fallback;
}

async function runWasiModule(wasmArtifact) {
	const bytes =
		wasmArtifact instanceof Uint8Array ? wasmArtifact : new Uint8Array(wasmArtifact);
	const stdout = new CaptureFd();
	const stderr = new CaptureFd();
	const wasiInstance = new WASI(['/work/main.wasm'], [], [
		new OpenFile(new File(new Uint8Array(), { readonly: true })),
		stdout,
		stderr,
		new PreopenDirectory('/tmp', new Map())
	]);
	const module = await WebAssembly.compile(bytes);
	const instance = await WebAssembly.instantiate(module, {
		wasi_snapshot_preview1: wasiInstance.wasiImport
	});
	let exitCode = null;
	try {
		exitCode = wasiInstance.start(instance);
	} catch (error) {
		appendLog(`browser runtime threw: ${error instanceof Error ? error.message : String(error)}`, 'error');
		throw error;
	}
	return {
		exitCode,
		stdout: stdout.getText(),
		stderr: stderr.getText()
	};
}

function readHarnessOptions(baseManifest, overrides = {}) {
	return {
		code: overrides.code ?? sourceInput.value,
		edition: overrides.edition ?? editionInput.value,
		compileTimeoutMs:
			overrides.compileTimeoutMs ??
			readNumericInput(compileTimeoutInput, baseManifest.compileTimeoutMs),
		artifactIdleMs:
			overrides.artifactIdleMs ??
			readNumericInput(artifactIdleInput, baseManifest.artifactIdleMs),
		initialPages:
			overrides.initialPages ??
			readNumericInput(memoryInitialInput, baseManifest.rustcMemory.initialPages),
		maximumPages:
			overrides.maximumPages ??
			readNumericInput(memoryMaximumInput, baseManifest.rustcMemory.maximumPages),
		log: overrides.log ?? enableLogsInput.checked
	};
}

async function runWasmRustHarness(overrides = {}) {
	const baseManifest = await loadHarnessManifest();
	const options = readHarnessOptions(baseManifest, overrides);
	const startedAt = performance.now();
	logPanel.textContent = '';
	runPill.textContent = 'status: running';
	appendLog(
		`starting compile timeout=${options.compileTimeoutMs} idle=${options.artifactIdleMs} memory=${options.initialPages}/${options.maximumPages}`
	);

	const compiler = await createRustCompiler({
		dependencies: {
			loadManifest: async () => ({
				...baseManifest,
				compileTimeoutMs: options.compileTimeoutMs,
				artifactIdleMs: options.artifactIdleMs,
				rustcMemory: {
					...baseManifest.rustcMemory,
					initialPages: options.initialPages,
					maximumPages: options.maximumPages
				}
			})
		}
	});

	const compileResult = await compiler.compile({
		code: options.code,
		edition: options.edition,
		crateType: 'bin',
		log: options.log
	});
	const result = {
		crossOriginIsolated: window.crossOriginIsolated,
		elapsedMs: Math.round(performance.now() - startedAt),
		manifest: {
			compileTimeoutMs: options.compileTimeoutMs,
			artifactIdleMs: options.artifactIdleMs,
			initialPages: options.initialPages,
			maximumPages: options.maximumPages
		},
		compile: {
			success: compileResult.success,
			stdout: compileResult.stdout ?? '',
			stderr: compileResult.stderr ?? '',
			diagnostics: compileResult.diagnostics ?? [],
			hasWasm: Boolean(compileResult.artifact?.wasm),
			hasWat: Boolean(compileResult.artifact?.wat)
		},
		runtime: null
	};

	if (compileResult.success && compileResult.artifact?.wasm) {
		appendLog('compile succeeded; executing WASI module in browser');
		result.runtime = await runWasiModule(compileResult.artifact.wasm);
	} else {
		appendLog(
			`compile failed: ${compileResult.stderr || 'missing artifact from compiler result'}`,
			'warn'
		);
	}

	state.lastResult = result;
	resultPanel.textContent = JSON.stringify(result, null, 2);
	runPill.textContent = result.compile.success && result.runtime?.exitCode === 0 ? 'status: ok' : 'status: failed';
	appendLog(`run finished in ${result.elapsedMs}ms`);
	return result;
}

isolationPill.textContent = `crossOriginIsolated: ${String(window.crossOriginIsolated)}`;
loadHarnessManifest()
	.then((manifest) => {
		compileTimeoutInput.value = String(manifest.compileTimeoutMs);
		artifactIdleInput.value = String(manifest.artifactIdleMs);
		memoryInitialInput.value = String(manifest.rustcMemory.initialPages);
		memoryMaximumInput.value = String(manifest.rustcMemory.maximumPages);
	})
	.catch((error) => {
		appendLog(
			`failed to load runtime manifest defaults: ${error instanceof Error ? error.message : String(error)}`,
			'warn'
		);
	});
window.__wasmRustBrowserHarnessState = state;
window.runWasmRustHarness = runWasmRustHarness;

runButton.addEventListener('click', async () => {
	runButton.disabled = true;
	try {
		await runWasmRustHarness();
	} catch (error) {
		const result = {
			crossOriginIsolated: window.crossOriginIsolated,
			elapsedMs: 0,
			compile: {
				success: false,
				stdout: '',
				stderr: error instanceof Error ? error.message : String(error),
				diagnostics: [],
				hasWasm: false,
				hasWat: false
			},
			runtime: null
		};
		state.lastResult = result;
		resultPanel.textContent = JSON.stringify(result, null, 2);
		runPill.textContent = 'status: failed';
		appendLog(result.compile.stderr, 'error');
	} finally {
		runButton.disabled = false;
	}
});
