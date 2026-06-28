import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { EvalToolDetails } from "../eval/types";
import { buildWorkflowShellEnvironment } from "../exec/shell-environment-policy";
import type { ToolSession } from "../tools";
import { EvalTool, type EvalToolParams } from "../tools/eval";
import { workflowScriptEnvironment } from "./script-runtime-env";
import { resolveWorkflowScriptTimeoutMs } from "./script-timeout-policy";
import type { WorkflowScriptEvalRequest, WorkflowScriptEvalResult, WorkflowScriptEvalRunner } from "./session-runtime";

export function createEvalToolScriptRunner(toolSession: ToolSession): WorkflowScriptEvalRunner {
	const runnerSessionId = crypto.randomUUID();
	return async request => {
		const evalTool = new EvalTool(await workflowScriptToolSession(toolSession, request, runnerSessionId));
		const params: EvalToolParams = {
			language: request.language,
			code: request.code,
			title: request.title,
		};
		params.timeout = workflowScriptEvalTimeoutSeconds(resolveWorkflowScriptTimeoutMs(request.timeoutMs));
		const result = await evalTool.execute(`workflow-${request.activationId}`, params, request.signal);
		return workflowScriptResultFromEvalTool(request.language, result);
	};
}

async function workflowScriptToolSession(
	toolSession: ToolSession,
	request: WorkflowScriptEvalRequest,
	runnerSessionId: string,
): Promise<ToolSession> {
	const settings = await toolSession.settings.cloneForCwd(toolSession.cwd);
	if (settings.get("tools.outputMaxColumns") !== 0) {
		settings.override("tools.outputMaxColumns", 0);
	}
	// Workflow script nodes are attempt-scoped runtime resources. Do not retain
	// Python kernels under the interactive session after a workflow has completed.
	settings.override("python.kernelMode", "per-call");
	const evalEnvironment = buildWorkflowShellEnvironment(
		workflowScriptEnvironment({ resourceDir: request.resourceDir }),
	);
	return {
		...toolSession,
		getEvalSessionId: () => `workflow-script:${runnerSessionId}:${request.activationId}`,
		getEvalEnvironment: () => evalEnvironment,
		getEvalKernelOwnerId: () => null,
		settings,
	};
}

function workflowScriptResultFromEvalTool(
	language: WorkflowScriptEvalResult["language"],
	result: AgentToolResult<EvalToolDetails | undefined>,
): WorkflowScriptEvalResult {
	const details = result.details;
	const output = textContent(result.content);
	const exitCode = exitCodeFromEvalDetails(details);
	const scriptResult: WorkflowScriptEvalResult = {
		exitCode,
		output,
		language,
	};
	if (details?.isError) {
		scriptResult.error = output || "eval script failed";
	}
	const artifactId = details?.meta?.truncation?.artifactId;
	if (artifactId !== undefined) {
		scriptResult.artifactId = artifactId;
	}
	return scriptResult;
}

function exitCodeFromEvalDetails(details: EvalToolDetails | undefined): number {
	const firstCell = details?.cells?.[0];
	if (firstCell?.exitCode !== undefined) return firstCell.exitCode;
	return details?.isError ? 1 : 0;
}

function workflowScriptEvalTimeoutSeconds(timeoutMs: number): number {
	return Math.max(1, Math.min(3600, Math.ceil(timeoutMs / 1000)));
}

function textContent(content: Array<{ type: string; text?: string }>): string {
	return content
		.filter(item => item.type === "text" && typeof item.text === "string")
		.map(item => item.text)
		.join("\n")
		.trim();
}
