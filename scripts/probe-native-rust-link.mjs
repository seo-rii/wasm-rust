import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const DEFAULT_TOOLCHAIN_ROOT =
	'/home/seorii/.rustup/toolchains/nightly-2024-04-12-x86_64-unknown-linux-gnu';
const DEFAULT_TARGET_TRIPLE = 'wasm32-wasip1';
const DEFAULT_LLD = '/tmp/wasi-sdk-20.0/bin/lld';
const SAMPLE_PROGRAM = 'fn main() { println!("hi"); }\n';

function runCommand(command, args, cwd) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd,
			stdio: ['ignore', 'pipe', 'pipe']
		});
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr.on('data', (chunk) => {
			stderr += chunk.toString();
		});
		child.on('error', reject);
		child.on('close', (code) => {
			if (code !== 0) {
				reject(
					new Error(
						`${command} ${args.join(' ')} failed with code ${code}\n${stdout}\n${stderr}`.trim()
					)
				);
				return;
			}
			resolve({ stdout, stderr });
		});
	});
}

async function buildAndRun() {
	const toolchainRoot = process.env.WASM_RUST_NATIVE_TOOLCHAIN_ROOT || DEFAULT_TOOLCHAIN_ROOT;
	const targetTriple = process.env.WASM_RUST_NATIVE_TARGET_TRIPLE || DEFAULT_TARGET_TRIPLE;
	const lld = process.env.WASM_RUST_NATIVE_LLD || DEFAULT_LLD;
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wasm-rust-native-link-'));
	const sourcePath = path.join(tempDir, 'main.rs');
	const linkerPath = path.join(tempDir, 'linker.sh');
	const argsPath = path.join(tempDir, 'linker-args.txt');
	const outputPath = path.join(tempDir, 'main.wasm');
	const rustcPath = path.join(toolchainRoot, 'bin', 'rustc');
	const libdir = path.join(toolchainRoot, 'lib', 'rustlib', targetTriple, 'lib');
	const crt1 = path.join(libdir, 'self-contained', 'crt1-command.o');

	await fs.writeFile(sourcePath, SAMPLE_PROGRAM);
	await fs.writeFile(
		linkerPath,
		[
			'#!/usr/bin/env bash',
			`printf '%s\\n' "$@" > ${JSON.stringify(argsPath)}`,
			'exit 1',
			''
		].join('\n')
	);
	await fs.chmod(linkerPath, 0o755);

	await runCommand(
		rustcPath,
		[
			'--target',
			targetTriple,
			'-Ccodegen-units=1',
			'-Csave-temps',
			`-Clinker=${linkerPath}`,
			sourcePath
		],
		tempDir
	).catch(() => null);

	const objectFiles = (await fs.readdir(tempDir))
		.filter((entry) => entry.endsWith('.o'))
		.sort()
		.map((entry) => path.join(tempDir, entry));

	const linkArgs = [
		'-flavor',
		'wasm',
		'--export',
		'__main_void',
		'-z',
		'stack-size=1048576',
		'--stack-first',
		'--allow-undefined',
		'--no-demangle',
		crt1,
		...objectFiles,
		'-L',
		libdir,
		path.join(libdir, 'libstd-5b2ea09f17180546.rlib'),
		path.join(libdir, 'libpanic_abort-fbb177a0979c9425.rlib'),
		path.join(libdir, 'libwasi-ba8c2c1ece0b9236.rlib'),
		path.join(libdir, 'librustc_demangle-c45290ee6d0b5753.rlib'),
		path.join(libdir, 'libstd_detect-27f533ab1e93a18d.rlib'),
		path.join(libdir, 'libhashbrown-9c2daa78883a82ca.rlib'),
		path.join(libdir, 'librustc_std_workspace_alloc-6ec209aa46d72e84.rlib'),
		path.join(libdir, 'libminiz_oxide-ac5ca8fe286890d7.rlib'),
		path.join(libdir, 'libadler-e542879ad99432f9.rlib'),
		path.join(libdir, 'libunwind-1abfb6ade0197bc3.rlib'),
		path.join(libdir, 'libcfg_if-473239d350633fdb.rlib'),
		path.join(libdir, 'liblibc-69a024b479bafbb3.rlib'),
		'-l',
		'c',
		path.join(libdir, 'liballoc-94c6caf9e8e1bbe9.rlib'),
		path.join(libdir, 'librustc_std_workspace_core-92291f0148887aae.rlib'),
		path.join(libdir, 'libcore-9a916268ce47f469.rlib'),
		path.join(libdir, 'libcompiler_builtins-c5a7c6f338f5da37.rlib'),
		'-L',
		libdir,
		'-L',
		path.join(libdir, 'self-contained'),
		'-o',
		outputPath,
		'--gc-sections',
		'-O0'
	];

	await runCommand(lld, linkArgs, tempDir);
	const runResult = await runCommand(
		'node',
		[
			'-e',
			[
				"const { WASI } = require('node:wasi');",
				"const fs = require('node:fs');",
				`const wasi = new WASI({ version: 'preview1', args: ['main.wasm'], env: process.env, preopens: { '/': '/' } });`,
				`const bytes = fs.readFileSync(${JSON.stringify(outputPath)});`,
				'const mod = new WebAssembly.Module(bytes);',
				"WebAssembly.instantiate(mod, { env: {}, wasi_snapshot_preview1: wasi.wasiImport }).then((instance) => wasi.start(instance));"
			].join(' ')
		],
		tempDir
	);

	return {
		success: true,
		toolchainRoot,
		targetTriple,
		lld,
		tempDir,
		objectFiles: objectFiles.map((file) => path.basename(file)),
		linkerArgs: (await fs.readFile(argsPath, 'utf8')).trim().split('\n'),
		outputBytes: (await fs.stat(outputPath)).size,
		stdout: runResult.stdout,
		stderr: runResult.stderr
	};
}

buildAndRun()
	.then((result) => {
		console.log(JSON.stringify(result, null, 2));
	})
	.catch((error) => {
		console.error(
			JSON.stringify(
				{
					success: false,
					message: error instanceof Error ? error.message : String(error)
				},
				null,
				2
			)
		);
		process.exitCode = 1;
	});
