import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import os from 'node:os';

const projectRoot = '/home/seorii/dev/hancomac/wasm-rust';
const distRoot = path.join(projectRoot, 'dist');
const runtimeRoot = path.join(distRoot, 'runtime');
const browserWasiShimRoot = path.join(
	projectRoot,
	'node_modules',
	'@bjorn3',
	'browser_wasi_shim',
	'dist'
);
const wasmRustcRoot =
	process.env.WASM_RUST_RUSTC_ROOT ||
	'/home/seorii/.cache/wasm-rust-real-rustc-20260317/rust/dist-emit-ir';
const matchingNativeToolchainRoot =
	process.env.WASM_RUST_MATCHING_NATIVE_TOOLCHAIN_ROOT ||
	'/home/seorii/.cache/wasm-rust-real-rustc-20260317/rust/build/x86_64-unknown-linux-gnu/stage2';
const llvmWasmRoot =
	process.env.WASM_RUST_LLVM_WASM_ROOT || '/home/seorii/.cache/llvm-wasm-20260319';
const targetTriple = process.env.WASM_RUST_TARGET_TRIPLE || 'wasm32-wasip1';
const hostTriple = process.env.WASM_RUST_HOST_TRIPLE || 'x86_64-unknown-linux-gnu';
const sampleProgram =
	process.env.WASM_RUST_SAMPLE_PROGRAM || 'fn main() { println!("hi"); }';
const bitcodeFileName =
	process.env.WASM_RUST_BITCODE_FILE_NAME ||
	'main.main.1ca70c240d7de168-cgu.0.rcgu.no-opt.bc';
const rustcMemoryInitialPages = Number(process.env.WASM_RUST_RUSTC_MEMORY_INITIAL_PAGES || '8192');
const rustcMemoryMaximumPages = Number(process.env.WASM_RUST_RUSTC_MEMORY_MAXIMUM_PAGES || '65536');

function relativeAssetPath(root, fullPath) {
	return path.relative(root, fullPath).replaceAll(path.sep, '/');
}

async function ensureDirectory(targetPath) {
	await fs.mkdir(targetPath, { recursive: true });
}

async function copyFileIfNeeded(sourcePath, targetPath) {
	await ensureDirectory(path.dirname(targetPath));
	const sourceStat = await fs.stat(sourcePath);
	try {
		const targetStat = await fs.stat(targetPath);
		if (
			targetStat.size === sourceStat.size &&
			Math.trunc(targetStat.mtimeMs) === Math.trunc(sourceStat.mtimeMs)
		) {
			return;
		}
	} catch {}
	await fs.copyFile(sourcePath, targetPath);
	await fs.utimes(targetPath, sourceStat.atime, sourceStat.mtime);
}

async function listFiles(rootPath) {
	const entries = await fs.readdir(rootPath, { withFileTypes: true });
	const results = [];
	for (const entry of entries) {
		const fullPath = path.join(rootPath, entry.name);
		if (entry.isDirectory()) {
			results.push(...(await listFiles(fullPath)));
			continue;
		}
		if (entry.isFile()) {
			results.push(fullPath);
		}
	}
	return results.sort();
}

async function copyTree(sourceRoot, targetRoot) {
	const files = await listFiles(sourceRoot);
	for (const filePath of files) {
		await copyFileIfNeeded(filePath, path.join(targetRoot, path.relative(sourceRoot, filePath)));
	}
	return files;
}

async function rewriteBrowserWasiShimImports() {
	const vendorRoot = path.join(distRoot, 'vendor', 'browser_wasi_shim');
	await copyTree(browserWasiShimRoot, vendorRoot);

	const distFiles = await listFiles(distRoot);
	for (const filePath of distFiles) {
		if (!filePath.endsWith('.js')) {
			continue;
		}
		if (filePath.startsWith(vendorRoot + path.sep)) {
			continue;
		}
		const current = await fs.readFile(filePath, 'utf8');
		if (!current.includes('@bjorn3/browser_wasi_shim')) {
			continue;
		}
		const replacementPath = path
			.relative(path.dirname(filePath), path.join(vendorRoot, 'index.js'))
			.replaceAll(path.sep, '/');
		await fs.writeFile(
			filePath,
			current.replaceAll(
				"'@bjorn3/browser_wasi_shim'",
				`'${replacementPath.startsWith('.') ? replacementPath : './' + replacementPath}'`
			)
		);
	}
}

async function captureNativeLinkInputs() {
	const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wasm-rust-link-manifest-'));
	const sourcePath = path.join(tempRoot, 'main.rs');
	const wrapperPath = path.join(tempRoot, 'rust-lld-wrapper.sh');
	const linkArgsPath = path.join(tempRoot, 'rust-lld-link-args.txt');
	const outputPath = path.join(tempRoot, 'native-main.wasm');
	const rustcPath = path.join(matchingNativeToolchainRoot, 'bin', 'rustc');

	await fs.writeFile(sourcePath, sampleProgram);
	await fs.writeFile(
		wrapperPath,
		[
			'#!/usr/bin/env bash',
			`printf '%s\\n' "$@" > ${JSON.stringify(linkArgsPath)}`,
			'exit 1'
		].join('\n'),
		{ mode: 0o755 }
	);

	try {
		execFileSync(
			rustcPath,
			[
				'--sysroot',
				matchingNativeToolchainRoot,
				'--target',
				targetTriple,
				'-Clinker=' + wrapperPath,
				'-Cpanic=abort',
				'-Ccodegen-units=1',
				'-Csave-temps',
				sourcePath,
				'-o',
				outputPath
			],
			{ stdio: 'ignore' }
		);
	} catch {
		await fs.access(linkArgsPath);
	}

	const tempEntries = await fs.readdir(tempRoot);
	const allocatorObjectName = tempEntries.find(
		(entry) => entry.endsWith('.rcgu.o') && !entry.includes('-cgu.0.')
	);
	if (!allocatorObjectName) {
		throw new Error(`failed to locate allocator shim object in ${tempRoot}`);
	}

	const nativeLinkArgs = (await fs.readFile(linkArgsPath, 'utf8'))
		.split('\n')
		.map((line) => line.trim())
		.filter(Boolean);

	return {
		tempRoot,
		allocatorObjectPath: path.join(tempRoot, allocatorObjectName),
		nativeLinkArgs
	};
}

function buildLinkManifest({ nativeLinkArgs, allocatorObjectPath, targetRustLibDir }) {
	const targetRustLibSelfContainedDir = path.join(targetRustLibDir, 'self-contained');
	const mainObjectArg = nativeLinkArgs.find((arg) => arg.endsWith('-cgu.0.rcgu.o'));
	if (!mainObjectArg) {
		throw new Error('failed to locate main object argument in native link args');
	}

	const fileMap = new Map([
		[mainObjectArg, '/work/main.o'],
		[allocatorObjectPath, '/work/alloc.o'],
		[targetRustLibDir, '/rustlib'],
		[targetRustLibSelfContainedDir, '/rustlib/self-contained']
	]);
	const linkedRustlibAssets = [];
	const isMaterializedLinkAsset = (arg) =>
		arg.endsWith('.rlib') ||
		arg.endsWith('.o') ||
		arg.endsWith('.a') ||
		arg.endsWith('.so') ||
		arg.endsWith('.bc');

	for (const arg of nativeLinkArgs) {
		if (!path.isAbsolute(arg)) {
			continue;
		}
		if (arg.startsWith(targetRustLibSelfContainedDir + path.sep)) {
			const runtimePath =
				'/rustlib/self-contained/' +
				path.relative(targetRustLibSelfContainedDir, arg).replaceAll(path.sep, '/');
			fileMap.set(arg, runtimePath);
			if (isMaterializedLinkAsset(arg)) {
				linkedRustlibAssets.push({
					asset:
						'sysroot/lib/rustlib/' +
						targetTriple +
						'/lib/self-contained/' +
						path.relative(targetRustLibSelfContainedDir, arg).replaceAll(path.sep, '/'),
					runtimePath
				});
			}
			continue;
		}
		if (arg.startsWith(targetRustLibDir + path.sep)) {
			const runtimePath =
				'/rustlib/' + path.relative(targetRustLibDir, arg).replaceAll(path.sep, '/');
			fileMap.set(arg, runtimePath);
			if (isMaterializedLinkAsset(arg)) {
				linkedRustlibAssets.push({
					asset:
						'sysroot/lib/rustlib/' +
						targetTriple +
						'/lib/' +
						path.relative(targetRustLibDir, arg).replaceAll(path.sep, '/'),
					runtimePath
				});
			}
		}
	}

	const translatedLinkArgs = nativeLinkArgs.map((arg) => {
		if (fileMap.has(arg)) {
			return fileMap.get(arg);
		}
		if (arg.startsWith('-L') && fileMap.has(arg.slice(2))) {
			return '-L' + fileMap.get(arg.slice(2));
		}
		return arg;
	});

	while (translatedLinkArgs[0] && !translatedLinkArgs[0].startsWith('-')) {
		translatedLinkArgs.shift();
	}

	const libcIndex = translatedLinkArgs.findIndex((arg) => arg === 'c');
	if (libcIndex >= 0 && translatedLinkArgs[libcIndex - 1] === '-l') {
		translatedLinkArgs.splice(
			libcIndex - 1,
			0,
			'-L',
			'/lib/wasm32-wasi',
			'/lib/clang/16.0.4/lib/wasi/libclang_rt.builtins-wasm32.a'
		);
	}

	const outputIndex = translatedLinkArgs.findIndex((arg) => arg === '-o');
	if (outputIndex === -1 || outputIndex + 1 >= translatedLinkArgs.length) {
		throw new Error('translated link args are missing -o');
	}
	translatedLinkArgs[outputIndex + 1] = '/work/main.wasm';

	const dedupedFiles = [];
	const seen = new Set();
	for (const entry of linkedRustlibAssets) {
		if (seen.has(entry.runtimePath)) {
			continue;
		}
		seen.add(entry.runtimePath);
		dedupedFiles.push(entry);
	}

	return {
		allocatorObjectRuntimePath: '/work/alloc.o',
		allocatorObjectAsset: 'link/alloc.o',
		args: translatedLinkArgs,
		files: dedupedFiles
	};
}

async function main() {
	await ensureDirectory(runtimeRoot);
	await rewriteBrowserWasiShimImports();

	const rustcTargetPath = path.join(runtimeRoot, 'rustc', 'rustc.wasm');
	await copyFileIfNeeded(path.join(wasmRustcRoot, 'bin', 'rustc.wasm'), rustcTargetPath);
	{
		const rustcBytes = new Uint8Array(await fs.readFile(rustcTargetPath));
		let cursor = 8;
		const readLeb = () => {
			let result = 0;
			let shift = 0;
			const start = cursor;
			while (true) {
				const byte = rustcBytes[cursor++];
				result |= (byte & 0x7f) << shift;
				if ((byte & 0x80) === 0) {
					return {
						value: result >>> 0,
						start,
						end: cursor
					};
				}
				shift += 7;
			}
		};
		const encodeLeb = (value) => {
			const encoded = [];
			let remaining = value >>> 0;
			do {
				let byte = remaining & 0x7f;
				remaining >>>= 7;
				if (remaining !== 0) {
					byte |= 0x80;
				}
				encoded.push(byte);
			} while (remaining !== 0);
			return encoded;
		};
		while (cursor < rustcBytes.length) {
			const sectionId = rustcBytes[cursor++];
			const sectionSize = readLeb();
			const sectionStart = cursor;
			const sectionEnd = sectionStart + sectionSize.value;
			if (sectionId !== 2) {
				cursor = sectionEnd;
				continue;
			}
			const importCount = readLeb().value;
			for (let importIndex = 0; importIndex < importCount; importIndex += 1) {
				const moduleLength = readLeb().value;
				cursor += moduleLength;
				const fieldLength = readLeb().value;
				cursor += fieldLength;
				const kind = rustcBytes[cursor++];
				if (kind === 0) {
					readLeb();
					continue;
				}
				if (kind === 1) {
					const elementType = rustcBytes[cursor++];
					if (elementType !== 0x60) {
						throw new Error(`unexpected rustc.wasm table import element type ${elementType}`);
					}
					readLeb();
					readLeb();
					continue;
				}
				if (kind === 3) {
					cursor += 2;
					continue;
				}
				if (kind !== 2) {
					throw new Error(`unsupported rustc.wasm import kind ${kind}`);
				}
				const flags = readLeb().value;
				readLeb();
				if ((flags & 1) !== 1) {
					throw new Error('rustc.wasm memory import does not declare a maximum');
				}
				const maximum = readLeb();
				const encodedMaximum = encodeLeb(rustcMemoryMaximumPages);
				if (encodedMaximum.length !== maximum.end - maximum.start) {
					throw new Error(
						`rustc.wasm memory maximum LEB size mismatch for ${rustcMemoryMaximumPages}`
					);
				}
				rustcBytes.set(encodedMaximum, maximum.start);
				await fs.writeFile(rustcTargetPath, rustcBytes);
				cursor = rustcBytes.length;
				break;
			}
		}
	}

	const llvmFiles = ['llc.js', 'llc.wasm', 'lld.js', 'lld.wasm', 'lld.data'];
	for (const entry of llvmFiles) {
		await copyFileIfNeeded(path.join(llvmWasmRoot, entry), path.join(runtimeRoot, 'llvm', entry));
	}

	const sysrootSourceRoot = path.join(wasmRustcRoot, 'lib', 'rustlib');
	const sysrootTargetRoot = path.join(runtimeRoot, 'sysroot', 'lib', 'rustlib');
	const hostLibSource = path.join(sysrootSourceRoot, hostTriple, 'lib');
	const targetLibSource = path.join(sysrootSourceRoot, targetTriple, 'lib');
	const copiedHostFiles = await copyTree(
		hostLibSource,
		path.join(sysrootTargetRoot, hostTriple, 'lib')
	);
	const copiedTargetFiles = await copyTree(
		targetLibSource,
		path.join(sysrootTargetRoot, targetTriple, 'lib')
	);

	const { allocatorObjectPath, nativeLinkArgs } = await captureNativeLinkInputs();
	await copyFileIfNeeded(allocatorObjectPath, path.join(runtimeRoot, 'link', 'alloc.o'));

	const link = buildLinkManifest({
		nativeLinkArgs,
		allocatorObjectPath,
		targetRustLibDir: path.join(
			matchingNativeToolchainRoot,
			'lib',
			'rustlib',
			targetTriple,
			'lib'
		)
	});

	const sysrootFiles = [...copiedHostFiles, ...copiedTargetFiles].map((filePath) => ({
		asset: 'sysroot/lib/rustlib/' + relativeAssetPath(sysrootSourceRoot, filePath),
		runtimePath: '/lib/rustlib/' + relativeAssetPath(sysrootSourceRoot, filePath)
	}));

	const runtimeManifest = {
		version: 'rust-1.79.0-dev-browser-split-v1',
		hostTriple,
		targetTriple,
		rustcWasm: 'rustc/rustc.wasm',
		workerBitcodeFile: bitcodeFileName,
		workerSharedOutputBytes: 32 * 1024 * 1024,
		compileTimeoutMs: 120_000,
		artifactIdleMs: 1_500,
		rustcMemory: {
			initialPages: rustcMemoryInitialPages,
			maximumPages: rustcMemoryMaximumPages
		},
		sysrootFiles,
		llvm: {
			llc: 'llvm/llc.js',
			lld: 'llvm/lld.js'
		},
		link
	};

	await fs.writeFile(
		path.join(runtimeRoot, 'runtime-manifest.json'),
		JSON.stringify(runtimeManifest, null, 2) + '\n'
	);
}

await main();
