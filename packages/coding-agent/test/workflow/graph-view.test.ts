import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type NativeScrollbackLiveRegion, visibleWidth } from "@oh-my-pi/pi-tui";
import { WorkflowGraphComponent } from "../../src/modes/components/workflow-graph";
import { getThemeByName, setThemeInstance } from "../../src/modes/theme/theme";
import { parseWorkflowDefinition, type WorkflowDefinition } from "../../src/workflow/definition";
import type { FlowFreeze } from "../../src/workflow/freeze";
import {
	buildWorkflowGraphView,
	formatWorkflowConditionLabel,
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
		const mergeBusIndex = findLastIndex(diagram, line => line.includes("├") && line.includes("┘"));

		expect(branchLine).toBeDefined();
		expect(rendered).toContain("┬");
		expect(rendered).toMatch(/[┌└]─{2,}[┐┘]/u);
		expect(splitBusIndex).toBeGreaterThan(-1);
		expect(["│", "▼"]).toContain(diagram[splitBusIndex + 1]?.[diagram[splitBusIndex]!.indexOf("┌")]);
		expect(["│", "┴", "╧", "▼"]).toContain(diagram[splitBusIndex + 2]?.[diagram[splitBusIndex]!.indexOf("┌")]);
		expect(["│", "▼"]).toContain(diagram[splitBusIndex + 1]?.[diagram[splitBusIndex]!.lastIndexOf("┐")]);
		expect(["│", "┴", "╧", "▼"]).toContain(diagram[splitBusIndex + 2]?.[diagram[splitBusIndex]!.lastIndexOf("┐")]);
		expect(mergeBusIndex).toBeGreaterThan(-1);
		const mergeConnectorColumn = visibleColumnsOf(diagram[mergeBusIndex]!, "├")[0];
		const mergeStemLine = diagram[mergeBusIndex + 1];
		const mergeLandingLine = diagram[mergeBusIndex + 2];
		expect(mergeConnectorColumn).toBeDefined();
		expect(mergeStemLine).toBeDefined();
		expect(mergeLandingLine).toBeDefined();
		if (mergeConnectorColumn === undefined || mergeStemLine === undefined || mergeLandingLine === undefined) {
			throw new Error("expected merge connector lines to be present");
		}
		const mergeStemChar = charAtVisibleColumn(mergeStemLine, mergeConnectorColumn);
		const mergeLandingChar = charAtVisibleColumn(mergeLandingLine, mergeConnectorColumn);
		if (mergeStemChar === undefined || mergeLandingChar === undefined) {
			throw new Error("expected merge connector glyphs to be present");
		}
		expect(["│", "▼"]).toContain(mergeStemChar);
		expect(["┴", "╧", "▼"]).toContain(mergeLandingChar);
		expectConnectorsUseOneBoxDrawingBaseline(diagram);
		expectSplitAndMergeBusesToBeCentered(diagram);
		expect(rendered).toContain("▼");
		expect(rendered).not.toMatch(/->|=>|→{2,}|←{1,}|◀/u);
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
		let arrowSeen = false;
		for (let index = sourceBottomIndex + 1; index < targetTopIndex; index += 1) {
			const char = charAtVisibleColumn(diagram[index]!, connectorColumn!);
			if (char === "▼") arrowSeen = true;
			expect(char).toBeDefined();
			expect(["│", "▼"]).toContain(char!);
		}
		expect(arrowSeen).toBe(true);
		expect(rendered).not.toMatch(/->|=>|→{2,}|←{1,}|◀/u);
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

		const diagram = renderWorkflowGraphDiagram(view, { width: 80 });
		const rendered = diagram.join("\n");
		const loopCloseIndex = diagram.findIndex(line => line.includes("↺ build"));
		const loopColumn = visibleColumnsOf(diagram[loopCloseIndex] ?? "", "╯")[0];
		const loopLineIndex = diagram.findIndex(
			(line, index) => index < loopCloseIndex && charAtVisibleColumn(line, loopColumn ?? -1) === "╮",
		);

		expect(loopLineIndex).toBeGreaterThan(-1);
		expect(loopColumn).toBeDefined();
		expect(loopCloseIndex).toBeGreaterThan(loopLineIndex);
		for (let index = loopLineIndex + 1; index < loopCloseIndex; index += 1) {
			const connector = charAtVisibleColumn(diagram[index]!, loopColumn!);
			expect(connector).toBeDefined();
			expect(["│", "▲"]).toContain(connector!);
		}
		expect(rendered).toContain("▲");
		expect(rendered).toContain("↺ build · if retry");
		expect(rendered).not.toContain("review back to build");
		expect(rendered).not.toContain("loopbacks");
	});

	it("renders diagram route labels as compact decision chips", () => {
		const view = createView({
			name: "decision-chip-loop",
			version: 1,
			models: { roles: {}, defaults: {} },
			nodes: [
				{ id: "build", type: "agent" },
				{ id: "review", type: "review" },
				{ id: "ship", type: "script" },
			],
			edges: [
				{ from: "build", to: "review" },
				{
					from: "review",
					to: "build",
					condition: { source: 'outputs.review.verdict == "CONTINUE"' },
				},
				{
					from: "review",
					to: "ship",
					condition: { source: 'outputs.review.verdict == "COMPLETE"' },
				},
			],
		});

		const rendered = renderWorkflowGraphDiagram(view, { width: 96 }).join("\n");

		expect(rendered).toContain("if COMPLETE");
		expect(rendered).toContain("↺ build · if CONTINUE");
		expect(rendered).not.toContain("when review verdict");
		expect(rendered).not.toContain("back to build");
	});

	it("draws loopback rails as connected node-to-node controls near the graph", () => {
		const view = createView({
			name: "connected-loop-control",
			version: 1,
			models: { roles: {}, defaults: {} },
			nodes: [
				{ id: "build", type: "agent" },
				{ id: "review", type: "review" },
				{ id: "ship", type: "script" },
			],
			edges: [
				{ from: "build", to: "review" },
				{
					from: "review",
					to: "ship",
					condition: {
						source: 'state.releaseDecision == "finish" && state.reviewConclusion == "ship-after-long-label"',
					},
				},
				{ from: "review", to: "build", condition: { source: 'state.verdict == "retry"' } },
			],
		});

		const diagram = renderWorkflowGraphDiagram(view, { width: 96 });
		const targetLine = diagram.find(line => line.includes("├") && line.includes("╮"));
		const sourceLine = diagram.find(line => line.includes("├") && line.includes("╯"));
		const targetJointColumn = visibleColumnsOf(targetLine ?? "", "├").at(-1);
		const sourceJointColumn = visibleColumnsOf(sourceLine ?? "", "├").at(-1);
		const targetRailColumn = visibleColumnsOf(targetLine ?? "", "╮")[0];
		const sourceRailColumn = visibleColumnsOf(sourceLine ?? "", "╯")[0];

		expect(targetJointColumn).toBeDefined();
		expect(sourceJointColumn).toBeDefined();
		expect(targetRailColumn).toBe(sourceRailColumn);
		expect(targetRailColumn! - targetJointColumn!).toBeLessThanOrEqual(8);
		expect(sourceRailColumn! - sourceJointColumn!).toBeLessThanOrEqual(8);
		expect(targetLine).toContain("├──");
		expect(sourceLine).toContain("├──");
		expect(sourceLine).toContain("↺ build · if retry");
		expect(sourceLine).not.toContain("review back to build");
	});

	it("routes parallel horizontal connector lanes without same-direction overlap", () => {
		const view = createView({
			name: "separated-connector-lanes",
			version: 1,
			models: { roles: {}, defaults: {} },
			nodes: [
				{ id: "fanout", type: "script" },
				{ id: "leftBuilder", type: "agent" },
				{ id: "middleBuilder", type: "agent" },
				{ id: "rightBuilder", type: "agent" },
				{ id: "review", type: "review", waitFor: ["leftBuilder", "middleBuilder", "rightBuilder"] },
			],
			edges: [
				{ from: "fanout", to: "leftBuilder" },
				{ from: "fanout", to: "middleBuilder" },
				{ from: "fanout", to: "rightBuilder" },
				{ from: "leftBuilder", to: "review" },
				{ from: "middleBuilder", to: "review" },
				{ from: "rightBuilder", to: "review" },
			],
		});

		const diagram = renderWorkflowGraphDiagram(view, { width: 128 });
		const sourceBottomIndex = diagram.findIndex(line => line.includes("└") && line.includes("┬"));
		const firstTargetTopIndex = diagram.findIndex(
			(line, index) => index > sourceBottomIndex && line.includes("┌") && line.includes("┴"),
		);
		const connectorRows = diagram
			.slice(sourceBottomIndex + 1, firstTargetTopIndex)
			.map(line => visibleColumnsOf(line, "─").join(","))
			.filter(signature => signature.length > 0);

		expect(sourceBottomIndex).toBeGreaterThan(-1);
		expect(firstTargetTopIndex).toBeGreaterThan(sourceBottomIndex);
		expect(connectorRows.length).toBeGreaterThanOrEqual(2);
		expect(new Set(connectorRows).size).toBe(connectorRows.length);
		expectConnectorsUseOneBoxDrawingBaseline(diagram);
		expect(diagram.join("\n")).toContain("▼");
	});

	it("weakens loopback lines where another node visually covers the route", () => {
		const view = createView({
			name: "occluded-loopback-route",
			version: 1,
			models: { roles: {}, defaults: {} },
			nodes: [
				{ id: "start", type: "script" },
				{ id: "build", type: "agent" },
				{ id: "sideQuest", type: "script" },
				{ id: "review", type: "review" },
			],
			edges: [
				{ from: "start", to: "build" },
				{ from: "start", to: "sideQuest" },
				{ from: "build", to: "review" },
				{ from: "review", to: "build", condition: { source: 'outputs.review.verdict == "retry"' } },
			],
		});

		const diagram = renderWorkflowGraphDiagram(view, { width: 118 });
		const rendered = diagram.join("\n");

		expect(rendered).toContain("↺ build · if retry");
		expect(rendered).toContain("▲");
		expect(rendered).toContain("Program┄·┄runs");
		expect(rendered).not.toContain("Program────runs");
	});

	it("colors workflow connector glyphs in the TUI diagram without coloring node text as connectors", async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("dark theme fixture is required");
		setThemeInstance(theme);
		const view = createView({
			name: "colored-connector-canvas",
			version: 1,
			models: { roles: {}, defaults: {} },
			nodes: [
				{ id: "build", type: "agent" },
				{ id: "review", type: "review" },
			],
			edges: [
				{ from: "build", to: "review" },
				{ from: "review", to: "build", condition: { source: 'outputs.review.verdict == "retry"' } },
			],
		});

		const rendered = new WorkflowGraphComponent(view, { refreshMs: 0 }).render(132).join("\n");

		expect(rendered).toMatch(/\x1b\[[0-9;]*m[▲▼▶│─┄┆]/u);
		expect(rendered).not.toMatch(/\x1b\[[0-9;]*moutputs\.review\.verdict/u);
	});

	it("keeps loop decision chips short in narrow labels", () => {
		const view = createView({
			name: "long-loop-label",
			version: 1,
			models: { roles: {}, defaults: {} },
			nodes: [
				{ id: "implementRound", type: "agent" },
				{ id: "writeRoundSummary", type: "script" },
				{ id: "codexSummaryReview", type: "review" },
			],
			edges: [
				{ from: "implementRound", to: "writeRoundSummary" },
				{ from: "writeRoundSummary", to: "codexSummaryReview" },
				{
					from: "codexSummaryReview",
					to: "implementRound",
					condition: { source: 'outputs.codexSummaryReview.verdict != "COMPLETE"' },
				},
			],
		});

		const diagram = renderWorkflowGraphDiagram(view, { width: 96 });
		const loopLabelLine = diagram.find(line => line.includes("↺ implementRound"));

		expect(loopLabelLine).toBeDefined();
		expect(loopLabelLine).toContain("not COMPLETE");
		expect(loopLabelLine).not.toContain("codexSummaryReview back");
		expect(loopLabelLine).not.toContain("codex summary review");
		expect(visibleWidth(loopLabelLine!)).toBeLessThanOrEqual(96);
	});

	it("keeps the full executable attempt id visible in stop actions", () => {
		const view = createView({
			name: "stop-id-contract",
			version: 1,
			models: { roles: {}, defaults: {} },
			nodes: [{ id: "review", type: "review" }],
			edges: [],
		});
		view.currentAttempt = {
			id: "workflow-abc123:attempt-1",
			status: "running",
			runtimeBindingId: "binding-1",
		};
		view.actions = [
			"Refresh: /workflow graph --family-id stop-id-contract",
			"Stop attempt: /workflow stop workflow-abc123:attempt-1 --deadline-ms 30000",
		];

		const rendered = renderWorkflowGraphText(view);

		expect(rendered).toContain("Run: attempt-1 running");
		expect(rendered).toContain("Stop attempt · /workflow stop workflow-abc123:attempt-1 --deadline-ms 30000");
		expect(rendered).not.toContain("Stop attempt · /workflow stop attempt-1 --deadline-ms 30000");
	});

	it("keeps stop command affordances visible in the dashboard controls", async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("dark theme fixture is required");
		setThemeInstance(theme);
		const view = createView({
			name: "stop-command-dashboard",
			version: 1,
			models: { roles: {}, defaults: {} },
			nodes: [{ id: "review", type: "review" }],
			edges: [],
		});
		view.currentAttempt = {
			id: "workflow-abc123:attempt-1",
			status: "running",
			runtimeBindingId: "binding-1",
		};
		view.actions = [
			"Refresh: /workflow graph --family-id stop-command-dashboard",
			"Stop attempt: /workflow stop workflow-abc123:attempt-1 --deadline-ms 30000",
		];

		const text = stripAnsi(new WorkflowGraphComponent(view, { refreshMs: 0 }).render(180).join("\n"));

		expect(text).toContain("Stop attempt · /workflow stop");
		expect(text).not.toContain("■ Stop attempt\n");
	});

	it("keeps loop diagrams inside the requested terminal width at common sizes", () => {
		const view = createView({
			name: "responsive-loop-control",
			version: 1,
			models: { roles: {}, defaults: {} },
			nodes: [
				{ id: "implementRound", type: "agent" },
				{ id: "writeRoundSummary", type: "script" },
				{ id: "codexSummaryReview", type: "review" },
				{ id: "enterReviewPhase", type: "script" },
				{ id: "fixReviewIssues", type: "agent" },
				{ id: "codexCodeReview", type: "review" },
			],
			edges: [
				{ from: "implementRound", to: "writeRoundSummary" },
				{ from: "writeRoundSummary", to: "codexSummaryReview" },
				{
					from: "codexSummaryReview",
					to: "implementRound",
					condition: { source: 'outputs.codexSummaryReview.verdict != "COMPLETE"' },
				},
				{
					from: "codexSummaryReview",
					to: "enterReviewPhase",
					condition: { source: 'outputs.codexSummaryReview.verdict == "COMPLETE"' },
				},
				{ from: "enterReviewPhase", to: "fixReviewIssues" },
				{ from: "fixReviewIssues", to: "codexCodeReview" },
				{
					from: "codexCodeReview",
					to: "fixReviewIssues",
					condition: { source: 'outputs.codexCodeReview.verdict == "ISSUES"' },
				},
			],
		});

		for (const width of [64, 96, 132]) {
			const diagram = renderWorkflowGraphDiagram(view, { width });
			const tooWide = diagram.filter(line => visibleWidth(line) > width);
			const connectedLoopLine = diagram.find(
				line => line.includes("├") && (line.includes("╯") || line.includes("╮")),
			);

			expect(tooWide).toEqual([]);
			expect(connectedLoopLine).toBeDefined();
		}
	});

	it("keeps nested loop rails aligned without crossing readable labels", () => {
		const view: WorkflowGraphView = {
			familyId: "humanize-rlcr-family",
			currentAttempt: {
				id: "attempt-1",
				status: "running",
				runtimeBindingId: "binding-1",
			},
			changes: { approved: 0, proposed: 0, rejected: 0 },
			topology: { parallelFanOuts: 0, branchPoints: 2, joins: 1, loops: 2, subflows: 0 },
			nodes: [
				{ id: "plan", kind: "agent", status: "completed", focused: false, activationCount: 1 },
				{ id: "implement", kind: "agent", status: "completed", focused: false, activationCount: 4 },
				{ id: "summaryReview", kind: "review", status: "completed", focused: false, activationCount: 4 },
				{ id: "codeReview", kind: "review", status: "running", activationCount: 4, focused: true },
				{ id: "done", kind: "program", status: "pending", focused: false, activationCount: 0 },
			],
			edges: [
				{ from: "plan", to: "implement" },
				{ from: "implement", to: "summaryReview" },
				{ from: "summaryReview", to: "codeReview", condition: 'state.summaryVerdict == "COMPLETE"' },
				{ from: "summaryReview", to: "implement", condition: 'state.summaryVerdict == "CONTINUE"' },
				{ from: "codeReview", to: "done", condition: 'state.codeVerdict == "COMPLETE"' },
				{ from: "codeReview", to: "implement", condition: 'state.codeVerdict == "CONTINUE"' },
			],
			lineage: [],
			actions: [],
		};

		const diagram = renderWorkflowGraphDiagram(view, { width: 104 });
		const rendered = diagram.join("\n");
		const implementRunsLine = diagram.find(
			line => line.includes("runs 4") && line.includes("┬") && line.includes("╮"),
		);
		const loopColumns = [
			...visibleColumnsOf(implementRunsLine ?? "", "┬"),
			...visibleColumnsOf(implementRunsLine ?? "", "╮"),
		];
		const summaryLabelLine = diagram.find(line => line.includes("if summary=CONTINUE"));
		const codeLabelLine = diagram.find(line => line.includes("if code=CONTINUE"));

		expect(loopColumns).toHaveLength(2);
		expect(charAtVisibleColumn(summaryLabelLine ?? "", loopColumns[0]!)).toBe("╯");
		expect(charAtVisibleColumn(summaryLabelLine ?? "", loopColumns[1]!)).toBe("│");
		expect(charAtVisibleColumn(codeLabelLine ?? "", loopColumns[1]!)).toBe("╯");
		expect(rendered).toContain("runs 0");
		expect(rendered).not.toContain("CONTINUE│");
		expect(rendered).not.toContain("CONTINUE╯");
	});

	it("summarizes branch, parallel, loop, join, and subflow topology for the operator cockpit", () => {
		const view = createView({
			name: "operator-topology",
			version: 1,
			models: { roles: {}, defaults: {} },
			subflows: [
				{
					alias: "reviewLoop",
					name: "review-loop",
					version: 1,
					namespace: "review__",
					nodeIds: ["review__build", "review__judge"],
					entryNodeIds: ["review__build"],
					exitNodeIds: ["review__judge"],
				},
			],
			nodes: [
				{ id: "plan", type: "agent" },
				{ id: "tryFast", type: "agent" },
				{ id: "trySafe", type: "agent" },
				{ id: "chooseBranch", type: "review" },
				{ id: "polish", type: "agent" },
			],
			edges: [
				{ from: "plan", to: "tryFast" },
				{ from: "plan", to: "trySafe" },
				{ from: "tryFast", to: "chooseBranch" },
				{ from: "trySafe", to: "chooseBranch" },
				{ from: "chooseBranch", to: "polish", condition: { source: 'outputs.chooseBranch.verdict == "COMPLETE"' } },
				{ from: "chooseBranch", to: "plan", condition: { source: 'outputs.chooseBranch.verdict == "CONTINUE"' } },
			],
		});

		expect(view.topology).toEqual({
			branchPoints: 1,
			joins: 1,
			loops: 1,
			parallelFanOuts: 1,
			subflows: 1,
		});
		expect(renderWorkflowGraphText(view)).toContain(
			"Flow: parallel fan-outs 1 / branch points 1 / joins 1 / loops 1 / subflows 1 · 5 nodes",
		);
	});

	it("describes multiple root nodes as parallel roots instead of linear flow", () => {
		const view = createView({
			name: "parallel-roots",
			version: 1,
			models: { roles: {}, defaults: {} },
			nodes: [
				{ id: "buildUi", type: "agent" },
				{ id: "buildApi", type: "agent" },
			],
			edges: [],
		});
		const text = renderWorkflowGraphText(view);

		expect(text).toContain("Flow: parallel roots 2 · 2 nodes");
		expect(text).not.toContain("Flow: linear · 2 nodes");
	});

	it("labels workflow graph mutation counts as flow changes, not project changes", async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("dark theme fixture is required");
		setThemeInstance(theme);
		const view = singleNodeView("running");
		view.changes = { approved: 1, proposed: 0, rejected: 0 };

		const text = renderWorkflowGraphText(view);
		const tuiText = stripAnsi(
			new WorkflowGraphComponent(view, { refreshMs: 0, heightProvider: () => 40 }).render(120).join("\n"),
		);

		expect(text).toContain("- Flow changes: 1 approved");
		expect(text).not.toContain("- Changes: 1 approved");
		expect(tuiText).toContain("Flow changes: 1 approved");
		expect(tuiText).not.toContain("Ops: changes 1 approved");
	});

	it("surfaces running workflow agents as operator-visible live work items", () => {
		const freeze = createFreeze({
			name: "agent-observability",
			version: 1,
			models: { roles: {}, defaults: {} },
			nodes: [
				{ id: "buildRound", type: "agent", agent: "task" },
				{ id: "reviewRound", type: "review", agent: "task" },
				{ id: "archive", type: "script", script: { language: "sh", code: "true" } },
			],
			edges: [
				{ from: "buildRound", to: "reviewRound" },
				{ from: "reviewRound", to: "archive" },
			],
		});
		const view = buildWorkflowGraphView({
			id: "agent-observability-family",
			freezes: [freeze],
			attempts: [
				{
					id: "attempt-1",
					familyId: "agent-observability-family",
					freezeId: freeze.id,
					startNodeId: "buildRound",
					status: "running",
					runtimeBindingSnapshot: createBinding(),
					activations: [
						{
							id: "activation-1",
							nodeId: "buildRound",
							parentActivationIds: [],
							status: "running",
						},
						{
							id: "activation-2",
							nodeId: "reviewRound",
							parentActivationIds: ["activation-1"],
							status: "running",
						},
					],
				},
			],
			checkpoints: [],
			changeRequests: [],
		});

		expect(view.activeAgents).toEqual([
			{
				activationId: "activation-1",
				focusAgentId: "buildRound",
				nodeId: "buildRound",
				label: "Build round",
				role: "Builder",
				status: "running",
			},
			{
				activationId: "activation-2",
				focusAgentId: "reviewRound",
				nodeId: "reviewRound",
				label: "Review round",
				role: "Reviewer",
				status: "running",
			},
		]);

		const text = renderWorkflowGraphText(view);

		expect(text).toContain("On-flight:");
		expect(text).toContain(
			"Agent Hub: double-left or observe to watch; Enter steers the selected agent; Esc returns.",
		);
		expect(text).toContain("- Builder · Build round live");
		expect(text).toContain("- Reviewer · Review round live");
		expect(text).toContain(
			"Interrupt Builder · Build round · /workflow interrupt attempt-1 buildRound --deadline-ms 30000",
		);
		expect(text).toContain(
			"Interrupt Reviewer · Review round · /workflow interrupt attempt-1 reviewRound --deadline-ms 30000",
		);
		expect(text).toContain("Open Agent Hub · double-left or observe key; watch/intervene buildRound or reviewRound");
		expect(text).toContain(
			"Steer selected agent · Agent Hub Enter attaches to the selected agent; Esc returns to workflow control",
		);
		expect(text).not.toContain("Focus agent: /agents");
	});

	it("uses semantic builder role labels for fixer agent nodes even when their ids mention review", async () => {
		const freeze = createFreeze({
			name: "agent-role-labels",
			version: 1,
			models: { roles: {}, defaults: {} },
			nodes: [
				{
					id: "fixCodeReviewIssues",
					type: "agent",
					agent: "task",
					model: { role: "builder" },
				},
			],
			edges: [],
		});
		const view = buildWorkflowGraphView({
			id: "agent-role-labels-family",
			freezes: [freeze],
			attempts: [
				{
					id: "attempt-1",
					familyId: "agent-role-labels-family",
					freezeId: freeze.id,
					startNodeId: "fixCodeReviewIssues",
					status: "running",
					runtimeBindingSnapshot: createBinding(),
					activations: [
						{
							id: "activation-1",
							nodeId: "fixCodeReviewIssues",
							parentActivationIds: [],
							status: "running",
						},
					],
				},
			],
			checkpoints: [],
			changeRequests: [],
		});

		expect(view.activeAgents).toEqual([
			{
				activationId: "activation-1",
				focusAgentId: "fixCodeReviewIssues",
				nodeId: "fixCodeReviewIssues",
				label: "Fix code review issues",
				role: "Builder",
				status: "running",
			},
		]);
		expect(view.focus?.role).toBe("Builder");

		const text = renderWorkflowGraphText(view);
		expect(text).toContain("- Builder · Fix code review issues live");
		expect(text).not.toContain("- Reviewer · Fix code review issues live");

		const root = path.resolve("temp", "workflow-monitor-history", String(Bun.nanoseconds()));
		try {
			const snapshotPath = await writeWorkflowGraphMonitorSnapshot(view, {
				agentDir: path.join(root, "agent"),
				now: new Date("2026-01-02T03:04:05.006Z"),
			});
			const snapshot = await Bun.file(snapshotPath).json();
			expect(snapshot.view.activeAgents[0].role).toBe("Builder");
			expect(snapshot.renderedText).toContain("Builder · Fix code review issues");
			expect(snapshot.renderedText).not.toContain("Reviewer · Fix code review issues");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("summarizes active workflow agent model binding and live progress for the cockpit", () => {
		const freeze = createFreeze({
			name: "agent-progress-cockpit",
			version: 1,
			models: { roles: {}, defaults: {} },
			nodes: [
				{ id: "buildRound", type: "agent", agent: "task" },
				{ id: "reviewRound", type: "review", agent: "task" },
			],
			edges: [{ from: "buildRound", to: "reviewRound" }],
		});
		const view = buildWorkflowGraphView(
			{
				id: "agent-progress-family",
				freezes: [freeze],
				attempts: [
					{
						id: "attempt-1",
						familyId: "agent-progress-family",
						freezeId: freeze.id,
						startNodeId: "buildRound",
						status: "running",
						runtimeBindingSnapshot: {
							...createBinding(),
							modelBindings: {
								buildRound: {
									nodeId: "buildRound",
									source: "node",
									requestedPattern: "gpt-5.5",
									unavailablePolicy: "fail",
									resolvedModel: "rust.cat/gpt-5.5",
									explicitThinkingLevel: false,
									fallbackUsed: false,
								},
							},
						},
						activations: [
							{
								id: "activation-build",
								nodeId: "buildRound",
								parentActivationIds: [],
								status: "running",
							},
						],
					},
				],
				checkpoints: [],
				changeRequests: [],
			},
			{
				activeAgentProgressById: new Map([
					[
						"buildRound",
						{
							model: "rust.cat/gpt-5.5",
							currentTool: "bash",
							currentToolArgs: "bun test",
							lastIntent: "tightening the recursive runner validation",
							recentOutput: ["Running bun test", "Fixed loop termination case"],
							durationMs: 65_000,
							toolCount: 4,
						},
					],
				]),
			},
		);

		expect(view.activeAgents).toEqual([
			{
				activationId: "activation-build",
				focusAgentId: "buildRound",
				nodeId: "buildRound",
				label: "Build round",
				role: "Builder",
				status: "running",
				model: "rust.cat/gpt-5.5",
				tool: "bash bun test",
				activity: "tightening the recursive runner validation",
				stats: "1m05s · 4 tools",
				recentOutput: ["Running bun test", "Fixed loop termination case"],
			},
		]);
		expect(view.focus).toEqual({
			nodeId: "buildRound",
			label: "Build round",
			role: "Builder",
			status: "running",
			focusAgentId: "buildRound",
			model: "rust.cat/gpt-5.5",
			tool: "bash bun test",
			activity: "tightening the recursive runner validation",
			stats: "1m05s · 4 tools",
			recentOutput: ["Running bun test", "Fixed loop termination case"],
			controls: [
				"Watch: Agent Hub buildRound",
				"Interrupt: /workflow interrupt attempt-1 buildRound --deadline-ms 30000",
				"Steer: Agent Hub Enter attaches; Esc returns",
			],
		});

		const text = renderWorkflowGraphText(view);

		expect(text).toContain("Focused node:");
		expect(text).toContain("- Builder · Build round live · rust.cat/gpt-5.5 · tool bash bun test · 1m05s · 4 tools");
		expect(text).toContain("- activity: tightening the recursive runner validation");
		expect(text).toContain("- stdout: Running bun test");
		expect(text).toContain("- control: Interrupt: /workflow interrupt attempt-1 buildRound --deadline-ms 30000");
		expect(text).toContain(
			"- Builder · Build round live · rust.cat/gpt-5.5 · tool bash bun test · 1m05s · 4 tools - tightening the recursive runner validation",
		);
		expect(text).toContain("Recent activity:");
		expect(text).toContain("- progress · Builder · Build round: tightening the recursive runner validation");
		expect(text).toContain("- stdout · Builder · Build round: Running bun test");
		expect(text).toContain("- stdout · Builder · Build round: Fixed loop termination case");
		expect(text).not.toContain("activation-build");
		expect(text).not.toContain("agent:task");
	});

	it("shows checkpoint frontier as the focused node after a stopped workflow", async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("dark theme fixture is required");
		setThemeInstance(theme);
		const freeze = createFreeze({
			name: "checkpoint-focus",
			version: 1,
			models: { roles: {}, defaults: {} },
			nodes: [
				{ id: "plan", type: "script", script: { language: "sh", code: "true" } },
				{ id: "review", type: "review", prompt: "Review the plan" },
			],
			edges: [{ from: "plan", to: "review" }],
		});
		const view = buildWorkflowGraphView({
			id: "checkpoint-focus-family",
			freezes: [freeze],
			attempts: [
				{
					id: "attempt-1",
					familyId: "checkpoint-focus-family",
					freezeId: freeze.id,
					startNodeId: "plan",
					status: "stopped",
					runtimeBindingSnapshot: createBinding(),
					checkpointId: "checkpoint-1",
					activations: [
						{
							id: "activation-plan",
							nodeId: "plan",
							parentActivationIds: [],
							status: "completed",
							output: { summary: "planned next change" },
						},
					],
				},
			],
			checkpoints: [
				{
					id: "checkpoint-1",
					familyId: "checkpoint-focus-family",
					attemptId: "attempt-1",
					completedActivationIds: ["activation-plan"],
					abortedActivationIds: [],
					frontierNodeIds: ["review"],
					state: {},
					sourceMapping: {},
				},
			],
			changeRequests: [],
		});

		expect(view.focus).toEqual({
			nodeId: "review",
			label: "Review",
			role: "Reviewer",
			status: "frontier",
		});

		const text = renderWorkflowGraphText(view);

		expect(text).toContain("Focused node:");
		expect(text).toContain("- Reviewer · Review frontier");
		expect(text).toContain("Frontier: review to review");

		const tuiText = stripAnsi(new WorkflowGraphComponent(view, { refreshMs: 0 }).render(140).join("\n"));

		expect(tuiText).toContain("◎ focus review");
		expect(tuiText).toContain("▶ restart");
		expect(tuiText).toContain("╭─ Operator Deck");
		expect(tuiText).not.toContain("Live Workbench");
		expect(tuiText).toContain("◇ frontier");
		expect(tuiText).not.toContain("◇ ready");
		expect(tuiText).toContain("1 frontier");
		expect(tuiText).toContain("frontier: ◇ review");
		expect(tuiText).not.toContain("1 active");
		expect(tuiText).not.toContain("live: ◇ review");
		expect(tuiText).not.toContain("◉ monitor review");
		expect(tuiText).not.toContain("◆ hub");
		expect(tuiText).not.toContain("↵ steer");
	});

	it("labels repeated loop activations with the current round and focus target", () => {
		const freeze = createFreeze({
			name: "loop-observability",
			version: 1,
			models: { roles: {}, defaults: {} },
			nodes: [
				{ id: "buildRound", type: "agent", agent: "task" },
				{ id: "reviewRound", type: "review", agent: "task" },
			],
			edges: [
				{ from: "buildRound", to: "reviewRound" },
				{ from: "reviewRound", to: "buildRound", condition: { source: 'state.review.verdict == "continue"' } },
			],
		});
		const view = buildWorkflowGraphView({
			id: "loop-observability-family",
			freezes: [freeze],
			attempts: [
				{
					id: "attempt-1",
					familyId: "loop-observability-family",
					freezeId: freeze.id,
					startNodeId: "buildRound",
					status: "running",
					runtimeBindingSnapshot: createBinding(),
					activations: [
						{
							id: "activation-build-1",
							nodeId: "buildRound",
							parentActivationIds: [],
							status: "completed",
						},
						{
							id: "activation-review-1",
							nodeId: "reviewRound",
							parentActivationIds: ["activation-build-1"],
							status: "completed",
							output: { summary: "CONTINUE" },
						},
						{
							id: "activation-build-2",
							nodeId: "buildRound",
							parentActivationIds: ["activation-review-1"],
							status: "running",
						},
					],
				},
			],
			checkpoints: [],
			changeRequests: [],
		});

		expect(view.activeAgents).toEqual([
			{
				activationId: "activation-build-2",
				focusAgentId: "buildRound-2",
				generation: 2,
				nodeId: "buildRound",
				label: "Build round",
				role: "Builder",
				status: "running",
			},
		]);

		const text = renderWorkflowGraphText(view);

		expect(text).toContain("- Builder · Build round live · round 2 (watch/intervene buildRound-2)");
		expect(text).toContain("runs 2");
		expect(text).toContain("runs 1");
		expect(text).toContain(
			"Interrupt Builder · Build round · /workflow interrupt attempt-1 buildRound-2 --deadline-ms 30000",
		);
		expect(text).toContain("Open Agent Hub · double-left or observe key; watch/intervene buildRound-2");
	});

	it("keeps default graph labels human-facing instead of showing runtime adapter names", () => {
		const view = createView({
			name: "human-facing-labels",
			version: 1,
			models: { roles: {}, defaults: {} },
			nodes: [
				{ id: "buildRound", type: "agent", agent: "task" },
				{ id: "reviewRound", type: "review", agent: "task" },
				{ id: "archive", type: "script", script: { language: "sh", code: "true" } },
			],
			edges: [
				{ from: "buildRound", to: "reviewRound" },
				{ from: "reviewRound", to: "archive" },
			],
		});

		const rendered = renderWorkflowGraphText(view);

		expect(rendered).toContain("Builder");
		expect(rendered).toContain("Reviewer");
		expect(rendered).toContain("Evidence archive");
		expect(rendered).not.toContain("agent:task");
		expect(rendered).not.toContain("review:task");
		expect(rendered).not.toContain("script:sh");
	});

	it("renders structured completion summaries as human-facing text", () => {
		const freeze = createFreeze({
			name: "structured-summary",
			version: 1,
			models: { roles: {}, defaults: {} },
			nodes: [{ id: "writeReleasePlan", type: "agent", agent: "task" }],
			edges: [],
		});
		const view = buildWorkflowGraphView({
			id: "structured-summary-family",
			freezes: [freeze],
			attempts: [
				{
					id: "attempt-1",
					familyId: "structured-summary-family",
					freezeId: freeze.id,
					startNodeId: "writeReleasePlan",
					status: "completed",
					runtimeBindingSnapshot: createBinding(),
					activations: [
						{
							id: "activation-1",
							nodeId: "writeReleasePlan",
							parentActivationIds: [],
							status: "completed",
							output: {
								summary:
									'{"status":"completed","summary":"Wrote TLS plan","artifacts":["workflow-output/release-plan.md"]}',
							},
						},
					],
				},
			],
			checkpoints: [],
			changeRequests: [],
		});

		const rendered = renderWorkflowGraphText(view);

		expect(rendered).toContain("completed - Wrote TLS plan");
		expect(rendered).not.toContain('{"status":"completed"');
		expect(rendered).not.toContain("workflow-output/release-plan.md");
	});

	it("infers cockpit roles from workflow node intent instead of falling back to generic agents", () => {
		const view = createView({
			name: "cockpit-labels",
			version: 1,
			models: { roles: {}, defaults: {} },
			nodes: [
				{ id: "scoutParser", type: "agent" },
				{ id: "scoutCli", type: "agent" },
				{ id: "scoutUx", type: "agent" },
				{ id: "chooseBranch", type: "script" },
				{ id: "quality__qualityGate", type: "review" },
			],
			edges: [
				{ from: "scoutParser", to: "chooseBranch" },
				{ from: "scoutCli", to: "chooseBranch" },
				{ from: "scoutUx", to: "chooseBranch" },
				{ from: "chooseBranch", to: "quality__qualityGate" },
			],
		});

		const rendered = renderWorkflowGraphText(view);

		expect(rendered).toContain("Parser scout");
		expect(rendered).toContain("CLI scout");
		expect(rendered).toContain("UX scout");
		expect(rendered).toContain("Branch selector");
		expect(rendered).toContain("Quality gate");
		expect(rendered).not.toMatch(/\nAgent\s*\n/u);
	});

	it("renders imported subflows as explicit graph metadata", () => {
		const view = createView({
			name: "kda-humanize",
			version: 1,
			models: { roles: {}, defaults: {} },
			subflows: [
				{
					alias: "humanize",
					name: "humanize-reference",
					version: 1,
					namespace: "humanize__",
					nodeIds: ["humanize__planQuiz", "humanize__finalize"],
					entryNodeIds: ["humanize__planQuiz"],
					exitNodeIds: ["humanize__finalize"],
					resourcePrefix: "humanize",
				},
			],
			nodes: [
				{ id: "draftPlan", type: "agent" },
				{ id: "humanize__planQuiz", type: "human" },
				{ id: "humanize__finalize", type: "script" },
				{ id: "promotionDecision", type: "review" },
			],
			edges: [
				{ from: "draftPlan", to: "humanize__planQuiz" },
				{ from: "humanize__planQuiz", to: "humanize__finalize" },
				{ from: "humanize__finalize", to: "promotionDecision" },
			],
		});

		const text = renderWorkflowGraphText(view);

		expect(view.subflows).toEqual([
			{
				alias: "humanize",
				name: "humanize-reference",
				version: 1,
				namespace: "humanize__",
				nodeCount: 2,
				entryNodeIds: ["humanize__planQuiz"],
				exitNodeIds: ["humanize__finalize"],
				resourcePrefix: "humanize",
			},
		]);
		expect(text).toContain("Flow calls:");
		expect(text).toContain(
			"- humanize calls humanize-reference@1 · 2 nodes · entry planQuiz · exit finalize · resources humanize",
		);
	});

	it("renders edge annotations with directed connectors but without composed arrow fragments", () => {
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

		expect(diagram).toContain("if finish");
		expect(diagram).toContain("↺ build · if retry");
		expect(diagram).not.toContain("review back to build");
		expect(diagram).not.toContain('state.verdict == "finish"');
		expect(diagram).not.toContain('state.verdict == "retry"');
		expect(diagram).not.toContain("edge review to ship");
		expect(diagram).toContain("▼");
		expect(diagram).not.toMatch(/->|=>|→{1,}|←{1,}|◀/u);
	});

	it("anchors conditional edge labels to the connector column", () => {
		const view = createView({
			name: "conditional-label-anchor",
			version: 1,
			models: { roles: {}, defaults: {} },
			nodes: [
				{ id: "review", type: "review" },
				{ id: "ship", type: "script" },
			],
			edges: [{ from: "review", to: "ship", condition: { source: 'state.verdict == "finish"' } }],
		});

		const diagram = renderWorkflowGraphDiagram(view, { width: 72 });
		const sourceBottomIndex = diagram.findIndex(
			line => line.includes("└") && line.includes("┬") && line.includes("┘"),
		);
		const connectorColumn = visibleColumnsOf(diagram[sourceBottomIndex]!, "┬")[0];
		const labelLine = diagram.find(line => line.includes("if finish"));

		expect(connectorColumn).toBeDefined();
		expect(labelLine).toBeDefined();
		expect(charAtVisibleColumn(labelLine!, connectorColumn!)).toBe("│");
		expect(labelLine!.trimStart()).toStartWith("│  if finish");
		expect(labelLine).not.toContain("edge review to ship");
	});

	it("renders review-output loop conditions as human-facing verdict labels", () => {
		const view = createView({
			name: "review-output-loop",
			version: 1,
			models: { roles: {}, defaults: {} },
			nodes: [
				{ id: "writeInvestigation", type: "agent" },
				{ id: "reviewInvestigation", type: "review" },
				{ id: "archiveInvestigation", type: "script" },
			],
			edges: [
				{ from: "writeInvestigation", to: "reviewInvestigation" },
				{
					from: "reviewInvestigation",
					to: "writeInvestigation",
					condition: { source: 'outputs.reviewInvestigation.verdict == "CONTINUE"' },
				},
				{
					from: "reviewInvestigation",
					to: "archiveInvestigation",
					condition: { source: '!(outputs.reviewInvestigation.verdict == "CONTINUE")' },
				},
			],
		});

		const diagram = renderWorkflowGraphDiagram(view, { width: 96 });
		const rendered = diagram.join("\n");
		const loopLabelLine = diagram.find(line => line.includes("╯"));

		expect(loopLabelLine).toBeDefined();
		expect(loopLabelLine).toContain("↺ writeInvestigation · if CONTINUE");
		expect(loopLabelLine).not.toContain("reviewInvestigation back");
		expect(rendered).toContain("if not CONTINUE");
		expect(rendered).not.toContain("outputs.reviewInvestigation.verdict");
	});

	it("renders flow-authored edge labels without hardcoding state path semantics", () => {
		const view = createView({
			name: "labeled-route",
			version: 1,
			models: { roles: {}, defaults: {} },
			nodes: [
				{ id: "review", type: "review" },
				{ id: "hold", type: "script" },
			],
			edges: [
				{
					from: "review",
					to: "hold",
					condition: {
						source:
							'outputs.codexSummaryReview.verdict == "COMPLETE" && state.humanize.operatorGate.minimumSatisfied == false',
					},
					label: "long-running floor pending",
				},
			],
		});

		const diagram = renderWorkflowGraphDiagram(view, { width: 96 }).join("\n");

		expect(diagram).toContain("if long-running floor pending");
		expect(diagram).not.toContain("humanize operator gate");
		expect(diagram).not.toContain("state.humanize");
		expect(diagram).not.toContain("outputs.codexSummaryReview");
	});

	it("renders bare state gate conditions as human-facing labels", () => {
		const label = formatWorkflowConditionLabel("state.longRunningFloorPending");

		expect(label).toBe("long running floor pending is present");
		expect(label).not.toContain("state.");
	});

	it("surfaces parsed review verdicts and selected routes separately from summary text", () => {
		const freeze = createFreeze({
			name: "review-selected-route",
			version: 1,
			models: { roles: {}, defaults: {} },
			nodes: [
				{ id: "retryBranch", type: "script" },
				{ id: "reviewJsonSummary", type: "review" },
				{ id: "doneBranch", type: "script" },
			],
			edges: [
				{ from: "retryBranch", to: "reviewJsonSummary" },
				{
					from: "reviewJsonSummary",
					to: "retryBranch",
					condition: { source: 'outputs.reviewJsonSummary.verdict == "CONTINUE"' },
				},
				{
					from: "reviewJsonSummary",
					to: "doneBranch",
					condition: { source: 'outputs.reviewJsonSummary.verdict != "CONTINUE"' },
				},
			],
		});
		const view = buildWorkflowGraphView({
			id: "review-selected-route-family",
			freezes: [freeze],
			attempts: [
				{
					id: "attempt-1",
					familyId: "review-selected-route-family",
					freezeId: freeze.id,
					startNodeId: "retryBranch",
					status: "running",
					runtimeBindingSnapshot: createBinding(),
					activations: [
						{
							id: "activation-retry",
							nodeId: "retryBranch",
							parentActivationIds: [],
							status: "completed",
							output: { summary: "retry branch completed" },
						},
						{
							id: "activation-review",
							nodeId: "reviewJsonSummary",
							parentActivationIds: ["activation-retry"],
							status: "completed",
							output: {
								summary: "COMPLETE visually misleading summary text",
								data: { verdict: "CONTINUE" },
							},
						},
					],
				},
			],
			checkpoints: [],
			changeRequests: [],
		});

		const diagram = renderWorkflowGraphDiagram(view, { width: 96 }).join("\n");
		const text = renderWorkflowGraphText(view);

		expect(diagram).toContain("completed - verdict CONTINUE");
		expect(text).toContain("Selected routes:");
		expect(text).toContain("- reviewJsonSummary chose retryBranch when review json summary verdict is CONTINUE");
		expect(text).not.toContain("reviewJsonSummary chose doneBranch");
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
		expect(renderWorkflowGraphText(view)).toContain("- Frontier: weakReview to strongReview");
	});

	it("surfaces checkpointed aborted work as omitted activation output", async () => {
		const freeze = createFreeze({
			name: "checkpoint-aborted-output",
			version: 1,
			models: { roles: {}, defaults: {} },
			nodes: [
				{ id: "buildRound", type: "agent" },
				{ id: "reviewRound", type: "review" },
			],
			edges: [{ from: "buildRound", to: "reviewRound" }],
		});
		const view = buildWorkflowGraphView({
			id: "checkpoint-aborted-output-family",
			freezes: [freeze],
			attempts: [
				{
					id: "attempt-1",
					familyId: "checkpoint-aborted-output-family",
					freezeId: freeze.id,
					startNodeId: "buildRound",
					status: "stopped",
					runtimeBindingSnapshot: createBinding(),
					activations: [
						{
							id: "activation-build",
							nodeId: "buildRound",
							parentActivationIds: [],
							status: "aborted",
							reason: "stop deadline elapsed",
						},
					],
				},
			],
			checkpoints: [
				{
					id: "checkpoint-1",
					familyId: "checkpoint-aborted-output-family",
					attemptId: "attempt-1",
					completedActivationIds: [],
					abortedActivationIds: ["activation-build"],
					frontierNodeIds: ["buildRound"],
					state: {},
					sourceMapping: { buildRound: "buildRound" },
				},
			],
			changeRequests: [],
		});

		expect(view.checkpoint?.omittedAbortedOutputs).toBe(1);
		expect(renderWorkflowGraphText(view)).toContain("- Aborted work: 1 activation output omitted");

		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("dark theme fixture is required");
		setThemeInstance(theme);
		const componentText = stripAnsi(new WorkflowGraphComponent(view, { refreshMs: 0 }).render(120).join("\n"));

		expect(componentText).toContain("Aborted work: 1 activation output omitted");
		expect(componentText).not.toContain("half-finished");
	});

	it("renders checkpointed activations from the checkpoint attempt when ids were reused", () => {
		const freeze = createFreeze({
			name: "checkpoint-duplicate-ids",
			version: 1,
			models: { roles: {}, defaults: {} },
			nodes: [
				{ id: "prepare", type: "script" },
				{ id: "implement", type: "agent" },
				{ id: "review", type: "review" },
			],
			edges: [
				{ from: "prepare", to: "implement" },
				{ from: "implement", to: "review" },
			],
		});

		const view = buildWorkflowGraphView({
			id: "checkpoint-duplicate-ids-family",
			freezes: [freeze],
			attempts: [
				{
					id: "attempt-old",
					familyId: "checkpoint-duplicate-ids-family",
					freezeId: freeze.id,
					startNodeId: "prepare",
					status: "completed",
					runtimeBindingSnapshot: createBinding(),
					activations: [
						{
							id: "activation-1",
							nodeId: "prepare",
							parentActivationIds: [],
							status: "completed",
							output: { summary: "old prepare" },
						},
						{
							id: "activation-2",
							nodeId: "implement",
							parentActivationIds: ["activation-1"],
							status: "completed",
							output: { summary: "old implementation summary" },
						},
					],
				},
				{
					id: "attempt-checkpoint",
					familyId: "checkpoint-duplicate-ids-family",
					freezeId: freeze.id,
					startNodeId: "prepare",
					status: "stopped",
					runtimeBindingSnapshot: createBinding(),
					activations: [
						{
							id: "activation-1",
							nodeId: "prepare",
							parentActivationIds: [],
							status: "completed",
							output: { summary: "checkpoint prepare" },
						},
						{
							id: "activation-2",
							nodeId: "implement",
							parentActivationIds: ["activation-1"],
							status: "completed",
							output: { summary: "checkpoint implementation summary" },
						},
					],
				},
				{
					id: "attempt-restart",
					familyId: "checkpoint-duplicate-ids-family",
					freezeId: freeze.id,
					startNodeId: "review",
					status: "failed",
					checkpointId: "checkpoint-1",
					runtimeBindingSnapshot: createBinding(),
					activations: [
						{
							id: "activation-3",
							nodeId: "review",
							parentActivationIds: ["activation-1", "activation-2"],
							status: "failed",
							error: "review failed",
						},
					],
				},
			],
			checkpoints: [
				{
					id: "checkpoint-1",
					familyId: "checkpoint-duplicate-ids-family",
					attemptId: "attempt-checkpoint",
					completedActivationIds: ["activation-1", "activation-2"],
					abortedActivationIds: [],
					frontierNodeIds: ["review"],
					state: {},
					sourceMapping: { review: "review" },
				},
			],
			changeRequests: [],
		});

		const implement = view.nodes.find(node => node.id === "implement");
		const review = view.nodes.find(node => node.id === "review");

		expect(implement).toMatchObject({
			status: "checkpointed",
			summary: "checkpoint implementation summary",
		});
		expect(review).toMatchObject({
			status: "failed",
			error: "review failed",
		});
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

	it("notifies monitor history only when the live workflow graph view changes", async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("dark theme fixture is required");
		setThemeInstance(theme);
		let view = singleNodeView("running");
		const observed: WorkflowGraphView[] = [];
		const component = new WorkflowGraphComponent(view, {
			viewProvider: () => view,
			onViewChange: changedView => {
				observed.push(changedView);
			},
			refreshMs: 0,
		});

		component.render(80);
		component.render(80);
		view = singleNodeView("completed");
		component.render(80);

		expect(observed.map(changedView => changedView.nodes[0]?.status)).toEqual(["running", "completed"]);
	});

	it("marks the TUI graph component as a live monitor from its first row", async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("dark theme fixture is required");
		setThemeInstance(theme);
		const component = new WorkflowGraphComponent(singleNodeView("running"), { refreshMs: 0 });
		component.render(80);
		const liveRegion = component as WorkflowGraphComponent & NativeScrollbackLiveRegion;

		expect(liveRegion.getNativeScrollbackLiveRegionStart()).toBe(0);
		expect(liveRegion.getNativeScrollbackCommitSafeEnd?.()).toBeUndefined();
	});

	it("renders TUI frontier routes without ASCII arrow fragments", async () => {
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
				topology: { parallelFanOuts: 0, branchPoints: 0, joins: 0, loops: 0, subflows: 0 },
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

		expect(text).toContain("Frontier: weakReview to strongReview");
		expect(text).not.toContain("frontier weakReview -> strongReview");
		expect(text).not.toMatch(/->|=>|→{1,}|←{1,}/u);
	});

	it("renders imported subflows in the live TUI graph component", async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("dark theme fixture is required");
		setThemeInstance(theme);
		const view = createView({
			name: "kda-humanize-tui",
			version: 1,
			models: { roles: {}, defaults: {} },
			subflows: [
				{
					alias: "humanize",
					name: "humanize-reference",
					version: 1,
					namespace: "humanize__",
					nodeIds: ["humanize__planQuiz", "humanize__finalize"],
					entryNodeIds: ["humanize__planQuiz"],
					exitNodeIds: ["humanize__finalize"],
					resourcePrefix: "humanize",
				},
			],
			nodes: [
				{ id: "draftPlan", type: "agent" },
				{ id: "humanize__planQuiz", type: "human" },
				{ id: "humanize__finalize", type: "script" },
			],
			edges: [
				{ from: "draftPlan", to: "humanize__planQuiz" },
				{ from: "humanize__planQuiz", to: "humanize__finalize" },
			],
		});
		const component = new WorkflowGraphComponent(view, { refreshMs: 0 });

		const text = stripAnsi(component.render(120).join("\n"));

		expect(text).toContain("flow calls");
		expect(text).toContain("humanize calls humanize-reference@1");
		expect(text).toContain("2 nodes");
		expect(text).toContain("resources humanize");
	});

	it("renders active workflow agents in the live TUI graph component", async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("dark theme fixture is required");
		setThemeInstance(theme);
		const view = singleNodeView("running");
		view.activeAgents = [
			{
				activationId: "activation-build",
				focusAgentId: "buildRound",
				nodeId: "buildRound",
				label: "Build round",
				role: "Builder",
				status: "running",
				generation: 3,
				summary: "editing implementation",
			},
		];
		const component = new WorkflowGraphComponent(view, { refreshMs: 0 });

		const text = stripAnsi(component.render(120).join("\n"));

		expect(text).toContain("On-flight");
		expect(text).toContain(
			"Agent Hub: double-left or observe to watch; Enter steers the selected agent; Esc returns.",
		);
		expect(text).toContain("● Builder · Build round live · round 3 - editing implementation");
		expect(text).toContain("(buildRound)");
		expect(text).not.toContain("activation-build");
	});

	it("shows a running checkpoint resume as status instead of a duplicate restart action", () => {
		const definition: WorkflowDefinition = {
			name: "resume-affordance",
			version: 1,
			models: { roles: {}, defaults: {} },
			nodes: [
				{ id: "build", type: "script" },
				{ id: "review", type: "review" },
			],
			edges: [{ from: "build", to: "review" }],
		};
		const freeze = createFreeze(definition);
		const family: WorkflowRunFamilySnapshot = {
			id: "resume-affordance:family",
			freezes: [freeze],
			attempts: [
				{
					id: "attempt-source",
					familyId: "resume-affordance:family",
					freezeId: freeze.id,
					startNodeId: "build",
					status: "stopped",
					runtimeBindingSnapshot: createBinding(),
					activations: [],
				},
				{
					id: "attempt-resume",
					familyId: "resume-affordance:family",
					freezeId: freeze.id,
					startNodeId: "review",
					status: "running",
					checkpointId: "checkpoint-1",
					runtimeBindingSnapshot: createBinding(),
					activations: [],
				},
			],
			checkpoints: [
				{
					id: "checkpoint-1",
					familyId: "resume-affordance:family",
					attemptId: "attempt-source",
					completedActivationIds: [],
					abortedActivationIds: [],
					frontierNodeIds: ["review"],
					state: {},
					sourceMapping: {},
				},
			],
			changeRequests: [],
		};

		const view = buildWorkflowGraphView(family);

		expect(view.actions).toContain("Resume in progress: attempt-resume from checkpoint-1");
		expect(view.actions).not.toContain("Restart: /workflow restart checkpoint-1 --background");
	});

	it("does not advertise Agent Hub controls when running work has no live agent", () => {
		const definition: WorkflowDefinition = {
			name: "script-running",
			version: 1,
			models: { roles: {}, defaults: {} },
			nodes: [{ id: "build", type: "script" }],
			edges: [],
		};
		const freeze = createFreeze(definition);
		const family: WorkflowRunFamilySnapshot = {
			id: "script-running:family",
			freezes: [freeze],
			attempts: [
				{
					id: "script-running:attempt-1",
					familyId: "script-running:family",
					freezeId: freeze.id,
					startNodeId: "build",
					status: "running",
					runtimeBindingSnapshot: createBinding(),
					activations: [
						{
							id: "activation-build",
							nodeId: "build",
							parentActivationIds: [],
							status: "running",
						},
					],
				},
			],
			checkpoints: [],
			changeRequests: [],
		};

		const view = buildWorkflowGraphView(family);

		expect(view.actions).toContain("Status: /workflow manager --family-id script-running:family");
		expect(view.actions).not.toContain("Active agents: /workflow manager --family-id script-running:family");
		expect(view.actions.join("\n")).not.toContain("Open Agent Hub");
		expect(view.actions.join("\n")).not.toContain("Focused prompt");
	});

	it("does not treat stale focus agent ids as live monitor targets", async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("dark theme fixture is required");
		setThemeInstance(theme);
		const view = singleNodeView("running");
		view.focus = {
			nodeId: "build",
			label: "Build",
			role: "Program",
			status: "running",
			focusAgentId: "stale-agent",
		};

		const text = stripAnsi(new WorkflowGraphComponent(view, { refreshMs: 0 }).render(120).join("\n"));

		expect(text).toContain("◎ focus build");
		expect(text).not.toContain("◉ monitor stale-agent");
		expect(text).not.toContain("◆ hub");
		expect(text).not.toContain("↵ steer");
	});

	it("renders terminal attempts without stale live elapsed time from persisted activations", async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("dark theme fixture is required");
		setThemeInstance(theme);
		const definition: WorkflowDefinition = {
			name: "closed-live-stale",
			version: 1,
			models: { roles: {}, defaults: {} },
			nodes: [{ id: "build", type: "agent", agent: "task" }],
			edges: [],
		};
		const family = createFamily(definition);
		const attempt = family.attempts[0]!;
		attempt.id = "attempt-closed";
		attempt.status = "completed";
		attempt.activations = [
			{
				id: "activation-stale",
				nodeId: "build",
				parentActivationIds: [],
				status: "running",
			},
		];
		const view = buildWorkflowGraphView(family, {
			liveAttemptIds: new Set(),
			activeAgentProgressById: new Map([
				[
					"build",
					{
						durationMs: 40 * 60 * 60 * 1000,
						lastIntent: "still working on a stale activation",
						toolCount: 12,
					},
				],
			]),
		});

		const text = stripAnsi(new WorkflowGraphComponent(view, { refreshMs: 0 }).render(132).join("\n"));

		expect(text).toContain("Run: attempt-closed completed");
		expect(text).not.toContain("40h");
		expect(text).not.toContain("still working on a stale activation");
		expect(text).not.toContain("12 tools");
		expect(text).not.toContain("Build live");
		expect(text).not.toContain("Build running");
		expect(text).not.toContain("Agent Hub");
		expect(text).not.toContain("/workflow interrupt");
	});

	it("labels running non-agent work without implying an Agent Hub target", async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("dark theme fixture is required");
		setThemeInstance(theme);
		const view = singleNodeView("running");
		view.focus = {
			nodeId: "build",
			label: "Build",
			role: "Program",
			status: "running",
			summary: "waiting for long-running floor",
		};

		const text = stripAnsi(new WorkflowGraphComponent(view, { refreshMs: 0 }).render(120).join("\n"));

		expect(text).toContain("On-flight: live work");
		expect(text).not.toContain("On-flight: live agents");
		expect(text).toContain("Build running");
		expect(text).not.toContain("◆ hub");
		expect(text).not.toContain("↵ steer");
	});

	it("renders the live TUI graph as a resident workflow dashboard before the diagram", async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("dark theme fixture is required");
		setThemeInstance(theme);
		const view = createView({
			name: "cockpit-topology-tui",
			version: 1,
			models: { roles: {}, defaults: {} },
			nodes: [
				{ id: "buildRound", type: "agent", agent: "task" },
				{ id: "reviewRound", type: "review", agent: "task" },
				{ id: "ship", type: "script" },
			],
			edges: [
				{ from: "buildRound", to: "reviewRound" },
				{
					from: "reviewRound",
					to: "buildRound",
					condition: { source: 'outputs.reviewRound.verdict == "CONTINUE"' },
				},
				{ from: "reviewRound", to: "ship", condition: { source: 'outputs.reviewRound.verdict != "CONTINUE"' } },
			],
		});
		view.activeAgents = [
			{
				activationId: "activation-review",
				focusAgentId: "reviewRound",
				nodeId: "reviewRound",
				label: "Review round",
				role: "Reviewer",
				status: "running",
				activity: "checking the build loop exit criteria",
			},
		];
		const component = new WorkflowGraphComponent(view, { refreshMs: 0 });

		const text = stripAnsi(component.render(120).join("\n"));

		expect(text).toContain("Workflow Dashboard");
		expect(text).toContain("╭─ Flow Lens");
		expect(text).toContain("╭─ Live Workbench");
		expect(text).toContain("Flow Lens");
		expect(text).toContain("Live Workbench");
		expect(text).toContain("Flow: branch points 1 / loops 1 · 3 nodes");
		expect(text).toContain("Focus: live Reviewer · Review round");
		expect(text).toContain("On-flight:");
		expect(text).toContain("Agent Hub");
		expect(text).toContain("● Reviewer · Review round live");
		expect(text.indexOf("Flow: branch points 1 / loops 1")).toBeLessThan(text.indexOf("diagram"));
		expect(text.indexOf("On-flight:")).toBeLessThan(text.indexOf("diagram"));
		expect(text).not.toContain(" cockpit ");
		expect(text).not.toContain("agent:task");
		expect(text).not.toContain("activation-review");
	});

	it("renders a width-aware directed flow map before the boxed diagram", async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("dark theme fixture is required");
		setThemeInstance(theme);
		const view = createView({
			name: "wide-flow-map",
			version: 1,
			models: { roles: {}, defaults: {} },
			nodes: [
				{ id: "plan", type: "agent" },
				{ id: "inspect", type: "script" },
				{ id: "build", type: "agent" },
				{ id: "review", type: "review" },
				{ id: "fix", type: "agent" },
				{ id: "verify", type: "script" },
				{ id: "ship", type: "script" },
			],
			edges: [
				{ from: "plan", to: "inspect" },
				{ from: "inspect", to: "build" },
				{ from: "build", to: "review" },
				{ from: "review", to: "fix", condition: { source: 'outputs.review.verdict == "CONTINUE"' } },
				{ from: "review", to: "verify", condition: { source: 'outputs.review.verdict != "CONTINUE"' } },
				{ from: "fix", to: "verify" },
				{ from: "verify", to: "ship" },
			],
		});
		view.nodes[2] = { ...view.nodes[2]!, status: "running", focused: true, activationCount: 4 };
		view.focus = {
			nodeId: "build",
			label: "Build",
			role: "Builder",
			status: "running",
			focusAgentId: "build-4",
			generation: 4,
		};
		const component = new WorkflowGraphComponent(view, { refreshMs: 0 });

		const rendered = component.render(156);
		const text = stripAnsi(rendered.join("\n"));
		const mapLine = text.split("\n").find(line => line.includes("[● build ×4]"));

		expect(text).toContain("Flow Lens");
		expect(mapLine).toBeDefined();
		expect(mapLine).toContain("plan");
		expect(mapLine).toContain("inspect");
		expect(mapLine).toContain("─▶");
		expect(mapLine).not.toContain("->");
		expect(visibleWidth(mapLine!)).toBeLessThanOrEqual(156);
		expect(text.indexOf("Flow Lens")).toBeLessThan(text.indexOf("diagram"));
	});

	it("renders a wide workflow dashboard with a live workbench pane", async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("dark theme fixture is required");
		setThemeInstance(theme);
		const view = createView({
			name: "wide-inspector-dashboard",
			version: 1,
			models: { roles: {}, defaults: {} },
			nodes: [
				{ id: "plan", type: "agent" },
				{ id: "build", type: "agent", agent: "task" },
				{ id: "review", type: "review", agent: "task" },
				{ id: "ship", type: "script" },
			],
			edges: [
				{ from: "plan", to: "build" },
				{ from: "build", to: "review" },
				{ from: "review", to: "build", condition: { source: 'outputs.review.verdict == "CONTINUE"' } },
				{ from: "review", to: "ship", condition: { source: 'outputs.review.verdict == "COMPLETE"' } },
			],
		});
		view.nodes[1] = { ...view.nodes[1]!, status: "running", focused: true, activationCount: 3 };
		view.focus = {
			nodeId: "build",
			label: "Build",
			role: "Builder",
			status: "running",
			focusAgentId: "build-3",
			generation: 3,
			activity: "tightening dashboard spacing after visual review",
			stats: "6m12s · 8 tools",
			recentOutput: ["patched parser", "rerunning tests"],
			controls: ["Watch: Agent Hub build-3", "Interrupt: /workflow interrupt attempt-1 build-3 --deadline-ms 30000"],
		};
		view.activeAgents = [
			{
				activationId: "activation-build",
				focusAgentId: "build-3",
				nodeId: "build",
				label: "Build",
				role: "Builder",
				status: "running",
				generation: 3,
				activity: "tightening dashboard spacing after visual review",
				stats: "6m12s · 8 tools",
				recentOutput: ["patched parser", "rerunning tests"],
			},
		];
		view.actions = [
			"Refresh: /workflow graph --family-id wide-inspector-dashboard",
			"Stop attempt: /workflow stop attempt-1 --deadline-ms 30000",
			"Interrupt Builder · Build: /workflow interrupt attempt-1 build-3 --deadline-ms 30000",
		];
		const component = new WorkflowGraphComponent(view, { refreshMs: 0 });

		const lines = component.render(180);
		const text = stripAnsi(lines.join("\n"));

		expect(text).toContain("Workflow Dashboard");
		expect(text).toContain("Progress:");
		expect(text).toContain("Flow Lens");
		expect(text).toContain("Live Workbench");
		expect(text).toContain("╭─ Flow Lens");
		expect(text).toContain("╭─ Live Workbench");
		expect(text).toContain("Path");
		expect(text).toContain("Focus");
		expect(text).toContain("On-flight");
		expect(text).toContain("Recent output");
		expect(text).toContain("Controls");
		expect(text).toContain("tightening dashboard spacing after visual review");
		expect(text).not.toContain("watch: Agent Hub build-3");
		expect(text).not.toContain("interrupt: selected live agent");
		expect(text).not.toContain(" focused node ");
		expect(text).not.toContain(" on-flight ");
		expect(text).not.toContain("--deadline-ms");
		expect(lines.map(line => visibleWidth(stripAnsi(line))).every(width => width <= 180)).toBeTrue();

		const ultrawideText = stripAnsi(component.render(240).join("\n"));
		expect(ultrawideText).toContain(
			"Builder: Build live · round 3 · 6m12s · tightening dashboard spacing after visual review",
		);
	});

	it("renders active workflow agents as switchable transcript monitor tabs before on-flight details", async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("dark theme fixture is required");
		setThemeInstance(theme);
		const view = createView({
			name: "parallel-agent-tabs",
			version: 1,
			models: { roles: {}, defaults: {} },
			nodes: [
				{ id: "plan", type: "script" },
				{ id: "buildUi", type: "agent", agent: "task" },
				{ id: "buildApi", type: "agent", agent: "task" },
				{ id: "review", type: "review", waitFor: ["buildUi", "buildApi"] },
			],
			edges: [
				{ from: "plan", to: "buildUi" },
				{ from: "plan", to: "buildApi" },
				{ from: "buildUi", to: "review" },
				{ from: "buildApi", to: "review" },
			],
		});
		view.nodes[1] = { ...view.nodes[1]!, status: "running", focused: true, activationCount: 1 };
		view.nodes[2] = { ...view.nodes[2]!, status: "running", focused: true, activationCount: 1 };
		view.focus = {
			nodeId: "buildUi",
			label: "Build ui",
			role: "Builder",
			status: "running",
			focusAgentId: "buildUi",
			stats: "1m04s · 3 tools",
			activity: "patching the dashboard",
		};
		view.activeAgents = [
			{
				activationId: "activation-ui",
				focusAgentId: "buildUi",
				nodeId: "buildUi",
				label: "Build ui",
				role: "Builder",
				status: "running",
				stats: "1m04s · 3 tools",
				activity: "patching the dashboard",
			},
			{
				activationId: "activation-api",
				focusAgentId: "buildApi",
				nodeId: "buildApi",
				label: "Build api",
				role: "Builder",
				status: "running",
				stats: "42s · 2 tools",
				activity: "checking workflow bindings",
			},
		];
		view.actions = [
			"Refresh: /workflow graph --family-id parallel-agent-tabs",
			"Stop attempt: /workflow stop attempt-1 --deadline-ms 30000",
			"Interrupt Builder · Build ui: /workflow interrupt attempt-1 buildUi --deadline-ms 30000",
			"Open Agent Hub: double-left or observe key; watch/intervene buildUi",
		];
		const component = new WorkflowGraphComponent(view, { refreshMs: 0 });

		const text = stripAnsi(component.render(180).join("\n"));

		expect(text).toContain("Operator rail");
		expect(text).toContain("◉ monitor buildUi");
		expect(text).toContain("hub ←←/observe");
		expect(text).toContain("↵ steer");
		expect(text).toContain("! interrupt");
		expect(text).toContain("■ stop");
		expect(text.indexOf("Operator rail")).toBeLessThan(text.indexOf("Focus: selected node"));
		expect(text).toContain("Agent tabs: transcript monitors");
		expect(text).toContain("[1] ● buildUi · 1m04s");
		expect(text).toContain("[2] ○ buildApi · 42s");
		expect(text).toContain("switch: Agent Hub tab/arrow keys");
		expect(text).toContain("live lanes · agent progress");
		expect(text).toContain("buildApi");
		expect(text).toContain("checking workflow bindings");
		expect(text).toContain("Builder: Build ui live · 1m04s");
		expect(text).toContain("activity: patching the dashboard");
		expect(text).toContain("! Interrupt Builder · Build ui");
		expect(text.indexOf("Controls: operator actions")).toBeLessThan(text.indexOf("On-flight: live agents"));
		expect(text).not.toContain("--deadline-ms");
	});

	it("uses wide terminal space for loop diagrams instead of pinning them to the left edge", () => {
		const view = createView({
			name: "anchored-loop-dashboard",
			version: 1,
			models: { roles: {}, defaults: {} },
			nodes: [
				{ id: "build", type: "agent" },
				{ id: "review", type: "review" },
			],
			edges: [
				{ from: "build", to: "review" },
				{ from: "review", to: "build", condition: { source: 'outputs.review.verdict == "CONTINUE"' } },
			],
		});

		const diagram = renderWorkflowGraphDiagram(view, { width: 160 });
		const buildLine = diagram.find(line => line.includes("build"));
		const reviewLine = diagram.find(line => line.includes("review"));
		const loopLabelLine = diagram.find(line => line.includes("↺ build"));
		const rendered = diagram.join("\n");

		expect(buildLine).toBeDefined();
		expect(reviewLine).toBeDefined();
		expect(loopLabelLine).toBeDefined();
		expect((buildLine ?? "").search(/\S/u)).toBeGreaterThan(24);
		expect((reviewLine ?? "").search(/\S/u)).toBeGreaterThan(24);
		expect(visibleWidth(loopLabelLine ?? "")).toBeGreaterThan(110);
		expect(rendered).toContain("▲");
		expect(diagram.every(line => visibleWidth(line) <= 160)).toBeTrue();
	});

	it("keeps diagram status color from leaking into node borders", async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("dark theme fixture is required");
		setThemeInstance(theme);
		const view = singleNodeView("running");
		view.nodes[0] = { ...view.nodes[0]!, activationCount: 2 };
		const component = new WorkflowGraphComponent(view, { refreshMs: 0 });

		const statusLine = component.render(100).find(line => stripAnsi(line).includes("║● build"));

		expect(statusLine).toBeDefined();
		expect(statusLine!).toMatch(/║\x1b\[39m(?:\x1b\[[0-9;]*m)*●/u);
		expect(statusLine!).not.toMatch(/\x1b\[[0-9;]*m║● build/u);
	});

	it("compacts the live TUI graph to the terminal height budget", async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("dark theme fixture is required");
		setThemeInstance(theme);
		const view = createView({
			name: "height-aware-cockpit",
			version: 1,
			models: { roles: {}, defaults: {} },
			nodes: [
				{ id: "plan", type: "agent" },
				{ id: "inspect", type: "script" },
				{ id: "build", type: "agent" },
				{ id: "summaryReview", type: "review" },
				{ id: "fixIssues", type: "agent" },
				{ id: "codeReview", type: "review" },
				{ id: "archive", type: "script" },
			],
			edges: [
				{ from: "plan", to: "inspect" },
				{ from: "inspect", to: "build" },
				{ from: "build", to: "summaryReview" },
				{
					from: "summaryReview",
					to: "fixIssues",
					condition: { source: 'outputs.summaryReview.verdict != "COMPLETE"' },
				},
				{
					from: "summaryReview",
					to: "codeReview",
					condition: { source: 'outputs.summaryReview.verdict == "COMPLETE"' },
				},
				{ from: "fixIssues", to: "codeReview" },
				{ from: "codeReview", to: "fixIssues", condition: { source: 'outputs.codeReview.verdict == "ISSUES"' } },
				{ from: "codeReview", to: "archive", condition: { source: 'outputs.codeReview.verdict != "ISSUES"' } },
			],
		});
		view.activeAgents = [
			{
				activationId: "activation-build",
				focusAgentId: "build-4",
				generation: 4,
				nodeId: "build",
				label: "Build",
				role: "Builder",
				status: "running",
				model: "gpt-5.5",
				tool: "bash bun test",
				stats: "9m12s · 12 tools · 41% ctx",
				activity: "tightening the retry loop after review feedback",
				recentOutput: ["patched graph view", "running focused tests"],
			},
		];
		view.focus = {
			nodeId: "build",
			label: "Build",
			role: "Builder",
			status: "running",
			focusAgentId: "build-4",
			generation: 4,
			model: "gpt-5.5",
			tool: "bash bun test",
			stats: "9m12s · 12 tools · 41% ctx",
			activity: "tightening the retry loop after review feedback",
			recentOutput: ["patched graph view", "running focused tests"],
			controls: [
				"Watch: Agent Hub build-4",
				"Interrupt: /workflow interrupt height-aware-cockpit:attempt-1 build-4 --deadline-ms 30000",
			],
		};
		view.actions = [
			"Refresh: /workflow graph --family-id height-aware-cockpit",
			"Stop attempt: /workflow stop height-aware-cockpit:attempt-1 --deadline-ms 30000",
			"Interrupt Builder · Build: /workflow interrupt height-aware-cockpit:attempt-1 build-4 --deadline-ms 30000",
			"Propose change: /workflow request-change <file> --family-id height-aware-cockpit",
		];
		const component = new WorkflowGraphComponent(view, { refreshMs: 0, heightProvider: () => 24 });

		const lines = component.render(96);
		const text = stripAnsi(lines.join("\n"));

		expect(lines.length).toBeLessThanOrEqual(24);
		expect(text).toContain("Workflow Dashboard");
		expect(text).toContain("Flow: branch points 2 / joins 2 / loops 1");
		expect(text).toContain("Focus");
		expect(text).toContain("On-flight");
		expect(text).toContain("diagram");
		expect(text).toContain("Controls");
		expect(text).toContain("◉ monitor build-4  hub ←←/observe  ↵ steer  ! interrupt  ■ stop  ± change");
		expect(text).toContain("diagram rows hidden");
		expect(text).toContain("9m12s");
		expect(text).toContain("Refresh");
		expect(text).not.toContain("gpt-5.5");
		expect(text).not.toContain("rust.cat/gpt-5.5");
		expect(text).not.toContain("bash");
		expect(text).not.toContain("ctx");
		expect(text).not.toContain("--deadline-ms");

		const mediumLines = new WorkflowGraphComponent(view, { refreshMs: 0, heightProvider: () => 40 }).render(96);
		const mediumText = stripAnsi(mediumLines.join("\n"));

		expect(mediumLines.length).toBeLessThanOrEqual(40);
		expect(mediumText).not.toContain("workflow graph rows hidden");
		expect(mediumText).toContain("diagram rows hidden");
		expect(mediumText).toContain("Flow Lens");
		expect(mediumText).toContain("[○ plan] ─▶ [○ inspect] ─▶ [○ build]");

		const wideLiveView = createView({
			name: "wide-height-rlcr",
			version: 1,
			models: { roles: {}, defaults: {} },
			nodes: [
				{ id: "planCompliancePrecheck", type: "review" },
				{ id: "planUnderstandingQuiz", type: "human" },
				{ id: "recordOperatorGate", type: "script" },
				{ id: "initializeGoalTracker", type: "script" },
				{ id: "implementRound", type: "agent", agent: "task" },
				{ id: "writeRoundSummary", type: "script" },
				{ id: "codexSummaryReview", type: "review", agent: "task" },
				{ id: "longRunningHold", type: "script" },
				{ id: "longRunningHoldCheck", type: "script" },
				{ id: "enterReviewPhase", type: "script" },
				{ id: "fixReviewIssues", type: "agent", agent: "task" },
				{ id: "codexCodeReview", type: "review", agent: "task" },
				{ id: "finalAlignmentCheck", type: "review" },
				{ id: "finalize", type: "script" },
			],
			edges: [
				{ from: "planCompliancePrecheck", to: "planUnderstandingQuiz" },
				{ from: "planUnderstandingQuiz", to: "recordOperatorGate" },
				{ from: "recordOperatorGate", to: "initializeGoalTracker" },
				{ from: "initializeGoalTracker", to: "implementRound" },
				{ from: "implementRound", to: "writeRoundSummary" },
				{ from: "writeRoundSummary", to: "codexSummaryReview" },
				{
					from: "codexSummaryReview",
					to: "implementRound",
					condition: { source: 'outputs.codexSummaryReview.verdict == "CONTINUE"' },
				},
				{
					from: "codexSummaryReview",
					to: "longRunningHold",
					condition: { source: 'outputs.codexSummaryReview.verdict == "COMPLETE"' },
				},
				{ from: "longRunningHold", to: "longRunningHoldCheck" },
				{
					from: "longRunningHoldCheck",
					to: "longRunningHold",
					condition: { source: "state.longRunningFloorPending" },
				},
				{
					from: "longRunningHoldCheck",
					to: "enterReviewPhase",
					condition: { source: "state.longRunningFloorSatisfied" },
				},
				{ from: "enterReviewPhase", to: "fixReviewIssues" },
				{ from: "fixReviewIssues", to: "codexCodeReview" },
				{
					from: "codexCodeReview",
					to: "fixReviewIssues",
					condition: { source: 'outputs.codexCodeReview.verdict == "ISSUES"' },
				},
				{
					from: "codexCodeReview",
					to: "finalAlignmentCheck",
					condition: { source: 'outputs.codexCodeReview.verdict != "ISSUES"' },
				},
				{ from: "finalAlignmentCheck", to: "finalize" },
			],
		});
		wideLiveView.nodes[4] = { ...wideLiveView.nodes[4]!, status: "running", focused: true, activationCount: 1 };
		wideLiveView.focus = {
			nodeId: "implementRound",
			label: "Implement round",
			role: "Builder",
			status: "running",
			focusAgentId: "implementRound",
		};
		wideLiveView.activeAgents = [
			{
				activationId: "activation-implement",
				focusAgentId: "implementRound",
				nodeId: "implementRound",
				label: "Implement round",
				role: "Builder",
				status: "running",
				activity: "Listing project",
			},
		];
		const wideLiveLines = new WorkflowGraphComponent(wideLiveView, { refreshMs: 0, heightProvider: () => 36 }).render(
			220,
		);
		const wideLiveText = stripAnsi(wideLiveLines.join("\n"));
		const visibleNodeRows = wideLiveText
			.split("\n")
			.filter(line =>
				/[│║][○●✓!◆×] (initializeGoalTracker|implementRound|writeRoundSummary|codexSummaryReview|longRunningHold)/u.test(
					line,
				),
			);

		expect(wideLiveLines.length).toBeGreaterThan(30);
		expect(wideLiveLines.length).toBeLessThanOrEqual(36);
		expect(wideLiveText).toContain("Flow Lens · Canvas");
		expect(wideLiveText).toContain("Live Workbench · Operator Deck");
		expect(wideLiveText).toContain("Recent output");
		expect(visibleNodeRows.length).toBeGreaterThanOrEqual(3);
		expect(wideLiveText).not.toContain("workflow graph rows hidden");
		expect(wideLiveText).not.toContain("overview hidden");
		expect(wideLiveText).not.toContain("state.");

		const tallLines = new WorkflowGraphComponent(view, { refreshMs: 0, heightProvider: () => 48 }).render(156);
		const tallText = stripAnsi(tallLines.join("\n"));

		expect(tallLines.length).toBeGreaterThan(42);
		expect(tallLines.length).toBeLessThanOrEqual(48);
		expect(tallText).toContain("Loops:");
		expect(tallText).toContain("Branches:");
		expect(tallText).not.toContain("workflow graph rows hidden");

		const tinyLines = new WorkflowGraphComponent(view, { refreshMs: 0, heightProvider: () => 10 }).render(96);
		const tinyText = stripAnsi(tinyLines.join("\n"));

		expect(tinyLines.length).toBeLessThanOrEqual(10);
		expect(tinyText).toContain("Workflow Dashboard");
		expect(tinyText).toContain("Flow: branch points 2 / joins 2 / loops 1");
		expect(tinyText).toContain("diagram");
		expect(tinyText).not.toContain("workflow graph rows hidden");

		const microLines = new WorkflowGraphComponent(view, { refreshMs: 0, heightProvider: () => 6 }).render(96);
		const microTextLines = microLines.map(line => stripAnsi(line));
		const graphRowsMarker = microTextLines.find(line => line.includes("dashboard rows hidden"));

		expect(graphRowsMarker).toBeDefined();
		expect(graphRowsMarker?.startsWith("├─ ")).toBeTrue();
		expect(graphRowsMarker?.endsWith("┤")).toBeTrue();
		expect(visibleWidth(graphRowsMarker ?? "")).toBe(96);

		const narrowLines = new WorkflowGraphComponent(view, { refreshMs: 0, heightProvider: () => 30 }).render(96);
		const narrowTextLines = narrowLines.map(line => stripAnsi(line));
		const hiddenMarkerIndex = narrowTextLines.findIndex(line => line.includes("diagram rows hidden"));
		const beforeHiddenMarker = narrowTextLines[hiddenMarkerIndex - 1] ?? "";

		expect(narrowLines.length).toBeLessThanOrEqual(30);
		expect(hiddenMarkerIndex).toBeGreaterThan(-1);
		expect(beforeHiddenMarker).not.toMatch(/[┌║]/u);
		expect(beforeHiddenMarker).not.toContain("runs ");
	});

	it("renders selected workflow routes in the live TUI graph component", async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("dark theme fixture is required");
		setThemeInstance(theme);
		const view = singleNodeView("completed");
		view.selectedRoutes = [
			{
				from: "reviewJsonSummary",
				to: "retryBranch",
				condition: 'outputs.reviewJsonSummary.verdict == "CONTINUE"',
			},
		];
		const component = new WorkflowGraphComponent(view, { refreshMs: 0 });

		const text = stripAnsi(component.render(120).join("\n"));

		expect(text).toContain("routes");
		expect(text).toContain("reviewJsonSummary chose retryBranch when review json summary verdict is CONTINUE");
		expect(text).not.toContain("outputs.reviewJsonSummary.verdict");
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

	it("records workflow monitor health fields for read-only run supervision", async () => {
		const root = path.resolve("temp", "workflow-monitor-history", String(Bun.nanoseconds()));
		try {
			const view = singleNodeView("running");
			view.nodes[0]!.status = "running";
			view.actions = ["Stop attempt: /workflow stop attempt-live --deadline-ms 30000"];
			const snapshotPath = await writeWorkflowGraphMonitorSnapshot(view, {
				agentDir: path.join(root, "agent"),
				now: new Date("2026-01-02T03:04:05.006Z"),
			});

			const snapshot = await Bun.file(snapshotPath).json();
			expect(snapshot.health).toEqual({
				persistedStatus: "running",
				processLive: false,
				detached: true,
				runningNodeIds: ["build"],
				runningAgentActivationIds: [],
				latestCheckpointId: null,
			});
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
	it("exposes mapped lanes for pool nodes", () => {
		const definition = parseWorkflowDefinition(
			`
name: mapped-pool-graph
version: 1
nodes:
  pool:
    type: mapped_pool
    mappedPool:
      itemSource: /queue
      itemKey: /id
      maxConcurrency: 5
      maxItems: 10
      worker: pool.worker
      verifier: pool.verifier
      reducer: pool.reducer
  pool.worker:
    type: agent
    agent: task
  pool.verifier:
    type: review
  pool.reducer:
    type: script
edges: []
`,
			{ sourcePath: "mapped.yml" },
		);
		const family = createFamily(definition);
		family.attempts[0]!.activations = [
			{
				id: "activation-1",
				nodeId: "pool",
				parentActivationIds: [],
				status: "completed",
			},
			{
				id: "activation-2",
				nodeId: "pool.worker",
				parentActivationIds: ["activation-1"],
				status: "completed",
				mapped: {
					poolId: "pool",
					poolActivationId: "activation-1",
					itemKey: "a",
					item: { id: "a" },
					phase: "worker",
				},
			},
			{
				id: "activation-3",
				nodeId: "pool.verifier",
				parentActivationIds: ["activation-1"],
				status: "completed",
				mapped: {
					poolId: "pool",
					poolActivationId: "activation-1",
					itemKey: "a",
					item: { id: "a" },
					phase: "verifier",
					workerActivationId: "activation-2",
				},
			},
			{
				id: "activation-4",
				nodeId: "pool.reducer",
				parentActivationIds: ["activation-1"],
				status: "completed",
				mapped: {
					poolId: "pool",
					poolActivationId: "activation-1",
					itemKey: "a",
					item: { id: "a" },
					phase: "reducer",
					workerActivationId: "activation-2",
					verifierActivationId: "activation-3",
				},
			},
			{
				id: "activation-5",
				nodeId: "pool.worker",
				parentActivationIds: ["activation-1"],
				status: "running",
				mapped: {
					poolId: "pool",
					poolActivationId: "activation-1",
					itemKey: "b/c",
					item: { id: "b/c" },
					phase: "worker",
				},
			},
		];
		const view = buildWorkflowGraphView(family);
		const poolNode = view.nodes.find(n => n.id === "pool");
		expect(poolNode?.mappedLanes).toContain("worker:a");
		expect(poolNode?.mappedLanes).toContain("verifier:a");
		expect(poolNode?.mappedLanes).toContain("reducer:a");
		expect(poolNode?.mappedLanes).toContain("worker:b/c");
	});
});

function expectConnectorsUseOneBoxDrawingBaseline(diagram: string[]): void {
	const connectorChars = new Set(["│", "─", "┌", "┐", "└", "┘", "┬", "┴", "┼", "├", "┤", "╤", "╧", "▼", " "]);
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
		topology: { parallelFanOuts: 0, branchPoints: 0, joins: 0, loops: 0, subflows: 0 },
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
