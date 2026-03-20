import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const projectRoot = '/home/seorii/dev/hancomac/wasm-rust';

async function runNode(args: string[], env: NodeJS.ProcessEnv = {}) {
	const childEnv: NodeJS.ProcessEnv = {
		...process.env,
		...env
	};
	delete childEnv.NODE_OPTIONS;
	delete childEnv.VITEST;
	for (const key of Object.keys(childEnv)) {
		if (key.startsWith('VITEST_')) {
			delete childEnv[key];
		}
	}
	const captureDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wasm-rust-browser-harness-test-'));
	const stdoutPath = path.join(captureDir, 'stdout.txt');
	const stderrPath = path.join(captureDir, 'stderr.txt');
	const shellCommand = `node ${args.map((arg) => JSON.stringify(arg)).join(' ')} >${JSON.stringify(stdoutPath)} 2>${JSON.stringify(stderrPath)}`;

	try {
		await execFileAsync('/bin/bash', ['-lc', shellCommand], {
			cwd: projectRoot,
			env: childEnv,
			maxBuffer: 128 * 1024 * 1024
		});
		return {
			stdout: await fs.readFile(stdoutPath, 'utf8').catch(() => ''),
			stderr: await fs.readFile(stderrPath, 'utf8').catch(() => '')
		};
	} catch (error) {
		(error as NodeJS.ErrnoException & { stdout?: string; stderr?: string }).stdout = await fs
			.readFile(stdoutPath, 'utf8')
			.catch(() => '');
		(error as NodeJS.ErrnoException & { stdout?: string; stderr?: string }).stderr = await fs
			.readFile(stderrPath, 'utf8')
			.catch(() => '');
		throw error;
	} finally {
		await fs.rm(captureDir, { recursive: true, force: true });
	}
}

describe('browser harness probe', () => {
	it(
		'compiles and runs hello world in Chromium when the real browser runtime is available',
		async () => {
			if (process.env.WASM_RUST_RUN_REAL_BROWSER_HARNESS !== '1') {
				return;
			}

			const { stdout, stderr } = await runNode(['./scripts/probe-browser-harness.mjs']);
			const result = JSON.parse((stdout.trim() || stderr.trim()) as string) as {
				success: boolean;
				result: {
					compile: { success: boolean };
					runtime: { stdout: string; exitCode: number | null } | null;
				};
			};

			expect(result.success).toBe(true);
			expect(result.result.compile.success).toBe(true);
			expect(result.result.runtime?.stdout).toBe('hi\n');
			expect(result.result.runtime?.exitCode).toBe(0);
		},
		780_000
	);
});
