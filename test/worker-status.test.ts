import { describe, expect, it } from 'vitest';

import {
	markWorkerFailure,
	readWorkerFailure,
	recordWorkerFailureContext,
	WORKER_STATUS_BUFFER_BYTES
} from '../src/worker-status.js';

describe('worker failure status', () => {
	it('includes the last recorded thread context in the helper-thread failure message', () => {
		const sharedStatusBuffer = new SharedArrayBuffer(WORKER_STATUS_BUFFER_BYTES);
		recordWorkerFailureContext(sharedStatusBuffer, 'pool-enter', 1234, [11, 22, 33, 44]);
		markWorkerFailure(sharedStatusBuffer, 'memory access out of bounds');

		expect(readWorkerFailure(sharedStatusBuffer)).toBe(
			'browser rustc helper thread failed before producing LLVM bitcode: memory access out of bounds (pool-enter startArg=1234 words=11,22,33,44)'
		);
	});
});
