import type { CustomEntry, SessionEntry } from "../session/session-entries";
import type { WorkflowDefinition } from "./definition";
import type { FlowFreeze } from "./freeze";
import type { WorkflowModelResolutionAudit } from "./model-resolution";
import type { WorkflowGraphPatchOperation } from "./patches";
import type { WorkflowActivationInputSnapshot } from "./prompt-source";
import type { WorkflowActivationOutput } from "./state";

export const WORKFLOW_LIFECYCLE_EVENT_TYPE = "workflow-lifecycle-event";

export interface WorkflowLifecycleStoreHost {
	appendCustomEntry(customType: string, data?: unknown): string;
	getBranch(): WorkflowLifecycleBranchEntry[];
}

export type WorkflowLifecycleBranchEntry = Pick<CustomEntry, "type" | "customType" | "data"> | SessionEntry;

export class WorkflowLifecycleError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WorkflowLifecycleError";
	}
}

export type WorkflowAttemptStatus = "running" | "stop_requested" | "stopped" | "completed" | "failed";
export type WorkflowAttemptActivationStatus = "running" | "completed" | "failed" | "aborted";

export interface RuntimeBindingSnapshot {
	id: string;
	requestedRoles: Record<string, string>;
	resolvedModels: Record<string, string>;
	modelBindings?: Record<string, WorkflowModelResolutionAudit>;
	tools: string[];
	agents: string[];
	plugins?: string[];
	extensions?: string[];
	skills?: string[];
	unavailable: string[];
	warnings: string[];
}

export interface WorkflowRunFamilySnapshot {
	id: string;
	objective?: string;
	freezes: FlowFreeze[];
	attempts: WorkflowRunAttemptSnapshot[];
	checkpoints: WorkflowCheckpointSnapshot[];
	changeRequests: WorkflowChangeRequestRecord[];
}

export interface WorkflowRunAttemptSnapshot {
	id: string;
	familyId: string;
	freezeId: string;
	startNodeId: string;
	startNodeIds?: string[];
	status: WorkflowAttemptStatus;
	runtimeBindingSnapshot: RuntimeBindingSnapshot;
	checkpointId?: string;
	stop?: WorkflowStopRecord;
	activations: WorkflowAttemptActivationRecord[];
	summary?: string;
	error?: string;
}

export interface WorkflowStopRecord {
	deadlineMs: number;
	reason?: string;
}

export interface WorkflowAttemptActivationRecord {
	id: string;
	nodeId: string;
	parentActivationIds: string[];
	status: WorkflowAttemptActivationStatus;
	input?: WorkflowActivationInputSnapshot;
	output?: WorkflowActivationOutput;
	error?: string;
	reason?: string;
}

export interface WorkflowCheckpointSnapshot {
	id: string;
	familyId: string;
	attemptId: string;
	completedActivationIds: string[];
	abortedActivationIds: string[];
	frontierNodeIds: string[];
	state: Record<string, unknown>;
	sourceMapping: Record<string, string>;
	workspace?: WorkflowCheckpointWorkspaceSnapshot;
}

export type WorkflowCheckpointWorkspaceStatus = "clean" | "dirty" | "unavailable";

export interface WorkflowCheckpointWorkspaceSnapshot {
	kind: "git" | "unknown";
	status: WorkflowCheckpointWorkspaceStatus;
	digest: string;
	dirtyPaths: string[];
	statusText?: string;
	error?: string;
}

export type WorkflowChangeRequestOrigin =
	| "internal-agent"
	| "supervisor"
	| "human"
	| "slash-command"
	| "test"
	| "external-api";

export interface WorkflowChangeRequestRecord {
	id: string;
	familyId: string;
	attemptId?: string;
	checkpointId?: string;
	status: "proposed" | "approved" | "rejected";
	actor: string;
	origin: WorkflowChangeRequestOrigin;
	reason: string;
	operations: WorkflowGraphPatchOperation[];
	frontierMapping: Record<string, string>;
	approvedBy?: string;
	approvalReason?: string;
	rejectedBy?: string;
	rejectionReason?: string;
	applications: WorkflowChangeRequestApplicationRecord[];
}

export type WorkflowChangeRequestApplicationTarget = "draft" | "freeze";

export interface WorkflowChangeRequestApplicationRecord {
	target: WorkflowChangeRequestApplicationTarget;
	actor: string;
	reason?: string;
	freezeId?: string;
	draftId?: string;
}

export interface StartWorkflowFamilyOptions {
	familyId: string;
	objective?: string;
}

export interface RecordWorkflowFreezeOptions {
	familyId?: string;
}

export interface StartWorkflowAttemptOptions {
	familyId: string;
	attemptId: string;
	freezeId: string;
	startNodeId: string;
	startNodeIds?: string[];
	runtimeBindingSnapshot: RuntimeBindingSnapshot;
}

export interface RestartWorkflowAttemptOptions extends StartWorkflowAttemptOptions {
	checkpointId: string;
}

export interface AppendWorkflowAttemptActivationStartedOptions {
	attemptId: string;
	activationId: string;
	nodeId: string;
	parentActivationIds: string[];
	input?: WorkflowActivationInputSnapshot;
}

export interface AppendWorkflowAttemptActivationCompletedOptions {
	attemptId: string;
	activationId: string;
	output?: WorkflowActivationOutput;
}

export interface AppendWorkflowAttemptActivationFailedOptions {
	attemptId: string;
	activationId: string;
	error: string;
}

export interface AppendWorkflowAttemptActivationAbortedOptions {
	attemptId: string;
	activationId: string;
	nodeId: string;
	reason: string;
}

export interface ProposeWorkflowChangeRequestOptions {
	changeRequestId: string;
	familyId: string;
	attemptId?: string;
	checkpointId?: string;
	actor: string;
	origin: WorkflowChangeRequestOrigin;
	reason: string;
	operations: WorkflowGraphPatchOperation[];
	frontierMapping?: Record<string, string>;
}

export interface ApproveWorkflowChangeRequestOptions {
	changeRequestId: string;
	actor: string;
	reason?: string;
}

export interface RejectWorkflowChangeRequestOptions {
	changeRequestId: string;
	actor: string;
	reason?: string;
}

export interface RecordWorkflowChangeRequestAppliedOptions {
	changeRequestId: string;
	actor: string;
	target: WorkflowChangeRequestApplicationTarget;
	reason?: string;
	freezeId?: string;
	draftId?: string;
}

export interface RequestWorkflowAttemptStopOptions {
	attemptId: string;
	deadlineMs: number;
	reason?: string;
}

export interface CreateWorkflowCheckpointOptions {
	checkpointId: string;
	familyId: string;
	attemptId: string;
	completedActivationIds: string[];
	abortedActivationIds: string[];
	frontierNodeIds: string[];
	state: Record<string, unknown>;
	sourceMapping: Record<string, string>;
	workspace?: WorkflowCheckpointWorkspaceSnapshot;
}

export interface CompleteWorkflowAttemptOptions {
	attemptId: string;
	summary?: string;
}

export interface FailWorkflowAttemptOptions {
	attemptId: string;
	error: string;
}

type WorkflowLifecycleEvent =
	| WorkflowFamilyCreatedEvent
	| WorkflowFreezeRecordedEvent
	| WorkflowAttemptStartedEvent
	| WorkflowAttemptRestartedEvent
	| WorkflowRuntimeBindingSnapshotCreatedEvent
	| WorkflowActivationStartedEvent
	| WorkflowActivationCompletedEvent
	| WorkflowActivationFailedEvent
	| WorkflowActivationAbortedEvent
	| WorkflowChangeRequestProposedEvent
	| WorkflowChangeRequestApprovedEvent
	| WorkflowChangeRequestRejectedEvent
	| WorkflowChangeRequestAppliedEvent
	| WorkflowStopRequestedEvent
	| WorkflowCheckpointCreatedEvent
	| WorkflowAttemptCompletedEvent
	| WorkflowAttemptFailedEvent;

interface WorkflowFamilyCreatedEvent {
	event: "family_created";
	familyId: string;
	objective?: string;
}

interface WorkflowFreezeRecordedEvent {
	event: "flow_frozen";
	familyId?: string;
	freeze: FlowFreeze;
}

interface WorkflowAttemptStartedEvent {
	event: "attempt_started";
	familyId: string;
	attemptId: string;
	freezeId: string;
	startNodeId: string;
	startNodeIds?: string[];
}

interface WorkflowAttemptRestartedEvent {
	event: "attempt_restarted_from_checkpoint";
	familyId: string;
	attemptId: string;
	checkpointId: string;
	freezeId: string;
	startNodeId: string;
	startNodeIds?: string[];
}

interface WorkflowRuntimeBindingSnapshotCreatedEvent {
	event: "runtime_binding_snapshot_created";
	attemptId: string;
	snapshot: RuntimeBindingSnapshot;
}

interface WorkflowActivationStartedEvent {
	event: "activation_started";
	attemptId: string;
	activationId: string;
	nodeId: string;
	parentActivationIds: string[];
	input?: WorkflowActivationInputSnapshot;
}

interface WorkflowActivationCompletedEvent {
	event: "activation_completed";
	attemptId: string;
	activationId: string;
	output?: WorkflowActivationOutput;
}

interface WorkflowActivationFailedEvent {
	event: "activation_failed";
	attemptId: string;
	activationId: string;
	error: string;
}

interface WorkflowActivationAbortedEvent {
	event: "activation_aborted";
	attemptId: string;
	activationId: string;
	nodeId: string;
	reason: string;
}

interface WorkflowChangeRequestProposedEvent {
	event: "change_request_proposed";
	request: WorkflowChangeRequestRecord;
}

interface WorkflowChangeRequestApprovedEvent {
	event: "change_request_approved";
	changeRequestId: string;
	actor: string;
	reason?: string;
}

interface WorkflowChangeRequestRejectedEvent {
	event: "change_request_rejected";
	changeRequestId: string;
	actor: string;
	reason?: string;
}

interface WorkflowChangeRequestAppliedEvent {
	event: "change_request_applied";
	changeRequestId: string;
	application: WorkflowChangeRequestApplicationRecord;
}

interface WorkflowStopRequestedEvent {
	event: "stop_requested";
	attemptId: string;
	deadlineMs: number;
	reason?: string;
}

interface WorkflowCheckpointCreatedEvent {
	event: "checkpoint_created";
	checkpoint: WorkflowCheckpointSnapshot;
}

interface WorkflowAttemptCompletedEvent {
	event: "attempt_completed";
	attemptId: string;
	summary?: string;
}

interface WorkflowAttemptFailedEvent {
	event: "attempt_failed";
	attemptId: string;
	error: string;
}

export function startWorkflowFamily(
	host: WorkflowLifecycleStoreHost,
	options: StartWorkflowFamilyOptions,
): WorkflowRunFamilySnapshot {
	const event: WorkflowFamilyCreatedEvent = {
		event: "family_created",
		familyId: options.familyId,
	};
	if (options.objective !== undefined) event.objective = options.objective;
	appendLifecycleEvent(host, event);
	return {
		id: options.familyId,
		objective: options.objective,
		freezes: [],
		attempts: [],
		checkpoints: [],
		changeRequests: [],
	};
}

export function recordWorkflowFreeze(
	host: WorkflowLifecycleStoreHost,
	freeze: FlowFreeze,
	options: RecordWorkflowFreezeOptions = {},
): FlowFreeze {
	const event: WorkflowFreezeRecordedEvent = { event: "flow_frozen", freeze: clone(freeze) };
	if (options.familyId !== undefined) event.familyId = options.familyId;
	appendLifecycleEvent(host, event);
	return freeze;
}

export function startWorkflowAttempt(
	host: WorkflowLifecycleStoreHost,
	options: StartWorkflowAttemptOptions,
): WorkflowRunAttemptSnapshot {
	assertWorkflowAttemptIdAvailable(host, options.attemptId);
	const event: WorkflowAttemptStartedEvent = {
		event: "attempt_started",
		familyId: options.familyId,
		attemptId: options.attemptId,
		freezeId: options.freezeId,
		startNodeId: options.startNodeId,
	};
	if (options.startNodeIds !== undefined) event.startNodeIds = [...options.startNodeIds];
	appendLifecycleEvent(host, event);
	appendRuntimeBindingSnapshot(host, options.attemptId, options.runtimeBindingSnapshot);
	const attempt: WorkflowRunAttemptSnapshot = {
		id: options.attemptId,
		familyId: options.familyId,
		freezeId: options.freezeId,
		startNodeId: options.startNodeId,
		status: "running",
		runtimeBindingSnapshot: clone(options.runtimeBindingSnapshot),
		activations: [],
	};
	if (options.startNodeIds !== undefined) attempt.startNodeIds = [...options.startNodeIds];
	return attempt;
}

export function restartWorkflowAttempt(
	host: WorkflowLifecycleStoreHost,
	options: RestartWorkflowAttemptOptions,
): WorkflowRunAttemptSnapshot {
	assertWorkflowAttemptIdAvailable(host, options.attemptId);
	assertWorkflowRestartAllowed(host, options);
	const event: WorkflowAttemptRestartedEvent = {
		event: "attempt_restarted_from_checkpoint",
		familyId: options.familyId,
		attemptId: options.attemptId,
		checkpointId: options.checkpointId,
		freezeId: options.freezeId,
		startNodeId: options.startNodeId,
	};
	if (options.startNodeIds !== undefined) event.startNodeIds = [...options.startNodeIds];
	appendLifecycleEvent(host, event);
	appendRuntimeBindingSnapshot(host, options.attemptId, options.runtimeBindingSnapshot);
	const attempt: WorkflowRunAttemptSnapshot = {
		id: options.attemptId,
		familyId: options.familyId,
		freezeId: options.freezeId,
		startNodeId: options.startNodeId,
		checkpointId: options.checkpointId,
		status: "running",
		runtimeBindingSnapshot: clone(options.runtimeBindingSnapshot),
		activations: [],
	};
	if (options.startNodeIds !== undefined) attempt.startNodeIds = [...options.startNodeIds];
	return attempt;
}

function assertWorkflowAttemptIdAvailable(host: WorkflowLifecycleStoreHost, attemptId: string): void {
	const existing = reconstructWorkflowFamilies(host.getBranch()).some(family =>
		family.attempts.some(attempt => attempt.id === attemptId),
	);
	if (existing) throw new Error(`Workflow attempt already exists: ${attemptId}`);
}

export function appendWorkflowAttemptActivationStarted(
	host: WorkflowLifecycleStoreHost,
	options: AppendWorkflowAttemptActivationStartedOptions,
): void {
	const event: WorkflowActivationStartedEvent = {
		event: "activation_started",
		attemptId: options.attemptId,
		activationId: options.activationId,
		nodeId: options.nodeId,
		parentActivationIds: [...options.parentActivationIds],
	};
	if (options.input !== undefined) event.input = clone(options.input);
	appendLifecycleEvent(host, event);
}

export function appendWorkflowAttemptActivationCompleted(
	host: WorkflowLifecycleStoreHost,
	options: AppendWorkflowAttemptActivationCompletedOptions,
): void {
	const event: WorkflowActivationCompletedEvent = {
		event: "activation_completed",
		attemptId: options.attemptId,
		activationId: options.activationId,
	};
	if (options.output !== undefined) event.output = clone(options.output);
	appendLifecycleEvent(host, event);
}

export function appendWorkflowAttemptActivationFailed(
	host: WorkflowLifecycleStoreHost,
	options: AppendWorkflowAttemptActivationFailedOptions,
): void {
	appendLifecycleEvent(host, {
		event: "activation_failed",
		attemptId: options.attemptId,
		activationId: options.activationId,
		error: options.error,
	});
}

export function appendWorkflowAttemptActivationAborted(
	host: WorkflowLifecycleStoreHost,
	options: AppendWorkflowAttemptActivationAbortedOptions,
): void {
	appendLifecycleEvent(host, {
		event: "activation_aborted",
		attemptId: options.attemptId,
		activationId: options.activationId,
		nodeId: options.nodeId,
		reason: options.reason,
	});
}

export function proposeWorkflowChangeRequest(
	host: WorkflowLifecycleStoreHost,
	options: ProposeWorkflowChangeRequestOptions,
): WorkflowChangeRequestRecord {
	const family = expectWorkflowFamily(host, options.familyId);
	const existing = family.changeRequests.find(request => request.id === options.changeRequestId);
	if (existing !== undefined) {
		if (workflowChangeRequestProposalMatches(existing, options)) return existing;
		throw new WorkflowLifecycleError(`Workflow change request id already exists: ${options.changeRequestId}`);
	}
	const proposalDenial = workflowChangeProposalDenial(family, options);
	if (proposalDenial !== undefined) throw new WorkflowLifecycleError(proposalDenial);
	const request: WorkflowChangeRequestRecord = {
		id: options.changeRequestId,
		familyId: options.familyId,
		status: "proposed",
		actor: options.actor,
		origin: options.origin,
		reason: options.reason,
		operations: clone(options.operations),
		frontierMapping: clone(options.frontierMapping ?? {}),
		applications: [],
	};
	if (options.attemptId !== undefined) request.attemptId = options.attemptId;
	if (options.checkpointId !== undefined) request.checkpointId = options.checkpointId;
	appendLifecycleEvent(host, { event: "change_request_proposed", request: clone(request) });
	return request;
}

export function approveWorkflowChangeRequest(
	host: WorkflowLifecycleStoreHost,
	options: ApproveWorkflowChangeRequestOptions,
): void {
	const { family, request } = expectWorkflowChangeRequest(host, options.changeRequestId);
	if (request.status !== "proposed") {
		throw new WorkflowLifecycleError(`Workflow change request cannot be approved: ${request.id} (${request.status})`);
	}
	const approvalDenial = workflowChangeApprovalDenial(family, request, options.actor);
	if (approvalDenial !== undefined) throw new WorkflowLifecycleError(approvalDenial);
	const event: WorkflowChangeRequestApprovedEvent = {
		event: "change_request_approved",
		changeRequestId: options.changeRequestId,
		actor: options.actor,
	};
	if (options.reason !== undefined) event.reason = options.reason;
	appendLifecycleEvent(host, event);
}

export function rejectWorkflowChangeRequest(
	host: WorkflowLifecycleStoreHost,
	options: RejectWorkflowChangeRequestOptions,
): void {
	const { request } = expectWorkflowChangeRequest(host, options.changeRequestId);
	if (request.status !== "proposed") {
		throw new WorkflowLifecycleError(`Workflow change request cannot be rejected: ${request.id} (${request.status})`);
	}
	const event: WorkflowChangeRequestRejectedEvent = {
		event: "change_request_rejected",
		changeRequestId: options.changeRequestId,
		actor: options.actor,
	};
	if (options.reason !== undefined) event.reason = options.reason;
	appendLifecycleEvent(host, event);
}

export function recordWorkflowChangeRequestApplied(
	host: WorkflowLifecycleStoreHost,
	options: RecordWorkflowChangeRequestAppliedOptions,
): WorkflowChangeRequestApplicationRecord {
	const { family, request } = expectWorkflowChangeRequest(host, options.changeRequestId);
	if (request.status !== "approved") {
		throw new WorkflowLifecycleError(`Workflow change request is not approved: ${request.id} (${request.status})`);
	}
	const applicationError = workflowChangeApplicationError(family, request);
	if (applicationError !== undefined) throw new WorkflowLifecycleError(applicationError);
	if (options.target === "freeze") {
		if (options.freezeId === undefined) {
			throw new WorkflowLifecycleError(
				`Workflow change request freeze application requires a freeze id: ${request.id}`,
			);
		}
		const targetFreeze = family.freezes.find(freeze => freeze.id === options.freezeId);
		if (targetFreeze === undefined) {
			throw new WorkflowLifecycleError(
				`Workflow freeze not found for change request ${request.id}: ${options.freezeId}`,
			);
		}
		const freezeError = workflowChangeFreezeApplicationError(request, targetFreeze);
		if (freezeError !== undefined) throw new WorkflowLifecycleError(freezeError);
	}
	const application: WorkflowChangeRequestApplicationRecord = {
		target: options.target,
		actor: options.actor,
	};
	if (options.reason !== undefined) application.reason = options.reason;
	if (options.freezeId !== undefined) application.freezeId = options.freezeId;
	if (options.draftId !== undefined) application.draftId = options.draftId;
	appendLifecycleEvent(host, {
		event: "change_request_applied",
		changeRequestId: options.changeRequestId,
		application: clone(application),
	});
	return application;
}

export function requestWorkflowAttemptStop(
	host: WorkflowLifecycleStoreHost,
	options: RequestWorkflowAttemptStopOptions,
): void {
	const { attempt } = expectWorkflowAttempt(host, options.attemptId, "stop");
	if (attempt.status !== "running") {
		throw new WorkflowLifecycleError(`Workflow attempt cannot be stopped: ${attempt.id} (${attempt.status})`);
	}
	const event: WorkflowStopRequestedEvent = {
		event: "stop_requested",
		attemptId: options.attemptId,
		deadlineMs: options.deadlineMs,
	};
	if (options.reason !== undefined) event.reason = options.reason;
	appendLifecycleEvent(host, event);
}

export function createWorkflowCheckpoint(
	host: WorkflowLifecycleStoreHost,
	options: CreateWorkflowCheckpointOptions,
): WorkflowCheckpointSnapshot {
	const family = expectWorkflowFamily(host, options.familyId);
	const attempt = family.attempts.find(candidate => candidate.id === options.attemptId);
	if (attempt === undefined) {
		const attemptFamily = findWorkflowAttempt(host, options.attemptId)?.family;
		if (attemptFamily !== undefined) {
			throw new WorkflowLifecycleError(
				`Workflow checkpoint attempt ${options.attemptId} does not belong to family ${options.familyId}`,
			);
		}
		throw new WorkflowLifecycleError(`Workflow checkpoint attempt not found: ${options.attemptId}`);
	}
	if (attempt.status !== "stop_requested" && attempt.status !== "stopped" && attempt.status !== "failed") {
		throw new WorkflowLifecycleError(
			`Workflow checkpoint requires a stopped or failed attempt before saving: ${attempt.id} (${attempt.status})`,
		);
	}
	const runningActivations = attempt.activations
		.filter(activation => activation.status === "running")
		.map(activation => activation.id);
	if (runningActivations.length > 0) {
		throw new WorkflowLifecycleError(
			`Workflow checkpoint attempt still has running activations: ${runningActivations.join(", ")}`,
		);
	}
	validateWorkflowCheckpointActivations(attempt, options.completedActivationIds, "completed");
	validateWorkflowCheckpointActivations(attempt, options.abortedActivationIds, "aborted");
	const checkpoint: WorkflowCheckpointSnapshot = {
		id: options.checkpointId,
		familyId: options.familyId,
		attemptId: options.attemptId,
		completedActivationIds: [...options.completedActivationIds],
		abortedActivationIds: [...options.abortedActivationIds],
		frontierNodeIds: [...options.frontierNodeIds],
		state: clone(options.state),
		sourceMapping: clone(options.sourceMapping),
	};
	if (options.workspace !== undefined) checkpoint.workspace = clone(options.workspace);
	appendLifecycleEvent(host, { event: "checkpoint_created", checkpoint: clone(checkpoint) });
	return checkpoint;
}

function validateWorkflowCheckpointActivations(
	attempt: WorkflowRunAttemptSnapshot,
	activationIds: string[],
	status: "completed" | "aborted",
): void {
	for (const activationId of activationIds) {
		const activation = attempt.activations.find(candidate => candidate.id === activationId);
		if (activation === undefined) {
			throw new WorkflowLifecycleError(
				`Workflow checkpoint references unknown ${status} activation: ${activationId}`,
			);
		}
		if (activation.status !== status) {
			throw new WorkflowLifecycleError(
				`Workflow checkpoint references ${status} activation with status ${activation.status}: ${activationId}`,
			);
		}
	}
}

export function completeWorkflowAttempt(
	host: WorkflowLifecycleStoreHost,
	options: CompleteWorkflowAttemptOptions,
): void {
	assertWorkflowAttemptTerminalTransitionAllowed(host, options.attemptId, "completed");
	const event: WorkflowAttemptCompletedEvent = {
		event: "attempt_completed",
		attemptId: options.attemptId,
	};
	if (options.summary !== undefined) event.summary = options.summary;
	appendLifecycleEvent(host, event);
}

export function failWorkflowAttempt(host: WorkflowLifecycleStoreHost, options: FailWorkflowAttemptOptions): void {
	assertWorkflowAttemptTerminalTransitionAllowed(host, options.attemptId, "failed");
	appendLifecycleEvent(host, {
		event: "attempt_failed",
		attemptId: options.attemptId,
		error: options.error,
	});
}

export function workflowChangeApprovalDenial(
	family: WorkflowRunFamilySnapshot,
	request: WorkflowChangeRequestRecord,
	actor: string,
): string | undefined {
	const policy = workflowChangePolicy(family, request);
	if (isHumanWorkflowActor(actor)) {
		return policy.humansCanApprove
			? undefined
			: `Workflow change request approval denied: ${actor} requires changePolicy.humansCanApprove`;
	}
	if (isSupervisorWorkflowActor(actor)) {
		return policy.supervisorsCanApprove === true
			? undefined
			: `Workflow change request approval denied: ${actor} requires changePolicy.supervisorsCanApprove`;
	}
	return `Workflow change request approval denied: ${actor} requires human approval or authorized supervisor policy`;
}

export function workflowChangeProposalDenial(
	family: WorkflowRunFamilySnapshot,
	request: ProposeWorkflowChangeRequestOptions,
): string | undefined {
	const policy = workflowChangePolicy(family, request);
	if (request.origin === "internal-agent" && !policy.agentsCanPropose) {
		return `Workflow change request proposal denied: ${request.actor} requires changePolicy.agentsCanPropose`;
	}
	return undefined;
}

export function workflowChangeApplicationError(
	family: WorkflowRunFamilySnapshot,
	request: WorkflowChangeRequestRecord,
): string | undefined {
	if (request.checkpointId !== undefined) {
		const checkpoint = family.checkpoints.find(candidate => candidate.id === request.checkpointId);
		if (checkpoint === undefined) return `Workflow change request checkpoint not found: ${request.checkpointId}`;
	}
	const sourceFreeze = workflowFreezeForChangeTarget(family, request);
	if (sourceFreeze !== undefined) {
		const branchDispositionError = workflowChangeBranchDispositionError(request, sourceFreeze);
		if (branchDispositionError !== undefined) return branchDispositionError;
	}
	if (request.attemptId === undefined) {
		if (request.checkpointId !== undefined) return undefined;
		const activeAttempt = family.attempts.find(
			attempt => attempt.status === "running" || attempt.status === "stop_requested",
		);
		if (activeAttempt !== undefined) {
			return `Workflow change request cannot be applied while family has an active attempt: ${activeAttempt.id} (${activeAttempt.status})`;
		}
		return undefined;
	}
	const attempt = family.attempts.find(candidate => candidate.id === request.attemptId);
	const attemptCheckpoints = family.checkpoints.filter(checkpoint => checkpoint.attemptId === request.attemptId);
	if (attemptCheckpoints.length === 0) {
		return `Workflow change request cannot be applied before checkpointing attempt: ${request.attemptId}`;
	}
	if (attempt !== undefined && attempt.status !== "stopped" && attempt.status !== "failed") {
		return `Workflow change request cannot be applied before stopping attempt: ${attempt.id} (${attempt.status})`;
	}
	return undefined;
}

export function workflowChangeFreezeApplicationError(
	request: WorkflowChangeRequestRecord,
	freeze: FlowFreeze,
): string | undefined {
	const nodeIds = new Set(freeze.definition.nodes.map(node => node.id));
	const edges = freeze.definition.edges;
	const modelRoles = freeze.definition.models.roles ?? {};
	for (const operation of request.operations) {
		if (operation.op === "add_node" && !nodeIds.has(operation.node.id)) {
			return `Workflow change request cannot be applied to freeze ${freeze.id}: added node missing from freeze: ${operation.node.id}`;
		}
		if (operation.op === "remove_node" && nodeIds.has(operation.nodeId)) {
			return `Workflow change request cannot be applied to freeze ${freeze.id}: removed node still exists in freeze: ${operation.nodeId}`;
		}
		if (operation.op === "add_edge" && !workflowDefinitionHasEdge(edges, operation.edge.from, operation.edge.to)) {
			return `Workflow change request cannot be applied to freeze ${freeze.id}: added edge missing from freeze: ${operation.edge.from} -> ${operation.edge.to}`;
		}
		if (operation.op === "remove_edge" && workflowDefinitionHasEdge(edges, operation.from, operation.to)) {
			return `Workflow change request cannot be applied to freeze ${freeze.id}: removed edge still exists in freeze: ${operation.from} -> ${operation.to}`;
		}
		if (operation.op === "replace_edge_condition") {
			const edge = edges.find(candidate => candidate.from === operation.from && candidate.to === operation.to);
			if (edge === undefined) {
				return `Workflow change request cannot be applied to freeze ${freeze.id}: changed edge missing from freeze: ${operation.from} -> ${operation.to}`;
			}
			const condition = edge.condition?.source;
			if (condition !== operation.condition) {
				return `Workflow change request cannot be applied to freeze ${freeze.id}: edge condition mismatch for ${operation.from} -> ${operation.to}`;
			}
		}
		if (operation.op === "replace_node_prompt_source") {
			const node = freeze.definition.nodes.find(candidate => candidate.id === operation.nodeId);
			if (!node || !workflowJsonEqual(node.promptSource, operation.promptSource)) {
				return `Workflow change request cannot be applied to freeze ${freeze.id}: prompt source mismatch for node: ${operation.nodeId}`;
			}
		}
		if (operation.op === "replace_node_model") {
			const node = freeze.definition.nodes.find(candidate => candidate.id === operation.nodeId);
			if (!node || !workflowJsonEqual(node.model, operation.model)) {
				return `Workflow change request cannot be applied to freeze ${freeze.id}: model mismatch for node: ${operation.nodeId}`;
			}
		}
		if (operation.op === "replace_node_permissions") {
			const node = freeze.definition.nodes.find(candidate => candidate.id === operation.nodeId);
			if (
				!node ||
				!workflowJsonEqual(node.reads ?? [], operation.reads ?? []) ||
				!workflowJsonEqual(node.writes ?? [], operation.writes ?? [])
			) {
				return `Workflow change request cannot be applied to freeze ${freeze.id}: permissions mismatch for node: ${operation.nodeId}`;
			}
		}
		if (operation.op === "set_model_role" && modelRoles[operation.role] !== operation.selector) {
			return `Workflow change request cannot be applied to freeze ${freeze.id}: model role mismatch for role: ${operation.role}`;
		}
	}
	for (const targetNodeId of Object.values(request.frontierMapping)) {
		if (!nodeIds.has(targetNodeId)) {
			return `Workflow change request cannot be applied to freeze ${freeze.id}: frontier target missing from freeze: ${targetNodeId}`;
		}
	}
	return undefined;
}

function workflowChangeBranchDispositionError(
	request: WorkflowChangeRequestRecord,
	sourceFreeze: FlowFreeze,
): string | undefined {
	const nodeIds = new Set(sourceFreeze.definition.nodes.map(node => node.id));
	for (const operation of request.operations) {
		if (operation.op === "abandon_branch" && !nodeIds.has(operation.nodeId)) {
			return `Workflow change request branch disposition references missing source node: ${operation.nodeId}`;
		}
		if (operation.op === "rollback_branch") {
			if (!nodeIds.has(operation.nodeId)) {
				return `Workflow change request branch disposition references missing source node: ${operation.nodeId}`;
			}
			if (!nodeIds.has(operation.targetNodeId)) {
				return `Workflow change request branch rollback references missing target node: ${operation.targetNodeId}`;
			}
		}
	}
	return undefined;
}

export function workflowFreezeForChangeTarget(
	family: WorkflowRunFamilySnapshot,
	target: WorkflowChangePolicyTarget,
): FlowFreeze | undefined {
	if (target.attemptId !== undefined) {
		const attemptFreeze = workflowFreezeForAttempt(family, target.attemptId);
		if (attemptFreeze !== undefined) return attemptFreeze;
	}
	if (target.checkpointId !== undefined) {
		const checkpoint = family.checkpoints.find(candidate => candidate.id === target.checkpointId);
		if (checkpoint !== undefined) {
			const checkpointFreeze = workflowFreezeForAttempt(family, checkpoint.attemptId);
			if (checkpointFreeze !== undefined) return checkpointFreeze;
		}
	}
	return family.freezes.at(-1);
}

interface WorkflowChangePolicyTarget {
	attemptId?: string;
	checkpointId?: string;
}

function assertWorkflowRestartAllowed(host: WorkflowLifecycleStoreHost, options: RestartWorkflowAttemptOptions): void {
	const family = expectWorkflowFamily(host, options.familyId);
	const checkpoint = family.checkpoints.find(candidate => candidate.id === options.checkpointId);
	if (checkpoint === undefined) {
		throw new WorkflowLifecycleError(`Workflow checkpoint not found for restart: ${options.checkpointId}`);
	}
	if (checkpoint.familyId !== options.familyId) {
		throw new WorkflowLifecycleError(
			`Workflow checkpoint ${options.checkpointId} does not belong to family ${options.familyId}`,
		);
	}
	const checkpointAttempt = family.attempts.find(attempt => attempt.id === checkpoint.attemptId);
	if (checkpointAttempt === undefined) {
		throw new WorkflowLifecycleError(`Workflow checkpoint attempt not found for restart: ${checkpoint.attemptId}`);
	}
	if (checkpointAttempt.status !== "stopped" && checkpointAttempt.status !== "failed") {
		throw new WorkflowLifecycleError(
			`Workflow checkpoint attempt is not stopped or failed for restart: ${checkpointAttempt.id} (${checkpointAttempt.status})`,
		);
	}
	const freeze = family.freezes.find(candidate => candidate.id === options.freezeId);
	if (freeze === undefined)
		throw new WorkflowLifecycleError(`Workflow freeze not found for restart: ${options.freezeId}`);
	const startNodeIds = resolveWorkflowRestartStartNodeIds(family, checkpoint, freeze);
	if (options.freezeId === checkpointAttempt.freezeId) {
		assertWorkflowRestartStartNodeIds(options, startNodeIds);
		return;
	}
	const applied = family.changeRequests.some(
		request =>
			request.status === "approved" &&
			(request.checkpointId === undefined || request.checkpointId === checkpoint.id) &&
			(request.attemptId === undefined || request.attemptId === checkpoint.attemptId) &&
			request.applications.some(
				application => application.target === "freeze" && application.freezeId === options.freezeId,
			),
	);
	if (!applied) {
		throw new WorkflowLifecycleError(
			`Workflow restart freeze is not applied to checkpoint ${options.checkpointId}: ${options.freezeId}`,
		);
	}
	assertWorkflowRestartStartNodeIds(options, startNodeIds);
}

export function resolveWorkflowRestartStartNodeIds(
	family: WorkflowRunFamilySnapshot,
	checkpoint: WorkflowCheckpointSnapshot,
	freeze: FlowFreeze,
): string[] {
	const nodeIds = new Set(freeze.definition.nodes.map(node => node.id));
	const frontierMappings = [
		...approvedCheckpointFrontierMappings(family, checkpoint, freeze.id),
		...migrationFrontierMappings(freeze.definition),
	];
	const startNodeIds: string[] = [];
	for (const frontierNodeId of checkpoint.frontierNodeIds) {
		for (const mapped of restartFrontierCandidates(frontierNodeId, checkpoint, frontierMappings)) {
			if (nodeIds.has(mapped)) {
				pushUnique(startNodeIds, mapped);
				break;
			}
		}
	}
	assertWorkflowRestartJoinReadiness(family, checkpoint, freeze, startNodeIds);
	return startNodeIds;
}

function assertWorkflowRestartJoinReadiness(
	family: WorkflowRunFamilySnapshot,
	checkpoint: WorkflowCheckpointSnapshot,
	freeze: FlowFreeze,
	startNodeIds: string[],
): void {
	const nodesById = new Map(freeze.definition.nodes.map(node => [node.id, node]));
	const completedNodeIds = checkpointCompletedNodeIds(family, checkpoint);
	for (const nodeId of startNodeIds) {
		const node = nodesById.get(nodeId);
		if (node?.waitFor === undefined || node.waitFor.length === 0) continue;
		const missing = node.waitFor.filter(waitForNodeId => !completedNodeIds.has(waitForNodeId));
		if (missing.length === 0) continue;
		throw new WorkflowLifecycleError(
			`Workflow restart frontier node "${nodeId}" requires checkpoint frontier siblings: ${missing.join(", ")}`,
		);
	}
}

function checkpointCompletedNodeIds(
	family: WorkflowRunFamilySnapshot,
	checkpoint: WorkflowCheckpointSnapshot,
): Set<string> {
	const completedActivationIds = new Set(checkpoint.completedActivationIds);
	const attempt = family.attempts.find(candidate => candidate.id === checkpoint.attemptId);
	const nodeIds = new Set<string>();
	for (const activation of attempt?.activations ?? []) {
		if (activation.status === "completed" && completedActivationIds.has(activation.id)) {
			nodeIds.add(activation.nodeId);
		}
	}
	return nodeIds;
}

function assertWorkflowRestartStartNodeIds(options: RestartWorkflowAttemptOptions, startNodeIds: string[]): void {
	if (startNodeIds.length === 0) {
		throw new WorkflowLifecycleError(`Workflow checkpoint has no restartable frontier: ${options.checkpointId}`);
	}
	const requestedStartNodeIds = requestedWorkflowRestartStartNodeIds(options);
	const allowed = new Set(startNodeIds);
	for (const nodeId of requestedStartNodeIds) {
		if (!allowed.has(nodeId)) {
			throw new WorkflowLifecycleError(
				`Workflow restart start node "${nodeId}" is not reachable from checkpoint frontier: ${startNodeIds.join(", ")}`,
			);
		}
	}
	const requested = new Set(requestedStartNodeIds);
	const missing = startNodeIds.filter(nodeId => !requested.has(nodeId));
	if (missing.length > 0) {
		throw new WorkflowLifecycleError(
			`Workflow restart is missing checkpoint frontier start node: ${missing.join(", ")}`,
		);
	}
}

function requestedWorkflowRestartStartNodeIds(options: RestartWorkflowAttemptOptions): string[] {
	const startNodeIds: string[] = [];
	pushUnique(startNodeIds, options.startNodeId);
	for (const nodeId of options.startNodeIds ?? []) pushUnique(startNodeIds, nodeId);
	return startNodeIds;
}

function migrationFrontierMappings(definition: WorkflowDefinition): Array<Record<string, string>> {
	return definition.migrations?.map(migration => migration.frontierMapping) ?? [];
}

function approvedCheckpointFrontierMappings(
	family: WorkflowRunFamilySnapshot,
	checkpoint: WorkflowCheckpointSnapshot,
	freezeId: string,
): Array<Record<string, string>> {
	return family.changeRequests
		.filter(
			request =>
				request.status === "approved" &&
				(request.checkpointId === undefined || request.checkpointId === checkpoint.id) &&
				(request.attemptId === undefined || request.attemptId === checkpoint.attemptId) &&
				request.applications.some(
					application => application.target === "freeze" && application.freezeId === freezeId,
				),
		)
		.map(request => request.frontierMapping);
}

function restartFrontierCandidates(
	frontierNodeId: string,
	checkpoint: WorkflowCheckpointSnapshot,
	approvedMappings: Array<Record<string, string>>,
): string[] {
	const candidates: string[] = [];
	for (const mapping of approvedMappings) {
		const mapped = mapping[frontierNodeId];
		if (mapped !== undefined) candidates.push(mapped);
	}
	const savedMapping = checkpoint.sourceMapping[frontierNodeId];
	if (savedMapping !== undefined) candidates.push(savedMapping);
	candidates.push(frontierNodeId);
	return candidates;
}

function pushUnique(values: string[], value: string): void {
	if (!values.includes(value)) values.push(value);
}

function assertWorkflowAttemptTerminalTransitionAllowed(
	host: WorkflowLifecycleStoreHost,
	attemptId: string,
	targetStatus: "completed" | "failed",
): void {
	const { attempt } = expectWorkflowAttempt(host, attemptId, targetStatus);
	if (attempt.status === "completed" || attempt.status === "failed" || attempt.status === "stopped") {
		throw new WorkflowLifecycleError(
			`Workflow attempt cannot enter ${targetStatus} from terminal state: ${attempt.id} (${attempt.status})`,
		);
	}
	const runningActivationIds = attempt.activations
		.filter(activation => activation.status === "running")
		.map(activation => activation.id);
	if (runningActivationIds.length > 0) {
		throw new WorkflowLifecycleError(
			`Workflow attempt cannot enter ${targetStatus} while activations are running: ${attempt.id} (${runningActivationIds.join(", ")})`,
		);
	}
}

function expectWorkflowFamily(host: WorkflowLifecycleStoreHost, familyId: string): WorkflowRunFamilySnapshot {
	const family = reconstructWorkflowFamilies(host.getBranch()).find(candidate => candidate.id === familyId);
	if (family === undefined) throw new WorkflowLifecycleError(`Workflow family not found: ${familyId}`);
	return family;
}

function expectWorkflowAttempt(
	host: WorkflowLifecycleStoreHost,
	attemptId: string,
	action: string,
): { family: WorkflowRunFamilySnapshot; attempt: WorkflowRunAttemptSnapshot } {
	const found = findWorkflowAttempt(host, attemptId);
	if (found === undefined) throw new WorkflowLifecycleError(`Workflow attempt not found for ${action}: ${attemptId}`);
	return found;
}

function findWorkflowAttempt(
	host: WorkflowLifecycleStoreHost,
	attemptId: string,
): { family: WorkflowRunFamilySnapshot; attempt: WorkflowRunAttemptSnapshot } | undefined {
	for (const family of reconstructWorkflowFamilies(host.getBranch())) {
		const attempt = family.attempts.find(candidate => candidate.id === attemptId);
		if (attempt !== undefined) return { family, attempt };
	}
	return undefined;
}

function expectWorkflowChangeRequest(
	host: WorkflowLifecycleStoreHost,
	changeRequestId: string,
): { family: WorkflowRunFamilySnapshot; request: WorkflowChangeRequestRecord } {
	for (const family of reconstructWorkflowFamilies(host.getBranch())) {
		const request = family.changeRequests.find(candidate => candidate.id === changeRequestId);
		if (request !== undefined) return { family, request };
	}
	throw new WorkflowLifecycleError(`Workflow change request not found: ${changeRequestId}`);
}

function workflowChangePolicy(
	family: WorkflowRunFamilySnapshot,
	target: WorkflowChangePolicyTarget,
): NonNullable<FlowFreeze["changePolicy"]> {
	const policy = workflowFreezeForChangeTarget(family, target)?.changePolicy;
	return {
		agentsCanPropose: policy?.agentsCanPropose ?? true,
		humansCanApprove: policy?.humansCanApprove ?? true,
		...(policy?.supervisorsCanApprove !== undefined ? { supervisorsCanApprove: policy.supervisorsCanApprove } : {}),
	};
}

function workflowFreezeForAttempt(family: WorkflowRunFamilySnapshot, attemptId: string): FlowFreeze | undefined {
	const attempt = family.attempts.find(candidate => candidate.id === attemptId);
	if (attempt === undefined) return undefined;
	return family.freezes.find(candidate => candidate.id === attempt.freezeId);
}

function isHumanWorkflowActor(actor: string): boolean {
	return actor === "human" || actor.startsWith("human:");
}

function isSupervisorWorkflowActor(actor: string): boolean {
	return actor === "supervisor" || actor.startsWith("supervisor:");
}

function workflowChangeRequestProposalMatches(
	record: WorkflowChangeRequestRecord,
	proposal: WorkflowChangeRequestRecord | ProposeWorkflowChangeRequestOptions,
): boolean {
	const proposalId = "changeRequestId" in proposal ? proposal.changeRequestId : proposal.id;
	const proposalFrontierMapping =
		"changeRequestId" in proposal ? (proposal.frontierMapping ?? {}) : proposal.frontierMapping;
	return (
		record.id === proposalId &&
		record.familyId === proposal.familyId &&
		record.attemptId === proposal.attemptId &&
		record.checkpointId === proposal.checkpointId &&
		record.actor === proposal.actor &&
		record.origin === proposal.origin &&
		record.reason === proposal.reason &&
		workflowJsonEqual(record.operations, proposal.operations) &&
		workflowJsonEqual(record.frontierMapping, proposalFrontierMapping)
	);
}

function workflowDefinitionHasEdge(edges: WorkflowDefinition["edges"], from: string, to: string): boolean {
	return edges.some(edge => edge.from === from && edge.to === to);
}

function workflowJsonEqual(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

export function reconstructWorkflowFamilies(entries: WorkflowLifecycleBranchEntry[]): WorkflowRunFamilySnapshot[] {
	const families = new Map<string, WorkflowRunFamilySnapshot>();
	const attempts = new Map<string, WorkflowRunAttemptSnapshot>();
	const changeRequests = new Map<string, WorkflowChangeRequestRecord>();
	let currentFamilyId: string | undefined;

	for (const entry of entries) {
		const event = lifecycleEventFromEntry(entry);
		if (!event) continue;
		if (event.event === "family_created") {
			const existing = families.get(event.familyId);
			if (existing) {
				if (existing.objective === undefined && event.objective !== undefined) existing.objective = event.objective;
				currentFamilyId = event.familyId;
				continue;
			}
			const family: WorkflowRunFamilySnapshot = {
				id: event.familyId,
				objective: event.objective,
				freezes: [],
				attempts: [],
				checkpoints: [],
				changeRequests: [],
			};
			families.set(event.familyId, family);
			currentFamilyId = event.familyId;
			continue;
		}
		if (event.event === "flow_frozen") {
			const familyId = event.familyId ?? currentFamilyId;
			const family = familyId ? families.get(familyId) : undefined;
			if (family && !family.freezes.some(freeze => freeze.id === event.freeze.id)) {
				family.freezes.push(clone(event.freeze));
			}
			continue;
		}
		if (event.event === "attempt_started" || event.event === "attempt_restarted_from_checkpoint") {
			const family = families.get(event.familyId);
			if (!family) continue;
			const attempt: WorkflowRunAttemptSnapshot = {
				id: event.attemptId,
				familyId: event.familyId,
				freezeId: event.freezeId,
				startNodeId: event.startNodeId,
				status: "running",
				runtimeBindingSnapshot: emptyRuntimeBindingSnapshot(event.attemptId),
				activations: [],
			};
			if (event.startNodeIds !== undefined) attempt.startNodeIds = [...event.startNodeIds];
			if (event.event === "attempt_restarted_from_checkpoint") {
				attempt.checkpointId = event.checkpointId;
			}
			attempts.set(event.attemptId, attempt);
			family.attempts.push(attempt);
			currentFamilyId = event.familyId;
			continue;
		}
		if (event.event === "runtime_binding_snapshot_created") {
			const attempt = attempts.get(event.attemptId);
			if (attempt) attempt.runtimeBindingSnapshot = clone(event.snapshot);
			continue;
		}
		if (event.event === "activation_started") {
			const attempt = attempts.get(event.attemptId);
			if (!attempt) continue;
			attempt.activations.push({
				id: event.activationId,
				nodeId: event.nodeId,
				parentActivationIds: [...event.parentActivationIds],
				status: "running",
				...(event.input !== undefined ? { input: clone(event.input) } : {}),
			});
			continue;
		}
		if (event.event === "activation_completed") {
			const activation = findActivation(attempts, event.attemptId, event.activationId);
			if (!activation) continue;
			activation.status = "completed";
			if (event.output !== undefined) activation.output = clone(event.output);
			delete activation.error;
			continue;
		}
		if (event.event === "activation_failed") {
			const activation = findActivation(attempts, event.attemptId, event.activationId);
			if (!activation) continue;
			activation.status = "failed";
			activation.error = event.error;
			continue;
		}
		if (event.event === "activation_aborted") {
			const attempt = attempts.get(event.attemptId);
			if (!attempt) continue;
			const existing = attempt.activations.find(activation => activation.id === event.activationId);
			const activation =
				existing ??
				({
					id: event.activationId,
					nodeId: event.nodeId,
					parentActivationIds: [],
					status: "aborted",
				} satisfies WorkflowAttemptActivationRecord);
			activation.status = "aborted";
			activation.reason = event.reason;
			if (!existing) attempt.activations.push(activation);
			continue;
		}
		if (event.event === "change_request_proposed") {
			const family = families.get(event.request.familyId);
			if (!family) continue;
			const request = clone(event.request);
			const existing = changeRequests.get(request.id);
			if (existing !== undefined && workflowChangeRequestProposalMatches(existing, request)) {
				currentFamilyId = event.request.familyId;
				continue;
			}
			changeRequests.set(request.id, request);
			family.changeRequests.push(request);
			currentFamilyId = event.request.familyId;
			continue;
		}
		if (event.event === "change_request_approved" || event.event === "change_request_rejected") {
			const request = changeRequests.get(event.changeRequestId);
			if (!request) continue;
			if (event.event === "change_request_approved") {
				request.status = "approved";
				request.approvedBy = event.actor;
				if (event.reason !== undefined) request.approvalReason = event.reason;
			} else {
				request.status = "rejected";
				request.rejectedBy = event.actor;
				if (event.reason !== undefined) request.rejectionReason = event.reason;
			}
			continue;
		}
		if (event.event === "change_request_applied") {
			const request = changeRequests.get(event.changeRequestId);
			if (!request) continue;
			request.applications.push(clone(event.application));
			continue;
		}
		if (event.event === "stop_requested") {
			const attempt = attempts.get(event.attemptId);
			if (!attempt) continue;
			if (attempt.status === "completed" || attempt.status === "failed" || attempt.status === "stopped") continue;
			attempt.status = "stop_requested";
			attempt.stop = { deadlineMs: event.deadlineMs };
			if (event.reason !== undefined) attempt.stop.reason = event.reason;
			continue;
		}
		if (event.event === "checkpoint_created") {
			const family = families.get(event.checkpoint.familyId);
			if (!family) continue;
			family.checkpoints.push(clone(event.checkpoint));
			const attempt = attempts.get(event.checkpoint.attemptId);
			if (attempt && attempt.status === "stop_requested") attempt.status = "stopped";
			currentFamilyId = event.checkpoint.familyId;
			continue;
		}
		if (event.event === "attempt_completed") {
			const attempt = attempts.get(event.attemptId);
			if (!attempt) continue;
			attempt.status = "completed";
			if (event.summary !== undefined) attempt.summary = event.summary;
			continue;
		}
		if (event.event === "attempt_failed") {
			const attempt = attempts.get(event.attemptId);
			if (!attempt) continue;
			attempt.status = "failed";
			attempt.error = event.error;
		}
	}
	return [...families.values()];
}

export function findRunningWorkflowCheckpointResumeAttempt(
	family: WorkflowRunFamilySnapshot,
	checkpointId: string,
): WorkflowRunAttemptSnapshot | undefined {
	for (let index = family.attempts.length - 1; index >= 0; index -= 1) {
		const attempt = family.attempts[index];
		if (attempt?.status === "running" && attempt.checkpointId === checkpointId) return attempt;
	}
	return undefined;
}

function appendRuntimeBindingSnapshot(
	host: WorkflowLifecycleStoreHost,
	attemptId: string,
	snapshot: RuntimeBindingSnapshot,
): void {
	appendLifecycleEvent(host, {
		event: "runtime_binding_snapshot_created",
		attemptId,
		snapshot: clone(snapshot),
	});
}

function appendLifecycleEvent(host: WorkflowLifecycleStoreHost, event: WorkflowLifecycleEvent): void {
	host.appendCustomEntry(WORKFLOW_LIFECYCLE_EVENT_TYPE, event);
}

function lifecycleEventFromEntry(entry: unknown): WorkflowLifecycleEvent | undefined {
	if (!isRecord(entry)) return undefined;
	if (entry.type !== "custom" || entry.customType !== WORKFLOW_LIFECYCLE_EVENT_TYPE) return undefined;
	if (!isRecord(entry.data) || typeof entry.data.event !== "string") return undefined;
	return entry.data as unknown as WorkflowLifecycleEvent;
}

function findActivation(
	attempts: Map<string, WorkflowRunAttemptSnapshot>,
	attemptId: string,
	activationId: string,
): WorkflowAttemptActivationRecord | undefined {
	return attempts.get(attemptId)?.activations.find(activation => activation.id === activationId);
}

function emptyRuntimeBindingSnapshot(attemptId: string): RuntimeBindingSnapshot {
	return {
		id: `${attemptId}:binding`,
		requestedRoles: {},
		resolvedModels: {},
		modelBindings: {},
		tools: [],
		agents: [],
		unavailable: [],
		warnings: [],
	};
}

function clone<T>(value: T): T {
	return structuredClone(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
