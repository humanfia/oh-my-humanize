import { beforeAll, describe, expect, it } from "bun:test";
import type { WorkflowGraphView } from "../../workflow/graph-view";
import { initTheme } from "../theme/theme";
import { WorkflowGraphComponent } from "./workflow-graph";

const stripAnsi = (value: string): string => value.replace(/\u001b\[[0-9;]*m/g, "");

describe("WorkflowGraphComponent display modes", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("collapses the resident dashboard to restorable status and guide rows", () => {
		const component = new WorkflowGraphComponent(workflowGraphViewFixture(), {
			displayModeProvider: () => "collapsed",
		});

		const lines = component.render(120).map(stripAnsi);
		const text = lines.join("\n");

		expect(lines.length).toBeLessThanOrEqual(4);
		expect(text).toContain("Workflow attempt-1 running");
		expect(text).toContain("9/11 done");
		expect(text).toContain("/workflow help");
		expect(text).toContain("/workflow help agents");
		expect(text).toContain("/workflow dashboard show");
		expect(text).toContain("/workflow interrupt");
		expect(text).not.toContain("Workflow Dashboard");
	});

	it("prioritizes focused node interruption in narrow collapsed mode", () => {
		const component = new WorkflowGraphComponent(workflowGraphViewFixture(), {
			displayModeProvider: () => "collapsed",
		});

		const line = component.render(80).map(stripAnsi).join("\n");

		expect(line).toContain("/workflow help");
		expect(line).toContain("/workflow help agents");
		expect(line).toContain("/workflow dashboard show");
		expect(line).toContain("/workflow interrupt");
		expect(line).not.toContain("/workflow stop");
	});

	it("forces compact mode to keep the monitor materially shorter than full mode", () => {
		const full = new WorkflowGraphComponent(workflowGraphViewFixture(), {
			displayModeProvider: () => "full",
		})
			.render(140)
			.map(stripAnsi);
		const compact = new WorkflowGraphComponent(workflowGraphViewFixture(), {
			displayModeProvider: () => "compact",
		})
			.render(140)
			.map(stripAnsi);

		expect(compact.length).toBeLessThan(full.length);
		expect(compact.join("\n")).toContain("/workflow dashboard show");
		expect(compact.join("\n")).toContain("/workflow dashboard collapse");
		expect(compact.join("\n")).toContain("/workflow help");
		expect(compact.join("\n")).toContain("/workflow help agents");
	});

	it("keeps operator actions visible in very short compact mode", () => {
		const compact = new WorkflowGraphComponent(workflowGraphViewFixture(), {
			displayModeProvider: () => "compact",
			heightProvider: () => 10,
		})
			.render(100)
			.map(stripAnsi)
			.join("\n");

		expect(compact).toContain("/workflow dashboard show");
		expect(compact).toContain("/workflow dashboard collapse");
		expect(compact).toContain("/workflow interrupt");
	});

	it("makes workflow node and transcript navigation discoverable", () => {
		const text = new WorkflowGraphComponent(workflowGraphNavigationViewFixture(), {
			displayModeProvider: () => "full",
		})
			.render(140)
			.map(stripAnsi)
			.join("\n");

		expect(text).toContain("Tab/Shift-Tab nodes");
		expect(text).toContain("[/] activations");
		expect(text).toContain("h help");
		expect(text).toContain("Agent Hub transcript");
		expect(text).toContain("Focus: selected node");
	});

	it("does not count skipped conditional branch nodes against completed workflow progress", () => {
		const text = new WorkflowGraphComponent(completedConditionalBranchViewFixture(), {
			displayModeProvider: () => "full",
		})
			.render(140)
			.map(stripAnsi)
			.join("\n");

		expect(text).toContain("7/7 done");
		expect(text).toContain("1 skipped");
		expect(text).not.toContain("7/8 done");
	});

	it("summarizes skipped conditional branch nodes in collapsed completed workflows", () => {
		const text = new WorkflowGraphComponent(completedConditionalBranchViewFixture(), {
			displayModeProvider: () => "collapsed",
		})
			.render(120)
			.map(stripAnsi)
			.join("\n");

		expect(text).toContain("7/7 done");
		expect(text).toContain("1 skipped");
		expect(text).not.toContain("7/8 done");
	});

	it("keeps completed workflow summaries visible in collapsed mode", () => {
		const text = new WorkflowGraphComponent(completedConditionalBranchViewFixture(), {
			displayModeProvider: () => "collapsed",
		})
			.render(140)
			.map(stripAnsi)
			.join("\n");

		expect(text).toContain("Idea draft saved to /tmp/idea.md");
	});

	it("switches selected workflow nodes and activation summaries from keyboard input", () => {
		const component = new WorkflowGraphComponent(workflowGraphNavigationViewFixture(), {
			displayModeProvider: () => "full",
		});

		expect(stripAnsi(component.render(220).join("\n"))).toContain("Planner: Plan completed");

		component.handleInput?.("\t");
		const buildText = stripAnsi(component.render(220).join("\n"));
		expect(buildText).toContain("Builder: Build round completed");
		expect(buildText).toContain("activation: 1/3");
		expect(buildText).toContain("summary: initial implementation compiled");

		component.handleInput?.("]");
		const secondActivationText = stripAnsi(component.render(220).join("\n"));
		expect(secondActivationText).toContain("activation: 2/3");
		expect(secondActivationText).toContain("summary: fixed reviewer blocking feedback");

		component.handleInput?.("\x1b[Z");
		expect(stripAnsi(component.render(220).join("\n"))).toContain("Planner: Plan completed");
	});

	it("colors arrows and occluded graph segments with distinct terminal styles", () => {
		const text = new WorkflowGraphComponent(workflowGraphOcclusionViewFixture(), {
			displayModeProvider: () => "full",
		})
			.render(160)
			.join("\n");

		const arrowColors = connectorColorCodes(text, "▼");
		const occludedColors = connectorColorCodes(text, "┄");

		expect(arrowColors.size).toBeGreaterThan(0);
		expect(occludedColors.size).toBeGreaterThan(0);
		expect([...arrowColors].some(color => !occludedColors.has(color))).toBe(true);
	});
});

function workflowGraphViewFixture(): WorkflowGraphView {
	return {
		familyId: "r4-palletsitsdang-perf-20d",
		latestFreezeId: "flowfreeze:test",
		currentAttempt: {
			id: "attempt-1",
			status: "running",
			runtimeBindingId: "binding-1",
		},
		changes: { approved: 0, proposed: 0, rejected: 0 },
		topology: {
			parallelFanOuts: 1,
			branchPoints: 2,
			joins: 3,
			loops: 2,
			subflows: 0,
		},
		focus: {
			nodeId: "longRunningHold",
			label: "Long running hold",
			role: "Program",
			status: "running",
			summary: "long-running floor pending",
		},
		nodes: [
			{ id: "precheckTaskContract", kind: "Verifier", status: "completed", activationCount: 1, focused: false },
			{ id: "captureBaseline", kind: "Program", status: "completed", activationCount: 1, focused: false },
			{ id: "planHypotheses", kind: "Planner", status: "completed", activationCount: 2, focused: false },
			{
				id: "tryAlgorithmicChange",
				kind: "Workflow agent",
				status: "completed",
				activationCount: 2,
				focused: false,
			},
			{ id: "tryCachingChange", kind: "Workflow agent", status: "completed", activationCount: 2, focused: false },
			{ id: "tryIOChange", kind: "Workflow agent", status: "completed", activationCount: 2, focused: false },
			{ id: "benchmarkCandidates", kind: "Program", status: "completed", activationCount: 2, focused: false },
			{ id: "perfReview", kind: "Reviewer", status: "completed", activationCount: 2, focused: false },
			{ id: "longRunningHold", kind: "Program", status: "running", activationCount: 305, focused: true },
			{ id: "longRunningHoldCheck", kind: "Verifier", status: "completed", activationCount: 304, focused: false },
			{ id: "archivePerformance", kind: "Evidence archive", status: "pending", activationCount: 0, focused: false },
		],
		edges: [
			{ from: "precheckTaskContract", to: "captureBaseline" },
			{ from: "captureBaseline", to: "planHypotheses" },
			{ from: "planHypotheses", to: "tryAlgorithmicChange" },
			{ from: "planHypotheses", to: "tryCachingChange" },
			{ from: "planHypotheses", to: "tryIOChange" },
			{ from: "tryAlgorithmicChange", to: "benchmarkCandidates" },
			{ from: "tryCachingChange", to: "benchmarkCandidates" },
			{ from: "tryIOChange", to: "benchmarkCandidates" },
			{ from: "benchmarkCandidates", to: "perfReview" },
			{ from: "perfReview", to: "planHypotheses", condition: "continue" },
			{ from: "perfReview", to: "longRunningHold", condition: "not continue" },
			{ from: "longRunningHold", to: "longRunningHoldCheck" },
			{ from: "longRunningHoldCheck", to: "longRunningHold", condition: "runtime long running minimum pending" },
			{
				from: "longRunningHoldCheck",
				to: "archivePerformance",
				condition: "runtime long running minimum satisfied",
			},
		],
		selectedRoutes: [
			{ from: "perfReview", to: "longRunningHold", condition: "not continue" },
			{ from: "longRunningHoldCheck", to: "longRunningHold", condition: "runtime long running minimum pending" },
		],
		lineage: [],
		actions: [
			"Refresh",
			"Interrupt Program · Long running hold: /workflow interrupt attempt-1 longRunningHold --deadline-ms 30000",
			"Stop attempt · /workflow stop attempt-1 --deadline-ms 30000",
			"Propose change · /workflow request-change <file> --family-id r4-palletsitsdang-perf-20d",
		],
	};
}

function workflowGraphOcclusionViewFixture(): WorkflowGraphView {
	return {
		familyId: "visual-routing-check",
		latestFreezeId: "flowfreeze:test",
		currentAttempt: {
			id: "attempt-1",
			status: "running",
			runtimeBindingId: "binding-1",
		},
		changes: { approved: 1, proposed: 0, rejected: 0 },
		topology: {
			parallelFanOuts: 1,
			branchPoints: 1,
			joins: 1,
			loops: 1,
			subflows: 0,
		},
		focus: {
			nodeId: "left",
			label: "Left branch",
			role: "Builder",
			status: "running",
			activity: "Checking graph routing visibility",
			stats: "2m14s",
		},
		nodes: [
			{ id: "start", kind: "Program", status: "completed", activationCount: 1, focused: false },
			{ id: "left", kind: "Agent", status: "running", activationCount: 2, focused: true },
			{ id: "right", kind: "Agent", status: "pending", activationCount: 0, focused: false },
			{ id: "review", kind: "Reviewer", status: "pending", activationCount: 0, focused: false },
		],
		edges: [
			{ from: "start", to: "left" },
			{ from: "start", to: "right" },
			{ from: "left", to: "review" },
			{ from: "right", to: "review" },
			{ from: "review", to: "left", condition: "state.retry == true" },
		],
		selectedRoutes: [{ from: "review", to: "left", condition: "state.retry == true" }],
		activeAgents: [
			{
				activationId: "activation-left-2",
				focusAgentId: "left-2",
				nodeId: "left",
				label: "Left branch",
				role: "Builder",
				status: "running",
				activity: "Checking graph routing visibility",
				stats: "2m14s",
			},
		],
		lineage: [],
		actions: [
			"Refresh",
			"Interrupt Builder · Left branch: /workflow interrupt attempt-1 left --deadline-ms 30000",
			"Stop attempt · /workflow stop attempt-1 --deadline-ms 30000",
		],
	};
}

function completedConditionalBranchViewFixture(): WorkflowGraphView {
	return {
		familyId: "rich-test-generation",
		currentAttempt: {
			id: "attempt-1",
			status: "completed",
			runtimeBindingId: "binding-1",
			summary: "Idea draft saved to /tmp/idea.md.",
		},
		changes: { approved: 0, proposed: 0, rejected: 0 },
		topology: {
			parallelFanOuts: 0,
			branchPoints: 1,
			joins: 1,
			loops: 1,
			subflows: 0,
		},
		focus: {
			nodeId: "archiveTests",
			label: "Archive tests",
			role: "Evidence archive",
			status: "completed",
			summary: "archived test hardening evidence",
		},
		nodes: [
			{ id: "precheckTaskContract", kind: "Verifier", status: "completed", activationCount: 1, focused: false },
			{ id: "inspectCoverage", kind: "Workflow agent", status: "completed", activationCount: 1, focused: false },
			{ id: "materializeGapReport", kind: "Program", status: "completed", activationCount: 1, focused: false },
			{ id: "generateTests", kind: "Workflow agent", status: "completed", activationCount: 1, focused: false },
			{ id: "repairTests", kind: "Workflow agent", status: "pending", activationCount: 0, focused: false },
			{ id: "runTestSuite", kind: "Verifier", status: "completed", activationCount: 1, focused: false },
			{ id: "testReview", kind: "Validation review", status: "completed", activationCount: 1, focused: false },
			{ id: "archiveTests", kind: "Evidence archive", status: "completed", activationCount: 1, focused: true },
		],
		edges: [
			{ from: "precheckTaskContract", to: "inspectCoverage" },
			{ from: "inspectCoverage", to: "materializeGapReport" },
			{ from: "materializeGapReport", to: "generateTests" },
			{ from: "generateTests", to: "runTestSuite" },
			{ from: "repairTests", to: "runTestSuite" },
			{ from: "runTestSuite", to: "testReview" },
			{ from: "testReview", to: "repairTests", condition: "review requests test changes" },
			{ from: "testReview", to: "archiveTests", condition: "review accepted tests" },
		],
		selectedRoutes: [{ from: "testReview", to: "archiveTests", condition: "review accepted tests" }],
		lineage: [],
		actions: [
			"Refresh: /workflow graph --family-id rich-test-generation",
			"Propose change: /workflow request-change <file> --family-id rich-test-generation",
		],
	};
}

function workflowGraphNavigationViewFixture(): WorkflowGraphView {
	return {
		familyId: "keyboard-navigation-check",
		latestFreezeId: "flowfreeze:navigation",
		currentAttempt: {
			id: "attempt-1",
			status: "running",
			runtimeBindingId: "binding-1",
		},
		changes: { approved: 0, proposed: 0, rejected: 0 },
		topology: {
			parallelFanOuts: 0,
			branchPoints: 1,
			joins: 0,
			loops: 1,
			subflows: 0,
		},
		focus: {
			nodeId: "plan",
			label: "Plan",
			role: "Planner",
			status: "completed",
			summary: "plan completed",
		},
		nodes: [
			{
				id: "plan",
				kind: "Planner",
				status: "completed",
				activationCount: 1,
				focused: true,
				activations: [
					{
						id: "activation-plan-1",
						ordinal: 1,
						status: "completed",
						summary: "plan completed",
					},
				],
			},
			{
				id: "buildRound",
				kind: "Builder",
				status: "completed",
				activationCount: 3,
				focused: false,
				activations: [
					{
						id: "activation-build-1",
						ordinal: 1,
						status: "completed",
						summary: "initial implementation compiled",
					},
					{
						id: "activation-build-2",
						ordinal: 2,
						status: "completed",
						summary: "fixed reviewer blocking feedback",
					},
					{
						id: "activation-build-3",
						ordinal: 3,
						status: "completed",
						summary: "final validation passed",
					},
				],
			},
			{
				id: "reviewRound",
				kind: "Reviewer",
				status: "running",
				activationCount: 1,
				focused: false,
				activations: [
					{
						id: "activation-review-1",
						ordinal: 1,
						status: "running",
						focusAgentId: "reviewRound",
						activity: "checking the final diff",
					},
				],
			},
		],
		edges: [
			{ from: "plan", to: "buildRound" },
			{ from: "buildRound", to: "reviewRound" },
			{ from: "reviewRound", to: "buildRound", condition: "issues" },
		],
		activeAgents: [
			{
				activationId: "activation-review-1",
				focusAgentId: "reviewRound",
				nodeId: "reviewRound",
				label: "Review round",
				role: "Reviewer",
				status: "running",
				activity: "checking the final diff",
			},
		],
		lineage: [],
		actions: [
			"Refresh: /workflow graph --family-id keyboard-navigation-check",
			"Interrupt Reviewer · Review round: /workflow interrupt attempt-1 reviewRound --deadline-ms 30000",
			"Stop attempt: /workflow stop attempt-1 --deadline-ms 30000",
			"Open Agent Hub: double-left or observe key; watch/intervene reviewRound",
			"Focused prompt: Agent Hub Enter attaches to the selected agent; Esc returns to workflow control",
		],
	};
}

function connectorColorCodes(text: string, glyph: string): Set<string> {
	const escaped = glyph.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
	const pattern = new RegExp(`(\\u001b\\[[0-9;]*m)${escaped}`, "gu");
	return new Set([...text.matchAll(pattern)].map(match => match[1] ?? ""));
}
