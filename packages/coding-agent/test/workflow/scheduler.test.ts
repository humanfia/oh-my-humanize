import { describe, expect, it } from "bun:test";
import { parseWorkflowDefinition } from "../../src/workflow/definition";
import { applyWorkflowGraphPatchToRun } from "../../src/workflow/patches";
import { startWorkflowRun, type WorkflowRunStoreHost } from "../../src/workflow/run-store";
import { runWorkflowScheduler } from "../../src/workflow/scheduler";

const linearWorkflow = `
name: linear-demo
version: 1
nodes:
  start:
    type: script
  review:
    type: review
edges:
  - from: start
    to: review
`;

const conditionalWorkflow = `
name: conditional-demo
version: 1
nodes:
  review:
    type: review
    writes:
      - /verdict
  build:
    type: agent
  finish:
    type: script
edges:
  - from: review
    to: build
    when: state.verdict == "continue"
  - from: review
    to: finish
    when: state.verdict == "finish"
`;

const outputConditionalWorkflow = `
name: output-conditional-demo
version: 1
nodes:
  build:
    type: agent
  review:
    type: review
  finish:
    type: script
edges:
  - from: build
    to: review
  - from: review
    to: build
    when: outputs.review.verdict == "continue"
  - from: review
    to: finish
    when: outputs.review.verdict == "finish"
`;

const loopWorkflow = `
name: loop-demo
version: 1
nodes:
  build:
    type: agent
  review:
    type: review
edges:
  - from: build
    to: review
  - from: review
    to: build
`;

const joinWorkflow = `
name: join-demo
version: 1
nodes:
  start:
    type: script
  left:
    type: script
  right:
    type: script
  join:
    type: script
    waitFor:
      - left
      - right
edges:
  - from: start
    to: left
  - from: start
    to: right
  - from: left
    to: join
  - from: right
    to: join
`;

const loopedJoinWorkflow = `
name: looped-join-demo
version: 1
nodes:
  start:
    type: script
  left:
    type: script
  right:
    type: script
  validate:
    type: script
    waitFor:
      - left
      - right
  review:
    type: review
  fix:
    type: script
  archive:
    type: script
edges:
  - from: start
    to: left
  - from: start
    to: right
  - from: left
    to: validate
  - from: right
    to: validate
  - from: validate
    to: review
  - from: review
    to: fix
    when: outputs.review.verdict == "retry"
  - from: review
    to: archive
    when: outputs.review.verdict == "finish"
  - from: fix
    to: validate
`;

const mutableWorkflow = `
name: mutable-demo
version: 1
nodes:
  start:
    type: script
  mutate:
    type: script
edges:
  - from: start
    to: mutate
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

describe("workflow activation scheduler", () => {
	it("runs a linear graph in edge order", async () => {
		const definition = parseWorkflowDefinition(linearWorkflow, { sourcePath: "workflow.yml" });
		const executed: string[] = [];

		const result = await runWorkflowScheduler(definition, {
			startNodeId: "start",
			executeNode: async activation => {
				executed.push(activation.nodeId);
				return { summary: `ran ${activation.nodeId}` };
			},
		});

		expect(executed).toEqual(["start", "review"]);
		expect(result.activations.map(activation => [activation.nodeId, activation.status])).toEqual([
			["start", "completed"],
			["review", "completed"],
		]);
		expect(result.activations[1]?.parentActivationIds).toEqual([result.activations[0]?.id]);
	});

	it("follows only true conditional edges", async () => {
		const definition = parseWorkflowDefinition(conditionalWorkflow, { sourcePath: "workflow.yml" });

		const result = await runWorkflowScheduler(definition, {
			startNodeId: "review",
			initialState: { verdict: "continue" },
			executeNode: async activation => ({ summary: `ran ${activation.nodeId}` }),
		});

		expect(result.activations.map(activation => activation.nodeId)).toEqual(["review", "build"]);
	});

	it("applies activation state patches before evaluating outgoing edges", async () => {
		const definition = parseWorkflowDefinition(conditionalWorkflow, { sourcePath: "workflow.yml" });

		const result = await runWorkflowScheduler(definition, {
			startNodeId: "review",
			executeNode: async activation => ({
				summary: `ran ${activation.nodeId}`,
				statePatch:
					activation.nodeId === "review" ? [{ op: "set", path: "/verdict", value: "continue" }] : undefined,
			}),
		});

		expect(result.activations.map(activation => activation.nodeId)).toEqual(["review", "build"]);
		expect(result.state).toEqual({ verdict: "continue" });
	});

	it("evaluates outgoing edge conditions against the latest structured node outputs", async () => {
		const definition = parseWorkflowDefinition(outputConditionalWorkflow, { sourcePath: "workflow.yml" });
		let reviewCount = 0;

		const result = await runWorkflowScheduler(definition, {
			startNodeId: "build",
			executeNode: async activation => {
				if (activation.nodeId !== "review") {
					return { summary: `ran ${activation.nodeId}` };
				}
				reviewCount += 1;
				return {
					summary: `review ${reviewCount}`,
					data: { verdict: reviewCount === 1 ? "continue" : "finish" },
				};
			},
		});

		expect(result.activations.map(activation => activation.nodeId)).toEqual([
			"build",
			"review",
			"build",
			"review",
			"finish",
		]);
		expect(result.activations.findLast(activation => activation.nodeId === "review")?.output?.data).toEqual({
			verdict: "finish",
		});
	});

	it("fails activations that write outside declared state scopes", async () => {
		const definition = parseWorkflowDefinition(conditionalWorkflow, { sourcePath: "workflow.yml" });

		const result = await runWorkflowScheduler(definition, {
			startNodeId: "review",
			executeNode: async () => ({
				summary: "attempted private write",
				statePatch: [{ op: "set", path: "/private/token", value: "secret" }],
			}),
		});

		expect(result.activations.map(activation => [activation.nodeId, activation.status])).toEqual([
			["review", "failed"],
		]);
		expect(result.activations[0]?.error).toBe('workflow state write to "/private/token" is not allowed');
		expect(result.state).toEqual({});
	});

	it("fails activations that violate the workflow state schema", async () => {
		const definition = parseWorkflowDefinition(
			`
name: schema-demo
version: 1
stateSchema:
  version: 1
  shape:
    verdict: string
nodes:
  review:
    type: review
    writes:
      - /verdict
edges: []
`,
			{ sourcePath: "workflow.yml" },
		);

		const result = await runWorkflowScheduler(definition, {
			startNodeId: "review",
			executeNode: async () => ({
				summary: "attempted invalid verdict write",
				statePatch: [{ op: "set", path: "/verdict", value: { status: "continue" } }],
			}),
		});

		expect(result.activations.map(activation => [activation.nodeId, activation.status])).toEqual([
			["review", "failed"],
		]);
		expect(result.activations[0]?.error).toBe(
			'workflow state schema rejects write to "/verdict": expected string, received object',
		);
		expect(result.state).toEqual({});
	});

	it("creates separate activations for loops and stops at the activation limit", async () => {
		const definition = parseWorkflowDefinition(loopWorkflow, { sourcePath: "workflow.yml" });

		const result = await runWorkflowScheduler(definition, {
			startNodeId: "build",
			maxActivations: 3,
			executeNode: async activation => ({ summary: `ran ${activation.nodeId}` }),
		});

		expect(result.activations.map(activation => activation.nodeId)).toEqual(["build", "review", "build"]);
		expect(new Set(result.activations.map(activation => activation.id)).size).toBe(3);
		expect(result.limitReached).toBe(true);
	});

	it("stops before exceeding the per-node activation limit", async () => {
		const definition = parseWorkflowDefinition(loopWorkflow, { sourcePath: "workflow.yml" });

		const result = await runWorkflowScheduler(definition, {
			startNodeId: "build",
			maxActivations: 5,
			maxNodeActivations: 1,
			executeNode: async activation => ({ summary: `ran ${activation.nodeId}` }),
		});

		expect(result.activations.map(activation => activation.nodeId)).toEqual(["build", "review"]);
		expect(result.limitReached).toBe(true);
	});

	it("activates explicit joins after all declared parents complete", async () => {
		const definition = parseWorkflowDefinition(joinWorkflow, { sourcePath: "workflow.yml" });

		const result = await runWorkflowScheduler(definition, {
			startNodeId: "start",
			executeNode: async activation => ({ summary: `ran ${activation.nodeId}` }),
		});

		expect(result.activations.map(activation => activation.nodeId)).toEqual(["start", "left", "right", "join"]);
		const join = result.activations.find(activation => activation.nodeId === "join");
		const left = result.activations.find(activation => activation.nodeId === "left");
		const right = result.activations.find(activation => activation.nodeId === "right");
		if (!join || !left || !right) {
			throw new Error("expected join, left, and right activations");
		}
		expect(join.parentActivationIds).toEqual([left.id, right.id]);
	});

	it("starts ready sibling activations concurrently before waiting for either to finish", async () => {
		const definition = parseWorkflowDefinition(joinWorkflow, { sourcePath: "workflow.yml" });
		const leftStarted = Promise.withResolvers<void>();
		const rightStarted = Promise.withResolvers<void>();
		const releaseLeft = Promise.withResolvers<void>();
		const releaseRight = Promise.withResolvers<void>();
		const started: string[] = [];
		const resultPromise = runWorkflowScheduler(definition, {
			startNodeId: "start",
			executeNode: async activation => {
				started.push(activation.nodeId);
				if (activation.nodeId === "left") {
					leftStarted.resolve();
					await releaseLeft.promise;
				}
				if (activation.nodeId === "right") {
					rightStarted.resolve();
					await releaseRight.promise;
				}
				return { summary: `ran ${activation.nodeId}` };
			},
		});

		await leftStarted.promise;
		const secondSibling = await Promise.race([
			rightStarted.promise.then(() => "right-started"),
			Bun.sleep(20).then(() => "timeout"),
		]);
		let failure: unknown;
		try {
			expect(secondSibling).toBe("right-started");
		} catch (error) {
			failure = error;
		}
		releaseLeft.resolve();
		releaseRight.resolve();
		const result = await resultPromise;
		if (failure !== undefined) throw failure;

		expect(started.slice(0, 3)).toEqual(["start", "left", "right"]);
		expect(result.activations.map(activation => activation.nodeId)).toEqual(["start", "left", "right", "join"]);
	});

	it("re-activates a join when a loop edge returns from outside its waitFor set", async () => {
		const definition = parseWorkflowDefinition(loopedJoinWorkflow, { sourcePath: "workflow.yml" });
		let reviewCount = 0;

		const result = await runWorkflowScheduler(definition, {
			startNodeId: "start",
			executeNode: async activation => {
				if (activation.nodeId !== "review") return { summary: `ran ${activation.nodeId}` };
				reviewCount += 1;
				return {
					summary: `review ${reviewCount}`,
					data: { verdict: reviewCount === 1 ? "retry" : "finish" },
				};
			},
		});

		expect(result.activations.map(activation => activation.nodeId)).toEqual([
			"start",
			"left",
			"right",
			"validate",
			"review",
			"fix",
			"validate",
			"review",
			"archive",
		]);
		const secondValidate = result.activations.filter(activation => activation.nodeId === "validate")[1];
		const left = result.activations.find(activation => activation.nodeId === "left");
		const right = result.activations.find(activation => activation.nodeId === "right");
		const fix = result.activations.find(activation => activation.nodeId === "fix");
		if (!secondValidate || !left || !right || !fix) {
			throw new Error("expected looped join activations to exist");
		}
		expect(secondValidate.parentActivationIds).toEqual([left.id, right.id, fix.id]);
	});

	it("stops scheduling downstream nodes after parallel activations observe cancellation", async () => {
		const definition = parseWorkflowDefinition(
			`
name: parallel-stop-demo
version: 1
nodes:
  start:
    type: script
  left:
    type: script
  right:
    type: script
  afterLeft:
    type: script
  afterRight:
    type: script
edges:
  - from: start
    to: left
  - from: start
    to: right
  - from: left
    to: afterLeft
  - from: right
    to: afterRight
`,
			{ sourcePath: "workflow.yml" },
		);
		const controller = new AbortController();
		const leftStarted = Promise.withResolvers<void>();
		const rightStarted = Promise.withResolvers<void>();
		const releaseBranches = Promise.withResolvers<void>();

		const resultPromise = runWorkflowScheduler(definition, {
			startNodeId: "start",
			signal: controller.signal,
			executeNode: async activation => {
				if (activation.nodeId === "left") leftStarted.resolve();
				if (activation.nodeId === "right") rightStarted.resolve();
				if (activation.nodeId === "left" || activation.nodeId === "right") {
					await releaseBranches.promise;
				}
				return { summary: `ran ${activation.nodeId}` };
			},
		});

		await leftStarted.promise;
		const secondSibling = await Promise.race([
			rightStarted.promise.then(() => "right-started"),
			Bun.sleep(20).then(() => "timeout"),
		]);
		let failure: unknown;
		try {
			expect(secondSibling).toBe("right-started");
		} catch (error) {
			failure = error;
		}
		controller.abort("user stopped workflow");
		releaseBranches.resolve();
		const result = await resultPromise;
		if (failure !== undefined) throw failure;

		expect(result.activations.map(activation => [activation.nodeId, activation.status])).toEqual([
			["start", "completed"],
			["left", "completed"],
			["right", "completed"],
		]);
		expect(result.frontierNodeIds).toEqual(["afterLeft", "afterRight"]);
	});

	it("returns frontier without starting downstream activations when cancellation follows completion", async () => {
		const definition = parseWorkflowDefinition(linearWorkflow, { sourcePath: "workflow.yml" });
		const controller = new AbortController();
		const executed: string[] = [];

		const result = await runWorkflowScheduler(definition, {
			startNodeId: "start",
			signal: controller.signal,
			executeNode: async activation => {
				executed.push(activation.nodeId);
				controller.abort("user cancelled workflow");
				return { summary: `ran ${activation.nodeId}` };
			},
		});

		expect(executed).toEqual(["start"]);
		expect(result.activations.map(activation => [activation.nodeId, activation.status, activation.error])).toEqual([
			["start", "completed", undefined],
		]);
		expect(result.frontierNodeIds).toEqual(["review"]);
	});

	it("fails active-run graph patch attempts without changing the run graph", async () => {
		const host = createHost();
		const definition = parseWorkflowDefinition(mutableWorkflow, { sourcePath: "workflow.yml" });
		const run = startWorkflowRun(host, definition, { runId: "run-1" });

		const result = await runWorkflowScheduler(run.definition, {
			startNodeId: "start",
			graphRevisionId: run.currentGraphRevisionId,
			executeNode: async activation => {
				if (activation.nodeId === "mutate") {
					applyWorkflowGraphPatchToRun(
						host,
						run,
						[
							{ op: "add_node", node: { id: "finish", type: "script" } },
							{ op: "add_edge", edge: { from: "mutate", to: "finish" } },
						],
						{
							actor: "supervisor",
							graphRevisionId: "run-1:graph-1",
							reason: "add finish node",
						},
					);
				}
				return { summary: `ran ${activation.nodeId}` };
			},
		});

		expect(result.activations.map(activation => [activation.nodeId, activation.status])).toEqual([
			["start", "completed"],
			["mutate", "failed"],
		]);
		expect(result.activations[1]?.error).toBe(
			"workflow graph patches cannot be applied to an active run; stop, checkpoint, freeze, and restart the workflow instead",
		);
		expect(result.activations.map(activation => activation.graphRevisionId)).toEqual([
			"run-1:graph-0",
			"run-1:graph-0",
		]);
		expect(run.currentGraphRevisionId).toBe("run-1:graph-0");
		expect(run.definition.nodes.map(node => node.id)).toEqual(["start", "mutate"]);
	});
});
