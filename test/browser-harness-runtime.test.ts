import { describe, expect, it } from 'vitest';

import { isBrowserHarnessProbeSuccessful } from '../scripts/browser-harness-runtime.mjs';

describe('browser harness runtime helpers', () => {
	it('treats zero-exit richer stdout as a successful probe by default', () => {
		expect(
			isBrowserHarnessProbeSuccessful([
				{
					ok: true,
					result: {
						compile: { success: true },
						runtime: {
							exitCode: 0,
							stdout: 'preview2_component=preview2-cli\nfactorial_plus_bonus=27\n'
						}
					}
				}
			])
		).toBe(true);
	});

	it('supports an explicit stdout expectation hook when a caller wants exact output', () => {
		expect(
			isBrowserHarnessProbeSuccessful(
				[
					{
						ok: true,
						result: {
							compile: { success: true },
							runtime: {
								exitCode: 0,
								stdout: 'hi\n'
							}
						}
					}
				],
				'hi\n'
			)
		).toBe(true);
		expect(
			isBrowserHarnessProbeSuccessful(
				[
					{
						ok: true,
						result: {
							compile: { success: true },
							runtime: {
								exitCode: 0,
								stdout: 'preview2_component=preview2-cli\nfactorial_plus_bonus=27\n'
							}
						}
					}
				],
				'hi\n'
			)
		).toBe(false);
	});
});
