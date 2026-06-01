import type { WorkflowModelContext, WorkflowNode } from "./definition";
import type { WorkflowActivation, WorkflowActivationOutput } from "./scheduler";

export interface WorkflowNodeRuntimeInput {
	node: WorkflowNode;
	activation: WorkflowActivation;
}

export interface WorkflowAgentNodeInput extends WorkflowNodeRuntimeInput {
	agent: string;
	prompt?: string;
	model?: WorkflowModelContext;
}

export interface WorkflowScriptNodeInput extends WorkflowNodeRuntimeInput {
	script?: string;
	model?: WorkflowModelContext;
}

export interface WorkflowHumanNodeInput extends WorkflowNodeRuntimeInput {
	prompt?: string;
}

export interface WorkflowReviewNodeInput extends WorkflowNodeRuntimeInput {
	agent?: string;
	prompt?: string;
	model?: WorkflowModelContext;
	gates?: string[];
}

export interface WorkflowReviewNodeOutput {
	summary?: string;
	verdict: string;
	artifacts?: string[];
}

export interface WorkflowNodeRuntimeHost {
	runAgentNode?: (input: WorkflowAgentNodeInput) => Promise<WorkflowActivationOutput>;
	runScriptNode?: (input: WorkflowScriptNodeInput) => Promise<WorkflowActivationOutput>;
	runHumanNode?: (input: WorkflowHumanNodeInput) => Promise<WorkflowActivationOutput>;
	runReviewNode?: (input: WorkflowReviewNodeInput) => Promise<WorkflowReviewNodeOutput>;
}

export class WorkflowNodeRuntimeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WorkflowNodeRuntimeError";
	}
}

export async function executeWorkflowNode(
	node: WorkflowNode,
	activation: WorkflowActivation,
	host: WorkflowNodeRuntimeHost,
): Promise<WorkflowActivationOutput> {
	if (node.type === "agent") {
		return executeAgentNode(node, activation, host);
	}
	if (node.type === "script") {
		return executeScriptNode(node, activation, host);
	}
	if (node.type === "human") {
		return executeHumanNode(node, activation, host);
	}
	if (node.type === "review") {
		return executeReviewNode(node, activation, host);
	}
	throw new WorkflowNodeRuntimeError(`unsupported workflow node type: ${node.type}`);
}

async function executeAgentNode(
	node: WorkflowNode,
	activation: WorkflowActivation,
	host: WorkflowNodeRuntimeHost,
): Promise<WorkflowActivationOutput> {
	if (!node.agent) {
		throw new WorkflowNodeRuntimeError(`agent node "${node.id}" must define an agent`);
	}
	if (!host.runAgentNode) {
		throw new WorkflowNodeRuntimeError("workflow runtime host does not support agent nodes");
	}
	return host.runAgentNode({
		node,
		activation,
		agent: node.agent,
		prompt: node.prompt,
		model: node.model,
	});
}

async function executeScriptNode(
	node: WorkflowNode,
	activation: WorkflowActivation,
	host: WorkflowNodeRuntimeHost,
): Promise<WorkflowActivationOutput> {
	if (!host.runScriptNode) {
		throw new WorkflowNodeRuntimeError("workflow runtime host does not support script nodes");
	}
	return host.runScriptNode({
		node,
		activation,
		script: node.prompt,
		model: node.model,
	});
}

async function executeHumanNode(
	node: WorkflowNode,
	activation: WorkflowActivation,
	host: WorkflowNodeRuntimeHost,
): Promise<WorkflowActivationOutput> {
	if (!host.runHumanNode) {
		throw new WorkflowNodeRuntimeError("workflow runtime host does not support human nodes");
	}
	return host.runHumanNode({
		node,
		activation,
		prompt: node.prompt,
	});
}

async function executeReviewNode(
	node: WorkflowNode,
	activation: WorkflowActivation,
	host: WorkflowNodeRuntimeHost,
): Promise<WorkflowActivationOutput> {
	if (!host.runReviewNode) {
		throw new WorkflowNodeRuntimeError("workflow runtime host does not support review nodes");
	}
	const output = await host.runReviewNode({
		node,
		activation,
		agent: node.agent,
		prompt: node.prompt,
		model: node.model,
		gates: node.gates,
	});
	if (node.gates?.length && !node.gates.includes(output.verdict)) {
		throw new WorkflowNodeRuntimeError(
			`workflow review node "${node.id}" returned undeclared verdict "${output.verdict}"`,
		);
	}
	return {
		summary: output.summary,
		artifacts: output.artifacts,
		statePatch: [{ op: "set", path: "/verdict", value: output.verdict }],
	};
}
