import { componentizeCoreWasmToPreview2Component } from './browser-component-tools.js';
import {
	resolveRuntimeAssetUrl,
	type NormalizedRuntimeManifest,
	type RuntimeTargetConfig
} from './runtime-manifest.js';
import type { BrowserRustCompilerResult } from './types.js';

function mkdirp(module: { FS: { mkdir(path: string): void } }, targetPath: string) {
	const segments = targetPath.replace(/^\/+/, '').split('/').filter(Boolean);
	let current = '';
	for (const segment of segments) {
		current += '/' + segment;
		try {
			module.FS.mkdir(current);
		} catch {}
	}
}

function formatToolFailure(
	label: string,
	stage: string,
	stderr: string[],
	stdout: string[],
	detail?: string
) {
	const parts = [`${label} ${stage} failed`];
	if (detail) {
		parts.push(detail);
	}
	if (stderr.length > 0) {
		parts.push(`stderr=${stderr.join('\n')}`);
	}
	if (stdout.length > 0) {
		parts.push(`stdout=${stdout.join('\n')}`);
	}
	return new Error(parts.join(' | '));
}

export async function linkBitcodeWithLlvmWasm(
	bitcode: Uint8Array,
	manifest: NormalizedRuntimeManifest,
	target: RuntimeTargetConfig,
	runtimeBaseUrl: string
): Promise<NonNullable<BrowserRustCompilerResult['artifact']>> {
	const { default: Llc } = await import(
		resolveRuntimeAssetUrl(runtimeBaseUrl, target.compile.llvm.llc)
	);
	const llcStdout: string[] = [];
	const llcStderr: string[] = [];
	const llc = await Llc({
		locateFile(file: string) {
			return resolveRuntimeAssetUrl(runtimeBaseUrl, `llvm/${file}`);
		},
		print(text: string) {
			llcStdout.push(String(text));
		},
		printErr(text: string) {
			llcStderr.push(String(text));
		}
	});
	mkdirp(llc, '/work');
	llc.FS.writeFile('/work/main.bc', bitcode);
	try {
		await llc.callMain(['-filetype=obj', '-o', '/work/main.o', '/work/main.bc']);
	} catch (error) {
		throw formatToolFailure(
			'llc',
			'codegen',
			llcStderr,
			llcStdout,
			error instanceof Error ? error.message : String(error)
		);
	}
	let mainObject: Uint8Array;
	try {
		mainObject = llc.FS.readFile('/work/main.o');
	} catch (error) {
		throw formatToolFailure(
			'llc',
			'output-read',
			llcStderr,
			llcStdout,
			error instanceof Error ? error.message : String(error)
		);
	}

	const { default: Lld } = await import(
		resolveRuntimeAssetUrl(runtimeBaseUrl, target.compile.llvm.lld)
	);
	const lldStdout: string[] = [];
	const lldStderr: string[] = [];
	const lld = await Lld({
		locateFile(file: string) {
			return resolveRuntimeAssetUrl(runtimeBaseUrl, `llvm/${file}`);
		},
		print(text: string) {
			lldStdout.push(String(text));
		},
		printErr(text: string) {
			lldStderr.push(String(text));
		}
	});
	const addFile = async (runtimePath: string, assetPath: string, contents?: Uint8Array) => {
		mkdirp(lld, runtimePath.split('/').slice(0, -1).join('/'));
		if (contents) {
			lld.FS.writeFile(runtimePath, contents);
			return;
		}
		const assetUrl = resolveRuntimeAssetUrl(runtimeBaseUrl, assetPath);
		const response = await fetch(assetUrl);
		if (!response.ok) {
			throw new Error(`failed to fetch wasm-rust link asset ${assetPath} from ${assetUrl}`);
		}
		lld.FS.writeFile(runtimePath, new Uint8Array(await response.arrayBuffer()));
	};

	await addFile('/work/main.o', '', mainObject);
	await addFile(
		target.compile.link.allocatorObjectRuntimePath,
		target.compile.link.allocatorObjectAsset
	);
	for (const entry of target.compile.link.files) {
		await addFile(entry.runtimePath, entry.asset);
	}
	try {
		await lld.callMain([...target.compile.link.args]);
	} catch (error) {
		throw formatToolFailure(
			'lld',
			'link',
			lldStderr,
			lldStdout,
			error instanceof Error ? error.message : String(error)
		);
	}
	try {
		const coreWasm = lld.FS.readFile('/work/main.wasm');
		if (target.compile.kind === 'llvm-wasm+component-encoder') {
			const component = await componentizeCoreWasmToPreview2Component(coreWasm, runtimeBaseUrl);
			return {
				wasm: component,
				targetTriple: target.targetTriple,
				format: 'component'
			};
		}
		return {
			wasm: coreWasm,
			targetTriple: target.targetTriple,
			format: target.artifactFormat
		};
	} catch (error) {
		throw formatToolFailure(
			'lld',
			'output-read',
			lldStderr,
			lldStdout,
			error instanceof Error ? error.message : String(error)
		);
	}
}
