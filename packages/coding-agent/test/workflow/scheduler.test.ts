import { describe, expect, it } from "bun:test";
import { parseWorkflowDefinition } from "../../src/workflow/definition";
import { applyWorkflowGraphPatchToRun } from "../../src/workflow/patches";
import { startWorkflowRun, type WorkflowRunStoreHost } from "../../src/workflow/run-store";
import { runWorkflowScheduler, type WorkflowActivation } from "../../src/workflow/scheduler";
import type { WorkflowActivationOutput } from "../../src/workflow/state";

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

const mappedPoolWorkflow = `
name: mapped-pool-demo
version: 1
nodes:
  pool:
    type: mapped_pool
    mappedPool:
      itemSource: /queue
      itemKey: /id
      maxConcurrency: 5
      maxItems: 6
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
`;

const mappedPoolWithFinishWorkflow = `
name: mapped-pool-finish-demo
version: 1
nodes:
  pool:
    type: mapped_pool
    mappedPool:
      itemSource: /queue
      itemKey: /id
      maxConcurrency: 5
      maxItems: 6
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
  finish:
    type: script
edges:
  - from: pool
    to: finish
`;
const mappedPoolMaxItemsWorkflow = `
name: mapped-pool-maxitems-demo
version: 1
nodes:
  pool:
    type: mapped_pool
    mappedPool:
      itemSource: /queue
      itemKey: /id
      maxConcurrency: 5
      maxItems: 2
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
`;

const mappedPoolStopWhenWorkflow = `
name: mapped-pool-stopwhen-demo
version: 1
nodes:
  pool:
    type: mapped_pool
    mappedPool:
      itemSource: /queue
      itemKey: /id
      maxConcurrency: 2
      maxItems: 10
      stopWhen: state.stop == true
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

	it("claims later mapped pool items while earlier items are still in flight", async () => {
		const definition = parseWorkflowDefinition(mappedPoolWorkflow, { sourcePath: "mapped.yml" });
		const resolvers = new Map<string, () => void>();
		const started: Array<{ nodeId: string; itemKey: string; phase: string }> = [];
		const results = new Map<string, unknown>();

		const executeNode = async (activation: WorkflowActivation) => {
			const mapped = activation.mapped;
			const itemKey = mapped?.itemKey ?? "";
			const phase = mapped?.phase ?? "";
			const key = `${activation.nodeId}:${itemKey}:${phase}`;
			started.push({ nodeId: activation.nodeId, itemKey, phase });
			return new Promise<WorkflowActivationOutput>(resolve => {
				resolvers.set(key, () => {
					const value = { summary: `ran ${key}` };
					results.set(key, value);
					resolve(value);
				});
			});
		};

		const schedulerPromise = runWorkflowScheduler(definition, {
			startNodeId: "pool",
			initialState: {
				queue: [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }, { id: "e" }, { id: "f" }],
			},
			executeNode,
		});

		const resolveActivation = (nodeId: string, itemKey: string, phase: string) => {
			const key = `${nodeId}:${itemKey}:${phase}`;
			const resolve = resolvers.get(key);
			if (!resolve) throw new Error(`no resolver for ${key}`);
			resolvers.delete(key);
			resolve();
		};

		await Bun.sleep(0);
		expect(started.filter(s => s.nodeId === "pool.worker").map(s => s.itemKey)).toEqual(["a", "b", "c", "d", "e"]);

		resolveActivation("pool.worker", "a", "worker");
		resolveActivation("pool.worker", "b", "worker");
		resolveActivation("pool.worker", "c", "worker");
		resolveActivation("pool.worker", "d", "worker");
		resolveActivation("pool.worker", "e", "worker");
		await Bun.sleep(0);
		expect(
			started
				.filter(s => s.nodeId === "pool.verifier")
				.map(s => s.itemKey)
				.sort(),
		).toEqual(["a", "b", "c", "d", "e"]);

		resolveActivation("pool.verifier", "a", "verifier");
		await Bun.sleep(0);
		resolveActivation("pool.reducer", "a", "reducer");
		await Bun.sleep(0);

		expect(started.some(s => s.nodeId === "pool.worker" && s.itemKey === "f")).toBe(true);
		expect(resolvers.has("pool.verifier:b:verifier")).toBe(true);
		expect(resolvers.has("pool.verifier:c:verifier")).toBe(true);
		expect(resolvers.has("pool.verifier:d:verifier")).toBe(true);
		expect(resolvers.has("pool.verifier:e:verifier")).toBe(true);

		for (const itemKey of ["b", "c", "d", "e"]) {
			resolveActivation("pool.verifier", itemKey, "verifier");
			await Bun.sleep(0);
			resolveActivation("pool.reducer", itemKey, "reducer");
			await Bun.sleep(0);
		}
		resolveActivation("pool.worker", "f", "worker");
		await Bun.sleep(0);
		resolveActivation("pool.verifier", "f", "verifier");
		await Bun.sleep(0);
		resolveActivation("pool.reducer", "f", "reducer");

		const result = await schedulerPromise;
		expect(result.activations.filter(a => a.status === "failed")).toHaveLength(0);
		expect(result.activations.filter(a => a.status === "completed" && a.nodeId === "pool.reducer")).toHaveLength(6);
	});

	it("records static pool node id and runtime pool activation id separately", async () => {
		const definition = parseWorkflowDefinition(mappedPoolWorkflow, { sourcePath: "mapped.yml" });
		const result = await runWorkflowScheduler(definition, {
			startNodeId: "pool",
			initialState: { queue: [{ id: "a" }] },
			executeNode: async activation => ({ summary: `ran ${activation.nodeId}` }),
		});
		const poolActivation = result.activations.find(a => a.nodeId === "pool");
		const workerActivation = result.activations.find(a => a.nodeId === "pool.worker");
		expect(workerActivation?.mapped?.poolId).toBe("pool");
		expect(workerActivation?.mapped?.poolActivationId).toBe(poolActivation?.id);
	});

	it("starts downstream nodes after a mapped pool completes", async () => {
		const definition = parseWorkflowDefinition(mappedPoolWithFinishWorkflow, { sourcePath: "mapped.yml" });

		const result = await runWorkflowScheduler(definition, {
			startNodeId: "pool",
			initialState: { queue: [{ id: "a" }] },
			executeNode: async activation => ({ summary: `ran ${activation.nodeId}` }),
		});

		expect(result.activations.map(activation => [activation.nodeId, activation.status])).toEqual([
			["pool", "completed"],
			["pool.worker", "completed"],
			["pool.verifier", "completed"],
			["pool.reducer", "completed"],
			["finish", "completed"],
		]);
		const poolActivation = result.activations.find(activation => activation.nodeId === "pool");
		expect(poolActivation).toBeDefined();
		expect(result.activations.find(activation => activation.nodeId === "finish")?.parentActivationIds).toEqual([
			poolActivation!.id,
		]);
		expect(poolActivation!.output?.summary).toContain('mapped pool "pool" completed 1 item(s)');
		expect(poolActivation!.output?.data).toBeUndefined();
	});

	it("starts downstream nodes when a mapped pool has an empty queue", async () => {
		const definition = parseWorkflowDefinition(mappedPoolWithFinishWorkflow, { sourcePath: "mapped.yml" });

		const result = await runWorkflowScheduler(definition, {
			startNodeId: "pool",
			initialState: { queue: [] },
			executeNode: async activation => ({ summary: `ran ${activation.nodeId}` }),
		});

		expect(result.activations.map(activation => [activation.nodeId, activation.status])).toEqual([
			["pool", "completed"],
			["finish", "completed"],
		]);
		const poolActivation = result.activations.find(activation => activation.nodeId === "pool");
		expect(poolActivation).toBeDefined();
		expect(result.activations.find(activation => activation.nodeId === "finish")?.parentActivationIds).toEqual([
			poolActivation!.id,
		]);
		expect(poolActivation!.output?.summary).toContain('mapped pool "pool" completed 0 item(s)');
		expect(poolActivation!.output?.data).toBeUndefined();
	});
	it("does not schedule downstream nodes when a mapped pool fails", async () => {
		const definition = parseWorkflowDefinition(mappedPoolWithFinishWorkflow, { sourcePath: "mapped.yml" });
		const result = await runWorkflowScheduler(definition, {
			startNodeId: "pool",
			initialState: { queue: [{ id: "a" }] },
			executeNode: async activation => {
				if (activation.mapped?.phase === "verifier") {
					throw new Error("verifier crashed");
				}
				return { summary: `ran ${activation.nodeId}` };
			},
		});

		const poolActivation = result.activations.find(activation => activation.nodeId === "pool");
		expect(poolActivation?.status).toBe("failed");
		expect(result.activations.find(activation => activation.nodeId === "finish")).toBeUndefined();
	});

	it("settles mapped activations that finish after their parent pool fails", async () => {
		const definition = parseWorkflowDefinition(mappedPoolWorkflow, { sourcePath: "mapped.yml" });
		let resolveVerifierB: (() => void) | undefined;
		const schedulerPromise = runWorkflowScheduler(definition, {
			startNodeId: "pool",
			initialState: { queue: [{ id: "a" }, { id: "b" }] },
			executeNode: async activation => {
				if (activation.mapped?.phase === "verifier" && activation.mapped.itemKey === "a") {
					throw new Error("verifier crashed");
				}
				if (activation.mapped?.phase === "verifier" && activation.mapped.itemKey === "b") {
					return new Promise<WorkflowActivationOutput>(resolve => {
						resolveVerifierB = () => resolve({ summary: "verifier b done" });
					});
				}
				return { summary: `ran ${activation.nodeId}` };
			},
		});
		while (resolveVerifierB === undefined) {
			await Bun.sleep(0);
		}
		await Bun.sleep(0);
		resolveVerifierB();
		const result = await schedulerPromise;
		expect(result.activations.find(a => a.nodeId === "pool")?.status).toBe("failed");
		expect(result.activations.filter(a => a.status === "running")).toHaveLength(0);
	});

	it("fails pool activation when itemSource resolves to a non-array", async () => {
		const definition = parseWorkflowDefinition(mappedPoolWorkflow, { sourcePath: "mapped.yml" });
		const result = await runWorkflowScheduler(definition, {
			startNodeId: "pool",
			initialState: { queue: "not-an-array" },
			executeNode: async () => ({ summary: "should not run" }),
		});
		const poolActivation = result.activations.find(a => a.nodeId === "pool");
		expect(poolActivation?.status).toBe("failed");
		expect(poolActivation?.error).toContain("must resolve to an array");
		expect(result.activations.filter(a => a.nodeId === "pool.worker")).toHaveLength(0);
	});

	it("fails pool activation on duplicate item keys in the source array", async () => {
		const definition = parseWorkflowDefinition(mappedPoolWorkflow, { sourcePath: "mapped.yml" });
		const result = await runWorkflowScheduler(definition, {
			startNodeId: "pool",
			initialState: { queue: [{ id: "a" }, { id: "a" }] },
			executeNode: async () => ({ summary: "should not run" }),
		});
		const poolActivation = result.activations.find(a => a.nodeId === "pool");
		expect(poolActivation?.status).toBe("failed");
		expect(poolActivation?.error).toContain("duplicate item key");
	});
	it("fails pool activation on non-contiguous duplicate item keys", async () => {
		const definition = parseWorkflowDefinition(mappedPoolWorkflow, { sourcePath: "mapped.yml" });
		const result = await runWorkflowScheduler(definition, {
			startNodeId: "pool",
			initialState: { queue: [{ id: "a" }, { id: "b" }, { id: "a" }] },
			executeNode: async () => ({ summary: "should not run" }),
		});
		const poolActivation = result.activations.find(a => a.nodeId === "pool");
		expect(poolActivation?.status).toBe("failed");
		expect(poolActivation?.error).toContain("duplicate item key");
		expect(result.activations.filter(a => a.nodeId === "pool.worker")).toHaveLength(2);
	});
	it("fails pool activation when an item key is empty or non-string", async () => {
		const definition = parseWorkflowDefinition(mappedPoolWorkflow, { sourcePath: "mapped.yml" });

		for (const queue of [[{ id: "" }], [{ id: 123 }], [{ id: null }]]) {
			const result = await runWorkflowScheduler(definition, {
				startNodeId: "pool",
				initialState: { queue },
				executeNode: async () => ({ summary: "should not run" }),
			});
			const poolActivation = result.activations.find(a => a.nodeId === "pool");
			expect(poolActivation?.status).toBe("failed");
			expect(poolActivation?.error).toContain("invalid itemKey");
			expect(result.activations.filter(a => a.nodeId === "pool.worker")).toHaveLength(0);
		}
	});

	it("fails parent pool when an internal verifier activation fails", async () => {
		const definition = parseWorkflowDefinition(mappedPoolWorkflow, { sourcePath: "mapped.yml" });
		const result = await runWorkflowScheduler(definition, {
			startNodeId: "pool",
			initialState: { queue: [{ id: "a" }] },
			executeNode: async activation => {
				if (activation.mapped?.phase === "verifier") {
					throw new Error("verifier crashed");
				}
				return { summary: `ran ${activation.nodeId}` };
			},
		});
		const poolActivation = result.activations.find(a => a.nodeId === "pool");
		expect(poolActivation?.status).toBe("failed");
		expect(poolActivation?.error).toContain('verifier for item "a" failed');
		const reducerActivations = result.activations.filter(a => a.nodeId === "pool.reducer");
		expect(reducerActivations).toHaveLength(0);
	});

	it("seeds mapped pool progress from completed activations and does not re-run completed items", async () => {
		const definition = parseWorkflowDefinition(mappedPoolWorkflow, { sourcePath: "mapped.yml" });
		const firstResult = await runWorkflowScheduler(definition, {
			startNodeId: "pool",
			initialState: { queue: [{ id: "a" }, { id: "b" }] },
			executeNode: async activation => {
				if (activation.mapped?.phase === "verifier") {
					return { summary: "verified", data: { verdict: "continue" } };
				}
				return { summary: `ran ${activation.nodeId}` };
			},
		});

		const completedActivations = firstResult.activations.filter(activation => activation.status === "completed");
		const firstPoolActivation = firstResult.activations.find(activation => activation.nodeId === "pool");
		expect(firstPoolActivation?.status).toBe("completed");

		const secondResult = await runWorkflowScheduler(definition, {
			startNodeId: "pool",
			startNodeIds: ["pool"],
			initialState: { queue: [{ id: "a" }, { id: "b" }] },
			completedActivations,
			executeNode: async activation => {
				throw new Error(`should not re-run ${activation.nodeId} for item ${activation.mapped?.itemKey ?? ""}`);
			},
		});

		const secondPoolActivation = secondResult.activations.find(activation => activation.nodeId === "pool");
		expect(secondPoolActivation?.status).toBe("completed");
		const newMappedActivations = secondResult.activations.filter(
			activation => activation.mapped !== undefined && activation.nodeId !== "pool",
		);
		expect(newMappedActivations).toHaveLength(0);
		expect(secondResult.limitReached).toBe(false);
	});
	it("fails closed when mapped pool queue exceeds maxItems", async () => {
		const definition = parseWorkflowDefinition(mappedPoolMaxItemsWorkflow, { sourcePath: "mapped.yml" });
		const result = await runWorkflowScheduler(definition, {
			startNodeId: "pool",
			initialState: { queue: [{ id: "a" }, { id: "b" }, { id: "c" }] },
			executeNode: async () => ({ summary: "ran" }),
		});
		const poolActivation = result.activations.find(a => a.nodeId === "pool");
		expect(poolActivation?.status).toBe("failed");
		expect(poolActivation?.error).toContain("exceeded maxItems 2");
		expect(result.activations.filter(a => a.nodeId === "pool.worker")).toHaveLength(2);
	});
	it("fails closed on restart when queue growth exceeds maxItems accounting for completed items", async () => {
		const definition = parseWorkflowDefinition(mappedPoolMaxItemsWorkflow, { sourcePath: "mapped.yml" });
		const firstResult = await runWorkflowScheduler(definition, {
			startNodeId: "pool",
			initialState: { queue: [{ id: "a" }, { id: "b" }] },
			executeNode: async activation => {
				if (activation.mapped?.phase === "verifier") {
					return { summary: "verified", data: { verdict: "continue" } };
				}
				return { summary: `ran ${activation.nodeId}` };
			},
		});

		const completedActivations = firstResult.activations.filter(activation => activation.status === "completed");

		const secondResult = await runWorkflowScheduler(definition, {
			startNodeId: "pool",
			startNodeIds: ["pool"],
			initialState: { queue: [{ id: "a" }, { id: "b" }, { id: "c" }] },
			completedActivations,
			executeNode: async () => {
				throw new Error("should not run additional mapped items");
			},
		});

		const poolActivation = secondResult.activations.find(a => a.nodeId === "pool");
		expect(poolActivation?.status).toBe("failed");
		expect(poolActivation?.error).toContain("exceeded maxItems 2");
		expect(secondResult.activations.filter(a => a.nodeId === "pool.worker")).toHaveLength(0);
	});

	it("completes stopWhen pool only after in-flight activations settle", async () => {
		const definition = parseWorkflowDefinition(mappedPoolStopWhenWorkflow, { sourcePath: "mapped.yml" });
		let resolveWorkerB: (() => void) | undefined;
		const schedulerPromise = runWorkflowScheduler(definition, {
			startNodeId: "pool",
			initialState: { queue: [{ id: "a" }, { id: "b" }], stop: true },
			executeNode: async activation => {
				if (activation.mapped?.phase === "worker" && activation.mapped.itemKey === "b") {
					await new Promise<void>(resolve => {
						resolveWorkerB = resolve;
					});
				}
				if (activation.mapped?.phase === "verifier") {
					return { summary: "verified", data: { verdict: "continue" } };
				}
				return { summary: `ran ${activation.nodeId}` };
			},
		});
		while (resolveWorkerB === undefined) {
			await Bun.sleep(0);
		}
		await Bun.sleep(0);
		const poolCompletedEarly = await Promise.race([
			schedulerPromise.then(() => true),
			Bun.sleep(50).then(() => false),
		]);
		expect(poolCompletedEarly).toBe(false);
		resolveWorkerB!();
		const result = await schedulerPromise;
		const poolActivation = result.activations.find(a => a.nodeId === "pool");
		expect(poolActivation?.status).toBe("completed");
		expect(result.activations.filter(a => a.status === "completed" && a.nodeId === "pool.reducer")).toHaveLength(2);
	});
	it("emits mapped pool lifecycle callbacks when the pool completes", async () => {
		const definition = parseWorkflowDefinition(mappedPoolWithFinishWorkflow, { sourcePath: "mapped.yml" });
		const started: Array<{ activation: WorkflowActivation; nodeId: string }> = [];
		const completed: Array<{ activation: WorkflowActivation; output: WorkflowActivationOutput }> = [];
		const failed: Array<{ activation: WorkflowActivation; error: string }> = [];

		const result = await runWorkflowScheduler(definition, {
			startNodeId: "pool",
			initialState: { queue: [{ id: "a" }] },
			executeNode: async activation => ({ summary: `ran ${activation.nodeId}` }),
			onMappedPoolActivationStarted: (activation, node) => started.push({ activation, nodeId: node.id }),
			onMappedPoolActivationCompleted: (activation, output) => completed.push({ activation, output }),
			onMappedPoolActivationFailed: (activation, error) => failed.push({ activation, error }),
		});

		const poolActivation = result.activations.find(a => a.nodeId === "pool");
		expect(poolActivation).toBeDefined();
		expect(started).toHaveLength(1);
		expect(started[0].nodeId).toBe("pool");
		expect(started[0].activation.id).toBe(poolActivation!.id);
		expect(completed).toHaveLength(1);
		expect(completed[0].activation.id).toBe(poolActivation!.id);
		expect(completed[0].output.summary).toContain('mapped pool "pool" completed 1 item(s)');
		expect(failed).toHaveLength(0);
	});

	it("emits mapped pool failure callback when an internal verifier crashes", async () => {
		const definition = parseWorkflowDefinition(mappedPoolWorkflow, { sourcePath: "mapped.yml" });
		const failed: Array<{ activation: WorkflowActivation; error: string }> = [];

		const result = await runWorkflowScheduler(definition, {
			startNodeId: "pool",
			initialState: { queue: [{ id: "a" }] },
			executeNode: async activation => {
				if (activation.mapped?.phase === "verifier") {
					throw new Error("verifier crashed");
				}
				return { summary: "ran" };
			},
			onMappedPoolActivationFailed: (activation, error) => failed.push({ activation, error }),
		});

		expect(failed).toHaveLength(1);
		expect(failed[0].activation.nodeId).toBe("pool");
		expect(failed[0].error).toContain('verifier for item "a" failed');
		const poolActivation = result.activations.find(a => a.nodeId === "pool");
		expect(poolActivation?.status).toBe("failed");
	});

	it("resumes worker-only checkpoint by scheduling verifier and reducer without re-running worker", async () => {
		const definition = parseWorkflowDefinition(mappedPoolWorkflow, { sourcePath: "mapped.yml" });
		const firstResult = await runWorkflowScheduler(definition, {
			startNodeId: "pool",
			initialState: { queue: [{ id: "a" }] },
			executeNode: async activation => {
				if (activation.mapped?.phase === "worker") {
					return { summary: "worker done" };
				}
				throw new Error(`should not run ${activation.nodeId} in first run`);
			},
		});

		const completedActivations = firstResult.activations.filter(activation => activation.status === "completed");
		const secondResult = await runWorkflowScheduler(definition, {
			startNodeId: "pool",
			startNodeIds: ["pool"],
			initialState: { queue: [{ id: "a" }] },
			completedActivations,
			executeNode: async activation => {
				if (activation.mapped?.phase === "worker") {
					throw new Error("should not re-run worker for partially completed item");
				}
				if (activation.mapped?.phase === "verifier") {
					return { summary: "verified", data: { verdict: "continue" } };
				}
				return { summary: "reducer done" };
			},
		});

		const poolActivation = secondResult.activations.find(a => a.nodeId === "pool");
		expect(poolActivation?.status).toBe("completed");
		expect(
			secondResult.activations.filter(a => a.nodeId === "pool.verifier" && a.status === "completed"),
		).toHaveLength(1);
		expect(
			secondResult.activations.filter(a => a.nodeId === "pool.reducer" && a.status === "completed"),
		).toHaveLength(1);
	});

	it("resumes worker-and-verifier checkpoint by scheduling reducer without re-running worker or verifier", async () => {
		const definition = parseWorkflowDefinition(mappedPoolWorkflow, { sourcePath: "mapped.yml" });
		const completedActivations: WorkflowActivation[] = [
			{
				id: "activation-1",
				nodeId: "pool",
				graphRevisionId: "graph-1",
				status: "completed",
				parentActivationIds: [],
			},
			{
				id: "activation-2",
				nodeId: "pool.worker",
				graphRevisionId: "graph-1",
				status: "completed",
				parentActivationIds: ["activation-1"],
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
				graphRevisionId: "graph-1",
				status: "completed",
				parentActivationIds: ["activation-1"],
				output: { summary: "verified", data: { verdict: "continue" } },
				mapped: {
					poolId: "pool",
					poolActivationId: "activation-1",
					itemKey: "a",
					item: { id: "a" },
					phase: "verifier",
					workerActivationId: "activation-2",
				},
			},
		];

		const secondResult = await runWorkflowScheduler(definition, {
			startNodeId: "pool",
			startNodeIds: ["pool"],
			initialState: { queue: [{ id: "a" }] },
			completedActivations,
			executeNode: async activation => {
				if (activation.mapped?.phase === "worker" || activation.mapped?.phase === "verifier") {
					throw new Error("should not re-run worker or verifier for partially completed item");
				}
				return { summary: "reducer resumed" };
			},
		});

		const poolActivation = secondResult.activations.find(a => a.nodeId === "pool");
		expect(poolActivation?.status).toBe("completed");
		const reducers = secondResult.activations.filter(a => a.nodeId === "pool.reducer" && a.status === "completed");
		expect(reducers).toHaveLength(1);
		expect(reducers[0]?.mapped?.workerActivationId).toBe("activation-2");
		expect(reducers[0]?.mapped?.verifierActivationId).toBe("activation-3");
		expect(secondResult.activations.filter(a => a.mapped !== undefined && a.nodeId !== "pool")).toHaveLength(1);
	});

	it("aborts mapped pool without failing when a child activation is aborted", async () => {
		const definition = parseWorkflowDefinition(mappedPoolWorkflow, { sourcePath: "mapped.yml" });
		const started: Array<{ activation: WorkflowActivation; nodeId: string }> = [];
		const aborted: Array<{ activation: WorkflowActivation; reason: string }> = [];
		const failed: Array<{ activation: WorkflowActivation; error: string }> = [];

		const result = await runWorkflowScheduler(definition, {
			startNodeId: "pool",
			initialState: { queue: [{ id: "a" }] },
			executeNode: async activation => {
				if (activation.mapped?.phase === "worker") {
					return { summary: "worker done" };
				}
				throw new Error("should not reach verifier before abort");
			},
			nodeAbortSignalForActivation: activation =>
				activation.mapped?.phase === "verifier" ? AbortSignal.abort("test abort") : undefined,
			onMappedPoolActivationStarted: (activation, node) => started.push({ activation, nodeId: node.id }),
			onMappedPoolActivationAborted: (activation, reason) => aborted.push({ activation, reason }),
			onMappedPoolActivationFailed: (activation, error) => failed.push({ activation, error }),
		});

		const poolActivation = result.activations.find(a => a.nodeId === "pool");
		expect(poolActivation?.status).toBe("aborted");
		expect(aborted).toHaveLength(1);
		expect(aborted[0].activation.nodeId).toBe("pool");
		expect(failed).toHaveLength(0);
		expect(result.stopped).toBe(true);
	});
});
