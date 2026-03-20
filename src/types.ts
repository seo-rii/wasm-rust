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
	};
}

export interface BrowserRustCompiler {
	compile: (request: BrowserRustCompileRequest) => Promise<BrowserRustCompilerResult>;
}

export type BrowserRustCompilerFactory = () => Promise<BrowserRustCompiler>;
