import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const steps = [
	{
		label: 'fast ci lane',
		command: 'pnpm',
		args: ['run', 'test:ci:fast']
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
