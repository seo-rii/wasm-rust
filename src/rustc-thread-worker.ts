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

const MIRRORED_BITCODE_LENGTH_INDEX = 0;

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
			const spawnDedicatedWorker = () => {
				const nestedReadyBuffer = new SharedArrayBuffer(4);
				const nestedReadyState = new Int32Array(nestedReadyBuffer);
				const nestedThreadWorkerUrl = resolveVersionedAssetUrl(
					import.meta.url,
					'./rustc-thread-worker.js'
				);
				if (request.log) {
					nestedThreadWorkerUrl.searchParams.set('log', '1');
				}
				const nestedWorker = createModuleWorker(nestedThreadWorkerUrl);
				const markNestedStartupFailure = () => {
					if (Atomics.load(nestedReadyState, 0) < 0) {
						return;
					}
					Atomics.store(nestedReadyState, 0, -1);
					Atomics.notify(nestedReadyState, 0);
				};
				nestedWorker.addEventListener('error', markNestedStartupFailure);
				nestedWorker.addEventListener('messageerror', markNestedStartupFailure);
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
				const waitDeadline = Date.now() + 30_000;
				while (true) {
					const currentState = Atomics.load(nestedReadyState, 0);
					if (currentState >= 2) {
						break;
					}
					if (currentState < 0) {
						throw new Error(
							`rustc dedicated helper thread ${nestedThreadId} failed to initialize`
						);
					}
					const remaining = waitDeadline - Date.now();
					if (remaining <= 0) {
						throw new Error(
							`rustc dedicated helper thread ${nestedThreadId} timed out during startup`
						);
					}
					Atomics.wait(nestedReadyState, 0, currentState, Math.min(remaining, 1_000));
				}
				return nestedThreadId;
			};
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
					return spawnDedicatedWorker();
				}
				Atomics.store(slot.slotState, 1, nestedThreadId);
				Atomics.store(slot.slotState, 2, startArg);
				Atomics.store(slot.slotState, 0, 1);
				Atomics.notify(slot.slotState, 0);
				return nestedThreadId;
			}
			return spawnDedicatedWorker();
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
	}
	Atomics.store(readyState, 0, 2);
	Atomics.notify(readyState, 0);
	if (request.log) {
		postMessage({
			type: 'thread-log',
			threadId: request.threadId,
			phase: 'enter-wasi-thread-start'
		} satisfies RustcThreadWorkerLogMessage);
	}
	(instantiated.instance.exports as any).wasi_thread_start(request.threadId, request.startArg);
}

async function startThreadPoolWorker(request: RustcThreadPoolInitRequest) {
	const slotState = new Int32Array(request.slotBuffer);
	if (request.log) {
		postMessage({
			type: 'thread-log',
			threadId: request.slotIndex,
			phase: 'pool-init-start'
		} satisfies RustcThreadWorkerLogMessage);
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
				const mirroredState = new Int32Array(request.sharedBitcodeBuffer, 0, 4);
				const mirroredLength = Atomics.load(mirroredState, MIRRORED_BITCODE_LENGTH_INDEX);
				const mirroredBitcodeReady = mirroredLength > 0;
				if (!mirroredBitcodeReady) {
					markWorkerFailure(request.sharedStatusBuffer, detail);
				}
				const readyState = new Int32Array(request.readyBuffer);
				Atomics.store(readyState, 0, -1);
				Atomics.notify(readyState, 0);
				if (request.log && !mirroredBitcodeReady) {
					postMessage({
						type: 'thread-log',
						threadId: request.threadId,
						phase: 'error',
						detail
					} satisfies RustcThreadWorkerLogMessage);
				}
			});
			return;
		}
		if (event.data?.type === 'thread-pool-init') {
			const request = event.data;
			void startThreadPoolWorker(request).catch((error) => {
				const detail = error instanceof Error ? error.message : String(error);
				const mirroredState = new Int32Array(request.sharedBitcodeBuffer, 0, 4);
				const mirroredLength = Atomics.load(mirroredState, MIRRORED_BITCODE_LENGTH_INDEX);
				const mirroredBitcodeReady = mirroredLength > 0;
				if (!mirroredBitcodeReady) {
					markWorkerFailure(request.sharedStatusBuffer, detail);
				}
				const slotState = new Int32Array(request.slotBuffer);
				Atomics.store(slotState, 0, -1);
				Atomics.notify(slotState, 0);
				if (request.log && !mirroredBitcodeReady) {
					postMessage({
						type: 'thread-log',
						threadId: request.slotIndex,
						phase: 'pool-error',
						detail
					} satisfies RustcThreadWorkerLogMessage);
				}
			});
		}
	}
);
