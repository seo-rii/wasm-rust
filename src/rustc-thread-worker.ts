import { resolveVersionedAssetUrl } from './asset-url.js';
import { createModuleWorker } from './module-worker.js';
import type {
	RustcThreadPoolInitRequest,
	RustcThreadWorkerLogMessage,
	RustcThreadWorkerReadyMessage,
	RustcThreadWorkerRequest
} from './worker-protocol.js';
import { buildPreopenedDirectories, instantiateRustcInstance } from './rustc-runtime.js';
import { markWorkerFailure } from './worker-status.js';

const moduleLogEnabled = new URL(import.meta.url).searchParams.get('log') === '1';

if (moduleLogEnabled) {
	console.log('[wasm-rust:thread-worker] module evaluated');
}

postMessage({
	type: 'thread-ready'
} satisfies RustcThreadWorkerReadyMessage);

async function instantiateThreadWorkerRuntime(
	request: RustcThreadWorkerRequest | RustcThreadPoolInitRequest
) {
	const { fds } = await buildPreopenedDirectories(
		request.manifest,
		request.sysrootAssets,
		request.sourceCode,
		request.sharedBitcodeBuffer
	);
	if (request.log) {
		postMessage({
			type: 'thread-log',
			threadId: request.type === 'thread-start' ? request.threadId : request.slotIndex,
			phase: 'preopens-ready'
		} satisfies RustcThreadWorkerLogMessage);
	}
	return instantiateRustcInstance({
		rustcModule: request.rustcModule,
		memory: request.memory,
		args: request.args,
		fds,
		threadSpawner: (startArg) => {
			const threadCounter = new Int32Array(request.threadCounterBuffer);
			const nestedThreadId = Atomics.add(threadCounter, 0, 1) + 1;
			if (request.log) {
				console.log(
					`[wasm-rust:thread-worker ${request.type === 'thread-start' ? request.threadId : `pool-${request.slotIndex}`}] spawn nested=${nestedThreadId} startArg=${startArg}`
				);
			}
			if (request.type === 'thread-pool-init') {
				const slot = request.poolBuffers
					.map((buffer, index) => ({
						index,
						slotState: new Int32Array(buffer)
					}))
					.find(
						(entry) =>
							entry.index !== request.slotIndex && Atomics.load(entry.slotState, 0) === 0
					);
				if (!slot) {
					throw new Error('rustc browser thread pool exhausted in worker');
				}
				Atomics.store(slot.slotState, 1, nestedThreadId);
				Atomics.store(slot.slotState, 2, startArg);
				Atomics.store(slot.slotState, 0, 1);
				Atomics.notify(slot.slotState, 0);
				if (request.log) {
					console.log(
						`[wasm-rust:thread-worker pool-${request.slotIndex}] nested=${nestedThreadId} assigned to slot=${slot.index}`
					);
				}
				return nestedThreadId;
			}
			const nestedReadyBuffer = new SharedArrayBuffer(4);
			const nestedThreadWorkerUrl = resolveVersionedAssetUrl(
				import.meta.url,
				'./rustc-thread-worker.js'
			);
			if (request.log) {
				nestedThreadWorkerUrl.searchParams.set('log', '1');
			}
			const nestedWorker = createModuleWorker(nestedThreadWorkerUrl);
			nestedWorker.addEventListener(
				'message',
				(event: MessageEvent<RustcThreadWorkerLogMessage>) => {
						if (!request.log || event.data?.type !== 'thread-log') {
							return;
						}
						console.log(
							`[wasm-rust:thread-worker ${request.threadId}] nested=${event.data.threadId} phase=${event.data.phase}${event.data.detail ? ` detail=${event.data.detail}` : ''}`
						);
					}
				);
				nestedWorker.addEventListener('error', (event) => {
					if (request.log) {
						console.debug(
							`[wasm-rust:thread-worker ${request.threadId}] nested=${nestedThreadId} worker error ${event.message}`
						);
					}
				});
				nestedWorker.addEventListener('messageerror', () => {
					if (request.log) {
						console.debug(
							`[wasm-rust:thread-worker ${request.threadId}] nested=${nestedThreadId} worker messageerror during startup`
						);
					}
				});
			nestedWorker.postMessage({
				type: 'thread-start',
				runtimeBaseUrl: request.runtimeBaseUrl,
				manifest: request.manifest,
				sourceCode: request.sourceCode,
				log: request.log,
				sharedBitcodeBuffer: request.sharedBitcodeBuffer,
				sharedStatusBuffer: request.sharedStatusBuffer,
				threadCounterBuffer: request.threadCounterBuffer,
				sysrootAssets: request.sysrootAssets,
				rustcModule: request.rustcModule,
				memory: request.memory,
				args: request.args,
				threadId: nestedThreadId,
				startArg,
				readyBuffer: nestedReadyBuffer
				} satisfies RustcThreadWorkerRequest);
				if (request.log) {
					console.log(
						`[wasm-rust:thread-worker ${request.threadId}] nested=${nestedThreadId} spawned without blocking wait`
					);
				}
			return nestedThreadId;
		}
	});
}

async function startThreadWorker(request: RustcThreadWorkerRequest) {
	if (request.log) {
		postMessage({
			type: 'thread-log',
			threadId: request.threadId,
			phase: 'start',
			detail: `startArg=${request.startArg}`
		} satisfies RustcThreadWorkerLogMessage);
		console.log(
			`[wasm-rust:thread-worker ${request.threadId}] start startArg=${request.startArg}`
		);
	}
	const readyState = new Int32Array(request.readyBuffer);
	Atomics.store(readyState, 0, 1);
	Atomics.notify(readyState, 0);
	const instantiated = await instantiateThreadWorkerRuntime(request);
	if (request.log) {
		postMessage({
			type: 'thread-log',
			threadId: request.threadId,
			phase: 'instance-ready'
		} satisfies RustcThreadWorkerLogMessage);
		console.log(`[wasm-rust:thread-worker ${request.threadId}] instance ready`);
	}
	Atomics.store(readyState, 0, 2);
	Atomics.notify(readyState, 0);
	if (request.log) {
		postMessage({
			type: 'thread-log',
			threadId: request.threadId,
			phase: 'enter-wasi-thread-start'
		} satisfies RustcThreadWorkerLogMessage);
		console.log(`[wasm-rust:thread-worker ${request.threadId}] entering wasi_thread_start`);
	}
	(instantiated.instance.exports as any).wasi_thread_start(request.threadId, request.startArg);
	if (request.log) {
		console.log(`[wasm-rust:thread-worker ${request.threadId}] wasi_thread_start returned`);
	}
}

async function startThreadPoolWorker(request: RustcThreadPoolInitRequest) {
	const slotState = new Int32Array(request.slotBuffer);
	if (request.log) {
		postMessage({
			type: 'thread-log',
			threadId: request.slotIndex,
			phase: 'pool-init-start'
		} satisfies RustcThreadWorkerLogMessage);
		console.log(`[wasm-rust:thread-worker pool-${request.slotIndex}] init start`);
	}
	const instantiated = await instantiateThreadWorkerRuntime(request);
	Atomics.store(slotState, 0, 0);
	Atomics.notify(slotState, 0);
	if (request.log) {
		postMessage({
			type: 'thread-log',
			threadId: request.slotIndex,
			phase: 'pool-init-ready'
		} satisfies RustcThreadWorkerLogMessage);
		console.log(`[wasm-rust:thread-worker pool-${request.slotIndex}] init ready`);
	}
	while (true) {
		const currentState = Atomics.load(slotState, 0);
		if (currentState === -2) {
			return;
		}
		if (currentState === 0) {
			Atomics.wait(slotState, 0, 0);
			continue;
		}
		if (currentState !== 1) {
			Atomics.wait(slotState, 0, currentState, 50);
			continue;
		}
		const threadId = Atomics.load(slotState, 1);
		const startArg = Atomics.load(slotState, 2);
		Atomics.store(slotState, 0, 2);
		if (request.log) {
			postMessage({
				type: 'thread-log',
				threadId,
				phase: 'pool-run',
				detail: `slot=${request.slotIndex} startArg=${startArg}`
			} satisfies RustcThreadWorkerLogMessage);
			console.log(
				`[wasm-rust:thread-worker pool-${request.slotIndex}] run thread=${threadId} startArg=${startArg}`
			);
		}
		(instantiated.instance.exports as any).wasi_thread_start(threadId, startArg);
		Atomics.store(slotState, 0, 0);
		Atomics.notify(slotState, 0);
		if (request.log) {
			postMessage({
				type: 'thread-log',
				threadId,
				phase: 'pool-idle',
				detail: `slot=${request.slotIndex}`
			} satisfies RustcThreadWorkerLogMessage);
			console.log(`[wasm-rust:thread-worker pool-${request.slotIndex}] idle`);
		}
	}
}

globalThis.addEventListener(
	'message',
	(event: MessageEvent<RustcThreadWorkerRequest | RustcThreadPoolInitRequest>) => {
		if (event.data?.type === 'thread-start') {
			const request = event.data;
			void startThreadWorker(request).catch((error) => {
				const detail = error instanceof Error ? error.message : String(error);
				markWorkerFailure(request.sharedStatusBuffer, detail);
				const readyState = new Int32Array(request.readyBuffer);
				Atomics.store(readyState, 0, -1);
				Atomics.notify(readyState, 0);
				if (request.log) {
					postMessage({
						type: 'thread-log',
						threadId: request.threadId,
						phase: 'error',
						detail
					} satisfies RustcThreadWorkerLogMessage);
				}
				if (request.log) {
					console.debug(`[wasm-rust:thread-worker ${request.threadId}] failed`, error);
				}
			});
			return;
		}
		if (event.data?.type === 'thread-pool-init') {
			const request = event.data;
			void startThreadPoolWorker(request).catch((error) => {
				const detail = error instanceof Error ? error.message : String(error);
				markWorkerFailure(request.sharedStatusBuffer, detail);
				const slotState = new Int32Array(request.slotBuffer);
				Atomics.store(slotState, 0, -1);
				Atomics.notify(slotState, 0);
				if (request.log) {
					postMessage({
						type: 'thread-log',
						threadId: request.slotIndex,
						phase: 'pool-error',
						detail
					} satisfies RustcThreadWorkerLogMessage);
				}
				if (request.log) {
					console.debug(`[wasm-rust:thread-worker pool-${request.slotIndex}] failed`, error);
				}
			});
		}
	}
);
