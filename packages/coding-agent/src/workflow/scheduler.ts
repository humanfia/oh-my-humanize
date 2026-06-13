import { evaluateWorkflowCondition } from "./condition";
import type { WorkflowDefinition, WorkflowNode } from "./definition";
import { applyWorkflowStatePatch, validateWorkflowActivationOutput, type WorkflowActivationOutput } from "./state";

export type WorkflowActivationStatus = "queued" | "running" | "completed" | "failed" | "aborted";

export interface WorkflowActivation {
	id: string;
	nodeId: string;
	graphRevisionId: string;
	status: WorkflowActivationStatus;
	parentActivationIds: string[];
	output?: WorkflowActivationOutput;
	error?: string;
	reason?: string;
}

export interface WorkflowSchedulerOptions {
	startNodeId: string;
	startNodeIds?: string[];
	initialState?: Record<string, unknown>;
	completedActivations?: WorkflowActivation[];
	startParentActivationIds?: string[];
	maxActivations?: number;
	maxNodeActivations?: number;
	signal?: AbortSignal;
	nodeAbortSignal?: AbortSignal;
	nodeAbortSignalForActivation?: (activation: WorkflowActivation) => AbortSignal | undefined;
	graphRevisionId?: string;
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
	nodeAbortSignal?: AbortSignal;
}

export interface WorkflowSchedulerResult {
	activations: WorkflowActivation[];
	limitReached: boolean;
	frontierNodeIds: string[];
	state: Record<string, unknown>;
}

interface RunningWorkflowActivation {
	activation: WorkflowActivation;
	node: WorkflowNode;
	result: Promise<WorkflowActivationExecutionResult>;
}

interface WorkflowActivationExecutionResult {
	activation: WorkflowActivation;
	node: WorkflowNode;
	output?: WorkflowActivationOutput;
	error?: string;
	aborted?: boolean;
}

export async function runWorkflowScheduler(
	definition: WorkflowDefinition,
	options: WorkflowSchedulerOptions,
): Promise<WorkflowSchedulerResult> {
	const graphRevisionId = options.graphRevisionId ?? "workflow-graph";
	const nodesById = new Map(definition.nodes.map(node => [node.id, node]));
	const state = options.initialState ?? {};
	const externalCompletedActivations = options.completedActivations ?? [];
	const activations: WorkflowActivation[] = [];
	const completedByNode = seedCompletedByNode(externalCompletedActivations);
	const completedById = seedCompletedById(externalCompletedActivations);
	const outputsByNode = seedOutputsByNode(externalCompletedActivations);
	const queuedJoinKeys = new Set<string>();
	let nextActivationId = nextActivationOrdinal(externalCompletedActivations);
	const createNextActivation = (nodeId: string, parentActivationIds: string[]): WorkflowActivation => ({
		id: `activation-${nextActivationId++}`,
		nodeId,
		graphRevisionId,
		status: "queued",
		parentActivationIds,
	});
	const maxActivations = options.maxActivations ?? Number.POSITIVE_INFINITY;
	const maxNodeActivations = options.maxNodeActivations ?? Number.POSITIVE_INFINITY;
	const startNodeIds = options.startNodeIds ?? [options.startNodeId];
	const queue: WorkflowActivation[] = startNodeIds.map(nodeId =>
		createNextActivation(nodeId, options.startParentActivationIds ?? []),
	);
	const running = new Map<string, RunningWorkflowActivation>();
	let limitReached = false;
	let stoppedFrontierNodeIds: string[] | undefined;
	let stopScheduling = false;
	const completedActivationSnapshot = (): WorkflowActivation[] => [
		...externalCompletedActivations,
		...activations.filter(candidate => candidate.status === "completed"),
	];
	const startReadyActivations = (): void => {
		while (queue.length > 0 && !stopScheduling) {
			if (activations.length >= maxActivations) {
				limitReached = true;
				break;
			}
			const activation = queue.shift();
			if (!activation) break;
			if (workflowAbortReason(options.signal)) {
				stoppedFrontierNodeIds = uniqueNodeIds([activation, ...queue]);
				stopScheduling = true;
				break;
			}
			if (
				countNodeActivations([...externalCompletedActivations, ...activations], activation.nodeId) >=
				maxNodeActivations
			) {
				limitReached = true;
				queue.unshift(activation);
				break;
			}
			const node = nodesById.get(activation.nodeId);
			if (!node) {
				activation.status = "failed";
				activation.error = `unknown node "${activation.nodeId}"`;
				activations.push(activation);
				continue;
			}
			activation.status = "running";
			activations.push(activation);
			const nodeAbortSignal = options.nodeAbortSignalForActivation?.(activation) ?? options.nodeAbortSignal;
			const context: WorkflowSchedulerExecutionContext = {
				state,
				completedActivations: completedActivationSnapshot(),
				signal: options.signal,
				nodeAbortSignal,
			};
			running.set(activation.id, {
				activation,
				node,
				result: executeSchedulerActivation(definition, options, activation, node, context),
			});
		}
	};
	startReadyActivations();
	while (running.size > 0) {
		const result = await nextSchedulerActivationResult(running);
		running.delete(result.activation.id);
		if (result.aborted === true) {
			result.activation.status = "aborted";
			result.activation.reason = result.error ?? "workflow activation aborted";
			if (stoppedFrontierNodeIds === undefined) stoppedFrontierNodeIds = uniqueNodeIds(queue);
			pushUnique(stoppedFrontierNodeIds, result.activation.nodeId);
			stopScheduling = true;
			continue;
		}
		if (result.error !== undefined) {
			result.activation.status = "failed";
			result.activation.error = result.error;
			if (!stopScheduling) startReadyActivations();
			continue;
		}
		const output = result.output;
		if (output === undefined) {
			result.activation.status = "failed";
			result.activation.error = `workflow activation ${result.activation.id} produced no output`;
			if (!stopScheduling) startReadyActivations();
			continue;
		}
		result.activation.output = output;
		if (output.statePatch) {
			applyWorkflowStatePatch(state, output.statePatch, {
				allowedWritePaths: result.node.writes,
				stateSchema: definition.stateSchema,
			});
		}
		if (output.data !== undefined) {
			outputsByNode[result.activation.nodeId] = output.data;
		} else {
			delete outputsByNode[result.activation.nodeId];
		}
		result.activation.status = "completed";
		const completed = completedByNode.get(result.activation.nodeId) ?? [];
		completed.push(result.activation);
		completedByNode.set(result.activation.nodeId, completed);
		completedById.set(result.activation.id, result.activation);
		if (workflowAbortReason(options.signal)) {
			if (stoppedFrontierNodeIds === undefined) stoppedFrontierNodeIds = uniqueNodeIds(queue);
			for (const nodeId of eligibleFrontierNodeIds(
				definition,
				result.activation,
				nodesById,
				completedByNode,
				completedById,
				state,
				outputsByNode,
			)) {
				pushUnique(stoppedFrontierNodeIds, nodeId);
			}
			stopScheduling = true;
			continue;
		}
		enqueueReadyChildren(
			definition,
			result.activation,
			nodesById,
			completedByNode,
			completedById,
			outputsByNode,
			state,
			{
				queue,
				queuedJoinKeys,
				createNextActivation,
			},
		);
		startReadyActivations();
	}

	return { activations, limitReached, frontierNodeIds: stoppedFrontierNodeIds ?? uniqueNodeIds(queue), state };
}

async function executeSchedulerActivation(
	definition: WorkflowDefinition,
	options: WorkflowSchedulerOptions,
	activation: WorkflowActivation,
	node: WorkflowNode,
	context: WorkflowSchedulerExecutionContext,
): Promise<WorkflowActivationExecutionResult> {
	try {
		return {
			activation,
			node,
			output: validateWorkflowActivationOutput(await options.executeNode(activation, node, context), {
				allowedWritePaths: node.writes,
				stateSchema: definition.stateSchema,
			}),
		};
	} catch (error) {
		const abortReason = workflowAbortReason(context.nodeAbortSignal);
		if (abortReason) {
			return {
				activation,
				node,
				error: abortReason,
				aborted: true,
			};
		}
		return {
			activation,
			node,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

async function nextSchedulerActivationResult(
	running: Map<string, RunningWorkflowActivation>,
): Promise<WorkflowActivationExecutionResult> {
	return Promise.race([...running.values()].map(entry => entry.result));
}

interface WorkflowSchedulerQueueState {
	queue: WorkflowActivation[];
	queuedJoinKeys: Set<string>;
	createNextActivation: (nodeId: string, parentActivationIds: string[]) => WorkflowActivation;
}

function enqueueReadyChildren(
	definition: WorkflowDefinition,
	activation: WorkflowActivation,
	nodesById: Map<string, WorkflowNode>,
	completedByNode: Map<string, WorkflowActivation[]>,
	completedById: Map<string, WorkflowActivation>,
	outputsByNode: Record<string, unknown>,
	state: Record<string, unknown>,
	queueState: WorkflowSchedulerQueueState,
): void {
	for (const edge of definition.edges.filter(edge => edge.from === activation.nodeId)) {
		if (edge.condition && !evaluateWorkflowCondition(edge.condition.source, { state, outputs: outputsByNode })) {
			continue;
		}
		const target = nodesById.get(edge.to);
		if (target?.waitFor?.length) {
			const parentActivationIds = collectJoinParentIds(target.waitFor, completedByNode, completedById, activation);
			if (!parentActivationIds) continue;
			const joinKey = `${target.id}:${parentActivationIds.join(",")}`;
			if (queueState.queuedJoinKeys.has(joinKey)) continue;
			queueState.queuedJoinKeys.add(joinKey);
			queueState.queue.push(queueState.createNextActivation(edge.to, parentActivationIds));
			continue;
		}
		queueState.queue.push(queueState.createNextActivation(edge.to, [activation.id]));
	}
}

function eligibleFrontierNodeIds(
	definition: WorkflowDefinition,
	activation: WorkflowActivation,
	nodesById: Map<string, WorkflowNode>,
	completedByNode: Map<string, WorkflowActivation[]>,
	completedById: Map<string, WorkflowActivation>,
	state: Record<string, unknown>,
	outputsByNode: Record<string, unknown>,
): string[] {
	const frontierNodeIds: string[] = [];
	for (const edge of definition.edges.filter(edge => edge.from === activation.nodeId)) {
		if (edge.condition && !evaluateWorkflowCondition(edge.condition.source, { state, outputs: outputsByNode })) {
			continue;
		}
		const target = nodesById.get(edge.to);
		if (
			target?.waitFor?.length &&
			!collectJoinParentIds(target.waitFor, completedByNode, completedById, activation)
		) {
			continue;
		}
		pushUnique(frontierNodeIds, edge.to);
	}
	return frontierNodeIds;
}

function seedCompletedByNode(completedActivations: WorkflowActivation[]): Map<string, WorkflowActivation[]> {
	const completedByNode = new Map<string, WorkflowActivation[]>();
	for (const activation of completedActivations) {
		if (activation.status !== "completed") continue;
		const completed = completedByNode.get(activation.nodeId) ?? [];
		completed.push(activation);
		completedByNode.set(activation.nodeId, completed);
	}
	return completedByNode;
}

function seedCompletedById(completedActivations: WorkflowActivation[]): Map<string, WorkflowActivation> {
	const completedById = new Map<string, WorkflowActivation>();
	for (const activation of completedActivations) {
		if (activation.status !== "completed") continue;
		completedById.set(activation.id, activation);
	}
	return completedById;
}

function seedOutputsByNode(completedActivations: WorkflowActivation[]): Record<string, unknown> {
	const outputsByNode: Record<string, unknown> = {};
	for (const activation of completedActivations) {
		if (activation.status !== "completed") continue;
		if (activation.output?.data !== undefined) {
			outputsByNode[activation.nodeId] = activation.output.data;
		}
	}
	return outputsByNode;
}

function nextActivationOrdinal(completedActivations: WorkflowActivation[]): number {
	let maxOrdinal = 0;
	for (const activation of completedActivations) {
		const match = /^activation-(\d+)$/u.exec(activation.id);
		if (!match) continue;
		const ordinal = Number(match[1]);
		if (Number.isSafeInteger(ordinal) && ordinal > maxOrdinal) maxOrdinal = ordinal;
	}
	return maxOrdinal + 1;
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

function uniqueNodeIds(activations: WorkflowActivation[]): string[] {
	const seen = new Set<string>();
	const nodeIds: string[] = [];
	for (const activation of activations) {
		if (seen.has(activation.nodeId)) continue;
		seen.add(activation.nodeId);
		nodeIds.push(activation.nodeId);
	}
	return nodeIds;
}

function pushUnique(values: string[], value: string): void {
	if (!values.includes(value)) values.push(value);
}

function collectJoinParentIds(
	waitFor: string[],
	completedByNode: Map<string, WorkflowActivation[]>,
	completedById: Map<string, WorkflowActivation>,
	currentActivation: WorkflowActivation,
): string[] | undefined {
	const includeCurrentActivation = !waitFor.includes(currentActivation.nodeId);
	for (const generation of joinGenerationCandidates(currentActivation, completedById, new Set(waitFor))) {
		const parentIds: string[] = [];
		for (const nodeId of waitFor) {
			const completed = completedByNode.get(nodeId);
			const matching = latestActivationInJoinGeneration(completed, generation, completedById);
			if (!matching) break;
			parentIds.push(matching.id);
		}
		if (parentIds.length === waitFor.length) {
			if (includeCurrentActivation) parentIds.push(currentActivation.id);
			return parentIds;
		}
	}
	if (!includeCurrentActivation) return undefined;
	const parentIds: string[] = [];
	for (const nodeId of waitFor) {
		const matching = latestCompletedActivation(completedByNode.get(nodeId));
		if (!matching) return undefined;
		parentIds.push(matching.id);
	}
	parentIds.push(currentActivation.id);
	return parentIds;
}

function latestCompletedActivation(activations: WorkflowActivation[] | undefined): WorkflowActivation | undefined {
	return activations?.at(-1);
}

function latestActivationInJoinGeneration(
	activations: WorkflowActivation[] | undefined,
	generation: string | null,
	completedById: Map<string, WorkflowActivation>,
): WorkflowActivation | undefined {
	if (activations === undefined) return undefined;
	for (let index = activations.length - 1; index >= 0; index -= 1) {
		const activation = activations[index]!;
		if (activationInJoinGeneration(activation, generation, completedById)) return activation;
	}
	return undefined;
}

function activationInJoinGeneration(
	activation: WorkflowActivation,
	generation: string | null,
	completedById: Map<string, WorkflowActivation>,
): boolean {
	if (generation === null) return activation.parentActivationIds.length === 0;
	return activation.id === generation || activationAncestorIds(activation, completedById).includes(generation);
}

function joinGenerationCandidates(
	activation: WorkflowActivation,
	completedById: Map<string, WorkflowActivation>,
	waitFor: Set<string>,
): Array<string | null> {
	const ancestors = activationAncestorIds(activation, completedById);
	if (ancestors.length === 0) return [null];
	const candidates: string[] = [];
	for (const ancestorId of ancestors) {
		const ancestor = completedById.get(ancestorId);
		if (ancestor && waitFor.has(ancestor.nodeId)) break;
		candidates.push(ancestorId);
	}
	return candidates;
}

function activationAncestorIds(
	activation: WorkflowActivation,
	completedById: Map<string, WorkflowActivation>,
): string[] {
	const seen = new Set<string>();
	const ancestors: string[] = [];
	const queue = [...activation.parentActivationIds];
	while (queue.length > 0) {
		const id = queue.shift()!;
		if (seen.has(id)) continue;
		seen.add(id);
		ancestors.push(id);
		const parent = completedById.get(id);
		if (parent) queue.push(...parent.parentActivationIds);
	}
	return ancestors;
}
