import type { WorkflowPortableModelRequest } from "./model-resolution";

export const WORKFLOW_SUBAGENT_MODEL_OVERRIDE_ENV = "OMH_WORKFLOW_SUBAGENT_MODEL_OVERRIDE";
export const WORKFLOW_SUBAGENT_MODEL_OVERRIDE_AUTH_FALLBACK_ENV = "OMH_WORKFLOW_SUBAGENT_MODEL_OVERRIDE_AUTH_FALLBACK";
export const WORKFLOW_MODEL_REQUEST_ENV = "OMH_WORKFLOW_MODEL_REQUEST";
export const WORKFLOW_SUBAGENT_RETRY_BASE_DELAY_MS_ENV = "OMH_WORKFLOW_SUBAGENT_RETRY_BASE_DELAY_MS";
export const WORKFLOW_SUBAGENT_RETRY_MAX_DELAY_MS_ENV = "OMH_WORKFLOW_SUBAGENT_RETRY_MAX_DELAY_MS";
export const WORKFLOW_SUBAGENT_SHELL_ENVIRONMENT_POLICY_ENV = "OMH_WORKFLOW_SUBAGENT_SHELL_ENVIRONMENT_POLICY";
export const WORKFLOW_SUBAGENT_REQUIRE_YIELD_TOOL_ENV = "OMH_WORKFLOW_SUBAGENT_REQUIRE_YIELD_TOOL";

export function parseWorkflowModelRequest(value: string | undefined): WorkflowPortableModelRequest | undefined {
	if (value === undefined || value.trim().length === 0) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new Error(`${WORKFLOW_MODEL_REQUEST_ENV} must contain valid JSON`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`${WORKFLOW_MODEL_REQUEST_ENV} must contain an object`);
	}
	const record = parsed as Record<string, unknown>;
	if (record.version !== 1) {
		throw new Error(`${WORKFLOW_MODEL_REQUEST_ENV} has unsupported version`);
	}
	if (typeof record.nodeId !== "string" || record.nodeId.length === 0) {
		throw new Error(`${WORKFLOW_MODEL_REQUEST_ENV}.nodeId must be a non-empty string`);
	}
	if (
		!Array.isArray(record.patterns) ||
		record.patterns.length === 0 ||
		record.patterns.some(pattern => typeof pattern !== "string" || pattern.length === 0)
	) {
		throw new Error(`${WORKFLOW_MODEL_REQUEST_ENV}.patterns must be a non-empty string array`);
	}
	if (record.unavailablePolicy !== "fail" && record.unavailablePolicy !== "fallback-to-parent") {
		throw new Error(`${WORKFLOW_MODEL_REQUEST_ENV}.unavailablePolicy is invalid`);
	}
	return {
		version: 1,
		nodeId: record.nodeId,
		patterns: [...record.patterns] as string[],
		unavailablePolicy: record.unavailablePolicy,
	};
}
