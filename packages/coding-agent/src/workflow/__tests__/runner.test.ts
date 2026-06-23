import { describe, expect, it } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { WorkflowDefinition } from "../definition";
import type { FlowFreeze } from "../freeze";
import type { RuntimeBindingSnapshot, WorkflowLifecycleBranchEntry } from "../lifecycle";
import { reconstructWorkflowFamilies, WORKFLOW_LIFECYCLE_EVENT_TYPE } from "../lifecycle";
import type { WorkflowNodeRuntimeHost } from "../node-runtime";
import { reconstructWorkflowRuns } from "../run-store";
import { runWorkflow } from "../runner";
import type { WorkflowActivation, WorkflowMappedActivationContext } from "../scheduler";

describe("runWorkflow lifecycle", () => {
	it("creates a restartable checkpoint when an activation fails", async () => {
		const host = new MemoryWorkflowHost();
		const definition = failureRecoveryDefinition();
		const freeze = freezeForDefinition(definition);
		let failMiddleNode = true;
		const runtimeHost: WorkflowNodeRuntimeHost = {
			runScriptNode: async input => {
				if (input.node.id === "middle" && failMiddleNode) {
					throw new Error("middle exploded");
				}
				if (input.node.id === "setup") {
					return {
						summary: "setup complete",
						statePatch: [{ op: "set", path: "/ready", value: true }],
					};
				}
				if (input.node.id === "middle") {
					return {
						summary: "middle recovered",
						statePatch: [{ op: "set", path: "/middleRecovered", value: true }],
					};
				}
				return {
					summary: "finished",
					statePatch: [{ op: "set", path: "/done", value: true }],
				};
			},
		};

		const firstRun = await runWorkflow({
			host,
			definition,
			runId: "run-1",
			graphRevisionId: "graph-1",
			startNodeId: "setup",
			runtimeHost,
			lifecycle: {
				familyId: "family-1",
				attemptId: "attempt-1",
				freeze,
				runtimeBindingSnapshot: bindingSnapshot("attempt-1:binding-1"),
			},
		});

		const failedFamily = reconstructWorkflowFamilies(host.getBranch())[0]!;
		const failedAttempt = failedFamily.attempts[0]!;
		expect(failedAttempt.status).toBe("failed");
		expect(failedAttempt.error).toContain("middle exploded");
		expect(failedFamily.checkpoints).toHaveLength(1);
		expect(failedFamily.checkpoints[0]).toMatchObject({
			id: "attempt-1:checkpoint-1",
			attemptId: "attempt-1",
			frontierNodeIds: ["middle"],
			state: { ready: true },
			sourceMapping: { middle: "middle" },
		});
		expect(failedFamily.checkpoints[0]!.completedActivationIds).toEqual(["activation-1"]);

		failMiddleNode = false;
		const completedActivations = firstRun.scheduler.activations.filter(
			(activation): activation is WorkflowActivation => activation.status === "completed",
		);
		await runWorkflow({
			host,
			definition,
			runId: "run-2",
			graphRevisionId: "graph-2",
			startNodeId: "middle",
			startNodeIds: ["middle"],
			startParentActivationIds: failedFamily.checkpoints[0]!.completedActivationIds,
			initialState: failedFamily.checkpoints[0]!.state,
			completedActivations,
			runtimeHost,
			lifecycle: {
				familyId: "family-1",
				attemptId: "attempt-2",
				checkpointId: failedFamily.checkpoints[0]!.id,
				freeze,
				runtimeBindingSnapshot: bindingSnapshot("attempt-2:binding-1"),
				recordFamily: false,
				recordFreeze: false,
			},
		});

		const recoveredFamily = reconstructWorkflowFamilies(host.getBranch())[0]!;
		const recoveredAttempt = recoveredFamily.attempts[1]!;
		expect(recoveredAttempt.status).toBe("completed");
		expect(recoveredAttempt.checkpointId).toBe("attempt-1:checkpoint-1");
		expect(recoveredAttempt.activations.map(activation => activation.nodeId)).toEqual(["middle", "after"]);
	});

	it("persists mapped pool activation in run-store and lifecycle-store", async () => {
		const host = new MemoryWorkflowHost();
		const definition = mappedPoolDefinition();
		const freeze = freezeForDefinition(definition);
		const runtimeHost: WorkflowNodeRuntimeHost = {
			runAgentNode: async () => ({ summary: "worker done" }),
			runReviewNode: async () => ({ summary: "verifier done", verdict: "continue" }),
			runScriptNode: async () => ({ summary: "reducer done" }),
		};

		await runWorkflow({
			host,
			definition,
			runId: "run-1",
			graphRevisionId: "graph-1",
			startNodeId: "pool",
			initialState: { queue: [{ id: "a" }, { id: "b" }] },
			runtimeHost,
			modelResolution: testModelResolution(),
			lifecycle: {
				familyId: "family-1",
				attemptId: "attempt-1",
				freeze,
				runtimeBindingSnapshot: bindingSnapshot("attempt-1:binding-1"),
			},
		});

		const runs = reconstructWorkflowRuns(host.getBranch());
		expect(runs).toHaveLength(1);
		const run = runs[0]!;
		const runPoolActivation = run.activations.find(activation => activation.nodeId === "pool");
		expect(runPoolActivation).toBeDefined();
		expect(runPoolActivation?.status).toBe("completed");
		expect(runPoolActivation?.mapped).toBeUndefined();

		const family = reconstructWorkflowFamilies(host.getBranch())[0]!;
		const attempt = family.attempts[0]!;
		expect(attempt.status).toBe("completed");
		const lifecyclePoolActivation = attempt.activations.find(activation => activation.nodeId === "pool");
		expect(lifecyclePoolActivation).toBeDefined();
		expect(lifecyclePoolActivation?.status).toBe("completed");
	});
	it("emits lifecycle started/completed events for mapped pool and children", async () => {
		const host = new MemoryWorkflowHost();
		const definition = mappedPoolDefinition();
		const freeze = freezeForDefinition(definition);
		const runtimeHost: WorkflowNodeRuntimeHost = {
			runAgentNode: async () => ({ summary: "worker done" }),
			runReviewNode: async () => ({ summary: "verifier done", verdict: "continue" }),
			runScriptNode: async () => ({ summary: "reducer done" }),
		};

		await runWorkflow({
			host,
			definition,
			runId: "run-1",
			graphRevisionId: "graph-1",
			startNodeId: "pool",
			initialState: { queue: [{ id: "a" }, { id: "b" }] },
			runtimeHost,
			modelResolution: testModelResolution(),
			lifecycle: {
				familyId: "family-1",
				attemptId: "attempt-1",
				freeze,
				runtimeBindingSnapshot: bindingSnapshot("attempt-1:binding-1"),
			},
		});

		const runs = reconstructWorkflowRuns(host.getBranch());
		const run = runs[0]!;
		const poolActivation = run.activations.find(a => a.nodeId === "pool" && a.status === "completed");
		expect(poolActivation).toBeDefined();
		const poolActivationId = poolActivation!.id;

		const lifecycleEvents = host
			.getBranch()
			.filter(
				(entry): entry is { type: "custom"; customType: string; data: Record<string, unknown> } =>
					entry.type === "custom" && entry.customType === WORKFLOW_LIFECYCLE_EVENT_TYPE,
			)
			.map(event => event.data);

		const poolStarted = lifecycleEvents.filter(
			event => event.event === "activation_started" && event.activationId === poolActivationId,
		);
		const poolCompleted = lifecycleEvents.filter(
			event => event.event === "activation_completed" && event.activationId === poolActivationId,
		);
		expect(poolStarted).toHaveLength(1);
		expect(poolCompleted).toHaveLength(1);
		expect(poolCompleted[0]!.output).toMatchObject({
			summary: expect.stringContaining("completed 2 item(s)"),
		});

		const childStarted = lifecycleEvents.filter(
			event =>
				event.event === "activation_started" &&
				event.activationId !== poolActivationId &&
				(event.mapped as WorkflowMappedActivationContext | undefined)?.poolActivationId === poolActivationId,
		);
		expect(childStarted.length).toBe(6);
		const childNodeIds = childStarted.map(event => event.nodeId as string).sort();
		expect(childNodeIds).toEqual([
			"pool.reducer",
			"pool.reducer",
			"pool.verifier",
			"pool.verifier",
			"pool.worker",
			"pool.worker",
		]);

		const poolStartedIndex = lifecycleEvents.findIndex(
			event => event.event === "activation_started" && event.activationId === poolActivationId,
		);
		const poolCompletedIndex = lifecycleEvents.findIndex(
			event => event.event === "activation_completed" && event.activationId === poolActivationId,
		);
		expect(poolStartedIndex).toBeGreaterThanOrEqual(0);
		expect(poolCompletedIndex).toBeGreaterThan(poolStartedIndex);
	});

	it("creates a checkpoint that validates the completed mapped pool activation", async () => {
		const host = new MemoryWorkflowHost();
		const definition = mappedPoolWithFinishDefinition();
		const freeze = freezeForDefinition(definition);
		const failFinish = true;
		const runtimeHost: WorkflowNodeRuntimeHost = {
			runAgentNode: async () => ({ summary: "worker done" }),
			runReviewNode: async () => ({ summary: "verifier done", verdict: "continue" }),
			runScriptNode: async input => {
				if (input.node.id === "pool.reducer") return { summary: "reducer done" };
				if (input.node.id === "finish" && failFinish) throw new Error("finish exploded");
				return { summary: "finish done" };
			},
		};

		const firstRun = await runWorkflow({
			host,
			definition,
			runId: "run-1",
			graphRevisionId: "graph-1",
			startNodeId: "pool",
			initialState: { queue: [{ id: "a" }, { id: "b" }] },
			runtimeHost,
			modelResolution: testModelResolution(),
			lifecycle: {
				familyId: "family-1",
				attemptId: "attempt-1",
				freeze,
				runtimeBindingSnapshot: bindingSnapshot("attempt-1:binding-1"),
			},
		});

		const family = reconstructWorkflowFamilies(host.getBranch())[0]!;
		const attempt = family.attempts[0]!;
		expect(attempt.status).toBe("failed");
		expect(attempt.error).toContain("finish exploded");
		expect(family.checkpoints).toHaveLength(1);
		const checkpoint = family.checkpoints[0]!;
		const poolActivation = firstRun.scheduler.activations.find(
			activation => activation.nodeId === "pool" && activation.status === "completed",
		);
		expect(poolActivation).toBeDefined();
		expect(checkpoint.completedActivationIds).toContain(poolActivation!.id);
		expect(checkpoint.frontierNodeIds).toEqual(["finish"]);
	});
	it("resumes a mapped pool from checkpoint without re-running completed items", async () => {
		const host = new MemoryWorkflowHost();
		const definition = mappedPoolWithFinishDefinition();
		const freeze = freezeForDefinition(definition);
		let failFinish = true;
		const executedPhases = new Set<string>();
		const runtimeHost: WorkflowNodeRuntimeHost = {
			runAgentNode: async input => {
				const itemKey = input.activation.mapped?.itemKey;
				if (itemKey) executedPhases.add(`worker:${itemKey}`);
				return { summary: "worker done" };
			},
			runReviewNode: async () => ({ summary: "verifier done", verdict: "continue" }),
			runScriptNode: async input => {
				if (input.node.id === "pool.reducer") {
					const itemKey = input.activation.mapped?.itemKey;
					if (itemKey) executedPhases.add(`reducer:${itemKey}`);
					return { summary: "reducer done" };
				}
				if (input.node.id === "finish" && failFinish) throw new Error("finish exploded");
				return { summary: "finish done" };
			},
		};

		const firstRun = await runWorkflow({
			host,
			definition,
			runId: "run-1",
			graphRevisionId: "graph-1",
			startNodeId: "pool",
			initialState: { queue: [{ id: "a" }, { id: "b" }] },
			runtimeHost,
			modelResolution: testModelResolution(),
			lifecycle: {
				familyId: "family-1",
				attemptId: "attempt-1",
				freeze,
				runtimeBindingSnapshot: bindingSnapshot("attempt-1:binding-1"),
			},
		});

		const family = reconstructWorkflowFamilies(host.getBranch())[0]!;
		const checkpoint = family.checkpoints[0]!;
		const completedActivations = firstRun.scheduler.activations.filter(
			(activation): activation is WorkflowActivation => activation.status === "completed",
		);
		expect(executedPhases).toContain("worker:a");
		expect(executedPhases).toContain("worker:b");
		expect(executedPhases).toContain("reducer:a");
		expect(executedPhases).toContain("reducer:b");

		failFinish = false;
		const secondRun = await runWorkflow({
			host,
			definition,
			runId: "run-2",
			graphRevisionId: "graph-2",
			startNodeId: "finish",
			startNodeIds: ["finish"],
			startParentActivationIds: checkpoint.completedActivationIds,
			initialState: checkpoint.state,
			completedActivations,
			runtimeHost,
			modelResolution: testModelResolution(),
			lifecycle: {
				familyId: "family-1",
				attemptId: "attempt-2",
				checkpointId: checkpoint.id,
				freeze,
				runtimeBindingSnapshot: bindingSnapshot("attempt-2:binding-1"),
				recordFamily: false,
				recordFreeze: false,
			},
		});

		expect(
			secondRun.scheduler.activations.find(a => a.nodeId === "finish" && a.status === "completed"),
		).toBeDefined();
		const newMappedActivations = secondRun.scheduler.activations.filter(
			a => a.mapped !== undefined && a.nodeId !== "pool",
		);
		expect(newMappedActivations).toHaveLength(0);
	});
	it("aborts an in-flight mapped pool child, checkpoints the stopped attempt, and resumes from the correct phase", async () => {
		const host = new MemoryWorkflowHost();
		const definition = mappedPoolAbortResumeDefinition();
		const freeze = freezeForDefinition(definition);

		// Gate worker "a" so worker "b" completes first and starts verifier "b".
		// Verifier "b" aborts via nodeAbortSignalForActivation, stopping the pool.
		// Worker "a" is released in a macrotask (setTimeout 0) — after the
		// microtask-driven abort chain has marked the pool aborted — so it
		// settles to completed worker-phase-only via
		// settleMappedActivationAfterPoolStopped.  On restart that item must
		// resume at the verifier without re-running the worker.
		let resolveWorkerAGate: () => void = () => {};
		const workerAGate = new Promise<void>(resolve => {
			resolveWorkerAGate = resolve;
		});
		let abortVerifierB = true;
		let workerRunCount = 0;
		let verifierRunCount = 0;
		let reducerRunCount = 0;

		const runtimeHost: WorkflowNodeRuntimeHost = {
			runAgentNode: async input => {
				workerRunCount++;
				const itemKey = input.activation.mapped?.itemKey;
				if (itemKey === "a") {
					await workerAGate;
				}
				return { summary: `worker ${itemKey} done` };
			},
			runReviewNode: async input => {
				verifierRunCount++;
				const itemKey = input.activation.mapped?.itemKey;
				if (abortVerifierB && itemKey === "b") {
					setTimeout(() => resolveWorkerAGate(), 0);
					throw new Error("verifier b aborted");
				}
				return { summary: `verifier ${itemKey} done`, verdict: "continue" };
			},
			runScriptNode: async input => {
				if (input.node.id === "pool.reducer") {
					reducerRunCount++;
				}
				return { summary: "reducer done" };
			},
		};

		const firstRun = await runWorkflow({
			host,
			definition,
			runId: "run-1",
			graphRevisionId: "graph-1",
			startNodeId: "pool",
			initialState: { queue: [{ id: "a" }, { id: "b" }] },
			runtimeHost,
			modelResolution: testModelResolution(),
			nodeAbortSignalForActivation: activation =>
				abortVerifierB && activation.mapped?.phase === "verifier" && activation.mapped?.itemKey === "b"
					? AbortSignal.abort("test abort")
					: undefined,
			lifecycle: {
				familyId: "family-1",
				attemptId: "attempt-1",
				freeze,
				runtimeBindingSnapshot: bindingSnapshot("attempt-1:binding-1"),
			},
		});

		// §2.3 — attempt status is "stopped" (not "failed").
		const family = reconstructWorkflowFamilies(host.getBranch())[0]!;
		const stoppedAttempt = family.attempts[0]!;
		expect(stoppedAttempt.status).toBe("stopped");
		expect(family.checkpoints).toHaveLength(1);
		const checkpoint = family.checkpoints[0]!;

		// §2.4 — checkpoint abortedActivationIds includes the pool activation.
		const poolActivation = firstRun.scheduler.activations.find(activation => activation.nodeId === "pool")!;
		expect(poolActivation.status).toBe("aborted");
		expect(checkpoint.abortedActivationIds).toContain(poolActivation.id);

		// The aborted child verifier is also recorded as aborted.
		const abortedVerifier = firstRun.scheduler.activations.find(
			activation => activation.nodeId === "pool.verifier" && activation.mapped?.itemKey === "b",
		)!;
		expect(abortedVerifier.status).toBe("aborted");
		expect(checkpoint.abortedActivationIds).toContain(abortedVerifier.id);

		// Worker "a" settled to completed worker-phase-only — no verifier "a"
		// was started, so it must resume at verifier on restart.
		const workerA = firstRun.scheduler.activations.find(
			activation => activation.nodeId === "pool.worker" && activation.mapped?.itemKey === "a",
		)!;
		expect(workerA.status).toBe("completed");
		expect(
			firstRun.scheduler.activations.some(
				activation => activation.nodeId === "pool.verifier" && activation.mapped?.itemKey === "a",
			),
		).toBe(false);

		// §2.5–6 — restart from the checkpoint.
		abortVerifierB = false;
		workerRunCount = 0;
		verifierRunCount = 0;
		reducerRunCount = 0;

		const completedActivations = firstRun.scheduler.activations.filter(
			(activation): activation is WorkflowActivation => activation.status === "completed",
		);

		const secondRun = await runWorkflow({
			host,
			definition,
			runId: "run-2",
			graphRevisionId: "graph-2",
			startNodeId: "pool",
			startParentActivationIds: checkpoint.completedActivationIds,
			initialState: checkpoint.state,
			completedActivations,
			runtimeHost,
			modelResolution: testModelResolution(),
			lifecycle: {
				familyId: "family-1",
				attemptId: "attempt-2",
				checkpointId: checkpoint.id,
				freeze,
				runtimeBindingSnapshot: bindingSnapshot("attempt-2:binding-1"),
				recordFamily: false,
				recordFreeze: false,
			},
		});

		// §2.6 — pool resumes in-flight items from their correct phase without
		// re-running completed work: workers are NOT re-run, verifiers and
		// reducers run for both items.
		const restartPool = secondRun.scheduler.activations.find(
			activation => activation.nodeId === "pool" && activation.status === "completed",
		);
		expect(restartPool).toBeDefined();
		expect(workerRunCount).toBe(0);
		expect(verifierRunCount).toBe(2);
		expect(reducerRunCount).toBe(2);
	});
});

class MemoryWorkflowHost {
	#entries: WorkflowLifecycleBranchEntry[] = [];

	appendCustomEntry(customType: string, data?: unknown): string {
		const id = `entry-${this.#entries.length + 1}`;
		this.#entries.push({ type: "custom", customType, data });
		return id;
	}

	getBranch(): WorkflowLifecycleBranchEntry[] {
		return this.#entries;
	}
}

function failureRecoveryDefinition(): WorkflowDefinition {
	return {
		name: "failure-recovery",
		version: 1,
		models: { roles: {}, defaults: {} },
		nodes: [
			{
				id: "setup",
				type: "script",
				script: { language: "sh", code: "setup" },
				writes: ["/ready"],
			},
			{
				id: "middle",
				type: "script",
				script: { language: "sh", code: "middle" },
				writes: ["/middleRecovered"],
			},
			{
				id: "after",
				type: "script",
				script: { language: "sh", code: "after" },
				writes: ["/done"],
			},
		],
		edges: [
			{ from: "setup", to: "middle" },
			{ from: "middle", to: "after" },
		],
	};
}

function mappedPoolDefinition(): WorkflowDefinition {
	return {
		name: "mapped-pool-persistence",
		version: 1,
		models: { roles: {}, defaults: {} },
		nodes: [
			{
				id: "pool",
				type: "mapped_pool",
				mappedPool: {
					itemSource: "/queue",
					itemKey: "/id",
					maxConcurrency: 5,
					maxItems: 2,
					workerNodeId: "pool.worker",
					verifierNodeId: "pool.verifier",
					reducerNodeId: "pool.reducer",
				},
			},
			{
				id: "pool.worker",
				type: "agent",
				agent: "task",
			},
			{
				id: "pool.verifier",
				type: "review",
			},
			{
				id: "pool.reducer",
				type: "script",
				script: { language: "sh", code: "reducer" },
			},
		],
		edges: [],
	};
}

function mappedPoolWithFinishDefinition(): WorkflowDefinition {
	return {
		name: "mapped-pool-checkpoint",
		version: 1,
		models: { roles: {}, defaults: {} },
		nodes: [
			{
				id: "pool",
				type: "mapped_pool",
				mappedPool: {
					itemSource: "/queue",
					itemKey: "/id",
					maxConcurrency: 5,
					maxItems: 2,
					workerNodeId: "pool.worker",
					verifierNodeId: "pool.verifier",
					reducerNodeId: "pool.reducer",
				},
			},
			{
				id: "pool.worker",
				type: "agent",
				agent: "task",
			},
			{
				id: "pool.verifier",
				type: "review",
			},
			{
				id: "pool.reducer",
				type: "script",
				script: { language: "sh", code: "reducer" },
			},
			{
				id: "finish",
				type: "script",
				script: { language: "sh", code: "finish" },
				writes: ["/done"],
			},
		],
		edges: [{ from: "pool", to: "finish" }],
	};
}

function mappedPoolAbortResumeDefinition(): WorkflowDefinition {
	return {
		name: "mapped-pool-abort-resume",
		version: 1,
		models: { roles: {}, defaults: {} },
		nodes: [
			{
				id: "pool",
				type: "mapped_pool",
				mappedPool: {
					itemSource: "/queue",
					itemKey: "/id",
					maxConcurrency: 2,
					maxItems: 2,
					workerNodeId: "pool.worker",
					verifierNodeId: "pool.verifier",
					reducerNodeId: "pool.reducer",
				},
			},
			{
				id: "pool.worker",
				type: "agent",
				agent: "task",
			},
			{
				id: "pool.verifier",
				type: "review",
			},
			{
				id: "pool.reducer",
				type: "script",
				script: { language: "sh", code: "reducer" },
			},
		],
		edges: [],
	};
}

function freezeForDefinition(definition: WorkflowDefinition): FlowFreeze {
	return {
		id: "flowfreeze:test",
		schemaVersion: "omhflow/v1",
		flowPath: "/tmp/failure-recovery.omhflow",
		resourceDir: "/tmp/failure-recovery",
		mainContentHash: "sha256:main",
		resourceHashes: [],
		resourceSnapshots: [],
		canonicalGraphHash: "sha256:graph",
		sourceMapping: { workflowBlocks: [], nodes: {} },
		staticCheckReport: { status: "passed", checks: [{ name: "test", status: "passed" }] },
		portableDefaults: { models: definition.models },
		checkpointPolicy: { stopDeadlineMs: 0 },
		changePolicy: { agentsCanPropose: true, humansCanApprove: true },
		definition,
	};
}

function bindingSnapshot(id: string): RuntimeBindingSnapshot {
	return {
		id,
		requestedRoles: {},
		resolvedModels: {},
		tools: ["script"],
		agents: [],
		unavailable: [],
		warnings: [],
	};
}
function testModelResolution() {
	return {
		availableModels: [
			buildModel({
				id: "test-model",
				name: "Test Model",
				api: "openai",
				provider: "openai",
				baseUrl: "http://localhost:9999",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 4096,
				maxTokens: 4096,
			}),
		],
	};
}
