import { describe, expect, it } from "bun:test";
import { Effort } from "@oh-my-pi/pi-ai";
import { parseWorkflowDefinition, type WorkflowDefinition } from "../../src/workflow/definition";
import {
	appendWorkflowActivationAborted,
	appendWorkflowActivationCompleted,
	appendWorkflowActivationFailed,
	appendWorkflowActivationStarted,
	appendWorkflowGraphPatchProposed,
	appendWorkflowStatePatch,
	reconstructWorkflowRuns,
	startWorkflowRun,
	WORKFLOW_RUN_EVENT_TYPE,
	type WorkflowRunStoreHost,
} from "../../src/workflow/run-store";

const source = `
name: run-store-demo
version: 1
nodes:
  build:
    type: agent
edges: []
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

function renamedDefinition(definition: WorkflowDefinition): WorkflowDefinition {
	return {
		...definition,
		name: "renamed-workflow",
	};
}

describe("workflow run store", () => {
	it("stores the initial definition snapshot when a run starts", () => {
		const host = createHost();
		const definition = parseWorkflowDefinition(source, { sourcePath: "workflow.yml" });

		const run = startWorkflowRun(host, definition, { runId: "run-1" });

		expect(run.id).toBe("run-1");
		expect(run.currentGraphRevisionId).toBe("run-1:graph-0");
		expect(host.entries).toHaveLength(1);
		expect(host.entries[0]).toMatchObject({
			customType: WORKFLOW_RUN_EVENT_TYPE,
			data: {
				event: "run_started",
				runId: "run-1",
				graphRevisionId: "run-1:graph-0",
				definitionSnapshot: definition,
			},
		});

		const reconstructed = reconstructWorkflowRuns(host.getBranch());
		expect(reconstructed).toHaveLength(1);
		expect(reconstructed[0]?.definition.name).toBe("run-store-demo");
		expect(reconstructed[0]?.graphRevisions.map(revision => revision.id)).toEqual(["run-1:graph-0"]);
		expect(reconstructed[0]?.activations).toEqual([]);
	});

	it("rejects duplicate run ids before appending run events", () => {
		const host = createHost();
		const definition = parseWorkflowDefinition(source, { sourcePath: "workflow.yml" });

		startWorkflowRun(host, definition, { runId: "run-1" });
		const entryCount = host.entries.length;

		expect(() => startWorkflowRun(host, definition, { runId: "run-1" })).toThrow(
			"Workflow run already exists: run-1",
		);
		expect(host.entries).toHaveLength(entryCount);
		expect(reconstructWorkflowRuns(host.getBranch()).map(run => run.id)).toEqual(["run-1"]);
	});

	it("ignores legacy active-run graph revision events during reconstruction", () => {
		const host = createHost();
		const definition = parseWorkflowDefinition(source, { sourcePath: "workflow.yml" });
		const run = startWorkflowRun(host, definition, { runId: "run-1" });
		const nextDefinition = renamedDefinition(definition);

		host.appendCustomEntry(WORKFLOW_RUN_EVENT_TYPE, {
			event: "graph_revision_created",
			runId: run.id,
			graphRevisionId: "run-1:graph-1",
			parentGraphRevisionId: run.currentGraphRevisionId,
			definitionSnapshot: nextDefinition,
			reason: "rename workflow",
		});

		expect(host.entries).toHaveLength(2);
		const reconstructed = reconstructWorkflowRuns(host.getBranch());

		expect(reconstructed[0]?.currentGraphRevisionId).toBe("run-1:graph-0");
		expect(reconstructed[0]?.definition.name).toBe("run-store-demo");
		expect(reconstructed[0]?.graphRevisions.map(entry => entry.definition.name)).toEqual(["run-store-demo"]);
	});

	it("ignores unrelated custom entries and orphan legacy graph revisions during reconstruction", () => {
		const host = createHost();
		const definition = parseWorkflowDefinition(source, { sourcePath: "workflow.yml" });

		host.appendCustomEntry("other-feature", { ok: true });
		host.appendCustomEntry(WORKFLOW_RUN_EVENT_TYPE, {
			event: "graph_revision_created",
			runId: "missing-run",
			graphRevisionId: "missing-run:graph-1",
			definitionSnapshot: definition,
		});
		startWorkflowRun(host, definition, { runId: "run-1" });

		const reconstructed = reconstructWorkflowRuns(host.getBranch());

		expect(reconstructed.map(run => run.id)).toEqual(["run-1"]);
		expect(reconstructed[0]?.currentGraphRevisionId).toBe("run-1:graph-0");
	});

	it("reconstructs current state from appended state patches", () => {
		const host = createHost();
		const definition = parseWorkflowDefinition(source, { sourcePath: "workflow.yml" });
		const run = startWorkflowRun(host, definition, { runId: "run-1" });

		appendWorkflowStatePatch(host, run.id, {
			patch: [
				{ op: "set", path: "/round", value: 1 },
				{ op: "set", path: "/verdict", value: "continue" },
			],
			reason: "review verdict",
		});

		const reconstructed = reconstructWorkflowRuns(host.getBranch());

		expect(reconstructed[0]?.state).toEqual({ round: 1, verdict: "continue" });
	});

	it("enforces the definition state schema when reconstructing history", () => {
		const host = createHost();
		const definition = parseWorkflowDefinition(
			`
name: schema-history-demo
version: 1
stateSchema:
  version: 1
  shape:
    verdict: string
nodes:
  review:
    type: review
edges: []
`,
			{ sourcePath: "workflow.yml" },
		);
		const run = startWorkflowRun(host, definition, { runId: "run-1" });

		appendWorkflowStatePatch(host, run.id, {
			patch: [{ op: "set", path: "/verdict", value: { status: "continue" } }],
			reason: "corrupt historical event",
		});

		expect(() => reconstructWorkflowRuns(host.getBranch())).toThrow(
			'workflow state schema rejects write to "/verdict": expected string, received object',
		);
	});

	it("ignores legacy active-run graph patch proposals during reconstruction", () => {
		const host = createHost();
		const definition = parseWorkflowDefinition(source, { sourcePath: "workflow.yml" });
		const run = startWorkflowRun(host, definition, { runId: "run-1" });
		const patch = [
			{
				op: "add_node" as const,
				node: { id: "review", type: "review" as const },
			},
		];
		const preview = {
			addedNodes: ["review"],
			removedNodes: [],
			changedNodes: [],
			addedEdges: [],
			removedEdges: [],
			changedEdges: [],
			promptSourceChanges: [],
			modelChanges: [],
			permissionChanges: [],
			modelRoleChanges: [],
			abandonedBranches: [],
			rolledBackBranches: [],
			warnings: [],
		};

		appendWorkflowGraphPatchProposed(host, run.id, {
			proposalId: "proposal-1",
			actor: "agent",
			patch,
			preview,
			reason: "add review gate",
		});

		const reconstructed = reconstructWorkflowRuns(host.getBranch());

		expect(reconstructed[0]?.graphPatchProposals).toEqual([]);
		expect(Object.hasOwn(reconstructed[0] ?? {}, "appliedGraphPatches")).toBe(false);
	});

	it("reconstructs activation output and model audit records", () => {
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
			output: {
				summary: "build completed",
				artifacts: ["artifact://workflow/run-1/build.txt"],
			},
			modelAudit: {
				nodeId: "build",
				source: "workflow-default",
				requestedRole: "builder",
				requestedPattern: "anthropic/claude-sonnet-4-5:medium",
				unavailablePolicy: "fallback-to-parent",
				resolvedModel: "anthropic/claude-sonnet-4-5",
				thinkingLevel: Effort.Medium,
				explicitThinkingLevel: true,
				fallbackUsed: false,
			},
		});

		const reconstructed = reconstructWorkflowRuns(host.getBranch());

		expect(reconstructed[0]?.activations).toEqual([
			{
				id: "activation-1",
				nodeId: "build",
				graphRevisionId: "run-1:graph-0",
				parentActivationIds: [],
				status: "completed",
				output: {
					summary: "build completed",
					artifacts: ["artifact://workflow/run-1/build.txt"],
				},
				modelAudit: {
					nodeId: "build",
					source: "workflow-default",
					requestedRole: "builder",
					requestedPattern: "anthropic/claude-sonnet-4-5:medium",
					unavailablePolicy: "fallback-to-parent",
					resolvedModel: "anthropic/claude-sonnet-4-5",
					thinkingLevel: Effort.Medium,
					explicitThinkingLevel: true,
					fallbackUsed: false,
				},
			},
		]);
	});

	it("reconstructs failed activation records", () => {
		const host = createHost();
		const definition = parseWorkflowDefinition(source, { sourcePath: "workflow.yml" });
		const run = startWorkflowRun(host, definition, { runId: "run-1" });

		appendWorkflowActivationStarted(host, run.id, {
			activationId: "activation-1",
			nodeId: "build",
			graphRevisionId: run.currentGraphRevisionId,
			parentActivationIds: ["activation-0"],
		});
		appendWorkflowActivationFailed(host, run.id, {
			activationId: "activation-1",
			error: "model unavailable",
		});

		const reconstructed = reconstructWorkflowRuns(host.getBranch());

		expect(reconstructed[0]?.activations).toEqual([
			{
				id: "activation-1",
				nodeId: "build",
				graphRevisionId: "run-1:graph-0",
				parentActivationIds: ["activation-0"],
				status: "failed",
				error: "model unavailable",
			},
		]);
	});

	it("reconstructs aborted activation records without marking them failed", () => {
		const host = createHost();
		const definition = parseWorkflowDefinition(source, { sourcePath: "workflow.yml" });
		const run = startWorkflowRun(host, definition, { runId: "run-1" });

		appendWorkflowActivationStarted(host, run.id, {
			activationId: "activation-1",
			nodeId: "build",
			graphRevisionId: run.currentGraphRevisionId,
			parentActivationIds: ["activation-0"],
		});
		appendWorkflowActivationAborted(host, run.id, {
			activationId: "activation-1",
			reason: "stop deadline elapsed",
		});

		const reconstructed = reconstructWorkflowRuns(host.getBranch());

		expect(reconstructed[0]?.activations).toEqual([
			{
				id: "activation-1",
				nodeId: "build",
				graphRevisionId: "run-1:graph-0",
				parentActivationIds: ["activation-0"],
				status: "aborted",
				reason: "stop deadline elapsed",
			},
		]);
	});
	it("reconstructs mapped activation metadata from started events", () => {
		const host = createHost();
		const definition = parseWorkflowDefinition(source, { sourcePath: "workflow.yml" });
		const run = startWorkflowRun(host, definition, { runId: "run-1" });

		appendWorkflowActivationStarted(host, run.id, {
			activationId: "activation-1",
			nodeId: "build",
			graphRevisionId: run.currentGraphRevisionId,
			parentActivationIds: ["activation-0"],
			mapped: {
				poolId: "pool",
				poolActivationId: "activation-0",
				itemKey: "task-1",
				item: { id: "task-1" },
				phase: "worker",
			},
		});
		appendWorkflowActivationCompleted(host, run.id, {
			activationId: "activation-1",
			output: { summary: "worker done" },
		});

		const reconstructed = reconstructWorkflowRuns(host.getBranch());

		expect(reconstructed[0]?.activations).toEqual([
			{
				id: "activation-1",
				nodeId: "build",
				graphRevisionId: "run-1:graph-0",
				parentActivationIds: ["activation-0"],
				status: "completed",
				output: { summary: "worker done" },
				mapped: {
					poolId: "pool",
					poolActivationId: "activation-0",
					itemKey: "task-1",
					item: { id: "task-1" },
					phase: "worker",
				},
			},
		]);
	});
});
