import { execFileSync } from 'node:child_process';

const projectRoot = '/home/seorii/dev/hancomac/wasm-rust';

const steps = [
	{
		label: 'build',
		command: 'pnpm',
		args: ['build']
	},
	{
		label: 'test',
		command: 'pnpm',
		args: ['test']
	},
	{
		label: 'browser probe',
		command: 'pnpm',
		args: ['run', 'probe:browser-harness']
	},
	{
		label: 'browser vitest',
		command: 'pnpm',
		args: ['exec', 'vitest', 'run', 'test/browser-harness.test.ts'],
		env: {
			WASM_RUST_RUN_REAL_BROWSER_HARNESS: '1'
		}
	},
	{
		label: 'browser playwright integration',
		command: 'pnpm',
		args: ['exec', 'vitest', 'run', 'test/browser-playwright-integration.test.ts'],
		env: {
			WASM_RUST_RUN_REAL_BROWSER_HARNESS: '1'
		}
	}
];

for (const step of steps) {
	console.log(`\n[wasm-rust] ${step.label}`);
	execFileSync(step.command, step.args, {
		cwd: projectRoot,
		stdio: 'inherit',
		env: {
			...process.env,
			...step.env
		}
	});
}

console.log('\n[wasm-rust] standalone browser validation complete');
