import {
	type Component,
	matchesKey,
	type NativeScrollbackLiveRegion,
	replaceTabs,
	truncateToWidth,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import type { State } from "../../tui/types";
import {
	formatWorkflowChangeReviewLines,
	formatWorkflowControlLines,
	formatWorkflowFocusLines,
	formatWorkflowOnFlightLines,
	formatWorkflowOverviewLines,
	formatWorkflowRecentActivityLines,
	formatWorkflowSelectedRoute,
	formatWorkflowSubflow,
	renderWorkflowGraphDiagram,
	selectWorkflowGraphViewNode,
	type WorkflowGraphActiveAgentView,
	type WorkflowGraphNodeStatus,
	type WorkflowGraphView,
} from "../../workflow/graph-view";
import type { WorkflowMonitorDisplayMode } from "../../workflow/monitor-display-mode";
import { type ThemeColor, theme } from "../theme/theme";

export interface WorkflowGraphComponentOptions {
	viewProvider?: () => WorkflowGraphView | undefined;
	onViewChange?: (view: WorkflowGraphView) => void;
	requestRender?: (component: Component) => void;
	refreshMs?: number;
	heightProvider?: () => number | undefined;
	displayMode?: WorkflowMonitorDisplayMode;
	displayModeProvider?: () => WorkflowMonitorDisplayMode;
}

export class WorkflowGraphComponent implements Component, NativeScrollbackLiveRegion {
	#cache?: { width: number; heightBudget?: number; displayMode: WorkflowMonitorDisplayMode; lines: string[] };
	#displayMode: WorkflowMonitorDisplayMode;
	#displayModeProvider?: () => WorkflowMonitorDisplayMode;
	#heightProvider?: () => number | undefined;
	#lastObservedViewSignature?: string;
	#onViewChange?: (view: WorkflowGraphView) => void;
	#requestRender?: (component: Component) => void;
	#selectedActivationIndexByNodeId = new Map<string, number>();
	#selectedNodeId?: string;
	#showKeyboardHelp = false;
	#view: WorkflowGraphView;
	#viewProvider?: () => WorkflowGraphView | undefined;
	#refreshTimer?: NodeJS.Timeout;

	constructor(view: WorkflowGraphView, options: WorkflowGraphComponentOptions = {}) {
		this.#view = view;
		this.#viewProvider = options.viewProvider;
		this.#onViewChange = options.onViewChange;
		this.#requestRender = options.requestRender;
		this.#heightProvider = options.heightProvider;
		this.#displayMode = options.displayMode ?? "full";
		this.#displayModeProvider = options.displayModeProvider;
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
		const displayMode = this.#displayModeProvider?.() ?? this.#displayMode;
		const view = this.#currentView();
		this.#observeView(view);
		if (
			this.#viewProvider === undefined &&
			this.#cache?.width === safeWidth &&
			this.#cache.heightBudget === heightBudget &&
			this.#cache.displayMode === displayMode
		)
			return this.#cache.lines;
		const lines = renderWorkflowGraphBlock(view, safeWidth, heightBudget, displayMode);
		this.#cache = { width: safeWidth, heightBudget, displayMode, lines };
		return lines;
	}

	getNativeScrollbackLiveRegionStart(): number | undefined {
		return 0;
	}

	handleInput(data: string): void {
		const view = this.#currentView();
		if (view.nodes.length === 0) return;
		if (matchesKey(data, "tab") || matchesKey(data, "right")) {
			this.#moveSelectedNode(view, 1);
			return;
		}
		if (matchesKey(data, "shift+tab") || data === "\x1b[Z" || matchesKey(data, "left")) {
			this.#moveSelectedNode(view, -1);
			return;
		}
		if (data === "]" || data === "}") {
			this.#moveSelectedActivation(view, 1);
			return;
		}
		if (data === "[" || data === "{") {
			this.#moveSelectedActivation(view, -1);
			return;
		}
		if (data.toLowerCase() === "h" || data === "?") {
			this.#showKeyboardHelp = !this.#showKeyboardHelp;
			this.#selectionChanged();
		}
	}

	#currentView(): WorkflowGraphView {
		const view = this.#viewProvider?.() ?? this.#view;
		return this.#selectedView(view);
	}

	#observeView(view: WorkflowGraphView): void {
		if (this.#onViewChange === undefined) return;
		const signature = JSON.stringify(view);
		if (signature === this.#lastObservedViewSignature) return;
		this.#lastObservedViewSignature = signature;
		this.#onViewChange(view);
	}

	#selectedView(view: WorkflowGraphView): WorkflowGraphView {
		const nodeId = this.#selectedWorkflowNodeId(view);
		if (nodeId === undefined) return this.#viewWithKeyboardHelp(view);
		const activationIndex = this.#selectedActivationIndexByNodeId.get(nodeId);
		return this.#viewWithKeyboardHelp(selectWorkflowGraphViewNode(view, nodeId, activationIndex));
	}

	#selectedWorkflowNodeId(view: WorkflowGraphView): string | undefined {
		if (this.#selectedNodeId !== undefined && view.nodes.some(node => node.id === this.#selectedNodeId)) {
			return this.#selectedNodeId;
		}
		return view.focus?.nodeId ?? view.nodes.find(node => node.focused)?.id ?? view.nodes[0]?.id;
	}

	#moveSelectedNode(view: WorkflowGraphView, delta: number): void {
		const selectedNodeId = this.#selectedWorkflowNodeId(view);
		if (selectedNodeId === undefined) return;
		const selectedIndex = view.nodes.findIndex(node => node.id === selectedNodeId);
		if (selectedIndex === -1) return;
		const nextIndex = wrapWorkflowGraphIndex(selectedIndex + delta, view.nodes.length);
		this.#selectedNodeId = view.nodes[nextIndex]?.id;
		this.#selectionChanged();
	}

	#moveSelectedActivation(view: WorkflowGraphView, delta: number): void {
		const selectedNodeId = this.#selectedWorkflowNodeId(view);
		if (selectedNodeId === undefined) return;
		const node = view.nodes.find(candidate => candidate.id === selectedNodeId);
		const activationCount = node?.activations?.length ?? node?.activationCount ?? 0;
		if (activationCount <= 1) return;
		const currentIndex = this.#selectedActivationIndexByNodeId.get(selectedNodeId) ?? 0;
		this.#selectedActivationIndexByNodeId.set(
			selectedNodeId,
			wrapWorkflowGraphIndex(currentIndex + delta, activationCount),
		);
		this.#selectionChanged();
	}

	#viewWithKeyboardHelp(view: WorkflowGraphView): WorkflowGraphView {
		if (!this.#showKeyboardHelp) return view;
		return {
			...view,
			actions: [
				"Keyboard help: Tab/Shift-Tab moves node focus; [/] switches activation; Enter/observe opens Agent Hub transcript; /workflow dashboard collapse frees prompt space",
				...view.actions,
			],
		};
	}

	#selectionChanged(): void {
		this.invalidate();
		this.#requestRender?.(this);
	}
}

function wrapWorkflowGraphIndex(index: number, length: number): number {
	if (length <= 0) return 0;
	return ((index % length) + length) % length;
}

type WorkflowGraphDensity = "full" | "compact";
type WorkflowGraphActionKind = "refresh" | "stop" | "restart" | "interrupt" | "agentHub" | "steer" | "watch" | "change";

interface WorkflowGraphActionMeta {
	kind: WorkflowGraphActionKind;
	pattern: RegExp;
	glyph: string;
	railToken?: string;
}

const WORKFLOW_GRAPH_ACTION_META: readonly WorkflowGraphActionMeta[] = [
	{ kind: "refresh", pattern: /^Refresh\b/u, glyph: "⟳" },
	{ kind: "stop", pattern: /^Stop\b/u, glyph: "■", railToken: "■ stop" },
	{ kind: "restart", pattern: /^Restart\b/u, glyph: "▶", railToken: "▶ restart" },
	{ kind: "interrupt", pattern: /^Interrupt\b/u, glyph: "!", railToken: "! interrupt" },
	{ kind: "agentHub", pattern: /^Open Agent Hub\b/u, glyph: "⌘" },
	{ kind: "steer", pattern: /^Steer\b/u, glyph: "↵" },
	{ kind: "watch", pattern: /^Watch\b/u, glyph: "◉" },
	{ kind: "change", pattern: /^(?:Propose change|Request change)\b/u, glyph: "±", railToken: "± change" },
];

interface WorkflowGraphCompactProfile {
	overviewLines: number;
	focusLines: number;
	onFlightLines: number;
	recentActivityLines: number;
	controlLines: number;
	diagramChromeRows: number;
	pathLine: boolean;
}

const WORKFLOW_GRAPH_MIN_HEIGHT_BUDGET = 6;
const WORKFLOW_GRAPH_WORKBENCH_MIN_WIDTH = 118;
const WORKFLOW_GRAPH_WORKBENCH_MIN_PANE_WIDTH = 38;
const WORKFLOW_GRAPH_WORKBENCH_MAX_PANE_WIDTH = 72;
const WORKFLOW_GRAPH_WORKBENCH_ULTRAWIDE_MAX_PANE_WIDTH = 112;
const WORKFLOW_GRAPH_PANE_GAP_WIDTH = 3;
const WORKFLOW_GRAPH_FRAME_CHROME_WIDTH = 4;
const WORKFLOW_GRAPH_FLOW_MAP_HINT_MIN_WIDTH = 93;
const WORKFLOW_GRAPH_FORCED_COMPACT_HEIGHT = 14;
const WORKFLOW_GRAPH_MODEL_STATUS_SEGMENT_PATTERN =
	/ · (?:[A-Za-z0-9_.-]+\/)?(?:gpt|claude|gemini|deepseek|llama|qwen|mistral|o\d)[A-Za-z0-9_.:+-]*/giu;

function renderWorkflowGraphBlock(
	view: WorkflowGraphView,
	safeWidth: number,
	heightBudget: number | undefined,
	displayMode: WorkflowMonitorDisplayMode,
): string[] {
	if (displayMode === "collapsed") return renderWorkflowGraphCollapsedRows(view, safeWidth);
	if (displayMode === "compact") {
		const compactBudget =
			heightBudget === undefined
				? WORKFLOW_GRAPH_FORCED_COMPACT_HEIGHT
				: Math.min(heightBudget, WORKFLOW_GRAPH_FORCED_COMPACT_HEIGHT);
		const compact = renderWorkflowGraphBlockAtDensity(view, safeWidth, "compact", compactBudget);
		const hinted = insertWorkflowGraphDashboardModeHint(compact, view, safeWidth);
		return hinted.length <= compactBudget
			? hinted
			: fitWorkflowGraphDashboardRowsToHeight(hinted, safeWidth, compactBudget);
	}
	const full = renderWorkflowGraphBlockAtDensity(view, safeWidth, "full", undefined);
	if (heightBudget === undefined || full.length <= heightBudget) return full;
	const compact = renderWorkflowGraphBlockAtDensity(view, safeWidth, "compact", heightBudget);
	return compact.length <= heightBudget
		? compact
		: fitWorkflowGraphDashboardRowsToHeight(compact, safeWidth, heightBudget);
}

function renderWorkflowGraphBlockAtDensity(
	view: WorkflowGraphView,
	safeWidth: number,
	density: WorkflowGraphDensity,
	heightBudget: number | undefined,
): string[] {
	const contentWidth = Math.max(20, safeWidth - WORKFLOW_GRAPH_FRAME_CHROME_WIDTH);
	const profile = workflowGraphCompactProfile(density, heightBudget);
	const headerLines = workflowGraphDashboardHeaderLines(view, contentWidth, density, profile);
	const bodyLines = workflowGraphDashboardBodyLines(view, contentWidth, density, heightBudget, profile);
	return renderWorkflowGraphDashboardFrame(view, safeWidth, [...headerLines, ...bodyLines]);
}

function workflowGraphDashboardHeaderLines(
	view: WorkflowGraphView,
	width: number,
	density: WorkflowGraphDensity,
	profile: WorkflowGraphCompactProfile,
): string[] {
	const overviewSourceLines = workflowGraphDashboardOverviewLines(view, width);
	const overviewLines =
		density === "full"
			? overviewSourceLines
			: limitWorkflowGraphOverviewLines(
					overviewSourceLines,
					profile.overviewLines,
					profile.pathLine ? workflowGraphCompactPathLine(view, width) : undefined,
				);
	const deckLines = workflowGraphDashboardHeaderDeckLines(overviewLines, width, profile.overviewLines);
	if (deckLines.length > 0) return deckLines;
	return overviewLines.map((line, index) =>
		index === 0 ? workflowGraphDashboardPrimaryLine(line, width) : workflowGraphDashboardMetricLine(line, width),
	);
}

function workflowGraphDashboardHeaderDeckLines(lines: readonly string[], width: number, maxRows: number): string[] {
	if (width < 96 || maxRows <= 1) return [];
	const lineByLabel = new Map<string, string>();
	const usedLines = new Set<string>();
	for (const line of lines) {
		const separator = line.indexOf(":");
		if (separator === -1) continue;
		lineByLabel.set(line.slice(0, separator), line);
	}
	const pick = (label: string): string | undefined => {
		const line = lineByLabel.get(label);
		if (line !== undefined) usedLines.add(line);
		return line;
	};
	const rows = [
		workflowGraphDashboardSegmentLine(
			[pick("Run"), pick("Flow")].filter((line): line is string => line !== undefined),
			width,
		),
		workflowGraphDashboardSegmentLine(
			[pick("Progress"), pick("Focus")].filter((line): line is string => line !== undefined),
			width,
		),
		workflowGraphDashboardSegmentLine(
			[pick("Ops"), pick("Flow changes")].filter((line): line is string => line !== undefined),
			width,
		),
	].filter(line => line.length > 0);
	for (const line of lines) {
		if (usedLines.has(line)) continue;
		rows.push(workflowGraphDashboardSegmentLine([line], width));
	}
	return rows.slice(0, Math.min(rows.length, Math.max(1, maxRows)));
}

function workflowGraphDashboardSegmentLine(lines: readonly string[], width: number): string {
	if (lines.length === 0) return "";
	const separator = theme.fg("borderMuted", "  │  ");
	return truncateToWidth(lines.map(workflowGraphDashboardSegment).join(separator), width);
}

function workflowGraphDashboardSegment(line: string): string {
	const separator = line.indexOf(":");
	if (separator === -1) return line;
	const labelText = line.slice(0, separator + 1);
	const valueText = line.slice(separator + 1);
	const status = labelText === "Run:" ? workflowGraphStatusFromRunLine(line) : undefined;
	const glyph =
		status === undefined ? "" : `${theme.fg(workflowGraphStatusColor(status), workflowGraphStatusGlyph(status))} `;
	return `${glyph}${theme.fg("muted", labelText)}${valueText}`;
}

function workflowGraphDashboardBodyLines(
	view: WorkflowGraphView,
	width: number,
	density: WorkflowGraphDensity,
	heightBudget: number | undefined,
	profile: WorkflowGraphCompactProfile,
): string[] {
	const layout = workflowGraphDashboardLayout(width, density, heightBudget);
	if (layout.kind === "wide") return workflowGraphDashboardWideBodyLines(view, layout, density, heightBudget, profile);
	return workflowGraphDashboardStackedBodyLines(view, width, density, heightBudget, profile);
}

interface WorkflowGraphDashboardWideLayout {
	kind: "wide";
	graphWidth: number;
	workbenchWidth: number;
}

interface WorkflowGraphDashboardStackedLayout {
	kind: "stacked";
}

type WorkflowGraphDashboardLayout = WorkflowGraphDashboardWideLayout | WorkflowGraphDashboardStackedLayout;

function workflowGraphDashboardLayout(
	width: number,
	density: WorkflowGraphDensity,
	heightBudget: number | undefined,
): WorkflowGraphDashboardLayout {
	if (width < WORKFLOW_GRAPH_WORKBENCH_MIN_WIDTH) return { kind: "stacked" };
	if (density === "compact" && (heightBudget ?? 0) <= 20) return { kind: "stacked" };
	const maximumWorkbenchWidth =
		width >= 220 ? WORKFLOW_GRAPH_WORKBENCH_ULTRAWIDE_MAX_PANE_WIDTH : WORKFLOW_GRAPH_WORKBENCH_MAX_PANE_WIDTH;
	const preferredWorkbenchRatio = width >= 220 ? 0.45 : 0.34;
	const workbenchWidth = Math.max(
		WORKFLOW_GRAPH_WORKBENCH_MIN_PANE_WIDTH,
		Math.min(maximumWorkbenchWidth, Math.floor(width * preferredWorkbenchRatio)),
	);
	const graphWidth = Math.max(48, width - workbenchWidth - WORKFLOW_GRAPH_PANE_GAP_WIDTH);
	return { kind: "wide", graphWidth, workbenchWidth };
}

function workflowGraphDashboardWideBodyLines(
	view: WorkflowGraphView,
	layout: WorkflowGraphDashboardWideLayout,
	density: WorkflowGraphDensity,
	heightBudget: number | undefined,
	profile: WorkflowGraphCompactProfile,
): string[] {
	const flowLensProfile = workflowGraphWideFlowLensProfile(profile, density, heightBudget);
	const workbenchProfile = workflowGraphWideWorkbenchProfile(profile, density, heightBudget);
	const graphContentLines = workflowGraphFlowLensLines(
		view,
		layout.graphWidth - WORKFLOW_GRAPH_FRAME_CHROME_WIDTH,
		density,
		heightBudget,
		flowLensProfile,
	);
	const workbenchContentLines = workflowGraphLiveWorkbenchLines(
		view,
		layout.workbenchWidth - WORKFLOW_GRAPH_FRAME_CHROME_WIDTH,
		density,
		workbenchProfile,
	);
	const panelContentRows = Math.max(graphContentLines.length, workbenchContentLines.length);
	const graphLines = renderWorkflowGraphDashboardPanel(
		"Flow Lens · Canvas",
		layout.graphWidth,
		padWorkflowGraphPanelContentLines(graphContentLines, panelContentRows),
	);
	const workbenchLines = renderWorkflowGraphDashboardPanel(
		workflowGraphWorkbenchTitle(view),
		layout.workbenchWidth,
		padWorkflowGraphPanelContentLines(workbenchContentLines, panelContentRows),
		workflowGraphLiveWorkbenchAccent(view),
	);
	const rowCount = Math.max(graphLines.length, workbenchLines.length);
	const rows: string[] = [];
	const gap = " ".repeat(WORKFLOW_GRAPH_PANE_GAP_WIDTH);
	for (let index = 0; index < rowCount; index += 1) {
		const graphLine = padWorkflowGraphLine(
			truncateToWidth(graphLines[index] ?? "", layout.graphWidth),
			layout.graphWidth,
		);
		const workbenchLine = truncateToWidth(workbenchLines[index] ?? "", layout.workbenchWidth);
		rows.push(`${graphLine}${gap}${padWorkflowGraphLine(workbenchLine, layout.workbenchWidth)}`.trimEnd());
	}
	return rows;
}

function padWorkflowGraphPanelContentLines(lines: readonly string[], targetRows: number): string[] {
	if (lines.length >= targetRows) return [...lines];
	return [...lines, ...Array.from({ length: targetRows - lines.length }, () => "")];
}

function workflowGraphWideFlowLensProfile(
	profile: WorkflowGraphCompactProfile,
	density: WorkflowGraphDensity,
	heightBudget: number | undefined,
): WorkflowGraphCompactProfile {
	if (density === "full" || heightBudget === undefined) return profile;
	if (heightBudget < 32) return profile;
	return {
		...profile,
		diagramChromeRows:
			heightBudget >= 42 ? Math.max(profile.diagramChromeRows, 16) : Math.min(profile.diagramChromeRows, 14),
	};
}

function workflowGraphWideWorkbenchProfile(
	profile: WorkflowGraphCompactProfile,
	density: WorkflowGraphDensity,
	heightBudget: number | undefined,
): WorkflowGraphCompactProfile {
	if (density === "full" || heightBudget === undefined) return profile;
	if (heightBudget < 32) return profile;
	const roomy = heightBudget >= 44;
	return {
		...profile,
		focusLines: Math.max(profile.focusLines, roomy ? 5 : 3),
		onFlightLines: Math.max(profile.onFlightLines, roomy ? 5 : 3),
		recentActivityLines: Math.max(profile.recentActivityLines, roomy ? 6 : 4),
		controlLines: Math.max(profile.controlLines, roomy ? 5 : 4),
	};
}

function workflowGraphDashboardStackedBodyLines(
	view: WorkflowGraphView,
	width: number,
	density: WorkflowGraphDensity,
	heightBudget: number | undefined,
	profile: WorkflowGraphCompactProfile,
): string[] {
	if (density === "compact" && (heightBudget ?? 0) <= 14) {
		const contentWidth = width - WORKFLOW_GRAPH_FRAME_CHROME_WIDTH;
		return renderWorkflowGraphDashboardPanel("Flow Lens · Canvas", width, [
			...workflowGraphTinyCompactOperatorLines(view, contentWidth),
			...workflowGraphFlowLensLines(view, contentWidth, density, heightBudget, profile),
		]);
	}
	return [
		...renderWorkflowGraphDashboardPanel(
			"Flow Lens · Canvas",
			width,
			workflowGraphFlowLensLines(view, width - WORKFLOW_GRAPH_FRAME_CHROME_WIDTH, density, heightBudget, profile),
		),
		"",
		...renderWorkflowGraphDashboardPanel(
			workflowGraphWorkbenchTitle(view),
			width,
			workflowGraphLiveWorkbenchLines(view, width - WORKFLOW_GRAPH_FRAME_CHROME_WIDTH, density, profile),
			workflowGraphLiveWorkbenchAccent(view),
		),
	];
}

function workflowGraphWorkbenchTitle(view: WorkflowGraphView): string {
	return workflowGraphHasLiveWork(view) ? "Live Workbench · Operator Deck" : "Operator Deck";
}

function workflowGraphTinyCompactOperatorLines(view: WorkflowGraphView, width: number): string[] {
	const primaryAction = workflowGraphCollapsedPrimaryAction(view);
	const railLines = workflowGraphOperatorRailLines(view, width, "compact");
	const lines = [...railLines, primaryAction].filter((line): line is string => line !== undefined && line.length > 0);
	if (lines.length === 0) return [];
	return lines.slice(0, 2).map(line => truncateToWidth(`Action: ${line}`, Math.max(20, width)));
}

function workflowGraphHasLiveWork(view: WorkflowGraphView): boolean {
	return (view.activeAgents ?? []).length > 0 || view.nodes.some(node => node.status === "running");
}

function workflowGraphFlowLensLines(
	view: WorkflowGraphView,
	width: number,
	density: WorkflowGraphDensity,
	heightBudget: number | undefined,
	profile: WorkflowGraphCompactProfile,
): string[] {
	const flowMapLines =
		density === "compact" && (heightBudget ?? 0) <= 14 ? [] : workflowGraphFlowMapLines(view, width, density);
	const diagramLines = workflowGraphDiagramLines(view, width, density, heightBudget, profile.diagramChromeRows);
	const lines: string[] = [];
	if (flowMapLines.length > 0) {
		lines.push(workflowGraphDashboardSubsectionLabel("Path map"));
		lines.push(...colorWorkflowDiagram(flowMapLines));
	}
	const legend = workflowGraphLegendLine(width);
	if (legend !== undefined && (density === "full" || (width >= 90 && (heightBudget ?? 0) >= 42))) {
		lines.push(colorWorkflowStatusLine(legend));
	}
	lines.push(workflowGraphDashboardSubsectionLabel("diagram · topology canvas"));
	lines.push(...colorWorkflowDiagram(diagramLines));
	const liveLaneLines =
		density === "full" || heightBudget === undefined || heightBudget >= 44
			? workflowGraphFlowLensLiveLaneLines(view, width, density)
			: [];
	if (liveLaneLines.length > 0) {
		lines.push(workflowGraphDashboardSubsectionLabel("live lanes · agent progress"));
		lines.push(...liveLaneLines);
	}
	return lines.map(line => truncateToWidth(line, width));
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
	return limitWorkflowGraphDiagramLines(
		lines,
		Math.max((heightBudget ?? 0) <= 14 ? 1 : 4, Math.min(lines.length, (heightBudget ?? 32) - diagramChromeRows)),
		view,
		width,
	);
}

function workflowGraphLiveWorkbenchLines(
	view: WorkflowGraphView,
	width: number,
	density: WorkflowGraphDensity,
	profile: WorkflowGraphCompactProfile,
): string[] {
	const focusLines = workflowGraphWorkbenchFocusLines(view, width, density);
	const onFlightLines = workflowGraphOnFlightLines(view, width - 2, "compact");
	const recentLines = workflowGraphRecentActivityLines(view, width - 2);
	const controlLines = workflowGraphControlLines(view, "compact").map(line => line.trim());
	const maxFocus = density === "full" ? 5 : profile.focusLines;
	const maxOnFlight = density === "full" ? 5 : profile.onFlightLines;
	const maxRecent = density === "full" ? 4 : profile.recentActivityLines;
	const maxControls = density === "full" ? 5 : profile.controlLines;
	const maxRoutes = density === "full" ? 3 : profile.recentActivityLines > 0 ? 2 : 0;
	const maxChanges = density === "full" ? 3 : profile.recentActivityLines > 0 ? 2 : 0;
	const maxPulse = density === "full" ? 4 : profile.recentActivityLines > 0 ? 2 : 0;
	const maxTabs =
		density === "full" ? 4 : width >= WORKFLOW_GRAPH_WORKBENCH_MIN_WIDTH && profile.onFlightLines > 0 ? 2 : 0;
	const lines: string[] = [];
	const railLines = workflowGraphOperatorRailLines(view, width, density);
	if (railLines.length > 0) {
		lines.push(...workflowGraphWorkbenchGroup("Operator rail", railLines, width, density === "full" ? 2 : 1));
	}
	lines.push(
		...workflowGraphWorkbenchGroup(
			"Guide: keyboard",
			workflowGraphInteractionGuideLines(view, width, density),
			width,
			density === "full" ? 2 : 1,
		),
	);
	if (maxFocus > 0) lines.push(...workflowGraphWorkbenchGroup("Focus: selected node", focusLines, width, maxFocus));
	if (maxTabs > 0) {
		const tabLines = workflowGraphAgentTabLines(view, width);
		if (tabLines.length > 0) {
			lines.push(...workflowGraphWorkbenchGroup("Agent tabs: transcript monitors", tabLines, width, maxTabs));
		}
	}
	if (maxControls > 0)
		lines.push(...workflowGraphWorkbenchGroup("Controls: operator actions", controlLines, width, maxControls));
	if (maxOnFlight > 0)
		lines.push(
			...workflowGraphWorkbenchGroup(workflowGraphOnFlightGroupLabel(view), onFlightLines, width, maxOnFlight),
		);
	if (recentLines.length > 0 && maxRecent > 0) {
		lines.push(...workflowGraphWorkbenchGroup("Recent output: tail", recentLines, width, maxRecent));
	}
	if (maxPulse > 0) {
		const pulseLines = workflowGraphNodePulseLines(view, width);
		if (pulseLines.length > 0) {
			lines.push(...workflowGraphWorkbenchGroup("Node pulse: state lanes", pulseLines, width, maxPulse));
		}
	}
	if (density === "full" && view.subflows !== undefined && view.subflows.length > 0) {
		lines.push(...workflowGraphWorkbenchGroup("flow calls", workflowGraphSubflowLines(view), width, 3));
	}
	if (view.selectedRoutes !== undefined && view.selectedRoutes.length > 0 && maxRoutes > 0) {
		lines.push(...workflowGraphWorkbenchGroup("routes", workflowGraphSelectedRouteLines(view), width, maxRoutes));
	}
	if (view.lineage.length > 0 && maxChanges > 0) {
		lines.push(
			...workflowGraphWorkbenchGroup("change review", workflowGraphChangeLines(view, width), width, maxChanges),
		);
	}
	return lines.map(line => truncateToWidth(line, width));
}

function workflowGraphOnFlightGroupLabel(view: WorkflowGraphView): string {
	const agents = view.activeAgents ?? [];
	const agentNodeIds = new Set(agents.map(agent => agent.nodeId));
	const hasNonAgentLiveWork = view.nodes.some(node => node.status === "running" && !agentNodeIds.has(node.id));
	return hasNonAgentLiveWork || agents.length === 0 ? "On-flight: live work" : "On-flight: live agents";
}

function workflowGraphOperatorRailLines(
	view: WorkflowGraphView,
	width: number,
	density: WorkflowGraphDensity,
): string[] {
	const selected = workflowGraphSelectedAgentTarget(view);
	const subject = selected ?? view.focus?.nodeId ?? view.currentAttempt?.id ?? "workflow";
	const primaryTokens = [workflowGraphOperatorRailPrimaryToken(subject, selected !== undefined)];
	if (selected !== undefined) {
		primaryTokens.push("hub ←←/observe", "↵ steer");
	} else if (view.focus !== undefined) {
		primaryTokens.push("details /workflow help agents");
	}
	const actionKinds = workflowGraphActionKinds(view);
	const safetyTokens: string[] = [];
	for (const kind of ["interrupt", "stop", "restart", "change"] satisfies WorkflowGraphActionKind[]) {
		const railToken = workflowGraphActionMeta(kind)?.railToken;
		if (railToken !== undefined && actionKinds.has(kind)) safetyTokens.push(railToken);
	}
	if (density !== "full") {
		return [[...primaryTokens, ...safetyTokens].join("  ")]
			.filter(line => line.length > 0)
			.map(line => truncateToWidth(line, Math.max(20, width)));
	}
	return [primaryTokens.join("  "), safetyTokens.join("  ")]
		.filter(line => line.length > 0)
		.map(line => truncateToWidth(line, Math.max(20, width)));
}

function workflowGraphOperatorRailPrimaryToken(subject: string, hasLiveAgentTarget: boolean): string {
	const compactSubject = compactWorkflowGraphNodeId(subject);
	return hasLiveAgentTarget ? `◉ monitor ${compactSubject}` : `◎ focus ${compactSubject}`;
}

function workflowGraphInteractionGuideLines(
	view: WorkflowGraphView,
	width: number,
	density: WorkflowGraphDensity,
): string[] {
	const activationHint = view.nodes.some(node => (node.activationCount ?? node.activations?.length ?? 0) > 1)
		? "  [/] activations"
		: "";
	const transcriptHint = (view.activeAgents ?? []).length > 0 ? "Agent Hub transcript" : "/workflow help agents";
	const lines =
		density === "full"
			? [`Tab/Shift-Tab nodes${activationHint}`, `h help  ${transcriptHint}`]
			: [`Tab/Shift-Tab nodes${activationHint}  h help`];
	return lines.map(line => truncateToWidth(line, Math.max(20, width)));
}

function workflowGraphSelectedAgentTarget(view: WorkflowGraphView): string | undefined {
	const agents = view.activeAgents ?? [];
	const focusAgentId = view.focus?.focusAgentId;
	if (view.focus !== undefined && focusAgentId === undefined) return undefined;
	return agents.find(agent => agent.focusAgentId === focusAgentId)?.focusAgentId ?? agents[0]?.focusAgentId;
}

function workflowGraphActionKinds(view: WorkflowGraphView): ReadonlySet<WorkflowGraphActionKind> {
	const kinds = new Set<WorkflowGraphActionKind>();
	for (const action of view.actions) {
		const kind = workflowGraphActionKind(compactWorkflowGraphControl(action));
		if (kind !== undefined) kinds.add(kind);
	}
	return kinds;
}

function workflowGraphActionKind(label: string): WorkflowGraphActionKind | undefined {
	return WORKFLOW_GRAPH_ACTION_META.find(meta => meta.pattern.test(label))?.kind;
}

function workflowGraphActionMeta(kind: WorkflowGraphActionKind): WorkflowGraphActionMeta | undefined {
	return WORKFLOW_GRAPH_ACTION_META.find(meta => meta.kind === kind);
}

function workflowGraphWorkbenchGroup(
	label: string,
	lines: readonly string[],
	width: number,
	maxLines: number,
): string[] {
	const rows = [workflowGraphDashboardSubsectionLabel(label)];
	const visibleLines = lines.length === 0 ? ["none"] : lines.slice(0, maxLines);
	for (const line of visibleLines) {
		rows.push(`${theme.fg("borderMuted", "│")} ${truncateToWidth(replaceTabs(line), Math.max(8, width - 2))}`);
	}
	if (lines.length > visibleLines.length) {
		rows.push(`${theme.fg("borderMuted", "│")} ${theme.fg("dim", `+${lines.length - visibleLines.length} hidden`)}`);
	}
	return rows;
}

function workflowGraphWorkbenchFocusLines(
	view: WorkflowGraphView,
	width: number,
	density: WorkflowGraphDensity,
): string[] {
	const lines = workflowGraphFocusLines(view, width, "compact");
	const headline = workflowGraphFocusHeadline(view, density);
	const sourceLines =
		headline === undefined
			? lines.length > 0
				? lines
				: workflowGraphOnFlightLines(view, width, "compact").slice(0, 1)
			: [headline, ...lines.slice(1)];
	const status = view.focus?.status ?? view.activeAgents?.[0]?.status ?? "pending";
	return sourceLines.map((line, index) => {
		const compact = compactWorkflowGraphFocusControlLine(compactWorkflowGraphStatusLine(line, density));
		const prefix =
			index === 0 && !workflowGraphLineStartsWithStatusGlyph(compact)
				? `${theme.fg(workflowGraphStatusColor(status), workflowGraphStatusGlyph(status))} `
				: "  ";
		return truncateToWidth(replaceTabs(`${prefix}${compact}`), Math.max(20, width));
	});
}

interface WorkflowGraphHeadlineSubject {
	role: string;
	label: string;
	status: WorkflowGraphNodeStatus;
	focusAgentId?: string;
	generation?: number;
	stats?: string;
	activity?: string;
	summary?: string;
}

function workflowGraphFocusHeadline(view: WorkflowGraphView, density: WorkflowGraphDensity): string | undefined {
	const subject = workflowGraphFocusHeadlineSubject(view);
	if (subject === undefined) return undefined;
	const generation = subject.generation === undefined ? undefined : `round ${subject.generation}`;
	const duration = workflowGraphDurationFromStats(subject.stats);
	const activity = subject.activity ?? subject.summary;
	const detail = activity === undefined ? undefined : formatWorkflowGraphHeadlineDetail(activity);
	const parts = [generation, duration, detail].filter((part): part is string => part !== undefined && part.length > 0);
	const status = subject.status === "running" && subject.focusAgentId !== undefined ? "live" : subject.status;
	const suffix = parts.length === 0 ? "" : ` · ${parts.join(" · ")}`;
	const line = `${subject.role}: ${subject.label} ${status}${suffix}`;
	return density === "full" ? line : compactWorkflowGraphStatusLine(line, density);
}

function workflowGraphFocusHeadlineSubject(view: WorkflowGraphView): WorkflowGraphHeadlineSubject | undefined {
	const focus = view.focus;
	if (focus !== undefined) return focus;
	const activeAgent = view.activeAgents?.[0];
	if (activeAgent === undefined) return undefined;
	return activeAgent;
}

function workflowGraphDurationFromStats(stats: string | undefined): string | undefined {
	return stats?.match(/\b(?:\d+h\d{2}m|\d+m\d{2}s|\d+s)\b/u)?.[0];
}

function formatWorkflowGraphHeadlineDetail(value: string): string {
	return replaceTabs(value).replace(/\s+/gu, " ").trim();
}

function workflowGraphAgentTabLines(view: WorkflowGraphView, width: number): string[] {
	const agents = view.activeAgents ?? [];
	if (agents.length === 0) return [];
	const selectedNodeId = view.focus?.nodeId ?? agents[0]?.nodeId;
	const tabs = agents.map((agent, index) =>
		workflowGraphAgentTabToken(agent, index + 1, agent.nodeId === selectedNodeId),
	);
	const hint =
		agents.length > 1
			? "switch: Agent Hub tab/arrow keys · Enter steers selected"
			: "open: Agent Hub transcript · Enter steers selected";
	return [truncateToWidth(tabs.join("  "), Math.max(20, width)), truncateToWidth(hint, Math.max(20, width))];
}

function workflowGraphAgentTabToken(agent: WorkflowGraphActiveAgentView, index: number, selected: boolean): string {
	const marker = selected ? "●" : "○";
	const duration = workflowGraphDurationFromStats(agent.stats);
	const detail = duration === undefined ? "" : ` · ${duration}`;
	return `[${index}] ${marker} ${compactWorkflowGraphNodeId(agent.nodeId)}${detail}`;
}

function workflowGraphFlowLensLiveLaneLines(
	view: WorkflowGraphView,
	width: number,
	density: WorkflowGraphDensity,
): string[] {
	const agents = view.activeAgents ?? [];
	if (agents.length === 0 || width < 72) return [];
	const maxAgents = density === "full" ? 4 : 3;
	const visibleAgents = agents.slice(0, maxAgents);
	const lines = visibleAgents.map(agent => workflowGraphFlowLensLiveLaneLine(agent, width));
	if (agents.length > visibleAgents.length) {
		lines.push(theme.fg("dim", `+${agents.length - visibleAgents.length} live agents hidden`));
	}
	return lines;
}

function workflowGraphFlowLensLiveLaneLine(agent: WorkflowGraphActiveAgentView, width: number): string {
	const labelWidth = Math.max(10, Math.min(22, Math.floor(width * 0.16)));
	const railWidth = Math.max(8, Math.min(28, Math.floor(width * 0.18)));
	const label = padWorkflowGraphLine(
		truncateToWidth(compactWorkflowGraphNodeId(agent.nodeId), labelWidth),
		labelWidth,
	);
	const rail = theme.fg("accent", `${"━".repeat(Math.max(1, railWidth - 1))}▶`);
	const duration = workflowGraphDurationFromStats(agent.stats) ?? "live";
	const detail = workflowGraphFlowLensAgentDetail(agent);
	const suffix = detail === undefined ? duration : `${duration} · ${detail}`;
	const suffixWidth = Math.max(12, width - visibleWidth(label) - railWidth - 5);
	return truncateToWidth(
		`${theme.fg("accent", "●")} ${theme.fg("muted", label)} ${rail} ${theme.fg("muted", truncateToWidth(suffix, suffixWidth))}`,
		width,
	);
}

function workflowGraphFlowLensAgentDetail(agent: WorkflowGraphActiveAgentView): string | undefined {
	const detail = agent.activity ?? agent.summary ?? agent.recentOutput?.at(-1);
	if (detail === undefined) return undefined;
	const normalized = formatWorkflowGraphHeadlineDetail(detail);
	return normalized.length === 0 ? undefined : normalized;
}

function workflowGraphNodePulseLines(view: WorkflowGraphView, width: number): string[] {
	const running = view.nodes.filter(node => node.status === "running");
	const frontier = view.nodes.filter(node => node.status === "frontier");
	const pending = view.nodes.filter(node => node.status === "pending");
	const finished = view.nodes.filter(node => node.status === "completed" || node.status === "checkpointed");
	const repeated = view.nodes.filter(node => (node.activationCount ?? 0) > 1);
	const rows = [
		workflowGraphNodePulseLine("live", running, width),
		workflowGraphNodePulseLine("frontier", frontier, width),
		workflowGraphNodePulseLine("next", pending.slice(0, 3), width),
		workflowGraphNodePulseLine("done", finished.slice(-3), width),
		workflowGraphNodePulseLine("rounds", repeated.slice(-3), width),
	].filter((line): line is string => line !== undefined);
	return rows;
}

function workflowGraphNodePulseLine(
	label: string,
	nodes: readonly WorkflowGraphView["nodes"][number][],
	width: number,
): string | undefined {
	if (nodes.length === 0) return undefined;
	const tokens = nodes.map(node => workflowGraphNodePulseToken(node, Math.max(12, Math.floor(width / 3))));
	return truncateToWidth(`${label}: ${tokens.join("  ·  ")}`, Math.max(20, width));
}

function workflowGraphNodePulseToken(node: WorkflowGraphView["nodes"][number], width: number): string {
	const count = node.activationCount === undefined || node.activationCount <= 0 ? "" : ` ×${node.activationCount}`;
	return `${workflowGraphStatusGlyph(node.status)} ${truncateToWidth(compactWorkflowGraphNodeId(node.id), width)}${count}`;
}

function workflowGraphLineStartsWithStatusGlyph(line: string): boolean {
	return /^[✓◆◇●!×○]\s/u.test(line);
}

function compactWorkflowGraphFocusControlLine(line: string): string {
	return line
		.replace(/^control: Watch: Agent Hub (.+)$/u, "watch: Agent Hub $1")
		.replace(/^control: Interrupt: .+$/u, "interrupt: selected live agent")
		.replace(/^control: Steer: .+$/u, "steer: Enter attaches · Esc returns");
}

function workflowGraphDashboardPrimaryLine(line: string, width: number): string {
	const status = workflowGraphStatusFromRunLine(line);
	const glyph = workflowGraphStatusGlyph(status);
	const color = workflowGraphStatusColor(status);
	return truncateToWidth(`${theme.fg(color, glyph)} ${theme.bold(line)}`, width);
}

function workflowGraphDashboardMetricLine(line: string, width: number): string {
	const separator = line.indexOf(":");
	if (separator === -1) return truncateToWidth(line, width);
	const label = theme.fg("muted", line.slice(0, separator + 1));
	const value = line.slice(separator + 1);
	return truncateToWidth(`${label}${value}`, width);
}

function workflowGraphStatusFromRunLine(line: string): WorkflowGraphNodeStatus {
	if (line.includes(" failed")) return "failed";
	if (line.includes(" completed")) return "completed";
	if (line.includes(" stopped")) return "checkpointed";
	if (line.includes(" running")) return "running";
	return "pending";
}

function workflowGraphDashboardSubsectionLabel(label: string): string {
	return `${theme.fg("borderMuted", "╭─")} ${theme.fg("muted", theme.bold(label))}`;
}

function renderWorkflowGraphDashboardPanel(
	title: string,
	width: number,
	contentLines: readonly string[],
	borderColor: ThemeColor = "borderMuted",
): string[] {
	const border = (text: string) => theme.fg(borderColor, text);
	const panelWidth = Math.max(WORKFLOW_GRAPH_FRAME_CHROME_WIDTH, width);
	const innerWidth = Math.max(0, panelWidth - WORKFLOW_GRAPH_FRAME_CHROME_WIDTH);
	return [
		renderWorkflowGraphDashboardBar("╭", "╮", title, undefined, panelWidth, border),
		...contentLines.map(line => renderWorkflowGraphDashboardContentLine(line, innerWidth, border)),
		renderWorkflowGraphDashboardBar("╰", "╯", undefined, undefined, panelWidth, border),
	];
}

function workflowGraphLiveWorkbenchAccent(view: WorkflowGraphView): ThemeColor {
	if (view.nodes.some(node => node.status === "failed")) return "error";
	if (workflowGraphHasLiveWork(view)) return "accent";
	if (view.changes.proposed > 0) return "warning";
	if (view.currentAttempt?.status === "completed") return "success";
	return "borderMuted";
}

function renderWorkflowGraphDashboardFrame(
	view: WorkflowGraphView,
	width: number,
	contentLines: readonly string[],
): string[] {
	const borderColor = workflowGraphDashboardBorderColor(view);
	const border = (text: string) => theme.fg(borderColor, text);
	const innerWidth = Math.max(0, width - WORKFLOW_GRAPH_FRAME_CHROME_WIDTH);
	const rows = [
		renderWorkflowGraphDashboardBar("╭", "╮", "Workflow Dashboard", view.familyId, width, border),
		...contentLines.map(line => renderWorkflowGraphDashboardContentLine(line, innerWidth, border)),
		renderWorkflowGraphDashboardBar("╰", "╯", undefined, undefined, width, border),
	];
	return rows;
}

function insertWorkflowGraphDashboardModeHint(rows: string[], view: WorkflowGraphView, width: number): string[] {
	if (rows.length < 2) return rows;
	const border = (text: string) => theme.fg(workflowGraphDashboardBorderColor(view), text);
	const hint = renderWorkflowGraphDashboardContentLine(
		"/workflow help · /workflow help agents · /workflow dashboard show · /workflow dashboard collapse",
		Math.max(0, width - WORKFLOW_GRAPH_FRAME_CHROME_WIDTH),
		border,
	);
	return [rows[0]!, hint, ...rows.slice(1)];
}

function renderWorkflowGraphCollapsedRows(view: WorkflowGraphView, width: number): string[] {
	const status = workflowGraphCollapsedStatus(view);
	const color = workflowGraphStatusColor(status);
	const glyph = workflowGraphStatusGlyph(status);
	const attempt =
		view.currentAttempt === undefined ? view.familyId : `${view.currentAttempt.id} ${view.currentAttempt.status}`;
	const summaryParts = [
		`Workflow ${attempt}`,
		workflowGraphProgressSummary(view),
		workflowGraphCompletionSummary(view),
		view.focus === undefined ? undefined : `focus ${view.focus.nodeId}`,
	].filter((part): part is string => part !== undefined && part.length > 0);
	const guideParts = ["/workflow help", "/workflow help agents", "/workflow dashboard show"];
	const primaryAction = workflowGraphCollapsedPrimaryAction(view);
	if (width >= 160) {
		const parts = [...summaryParts.slice(0, 2), ...guideParts, primaryAction, ...summaryParts.slice(2)].filter(
			(part): part is string => part !== undefined && part.length > 0,
		);
		return [truncateToWidth(`${theme.fg(color, glyph)} ${parts.join(" · ")}`, width)];
	}
	const rows = [
		truncateToWidth(`${theme.fg(color, glyph)} ${summaryParts.join(" · ")}`, width),
		...workflowGraphCollapsedGuideRows(guideParts, width),
		primaryAction === undefined ? undefined : truncateToWidth(primaryAction, width),
	].filter((line): line is string => line !== undefined && line.length > 0);
	return rows;
}

function workflowGraphCollapsedGuideRows(parts: readonly string[], width: number): string[] {
	if (width >= 92) return [truncateToWidth(parts.join(" · "), width)];
	return parts.map(part => truncateToWidth(part, width));
}

function workflowGraphCollapsedStatus(view: WorkflowGraphView): WorkflowGraphNodeStatus {
	if (view.nodes.some(node => node.status === "failed")) return "failed";
	if (view.focus !== undefined) return view.focus.status;
	if (view.currentAttempt?.status === "completed") return "completed";
	if (view.currentAttempt?.status === "stopped") return "checkpointed";
	return view.nodes.find(node => node.status === "running")?.status ?? "pending";
}

function workflowGraphProgressSummary(view: WorkflowGraphView): string {
	if (view.nodes.length === 0) return "no nodes";
	const progress = workflowGraphProgressStats(view);
	const tail = [
		`${progress.done}/${progress.total} done`,
		progress.active > 0 ? `${progress.active} active` : undefined,
		progress.counts.frontier > 0 ? `${progress.counts.frontier} frontier` : undefined,
		progress.counts.failed > 0 ? `${progress.counts.failed} failed` : undefined,
		progress.counts.aborted > 0 ? `${progress.counts.aborted} aborted` : undefined,
		progress.skipped > 0 ? `${progress.skipped} skipped` : undefined,
	].filter((part): part is string => part !== undefined);
	return tail.join(" · ");
}

function workflowGraphCompletionSummary(view: WorkflowGraphView): string | undefined {
	if (view.currentAttempt?.status !== "completed") return undefined;
	const summary = view.currentAttempt.summary?.trim();
	if (!summary || summary === "workflow completed") return undefined;
	return formatWorkflowGraphHeadlineDetail(summary);
}

function workflowGraphCollapsedPrimaryAction(view: WorkflowGraphView): string | undefined {
	const action = workflowGraphCollapsedPrimaryActionForOrder(view, workflowGraphCollapsedPrimaryActionOrder(view));
	if (action === undefined) return undefined;
	return `${action.label} ${action.command}`;
}

function workflowGraphCollapsedPrimaryActionOrder(view: WorkflowGraphView): readonly WorkflowGraphActionKind[] {
	const isRunning = view.currentAttempt?.status === "running" || view.focus?.status === "running";
	if (isRunning) return ["interrupt", "stop", "change", "restart"];
	return ["restart", "interrupt", "stop", "change"];
}

function workflowGraphCollapsedPrimaryActionForOrder(
	view: WorkflowGraphView,
	order: readonly WorkflowGraphActionKind[],
): { label: string; command: string } | undefined {
	for (const kind of order) {
		const action = workflowGraphCollapsedActionCommand(view, kind);
		if (action !== undefined) return action;
	}
	return undefined;
}

function workflowGraphCollapsedActionCommand(
	view: WorkflowGraphView,
	kind: WorkflowGraphActionKind,
): { label: string; command: string } | undefined {
	for (const action of view.actions) {
		const meta = WORKFLOW_GRAPH_ACTION_META.find(candidate => candidate.kind === kind);
		if (meta === undefined || !meta.pattern.test(action)) continue;
		const command = action.match(/\/workflow\s+\S+(?:\s+\S+)*/u)?.[0];
		if (command === undefined) return { label: kind, command: compactWorkflowGraphControl(action) };
		return { label: kind, command };
	}
	return undefined;
}

function renderWorkflowGraphDashboardBar(
	left: string,
	right: string,
	label: string | undefined,
	meta: string | undefined,
	width: number,
	border: (text: string) => string,
): string {
	const leftText = label === undefined ? left : `${left}─ ${label}${meta === undefined ? "" : ` · ${meta}`} `;
	const leftWidth = visibleWidth(leftText);
	const rightWidth = visibleWidth(right);
	const fill = "─".repeat(Math.max(0, width - leftWidth - rightWidth));
	return `${border(leftText)}${border(fill)}${border(right)}`;
}

function renderWorkflowGraphDashboardContentLine(
	line: string,
	innerWidth: number,
	border: (text: string) => string,
): string {
	const clipped = truncateToWidth(line, innerWidth);
	const padded = padWorkflowGraphLine(clipped, innerWidth);
	return `${border("│")} ${padded} ${border("│")}`;
}

function workflowGraphDashboardBorderColor(view: WorkflowGraphView): ThemeColor {
	const state = workflowGraphState(view);
	if (state === "error") return "error";
	if (state === "warning") return "warning";
	if (state === "running" || state === "pending") return "accent";
	if (state === "success") return "success";
	return "border";
}

function padWorkflowGraphLine(line: string, width: number): string {
	const lineWidth = visibleWidth(line);
	if (lineWidth >= width) return line;
	return `${line}${" ".repeat(width - lineWidth)}`;
}

function workflowGraphDashboardOverviewLines(view: WorkflowGraphView, width: number): string[] {
	const lines = formatWorkflowOverviewLines(view);
	const progressLine = workflowGraphProgressLine(view, width);
	if (progressLine === undefined) return lines;
	const flowLineIndex = lines.findIndex(line => line.startsWith("Flow:"));
	if (flowLineIndex === -1) return [progressLine, ...lines];
	return [...lines.slice(0, flowLineIndex + 1), progressLine, ...lines.slice(flowLineIndex + 1)];
}

function workflowGraphProgressLine(view: WorkflowGraphView, width: number): string | undefined {
	if (view.nodes.length === 0) return undefined;
	const progress = workflowGraphProgressStats(view);
	const repeats = view.nodes.reduce((total, node) => total + Math.max(0, (node.activationCount ?? 0) - 1), 0);
	const barWidth = Math.max(6, Math.min(18, Math.floor(width / 12)));
	const filled = Math.max(0, Math.min(barWidth, Math.round((progress.done / progress.total) * barWidth)));
	const bar = `${"█".repeat(filled)}${"░".repeat(barWidth - filled)}`;
	const statusParts = [
		`${progress.done}/${progress.total} done`,
		progress.active > 0 ? `${progress.active} active` : undefined,
		progress.counts.frontier > 0 ? `${progress.counts.frontier} frontier` : undefined,
		progress.counts.failed > 0 ? `${progress.counts.failed} failed` : undefined,
		progress.counts.aborted > 0 ? `${progress.counts.aborted} aborted` : undefined,
		progress.skipped > 0 ? `${progress.skipped} skipped` : undefined,
		repeats > 0 ? `${repeats} repeats` : undefined,
	].filter((part): part is string => part !== undefined);
	return `Progress: ${bar} ${statusParts.join(" · ")}`;
}

interface WorkflowGraphProgressStats {
	counts: Record<WorkflowGraphNodeStatus, number>;
	done: number;
	active: number;
	skipped: number;
	total: number;
}

function workflowGraphProgressStats(view: WorkflowGraphView): WorkflowGraphProgressStats {
	const counts = workflowGraphStatusCounts(view);
	const skipped = view.currentAttempt?.status === "completed" ? counts.pending : 0;
	const total = Math.max(1, view.nodes.length - skipped);
	return {
		counts,
		done: counts.completed + counts.checkpointed,
		active: counts.running,
		skipped,
		total,
	};
}

function workflowGraphStatusCounts(view: WorkflowGraphView): Record<WorkflowGraphNodeStatus, number> {
	return view.nodes.reduce<Record<WorkflowGraphNodeStatus, number>>(
		(counts, node) => {
			counts[node.status] += 1;
			return counts;
		},
		{
			aborted: 0,
			checkpointed: 0,
			completed: 0,
			failed: 0,
			frontier: 0,
			pending: 0,
			running: 0,
		},
	);
}

function workflowGraphCompactProfile(
	density: WorkflowGraphDensity,
	heightBudget: number | undefined,
): WorkflowGraphCompactProfile {
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
			diagramChromeRows: 21,
			pathLine: false,
		};
	}
	if ((heightBudget ?? 0) <= 32) {
		return {
			overviewLines: 4,
			focusLines: 1,
			onFlightLines: 1,
			recentActivityLines: 0,
			controlLines: 2,
			diagramChromeRows: 26,
			pathLine: false,
		};
	}
	if ((heightBudget ?? 0) <= 40) {
		return {
			overviewLines: 5,
			focusLines: 1,
			onFlightLines: 1,
			recentActivityLines: 0,
			controlLines: 2,
			diagramChromeRows: 24,
			pathLine: false,
		};
	}
	return {
		overviewLines: 5,
		focusLines: 3,
		onFlightLines: 2,
		recentActivityLines: 2,
		controlLines: 3,
		diagramChromeRows: 14,
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
	const marker = workflowGraphHiddenDiagramMarker(hiddenBefore, hiddenAfter);
	return [...lines.slice(start, end), marker];
}

function workflowGraphHiddenDiagramMarker(hiddenBefore: number, hiddenAfter: number): string {
	const hidden = hiddenBefore + hiddenAfter;
	if (hiddenBefore > 0 && hiddenAfter > 0) {
		return `+${hidden} diagram rows hidden · ${hiddenBefore} above / ${hiddenAfter} below focus`;
	}
	if (hiddenBefore > 0) return `+${hidden} diagram rows hidden above focus`;
	if (hiddenAfter > 0) return `+${hidden} diagram rows hidden below focus`;
	return "+0 diagram rows hidden";
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

function limitWorkflowGraphOverviewLines(lines: string[], maxLines: number, pathLine: string | undefined): string[] {
	if (maxLines <= 0) return [];
	const sourceLines = pathLine === undefined ? lines : [...lines, pathLine];
	if (sourceLines.length <= maxLines) return sourceLines;
	const runLine = lines[0];
	const flowLine = lines.find(line => line.startsWith("Flow:"));
	const focusLine = lines.find(line => line.startsWith("Focus:"));
	const progressLine = lines.find(line => line.startsWith("Progress:"));
	const operationsLine = workflowGraphOperationsLine(lines);
	const priorityLines = [runLine, flowLine, focusLine, progressLine, operationsLine, pathLine].filter(
		(line): line is string => line !== undefined,
	);
	if (maxLines <= priorityLines.length) return priorityLines.slice(0, maxLines);
	if (maxLines <= 3) return [...priorityLines, `+${lines.length - priorityLines.length} overview hidden`];
	const remaining = sourceLines.filter(line => !priorityLines.includes(line));
	const visibleRemaining = remaining.slice(0, maxLines - priorityLines.length - 1);
	const hidden = sourceLines.length - priorityLines.length - visibleRemaining.length;
	return [...priorityLines, ...visibleRemaining, `+${hidden} overview hidden`];
}

function workflowGraphOperationsLine(lines: readonly string[]): string | undefined {
	const onFlight = workflowGraphOverviewValue(lines, "On-flight:");
	const changes = workflowGraphOverviewValue(lines, "Flow changes:");
	if (onFlight === undefined && changes === undefined) return undefined;
	const parts = [
		onFlight === undefined ? undefined : `on-flight ${onFlight}`,
		changes === undefined ? undefined : `flow changes ${changes}`,
	].filter((part): part is string => part !== undefined);
	if (parts.length === 0) return undefined;
	return `Ops: ${parts.join(" · ")}`;
}

function workflowGraphOverviewValue(lines: readonly string[], prefix: string): string | undefined {
	const line = lines.find(candidate => candidate.startsWith(prefix));
	if (line === undefined) return undefined;
	const value = line.slice(prefix.length).trim();
	return value.length === 0 ? undefined : value;
}

function workflowGraphCompactPathLine(view: WorkflowGraphView, width: number): string | undefined {
	if (view.nodes.length === 0) return undefined;
	const focusNodeId = view.focus?.nodeId ?? view.activeAgents?.[0]?.nodeId;
	const nodeIds = view.nodes.map(node => (node.id === focusNodeId ? `[${node.id}]` : node.id));
	return truncateToWidth(`Map: ${nodeIds.join(" ─▶ ")}`, Math.max(20, width));
}

function workflowGraphFlowMapLines(view: WorkflowGraphView, width: number, density: WorkflowGraphDensity): string[] {
	if (view.nodes.length === 0) return [];
	const compactWide = density === "compact" && width >= WORKFLOW_GRAPH_FLOW_MAP_HINT_MIN_WIDTH;
	const maxRows = density === "full" ? 4 : compactWide ? 3 : 1;
	const nodeRows = workflowGraphFlowMapNodeRows(view, width, density === "full" ? 3 : 1);
	const hintRows =
		density === "full" || compactWide
			? workflowGraphFlowMapHintRows(view, width, Math.max(0, maxRows - nodeRows.length))
			: [];
	return [...nodeRows, ...hintRows].slice(0, maxRows);
}

function workflowGraphFlowMapNodeRows(view: WorkflowGraphView, width: number, maxRows: number): string[] {
	const rows: string[] = [];
	let row = "";
	for (let index = 0; index < view.nodes.length; index += 1) {
		const node = view.nodes[index]!;
		const token = workflowGraphFlowMapNodeToken(node, width);
		const previousNode = index === 0 ? undefined : view.nodes[index - 1];
		const connector =
			previousNode === undefined ? "" : workflowGraphFlowMapConnector(previousNode.id, node.id, view.edges);
		const piece = index === 0 ? token : `${connector}${token}`;
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

function workflowGraphFlowMapConnector(
	from: string,
	to: string,
	edges: readonly WorkflowGraphView["edges"][number][],
): string {
	return edges.some(edge => edge.from === from && edge.to === to) ? " ─▶ " : " ∥ ";
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
		.map(edge => workflowGraphFlowMapEdgeHint(edge, "┬▶"));
	const loops = view.edges
		.filter(edge => workflowGraphIsBackEdge(edge, order))
		.map(edge => workflowGraphFlowMapEdgeHint(edge, "↺"));
	const hints = [
		loops.length > 0 ? workflowGraphFlowMapHintLine("Loops", loops, width) : undefined,
		branches.length > 0 ? workflowGraphFlowMapHintLine("Branches", branches, width) : undefined,
	].filter((line): line is string => line !== undefined);
	return hints.slice(0, maxRows).map(line => truncateToWidth(line, Math.max(20, width)));
}

function workflowGraphFlowMapEdgeHint(edge: { from: string; to: string }, connector: string): string {
	return `${compactWorkflowGraphNodeId(edge.from)} ${connector} ${compactWorkflowGraphNodeId(edge.to)}`;
}

function compactWorkflowGraphNodeId(nodeId: string): string {
	const normalized = nodeId.includes("__") ? nodeId.slice(nodeId.lastIndexOf("__") + 2) : nodeId;
	return truncateToWidth(normalized, 22);
}

function workflowGraphFlowMapHintLine(label: string, hints: readonly string[], width: number): string {
	const visibleHints: string[] = [];
	let usedWidth = visibleWidth(`${label}: `);
	for (const hint of hints) {
		const separator = visibleHints.length === 0 ? "" : "  ·  ";
		const nextWidth = visibleWidth(separator) + visibleWidth(hint);
		const hiddenSuffix = hints.length - visibleHints.length - 1 > 0 ? "  +" : "";
		if (usedWidth + nextWidth + visibleWidth(hiddenSuffix) > width) break;
		visibleHints.push(hint);
		usedWidth += nextWidth;
	}
	const hidden = hints.length - visibleHints.length;
	const suffix = hidden > 0 ? `  +${hidden}` : "";
	return `${label}: ${visibleHints.join("  ·  ")}${suffix}`;
}

function workflowGraphLegendLine(width: number): string | undefined {
	if (width < 70) return undefined;
	const legend = "Legend: ● live · ◇ frontier · ✓ done · ! failed · × aborted · ↺ loop · ┬▶ branch";
	return truncateToWidth(legend, width);
}

function workflowGraphIsBackEdge(edge: { from: string; to: string }, order: ReadonlyMap<string, number>): boolean {
	const source = order.get(edge.from);
	const target = order.get(edge.to);
	if (source === undefined || target === undefined) return false;
	return target <= source;
}

function fitWorkflowGraphDashboardRowsToHeight(lines: string[], width: number, heightBudget: number): string[] {
	if (lines.length <= heightBudget) return lines;
	const safeHeight = Math.max(1, heightBudget);
	if (safeHeight === 1) return fitWorkflowGraphRowsToHeight(lines, width, heightBudget);
	const actionAnchor = workflowGraphRowsActionAnchor(lines);
	const plainRows = fitWorkflowGraphRowsToHeight(lines, width, heightBudget);
	const tailRows = workflowGraphFittedTailRows(safeHeight);
	const tailStart = lines.length - tailRows;
	if (actionAnchor !== undefined && actionAnchor < tailStart) {
		const actionEnd = workflowGraphRowsActionAnchorEnd(lines, actionAnchor);
		const actionRows = actionEnd - actionAnchor;
		const diagramAnchor = workflowGraphRowsDiagramAnchor(lines, actionAnchor);
		const minimumHeadRows = diagramAnchor === undefined ? 1 : diagramAnchor + 1;
		const remainingRows = safeHeight - actionRows - 1;
		if (remainingRows >= 2 && minimumHeadRows < actionAnchor) {
			const anchoredHeadRows = Math.min(Math.max(minimumHeadRows, Math.floor(remainingRows / 2)), remainingRows - 1);
			const anchoredTailRows = remainingRows - anchoredHeadRows;
			const anchoredTailStart = Math.max(actionEnd, lines.length - anchoredTailRows);
			const tail = lines.slice(anchoredTailStart);
			const hidden = Math.max(0, lines.length - anchoredHeadRows - actionRows - tail.length);
			const marker = renderWorkflowGraphClippedRowsMarker(hidden, width);
			return [...lines.slice(0, anchoredHeadRows), marker, ...lines.slice(actionAnchor, actionEnd), ...tail];
		}
		const anchoredTailRows = lines.length - actionAnchor;
		const anchoredTailCount = Math.min(anchoredTailRows, Math.max(1, safeHeight - 2));
		const anchoredHeadRows = Math.max(1, safeHeight - anchoredTailCount - 1);
		const hidden = Math.max(0, lines.length - anchoredHeadRows - anchoredTailCount);
		const marker = renderWorkflowGraphClippedRowsMarker(hidden, width);
		return [...lines.slice(0, anchoredHeadRows), marker, ...lines.slice(lines.length - anchoredTailCount)];
	}
	return plainRows;
}

function fitWorkflowGraphRowsToHeight(lines: string[], width: number, heightBudget: number): string[] {
	if (lines.length <= heightBudget) return lines;
	const safeHeight = Math.max(1, heightBudget);
	if (safeHeight === 1) return [truncateToWidth("... workflow graph clipped ...", width)];
	const headRows = workflowGraphFittedHeadRows(safeHeight);
	const tailRows = workflowGraphFittedTailRows(safeHeight);
	const hidden = Math.max(0, lines.length - headRows - tailRows);
	const marker = renderWorkflowGraphClippedRowsMarker(hidden, width);
	return [...lines.slice(0, headRows), marker, ...lines.slice(lines.length - tailRows)];
}

function workflowGraphFittedHeadRows(safeHeight: number): number {
	return Math.max(1, Math.floor((safeHeight - 1) / 2));
}

function workflowGraphFittedTailRows(safeHeight: number): number {
	return Math.max(1, safeHeight - workflowGraphFittedHeadRows(safeHeight) - 1);
}

function workflowGraphRowsActionAnchor(lines: readonly string[]): number | undefined {
	const index = lines.findIndex(line => line.includes("Operator rail") || line.includes("Action:"));
	return index === -1 ? undefined : index;
}

function workflowGraphRowsActionAnchorEnd(lines: readonly string[], start: number): number {
	let end = start + 1;
	while (end < lines.length && end < start + 3) {
		if (lines[end]?.includes("╭─ ") === true) break;
		end += 1;
	}
	return end;
}

function workflowGraphRowsDiagramAnchor(lines: readonly string[], beforeIndex: number): number | undefined {
	const index = lines.findIndex((line, lineIndex) => lineIndex < beforeIndex && line.includes("diagram rows hidden"));
	return index === -1 ? undefined : index;
}

function renderWorkflowGraphClippedRowsMarker(hiddenRows: number, width: number): string {
	return renderWorkflowGraphDashboardBar("├", "┤", `+${hiddenRows} dashboard rows hidden`, undefined, width, value =>
		theme.fg("borderMuted", value),
	);
}

function workflowGraphHeightBudget(value: number | undefined): number | undefined {
	if (value === undefined || !Number.isFinite(value)) return undefined;
	return Math.max(WORKFLOW_GRAPH_MIN_HEIGHT_BUDGET, Math.floor(value));
}

function workflowGraphControlLines(view: WorkflowGraphView, density: WorkflowGraphDensity = "full"): string[] {
	const lines: string[] = [];
	for (const action of formatWorkflowControlLines(view)) {
		const label = density === "full" ? action : compactWorkflowGraphControl(action);
		lines.push(`  ${decorateWorkflowGraphControl(label)}`);
	}
	return lines;
}

function decorateWorkflowGraphControl(label: string): string {
	const kind = workflowGraphActionKind(label);
	const glyph = kind === undefined ? "•" : (workflowGraphActionMeta(kind)?.glyph ?? "•");
	return `${glyph} ${label}`;
}

function workflowGraphSubflowLines(view: WorkflowGraphView): string[] {
	return (view.subflows ?? []).map(subflow => formatWorkflowSubflow(subflow));
}

function workflowGraphFocusLines(
	view: WorkflowGraphView,
	width: number,
	density: WorkflowGraphDensity = "full",
): string[] {
	const allFocusLines = formatWorkflowFocusLines(view);
	const focusLines =
		workflowGraphSelectedAgentTarget(view) === undefined
			? allFocusLines
			: allFocusLines.filter(line => !workflowGraphIsRailDuplicateFocusControl(line));
	return focusLines.map(line =>
		truncateToWidth(replaceTabs(compactWorkflowGraphStatusLine(line, density)), Math.max(20, width)),
	);
}

function workflowGraphIsRailDuplicateFocusControl(line: string): boolean {
	return /^control: (Watch: Agent Hub|Interrupt:|Steer:)/u.test(line);
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
		.replace(WORKFLOW_GRAPH_MODEL_STATUS_SEGMENT_PATTERN, "")
		.replace(/ · tool [^·]+(?= · |$)/gu, "")
		.replace(/ · (\d+h\d{2}m|\d+m\d{2}s|\d+s) · \d+ tools? · \d+% ctx/gu, " · $1")
		.replace(/\(watch\/intervene ([^)]+)\)/gu, "($1)");
}

function compactWorkflowGraphControl(action: string): string {
	if (/^(?:Stop attempt|Restart|Interrupt\b).* · \/workflow /u.test(action)) {
		return action.replace(/\s+--deadline-ms\s+\S+/u, "");
	}
	const commandSeparator = action.search(/ · (?:\/workflow|Agent Hub|double-left)/u);
	if (commandSeparator !== -1) return action.slice(0, commandSeparator);
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
	return lines.map(colorWorkflowDiagramLine);
}

const WORKFLOW_STATUS_TOKEN_PATTERN =
	/[✓◆◇●!○]|×(?=\s)|\b(?:failed|running|frontier|checkpointed|completed|aborted|pending)\b/gu;
const WORKFLOW_GRAPH_CONNECTOR_TOKEN_PATTERN = /[▲▼▶│║┆─═━┄┌┐└┘╭╮╰╯├┤┬┴┼╟╢╫╤╧]+/gu;

function colorWorkflowDiagramLine(line: string): string {
	let rendered = "";
	let offset = 0;
	for (const match of line.matchAll(WORKFLOW_STATUS_TOKEN_PATTERN)) {
		const token = match[0];
		const index = match.index;
		if (index > offset) rendered = `${rendered}${colorWorkflowDiagramSegment(line.slice(offset, index))}`;
		rendered = `${rendered}${theme.fg(workflowGraphStatusColor(workflowGraphStatusFromToken(token)), token)}`;
		offset = index + token.length;
	}
	if (offset < line.length) rendered = `${rendered}${colorWorkflowDiagramSegment(line.slice(offset))}`;
	return rendered;
}

function colorWorkflowDiagramSegment(segment: string): string {
	let rendered = "";
	let offset = 0;
	for (const match of segment.matchAll(WORKFLOW_GRAPH_CONNECTOR_TOKEN_PATTERN)) {
		const token = match[0];
		const index = match.index;
		if (index > offset) rendered = `${rendered}${theme.fg("muted", segment.slice(offset, index))}`;
		rendered = `${rendered}${colorWorkflowDiagramConnectorRun(token)}`;
		offset = index + token.length;
	}
	if (offset < segment.length) rendered = `${rendered}${theme.fg("muted", segment.slice(offset))}`;
	return rendered;
}

function colorWorkflowDiagramConnectorRun(token: string): string {
	if (/^[┄┆]+$/u.test(token)) return theme.fg("dim", token);
	if (/[┼╫├┤┬┴╟╢╤╧]/u.test(token)) return theme.fg("warning", token);
	if (/[▲▼▶]/u.test(token)) return theme.fg("accent", token);
	if (/^[│║]+$/u.test(token)) return theme.fg("borderAccent", token);
	if (/^[─═━]+$/u.test(token)) return theme.fg("accent", token);
	return theme.fg("borderMuted", token);
}

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
