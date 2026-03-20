import { afterEach, describe, expect, it, vi } from 'vitest';

import { createModuleWorker } from '../src/module-worker.js';

describe('module worker wrapper', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('creates a direct module worker from the resolved asset URL', () => {
		const fakeWorker = { terminate() {} };
		const workerConstructor = vi.fn(function () {
			return fakeWorker;
		});
		vi.stubGlobal('Worker', workerConstructor as unknown as typeof Worker);
		const moduleUrl = new URL('http://127.0.0.1:4174/compiler-worker.js?v=test-cache-bust');

		const worker = createModuleWorker(moduleUrl);
		expect(worker).toBe(fakeWorker);
		expect(workerConstructor).toHaveBeenCalledWith(moduleUrl, { type: 'module' });
	});
});
