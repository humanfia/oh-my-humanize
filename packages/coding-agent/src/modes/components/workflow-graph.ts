import {
	type Component,
	type NativeScrollbackLiveRegion,
	replaceTabs,
	truncateToWidth,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import { renderOutputBlock } from "../../tui/output-block";
import type { State } from "../../tui/types";
import {
	formatWorkflowChangeReviewLines,
	formatWorkflowConditionLabel,
	formatWorkflowControlLines,
	formatWorkflowFocusLines,
	formatWorkflowOnFlightLines,
	formatWorkflowOverviewLines,
	formatWorkflowRecentActivityLines,
	formatWorkflowSelectedRoute,
	formatWorkflowSubflow,
	renderWorkflowGraphDiagram,
	type WorkflowGraphNodeStatus,
	type WorkflowGraphView,
} from "../../workflow/graph-view";
import { type ThemeColor, theme } from "../theme/theme";

export interface WorkflowGraphComponentOptions {
	viewProvider?: () => WorkflowGraphView | undefined;
	onViewChange?: (view: WorkflowGraphView) => void;
	requestRender?: (component: Component) => void;
	refreshMs?: number;
	heightProvider?: () => number | undefined;
}

export class WorkflowGraphComponent implements Component, NativeScrollbackLiveRegion {
	#cache?: { width: number; heightBudget?: number; lines: string[] };
	#heightProvider?: () => number | undefined;
	#lastObservedViewSignature?: string;
	#onViewChange?: (view: WorkflowGraphView) => void;
	#view: WorkflowGraphView;
	#viewProvider?: () => WorkflowGraphView | undefined;
	#refreshTimer?: NodeJS.Timeout;

	constructor(view: WorkflowGraphView, options: WorkflowGraphComponentOptions = {}) {
		this.#view = view;
		this.#viewProvider = options.viewProvider;
		this.#onViewChange = options.onViewChange;
		this.#heightProvider = options.heightProvider;
		const refreshMs = options.refreshMs ?? 500;
		if (options.requestRender !== undefined && refreshMs > 0) {
			this.#refreshTimer = setInterval(() => {
				this.invalidate();
				options.requestRender?.(this);
			}, refreshMs);
			this.#refreshTimer.unref?.();
		}
	}

	invalidate(): void {
		this.#cache = undefined;
	}

	dispose(): void {
		if (this.#refreshTimer !== undefined) {
			clearInterval(this.#refreshTimer);
			this.#refreshTimer = undefined;
		}
	}

	render(width: number): readonly string[] {
		const safeWidth = Math.max(40, width);
		const heightBudget = workflowGraphHeightBudget(this.#heightProvider?.());
		const view = this.#currentView();
		this.#observeView(view);
		if (
			this.#viewProvider === undefined &&
			this.#cache?.width === safeWidth &&
			this.#cache.heightBudget === heightBudget
		)
			return this.#cache.lines;
		const lines = renderWorkflowGraphBlock(view, safeWidth, heightBudget);
		this.#cache = { width: safeWidth, heightBudget, lines };
		return lines;
	}

	getNativeScrollbackLiveRegionStart(): number | undefined {
		return 0;
	}

	#currentView(): WorkflowGraphView {
		return this.#viewProvider?.() ?? this.#view;
	}

	#observeView(view: WorkflowGraphView): void {
		if (this.#onViewChange === undefined) return;
		const signature = JSON.stringify(view);
		if (signature === this.#lastObservedViewSignature) return;
		this.#lastObservedViewSignature = signature;
		this.#onViewChange(view);
	}
}

type WorkflowGraphDensity = "full" | "compact";

const WORKFLOW_GRAPH_MIN_HEIGHT_BUDGET = 6;

function renderWorkflowGraphBlock(
	view: WorkflowGraphView,
	safeWidth: number,
	heightBudget: number | undefined,
): string[] {
	const full = renderWorkflowGraphBlockAtDensity(view, safeWidth, "full", undefined);
	if (heightBudget === undefined || full.length <= heightBudget) return full;
	const compact = renderWorkflowGraphBlockAtDensity(view, safeWidth, "compact", heightBudget);
	return compact.length <= heightBudget ? compact : fitWorkflowGraphRowsToHeight(compact, safeWidth, heightBudget);
}

function renderWorkflowGraphBlockAtDensity(
	view: WorkflowGraphView,
	safeWidth: number,
	density: WorkflowGraphDensity,
	heightBudget: number | undefined,
): string[] {
	const contentWidth = safeWidth - 8;
	const focusLines = workflowGraphFocusLines(view, contentWidth, density);
	const onFlightLines = workflowGraphOnFlightLines(view, contentWidth, density);
	const recentActivityLines = workflowGraphRecentActivityLines(view, contentWidth);
	const profile = workflowGraphCompactProfile(density, heightBudget);
	const flowMapLines = workflowGraphFlowMapLines(view, contentWidth, density);
	const diagramLines = workflowGraphDiagramLines(view, contentWidth, density, heightBudget, profile.diagramChromeRows);
	const overviewSourceLines = formatWorkflowOverviewLines(view);
	const overviewLines =
		density === "full"
			? overviewSourceLines
			: limitWorkflowGraphOverviewLines(
					overviewSourceLines,
					profile.overviewLines,
					profile.pathLine ? workflowGraphCompactPathLine(view, contentWidth) : undefined,
				);
	const compactFocusLines =
		density === "full" ? focusLines : limitWorkflowGraphLines(focusLines, profile.focusLines, "focus");
	const compactOnFlightLines =
		density === "full" ? onFlightLines : limitWorkflowGraphLines(onFlightLines, profile.onFlightLines, "on-flight");
	const compactRecentActivityLines =
		density === "full"
			? recentActivityLines
			: limitWorkflowGraphLines(recentActivityLines, profile.recentActivityLines, "activity");
	const controlLines = workflowGraphControlLines(view, density);
	const compactControlLines =
		density === "full" ? controlLines : limitWorkflowGraphLines(controlLines, profile.controlLines, "controls");
	return renderOutputBlock(
		{
			header: "Workflow graph",
			headerMeta: view.familyId,
			state: workflowGraphState(view),
			width: safeWidth,
			contentPaddingLeft: 2,
			sections: [
				{ lines: overviewLines },
				...(flowMapLines.length > 0 ? [{ label: "flow map", lines: colorWorkflowDiagram(flowMapLines) }] : []),
				...(compactFocusLines.length > 0 ? [{ label: "focused node", lines: compactFocusLines }] : []),
				...(density === "full" && view.subflows !== undefined && view.subflows.length > 0
					? [{ label: "flow calls", lines: workflowGraphSubflowLines(view) }]
					: []),
				...(compactOnFlightLines.length > 0 ? [{ label: "on-flight", lines: compactOnFlightLines }] : []),
				...(compactRecentActivityLines.length > 0
					? [{ label: density === "full" ? "recent activity" : "recent", lines: compactRecentActivityLines }]
					: []),
				{ label: "diagram", lines: colorWorkflowDiagram(diagramLines) },
				...(density === "full" && view.selectedRoutes !== undefined && view.selectedRoutes.length > 0
					? [{ label: "routes", lines: workflowGraphSelectedRouteLines(view) }]
					: []),
				...(density === "full" && view.lineage.length > 0
					? [{ label: "change review", lines: workflowGraphChangeLines(view, contentWidth) }]
					: []),
				...(compactControlLines.length > 0 ? [{ label: "controls", lines: compactControlLines }] : []),
			],
		},
		theme,
	);
}

function workflowGraphDiagramLines(
	view: WorkflowGraphView,
	width: number,
	density: WorkflowGraphDensity,
	heightBudget: number | undefined,
	diagramChromeRows: number,
): string[] {
	const lines = renderWorkflowGraphDiagram(view, { width });
	if (density === "full") return lines;
	const minRows = (heightBudget ?? 0) <= 14 ? 1 : 4;
	const maxRows = Math.max(minRows, Math.min(lines.length, (heightBudget ?? 32) - diagramChromeRows));
	return limitWorkflowGraphDiagramLines(lines, maxRows, view, width);
}

function workflowGraphCompactProfile(
	density: WorkflowGraphDensity,
	heightBudget: number | undefined,
): {
	overviewLines: number;
	focusLines: number;
	onFlightLines: number;
	recentActivityLines: number;
	controlLines: number;
	diagramChromeRows: number;
	pathLine: boolean;
} {
	if (density === "full") {
		return {
			overviewLines: Number.POSITIVE_INFINITY,
			focusLines: Number.POSITIVE_INFINITY,
			onFlightLines: Number.POSITIVE_INFINITY,
			recentActivityLines: Number.POSITIVE_INFINITY,
			controlLines: Number.POSITIVE_INFINITY,
			diagramChromeRows: 0,
			pathLine: false,
		};
	}
	if ((heightBudget ?? 0) <= 14) {
		return {
			overviewLines: 2,
			focusLines: 0,
			onFlightLines: 0,
			recentActivityLines: 0,
			controlLines: 0,
			diagramChromeRows: 7,
			pathLine: false,
		};
	}
	if ((heightBudget ?? 0) <= 20) {
		return {
			overviewLines: 3,
			focusLines: 1,
			onFlightLines: 0,
			recentActivityLines: 0,
			controlLines: 1,
			diagramChromeRows: 12,
			pathLine: false,
		};
	}
	if ((heightBudget ?? 0) <= 28) {
		return {
			overviewLines: 4,
			focusLines: 2,
			onFlightLines: 1,
			recentActivityLines: 0,
			controlLines: 2,
			diagramChromeRows: 17,
			pathLine: false,
		};
	}
	return {
		overviewLines: 5,
		focusLines: 1,
		onFlightLines: 1,
		recentActivityLines: 0,
		controlLines: 2,
		diagramChromeRows: 18,
		pathLine: false,
	};
}

function limitWorkflowGraphDiagramLines(
	lines: string[],
	maxRows: number,
	view: WorkflowGraphView,
	width: number,
): string[] {
	if (lines.length <= maxRows) return lines;
	if (maxRows <= 1) return [`+${lines.length} diagram rows hidden around focus`];
	const anchor = workflowGraphDiagramAnchorLine(lines, view);
	const visibleRows = Math.max(1, maxRows - 1);
	const focusBox = workflowGraphFocusedNodeBox(lines, anchor);
	if (maxRows <= 5) return compactWorkflowGraphTinyDiagram(lines.length, maxRows, view, width);
	const start =
		focusBox !== undefined && focusBox.end - focusBox.start + 1 <= visibleRows
			? workflowGraphContextStart(lines, focusBox, visibleRows)
			: Math.max(0, Math.min(anchor - Math.floor(visibleRows / 2), lines.length - visibleRows));
	const rawEnd = Math.min(lines.length, start + visibleRows);
	const focusEnd = focusBox === undefined ? start + 1 : focusBox.end + 1;
	const end = workflowGraphTrimPartialTrailingNode(lines, start, rawEnd, focusEnd);
	const hiddenBefore = start;
	const hiddenAfter = lines.length - end;
	const hidden = hiddenBefore + hiddenAfter;
	const marker =
		hiddenBefore > 0 && hiddenAfter > 0
			? `+${hidden} diagram rows hidden around focus`
			: `+${hidden} diagram rows hidden`;
	return [...lines.slice(start, end), marker];
}

function compactWorkflowGraphTinyDiagram(
	sourceRowCount: number,
	maxRows: number,
	view: WorkflowGraphView,
	width: number,
): string[] {
	const focus = view.focus ?? view.activeAgents?.[0];
	const subject =
		focus === undefined
			? "workflow focus"
			: [
					focus.status === "running" ? "●" : "○",
					focus.nodeId,
					focus.role,
					focus.generation === undefined ? undefined : `round ${focus.generation}`,
					focus.status,
				]
					.filter(Boolean)
					.join(" · ");
	const lines = [
		truncateToWidth(subject, width),
		`+${Math.max(0, sourceRowCount - 1)} diagram rows hidden around focus`,
	];
	return lines.slice(0, maxRows);
}

function workflowGraphDiagramAnchorLine(lines: readonly string[], view: WorkflowGraphView): number {
	const focusNodeId = view.focus?.nodeId ?? view.activeAgents?.[0]?.nodeId;
	if (focusNodeId !== undefined) {
		const focusLine = lines.findIndex(line => line.includes(focusNodeId));
		if (focusLine !== -1) return focusLine;
	}
	const runningLine = lines.findIndex(line => line.includes("● ") || line.includes("running"));
	return runningLine === -1 ? Math.floor(lines.length / 2) : runningLine;
}

function workflowGraphFocusedNodeBox(
	lines: readonly string[],
	anchor: number,
): { start: number; end: number } | undefined {
	let start = -1;
	for (let index = Math.min(anchor, lines.length - 1); index >= 0; index -= 1) {
		if (/[┌╔]/u.test(lines[index] ?? "")) {
			start = index;
			break;
		}
	}
	const end = lines.findIndex((line, index) => index >= anchor && /[┘╝]/u.test(line));
	return start === -1 || end === -1 || end < start ? undefined : { start, end };
}

function workflowGraphContextStart(
	lines: readonly string[],
	focusBox: { start: number; end: number },
	visibleRows: number,
): number {
	const previousBox = workflowGraphPreviousNodeBox(lines, focusBox.start);
	if (previousBox !== undefined && focusBox.end - previousBox.start + 1 <= visibleRows) {
		return Math.min(previousBox.start, Math.max(0, lines.length - visibleRows));
	}
	return Math.min(focusBox.start, Math.max(0, lines.length - visibleRows));
}

function workflowGraphTrimPartialTrailingNode(
	lines: readonly string[],
	start: number,
	end: number,
	minEnd: number,
): number {
	let lastTop = -1;
	let lastBottom = -1;
	for (let index = start; index < end; index += 1) {
		const line = lines[index] ?? "";
		if (/[┌╔]/u.test(line)) lastTop = index;
		if (/[┘╝]/u.test(line)) lastBottom = index;
	}
	if (lastTop > lastBottom && lastTop >= minEnd) return lastTop;
	return end;
}

function workflowGraphPreviousNodeBox(
	lines: readonly string[],
	beforeIndex: number,
): { start: number; end: number } | undefined {
	let end = -1;
	for (let index = beforeIndex - 1; index >= 0; index -= 1) {
		if (/[┘╝]/u.test(lines[index] ?? "")) {
			end = index;
			break;
		}
	}
	if (end === -1) return undefined;
	for (let index = end; index >= 0; index -= 1) {
		if (/[┌╔]/u.test(lines[index] ?? "")) return { start: index, end };
	}
	return undefined;
}

function limitWorkflowGraphLines(lines: string[], maxLines: number, label: string): string[] {
	if (maxLines <= 0) return [];
	if (lines.length <= maxLines) return lines;
	if (maxLines <= 1) return lines.slice(0, 1);
	return [...lines.slice(0, maxLines - 1), `+${lines.length - maxLines + 1} ${label} hidden`];
}

function limitWorkflowGraphOverviewLines(lines: string[], maxLines: number, pathLine: string | undefined): string[] {
	if (maxLines <= 0) return [];
	const sourceLines = pathLine === undefined ? lines : [...lines, pathLine];
	if (sourceLines.length <= maxLines) return sourceLines;
	const runLine = lines[0];
	const flowLine = lines.find(line => line.startsWith("Flow:"));
	const focusLine = lines.find(line => line.startsWith("Focus:"));
	const priorityLines = [runLine, flowLine, focusLine, pathLine].filter((line): line is string => line !== undefined);
	if (maxLines <= priorityLines.length) return priorityLines.slice(0, maxLines);
	if (maxLines <= 3) return [...priorityLines, `+${lines.length - priorityLines.length} overview hidden`];
	const remaining = sourceLines.filter(line => !priorityLines.includes(line));
	const visibleRemaining = remaining.slice(0, maxLines - priorityLines.length - 1);
	const hidden = sourceLines.length - priorityLines.length - visibleRemaining.length;
	return [...priorityLines, ...visibleRemaining, `+${hidden} overview hidden`];
}

function workflowGraphCompactPathLine(view: WorkflowGraphView, width: number): string | undefined {
	if (view.nodes.length === 0) return undefined;
	const focusNodeId = view.focus?.nodeId ?? view.activeAgents?.[0]?.nodeId;
	const nodeIds = view.nodes.map(node => (node.id === focusNodeId ? `[${node.id}]` : node.id));
	return truncateToWidth(`Map: ${nodeIds.join(" ─▶ ")}`, Math.max(20, width));
}

function workflowGraphFlowMapLines(view: WorkflowGraphView, width: number, density: WorkflowGraphDensity): string[] {
	if (view.nodes.length === 0) return [];
	const maxRows = density === "full" ? 4 : 1;
	const nodeRows = workflowGraphFlowMapNodeRows(view, width, density === "full" ? 3 : 1);
	const hintRows =
		density === "full" ? workflowGraphFlowMapHintRows(view, width, Math.max(0, maxRows - nodeRows.length)) : [];
	return [...nodeRows, ...hintRows].slice(0, maxRows);
}

function workflowGraphFlowMapNodeRows(view: WorkflowGraphView, width: number, maxRows: number): string[] {
	const rows: string[] = [];
	let row = "";
	for (let index = 0; index < view.nodes.length; index += 1) {
		const node = view.nodes[index]!;
		const token = workflowGraphFlowMapNodeToken(node, width);
		const piece = index === 0 ? token : ` ─▶ ${token}`;
		if (row.length > 0 && visibleWidth(row) + visibleWidth(piece) > width) {
			rows.push(row);
			if (rows.length >= maxRows) return workflowGraphFlowMapRowsWithOverflow(rows, view.nodes.length - index);
			row = `↳ ${token}`;
			continue;
		}
		row = `${row}${piece}`;
	}
	if (row.length > 0) rows.push(row);
	return rows;
}

function workflowGraphFlowMapRowsWithOverflow(rows: string[], hiddenNodeCount: number): string[] {
	if (hiddenNodeCount <= 0) return rows;
	const lastIndex = rows.length - 1;
	rows[lastIndex] = `${rows[lastIndex]}  +${hiddenNodeCount} nodes`;
	return rows;
}

function workflowGraphFlowMapNodeToken(node: WorkflowGraphView["nodes"][number], width: number): string {
	const count = node.activationCount === undefined || node.activationCount <= 0 ? "" : ` ×${node.activationCount}`;
	const labelWidth = Math.max(8, Math.min(24, Math.floor(width / 4)));
	const label = truncateToWidth(node.id, labelWidth);
	return `[${workflowGraphStatusGlyph(node.status)} ${label}${count}]`;
}

function workflowGraphFlowMapHintRows(view: WorkflowGraphView, width: number, maxRows: number): string[] {
	if (maxRows <= 0) return [];
	const order = new Map(view.nodes.map((node, index) => [node.id, index]));
	const outgoing = new Map<string, number>();
	for (const edge of view.edges) outgoing.set(edge.from, (outgoing.get(edge.from) ?? 0) + 1);
	const branches = view.edges
		.filter(edge => (outgoing.get(edge.from) ?? 0) > 1 && !workflowGraphIsBackEdge(edge, order))
		.map(edge => {
			const condition = edge.condition === undefined ? "" : ` · ${formatWorkflowConditionLabel(edge.condition)}`;
			return `${edge.from} ┬▶ ${edge.to}${condition}`;
		});
	const loops = view.edges
		.filter(edge => workflowGraphIsBackEdge(edge, order))
		.map(edge => {
			const condition = edge.condition === undefined ? "" : ` · ${formatWorkflowConditionLabel(edge.condition)}`;
			return `${edge.from} ⟲ ${edge.to}${condition}`;
		});
	const hints = [
		branches.length > 0 ? `Branches: ${branches.slice(0, 2).join("  ·  ")}` : undefined,
		loops.length > 0 ? `Loops: ${loops.slice(0, 2).join("  ·  ")}` : undefined,
	].filter((line): line is string => line !== undefined);
	return hints.slice(0, maxRows).map(line => truncateToWidth(line, Math.max(20, width)));
}

function workflowGraphIsBackEdge(edge: { from: string; to: string }, order: ReadonlyMap<string, number>): boolean {
	const source = order.get(edge.from);
	const target = order.get(edge.to);
	if (source === undefined || target === undefined) return false;
	return target <= source;
}

function fitWorkflowGraphRowsToHeight(lines: string[], width: number, heightBudget: number): string[] {
	if (lines.length <= heightBudget) return lines;
	const safeHeight = Math.max(1, heightBudget);
	if (safeHeight === 1) return [truncateToWidth("... workflow graph clipped ...", width)];
	const headRows = Math.max(1, Math.floor((safeHeight - 1) / 2));
	const tailRows = Math.max(1, safeHeight - headRows - 1);
	const hidden = Math.max(0, lines.length - headRows - tailRows);
	const marker = theme.fg("muted", truncateToWidth(`+${hidden} workflow graph rows hidden`, width));
	return [...lines.slice(0, headRows), marker, ...lines.slice(lines.length - tailRows)];
}

function workflowGraphHeightBudget(value: number | undefined): number | undefined {
	if (value === undefined || !Number.isFinite(value)) return undefined;
	return Math.max(WORKFLOW_GRAPH_MIN_HEIGHT_BUDGET, Math.floor(value));
}

function workflowGraphControlLines(view: WorkflowGraphView, density: WorkflowGraphDensity = "full"): string[] {
	const lines: string[] = [];
	for (const action of formatWorkflowControlLines(view)) {
		lines.push(density === "full" ? `  ${action}` : `  ${compactWorkflowGraphControl(action)}`);
	}
	return lines;
}

function workflowGraphSubflowLines(view: WorkflowGraphView): string[] {
	return (view.subflows ?? []).map(subflow => formatWorkflowSubflow(subflow));
}

function workflowGraphFocusLines(
	view: WorkflowGraphView,
	width: number,
	density: WorkflowGraphDensity = "full",
): string[] {
	return formatWorkflowFocusLines(view).map(line =>
		truncateToWidth(replaceTabs(compactWorkflowGraphStatusLine(line, density)), Math.max(20, width)),
	);
}

function workflowGraphOnFlightLines(
	view: WorkflowGraphView,
	width: number,
	density: WorkflowGraphDensity = "full",
): string[] {
	return formatWorkflowOnFlightLines(view).map(line => {
		const compact = compactWorkflowGraphStatusLine(line, density);
		const prefixed = compact.includes(" live") ? `${theme.fg("accent", "●")} ${compact}` : compact;
		return truncateToWidth(replaceTabs(prefixed), Math.max(20, width));
	});
}

function compactWorkflowGraphStatusLine(line: string, density: WorkflowGraphDensity): string {
	if (density === "full") return line;
	return line
		.replace(/ · [A-Za-z0-9_.-]+\/[A-Za-z0-9_.:+-]+/gu, "")
		.replace(/ · tool [^·]+(?= · |$)/gu, "")
		.replace(/ · (\d+h\d{2}m|\d+m\d{2}s|\d+s) · \d+ tools? · \d+% ctx/gu, " · $1")
		.replace(/\(watch\/intervene ([^)]+)\)/gu, "($1)");
}

function compactWorkflowGraphControl(action: string): string {
	const separator = action.indexOf(" · ");
	if (separator !== -1) return action.slice(0, separator);
	const legacySeparator = action.indexOf(": ");
	if (legacySeparator !== -1) return action.slice(0, legacySeparator);
	return action;
}

function workflowGraphRecentActivityLines(view: WorkflowGraphView, width: number): string[] {
	return formatWorkflowRecentActivityLines(view).map(line =>
		theme.fg("muted", truncateToWidth(replaceTabs(line), Math.max(20, width))),
	);
}

function workflowGraphChangeLines(view: WorkflowGraphView, width: number): string[] {
	return formatWorkflowChangeReviewLines(view).map(line => truncateToWidth(replaceTabs(line), Math.max(20, width)));
}

function workflowGraphSelectedRouteLines(view: WorkflowGraphView): string[] {
	return (view.selectedRoutes ?? []).map(route => formatWorkflowSelectedRoute(route));
}

function colorWorkflowDiagram(lines: string[]): string[] {
	return lines.map(colorWorkflowStatusLine);
}

const WORKFLOW_STATUS_TOKEN_PATTERN =
	/[✓◆◇●!○]|×(?=\s)|\b(?:failed|running|frontier|checkpointed|completed|aborted|pending)\b/gu;

function colorWorkflowStatusLine(line: string): string {
	let rendered = "";
	let offset = 0;
	for (const match of line.matchAll(WORKFLOW_STATUS_TOKEN_PATTERN)) {
		const token = match[0];
		const index = match.index;
		if (index > offset) rendered = `${rendered}${theme.fg("muted", line.slice(offset, index))}`;
		rendered = `${rendered}${theme.fg(workflowGraphStatusColor(workflowGraphStatusFromToken(token)), token)}`;
		offset = index + token.length;
	}
	if (offset < line.length) rendered = `${rendered}${theme.fg("muted", line.slice(offset))}`;
	return rendered;
}

function workflowGraphStatusFromToken(token: string): WorkflowGraphNodeStatus {
	switch (token) {
		case "✓":
		case "completed":
			return "completed";
		case "◆":
		case "checkpointed":
			return "checkpointed";
		case "◇":
		case "frontier":
			return "frontier";
		case "●":
		case "running":
			return "running";
		case "!":
		case "failed":
			return "failed";
		case "×":
		case "aborted":
			return "aborted";
		default:
			return "pending";
	}
}

function workflowGraphStatusColor(status: WorkflowGraphNodeStatus): ThemeColor {
	if (status === "failed") return "error";
	if (status === "running" || status === "frontier") return "accent";
	if (status === "checkpointed" || status === "aborted") return "warning";
	if (status === "completed") return "success";
	return "muted";
}

function workflowGraphStatusGlyph(status: WorkflowGraphNodeStatus): string {
	if (status === "completed") return "✓";
	if (status === "checkpointed") return "◆";
	if (status === "frontier") return "◇";
	if (status === "running") return "●";
	if (status === "failed") return "!";
	if (status === "aborted") return "×";
	return "○";
}

function workflowGraphState(view: WorkflowGraphView): State {
	if (view.nodes.some(node => node.status === "failed")) return "error";
	if (view.nodes.some(node => node.status === "running")) return "running";
	if (view.nodes.some(node => node.status === "frontier")) return "pending";
	if (view.currentAttempt?.status === "completed") return "success";
	return "pending";
}
