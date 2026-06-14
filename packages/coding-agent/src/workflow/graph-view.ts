import { Ellipsis, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import { workflowAgentTaskIdForNode } from "./agent-task-id";
import { evaluateWorkflowCondition } from "./condition";
import type { WorkflowNode } from "./definition";
import { formatWorkflowNodeDisplayName, formatWorkflowNodeRole } from "./display";
import type {
	WorkflowAttemptActivationRecord,
	WorkflowChangeRequestRecord,
	WorkflowCheckpointSnapshot,
	WorkflowRunAttemptSnapshot,
	WorkflowRunFamilySnapshot,
} from "./lifecycle";
import { findRunningWorkflowCheckpointResumeAttempt } from "./lifecycle";
import { applyWorkflowStatePatch, type WorkflowActivationOutput } from "./state";

export type WorkflowGraphNodeStatus =
	| "pending"
	| "running"
	| "completed"
	| "checkpointed"
	| "frontier"
	| "failed"
	| "aborted";

export interface WorkflowGraphView {
	familyId: string;
	objective?: string;
	latestFreezeId?: string;
	currentAttempt?: WorkflowGraphAttemptView;
	changes: WorkflowGraphChangeCounts;
	topology: WorkflowGraphTopologyView;
	subflows?: WorkflowGraphSubflowView[];
	activeAgents?: WorkflowGraphActiveAgentView[];
	nodes: WorkflowGraphNodeView[];
	edges: WorkflowGraphEdgeView[];
	selectedRoutes?: WorkflowGraphSelectedRouteView[];
	checkpoint?: WorkflowGraphCheckpointView;
	lineage: WorkflowGraphLineageView[];
	actions: string[];
}

export interface WorkflowGraphAttemptView {
	id: string;
	status: WorkflowRunAttemptSnapshot["status"];
	runtimeBindingId: string;
	checkpointId?: string;
}

export interface WorkflowGraphChangeCounts {
	approved: number;
	proposed: number;
	rejected: number;
}

export interface WorkflowGraphTopologyView {
	parallelFanOuts: number;
	branchPoints: number;
	joins: number;
	loops: number;
	subflows: number;
}

export interface WorkflowGraphSubflowView {
	alias: string;
	name: string;
	version: number;
	namespace: string;
	nodeCount: number;
	entryNodeIds: string[];
	exitNodeIds: string[];
	resourcePrefix?: string;
}

export interface WorkflowGraphActiveAgentView {
	activationId: string;
	focusAgentId: string;
	generation?: number;
	nodeId: string;
	label: string;
	role: string;
	status: "running";
	model?: string;
	tool?: string;
	activity?: string;
	stats?: string;
	summary?: string;
	recentOutput?: string[];
}

export interface WorkflowGraphNodeView {
	id: string;
	kind: string;
	status: WorkflowGraphNodeStatus;
	verdict?: string;
	summary?: string;
	error?: string;
	reason?: string;
	focused: boolean;
}

export interface WorkflowGraphEdgeView {
	from: string;
	to: string;
	condition?: string;
}

export interface WorkflowGraphSelectedRouteView {
	from: string;
	to: string;
	condition?: string;
}

export interface WorkflowGraphCheckpointView {
	id: string;
	frontier: WorkflowGraphFrontierView[];
	omittedAbortedOutputs?: number;
}

export interface WorkflowGraphFrontierView {
	from: string;
	to: string;
}

export interface WorkflowGraphLineageView {
	id: string;
	status: WorkflowChangeRequestRecord["status"];
	reason: string;
	actor?: string;
	applications: string[];
}

export interface WorkflowGraphRenderOptions {
	width?: number;
}

export interface WorkflowGraphViewOptions {
	/**
	 * When provided, only attempts in this set are considered process-live. This
	 * prevents persisted running activations from being rendered as focusable live
	 * Agent Hub targets after a session resume.
	 */
	liveAttemptIds?: ReadonlySet<string>;
	activeAgentProgressById?: ReadonlyMap<string, WorkflowGraphActiveAgentProgress>;
}

export interface WorkflowGraphActiveAgentProgress {
	model?: string;
	currentTool?: string;
	currentToolArgs?: string;
	lastIntent?: string;
	recentOutput?: readonly string[];
	durationMs?: number;
	toolCount?: number;
	contextTokens?: number;
	contextWindow?: number;
	retryState?: WorkflowGraphActiveAgentRetryState;
}

export interface WorkflowGraphActiveAgentRetryState {
	attempt: number;
	maxAttempts: number;
	delayMs: number;
	errorMessage: string;
	startedAtMs: number;
}

const WORKFLOW_DETAIL_PREVIEW_CHARS = 180;
const WORKFLOW_RECENT_OUTPUT_LINES = 4;
const WORKFLOW_RECENT_OUTPUT_PER_AGENT = 2;
const MIN_NODE_WIDTH = 31;
const DEFAULT_NODE_WIDTH = 49;
const MAX_NODE_WIDTH = 71;
const NODE_GAP_WIDTH = 3;

export function buildWorkflowGraphView(
	family: WorkflowRunFamilySnapshot,
	options: WorkflowGraphViewOptions = {},
): WorkflowGraphView {
	const latestFreeze = family.freezes.at(-1);
	const currentAttempt = family.attempts.at(-1);
	const currentFreeze =
		(currentAttempt ? family.freezes.find(freeze => freeze.id === currentAttempt.freezeId) : undefined) ??
		latestFreeze;
	const currentCheckpoint = currentAttempt ? findWorkflowCheckpointForAttempt(family, currentAttempt) : undefined;
	const nodeStatuses = buildWorkflowGraphNodeStatuses(family, currentAttempt, currentCheckpoint);
	const nodes =
		currentFreeze?.definition.nodes.map(node => {
			const status = nodeStatuses.get(node.id) ?? { status: "pending" as const };
			const view: WorkflowGraphNodeView = {
				id: node.id,
				kind: formatWorkflowNodeKind(node),
				status: status.status,
				focused: isFocusedWorkflowGraphNode(status.status),
			};
			if (status.verdict !== undefined) view.verdict = status.verdict;
			if (status.summary !== undefined) view.summary = status.summary;
			if (status.error !== undefined) view.error = status.error;
			if (status.reason !== undefined) view.reason = status.reason;
			return view;
		}) ?? [];
	const edges =
		currentFreeze?.definition.edges.map(edge => {
			const view: WorkflowGraphEdgeView = { from: edge.from, to: edge.to };
			if (edge.condition?.source !== undefined) view.condition = edge.condition.source;
			return view;
		}) ?? [];
	const topology = buildWorkflowGraphTopology(nodes, edges, currentFreeze?.definition.subflows?.length ?? 0);
	const selectedRoutes = buildWorkflowGraphSelectedRoutes(currentAttempt, edges);
	const activeAgents = formatActiveWorkflowAgents(currentAttempt, currentFreeze?.definition.nodes ?? [], options);
	const view: WorkflowGraphView = {
		familyId: family.id,
		changes: countWorkflowChangeRequests(family),
		topology,
		nodes,
		edges,
		lineage: family.changeRequests.map(formatLineage),
		actions: formatWorkflowGraphActions(family, currentAttempt, currentCheckpoint, options, activeAgents),
	};
	if (selectedRoutes.length > 0) view.selectedRoutes = selectedRoutes;
	if (currentFreeze?.definition.subflows !== undefined) {
		view.subflows = currentFreeze.definition.subflows.map(subflow => ({
			alias: subflow.alias,
			name: subflow.name,
			version: subflow.version,
			namespace: subflow.namespace,
			nodeCount: subflow.nodeIds.length,
			entryNodeIds: [...subflow.entryNodeIds],
			exitNodeIds: [...subflow.exitNodeIds],
			...(subflow.resourcePrefix !== undefined ? { resourcePrefix: subflow.resourcePrefix } : {}),
		}));
	}
	if (activeAgents.length > 0) view.activeAgents = activeAgents;
	if (family.objective !== undefined) view.objective = family.objective;
	if (latestFreeze?.id !== undefined) view.latestFreezeId = latestFreeze.id;
	if (currentAttempt !== undefined) {
		view.currentAttempt = {
			id: currentAttempt.id,
			status: currentAttempt.status,
			runtimeBindingId: currentAttempt.runtimeBindingSnapshot.id,
		};
		if (currentAttempt.checkpointId !== undefined) view.currentAttempt.checkpointId = currentAttempt.checkpointId;
	}
	if (currentCheckpoint !== undefined) {
		view.checkpoint = {
			id: currentCheckpoint.id,
			frontier: currentCheckpoint.frontierNodeIds.map(nodeId => ({
				from: nodeId,
				to: mapWorkflowCheckpointFrontierNode(family, currentCheckpoint, nodeId, currentFreeze),
			})),
		};
		if (currentCheckpoint.abortedActivationIds.length > 0) {
			view.checkpoint.omittedAbortedOutputs = currentCheckpoint.abortedActivationIds.length;
		}
	}
	return view;
}

export function renderWorkflowGraphText(view: WorkflowGraphView, options: WorkflowGraphRenderOptions = {}): string {
	const lines: string[] = [`Workflow graph: ${view.familyId}`];
	if (view.objective !== undefined) lines.push(`Objective: ${view.objective}`);
	lines.push("Overview:");
	for (const line of formatWorkflowOverviewLines(view)) lines.push(`- ${line}`);
	if (view.subflows !== undefined && view.subflows.length > 0) {
		lines.push("Flow calls:");
		for (const subflow of view.subflows) lines.push(`- ${formatWorkflowSubflow(subflow)}`);
	}
	const onFlight = formatWorkflowOnFlightLines(view);
	if (onFlight.length > 0) {
		lines.push("On-flight:");
		for (const line of onFlight) lines.push(`- ${line}`);
	}
	const recentOutput = formatWorkflowRecentOutputLines(view);
	if (recentOutput.length > 0) {
		lines.push("Recent output:");
		for (const line of recentOutput) lines.push(`- ${line}`);
	}
	lines.push("Diagram:");
	lines.push(...renderWorkflowGraphDiagram(view, options));
	if (view.selectedRoutes !== undefined && view.selectedRoutes.length > 0) {
		lines.push("Selected routes:");
		for (const route of view.selectedRoutes) lines.push(`- ${formatWorkflowSelectedRoute(route)}`);
	}
	if (view.lineage.length > 0) {
		lines.push("Change review:");
		for (const line of formatWorkflowChangeReviewLines(view)) lines.push(`- ${line}`);
	}
	lines.push("Controls:");
	for (const action of formatWorkflowControlLines(view)) lines.push(`- ${action}`);
	return lines.join("\n");
}

export function renderWorkflowGraphDiagram(
	view: WorkflowGraphView,
	options: WorkflowGraphRenderOptions = {},
): string[] {
	if (view.nodes.length === 0) return ["(no frozen graph)"];
	const layout = layoutWorkflowGraph(view, options.width);
	const lines: string[] = [];
	for (let rankIndex = 0; rankIndex < layout.ranks.length; rankIndex += 1) {
		lines.push(...renderWorkflowGraphRank(rankIndex, layout));
		const connectorLines = renderWorkflowGraphConnector(rankIndex, layout);
		lines.push(...connectorLines);
		if (rankIndex < layout.ranks.length - 1 && connectorLines.length === 0) lines.push("");
	}
	if (layout.backEdges.length > 0) lines.push("", ...renderWorkflowGraphLoopbacks(layout.backEdges));
	return lines;
}

interface WorkflowGraphLayout {
	ranks: WorkflowGraphNodeView[][];
	rankByNodeId: Map<string, number>;
	forwardEdges: WorkflowGraphEdgeView[];
	backEdges: WorkflowGraphEdgeView[];
	nodeWidth: number;
	totalWidth: number;
}

function layoutWorkflowGraph(view: WorkflowGraphView, width: number | undefined): WorkflowGraphLayout {
	const order = new Map(view.nodes.map((node, index) => [node.id, index]));
	const forwardEdges = view.edges.filter(edge => !isWorkflowBackEdge(edge, order));
	const backEdges = view.edges.filter(edge => isWorkflowBackEdge(edge, order));
	const rankByNodeId = new Map(view.nodes.map(node => [node.id, 0]));
	for (let pass = 0; pass < view.nodes.length; pass += 1) {
		let changed = false;
		for (const edge of forwardEdges) {
			const sourceRank = rankByNodeId.get(edge.from);
			const targetRank = rankByNodeId.get(edge.to);
			if (sourceRank === undefined || targetRank === undefined) continue;
			const nextRank = sourceRank + 1;
			if (targetRank >= nextRank) continue;
			rankByNodeId.set(edge.to, nextRank);
			changed = true;
		}
		if (!changed) break;
	}
	const rankCount = Math.max(1, ...rankByNodeId.values()) + 1;
	const ranks = Array.from({ length: rankCount }, () => [] as WorkflowGraphNodeView[]);
	for (const node of view.nodes) {
		const rank = rankByNodeId.get(node.id) ?? 0;
		ranks[rank]!.push(node);
	}
	const maxRankSize = Math.max(1, ...ranks.map(rank => rank.length));
	const nodeWidth = workflowGraphNodeWidth(width, maxRankSize);
	return {
		ranks,
		rankByNodeId,
		forwardEdges,
		backEdges,
		nodeWidth,
		totalWidth: rankWidth(maxRankSize, nodeWidth),
	};
}

function buildWorkflowGraphTopology(
	nodes: readonly WorkflowGraphNodeView[],
	edges: readonly WorkflowGraphEdgeView[],
	subflows: number,
): WorkflowGraphTopologyView {
	const order = new Map(nodes.map((node, index) => [node.id, index]));
	const outgoing = new Map<string, WorkflowGraphEdgeView[]>();
	const incoming = new Map<string, WorkflowGraphEdgeView[]>();
	for (const edge of edges) {
		const outgoingEdges = outgoing.get(edge.from) ?? [];
		outgoingEdges.push(edge);
		outgoing.set(edge.from, outgoingEdges);
		const incomingEdges = incoming.get(edge.to) ?? [];
		incomingEdges.push(edge);
		incoming.set(edge.to, incomingEdges);
	}
	let parallelFanOuts = 0;
	let branchPoints = 0;
	let joins = 0;
	let loops = 0;
	for (const node of nodes) {
		const outgoingEdges = outgoing.get(node.id) ?? [];
		const conditionalOutgoing = outgoingEdges.some(edge => edge.condition !== undefined);
		if (outgoingEdges.length > 1 && !conditionalOutgoing) parallelFanOuts += 1;
		if (conditionalOutgoing) branchPoints += 1;
		if ((incoming.get(node.id) ?? []).length > 1) joins += 1;
	}
	for (const edge of edges) {
		if (isWorkflowBackEdge(edge, order)) loops += 1;
	}
	return { parallelFanOuts, branchPoints, joins, loops, subflows };
}

function isWorkflowBackEdge(edge: WorkflowGraphEdgeView, order: Map<string, number>): boolean {
	const sourceOrder = order.get(edge.from);
	const targetOrder = order.get(edge.to);
	if (sourceOrder === undefined || targetOrder === undefined) return false;
	return targetOrder <= sourceOrder;
}

function workflowGraphNodeWidth(width: number | undefined, maxRankSize: number): number {
	if (width === undefined || !Number.isFinite(width)) return DEFAULT_NODE_WIDTH;
	const safeRankSize = Math.max(1, maxRankSize);
	const available = Math.floor(width) - NODE_GAP_WIDTH * (safeRankSize - 1);
	const rankFitWidth = Math.floor(available / safeRankSize);
	const boundedWidth = Math.max(MIN_NODE_WIDTH, Math.min(MAX_NODE_WIDTH, rankFitWidth));
	return oddNodeWidth(boundedWidth);
}

function oddNodeWidth(width: number): number {
	return width % 2 === 0 ? width - 1 : width;
}

function rankWidth(rankSize: number, nodeWidth: number): number {
	return rankSize * nodeWidth + Math.max(0, rankSize - 1) * NODE_GAP_WIDTH;
}

function renderWorkflowGraphRank(rankIndex: number, layout: WorkflowGraphLayout): string[] {
	const rank = layout.ranks[rankIndex] ?? [];
	const boxes = rank.map(node =>
		renderWorkflowGraphNode(node, layout.nodeWidth, {
			incoming: hasIncomingWorkflowGraphConnector(node.id, rankIndex, layout),
			outgoing: hasOutgoingWorkflowGraphConnector(node.id, rankIndex, layout),
		}),
	);
	const rankContentWidth = rankWidth(rank.length, layout.nodeWidth);
	const leftPadding = " ".repeat(Math.max(0, Math.floor((layout.totalWidth - rankContentWidth) / 2)));
	const height = Math.max(...boxes.map(box => box.length));
	const rows: string[] = [];
	for (let lineIndex = 0; lineIndex < height; lineIndex += 1) {
		rows.push(
			`${leftPadding}${boxes
				.map(box => box[lineIndex] ?? " ".repeat(layout.nodeWidth))
				.join(" ".repeat(NODE_GAP_WIDTH))}`.trimEnd(),
		);
	}
	return rows;
}

function renderWorkflowGraphConnector(rankIndex: number, layout: WorkflowGraphLayout): string[] {
	const edges = layout.forwardEdges.filter(edge => layout.rankByNodeId.get(edge.from) === rankIndex);
	if (edges.length === 0) return [];
	const nextRankIndex = rankIndex + 1;
	const routedEdges = edges.filter(edge => {
		const targetRank = layout.rankByNodeId.get(edge.to);
		return targetRank !== undefined && targetRank >= nextRankIndex;
	});
	if (routedEdges.length === 0) return [];
	const directEdges: RoutedWorkflowGraphEdge[] = [];
	const skippedEdges: WorkflowGraphEdgeView[] = [];
	for (const edge of routedEdges) {
		const source = nodeCenter(edge.from, rankIndex, layout);
		const targetRank = layout.rankByNodeId.get(edge.to);
		if (source === undefined || targetRank === undefined) continue;
		const target = nodeCenter(edge.to, targetRank, layout);
		if (target === undefined) continue;
		if (targetRank === nextRankIndex) directEdges.push({ edge, source, target });
		else skippedEdges.push(edge);
	}
	const rows = renderWorkflowGraphConnectorRows(directEdges, layout.totalWidth);
	const labeledEdges = [
		...directEdges.filter(routed => routed.edge.condition !== undefined).map(routed => routed.edge),
		...skippedEdges,
	];
	for (const edge of labeledEdges) rows.push(`  edge ${edge.from} to ${formatEdgeTarget(edge)}`);
	return rows;
}

interface RoutedWorkflowGraphEdge {
	edge: WorkflowGraphEdgeView;
	source: number;
	target: number;
}

function renderWorkflowGraphConnectorRows(edges: RoutedWorkflowGraphEdge[], width: number): string[] {
	if (edges.length === 0) return [];
	const grid = createConnectorGrid(3, width);
	const targets = new Set<number>();
	for (const edge of edges) {
		drawConnectorStem(grid, 0, edge.source);
		drawConnectorBus(grid, 1, edge.source, edge.target);
		targets.add(edge.target);
	}
	for (const target of targets) {
		drawConnectorLanding(grid, 2, target);
	}
	return grid.map(row => connectorRowToString(row)).filter(line => line.trim().length > 0);
}

function hasIncomingWorkflowGraphConnector(nodeId: string, rankIndex: number, layout: WorkflowGraphLayout): boolean {
	if (rankIndex === 0) return false;
	return layout.forwardEdges.some(edge => {
		if (edge.to !== nodeId) return false;
		return layout.rankByNodeId.get(edge.from) === rankIndex - 1;
	});
}

function hasOutgoingWorkflowGraphConnector(nodeId: string, rankIndex: number, layout: WorkflowGraphLayout): boolean {
	return layout.forwardEdges.some(edge => {
		if (edge.from !== nodeId) return false;
		return layout.rankByNodeId.get(edge.to) === rankIndex + 1;
	});
}

function nodeCenter(nodeId: string, rankIndex: number, layout: WorkflowGraphLayout): number | undefined {
	const rank = layout.ranks[rankIndex];
	if (rank === undefined) return undefined;
	const nodeIndex = rank.findIndex(node => node.id === nodeId);
	if (nodeIndex === -1) return undefined;
	const rankContentWidth = rankWidth(rank.length, layout.nodeWidth);
	const leftOffset = Math.max(0, Math.floor((layout.totalWidth - rankContentWidth) / 2));
	return leftOffset + nodeIndex * (layout.nodeWidth + NODE_GAP_WIDTH) + Math.floor(layout.nodeWidth / 2);
}

function renderWorkflowGraphLoopbacks(edges: WorkflowGraphEdgeView[]): string[] {
	const lines = ["╭─ loopbacks"];
	for (let index = 0; index < edges.length; index += 1) {
		const branch = index === edges.length - 1 ? "╰" : "├";
		const edge = edges[index]!;
		lines.push(`${branch}─ ${edge.from} back to ${formatEdgeTarget(edge)}`);
	}
	return lines;
}

interface ConnectorCell {
	up: boolean;
	down: boolean;
	left: boolean;
	right: boolean;
}

type ConnectorDirection = "up" | "down" | "left" | "right";
type ConnectorGrid = ConnectorCell[][];

function createConnectorGrid(rows: number, width: number): ConnectorGrid {
	return Array.from({ length: rows }, () =>
		Array.from({ length: Math.max(1, width) }, () => ({
			up: false,
			down: false,
			left: false,
			right: false,
		})),
	);
}

function drawConnectorStem(grid: ConnectorGrid, row: number, column: number): void {
	addConnectorDirection(grid, row, column, "up");
	addConnectorDirection(grid, row, column, "down");
}

function drawConnectorBus(grid: ConnectorGrid, row: number, source: number, target: number): void {
	if (source === target) {
		addConnectorDirection(grid, row, source, "up");
		addConnectorDirection(grid, row, source, "down");
		return;
	}
	const left = Math.min(source, target);
	const right = Math.max(source, target);
	for (let column = left + 1; column < right; column += 1) {
		addConnectorDirection(grid, row, column, "left");
		addConnectorDirection(grid, row, column, "right");
	}
	addConnectorDirection(grid, row, source, "up");
	addConnectorDirection(grid, row, source, source < target ? "right" : "left");
	addConnectorDirection(grid, row, target, "down");
	addConnectorDirection(grid, row, target, source < target ? "left" : "right");
}

function drawConnectorLanding(grid: ConnectorGrid, row: number, column: number): void {
	addConnectorDirection(grid, row, column, "up");
	addConnectorDirection(grid, row, column, "down");
}

function addConnectorDirection(grid: ConnectorGrid, row: number, column: number, direction: ConnectorDirection): void {
	const cell = grid[row]?.[column];
	if (cell === undefined) return;
	cell[direction] = true;
}

function connectorRowToString(row: ConnectorCell[]): string {
	return row.map(connectorCellToChar).join("").replace(/\s+$/u, "");
}

function connectorCellToChar(cell: ConnectorCell): string {
	const { up, down, left, right } = cell;
	if (up && down && left && right) return "┼";
	if (up && down && left) return "┤";
	if (up && down && right) return "├";
	if (up && left && right) return "┴";
	if (down && left && right) return "┬";
	if (up && down) return "│";
	if (left && right) return "─";
	if (up && right) return "└";
	if (up && left) return "┘";
	if (down && right) return "┌";
	if (down && left) return "┐";
	if (up || down) return "│";
	if (left || right) return "─";
	return " ";
}

interface WorkflowGraphNodeJoints {
	incoming: boolean;
	outgoing: boolean;
}

function renderWorkflowGraphNode(
	node: WorkflowGraphNodeView,
	width: number,
	joints: WorkflowGraphNodeJoints = { incoming: false, outgoing: false },
): string[] {
	const border = node.focused ? doubleBorder() : singleBorder();
	const innerWidth = width - 2;
	const detail = formatWorkflowNodeDetail(node);
	const lines = [
		`${statusGlyph(node.status)} ${node.id}`,
		node.kind,
		detail ? `${node.status} - ${detail}` : node.status,
	];
	return [
		renderWorkflowGraphBorderLine(
			border.topLeft,
			border.horizontal,
			border.topRight,
			innerWidth,
			joints.incoming ? border.incomingTop : undefined,
		),
		...lines.map(line => `${border.vertical}${padCell(line, innerWidth)}${border.vertical}`),
		renderWorkflowGraphBorderLine(
			border.bottomLeft,
			border.horizontal,
			border.bottomRight,
			innerWidth,
			joints.outgoing ? border.outgoingBottom : undefined,
		),
	];
}

function renderWorkflowGraphBorderLine(
	left: string,
	horizontal: string,
	right: string,
	innerWidth: number,
	joint: string | undefined,
): string {
	if (joint === undefined || innerWidth <= 0) return `${left}${horizontal.repeat(innerWidth)}${right}`;
	const leftWidth = Math.floor(innerWidth / 2);
	const rightWidth = Math.max(0, innerWidth - leftWidth - 1);
	return `${left}${horizontal.repeat(leftWidth)}${joint}${horizontal.repeat(rightWidth)}${right}`;
}

function formatWorkflowNodeDetail(node: WorkflowGraphNodeView): string {
	const parts: string[] = [];
	if (node.verdict) parts.push(`verdict ${formatSingleLineWorkflowDetail(node.verdict)}`);
	if (node.summary && node.summary.trim() !== node.verdict) {
		parts.push(formatSingleLineWorkflowDetail(formatWorkflowDisplayDetail(node.summary)));
	}
	if (node.error) parts.push(`error: ${formatSingleLineWorkflowDetail(node.error)}`);
	if (node.reason) parts.push(`reason: ${formatSingleLineWorkflowDetail(node.reason)}`);
	return parts.join("; ");
}

function formatWorkflowDisplayDetail(value: string): string {
	return extractStructuredWorkflowDisplayDetail(value) ?? value;
}

function extractStructuredWorkflowDisplayDetail(value: string): string | undefined {
	const jsonText = workflowDisplayDetailJsonCandidate(value);
	if (jsonText === undefined) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonText);
	} catch {
		return undefined;
	}
	if (!isWorkflowDisplayRecord(parsed)) return undefined;
	return (
		workflowDisplayRecordString(parsed, ["summary", "message", "result", "verdict", "decision"]) ??
		workflowDisplayNestedRecordString(parsed, "data", ["summary", "message", "result", "verdict", "decision"]) ??
		workflowDisplayRecordStatus(parsed)
	);
}

function workflowDisplayDetailJsonCandidate(value: string): string | undefined {
	const trimmed = value.trim();
	if (trimmed.length === 0) return undefined;
	const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/u);
	const candidate = fenced?.[1]?.trim() ?? trimmed;
	if (!candidate.startsWith("{") || !candidate.endsWith("}")) return undefined;
	return candidate;
}

function workflowDisplayRecordString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value !== "string") continue;
		const trimmed = value.trim();
		if (trimmed.length > 0) return trimmed;
	}
	return undefined;
}

function workflowDisplayNestedRecordString(
	record: Record<string, unknown>,
	key: string,
	fields: readonly string[],
): string | undefined {
	const value = record[key];
	if (!isWorkflowDisplayRecord(value)) return undefined;
	return workflowDisplayRecordString(value, fields);
}

function workflowDisplayRecordStatus(record: Record<string, unknown>): string | undefined {
	const status = record.status;
	if (typeof status !== "string") return undefined;
	const trimmed = status.trim();
	if (trimmed.length === 0 || /^(completed?|success|ok|done)$/iu.test(trimmed)) return undefined;
	return trimmed;
}

function isWorkflowDisplayRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatEdgeTarget(edge: WorkflowGraphEdgeView): string {
	return edge.condition === undefined ? edge.to : `${edge.to} when ${formatWorkflowConditionLabel(edge.condition)}`;
}

export function formatWorkflowSelectedRoute(route: WorkflowGraphSelectedRouteView): string {
	return `${route.from} chose ${formatEdgeTarget(route)}`;
}

export function formatWorkflowConditionLabel(condition: string): string {
	const trimmed = condition.trim();
	const negated = trimmed.match(/^!\((.*)\)$/u);
	if (negated?.[1] !== undefined) {
		const simple = parseSimpleWorkflowCondition(negated[1].trim());
		if (simple !== undefined) return formatSimpleWorkflowCondition(simple, true);
	}
	const simple = parseSimpleWorkflowCondition(trimmed);
	if (simple !== undefined) return formatSimpleWorkflowCondition(simple, false);
	return trimmed;
}

interface SimpleWorkflowCondition {
	reference: string;
	operator: "==" | "!=";
	value: string;
}

function parseSimpleWorkflowCondition(condition: string): SimpleWorkflowCondition | undefined {
	const match = condition.match(/^((?:state|outputs)(?:\.[A-Za-z0-9_-]+)+)\s*(==|!=)\s*"((?:\\.|[^"])*)"$/u);
	const reference = match?.[1];
	const operator = match?.[2];
	const value = match?.[3];
	if (reference === undefined || (operator !== "==" && operator !== "!=") || value === undefined) return undefined;
	return { reference, operator, value: unescapeWorkflowConditionString(value) };
}

function formatSimpleWorkflowCondition(condition: SimpleWorkflowCondition, negated: boolean): string {
	const isPositive = condition.operator === "==" ? !negated : negated;
	const relation = isPositive ? "is" : "is not";
	return `${formatWorkflowConditionSubject(condition.reference)} ${relation} ${condition.value}`;
}

function formatWorkflowConditionSubject(reference: string): string {
	if (reference.startsWith("state.")) return formatWorkflowConditionPath(reference.slice("state.".length).split("."));
	if (reference.startsWith("outputs.")) {
		const [nodeId, ...fields] = reference.slice("outputs.".length).split(".");
		return formatWorkflowConditionPath([nodeId ?? "", ...fields]);
	}
	return reference;
}

function formatWorkflowConditionPath(parts: string[]): string {
	return parts
		.filter(part => part.length > 0)
		.map(formatWorkflowConditionIdentifier)
		.join(" ");
}

function formatWorkflowConditionIdentifier(identifier: string): string {
	return identifier
		.replaceAll("__", " ")
		.replace(/[_-]+/gu, " ")
		.replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
		.toLowerCase();
}

function unescapeWorkflowConditionString(value: string): string {
	return value.replace(/\\(["\\])/gu, "$1");
}

function padCell(text: string, width: number): string {
	const clipped = truncateToWidth(text, width, Ellipsis.Ascii);
	return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
}

function singleBorder(): {
	topLeft: string;
	topRight: string;
	bottomLeft: string;
	bottomRight: string;
	horizontal: string;
	vertical: string;
	incomingTop: string;
	outgoingBottom: string;
} {
	return {
		topLeft: "┌",
		topRight: "┐",
		bottomLeft: "└",
		bottomRight: "┘",
		horizontal: "─",
		vertical: "│",
		incomingTop: "┴",
		outgoingBottom: "┬",
	};
}

function doubleBorder(): {
	topLeft: string;
	topRight: string;
	bottomLeft: string;
	bottomRight: string;
	horizontal: string;
	vertical: string;
	incomingTop: string;
	outgoingBottom: string;
} {
	return {
		topLeft: "╔",
		topRight: "╗",
		bottomLeft: "╚",
		bottomRight: "╝",
		horizontal: "═",
		vertical: "║",
		incomingTop: "╧",
		outgoingBottom: "╤",
	};
}

function statusGlyph(status: WorkflowGraphNodeStatus): string {
	if (status === "completed") return "✓";
	if (status === "checkpointed") return "◆";
	if (status === "frontier") return "◇";
	if (status === "running") return "●";
	if (status === "failed") return "!";
	if (status === "aborted") return "×";
	return "○";
}

function countWorkflowChangeRequests(family: WorkflowRunFamilySnapshot): WorkflowGraphChangeCounts {
	const counts: WorkflowGraphChangeCounts = { approved: 0, proposed: 0, rejected: 0 };
	for (const request of family.changeRequests) {
		counts[request.status] += 1;
	}
	return counts;
}

function buildWorkflowGraphNodeStatuses(
	family: WorkflowRunFamilySnapshot,
	currentAttempt: WorkflowRunAttemptSnapshot | undefined,
	currentCheckpoint: WorkflowCheckpointSnapshot | undefined,
): Map<string, WorkflowGraphNodeStatusRecord> {
	const statuses = new Map<string, WorkflowGraphNodeStatusRecord>();
	const checkpointedActivationIds = new Set(currentCheckpoint?.completedActivationIds ?? []);
	if (currentCheckpoint) {
		for (const activationId of currentCheckpoint.completedActivationIds) {
			const activation = findWorkflowCheckpointActivation(family, currentCheckpoint, activationId);
			if (!activation) continue;
			const nodeId = currentCheckpoint.sourceMapping[activation.nodeId] ?? activation.nodeId;
			statuses.set(nodeId, {
				status: "checkpointed",
				verdict: workflowActivationOutputVerdict(activation.output),
				summary: activation.output?.summary,
				error: activation.error,
				reason: activation.reason,
			});
		}
		for (const frontierNodeId of currentCheckpoint.frontierNodeIds) {
			const nodeId = mapWorkflowCheckpointFrontierNode(
				family,
				currentCheckpoint,
				frontierNodeId,
				currentWorkflowFreeze(family),
			);
			if (!statuses.has(nodeId)) statuses.set(nodeId, { status: "frontier" });
		}
	}
	if (currentAttempt) {
		const currentAttemptOwnsCheckpoint = currentAttempt.id === currentCheckpoint?.attemptId;
		for (const activation of currentAttempt.activations) {
			statuses.set(activation.nodeId, {
				status:
					currentAttemptOwnsCheckpoint && checkpointedActivationIds.has(activation.id)
						? "checkpointed"
						: activation.status,
				verdict: workflowActivationOutputVerdict(activation.output),
				summary: activation.output?.summary,
				error: activation.error,
				reason: activation.reason,
			});
		}
	}
	return statuses;
}

interface WorkflowGraphNodeStatusRecord {
	status: WorkflowGraphNodeStatus;
	verdict?: string;
	summary?: string;
	error?: string;
	reason?: string;
}

function workflowActivationOutputVerdict(output: WorkflowActivationOutput | undefined): string | undefined {
	const verdict = output?.data?.verdict;
	return typeof verdict === "string" && verdict.length > 0 ? verdict : undefined;
}

function buildWorkflowGraphSelectedRoutes(
	currentAttempt: WorkflowRunAttemptSnapshot | undefined,
	edges: readonly WorkflowGraphEdgeView[],
): WorkflowGraphSelectedRouteView[] {
	if (currentAttempt === undefined || edges.length === 0) return [];
	const outgoingEdgesByNode = groupWorkflowGraphEdgesBySource(edges);
	const outputsByNode: Record<string, unknown> = {};
	const state: Record<string, unknown> = {};
	const selectedRoutes: WorkflowGraphSelectedRouteView[] = [];
	for (const activation of currentAttempt.activations) {
		if (activation.status !== "completed" || activation.output === undefined) continue;
		applyWorkflowGraphActivationOutputContext(activation, state, outputsByNode);
		const outgoingEdges = outgoingEdgesByNode.get(activation.nodeId);
		if (outgoingEdges === undefined || !workflowGraphSourceHasRouteChoice(outgoingEdges)) continue;
		for (const edge of outgoingEdges) {
			if (!workflowGraphEdgeIsSelected(edge, state, outputsByNode)) continue;
			selectedRoutes.push({
				from: edge.from,
				to: edge.to,
				...(edge.condition !== undefined ? { condition: edge.condition } : {}),
			});
		}
	}
	return selectedRoutes;
}

function groupWorkflowGraphEdgesBySource(
	edges: readonly WorkflowGraphEdgeView[],
): Map<string, WorkflowGraphEdgeView[]> {
	const edgesBySource = new Map<string, WorkflowGraphEdgeView[]>();
	for (const edge of edges) {
		const outgoing = edgesBySource.get(edge.from) ?? [];
		outgoing.push(edge);
		edgesBySource.set(edge.from, outgoing);
	}
	return edgesBySource;
}

function workflowGraphSourceHasRouteChoice(edges: readonly WorkflowGraphEdgeView[]): boolean {
	return edges.length > 1 || edges.some(edge => edge.condition !== undefined);
}

function applyWorkflowGraphActivationOutputContext(
	activation: WorkflowAttemptActivationRecord,
	state: Record<string, unknown>,
	outputsByNode: Record<string, unknown>,
): void {
	const output = activation.output;
	if (output === undefined) return;
	if (output.statePatch !== undefined) {
		applyWorkflowStatePatch(state, output.statePatch);
	}
	if (output.data !== undefined) {
		outputsByNode[activation.nodeId] = output.data;
	} else {
		delete outputsByNode[activation.nodeId];
	}
}

function workflowGraphEdgeIsSelected(
	edge: WorkflowGraphEdgeView,
	state: Record<string, unknown>,
	outputsByNode: Record<string, unknown>,
): boolean {
	if (edge.condition === undefined) return true;
	try {
		return evaluateWorkflowCondition(edge.condition, { state, outputs: outputsByNode });
	} catch {
		return false;
	}
}

function mapWorkflowCheckpointFrontierNode(
	family: WorkflowRunFamilySnapshot,
	checkpoint: WorkflowCheckpointSnapshot,
	frontierNodeId: string,
	freeze: WorkflowRunFamilySnapshot["freezes"][number] | undefined,
): string {
	for (const mapping of approvedWorkflowCheckpointFrontierMappings(family, checkpoint, freeze?.id)) {
		const mapped = mapping[frontierNodeId];
		if (mapped !== undefined) return mapped;
	}
	for (const mapping of migrationFrontierMappings(freeze?.definition)) {
		const mapped = mapping[frontierNodeId];
		if (mapped !== undefined) return mapped;
	}
	return checkpoint.sourceMapping[frontierNodeId] ?? frontierNodeId;
}

function currentWorkflowFreeze(
	family: WorkflowRunFamilySnapshot,
): WorkflowRunFamilySnapshot["freezes"][number] | undefined {
	const currentAttempt = family.attempts.at(-1);
	return (
		(currentAttempt ? family.freezes.find(freeze => freeze.id === currentAttempt.freezeId) : undefined) ??
		family.freezes.at(-1)
	);
}

function migrationFrontierMappings(
	definition: WorkflowRunFamilySnapshot["freezes"][number]["definition"] | undefined,
): Array<Record<string, string>> {
	return definition?.migrations?.map(migration => migration.frontierMapping) ?? [];
}

function approvedWorkflowCheckpointFrontierMappings(
	family: WorkflowRunFamilySnapshot,
	checkpoint: WorkflowCheckpointSnapshot,
	freezeId: string | undefined,
): Array<Record<string, string>> {
	if (freezeId === undefined) return [];
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

function findWorkflowCheckpointForAttempt(
	family: WorkflowRunFamilySnapshot,
	attempt: WorkflowRunAttemptSnapshot,
): WorkflowCheckpointSnapshot | undefined {
	if (attempt.checkpointId !== undefined) {
		return family.checkpoints.find(checkpoint => checkpoint.id === attempt.checkpointId);
	}
	return family.checkpoints.filter(checkpoint => checkpoint.attemptId === attempt.id).at(-1);
}

function findWorkflowCheckpointActivation(
	family: WorkflowRunFamilySnapshot,
	checkpoint: WorkflowCheckpointSnapshot,
	activationId: string,
): WorkflowAttemptActivationRecord | undefined {
	return family.attempts
		.find(attempt => attempt.id === checkpoint.attemptId)
		?.activations.find(candidate => candidate.id === activationId);
}

function isFocusedWorkflowGraphNode(status: WorkflowGraphNodeStatus): boolean {
	return status === "running" || status === "frontier" || status === "failed";
}

function formatWorkflowNodeKind(node: WorkflowNode): string {
	return formatWorkflowNodeRole(node);
}

function formatActiveWorkflowAgents(
	currentAttempt: WorkflowRunAttemptSnapshot | undefined,
	nodes: WorkflowNode[],
	options: WorkflowGraphViewOptions,
): WorkflowGraphActiveAgentView[] {
	if (!currentAttempt) return [];
	if (options.liveAttemptIds !== undefined && !options.liveAttemptIds.has(currentAttempt.id)) return [];
	const nodesById = new Map(nodes.map(node => [node.id, node]));
	const generationByNodeId = new Map<string, number>();
	const activeAgents: WorkflowGraphActiveAgentView[] = [];
	for (const activation of currentAttempt.activations) {
		const generation = (generationByNodeId.get(activation.nodeId) ?? 0) + 1;
		generationByNodeId.set(activation.nodeId, generation);
		if (activation.status !== "running") continue;
		const node = nodesById.get(activation.nodeId);
		if (!node || !workflowNodeIsAgentLike(node)) continue;
		const view: WorkflowGraphActiveAgentView = {
			activationId: activation.id,
			focusAgentId: formatWorkflowAgentFocusTarget(node.id, generation),
			nodeId: node.id,
			label: formatWorkflowNodeDisplayName(node.id),
			role: formatWorkflowNodeRole(node),
			status: "running",
		};
		if (generation > 1) view.generation = generation;
		const progress = options.activeAgentProgressById?.get(view.focusAgentId);
		const model = progress?.model ?? currentAttempt.runtimeBindingSnapshot.modelBindings?.[node.id]?.resolvedModel;
		const tool = formatWorkflowActiveAgentTool(progress);
		const activity = formatWorkflowActiveAgentActivity(progress);
		const stats = formatWorkflowActiveAgentStats(progress);
		const recentOutput = formatWorkflowActiveAgentRecentOutput(progress);
		if (model !== undefined) view.model = model;
		if (tool !== undefined) view.tool = tool;
		if (activity !== undefined) view.activity = activity;
		if (stats !== undefined) view.stats = stats;
		if (recentOutput.length > 0) view.recentOutput = recentOutput;
		if (activation.output?.summary !== undefined) view.summary = activation.output.summary;
		activeAgents.push(view);
	}
	return activeAgents;
}

function workflowNodeIsAgentLike(node: WorkflowNode): boolean {
	return node.type === "agent" || node.type === "review";
}

export function formatActiveWorkflowAgent(agent: WorkflowGraphActiveAgentView): string {
	const generation = formatActiveWorkflowAgentGeneration(agent);
	const model = agent.model === undefined ? "" : ` · ${formatSingleLineWorkflowDetail(agent.model)}`;
	const tool = agent.tool === undefined ? "" : ` · tool ${formatSingleLineWorkflowDetail(agent.tool)}`;
	const stats = agent.stats === undefined ? "" : ` · ${agent.stats}`;
	const activity = agent.activity === undefined ? "" : ` - ${formatSingleLineWorkflowDetail(agent.activity)}`;
	const summary = agent.summary === undefined ? "" : ` - ${formatSingleLineWorkflowDetail(agent.summary)}`;
	return `${agent.role} · ${agent.label} live${generation}${model}${tool}${stats}${activity}${summary} (watch/intervene ${agent.focusAgentId})`;
}

export function formatWorkflowActiveAgentGuidance(): string[] {
	return ["Agent Hub: double-left or observe to watch; Enter steers the selected agent; Esc returns."];
}

export function formatActiveWorkflowAgentGeneration(agent: WorkflowGraphActiveAgentView): string {
	return agent.generation === undefined ? "" : ` · round ${agent.generation}`;
}

function formatWorkflowAgentFocusTarget(nodeId: string, generation: number): string {
	const base = workflowAgentTaskIdForNode(nodeId);
	return generation === 1 ? base : `${base}-${generation}`;
}

function formatWorkflowActiveAgentTool(progress: WorkflowGraphActiveAgentProgress | undefined): string | undefined {
	if (progress?.currentTool === undefined) return undefined;
	const args = progress.currentToolArgs?.trim();
	if (!args) return progress.currentTool;
	return `${progress.currentTool} ${formatSingleLineWorkflowDetail(args)}`;
}

function formatWorkflowActiveAgentActivity(progress: WorkflowGraphActiveAgentProgress | undefined): string | undefined {
	if (progress === undefined) return undefined;
	if (progress.retryState !== undefined) {
		return `retrying provider request ${progress.retryState.attempt}/${progress.retryState.maxAttempts}: ${progress.retryState.errorMessage}`;
	}
	if (progress.lastIntent !== undefined && progress.lastIntent.trim().length > 0) {
		return progress.lastIntent;
	}
	const recent = progress.recentOutput
		?.map(line => line.trim())
		.filter(line => line.length > 0)
		.at(-1);
	return recent;
}

function formatWorkflowActiveAgentRecentOutput(progress: WorkflowGraphActiveAgentProgress | undefined): string[] {
	return (
		progress?.recentOutput
			?.map(line => formatSingleLineWorkflowDetail(line))
			.filter(line => line.length > 0)
			.slice(0, WORKFLOW_RECENT_OUTPUT_PER_AGENT) ?? []
	);
}

function formatWorkflowActiveAgentStats(progress: WorkflowGraphActiveAgentProgress | undefined): string | undefined {
	if (progress === undefined) return undefined;
	const parts: string[] = [];
	if (progress.durationMs !== undefined && progress.durationMs > 0) {
		parts.push(formatWorkflowDuration(progress.durationMs));
	}
	if (progress.toolCount !== undefined && progress.toolCount > 0) {
		parts.push(`${progress.toolCount} ${progress.toolCount === 1 ? "tool" : "tools"}`);
	}
	if (
		progress.contextTokens !== undefined &&
		progress.contextTokens > 0 &&
		progress.contextWindow !== undefined &&
		progress.contextWindow > 0
	) {
		parts.push(`${Math.round((progress.contextTokens / progress.contextWindow) * 100)}% ctx`);
	}
	return parts.length === 0 ? undefined : parts.join(" · ");
}

function formatWorkflowDuration(durationMs: number): string {
	const totalSeconds = Math.max(1, Math.round(durationMs / 1000));
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes < 60) return `${minutes}m${seconds.toString().padStart(2, "0")}s`;
	const hours = Math.floor(minutes / 60);
	const remainingMinutes = minutes % 60;
	return `${hours}h${remainingMinutes.toString().padStart(2, "0")}m`;
}

function formatCheckpointFrontier(checkpoint: WorkflowGraphCheckpointView): string {
	if (checkpoint.frontier.length === 0) return "none";
	return checkpoint.frontier.map(entry => `${entry.from} to ${entry.to}`).join(", ");
}

export function formatOmittedAbortedOutputs(count: number): string {
	return `${count} ${count === 1 ? "activation output" : "activation outputs"} omitted`;
}

export function formatWorkflowTopology(topology: WorkflowGraphTopologyView): string {
	const parts: string[] = [];
	if (topology.parallelFanOuts > 0) {
		parts.push(`parallel fan-outs ${topology.parallelFanOuts}`);
	}
	if (topology.branchPoints > 0) parts.push(`branch points ${topology.branchPoints}`);
	if (topology.joins > 0) parts.push(`joins ${topology.joins}`);
	if (topology.loops > 0) parts.push(`loops ${topology.loops}`);
	if (topology.subflows > 0) parts.push(`subflows ${topology.subflows}`);
	return parts.length === 0 ? "linear" : parts.join(" / ");
}

export function formatWorkflowOverviewLines(view: WorkflowGraphView): string[] {
	const lines: string[] = [];
	const attempt = view.currentAttempt;
	if (attempt === undefined) {
		lines.push("Run: no attempt yet");
	} else {
		const checkpoint =
			attempt.checkpointId === undefined ? "" : ` from ${formatWorkflowShortId(attempt.checkpointId)}`;
		lines.push(`Run: ${formatWorkflowShortId(attempt.id)} ${attempt.status}${checkpoint}`);
	}
	lines.push(`Flow: ${formatWorkflowTopology(view.topology)} · ${view.nodes.length} ${pluralNode(view.nodes.length)}`);
	lines.push(`Focus: ${formatWorkflowOperatorFocus(view)}`);
	lines.push(`On-flight: ${formatWorkflowOnFlightSummary(view)}`);
	lines.push(`Changes: ${formatWorkflowChangeCounts(view.changes)}`);
	if (view.checkpoint !== undefined) {
		lines.push(`Frontier: ${formatCheckpointFrontier(view.checkpoint)}`);
		if ((view.checkpoint.omittedAbortedOutputs ?? 0) > 0) {
			lines.push(`Aborted work: ${formatOmittedAbortedOutputs(view.checkpoint.omittedAbortedOutputs ?? 0)}`);
		}
	}
	if (view.activeAgents !== undefined && view.activeAgents.length > 0) {
		lines.push(...formatWorkflowActiveAgentGuidance());
	}
	return lines;
}

export function formatWorkflowOnFlightLines(view: WorkflowGraphView): string[] {
	const lines = (view.activeAgents ?? []).map(agent => formatActiveWorkflowAgent(agent));
	if (lines.length > 0) return lines;
	const runningNodes = view.nodes.filter(node => node.status === "running");
	return runningNodes.map(node => `${formatWorkflowNodeDisplayName(node.id)} running`);
}

export function formatWorkflowRecentOutputLines(view: WorkflowGraphView): string[] {
	const lines: string[] = [];
	for (const agent of view.activeAgents ?? []) {
		for (const output of agent.recentOutput ?? []) {
			lines.push(`${agent.role} · ${agent.label} stdout: ${output}`);
		}
	}
	for (const node of view.nodes) {
		if (node.status === "failed" && node.error !== undefined) {
			lines.push(`${formatWorkflowNodeDisplayName(node.id)} stderr: ${formatSingleLineWorkflowDetail(node.error)}`);
		}
	}
	return lines.slice(0, WORKFLOW_RECENT_OUTPUT_LINES);
}

export function formatWorkflowChangeReviewLines(view: WorkflowGraphView): string[] {
	return view.lineage.map(request => {
		const actor = request.actor === undefined ? "" : ` by ${request.actor}`;
		const applied = request.applications.length === 0 ? "" : " · applied";
		return `${request.id} ${request.status}${actor}${applied} - ${formatSingleLineWorkflowDetail(request.reason)}`;
	});
}

export function formatWorkflowControlLines(view: WorkflowGraphView): string[] {
	return view.actions.map(formatWorkflowControlAction);
}

function formatWorkflowControlAction(action: string): string {
	const normalized = action
		.replace("Active agents:", "Open manager:")
		.replace("Focused prompt:", "Steer selected agent:");
	const separator = normalized.indexOf(": ");
	if (separator === -1) return normalized;
	const label = normalized.slice(0, separator);
	const command = normalized.slice(separator + 2);
	if (!command.startsWith("/workflow") && !command.startsWith("Agent Hub") && !command.startsWith("double-left")) {
		return normalized;
	}
	return `${label} · ${command}`;
}

export function formatWorkflowOperatorFocus(view: WorkflowGraphView): string {
	const activeAgents = view.activeAgents ?? [];
	if (activeAgents.length > 0) {
		return `live ${activeAgents.map(formatWorkflowOperatorAgentFocus).join(" / ")}`;
	}
	const failed = view.nodes
		.filter(node => node.status === "failed")
		.map(node => formatWorkflowNodeDisplayName(node.id));
	if (failed.length > 0) return `failed ${failed.join(" / ")}`;
	const running = view.nodes
		.filter(node => node.status === "running")
		.map(node => formatWorkflowNodeDisplayName(node.id));
	if (running.length > 0) return `running ${running.join(" / ")}`;
	const frontier = view.nodes
		.filter(node => node.status === "frontier")
		.map(node => formatWorkflowNodeDisplayName(node.id));
	if (frontier.length > 0) return `frontier ${frontier.join(" / ")}`;
	if (view.currentAttempt?.status === "completed") return "completed";
	return "waiting";
}

function formatWorkflowOperatorAgentFocus(agent: WorkflowGraphActiveAgentView): string {
	return `${agent.role} · ${agent.label}${formatActiveWorkflowAgentGeneration(agent)}`;
}

export function formatWorkflowSubflow(subflow: WorkflowGraphSubflowView): string {
	const entries = subflow.entryNodeIds.map(nodeId => formatSubflowNodeReference(subflow, nodeId)).join(", ") || "none";
	const exits = subflow.exitNodeIds.map(nodeId => formatSubflowNodeReference(subflow, nodeId)).join(", ") || "none";
	const resources = subflow.resourcePrefix === undefined ? "" : ` · resources ${subflow.resourcePrefix}`;
	return `${subflow.alias} calls ${subflow.name}@${subflow.version} · ${subflow.nodeCount} ${pluralNode(subflow.nodeCount)} · entry ${entries} · exit ${exits}${resources}`;
}

function formatSubflowNodeReference(subflow: WorkflowGraphSubflowView, nodeId: string): string {
	return nodeId.startsWith(subflow.namespace) ? nodeId.slice(subflow.namespace.length) : nodeId;
}

function formatWorkflowChangeCounts(changes: WorkflowGraphChangeCounts): string {
	const parts: string[] = [];
	if (changes.approved > 0) parts.push(`${changes.approved} approved`);
	if (changes.proposed > 0) parts.push(`${changes.proposed} proposed`);
	if (changes.rejected > 0) parts.push(`${changes.rejected} rejected`);
	return parts.length === 0 ? "none" : parts.join(" / ");
}

function formatWorkflowOnFlightSummary(view: WorkflowGraphView): string {
	const activeAgents = view.activeAgents ?? [];
	if (activeAgents.length > 0) {
		return activeAgents
			.map(agent => `${agent.role} · ${agent.label}${formatActiveWorkflowAgentGeneration(agent)}`)
			.join(" / ");
	}
	const runningNodes = view.nodes.filter(node => node.status === "running");
	if (runningNodes.length > 0) return runningNodes.map(node => formatWorkflowNodeDisplayName(node.id)).join(" / ");
	return "none";
}

function pluralNode(count: number): string {
	return count === 1 ? "node" : "nodes";
}

function formatWorkflowShortId(id: string): string {
	const checkpoint = id.match(/(?:^|:)(checkpoint-[^:]+)$/u)?.[1];
	if (checkpoint !== undefined) return checkpoint;
	const attempt = id.match(/(?:^|:)(attempt-[^:]+)$/u)?.[1];
	if (attempt !== undefined) return attempt;
	if (id.startsWith("flowfreeze:")) return `freeze ${id.slice("flowfreeze:".length, "flowfreeze:".length + 8)}`;
	return id;
}

function formatLineage(request: WorkflowChangeRequestRecord): WorkflowGraphLineageView {
	const view: WorkflowGraphLineageView = {
		id: request.id,
		status: request.status,
		reason: request.reason,
		applications: request.applications.map(formatWorkflowChangeApplication),
	};
	if (request.approvedBy !== undefined) view.actor = request.approvedBy;
	if (request.rejectedBy !== undefined) view.actor = request.rejectedBy;
	return view;
}

function formatWorkflowChangeApplication(application: WorkflowChangeRequestRecord["applications"][number]): string {
	const targetId = application.freezeId ?? application.draftId;
	return targetId === undefined
		? `${application.target}:${application.actor}`
		: `${application.target}:${targetId}:${application.actor}`;
}

function formatWorkflowGraphActions(
	family: WorkflowRunFamilySnapshot,
	currentAttempt: WorkflowRunAttemptSnapshot | undefined,
	currentCheckpoint: WorkflowCheckpointSnapshot | undefined,
	options: WorkflowGraphViewOptions,
	activeAgents: readonly WorkflowGraphActiveAgentView[],
): string[] {
	const latestFreeze = family.freezes.at(-1);
	const actions = [`Refresh: /workflow graph --family-id ${family.id}`];
	if (currentAttempt?.status === "running") {
		actions.push(`Stop attempt: /workflow stop ${currentAttempt.id} --deadline-ms 30000`);
		if (currentAttempt.activations.some(activation => activation.status === "running")) {
			const hasLiveAttempt = options.liveAttemptIds === undefined || options.liveAttemptIds.has(currentAttempt.id);
			if (!hasLiveAttempt || activeAgents.length === 0) {
				actions.push(`Status: /workflow manager --family-id ${family.id}`);
			} else {
				actions.push(`Active agents: /workflow manager --family-id ${family.id}`);
				for (const agent of activeAgents) {
					actions.push(
						`Interrupt ${agent.role} · ${agent.label}: /workflow interrupt ${currentAttempt.id} ${agent.focusAgentId} --deadline-ms 30000`,
					);
				}
				const focusTargets = activeAgents.map(agent => agent.focusAgentId).join(" or ");
				const targetHint = focusTargets.length === 0 ? "the selected live agent" : focusTargets;
				actions.push(`Open Agent Hub: double-left or observe key; watch/intervene ${targetHint}`);
				actions.push(
					"Focused prompt: Agent Hub Enter attaches to the selected agent; Esc returns to workflow control",
				);
			}
		}
	}
	actions.push(`Propose change: /workflow request-change <file> --family-id ${family.id}`);
	const proposed = family.changeRequests.filter(request => request.status === "proposed");
	for (const request of proposed) {
		actions.push(`Approve: /workflow approve-change ${request.id} --actor human`);
		actions.push(`Reject: /workflow reject-change ${request.id} --actor human --reason <reason>`);
	}
	for (const request of family.changeRequests.filter(
		request => request.status === "approved" && request.applications.length === 0,
	)) {
		if (latestFreeze !== undefined) {
			actions.push(
				`Apply change: /workflow apply-change ${request.id} --freeze-id ${latestFreeze.id} --actor human`,
			);
		}
	}
	if (currentCheckpoint) {
		const runningResume = findRunningWorkflowCheckpointResumeAttempt(family, currentCheckpoint.id);
		if (runningResume !== undefined)
			actions.push(`Resume in progress: ${runningResume.id} from ${currentCheckpoint.id}`);
		else actions.push(`Restart: /workflow restart ${currentCheckpoint.id} --background`);
	}
	return actions;
}

function formatSingleLineWorkflowDetail(value: string): string {
	const compact = value.replace(/\s+/g, " ").trim();
	if (compact.length <= WORKFLOW_DETAIL_PREVIEW_CHARS) return compact;
	return `${compact.slice(0, WORKFLOW_DETAIL_PREVIEW_CHARS - 3)}...`;
}
