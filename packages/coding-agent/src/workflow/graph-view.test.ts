import { describe, expect, it } from "bun:test";
import type { WorkflowDefinition } from "./definition";
import type { FlowFreeze } from "./freeze";
import {
	buildWorkflowGraphView,
	renderWorkflowGraphDiagram,
	renderWorkflowGraphText,
	selectWorkflowGraphViewNode,
	type WorkflowGraphView,
} from "./graph-view";
import type { RuntimeBindingSnapshot, WorkflowRunFamilySnapshot } from "./lifecycle";

describe("buildWorkflowGraphView", () => {
	it("exposes interrupt guidance for a focused running program node", () => {
		const view = buildWorkflowGraphView(workflowFamilyWithRunningProgram());

		expect(view.focus?.nodeId).toBe("longRunningHold");
		expect(view.focus?.controls?.join("\n")).toContain(
			"/workflow interrupt attempt-1 longRunningHold --deadline-ms 30000",
		);
		expect(view.actions.join("\n")).toContain(
			"Interrupt Program · Long running hold: /workflow interrupt attempt-1 longRunningHold --deadline-ms 30000",
		);
	});

	it("does not render stale running activations as live work after an attempt is terminal", () => {
		const family = workflowFamilyWithRunningProgram();
		family.attempts[0]!.status = "completed";
		const view = buildWorkflowGraphView(family, { liveAttemptIds: new Set() });

		expect(view.currentAttempt?.status).toBe("completed");
		expect(view.focus).toBeUndefined();
		expect(view.activeAgents ?? []).toEqual([]);
		expect(view.nodes.find(node => node.id === "longRunningHold")?.status).toBe("completed");
		expect(view.actions.join("\n")).not.toContain("/workflow interrupt");
	});

	it("projects completed activation artifacts into node and focus views", () => {
		const view = buildWorkflowGraphView(workflowFamilyWithAgentArtifacts());
		const build = view.nodes.find(node => node.id === "build");
		const focused = selectWorkflowGraphViewNode(view, "build", 0);

		expect(build?.activations?.[0]?.artifacts).toEqual([
			"agent-output://build",
			"local:///tmp/workflow/build.md",
			"local:///tmp/workflow/build.jsonl",
		]);
		expect(focused.focus?.artifacts).toEqual([
			"agent-output://build",
			"local:///tmp/workflow/build.md",
			"local:///tmp/workflow/build.jsonl",
		]);
	});

	it("recommends the latest checkpoint owned by a restarted stopped attempt", () => {
		const view = buildWorkflowGraphView(workflowFamilyWithRestartedCheckpoint());
		const text = renderWorkflowGraphText(view);

		expect(view.checkpoint?.id).toBe("attempt-2:checkpoint-1");
		expect(text).toContain("Restart · /workflow restart attempt-2:checkpoint-1");
		expect(text).not.toContain("Restart · /workflow restart workflow-family:attempt-1:checkpoint-1");
	});
});

describe("renderWorkflowGraphDiagram", () => {
	it("keeps node text visible and marks loopback segments occluded by another node as dotted", () => {
		const diagram = renderWorkflowGraphDiagram(loopbackOcclusionView(), { width: 100 }).join("\n");

		expect(diagram.match(/Agent/g)?.length).toBe(2);
		expect(diagram.match(/Agent[ ┄]+·[ ┄]+runs[ ┄]+0/g)?.length).toBe(2);
		expect(diagram).toContain("┄");
	});

	it("places unrelated overlapping forward edge buses on separate visual lanes", () => {
		const lines = renderWorkflowGraphDiagram(overlappingForwardEdgesView(), { width: 82 });
		const firstTargetLabelLine = lines.findIndex(line => line.includes("○ c"));
		const connectorRows = lines.slice(5, Math.max(5, firstTargetLabelLine - 1));

		expect(connectorRows.filter(line => line.includes("─")).length).toBeGreaterThanOrEqual(2);
	});

	it("renders arrowheads for directed forward, skipped, and loopback routes", () => {
		const loopbackDiagram = renderWorkflowGraphDiagram(loopbackOcclusionView(), { width: 100 }).join("\n");
		const skippedDiagram = renderWorkflowGraphDiagram(skippedForwardEdgeView(), { width: 82 }).join("\n");
		const selfLoopDiagram = renderWorkflowGraphDiagram(selfLoopView(), { width: 100 }).join("\n");

		expect(loopbackDiagram).toContain("▼");
		expect(loopbackDiagram).toContain("▲");
		expect(skippedDiagram).toMatch(/▼\s+to c/u);
		expect(selfLoopDiagram).toContain("▶");
	});
});

function loopbackOcclusionView(): WorkflowGraphView {
	return {
		familyId: "loopback-occlusion",
		changes: { approved: 0, proposed: 0, rejected: 0 },
		topology: { parallelFanOuts: 0, branchPoints: 0, joins: 0, loops: 1, subflows: 0 },
		nodes: [
			{ id: "start", kind: "Program", status: "completed", activationCount: 1, focused: false },
			{ id: "left", kind: "Agent", status: "pending", activationCount: 0, focused: false },
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
		lineage: [],
		actions: [],
	};
}

function overlappingForwardEdgesView(): WorkflowGraphView {
	return {
		familyId: "overlapping-forward-edges",
		changes: { approved: 0, proposed: 0, rejected: 0 },
		topology: { parallelFanOuts: 0, branchPoints: 0, joins: 0, loops: 0, subflows: 0 },
		nodes: [
			{ id: "a", kind: "Program", status: "completed", activationCount: 1, focused: false },
			{ id: "b", kind: "Program", status: "completed", activationCount: 1, focused: false },
			{ id: "c", kind: "Program", status: "pending", activationCount: 0, focused: false },
			{ id: "d", kind: "Program", status: "pending", activationCount: 0, focused: false },
		],
		edges: [
			{ from: "a", to: "d" },
			{ from: "b", to: "c" },
		],
		lineage: [],
		actions: [],
	};
}

function skippedForwardEdgeView(): WorkflowGraphView {
	return {
		familyId: "skipped-forward-edge",
		changes: { approved: 0, proposed: 0, rejected: 0 },
		topology: { parallelFanOuts: 0, branchPoints: 0, joins: 1, loops: 0, subflows: 0 },
		nodes: [
			{ id: "a", kind: "Program", status: "completed", activationCount: 1, focused: false },
			{ id: "b", kind: "Program", status: "completed", activationCount: 1, focused: false },
			{ id: "c", kind: "Program", status: "pending", activationCount: 0, focused: false },
		],
		edges: [
			{ from: "a", to: "b" },
			{ from: "b", to: "c" },
			{ from: "a", to: "c" },
		],
		lineage: [],
		actions: [],
	};
}

function selfLoopView(): WorkflowGraphView {
	return {
		familyId: "self-loop",
		changes: { approved: 0, proposed: 0, rejected: 0 },
		topology: { parallelFanOuts: 0, branchPoints: 1, joins: 1, loops: 1, subflows: 0 },
		nodes: [{ id: "review", kind: "Reviewer", status: "running", activationCount: 2, focused: true }],
		edges: [{ from: "review", to: "review", condition: "retry" }],
		lineage: [],
		actions: [],
	};
}

function workflowFamilyWithRunningProgram(): WorkflowRunFamilySnapshot {
	const definition: WorkflowDefinition = {
		name: "program-interrupt-smoke",
		version: 1,
		models: { roles: {}, defaults: {} },
		nodes: [
			{ id: "build", type: "agent" },
			{ id: "longRunningHold", type: "script", script: { language: "js", file: "hold.js" } },
			{ id: "archive", type: "script", script: { language: "js", file: "archive.js" } },
		],
		edges: [
			{ from: "build", to: "longRunningHold" },
			{ from: "longRunningHold", to: "archive" },
		],
	};
	return {
		id: "family-1",
		freezes: [flowFreeze(definition)],
		attempts: [
			{
				id: "attempt-1",
				familyId: "family-1",
				freezeId: "freeze-1",
				startNodeId: "build",
				status: "running",
				runtimeBindingSnapshot: runtimeBinding(),
				activations: [
					{ id: "activation-1", nodeId: "build", parentActivationIds: [], status: "completed" },
					{
						id: "activation-2",
						nodeId: "longRunningHold",
						parentActivationIds: ["activation-1"],
						status: "running",
					},
				],
			},
		],
		checkpoints: [],
		changeRequests: [],
	};
}

function workflowFamilyWithAgentArtifacts(): WorkflowRunFamilySnapshot {
	const definition: WorkflowDefinition = {
		name: "artifact-projection-smoke",
		version: 1,
		models: { roles: {}, defaults: {} },
		nodes: [{ id: "build", type: "agent" }],
		edges: [],
	};
	return {
		id: "family-artifacts",
		freezes: [flowFreeze(definition)],
		attempts: [
			{
				id: "attempt-artifacts",
				familyId: "family-artifacts",
				freezeId: "freeze-1",
				startNodeId: "build",
				status: "completed",
				runtimeBindingSnapshot: runtimeBinding(),
				activations: [
					{
						id: "activation-build",
						nodeId: "build",
						parentActivationIds: [],
						status: "completed",
						output: {
							summary: "built",
							artifacts: [
								"agent-output://build",
								"local:///tmp/workflow/build.md",
								"local:///tmp/workflow/build.jsonl",
							],
						},
					},
				],
			},
		],
		checkpoints: [],
		changeRequests: [],
	};
}

function workflowFamilyWithRestartedCheckpoint(): WorkflowRunFamilySnapshot {
	const definition: WorkflowDefinition = {
		name: "restart-control-smoke",
		version: 1,
		models: { roles: {}, defaults: {} },
		nodes: [
			{ id: "mutationGate", type: "human", checkpoint: "after" },
			{ id: "buildRound", type: "agent" },
		],
		edges: [
			{
				from: "mutationGate",
				to: "buildRound",
				condition: { source: 'outputs.mutationGate.response == "Approve"' },
			},
		],
	};
	return {
		id: "workflow-family",
		freezes: [flowFreeze(definition)],
		attempts: [
			{
				id: "workflow-family:attempt-1",
				familyId: "workflow-family",
				freezeId: "freeze-1",
				startNodeId: "mutationGate",
				status: "stopped",
				runtimeBindingSnapshot: runtimeBinding(),
				activations: [],
			},
			{
				id: "attempt-2",
				familyId: "workflow-family",
				freezeId: "freeze-1",
				startNodeId: "mutationGate",
				status: "stopped",
				runtimeBindingSnapshot: runtimeBinding(),
				checkpointId: "workflow-family:attempt-1:checkpoint-1",
				activations: [
					{
						id: "activation-1",
						nodeId: "mutationGate",
						parentActivationIds: [],
						status: "completed",
						output: { data: { response: "Approve" }, summary: "Approve" },
					},
				],
			},
		],
		checkpoints: [
			{
				id: "workflow-family:attempt-1:checkpoint-1",
				familyId: "workflow-family",
				attemptId: "workflow-family:attempt-1",
				completedActivationIds: [],
				abortedActivationIds: [],
				frontierNodeIds: ["mutationGate"],
				state: {},
				sourceMapping: { mutationGate: "mutationGate" },
			},
			{
				id: "attempt-2:checkpoint-1",
				familyId: "workflow-family",
				attemptId: "attempt-2",
				completedActivationIds: ["activation-1"],
				abortedActivationIds: [],
				frontierNodeIds: ["buildRound"],
				state: {},
				sourceMapping: { buildRound: "buildRound" },
			},
		],
		changeRequests: [],
	};
}

function flowFreeze(definition: WorkflowDefinition): FlowFreeze {
	return {
		id: "freeze-1",
		schemaVersion: "1",
		flowPath: "program-interrupt-smoke.omhflow",
		resourceDir: "program-interrupt-smoke",
		mainContentHash: "sha256:test",
		resourceHashes: [],
		resourceSnapshots: [],
		canonicalGraphHash: "sha256:test",
		sourceMapping: { workflowBlocks: [], nodes: {} },
		staticCheckReport: { status: "passed", checks: [] },
		portableDefaults: { models: definition.models },
		definition,
	};
}

function runtimeBinding(): RuntimeBindingSnapshot {
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
