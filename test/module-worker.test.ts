import { afterEach, describe, expect, it, vi } from 'vitest';

import { createModuleWorker } from '../src/module-worker.js';

describe('module worker wrapper', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('bootstraps module workers through a blob wrapper', async () => {
		const fakeWorker = { terminate() {} };
		const workerConstructor = vi.fn(function () {
			return fakeWorker;
		});
		let bootstrapBlob: Blob | null = null;
		const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
			bootstrapBlob = blob;
			return 'blob:wasm-rust-worker-bootstrap';
		});
		const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
		vi.stubGlobal('Worker', workerConstructor as unknown as typeof Worker);
		const moduleUrl = new URL('http://127.0.0.1:4174/compiler-worker.js?v=test-cache-bust');

		const worker = createModuleWorker(moduleUrl);
		expect(worker).toBe(fakeWorker);
		expect(workerConstructor).toHaveBeenCalledWith('blob:wasm-rust-worker-bootstrap', {
			type: 'module'
		});
		expect(createObjectURL).toHaveBeenCalledTimes(1);
		expect(await bootstrapBlob?.text()).toBe(
			'import "http://127.0.0.1:4174/compiler-worker.js?v=test-cache-bust";\n'
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(revokeObjectURL).toHaveBeenCalledWith('blob:wasm-rust-worker-bootstrap');
	});
});
