import type { WorkflowNode } from "./definition";

export const WORKFLOW_AGENT_TASK_TIMEOUT_MS = 60 * 60 * 1000;

export function resolveWorkflowAgentTaskTimeoutMs(timeoutMs: number | undefined): number {
	return timeoutMs ?? WORKFLOW_AGENT_TASK_TIMEOUT_MS;
}

export function resolveWorkflowNodeDeadlineTimeoutMs(
	node: Pick<WorkflowNode, "type" | "timeoutMs">,
): number | undefined {
	if (node.type === "agent" || node.type === "review") {
		return resolveWorkflowAgentTaskTimeoutMs(node.timeoutMs);
	}
	return node.timeoutMs;
}
