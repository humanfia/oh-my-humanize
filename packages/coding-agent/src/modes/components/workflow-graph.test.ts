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
