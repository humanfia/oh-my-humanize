import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { freezeWorkflowArtifact } from "../../src/workflow/freeze";
import type { WorkflowNodeRuntimeHost } from "../../src/workflow/node-runtime";
import { loadWorkflowArtifact } from "../../src/workflow/package-loader";
import { reconstructWorkflowRuns, type WorkflowRunStoreHost } from "../../src/workflow/run-store";
import { runWorkflow } from "../../src/workflow/runner";
import type { WorkflowActivation } from "../../src/workflow/scheduler";
import { createSessionWorkflowRuntimeHost, type WorkflowScriptEvalRequest } from "../../src/workflow/session-runtime";
import type { WorkflowStatePatchOperation } from "../../src/workflow/state";

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

describe("mapped worker-verifier pool flow contract", () => {
	it("runs the example through worker, verifier, reducer, and expands the queue", async () => {
		const exampleDir = path.resolve(
			import.meta.dir,
			"../../examples/workflow/experimental/mapped-worker-verifier-pool",
		);
		const host = createHost();
		const startedActivations: WorkflowActivation[] = [];
		const scriptOutputs = new Map<string, unknown>();
		const runtimeHost = createSessionWorkflowRuntimeHost({
			cwd: exampleDir,
			runEvalScript: async request => {
				const output = await runExampleScript(request);
				scriptOutputs.set(request.activationId, output);
				return { exitCode: 0, output: JSON.stringify(output), language: request.language };
			},
		});

		const runtimeHostWithReview: WorkflowNodeRuntimeHost = {
			...runtimeHost,
			runAgentNode: async input => {
				startedActivations.push(input.activation);
				const mapped = input.activation.mapped;
				if (input.node.id === "pool.worker" && mapped) {
					return {
						summary: `processed ${mapped.itemKey}`,
						statePatch: [
							{
								op: "set",
								path: `/pool/results/${mapped.itemKey}`,
								value: { summary: `result-${mapped.itemKey}`, expand: mapped.itemKey === "task-1" },
							},
						],
					};
				}
				return { summary: "agent ran" };
			},
			runReviewNode: async input => {
				startedActivations.push(input.activation);
				const mapped = input.activation.mapped;
				if (input.node.id === "pool.verifier" && mapped) {
					return {
						verdict: mapped.itemKey === "task-1" ? "expand" : "accept",
						summary: `verified ${mapped.itemKey}`,
						statePatch: [
							{
								op: "set",
								path: `/pool/results/${mapped.itemKey}/verdict`,
								value: mapped.itemKey === "task-1" ? "expand" : "accept",
							},
						],
					};
				}
				return { verdict: "accept", summary: "reviewed" };
			},
		};

		async function runExampleScript(request: WorkflowScriptEvalRequest): Promise<unknown> {
			const logs: unknown[] = [];
			const originalLog = console.log;
			console.log = (...args: unknown[]) => {
				logs.push(args[0]);
			};
			try {
				const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
					arg: string,
					body: string,
				) => (context: unknown) => Promise<unknown>;
				const execute = new AsyncFunction("context", request.code);
				await execute(request.context);
			} finally {
				console.log = originalLog;
			}
			for (let i = logs.length - 1; i >= 0; i -= 1) {
				const line = typeof logs[i] === "string" ? logs[i] : JSON.stringify(logs[i]);
				try {
					return JSON.parse(line as string);
				} catch {
					// continue scanning for a JSON line
				}
			}
			return undefined;
		}

		const artifact = await loadWorkflowArtifact(path.join(exampleDir, "mapped-worker-verifier-pool.omhflow"));
		const freeze = await freezeWorkflowArtifact(artifact);

		await runWorkflow({
			host,
			packageRoot: exampleDir,
			definition: freeze.definition,
			frozenResources: freeze.resourceSnapshots,
			runId: "mapped-pool-run-1",
			startNodeId: "plan",
			runtimeHost: runtimeHostWithReview,
		});

		const runs = reconstructWorkflowRuns(host.getBranch());
		const run = runs[0];
		if (!run) throw new Error("expected a run");

		const seedOutput = scriptOutputs.get("activation-1") as
			| { statePatch?: WorkflowStatePatchOperation[] }
			| undefined;
		expect(seedOutput?.statePatch).toEqual([
			{ op: "set", path: "/plan", value: { tasks: ["task-1", "task-2", "task-3", "task-4", "task-5"] } },
			{
				op: "set",
				path: "/pool/queue",
				value: [{ id: "task-1" }, { id: "task-2" }, { id: "task-3" }, { id: "task-4" }, { id: "task-5" }],
			},
			{ op: "set", path: "/pool/done", value: false },
			{ op: "set", path: "/pool/results", value: {} },
		]);

		const taskOneReducer = run.activations.find(
			activation => activation.nodeId === "pool.reducer" && activation.mapped?.itemKey === "task-1",
		);
		expect(taskOneReducer).toBeDefined();
		expect(scriptOutputs.get(taskOneReducer!.id)).toEqual({
			statePatch: [
				{
					op: "set",
					path: "/pool/queue",
					value: [
						{ id: "task-1" },
						{ id: "task-2" },
						{ id: "task-3" },
						{ id: "task-4" },
						{ id: "task-5" },
						{ id: "task-6" },
					],
				},
				{ op: "set", path: "/pool/done", value: true },
			],
		});
		const reducerActivations = run.activations.filter(a => a.nodeId === "pool.reducer" && a.status === "completed");
		expect(reducerActivations).toHaveLength(6);

		const workerItems = run.activations
			.filter(a => a.nodeId === "pool.worker" && a.status === "completed")
			.map(a => a.mapped?.itemKey)
			.sort();
		expect(workerItems).toEqual(["task-1", "task-2", "task-3", "task-4", "task-5", "task-6"]);

		const verifierItems = run.activations
			.filter(a => a.nodeId === "pool.verifier" && a.status === "completed")
			.map(a => a.mapped?.itemKey)
			.sort();
		expect(verifierItems).toEqual(["task-1", "task-2", "task-3", "task-4", "task-5", "task-6"]);

		expect((run.state as Record<string, Record<string, unknown>>).pool?.done).toBe(true);
	});
});
