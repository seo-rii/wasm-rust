export type SupportedTargetTriple = 'wasm32-wasip1' | 'wasm32-wasip2' | 'wasm32-wasip3';
export type BrowserRustArtifactFormat = 'core-wasm' | 'component';

export interface CompilerDiagnostic {
	lineNumber: number;
	columnNumber: number;
	severity: 'error' | 'warning' | 'other';
	message: string;
}

export interface BrowserRustCompileRequest {
	code: string;
	channel?: string;
	mode?: string;
	edition?: string;
	crateType?: string;
	targetTriple?: SupportedTargetTriple;
	log?: boolean;
	prepare?: boolean;
}

export interface BrowserRustCompilerResult {
	success: boolean;
	stdout?: string;
	stderr?: string;
	diagnostics?: CompilerDiagnostic[];
	artifact?: {
		wasm?: Uint8Array | ArrayBuffer;
		wat?: string;
		targetTriple: SupportedTargetTriple;
		format: BrowserRustArtifactFormat;
	};
}

export interface BrowserRustCompiler {
	compile: (request: BrowserRustCompileRequest) => Promise<BrowserRustCompilerResult>;
}

export type BrowserRustCompilerFactory = () => Promise<BrowserRustCompiler>;
