import { type Component, type NativeScrollbackLiveRegion, replaceTabs, truncateToWidth } from "@oh-my-pi/pi-tui";
import { renderOutputBlock } from "../../tui/output-block";
import type { State } from "../../tui/types";
import {
	formatWorkflowChangeReviewLines,
	formatWorkflowControlLines,
	formatWorkflowOnFlightLines,
	formatWorkflowOverviewLines,
	formatWorkflowRecentOutputLines,
	formatWorkflowSelectedRoute,
	formatWorkflowSubflow,
	renderWorkflowGraphDiagram,
	type WorkflowGraphNodeStatus,
	type WorkflowGraphView,
} from "../../workflow/graph-view";
import { theme } from "../theme/theme";

export interface WorkflowGraphComponentOptions {
	viewProvider?: () => WorkflowGraphView | undefined;
	onViewChange?: (view: WorkflowGraphView) => void;
	requestRender?: (component: Component) => void;
	refreshMs?: number;
}

export class WorkflowGraphComponent implements Component, NativeScrollbackLiveRegion {
	#cache?: { width: number; lines: string[] };
	#lastObservedViewSignature?: string;
	#onViewChange?: (view: WorkflowGraphView) => void;
	#view: WorkflowGraphView;
	#viewProvider?: () => WorkflowGraphView | undefined;
	#refreshTimer?: NodeJS.Timeout;

	constructor(view: WorkflowGraphView, options: WorkflowGraphComponentOptions = {}) {
		this.#view = view;
		this.#viewProvider = options.viewProvider;
		this.#onViewChange = options.onViewChange;
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
		const view = this.#currentView();
		this.#observeView(view);
		if (this.#viewProvider === undefined && this.#cache?.width === safeWidth) return this.#cache.lines;
		const onFlightLines = workflowGraphOnFlightLines(view, safeWidth - 8);
		const recentOutputLines = workflowGraphRecentOutputLines(view, safeWidth - 8);
		const lines = renderOutputBlock(
			{
				header: "Workflow graph",
				headerMeta: view.familyId,
				state: workflowGraphState(view),
				width: safeWidth,
				contentPaddingLeft: 2,
				sections: [
					{ lines: formatWorkflowOverviewLines(view) },
					...(view.subflows !== undefined && view.subflows.length > 0
						? [{ label: "flow calls", lines: workflowGraphSubflowLines(view) }]
						: []),
					...(onFlightLines.length > 0 ? [{ label: "on-flight", lines: onFlightLines }] : []),
					...(recentOutputLines.length > 0 ? [{ label: "recent output", lines: recentOutputLines }] : []),
					{
						label: "diagram",
						lines: colorWorkflowDiagram(renderWorkflowGraphDiagram(view, { width: safeWidth - 8 })),
					},
					...(view.selectedRoutes !== undefined && view.selectedRoutes.length > 0
						? [{ label: "routes", lines: workflowGraphSelectedRouteLines(view) }]
						: []),
					...(view.lineage.length > 0
						? [{ label: "change review", lines: workflowGraphChangeLines(view, safeWidth - 8) }]
						: []),
					{ label: "controls", lines: workflowGraphControlLines(view) },
				],
			},
			theme,
		);
		this.#cache = { width: safeWidth, lines };
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

function workflowGraphControlLines(view: WorkflowGraphView): string[] {
	const lines: string[] = [];
	for (const action of formatWorkflowControlLines(view)) lines.push(`  ${action}`);
	return lines;
}

function workflowGraphSubflowLines(view: WorkflowGraphView): string[] {
	return (view.subflows ?? []).map(subflow => formatWorkflowSubflow(subflow));
}

function workflowGraphOnFlightLines(view: WorkflowGraphView, width: number): string[] {
	return formatWorkflowOnFlightLines(view).map(line => {
		const prefixed = line.includes(" live") ? `${theme.fg("accent", "●")} ${line}` : line;
		return truncateToWidth(replaceTabs(prefixed), Math.max(20, width));
	});
}

function workflowGraphRecentOutputLines(view: WorkflowGraphView, width: number): string[] {
	return formatWorkflowRecentOutputLines(view).map(line =>
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
	return lines.map(line => {
		const status = detectLineStatus(line);
		if (status === "failed") return theme.fg("error", line);
		if (status === "running" || status === "frontier") return theme.fg("accent", line);
		if (status === "checkpointed") return theme.fg("warning", line);
		if (status === "completed") return theme.fg("success", line);
		return theme.fg("muted", line);
	});
}

function detectLineStatus(line: string): WorkflowGraphNodeStatus | undefined {
	if (line.includes("failed") || line.includes("! ")) return "failed";
	if (line.includes("running") || line.includes("● ")) return "running";
	if (line.includes("frontier") || line.includes("◇ ")) return "frontier";
	if (line.includes("checkpointed") || line.includes("◆ ")) return "checkpointed";
	if (line.includes("completed") || line.includes("✓ ")) return "completed";
	if (line.includes("aborted") || line.includes("× ")) return "aborted";
	if (line.includes("pending") || line.includes("○ ")) return "pending";
	return undefined;
}

function workflowGraphState(view: WorkflowGraphView): State {
	if (view.nodes.some(node => node.status === "failed")) return "error";
	if (view.nodes.some(node => node.status === "running")) return "running";
	if (view.nodes.some(node => node.status === "frontier")) return "pending";
	if (view.currentAttempt?.status === "completed") return "success";
	return "pending";
}
