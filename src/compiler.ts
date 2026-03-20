import { resolveVersionedAssetUrl } from './asset-url.js';
import { linkBitcodeWithLlvmWasm } from './browser-linker.js';
import { createModuleWorker } from './module-worker.js';
import {
	loadRuntimeManifest,
	normalizeRuntimeManifest,
	resolveTargetManifest
} from './runtime-manifest.js';
import { readMirroredBitcode } from './rustc-runtime.js';
import { readWorkerFailure, WORKER_STATUS_BUFFER_BYTES } from './worker-status.js';
import type { CompileWorkerMessage, CompileWorkerRequest } from './worker-protocol.js';
import type {
	BrowserRustCompileRequest,
	BrowserRustCompilerResult,
	CompilerDiagnostic,
	SupportedTargetTriple
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
const SUPPORTED_TARGET_TRIPLES = new Set<SupportedTargetTriple>([
	'wasm32-wasip1',
	'wasm32-wasip2'
]);

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
type BufferedCompileLog = {
	level: 'log' | 'warn' | 'error' | 'debug';
	message: string;
};

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
	if (request.targetTriple && !SUPPORTED_TARGET_TRIPLES.has(request.targetTriple)) {
		return `unsupported browser compiler target: ${request.targetTriple}`;
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
	let loadedManifest;
	try {
		loadedManifest = await (dependencies.loadManifest || loadRuntimeManifest)(
			resolveVersionedAssetUrl(runtimeBaseUrl, 'runtime-manifest.v2.json')
		);
	} catch {
		loadedManifest = await (dependencies.loadManifest || loadRuntimeManifest)(
			resolveVersionedAssetUrl(runtimeBaseUrl, 'runtime-manifest.json')
		);
	}
	const manifest = normalizeRuntimeManifest(loadedManifest);
	let targetConfig;
	try {
		targetConfig = resolveTargetManifest(manifest, request.targetTriple);
	} catch (error) {
		return makeFailure(error instanceof Error ? error.message : String(error));
	}
	const versionedModuleBaseUrl = new URL(import.meta.url);
	versionedModuleBaseUrl.searchParams.set('v', manifest.version);
	const versionedRuntimeBaseUrl = resolveVersionedAssetUrl(versionedModuleBaseUrl, './runtime/');
	const compileTimeoutMs = request.prepare
		? Math.max(manifest.compiler.compileTimeoutMs, 120_000)
		: manifest.compiler.compileTimeoutMs;
	const compileLogs: BufferedCompileLog[] = [];
	const emitCompileLog = (
		message: string,
		level: 'log' | 'warn' | 'error' | 'debug' = 'log'
	) => {
		if (!request.log) {
			return;
		}
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
	const recordPersistentCompileLog = (
		message: string,
		level: 'log' | 'warn' | 'error' | 'debug' = 'log'
	) => {
		compileLogs.push({
			level,
			message
		});
		emitCompileLog(message, level);
	};
	const flushAttemptCompileLogs = (attemptCompileLogs: BufferedCompileLog[]) => {
		compileLogs.push(...attemptCompileLogs);
		for (const record of attemptCompileLogs) {
			emitCompileLog(record.message, record.level);
		}
	};
	const mergeCompileStdout = (stdout?: string) => {
		if (compileLogs.length === 0) {
			return stdout || undefined;
		}
		const compileLogText = `${compileLogs.map((entry) => entry.message).join('\n')}\n`;
		if (!stdout) {
			return compileLogText;
		}
		return `${compileLogText}${stdout}`;
	};
	recordPersistentCompileLog(
		`[wasm-rust] manifest loaded target=${targetConfig.targetTriple} timeout=${compileTimeoutMs}ms idle=${manifest.compiler.artifactIdleMs}ms memory=${manifest.compiler.rustcMemory.initialPages}/${manifest.compiler.rustcMemory.maximumPages}`
	);
	const now = dependencies.now || (() => Date.now());
	const sleep =
		dependencies.sleep ||
		((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
	const retryableFailurePatterns = [
		'worker script error',
		'failed to fetch dynamically imported module',
		'importing a module script failed',
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
	const helperThreadFailureGraceMs = Math.max(
		1_000,
		Math.min(4_000, manifest.compiler.artifactIdleMs * 2)
	);
	let lastFailure = makeFailure('browser rustc failed before emitting LLVM bitcode');

	for (let attempt = 1; attempt <= maxBrowserAttempts; attempt += 1) {
		const attemptCompileLogs: BufferedCompileLog[] = [];
		const recordAttemptCompileLog = (
			message: string,
			level: 'log' | 'warn' | 'error' | 'debug' = 'log'
		) => {
			attemptCompileLogs.push({
				level,
				message
			});
		};
		const workerUrl = resolveVersionedAssetUrl(versionedModuleBaseUrl, './compiler-worker.js');
		workerUrl.searchParams.set('attempt', String(attempt));
		const worker = (dependencies.createWorker ||
			((url) => createModuleWorker(url) as WorkerLike))(
			workerUrl
		);
		const sharedBitcodeBuffer = new SharedArrayBuffer(
			16 + manifest.compiler.workerSharedOutputBytes
		);
		const sharedStatusBuffer = new SharedArrayBuffer(WORKER_STATUS_BUFFER_BYTES);
		const workerResult = new Promise<SettledCompileWorkerMessage>((resolve, reject) => {
			const handleMessage = (event: MessageEvent<CompileWorkerMessage>) => {
				if (event.data.type === 'log') {
					recordAttemptCompileLog(event.data.message);
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
		recordAttemptCompileLog(
			`[wasm-rust] compile worker started attempt=${attempt}/${maxBrowserAttempts}`
		);

			const deadline = now() + compileTimeoutMs;
			let lastSequence = 0;
			let lastSequenceChange = now();
			let settledMessage: SettledCompileWorkerMessage | null = null;
			let workerBootstrapError: Error | null = null;
			let attemptResult: BrowserRustCompilerResult | null = null;
			let pendingHelperThreadFailure: string | null = null;
			let pendingHelperThreadFailureObservedAt = 0;

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
				if (helperThreadFailure && !pendingHelperThreadFailure) {
					pendingHelperThreadFailure = helperThreadFailure;
					pendingHelperThreadFailureObservedAt = now();
				}
				if (mirrored.length === 0 && pendingHelperThreadFailure) {
					if (now() - pendingHelperThreadFailureObservedAt >= helperThreadFailureGraceMs) {
						worker.terminate();
						attemptResult = makeFailure(pendingHelperThreadFailure);
						break;
					}
				} else if (mirrored.length > 0) {
					pendingHelperThreadFailure = null;
					pendingHelperThreadFailureObservedAt = 0;
				}
				if (mirrored.writeSequence !== lastSequence) {
					lastSequence = mirrored.writeSequence;
					lastSequenceChange = now();
					recordAttemptCompileLog(
						`[wasm-rust] mirrored artifact updated seq=${mirrored.writeSequence} bytes=${mirrored.length} overflowed=${mirrored.overflowed}`
					);
				continue;
			}
			if (mirrored.length > 0 && now() - lastSequenceChange >= manifest.compiler.artifactIdleMs) {
				worker.terminate();
				if (mirrored.overflowed) {
					attemptResult = makeFailure(
						'wasm-rust mirrored bitcode buffer overflowed before backend linking'
					);
					break;
				}
				recordAttemptCompileLog('[wasm-rust] mirrored bitcode settled; linking through llvm-wasm');
				let artifact: NonNullable<BrowserRustCompilerResult['artifact']>;
				try {
					artifact = await (dependencies.linkBitcode || linkBitcodeWithLlvmWasm)(
						mirrored.bytes,
						manifest,
						targetConfig,
						versionedRuntimeBaseUrl.toString()
					);
				} catch (error) {
					recordAttemptCompileLog(
						`[wasm-rust] llvm-wasm link failed after mirrored bitcode: ${error instanceof Error ? error.message : String(error)}`,
						'error'
					);
					attemptResult = makeFailure(
						`browser rustc emitted LLVM bitcode but llvm-wasm link failed: ${error instanceof Error ? error.message : String(error)}`
					);
					break;
				}
				flushAttemptCompileLogs(attemptCompileLogs);
				return {
					success: true,
					stdout: mergeCompileStdout(),
					artifact
				};
			}
		}

		if (!attemptResult && workerBootstrapError) {
			worker.terminate();
			recordAttemptCompileLog(
				`[wasm-rust] compile worker bootstrap failed ${workerBootstrapError.message}`,
				'debug'
			);
			attemptResult = makeFailure(workerBootstrapError.message, undefined, mergeCompileStdout());
		}

		if (!attemptResult && !settledMessage) {
			worker.terminate();
			const mirrored = readMirroredBitcode(sharedBitcodeBuffer);
			if (mirrored.length > 0 && !mirrored.overflowed) {
				recordAttemptCompileLog(
					'[wasm-rust] compile timeout reached after mirrored bitcode appeared; proceeding to llvm-wasm link',
					'debug'
				);
				let artifact: NonNullable<BrowserRustCompilerResult['artifact']>;
				try {
					artifact = await (dependencies.linkBitcode || linkBitcodeWithLlvmWasm)(
						mirrored.bytes,
						manifest,
						targetConfig,
						versionedRuntimeBaseUrl.toString()
					);
				} catch (error) {
					recordAttemptCompileLog(
						`[wasm-rust] llvm-wasm link failed after timeout fallback: ${error instanceof Error ? error.message : String(error)}`,
						'error'
					);
					attemptResult = makeFailure(
						`browser rustc emitted LLVM bitcode but llvm-wasm link failed: ${error instanceof Error ? error.message : String(error)}`
					);
					break;
				}
				flushAttemptCompileLogs(attemptCompileLogs);
				return {
					success: true,
					stdout: mergeCompileStdout(),
					artifact
				};
			}
			if (mirrored.overflowed) {
				attemptResult = makeFailure(
					'wasm-rust mirrored bitcode buffer overflowed before backend linking',
					undefined,
					mergeCompileStdout()
				);
			} else {
				recordAttemptCompileLog(
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
					recordAttemptCompileLog(
						'[wasm-rust] worker errored with mirrored bitcode present; linking through llvm-wasm'
					);
					try {
						const artifact = await (dependencies.linkBitcode || linkBitcodeWithLlvmWasm)(
							mirrored.bytes,
							manifest,
							targetConfig,
							versionedRuntimeBaseUrl.toString()
						);
						flushAttemptCompileLogs(attemptCompileLogs);
						return {
							success: true,
							stdout: mergeCompileStdout(settledMessage.stdout),
							diagnostics: settledMessage.diagnostics,
							artifact
						};
					} catch (error) {
						recordAttemptCompileLog(
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
				recordAttemptCompileLog('[wasm-rust] worker settled with mirrored bitcode; linking through llvm-wasm');
				let artifact: NonNullable<BrowserRustCompilerResult['artifact']> | null = null;
				try {
					artifact = await (dependencies.linkBitcode || linkBitcodeWithLlvmWasm)(
						mirrored.bytes,
						manifest,
						targetConfig,
						versionedRuntimeBaseUrl.toString()
					);
				} catch (error) {
					recordAttemptCompileLog(
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
					if (!artifact) {
						attemptResult = makeFailure(
							'browser rustc emitted LLVM bitcode but llvm-wasm returned no wasm artifact',
							settledMessage.diagnostics,
							mergeCompileStdout(settledMessage.stdout)
						);
						continue;
					}
					flushAttemptCompileLogs(attemptCompileLogs);
					return {
						success: true,
						stdout: mergeCompileStdout(settledMessage.stdout),
						diagnostics: settledMessage.diagnostics,
						artifact
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
		if (shouldRetry) {
			recordPersistentCompileLog(
				`[wasm-rust] browser rustc attempt ${attempt}/${maxBrowserAttempts} failed; retrying`,
				'warn'
			);
		} else {
			flushAttemptCompileLogs(attemptCompileLogs);
		}
		if (!shouldRetry) {
			return attemptResult;
		}
		await sleep(Math.min(500 * attempt, 2_000));
	}

	return lastFailure;
}
