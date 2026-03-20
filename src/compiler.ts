import { resolveVersionedAssetUrl } from './asset-url.js';
import { linkBitcodeWithLlvmWasm } from './browser-linker.js';
import { createModuleWorker } from './module-worker.js';
import { loadRuntimeManifest } from './runtime-manifest.js';
import { readMirroredBitcode } from './rustc-runtime.js';
import { readWorkerFailure, WORKER_STATUS_BUFFER_BYTES } from './worker-status.js';
import type { CompileWorkerMessage, CompileWorkerRequest } from './worker-protocol.js';
import type {
	BrowserRustCompileRequest,
	BrowserRustCompilerResult,
	CompilerDiagnostic
} from './types.js';

export type {
	BrowserRustCompileRequest,
	BrowserRustCompiler,
	BrowserRustCompilerFactory,
	BrowserRustCompilerResult,
	CompilerDiagnostic
} from './types.js';

const SUPPORTED_EDITIONS = new Set(['2021', '2024']);
const SUPPORTED_CRATE_TYPES = new Set(['bin']);

interface WorkerLike {
	postMessage(message: unknown): void;
	terminate(): void;
	addEventListener(type: 'message', listener: (event: MessageEvent<CompileWorkerMessage>) => void): void;
	addEventListener(type: 'error', listener: (event: ErrorEvent) => void): void;
	removeEventListener(
		type: 'message',
		listener: (event: MessageEvent<CompileWorkerMessage>) => void
	): void;
	removeEventListener(type: 'error', listener: (event: ErrorEvent) => void): void;
}

export interface CompileRustDependencies {
	loadManifest?: typeof loadRuntimeManifest;
	createWorker?: (url: URL) => WorkerLike;
	linkBitcode?: typeof linkBitcodeWithLlvmWasm;
	now?: () => number;
	sleep?: (milliseconds: number) => Promise<void>;
}

export interface CreateRustCompilerOptions {
	dependencies?: CompileRustDependencies;
}

type SettledCompileWorkerMessage = Exclude<CompileWorkerMessage, { type: 'log' }>;

function describeWorkerErrorEvent(
	event: Pick<ErrorEvent, 'message' | 'filename' | 'lineno' | 'colno' | 'error'>
) {
	const location = event.filename
		? `${event.filename}${event.lineno ? `:${event.lineno}` : ''}${event.colno ? `:${event.colno}` : ''}`
		: '';
	const errorMessage =
		event.error instanceof Error
			? event.error.message || event.error.name
			: typeof event.error === 'string'
				? event.error
				: '';
	const primaryMessage = errorMessage || event.message || '';
	if (primaryMessage && location) {
		return `${primaryMessage} (${location})`;
	}
	if (primaryMessage) {
		return primaryMessage;
	}
	if (location) {
		return `worker script error at ${location}`;
	}
	return 'worker script error';
}

function makeFailure(
	stderr: string,
	diagnostics?: CompilerDiagnostic[],
	stdout?: string
): BrowserRustCompilerResult {
	return {
		success: false,
		stdout,
		stderr,
		diagnostics
	};
}

function validateRequest(request: BrowserRustCompileRequest) {
	if (!request.code || request.code.trim().length === 0) {
		return 'wasm-rust requires a non-empty Rust source file';
	}
	if (request.edition && !SUPPORTED_EDITIONS.has(request.edition)) {
		return `unsupported browser compiler edition: ${request.edition}`;
	}
	if (request.crateType && !SUPPORTED_CRATE_TYPES.has(request.crateType)) {
		return `unsupported browser compiler crate type: ${request.crateType}`;
	}
	return null;
}

export async function compileRust(
	request: BrowserRustCompileRequest,
	dependencies: CompileRustDependencies = {}
): Promise<BrowserRustCompilerResult> {
	const validationError = validateRequest(request);
	if (validationError) {
		return makeFailure(validationError);
	}
	if (
		(!dependencies.createWorker && typeof Worker === 'undefined') ||
		typeof SharedArrayBuffer === 'undefined' ||
		typeof Atomics === 'undefined'
	) {
		return makeFailure(
			'wasm-rust requires a cross-origin-isolated worker environment with SharedArrayBuffer support'
		);
	}

	const runtimeBaseUrl = resolveVersionedAssetUrl(import.meta.url, './runtime/');
	const manifest = await (dependencies.loadManifest || loadRuntimeManifest)(
		resolveVersionedAssetUrl(runtimeBaseUrl, 'runtime-manifest.json')
	);
	const versionedModuleBaseUrl = new URL(import.meta.url);
	versionedModuleBaseUrl.searchParams.set('v', manifest.version);
	const versionedRuntimeBaseUrl = resolveVersionedAssetUrl(versionedModuleBaseUrl, './runtime/');
	const compileTimeoutMs = request.prepare
		? Math.max(manifest.compileTimeoutMs, 120_000)
		: manifest.compileTimeoutMs;
	const compileLogLines: string[] = [];
	const recordCompileLog = (
		message: string,
		level: 'log' | 'warn' | 'error' | 'debug' = 'log'
	) => {
		if (!request.log) {
			return;
		}
		compileLogLines.push(message);
		if (level === 'warn') {
			console.warn(message);
			return;
		}
		if (level === 'error') {
			console.error(message);
			return;
		}
		if (level === 'debug') {
			console.debug(message);
			return;
		}
		console.log(message);
	};
	const mergeCompileStdout = (stdout?: string) => {
		if (compileLogLines.length === 0) {
			return stdout || undefined;
		}
		const compileLogText = `${compileLogLines.join('\n')}\n`;
		if (!stdout) {
			return compileLogText;
		}
		return `${compileLogText}${stdout}`;
	};
	recordCompileLog(
		`[wasm-rust] manifest loaded timeout=${compileTimeoutMs}ms idle=${manifest.artifactIdleMs}ms memory=${manifest.rustcMemory.initialPages}/${manifest.rustcMemory.maximumPages}`
	);
	const now = dependencies.now || (() => Date.now());
	const sleep =
		dependencies.sleep ||
		((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
	const retryableFailurePatterns = [
		'worker script error',
		'failed to fetch dynamically imported module',
		'importing a module script failed',
		'failed to fetch',
		'memory access out of bounds',
		'browser rustc timed out before producing llvm bitcode',
		'operation does not support unaligned accesses',
		'rustc browser thread pool exhausted',
		'unreachable',
		'browser rustc helper thread failed before producing llvm bitcode',
		'invalid enum variant tag while decoding',
		'found invalid metadata files for crate',
		'failed to parse rlib',
		"can't find crate for `std`",
		'the compiler unexpectedly panicked'
	];
	const maxBrowserAttempts = 5;
	let lastFailure = makeFailure('browser rustc failed before emitting LLVM bitcode');

	for (let attempt = 1; attempt <= maxBrowserAttempts; attempt += 1) {
		const workerUrl = resolveVersionedAssetUrl(versionedModuleBaseUrl, './compiler-worker.js');
		workerUrl.searchParams.set('attempt', String(attempt));
		const worker = (dependencies.createWorker ||
			((url) => createModuleWorker(url) as WorkerLike))(
			workerUrl
		);
		const sharedBitcodeBuffer = new SharedArrayBuffer(
			16 + manifest.workerSharedOutputBytes
		);
		const sharedStatusBuffer = new SharedArrayBuffer(WORKER_STATUS_BUFFER_BYTES);
		const workerResult = new Promise<SettledCompileWorkerMessage>((resolve, reject) => {
			const handleMessage = (event: MessageEvent<CompileWorkerMessage>) => {
				if (event.data.type === 'log') {
					recordCompileLog(event.data.message);
					return;
				}
				worker.removeEventListener('message', handleMessage);
				worker.removeEventListener('error', handleError);
				resolve(event.data);
			};
			const handleError = (event: ErrorEvent) => {
				worker.removeEventListener('message', handleMessage);
				worker.removeEventListener('error', handleError);
				reject(
					new Error(
						`${describeWorkerErrorEvent(event)} [worker=${workerUrl.toString()}]`
					)
				);
			};
			worker.addEventListener('message', handleMessage);
			worker.addEventListener('error', handleError);
		});

		worker.postMessage({
			type: 'compile',
			runtimeBaseUrl: versionedRuntimeBaseUrl.toString(),
			manifest,
			request,
			sharedBitcodeBuffer,
			sharedStatusBuffer
		} satisfies CompileWorkerRequest);
		recordCompileLog(
			`[wasm-rust] compile worker started attempt=${attempt}/${maxBrowserAttempts}`
		);

		const deadline = now() + compileTimeoutMs;
		let lastSequence = 0;
		let lastSequenceChange = now();
		let settledMessage: SettledCompileWorkerMessage | null = null;
		let workerBootstrapError: Error | null = null;
		let attemptResult: BrowserRustCompilerResult | null = null;

		while (!settledMessage && !workerBootstrapError && now() < deadline) {
			const raced = await Promise.race([
				workerResult
					.then((message) => ({ type: 'message' as const, message }))
					.catch((error) => ({ type: 'worker-error' as const, error })),
				sleep(250).then(() => ({ type: 'tick' as const }))
			]);
			if (raced.type === 'message') {
				settledMessage = raced.message;
				break;
			}
			if (raced.type === 'worker-error') {
				workerBootstrapError =
					raced.error instanceof Error ? raced.error : new Error(String(raced.error));
				break;
			}
			const mirrored = readMirroredBitcode(sharedBitcodeBuffer);
			const helperThreadFailure = readWorkerFailure(sharedStatusBuffer);
			if (helperThreadFailure && mirrored.length === 0) {
				worker.terminate();
				attemptResult = makeFailure(helperThreadFailure);
				break;
			}
			if (mirrored.writeSequence !== lastSequence) {
				lastSequence = mirrored.writeSequence;
				lastSequenceChange = now();
				recordCompileLog(
					`[wasm-rust] mirrored artifact updated seq=${mirrored.writeSequence} bytes=${mirrored.length} overflowed=${mirrored.overflowed}`
				);
				continue;
			}
			if (mirrored.length > 0 && now() - lastSequenceChange >= manifest.artifactIdleMs) {
				worker.terminate();
				if (mirrored.overflowed) {
					attemptResult = makeFailure(
						'wasm-rust mirrored bitcode buffer overflowed before backend linking'
					);
					break;
				}
				recordCompileLog('[wasm-rust] mirrored bitcode settled; linking through llvm-wasm');
				let wasm: Uint8Array;
				try {
					wasm = await (dependencies.linkBitcode || linkBitcodeWithLlvmWasm)(
						mirrored.bytes,
						manifest,
						versionedRuntimeBaseUrl.toString()
					);
				} catch (error) {
					recordCompileLog(
						`[wasm-rust] llvm-wasm link failed after mirrored bitcode: ${error instanceof Error ? error.message : String(error)}`,
						'error'
					);
					attemptResult = makeFailure(
						`browser rustc emitted LLVM bitcode but llvm-wasm link failed: ${error instanceof Error ? error.message : String(error)}`
					);
					break;
				}
				return {
					success: true,
					stdout: mergeCompileStdout(),
					artifact: {
						wasm
					}
				};
			}
		}

		if (!attemptResult && workerBootstrapError) {
			worker.terminate();
			recordCompileLog(
				`[wasm-rust] compile worker bootstrap failed ${workerBootstrapError.message}`,
				'debug'
			);
			attemptResult = makeFailure(workerBootstrapError.message, undefined, mergeCompileStdout());
		}

		if (!attemptResult && !settledMessage) {
			worker.terminate();
			const mirrored = readMirroredBitcode(sharedBitcodeBuffer);
			if (mirrored.length > 0 && !mirrored.overflowed) {
				recordCompileLog(
					'[wasm-rust] compile timeout reached after mirrored bitcode appeared; proceeding to llvm-wasm link',
					'debug'
				);
				let wasm: Uint8Array;
				try {
					wasm = await (dependencies.linkBitcode || linkBitcodeWithLlvmWasm)(
						mirrored.bytes,
						manifest,
						versionedRuntimeBaseUrl.toString()
					);
				} catch (error) {
					recordCompileLog(
						`[wasm-rust] llvm-wasm link failed after timeout fallback: ${error instanceof Error ? error.message : String(error)}`,
						'error'
					);
					attemptResult = makeFailure(
						`browser rustc emitted LLVM bitcode but llvm-wasm link failed: ${error instanceof Error ? error.message : String(error)}`
					);
					break;
				}
				return {
					success: true,
					stdout: mergeCompileStdout(),
					artifact: {
						wasm
					}
				};
			}
			if (mirrored.overflowed) {
				attemptResult = makeFailure(
					'wasm-rust mirrored bitcode buffer overflowed before backend linking',
					undefined,
					mergeCompileStdout()
				);
			} else {
				recordCompileLog(
					'[wasm-rust] compile timed out before mirrored bitcode appeared',
					'debug'
				);
				attemptResult = makeFailure(
					'browser rustc timed out before producing LLVM bitcode',
					undefined,
					mergeCompileStdout()
				);
			}
		}

		if (!attemptResult && settledMessage) {
			worker.terminate();
			const mirrored = readMirroredBitcode(sharedBitcodeBuffer);
			if (settledMessage.type === 'error') {
				if (mirrored.length > 0 && !mirrored.overflowed) {
					recordCompileLog(
						'[wasm-rust] worker errored with mirrored bitcode present; linking through llvm-wasm'
					);
					try {
						const linkedWasm = await (dependencies.linkBitcode || linkBitcodeWithLlvmWasm)(
							mirrored.bytes,
							manifest,
							versionedRuntimeBaseUrl.toString()
						);
						return {
							success: true,
							stdout: mergeCompileStdout(settledMessage.stdout),
							diagnostics: settledMessage.diagnostics,
							artifact: {
								wasm: linkedWasm
							}
						};
					} catch (error) {
						recordCompileLog(
							`[wasm-rust] llvm-wasm link failed after worker error: ${error instanceof Error ? error.message : String(error)}`,
							'error'
						);
						attemptResult = makeFailure(
							`browser rustc emitted LLVM bitcode but llvm-wasm link failed: ${error instanceof Error ? error.message : String(error)}`,
							settledMessage.diagnostics,
							mergeCompileStdout(settledMessage.stdout)
						);
					}
				} else if (mirrored.overflowed) {
					attemptResult = makeFailure(
						'wasm-rust mirrored bitcode buffer overflowed before backend linking',
						undefined,
						mergeCompileStdout(settledMessage.stdout)
					);
				} else {
					attemptResult = makeFailure(
						settledMessage.stderr || settledMessage.message,
						settledMessage.diagnostics,
						mergeCompileStdout(settledMessage.stdout)
					);
				}
			} else if (mirrored.length > 0 && !mirrored.overflowed) {
				recordCompileLog('[wasm-rust] worker settled with mirrored bitcode; linking through llvm-wasm');
				let linkedWasm: Uint8Array | null = null;
				try {
					linkedWasm = await (dependencies.linkBitcode || linkBitcodeWithLlvmWasm)(
						mirrored.bytes,
						manifest,
						versionedRuntimeBaseUrl.toString()
					);
				} catch (error) {
					recordCompileLog(
						`[wasm-rust] llvm-wasm link failed after worker settled: ${error instanceof Error ? error.message : String(error)}`,
						'error'
					);
					attemptResult = makeFailure(
						`browser rustc emitted LLVM bitcode but llvm-wasm link failed: ${error instanceof Error ? error.message : String(error)}`,
						settledMessage.diagnostics,
						mergeCompileStdout(settledMessage.stdout)
					);
				}
				if (!attemptResult) {
					if (!linkedWasm) {
						attemptResult = makeFailure(
							'browser rustc emitted LLVM bitcode but llvm-wasm returned no wasm artifact',
							settledMessage.diagnostics,
							mergeCompileStdout(settledMessage.stdout)
						);
						continue;
					}
					return {
						success: true,
						stdout: mergeCompileStdout(settledMessage.stdout),
						diagnostics: settledMessage.diagnostics,
						artifact: {
							wasm: linkedWasm
						}
					};
				}
			} else if (mirrored.overflowed) {
				attemptResult = makeFailure(
					'wasm-rust mirrored bitcode buffer overflowed before backend linking',
					undefined,
					mergeCompileStdout(settledMessage.stdout)
				);
			} else {
				attemptResult = makeFailure(
					settledMessage.stderr || 'browser rustc failed before emitting LLVM bitcode',
					settledMessage.diagnostics,
					mergeCompileStdout(settledMessage.stdout)
				);
			}
		}

		if (!attemptResult) {
			attemptResult = makeFailure(
				'browser rustc failed before emitting LLVM bitcode',
				undefined,
				mergeCompileStdout()
			);
		}

		lastFailure = attemptResult;
		const attemptStderr = attemptResult.stderr || '';
		const normalizedAttemptStderr = attemptStderr.toLowerCase();
		const shouldRetry =
			attempt < maxBrowserAttempts &&
			Boolean(attemptStderr) &&
			retryableFailurePatterns.some((pattern) => normalizedAttemptStderr.includes(pattern));
		if (request.log && shouldRetry) {
			recordCompileLog(
				`[wasm-rust] browser rustc attempt ${attempt}/${maxBrowserAttempts} failed; retrying reason=${JSON.stringify(attemptStderr)}`,
				'warn'
			);
		}
		if (!shouldRetry) {
			return attemptResult;
		}
		await sleep(Math.min(500 * attempt, 2_000));
	}

	return lastFailure;
}
