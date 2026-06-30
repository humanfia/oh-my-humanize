import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { getWorkflowMonitorCacheDir } from "@oh-my-pi/pi-utils";
import type { CanonicalModelRegistry, ModelMatchPreferences } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import type { WorkflowDefinition, WorkflowNode } from "./definition";
import type { FlowFreeze, FlowFreezeResourceSnapshot } from "./freeze";
import {
	type AppendWorkflowAttemptActivationStartedOptions,
	appendWorkflowAttemptActivationAborted,
	appendWorkflowAttemptActivationCompleted,
	appendWorkflowAttemptActivationFailed,
	appendWorkflowAttemptActivationStarted,
	type CreateWorkflowCheckpointOptions,
	completeWorkflowAttempt,
	createWorkflowCheckpoint,
	failWorkflowAttempt,
	type RuntimeBindingSnapshot,
	reconstructWorkflowFamilies,
	recordWorkflowFreeze,
	requestWorkflowAttemptStop,
	restartWorkflowAttempt,
	startWorkflowAttempt,
	startWorkflowFamily,
	type WorkflowCheckpointWorkspaceSnapshot,
} from "./lifecycle";
import { diagnoseWorkflowLiveness } from "./liveness";
import { resolveWorkflowNodeModel, type WorkflowModelResolutionAudit } from "./model-resolution";
import {
	executeWorkflowNode,
	WorkflowNodeAbortedError,
	type WorkflowNodeRuntimeHost,
	workflowNodeAbortedErrorReason,
} from "./node-runtime";
import { reconcileWorkflowSchedulerFailureObservability, recordWorkflowCheckpointObservability } from "./observability";
import {
	resolveWorkflowPrompt,
	type WorkflowActivationInputSnapshot,
	type WorkflowResolvedPrompt,
} from "./prompt-source";
import {
	appendWorkflowActivationAborted,
	appendWorkflowActivationCompleted,
	appendWorkflowActivationFailed,
	appendWorkflowActivationStarted,
	appendWorkflowStatePatch,
	startWorkflowRun,
	type WorkflowRunSnapshot,
	type WorkflowRunStoreHost,
} from "./run-store";
import { workflowMaxRuntimeStopReason } from "./runtime-timeout";
import {
	runWorkflowScheduler,
	type WorkflowActivation,
	type WorkflowSchedulerExecutionContext,
	type WorkflowSchedulerResult,
} from "./scheduler";
import { validateWorkflowActivationOutput, type WorkflowActivationOutput } from "./state";
import {
	assertWorkflowWorkspaceSnapshotUnchanged,
	captureWorkflowCheckpointWorkspace,
	workflowRuntimeScratchDirtyPathPrefixes,
} from "./workspace-checkpoint";

export interface WorkflowRunnerModelResolutionOptions {
	availableModels: Model<Api>[];
	settings?: Settings;
	matchPreferences?: ModelMatchPreferences;
	modelRegistry?: CanonicalModelRegistry;
	parentActiveModelPattern?: string;
	agentModels?: Record<string, string | string[]>;
}

export interface WorkflowRunnerOptions {
	host: WorkflowRunStoreHost;
	definition: WorkflowDefinition;
	runId: string;
	graphRevisionId?: string;
	startNodeId: string;
	startNodeIds?: string[];
	runtimeHost: WorkflowNodeRuntimeHost;
	modelResolution?: WorkflowRunnerModelResolutionOptions;
	maxActivations?: number;
	maxNodeActivations?: number;
	initialState?: Record<string, unknown>;
	completedActivations?: WorkflowActivation[];
	startParentActivationIds?: string[];
	signal?: AbortSignal;
	nodeAbortSignal?: AbortSignal;
	nodeAbortSignalForActivation?: (activation: WorkflowActivation) => AbortSignal | undefined;
	maxRuntimeMs?: number;
	workspaceRoot?: string;
	packageRoot?: string;
	maxPromptBytes?: number;
	frozenResources?: FlowFreezeResourceSnapshot[];
	resourceTempRoot?: string;
	lifecycle?: WorkflowRunnerLifecycleOptions;
}

export interface WorkflowRunnerResult {
	run: WorkflowRunSnapshot;
	scheduler: WorkflowSchedulerResult;
}

export interface WorkflowRunnerLifecycleOptions {
	familyId: string;
	attemptId: string;
	objective?: string;
	freeze: FlowFreeze;
	runtimeBindingSnapshot: RuntimeBindingSnapshot;
	checkpointId?: string;
	stopDeadlineMs?: number;
	recordFamily?: boolean;
	recordFreeze?: boolean;
}

export class WorkflowRunnerError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WorkflowRunnerError";
	}
}

const WORKFLOW_STOP_REQUEST_POLL_MS = 50;

export async function runWorkflow(options: WorkflowRunnerOptions): Promise<WorkflowRunnerResult> {
	startLifecycleAttempt(options);
	const run = startWorkflowRun(options.host, options.definition, {
		runId: options.runId,
		graphRevisionId: options.graphRevisionId,
	});
	const runtimeSignal = workflowRuntimeSignal(options);
	const resourceDir = await materializeWorkflowResources(
		workflowFrozenResources(options),
		workflowResourceTempRoot(options.resourceTempRoot, options.workspaceRoot),
	);
	try {
		const scheduler = await runWorkflowScheduler(options.definition, {
			startNodeId: options.startNodeId,
			maxActivations: options.maxActivations,
			maxNodeActivations: options.maxNodeActivations,
			initialState: options.initialState,
			completedActivations: options.completedActivations,
			startNodeIds: options.startNodeIds,
			startParentActivationIds: options.startParentActivationIds,
			signal: runtimeSignal.signal,
			nodeAbortSignal: runtimeSignal.nodeAbortSignal,
			nodeAbortSignalForActivation: runtimeSignal.nodeAbortSignalForActivation,
			graphRevisionId: run.currentGraphRevisionId,
			executeNode: async (activation, node, context) =>
				executeAndPersistActivation(options, run, activation, node, context, resourceDir),
		});
		await reconcileWorkflowSchedulerFailureObservability(
			options.workspaceRoot,
			options.definition.nodes,
			scheduler.activations,
		);
		await finishLifecycleAttempt(options, scheduler, runtimeSignal.signal);
		return { run, scheduler };
	} finally {
		runtimeSignal.dispose();
		await removeMaterializedWorkflowResources(resourceDir);
	}
}

interface WorkflowRuntimeSignal {
	signal?: AbortSignal;
	nodeAbortSignal?: AbortSignal;
	nodeAbortSignalForActivation?: (activation: WorkflowActivation) => AbortSignal | undefined;
	dispose: () => void;
}

function workflowRuntimeSignal(options: WorkflowRunnerOptions): WorkflowRuntimeSignal {
	const disposers: Array<() => void> = [];
	const timeoutSignal = workflowRuntimeTimeoutSignal(options.maxRuntimeMs, disposers);
	const lifecycleStop = workflowLifecycleStopSignal(options, disposers);
	const signal = combineAbortSignals([options.signal, timeoutSignal, lifecycleStop.signal]);
	const nodeAbortSignal = combineAbortSignals([
		options.nodeAbortSignal,
		options.signal,
		timeoutSignal,
		lifecycleStop.nodeAbortSignal,
	]);
	return {
		signal,
		nodeAbortSignal,
		nodeAbortSignalForActivation:
			options.nodeAbortSignalForActivation === undefined &&
			timeoutSignal === undefined &&
			lifecycleStop.nodeAbortSignal === undefined
				? undefined
				: activation =>
						combineAbortSignals([
							options.nodeAbortSignalForActivation?.(activation),
							options.signal,
							timeoutSignal,
							lifecycleStop.nodeAbortSignal,
						]),
		dispose: () => {
			for (const dispose of disposers.splice(0)) dispose();
		},
	};
}

function workflowRuntimeTimeoutSignal(
	maxRuntimeMs: number | undefined,
	disposers: Array<() => void>,
): AbortSignal | undefined {
	if (maxRuntimeMs === undefined) return undefined;
	const timeoutController = new AbortController();
	const timeout = setTimeout(() => timeoutController.abort(workflowMaxRuntimeStopReason(maxRuntimeMs)), maxRuntimeMs);
	disposers.push(() => clearTimeout(timeout));
	return timeoutController.signal;
}

interface WorkflowLifecycleStopSignal {
	signal?: AbortSignal;
	nodeAbortSignal?: AbortSignal;
}

function workflowLifecycleStopSignal(
	options: WorkflowRunnerOptions,
	disposers: Array<() => void>,
): WorkflowLifecycleStopSignal {
	const lifecycle = options.lifecycle;
	if (lifecycle === undefined) return {};
	const stopController = new AbortController();
	const nodeAbortController = new AbortController();
	let nodeAbortTimeout: NodeJS.Timeout | undefined;
	const abortNodes = (reason: string): void => {
		if (!nodeAbortController.signal.aborted) nodeAbortController.abort(reason);
	};
	const inspectStopRequest = (): void => {
		if (stopController.signal.aborted) return;
		const attempt = reconstructWorkflowFamilies(options.host.getBranch())
			.find(candidate => candidate.id === lifecycle.familyId)
			?.attempts.find(candidate => candidate.id === lifecycle.attemptId);
		if (attempt?.status !== "stop_requested") return;
		const reason = attempt.stop?.reason ?? "workflow stop requested";
		stopController.abort(reason);
		const deadlineMs = attempt.stop?.deadlineMs ?? lifecycle.stopDeadlineMs ?? 0;
		if (deadlineMs <= 0) {
			abortNodes("stop deadline elapsed");
			return;
		}
		nodeAbortTimeout = setTimeout(() => abortNodes("stop deadline elapsed"), deadlineMs);
	};
	const poll = setInterval(inspectStopRequest, WORKFLOW_STOP_REQUEST_POLL_MS);
	queueMicrotask(inspectStopRequest);
	disposers.push(() => {
		clearInterval(poll);
		if (nodeAbortTimeout !== undefined) clearTimeout(nodeAbortTimeout);
	});
	return {
		signal: stopController.signal,
		nodeAbortSignal: nodeAbortController.signal,
	};
}

function combineAbortSignals(signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
	const activeSignals = signals.filter((signal): signal is AbortSignal => signal !== undefined);
	if (activeSignals.length === 0) return undefined;
	if (activeSignals.length === 1) return activeSignals[0];
	const controller = new AbortController();
	const abortFrom = (signal: AbortSignal): void => {
		if (!controller.signal.aborted) {
			controller.abort(signal.reason);
		}
	};
	for (const signal of activeSignals) {
		if (signal.aborted) abortFrom(signal);
		signal.addEventListener("abort", () => abortFrom(signal), { once: true });
	}
	return controller.signal;
}

function startLifecycleAttempt(options: WorkflowRunnerOptions): void {
	const lifecycle = options.lifecycle;
	if (!lifecycle) return;
	if (lifecycle.recordFamily !== false) {
		startWorkflowFamily(options.host, {
			familyId: lifecycle.familyId,
			objective: lifecycle.objective,
		});
	}
	if (lifecycle.recordFreeze !== false) {
		recordWorkflowFreeze(options.host, lifecycle.freeze, { familyId: lifecycle.familyId });
	}
	const attemptOptions = {
		familyId: lifecycle.familyId,
		attemptId: lifecycle.attemptId,
		freezeId: lifecycle.freeze.id,
		startNodeId: options.startNodeId,
		startNodeIds: options.startNodeIds,
		runtimeBindingSnapshot: lifecycle.runtimeBindingSnapshot,
	};
	if (lifecycle.checkpointId !== undefined) {
		restartWorkflowAttempt(options.host, {
			...attemptOptions,
			checkpointId: lifecycle.checkpointId,
		});
		return;
	}
	startWorkflowAttempt(options.host, attemptOptions);
}

async function finishLifecycleAttempt(
	options: WorkflowRunnerOptions,
	scheduler: WorkflowSchedulerResult,
	signal: AbortSignal | undefined,
): Promise<void> {
	const lifecycle = options.lifecycle;
	if (!lifecycle) return;
	const failed = scheduler.activations.find(activation => activation.status === "failed");
	if (failed) {
		failWorkflowAttempt(options.host, {
			attemptId: lifecycle.attemptId,
			error: failed.error ?? `workflow activation ${failed.id} failed`,
		});
		const failedFrontierNodeIds = failedWorkflowFrontierNodeIds(scheduler);
		await createAndRecordLifecycleCheckpoint(options, scheduler, failedFrontierNodeIds);
		return;
	}
	const checkpointReason = workflowCheckpointReason(scheduler, signal);
	if (checkpointReason !== undefined) {
		requestWorkflowAttemptStopIfRunning(options, checkpointReason);
		await createAndRecordLifecycleCheckpoint(options, scheduler, scheduler.frontierNodeIds);
		return;
	}
	completeWorkflowAttempt(options.host, {
		attemptId: lifecycle.attemptId,
		summary: "workflow completed",
	});
}

async function createAndRecordLifecycleCheckpoint(
	options: WorkflowRunnerOptions,
	scheduler: WorkflowSchedulerResult,
	frontierNodeIds: string[],
): Promise<void> {
	const lifecycle = options.lifecycle;
	if (!lifecycle) return;
	const checkpointOptions: CreateWorkflowCheckpointOptions = {
		checkpointId: `${lifecycle.attemptId}:checkpoint-1`,
		familyId: lifecycle.familyId,
		attemptId: lifecycle.attemptId,
		completedActivationIds: scheduler.activations
			.filter(activation => activation.status === "completed")
			.map(activation => activation.id),
		abortedActivationIds: scheduler.activations
			.filter(activation => activation.status === "aborted")
			.map(activation => activation.id),
		frontierNodeIds,
		state: scheduler.state,
		sourceMapping: lifecycleCheckpointSourceMapping(options, frontierNodeIds),
		workspace: await captureLifecycleCheckpointWorkspace(options),
	};
	const checkpoint = createWorkflowCheckpoint(options.host, checkpointOptions);
	await recordWorkflowCheckpointObservability(options.workspaceRoot, {
		attemptId: checkpoint.attemptId,
		checkpointId: checkpoint.id,
		completedActivationIds: checkpoint.completedActivationIds,
		abortedActivationIds: checkpoint.abortedActivationIds,
		frontierNodeIds: checkpoint.frontierNodeIds,
		workspace: checkpoint.workspace,
	});
}

function captureLifecycleCheckpointWorkspace(
	options: WorkflowRunnerOptions,
): Promise<WorkflowCheckpointWorkspaceSnapshot | undefined> {
	return captureWorkflowCheckpointWorkspace(options.workspaceRoot, {
		ignoredDirtyPathPrefixes: workflowRuntimeScratchDirtyPathPrefixes(options.workspaceRoot),
	});
}

function requestWorkflowAttemptStopIfRunning(options: WorkflowRunnerOptions, reason: string): void {
	const lifecycle = options.lifecycle;
	if (!lifecycle) return;
	const family = reconstructWorkflowFamilies(options.host.getBranch()).find(
		candidate => candidate.id === lifecycle.familyId,
	);
	const attempt = family?.attempts.find(candidate => candidate.id === lifecycle.attemptId);
	if (attempt?.status !== "running") return;
	requestWorkflowAttemptStop(options.host, {
		attemptId: lifecycle.attemptId,
		deadlineMs: lifecycle.stopDeadlineMs ?? 0,
		reason,
	});
}

function workflowCheckpointReason(
	scheduler: WorkflowSchedulerResult,
	signal: AbortSignal | undefined,
): string | undefined {
	if (scheduler.limitReached) return "activation limit reached";
	if (scheduler.frontierNodeIds.length === 0) return undefined;
	if (scheduler.stopReason !== undefined) return scheduler.stopReason;
	if (!signal?.aborted) return undefined;
	const reason: unknown = signal.reason;
	if (reason instanceof Error) return reason.message;
	if (typeof reason === "string" && reason.length > 0) return reason;
	if (reason !== undefined && reason !== null) return String(reason);
	return "workflow stopped";
}

function failedWorkflowFrontierNodeIds(scheduler: WorkflowSchedulerResult): string[] {
	const seen = new Set<string>();
	const nodeIds: string[] = [];
	for (const activation of scheduler.activations) {
		if (activation.status !== "failed" || seen.has(activation.nodeId)) continue;
		seen.add(activation.nodeId);
		nodeIds.push(activation.nodeId);
	}
	return nodeIds;
}

function lifecycleCheckpointSourceMapping(
	options: WorkflowRunnerOptions,
	frontierNodeIds: string[],
): Record<string, string> {
	const lifecycle = options.lifecycle;
	if (!lifecycle) return identitySourceMapping(frontierNodeIds);
	const family = reconstructWorkflowFamilies(options.host.getBranch()).find(
		candidate => candidate.id === lifecycle.familyId,
	);
	const approvedMappings =
		family?.changeRequests
			.filter(
				request =>
					request.status === "approved" &&
					(request.attemptId === undefined || request.attemptId === lifecycle.attemptId),
			)
			.map(request => request.frontierMapping) ?? [];
	return Object.fromEntries(
		frontierNodeIds.map(nodeId => [
			nodeId,
			approvedMappings.find(mapping => mapping[nodeId] !== undefined)?.[nodeId] ?? nodeId,
		]),
	);
}

function identitySourceMapping(frontierNodeIds: string[]): Record<string, string> {
	return Object.fromEntries(frontierNodeIds.map(nodeId => [nodeId, nodeId]));
}

async function executeAndPersistActivation(
	options: WorkflowRunnerOptions,
	run: WorkflowRunSnapshot,
	activation: WorkflowActivation,
	node: WorkflowNode,
	context: WorkflowSchedulerExecutionContext,
	resourceDir: string | undefined,
): Promise<WorkflowActivationOutput> {
	let started = false;
	let activationCompletionSignal: AbortSignal | undefined;
	try {
		const livenessDiagnostic = diagnoseWorkflowLiveness(options.definition, node, context.completedActivations);
		if (livenessDiagnostic !== undefined) {
			throw new WorkflowRunnerError(livenessDiagnostic.message);
		}
		const resolvedPrompt = await resolvePromptForActivation(options, activation, node, context);
		const input = inputSnapshotFromPrompt(resolvedPrompt);
		appendWorkflowActivationStarted(options.host, run.id, {
			activationId: activation.id,
			nodeId: node.id,
			graphRevisionId: activation.graphRevisionId,
			parentActivationIds: activation.parentActivationIds,
			input,
		});
		appendLifecycleActivationStarted(options, activation, node, input);
		started = true;
		const promptedNode = resolvedPrompt ? { ...node, prompt: resolvedPrompt.value } : node;
		const nodeForExecution = await resolveScriptForExecution(options, promptedNode);
		const modelAudit = nodeRequiresModel(node) ? resolveModelAudit(options, node) : undefined;
		if (modelAudit?.error && nodeRequiresModel(node)) {
			throw new WorkflowRunnerError(modelAudit.error);
		}
		const nodeDeadline = workflowNodeDeadlineSignal(node);
		let rawOutput: WorkflowActivationOutput;
		try {
			const runtimeSignal = workflowNodeRuntimeSignal(context, nodeDeadline.signal);
			const completionSignal = workflowNodeCompletionSignal(context, nodeDeadline.signal);
			activationCompletionSignal = completionSignal;
			const readOnlyWorkspaceBefore = await captureReadOnlyWorkspaceSnapshot(options, node);
			rawOutput = await awaitWorkflowNodeExecution(
				executeWorkflowNode(nodeForExecution, activation, options.runtimeHost, {
					modelOverride: modelOverrideFromAudit(modelAudit),
					signal: runtimeSignal,
					context: {
						state: context.state,
						completedActivations: context.completedActivations,
					},
					resourceDir,
				}),
				completionSignal,
			);
			const postExecutionAbortReason = workflowNodeAbortReason(completionSignal);
			if (isWorkflowFailFastAbortReason(postExecutionAbortReason)) {
				throw new WorkflowRunnerError(postExecutionAbortReason);
			}
			await assertReadOnlyWorkspaceUnchanged(options, node, readOnlyWorkspaceBefore);
		} finally {
			nodeDeadline.dispose();
		}
		const output = validateWorkflowActivationOutput(materializeSingleWriteData(node, rawOutput), {
			allowedWritePaths: node.writes,
			stateSchema: options.definition.stateSchema,
		});
		assertDeclaredWritesWereMaterialized(node, output);
		assertWorkflowOutputAllowsContinuation(node, output);
		if (output.statePatch) {
			appendWorkflowStatePatch(options.host, run.id, {
				patch: output.statePatch,
				reason: `activation ${activation.id}`,
			});
		}
		appendWorkflowActivationCompleted(options.host, run.id, {
			activationId: activation.id,
			output,
			modelAudit,
		});
		appendLifecycleActivationCompleted(options, activation, output);
		return output;
	} catch (error) {
		if (!started) {
			appendWorkflowActivationStarted(options.host, run.id, {
				activationId: activation.id,
				nodeId: node.id,
				graphRevisionId: activation.graphRevisionId,
				parentActivationIds: activation.parentActivationIds,
			});
			appendLifecycleActivationStarted(options, activation, node);
		}
		const message = error instanceof Error ? error.message : String(error);
		const abortReason =
			workflowNodeAbortReason(activationCompletionSignal ?? workflowNodeCompletionSignal(context, undefined)) ??
			workflowNodeAbortedErrorReason(error);
		if (abortReason !== undefined) {
			appendWorkflowActivationAborted(options.host, run.id, {
				activationId: activation.id,
				reason: abortReason,
			});
			appendLifecycleActivationAborted(options, activation, node, abortReason);
			throw new WorkflowNodeAbortedError(abortReason);
		}
		appendWorkflowActivationFailed(options.host, run.id, {
			activationId: activation.id,
			error: message,
		});
		appendLifecycleActivationFailed(options, activation, message);
		throw error;
	}
}

async function captureReadOnlyWorkspaceSnapshot(
	options: WorkflowRunnerOptions,
	node: WorkflowNode,
): Promise<WorkflowCheckpointWorkspaceSnapshot | undefined> {
	if (node.workspaceAccess !== "read") return undefined;
	return captureWorkflowCheckpointWorkspace(options.workspaceRoot, {
		ignoredDirtyPathPrefixes: workflowRuntimeScratchDirtyPathPrefixes(options.workspaceRoot),
	});
}

async function assertReadOnlyWorkspaceUnchanged(
	options: WorkflowRunnerOptions,
	node: WorkflowNode,
	before: WorkflowCheckpointWorkspaceSnapshot | undefined,
): Promise<void> {
	if (node.workspaceAccess !== "read") return;
	const after = await captureWorkflowCheckpointWorkspace(options.workspaceRoot, {
		ignoredDirtyPathPrefixes: workflowRuntimeScratchDirtyPathPrefixes(options.workspaceRoot),
	});
	assertWorkflowWorkspaceSnapshotUnchanged(before, after, node.id);
}

interface WorkflowNodeDeadlineSignal {
	signal?: AbortSignal;
	dispose: () => void;
}

function workflowNodeDeadlineSignal(node: WorkflowNode): WorkflowNodeDeadlineSignal {
	const timeoutMs = node.timeoutMs;
	if (timeoutMs === undefined) return { dispose: () => {} };
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(workflowNodeTimeoutReason(node, timeoutMs)), timeoutMs);
	return {
		signal: controller.signal,
		dispose: () => clearTimeout(timeout),
	};
}

function workflowNodeTimeoutReason(node: WorkflowNode, timeoutMs: number): string {
	return `workflow node "${node.id}" timed out after ${timeoutMs}ms`;
}

function workflowNodeRuntimeSignal(
	context: WorkflowSchedulerExecutionContext,
	nodeDeadlineSignal: AbortSignal | undefined,
): AbortSignal | undefined {
	return combineAbortSignals([context.nodeAbortSignal, nodeDeadlineSignal, context.signal]);
}

function workflowNodeCompletionSignal(
	context: WorkflowSchedulerExecutionContext,
	nodeDeadlineSignal: AbortSignal | undefined,
): AbortSignal | undefined {
	const nodeSignal = combineAbortSignals([context.nodeAbortSignal, nodeDeadlineSignal]);
	if (nodeSignal === undefined) return context.signal;
	if (context.signal === undefined) return nodeSignal;
	return combineNodeCompletionAbortSignals(nodeSignal, context.signal);
}

function combineNodeCompletionAbortSignals(nodeSignal: AbortSignal, schedulerSignal: AbortSignal): AbortSignal {
	const controller = new AbortController();
	const abortFromNode = (): void => {
		if (!controller.signal.aborted) controller.abort(nodeSignal.reason);
	};
	const abortFromScheduler = (): void => {
		const reason = workflowNodeAbortReason(schedulerSignal);
		if (isWorkflowFailFastAbortReason(reason) && !controller.signal.aborted) {
			controller.abort(reason);
		}
	};
	if (nodeSignal.aborted) abortFromNode();
	if (schedulerSignal.aborted) abortFromScheduler();
	nodeSignal.addEventListener("abort", abortFromNode, { once: true });
	schedulerSignal.addEventListener("abort", abortFromScheduler, { once: true });
	return controller.signal;
}

function awaitWorkflowNodeExecution<T>(operation: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (signal === undefined) return operation;
	const { promise, resolve, reject } = Promise.withResolvers<T>();
	let settled = false;
	let abortTimer: NodeJS.Timeout | undefined;
	const settle = (fn: () => void): void => {
		if (settled) return;
		settled = true;
		if (abortTimer !== undefined) {
			clearTimeout(abortTimer);
			abortTimer = undefined;
		}
		signal.removeEventListener("abort", onAbort);
		fn();
	};
	const rejectWithAbortReason = (): void => {
		const reason = workflowNodeAbortReason(signal) ?? "workflow activation aborted";
		settle(() => reject(new WorkflowRunnerError(reason)));
	};
	const onAbort = (): void => {
		if (shouldWaitForWorkflowNodeAfterAbort(signal)) return;
		if (abortTimer !== undefined) return;
		abortTimer = setTimeout(rejectWithAbortReason, 0);
	};
	signal.addEventListener("abort", onAbort, { once: true });
	operation.then(
		output => {
			if (isWorkflowFailFastAbortReason(workflowNodeAbortReason(signal))) {
				rejectWithAbortReason();
				return;
			}
			settle(() => resolve(output));
		},
		error => {
			if (isWorkflowFailFastAbortReason(workflowNodeAbortReason(signal))) {
				rejectWithAbortReason();
				return;
			}
			settle(() => reject(error));
		},
	);
	if (signal.aborted) onAbort();
	return promise;
}

function shouldWaitForWorkflowNodeAfterAbort(signal: AbortSignal): boolean {
	return isWorkflowFailFastAbortReason(workflowNodeAbortReason(signal));
}

function isWorkflowFailFastAbortReason(reason: string | undefined): reason is string {
	return reason?.startsWith("workflow activation ") === true && reason.includes(" failed:");
}

function materializeSingleWriteData(node: WorkflowNode, output: WorkflowActivationOutput): WorkflowActivationOutput {
	if (output.statePatch !== undefined) return output;
	const writePath = node.writes?.length === 1 ? node.writes[0] : undefined;
	if (writePath === undefined || !hasStructuredWorkflowData(output.data)) return output;
	return {
		...output,
		statePatch: [{ op: "set", path: writePath, value: output.data }],
	};
}

function hasStructuredWorkflowData(data: Record<string, unknown> | undefined): data is Record<string, unknown> {
	if (data === undefined) return false;
	return Object.keys(data).some(key => !WORKFLOW_RUNTIME_DATA_KEYS.has(key));
}

const WORKFLOW_RUNTIME_DATA_KEYS = new Set([
	"exitCode",
	"summaryTruncated",
	"summaryBytes",
	"agentId",
	"outputPath",
	"sessionFile",
	"patchPath",
	"branchName",
	"changesApplied",
	"retryHistory",
]);

function assertDeclaredWritesWereMaterialized(node: WorkflowNode, output: WorkflowActivationOutput): void {
	if (node.writes === undefined || node.writes.length === 0) return;
	if (node.type === "script") return;
	if ((output.statePatch?.length ?? 0) > 0) return;
	throw new WorkflowRunnerError(
		`workflow node "${node.id}" declared state writes but produced no workflow state patch`,
	);
}

function assertWorkflowOutputAllowsContinuation(node: WorkflowNode, output: WorkflowActivationOutput): void {
	const status = workflowOutputStatus(output);
	if (status === undefined || !workflowOutputStatusIsFailClosed(status)) return;
	const reason = workflowOutputFailureReason(output);
	const suffix = reason === undefined ? "" : `: ${reason}`;
	throw new WorkflowRunnerError(
		`workflow node "${node.id}" returned terminal fail-closed status "${status}"${suffix}`,
	);
}

function workflowOutputStatus(output: WorkflowActivationOutput): string | undefined {
	const status = output.data?.status;
	return typeof status === "string" && status.trim().length > 0 ? status.trim() : undefined;
}

function workflowOutputStatusIsFailClosed(status: string): boolean {
	return /(^|[^a-z0-9])fail[_-]?closed([^a-z0-9]|$)/u.test(status.toLowerCase());
}

function workflowOutputFailureReason(output: WorkflowActivationOutput): string | undefined {
	if (output.data !== undefined) {
		for (const key of ["blocker", "reason", "error", "message"]) {
			const value = output.data[key];
			if (typeof value === "string" && value.trim().length > 0) return value.trim();
		}
	}
	return output.summary;
}

function appendLifecycleActivationStarted(
	options: WorkflowRunnerOptions,
	activation: WorkflowActivation,
	node: WorkflowNode,
	input?: WorkflowActivationInputSnapshot,
): void {
	const lifecycle = options.lifecycle;
	if (!lifecycle) return;
	const startOptions: AppendWorkflowAttemptActivationStartedOptions = {
		attemptId: lifecycle.attemptId,
		activationId: activation.id,
		nodeId: node.id,
		parentActivationIds: activation.parentActivationIds,
	};
	if (input !== undefined) startOptions.input = input;
	appendWorkflowAttemptActivationStarted(options.host, startOptions);
}

function appendLifecycleActivationCompleted(
	options: WorkflowRunnerOptions,
	activation: WorkflowActivation,
	output: WorkflowActivationOutput,
): void {
	const lifecycle = options.lifecycle;
	if (!lifecycle) return;
	appendWorkflowAttemptActivationCompleted(options.host, {
		attemptId: lifecycle.attemptId,
		activationId: activation.id,
		output,
	});
}

function appendLifecycleActivationAborted(
	options: WorkflowRunnerOptions,
	activation: WorkflowActivation,
	node: WorkflowNode,
	reason: string | undefined,
): void {
	const lifecycle = options.lifecycle;
	if (!lifecycle) return;
	appendWorkflowAttemptActivationAborted(options.host, {
		attemptId: lifecycle.attemptId,
		activationId: activation.id,
		nodeId: node.id,
		reason: reason ?? "workflow activation aborted",
	});
}

function appendLifecycleActivationFailed(
	options: WorkflowRunnerOptions,
	activation: WorkflowActivation,
	error: string,
): void {
	const lifecycle = options.lifecycle;
	if (!lifecycle) return;
	appendWorkflowAttemptActivationFailed(options.host, {
		attemptId: lifecycle.attemptId,
		activationId: activation.id,
		error,
	});
}

function modelOverrideFromAudit(modelAudit: WorkflowModelResolutionAudit | undefined): string | undefined {
	if (!modelAudit?.resolvedModel) return undefined;
	if (modelAudit.explicitThinkingLevel && modelAudit.thinkingLevel) {
		return `${modelAudit.resolvedModel}:${modelAudit.thinkingLevel}`;
	}
	return modelAudit.resolvedModel;
}

function workflowNodeAbortReason(signal: AbortSignal | undefined): string | undefined {
	if (!signal?.aborted) return undefined;
	const reason: unknown = signal.reason;
	if (reason instanceof Error) return reason.message;
	if (typeof reason === "string" && reason.length > 0) return reason;
	if (reason !== undefined && reason !== null) return String(reason);
	return "workflow activation aborted";
}

async function resolvePromptForActivation(
	options: WorkflowRunnerOptions,
	activation: WorkflowActivation,
	node: WorkflowNode,
	context: WorkflowSchedulerExecutionContext,
): Promise<WorkflowResolvedPrompt | undefined> {
	if (!nodeConsumesPrompt(node)) return undefined;
	return resolveWorkflowPrompt(node, {
		state: context.state,
		completedActivations: context.completedActivations,
		parentActivationIds: activation.parentActivationIds,
		packageRoot: options.packageRoot,
		maxPromptBytes: options.maxPromptBytes,
		frozenResources: workflowFrozenResources(options),
	});
}

function inputSnapshotFromPrompt(
	resolvedPrompt: WorkflowResolvedPrompt | undefined,
): WorkflowActivationInputSnapshot | undefined {
	return resolvedPrompt ? { prompt: resolvedPrompt } : undefined;
}

function resolveModelAudit(
	options: WorkflowRunnerOptions,
	node: WorkflowNode,
): WorkflowModelResolutionAudit | undefined {
	const modelResolution = options.modelResolution;
	if (!modelResolution) return undefined;
	return resolveWorkflowNodeModel(options.definition, node, {
		availableModels: modelResolution.availableModels,
		settings: modelResolution.settings,
		matchPreferences: modelResolution.matchPreferences,
		modelRegistry: modelResolution.modelRegistry,
		parentActiveModelPattern: modelResolution.parentActiveModelPattern,
		agentModel: resolveAgentModelPattern(modelResolution, node),
	}).audit;
}

function resolveAgentModelPattern(
	modelResolution: WorkflowRunnerModelResolutionOptions,
	node: WorkflowNode,
): string | string[] | undefined {
	if (!node.agent) return undefined;
	return modelResolution.agentModels?.[node.agent] ?? modelResolution.agentModels?.[node.id];
}

async function resolveScriptForExecution(options: WorkflowRunnerOptions, node: WorkflowNode): Promise<WorkflowNode> {
	if (node.type !== "script" || !node.script?.file) return node;
	if (!options.packageRoot) {
		throw new WorkflowRunnerError(`workflow script file for node "${node.id}" requires a workflow package root`);
	}
	const root = path.resolve(options.packageRoot);
	const resolved = path.resolve(root, node.script.file);
	const relative = path.relative(root, resolved);
	if (relative.startsWith("..") || path.isAbsolute(relative)) {
		throw new WorkflowRunnerError(`workflow script file for node "${node.id}" escapes the package root`);
	}
	const snapshot = findFrozenResourceSnapshot(workflowFrozenResources(options), relative);
	if (snapshot) {
		return {
			...node,
			script: {
				...node.script,
				code: snapshot.text,
			},
		};
	}
	if (workflowFrozenResources(options)) {
		throw new WorkflowRunnerError(
			`workflow script file for node "${node.id}" was not captured in the workflow freeze: ${node.script.file}`,
		);
	}
	try {
		const code = await Bun.file(resolved).text();
		return {
			...node,
			script: {
				...node.script,
				code,
			},
		};
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new WorkflowRunnerError(`workflow script file for node "${node.id}" is not readable: ${reason}`);
	}
}

function nodeRequiresModel(node: WorkflowNode): boolean {
	return node.type === "agent" || node.type === "review" || node.model !== undefined;
}

function nodeConsumesPrompt(node: WorkflowNode): boolean {
	return node.type === "agent" || node.type === "review" || node.type === "human";
}

function workflowFrozenResources(options: WorkflowRunnerOptions): FlowFreezeResourceSnapshot[] | undefined {
	return options.frozenResources ?? options.lifecycle?.freeze.resourceSnapshots;
}

async function materializeWorkflowResources(
	snapshots: FlowFreezeResourceSnapshot[] | undefined,
	tempRoot: string,
): Promise<string | undefined> {
	if (!snapshots?.length) return undefined;
	await fs.mkdir(tempRoot, { recursive: true });
	const root = await fs.mkdtemp(path.join(tempRoot, "omp-workflow-resources-"));
	try {
		for (const snapshot of snapshots) {
			await Bun.write(resolveMaterializedResourcePath(root, snapshot.path), snapshot.text);
		}
		return root;
	} catch (error) {
		await removeMaterializedWorkflowResources(root);
		throw error;
	}
}

async function removeMaterializedWorkflowResources(resourceDir: string | undefined): Promise<void> {
	if (resourceDir === undefined) return;
	await fs.rm(resourceDir, { recursive: true, force: true });
}

function resolveMaterializedResourcePath(root: string, resourcePath: string): string {
	if (path.isAbsolute(resourcePath)) {
		throw new WorkflowRunnerError(`workflow frozen resource path escapes the resource root: ${resourcePath}`);
	}
	const resolved = path.resolve(root, resourcePath);
	const relative = path.relative(root, resolved);
	if (relative.startsWith("..") || path.isAbsolute(relative)) {
		throw new WorkflowRunnerError(`workflow frozen resource path escapes the resource root: ${resourcePath}`);
	}
	return resolved;
}

function workflowResourceTempRoot(explicitRoot: string | undefined, workspaceRoot: string | undefined): string {
	if (explicitRoot !== undefined) return explicitRoot;
	return selectWorkflowResourceTempRoot(
		os.tmpdir(),
		workspaceRoot ?? process.cwd(),
		path.join(getWorkflowMonitorCacheDir(), "resources"),
	);
}

export function selectWorkflowResourceTempRoot(
	candidateRoot: string,
	workflowCwd: string,
	fallbackRoot: string,
): string {
	const candidate = path.resolve(candidateRoot);
	const cwd = path.resolve(workflowCwd);
	return pathIsInsideOrSame(candidate, cwd) ? fallbackRoot : candidate;
}

function pathIsInsideOrSame(candidate: string, root: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function findFrozenResourceSnapshot(
	snapshots: FlowFreezeResourceSnapshot[] | undefined,
	relativePath: string,
): FlowFreezeResourceSnapshot | undefined {
	if (!snapshots) return undefined;
	const normalized = relativePath.split(path.sep).join("/");
	return snapshots.find(snapshot => snapshot.path === normalized);
}
