import type { WorkflowScriptContext } from "./node-runtime";

export const WORKFLOW_CONTEXT_ENV = "OMP_WORKFLOW_CONTEXT";
export const WORKFLOW_RESOURCE_DIR_ENV = "OMP_WORKFLOW_RESOURCE_DIR";

export interface WorkflowScriptEnvironmentRequest {
	context?: WorkflowScriptContext;
	resourceDir?: string;
}

export function workflowScriptEnvironment(
	request: WorkflowScriptEnvironmentRequest,
	baseEnv?: Record<string, string | undefined>,
): Record<string, string> | undefined {
	const additions: Record<string, string> = {};
	if (request.context !== undefined) {
		additions[WORKFLOW_CONTEXT_ENV] = JSON.stringify(request.context);
	}
	if (request.resourceDir !== undefined) {
		additions[WORKFLOW_RESOURCE_DIR_ENV] = request.resourceDir;
	}
	if (Object.keys(additions).length === 0) return undefined;
	if (baseEnv === undefined) return additions;
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(baseEnv)) {
		if (value !== undefined) env[key] = value;
	}
	return { ...env, ...additions };
}
