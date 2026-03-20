import { resolveVersionedAssetUrl } from './asset-url.js';
import type { BrowserRustArtifactFormat, SupportedTargetTriple } from './types.js';

export interface RuntimeAssetFile {
	asset: string;
	runtimePath: string;
}

export interface RuntimeCompilerConfig {
	rustcWasm: string;
	workerBitcodeFile: string;
	workerSharedOutputBytes: number;
	compileTimeoutMs: number;
	artifactIdleMs: number;
	rustcMemory: {
		initialPages: number;
		maximumPages: number;
	};
}

export interface RuntimeLinkConfig {
	allocatorObjectRuntimePath: string;
	allocatorObjectAsset: string;
	args: string[];
	files: RuntimeAssetFile[];
}

export interface RuntimeTargetCompileConfig {
	kind: 'llvm-wasm' | 'llvm-wasm+component-encoder';
	llvm: {
		llc: string;
		lld: string;
	};
	link: RuntimeLinkConfig;
}

export interface RuntimeTargetExecutionConfig {
	kind: 'preview1' | 'preview2-component';
}

export interface RuntimeTargetConfig {
	targetTriple: SupportedTargetTriple;
	artifactFormat: BrowserRustArtifactFormat;
	sysrootFiles: RuntimeAssetFile[];
	compile: RuntimeTargetCompileConfig;
	execution: RuntimeTargetExecutionConfig;
}

export interface RuntimeManifestV1 {
	version: string;
	hostTriple: string;
	targetTriple: SupportedTargetTriple;
	rustcWasm: string;
	workerBitcodeFile: string;
	workerSharedOutputBytes: number;
	compileTimeoutMs: number;
	artifactIdleMs: number;
	rustcMemory: {
		initialPages: number;
		maximumPages: number;
	};
	sysrootFiles: RuntimeAssetFile[];
	llvm: {
		llc: string;
		lld: string;
	};
	link: RuntimeLinkConfig;
}

export interface RuntimeManifestV2 {
	manifestVersion: 2;
	version: string;
	hostTriple: string;
	defaultTargetTriple: SupportedTargetTriple;
	compiler: RuntimeCompilerConfig;
	targets: Partial<Record<SupportedTargetTriple, Omit<RuntimeTargetConfig, 'targetTriple'>>>;
}

export interface NormalizedRuntimeManifest {
	manifestVersion: 1 | 2;
	version: string;
	hostTriple: string;
	defaultTargetTriple: SupportedTargetTriple;
	compiler: RuntimeCompilerConfig;
	targets: Partial<Record<SupportedTargetTriple, RuntimeTargetConfig>>;
}

export type RuntimeManifest = RuntimeManifestV1 | RuntimeManifestV2;

function isNormalizedRuntimeManifest(
	value: RuntimeManifest | NormalizedRuntimeManifest
): value is NormalizedRuntimeManifest {
	if (!('compiler' in value) || !('targets' in value) || !('defaultTargetTriple' in value)) {
		return false;
	}
	for (const targetConfig of Object.values(value.targets)) {
		if (targetConfig && !('targetTriple' in targetConfig)) {
			return false;
		}
	}
	return true;
}

function isRuntimeManifestV2(
	value: RuntimeManifest | NormalizedRuntimeManifest
): value is RuntimeManifestV2 {
	return 'manifestVersion' in value && value.manifestVersion === 2;
}

function expectObject(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error(`invalid ${label} in wasm-rust runtime manifest`);
	}
	return value as Record<string, unknown>;
}

function expectString(value: unknown, label: string): string {
	if (typeof value !== 'string' || value.length === 0) {
		throw new Error(`invalid ${label} in wasm-rust runtime manifest`);
	}
	return value;
}

function expectNumber(value: unknown, label: string): number {
	if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
		throw new Error(`invalid ${label} in wasm-rust runtime manifest`);
	}
	return value;
}

function expectStringArray(value: unknown, label: string): string[] {
	if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
		throw new Error(`invalid ${label} in wasm-rust runtime manifest`);
	}
	return value as string[];
}

function expectTargetTriple(value: unknown, label: string): SupportedTargetTriple {
	if (value !== 'wasm32-wasip1' && value !== 'wasm32-wasip2') {
		throw new Error(`invalid ${label} in wasm-rust runtime manifest`);
	}
	return value;
}

function expectArtifactFormat(value: unknown, label: string): BrowserRustArtifactFormat {
	if (value !== 'core-wasm' && value !== 'component') {
		throw new Error(`invalid ${label} in wasm-rust runtime manifest`);
	}
	return value;
}

function expectCompileKind(value: unknown, label: string): RuntimeTargetCompileConfig['kind'] {
	if (value !== 'llvm-wasm' && value !== 'llvm-wasm+component-encoder') {
		throw new Error(`invalid ${label} in wasm-rust runtime manifest`);
	}
	return value;
}

function expectExecutionKind(value: unknown, label: string): RuntimeTargetExecutionConfig['kind'] {
	if (value !== 'preview1' && value !== 'preview2-component') {
		throw new Error(`invalid ${label} in wasm-rust runtime manifest`);
	}
	return value;
}

function expectAssetFileArray(value: unknown, label: string): RuntimeAssetFile[] {
	if (!Array.isArray(value)) {
		throw new Error(`invalid ${label} in wasm-rust runtime manifest`);
	}
	return value.map((entry, index) => {
		const object = expectObject(entry, `${label}[${index}]`);
		return {
			asset: expectString(object.asset, `${label}[${index}].asset`),
			runtimePath: expectString(object.runtimePath, `${label}[${index}].runtimePath`)
		};
	});
}

function parseRustcMemory(value: unknown, label: string): RuntimeCompilerConfig['rustcMemory'] {
	const object = expectObject(value, label);
	return {
		initialPages: expectNumber(object.initialPages, `${label}.initialPages`),
		maximumPages: expectNumber(object.maximumPages, `${label}.maximumPages`)
	};
}

function parseCompilerConfig(value: unknown, label: string): RuntimeCompilerConfig {
	const object = expectObject(value, label);
	return {
		rustcWasm: expectString(object.rustcWasm, `${label}.rustcWasm`),
		workerBitcodeFile: expectString(object.workerBitcodeFile, `${label}.workerBitcodeFile`),
		workerSharedOutputBytes: expectNumber(
			object.workerSharedOutputBytes,
			`${label}.workerSharedOutputBytes`
		),
		compileTimeoutMs: expectNumber(object.compileTimeoutMs, `${label}.compileTimeoutMs`),
		artifactIdleMs: expectNumber(object.artifactIdleMs, `${label}.artifactIdleMs`),
		rustcMemory: parseRustcMemory(object.rustcMemory, `${label}.rustcMemory`)
	};
}

function parseLinkConfig(value: unknown, label: string): RuntimeLinkConfig {
	const object = expectObject(value, label);
	return {
		allocatorObjectRuntimePath: expectString(
			object.allocatorObjectRuntimePath,
			`${label}.allocatorObjectRuntimePath`
		),
		allocatorObjectAsset: expectString(object.allocatorObjectAsset, `${label}.allocatorObjectAsset`),
		args: expectStringArray(object.args, `${label}.args`),
		files: expectAssetFileArray(object.files, `${label}.files`)
	};
}

function parseRuntimeTargetConfig(
	value: unknown,
	label: string,
	targetTriple: SupportedTargetTriple
): RuntimeTargetConfig {
	const object = expectObject(value, label);
	const compile = expectObject(object.compile, `${label}.compile`);
	const llvm = expectObject(compile.llvm, `${label}.compile.llvm`);
	const execution = expectObject(object.execution, `${label}.execution`);
	return {
		targetTriple,
		artifactFormat: expectArtifactFormat(object.artifactFormat, `${label}.artifactFormat`),
		sysrootFiles: expectAssetFileArray(object.sysrootFiles, `${label}.sysrootFiles`),
		compile: {
			kind: expectCompileKind(compile.kind, `${label}.compile.kind`),
			llvm: {
				llc: expectString(llvm.llc, `${label}.compile.llvm.llc`),
				lld: expectString(llvm.lld, `${label}.compile.llvm.lld`)
			},
			link: parseLinkConfig(compile.link, `${label}.compile.link`)
		},
		execution: {
			kind: expectExecutionKind(execution.kind, `${label}.execution.kind`)
		}
	};
}

export function parseRuntimeManifest(value: unknown): RuntimeManifest {
	const root = expectObject(value, 'root');

	if (root.manifestVersion === 2) {
		const targets = expectObject(root.targets, 'targets');
		const parsedTargets: RuntimeManifestV2['targets'] = {};
		for (const targetTriple of ['wasm32-wasip1', 'wasm32-wasip2'] as const) {
			const targetValue = targets[targetTriple];
			if (targetValue === undefined) {
				continue;
			}
			const parsedTarget = parseRuntimeTargetConfig(
				targetValue,
				`targets.${targetTriple}`,
				targetTriple
			);
			parsedTargets[targetTriple] = {
				artifactFormat: parsedTarget.artifactFormat,
				sysrootFiles: parsedTarget.sysrootFiles,
				compile: parsedTarget.compile,
				execution: parsedTarget.execution
			};
		}
		return {
			manifestVersion: 2,
			version: expectString(root.version, 'version'),
			hostTriple: expectString(root.hostTriple, 'hostTriple'),
			defaultTargetTriple: expectTargetTriple(root.defaultTargetTriple, 'defaultTargetTriple'),
			compiler: parseCompilerConfig(root.compiler, 'compiler'),
			targets: parsedTargets
		};
	}

	const llvm = expectObject(root.llvm, 'llvm');
	return {
		version: expectString(root.version, 'version'),
		hostTriple: expectString(root.hostTriple, 'hostTriple'),
		targetTriple: expectTargetTriple(root.targetTriple, 'targetTriple'),
		rustcWasm: expectString(root.rustcWasm, 'rustcWasm'),
		workerBitcodeFile: expectString(root.workerBitcodeFile, 'workerBitcodeFile'),
		workerSharedOutputBytes: expectNumber(root.workerSharedOutputBytes, 'workerSharedOutputBytes'),
		compileTimeoutMs: expectNumber(root.compileTimeoutMs, 'compileTimeoutMs'),
		artifactIdleMs: expectNumber(root.artifactIdleMs, 'artifactIdleMs'),
		rustcMemory: parseRustcMemory(root.rustcMemory, 'rustcMemory'),
		sysrootFiles: expectAssetFileArray(root.sysrootFiles, 'sysrootFiles'),
		llvm: {
			llc: expectString(llvm.llc, 'llvm.llc'),
			lld: expectString(llvm.lld, 'llvm.lld')
		},
		link: parseLinkConfig(root.link, 'link')
	};
}

export function normalizeRuntimeManifest(
	value: RuntimeManifest | NormalizedRuntimeManifest
): NormalizedRuntimeManifest {
	if (isNormalizedRuntimeManifest(value)) {
		return value;
	}

	if (isRuntimeManifestV2(value)) {
		const targets: NormalizedRuntimeManifest['targets'] = {};
		for (const [targetTriple, targetConfig] of Object.entries(value.targets) as Array<
			[SupportedTargetTriple, RuntimeManifestV2['targets'][SupportedTargetTriple]]
		>) {
			if (!targetConfig) {
				continue;
			}
			targets[targetTriple] = {
				targetTriple,
				artifactFormat: targetConfig.artifactFormat,
				sysrootFiles: targetConfig.sysrootFiles,
				compile: targetConfig.compile,
				execution: targetConfig.execution
			};
		}
		return {
			manifestVersion: 2,
			version: value.version,
			hostTriple: value.hostTriple,
			defaultTargetTriple: value.defaultTargetTriple,
			compiler: value.compiler,
			targets
		};
	}

	return {
		manifestVersion: 1,
		version: value.version,
		hostTriple: value.hostTriple,
		defaultTargetTriple: value.targetTriple,
		compiler: {
			rustcWasm: value.rustcWasm,
			workerBitcodeFile: value.workerBitcodeFile,
			workerSharedOutputBytes: value.workerSharedOutputBytes,
			compileTimeoutMs: value.compileTimeoutMs,
			artifactIdleMs: value.artifactIdleMs,
			rustcMemory: value.rustcMemory
		},
		targets: {
			[value.targetTriple]: {
				targetTriple: value.targetTriple,
				artifactFormat: 'core-wasm',
				sysrootFiles: value.sysrootFiles,
				compile: {
					kind: 'llvm-wasm',
					llvm: value.llvm,
					link: value.link
				},
				execution: {
					kind: 'preview1'
				}
			}
		}
	};
}

export function resolveTargetManifest(
	manifest: NormalizedRuntimeManifest,
	targetTriple: SupportedTargetTriple = manifest.defaultTargetTriple
): RuntimeTargetConfig {
	const target = manifest.targets[targetTriple];
	if (!target) {
		throw new Error(
			`unsupported wasm-rust target ${targetTriple}; available targets: ${Object.keys(manifest.targets).join(', ') || 'none'}`
		);
	}
	return target;
}

export async function loadRuntimeManifest(
	manifestUrl: string | URL,
	fetchImpl: typeof fetch = fetch
): Promise<RuntimeManifest> {
	const response = await fetchImpl(manifestUrl.toString());
	if (!response.ok) {
		throw new Error(`failed to load wasm-rust runtime manifest from ${manifestUrl}`);
	}
	return parseRuntimeManifest(await response.json());
}

export function resolveRuntimeAssetUrl(baseUrl: string | URL, assetPath: string): string {
	return resolveVersionedAssetUrl(baseUrl, assetPath).toString();
}
