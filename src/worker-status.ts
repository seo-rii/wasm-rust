const WORKER_STATUS_STATE_INDEX = 0;
const WORKER_STATUS_CODE_INDEX = 1;

const WORKER_STATUS_IDLE = 0;
const WORKER_STATUS_FAILED = 1;

const WORKER_STATUS_GENERIC = 0;
const WORKER_STATUS_MEMORY_OOB = 1;
const WORKER_STATUS_UNALIGNED = 2;
const WORKER_STATUS_UNREACHABLE = 3;

export const WORKER_STATUS_BUFFER_BYTES = 8;

function classifyFailureCode(detail: string) {
	if (detail.includes('memory access out of bounds')) {
		return WORKER_STATUS_MEMORY_OOB;
	}
	if (detail.includes('operation does not support unaligned accesses')) {
		return WORKER_STATUS_UNALIGNED;
	}
	if (detail.includes('unreachable')) {
		return WORKER_STATUS_UNREACHABLE;
	}
	return WORKER_STATUS_GENERIC;
}

export function markWorkerFailure(sharedStatusBuffer: SharedArrayBuffer, detail: string) {
	const state = new Int32Array(sharedStatusBuffer);
	if (
		Atomics.compareExchange(
			state,
			WORKER_STATUS_STATE_INDEX,
			WORKER_STATUS_IDLE,
			WORKER_STATUS_FAILED
		) !== WORKER_STATUS_IDLE
	) {
		return;
	}
	Atomics.store(state, WORKER_STATUS_CODE_INDEX, classifyFailureCode(detail));
	Atomics.notify(state, WORKER_STATUS_STATE_INDEX);
}

export function readWorkerFailure(sharedStatusBuffer: SharedArrayBuffer) {
	const state = new Int32Array(sharedStatusBuffer);
	if (Atomics.load(state, WORKER_STATUS_STATE_INDEX) !== WORKER_STATUS_FAILED) {
		return null;
	}
	const code = Atomics.load(state, WORKER_STATUS_CODE_INDEX);
	if (code === WORKER_STATUS_MEMORY_OOB) {
		return 'browser rustc helper thread failed before producing LLVM bitcode: memory access out of bounds';
	}
	if (code === WORKER_STATUS_UNALIGNED) {
		return 'browser rustc helper thread failed before producing LLVM bitcode: operation does not support unaligned accesses';
	}
	if (code === WORKER_STATUS_UNREACHABLE) {
		return 'browser rustc helper thread failed before producing LLVM bitcode: unreachable';
	}
	return 'browser rustc helper thread failed before producing LLVM bitcode';
}
