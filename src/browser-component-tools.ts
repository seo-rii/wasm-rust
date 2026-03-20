import { resolveRuntimeAssetUrl } from './runtime-manifest.js';

const JCO_BROWSER_MODULE = '../vendor/jco/src/browser.js';
const JCO_WASM_TOOLS_MODULE = '../vendor/jco/obj/wasm-tools.js';
const PREVIEW1_COMMAND_ADAPTER = '../vendor/jco/lib/wasi_snapshot_preview1.command.wasm';
const PREVIEW2_INSTANTIATION_MODULE = '../vendor/preview2-shim/lib/common/instantiation.js';
const PREVIEW2_CLI_MODULE = '../vendor/preview2-shim/lib/browser/cli.js';
const symbolDispose = Symbol.dispose ?? Symbol.for('dispose');

async function importRuntimeModule<T>(runtimeBaseUrl: string, assetPath: string): Promise<T> {
	return (await import(
		/* @vite-ignore */ resolveRuntimeAssetUrl(runtimeBaseUrl, assetPath)
	)) as T;
}

export async function componentizeCoreWasmToPreview2Component(
	coreWasm: Uint8Array,
	runtimeBaseUrl: string
) {
	const wasmToolsModule = await importRuntimeModule<{
		$init: Promise<void>;
		tools: {
			componentNew: (
				binary: Uint8Array,
				adapters: Array<[string, Uint8Array]>
			) => Uint8Array;
		};
	}>(runtimeBaseUrl, JCO_WASM_TOOLS_MODULE);
	const adapterUrl = resolveRuntimeAssetUrl(runtimeBaseUrl, PREVIEW1_COMMAND_ADAPTER);
	const adapterResponse = await fetch(adapterUrl);
	if (!adapterResponse.ok) {
		throw new Error(`failed to fetch wasm-rust preview1 adapter from ${adapterUrl}`);
	}
	const adapterBytes = new Uint8Array(await adapterResponse.arrayBuffer());
	await wasmToolsModule.$init;
	return wasmToolsModule.tools.componentNew(coreWasm, [['wasi_snapshot_preview1', adapterBytes]]);
}

export async function transpilePreview2Component(
	componentBytes: Uint8Array,
	runtimeBaseUrl: string,
	name = 'component'
) {
	const browserModule = await importRuntimeModule<{
		generate: (
			component: Uint8Array,
			options: {
				name: string;
				instantiation: { tag: 'async' };
				noTypescript: boolean;
				noNodejsCompat: boolean;
				map: string[][];
			}
		) => Promise<{
			files: Array<[string, Uint8Array]>;
			imports: string[];
			exports: Array<[string, 'function' | 'instance']>;
		}>;
	}>(runtimeBaseUrl, JCO_BROWSER_MODULE);
	const generated = await browserModule.generate(componentBytes, {
		name,
		instantiation: { tag: 'async' },
		noTypescript: true,
		noNodejsCompat: true,
		map: []
	});
	return {
		files: new Map(generated.files),
		imports: generated.imports,
		exports: generated.exports
	};
}

export async function createPreview2ImportObject(
	runtimeBaseUrl: string,
	options: {
		args?: string[];
		env?: Record<string, string>;
		stdin?: {
			blockingRead: (length: number) => Uint8Array;
		};
		stdout?: (chunk: Uint8Array) => void;
		stderr?: (chunk: Uint8Array) => void;
	} = {}
) {
	const [instantiationModule, cliModule] = await Promise.all([
		importRuntimeModule<{
			WASIShim: new (config?: {
				sandbox?: {
					preopens?: Record<string, string>;
					env?: Record<string, string>;
					args?: string[];
					enableNetwork?: boolean;
				};
			}) => {
				getImportObject: (options?: { asVersion?: string }) => Record<string, unknown>;
			};
		}>(runtimeBaseUrl, PREVIEW2_INSTANTIATION_MODULE),
		importRuntimeModule<{
			_setStdin: (handler: {
				blockingRead: (contents: bigint) => Uint8Array;
				subscribe?: () => unknown;
				[key: symbol]: () => void;
			}) => void;
			_setStdout: (handler: { write: (contents: Uint8Array) => bigint; blockingFlush: () => void }) => void;
			_setStderr: (handler: { write: (contents: Uint8Array) => bigint; blockingFlush: () => void }) => void;
		}>(runtimeBaseUrl, PREVIEW2_CLI_MODULE)
	]);

	if (options.stdin) {
		cliModule._setStdin({
			blockingRead(contents: bigint) {
				return options.stdin?.blockingRead(Number(contents)) || new Uint8Array(0);
			},
			[symbolDispose]() {}
		});
	}
	if (options.stdout) {
		cliModule._setStdout({
			write(contents: Uint8Array) {
				options.stdout?.(contents);
				return BigInt(contents.byteLength);
			},
			blockingFlush() {}
		});
	}
	if (options.stderr) {
		cliModule._setStderr({
			write(contents: Uint8Array) {
				options.stderr?.(contents);
				return BigInt(contents.byteLength);
			},
			blockingFlush() {}
		});
	}

	const shim = new instantiationModule.WASIShim({
		sandbox: {
			preopens: {},
			env: options.env || {},
			args: options.args || ['component.wasm'],
			enableNetwork: false
		}
	});
	return {
		...shim.getImportObject(),
		...shim.getImportObject({ asVersion: '0.2.3' })
	};
}
