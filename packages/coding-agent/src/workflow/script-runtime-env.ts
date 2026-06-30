import type { WorkflowScriptContext } from "./node-runtime";

export const WORKFLOW_CONTEXT_ENV = "OMP_WORKFLOW_CONTEXT";
export const WORKFLOW_RESOURCE_DIR_ENV = "OMP_WORKFLOW_RESOURCE_DIR";

export interface WorkflowScriptEnvironmentRequest {
	context?: WorkflowScriptContext;
	resourceDir?: string;
}

export function workflowScriptEnvironment(
	request: WorkflowScriptEnvironmentRequest,
	baseEnv: Record<string, string | undefined> = Bun.env,
): Record<string, string> | undefined {
	const env: Record<string, string> = {};
	const runTmp = baseEnv.OMH_RUN_TMP || baseEnv.TMPDIR || "workflow-output/tmp";
	env.PYTHONDONTWRITEBYTECODE = "1";
	env.PYTHONPYCACHEPREFIX = `${runTmp}/python-pycache`;
	env.PYTEST_ADDOPTS = appendShellOption(baseEnv.PYTEST_ADDOPTS, "-p no:cacheprovider");
	if (request.context !== undefined) {
		env[WORKFLOW_CONTEXT_ENV] = JSON.stringify(request.context);
	}
	if (request.resourceDir !== undefined) {
		env[WORKFLOW_RESOURCE_DIR_ENV] = request.resourceDir;
	}
	return env;
}

function appendShellOption(existing: string | undefined, addition: string): string {
	const trimmed = existing?.trim();
	if (!trimmed) return addition;
	if (trimmed.includes(addition)) return trimmed;
	return `${trimmed} ${addition}`;
}
