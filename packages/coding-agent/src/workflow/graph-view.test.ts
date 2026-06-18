import { describe, expect, it } from "bun:test";
import type { WorkflowDefinition } from "./definition";
import type { FlowFreeze } from "./freeze";
import { buildWorkflowGraphView } from "./graph-view";
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
});

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
