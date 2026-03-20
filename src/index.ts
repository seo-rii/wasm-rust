import {
	compileRust,
	type BrowserRustCompiler,
	type BrowserRustCompilerFactory,
	type BrowserRustCompilerResult,
	type BrowserRustCompileRequest,
	type CompilerDiagnostic,
	type CreateRustCompilerOptions
} from './compiler.js';

export type {
	BrowserRustCompiler,
	BrowserRustCompilerFactory,
	BrowserRustCompilerResult,
	BrowserRustCompileRequest,
	CompilerDiagnostic,
	CreateRustCompilerOptions
};

export async function createRustCompiler(
	options?: CreateRustCompilerOptions
): Promise<BrowserRustCompiler> {
	return {
		compile: async (request) => compileRust(request, options?.dependencies)
	};
}

const defaultFactory: BrowserRustCompilerFactory = createRustCompiler;

export default defaultFactory;
