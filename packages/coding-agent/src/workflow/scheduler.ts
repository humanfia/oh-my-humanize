import { evaluateWorkflowCondition } from "./condition";
import type { WorkflowDefinition, WorkflowNode } from "./definition";
import {
	applyWorkflowStatePatch,
	readWorkflowState,
	validateWorkflowActivationOutput,
	type WorkflowActivationOutput,
} from "./state";

export type WorkflowActivationStatus = "queued" | "running" | "completed" | "failed" | "aborted";

export type WorkflowMappedActivationPhase = "worker" | "verifier" | "reducer";

export interface WorkflowMappedActivationContext {
	poolId: string;
	poolActivationId: string;
	itemKey: string;
	item: unknown;
	phase: WorkflowMappedActivationPhase;
	workerActivationId?: string;
	verifierActivationId?: string;
}

export interface WorkflowActivation {
	id: string;
	nodeId: string;
	graphRevisionId: string;
	status: WorkflowActivationStatus;
	parentActivationIds: string[];
	output?: WorkflowActivationOutput;
	error?: string;
	reason?: string;
	mapped?: WorkflowMappedActivationContext;
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
	onMappedPoolActivationStarted?: (activation: WorkflowActivation, node: WorkflowNode) => void;
	onMappedPoolActivationCompleted?: (activation: WorkflowActivation, output: WorkflowActivationOutput) => void;
	onMappedPoolActivationFailed?: (activation: WorkflowActivation, error: string) => void;
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

interface RunningMappedPool {
	poolActivation: WorkflowActivation;
	spec: NonNullable<WorkflowNode["mappedPool"]>;
	claimedItemKeys: Set<string>;
	completedItemKeys: Set<string>;
	inFlightActivationIds: Set<string>;
	workerByItemKey: Map<string, string>;
	verifierByItemKey: Map<string, string>;
	claimedCount: number;
}

type StartMappedActivationFn = (
	poolActivationId: string,
	nodeId: string,
	itemKey: string,
	item: unknown,
	phase: WorkflowMappedActivationPhase,
	parentActivationIds: string[],
	workerActivationId?: string,
	verifierActivationId?: string,
) => WorkflowActivation | undefined;
function readMappedPoolItemKey(item: unknown, itemKeyPath: string): string | undefined {
	const keyValue = readWorkflowState(item as Record<string, unknown>, itemKeyPath);
	if (typeof keyValue !== "string" || keyValue.length === 0) return undefined;
	return keyValue;
}

function allMappedPoolItemsClaimedOrCompleted(
	spec: RunningMappedPool["spec"],
	state: Record<string, unknown>,
	claimedItemKeys: Set<string>,
	completedItemKeys: Set<string>,
): boolean {
	const sourceValue = readWorkflowState(state, spec.itemSource);
	if (!Array.isArray(sourceValue)) return false;
	return sourceValue.every(item => {
		const keyValue = readMappedPoolItemKey(item, spec.itemKey);
		return keyValue === undefined || claimedItemKeys.has(keyValue) || completedItemKeys.has(keyValue);
	});
}

function claimMappedPoolItems(
	poolActivationId: string,
	state: Record<string, unknown>,
	pools: Map<string, RunningMappedPool>,
	startActivation: StartMappedActivationFn,
	onLimitReached: () => boolean,
): void {
	const pool = pools.get(poolActivationId);
	if (pool?.poolActivation.status !== "running") return;
	const { spec, poolActivation } = pool;
	const sourceValue = readWorkflowState(state, spec.itemSource);
	if (!Array.isArray(sourceValue)) {
		pool.poolActivation.status = "failed";
		pool.poolActivation.error = `mapped pool "${poolActivation.nodeId}" itemSource "${spec.itemSource}" must resolve to an array`;
		return;
	}
	const seenKeys = new Set<string>();
	for (let index = 0; index < sourceValue.length; index += 1) {
		if (pool.inFlightActivationIds.size >= spec.maxConcurrency) break;
		const item = sourceValue[index];
		const keyValue = readMappedPoolItemKey(item, spec.itemKey);
		if (keyValue === undefined) {
			pool.poolActivation.status = "failed";
			pool.poolActivation.error = `mapped pool "${poolActivation.nodeId}" item at index ${index} has invalid itemKey "${spec.itemKey}"`;
			return;
		}
		if (seenKeys.has(keyValue)) {
			pool.poolActivation.status = "failed";
			pool.poolActivation.error = `mapped pool "${poolActivation.nodeId}" saw duplicate item key "${keyValue}" at "${spec.itemSource}"`;
			return;
		}
		seenKeys.add(keyValue);
		if (pool.claimedItemKeys.has(keyValue) || pool.completedItemKeys.has(keyValue)) continue;
		if (pool.claimedCount >= spec.maxItems) {
			pool.poolActivation.status = "failed";
			pool.poolActivation.error = `mapped pool "${poolActivation.nodeId}" exceeded maxItems ${spec.maxItems}`;
			return;
		}
		pool.claimedItemKeys.add(keyValue);
		pool.claimedCount += 1;
		const activation = startActivation(poolActivation.id, spec.workerNodeId, keyValue, item, "worker", [
			poolActivation.id,
		]);
		if (!activation) {
			if (onLimitReached()) {
				pool.poolActivation.status = "failed";
				pool.poolActivation.error = `mapped pool "${poolActivation.nodeId}" stopped because activation limit was reached`;
			}
			return;
		}
		pool.workerByItemKey.set(keyValue, activation.id);
	}
}
function handleMappedActivationCompletion(
	result: WorkflowActivationExecutionResult,
	pools: Map<string, RunningMappedPool>,
	state: Record<string, unknown>,
	outputsByNode: Record<string, unknown>,
	completedByNode: Map<string, WorkflowActivation[]>,
	completedById: Map<string, WorkflowActivation>,
	_nodesById: Map<string, WorkflowNode>,
	startActivation: StartMappedActivationFn,
	completePool: (poolActivationId: string) => void,
	failPool: (poolActivationId: string, reason: string) => void,
	onLimitReached: () => boolean,
): void {
	const { activation, node } = result;
	const mapped = activation.mapped;
	if (!mapped) return;
	const pool = pools.get(mapped.poolActivationId);
	if (pool) pool.inFlightActivationIds.delete(activation.id);
	if (!pool) return;
	if (pool.poolActivation.status !== "running") {
		settleMappedActivationAfterPoolStopped(result);
		return;
	}
	const fail = (reason: string): void => {
		activation.status = result.aborted ? "aborted" : "failed";
		if (result.aborted) {
			activation.reason = reason;
		} else {
			activation.error = reason;
		}
		failPool(
			mapped.poolActivationId,
			`mapped pool "${mapped.poolId}" ${mapped.phase} for item "${mapped.itemKey}" ${result.aborted ? "aborted" : "failed"}: ${reason}`,
		);
	};
	if (result.aborted === true) {
		fail(result.error ?? "workflow activation aborted");
		return;
	}
	if (result.error !== undefined) {
		fail(result.error);
		return;
	}
	const output = result.output;
	if (output === undefined) {
		fail(`workflow activation ${activation.id} produced no output`);
		return;
	}
	activation.output = output;
	if (output.statePatch) {
		applyWorkflowStatePatch(state, output.statePatch, {
			allowedWritePaths: node.writes,
			stateSchema: undefined,
		});
	}
	if (output.data !== undefined) {
		outputsByNode[activation.nodeId] = output.data;
	} else {
		delete outputsByNode[activation.nodeId];
	}
	activation.status = "completed";
	const completed = completedByNode.get(activation.nodeId) ?? [];
	completed.push(activation);
	completedByNode.set(activation.nodeId, completed);
	completedById.set(activation.id, activation);
	if (mapped.phase === "worker") {
		pool.workerByItemKey.set(mapped.itemKey, activation.id);
		const verifierActivation = startActivation(
			mapped.poolActivationId,
			pool.spec.verifierNodeId,
			mapped.itemKey,
			mapped.item,
			"verifier",
			[pool.poolActivation.id],
			activation.id,
		);
		if (!verifierActivation) {
			failPool(
				mapped.poolActivationId,
				`mapped pool "${mapped.poolId}" stopped because activation limit was reached`,
			);
		}
		return;
	}
	if (mapped.phase === "verifier") {
		pool.verifierByItemKey.set(mapped.itemKey, activation.id);
		const reducerActivation = startActivation(
			mapped.poolActivationId,
			pool.spec.reducerNodeId,
			mapped.itemKey,
			mapped.item,
			"reducer",
			[pool.poolActivation.id],
			mapped.workerActivationId,
			activation.id,
		);
		if (!reducerActivation) {
			failPool(
				mapped.poolActivationId,
				`mapped pool "${mapped.poolId}" stopped because activation limit was reached`,
			);
		}
		return;
	}
	if (mapped.phase === "reducer") {
		pool.completedItemKeys.add(mapped.itemKey);
		claimMappedPoolItems(mapped.poolActivationId, state, pools, startActivation, onLimitReached);
		if (pool.poolActivation.status !== "running") return;
		if (pool.inFlightActivationIds.size === 0) {
			if (pool.spec.stopWhen) {
				if (evaluateWorkflowCondition(pool.spec.stopWhen.source, { state, outputs: outputsByNode })) {
					completePool(mapped.poolActivationId);
					return;
				}
			}
			if (allMappedPoolItemsClaimedOrCompleted(pool.spec, state, pool.claimedItemKeys, pool.completedItemKeys)) {
				completePool(mapped.poolActivationId);
			}
		}
	}
}

function settleMappedActivationAfterPoolStopped(result: WorkflowActivationExecutionResult): void {
	if (result.aborted === true) {
		result.activation.status = "aborted";
		result.activation.reason = result.error ?? "workflow activation aborted";
		return;
	}
	if (result.error !== undefined) {
		result.activation.status = "failed";
		result.activation.error = result.error;
		return;
	}
	if (result.output === undefined) {
		result.activation.status = "failed";
		result.activation.error = `workflow activation ${result.activation.id} produced no output`;
		return;
	}
	result.activation.output = result.output;
	result.activation.status = "completed";
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
	const seededMappedPoolProgress = seedMappedPoolProgress(externalCompletedActivations);
	const mappedPools = new Map<string, RunningMappedPool>();
	let nextActivationId = nextActivationOrdinal(externalCompletedActivations);
	const createNextActivation = (
		nodeId: string,
		parentActivationIds: string[],
		mapped?: WorkflowMappedActivationContext,
	): WorkflowActivation => ({
		id: `activation-${nextActivationId++}`,
		nodeId,
		graphRevisionId,
		status: "queued",
		parentActivationIds,
		mapped,
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
	const activationLimitReached = (): boolean => {
		limitReached = true;
		return true;
	};
	const startActivation = (activation: WorkflowActivation, node: WorkflowNode): void => {
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
	};
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
			if (node.type === "mapped_pool") {
				activation.status = "running";
				activations.push(activation);
				const spec = node.mappedPool;
				if (!spec) {
					activation.status = "failed";
					activation.error = `mapped_pool node "${node.id}" must define mappedPool`;
					continue;
				}
				const seededProgress = seededMappedPoolProgress.get(node.id);
				const pool: RunningMappedPool = {
					poolActivation: activation,
					spec,
					claimedItemKeys: new Set<string>(seededProgress?.claimedItemKeys ?? []),
					completedItemKeys: new Set<string>(seededProgress?.completedItemKeys ?? []),
					inFlightActivationIds: new Set<string>(),
					workerByItemKey: new Map<string, string>(),
					verifierByItemKey: new Map<string, string>(),
					claimedCount: seededProgress?.claimedCount ?? 0,
				};
				mappedPools.set(activation.id, pool);
				options.onMappedPoolActivationStarted?.(activation, node);
				claimMappedPoolItems(activation.id, state, mappedPools, startMappedActivation, activationLimitReached);
				if (pool.poolActivation.status === "failed") {
					options.onMappedPoolActivationFailed?.(
						pool.poolActivation,
						pool.poolActivation.error ?? "mapped pool failed during item claim",
					);
					stopScheduling = true;
					continue;
				}
				if (
					pool.poolActivation.status === "running" &&
					pool.inFlightActivationIds.size === 0 &&
					allMappedPoolItemsClaimedOrCompleted(spec, state, pool.claimedItemKeys, pool.completedItemKeys)
				) {
					completeMappedPool(activation.id);
				}
				continue;
			}
			startActivation(activation, node);
		}
	};
	const startMappedActivation = (
		poolActivationId: string,
		nodeId: string,
		itemKey: string,
		item: unknown,
		phase: WorkflowMappedActivationPhase,
		parentActivationIds: string[],
		workerActivationId?: string,
		verifierActivationId?: string,
	): WorkflowActivation | undefined => {
		if (activations.length >= maxActivations) {
			limitReached = true;
			return undefined;
		}
		if (countNodeActivations([...externalCompletedActivations, ...activations], nodeId) >= maxNodeActivations) {
			limitReached = true;
			return undefined;
		}
		const pool = mappedPools.get(poolActivationId);
		if (!pool) return undefined;
		const node = nodesById.get(nodeId);
		if (!node) {
			failMappedPool(
				poolActivationId,
				`mapped pool "${pool.poolActivation.nodeId}" references unknown ${phase} node "${nodeId}"`,
			);
			return undefined;
		}
		const activation = createNextActivation(nodeId, parentActivationIds, {
			poolId: pool.poolActivation.nodeId,
			poolActivationId: pool.poolActivation.id,
			itemKey,
			item,
			phase,
			workerActivationId,
			verifierActivationId,
		});
		pool.inFlightActivationIds.add(activation.id);
		startActivation(activation, node);
		return activation;
	};
	const failMappedPool = (poolActivationId: string, reason: string): void => {
		const pool = mappedPools.get(poolActivationId);
		if (pool?.poolActivation.status !== "running") return;
		pool.poolActivation.status = "failed";
		pool.poolActivation.error = reason;
		options.onMappedPoolActivationFailed?.(pool.poolActivation, reason);
		stopScheduling = true;
	};
	const completeMappedPool = (poolActivationId: string): void => {
		const pool = mappedPools.get(poolActivationId);
		if (pool?.poolActivation.status !== "running") return;
		const output: WorkflowActivationOutput = {
			summary: `mapped pool "${pool.poolActivation.nodeId}" completed ${pool.completedItemKeys.size} item(s)`,
		};
		pool.poolActivation.status = "completed";
		pool.poolActivation.output = output;
		delete outputsByNode[pool.poolActivation.nodeId];
		const completed = completedByNode.get(pool.poolActivation.nodeId) ?? [];
		completed.push(pool.poolActivation);
		completedByNode.set(pool.poolActivation.nodeId, completed);
		completedById.set(pool.poolActivation.id, pool.poolActivation);
		options.onMappedPoolActivationCompleted?.(pool.poolActivation, output);
		enqueueReadyChildren(
			definition,
			pool.poolActivation,
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
	};
	startReadyActivations();
	while (running.size > 0) {
		const result = await nextSchedulerActivationResult(running);
		running.delete(result.activation.id);
		if (result.activation.mapped) {
			handleMappedActivationCompletion(
				result,
				mappedPools,
				state,
				outputsByNode,
				completedByNode,
				completedById,
				nodesById,
				startMappedActivation,
				completeMappedPool,
				failMappedPool,
				activationLimitReached,
			);
			if (!stopScheduling) startReadyActivations();
			continue;
		}
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
		const abortReason = workflowAbortReason(context.nodeAbortSignal) ?? workflowAbortReason(context.signal);
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
function seedMappedPoolProgress(
	completedActivations: WorkflowActivation[],
): Map<string, Pick<RunningMappedPool, "claimedItemKeys" | "completedItemKeys" | "claimedCount">> {
	const progressByPoolId = new Map<string, { claimed: Set<string>; completed: Set<string> }>();
	for (const activation of completedActivations) {
		if (activation.status !== "completed" || activation.mapped === undefined) continue;
		const { poolId, itemKey, phase } = activation.mapped;
		const progress = progressByPoolId.get(poolId) ?? { claimed: new Set<string>(), completed: new Set<string>() };
		progress.claimed.add(itemKey);
		if (phase === "reducer") {
			progress.completed.add(itemKey);
		}
		progressByPoolId.set(poolId, progress);
	}
	return new Map(
		[...progressByPoolId.entries()].map(([poolId, progress]) => [
			poolId,
			{
				claimedItemKeys: progress.claimed,
				completedItemKeys: progress.completed,
				claimedCount: progress.claimed.size,
			},
		]),
	);
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
