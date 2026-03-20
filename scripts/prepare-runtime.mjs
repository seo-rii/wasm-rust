import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import os from 'node:os';

const projectRoot = '/home/seorii/dev/hancomac/wasm-rust';
const distRoot = path.join(projectRoot, 'dist');
const runtimeRoot = path.join(distRoot, 'runtime');
const vendorRoot = path.join(distRoot, 'vendor');
const browserWasiShimRoot = path.join(
	projectRoot,
	'node_modules',
	'@bjorn3',
	'browser_wasi_shim',
	'dist'
);
const preview2ShimRoot = path.join(
	projectRoot,
	'node_modules',
	'@bytecodealliance',
	'preview2-shim',
	'lib'
);
const jcoRoot = path.join(projectRoot, 'node_modules', '@bytecodealliance', 'jco');

const wasmRustcRoot =
	process.env.WASM_RUST_RUSTC_ROOT ||
	'/home/seorii/.cache/wasm-rust-real-rustc-20260317/rust/dist-emit-ir';
const matchingNativeToolchainRoot =
	process.env.WASM_RUST_MATCHING_NATIVE_TOOLCHAIN_ROOT ||
	'/home/seorii/.cache/wasm-rust-real-rustc-20260317/rust/build/x86_64-unknown-linux-gnu/stage2';
const matchingNativeSysrootRoot =
	process.env.WASM_RUST_MATCHING_NATIVE_SYSROOT_ROOT || wasmRustcRoot;
const llvmWasmRoot =
	process.env.WASM_RUST_LLVM_WASM_ROOT || '/home/seorii/.cache/llvm-wasm-20260319';
const wasiSdkRoot = process.env.WASM_RUST_WASI_SDK_ROOT || process.env.WASI_SDK_PATH || '';
const configuredTargetTriples = parseTargetTripleList(
	process.env.WASM_RUST_RUNTIME_TARGET_TRIPLES || 'wasm32-wasip1,wasm32-wasip2',
	'WASM_RUST_RUNTIME_TARGET_TRIPLES'
);
const defaultTargetTriple = parseTargetTriple(
	process.env.WASM_RUST_DEFAULT_TARGET_TRIPLE || 'wasm32-wasip1',
	'WASM_RUST_DEFAULT_TARGET_TRIPLE'
);
const allowMissingTargets = process.env.WASM_RUST_ALLOW_MISSING_TARGETS !== '0';
const hostTriple = process.env.WASM_RUST_HOST_TRIPLE || 'x86_64-unknown-linux-gnu';
const sampleProgram =
	process.env.WASM_RUST_SAMPLE_PROGRAM || 'fn main() { println!("hi"); }';
const bitcodeFileName =
	process.env.WASM_RUST_BITCODE_FILE_NAME ||
	'main.main.1ca70c240d7de168-cgu.0.rcgu.no-opt.bc';
const rustcMemoryInitialPages = Number(
	process.env.WASM_RUST_RUSTC_MEMORY_INITIAL_PAGES || '16384'
);
const rustcMemoryMaximumPages = Number(process.env.WASM_RUST_RUSTC_MEMORY_MAXIMUM_PAGES || '65536');
const runtimeVersion =
	process.env.WASM_RUST_RUNTIME_VERSION || 'rust-1.79.0-dev-browser-split-v2';

if (!configuredTargetTriples.includes(defaultTargetTriple)) {
	throw new Error(
		`WASM_RUST_DEFAULT_TARGET_TRIPLE=${defaultTargetTriple} must be present in WASM_RUST_RUNTIME_TARGET_TRIPLES`
	);
}

function parseTargetTriple(value, label) {
	if (value !== 'wasm32-wasip1' && value !== 'wasm32-wasip2') {
		throw new Error(`invalid ${label}: ${value}`);
	}
	return value;
}

function parseTargetTripleList(value, label) {
	const entries = value
		.split(',')
		.map((entry) => entry.trim())
		.filter(Boolean);
	if (entries.length === 0) {
		throw new Error(`${label} must contain at least one target`);
	}
	return [...new Set(entries.map((entry) => parseTargetTriple(entry, label)))];
}

function relativeAssetPath(root, fullPath) {
	return path.relative(root, fullPath).replaceAll(path.sep, '/');
}

async function ensureDirectory(targetPath) {
	await fs.mkdir(targetPath, { recursive: true });
}

async function pathExists(targetPath) {
	try {
		await fs.access(targetPath);
		return true;
	} catch {
		return false;
	}
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

function toImportPath(fromFilePath, targetPath) {
	const relativePath = path
		.relative(path.dirname(fromFilePath), targetPath)
		.replaceAll(path.sep, '/');
	return relativePath.startsWith('.') ? relativePath : `./${relativePath}`;
}

function replaceQuotedSpecifier(input, specifier, replacement) {
	return input
		.replaceAll(`'${specifier}'`, `'${replacement}'`)
		.replaceAll(`"${specifier}"`, `"${replacement}"`);
}

async function copyBrowserVendorAssets() {
	const browserWasiShimVendorRoot = path.join(vendorRoot, 'browser_wasi_shim');
	const preview2ShimVendorRoot = path.join(vendorRoot, 'preview2-shim');
	const jcoVendorRoot = path.join(vendorRoot, 'jco');

	await fs.rm(browserWasiShimVendorRoot, { recursive: true, force: true });
	await fs.rm(preview2ShimVendorRoot, { recursive: true, force: true });
	await fs.rm(jcoVendorRoot, { recursive: true, force: true });

	await copyTree(browserWasiShimRoot, browserWasiShimVendorRoot);
	await copyTree(preview2ShimRoot, path.join(preview2ShimVendorRoot, 'lib'));
	await copyTree(path.join(jcoRoot, 'obj'), path.join(jcoVendorRoot, 'obj'));
	await copyFileIfNeeded(
		path.join(jcoRoot, 'src', 'browser.js'),
		path.join(jcoVendorRoot, 'src', 'browser.js')
	);
	await copyFileIfNeeded(
		path.join(jcoRoot, 'lib', 'wasi_snapshot_preview1.command.wasm'),
		path.join(jcoVendorRoot, 'lib', 'wasi_snapshot_preview1.command.wasm')
	);

	const distFiles = await listFiles(distRoot);
	const replacementTargets = [
		{
			specifier: '@bjorn3/browser_wasi_shim',
			targetPath: path.join(browserWasiShimVendorRoot, 'index.js')
		},
		{
			specifier: '@bytecodealliance/preview2-shim',
			targetPath: path.join(preview2ShimVendorRoot, 'lib', 'browser', 'index.js')
		},
		{
			specifier: '@bytecodealliance/preview2-shim/cli',
			targetPath: path.join(preview2ShimVendorRoot, 'lib', 'browser', 'cli.js')
		},
		{
			specifier: '@bytecodealliance/preview2-shim/filesystem',
			targetPath: path.join(preview2ShimVendorRoot, 'lib', 'browser', 'filesystem.js')
		},
		{
			specifier: '@bytecodealliance/preview2-shim/io',
			targetPath: path.join(preview2ShimVendorRoot, 'lib', 'browser', 'io.js')
		},
		{
			specifier: '@bytecodealliance/preview2-shim/random',
			targetPath: path.join(preview2ShimVendorRoot, 'lib', 'browser', 'random.js')
		}
	];

	for (const filePath of distFiles) {
		if (!filePath.endsWith('.js')) {
			continue;
		}
		let current = await fs.readFile(filePath, 'utf8');
		let next = current;
		for (const rule of replacementTargets) {
			if (!next.includes(rule.specifier)) {
				continue;
			}
			next = replaceQuotedSpecifier(next, rule.specifier, toImportPath(filePath, rule.targetPath));
		}
		if (next !== current) {
			await fs.writeFile(filePath, next);
		}
	}
}

async function patchRustcMemoryMaximum(rustcTargetPath) {
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
			return;
		}
	}

	throw new Error('failed to locate rustc.wasm memory import while patching maximum pages');
}

function parseWasiSdkVersion(text) {
	const match =
		text.match(/wasi-sdk[^0-9]*([0-9]+)(?:\.([0-9]+))?/i) ||
		text.match(/\b([0-9]+)\.([0-9]+)(?:\.[0-9]+)?\b/);
	if (!match) {
		return null;
	}
	return {
		major: Number(match[1]),
		minor: Number(match[2] || '0')
	};
}

async function detectWasiSdkVersion(root) {
	const candidates = [path.basename(root)];
	for (const filePath of [
		path.join(root, 'VERSION'),
		path.join(root, 'share', 'wasi-sdk', 'VERSION'),
		path.join(root, 'share', 'wasi-sdk', 'version.txt')
	]) {
		try {
			candidates.push(await fs.readFile(filePath, 'utf8'));
		} catch {}
	}
	for (const candidate of candidates) {
		const parsed = parseWasiSdkVersion(candidate);
		if (parsed) {
			return parsed;
		}
	}
	return null;
}

async function resolveWasiSdkSupport() {
	if (!wasiSdkRoot) {
		return null;
	}
	if (!(await pathExists(wasiSdkRoot))) {
		throw new Error(`configured WASM_RUST_WASI_SDK_ROOT does not exist: ${wasiSdkRoot}`);
	}
	const componentLinkerPath = path.join(wasiSdkRoot, 'bin', 'wasm-component-ld');
	if (!(await pathExists(componentLinkerPath))) {
		throw new Error(`wasi-sdk at ${wasiSdkRoot} is missing bin/wasm-component-ld`);
	}
	const version = await detectWasiSdkVersion(wasiSdkRoot);
	if (!version) {
		throw new Error(`failed to determine wasi-sdk version under ${wasiSdkRoot}`);
	}
	if (version.major < 22) {
		throw new Error(
			`wasi-sdk >= 22 is required for wasm32-wasip2 support (found ${version.major}.${version.minor} at ${wasiSdkRoot})`
		);
	}
	return {
		root: wasiSdkRoot,
		componentLinkerPath,
		version
	};
}

function getTargetArtifactProfile(targetTriple) {
	if (targetTriple === 'wasm32-wasip2') {
		return {
			artifactFormat: 'component',
			compileKind: 'llvm-wasm+component-encoder',
			executionKind: 'preview2-component'
		};
	}
	return {
		artifactFormat: 'core-wasm',
		compileKind: 'llvm-wasm',
		executionKind: 'preview1'
	};
}

async function captureNativeLinkInputs(targetTriple) {
	const tempRoot = await fs.mkdtemp(
		path.join(os.tmpdir(), `wasm-rust-link-manifest-${targetTriple.replaceAll('-', '_')}-`)
	);
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
				matchingNativeSysrootRoot,
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
		if (!(await pathExists(linkArgsPath))) {
			throw new Error(
				`failed to capture native link recipe for ${targetTriple}; rustc did not reach the linker wrapper`
			);
		}
	}

	const tempEntries = await fs.readdir(tempRoot);
	const allocatorObjectName = tempEntries.find(
		(entry) => entry.endsWith('.rcgu.o') && !entry.includes('-cgu.0.')
	);
	if (!allocatorObjectName) {
		throw new Error(`failed to locate allocator shim object for ${targetTriple} in ${tempRoot}`);
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

async function resolveWasiSdkBuiltinsPath(wasiSdkSupport) {
	if (!wasiSdkSupport) {
		return null;
	}
	const clangRoot = path.join(wasiSdkSupport.root, 'lib', 'clang');
	if (!(await pathExists(clangRoot))) {
		return null;
	}
	const entries = await fs.readdir(clangRoot, { withFileTypes: true });
	const versions = entries
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort()
		.reverse();
	for (const version of versions) {
		const candidate = path.join(
			clangRoot,
			version,
			'lib',
			'wasi',
			'libclang_rt.builtins-wasm32.a'
		);
		if (await pathExists(candidate)) {
			return candidate;
		}
	}
	return null;
}

async function resolveWasiSdkLibcPath(targetTriple, wasiSdkSupport) {
	if (!wasiSdkSupport) {
		return null;
	}
	const sysrootLibRoot = path.join(wasiSdkSupport.root, 'share', 'wasi-sysroot', 'lib');
	const candidateDirectories =
		targetTriple === 'wasm32-wasip2'
			? ['wasm32-wasip2', 'wasm32-wasip1', 'wasm32-wasi']
			: ['wasm32-wasip1', 'wasm32-wasi'];
	for (const directoryName of candidateDirectories) {
		const candidate = path.join(sysrootLibRoot, directoryName, 'libc.a');
		if (await pathExists(candidate)) {
			return candidate;
		}
	}
	return null;
}

function isLinkAssetPath(value) {
	return (
		value.endsWith('.rlib') ||
		value.endsWith('.o') ||
		value.endsWith('.a') ||
		value.endsWith('.so') ||
		value.endsWith('.bc') ||
		value.endsWith('.wasm')
	);
}

function maybeTranslateMappedPath(arg, mappingRoots) {
	if (!path.isAbsolute(arg)) {
		return null;
	}
	for (const mapping of mappingRoots) {
		if (arg === mapping.sourceRoot || arg.startsWith(mapping.sourceRoot + path.sep)) {
			const relativePath = path.relative(mapping.sourceRoot, arg).replaceAll(path.sep, '/');
			return {
				runtimePath: relativePath ? `${mapping.runtimeRoot}/${relativePath}` : mapping.runtimeRoot,
				asset:
					relativePath && mapping.assetRoot
						? `${mapping.assetRoot}/${relativePath}`
						: mapping.assetRoot || null
			};
		}
	}
	return null;
}

function sanitizeLinkArgsForBrowser(targetTriple, args) {
	if (targetTriple !== 'wasm32-wasip2') {
		return args;
	}
	const valueFlags = new Set(['--adapt', '--wasi-adapter']);
	const bareFlags = new Set(['--merge-imports-based-on-semver', '--validate-component']);
	const sanitized = [];
	for (let index = 0; index < args.length; index += 1) {
		const current = args[index];
		if (valueFlags.has(current)) {
			index += 1;
			continue;
		}
		if (
			current.startsWith('--adapt=') ||
			current.startsWith('--wasi-adapter=')
		) {
			continue;
		}
		if (bareFlags.has(current)) {
			continue;
		}
		sanitized.push(current);
	}
	return sanitized;
}

async function buildLinkManifest({
	nativeLinkArgs,
	allocatorObjectPath,
	tempRoot,
	targetRustLibDir,
	targetTriple,
	wasiSdkSupport
}) {
	const allocatorObjectAsset = `link/${targetTriple}/alloc.o`;
	const targetRustLibSelfContainedDir = path.join(targetRustLibDir, 'self-contained');
	const builtinsPath = await resolveWasiSdkBuiltinsPath(wasiSdkSupport);
	const libcPath = await resolveWasiSdkLibcPath(targetTriple, wasiSdkSupport);
	const mappingRoots = [
		{
			sourceRoot: allocatorObjectPath,
			runtimeRoot: '/work/alloc.o',
			assetRoot: allocatorObjectAsset
		},
		{
			sourceRoot: targetRustLibSelfContainedDir,
			runtimeRoot: '/rustlib/self-contained',
			assetRoot: `sysroot/lib/rustlib/${targetTriple}/lib/self-contained`
		},
		{
			sourceRoot: targetRustLibDir,
			runtimeRoot: '/rustlib',
			assetRoot: `sysroot/lib/rustlib/${targetTriple}/lib`
		}
	];
	if (wasiSdkSupport) {
		mappingRoots.push(
			{
				sourceRoot: path.join(wasiSdkSupport.root, 'share', 'wasi-sysroot'),
				runtimeRoot: '/wasi-sdk/share/wasi-sysroot',
				assetRoot: 'wasi-sdk/share/wasi-sysroot'
			},
			{
				sourceRoot: path.join(wasiSdkSupport.root, 'lib'),
				runtimeRoot: '/wasi-sdk/lib',
				assetRoot: 'wasi-sdk/lib'
			}
		);
	}
	mappingRoots.sort((left, right) => right.sourceRoot.length - left.sourceRoot.length);

	const expandedLinkArgs = [];
	for (let index = 0; index < nativeLinkArgs.length; index += 1) {
		const current = nativeLinkArgs[index];
		const next = nativeLinkArgs[index + 1];
		if (current === '-l' && next === 'c') {
			if (builtinsPath) {
				expandedLinkArgs.push(builtinsPath);
			}
			if (libcPath) {
				expandedLinkArgs.push(libcPath);
			} else if (targetTriple === 'wasm32-wasip2') {
				throw new Error(`failed to resolve wasi-sdk libc.a for ${targetTriple}`);
			} else {
				expandedLinkArgs.push(current, next);
			}
			index += 1;
			continue;
		}
		if (current === '-lc') {
			if (builtinsPath) {
				expandedLinkArgs.push(builtinsPath);
			}
			if (libcPath) {
				expandedLinkArgs.push(libcPath);
			} else if (targetTriple === 'wasm32-wasip2') {
				throw new Error(`failed to resolve wasi-sdk libc.a for ${targetTriple}`);
			} else {
				expandedLinkArgs.push(current);
			}
			continue;
		}
		expandedLinkArgs.push(current);
	}

	const translatedLinkArgs = [];
	const linkedAssets = [];
	let insertedBrowserMainObject = false;
	for (const arg of expandedLinkArgs) {
		if (
			path.isAbsolute(arg) &&
			arg.endsWith('.o') &&
			arg !== allocatorObjectPath &&
			(arg === tempRoot || arg.startsWith(tempRoot + path.sep))
		) {
			if (!insertedBrowserMainObject) {
				translatedLinkArgs.push('/work/main.o');
				insertedBrowserMainObject = true;
			}
			continue;
		}
		if (arg.startsWith('-L') && path.isAbsolute(arg.slice(2))) {
			const translated = maybeTranslateMappedPath(arg.slice(2), mappingRoots);
			translatedLinkArgs.push(translated ? `-L${translated.runtimePath}` : arg);
			continue;
		}
		const translated = maybeTranslateMappedPath(arg, mappingRoots);
		if (!translated) {
			translatedLinkArgs.push(arg);
			continue;
		}
		translatedLinkArgs.push(translated.runtimePath);
		if (translated.asset && isLinkAssetPath(arg)) {
			linkedAssets.push({
				asset: translated.asset,
				runtimePath: translated.runtimePath,
				sourcePath: arg
			});
		}
	}

	const sanitizedLinkArgs = sanitizeLinkArgsForBrowser(targetTriple, translatedLinkArgs);
	while (sanitizedLinkArgs[0] && !sanitizedLinkArgs[0].startsWith('-')) {
		sanitizedLinkArgs.shift();
	}

	const outputIndex = sanitizedLinkArgs.findIndex((arg) => arg === '-o');
	if (outputIndex === -1 || outputIndex + 1 >= sanitizedLinkArgs.length) {
		throw new Error(`translated link args for ${targetTriple} are missing -o`);
	}
	sanitizedLinkArgs[outputIndex + 1] = '/work/main.wasm';

	const dedupedFiles = [];
	const dedupedAssetCopies = [];
	const seenRuntimePaths = new Set();
	const seenAssets = new Set();
	for (const entry of linkedAssets) {
		if (!entry.runtimePath || entry.runtimePath === '/work/alloc.o') {
			continue;
		}
		if (seenRuntimePaths.has(entry.runtimePath)) {
			continue;
		}
		seenRuntimePaths.add(entry.runtimePath);
		dedupedFiles.push({
			asset: entry.asset,
			runtimePath: entry.runtimePath
		});
		if (!seenAssets.has(entry.asset)) {
			seenAssets.add(entry.asset);
			dedupedAssetCopies.push({
				asset: entry.asset,
				sourcePath: entry.sourcePath
			});
		}
	}

	return {
		allocatorObjectRuntimePath: '/work/alloc.o',
		allocatorObjectAsset,
		args: sanitizedLinkArgs,
		files: dedupedFiles,
		assetCopies: dedupedAssetCopies
	};
}

function buildLegacyManifest({
	hostTriple,
	targetTriple,
	compiler,
	targetConfig
}) {
	return {
		version: runtimeVersion,
		hostTriple,
		targetTriple,
		rustcWasm: compiler.rustcWasm,
		workerBitcodeFile: compiler.workerBitcodeFile,
		workerSharedOutputBytes: compiler.workerSharedOutputBytes,
		compileTimeoutMs: compiler.compileTimeoutMs,
		artifactIdleMs: compiler.artifactIdleMs,
		rustcMemory: compiler.rustcMemory,
		sysrootFiles: targetConfig.sysrootFiles,
		llvm: targetConfig.compile.llvm,
		link: targetConfig.compile.link
	};
}

async function main() {
	await fs.rm(runtimeRoot, { recursive: true, force: true });
	await ensureDirectory(runtimeRoot);
	await copyBrowserVendorAssets();

	const rustcTargetPath = path.join(runtimeRoot, 'rustc', 'rustc.wasm');
	await copyFileIfNeeded(path.join(wasmRustcRoot, 'bin', 'rustc.wasm'), rustcTargetPath);
	await patchRustcMemoryMaximum(rustcTargetPath);

	const llvmFiles = ['llc.js', 'llc.wasm', 'lld.js', 'lld.wasm', 'lld.data'];
	for (const entry of llvmFiles) {
		await copyFileIfNeeded(path.join(llvmWasmRoot, entry), path.join(runtimeRoot, 'llvm', entry));
	}

	const sysrootSourceRoot = path.join(wasmRustcRoot, 'lib', 'rustlib');
	const sysrootTargetRoot = path.join(runtimeRoot, 'sysroot', 'lib', 'rustlib');
	const hostLibSource = path.join(sysrootSourceRoot, hostTriple, 'lib');
	if (!(await pathExists(hostLibSource))) {
		throw new Error(`missing host sysroot libraries at ${hostLibSource}`);
	}
	const copiedHostFiles = await copyTree(
		hostLibSource,
		path.join(sysrootTargetRoot, hostTriple, 'lib')
	);

	const compiler = {
		rustcWasm: 'rustc/rustc.wasm',
		workerBitcodeFile: bitcodeFileName,
		workerSharedOutputBytes: 32 * 1024 * 1024,
		compileTimeoutMs: 120_000,
		artifactIdleMs: 1_500,
		rustcMemory: {
			initialPages: rustcMemoryInitialPages,
			maximumPages: rustcMemoryMaximumPages
		}
	};

	const wasiSdkSupport = await resolveWasiSdkSupport().catch((error) => {
		if (
			configuredTargetTriples.includes('wasm32-wasip2') &&
			!allowMissingTargets
		) {
			throw error;
		}
		console.warn(`[wasm-rust] skipping wasi-sdk component support: ${error.message}`);
		return null;
	});

	const targets = {};
	for (const targetTriple of configuredTargetTriples) {
		const profile = getTargetArtifactProfile(targetTriple);
		const targetLibSource = path.join(sysrootSourceRoot, targetTriple, 'lib');
		if (!(await pathExists(targetLibSource))) {
			const message = `missing target sysroot libraries at ${targetLibSource}`;
			if (allowMissingTargets && targetTriple !== defaultTargetTriple) {
				console.warn(`[wasm-rust] skipping ${targetTriple}: ${message}`);
				continue;
			}
			throw new Error(message);
		}
		if (targetTriple === 'wasm32-wasip2' && !wasiSdkSupport) {
			const message =
				'wasm32-wasip2 packaging requires WASM_RUST_WASI_SDK_ROOT pointing to wasi-sdk >= 22 with wasm-component-ld';
			if (allowMissingTargets && targetTriple !== defaultTargetTriple) {
				console.warn(`[wasm-rust] skipping ${targetTriple}: ${message}`);
				continue;
			}
			throw new Error(message);
		}

		const copiedTargetFiles = await copyTree(
			targetLibSource,
			path.join(sysrootTargetRoot, targetTriple, 'lib')
		);
		const { allocatorObjectPath, nativeLinkArgs, tempRoot } = await captureNativeLinkInputs(targetTriple);
		const allocatorAssetPath = path.join(runtimeRoot, 'link', targetTriple, 'alloc.o');
		await copyFileIfNeeded(allocatorObjectPath, allocatorAssetPath);

		const { assetCopies, ...link } = await buildLinkManifest({
			nativeLinkArgs,
			allocatorObjectPath,
			tempRoot,
			targetRustLibDir: path.join(
				matchingNativeSysrootRoot,
				'lib',
				'rustlib',
				targetTriple,
				'lib'
			),
			targetTriple,
			wasiSdkSupport
		});
		for (const assetCopy of assetCopies) {
			await copyFileIfNeeded(assetCopy.sourcePath, path.join(runtimeRoot, assetCopy.asset));
		}
		const sysrootFiles = copiedTargetFiles.map((filePath) => ({
			asset: `sysroot/lib/rustlib/${relativeAssetPath(sysrootSourceRoot, filePath)}`,
			runtimePath: `/lib/rustlib/${relativeAssetPath(sysrootSourceRoot, filePath)}`
		}));
		targets[targetTriple] = {
			artifactFormat: profile.artifactFormat,
			sysrootFiles,
			compile: {
				kind: profile.compileKind,
				llvm: {
					llc: 'llvm/llc.js',
					lld: 'llvm/lld.js'
				},
				link
			},
			execution: {
				kind: profile.executionKind
			}
		};
	}

	if (!targets['wasm32-wasip1']) {
		throw new Error('legacy runtime-manifest.json requires a packaged wasm32-wasip1 target');
	}
	if (!targets[defaultTargetTriple]) {
		throw new Error(`default target ${defaultTargetTriple} is unavailable after runtime packaging`);
	}

	const runtimeManifestV2 = {
		manifestVersion: 2,
		version: runtimeVersion,
		hostTriple,
		defaultTargetTriple,
		compiler,
		targets
	};
	const runtimeManifestV1 = buildLegacyManifest({
		hostTriple,
		targetTriple: 'wasm32-wasip1',
		compiler,
		targetConfig: targets['wasm32-wasip1']
	});

	await fs.writeFile(
		path.join(runtimeRoot, 'runtime-manifest.v2.json'),
		JSON.stringify(runtimeManifestV2, null, 2) + '\n'
	);
	await fs.writeFile(
		path.join(runtimeRoot, 'runtime-manifest.json'),
		JSON.stringify(runtimeManifestV1, null, 2) + '\n'
	);
}

await main();
