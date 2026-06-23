import type { CustomEntry, SessionEntry } from "../session/session-entries";
import type { WorkflowDefinition } from "./definition";
import type { WorkflowModelResolutionAudit } from "./model-resolution";
import type { WorkflowGraphPatchActor, WorkflowGraphPatchOperation, WorkflowGraphPatchPreview } from "./patches";
import type { WorkflowActivationInputSnapshot } from "./prompt-source";
import type { WorkflowMappedActivationContext } from "./scheduler";
import type { WorkflowActivationOutput } from "./state";
import { applyWorkflowStatePatch, type WorkflowStatePatchOperation } from "./state";

export const WORKFLOW_RUN_EVENT_TYPE = "workflow-run-event";

export interface WorkflowRunStoreHost {
	appendCustomEntry(customType: string, data?: unknown): string;
	getBranch(): Array<Pick<CustomEntry, "type" | "customType" | "data"> | SessionEntry>;
}

export interface WorkflowGraphRevision {
	id: string;
	parentId?: string;
	definition: WorkflowDefinition;
	reason?: string;
}

export interface WorkflowRunSnapshot {
	id: string;
	currentGraphRevisionId: string;
	definition: WorkflowDefinition;
	graphRevisions: WorkflowGraphRevision[];
	graphPatchProposals: WorkflowGraphPatchProposalRecord[];
	state: Record<string, unknown>;
	activations: WorkflowActivationRecord[];
}

export interface StartWorkflowRunOptions {
	runId: string;
	graphRevisionId?: string;
}

export interface AppendWorkflowStatePatchOptions {
	patch: WorkflowStatePatchOperation[];
	reason?: string;
}

export interface AppendWorkflowGraphPatchProposedOptions {
	proposalId: string;
	actor: WorkflowGraphPatchActor;
	patch: WorkflowGraphPatchOperation[];
	preview: WorkflowGraphPatchPreview;
	reason?: string;
}
export interface AppendWorkflowActivationStartedOptions {
	activationId: string;
	nodeId: string;
	graphRevisionId: string;
	parentActivationIds: string[];
	input?: WorkflowActivationInputSnapshot;
	mapped?: WorkflowMappedActivationContext;
}

export interface AppendWorkflowActivationCompletedOptions {
	activationId: string;
	output?: WorkflowActivationOutput;
	modelAudit?: WorkflowModelResolutionAudit;
}

export interface AppendWorkflowActivationFailedOptions {
	activationId: string;
	error: string;
}

export interface AppendWorkflowActivationAbortedOptions {
	activationId: string;
	reason: string;
}

export type WorkflowActivationRecordStatus = "running" | "completed" | "failed" | "aborted";

export interface WorkflowActivationRecord {
	id: string;
	nodeId: string;
	graphRevisionId: string;
	parentActivationIds: string[];
	status: WorkflowActivationRecordStatus;
	input?: WorkflowActivationInputSnapshot;
	output?: WorkflowActivationOutput;
	modelAudit?: WorkflowModelResolutionAudit;
	error?: string;
	reason?: string;
	mapped?: WorkflowMappedActivationContext;
}

export interface WorkflowGraphPatchProposalRecord {
	id: string;
	status: "proposed";
	actor: WorkflowGraphPatchActor;
	patch: WorkflowGraphPatchOperation[];
	preview: WorkflowGraphPatchPreview;
	reason?: string;
}

export type WorkflowRunEvent =
	| WorkflowRunStartedEvent
	| WorkflowStatePatchAppliedEvent
	| WorkflowGraphPatchProposedEvent
	| WorkflowActivationStartedEvent
	| WorkflowActivationCompletedEvent
	| WorkflowActivationFailedEvent
	| WorkflowActivationAbortedEvent;

export interface WorkflowRunStartedEvent {
	event: "run_started";
	runId: string;
	graphRevisionId: string;
	definitionSnapshot: WorkflowDefinition;
}

export interface WorkflowStatePatchAppliedEvent {
	event: "state_patch_applied";
	runId: string;
	patch: WorkflowStatePatchOperation[];
	reason?: string;
}

export interface WorkflowGraphPatchProposedEvent {
	event: "graph_patch_proposed";
	runId: string;
	proposalId: string;
	actor: WorkflowGraphPatchActor;
	patch: WorkflowGraphPatchOperation[];
	preview: WorkflowGraphPatchPreview;
	reason?: string;
}

export interface WorkflowActivationStartedEvent {
	event: "activation_started";
	runId: string;
	activationId: string;
	nodeId: string;
	graphRevisionId: string;
	parentActivationIds: string[];
	input?: WorkflowActivationInputSnapshot;
	mapped?: WorkflowMappedActivationContext;
}

export interface WorkflowActivationCompletedEvent {
	event: "activation_completed";
	runId: string;
	activationId: string;
	output?: WorkflowActivationOutput;
	modelAudit?: WorkflowModelResolutionAudit;
}

export interface WorkflowActivationFailedEvent {
	event: "activation_failed";
	runId: string;
	activationId: string;
	error: string;
}

export interface WorkflowActivationAbortedEvent {
	event: "activation_aborted";
	runId: string;
	activationId: string;
	reason: string;
}

export function startWorkflowRun(
	host: WorkflowRunStoreHost,
	definition: WorkflowDefinition,
	options: StartWorkflowRunOptions,
): WorkflowRunSnapshot {
	assertWorkflowRunIdAvailable(host, options.runId);
	const graphRevisionId = options.graphRevisionId ?? `${options.runId}:graph-0`;
	const event: WorkflowRunStartedEvent = {
		event: "run_started",
		runId: options.runId,
		graphRevisionId,
		definitionSnapshot: definition,
	};
	host.appendCustomEntry(WORKFLOW_RUN_EVENT_TYPE, event);
	return {
		id: options.runId,
		currentGraphRevisionId: graphRevisionId,
		definition,
		graphRevisions: [{ id: graphRevisionId, definition }],
		graphPatchProposals: [],
		state: {},
		activations: [],
	};
}

function assertWorkflowRunIdAvailable(host: WorkflowRunStoreHost, runId: string): void {
	const existing = reconstructWorkflowRuns(host.getBranch()).some(run => run.id === runId);
	if (existing) throw new Error(`Workflow run already exists: ${runId}`);
}

export function appendWorkflowStatePatch(
	host: WorkflowRunStoreHost,
	runId: string,
	options: AppendWorkflowStatePatchOptions,
): void {
	const event: WorkflowStatePatchAppliedEvent = {
		event: "state_patch_applied",
		runId,
		patch: options.patch,
	};
	if (options.reason !== undefined) event.reason = options.reason;
	host.appendCustomEntry(WORKFLOW_RUN_EVENT_TYPE, event);
}

export function appendWorkflowGraphPatchProposed(
	host: WorkflowRunStoreHost,
	runId: string,
	options: AppendWorkflowGraphPatchProposedOptions,
): void {
	const event: WorkflowGraphPatchProposedEvent = {
		event: "graph_patch_proposed",
		runId,
		proposalId: options.proposalId,
		actor: options.actor,
		patch: options.patch,
		preview: options.preview,
	};
	if (options.reason !== undefined) event.reason = options.reason;
	host.appendCustomEntry(WORKFLOW_RUN_EVENT_TYPE, event);
}

export function appendWorkflowActivationStarted(
	host: WorkflowRunStoreHost,
	runId: string,
	options: AppendWorkflowActivationStartedOptions,
): void {
	const event: WorkflowActivationStartedEvent = {
		event: "activation_started",
		runId,
		activationId: options.activationId,
		nodeId: options.nodeId,
		graphRevisionId: options.graphRevisionId,
		parentActivationIds: options.parentActivationIds,
	};
	if (options.input !== undefined) event.input = options.input;
	if (options.mapped !== undefined) event.mapped = options.mapped;
	host.appendCustomEntry(WORKFLOW_RUN_EVENT_TYPE, event);
}

export function appendWorkflowActivationCompleted(
	host: WorkflowRunStoreHost,
	runId: string,
	options: AppendWorkflowActivationCompletedOptions,
): void {
	const event: WorkflowActivationCompletedEvent = {
		event: "activation_completed",
		runId,
		activationId: options.activationId,
	};
	if (options.output !== undefined) event.output = options.output;
	if (options.modelAudit !== undefined) event.modelAudit = options.modelAudit;
	host.appendCustomEntry(WORKFLOW_RUN_EVENT_TYPE, event);
}

export function appendWorkflowActivationFailed(
	host: WorkflowRunStoreHost,
	runId: string,
	options: AppendWorkflowActivationFailedOptions,
): void {
	const event: WorkflowActivationFailedEvent = {
		event: "activation_failed",
		runId,
		activationId: options.activationId,
		error: options.error,
	};
	host.appendCustomEntry(WORKFLOW_RUN_EVENT_TYPE, event);
}

export function appendWorkflowActivationAborted(
	host: WorkflowRunStoreHost,
	runId: string,
	options: AppendWorkflowActivationAbortedOptions,
): void {
	const event: WorkflowActivationAbortedEvent = {
		event: "activation_aborted",
		runId,
		activationId: options.activationId,
		reason: options.reason,
	};
	host.appendCustomEntry(WORKFLOW_RUN_EVENT_TYPE, event);
}

export function reconstructWorkflowRuns(
	entries: WorkflowRunStoreHost["getBranch"] extends () => infer T ? T : never,
): WorkflowRunSnapshot[] {
	const runs = new Map<string, WorkflowRunSnapshot>();
	for (const entry of entries) {
		const event = workflowEventFromEntry(entry);
		if (!event) continue;
		if (event.event === "run_started") {
			runs.set(event.runId, {
				id: event.runId,
				currentGraphRevisionId: event.graphRevisionId,
				definition: event.definitionSnapshot,
				graphRevisions: [{ id: event.graphRevisionId, definition: event.definitionSnapshot }],
				graphPatchProposals: [],
				state: {},
				activations: [],
			});
			continue;
		}
		const run = runs.get(event.runId);
		if (!run) continue;
		if (event.event === "state_patch_applied") {
			applyWorkflowStatePatch(run.state, event.patch, { stateSchema: run.definition.stateSchema });
			continue;
		}
		if (event.event === "graph_patch_proposed") {
			// Active-run graph patch proposals are legacy audit noise. Production mutations use
			// lifecycle WorkflowChangeRequest records tied to freezes/checkpoints instead.
			continue;
		}
		if (event.event === "activation_started") {
			const activation: WorkflowActivationRecord = {
				id: event.activationId,
				nodeId: event.nodeId,
				graphRevisionId: event.graphRevisionId,
				parentActivationIds: event.parentActivationIds,
				status: "running",
			};
			if (event.input !== undefined) activation.input = event.input;
			if (event.mapped !== undefined) activation.mapped = event.mapped;
			run.activations.push(activation);
			continue;
		}
		if (event.event === "activation_completed") {
			const activation = run.activations.find(record => record.id === event.activationId);
			if (!activation) continue;
			activation.status = "completed";
			if (event.output !== undefined) activation.output = event.output;
			if (event.modelAudit !== undefined) activation.modelAudit = event.modelAudit;
			delete activation.error;
			continue;
		}
		if (event.event === "activation_failed") {
			const activation = run.activations.find(record => record.id === event.activationId);
			if (!activation) continue;
			activation.status = "failed";
			activation.error = event.error;
			delete activation.reason;
			continue;
		}
		if (event.event === "activation_aborted") {
			const activation = run.activations.find(record => record.id === event.activationId);
			if (!activation) continue;
			activation.status = "aborted";
			activation.reason = event.reason;
			delete activation.error;
		}
	}
	return [...runs.values()];
}

function workflowEventFromEntry(entry: unknown): WorkflowRunEvent | undefined {
	if (!isRecord(entry)) return undefined;
	if (entry.type !== "custom" || entry.customType !== WORKFLOW_RUN_EVENT_TYPE) return undefined;
	return isWorkflowRunEvent(entry.data) ? entry.data : undefined;
}

function isWorkflowRunEvent(value: unknown): value is WorkflowRunEvent {
	if (!isRecord(value)) return false;
	if (
		value.event !== "run_started" &&
		value.event !== "state_patch_applied" &&
		value.event !== "graph_patch_proposed" &&
		value.event !== "activation_started" &&
		value.event !== "activation_completed" &&
		value.event !== "activation_failed" &&
		value.event !== "activation_aborted"
	) {
		return false;
	}
	if (typeof value.runId !== "string") return false;
	if (value.event === "state_patch_applied") {
		return Array.isArray(value.patch);
	}
	if (value.event === "graph_patch_proposed") {
		return (
			typeof value.proposalId === "string" &&
			isWorkflowGraphPatchActor(value.actor) &&
			Array.isArray(value.patch) &&
			isRecord(value.preview)
		);
	}
	if (value.event === "activation_started") {
		return (
			typeof value.activationId === "string" &&
			typeof value.nodeId === "string" &&
			typeof value.graphRevisionId === "string" &&
			Array.isArray(value.parentActivationIds)
		);
	}
	if (value.event === "activation_completed") {
		return typeof value.activationId === "string";
	}
	if (value.event === "activation_failed") {
		return typeof value.activationId === "string" && typeof value.error === "string";
	}
	if (value.event === "activation_aborted") {
		return typeof value.activationId === "string" && typeof value.reason === "string";
	}
	if (typeof value.graphRevisionId !== "string") return false;
	return isRecord(value.definitionSnapshot);
}

function isWorkflowGraphPatchActor(value: unknown): value is WorkflowGraphPatchActor {
	return value === "agent" || value === "supervisor" || value === "human";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
