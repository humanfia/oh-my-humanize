import { ptree } from "@oh-my-pi/pi-utils";
import { buildNonInteractiveEnv } from "../exec/non-interactive-env";
import type { ToolSession } from "../tools";
import { workflowScriptEnvironment } from "./script-runtime-env";
import type {
	WorkflowScriptEvalResult,
	WorkflowShellScriptRequest,
	WorkflowShellScriptRunner,
} from "./session-runtime";

const WORKFLOW_SHELL_TIMEOUT_MS = 60 * 60 * 1000;

export function createShellScriptRunner(toolSession: ToolSession): WorkflowShellScriptRunner {
	return async request => {
		const timeoutMs = request.timeoutMs ?? WORKFLOW_SHELL_TIMEOUT_MS;
		const result = await ptree.exec(["sh"], {
			cwd: toolSession.cwd,
			input: `${request.code}\n`,
			timeout: timeoutMs,
			signal: request.signal,
			env: workflowShellEnv(request),
			detached: process.platform !== "win32",
			allowAbort: true,
			allowNonZero: true,
			stderr: "full",
		});
		const output = workflowShellOutput(result.stdout, result.stderr);
		const scriptResult: WorkflowScriptEvalResult = {
			exitCode: result.exitCode ?? 1,
			output,
			language: request.language,
		};
		if (result.exitError?.aborted) {
			const error = workflowShellAbortError(output, result.exitError, timeoutMs);
			scriptResult.error = error;
			if (!scriptResult.output) scriptResult.output = error;
		} else if (result.exitCode === undefined || result.exitCode === null) {
			scriptResult.error = "shell script missing exit status";
		} else if (result.exitCode !== 0) {
			scriptResult.error = `exit code ${result.exitCode}`;
		}
		return scriptResult;
	};
}

function workflowShellAbortError(output: string, error: ptree.Exception, timeoutMs: number): string {
	if (error instanceof ptree.TimeoutError) {
		return output || `Command timed out after ${Math.round(timeoutMs / 1000)} seconds`;
	}
	return output || "Command cancelled";
}

function workflowShellEnv(request: WorkflowShellScriptRequest): Record<string, string> {
	return buildNonInteractiveEnv(workflowScriptEnvironment(request));
}

function workflowShellOutput(stdout: string, stderr: string): string {
	if (stdout.length === 0) return stderr.trim();
	if (stderr.length === 0) return stdout.trim();
	return `${stdout.trimEnd()}\n${stderr.trimStart()}`.trim();
}

export function workflowShellCommand(code: string): string {
	const delimiter = workflowShellHeredocDelimiter(code);
	return `sh <<'${delimiter}'\n${code}\n${delimiter}`;
}

function workflowShellHeredocDelimiter(code: string): string {
	let index = 0;
	while (code.includes(`__OMP_WORKFLOW_SH_${index}__`)) {
		index++;
	}
	return `__OMP_WORKFLOW_SH_${index}__`;
}
