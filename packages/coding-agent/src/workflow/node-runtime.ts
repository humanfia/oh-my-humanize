import type { WorkflowModelContext, WorkflowNode, WorkflowScriptLanguage } from "./definition";
import type { WorkflowActivation, WorkflowMappedActivationContext } from "./scheduler";
import type { WorkflowActivationOutput } from "./state";
import { escapeJsonPointerSegment } from "./state-schema";

export interface WorkflowNodeRuntimeInput {
	node: WorkflowNode;
	activation: WorkflowActivation;
	signal?: AbortSignal;
}

export interface WorkflowAgentNodeInput extends WorkflowNodeRuntimeInput {
	agent: string;
	prompt?: string;
	model?: WorkflowModelContext;
	modelOverride?: string;
}

export interface WorkflowScriptNodeInput extends WorkflowNodeRuntimeInput {
	script?: string;
	scriptLanguage?: WorkflowScriptLanguage;
	scriptPath?: string;
	timeoutMs?: number;
	resourceDir?: string;
	model?: WorkflowModelContext;
	context?: WorkflowScriptContext;
}

export interface WorkflowHumanNodeInput extends WorkflowNodeRuntimeInput {
	prompt?: string;
}

export interface WorkflowReviewNodeInput extends WorkflowNodeRuntimeInput {
	agent?: string;
	prompt?: string;
	model?: WorkflowModelContext;
	modelOverride?: string;
	gates?: string[];
	fallbackVerdict?: string;
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

export interface WorkflowNodeExecutionContext {
	state: Record<string, unknown>;
	completedActivations: WorkflowActivation[];
}

export interface WorkflowScriptContext {
	activation: Pick<WorkflowActivation, "id" | "nodeId" | "graphRevisionId" | "parentActivationIds"> & {
		mapped?: WorkflowMappedActivationContext;
	};
	node: Pick<WorkflowNode, "id" | "type">;
	state: Record<string, unknown>;
	completedActivations: WorkflowActivation[];
	resources?: WorkflowScriptResourceContext;
}

export interface WorkflowScriptResourceContext {
	root: string;
}

export interface WorkflowNodeRuntimeOptions {
	modelOverride?: string;
	signal?: AbortSignal;
	context?: WorkflowNodeExecutionContext;
	resourceDir?: string;
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
	options: WorkflowNodeRuntimeOptions = {},
): Promise<WorkflowActivationOutput> {
	if (node.type === "agent") {
		return executeAgentNode(node, activation, host, options);
	}
	if (node.type === "script") {
		return executeScriptNode(node, activation, host, options);
	}
	if (node.type === "human") {
		return executeHumanNode(node, activation, host, options);
	}
	if (node.type === "review") {
		return executeReviewNode(node, activation, host, options);
	}
	throw new WorkflowNodeRuntimeError(`unsupported workflow node type: ${node.type}`);
}

async function executeAgentNode(
	node: WorkflowNode,
	activation: WorkflowActivation,
	host: WorkflowNodeRuntimeHost,
	options: WorkflowNodeRuntimeOptions,
): Promise<WorkflowActivationOutput> {
	if (!node.agent) {
		throw new WorkflowNodeRuntimeError(`agent node "${node.id}" must define an agent`);
	}
	if (!host.runAgentNode) {
		throw new WorkflowNodeRuntimeError("workflow runtime host does not support agent nodes");
	}
	const input: WorkflowAgentNodeInput = {
		node,
		activation,
		agent: node.agent,
		prompt: node.prompt,
		model: node.model,
	};
	if (options.modelOverride !== undefined) {
		input.modelOverride = options.modelOverride;
	}
	if (options.signal !== undefined) {
		input.signal = options.signal;
	}
	return host.runAgentNode(input);
}

async function executeScriptNode(
	node: WorkflowNode,
	activation: WorkflowActivation,
	host: WorkflowNodeRuntimeHost,
	options: WorkflowNodeRuntimeOptions,
): Promise<WorkflowActivationOutput> {
	if (!host.runScriptNode) {
		throw new WorkflowNodeRuntimeError("workflow runtime host does not support script nodes");
	}
	const input: WorkflowScriptNodeInput = {
		node,
		activation,
		script: node.script?.code ?? node.prompt,
		scriptLanguage: node.script?.language,
		scriptPath: node.script?.file,
		timeoutMs: node.script?.timeoutMs,
		model: node.model,
	};
	if (options.resourceDir !== undefined) {
		input.resourceDir = options.resourceDir;
	}
	const context = workflowScriptContextSnapshot(node, activation, options.context, options.resourceDir);
	if (context !== undefined) {
		input.context = context;
	}
	if (options.signal !== undefined) {
		input.signal = options.signal;
	}
	return host.runScriptNode(input);
}

function workflowScriptContextSnapshot(
	node: WorkflowNode,
	activation: WorkflowActivation,
	context: WorkflowNodeExecutionContext | undefined,
	resourceDir: string | undefined,
): WorkflowScriptContext | undefined {
	if (context === undefined) return undefined;
	const snapshot: WorkflowScriptContext = {
		activation: {
			id: activation.id,
			nodeId: activation.nodeId,
			graphRevisionId: activation.graphRevisionId,
			parentActivationIds: [...activation.parentActivationIds],
		},
		node: {
			id: node.id,
			type: node.type,
		},
		state: structuredClone(context.state),
		completedActivations: structuredClone(context.completedActivations),
	};
	if (activation.mapped !== undefined) {
		snapshot.activation.mapped = structuredClone(activation.mapped);
	}
	if (resourceDir !== undefined) {
		snapshot.resources = { root: resourceDir };
	}
	return snapshot;
}
async function executeHumanNode(
	node: WorkflowNode,
	activation: WorkflowActivation,
	host: WorkflowNodeRuntimeHost,
	options: WorkflowNodeRuntimeOptions,
): Promise<WorkflowActivationOutput> {
	if (!host.runHumanNode) {
		throw new WorkflowNodeRuntimeError("workflow runtime host does not support human nodes");
	}
	const input: WorkflowHumanNodeInput = {
		node,
		activation,
		prompt: node.prompt,
	};
	if (options.signal !== undefined) {
		input.signal = options.signal;
	}
	return host.runHumanNode(input);
}

async function executeReviewNode(
	node: WorkflowNode,
	activation: WorkflowActivation,
	host: WorkflowNodeRuntimeHost,
	options: WorkflowNodeRuntimeOptions,
): Promise<WorkflowActivationOutput> {
	if (!host.runReviewNode) {
		throw new WorkflowNodeRuntimeError("workflow runtime host does not support review nodes");
	}
	const input: WorkflowReviewNodeInput = {
		node,
		activation,
		agent: node.agent,
		prompt: node.prompt,
		model: node.model,
		gates: node.gates,
	};
	if (node.fallbackVerdict !== undefined) {
		input.fallbackVerdict = node.fallbackVerdict;
	}
	if (options.modelOverride !== undefined) {
		input.modelOverride = options.modelOverride;
	}
	if (options.signal !== undefined) {
		input.signal = options.signal;
	}
	const output = await host.runReviewNode(input);
	if (node.gates?.length && !node.gates.includes(output.verdict)) {
		throw new WorkflowNodeRuntimeError(
			`workflow review node "${node.id}" returned undeclared verdict "${output.verdict}"`,
		);
	}
	const result: WorkflowActivationOutput = {
		summary: output.summary,
		data: { verdict: output.verdict },
		statePatch: [{ op: "set", path: reviewVerdictStatePath(node, activation), value: output.verdict }],
	};
	if (output.artifacts !== undefined) result.artifacts = output.artifacts;
	return result;
}

function reviewVerdictStatePath(node: WorkflowNode, activation: WorkflowActivation): string {
	const base = node.writes?.[0] ?? "/verdict";
	const mapped = activation.mapped;
	if (mapped !== undefined) {
		return `${base.replace(/\/+$/, "")}/${escapeJsonPointerSegment(mapped.itemKey)}/verdict`;
	}
	return base;
}
