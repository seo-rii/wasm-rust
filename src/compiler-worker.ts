import { resolveVersionedAssetUrl } from './asset-url.js';
import type {
	CompileWorkerMessage,
	CompileWorkerRequest,
	RustcThreadPoolInitRequest,
	RustcThreadWorkerLogMessage,
	SharedRuntimeAssetFile
} from './worker-protocol.js';
import { createModuleWorker } from './module-worker.js';
import { buildPreopenedDirectories, instantiateRustcInstance } from './rustc-runtime.js';

const THREAD_POOL_SIZE = 4;
const ARCHIVE_MAGIC = new Uint8Array([0x21, 0x3c, 0x61, 0x72, 0x63, 0x68, 0x3e, 0x0a]);

export function validateRuntimeAssetBytes(assetPath: string, bytes: Uint8Array) {
	if (!assetPath.endsWith('.rlib') && !assetPath.endsWith('.a')) {
		return;
	}
	if (
		bytes.length >= ARCHIVE_MAGIC.length &&
		ARCHIVE_MAGIC.every((byte, index) => bytes[index] === byte)
	) {
		return;
	}
	const preview = new TextDecoder()
		.decode(bytes.slice(0, 64))
		.replaceAll(/\s+/g, ' ')
		.trim();
	throw new Error(
		`invalid wasm-rust runtime asset ${assetPath}: expected an ar archive but got ${JSON.stringify(preview || 'non-archive bytes')}. This usually means the browser loaded a stale or wrong wasm-rust bundle; hard refresh and resync the runtime assets.`
	);
}

export async function fetchRuntimeAssetBytes(assetUrl: URL, assetLabel: string) {
	let response: Response;
	try {
		response = await fetch(assetUrl);
	} catch (error) {
		throw new Error(
			`failed to fetch ${assetLabel} from ${assetUrl.toString()}: ${error instanceof Error ? error.message : String(error)}. This usually means the browser loaded a stale wasm-rust bundle or blocked a nested runtime asset request; hard refresh and resync the runtime assets.`
		);
	}
	if (!response.ok) {
		throw new Error(
			`failed to fetch ${assetLabel} from ${assetUrl.toString()} (status ${response.status}). This usually means the browser loaded a stale wasm-rust bundle or a nested runtime asset is missing.`
		);
	}
	return new Uint8Array(await response.arrayBuffer());
}

function buildRustcArguments(
	request: CompileWorkerRequest['request'],
	manifest: CompileWorkerRequest['manifest']
) {
	const edition = request.edition || '2024';
	return [
		'rustc',
		'-Zthreads=1',
		'-Zcodegen-backend=llvm',
		...(edition === '2024' ? ['-Zunstable-options'] : []),
		'/work/main.rs',
		'--sysroot',
		'/sysroot',
		'--target',
		manifest.targetTriple,
		'--crate-type',
		request.crateType || 'bin',
		'--edition',
		edition,
		'-Cpanic=abort',
		'-Ccodegen-units=1',
		'-Cno-prepopulate-passes',
		'-Csave-temps',
		'--emit=obj',
		'-o',
		'/work/main.o'
	];
}

function emitCompileWorkerLog(request: CompileWorkerRequest, message: string) {
	if (!request.request.log) {
		return;
	}
	console.log(message);
	postMessage({
		type: 'log',
		message
	} satisfies CompileWorkerMessage);
}

async function compileRustInWorker(request: CompileWorkerRequest) {
	emitCompileWorkerLog(
		request,
		`[wasm-rust:compiler-worker] start target=${request.manifest.targetTriple} timeout=${request.manifest.compileTimeoutMs}ms`
	);
	const rustcUrl = resolveVersionedAssetUrl(request.runtimeBaseUrl, request.manifest.rustcWasm);
	const rustcBytes = await fetchRuntimeAssetBytes(rustcUrl, 'rustc.wasm');
	emitCompileWorkerLog(
		request,
		`[wasm-rust:compiler-worker] rustc.wasm fetched bytes=${rustcBytes.byteLength}`
	);
	const rustcModule = await WebAssembly.compile(rustcBytes);
	let fetchedSysrootFiles = 0;
	const sysrootAssets: SharedRuntimeAssetFile[] = await Promise.all(
		request.manifest.sysrootFiles.map(async (entry) => {
			const assetUrl = resolveVersionedAssetUrl(request.runtimeBaseUrl, entry.asset);
			const bytes = await fetchRuntimeAssetBytes(
				assetUrl,
				`wasm-rust sysroot asset ${entry.asset}`
			);
			validateRuntimeAssetBytes(entry.asset, bytes);
			const sharedBuffer = new SharedArrayBuffer(bytes.byteLength);
			new Uint8Array(sharedBuffer).set(bytes);
			fetchedSysrootFiles += 1;
			if (
				request.request.log &&
				(fetchedSysrootFiles === 1 ||
					fetchedSysrootFiles === request.manifest.sysrootFiles.length ||
					fetchedSysrootFiles % 100 === 0)
			) {
				emitCompileWorkerLog(
					request,
					`[wasm-rust:compiler-worker] sysroot fetched ${fetchedSysrootFiles}/${request.manifest.sysrootFiles.length}`
				);
			}
			return {
				runtimePath: entry.runtimePath,
				buffer: sharedBuffer
			};
		})
	);
	const memory = new WebAssembly.Memory({
		initial: request.manifest.rustcMemory.initialPages,
		maximum: request.manifest.rustcMemory.maximumPages,
		shared: true
	});
	emitCompileWorkerLog(
		request,
		`[wasm-rust:compiler-worker] shared memory created initial=${request.manifest.rustcMemory.initialPages} max=${request.manifest.rustcMemory.maximumPages}`
	);
	const { fds, stdout, stderr } = await buildPreopenedDirectories(
		request.manifest,
		sysrootAssets,
		request.request.code,
		request.sharedBitcodeBuffer
	);
	emitCompileWorkerLog(request, '[wasm-rust:compiler-worker] preopened directories ready');
	const args = buildRustcArguments(request.request, request.manifest);
	const threadCounter = new Int32Array(new SharedArrayBuffer(4));
	const slotBuffers = Array.from({ length: THREAD_POOL_SIZE }, () => new SharedArrayBuffer(16));
	let reportedThreadFailure = false;
	const reportThreadFailure = (message: string) => {
		if (reportedThreadFailure) return;
		reportedThreadFailure = true;
		postMessage({
			type: 'error',
			message
		} satisfies CompileWorkerMessage);
	};
	const threadPool = await Promise.all(
		slotBuffers.map(async (slotBuffer, slotIndex) => {
			const slotState = new Int32Array(slotBuffer);
			Atomics.store(slotState, 0, -3);
			const threadWorkerUrl = resolveVersionedAssetUrl(
				import.meta.url,
				'./rustc-thread-worker.js'
			);
			if (request.request.log) {
				threadWorkerUrl.searchParams.set('log', '1');
			}
			const worker = createModuleWorker(threadWorkerUrl);
			worker.addEventListener('message', (event: MessageEvent<RustcThreadWorkerLogMessage>) => {
				if (event.data?.type !== 'thread-log') {
					return;
				}
				if (event.data.phase === 'pool-error' || event.data.phase === 'error') {
					reportThreadFailure(
						event.data.detail ||
							`rustc browser helper thread ${event.data.threadId} failed`
					);
				}
				if (!request.request.log) {
					return;
				}
				emitCompileWorkerLog(
					request,
					`[wasm-rust:compiler-worker] thread=${event.data.threadId} phase=${event.data.phase}${event.data.detail ? ` detail=${event.data.detail}` : ''}`
				);
			});
			worker.addEventListener('error', (event) => {
				emitCompileWorkerLog(
					request,
					`[wasm-rust:compiler-worker] pool=${slotIndex} worker error ${event.message}`
				);
				reportThreadFailure(event.message || `rustc thread pool slot ${slotIndex} failed`);
				Atomics.store(slotState, 0, -1);
				Atomics.notify(slotState, 0);
			});
			worker.addEventListener('messageerror', () => {
				emitCompileWorkerLog(
					request,
					`[wasm-rust:compiler-worker] pool=${slotIndex} worker messageerror during startup`
				);
				reportThreadFailure(`rustc thread pool slot ${slotIndex} messageerror during startup`);
				Atomics.store(slotState, 0, -1);
				Atomics.notify(slotState, 0);
			});
			worker.postMessage({
				type: 'thread-pool-init',
				runtimeBaseUrl: request.runtimeBaseUrl,
				manifest: request.manifest,
				sourceCode: request.request.code,
				log: Boolean(request.request.log),
				sharedBitcodeBuffer: request.sharedBitcodeBuffer,
				sharedStatusBuffer: request.sharedStatusBuffer,
				threadCounterBuffer: threadCounter.buffer as SharedArrayBuffer,
				sysrootAssets,
				rustcModule,
				memory,
				args,
				slotIndex,
				slotBuffer,
				poolBuffers: slotBuffers
			} satisfies RustcThreadPoolInitRequest);
			const initStartedAt = Date.now();
			while (Atomics.load(slotState, 0) === -3 && Date.now() - initStartedAt < 120_000) {
				await new Promise<void>((resolve) => setTimeout(resolve, 25));
			}
			if (Atomics.load(slotState, 0) < 0) {
				throw new Error(`rustc thread pool slot ${slotIndex} failed to initialize`);
			}
			emitCompileWorkerLog(request, `[wasm-rust:compiler-worker] pool=${slotIndex} initialized`);
			return {
				slotIndex,
				slotState
			};
		})
	);
	const threadSpawner = (startArg: number) => {
		const threadId = Atomics.add(threadCounter, 0, 1) + 1;
		const slot = threadPool.find((entry) => Atomics.load(entry.slotState, 0) === 0);
		if (!slot) {
			throw new Error('rustc browser thread pool exhausted');
		}
		Atomics.store(slot.slotState, 1, threadId);
		Atomics.store(slot.slotState, 2, startArg);
		Atomics.store(slot.slotState, 0, 1);
		Atomics.notify(slot.slotState, 0);
		emitCompileWorkerLog(
			request,
			`[wasm-rust:compiler-worker] assign thread=${threadId} startArg=${startArg} slot=${slot.slotIndex}`
		);
		return threadId;
	};
	const instantiated = await instantiateRustcInstance({
		rustcModule,
		memory,
		args,
		fds,
		threadSpawner
	});
	emitCompileWorkerLog(request, '[wasm-rust:compiler-worker] rustc instance ready');
	const instance = instantiated.instance as any;
	let exitCode: number | null = null;
	try {
		emitCompileWorkerLog(request, '[wasm-rust:compiler-worker] starting rustc main');
		exitCode = instantiated.wasiInstance.start(instance);
	} catch (error) {
		const stderrText = stderr.getText();
		emitCompileWorkerLog(
			request,
			`[wasm-rust:compiler-worker] rustc main threw ${error instanceof Error ? error.message : String(error)}`
		);
		postMessage({
			type: 'result',
			exitCode,
			stdout: stdout.getText(),
			stderr:
				stderrText +
				(error instanceof Error ? `${stderrText ? '\n' : ''}${error.message}` : '')
		} satisfies CompileWorkerMessage);
		return;
	}
	emitCompileWorkerLog(
		request,
		`[wasm-rust:compiler-worker] rustc main exited code=${String(exitCode)}`
	);
	postMessage({
		type: 'result',
		exitCode,
		stdout: stdout.getText(),
		stderr: stderr.getText()
	} satisfies CompileWorkerMessage);
}

if (typeof globalThis.addEventListener === 'function') {
	globalThis.addEventListener('message', (event: MessageEvent<CompileWorkerRequest>) => {
		if (event.data?.type !== 'compile') {
			return;
		}
	void compileRustInWorker(event.data).catch((error) => {
		emitCompileWorkerLog(
			event.data,
			`[wasm-rust:compiler-worker] unhandled failure ${error instanceof Error ? error.message : String(error)}`
		);
		postMessage({
			type: 'error',
			message: error instanceof Error ? error.message : String(error)
			} satisfies CompileWorkerMessage);
		});
	});
}
