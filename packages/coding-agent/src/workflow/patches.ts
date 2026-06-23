import { diagnoseWorkflowConditionReferences, parseWorkflowCondition, WorkflowConditionError } from "./condition";
import type {
	WorkflowDefinition,
	WorkflowEdge,
	WorkflowModelContext,
	WorkflowNode,
	WorkflowNodeType,
	WorkflowPromptSource,
} from "./definition";
import type { WorkflowRunSnapshot, WorkflowRunStoreHost } from "./run-store";
import { readWorkflowState } from "./state";

export type WorkflowGraphPatchActor = "agent" | "supervisor" | "human";

export type WorkflowGraphPatchOperation =
	| WorkflowAddNodePatchOperation
	| WorkflowRemoveNodePatchOperation
	| WorkflowAddEdgePatchOperation
	| WorkflowRemoveEdgePatchOperation
	| WorkflowReplaceEdgeConditionPatchOperation
	| WorkflowReplaceNodePromptSourcePatchOperation
	| WorkflowReplaceNodeModelPatchOperation
	| WorkflowReplaceNodePermissionsPatchOperation
	| WorkflowSetModelRolePatchOperation
	| WorkflowAbandonBranchPatchOperation
	| WorkflowRollbackBranchPatchOperation;

export interface WorkflowAddNodePatchOperation {
	op: "add_node";
	node: WorkflowNode;
}

export interface WorkflowRemoveNodePatchOperation {
	op: "remove_node";
	nodeId: string;
}

export interface WorkflowAddEdgePatchOperation {
	op: "add_edge";
	edge: WorkflowEdge;
}

export interface WorkflowRemoveEdgePatchOperation {
	op: "remove_edge";
	from: string;
	to: string;
}

export interface WorkflowReplaceEdgeConditionPatchOperation {
	op: "replace_edge_condition";
	from: string;
	to: string;
	condition?: string;
}

export interface WorkflowReplaceNodePromptSourcePatchOperation {
	op: "replace_node_prompt_source";
	nodeId: string;
	promptSource: WorkflowPromptSource;
}

export interface WorkflowReplaceNodeModelPatchOperation {
	op: "replace_node_model";
	nodeId: string;
	model: WorkflowModelContext;
}

export interface WorkflowReplaceNodePermissionsPatchOperation {
	op: "replace_node_permissions";
	nodeId: string;
	reads?: string[];
	writes?: string[];
}

export interface WorkflowSetModelRolePatchOperation {
	op: "set_model_role";
	role: string;
	selector: string;
}

export interface WorkflowAbandonBranchPatchOperation {
	op: "abandon_branch";
	nodeId: string;
	reason?: string;
}

export interface WorkflowRollbackBranchPatchOperation {
	op: "rollback_branch";
	nodeId: string;
	targetNodeId: string;
	reason?: string;
}

export interface WorkflowGraphPatchContext {
	actor: WorkflowGraphPatchActor;
	reason?: string;
}

export interface WorkflowGraphPatchProposalContext extends WorkflowGraphPatchContext {
	proposalId?: string;
}

export interface WorkflowGraphPatchRunContext extends WorkflowGraphPatchContext {
	graphRevisionId: string;
	proposalId?: string;
}

export interface WorkflowGraphPatchPreview {
	addedNodes: string[];
	removedNodes: string[];
	changedNodes: string[];
	addedEdges: WorkflowEdgeReference[];
	removedEdges: WorkflowEdgeReference[];
	changedEdges: WorkflowEdgeReference[];
	promptSourceChanges: WorkflowPromptSourceChange[];
	modelChanges: WorkflowNodeModelChange[];
	permissionChanges: WorkflowNodePermissionChange[];
	modelRoleChanges: WorkflowModelRoleChange[];
	abandonedBranches: WorkflowBranchDisposition[];
	rolledBackBranches: WorkflowRollbackBranchDisposition[];
	warnings: string[];
}

export interface WorkflowEdgeReference {
	from: string;
	to: string;
}

export interface WorkflowNodeModelChange {
	nodeId: string;
	before?: WorkflowModelContext;
	after?: WorkflowModelContext;
}

export interface WorkflowPromptSourceChange {
	nodeId: string;
	before?: WorkflowPromptSource;
	after: WorkflowPromptSource;
}

export interface WorkflowNodePermissions {
	reads?: string[];
	writes?: string[];
}

export interface WorkflowNodePermissionChange {
	nodeId: string;
	before: WorkflowNodePermissions;
	after: WorkflowNodePermissions;
}

export interface WorkflowModelRoleChange {
	role: string;
	before?: string;
	after: string;
}

export interface WorkflowBranchDisposition {
	nodeId: string;
	reason?: string;
}

export interface WorkflowRollbackBranchDisposition extends WorkflowBranchDisposition {
	targetNodeId: string;
}

export interface WorkflowGraphPatchProposal {
	id: string;
	status: "proposed";
	patch: WorkflowGraphPatchOperation[];
	reason?: string;
	preview: WorkflowGraphPatchPreview;
}

export interface WorkflowGraphPatchResult {
	definition: WorkflowDefinition;
	preview: WorkflowGraphPatchPreview;
}

export class WorkflowGraphPatchError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WorkflowGraphPatchError";
	}
}

export function proposeWorkflowGraphPatch(
	definition: WorkflowDefinition,
	patch: WorkflowGraphPatchOperation[],
	context: WorkflowGraphPatchProposalContext,
): WorkflowGraphPatchProposal {
	const result = applyPatchOperations(definition, patch);
	return {
		id: context.proposalId ?? "workflow-graph-proposal",
		status: "proposed",
		patch,
		reason: context.reason,
		preview: result.preview,
	};
}

export function proposeWorkflowGraphPatchToRun(
	host: WorkflowRunStoreHost,
	run: WorkflowRunSnapshot,
	patch: WorkflowGraphPatchOperation[],
	context: WorkflowGraphPatchProposalContext,
): never {
	void host;
	void run;
	void patch;
	void context;
	throw new WorkflowGraphPatchError(
		"workflow graph patches cannot be proposed on an active run; use a workflow change request instead",
	);
}

export function applyWorkflowGraphPatch(
	definition: WorkflowDefinition,
	patch: WorkflowGraphPatchOperation[],
	context: WorkflowGraphPatchContext,
): WorkflowGraphPatchResult {
	if (context.actor !== "supervisor" && context.actor !== "human") {
		throw new WorkflowGraphPatchError("workflow graph patch apply requires supervisor or human approval");
	}
	return applyPatchOperations(definition, patch);
}

export function applyWorkflowGraphPatchToRun(
	host: WorkflowRunStoreHost,
	run: WorkflowRunSnapshot,
	patch: WorkflowGraphPatchOperation[],
	context: WorkflowGraphPatchRunContext,
): never {
	void host;
	void run;
	void patch;
	void context;
	throw new WorkflowGraphPatchError(
		"workflow graph patches cannot be applied to an active run; stop, checkpoint, freeze, and restart the workflow instead",
	);
}

function applyPatchOperations(
	definition: WorkflowDefinition,
	patch: WorkflowGraphPatchOperation[],
): WorkflowGraphPatchResult {
	const nextDefinition = cloneDefinition(definition);
	const preview = createEmptyPreview();
	for (const operation of patch) {
		applyPatchOperation(nextDefinition, operation, preview);
	}
	validateDefinitionGraph(nextDefinition);
	return { definition: nextDefinition, preview };
}

function applyPatchOperation(
	definition: WorkflowDefinition,
	operation: WorkflowGraphPatchOperation,
	preview: WorkflowGraphPatchPreview,
): void {
	if (operation.op === "add_node") {
		addNode(definition, operation.node, preview);
		return;
	}
	if (operation.op === "remove_node") {
		removeNode(definition, operation.nodeId, preview);
		return;
	}
	if (operation.op === "add_edge") {
		addEdge(definition, operation.edge, preview);
		return;
	}
	if (operation.op === "remove_edge") {
		removeEdge(definition, operation.from, operation.to, preview);
		return;
	}
	if (operation.op === "replace_edge_condition") {
		replaceEdgeCondition(definition, operation, preview);
		return;
	}
	if (operation.op === "replace_node_prompt_source") {
		replaceNodePromptSource(definition, operation, preview);
		return;
	}
	if (operation.op === "replace_node_model") {
		replaceNodeModel(definition, operation, preview);
		return;
	}
	if (operation.op === "replace_node_permissions") {
		replaceNodePermissions(definition, operation, preview);
		return;
	}
	if (operation.op === "set_model_role") {
		setModelRole(definition, operation, preview);
		return;
	}
	if (operation.op === "abandon_branch") {
		abandonBranch(definition, operation, preview);
		return;
	}
	if (operation.op === "rollback_branch") {
		rollbackBranch(definition, operation, preview);
		return;
	}
	const unreachable: never = operation;
	throw new WorkflowGraphPatchError(`unsupported workflow graph patch operation: ${String(unreachable)}`);
}

function addNode(definition: WorkflowDefinition, node: WorkflowNode, preview: WorkflowGraphPatchPreview): void {
	if (definition.nodes.some(existing => existing.id === node.id)) {
		throw new WorkflowGraphPatchError(`workflow graph patch cannot add duplicate node "${node.id}"`);
	}
	validateNodeShape(node);
	definition.nodes.push(cloneNode(node));
	preview.addedNodes.push(node.id);
}

function removeNode(definition: WorkflowDefinition, nodeId: string, preview: WorkflowGraphPatchPreview): void {
	const nodeIndex = findNodeIndex(definition, nodeId);
	definition.nodes.splice(nodeIndex, 1);
	const remainingEdges: WorkflowEdge[] = [];
	for (const edge of definition.edges) {
		if (edge.from === nodeId || edge.to === nodeId) {
			preview.removedEdges.push(edgeReference(edge));
			continue;
		}
		remainingEdges.push(edge);
	}
	definition.edges = remainingEdges;
	preview.removedNodes.push(nodeId);
}

function addEdge(definition: WorkflowDefinition, edge: WorkflowEdge, preview: WorkflowGraphPatchPreview): void {
	if (definition.edges.some(existing => existing.from === edge.from && existing.to === edge.to)) {
		throw new WorkflowGraphPatchError(
			`workflow graph patch cannot add duplicate edge "${edge.from}" -> "${edge.to}"`,
		);
	}
	validateEdgeReferences(definition, edge);
	validateEdgeCondition(edge.condition?.source, definition);
	definition.edges.push(cloneEdge(edge));
	preview.addedEdges.push(edgeReference(edge));
}

function removeEdge(
	definition: WorkflowDefinition,
	from: string,
	to: string,
	preview: WorkflowGraphPatchPreview,
): void {
	const edgeIndex = findEdgeIndex(definition, from, to);
	const edge = definition.edges[edgeIndex];
	if (edge) preview.removedEdges.push(edgeReference(edge));
	definition.edges.splice(edgeIndex, 1);
}

function replaceEdgeCondition(
	definition: WorkflowDefinition,
	operation: WorkflowReplaceEdgeConditionPatchOperation,
	preview: WorkflowGraphPatchPreview,
): void {
	const edge = definition.edges[findEdgeIndex(definition, operation.from, operation.to)];
	if (!edge) {
		throw new WorkflowGraphPatchError(
			`workflow graph patch references unknown edge "${operation.from}" -> "${operation.to}"`,
		);
	}
	validateEdgeCondition(operation.condition, definition);
	if (operation.condition === undefined) {
		delete edge.condition;
	} else {
		edge.condition = { source: operation.condition.trim() };
	}
	preview.changedEdges.push({ from: operation.from, to: operation.to });
}

function replaceNodePromptSource(
	definition: WorkflowDefinition,
	operation: WorkflowReplaceNodePromptSourcePatchOperation,
	preview: WorkflowGraphPatchPreview,
): void {
	const node = definition.nodes[findNodeIndex(definition, operation.nodeId)];
	if (!node) {
		throw new WorkflowGraphPatchError(`workflow graph patch references unknown node "${operation.nodeId}"`);
	}
	validatePromptSourceShape(operation.promptSource, operation.nodeId);
	const nextPromptSource = structuredClone(operation.promptSource);
	preview.promptSourceChanges.push({
		nodeId: operation.nodeId,
		before: clonePromptSource(node.promptSource),
		after: nextPromptSource,
	});
	node.promptSource = nextPromptSource;
	const prompt = promptTextForSource(operation.promptSource);
	if (prompt === undefined) {
		delete node.prompt;
	} else {
		node.prompt = prompt;
	}
	pushUnique(preview.changedNodes, operation.nodeId);
}

function replaceNodeModel(
	definition: WorkflowDefinition,
	operation: WorkflowReplaceNodeModelPatchOperation,
	preview: WorkflowGraphPatchPreview,
): void {
	const node = definition.nodes[findNodeIndex(definition, operation.nodeId)];
	if (!node) {
		throw new WorkflowGraphPatchError(`workflow graph patch references unknown node "${operation.nodeId}"`);
	}
	validateModelContext(operation.model);
	preview.modelChanges.push({
		nodeId: operation.nodeId,
		before: cloneModelContext(node.model),
		after: cloneModelContext(operation.model),
	});
	node.model = cloneModelContext(operation.model);
	pushUnique(preview.changedNodes, operation.nodeId);
}

function replaceNodePermissions(
	definition: WorkflowDefinition,
	operation: WorkflowReplaceNodePermissionsPatchOperation,
	preview: WorkflowGraphPatchPreview,
): void {
	const node = definition.nodes[findNodeIndex(definition, operation.nodeId)];
	if (!node) {
		throw new WorkflowGraphPatchError(`workflow graph patch references unknown node "${operation.nodeId}"`);
	}
	validateStateScopes(operation.reads);
	validateStateScopes(operation.writes);
	const before = compactPermissions({ reads: node.reads, writes: node.writes });
	const after = compactPermissions({ reads: operation.reads, writes: operation.writes });
	if (operation.reads === undefined) {
		delete node.reads;
	} else {
		node.reads = [...operation.reads];
	}
	if (operation.writes === undefined) {
		delete node.writes;
	} else {
		node.writes = [...operation.writes];
	}
	preview.permissionChanges.push({ nodeId: operation.nodeId, before, after });
	pushUnique(preview.changedNodes, operation.nodeId);
}

function setModelRole(
	definition: WorkflowDefinition,
	operation: WorkflowSetModelRolePatchOperation,
	preview: WorkflowGraphPatchPreview,
): void {
	validateNonEmptyString(operation.role, "workflow graph patch model role");
	validateNonEmptyString(operation.selector, "workflow graph patch model role selector");
	const before = definition.models.roles[operation.role];
	definition.models.roles[operation.role] = operation.selector;
	preview.modelRoleChanges.push({ role: operation.role, before, after: operation.selector });
}

function abandonBranch(
	definition: WorkflowDefinition,
	operation: WorkflowAbandonBranchPatchOperation,
	preview: WorkflowGraphPatchPreview,
): void {
	findNodeIndex(definition, operation.nodeId);
	const disposition: WorkflowBranchDisposition = { nodeId: operation.nodeId };
	if (operation.reason !== undefined) {
		validateNonEmptyString(operation.reason, "workflow graph patch abandon branch reason");
		disposition.reason = operation.reason;
	}
	preview.abandonedBranches.push(disposition);
}

function rollbackBranch(
	definition: WorkflowDefinition,
	operation: WorkflowRollbackBranchPatchOperation,
	preview: WorkflowGraphPatchPreview,
): void {
	findNodeIndex(definition, operation.nodeId);
	findNodeIndex(definition, operation.targetNodeId);
	const disposition: WorkflowRollbackBranchDisposition = {
		nodeId: operation.nodeId,
		targetNodeId: operation.targetNodeId,
	};
	if (operation.reason !== undefined) {
		validateNonEmptyString(operation.reason, "workflow graph patch rollback branch reason");
		disposition.reason = operation.reason;
	}
	preview.rolledBackBranches.push(disposition);
}

function validateDefinitionGraph(definition: WorkflowDefinition): void {
	const nodeIds = new Set<string>();
	for (const node of definition.nodes) {
		validateNodeShape(node);
		if (nodeIds.has(node.id)) {
			throw new WorkflowGraphPatchError(`workflow graph patch produced duplicate node "${node.id}"`);
		}
		nodeIds.add(node.id);
	}
	validatePromptSourceReferences(definition, nodeIds);
	for (const edge of definition.edges) {
		validateEdgeReferences(definition, edge);
		validateEdgeCondition(edge.condition?.source, definition);
	}
}

function validateNodeShape(node: WorkflowNode): void {
	if (!node.id.trim()) {
		throw new WorkflowGraphPatchError("workflow graph patch node id must be non-empty");
	}
	validateNodeType(node.type);
	validateModelContext(node.model);
	validateStateScopes(node.reads);
	validateStateScopes(node.writes);
	validateFallbackVerdict(node);
	if (node.promptSource !== undefined) {
		validatePromptSourceShape(node.promptSource, node.id);
	}
}

function validateNodeType(type: WorkflowNodeType): void {
	if (
		type === "agent" ||
		type === "script" ||
		type === "human" ||
		type === "review" ||
		type === "foreach" ||
		type === "workflow"
	) {
		return;
	}
	throw new WorkflowGraphPatchError(`workflow graph patch node type is invalid: ${String(type)}`);
}

function validateFallbackVerdict(node: WorkflowNode): void {
	if (node.fallbackVerdict === undefined) return;
	if (node.type !== "review") {
		throw new WorkflowGraphPatchError("workflow graph patch fallbackVerdict is only valid for review nodes");
	}
	if (!node.gates?.includes(node.fallbackVerdict)) {
		throw new WorkflowGraphPatchError(
			`workflow graph patch fallbackVerdict for node "${node.id}" must be one of the declared gates`,
		);
	}
}

function validateEdgeReferences(definition: WorkflowDefinition, edge: WorkflowEdge): void {
	if (!definition.nodes.some(node => node.id === edge.from)) {
		throw new WorkflowGraphPatchError(`workflow graph patch references unknown source node "${edge.from}"`);
	}
	if (!definition.nodes.some(node => node.id === edge.to)) {
		throw new WorkflowGraphPatchError(`workflow graph patch references unknown target node "${edge.to}"`);
	}
}

function validateEdgeCondition(source: string | undefined, definition: WorkflowDefinition): void {
	if (source === undefined) return;
	const trimmed = source.trim();
	try {
		parseWorkflowCondition(trimmed);
	} catch (error) {
		if (error instanceof WorkflowConditionError) {
			throw new WorkflowGraphPatchError(`workflow graph patch condition is invalid: ${error.message}`);
		}
		throw error;
	}
	for (const diagnostic of diagnoseWorkflowConditionReferences(trimmed, definition.nodes)) {
		throw new WorkflowGraphPatchError(`workflow graph patch condition ${diagnostic}`);
	}
}

function validateModelContext(model: WorkflowModelContext | undefined): void {
	if (model === undefined) return;
	const sourceCount = [model.role, model.selector, model.candidates].filter(entry => entry !== undefined).length;
	if (sourceCount !== 1) {
		throw new WorkflowGraphPatchError(
			"workflow graph patch model context must define exactly one of role, selector, or candidates",
		);
	}
	if (model.candidates !== undefined && model.candidates.length === 0) {
		throw new WorkflowGraphPatchError("workflow graph patch model candidates must not be empty");
	}
	if (model.unavailable !== undefined && model.unavailable !== "fallback-to-parent" && model.unavailable !== "fail") {
		throw new WorkflowGraphPatchError("workflow graph patch model unavailable policy is invalid");
	}
}

function validateStateScopes(scopes: string[] | undefined): void {
	if (scopes === undefined) return;
	for (const scope of scopes) {
		readWorkflowState({}, scope, { allowedReadPaths: [scope] });
	}
}

function validatePromptSourceReferences(definition: WorkflowDefinition, nodeIds: Set<string>): void {
	for (const node of definition.nodes) {
		const source = node.promptSource;
		if (source?.kind === "output" && !nodeIds.has(source.node)) {
			throw new WorkflowGraphPatchError(
				`workflow graph patch leaves node "${node.id}" prompt referencing unknown output node "${source.node}"`,
			);
		}
		if (source?.kind === "template") {
			for (const binding of Object.values(source.bindings)) {
				if (binding.kind === "output" && !nodeIds.has(binding.node)) {
					throw new WorkflowGraphPatchError(
						`workflow graph patch leaves node "${node.id}" prompt referencing unknown output node "${binding.node}"`,
					);
				}
			}
		}
		validatePromptSourcePermissions(node);
	}
}

function validatePromptSourcePermissions(node: WorkflowNode): void {
	const source = node.promptSource;
	if (!source) return;
	if (source.kind === "state" || source.kind === "human" || source.kind === "output") {
		readWorkflowState({}, source.path, { allowedReadPaths: node.reads });
		return;
	}
	if (source.kind === "template") {
		for (const binding of Object.values(source.bindings)) {
			if (binding.kind === "state" || binding.kind === "human" || binding.kind === "output") {
				readWorkflowState({}, binding.path, { allowedReadPaths: node.reads });
			}
		}
	}
}

function validatePromptSourceShape(source: WorkflowPromptSource, nodeId: string): void {
	if (source.kind === "inline") {
		validateNonEmptyString(source.text, `workflow graph patch node "${nodeId}" inline prompt`);
		return;
	}
	if (source.kind === "file") {
		validateNonEmptyString(source.path, `workflow graph patch node "${nodeId}" prompt file path`);
		return;
	}
	if (source.kind === "state" || source.kind === "human") {
		validateJsonPointer(source.path, `workflow graph patch node "${nodeId}" prompt path`);
		return;
	}
	if (source.kind === "output") {
		validateNonEmptyString(source.node, `workflow graph patch node "${nodeId}" prompt output node`);
		validateJsonPointer(source.path, `workflow graph patch node "${nodeId}" prompt output path`);
		if (source.activation !== "parent" && source.activation !== "latest-completed") {
			throw new WorkflowGraphPatchError(
				`workflow graph patch node "${nodeId}" prompt activation selector is invalid`,
			);
		}
		return;
	}
	if (source.kind === "template") {
		validateNonEmptyString(source.file, `workflow graph patch node "${nodeId}" prompt template file path`);
		for (const [name, binding] of Object.entries(source.bindings)) {
			validateNonEmptyString(name, `workflow graph patch node "${nodeId}" prompt template binding name`);
			if (binding.kind === "inline") {
				validateNonEmptyString(binding.text, `workflow graph patch node "${nodeId}" prompt template binding`);
				continue;
			}
			if (binding.kind === "state" || binding.kind === "human") {
				validateJsonPointer(binding.path, `workflow graph patch node "${nodeId}" prompt template binding path`);
				continue;
			}
			if (binding.kind === "output") {
				validateNonEmptyString(
					binding.node,
					`workflow graph patch node "${nodeId}" prompt template binding output node`,
				);
				validateJsonPointer(
					binding.path,
					`workflow graph patch node "${nodeId}" prompt template binding output path`,
				);
				if (binding.activation !== "parent" && binding.activation !== "latest-completed") {
					throw new WorkflowGraphPatchError(
						`workflow graph patch node "${nodeId}" prompt template binding activation selector is invalid`,
					);
				}
				continue;
			}
			const invalidBinding: never = binding;
			throw new WorkflowGraphPatchError(
				`workflow graph patch prompt template binding is invalid: ${String(invalidBinding)}`,
			);
		}
		return;
	}
	const unreachable: never = source;
	throw new WorkflowGraphPatchError(`workflow graph patch prompt source is invalid: ${String(unreachable)}`);
}

function validateJsonPointer(path: string, label: string): void {
	validateNonEmptyString(path, label);
	if (!path.startsWith("/")) {
		throw new WorkflowGraphPatchError(`${label} must be a JSON pointer`);
	}
}

function validateNonEmptyString(value: string, label: string): void {
	if (typeof value !== "string" || !value.trim()) {
		throw new WorkflowGraphPatchError(`${label} must be non-empty`);
	}
}

function findNodeIndex(definition: WorkflowDefinition, nodeId: string): number {
	const index = definition.nodes.findIndex(node => node.id === nodeId);
	if (index >= 0) return index;
	throw new WorkflowGraphPatchError(`workflow graph patch references unknown node "${nodeId}"`);
}

function findEdgeIndex(definition: WorkflowDefinition, from: string, to: string): number {
	const index = definition.edges.findIndex(edge => edge.from === from && edge.to === to);
	if (index >= 0) return index;
	throw new WorkflowGraphPatchError(`workflow graph patch references unknown edge "${from}" -> "${to}"`);
}

function cloneDefinition(definition: WorkflowDefinition): WorkflowDefinition {
	return structuredClone(definition);
}

function cloneNode(node: WorkflowNode): WorkflowNode {
	return structuredClone(node);
}

function cloneEdge(edge: WorkflowEdge): WorkflowEdge {
	return structuredClone(edge);
}

function cloneModelContext(model: WorkflowModelContext | undefined): WorkflowModelContext | undefined {
	return model === undefined ? undefined : structuredClone(model);
}

function clonePromptSource(source: WorkflowPromptSource | undefined): WorkflowPromptSource | undefined {
	return source === undefined ? undefined : structuredClone(source);
}

function promptTextForSource(source: WorkflowPromptSource): string | undefined {
	if (source.kind === "inline") return source.text;
	if (source.kind === "file") return source.path;
	return undefined;
}

function edgeReference(edge: WorkflowEdge): WorkflowEdgeReference {
	return { from: edge.from, to: edge.to };
}

function compactPermissions(permissions: WorkflowNodePermissions): WorkflowNodePermissions {
	const result: WorkflowNodePermissions = {};
	if (permissions.reads !== undefined) result.reads = [...permissions.reads];
	if (permissions.writes !== undefined) result.writes = [...permissions.writes];
	return result;
}

function pushUnique(values: string[], value: string): void {
	if (!values.includes(value)) values.push(value);
}

function createEmptyPreview(): WorkflowGraphPatchPreview {
	return {
		addedNodes: [],
		removedNodes: [],
		changedNodes: [],
		addedEdges: [],
		removedEdges: [],
		changedEdges: [],
		promptSourceChanges: [],
		modelChanges: [],
		permissionChanges: [],
		modelRoleChanges: [],
		abandonedBranches: [],
		rolledBackBranches: [],
		warnings: [],
	};
}
