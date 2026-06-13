import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { WorkflowGraphComponent } from "../../src/modes/components/workflow-graph";
import { getThemeByName, setThemeInstance } from "../../src/modes/theme/theme";
import type { WorkflowDefinition } from "../../src/workflow/definition";
import type { FlowFreeze } from "../../src/workflow/freeze";
import {
	buildWorkflowGraphView,
	renderWorkflowGraphDiagram,
	renderWorkflowGraphText,
	type WorkflowGraphView,
} from "../../src/workflow/graph-view";
import type { RuntimeBindingSnapshot, WorkflowRunFamilySnapshot } from "../../src/workflow/lifecycle";
import { writeWorkflowGraphMonitorSnapshot } from "../../src/workflow/monitor-history";

describe("workflow graph view rendering", () => {
	it("renders parallel branches as sibling graph lanes before a join", () => {
		const view = createView({
			name: "parallel-review",
			version: 1,
			models: { roles: {}, defaults: {} },
			nodes: [
				{ id: "plan", type: "script" },
				{ id: "tryTiling", type: "script" },
				{ id: "tryFusion", type: "script" },
				{ id: "evaluate", type: "review", waitFor: ["tryTiling", "tryFusion"] },
			],
			edges: [
				{ from: "plan", to: "tryTiling" },
				{ from: "plan", to: "tryFusion" },
				{ from: "tryTiling", to: "evaluate" },
				{ from: "tryFusion", to: "evaluate" },
			],
		});

		const diagram = renderWorkflowGraphDiagram(view, { width: 96 });
		const branchLine = diagram.find(line => line.includes("tryTiling") && line.includes("tryFusion"));
		const rendered = diagram.join("\n");
		const splitBusIndex = diagram.findIndex(line => line.includes("┌") && line.includes("┴") && line.includes("┐"));
		const mergeBusIndex = findLastIndex(
			diagram,
			line => line.includes("└") && line.includes("┬") && line.includes("┘"),
		);

		expect(branchLine).toBeDefined();
		expect(rendered).toContain("┬");
		expect(rendered).toMatch(/[┌└]─{2,}[┐┘]/u);
		expect(splitBusIndex).toBeGreaterThan(-1);
		expect(diagram[splitBusIndex + 1]?.[diagram[splitBusIndex]!.indexOf("┌")]).toBe("│");
		expect(["┴", "╧"]).toContain(diagram[splitBusIndex + 2]?.[diagram[splitBusIndex]!.indexOf("┌")]);
		expect(diagram[splitBusIndex + 1]?.[diagram[splitBusIndex]!.lastIndexOf("┐")]).toBe("│");
		expect(["┴", "╧"]).toContain(diagram[splitBusIndex + 2]?.[diagram[splitBusIndex]!.lastIndexOf("┐")]);
		expect(mergeBusIndex).toBeGreaterThan(-1);
		expect(diagram[mergeBusIndex + 1]?.[diagram[mergeBusIndex]!.indexOf("┬")]).toBe("│");
		expect(["┴", "╧"]).toContain(diagram[mergeBusIndex + 2]?.[diagram[mergeBusIndex]!.indexOf("┬")]);
		expectConnectorsUseOneBoxDrawingBaseline(diagram);
		expectSplitAndMergeBusesToBeCentered(diagram);
		expect(rendered).not.toMatch(/[-─]+[>→▶]|[<←◀][-─]+|→{2,}|←{2,}/u);
		expect(rendered).not.toContain("▶");
		expect(rendered).not.toContain("◀");
		expect(rendered).not.toContain("▼");
		expect(rendered).toContain("evaluate");
	});

	it("connects edge lines into node borders on the same terminal column", () => {
		const view = createView({
			name: "linear-review",
			version: 1,
			models: { roles: {}, defaults: {} },
			nodes: [
				{ id: "plan", type: "script" },
				{ id: "review", type: "review" },
			],
			edges: [{ from: "plan", to: "review" }],
		});

		const diagram = renderWorkflowGraphDiagram(view, { width: 64 });
		const rendered = diagram.join("\n");
		const sourceBottomIndex = diagram.findIndex(
			line => line.includes("└") && line.includes("┬") && line.includes("┘"),
		);
		const targetTopIndex = diagram.findIndex(
			(line, index) => index > sourceBottomIndex && line.includes("┌") && line.includes("┴") && line.includes("┐"),
		);

		expect(sourceBottomIndex).toBeGreaterThan(-1);
		expect(targetTopIndex).toBeGreaterThan(sourceBottomIndex);
		const connectorColumn = visibleColumnsOf(diagram[sourceBottomIndex]!, "┬")[0];
		expect(connectorColumn).toBeDefined();
		expect(charAtVisibleColumn(diagram[targetTopIndex]!, connectorColumn!)).toBe("┴");
		for (let index = sourceBottomIndex + 1; index < targetTopIndex; index += 1) {
			expect(charAtVisibleColumn(diagram[index]!, connectorColumn!)).toBe("│");
		}
		expect(rendered).not.toMatch(/[-─]+[>→▶▼]|[<←◀][-─]+|→{2,}|←{2,}/u);
		expect(rendered).not.toContain("▼");
	});

	it("renders loop edges as explicit back-edge controls instead of hiding them in linear flow", () => {
		const view = createView({
			name: "long-running-loop",
			version: 1,
			models: { roles: {}, defaults: {} },
			nodes: [
				{ id: "build", type: "agent" },
				{ id: "review", type: "review" },
			],
			edges: [
				{ from: "build", to: "review" },
				{ from: "review", to: "build", condition: { source: 'state.verdict == "retry"' } },
			],
		});

		const diagram = renderWorkflowGraphDiagram(view, { width: 80 }).join("\n");

		expect(diagram).toContain("loopbacks");
		expect(diagram).toContain('review back to build when state.verdict == "retry"');
	});

	it("renders edge annotations without composed arrowheads", () => {
		const view = createView({
			name: "conditional-loop",
			version: 1,
			models: { roles: {}, defaults: {} },
			nodes: [
				{ id: "build", type: "agent" },
				{ id: "review", type: "review" },
				{ id: "ship", type: "script" },
			],
			edges: [
				{ from: "build", to: "review" },
				{ from: "review", to: "ship", condition: { source: 'state.verdict == "finish"' } },
				{ from: "review", to: "build", condition: { source: 'state.verdict == "retry"' } },
			],
		});

		const diagram = renderWorkflowGraphDiagram(view, { width: 80 }).join("\n");

		expect(diagram).toContain('edge review to ship when state.verdict == "finish"');
		expect(diagram).toContain('review back to build when state.verdict == "retry"');
		expect(diagram).not.toMatch(/[-─]+[>→▶]|[<←◀][-─]+|->|=>|→|↺/u);
	});

	it("keeps node boxes aligned when ids and summaries contain wide terminal glyphs", () => {
		const view = createView({
			name: "unicode-width",
			version: 1,
			models: { roles: {}, defaults: {} },
			nodes: [{ id: "验证节点", type: "review" }],
			edges: [],
		});
		view.nodes[0]!.summary = "检查中文摘要和符号✓";

		const diagram = renderWorkflowGraphDiagram(view, { width: 48 });
		const boxLines = diagram.filter(line => line.includes("验证节点") || line.includes("检查中文摘要"));
		const borderedLines = diagram.filter(
			line =>
				line.trimStart().startsWith("│") || line.trimStart().startsWith("┌") || line.trimStart().startsWith("└"),
		);
		const widths = new Set(borderedLines.map(line => visibleWidth(line.trimStart())));

		expect(boxLines.length).toBeGreaterThan(0);
		expect(widths.size).toBe(1);
	});

	it("renders checkpoint frontier through a change mapping approved after checkpoint creation", () => {
		const oldFreeze = createFreeze({
			name: "mutable-old",
			version: 1,
			models: { roles: {}, defaults: {} },
			nodes: [
				{ id: "runValidation", type: "script" },
				{ id: "weakReview", type: "review" },
			],
			edges: [{ from: "runValidation", to: "weakReview" }],
		});
		const newFreeze = createFreeze({
			name: "mutable-new",
			version: 2,
			models: { roles: {}, defaults: {} },
			nodes: [
				{ id: "runValidation", type: "script" },
				{ id: "strongReview", type: "review" },
			],
			edges: [{ from: "runValidation", to: "strongReview" }],
		});

		const view = buildWorkflowGraphView({
			id: "mutable-family",
			freezes: [oldFreeze, newFreeze],
			attempts: [
				{
					id: "attempt-1",
					familyId: "mutable-family",
					freezeId: oldFreeze.id,
					startNodeId: "runValidation",
					status: "stopped",
					runtimeBindingSnapshot: createBinding(),
					activations: [],
				},
				{
					id: "attempt-2",
					familyId: "mutable-family",
					freezeId: newFreeze.id,
					startNodeId: "strongReview",
					status: "running",
					checkpointId: "checkpoint-1",
					runtimeBindingSnapshot: createBinding(),
					activations: [],
				},
			],
			checkpoints: [
				{
					id: "checkpoint-1",
					familyId: "mutable-family",
					attemptId: "attempt-1",
					completedActivationIds: [],
					abortedActivationIds: [],
					frontierNodeIds: ["weakReview"],
					state: {},
					sourceMapping: { weakReview: "weakReview" },
				},
			],
			changeRequests: [
				{
					id: "change-1",
					familyId: "mutable-family",
					checkpointId: "checkpoint-1",
					status: "approved",
					actor: "human:sihao",
					origin: "human",
					reason: "upgrade review",
					operations: [],
					frontierMapping: { weakReview: "strongReview" },
					approvedBy: "human:sihao",
					applications: [
						{
							target: "freeze",
							actor: "human:sihao",
							freezeId: newFreeze.id,
						},
					],
				},
			],
		});

		expect(view.checkpoint?.frontier).toEqual([{ from: "weakReview", to: "strongReview" }]);
		expect(view.nodes.find(node => node.id === "strongReview")?.status).toBe("frontier");
		expect(renderWorkflowGraphText(view)).toContain("Checkpoint frontier: checkpoint-1 weakReview to strongReview");
	});

	it("re-renders live TUI graph components from provider updates at the same width", async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("dark theme fixture is required");
		setThemeInstance(theme);
		let view = singleNodeView("running");
		const component = new WorkflowGraphComponent(view, { viewProvider: () => view, refreshMs: 0 });

		expect(component.render(80).join("\n")).toContain("running");
		view = singleNodeView("completed");

		expect(component.render(80).join("\n")).toContain("completed");
	});

	it("renders TUI frontier routes without arrow fragments", async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("dark theme fixture is required");
		setThemeInstance(theme);
		const component = new WorkflowGraphComponent(
			{
				familyId: "frontier-family",
				latestFreezeId: "flowfreeze:frontier",
				currentAttempt: {
					id: "attempt-1",
					status: "stopped",
					checkpointId: "checkpoint-1",
					runtimeBindingId: "binding-1",
				},
				changes: { approved: 1, proposed: 0, rejected: 0 },
				nodes: [
					{ id: "planner", kind: "script", status: "checkpointed", focused: true },
					{ id: "strongReview", kind: "review", status: "frontier", focused: true },
				],
				edges: [{ from: "planner", to: "strongReview" }],
				checkpoint: { id: "checkpoint-1", frontier: [{ from: "weakReview", to: "strongReview" }] },
				lineage: [],
				actions: ["Refresh: /workflow graph --family-id frontier-family"],
			},
			{ refreshMs: 0 },
		);

		const text = stripAnsi(component.render(120).join("\n"));

		expect(text).toContain("frontier weakReview to strongReview");
		expect(text).not.toContain("frontier weakReview -> strongReview");
		expect(text).not.toMatch(/[-─]+[>→▶]|[<←◀][-─]+|->|=>|→{1,}|←{1,}/u);
	});

	it("writes timestamped workflow monitor snapshots under the agent cache", async () => {
		const root = path.resolve("temp", "workflow-monitor-history", String(Bun.nanoseconds()));
		try {
			const agentDir = path.join(root, "agent");
			const snapshotPath = await writeWorkflowGraphMonitorSnapshot(singleNodeView("running"), {
				agentDir,
				now: new Date("2026-01-02T03:04:05.006Z"),
			});

			expect(snapshotPath).toBe(
				path.join(agentDir, "cache", "workflows", "2026-01-02T03-04-05-006Z-live-family.json"),
			);
			const snapshot = await Bun.file(snapshotPath).json();
			expect(snapshot.familyId).toBe("live-family");
			expect(snapshot.view.currentAttempt.id).toBe("attempt-live");
			expect(snapshot.renderedText).toContain("Workflow graph: live-family");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});

function expectConnectorsUseOneBoxDrawingBaseline(diagram: string[]): void {
	const connectorChars = new Set(["│", "─", "┌", "┐", "└", "┘", "┬", "┴", "┼", "├", "┤", "╤", "╧", " "]);
	for (const line of diagram) {
		for (const char of line) {
			if (char === "✓" || char === "○" || char === " " || /\p{Letter}|\p{Number}|\p{Punctuation}/u.test(char)) {
				continue;
			}
			expect(connectorChars.has(char)).toBe(true);
		}
	}
}

function expectSplitAndMergeBusesToBeCentered(diagram: string[]): void {
	for (const line of diagram) {
		const splitColumns = visibleColumnsOf(line, "┌");
		const mergeColumns = visibleColumnsOf(line, "└");
		if (splitColumns.length === 1) expectCenteredBus(line, "┌", "┴", "┐");
		if (mergeColumns.length === 1) expectCenteredBus(line, "└", "┬", "┘");
	}
}

function expectCenteredBus(line: string, leftGlyph: string, centerGlyph: string, rightGlyph: string): void {
	const left = visibleColumnsOf(line, leftGlyph)[0];
	const center = visibleColumnsOf(line, centerGlyph)[0];
	const right = visibleColumnsOf(line, rightGlyph).at(-1);
	if (left === undefined || center === undefined || right === undefined) return;
	expect(center - left).toBe(right - center);
}

function visibleColumnsOf(line: string, needle: string): number[] {
	const columns: number[] = [];
	let visibleColumn = 0;
	for (const char of line) {
		if (char === needle) columns.push(visibleColumn);
		visibleColumn += visibleWidth(char);
	}
	return columns;
}

function charAtVisibleColumn(line: string, column: number): string | undefined {
	let visibleColumn = 0;
	for (const char of line) {
		if (visibleColumn === column) return char;
		visibleColumn += visibleWidth(char);
	}
	return undefined;
}

function stripAnsi(text: string): string {
	return text.replace(/\u001b\[[0-9;]*m/g, "");
}

function findLastIndex<T>(values: T[], predicate: (value: T, index: number) => boolean): number {
	for (let index = values.length - 1; index >= 0; index -= 1) {
		if (predicate(values[index]!, index)) return index;
	}
	return -1;
}

function singleNodeView(status: WorkflowGraphView["nodes"][number]["status"]): WorkflowGraphView {
	return {
		familyId: "live-family",
		latestFreezeId: "flowfreeze:live",
		currentAttempt: {
			id: "attempt-live",
			status: status === "completed" ? "completed" : "running",
			runtimeBindingId: "binding-live",
		},
		changes: { approved: 0, proposed: 0, rejected: 0 },
		nodes: [{ id: "build", kind: "script", status, focused: true }],
		edges: [],
		lineage: [],
		actions: ["Refresh: /workflow graph --family-id live-family"],
	};
}

function createView(definition: WorkflowDefinition): WorkflowGraphView {
	return buildWorkflowGraphView(createFamily(definition));
}

function createFamily(definition: WorkflowDefinition): WorkflowRunFamilySnapshot {
	const freeze = createFreeze(definition);
	return {
		id: `${definition.name}:family`,
		freezes: [freeze],
		attempts: [
			{
				id: `${definition.name}:attempt-1`,
				familyId: `${definition.name}:family`,
				freezeId: freeze.id,
				startNodeId: definition.nodes[0]?.id ?? "",
				status: "running",
				runtimeBindingSnapshot: createBinding(),
				activations: [],
			},
		],
		checkpoints: [],
		changeRequests: [],
	};
}

function createFreeze(definition: WorkflowDefinition): FlowFreeze {
	return {
		id: `flowfreeze:${definition.name}`,
		schemaVersion: "omhflow/v1",
		flowPath: `${definition.name}.omhflow`,
		resourceDir: definition.name,
		mainContentHash: "sha256:main",
		resourceHashes: [],
		resourceSnapshots: [],
		canonicalGraphHash: "sha256:graph",
		sourceMapping: {
			workflowBlocks: [{ id: "workflow:0", language: "yaml" }],
			nodes: Object.fromEntries(definition.nodes.map(node => [node.id, { sourceBlock: "workflow:0" }])),
		},
		staticCheckReport: {
			status: "passed",
			checks: [{ name: "parse", status: "passed" }],
		},
		portableDefaults: { models: definition.models },
		definition,
	};
}

function createBinding(): RuntimeBindingSnapshot {
	return {
		id: "binding-1",
		requestedRoles: {},
		resolvedModels: {},
		tools: [],
		agents: [],
		unavailable: [],
		warnings: [],
	};
}
