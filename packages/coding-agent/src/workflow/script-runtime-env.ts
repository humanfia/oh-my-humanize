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
	env.PYTEST_ADDOPTS = appendShellOptions(baseEnv.PYTEST_ADDOPTS, ["-p no:cacheprovider", "-p no:benchmark"]);
	env.RUFF_CACHE_DIR = `${runTmp}/ruff-cache`;
	if (request.context !== undefined) {
		env[WORKFLOW_CONTEXT_ENV] = JSON.stringify(request.context);
	}
	if (request.resourceDir !== undefined) {
		env[WORKFLOW_RESOURCE_DIR_ENV] = request.resourceDir;
	}
	return env;
}

function appendShellOptions(existing: string | undefined, additions: readonly string[]): string {
	const trimmed = existing?.trim();
	const options = trimmed ? [trimmed] : [];
	for (const addition of additions) {
		if (trimmed?.includes(addition)) continue;
		options.push(addition);
	}
	return options.join(" ");
}
