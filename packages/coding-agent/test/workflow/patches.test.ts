import { describe, expect, it } from "bun:test";
import { parseWorkflowDefinition } from "../../src/workflow/definition";
import {
	applyWorkflowGraphPatch,
	applyWorkflowGraphPatchToRun,
	proposeWorkflowGraphPatch,
	proposeWorkflowGraphPatchToRun,
	WorkflowGraphPatchError,
	type WorkflowGraphPatchOperation,
} from "../../src/workflow/patches";
import { reconstructWorkflowRuns, startWorkflowRun, type WorkflowRunStoreHost } from "../../src/workflow/run-store";

const source = `
name: patch-demo
version: 1
models:
  roles:
    reviewer: provider/reviewer:high
  defaults: {}
nodes:
  build:
    type: agent
    agent: task
  review:
    type: review
    model:
      role: reviewer
    writes:
      - /verdict
edges:
  - from: build
    to: review
`;

const promptSourcePatchSource = `
name: prompt-patch-demo
version: 1
nodes:
  planner:
    type: agent
    agent: task
    prompt: Plan the next build.
  build:
    type: agent
    agent: task
    prompt:
      output:
        node: planner
        path: /data/nextPrompt
        activation: latest-completed
edges:
  - from: planner
    to: build
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

function patchOperations(): WorkflowGraphPatchOperation[] {
	return [
		{
			op: "add_node",
			node: {
				id: "finish",
				type: "script",
				reads: ["/verdict"],
			},
		},
		{
			op: "add_edge",
			edge: { from: "review", to: "finish", condition: { source: 'state.verdict == "finish"' } },
		},
		{
			op: "replace_edge_condition",
			from: "build",
			to: "review",
			condition: "state.ready == true",
		},
		{
			op: "replace_node_model",
			nodeId: "review",
			model: { selector: "provider/reviewer-v2:high" },
		},
		{
			op: "replace_node_permissions",
			nodeId: "review",
			reads: ["/draft"],
			writes: ["/verdict", "/score"],
			workspaceAccess: "read",
		},
	];
}

describe("workflow graph patch API", () => {
	it("lets ordinary agent contexts propose patches but not apply them", () => {
		const definition = parseWorkflowDefinition(source, { sourcePath: "workflow.yml" });
		const patch = patchOperations();

		const proposal = proposeWorkflowGraphPatch(definition, patch, {
			actor: "agent",
			proposalId: "proposal-1",
			reason: "add finish branch",
		});

		expect(proposal).toMatchObject({
			id: "proposal-1",
			status: "proposed",
			reason: "add finish branch",
			preview: {
				addedNodes: ["finish"],
				addedEdges: [{ from: "review", to: "finish" }],
				changedNodes: ["review"],
			},
		});
		expect(definition.nodes.map(node => node.id)).toEqual(["build", "review"]);
		expect(() => applyWorkflowGraphPatch(definition, patch, { actor: "agent" })).toThrow(
			"workflow graph patch apply requires supervisor or human approval",
		);
	});

	it("applies patches in authorized contexts and reports graph and model impact", () => {
		const definition = parseWorkflowDefinition(source, { sourcePath: "workflow.yml" });

		const result = applyWorkflowGraphPatch(definition, patchOperations(), {
			actor: "supervisor",
			reason: "add finish branch",
		});

		expect(result.definition.nodes.map(node => node.id)).toEqual(["build", "review", "finish"]);
		expect(result.definition.edges.map(edge => [edge.from, edge.to, edge.condition?.source])).toEqual([
			["build", "review", "state.ready == true"],
			["review", "finish", 'state.verdict == "finish"'],
		]);
		expect(result.definition.nodes.find(node => node.id === "review")?.model).toEqual({
			selector: "provider/reviewer-v2:high",
		});
		expect(result.definition.nodes.find(node => node.id === "review")?.reads).toEqual(["/draft"]);
		expect(result.definition.nodes.find(node => node.id === "review")?.writes).toEqual(["/verdict", "/score"]);
		expect(result.definition.nodes.find(node => node.id === "review")?.workspaceAccess).toBe("read");
		expect(result.preview.modelChanges).toEqual([
			{
				nodeId: "review",
				before: { role: "reviewer" },
				after: { selector: "provider/reviewer-v2:high" },
			},
		]);
		expect(result.preview.permissionChanges).toEqual([
			{
				nodeId: "review",
				before: { writes: ["/verdict"] },
				after: { reads: ["/draft"], writes: ["/verdict", "/score"], workspaceAccess: "read" },
			},
		]);
	});

	it("updates model roles and rejects empty role patches", () => {
		const definition = parseWorkflowDefinition(source, { sourcePath: "workflow.yml" });

		const result = applyWorkflowGraphPatch(
			definition,
			[{ op: "set_model_role", role: "reviewer", selector: "provider/reviewer-v3:xhigh" }],
			{ actor: "supervisor" },
		);

		expect(result.definition.models.roles.reviewer).toBe("provider/reviewer-v3:xhigh");
		expect(result.preview.modelRoleChanges).toEqual([
			{
				role: "reviewer",
				before: "provider/reviewer:high",
				after: "provider/reviewer-v3:xhigh",
			},
		]);
		expect(() =>
			applyWorkflowGraphPatch(definition, [{ op: "set_model_role", role: "", selector: "provider/model" }], {
				actor: "supervisor",
			}),
		).toThrow("workflow graph patch model role must be non-empty");
		expect(() =>
			applyWorkflowGraphPatch(definition, [{ op: "set_model_role", role: "reviewer", selector: "" }], {
				actor: "supervisor",
			}),
		).toThrow("workflow graph patch model role selector must be non-empty");
	});

	it("records branch dispositions without mutating the workflow graph", () => {
		const definition = parseWorkflowDefinition(
			`
name: branch-disposition-demo
version: 1
nodes:
  build:
    type: script
  tryFast:
    type: script
  trySafe:
    type: script
  review:
    type: review
edges:
  - from: build
    to: tryFast
  - from: build
    to: trySafe
  - from: tryFast
    to: review
  - from: trySafe
    to: review
`,
			{ sourcePath: "workflow.yml" },
		);

		const result = applyWorkflowGraphPatch(
			definition,
			[
				{ op: "abandon_branch", nodeId: "trySafe", reason: "candidate regressed latency" },
				{ op: "rollback_branch", nodeId: "tryFast", targetNodeId: "build", reason: "keep baseline path" },
			],
			{ actor: "supervisor" },
		);

		expect(result.definition.nodes.map(node => node.id)).toEqual(["build", "tryFast", "trySafe", "review"]);
		expect(result.definition.edges.map(edge => [edge.from, edge.to])).toEqual([
			["build", "tryFast"],
			["build", "trySafe"],
			["tryFast", "review"],
			["trySafe", "review"],
		]);
		expect(result.preview.abandonedBranches).toEqual([{ nodeId: "trySafe", reason: "candidate regressed latency" }]);
		expect(result.preview.rolledBackBranches).toEqual([
			{ nodeId: "tryFast", targetNodeId: "build", reason: "keep baseline path" },
		]);
		expect(() =>
			applyWorkflowGraphPatch(definition, [{ op: "abandon_branch", nodeId: "missing", reason: "unknown branch" }], {
				actor: "supervisor",
			}),
		).toThrow('workflow graph patch references unknown node "missing"');
	});

	it("validates patch references, model context, and edge conditions", () => {
		const definition = parseWorkflowDefinition(source, { sourcePath: "workflow.yml" });

		expect(() =>
			applyWorkflowGraphPatch(definition, [{ op: "add_edge", edge: { from: "review", to: "missing" } }], {
				actor: "supervisor",
			}),
		).toThrow(WorkflowGraphPatchError);
		expect(() =>
			applyWorkflowGraphPatch(
				definition,
				[{ op: "replace_edge_condition", from: "build", to: "review", condition: "state.ready = true" }],
				{ actor: "supervisor" },
			),
		).toThrow('workflow graph patch condition is invalid: unexpected token "="');
		expect(() =>
			applyWorkflowGraphPatch(
				definition,
				[
					{
						op: "add_edge",
						edge: {
							from: "review",
							to: "build",
							condition: { source: 'outputs.missing.verdict == "retry"' },
						},
					},
				],
				{ actor: "supervisor" },
			),
		).toThrow('workflow graph patch condition references unknown output node "missing"');
		expect(() =>
			applyWorkflowGraphPatch(
				parseWorkflowDefinition(
					`
name: review-gates
version: 1
nodes:
  fix:
    type: agent
  review:
    type: review
    gates:
      - retry
      - complete
edges:
  - from: fix
    to: review
`,
					{ sourcePath: "workflow.yml" },
				),
				[
					{
						op: "replace_edge_condition",
						from: "fix",
						to: "review",
						condition: 'outputs.review.verdict == "needs-work"',
					},
				],
				{ actor: "supervisor" },
			),
		).toThrow('workflow graph patch condition references undeclared verdict "needs-work" for review node "review"');
		expect(() =>
			applyWorkflowGraphPatch(
				definition,
				[{ op: "replace_node_model", nodeId: "missing", model: { selector: "provider/model:high" } }],
				{ actor: "supervisor" },
			),
		).toThrow('workflow graph patch references unknown node "missing"');
		expect(() =>
			applyWorkflowGraphPatch(
				definition,
				[
					{
						op: "replace_node_model",
						nodeId: "review",
						model: { role: "reviewer", selector: "provider/model:high" },
					},
				],
				{ actor: "supervisor" },
			),
		).toThrow("workflow graph patch model context must define exactly one of role, selector, or candidates");
	});

	it("validates and previews prompt source dependency changes", () => {
		const definition = parseWorkflowDefinition(promptSourcePatchSource, { sourcePath: "workflow.yml" });

		expect(() =>
			applyWorkflowGraphPatch(definition, [{ op: "remove_node", nodeId: "planner" }], { actor: "supervisor" }),
		).toThrow('workflow graph patch leaves node "build" prompt referencing unknown output node "planner"');
		expect(() =>
			applyWorkflowGraphPatch(
				parseWorkflowDefinition(
					`
name: prompt-permission-demo
version: 1
nodes:
  planner:
    type: agent
  build:
    type: agent
    reads:
      - /summary
    prompt: Use the static fallback plan.
edges:
  - from: planner
    to: build
`,
					{ sourcePath: "workflow.yml" },
				),
				[
					{
						op: "replace_node_prompt_source",
						nodeId: "build",
						promptSource: {
							kind: "output",
							node: "planner",
							path: "/data/nextPrompt",
							activation: "latest-completed",
						},
					},
				],
				{ actor: "supervisor" },
			),
		).toThrow('workflow state read from "/data/nextPrompt" is not allowed');

		const result = applyWorkflowGraphPatch(
			definition,
			[
				{
					op: "replace_node_prompt_source",
					nodeId: "build",
					promptSource: { kind: "inline", text: "Use the static fallback plan." },
				},
			],
			{ actor: "supervisor" },
		);

		const build = result.definition.nodes.find(node => node.id === "build");
		expect(build?.prompt).toBe("Use the static fallback plan.");
		expect(build?.promptSource).toEqual({ kind: "inline", text: "Use the static fallback plan." });
		expect(result.preview.promptSourceChanges).toEqual([
			{
				nodeId: "build",
				before: {
					kind: "output",
					node: "planner",
					path: "/data/nextPrompt",
					activation: "latest-completed",
				},
				after: { kind: "inline", text: "Use the static fallback plan." },
			},
		]);
	});

	it("rejects proposing or applying graph patches directly to active runs", () => {
		const host = createHost();
		const definition = parseWorkflowDefinition(source, { sourcePath: "workflow.yml" });
		const run = startWorkflowRun(host, definition, { runId: "run-1" });

		expect(() =>
			proposeWorkflowGraphPatchToRun(host, run, patchOperations(), {
				actor: "agent",
				proposalId: "proposal-1",
				reason: "request finish branch",
			}),
		).toThrow("workflow graph patches cannot be proposed on an active run; use a workflow change request instead");

		expect(() =>
			applyWorkflowGraphPatchToRun(host, run, patchOperations(), {
				actor: "human",
				proposalId: "proposal-1",
				graphRevisionId: "run-1:graph-1",
				reason: "approved finish branch",
			}),
		).toThrow(
			"workflow graph patches cannot be applied to an active run; stop, checkpoint, freeze, and restart the workflow instead",
		);
		const reconstructed = reconstructWorkflowRuns(host.getBranch());
		expect(run.currentGraphRevisionId).toBe("run-1:graph-0");
		expect(run.definition.nodes.map(node => node.id)).toEqual(["build", "review"]);
		expect(reconstructed[0]?.graphRevisions.map(revision => revision.id)).toEqual(["run-1:graph-0"]);
		expect(reconstructed[0]?.graphPatchProposals).toEqual([]);
		expect(Object.hasOwn(reconstructed[0] ?? {}, "appliedGraphPatches")).toBe(false);
	});
});
