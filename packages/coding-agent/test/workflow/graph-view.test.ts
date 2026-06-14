import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type NativeScrollbackLiveRegion, visibleWidth } from "@oh-my-pi/pi-tui";
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
		expect(diagram).toContain("review back to build when verdict is retry");
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

		const text = renderWorkflowGraphText(view);

		expect(text).toContain(
			"- Builder · Build round live · rust.cat/gpt-5.5 · tool bash bun test · 1m05s · 4 tools - tightening the recursive runner validation",
		);
		expect(text).toContain("Recent output:");
		expect(text).toContain("- Builder · Build round stdout: Running bun test");
		expect(text).toContain("- Builder · Build round stdout: Fixed loop termination case");
		expect(text).not.toContain("activation-build");
		expect(text).not.toContain("agent:task");
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

		expect(diagram).toContain("edge review to ship when verdict is finish");
		expect(diagram).toContain("review back to build when verdict is retry");
		expect(diagram).not.toContain('state.verdict == "finish"');
		expect(diagram).not.toContain('state.verdict == "retry"');
		expect(diagram).not.toMatch(/[-─]+[>→▶]|[<←◀][-─]+|->|=>|→|↺/u);
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

		const diagram = renderWorkflowGraphDiagram(view, { width: 96 }).join("\n");

		expect(diagram).toContain(
			"reviewInvestigation back to writeInvestigation when review investigation verdict is CONTINUE",
		);
		expect(diagram).toContain(
			"edge reviewInvestigation to archiveInvestigation when review investigation verdict is not CONTINUE",
		);
		expect(diagram).not.toContain("outputs.reviewInvestigation.verdict");
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
		expect(text).not.toMatch(/[-─]+[>→▶]|[<←◀][-─]+|->|=>|→{1,}|←{1,}/u);
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

		expect(text).toContain("on-flight");
		expect(text).toContain(
			"Agent Hub: double-left or observe to watch; Enter steers the selected agent; Esc returns.",
		);
		expect(text).toContain("● Builder · Build round live · round 3 - editing implementation");
		expect(text).toContain("watch/intervene buildRound");
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

	it("renders the live TUI graph as an operator cockpit before the diagram", async () => {
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

		expect(text).toContain("Flow: branch points 1 / loops 1 · 3 nodes");
		expect(text).toContain("Focus: live Reviewer · Review round");
		expect(text).toContain(
			"Agent Hub: double-left or observe to watch; Enter steers the selected agent; Esc returns.",
		);
		expect(text).toContain(" on-flight ");
		expect(text).toContain("● Reviewer · Review round live");
		expect(text.indexOf("Flow: branch points 1 / loops 1")).toBeLessThan(text.indexOf("diagram"));
		expect(text.indexOf(" on-flight ")).toBeLessThan(text.indexOf("diagram"));
		expect(text).not.toContain(" cockpit ");
		expect(text).not.toContain("agent:task");
		expect(text).not.toContain("activation-review");
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
