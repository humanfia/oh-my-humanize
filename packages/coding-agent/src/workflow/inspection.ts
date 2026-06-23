import type { WorkflowNodeType } from "./definition";
import type {
	RuntimeBindingSnapshot,
	WorkflowAttemptActivationRecord,
	WorkflowAttemptActivationStatus,
	WorkflowAttemptStatus,
	WorkflowChangeRequestApplicationRecord,
	WorkflowChangeRequestRecord,
	WorkflowCheckpointSnapshot,
	WorkflowRunAttemptSnapshot,
	WorkflowRunFamilySnapshot,
} from "./lifecycle";
import type { WorkflowResolvedPrompt } from "./prompt-source";
import type { WorkflowActivationRecord, WorkflowGraphPatchProposalRecord, WorkflowRunSnapshot } from "./run-store";

export interface WorkflowInspection {
	runId: string;
	currentGraphRevisionId: string;
	graph: WorkflowInspectionGraph;
	state: Record<string, unknown>;
	graphRevisions: WorkflowInspectionGraphRevision[];
	pendingGraphPatchProposals: WorkflowInspectionGraphPatchProposal[];
	activations: WorkflowInspectionActivation[];
	modelAssignments: WorkflowInspectionModelAssignment[];
}

export interface WorkflowLifecycleInspection {
	familyId: string;
	objective?: string;
	freezeIds: string[];
	attempts: WorkflowLifecycleInspectionAttempt[];
	checkpoints: WorkflowLifecycleInspectionCheckpoint[];
	changeRequests: WorkflowLifecycleInspectionChangeRequest[];
}

export interface WorkflowLifecycleInspectionAttempt {
	id: string;
	freezeId: string;
	startNodeId: string;
	startNodeIds?: string[];
	status: WorkflowAttemptStatus;
	checkpointId?: string;
	runtimeBindingSnapshot: RuntimeBindingSnapshot;
	activationCounts: Record<string, number>;
	activations: WorkflowLifecycleInspectionActivation[];
	summary?: string;
	error?: string;
}

export interface WorkflowLifecycleInspectionActivation {
	id: string;
	nodeId: string;
	parentActivationIds: string[];
	status: WorkflowAttemptActivationStatus;
	mapped?: {
		poolId: string;
		itemKey: string;
		phase: "worker" | "verifier" | "reducer";
	};
	summary?: string;
	artifacts?: string[];
	error?: string;
	reason?: string;
}

export interface WorkflowLifecycleInspectionCheckpoint {
	id: string;
	attemptId: string;
	completedActivationCount: number;
	abortedActivationCount: number;
	frontierNodeIds: string[];
	sourceMapping: Record<string, string>;
}

export interface WorkflowLifecycleInspectionChangeRequest {
	id: string;
	status: WorkflowChangeRequestRecord["status"];
	actor: string;
	origin: WorkflowChangeRequestRecord["origin"];
	reason: string;
	attemptId?: string;
	checkpointId?: string;
	operationCount: number;
	operations: string[];
	frontierMapping: Record<string, string>;
	approvedBy?: string;
	rejectedBy?: string;
	applications: WorkflowLifecycleInspectionChangeApplication[];
}

export interface WorkflowLifecycleInspectionChangeApplication {
	target: WorkflowChangeRequestApplicationRecord["target"];
	actor: string;
	reason?: string;
	freezeId?: string;
	draftId?: string;
}

export interface WorkflowInspectionGraph {
	nodes: WorkflowInspectionNode[];
	edges: WorkflowInspectionEdge[];
}

export interface WorkflowInspectionNode {
	id: string;
	type: WorkflowNodeType;
}

export interface WorkflowInspectionEdge {
	from: string;
	to: string;
	condition?: string;
}

export interface WorkflowInspectionGraphRevision {
	id: string;
	nodeCount: number;
	edgeCount: number;
}

export interface WorkflowInspectionGraphPatchProposal {
	id: string;
	actor: WorkflowGraphPatchProposalRecord["actor"];
	reason?: string;
	impact: WorkflowInspectionGraphPatchImpact;
}

export interface WorkflowInspectionGraphPatchImpact {
	addedNodes: number;
	removedNodes: number;
	changedNodes: number;
	addedEdges: number;
	removedEdges: number;
	changedEdges: number;
	promptSourceChanges: number;
	modelChanges: number;
	permissionChanges: number;
	modelRoleChanges: number;
	warnings: number;
}

export interface WorkflowInspectionActivation {
	id: string;
	nodeId: string;
	graphRevisionId: string;
	parentActivationIds: string[];
	status: WorkflowActivationRecord["status"];
	mapped?: {
		poolId: string;
		itemKey: string;
		phase: "worker" | "verifier" | "reducer";
	};
	prompt?: WorkflowResolvedPrompt;
	summary?: string;
	artifacts?: string[];
	error?: string;
}
export interface WorkflowInspectionModelAssignment {
	activationId: string;
	nodeId: string;
	source: string;
	requestedRole?: string;
	requestedPattern?: string;
	resolvedModel?: string;
	thinkingLevel?: string;
	fallbackUsed: boolean;
	fallbackReason?: string;
	error?: string;
}

export function buildWorkflowInspection(run: WorkflowRunSnapshot): WorkflowInspection {
	return {
		runId: run.id,
		currentGraphRevisionId: run.currentGraphRevisionId,
		graph: {
			nodes: run.definition.nodes.map(node => ({ id: node.id, type: node.type })),
			edges: run.definition.edges.map(edge => compactEdge(edge.from, edge.to, edge.condition?.source)),
		},
		state: run.state,
		graphRevisions: run.graphRevisions.map(revision => ({
			id: revision.id,
			nodeCount: revision.definition.nodes.length,
			edgeCount: revision.definition.edges.length,
		})),
		pendingGraphPatchProposals: pendingGraphPatchProposals(run).map(proposal => ({
			id: proposal.id,
			actor: proposal.actor,
			reason: proposal.reason,
			impact: compactPatchImpact(proposal.preview),
		})),
		activations: run.activations.map(activation => ({
			id: activation.id,
			nodeId: activation.nodeId,
			graphRevisionId: activation.graphRevisionId,
			parentActivationIds: activation.parentActivationIds,
			status: activation.status,
			mapped: activation.mapped
				? {
						poolId: activation.mapped.poolId,
						itemKey: activation.mapped.itemKey,
						phase: activation.mapped.phase,
					}
				: undefined,
			prompt: activation.input?.prompt,
			summary: activation.output?.summary,
			artifacts: activation.output?.artifacts,
			error: activation.error,
		})),
		modelAssignments: run.activations.flatMap(activation => {
			const audit = activation.modelAudit;
			if (!audit) return [];
			return [
				{
					activationId: activation.id,
					nodeId: activation.nodeId,
					source: audit.source,
					requestedRole: audit.requestedRole,
					requestedPattern: audit.requestedPattern,
					resolvedModel: audit.resolvedModel,
					thinkingLevel: audit.thinkingLevel,
					fallbackUsed: audit.fallbackUsed,
					fallbackReason: audit.fallbackReason,
					error: audit.error,
				},
			];
		}),
	};
}

export function buildWorkflowLifecycleInspection(family: WorkflowRunFamilySnapshot): WorkflowLifecycleInspection {
	const inspection: WorkflowLifecycleInspection = {
		familyId: family.id,
		freezeIds: family.freezes.map(freeze => freeze.id),
		attempts: family.attempts.map(compactLifecycleAttempt),
		checkpoints: family.checkpoints.map(compactLifecycleCheckpoint),
		changeRequests: family.changeRequests.map(compactLifecycleChangeRequest),
	};
	if (family.objective !== undefined) inspection.objective = family.objective;
	return inspection;
}

function compactLifecycleAttempt(attempt: WorkflowRunAttemptSnapshot): WorkflowLifecycleInspectionAttempt {
	const inspection: WorkflowLifecycleInspectionAttempt = {
		id: attempt.id,
		freezeId: attempt.freezeId,
		startNodeId: attempt.startNodeId,
		status: attempt.status,
		runtimeBindingSnapshot: attempt.runtimeBindingSnapshot,
		activationCounts: attempt.activations.reduce<Record<string, number>>((counts, activation) => {
			counts[activation.status] = (counts[activation.status] ?? 0) + 1;
			return counts;
		}, {}),
		activations: attempt.activations.map(compactLifecycleActivation),
	};
	if (attempt.startNodeIds !== undefined) inspection.startNodeIds = [...attempt.startNodeIds];
	if (attempt.checkpointId !== undefined) inspection.checkpointId = attempt.checkpointId;
	if (attempt.summary !== undefined) inspection.summary = attempt.summary;
	if (attempt.error !== undefined) inspection.error = attempt.error;
	return inspection;
}

function compactLifecycleActivation(
	activation: WorkflowAttemptActivationRecord,
): WorkflowLifecycleInspectionActivation {
	return {
		id: activation.id,
		nodeId: activation.nodeId,
		parentActivationIds: activation.parentActivationIds,
		status: activation.status,
		mapped: activation.mapped
			? {
					poolId: activation.mapped.poolId,
					itemKey: activation.mapped.itemKey,
					phase: activation.mapped.phase,
				}
			: undefined,
		summary: activation.output?.summary,
		artifacts: activation.output?.artifacts,
		error: activation.error,
		reason: activation.reason,
	};
}

function compactLifecycleCheckpoint(checkpoint: WorkflowCheckpointSnapshot): WorkflowLifecycleInspectionCheckpoint {
	return {
		id: checkpoint.id,
		attemptId: checkpoint.attemptId,
		completedActivationCount: checkpoint.completedActivationIds.length,
		abortedActivationCount: checkpoint.abortedActivationIds.length,
		frontierNodeIds: checkpoint.frontierNodeIds,
		sourceMapping: checkpoint.sourceMapping,
	};
}

function compactLifecycleChangeRequest(request: WorkflowChangeRequestRecord): WorkflowLifecycleInspectionChangeRequest {
	const inspection: WorkflowLifecycleInspectionChangeRequest = {
		id: request.id,
		status: request.status,
		actor: request.actor,
		origin: request.origin,
		reason: request.reason,
		operationCount: request.operations.length,
		operations: request.operations.map(compactLifecycleChangeOperation),
		frontierMapping: request.frontierMapping,
		applications: request.applications.map(compactLifecycleChangeApplication),
	};
	if (request.attemptId !== undefined) inspection.attemptId = request.attemptId;
	if (request.checkpointId !== undefined) inspection.checkpointId = request.checkpointId;
	if (request.approvedBy !== undefined) inspection.approvedBy = request.approvedBy;
	if (request.rejectedBy !== undefined) inspection.rejectedBy = request.rejectedBy;
	return inspection;
}

function compactLifecycleChangeApplication(
	application: WorkflowChangeRequestApplicationRecord,
): WorkflowLifecycleInspectionChangeApplication {
	const inspection: WorkflowLifecycleInspectionChangeApplication = {
		target: application.target,
		actor: application.actor,
	};
	if (application.reason !== undefined) inspection.reason = application.reason;
	if (application.freezeId !== undefined) inspection.freezeId = application.freezeId;
	if (application.draftId !== undefined) inspection.draftId = application.draftId;
	return inspection;
}

function compactLifecycleChangeOperation(operation: WorkflowChangeRequestRecord["operations"][number]): string {
	if (operation.op === "add_node") return `add_node ${operation.node.id} (${operation.node.type})`;
	if (operation.op === "remove_node") return `remove_node ${operation.nodeId}`;
	if (operation.op === "add_edge")
		return `add_edge ${formatEdgeOperation(operation.edge.from, operation.edge.to, operation.edge.condition?.source)}`;
	if (operation.op === "remove_edge") return `remove_edge ${formatEdgeOperation(operation.from, operation.to)}`;
	if (operation.op === "replace_edge_condition") {
		return `replace_edge_condition ${formatEdgeOperation(operation.from, operation.to, operation.condition)}`;
	}
	if (operation.op === "replace_node_prompt_source") return `replace_node_prompt_source ${operation.nodeId}`;
	if (operation.op === "replace_node_model") return `replace_node_model ${operation.nodeId}`;
	if (operation.op === "replace_node_permissions") {
		const reads = operation.reads === undefined ? "" : ` reads=${operation.reads.join(",")}`;
		const writes = operation.writes === undefined ? "" : ` writes=${operation.writes.join(",")}`;
		return `replace_node_permissions ${operation.nodeId}${reads}${writes}`;
	}
	if (operation.op === "set_model_role") return `set_model_role ${operation.role}=${operation.selector}`;
	if (operation.op === "abandon_branch") return `abandon_branch ${operation.nodeId}${formatReason(operation.reason)}`;
	return `rollback_branch ${operation.nodeId} -> ${operation.targetNodeId}${formatReason(operation.reason)}`;
}

function formatEdgeOperation(from: string, to: string, condition?: string): string {
	const when = condition === undefined ? "" : ` when ${condition}`;
	return `${from} -> ${to}${when}`;
}

function formatReason(reason: string | undefined): string {
	return reason === undefined ? "" : ` - ${reason}`;
}

function compactEdge(from: string, to: string, condition: string | undefined): WorkflowInspectionEdge {
	const edge: WorkflowInspectionEdge = { from, to };
	if (condition !== undefined) edge.condition = condition;
	return edge;
}

function pendingGraphPatchProposals(run: WorkflowRunSnapshot): WorkflowGraphPatchProposalRecord[] {
	return run.graphPatchProposals;
}

function compactPatchImpact(preview: WorkflowGraphPatchProposalRecord["preview"]): WorkflowInspectionGraphPatchImpact {
	return {
		addedNodes: preview.addedNodes.length,
		removedNodes: preview.removedNodes.length,
		changedNodes: preview.changedNodes.length,
		addedEdges: preview.addedEdges.length,
		removedEdges: preview.removedEdges.length,
		changedEdges: preview.changedEdges.length,
		promptSourceChanges: preview.promptSourceChanges.length,
		modelChanges: preview.modelChanges.length,
		permissionChanges: preview.permissionChanges.length,
		modelRoleChanges: preview.modelRoleChanges.length,
		warnings: preview.warnings.length,
	};
}
