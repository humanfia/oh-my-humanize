import { executeBash } from "../exec/bash-executor";
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
		const result = await executeBash(workflowShellCommand(request.code), {
			cwd: toolSession.cwd,
			timeout: WORKFLOW_SHELL_TIMEOUT_MS,
			signal: request.signal,
			sessionKey: workflowShellSessionKey(toolSession, request.activationId),
			useUserShell: true,
			outputMaxColumns: 0,
			env: workflowShellContextEnv(request),
		});
		const scriptResult: WorkflowScriptEvalResult = {
			exitCode: result.exitCode ?? 1,
			output: result.output.trim(),
			language: request.language,
		};
		if (result.artifactId !== undefined) {
			scriptResult.artifactId = result.artifactId;
		}
		if (result.cancelled) {
			scriptResult.error = result.output.trim() || "shell script cancelled";
		} else if (result.exitCode === undefined) {
			scriptResult.error = "shell script missing exit status";
		} else if (result.exitCode !== 0) {
			scriptResult.error = `exit code ${result.exitCode}`;
		}
		return scriptResult;
	};
}

function workflowShellContextEnv(request: WorkflowShellScriptRequest): Record<string, string> | undefined {
	return workflowScriptEnvironment(request);
}

export function workflowShellCommand(code: string): string {
	const delimiter = workflowShellHeredocDelimiter(code);
	return `sh <<'${delimiter}'\n${code}\n${delimiter}`;
}

function workflowShellSessionKey(toolSession: ToolSession, activationId: string): string {
	const sessionId = toolSession.getSessionId?.() ?? "session";
	return `${sessionId}:workflow:${activationId}`;
}

function workflowShellHeredocDelimiter(code: string): string {
	let index = 0;
	while (code.includes(`__OMP_WORKFLOW_SH_${index}__`)) {
		index++;
	}
	return `__OMP_WORKFLOW_SH_${index}__`;
}
