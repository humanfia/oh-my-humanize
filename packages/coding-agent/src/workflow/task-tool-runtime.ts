import { type TaskParams, TaskTool } from "../task";
import type { ToolSession } from "../tools";
import type { WorkflowAgentTaskResult, WorkflowAgentTaskRunner } from "./session-runtime";

const WORKFLOW_TASK_RETRY_BASE_DELAY_MS = 30_000;
const WORKFLOW_TASK_RETRY_MAX_DELAY_MS = 300_000;

export function createTaskToolAgentRunner(toolSession: ToolSession): WorkflowAgentTaskRunner {
	return async request => {
		const taskTool = await TaskTool.create(
			await synchronousTaskToolSession(toolSession, { requireIsolation: request.isolated === true }),
		);
		const params: TaskParams = {
			agent: request.agent,
			id: request.task.id,
			description: request.task.description,
			role: request.task.role,
			assignment: request.task.assignment,
		};
		if (request.modelOverride !== undefined) {
			params.modelOverride = request.modelOverride;
		}
		if (request.modelOverrideAuthFallback !== undefined) {
			params.modelOverrideAuthFallback = request.modelOverrideAuthFallback;
		}
		if (request.isolated !== undefined) params.isolated = request.isolated;
		if (request.apply !== undefined) params.apply = request.apply;
		if (request.merge !== undefined) params.merge = request.merge;
		if (request.capture !== undefined) params.capture = request.capture;
		const result = await taskTool.execute(`workflow-${request.activationId}`, params, request.signal);
		const taskResult = result.details?.results[0];
		const output = textContent(result.content);
		if (!taskResult) {
			const suffix = output ? `: ${output}` : "";
			return {
				exitCode: 1,
				output,
				error: `workflow agent node "${request.nodeId}" did not return a task result${suffix}`,
			};
		}
		const taskOutput: WorkflowAgentTaskResult = {
			exitCode: taskResult.exitCode,
			output: taskResult.output,
			stderr: taskResult.stderr,
			agentId: taskResult.id,
		};
		if (taskResult.error !== undefined) taskOutput.error = taskResult.error;
		const data = finalSuccessfulYieldData(taskResult.extractedToolData);
		if (data !== undefined) taskOutput.data = data;
		if (taskResult.outputPath !== undefined) taskOutput.outputPath = taskResult.outputPath;
		if (taskResult.sessionFile !== undefined) taskOutput.sessionFile = taskResult.sessionFile;
		if (taskResult.patchPath !== undefined) taskOutput.patchPath = taskResult.patchPath;
		if (taskResult.branchName !== undefined) taskOutput.branchName = taskResult.branchName;
		if (taskResult.changesApplied !== undefined) taskOutput.changesApplied = taskResult.changesApplied;
		return taskOutput;
	};
}

function finalSuccessfulYieldData(
	extractedToolData: Record<string, unknown[]> | undefined,
): Record<string, unknown> | undefined {
	const yieldItems = extractedToolData?.yield;
	if (!Array.isArray(yieldItems)) return undefined;
	for (let index = yieldItems.length - 1; index >= 0; index -= 1) {
		const item = yieldItems[index];
		if (!isRecord(item) || item.status === "aborted") continue;
		if (isRecord(item.data)) return item.data;
	}
	return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface SynchronousTaskToolSessionOptions {
	requireIsolation?: boolean;
}

async function synchronousTaskToolSession(
	toolSession: ToolSession,
	options: SynchronousTaskToolSessionOptions = {},
): Promise<ToolSession> {
	const settings = await toolSession.settings.cloneForCwd(toolSession.cwd);
	settings.override("async.enabled", false);
	if (options.requireIsolation === true && settings.get("task.isolation.mode") === "none") {
		settings.override("task.isolation.mode", "auto");
	}
	const retryBaseDelayMs = Math.max(settings.get("retry.baseDelayMs"), WORKFLOW_TASK_RETRY_BASE_DELAY_MS);
	settings.override("retry.baseDelayMs", retryBaseDelayMs);
	settings.override(
		"retry.maxDelayMs",
		Math.max(settings.get("retry.maxDelayMs"), retryBaseDelayMs, WORKFLOW_TASK_RETRY_MAX_DELAY_MS),
	);
	return { ...toolSession, taskAgentCompletionLifecycle: "park", shellEnvironmentPolicy: "workflow", settings };
}

function textContent(content: Array<{ type: string; text?: string }>): string {
	return content
		.filter(item => item.type === "text" && typeof item.text === "string")
		.map(item => item.text)
		.join("\n")
		.trim();
}
