import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import type { WorkflowDefinition } from "../definition";
import type { FlowFreeze } from "../freeze";
import type { RuntimeBindingSnapshot, WorkflowLifecycleBranchEntry } from "../lifecycle";
import { reconstructWorkflowFamilies, requestWorkflowAttemptStop } from "../lifecycle";
import { WorkflowNodeAbortedError, type WorkflowNodeRuntimeHost } from "../node-runtime";
import { runWorkflow } from "../runner";
import type { WorkflowActivation } from "../scheduler";
import {
	assertWorkflowCheckpointWorkspaceMatches,
	assertWorkflowWorkspaceSnapshotUnchanged,
	captureWorkflowCheckpointWorkspace,
	workflowRuntimeScratchDirtyPathPrefixes,
} from "../workspace-checkpoint";

describe("runWorkflow lifecycle", () => {
	it("fails fast when an agent output declares a fail-closed terminal status", async () => {
		const host = new MemoryWorkflowHost();
		const definition = failClosedAgentDefinition();
		const freeze = freezeForDefinition(definition);
		const runtimeHost: WorkflowNodeRuntimeHost = {
			runAgentNode: async () => ({
				summary: "validation unavailable",
				data: {
					status: "mapped_fail_closed_no_edits",
					blocker: "pytest is not available in this environment",
				},
			}),
			runScriptNode: async () => {
				throw new Error("after node should not run");
			},
		};

		const result = await runWorkflow({
			host,
			definition,
			runId: "run-1",
			graphRevisionId: "graph-1",
			startNodeId: "inspect",
			runtimeHost,
			lifecycle: {
				familyId: "family-1",
				attemptId: "attempt-1",
				freeze,
				runtimeBindingSnapshot: bindingSnapshot("attempt-1:binding-1"),
			},
		});

		expect(result.scheduler.activations.map(activation => [activation.nodeId, activation.status])).toEqual([
			["inspect", "failed"],
		]);
		expect(result.scheduler.activations[0]?.error).toContain("pytest is not available");
		expect(result.scheduler.state).toEqual({});

		const family = reconstructWorkflowFamilies(host.getBranch())[0]!;
		expect(family.attempts[0]).toMatchObject({
			status: "failed",
			error: expect.stringContaining("pytest is not available"),
		});
		expect(family.checkpoints[0]).toMatchObject({
			frontierNodeIds: ["inspect"],
			state: {},
			completedActivationIds: [],
		});
	});

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

	it("records the workspace snapshot when a stopped activation leaves dirty files", async () => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "omp-workflow-checkpoint-workspace-"));
		try {
			await initializeGitWorkspace(workspace);
			const host = new MemoryWorkflowHost();
			const definition = stoppedWorkspaceDefinition();
			const freeze = freezeForDefinition(definition);
			const controller = new AbortController();
			const wrotePartialFile = Promise.withResolvers<void>();
			const runtimeHost: WorkflowNodeRuntimeHost = {
				runScriptNode: async input => {
					await Bun.write(path.join(workspace, "src", "partial.ts"), "export const partial = true;\n");
					wrotePartialFile.resolve();
					const parked = Promise.withResolvers<never>();
					input.signal?.addEventListener("abort", () => parked.reject(new Error("workflow activation stopped")), {
						once: true,
					});
					return parked.promise;
				},
			};

			const runPromise = runWorkflow({
				host,
				definition,
				runId: "run-1",
				graphRevisionId: "graph-1",
				startNodeId: "writePartial",
				runtimeHost,
				workspaceRoot: workspace,
				signal: controller.signal,
				nodeAbortSignal: controller.signal,
				lifecycle: {
					familyId: "family-1",
					attemptId: "attempt-1",
					freeze,
					runtimeBindingSnapshot: bindingSnapshot("attempt-1:binding-1"),
				},
			});
			await wrotePartialFile.promise;
			controller.abort("operator stop");
			await runPromise;

			const checkpoint = reconstructWorkflowFamilies(host.getBranch())[0]?.checkpoints[0];
			expect(checkpoint?.abortedActivationIds).toEqual(["activation-1"]);
			expect(checkpoint?.workspace).toMatchObject({
				kind: "git",
				status: "dirty",
				dirtyPaths: ["src/partial.ts"],
			});
			expect(checkpoint?.workspace?.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
			const observability = await Bun.file(
				path.join(workspace, "workflow-output", "omh-runtime", "observability.json"),
			).json();
			expect(observability.lifecycle).toMatchObject([
				{
					event: "checkpoint_created",
					attemptId: "attempt-1",
					checkpointId: "attempt-1:checkpoint-1",
					completedActivationIds: [],
					abortedActivationIds: ["activation-1"],
					frontierNodeIds: ["writePartial"],
					workspaceStatus: "dirty",
				},
			]);
			const progress = await Bun.file(path.join(workspace, "workflow-output", "omh-runtime", "progress.md")).text();
			expect(progress).toContain("## Lifecycle Events");
			expect(progress).toContain("checkpoint_created");
			expect(progress).toContain("frontier writePartial");
		} finally {
			await fs.rm(workspace, { recursive: true, force: true });
		}
	});

	it("does not treat monitor assignment updates as read-only workspace changes", async () => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "omp-workflow-monitor-metadata-"));
		try {
			await initializeGitWorkspace(workspace);
			await Bun.write(path.join(workspace, "task.md"), "Run a workflow canary.\n");
			await Bun.write(path.join(workspace, "manifest-entry.json"), '{"runId":"run-1"}\n');
			await Bun.write(path.join(workspace, "monitor-assignment.json"), '{"monitor":"pending"}\n');
			await Bun.write(path.join(workspace, "workflow-output", "documentation-precheck.md"), "precheck\n");
			const snapshotOptions = {
				ignoredDirtyPathPrefixes: workflowRuntimeScratchDirtyPathPrefixes(workspace),
			};
			const before = await captureWorkflowCheckpointWorkspace(workspace, snapshotOptions);

			await Bun.write(path.join(workspace, "monitor-assignment.json"), '{"monitor":"agent-1"}\n');
			const after = await captureWorkflowCheckpointWorkspace(workspace, snapshotOptions);

			expect(() => assertWorkflowWorkspaceSnapshotUnchanged(before, after, "readOnlyNode")).not.toThrow();
			expect(after?.dirtyPaths).toEqual([
				"manifest-entry.json",
				"task.md",
				"workflow-output/documentation-precheck.md",
			]);
		} finally {
			await fs.rm(workspace, { recursive: true, force: true });
		}
	});

	it("creates a restartable checkpoint when the operator leaves a human checkpoint prompt", async () => {
		const host = new MemoryWorkflowHost();
		const definition = humanCheckpointDefinition();
		const freeze = freezeForDefinition(definition);
		const runtimeHost: WorkflowNodeRuntimeHost = {
			runHumanNode: async () => {
				throw new WorkflowNodeAbortedError("operator left human checkpoint");
			},
		};

		const result = await runWorkflow({
			host,
			definition,
			runId: "run-1",
			graphRevisionId: "graph-1",
			startNodeId: "operatorGate",
			runtimeHost,
			lifecycle: {
				familyId: "family-1",
				attemptId: "attempt-1",
				freeze,
				runtimeBindingSnapshot: bindingSnapshot("attempt-1:binding-1"),
			},
		});

		expect(result.scheduler.activations.map(activation => [activation.nodeId, activation.status])).toEqual([
			["operatorGate", "aborted"],
		]);
		expect(result.scheduler.stopReason).toBe("operator left human checkpoint");

		const family = reconstructWorkflowFamilies(host.getBranch())[0]!;
		expect(family.attempts[0]).toMatchObject({
			status: "stopped",
			stop: {
				reason: "operator left human checkpoint",
			},
		});
		expect(family.checkpoints[0]).toMatchObject({
			id: "attempt-1:checkpoint-1",
			attemptId: "attempt-1",
			frontierNodeIds: ["operatorGate"],
			completedActivationIds: [],
			abortedActivationIds: ["activation-1"],
		});
	});

	it("aborts active nodes when a lifecycle stop request reaches its deadline", async () => {
		const host = new MemoryWorkflowHost();
		const definition = stopRequestedDefinition();
		const freeze = freezeForDefinition(definition);
		let stopRequested = false;
		const runtimeHost: WorkflowNodeRuntimeHost = {
			runScriptNode: async input => {
				if (!stopRequested) {
					stopRequested = true;
					requestWorkflowAttemptStop(host, {
						attemptId: "attempt-1",
						deadlineMs: 1,
						reason: "test external stop",
					});
				}
				const signal = input.signal;
				if (signal === undefined) throw new Error("expected node abort signal");
				return await new Promise((_, reject) => {
					const onAbort = () => reject(new WorkflowNodeAbortedError("stop deadline elapsed"));
					if (signal.aborted) onAbort();
					else signal.addEventListener("abort", onAbort, { once: true });
				});
			},
		};

		const result = await runWorkflow({
			host,
			definition,
			runId: "run-1",
			graphRevisionId: "graph-1",
			startNodeId: "long",
			runtimeHost,
			lifecycle: {
				familyId: "family-1",
				attemptId: "attempt-1",
				freeze,
				runtimeBindingSnapshot: bindingSnapshot("attempt-1:binding-1"),
			},
		});

		expect(result.scheduler.activations.map(activation => [activation.nodeId, activation.status])).toEqual([
			["long", "aborted"],
		]);
		const family = reconstructWorkflowFamilies(host.getBranch())[0]!;
		expect(family.attempts[0]?.status).toBe("stopped");
		expect(family.checkpoints[0]).toMatchObject({
			abortedActivationIds: ["activation-1"],
			frontierNodeIds: ["long"],
		});
	});

	it("creates a restartable checkpoint after a lifecycle checkpoint node completes", async () => {
		const host = new MemoryWorkflowHost();
		const definition = humanCheckpointAfterDefinition();
		const freeze = freezeForDefinition(definition);
		const runtimeHost: WorkflowNodeRuntimeHost = {
			runHumanNode: async () => ({
				summary: "operator approved maintenance window",
				data: { response: "Approve" },
				statePatch: [{ op: "set", path: "/gate", value: { response: "Approve" } }],
			}),
			runScriptNode: async () => {
				throw new Error("continuation should wait for checkpoint restart");
			},
		};

		const result = await runWorkflow({
			host,
			definition,
			runId: "run-1",
			graphRevisionId: "graph-1",
			startNodeId: "operatorGate",
			runtimeHost,
			lifecycle: {
				familyId: "family-1",
				attemptId: "attempt-1",
				freeze,
				runtimeBindingSnapshot: bindingSnapshot("attempt-1:binding-1"),
			},
		});

		expect(result.scheduler.activations.map(activation => [activation.nodeId, activation.status])).toEqual([
			["operatorGate", "completed"],
		]);
		expect(result.scheduler.stopReason).toBe('workflow node "operatorGate" requested checkpoint after completion');
		expect(result.scheduler.state).toEqual({ gate: { response: "Approve" } });

		const family = reconstructWorkflowFamilies(host.getBranch())[0]!;
		expect(family.attempts[0]).toMatchObject({
			status: "stopped",
			stop: {
				reason: 'workflow node "operatorGate" requested checkpoint after completion',
			},
		});
		expect(family.checkpoints[0]).toMatchObject({
			id: "attempt-1:checkpoint-1",
			attemptId: "attempt-1",
			frontierNodeIds: ["continueWork"],
			completedActivationIds: ["activation-1"],
			abortedActivationIds: [],
			state: { gate: { response: "Approve" } },
			sourceMapping: { continueWork: "continueWork" },
		});
	});

	it("rejects restart validation when the checkpoint workspace snapshot no longer matches", async () => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "omp-workflow-checkpoint-restart-"));
		try {
			await initializeGitWorkspace(workspace);
			const host = new MemoryWorkflowHost();
			const definition = stoppedWorkspaceDefinition();
			const freeze = freezeForDefinition(definition);
			const controller = new AbortController();
			const wrotePartialFile = Promise.withResolvers<void>();
			const runtimeHost: WorkflowNodeRuntimeHost = {
				runScriptNode: async input => {
					await Bun.write(path.join(workspace, "src", "partial.ts"), "export const partial = true;\n");
					wrotePartialFile.resolve();
					const parked = Promise.withResolvers<never>();
					input.signal?.addEventListener("abort", () => parked.reject(new Error("workflow activation stopped")), {
						once: true,
					});
					return parked.promise;
				},
			};

			const runPromise = runWorkflow({
				host,
				definition,
				runId: "run-1",
				graphRevisionId: "graph-1",
				startNodeId: "writePartial",
				runtimeHost,
				workspaceRoot: workspace,
				signal: controller.signal,
				nodeAbortSignal: controller.signal,
				lifecycle: {
					familyId: "family-1",
					attemptId: "attempt-1",
					freeze,
					runtimeBindingSnapshot: bindingSnapshot("attempt-1:binding-1"),
				},
			});
			await wrotePartialFile.promise;
			controller.abort("operator stop");
			await runPromise;

			const checkpoint = reconstructWorkflowFamilies(host.getBranch())[0]?.checkpoints[0];
			if (checkpoint === undefined) throw new Error("expected workflow checkpoint");
			await expect(assertWorkflowCheckpointWorkspaceMatches(checkpoint, workspace)).resolves.toBeUndefined();

			await Bun.write(path.join(workspace, "src", "unexpected.ts"), "export const unexpected = true;\n");
			await expect(assertWorkflowCheckpointWorkspaceMatches(checkpoint, workspace)).rejects.toThrow(
				"Workflow checkpoint workspace state does not match current workspace",
			);
		} finally {
			await fs.rm(workspace, { recursive: true, force: true });
		}
	});

	it("omits runtime scratch from checkpoint workspace snapshots", async () => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "omp-workflow-checkpoint-scratch-"));
		const scratchRoot = path.join(workspace, "workflow-output", "tmp");
		const previousRunTmp = process.env.OMH_RUN_TMP;
		try {
			process.env.OMH_RUN_TMP = scratchRoot;
			await initializeGitWorkspace(workspace);
			const host = new MemoryWorkflowHost();
			const definition = stoppedWorkspaceDefinition();
			const freeze = freezeForDefinition(definition);
			const controller = new AbortController();
			const wrotePartialFile = Promise.withResolvers<void>();
			const runtimeHost: WorkflowNodeRuntimeHost = {
				runScriptNode: async input => {
					await Bun.write(path.join(workspace, "src", "partial.ts"), "export const partial = true;\n");
					await Bun.write(
						path.join(scratchRoot, "omp-python-runner", "runner-novmd3thesia.py"),
						"print('transient runner')\n",
					);
					wrotePartialFile.resolve();
					const parked = Promise.withResolvers<never>();
					input.signal?.addEventListener("abort", () => parked.reject(new Error("workflow activation stopped")), {
						once: true,
					});
					return parked.promise;
				},
			};

			const runPromise = runWorkflow({
				host,
				definition,
				runId: "run-1",
				graphRevisionId: "graph-1",
				startNodeId: "writePartial",
				runtimeHost,
				workspaceRoot: workspace,
				signal: controller.signal,
				nodeAbortSignal: controller.signal,
				lifecycle: {
					familyId: "family-1",
					attemptId: "attempt-1",
					freeze,
					runtimeBindingSnapshot: bindingSnapshot("attempt-1:binding-1"),
				},
			});
			await wrotePartialFile.promise;
			controller.abort("operator stop");
			await runPromise;

			const checkpoint = reconstructWorkflowFamilies(host.getBranch())[0]?.checkpoints[0];
			if (checkpoint === undefined) throw new Error("expected workflow checkpoint");
			expect(checkpoint.workspace?.dirtyPaths).toEqual(["src/partial.ts"]);

			await fs.rm(scratchRoot, { recursive: true, force: true });
			await expect(assertWorkflowCheckpointWorkspaceMatches(checkpoint, workspace)).resolves.toBeUndefined();
		} finally {
			if (previousRunTmp === undefined) delete process.env.OMH_RUN_TMP;
			else process.env.OMH_RUN_TMP = previousRunTmp;
			await fs.rm(workspace, { recursive: true, force: true });
		}
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

function failClosedAgentDefinition(): WorkflowDefinition {
	return {
		name: "fail-closed-agent",
		version: 1,
		models: { roles: {}, defaults: {} },
		nodes: [
			{
				id: "inspect",
				type: "agent",
				agent: "task",
				prompt: "Inspect the project.",
				writes: ["/inspection"],
			},
			{
				id: "after",
				type: "script",
				script: { language: "sh", code: "after" },
				writes: ["/done"],
			},
		],
		edges: [{ from: "inspect", to: "after" }],
	};
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

function stoppedWorkspaceDefinition(): WorkflowDefinition {
	return {
		name: "stopped-workspace",
		version: 1,
		models: { roles: {}, defaults: {} },
		nodes: [
			{
				id: "writePartial",
				type: "script",
				script: { language: "sh", code: "write partial" },
			},
		],
		edges: [],
	};
}

function humanCheckpointDefinition(): WorkflowDefinition {
	return {
		name: "human-checkpoint",
		version: 1,
		models: { roles: {}, defaults: {} },
		nodes: [
			{
				id: "operatorGate",
				type: "human",
				prompt: "Approve after inspecting the adaptive workflow proposal.",
			},
		],
		edges: [],
	};
}

function humanCheckpointAfterDefinition(): WorkflowDefinition {
	return {
		name: "human-checkpoint-after",
		version: 1,
		models: { roles: {}, defaults: {} },
		stateSchema: {
			version: 1,
			shape: { gate: "object" },
		},
		nodes: [
			{
				id: "operatorGate",
				type: "human",
				prompt: "Approve after inspecting the adaptive workflow proposal.",
				checkpoint: "after",
				writes: ["/gate"],
			},
			{
				id: "continueWork",
				type: "script",
				script: { language: "sh", code: "continue" },
			},
		],
		edges: [{ from: "operatorGate", to: "continueWork" }],
	};
}

function stopRequestedDefinition(): WorkflowDefinition {
	return {
		name: "stop-requested",
		version: 1,
		models: { roles: {}, defaults: {} },
		nodes: [
			{
				id: "long",
				type: "script",
				script: { language: "sh", code: "long" },
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

async function initializeGitWorkspace(workspace: string): Promise<void> {
	await $`git init`.cwd(workspace).quiet();
	await Bun.write(path.join(workspace, "README.md"), "baseline\n");
	await $`git add README.md`.cwd(workspace).quiet();
	await $`git -c user.name=omh-test -c user.email=omh-test@example.invalid -c commit.gpgsign=false commit -m baseline`
		.cwd(workspace)
		.quiet();
}
