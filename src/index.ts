import {
	compileRust,
	type BrowserRustCompileProgress,
	type BrowserRustCompiler,
	type BrowserRustCompilerFactory,
	type BrowserRustCompilerResult,
	type BrowserRustCompileRequest,
	type BrowserRustCompileStage,
	type CompilerDiagnostic,
	type CreateRustCompilerOptions
} from './compiler.js';
import {
	executeBrowserRustArtifact,
	type BrowserExecutionOptions,
	type BrowserExecutionResult
} from './browser-execution.js';

export type {
	BrowserRustCompiler,
	BrowserRustCompilerFactory,
	BrowserRustCompilerResult,
	BrowserRustCompileRequest,
	BrowserRustCompileProgress,
	BrowserRustCompileStage,
	CompilerDiagnostic,
	CreateRustCompilerOptions,
	BrowserExecutionOptions,
	BrowserExecutionResult
};
export { executeBrowserRustArtifact };

export async function createRustCompiler(
	options?: CreateRustCompilerOptions
): Promise<BrowserRustCompiler> {
	return {
		compile: async (request) => compileRust(request, options?.dependencies)
	};
}

const defaultFactory: BrowserRustCompilerFactory = createRustCompiler;

export default defaultFactory;
