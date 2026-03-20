import { resolveVersionedAssetUrl } from './asset-url.js';

export interface RuntimeAssetFile {
	asset: string;
	runtimePath: string;
}

export interface RuntimeManifest {
	version: string;
	hostTriple: string;
	targetTriple: string;
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
	link: {
		allocatorObjectRuntimePath: string;
		allocatorObjectAsset: string;
		args: string[];
		files: RuntimeAssetFile[];
	};
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

export function parseRuntimeManifest(value: unknown): RuntimeManifest {
	const root = expectObject(value, 'root');
	const rustcMemory = expectObject(root.rustcMemory, 'rustcMemory');
	const llvm = expectObject(root.llvm, 'llvm');
	const link = expectObject(root.link, 'link');

	return {
		version: expectString(root.version, 'version'),
		hostTriple: expectString(root.hostTriple, 'hostTriple'),
		targetTriple: expectString(root.targetTriple, 'targetTriple'),
		rustcWasm: expectString(root.rustcWasm, 'rustcWasm'),
		workerBitcodeFile: expectString(root.workerBitcodeFile, 'workerBitcodeFile'),
		workerSharedOutputBytes: expectNumber(root.workerSharedOutputBytes, 'workerSharedOutputBytes'),
		compileTimeoutMs: expectNumber(root.compileTimeoutMs, 'compileTimeoutMs'),
		artifactIdleMs: expectNumber(root.artifactIdleMs, 'artifactIdleMs'),
		rustcMemory: {
			initialPages: expectNumber(rustcMemory.initialPages, 'rustcMemory.initialPages'),
			maximumPages: expectNumber(rustcMemory.maximumPages, 'rustcMemory.maximumPages')
		},
		sysrootFiles: expectAssetFileArray(root.sysrootFiles, 'sysrootFiles'),
		llvm: {
			llc: expectString(llvm.llc, 'llvm.llc'),
			lld: expectString(llvm.lld, 'llvm.lld')
		},
		link: {
			allocatorObjectRuntimePath: expectString(
				link.allocatorObjectRuntimePath,
				'link.allocatorObjectRuntimePath'
			),
			allocatorObjectAsset: expectString(link.allocatorObjectAsset, 'link.allocatorObjectAsset'),
			args: expectStringArray(link.args, 'link.args'),
			files: expectAssetFileArray(link.files, 'link.files')
		}
	};
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
