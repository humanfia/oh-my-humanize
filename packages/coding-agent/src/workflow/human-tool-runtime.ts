import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import type { ToolSession } from "../tools";
import { AskTool } from "../tools/ask";
import { ToolAbortError } from "../tools/tool-errors";
import { WorkflowNodeAbortedError } from "./node-runtime";
import type { WorkflowHumanInputResult, WorkflowHumanInputRunner } from "./session-runtime";

const WORKFLOW_HUMAN_COMMAND_CHECKPOINT_OPTION = "Checkpoint for commands";

export function createAskToolHumanInputRunner(
	toolSession: ToolSession,
	getToolContext: () => AgentToolContext,
): WorkflowHumanInputRunner {
	return async request => {
		const askTool = AskTool.createIf(toolSession);
		if (!askTool) {
			throw new Error(`workflow human node "${request.nodeId}" requires interactive mode`);
		}
		let result: { details?: WorkflowAskDetails };
		try {
			result = await askTool.execute(
				`workflow-${request.activationId}`,
				{
					questions: [
						{
							id: "response",
							question: request.question,
							options: [
								{
									label: "Reject",
									description: "Decline approval and let the workflow follow its rejection path.",
								},
								{
									label: "Approve",
									description: "Proceed only after reading the prompt and evidence.",
								},
								{
									label: WORKFLOW_HUMAN_COMMAND_CHECKPOINT_OPTION,
									description: "Stop safely, create a checkpoint, then use /workflow lifecycle commands.",
								},
							],
							recommended: 0,
						},
					],
				},
				request.signal,
				undefined,
				getToolContext(),
			);
		} catch (error) {
			const abortReason = workflowHumanInputAbortReason(error, request);
			if (abortReason !== undefined) throw new WorkflowNodeAbortedError(abortReason);
			throw error;
		}
		const details = result.details;
		if (workflowHumanCheckpointForCommandsRequested(details)) {
			throw new WorkflowNodeAbortedError(
				`workflow human node "${request.nodeId}" checkpointed for operator commands`,
			);
		}
		const response = responseFromAskDetails(details);
		const output: WorkflowHumanInputResult = {
			response,
		};
		if (details?.selectedOptions !== undefined) output.selectedOptions = details.selectedOptions;
		if (details?.customInput !== undefined) output.customInput = details.customInput;
		return output;
	};
}

function workflowHumanCheckpointForCommandsRequested(details: WorkflowAskDetails | undefined): boolean {
	return details?.selectedOptions?.includes(WORKFLOW_HUMAN_COMMAND_CHECKPOINT_OPTION) === true;
}

function responseFromAskDetails(details: WorkflowAskDetails | undefined): string {
	if (details?.customInput !== undefined) return details.customInput;
	const selected = details?.selectedOptions?.[0];
	if (selected) return selected;
	return "User did not provide a response";
}

function workflowHumanInputAbortReason(
	error: unknown,
	request: { nodeId: string; signal?: AbortSignal },
): string | undefined {
	if (!(error instanceof ToolAbortError)) return undefined;
	if (request.signal?.aborted === true) {
		const reason = request.signal.reason;
		if (reason instanceof Error) return reason.message;
		if (typeof reason === "string" && reason.length > 0) return reason;
		if (reason !== undefined && reason !== null) return String(reason);
	}
	if (error.message === "Ask input was cancelled" || error.message === "Ask tool was cancelled by the user") {
		return `workflow human node "${request.nodeId}" input cancelled by operator`;
	}
	return undefined;
}

interface WorkflowAskDetails {
	selectedOptions?: string[];
	customInput?: string;
}
