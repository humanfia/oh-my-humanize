import { type BashResult, executeBash } from "../exec/bash-executor";
import type { WorkflowNodeRuntimeHost } from "./node-runtime";
import { WorkflowNodeRuntimeError } from "./node-runtime";
import type { WorkflowActivationOutput } from "./state";

export interface WorkflowSessionRuntimeOptions {
	cwd: string;
	runShellCommand?: (command: string, options: WorkflowShellCommandOptions) => Promise<BashResult>;
	runAgentTask?: WorkflowAgentTaskRunner;
}

export interface WorkflowShellCommandOptions {
	cwd: string;
	timeout: number;
}

export interface WorkflowAgentTaskRequest {
	agent: string;
	activationId: string;
	nodeId: string;
	task: WorkflowAgentTaskItem;
}

export interface WorkflowAgentTaskItem {
	id: string;
	description: string;
	assignment: string;
}

export interface WorkflowAgentTaskResult {
	exitCode: number;
	output: string;
	stderr?: string;
	error?: string;
	outputPath?: string;
}

export type WorkflowAgentTaskRunner = (request: WorkflowAgentTaskRequest) => Promise<WorkflowAgentTaskResult>;

const DEFAULT_WORKFLOW_SCRIPT_TIMEOUT_MS = 300_000;

export function createSessionWorkflowRuntimeHost(options: WorkflowSessionRuntimeOptions): WorkflowNodeRuntimeHost {
	const runShellCommand = options.runShellCommand ?? executeBash;
	return {
		runAgentNode: async input => {
			if (!options.runAgentTask) {
				throw new WorkflowNodeRuntimeError(
					`workflow agent node "${input.node.id}" requires a subagent runtime adapter`,
				);
			}
			const task: WorkflowAgentTaskItem = {
				id: taskIdForNode(input.node.id),
				description: input.node.id,
				assignment: input.prompt?.trim() || `Run workflow node "${input.node.id}".`,
			};
			const result = await options.runAgentTask({
				agent: input.agent,
				activationId: input.activation.id,
				nodeId: input.node.id,
				task,
			});
			return activationOutputFromTaskResult(input.node.id, result);
		},
		runScriptNode: async input => {
			const command = input.script?.trim();
			if (!command) {
				throw new WorkflowNodeRuntimeError(`workflow script node "${input.node.id}" must define a script command`);
			}
			const result = await runShellCommand(command, {
				cwd: options.cwd,
				timeout: DEFAULT_WORKFLOW_SCRIPT_TIMEOUT_MS,
			});
			if (result.cancelled) {
				throw new WorkflowNodeRuntimeError(`workflow script node "${input.node.id}" was cancelled`);
			}
			if (result.exitCode !== 0) {
				throw new WorkflowNodeRuntimeError(
					`workflow script node "${input.node.id}" exited with code ${result.exitCode ?? "unknown"}`,
				);
			}
			const summary = result.output.trim() || `script node "${input.node.id}" completed`;
			return {
				summary,
				data: { exitCode: result.exitCode },
			};
		},
		runHumanNode: async input => {
			throw new WorkflowNodeRuntimeError(`workflow human node "${input.node.id}" requires a human input adapter`);
		},
		runReviewNode: async input => {
			throw new WorkflowNodeRuntimeError(
				`workflow review node "${input.node.id}" requires a review runtime adapter`,
			);
		},
	};
}

function taskIdForNode(nodeId: string): string {
	const sanitized = nodeId.replaceAll(/[^A-Za-z0-9_]/g, "_").slice(0, 48);
	return sanitized || "workflow_node";
}

function activationOutputFromTaskResult(nodeId: string, result: WorkflowAgentTaskResult): WorkflowActivationOutput {
	if (result.exitCode !== 0) {
		const reason = result.error || result.stderr || `exit code ${result.exitCode}`;
		throw new WorkflowNodeRuntimeError(`workflow agent node "${nodeId}" failed: ${reason}`);
	}
	const output: WorkflowActivationOutput = {
		summary: result.output.trim() || `agent node "${nodeId}" completed`,
		data: { exitCode: result.exitCode },
	};
	if (result.outputPath) {
		output.artifacts = [`local://${result.outputPath}`];
	}
	return output;
}
