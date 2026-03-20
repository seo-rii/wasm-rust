import type { CompileWorkerMessage } from '../src/worker-protocol.js';

export function createRuntimeManifest(overrides: Record<string, unknown> = {}) {
	return {
		version: 'test-runtime-v1',
		hostTriple: 'x86_64-unknown-linux-gnu',
		targetTriple: 'wasm32-wasip1',
		rustcWasm: 'rustc/rustc.wasm',
		workerBitcodeFile: 'main.main.1ca70c240d7de168-cgu.0.rcgu.no-opt.bc',
		workerSharedOutputBytes: 1024,
		compileTimeoutMs: 2_000,
		artifactIdleMs: 500,
		rustcMemory: {
			initialPages: 8,
			maximumPages: 16
		},
		sysrootFiles: [
			{
				asset: 'sysroot/lib/rustlib/wasm32-wasip1/lib/libstd.rlib',
				runtimePath: '/lib/rustlib/wasm32-wasip1/lib/libstd.rlib'
			}
		],
		llvm: {
			llc: 'llvm/llc.js',
			lld: 'llvm/lld.js'
		},
		link: {
			allocatorObjectRuntimePath: '/work/alloc.o',
			allocatorObjectAsset: 'link/alloc.o',
			args: ['-o', '/work/main.wasm'],
			files: [
				{
					asset: 'sysroot/lib/rustlib/wasm32-wasip1/lib/libstd.rlib',
					runtimePath: '/rustlib/libstd.rlib'
				}
			]
		},
		...overrides
	};
}

export class FakeWorker {
	private readonly listeners = new Map<'message' | 'error', Set<(event: any) => void>>();
	terminated = false;
	lastRequest: unknown = null;
	private readonly onPostMessage: (message: any, worker: FakeWorker) => void;

	constructor(onPostMessage: (message: any, worker: FakeWorker) => void = () => {}) {
		this.listeners.set('message', new Set());
		this.listeners.set('error', new Set());
		this.onPostMessage = onPostMessage;
	}

	postMessage(message: unknown) {
		this.lastRequest = message;
		this.onPostMessage(message, this);
	}

	terminate() {
		this.terminated = true;
	}

	addEventListener(type: 'message' | 'error', listener: (event: any) => void) {
		this.listeners.get(type)?.add(listener);
	}

	removeEventListener(type: 'message' | 'error', listener: (event: any) => void) {
		this.listeners.get(type)?.delete(listener);
	}

	emitMessage(data: CompileWorkerMessage) {
		for (const listener of this.listeners.get('message') || []) {
			listener({ data });
		}
	}

	emitError(error: Error) {
		for (const listener of this.listeners.get('error') || []) {
			listener({ error, message: error.message });
		}
	}

	emitErrorEvent(event: {
		error?: unknown;
		message?: string;
		filename?: string;
		lineno?: number;
		colno?: number;
	}) {
		for (const listener of this.listeners.get('error') || []) {
			listener(event);
		}
	}
}

export function mirrorBitcode(sharedBuffer: SharedArrayBuffer, bitcode: Uint8Array, sequence = 1) {
	const state = new Int32Array(sharedBuffer, 0, 4);
	const bytes = new Uint8Array(sharedBuffer, 16);
	bytes.set(bitcode, 0);
	Atomics.store(state, 0, bitcode.length);
	Atomics.store(state, 1, 0);
	Atomics.store(state, 2, sequence);
}
