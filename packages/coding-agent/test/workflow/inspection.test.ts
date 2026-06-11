import { describe, expect, it } from "bun:test";
import { parseWorkflowDefinition } from "../../src/workflow/definition";
import type { FlowFreeze } from "../../src/workflow/freeze";
import { buildWorkflowInspection, buildWorkflowLifecycleInspection } from "../../src/workflow/inspection";
import {
	appendWorkflowAttemptActivationAborted,
	appendWorkflowAttemptActivationCompleted,
	appendWorkflowAttemptActivationStarted,
	approveWorkflowChangeRequest,
	createWorkflowCheckpoint,
	proposeWorkflowChangeRequest,
	reconstructWorkflowFamilies,
	recordWorkflowFreeze,
	requestWorkflowAttemptStop,
	restartWorkflowAttempt,
	startWorkflowAttempt,
	startWorkflowFamily,
} from "../../src/workflow/lifecycle";
import {
	appendWorkflowActivationCompleted,
	appendWorkflowActivationStarted,
	appendWorkflowGraphPatchApplied,
	appendWorkflowGraphPatchProposed,
	reconstructWorkflowRuns,
	startWorkflowRun,
	type WorkflowRunStoreHost,
} from "../../src/workflow/run-store";

const source = `
name: inspect-demo
version: 1
nodes:
  build:
    type: agent
  review:
    type: review
edges:
  - from: build
    to: review
`;

interface CapturedEntry {
	type: "custom";
	customType: string;
	data?: unknown;
}

function createHost(): WorkflowRunStoreHost & { entries: CapturedEntry[] } {
	const entries: CapturedEntry[] = [];
	return {
		entries,
		appendCustomEntry: (customType, data) => {
			entries.push({ type: "custom", customType, data });
			return `entry-${entries.length}`;
		},
		getBranch: () => entries,
	};
}

function graphPatchPreview() {
	return {
		addedNodes: ["scoreboard"],
		removedNodes: [],
		changedNodes: ["review"],
		addedEdges: [{ from: "review", to: "scoreboard" }],
		removedEdges: [],
		changedEdges: [],
		promptSourceChanges: [],
		modelChanges: [{ nodeId: "review", before: { role: "reviewer" }, after: { selector: "openai/gpt-4o" } }],
		permissionChanges: [],
		modelRoleChanges: [],
		warnings: ["review model changed"],
	};
}

describe("workflow inspection model", () => {
	it("summarizes graph, state, activations, revisions, and model assignments", () => {
		const host = createHost();
		const definition = parseWorkflowDefinition(source, { sourcePath: "workflow.yml" });
		const run = startWorkflowRun(host, definition, { runId: "run-1" });
		appendWorkflowActivationStarted(host, run.id, {
			activationId: "activation-1",
			nodeId: "build",
			graphRevisionId: run.currentGraphRevisionId,
			parentActivationIds: [],
		});
		appendWorkflowActivationCompleted(host, run.id, {
			activationId: "activation-1",
			output: { summary: "built", artifacts: ["artifact://workflow/run-1/build.txt"] },
			modelAudit: {
				nodeId: "build",
				source: "workflow-default",
				requestedRole: "builder",
				requestedPattern: "openai/gpt-4o",
				unavailablePolicy: "fallback-to-parent",
				resolvedModel: "openai/gpt-4o",
				explicitThinkingLevel: false,
				fallbackUsed: false,
			},
		});

		const reconstructed = reconstructWorkflowRuns(host.getBranch())[0]!;
		const inspection = buildWorkflowInspection(reconstructed);

		expect(inspection).toEqual({
			runId: "run-1",
			currentGraphRevisionId: "run-1:graph-0",
			graph: {
				nodes: [
					{ id: "build", type: "agent" },
					{ id: "review", type: "review" },
				],
				edges: [{ from: "build", to: "review" }],
			},
			state: {},
			graphRevisions: [{ id: "run-1:graph-0", nodeCount: 2, edgeCount: 1 }],
			pendingGraphPatchProposals: [],
			appliedGraphPatches: [],
			activations: [
				{
					id: "activation-1",
					nodeId: "build",
					graphRevisionId: "run-1:graph-0",
					parentActivationIds: [],
					status: "completed",
					prompt: undefined,
					summary: "built",
					artifacts: ["artifact://workflow/run-1/build.txt"],
					error: undefined,
				},
			],
			modelAssignments: [
				{
					activationId: "activation-1",
					nodeId: "build",
					source: "workflow-default",
					requestedRole: "builder",
					requestedPattern: "openai/gpt-4o",
					resolvedModel: "openai/gpt-4o",
					thinkingLevel: undefined,
					fallbackUsed: false,
					fallbackReason: undefined,
					error: undefined,
				},
			],
		});
	});

	it("summarizes graph patch proposal and application audit records", () => {
		const host = createHost();
		const definition = parseWorkflowDefinition(source, { sourcePath: "workflow.yml" });
		const run = startWorkflowRun(host, definition, { runId: "run-1" });
		const pendingPatch = [{ op: "add_node" as const, node: { id: "human-review", type: "human" as const } }];
		const appliedPatch = [{ op: "add_node" as const, node: { id: "scoreboard", type: "script" as const } }];
		const preview = graphPatchPreview();

		appendWorkflowGraphPatchProposed(host, run.id, {
			proposalId: "proposal-pending",
			actor: "agent",
			patch: pendingPatch,
			preview,
			reason: "request human gate",
		});
		appendWorkflowGraphPatchProposed(host, run.id, {
			proposalId: "proposal-applied",
			actor: "agent",
			patch: appliedPatch,
			preview,
			reason: "request scoreboard",
		});
		appendWorkflowGraphPatchApplied(host, run.id, {
			proposalId: "proposal-applied",
			actor: "supervisor",
			patch: appliedPatch,
			preview,
			graphRevisionId: "run-1:graph-1",
			parentGraphRevisionId: run.currentGraphRevisionId,
			reason: "approved scoreboard",
		});

		const reconstructed = reconstructWorkflowRuns(host.getBranch())[0]!;
		const inspection = buildWorkflowInspection(reconstructed);

		expect(inspection.pendingGraphPatchProposals).toEqual([
			{
				id: "proposal-pending",
				actor: "agent",
				reason: "request human gate",
				impact: {
					addedNodes: 1,
					removedNodes: 0,
					changedNodes: 1,
					addedEdges: 1,
					removedEdges: 0,
					changedEdges: 0,
					promptSourceChanges: 0,
					modelChanges: 1,
					permissionChanges: 0,
					modelRoleChanges: 0,
					warnings: 1,
				},
			},
		]);
		expect(inspection.appliedGraphPatches).toEqual([
			{
				proposalId: "proposal-applied",
				actor: "supervisor",
				reason: "approved scoreboard",
				graphRevisionId: "run-1:graph-1",
				parentGraphRevisionId: "run-1:graph-0",
				impact: {
					addedNodes: 1,
					removedNodes: 0,
					changedNodes: 1,
					addedEdges: 1,
					removedEdges: 0,
					changedEdges: 0,
					promptSourceChanges: 0,
					modelChanges: 1,
					permissionChanges: 0,
					modelRoleChanges: 0,
					warnings: 1,
				},
			},
		]);
	});

	it("summarizes lifecycle family lineage, checkpoints, changes, and bindings", () => {
		const host = createHost();
		const freezeA = createFreeze("flowfreeze:a");
		const freezeB = createFreeze("flowfreeze:b");

		startWorkflowFamily(host, { familyId: "family-1", objective: "ship release" });
		recordWorkflowFreeze(host, freezeA, { familyId: "family-1" });
		startWorkflowAttempt(host, {
			familyId: "family-1",
			attemptId: "attempt-1",
			freezeId: freezeA.id,
			startNodeId: "build",
			runtimeBindingSnapshot: binding("binding-1"),
		});
		appendWorkflowAttemptActivationStarted(host, {
			attemptId: "attempt-1",
			activationId: "activation-1",
			nodeId: "build",
			parentActivationIds: [],
		});
		appendWorkflowAttemptActivationCompleted(host, {
			attemptId: "attempt-1",
			activationId: "activation-1",
			output: { summary: "built" },
		});
		const request = proposeWorkflowChangeRequest(host, {
			changeRequestId: "change-1",
			familyId: "family-1",
			attemptId: "attempt-1",
			actor: "agent:reviewer",
			origin: "internal-agent",
			reason: "add verification",
			operations: [{ op: "add_node", node: { id: "verify", type: "script" } }],
			frontierMapping: { review: "verify" },
		});
		approveWorkflowChangeRequest(host, { changeRequestId: request.id, actor: "human:sihao" });
		requestWorkflowAttemptStop(host, { attemptId: "attempt-1", deadlineMs: 10 });
		appendWorkflowAttemptActivationAborted(host, {
			attemptId: "attempt-1",
			activationId: "activation-2",
			nodeId: "review",
			reason: "stop deadline elapsed",
		});
		createWorkflowCheckpoint(host, {
			checkpointId: "checkpoint-1",
			familyId: "family-1",
			attemptId: "attempt-1",
			completedActivationIds: ["activation-1"],
			abortedActivationIds: ["activation-2"],
			frontierNodeIds: ["review"],
			state: { build: { summary: "built" } },
			sourceMapping: { review: "verify" },
		});
		recordWorkflowFreeze(host, freezeB, { familyId: "family-1" });
		restartWorkflowAttempt(host, {
			familyId: "family-1",
			attemptId: "attempt-2",
			checkpointId: "checkpoint-1",
			freezeId: freezeB.id,
			startNodeId: "verify",
			runtimeBindingSnapshot: binding("binding-2"),
		});

		const family = reconstructWorkflowFamilies(host.getBranch())[0]!;
		const inspection = buildWorkflowLifecycleInspection(family);

		expect(inspection).toMatchObject({
			familyId: "family-1",
			objective: "ship release",
			freezeIds: ["flowfreeze:a", "flowfreeze:b"],
			attempts: [
				{
					id: "attempt-1",
					freezeId: "flowfreeze:a",
					status: "stopped",
					activationCounts: { completed: 1, aborted: 1 },
					runtimeBindingSnapshot: { id: "binding-1" },
				},
				{
					id: "attempt-2",
					freezeId: "flowfreeze:b",
					status: "running",
					checkpointId: "checkpoint-1",
					runtimeBindingSnapshot: { id: "binding-2" },
				},
			],
			checkpoints: [
				{
					id: "checkpoint-1",
					attemptId: "attempt-1",
					completedActivationCount: 1,
					abortedActivationCount: 1,
					frontierNodeIds: ["review"],
					sourceMapping: { review: "verify" },
				},
			],
			changeRequests: [
				{
					id: "change-1",
					status: "approved",
					approvedBy: "human:sihao",
					operationCount: 1,
					frontierMapping: { review: "verify" },
				},
			],
		});
		expect(inspection.attempts[0]?.activations).toEqual([
			{
				id: "activation-1",
				nodeId: "build",
				parentActivationIds: [],
				status: "completed",
				summary: "built",
				artifacts: undefined,
				error: undefined,
				reason: undefined,
			},
			{
				id: "activation-2",
				nodeId: "review",
				parentActivationIds: [],
				status: "aborted",
				summary: undefined,
				artifacts: undefined,
				error: undefined,
				reason: "stop deadline elapsed",
			},
		]);
	});
});

function binding(id: string) {
	return {
		id,
		requestedRoles: { builder: "openai/gpt-4o" },
		resolvedModels: { builder: "openai/gpt-4o" },
		tools: ["task"],
		agents: ["task"],
		unavailable: [],
		warnings: [],
	};
}

function createFreeze(id: string): FlowFreeze {
	return {
		id,
		schemaVersion: "omhflow/v1",
		flowPath: `${id}.omhflow`,
		resourceDir: id,
		mainContentHash: `sha256:main-${id}`,
		resourceHashes: [],
		resourceSnapshots: [],
		canonicalGraphHash: `sha256:graph-${id}`,
		sourceMapping: {
			workflowBlocks: [{ id: "workflow:0", language: "yaml" }],
			nodes: { build: { sourceBlock: "workflow:0" } },
		},
		staticCheckReport: { status: "passed", checks: [{ name: "fixture", status: "passed" }] },
		portableDefaults: { models: { roles: { builder: "openai/gpt-4o" }, defaults: { agent: "builder" } } },
		definition: {
			name: id,
			version: 1,
			models: { roles: { builder: "openai/gpt-4o" }, defaults: { agent: "builder" } },
			nodes: [{ id: "build", type: "agent" }],
			edges: [],
		},
	};
}
