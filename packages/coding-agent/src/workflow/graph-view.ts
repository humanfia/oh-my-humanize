import { Ellipsis, sliceByColumn, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import { workflowAgentTaskIdForNode } from "./agent-task-id";
import {
	evaluateWorkflowCondition,
	parseWorkflowCondition,
	type WorkflowComparisonCondition,
	type WorkflowConditionAst,
	type WorkflowConditionLiteral,
	type WorkflowConditionOperator,
} from "./condition";
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
	focus?: WorkflowGraphFocusView;
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

export interface WorkflowGraphFocusView {
	nodeId: string;
	label: string;
	role: string;
	status: WorkflowGraphNodeStatus;
	activationId?: string;
	activationOrdinal?: number;
	activationCount?: number;
	focusAgentId?: string;
	generation?: number;
	model?: string;
	tool?: string;
	stats?: string;
	activity?: string;
	summary?: string;
	error?: string;
	reason?: string;
	humanPrompt?: string;
	recentOutput?: string[];
	controls?: string[];
	artifacts?: string[];
}

export interface WorkflowGraphNodeActivationView {
	id: string;
	ordinal: number;
	status: WorkflowAttemptActivationRecord["status"];
	verdict?: string;
	summary?: string;
	error?: string;
	reason?: string;
	focusAgentId?: string;
	generation?: number;
	model?: string;
	tool?: string;
	stats?: string;
	activity?: string;
	humanPrompt?: string;
	recentOutput?: string[];
	artifacts?: string[];
}

export interface WorkflowGraphNodeView {
	id: string;
	kind: string;
	status: WorkflowGraphNodeStatus;
	activationCount?: number;
	activations?: WorkflowGraphNodeActivationView[];
	verdict?: string;
	summary?: string;
	error?: string;
	reason?: string;
	humanPrompt?: string;
	focused: boolean;
}

export interface WorkflowGraphEdgeView {
	from: string;
	to: string;
	condition?: string;
	label?: string;
}

export interface WorkflowGraphSelectedRouteView {
	from: string;
	to: string;
	condition?: string;
	label?: string;
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
const MIN_NODE_WIDTH = 23;
const DEFAULT_NODE_WIDTH = 43;
const MAX_NODE_WIDTH = 41;
const NODE_GAP_WIDTH = 3;
const LOOP_RAIL_GAP_WIDTH = 3;
const LOOP_RAIL_STEP_WIDTH = 4;
const LOOP_RAIL_LABEL_MIN_WIDTH = 40;

export function buildWorkflowGraphView(
	family: WorkflowRunFamilySnapshot,
	options: WorkflowGraphViewOptions = {},
): WorkflowGraphView {
	const latestFreeze = family.freezes.at(-1);
	const currentAttempt = family.attempts.at(-1);
	const currentCheckpoint = currentAttempt ? findWorkflowCheckpointForAttempt(family, currentAttempt) : undefined;
	const checkpointRestartFreeze =
		currentAttempt?.status === "running" || currentCheckpoint === undefined
			? undefined
			: workflowRestartFreezeForCheckpoint(family, currentCheckpoint);
	const currentFreeze =
		checkpointRestartFreeze ??
		(currentAttempt ? family.freezes.find(freeze => freeze.id === currentAttempt.freezeId) : undefined) ??
		latestFreeze;
	const nodeStatuses = buildWorkflowGraphNodeStatuses(family, currentAttempt, currentCheckpoint, currentFreeze);
	const nodeActivationCounts =
		currentAttempt === undefined ? undefined : buildWorkflowGraphNodeActivationCounts(currentAttempt);
	const nodeActivations =
		currentAttempt === undefined
			? undefined
			: buildWorkflowGraphNodeActivations(currentAttempt, currentFreeze?.definition.nodes ?? [], options);
	const nodes =
		currentFreeze?.definition.nodes.map(node => {
			const status = nodeStatuses.get(node.id) ?? { status: "pending" as const };
			const activations = nodeActivations?.get(node.id) ?? [];
			const view: WorkflowGraphNodeView = {
				id: node.id,
				kind: formatWorkflowNodeKind(node),
				status: status.status,
				focused: isFocusedWorkflowGraphNode(status.status),
			};
			if (nodeActivationCounts !== undefined) view.activationCount = nodeActivationCounts.get(node.id) ?? 0;
			if (activations.length > 0) view.activations = activations;
			if (status.verdict !== undefined) view.verdict = status.verdict;
			if (status.summary !== undefined) view.summary = status.summary;
			if (status.error !== undefined) view.error = status.error;
			if (status.reason !== undefined) view.reason = status.reason;
			const focusedActivation = selectedWorkflowGraphNodeActivation(view, undefined);
			if (focusedActivation?.humanPrompt !== undefined) view.humanPrompt = focusedActivation.humanPrompt;
			return view;
		}) ?? [];
	const edges =
		currentFreeze?.definition.edges.map(edge => {
			const view: WorkflowGraphEdgeView = { from: edge.from, to: edge.to };
			if (edge.condition?.source !== undefined) view.condition = edge.condition.source;
			if (edge.label !== undefined) view.label = edge.label;
			return view;
		}) ?? [];
	const topology = buildWorkflowGraphTopology(nodes, edges, currentFreeze?.definition.subflows?.length ?? 0);
	const selectedRoutes = buildWorkflowGraphSelectedRoutes(currentAttempt, edges);
	const activeAgents = formatActiveWorkflowAgents(currentAttempt, currentFreeze?.definition.nodes ?? [], options);
	const focus = buildWorkflowGraphFocus(nodes, activeAgents, currentAttempt);
	const view: WorkflowGraphView = {
		familyId: family.id,
		changes: countWorkflowChangeRequests(family),
		topology,
		nodes,
		edges,
		lineage: family.changeRequests.map(formatLineage),
		actions: formatWorkflowGraphActions(
			family,
			currentAttempt,
			currentCheckpoint,
			options,
			activeAgents,
			currentFreeze?.definition.nodes ?? [],
		),
	};
	if (selectedRoutes.length > 0) view.selectedRoutes = selectedRoutes;
	if (focus !== undefined) view.focus = focus;
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
	const focus = formatWorkflowFocusLines(view);
	if (focus.length > 0) {
		lines.push("Focused node:");
		for (const line of focus) lines.push(`- ${line}`);
	}
	if (view.subflows !== undefined && view.subflows.length > 0) {
		lines.push("Flow calls:");
		for (const subflow of view.subflows) lines.push(`- ${formatWorkflowSubflow(subflow)}`);
	}
	const onFlight = formatWorkflowOnFlightLines(view);
	if (onFlight.length > 0) {
		lines.push("On-flight:");
		for (const line of onFlight) lines.push(`- ${line}`);
	}
	const recentActivity = formatWorkflowRecentActivityLines(view);
	if (recentActivity.length > 0) {
		lines.push("Recent activity:");
		for (const line of recentActivity) lines.push(`- ${line}`);
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
	const nodeLineById = new Map<string, number>();
	const nodeBoxesById = new Map<string, WorkflowGraphNodeBox>();
	for (let rankIndex = 0; rankIndex < layout.ranks.length; rankIndex += 1) {
		const rankLines = renderWorkflowGraphRank(rankIndex, layout);
		const rankStartLine = lines.length;
		lines.push(...rankLines);
		const nodeLine = rankStartLine + Math.floor(rankLines.length / 2);
		for (const node of layout.ranks[rankIndex] ?? []) {
			nodeLineById.set(node.id, nodeLine);
			const box = workflowGraphNodeBox(node.id, rankIndex, rankStartLine, rankLines.length, layout);
			if (box !== undefined) nodeBoxesById.set(node.id, box);
		}
		const connectorLines = renderWorkflowGraphConnector(rankIndex, layout);
		lines.push(...connectorLines);
		if (rankIndex < layout.ranks.length - 1 && connectorLines.length === 0) lines.push("");
	}
	return renderWorkflowGraphLoopbackRails(lines, layout.backEdges, nodeLineById, nodeBoxesById, layout);
}

interface WorkflowGraphLayout {
	ranks: WorkflowGraphNodeView[][];
	rankByNodeId: Map<string, number>;
	forwardEdges: WorkflowGraphEdgeView[];
	backEdges: WorkflowGraphEdgeView[];
	nodeWidth: number;
	totalWidth: number;
	labelWidth: number;
}

interface WorkflowGraphNodeBox {
	nodeId: string;
	topLine: number;
	bottomLine: number;
	leftColumn: number;
	rightColumn: number;
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
	const nodeWidth = workflowGraphNodeWidth(width, maxRankSize, backEdges.length);
	const totalWidth = workflowGraphCanvasWidth(width, rankWidth(maxRankSize, nodeWidth), backEdges.length);
	const labelWidth =
		width === undefined || !Number.isFinite(width) ? totalWidth : Math.max(totalWidth, Math.floor(width));
	return {
		ranks,
		rankByNodeId,
		forwardEdges,
		backEdges,
		nodeWidth,
		totalWidth,
		labelWidth,
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

function workflowGraphNodeWidth(width: number | undefined, maxRankSize: number, loopRailCount: number): number {
	if (width === undefined || !Number.isFinite(width)) return DEFAULT_NODE_WIDTH;
	const safeRankSize = Math.max(1, maxRankSize);
	const available =
		Math.floor(width) - NODE_GAP_WIDTH * (safeRankSize - 1) - workflowGraphLoopRailReserve(loopRailCount);
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

function workflowGraphCanvasWidth(width: number | undefined, rankContentWidth: number, loopRailCount: number): number {
	if (width === undefined || !Number.isFinite(width)) return rankContentWidth;
	const visualWidth = Math.max(1, Math.floor(width));
	const loopRailReserve = workflowGraphLoopRailReserve(loopRailCount);
	const availableCanvasWidth = Math.max(1, visualWidth - loopRailReserve);
	return Math.max(rankContentWidth, availableCanvasWidth);
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
	const skippedEdges: SkippedWorkflowGraphEdge[] = [];
	for (const edge of routedEdges) {
		const source = nodeCenter(edge.from, rankIndex, layout);
		const targetRank = layout.rankByNodeId.get(edge.to);
		if (source === undefined || targetRank === undefined) continue;
		const target = nodeCenter(edge.to, targetRank, layout);
		if (target === undefined) continue;
		if (targetRank === nextRankIndex) directEdges.push({ edge, source, target });
		else skippedEdges.push({ edge, source });
	}
	const rows = renderWorkflowGraphConnectorRows(directEdges, layout.totalWidth);
	const directLabels = directEdges
		.filter(routed => workflowGraphEdgeHasLabel(routed.edge))
		.map(routed =>
			renderWorkflowGraphConnectorLabel(
				routed.target,
				layout.labelWidth,
				formatWorkflowGraphEdgeRouteLabel(routed.edge),
			),
		);
	const skippedLabels = skippedEdges.map(routed =>
		renderWorkflowGraphConnectorLabel(
			routed.source,
			layout.labelWidth,
			formatWorkflowGraphSkippedRouteLabel(routed.edge),
			"▼",
		),
	);
	if (directLabels.length === 0) return [...rows, ...skippedLabels];
	const labelInsertionIndex = rows.length <= 1 ? rows.length : rows.length - 1;
	return [
		...rows.slice(0, labelInsertionIndex),
		...directLabels,
		...rows.slice(labelInsertionIndex),
		...skippedLabels,
	];
}

interface RoutedWorkflowGraphEdge {
	edge: WorkflowGraphEdgeView;
	source: number;
	target: number;
}

interface RoutedWorkflowGraphEdgeWithLane extends RoutedWorkflowGraphEdge {
	lane: number;
}

interface SkippedWorkflowGraphEdge {
	edge: WorkflowGraphEdgeView;
	source: number;
}

function renderWorkflowGraphConnectorRows(edges: RoutedWorkflowGraphEdge[], width: number): string[] {
	if (edges.length === 0) return [];
	const routed = assignWorkflowGraphConnectorLanes(edges);
	const laneCount = Math.max(1, ...routed.map(edge => edge.lane + 1));
	const landingRow = laneCount + 1;
	const grid = createConnectorGrid(landingRow + 1, width);
	for (const edge of routed) {
		const busRow = edge.lane + 1;
		for (let row = 0; row < busRow; row += 1) drawConnectorStem(grid, row, edge.source);
		drawConnectorBus(grid, busRow, edge.source, edge.target);
		for (let row = busRow + 1; row < landingRow; row += 1) drawConnectorStem(grid, row, edge.target);
		drawConnectorLanding(grid, landingRow, edge.target);
	}
	return grid.map(row => connectorRowToString(row)).filter(line => line.trim().length > 0);
}

function assignWorkflowGraphConnectorLanes(
	edges: readonly RoutedWorkflowGraphEdge[],
): RoutedWorkflowGraphEdgeWithLane[] {
	const laneIntervals: WorkflowGraphInterval[][] = [];
	return edges.map(edge => {
		const interval = workflowGraphEdgeInterval(edge);
		let lane = laneIntervals.findIndex(intervals =>
			intervals.every(existing => workflowGraphIntervalsHaveMinimumGap(existing, interval)),
		);
		if (lane === -1) {
			lane = laneIntervals.length;
			laneIntervals.push([]);
		}
		laneIntervals[lane]!.push(interval);
		return { ...edge, lane };
	});
}

interface WorkflowGraphInterval {
	left: number;
	right: number;
}

function workflowGraphEdgeInterval(edge: RoutedWorkflowGraphEdge): WorkflowGraphInterval {
	return { left: Math.min(edge.source, edge.target), right: Math.max(edge.source, edge.target) };
}

function workflowGraphIntervalsHaveMinimumGap(a: WorkflowGraphInterval, b: WorkflowGraphInterval): boolean {
	return a.right + 1 < b.left || b.right + 1 < a.left;
}

function renderWorkflowGraphConnectorLabel(column: number, width: number, label: string, marker = "│"): string {
	const safeColumn = Math.max(0, Math.min(column, Math.max(0, width - 1)));
	const suffixWidth = Math.max(0, width - safeColumn - 1);
	const suffix = suffixWidth === 0 ? "" : truncateToWidth(`  ${label}`, suffixWidth, Ellipsis.Ascii);
	return `${" ".repeat(safeColumn)}${marker}${suffix}`.trimEnd();
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

function renderWorkflowGraphLoopbackRails(
	lines: string[],
	backEdges: readonly WorkflowGraphEdgeView[],
	nodeLineById: ReadonlyMap<string, number>,
	nodeBoxesById: ReadonlyMap<string, WorkflowGraphNodeBox>,
	layout: WorkflowGraphLayout,
): string[] {
	if (backEdges.length === 0) return lines;
	const rendered = [...lines];
	const labelsByLine = new Map<number, string[]>();
	const labelColumn = workflowGraphLoopRailLabelColumn(layout.totalWidth, backEdges.length);
	for (let index = 0; index < backEdges.length; index += 1) {
		const edge = backEdges[index]!;
		const sourceLine = nodeLineById.get(edge.from);
		const targetLine = nodeLineById.get(edge.to);
		if (sourceLine === undefined || targetLine === undefined) continue;
		const sourceRight = nodeRightEdge(edge.from, layout);
		const targetRight = nodeRightEdge(edge.to, layout);
		if (sourceRight === undefined || targetRight === undefined) continue;
		const column = workflowGraphLoopRailColumn(layout.totalWidth, index);
		drawWorkflowGraphLoopbackPath(rendered, {
			sourceLine,
			sourceRight,
			targetLine,
			targetRight,
			railColumn: column,
			nodeBoxes: nodeBoxesById,
		});
		const labels = labelsByLine.get(sourceLine) ?? [];
		labels.push(formatWorkflowGraphLoopbackLabel(edge));
		labelsByLine.set(sourceLine, labels);
	}
	for (const [lineIndex, labels] of labelsByLine) {
		const label = formatWorkflowGraphLoopbackLabels(labels, labelColumn, layout.labelWidth);
		if (label.length > 0)
			rendered[lineIndex] = putWorkflowGraphTextAtColumn(rendered[lineIndex] ?? "", labelColumn, label);
	}
	return rendered;
}

function workflowGraphLoopRailReserve(railCount: number): number {
	return railCount === 0 ? 0 : LOOP_RAIL_GAP_WIDTH + railCount * LOOP_RAIL_STEP_WIDTH + LOOP_RAIL_LABEL_MIN_WIDTH;
}

function workflowGraphLoopRailColumn(maxWidth: number, index: number): number {
	return maxWidth + LOOP_RAIL_GAP_WIDTH + index * LOOP_RAIL_STEP_WIDTH;
}

function workflowGraphLoopRailLabelColumn(maxWidth: number, railCount: number): number {
	return workflowGraphLoopRailColumn(maxWidth, Math.max(0, railCount - 1)) + 3;
}

function formatWorkflowGraphLoopbackLabels(labels: readonly string[], labelColumn: number, width: number): string {
	const suffixWidth = Math.max(0, Math.floor(width) - labelColumn);
	if (suffixWidth <= 0) return "";
	return truncateToWidth(labels.join("; "), suffixWidth, Ellipsis.Ascii);
}

function formatWorkflowGraphLoopbackLabel(edge: WorkflowGraphEdgeView): string {
	if (edge.condition === undefined) return `↺ ${edge.to}`;
	return `↺ ${edge.to} · ${formatWorkflowGraphEdgeRouteLabel(edge)}`;
}

interface WorkflowGraphLoopbackPath {
	sourceLine: number;
	sourceRight: number;
	targetLine: number;
	targetRight: number;
	railColumn: number;
	nodeBoxes: ReadonlyMap<string, WorkflowGraphNodeBox>;
}

function drawWorkflowGraphLoopbackPath(lines: string[], path: WorkflowGraphLoopbackPath): void {
	if (path.sourceLine === path.targetLine) {
		drawWorkflowGraphLoopBranch(lines, path.sourceLine, path.sourceRight, path.railColumn, path.nodeBoxes);
		drawWorkflowGraphConnectorAtColumn(lines, path.sourceLine, path.railColumn, {
			left: true,
			arrowRight: true,
		});
		return;
	}
	const sourceGoesUp = path.targetLine < path.sourceLine;
	const topLine = Math.min(path.sourceLine, path.targetLine);
	const bottomLine = Math.max(path.sourceLine, path.targetLine);
	drawWorkflowGraphLoopBranch(lines, path.targetLine, path.targetRight, path.railColumn, path.nodeBoxes);
	drawWorkflowGraphConnectorAtColumn(
		lines,
		path.targetLine,
		path.railColumn,
		sourceGoesUp ? { down: true, left: true } : { up: true, left: true },
		true,
	);
	for (let lineIndex = topLine + 1; lineIndex < bottomLine; lineIndex += 1) {
		drawWorkflowGraphConnectorAtColumn(lines, lineIndex, path.railColumn, { up: true, down: true });
	}
	const arrowLine = sourceGoesUp ? path.targetLine + 1 : path.targetLine - 1;
	if (arrowLine > topLine && arrowLine < bottomLine) {
		drawWorkflowGraphConnectorAtColumn(
			lines,
			arrowLine,
			path.railColumn,
			sourceGoesUp ? { up: true, down: true, arrowUp: true } : { up: true, down: true, arrowDown: true },
		);
	}
	drawWorkflowGraphLoopBranch(lines, path.sourceLine, path.sourceRight, path.railColumn, path.nodeBoxes);
	drawWorkflowGraphConnectorAtColumn(
		lines,
		path.sourceLine,
		path.railColumn,
		sourceGoesUp ? { up: true, left: true } : { down: true, left: true },
		true,
	);
}

function drawWorkflowGraphLoopBranch(
	lines: string[],
	lineIndex: number,
	nodeRightColumn: number,
	railColumn: number,
	nodeBoxes: ReadonlyMap<string, WorkflowGraphNodeBox>,
): void {
	if (railColumn <= nodeRightColumn) return;
	drawWorkflowGraphConnectorAtColumn(lines, lineIndex, nodeRightColumn, {
		up: true,
		down: true,
		right: true,
	});
	for (let column = nodeRightColumn + 1; column < railColumn; column += 1) {
		drawWorkflowGraphConnectorAtColumn(lines, lineIndex, column, { left: true, right: true }, false, {
			occluded: workflowGraphCellIsCoveredByNode(lineIndex, column, nodeBoxes),
		});
	}
}

function drawWorkflowGraphConnectorAtColumn(
	lines: string[],
	lineIndex: number,
	column: number,
	directions: Partial<ConnectorCell>,
	roundedCorner = false,
	options: { occluded?: boolean } = {},
): void {
	const existingChar = workflowGraphCharAtColumn(lines[lineIndex] ?? "", column);
	if (options.occluded === true && !workflowGraphCanReplaceOccludedCell(existingChar)) return;
	const existing = workflowGraphConnectorCellFromChar(existingChar);
	const merged: WorkflowGraphConnectorCell = {
		up: existing.up || directions.up === true,
		down: existing.down || directions.down === true,
		left: existing.left || directions.left === true,
		right: existing.right || directions.right === true,
		arrowDown: existing.arrowDown || directions.arrowDown === true,
		arrowUp: existing.arrowUp || directions.arrowUp === true,
		arrowRight: existing.arrowRight || directions.arrowRight === true,
		doubleVertical: existing.doubleVertical,
	};
	lines[lineIndex] = putWorkflowGraphTextAtColumn(
		lines[lineIndex] ?? "",
		column,
		workflowGraphConnectorCellToChar(merged, roundedCorner, options.occluded === true),
	);
}

interface WorkflowGraphConnectorCell extends ConnectorCell {
	doubleVertical?: boolean;
}

function workflowGraphCharAtColumn(line: string, column: number): string | undefined {
	const char = sliceByColumn(line, column, 1);
	return visibleWidth(char) === 0 ? undefined : char;
}

function workflowGraphConnectorCellFromChar(char: string | undefined): WorkflowGraphConnectorCell {
	const cell: WorkflowGraphConnectorCell = {
		up: false,
		down: false,
		left: false,
		right: false,
		arrowDown: false,
		arrowUp: false,
		arrowRight: false,
	};
	switch (char) {
		case "▲":
			cell.up = true;
			cell.down = true;
			cell.arrowUp = true;
			break;
		case "▼":
			cell.up = true;
			cell.down = true;
			cell.arrowDown = true;
			break;
		case "▶":
			cell.left = true;
			cell.right = true;
			cell.arrowRight = true;
			break;
		case "│":
			cell.up = true;
			cell.down = true;
			break;
		case "┆":
			cell.up = true;
			cell.down = true;
			break;
		case "║":
			cell.up = true;
			cell.down = true;
			cell.doubleVertical = true;
			break;
		case "─":
		case "═":
		case "┄":
			cell.left = true;
			cell.right = true;
			break;
		case "┌":
		case "╭":
			cell.down = true;
			cell.right = true;
			break;
		case "┐":
		case "╮":
			cell.down = true;
			cell.left = true;
			break;
		case "└":
		case "╰":
			cell.up = true;
			cell.right = true;
			break;
		case "┘":
		case "╯":
			cell.up = true;
			cell.left = true;
			break;
		case "├":
			cell.up = true;
			cell.down = true;
			cell.right = true;
			break;
		case "┤":
			cell.up = true;
			cell.down = true;
			cell.left = true;
			break;
		case "┬":
			cell.down = true;
			cell.left = true;
			cell.right = true;
			break;
		case "┴":
			cell.up = true;
			cell.left = true;
			cell.right = true;
			break;
		case "┼":
			cell.up = true;
			cell.down = true;
			cell.left = true;
			cell.right = true;
			break;
		case "╟":
			cell.up = true;
			cell.down = true;
			cell.right = true;
			cell.doubleVertical = true;
			break;
		case "╢":
			cell.up = true;
			cell.down = true;
			cell.left = true;
			cell.doubleVertical = true;
			break;
		case "╫":
			cell.up = true;
			cell.down = true;
			cell.left = true;
			cell.right = true;
			cell.doubleVertical = true;
			break;
		case "╤":
			cell.down = true;
			cell.left = true;
			cell.right = true;
			cell.doubleVertical = true;
			break;
		case "╧":
			cell.up = true;
			cell.left = true;
			cell.right = true;
			cell.doubleVertical = true;
			break;
	}
	return cell;
}

function workflowGraphConnectorCellToChar(
	cell: WorkflowGraphConnectorCell,
	roundedCorner: boolean,
	occluded = false,
): string {
	if (cell.arrowUp) return "▲";
	if (cell.arrowDown) return "▼";
	if (cell.arrowRight) return "▶";
	if (occluded) {
		if (cell.left || cell.right) return "┄";
		if (cell.up || cell.down) return "┆";
	}
	if (cell.doubleVertical === true && cell.up && cell.down) {
		if (cell.left && cell.right) return "╫";
		if (cell.right) return "╟";
		if (cell.left) return "╢";
		return "║";
	}
	if (roundedCorner) {
		if (cell.down && cell.left && !cell.up && !cell.right) return "╮";
		if (cell.up && cell.left && !cell.down && !cell.right) return "╯";
		if (cell.down && cell.right && !cell.up && !cell.left) return "╭";
		if (cell.up && cell.right && !cell.down && !cell.left) return "╰";
	}
	return connectorCellToChar(cell);
}

function workflowGraphNodeBox(
	nodeId: string,
	rankIndex: number,
	rankStartLine: number,
	rankHeight: number,
	layout: WorkflowGraphLayout,
): WorkflowGraphNodeBox | undefined {
	const leftColumn = nodeLeftEdge(nodeId, rankIndex, layout);
	if (leftColumn === undefined) return undefined;
	return {
		nodeId,
		topLine: rankStartLine,
		bottomLine: rankStartLine + rankHeight - 1,
		leftColumn,
		rightColumn: leftColumn + layout.nodeWidth - 1,
	};
}

function nodeLeftEdge(nodeId: string, rankIndex: number, layout: WorkflowGraphLayout): number | undefined {
	const rank = layout.ranks[rankIndex];
	if (rank === undefined) return undefined;
	const nodeIndex = rank.findIndex(node => node.id === nodeId);
	if (nodeIndex === -1) return undefined;
	const rankContentWidth = rankWidth(rank.length, layout.nodeWidth);
	const leftOffset = Math.max(0, Math.floor((layout.totalWidth - rankContentWidth) / 2));
	return leftOffset + nodeIndex * (layout.nodeWidth + NODE_GAP_WIDTH);
}

function nodeRightEdge(nodeId: string, layout: WorkflowGraphLayout): number | undefined {
	const rankIndex = layout.rankByNodeId.get(nodeId);
	if (rankIndex === undefined) return undefined;
	const leftEdge = nodeLeftEdge(nodeId, rankIndex, layout);
	return leftEdge === undefined ? undefined : leftEdge + layout.nodeWidth - 1;
}

function workflowGraphCellIsCoveredByNode(
	lineIndex: number,
	column: number,
	nodeBoxesById: ReadonlyMap<string, WorkflowGraphNodeBox>,
): boolean {
	for (const box of nodeBoxesById.values()) {
		if (lineIndex < box.topLine || lineIndex > box.bottomLine) continue;
		if (column > box.leftColumn && column < box.rightColumn) return true;
	}
	return false;
}

function workflowGraphCanReplaceOccludedCell(char: string | undefined): boolean {
	return char === undefined || char === " " || workflowGraphIsConnectorGlyph(char);
}

function workflowGraphIsConnectorGlyph(char: string): boolean {
	return WORKFLOW_GRAPH_CONNECTOR_GLYPHS.has(char);
}

const WORKFLOW_GRAPH_CONNECTOR_GLYPHS = new Set([
	"▲",
	"▼",
	"▶",
	"│",
	"║",
	"┆",
	"─",
	"═",
	"━",
	"┄",
	"┌",
	"┐",
	"└",
	"┘",
	"╭",
	"╮",
	"╰",
	"╯",
	"├",
	"┤",
	"┬",
	"┴",
	"┼",
	"╟",
	"╢",
	"╫",
	"╤",
	"╧",
]);

function putWorkflowGraphTextAtColumn(line: string, column: number, text: string): string {
	const safeColumn = Math.max(0, column);
	const textWidth = visibleWidth(text);
	const lineWidth = visibleWidth(line);
	const prefix = padWorkflowGraphLineToColumn(sliceByColumn(line, 0, safeColumn), safeColumn);
	const suffixStart = safeColumn + textWidth;
	const suffixWidth = Math.max(0, lineWidth - suffixStart);
	const suffix = suffixWidth === 0 ? "" : sliceByColumn(line, suffixStart, suffixWidth);
	return `${prefix}${text}${suffix}`.trimEnd();
}

function padWorkflowGraphLineToColumn(line: string, column: number): string {
	const width = visibleWidth(line);
	if (width >= column) return line;
	return `${line}${" ".repeat(column - width)}`;
}

interface ConnectorCell {
	up: boolean;
	down: boolean;
	left: boolean;
	right: boolean;
	arrowDown: boolean;
	arrowUp: boolean;
	arrowRight: boolean;
}

type ConnectorDirection = "up" | "down" | "left" | "right";
type ConnectorGrid = ConnectorCell[][];
type WorkflowConditionLabelMode = "default" | "loopback" | "route";

function createConnectorGrid(rows: number, width: number): ConnectorGrid {
	return Array.from({ length: rows }, () =>
		Array.from({ length: Math.max(1, width) }, () => ({
			up: false,
			down: false,
			left: false,
			right: false,
			arrowDown: false,
			arrowUp: false,
			arrowRight: false,
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
	const cell = grid[row]?.[column];
	if (cell !== undefined) cell.arrowDown = true;
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
	if (cell.arrowUp) return "▲";
	if (cell.arrowDown) return "▼";
	if (cell.arrowRight) return "▶";
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
	const activationCount = node.activationCount === undefined ? undefined : `runs ${node.activationCount}`;
	const metadata = activationCount === undefined ? node.kind : `${node.kind} · ${activationCount}`;
	const lines = [
		`${statusGlyph(node.status)} ${node.id}`,
		metadata,
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
	if (edge.condition === undefined) return edge.to;
	return `${edge.to} when ${workflowGraphEdgeConditionLabel(edge)}`;
}

export function formatWorkflowSelectedRoute(route: WorkflowGraphSelectedRouteView): string {
	return `${route.from} chose ${formatEdgeTarget(route)}`;
}

export function formatWorkflowConditionLabel(condition: string): string {
	const trimmed = condition.trim();
	try {
		return formatWorkflowConditionAst(parseWorkflowCondition(trimmed).ast);
	} catch {
		return formatWorkflowConditionFallback(trimmed, "default");
	}
}

function formatWorkflowRouteConditionLabel(condition: string): string {
	const trimmed = condition.trim();
	try {
		return formatWorkflowConditionAst(parseWorkflowCondition(trimmed).ast, "route");
	} catch {
		return formatWorkflowConditionFallback(trimmed, "route");
	}
}

function formatWorkflowGraphEdgeRouteLabel(edge: WorkflowGraphEdgeView): string {
	return `if ${workflowGraphEdgeConditionLabel(edge, "route")}`;
}

function formatWorkflowGraphSkippedRouteLabel(edge: WorkflowGraphEdgeView): string {
	if (edge.condition === undefined) return `to ${edge.to}`;
	return `to ${edge.to} · ${formatWorkflowGraphEdgeRouteLabel(edge)}`;
}

function workflowGraphEdgeHasLabel(edge: WorkflowGraphEdgeView): boolean {
	return edge.condition !== undefined || edge.label !== undefined;
}

function workflowGraphEdgeConditionLabel(
	edge: WorkflowGraphEdgeView,
	mode: WorkflowConditionLabelMode = "default",
): string {
	if (edge.label !== undefined) return edge.label;
	if (edge.condition === undefined) return "";
	if (mode === "route") return formatWorkflowRouteConditionLabel(edge.condition);
	return formatWorkflowConditionLabel(edge.condition);
}

function formatWorkflowConditionFallback(condition: string, mode: WorkflowConditionLabelMode): string {
	const barePath = condition.match(/^(state|outputs)(?:\.[A-Za-z0-9_-]+)+$/u);
	if (barePath !== null) {
		const subject = formatWorkflowConditionSubjectPath(condition.split("."), mode);
		return mode === "loopback" ? subject : `${subject} is present`;
	}
	return condition;
}

function formatWorkflowConditionAst(ast: WorkflowConditionAst, mode: WorkflowConditionLabelMode = "default"): string {
	switch (ast.kind) {
		case "comparison":
			return formatWorkflowComparisonCondition(ast, mode);
		case "exists":
			return `${formatWorkflowConditionSubjectPath(ast.path)} is present`;
		case "and":
		case "or":
			return `${formatWorkflowConditionAst(ast.left, mode)} ${ast.kind} ${formatWorkflowConditionAst(ast.right, mode)}`;
		case "not":
			if (ast.expression.kind === "comparison") {
				return formatWorkflowComparisonCondition(
					{
						...ast.expression,
						operator: invertWorkflowComparisonOperator(ast.expression.operator),
					},
					mode,
				);
			}
			if (ast.expression.kind === "exists") {
				return `${formatWorkflowConditionSubjectPath(ast.expression.path)} is absent`;
			}
			return `not (${formatWorkflowConditionAst(ast.expression, mode)})`;
	}
}

function formatWorkflowComparisonCondition(
	condition: WorkflowComparisonCondition,
	mode: WorkflowConditionLabelMode = "default",
): string {
	if (mode === "route") {
		const routeLabel = formatWorkflowRouteComparisonCondition(condition);
		if (routeLabel !== undefined) return routeLabel;
	}
	const subject = formatWorkflowConditionSubjectPath(condition.leftPath, mode);
	const relation = formatWorkflowComparisonRelation(condition.operator, mode);
	const value = formatWorkflowConditionLiteral(condition.right);
	return `${subject} ${relation} ${value}`;
}

function formatWorkflowRouteComparisonCondition(condition: WorkflowComparisonCondition): string | undefined {
	const subject = workflowConditionVerdictSubjectLabel(condition.leftPath);
	if (subject === undefined) return undefined;
	if (typeof condition.right !== "string" && typeof condition.right !== "boolean") return undefined;
	const value = formatWorkflowConditionLiteral(condition.right);
	if (condition.operator === "==") return subject.length === 0 ? value : `${subject}=${value}`;
	if (condition.operator === "!=") return subject.length === 0 ? `not ${value}` : `${subject}!=${value}`;
	return undefined;
}

function workflowConditionVerdictSubjectLabel(path: readonly string[]): string | undefined {
	const leaf = path.at(-1);
	if (leaf === undefined) return undefined;
	if (leaf === "verdict") {
		if (path[0] === "outputs") return "";
		return formatWorkflowConditionPath(path.slice(1, -1));
	}
	if (!/Verdict$/u.test(leaf)) return undefined;
	const subjectLeaf = leaf.replace(/Verdict$/u, "");
	return formatWorkflowConditionPath([...path.slice(1, -1), subjectLeaf]);
}

function formatWorkflowComparisonRelation(
	operator: WorkflowConditionOperator,
	mode: WorkflowConditionLabelMode = "default",
): string {
	switch (operator) {
		case "==":
			return mode === "route" ? "=" : "is";
		case "!=":
			if (mode === "route") return "!=";
			return mode === "loopback" ? "not" : "is not";
		case ">":
			return mode === "loopback" ? ">" : "is greater than";
		case ">=":
			return mode === "loopback" ? ">=" : "is at least";
		case "<":
			return mode === "loopback" ? "<" : "is less than";
		case "<=":
			return mode === "loopback" ? "<=" : "is at most";
	}
}

function invertWorkflowComparisonOperator(operator: WorkflowConditionOperator): WorkflowConditionOperator {
	switch (operator) {
		case "==":
			return "!=";
		case "!=":
			return "==";
		case ">":
			return "<=";
		case ">=":
			return "<";
		case "<":
			return ">=";
		case "<=":
			return ">";
	}
}

function formatWorkflowConditionLiteral(value: WorkflowConditionLiteral): string {
	return value === null ? "null" : String(value);
}

function formatWorkflowConditionSubjectPath(
	path: readonly string[],
	mode: WorkflowConditionLabelMode = "default",
): string {
	if (mode === "loopback" && path[0] === "outputs" && path.at(-1) === "verdict") {
		return formatWorkflowConditionPath(path.slice(1, -1));
	}
	const [root, outputNodeId, ...outputFields] = path;
	if (root === "state") return formatWorkflowConditionPath(path.slice(1));
	if (root === "outputs") return formatWorkflowConditionPath([outputNodeId ?? "", ...outputFields]);
	return formatWorkflowConditionPath([...path]);
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

function buildWorkflowGraphNodeActivationCounts(currentAttempt: WorkflowRunAttemptSnapshot): Map<string, number> {
	const counts = new Map<string, number>();
	for (const activation of currentAttempt.activations) {
		counts.set(activation.nodeId, (counts.get(activation.nodeId) ?? 0) + 1);
	}
	return counts;
}

function buildWorkflowGraphNodeStatuses(
	family: WorkflowRunFamilySnapshot,
	currentAttempt: WorkflowRunAttemptSnapshot | undefined,
	currentCheckpoint: WorkflowCheckpointSnapshot | undefined,
	currentFreeze: WorkflowRunFamilySnapshot["freezes"][number] | undefined,
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
			const nodeId = mapWorkflowCheckpointFrontierNode(family, currentCheckpoint, frontierNodeId, currentFreeze);
			if (!statuses.has(nodeId)) statuses.set(nodeId, { status: "frontier" });
		}
	}
	if (currentAttempt) {
		const currentAttemptOwnsCheckpoint = currentAttempt.id === currentCheckpoint?.attemptId;
		for (const activation of currentAttempt.activations) {
			statuses.set(activation.nodeId, {
				status: workflowGraphNodeStatusForActivation(
					currentAttempt,
					activation,
					currentAttemptOwnsCheckpoint && checkpointedActivationIds.has(activation.id),
				),
				verdict: workflowActivationOutputVerdict(activation.output),
				summary: activation.output?.summary,
				error: activation.error,
				reason: activation.reason,
			});
		}
	}
	return statuses;
}

function workflowGraphNodeStatusForActivation(
	attempt: WorkflowRunAttemptSnapshot,
	activation: WorkflowAttemptActivationRecord,
	checkpointed: boolean,
): WorkflowGraphNodeStatus {
	if (checkpointed) return "checkpointed";
	if (activation.status !== "running") return activation.status;
	if (attempt.status === "running" || attempt.status === "stop_requested") return "running";
	if (attempt.status === "completed") return "completed";
	if (attempt.status === "failed") return "failed";
	return "aborted";
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
				...(edge.label !== undefined ? { label: edge.label } : {}),
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

function workflowRestartFreezeForCheckpoint(
	family: WorkflowRunFamilySnapshot,
	checkpoint: WorkflowCheckpointSnapshot,
): WorkflowRunFamilySnapshot["freezes"][number] | undefined {
	const appliedFreezeIds = new Set<string>();
	for (const request of family.changeRequests) {
		if (request.status !== "approved") continue;
		if (request.checkpointId !== undefined && request.checkpointId !== checkpoint.id) continue;
		if (request.attemptId !== undefined && request.attemptId !== checkpoint.attemptId) continue;
		for (const application of request.applications) {
			if (application.target === "freeze" && application.freezeId !== undefined) {
				appliedFreezeIds.add(application.freezeId);
			}
		}
	}
	const appliedFreeze = family.freezes
		.slice()
		.reverse()
		.find(freeze => appliedFreezeIds.has(freeze.id));
	if (appliedFreeze !== undefined) return appliedFreeze;
	const checkpointAttempt = family.attempts.find(attempt => attempt.id === checkpoint.attemptId);
	return family.freezes.find(freeze => freeze.id === checkpointAttempt?.freezeId);
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
	const ownedCheckpoint = family.checkpoints.filter(checkpoint => checkpoint.attemptId === attempt.id).at(-1);
	if (ownedCheckpoint !== undefined) return ownedCheckpoint;
	if (attempt.checkpointId !== undefined) {
		return family.checkpoints.find(checkpoint => checkpoint.id === attempt.checkpointId);
	}
	return undefined;
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

function buildWorkflowGraphNodeActivations(
	currentAttempt: WorkflowRunAttemptSnapshot,
	nodes: WorkflowNode[],
	options: WorkflowGraphViewOptions,
): Map<string, WorkflowGraphNodeActivationView[]> {
	const nodesById = new Map(nodes.map(node => [node.id, node]));
	const generationByNodeId = new Map<string, number>();
	const activationsByNodeId = new Map<string, WorkflowGraphNodeActivationView[]>();
	const hasLiveAttempt =
		(currentAttempt.status === "running" || currentAttempt.status === "stop_requested") &&
		(options.liveAttemptIds === undefined || options.liveAttemptIds.has(currentAttempt.id));
	for (const activation of currentAttempt.activations) {
		const generation = (generationByNodeId.get(activation.nodeId) ?? 0) + 1;
		generationByNodeId.set(activation.nodeId, generation);
		const node = nodesById.get(activation.nodeId);
		const focusAgentId =
			node !== undefined && workflowNodeIsAgentLike(node)
				? formatWorkflowAgentFocusTarget(node.id, generation)
				: undefined;
		const progress =
			hasLiveAttempt && focusAgentId !== undefined ? options.activeAgentProgressById?.get(focusAgentId) : undefined;
		const model =
			node === undefined
				? undefined
				: (progress?.model ?? currentAttempt.runtimeBindingSnapshot.modelBindings?.[node.id]?.resolvedModel);
		const tool = formatWorkflowActiveAgentTool(progress);
		const activity = formatWorkflowActiveAgentActivity(progress);
		const stats = formatWorkflowActiveAgentStats(progress);
		const recentOutput = formatWorkflowActiveAgentRecentOutput(progress);
		const humanPrompt = node?.type === "human" ? workflowGraphHumanPromptForActivation(activation) : undefined;
		const view: WorkflowGraphNodeActivationView = {
			id: activation.id,
			ordinal: generation,
			status: activation.status,
		};
		if (activation.output?.summary !== undefined) view.summary = activation.output.summary;
		if (activation.output?.artifacts !== undefined) view.artifacts = [...activation.output.artifacts];
		const verdict = workflowActivationOutputVerdict(activation.output);
		if (verdict !== undefined) view.verdict = verdict;
		if (activation.error !== undefined) view.error = activation.error;
		if (activation.reason !== undefined) view.reason = activation.reason;
		if (focusAgentId !== undefined) view.focusAgentId = focusAgentId;
		if (generation > 1) view.generation = generation;
		if (model !== undefined) view.model = model;
		if (tool !== undefined) view.tool = tool;
		if (stats !== undefined) view.stats = stats;
		if (activity !== undefined) view.activity = activity;
		if (humanPrompt !== undefined) view.humanPrompt = humanPrompt;
		if (recentOutput.length > 0) view.recentOutput = recentOutput;
		const activations = activationsByNodeId.get(activation.nodeId) ?? [];
		activations.push(view);
		activationsByNodeId.set(activation.nodeId, activations);
	}
	return activationsByNodeId;
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

function workflowGraphHumanPromptForActivation(activation: WorkflowAttemptActivationRecord): string | undefined {
	const inputPrompt = activation.input?.prompt?.value;
	if (typeof inputPrompt === "string" && inputPrompt.trim().length > 0) return inputPrompt.trim();
	const outputQuestion = activation.output?.data?.question;
	if (typeof outputQuestion === "string" && outputQuestion.trim().length > 0) return outputQuestion.trim();
	return undefined;
}

function buildWorkflowGraphFocus(
	nodes: readonly WorkflowGraphNodeView[],
	activeAgents: readonly WorkflowGraphActiveAgentView[],
	currentAttempt: WorkflowRunAttemptSnapshot | undefined,
): WorkflowGraphFocusView | undefined {
	const activeAgent = activeAgents[0];
	if (activeAgent !== undefined) {
		return workflowGraphFocusFromActiveAgent(activeAgent, currentAttempt?.id);
	}
	const node = selectWorkflowFocusNode(nodes);
	if (node === undefined) return undefined;
	return workflowGraphFocusFromNode(node, currentAttempt?.id);
}

export function selectWorkflowGraphViewNode(
	view: WorkflowGraphView,
	nodeId: string,
	activationIndex: number | undefined,
): WorkflowGraphView {
	const node = view.nodes.find(candidate => candidate.id === nodeId);
	if (node === undefined) return view;
	const nodes = view.nodes.map(candidate => ({ ...candidate, focused: candidate.id === node.id }));
	const selectedNode = nodes.find(candidate => candidate.id === node.id) ?? node;
	const activation = selectedWorkflowGraphNodeActivation(selectedNode, activationIndex);
	const focusAgent =
		activation?.focusAgentId === undefined
			? undefined
			: (view.activeAgents ?? []).find(agent => agent.focusAgentId === activation.focusAgentId);
	const fallbackAgent =
		focusAgent ??
		(view.activeAgents ?? []).find(agent => agent.activationId === activation?.id) ??
		(view.activeAgents ?? []).find(agent => agent.nodeId === selectedNode.id);
	const focus =
		fallbackAgent === undefined
			? workflowGraphFocusFromNode(selectedNode, view.currentAttempt?.id, activation)
			: workflowGraphFocusFromActiveAgent(fallbackAgent, view.currentAttempt?.id, activation, selectedNode);
	return { ...view, nodes, focus };
}

function workflowGraphFocusFromActiveAgent(
	activeAgent: WorkflowGraphActiveAgentView,
	attemptId: string | undefined,
	activation?: WorkflowGraphNodeActivationView,
	node?: WorkflowGraphNodeView,
): WorkflowGraphFocusView {
	const focus: WorkflowGraphFocusView = {
		nodeId: activeAgent.nodeId,
		label: activeAgent.label,
		role: activeAgent.role,
		status: "running",
		focusAgentId: activeAgent.focusAgentId,
	};
	const activationCount = node?.activationCount ?? node?.activations?.length;
	if (activation !== undefined) applyWorkflowGraphActivationFocus(focus, activation, activationCount);
	else if (activationCount !== undefined && activationCount > 0) focus.activationCount = activationCount;
	if (activeAgent.generation !== undefined) focus.generation = activeAgent.generation;
	if (activeAgent.model !== undefined) focus.model = activeAgent.model;
	if (activeAgent.tool !== undefined) focus.tool = activeAgent.tool;
	if (activeAgent.stats !== undefined) focus.stats = activeAgent.stats;
	if (activeAgent.activity !== undefined) focus.activity = activeAgent.activity;
	if (activeAgent.summary !== undefined) focus.summary = activeAgent.summary;
	if (activeAgent.recentOutput !== undefined) focus.recentOutput = activeAgent.recentOutput;
	if (attemptId !== undefined) {
		focus.controls = [
			`Watch: Agent Hub ${activeAgent.focusAgentId}`,
			`Interrupt: /workflow interrupt ${attemptId} ${activeAgent.focusAgentId} --deadline-ms 30000`,
			"Steer: Agent Hub Enter attaches; Esc returns",
		];
	}
	return focus;
}

function workflowGraphFocusFromNode(
	node: WorkflowGraphNodeView,
	attemptId: string | undefined,
	activation?: WorkflowGraphNodeActivationView,
): WorkflowGraphFocusView {
	const focus: WorkflowGraphFocusView = {
		nodeId: node.id,
		label: formatWorkflowNodeDisplayName(node.id),
		role: node.kind,
		status: node.status,
	};
	const selectedActivation = activation ?? selectedWorkflowGraphNodeActivation(node, undefined);
	if (selectedActivation !== undefined) {
		applyWorkflowGraphActivationFocus(focus, selectedActivation, node.activationCount ?? node.activations?.length);
	}
	if (node.verdict !== undefined && focus.summary === undefined) focus.summary = `verdict ${node.verdict}`;
	if (node.summary !== undefined && focus.summary === undefined) focus.summary = node.summary;
	if (node.error !== undefined && focus.error === undefined) focus.error = node.error;
	if (node.reason !== undefined && focus.reason === undefined) focus.reason = node.reason;
	if (node.humanPrompt !== undefined && focus.humanPrompt === undefined) focus.humanPrompt = node.humanPrompt;
	if (
		node.status === "running" &&
		attemptId !== undefined &&
		selectedActivation?.focusAgentId !== undefined &&
		selectedActivation.status === "running"
	) {
		focus.controls = [
			`Watch: Agent Hub ${selectedActivation.focusAgentId}`,
			`Interrupt: /workflow interrupt ${attemptId} ${selectedActivation.focusAgentId} --deadline-ms 30000`,
			"Steer: Agent Hub Enter attaches; Esc returns",
		];
	} else if (node.status === "running" && attemptId !== undefined) {
		focus.controls = [`Interrupt: /workflow interrupt ${attemptId} ${node.id} --deadline-ms 30000`];
	}
	return focus;
}

function selectedWorkflowGraphNodeActivation(
	node: WorkflowGraphNodeView,
	activationIndex: number | undefined,
): WorkflowGraphNodeActivationView | undefined {
	const activations = node.activations ?? [];
	if (activations.length === 0) return undefined;
	if (activationIndex === undefined || !Number.isFinite(activationIndex)) return activations[0];
	const boundedIndex = Math.max(0, Math.min(activations.length - 1, Math.floor(activationIndex)));
	return activations[boundedIndex];
}

function applyWorkflowGraphActivationFocus(
	focus: WorkflowGraphFocusView,
	activation: WorkflowGraphNodeActivationView,
	activationCount: number | undefined,
): void {
	focus.activationId = activation.id;
	focus.activationOrdinal = activation.ordinal;
	if (activationCount !== undefined) focus.activationCount = activationCount;
	if (activation.focusAgentId !== undefined) focus.focusAgentId = activation.focusAgentId;
	if (activation.generation !== undefined) focus.generation = activation.generation;
	if (activation.model !== undefined) focus.model = activation.model;
	if (activation.tool !== undefined) focus.tool = activation.tool;
	if (activation.stats !== undefined) focus.stats = activation.stats;
	if (activation.activity !== undefined) focus.activity = activation.activity;
	if (activation.verdict !== undefined) focus.summary = `verdict ${activation.verdict}`;
	if (activation.summary !== undefined) focus.summary = activation.summary;
	if (activation.error !== undefined) focus.error = activation.error;
	if (activation.reason !== undefined) focus.reason = activation.reason;
	if (activation.humanPrompt !== undefined) focus.humanPrompt = activation.humanPrompt;
	if (activation.recentOutput !== undefined) focus.recentOutput = activation.recentOutput;
	if (activation.artifacts !== undefined) focus.artifacts = [...activation.artifacts];
}

function selectWorkflowFocusNode(nodes: readonly WorkflowGraphNodeView[]): WorkflowGraphNodeView | undefined {
	return (
		nodes.find(node => node.focused) ??
		nodes.find(node => node.status === "failed") ??
		nodes.find(node => node.status === "running") ??
		nodes.find(node => node.status === "frontier") ??
		nodes.find(node => node.status === "checkpointed")
	);
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
	return formatWorkflowTopologyParts(topology).join(" / ") || "linear";
}

function formatWorkflowViewTopology(view: WorkflowGraphView): string {
	const parts = formatWorkflowTopologyParts(view.topology);
	const rootCount = workflowGraphRootNodeCount(view.nodes, view.edges);
	if (rootCount > 1) parts.unshift(`parallel roots ${rootCount}`);
	return parts.join(" / ") || "linear";
}

function formatWorkflowTopologyParts(topology: WorkflowGraphTopologyView): string[] {
	const parts: string[] = [];
	if (topology.parallelFanOuts > 0) {
		parts.push(`parallel fan-outs ${topology.parallelFanOuts}`);
	}
	if (topology.branchPoints > 0) parts.push(`branch points ${topology.branchPoints}`);
	if (topology.joins > 0) parts.push(`joins ${topology.joins}`);
	if (topology.loops > 0) parts.push(`loops ${topology.loops}`);
	if (topology.subflows > 0) parts.push(`subflows ${topology.subflows}`);
	return parts;
}

function workflowGraphRootNodeCount(
	nodes: readonly WorkflowGraphNodeView[],
	edges: readonly WorkflowGraphEdgeView[],
): number {
	const targetIds = new Set(edges.map(edge => edge.to));
	return nodes.filter(node => !targetIds.has(node.id)).length;
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
	lines.push(`Flow: ${formatWorkflowViewTopology(view)} · ${view.nodes.length} ${pluralNode(view.nodes.length)}`);
	lines.push(`Focus: ${formatWorkflowOperatorFocus(view)}`);
	lines.push(`On-flight: ${formatWorkflowOnFlightSummary(view)}`);
	lines.push(`Flow changes: ${formatWorkflowChangeCounts(view.changes)}`);
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
	return runningNodes.map(formatRunningWorkflowNode);
}

export function formatWorkflowRecentActivityLines(view: WorkflowGraphView): string[] {
	const lines: string[] = [];
	for (const agent of view.activeAgents ?? []) {
		if (agent.activity !== undefined) {
			lines.push(`progress · ${agent.role} · ${agent.label}: ${formatSingleLineWorkflowDetail(agent.activity)}`);
		}
		for (const output of agent.recentOutput ?? []) {
			lines.push(`stdout · ${agent.role} · ${agent.label}: ${formatSingleLineWorkflowDetail(output)}`);
		}
	}
	for (const node of view.nodes) {
		if (node.status === "failed" && node.error !== undefined) {
			lines.push(
				`stderr · ${formatWorkflowNodeDisplayName(node.id)}: ${formatSingleLineWorkflowDetail(node.error)}`,
			);
		}
	}
	for (const request of view.lineage) {
		if (request.status === "rejected") continue;
		const applied = request.applications.length === 0 ? "" : " · applied";
		lines.push(
			`changes · ${request.id} ${request.status}${applied}: ${formatSingleLineWorkflowDetail(request.reason)}`,
		);
	}
	for (const route of view.selectedRoutes ?? []) {
		lines.push(`route · ${formatWorkflowSelectedRoute(route)}`);
	}
	return lines.slice(0, WORKFLOW_RECENT_OUTPUT_LINES);
}

export function formatWorkflowFocusLines(view: WorkflowGraphView): string[] {
	const focus = view.focus;
	if (focus === undefined) return [];
	const lines: string[] = [];
	const generation = focus.generation === undefined ? "" : ` · round ${focus.generation}`;
	const model = focus.model === undefined ? "" : ` · ${formatSingleLineWorkflowDetail(focus.model)}`;
	const tool = focus.tool === undefined ? "" : ` · tool ${formatSingleLineWorkflowDetail(focus.tool)}`;
	const stats = focus.stats === undefined ? "" : ` · ${focus.stats}`;
	lines.push(`${focus.role} · ${focus.label} ${formatWorkflowFocusStatus(focus)}${generation}${model}${tool}${stats}`);
	const activationLine = formatWorkflowFocusActivationLine(focus);
	if (activationLine !== undefined) lines.push(activationLine);
	if (focus.humanPrompt !== undefined) {
		lines.push(`human prompt: ${formatSingleLineWorkflowDetail(focus.humanPrompt)}`);
		lines.push(
			"human input: default Reject; choose Approve only after reading the prompt and evidence; h help for controls",
		);
	}
	if (focus.activity !== undefined) {
		lines.push(`activity: ${formatSingleLineWorkflowDetail(focus.activity)}`);
	}
	if (focus.summary !== undefined) {
		lines.push(`summary: ${formatSingleLineWorkflowDetail(formatWorkflowDisplayDetail(focus.summary))}`);
	}
	if (focus.error !== undefined) {
		lines.push(`stderr: ${formatSingleLineWorkflowDetail(focus.error)}`);
	}
	if (focus.reason !== undefined) {
		lines.push(`reason: ${formatSingleLineWorkflowDetail(focus.reason)}`);
	}
	for (const output of focus.recentOutput ?? []) {
		lines.push(`stdout: ${formatSingleLineWorkflowDetail(output)}`);
	}
	for (const control of focus.controls ?? []) {
		lines.push(`control: ${formatSingleLineWorkflowDetail(control)}`);
	}
	return lines;
}

function formatWorkflowFocusActivationLine(focus: WorkflowGraphFocusView): string | undefined {
	if (focus.activationCount === undefined || focus.activationCount <= 0) return undefined;
	const ordinal = focus.activationOrdinal ?? focus.activationCount;
	const id = focus.activationId === undefined ? "" : ` · ${focus.activationId}`;
	return `activation: ${ordinal}/${focus.activationCount}${id}`;
}

function formatWorkflowFocusStatus(focus: WorkflowGraphFocusView): string {
	if (focus.status === "running" && focus.focusAgentId !== undefined) return "live";
	return focus.status;
}

function formatRunningWorkflowNode(node: WorkflowGraphNodeView): string {
	const label = formatWorkflowNodeDisplayName(node.id);
	if (node.kind === "Human checkpoint") return `${label} waiting for operator input (default Reject)`;
	return `${label} running`;
}

export function formatWorkflowChangeReviewLines(view: WorkflowGraphView): string[] {
	return view.lineage.map(request => {
		const actor = request.actor === undefined ? "" : ` by ${request.actor}`;
		const applied = request.applications.length === 0 ? "" : " · applied";
		return `${request.id} ${request.status}${actor}${applied} - ${formatSingleLineWorkflowDetail(request.reason)}`;
	});
}

export function formatWorkflowControlLines(view: WorkflowGraphView): string[] {
	return [...view.actions.map(formatWorkflowControlAction), ...formatWorkflowNavigationControlLines(view)];
}

function formatWorkflowNavigationControlLines(view: WorkflowGraphView): string[] {
	if (view.nodes.length === 0) return [];
	const hasRepeatedNode = view.nodes.some(node => (node.activationCount ?? node.activations?.length ?? 0) > 1);
	const lines = ["Navigate nodes: Tab/Shift-Tab nodes; h help; /workflow help for full command guide"];
	if (hasRepeatedNode) lines.push("Switch activation: [/] activations for the selected node");
	if ((view.activeAgents ?? []).length > 0) {
		lines.push("Agent Hub transcript: Enter/observe opens the selected live agent transcript; Esc returns");
	}
	return lines;
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
	nodes: readonly WorkflowNode[],
): string[] {
	const latestFreeze = family.freezes.at(-1);
	const actions = [`Refresh: /workflow graph --family-id ${family.id}`];
	if (currentAttempt?.status === "running") {
		actions.push(`Stop attempt: /workflow stop ${currentAttempt.id} --deadline-ms 30000`);
		if (currentAttempt.activations.some(activation => activation.status === "running")) {
			const hasLiveAttempt = options.liveAttemptIds === undefined || options.liveAttemptIds.has(currentAttempt.id);
			if (hasLiveAttempt) {
				actions.push(...formatWorkflowNonAgentInterruptActions(currentAttempt, activeAgents, nodes));
			}
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
		else {
			const restartFreeze = workflowRestartFreezeForCheckpoint(family, currentCheckpoint) ?? latestFreeze;
			const freezeArg = restartFreeze === undefined ? "" : ` --freeze-id ${restartFreeze.id}`;
			actions.push(`Restart: /workflow restart ${currentCheckpoint.id}${freezeArg} --background`);
		}
	}
	return actions;
}

function formatWorkflowNonAgentInterruptActions(
	currentAttempt: WorkflowRunAttemptSnapshot,
	activeAgents: readonly WorkflowGraphActiveAgentView[],
	nodes: readonly WorkflowNode[],
): string[] {
	const activeAgentActivationIds = new Set(activeAgents.map(agent => agent.activationId));
	const nodesById = new Map(nodes.map(node => [node.id, node]));
	const actions: string[] = [];
	for (const activation of currentAttempt.activations) {
		if (activation.status !== "running" || activeAgentActivationIds.has(activation.id)) continue;
		const node = nodesById.get(activation.nodeId);
		if (node !== undefined && workflowNodeIsAgentLike(node)) continue;
		const role = node === undefined ? "Node" : formatWorkflowNodeRole(node);
		const label = formatWorkflowNodeDisplayName(activation.nodeId);
		actions.push(
			`Interrupt ${role} · ${label}: /workflow interrupt ${currentAttempt.id} ${activation.nodeId} --deadline-ms 30000`,
		);
	}
	return actions;
}

function formatSingleLineWorkflowDetail(value: string): string {
	const compact = value.replace(/\s+/g, " ").trim();
	if (compact.length <= WORKFLOW_DETAIL_PREVIEW_CHARS) return compact;
	return `${compact.slice(0, WORKFLOW_DETAIL_PREVIEW_CHARS - 3)}...`;
}
