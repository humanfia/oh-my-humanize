import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { parseWorkflowDefinition } from "../../src/workflow/definition";
import type { FlowFreeze } from "../../src/workflow/freeze";
import {
	approveWorkflowChangeRequest,
	proposeWorkflowChangeRequest,
	type RuntimeBindingSnapshot,
	reconstructWorkflowFamilies,
	startWorkflowFamily,
} from "../../src/workflow/lifecycle";
import type { WorkflowNodeRuntimeHost, WorkflowScriptNodeInput } from "../../src/workflow/node-runtime";
import { reconstructWorkflowRuns, type WorkflowRunStoreHost } from "../../src/workflow/run-store";
import { runWorkflow } from "../../src/workflow/runner";

const openAiModel: Model<Api> = buildModel({
	id: "gpt-4o",
	name: "GPT-4o",
	api: "openai-completions",
	provider: "openai",
	baseUrl: "https://openai.example.test",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 8192,
});

const source = `
name: runner-demo
version: 1
models:
  roles:
    builder: openai/gpt-4o
    reviewer: openai/gpt-4o
  defaults:
    agent: builder
nodes:
  build:
    type: agent
    agent: task
    writes:
      - /work
  review:
    type: review
    agent: reviewer
    model:
      role: reviewer
      unavailable: fail
    gates:
      - finish
    writes:
      - /verdict
edges:
  - from: build
    to: review
`;

const agentDecisionSource = `
name: agent-decision-demo
version: 1
nodes:
  decide:
    type: agent
    agent: task
  retry:
    type: script
  done:
    type: script
edges:
  - from: decide
    to: retry
    when: outputs.decide.verdict == "retry"
  - from: decide
    to: done
    when: outputs.decide.verdict == "done"
  - from: retry
    to: decide
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

function createFreeze(
	id: string,
	definition = parseWorkflowDefinition(source, { sourcePath: "workflow.yml" }),
): FlowFreeze {
	return {
		id,
		schemaVersion: "omhflow/v1",
		flowPath: "workflow.omhflow",
		resourceDir: ".",
		mainContentHash: "sha256:main",
		resourceHashes: [],
		resourceSnapshots: [],
		canonicalGraphHash: "sha256:graph",
		sourceMapping: {
			workflowBlocks: [{ id: "workflow:0", language: "yaml" }],
			nodes: Object.fromEntries(definition.nodes.map(node => [node.id, { sourceBlock: "workflow:0" }])),
		},
		staticCheckReport: { status: "passed", checks: [] },
		portableDefaults: { models: definition.models },
		definition,
	};
}

function binding(id: string): RuntimeBindingSnapshot {
	return {
		id,
		requestedRoles: {},
		resolvedModels: {},
		tools: ["task"],
		agents: ["task"],
		unavailable: [],
		warnings: [],
	};
}

function isStatePatchEvent(data: unknown): boolean {
	return isRecord(data) && data.event === "state_patch_applied";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

describe("workflow runner", () => {
	it("persists activation lifecycle, state patches, artifacts, and model audit for a run", async () => {
		const host = createHost();
		const definition = parseWorkflowDefinition(source, { sourcePath: "workflow.yml" });
		const runtimeHost: WorkflowNodeRuntimeHost = {
			runAgentNode: async () => ({
				summary: "build completed",
				artifacts: ["artifact://workflow/run-1/build.txt"],
				statePatch: [{ op: "set", path: "/work/summary", value: "built" }],
			}),
			runReviewNode: async () => ({
				summary: "review completed",
				verdict: "finish",
				artifacts: ["artifact://workflow/run-1/review.txt"],
			}),
		};

		const result = await runWorkflow({
			host,
			definition,
			runId: "run-1",
			startNodeId: "build",
			runtimeHost,
			modelResolution: { availableModels: [openAiModel] },
		});

		expect(result.scheduler.activations.map(activation => [activation.nodeId, activation.status])).toEqual([
			["build", "completed"],
			["review", "completed"],
		]);
		const reconstructed = reconstructWorkflowRuns(host.getBranch());
		expect(reconstructed[0]?.state).toEqual({ work: { summary: "built" }, verdict: "finish" });
		expect(reconstructed[0]?.activations.map(activation => activation.status)).toEqual(["completed", "completed"]);
		expect(reconstructed[0]?.activations[0]?.output).toEqual({
			summary: "build completed",
			artifacts: ["artifact://workflow/run-1/build.txt"],
			statePatch: [{ op: "set", path: "/work/summary", value: "built" }],
		});
		expect(reconstructed[0]?.activations[0]?.modelAudit?.resolvedModel).toBe("openai/gpt-4o");
		expect(reconstructed[0]?.activations[1]?.modelAudit).toMatchObject({
			nodeId: "review",
			source: "node",
			requestedRole: "reviewer",
			resolvedModel: "openai/gpt-4o",
			fallbackUsed: false,
		});
	});

	it("rejects schema-invalid activation output before persisting state patches", async () => {
		const host = createHost();
		const definition = parseWorkflowDefinition(
			`
name: runner-schema-demo
version: 1
stateSchema:
  version: 1
  shape:
    work: object
nodes:
  build:
    type: agent
    agent: task
    writes:
      - /work
edges: []
`,
			{ sourcePath: "workflow.yml" },
		);
		const runtimeHost: WorkflowNodeRuntimeHost = {
			runAgentNode: async () => ({
				summary: "attempted invalid work write",
				statePatch: [{ op: "set", path: "/work", value: "built" }],
			}),
		};

		const result = await runWorkflow({
			host,
			definition,
			runId: "run-schema-invalid",
			startNodeId: "build",
			runtimeHost,
		});

		expect(result.scheduler.activations.map(activation => [activation.nodeId, activation.status])).toEqual([
			["build", "failed"],
		]);
		expect(result.scheduler.activations[0]?.error).toBe(
			'workflow state schema rejects write to "/work": expected object, received string',
		);
		expect(host.entries.some(entry => isStatePatchEvent(entry.data))).toBe(false);
		const reconstructed = reconstructWorkflowRuns(host.getBranch());
		expect(reconstructed[0]?.state).toEqual({});
		expect(reconstructed[0]?.activations[0]?.status).toBe("failed");
	});

	it("lets agent node outputs choose downstream paths", async () => {
		const host = createHost();
		const definition = parseWorkflowDefinition(agentDecisionSource, { sourcePath: "workflow.yml" });
		let decisionCount = 0;
		const runtimeHost: WorkflowNodeRuntimeHost = {
			runAgentNode: async () => {
				decisionCount += 1;
				const verdict = decisionCount === 1 ? "retry" : "done";
				return {
					summary: `agent selected ${verdict}`,
					data: { verdict },
				};
			},
			runScriptNode: async input => ({
				summary: `ran ${input.node.id}`,
			}),
		};

		const result = await runWorkflow({
			host,
			definition,
			runId: "run-agent-decision",
			startNodeId: "decide",
			runtimeHost,
		});

		expect(result.scheduler.activations.map(activation => activation.nodeId)).toEqual([
			"decide",
			"retry",
			"decide",
			"done",
		]);
		expect(result.scheduler.activations.findLast(activation => activation.nodeId === "decide")?.output?.data).toEqual(
			{
				verdict: "done",
			},
		);
	});

	it("checkpoints frozen attempts that stop at the activation limit", async () => {
		const host = createHost();
		const definition = parseWorkflowDefinition(source, { sourcePath: "workflow.yml" });
		const runtimeHost: WorkflowNodeRuntimeHost = {
			runAgentNode: async () => ({
				summary: "build completed",
				statePatch: [{ op: "set", path: "/work/summary", value: "built" }],
			}),
		};

		await runWorkflow({
			host,
			definition,
			runId: "run-limit",
			startNodeId: "build",
			runtimeHost,
			maxActivations: 1,
			lifecycle: {
				familyId: "family-limit",
				attemptId: "attempt-limit-1",
				freeze: createFreeze("flowfreeze:limit", definition),
				runtimeBindingSnapshot: binding("binding-limit"),
			},
		});

		const families = reconstructWorkflowFamilies(host.getBranch());
		expect(families[0]?.attempts.map(attempt => [attempt.id, attempt.status, attempt.summary])).toEqual([
			["attempt-limit-1", "stopped", undefined],
		]);
		expect(families[0]?.checkpoints).toMatchObject([
			{
				id: "attempt-limit-1:checkpoint-1",
				attemptId: "attempt-limit-1",
				completedActivationIds: ["activation-1"],
				abortedActivationIds: [],
				frontierNodeIds: ["review"],
				state: { work: { summary: "built" } },
				sourceMapping: { review: "review" },
			},
		]);
	});

	it("checkpoints frozen attempts when cancellation stops downstream scheduling", async () => {
		const host = createHost();
		const definition = parseWorkflowDefinition(source, { sourcePath: "workflow.yml" });
		const controller = new AbortController();
		const calls: string[] = [];
		const runtimeHost: WorkflowNodeRuntimeHost = {
			runAgentNode: async () => {
				calls.push("build");
				controller.abort("workflow stop requested");
				return {
					summary: "build completed",
					statePatch: [{ op: "set", path: "/work/summary", value: "built" }],
				};
			},
			runReviewNode: async () => {
				calls.push("review");
				return { summary: "review should not run", verdict: "finish" };
			},
		};

		await runWorkflow({
			host,
			definition,
			runId: "run-cancel",
			startNodeId: "build",
			runtimeHost,
			signal: controller.signal,
			lifecycle: {
				familyId: "family-cancel",
				attemptId: "attempt-cancel-1",
				freeze: createFreeze("flowfreeze:cancel", definition),
				runtimeBindingSnapshot: binding("binding-cancel"),
			},
		});

		const families = reconstructWorkflowFamilies(host.getBranch());
		expect(calls).toEqual(["build"]);
		expect(families[0]?.attempts.map(attempt => [attempt.id, attempt.status, attempt.summary])).toEqual([
			["attempt-cancel-1", "stopped", undefined],
		]);
		expect(families[0]?.attempts[0]?.activations.map(activation => [activation.nodeId, activation.status])).toEqual([
			["build", "completed"],
		]);
		expect(families[0]?.checkpoints).toMatchObject([
			{
				id: "attempt-cancel-1:checkpoint-1",
				attemptId: "attempt-cancel-1",
				completedActivationIds: ["activation-1"],
				abortedActivationIds: [],
				frontierNodeIds: ["review"],
				state: { work: { summary: "built" } },
				sourceMapping: { review: "review" },
			},
		]);
	});

	it("passes a dedicated node abort signal separately from the scheduler stop signal", async () => {
		const host = createHost();
		const definition = parseWorkflowDefinition(source, { sourcePath: "workflow.yml" });
		const stopController = new AbortController();
		const nodeAbortController = new AbortController();
		const calls: string[] = [];
		let receivedSignal: AbortSignal | undefined;
		const runtimeHost: WorkflowNodeRuntimeHost = {
			runAgentNode: async input => {
				calls.push("build");
				receivedSignal = input.signal;
				stopController.abort("workflow stop requested");
				return { summary: "build completed" };
			},
			runReviewNode: async () => {
				calls.push("review");
				return { summary: "review should not run", verdict: "finish" };
			},
		};

		await runWorkflow({
			host,
			definition,
			runId: "run-node-abort-signal",
			startNodeId: "build",
			runtimeHost,
			signal: stopController.signal,
			nodeAbortSignal: nodeAbortController.signal,
			lifecycle: {
				familyId: "family-node-abort-signal",
				attemptId: "attempt-node-abort-signal-1",
				freeze: createFreeze("flowfreeze:node-abort-signal", definition),
				runtimeBindingSnapshot: binding("binding-node-abort-signal"),
			},
		});

		expect(calls).toEqual(["build"]);
		expect(receivedSignal).toBe(nodeAbortController.signal);
		const families = reconstructWorkflowFamilies(host.getBranch());
		expect(families[0]?.attempts[0]?.status).toBe("stopped");
		expect(families[0]?.checkpoints[0]?.frontierNodeIds).toEqual(["review"]);
	});

	it("checkpoints deadline-aborted lifecycle activations instead of failing the attempt", async () => {
		const host = createHost();
		const definition = parseWorkflowDefinition(source, { sourcePath: "workflow.yml" });
		const stopController = new AbortController();
		const nodeAbortController = new AbortController();
		const runtimeHost: WorkflowNodeRuntimeHost = {
			runAgentNode: async input => {
				stopController.abort("workflow stop requested");
				await Promise.resolve();
				nodeAbortController.abort("stop deadline elapsed");
				throw new Error(input.signal?.reason ?? "stop deadline elapsed");
			},
			runReviewNode: async () => ({ summary: "review should not run", verdict: "finish" }),
		};

		const result = await runWorkflow({
			host,
			definition,
			runId: "run-node-abort",
			startNodeId: "build",
			runtimeHost,
			signal: stopController.signal,
			nodeAbortSignal: nodeAbortController.signal,
			lifecycle: {
				familyId: "family-node-abort",
				attemptId: "attempt-node-abort-1",
				freeze: createFreeze("flowfreeze:node-abort", definition),
				runtimeBindingSnapshot: binding("binding-node-abort"),
			},
		});

		expect(result.scheduler.activations.map(activation => [activation.nodeId, activation.status])).toEqual([
			["build", "aborted"],
		]);
		expect(reconstructWorkflowRuns(host.getBranch())[0]?.activations.map(activation => activation.status)).toEqual([
			"aborted",
		]);
		const families = reconstructWorkflowFamilies(host.getBranch());
		expect(families[0]?.attempts.map(attempt => [attempt.id, attempt.status, attempt.error])).toEqual([
			["attempt-node-abort-1", "stopped", undefined],
		]);
		expect(families[0]?.attempts[0]?.activations.map(activation => [activation.nodeId, activation.status])).toEqual([
			["build", "aborted"],
		]);
		expect(families[0]?.checkpoints).toMatchObject([
			{
				id: "attempt-node-abort-1:checkpoint-1",
				attemptId: "attempt-node-abort-1",
				completedActivationIds: [],
				abortedActivationIds: ["activation-1"],
				frontierNodeIds: ["build"],
				state: {},
				sourceMapping: { build: "build" },
			},
		]);
	});

	it("checkpoints lifecycle attempts when max runtime elapses", async () => {
		const host = createHost();
		const definition = parseWorkflowDefinition(source, { sourcePath: "workflow.yml" });
		const runtimeElapsed = Promise.withResolvers<void>();
		const runtimeHost: WorkflowNodeRuntimeHost = {
			runAgentNode: async input => {
				input.signal?.addEventListener("abort", () => runtimeElapsed.resolve(), { once: true });
				await runtimeElapsed.promise;
				throw new Error(input.signal?.reason ?? "workflow max runtime elapsed");
			},
			runReviewNode: async () => ({ summary: "review should not run", verdict: "finish" }),
		};

		const result = await runWorkflow({
			host,
			definition,
			runId: "run-max-runtime",
			startNodeId: "build",
			runtimeHost,
			maxRuntimeMs: 1,
			lifecycle: {
				familyId: "family-max-runtime",
				attemptId: "attempt-max-runtime-1",
				freeze: createFreeze("flowfreeze:max-runtime", definition),
				runtimeBindingSnapshot: binding("binding-max-runtime"),
			},
		});

		expect(result.scheduler.activations.map(activation => [activation.nodeId, activation.status])).toEqual([
			["build", "aborted"],
		]);
		const families = reconstructWorkflowFamilies(host.getBranch());
		expect(families[0]?.attempts.map(attempt => [attempt.id, attempt.status, attempt.error])).toEqual([
			["attempt-max-runtime-1", "stopped", undefined],
		]);
		expect(families[0]?.attempts[0]?.activations[0]).toMatchObject({
			nodeId: "build",
			status: "aborted",
			reason: "workflow max runtime elapsed after 1ms",
		});
		expect(families[0]?.checkpoints).toMatchObject([
			{
				id: "attempt-max-runtime-1:checkpoint-1",
				attemptId: "attempt-max-runtime-1",
				completedActivationIds: [],
				abortedActivationIds: ["activation-1"],
				frontierNodeIds: ["build"],
				state: {},
				sourceMapping: { build: "build" },
			},
		]);
	});

	it("uses approved change request mappings when checkpointing activation-limited attempts", async () => {
		const host = createHost();
		const definition = parseWorkflowDefinition(source, { sourcePath: "workflow.yml" });
		startWorkflowFamily(host, { familyId: "family-mapped-limit" });
		proposeWorkflowChangeRequest(host, {
			changeRequestId: "change-review",
			familyId: "family-mapped-limit",
			attemptId: "attempt-mapped-limit-1",
			actor: "human:operator",
			origin: "human",
			reason: "upgrade review node before restart",
			operations: [],
			frontierMapping: { review: "strongReview" },
		});
		approveWorkflowChangeRequest(host, {
			changeRequestId: "change-review",
			actor: "human:sihao",
		});
		const runtimeHost: WorkflowNodeRuntimeHost = {
			runAgentNode: async () => ({ summary: "build completed" }),
		};

		await runWorkflow({
			host,
			definition,
			runId: "run-mapped-limit",
			startNodeId: "build",
			runtimeHost,
			maxActivations: 1,
			lifecycle: {
				familyId: "family-mapped-limit",
				attemptId: "attempt-mapped-limit-1",
				freeze: createFreeze("flowfreeze:mapped-limit", definition),
				runtimeBindingSnapshot: binding("binding-mapped-limit"),
			},
		});

		const families = reconstructWorkflowFamilies(host.getBranch());
		expect(families[0]?.checkpoints[0]?.sourceMapping).toEqual({ review: "strongReview" });
	});

	it("resolves parent output prompts from checkpointed activations during restart", async () => {
		const host = createHost();
		const definition = parseWorkflowDefinition(
			`
name: checkpoint-prompt-restart
version: 1
nodes:
  runValidation:
    type: script
  strongReview:
    type: review
    agent: task
    prompt:
      output:
        node: runValidation
        path: /data/reviewPrompt
        activation: parent
    reads:
      - /data/reviewPrompt
    gates:
      - approve
edges:
  - from: runValidation
    to: strongReview
`,
			{ sourcePath: "workflow.yml" },
		);
		const receivedPrompts: string[] = [];
		const runtimeHost: WorkflowNodeRuntimeHost = {
			runReviewNode: async input => {
				receivedPrompts.push(input.prompt ?? "");
				return { summary: "approved", verdict: "approve" };
			},
		};

		const result = await runWorkflow({
			host,
			definition,
			runId: "run-restart",
			startNodeId: "strongReview",
			runtimeHost,
			completedActivations: [
				{
					id: "activation-1",
					nodeId: "runValidation",
					graphRevisionId: "previous-graph",
					status: "completed",
					parentActivationIds: [],
					output: {
						summary: "validation passed",
						data: { reviewPrompt: "Review the checkpointed validation report." },
					},
				},
			],
			startParentActivationIds: ["activation-1"],
		});

		expect(receivedPrompts).toEqual(["Review the checkpointed validation report."]);
		expect(
			result.scheduler.activations.map(activation => [activation.id, activation.nodeId, activation.status]),
		).toEqual([["activation-2", "strongReview", "completed"]]);
	});

	it("persists failed activations when node execution rejects", async () => {
		const host = createHost();
		const definition = parseWorkflowDefinition(source, { sourcePath: "workflow.yml" });
		const runtimeHost: WorkflowNodeRuntimeHost = {
			runAgentNode: async () => {
				throw new Error("build failed");
			},
		};

		const result = await runWorkflow({
			host,
			definition,
			runId: "run-1",
			startNodeId: "build",
			runtimeHost,
			modelResolution: { availableModels: [openAiModel] },
		});

		expect(result.scheduler.activations.map(activation => [activation.nodeId, activation.status])).toEqual([
			["build", "failed"],
		]);
		const reconstructed = reconstructWorkflowRuns(host.getBranch());
		expect(reconstructed[0]?.activations).toMatchObject([
			{
				id: "activation-1",
				nodeId: "build",
				graphRevisionId: "run-1:graph-0",
				status: "failed",
				error: "build failed",
			},
		]);
	});

	it("loads package-local script files with their declared language", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-workflow-script-file-"));
		try {
			await fs.mkdir(path.join(dir, "scripts"), { recursive: true });
			await Bun.write(path.join(dir, "scripts", "score.py"), 'print("scored")\n');
			const definition = parseWorkflowDefinition(
				`
name: script-file-workflow
version: 1
nodes:
  score:
    type: script
    script:
      language: py
      file: ./scripts/score.py
edges: []
`,
				{ sourcePath: path.join(dir, "workflow.yml") },
			);
			const host = createHost();
			let capturedInput: WorkflowScriptNodeInput | undefined;
			const runtimeHost: WorkflowNodeRuntimeHost = {
				runScriptNode: async input => {
					capturedInput = input;
					return {
						summary: "scored",
						data: { exitCode: 0 },
					};
				},
			};

			await runWorkflow({
				host,
				definition,
				runId: "run-script-file",
				startNodeId: "score",
				runtimeHost,
				packageRoot: dir,
			});

			expect(capturedInput?.script).toBe('print("scored")\n');
			expect(capturedInput?.scriptLanguage).toBe("py");
			expect(capturedInput?.scriptPath).toBe("./scripts/score.py");
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
