import { type Component, type NativeScrollbackLiveRegion, replaceTabs, truncateToWidth } from "@oh-my-pi/pi-tui";
import { renderOutputBlock } from "../../tui/output-block";
import type { State } from "../../tui/types";
import {
	formatActiveWorkflowAgentGeneration,
	formatWorkflowSubflow,
	renderWorkflowGraphDiagram,
	type WorkflowGraphActiveAgentView,
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
		const lines = renderOutputBlock(
			{
				header: "Workflow graph",
				headerMeta: view.familyId,
				state: workflowGraphState(view),
				width: safeWidth,
				contentPaddingLeft: 2,
				sections: [
					{ lines: workflowGraphHeaderLines(view) },
					...(view.subflows !== undefined && view.subflows.length > 0
						? [{ label: "subflows", lines: workflowGraphSubflowLines(view) }]
						: []),
					...(view.activeAgents !== undefined && view.activeAgents.length > 0
						? [{ label: "active agents", lines: workflowGraphActiveAgentLines(view, safeWidth - 8) }]
						: []),
					{
						label: "diagram",
						lines: colorWorkflowDiagram(renderWorkflowGraphDiagram(view, { width: safeWidth - 8 })),
					},
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

function workflowGraphHeaderLines(view: WorkflowGraphView): string[] {
	const lines = [
		`freeze ${view.latestFreezeId ?? "none"}`,
		`changes ${view.changes.approved} approved / ${view.changes.proposed} proposed / ${view.changes.rejected} rejected`,
	];
	if (view.currentAttempt !== undefined) {
		const checkpoint = view.currentAttempt.checkpointId ? ` from ${view.currentAttempt.checkpointId}` : "";
		lines.unshift(`attempt ${view.currentAttempt.id} ${view.currentAttempt.status}${checkpoint}`);
	} else {
		lines.unshift("attempt none");
	}
	if (view.checkpoint !== undefined) {
		const frontier = view.checkpoint.frontier.map(entry => `${entry.from} to ${entry.to}`).join(", ") || "none";
		lines.push(`frontier ${frontier}`);
	}
	return lines.map(line => theme.fg("muted", line));
}

function workflowGraphControlLines(view: WorkflowGraphView): string[] {
	const lines: string[] = [];
	if (view.lineage.length > 0) {
		lines.push(theme.fg("muted", "changes"));
		for (const request of view.lineage) {
			const actor = request.actor === undefined ? "" : ` by ${request.actor}`;
			const applied = request.applications.length === 0 ? "" : ` applied=${request.applications.join(",")}`;
			lines.push(`  ${request.id} ${request.status}${actor}${applied} - ${request.reason}`);
		}
	}
	lines.push(theme.fg("muted", "actions"));
	for (const action of view.actions) lines.push(`  ${action}`);
	return lines;
}

function workflowGraphSubflowLines(view: WorkflowGraphView): string[] {
	return (view.subflows ?? []).map(subflow => formatWorkflowSubflow(subflow));
}

function workflowGraphActiveAgentLines(view: WorkflowGraphView, width: number): string[] {
	const lines = [theme.fg("muted", "Agent Hub watches live transcripts; interrupt a selected live agent if needed.")];
	for (const agent of view.activeAgents ?? []) {
		const activity = workflowAgentActivityText(agent, width);
		const model = agent.model === undefined ? "" : theme.fg("muted", ` · ${agent.model}`);
		const tool = agent.tool === undefined ? "" : theme.fg("muted", ` · tool ${agent.tool}`);
		const stats = agent.stats === undefined ? "" : theme.fg("muted", ` · ${agent.stats}`);
		const generation = theme.fg("muted", formatActiveWorkflowAgentGeneration(agent));
		const focus = theme.fg("muted", ` focus ${agent.focusAgentId}`);
		const line = `${theme.fg("accent", "●")} ${agent.role}${theme.fg("muted", ` · ${agent.label}`)} ${theme.fg("accent", "live")}${generation}${model}${tool}${stats}${activity}${focus}`;
		lines.push(truncateToWidth(replaceTabs(line), Math.max(20, width)));
	}
	return lines;
}

function workflowAgentActivityText(agent: WorkflowGraphActiveAgentView, width: number): string {
	const source = agent.activity ?? agent.summary;
	if (source === undefined) return "";
	return ` - ${sanitizeWorkflowAgentSummary(source, Math.floor(width / 2))}`;
}

function sanitizeWorkflowAgentSummary(summary: string, width: number): string {
	const compact = replaceTabs(summary).replace(/\s+/g, " ").trim();
	return truncateToWidth(compact, Math.max(16, width));
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
