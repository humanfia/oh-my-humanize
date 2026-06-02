import { evaluateWorkflowCondition } from "./condition";
import type { WorkflowDefinition, WorkflowNode } from "./definition";
import { applyWorkflowStatePatch, validateWorkflowActivationOutput, type WorkflowActivationOutput } from "./state";

export type WorkflowActivationStatus = "queued" | "running" | "completed" | "failed";

export interface WorkflowActivation {
	id: string;
	nodeId: string;
	graphRevisionId: string;
	status: WorkflowActivationStatus;
	parentActivationIds: string[];
	output?: WorkflowActivationOutput;
	error?: string;
}

export interface WorkflowSchedulerOptions {
	startNodeId: string;
	initialState?: Record<string, unknown>;
	maxActivations?: number;
	maxNodeActivations?: number;
	signal?: AbortSignal;
	getCurrentDefinition?: () => WorkflowDefinition;
	getCurrentGraphRevisionId?: () => string;
	executeNode: (
		activation: WorkflowActivation,
		node: WorkflowNode,
		context: WorkflowSchedulerExecutionContext,
	) => Promise<WorkflowActivationOutput>;
}

export interface WorkflowSchedulerExecutionContext {
	state: Record<string, unknown>;
	completedActivations: WorkflowActivation[];
	signal?: AbortSignal;
}

export interface WorkflowSchedulerResult {
	activations: WorkflowActivation[];
	limitReached: boolean;
	state: Record<string, unknown>;
}

export async function runWorkflowScheduler(
	definition: WorkflowDefinition,
	options: WorkflowSchedulerOptions,
): Promise<WorkflowSchedulerResult> {
	const getCurrentDefinition = options.getCurrentDefinition ?? (() => definition);
	const getCurrentGraphRevisionId = options.getCurrentGraphRevisionId ?? (() => "workflow-graph");
	const state = options.initialState ?? {};
	const activations: WorkflowActivation[] = [];
	const completedByNode = new Map<string, WorkflowActivation[]>();
	const outputsByNode: Record<string, unknown> = {};
	const queuedJoinKeys = new Set<string>();
	let nextActivationId = 1;
	const createNextActivation = (nodeId: string, parentActivationIds: string[]): WorkflowActivation => ({
		id: `activation-${nextActivationId++}`,
		nodeId,
		graphRevisionId: getCurrentGraphRevisionId(),
		status: "queued",
		parentActivationIds,
	});
	const maxActivations = options.maxActivations ?? Number.POSITIVE_INFINITY;
	const maxNodeActivations = options.maxNodeActivations ?? Number.POSITIVE_INFINITY;
	const queue: WorkflowActivation[] = [createNextActivation(options.startNodeId, [])];
	let limitReached = false;

	while (queue.length > 0) {
		if (activations.length >= maxActivations) {
			limitReached = true;
			break;
		}
		const activation = queue.shift();
		if (!activation) break;
		const abortReason = workflowAbortReason(options.signal);
		if (abortReason) {
			activation.status = "failed";
			activation.error = abortReason;
			activations.push(activation);
			break;
		}
		if (countNodeActivations(activations, activation.nodeId) >= maxNodeActivations) {
			limitReached = true;
			break;
		}
		const definitionForActivation = getCurrentDefinition();
		const nodesById = new Map(definitionForActivation.nodes.map(node => [node.id, node]));
		const node = nodesById.get(activation.nodeId);
		if (!node) {
			activation.status = "failed";
			activation.error = `unknown node "${activation.nodeId}"`;
			activations.push(activation);
			continue;
		}
		activation.status = "running";
		activations.push(activation);
		try {
			const context: WorkflowSchedulerExecutionContext = {
				state,
				completedActivations: activations.filter(candidate => candidate.status === "completed"),
				signal: options.signal,
			};
			activation.output = validateWorkflowActivationOutput(await options.executeNode(activation, node, context), {
				allowedWritePaths: node.writes,
			});
			if (activation.output.statePatch) {
				applyWorkflowStatePatch(state, activation.output.statePatch, { allowedWritePaths: node.writes });
			}
			if (activation.output.data !== undefined) {
				outputsByNode[activation.nodeId] = activation.output.data;
			} else {
				delete outputsByNode[activation.nodeId];
			}
			activation.status = "completed";
			const completed = completedByNode.get(activation.nodeId) ?? [];
			completed.push(activation);
			completedByNode.set(activation.nodeId, completed);
		} catch (error) {
			activation.status = "failed";
			activation.error = error instanceof Error ? error.message : String(error);
			continue;
		}
		const definitionForTransitions = getCurrentDefinition();
		const transitionNodesById = new Map(definitionForTransitions.nodes.map(node => [node.id, node]));
		for (const edge of definitionForTransitions.edges.filter(edge => edge.from === activation.nodeId)) {
			if (edge.condition && !evaluateWorkflowCondition(edge.condition.source, { state, outputs: outputsByNode })) {
				continue;
			}
			const target = transitionNodesById.get(edge.to);
			if (target?.waitFor?.length) {
				const parentActivationIds = collectJoinParentIds(target.waitFor, completedByNode);
				if (!parentActivationIds) continue;
				const joinKey = `${target.id}:${parentActivationIds.join(",")}`;
				if (queuedJoinKeys.has(joinKey)) continue;
				queuedJoinKeys.add(joinKey);
				queue.push(createNextActivation(edge.to, parentActivationIds));
				continue;
			}
			queue.push(createNextActivation(edge.to, [activation.id]));
		}
	}

	return { activations, limitReached, state };
}

function workflowAbortReason(signal: AbortSignal | undefined): string | undefined {
	if (!signal?.aborted) return undefined;
	const reason: unknown = signal.reason;
	if (reason instanceof Error) return reason.message;
	if (typeof reason === "string" && reason.length > 0) return reason;
	if (reason !== undefined && reason !== null) return String(reason);
	return "workflow cancelled";
}

function countNodeActivations(activations: WorkflowActivation[], nodeId: string): number {
	return activations.filter(activation => activation.nodeId === nodeId).length;
}

function collectJoinParentIds(
	waitFor: string[],
	completedByNode: Map<string, WorkflowActivation[]>,
): string[] | undefined {
	const parentIds: string[] = [];
	for (const nodeId of waitFor) {
		const completed = completedByNode.get(nodeId);
		const latest = completed?.at(-1);
		if (!latest) return undefined;
		parentIds.push(latest.id);
	}
	return parentIds;
}
