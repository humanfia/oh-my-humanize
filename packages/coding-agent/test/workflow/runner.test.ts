import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils";
import { $ } from "bun";
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
import { runWorkflow, selectWorkflowResourceTempRoot } from "../../src/workflow/runner";

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

async function initializeGitWorkspace(workspace: string): Promise<void> {
	await $`git init`.cwd(workspace).quiet();
	await Bun.write(path.join(workspace, "README.md"), "baseline\n");
	await $`git add README.md`.cwd(workspace).quiet();
	await $`git -c user.name=omh-test -c user.email=omh-test@example.invalid -c commit.gpgsign=false commit -m baseline`
		.cwd(workspace)
		.quiet();
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

	it("fails read-only workspace nodes before persisting their state when they mutate files", async () => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "omp-workflow-readonly-workspace-"));
		try {
			await initializeGitWorkspace(workspace);
			const host = createHost();
			const definition = parseWorkflowDefinition(
				`
name: read-only-workspace-demo
version: 1
nodes:
  inspect:
    type: agent
    agent: task
    workspaceAccess: read
    writes:
      - /audit
  patch:
    type: script
    script:
      language: sh
      inline: echo patch
    writes:
      - /done
edges:
  - from: inspect
    to: patch
`,
				{ sourcePath: "workflow.yml" },
			);
			const runtimeHost: WorkflowNodeRuntimeHost = {
				runAgentNode: async () => {
					await Bun.write(path.join(workspace, "src", "unexpected.ts"), "export const unexpected = true;\n");
					return {
						summary: "inspection yielded after mutating files",
						statePatch: [{ op: "set", path: "/audit", value: { status: "done" } }],
					};
				},
				runScriptNode: async () => ({
					summary: "patch should not run",
					statePatch: [{ op: "set", path: "/done", value: true }],
				}),
			};

			const result = await runWorkflow({
				host,
				definition,
				runId: "run-read-only-workspace",
				startNodeId: "inspect",
				runtimeHost,
				workspaceRoot: workspace,
			});

			expect(result.scheduler.activations.map(activation => [activation.nodeId, activation.status])).toEqual([
				["inspect", "failed"],
			]);
			expect(result.scheduler.activations[0]?.error).toContain(
				'workflow node "inspect" declared workspaceAccess=read but changed workspace',
			);
			expect(result.scheduler.state).toEqual({});
			expect(reconstructWorkflowRuns(host.getBranch())[0]?.state).toEqual({});
		} finally {
			await fs.rm(workspace, { recursive: true, force: true });
		}
	});

	it("allows read-only workspace nodes to write configured task-local runtime scratch", async () => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "omp-workflow-readonly-scratch-"));
		const taskLocalTmp = path.join(workspace, "workflow-output", "tmp");
		const previousTmpDir = process.env.TMPDIR;
		const previousRunTmp = process.env.OMH_RUN_TMP;
		try {
			await initializeGitWorkspace(workspace);
			await fs.mkdir(taskLocalTmp, { recursive: true });
			process.env.TMPDIR = taskLocalTmp;
			Bun.env.TMPDIR = taskLocalTmp;
			process.env.OMH_RUN_TMP = taskLocalTmp;
			Bun.env.OMH_RUN_TMP = taskLocalTmp;
			const host = createHost();
			const definition = parseWorkflowDefinition(
				`
name: read-only-runtime-scratch-demo
version: 1
nodes:
  inspect:
    type: agent
    agent: task
    workspaceAccess: read
    writes:
      - /audit
edges: []
`,
				{ sourcePath: "workflow.yml" },
			);
			const runtimeHost: WorkflowNodeRuntimeHost = {
				runAgentNode: async () => {
					await Bun.write(path.join(taskLocalTmp, "omp-python-runner", "runner.py"), "print('runtime cache')\n");
					return {
						summary: "inspection used runtime scratch only",
						statePatch: [{ op: "set", path: "/audit", value: { status: "done" } }],
					};
				},
			};

			const result = await runWorkflow({
				host,
				definition,
				runId: "run-read-only-runtime-scratch",
				startNodeId: "inspect",
				runtimeHost,
				workspaceRoot: workspace,
			});

			expect(result.scheduler.activations.map(activation => [activation.nodeId, activation.status])).toEqual([
				["inspect", "completed"],
			]);
			expect(result.scheduler.state).toEqual({ audit: { status: "done" } });
		} finally {
			if (previousTmpDir === undefined) {
				delete process.env.TMPDIR;
				delete Bun.env.TMPDIR;
			} else {
				process.env.TMPDIR = previousTmpDir;
				Bun.env.TMPDIR = previousTmpDir;
			}
			if (previousRunTmp === undefined) {
				delete process.env.OMH_RUN_TMP;
				delete Bun.env.OMH_RUN_TMP;
			} else {
				process.env.OMH_RUN_TMP = previousRunTmp;
				Bun.env.OMH_RUN_TMP = previousRunTmp;
			}
			await fs.rm(workspace, { recursive: true, force: true });
		}
	});

	it("allows read-only workspace nodes when upstream nodes already dirtied the workspace", async () => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "omp-workflow-readonly-existing-dirty-"));
		try {
			await initializeGitWorkspace(workspace);
			const host = createHost();
			const definition = parseWorkflowDefinition(
				`
name: read-only-after-patch-demo
version: 1
nodes:
  patch:
    type: agent
    agent: task
    workspaceAccess: write
    writes:
      - /patch
  review:
    type: review
    workspaceAccess: read
    gates:
      - finish
    fallbackVerdict: finish
    writes:
      - /review
edges:
  - from: patch
    to: review
`,
				{ sourcePath: "workflow.yml" },
			);
			const runtimeHost: WorkflowNodeRuntimeHost = {
				runAgentNode: async () => {
					await Bun.write(path.join(workspace, "src", "expected.ts"), "export const expected = true;\n");
					return {
						summary: "patch completed",
						statePatch: [{ op: "set", path: "/patch", value: { changed: "src/expected.ts" } }],
					};
				},
				runReviewNode: async () => ({
					summary: "review accepted existing patch",
					verdict: "finish",
					statePatch: [{ op: "set", path: "/review", value: "finish" }],
				}),
			};

			const result = await runWorkflow({
				host,
				definition,
				runId: "run-read-only-after-patch",
				startNodeId: "patch",
				runtimeHost,
				workspaceRoot: workspace,
			});

			expect(result.scheduler.activations.map(activation => [activation.nodeId, activation.status])).toEqual([
				["patch", "completed"],
				["review", "completed"],
			]);
			expect(result.scheduler.state).toMatchObject({
				patch: { changed: "src/expected.ts" },
				review: "finish",
			});
		} finally {
			await fs.rm(workspace, { recursive: true, force: true });
		}
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

	it("blocks script-only cycles that repeat without workflow progress", async () => {
		const host = createHost();
		const definition = parseWorkflowDefinition(
			`
name: liveness-guard-demo
version: 1
nodes:
  hold:
    type: script
  check:
    type: script
edges:
  - from: hold
    to: check
  - from: check
    to: hold
`,
			{ sourcePath: "workflow.yml" },
		);
		const runtimeHost: WorkflowNodeRuntimeHost = {
			runScriptNode: async input => ({
				summary: `${input.node.id} observed no progress`,
				data: { elapsedMs: 1000 },
			}),
		};

		const result = await runWorkflow({
			host,
			definition,
			runId: "run-liveness-guard",
			startNodeId: "hold",
			runtimeHost,
			maxActivations: 20,
		});

		expect(result.scheduler.limitReached).toBe(false);
		expect(result.scheduler.activations.map(activation => [activation.nodeId, activation.status])).toEqual([
			["hold", "completed"],
			["check", "completed"],
			["hold", "completed"],
			["check", "completed"],
			["hold", "failed"],
		]);
		expect(result.scheduler.activations.at(-1)?.error).toContain(
			'workflow liveness guard blocked script-only cycle at node "hold"',
		);
		const reconstructed = reconstructWorkflowRuns(host.getBranch());
		expect(reconstructed[0]?.activations.at(-1)).toMatchObject({
			nodeId: "hold",
			status: "failed",
		});
	});

	it("does not treat honest agent retry non-convergence as fake script progress", async () => {
		const host = createHost();
		const definition = parseWorkflowDefinition(agentDecisionSource, { sourcePath: "workflow.yml" });
		const runtimeHost: WorkflowNodeRuntimeHost = {
			runAgentNode: async () => ({
				summary: "agent requested another retry",
				data: { verdict: "retry" },
			}),
			runScriptNode: async input => ({
				summary: `${input.node.id} completed without artifacts`,
			}),
		};

		const result = await runWorkflow({
			host,
			definition,
			runId: "run-agent-non-converged",
			startNodeId: "decide",
			runtimeHost,
			maxActivations: 5,
		});

		expect(result.scheduler.limitReached).toBe(true);
		expect(result.scheduler.activations.map(activation => [activation.nodeId, activation.status])).toEqual([
			["decide", "completed"],
			["retry", "completed"],
			["decide", "completed"],
			["retry", "completed"],
			["decide", "completed"],
		]);
		expect(result.scheduler.activations.some(activation => activation.status === "failed")).toBe(false);
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
				return {
					summary: "build completed",
					statePatch: [{ op: "set", path: "/work", value: { summary: "built" } }],
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
		expect(receivedSignal).toBeDefined();
		expect(receivedSignal).not.toBe(stopController.signal);
		expect(receivedSignal?.aborted).toBe(false);
		const families = reconstructWorkflowFamilies(host.getBranch());
		expect(families[0]?.attempts[0]?.status).toBe("stopped");
		expect(families[0]?.checkpoints[0]?.frontierNodeIds).toEqual(["review"]);
	});

	it("stops at a parsed checkpoint-after node with a restartable frontier", async () => {
		const host = createHost();
		const definition = parseWorkflowDefinition(
			`
name: checkpoint-after-demo
version: 1
nodes:
  approve:
    type: human
    checkpoint: after
    writes:
      - /approval
  continueWork:
    type: script
edges:
  - from: approve
    to: continueWork
`,
			{ sourcePath: "workflow.yml" },
		);
		const runtimeHost: WorkflowNodeRuntimeHost = {
			runHumanNode: async () => ({
				summary: "approved",
				data: { response: "Approve" },
				statePatch: [{ op: "set", path: "/approval", value: { response: "Approve" } }],
			}),
			runScriptNode: async () => {
				throw new Error("continuation should not run before checkpoint restart");
			},
		};

		const result = await runWorkflow({
			host,
			definition,
			runId: "run-checkpoint-after",
			startNodeId: "approve",
			runtimeHost,
			lifecycle: {
				familyId: "family-checkpoint-after",
				attemptId: "attempt-checkpoint-after-1",
				freeze: createFreeze("flowfreeze:checkpoint-after", definition),
				runtimeBindingSnapshot: binding("binding-checkpoint-after"),
			},
		});

		expect(definition.nodes[0]?.checkpoint).toBe("after");
		expect(result.scheduler.activations.map(activation => [activation.nodeId, activation.status])).toEqual([
			["approve", "completed"],
		]);
		expect(result.scheduler.state).toEqual({ approval: { response: "Approve" } });
		const family = reconstructWorkflowFamilies(host.getBranch())[0];
		expect(family?.attempts[0]).toMatchObject({
			status: "stopped",
			stop: { reason: 'workflow node "approve" requested checkpoint after completion' },
		});
		expect(family?.checkpoints[0]).toMatchObject({
			completedActivationIds: ["activation-1"],
			abortedActivationIds: [],
			frontierNodeIds: ["continueWork"],
			sourceMapping: { continueWork: "continueWork" },
		});
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

	it("waits for the node abort signal after a graceful scheduler stop before checkpointing", async () => {
		const host = createHost();
		const definition = parseWorkflowDefinition(source, { sourcePath: "workflow.yml" });
		const stopController = new AbortController();
		const nodeAbortController = new AbortController();
		const started = Promise.withResolvers<void>();
		const never = Promise.withResolvers<never>();
		const runtimeHost: WorkflowNodeRuntimeHost = {
			runAgentNode: async () => {
				started.resolve();
				return await never.promise;
			},
			runReviewNode: async () => ({ summary: "review should not run", verdict: "finish" }),
		};

		const resultPromise = runWorkflow({
			host,
			definition,
			runId: "run-graceful-stop-before-node-abort",
			startNodeId: "build",
			runtimeHost,
			signal: stopController.signal,
			nodeAbortSignal: nodeAbortController.signal,
			lifecycle: {
				familyId: "family-graceful-stop-before-node-abort",
				attemptId: "attempt-graceful-stop-before-node-abort-1",
				freeze: createFreeze("flowfreeze:graceful-stop-before-node-abort", definition),
				runtimeBindingSnapshot: binding("binding-graceful-stop-before-node-abort"),
			},
		});
		await started.promise;

		stopController.abort("slash command stop");
		const earlyResult = await Promise.race([
			resultPromise.then(() => "finished" as const),
			Bun.sleep(10).then(() => "waiting" as const),
		]);
		expect(earlyResult).toBe("waiting");

		nodeAbortController.abort("stop deadline elapsed");
		const result = await Promise.race([resultPromise, Bun.sleep(100).then(() => "timeout" as const)]);
		if (result === "timeout") {
			throw new Error("workflow stop did not checkpoint after the node abort signal");
		}

		expect(result.scheduler.activations.map(activation => [activation.nodeId, activation.status])).toEqual([
			["build", "aborted"],
		]);
		const families = reconstructWorkflowFamilies(host.getBranch());
		expect(families[0]?.attempts.map(attempt => [attempt.id, attempt.status, attempt.error])).toEqual([
			["attempt-graceful-stop-before-node-abort-1", "stopped", undefined],
		]);
		expect(families[0]?.checkpoints).toMatchObject([
			{
				id: "attempt-graceful-stop-before-node-abort-1:checkpoint-1",
				attemptId: "attempt-graceful-stop-before-node-abort-1",
				completedActivationIds: [],
				abortedActivationIds: ["activation-1"],
				frontierNodeIds: ["build"],
				state: {},
				sourceMapping: { build: "build" },
			},
		]);
	});

	it("checkpoints deadline-aborted lifecycle activations even when the runtime ignores abort", async () => {
		const host = createHost();
		const definition = parseWorkflowDefinition(source, { sourcePath: "workflow.yml" });
		const stopController = new AbortController();
		const nodeAbortController = new AbortController();
		const started = Promise.withResolvers<void>();
		const never = Promise.withResolvers<never>();
		const runtimeHost: WorkflowNodeRuntimeHost = {
			runAgentNode: async () => {
				started.resolve();
				return await never.promise;
			},
			runReviewNode: async () => ({ summary: "review should not run", verdict: "finish" }),
		};

		const resultPromise = runWorkflow({
			host,
			definition,
			runId: "run-node-abort-ignored",
			startNodeId: "build",
			runtimeHost,
			signal: stopController.signal,
			nodeAbortSignal: nodeAbortController.signal,
			lifecycle: {
				familyId: "family-node-abort-ignored",
				attemptId: "attempt-node-abort-ignored-1",
				freeze: createFreeze("flowfreeze:node-abort-ignored", definition),
				runtimeBindingSnapshot: binding("binding-node-abort-ignored"),
			},
		});
		await started.promise;

		stopController.abort("workflow stop requested");
		nodeAbortController.abort("stop deadline elapsed");
		const result = await Promise.race([resultPromise, Bun.sleep(100).then(() => "timeout" as const)]);
		if (result === "timeout") {
			throw new Error("workflow stop did not checkpoint when the node runtime ignored abort");
		}

		expect(result.scheduler.activations.map(activation => [activation.nodeId, activation.status])).toEqual([
			["build", "aborted"],
		]);
		const families = reconstructWorkflowFamilies(host.getBranch());
		expect(families[0]?.attempts.map(attempt => [attempt.id, attempt.status, attempt.error])).toEqual([
			["attempt-node-abort-ignored-1", "stopped", undefined],
		]);
		expect(families[0]?.attempts[0]?.activations.map(activation => [activation.nodeId, activation.status])).toEqual([
			["build", "aborted"],
		]);
		expect(families[0]?.checkpoints).toMatchObject([
			{
				id: "attempt-node-abort-ignored-1:checkpoint-1",
				attemptId: "attempt-node-abort-ignored-1",
				completedActivationIds: [],
				abortedActivationIds: ["activation-1"],
				frontierNodeIds: ["build"],
				state: {},
				sourceMapping: { build: "build" },
			},
		]);
	});

	it("waits for fail-fast aborted sibling runtimes before failing a lifecycle attempt", async () => {
		const host = createHost();
		const definition = parseWorkflowDefinition(
			`
name: parallel-fail-fast-runner-demo
version: 1
nodes:
  start:
    type: script
  left:
    type: script
    writes:
      - /left
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
		const leftStarted = Promise.withResolvers<void>();
		let leftSettled = false;
		const calls: string[] = [];
		const runtimeHost: WorkflowNodeRuntimeHost = {
			runScriptNode: async input => {
				calls.push(input.node.id);
				if (input.node.id === "left") {
					leftStarted.resolve();
					const signal = input.signal;
					if (signal === undefined) {
						throw new Error("left activation missing abort signal");
					}
					const abortWait = Promise.withResolvers<void>();
					const onAbort = () => abortWait.resolve();
					if (signal.aborted) {
						onAbort();
					} else {
						signal.addEventListener("abort", onAbort, { once: true });
					}
					await abortWait.promise;
					await Bun.sleep(25);
					leftSettled = true;
					return {
						summary: "left drained after sibling failure",
						statePatch: [{ op: "set", path: "/left", value: "discarded" }],
					};
				}
				if (input.node.id === "right") {
					await leftStarted.promise;
					throw new Error("right exploded");
				}
				return { summary: `ran ${input.node.id}` };
			},
		};

		const result = await runWorkflow({
			host,
			definition,
			runId: "run-parallel-fail-fast",
			startNodeId: "start",
			runtimeHost,
			lifecycle: {
				familyId: "family-parallel-fail-fast",
				attemptId: "attempt-parallel-fail-fast-1",
				freeze: createFreeze("flowfreeze:parallel-fail-fast", definition),
				runtimeBindingSnapshot: binding("binding-parallel-fail-fast"),
			},
		});

		expect(leftSettled).toBe(true);
		expect(calls).toEqual(["start", "left", "right"]);
		expect(
			result.scheduler.activations.map(activation => [activation.nodeId, activation.status, activation.error]),
		).toEqual([
			["start", "completed", undefined],
			["left", "aborted", undefined],
			["right", "failed", "right exploded"],
		]);
		expect(reconstructWorkflowRuns(host.getBranch())[0]?.state).toEqual({});
		const families = reconstructWorkflowFamilies(host.getBranch());
		expect(families[0]?.attempts.map(attempt => [attempt.id, attempt.status, attempt.error])).toEqual([
			["attempt-parallel-fail-fast-1", "failed", "right exploded"],
		]);
		expect(families[0]?.attempts[0]?.activations.map(activation => [activation.nodeId, activation.status])).toEqual([
			["start", "completed"],
			["left", "aborted"],
			["right", "failed"],
		]);
		expect(families[0]?.checkpoints).toMatchObject([
			{
				id: "attempt-parallel-fail-fast-1:checkpoint-1",
				attemptId: "attempt-parallel-fail-fast-1",
				completedActivationIds: ["activation-1"],
				abortedActivationIds: ["activation-2"],
				frontierNodeIds: ["right"],
				state: {},
				sourceMapping: { right: "right" },
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
			runAgentNode: async () => ({
				summary: "build completed",
				statePatch: [{ op: "set", path: "/work", value: { summary: "built" } }],
			}),
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

	it("materializes structured node data into a single declared workflow write path", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-workflow-auto-write-"));
		try {
			await fs.mkdir(path.join(dir, "prompts"), { recursive: true });
			await Bun.write(path.join(dir, "prompts", "build.md"), "Inventory:\n{{inventory}}\n");
			const definition = parseWorkflowDefinition(
				`
name: data-write-workflow
version: 1
nodes:
  inventory:
    type: agent
    agent: task
    writes:
      - /inventory
  build:
    type: agent
    agent: task
    reads:
      - /inventory
    prompt:
      template:
        file: prompts/build.md
        bindings:
          inventory:
            state: /inventory
edges:
  - from: inventory
    to: build
`,
				{ sourcePath: path.join(dir, "workflow.yml") },
			);
			const host = createHost();
			let buildPrompt = "";
			const runtimeHost: WorkflowNodeRuntimeHost = {
				runAgentNode: async input => {
					if (input.node.id === "inventory") {
						return {
							summary: "inventoried",
							data: {
								files: ["README.md", "src/index.ts"],
								risk: "medium",
							},
						};
					}
					buildPrompt = input.prompt ?? "";
					return { summary: "built" };
				},
			};

			const result = await runWorkflow({
				host,
				definition,
				runId: "run-data-write",
				startNodeId: "inventory",
				runtimeHost,
				packageRoot: dir,
			});

			expect(result.scheduler.state).toEqual({
				inventory: {
					files: ["README.md", "src/index.ts"],
					risk: "medium",
				},
			});
			expect(buildPrompt).toBe(
				'Inventory:\n{\n  "files": [\n    "README.md",\n    "src/index.ts"\n  ],\n  "risk": "medium"\n}',
			);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
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

	it("keeps frozen resource staging outside task-local temporary directories", async () => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "omp-workflow-resource-workspace-"));
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-workflow-resource-agent-"));
		const taskLocalTmp = path.join(workspace, "workflow-output", "tmp");
		const previousTmpDir = process.env.TMPDIR;
		const previousAgentDir = getAgentDir();
		try {
			await fs.mkdir(taskLocalTmp, { recursive: true });
			process.env.TMPDIR = taskLocalTmp;
			Bun.env.TMPDIR = taskLocalTmp;
			setAgentDir(agentDir);
			const definition = parseWorkflowDefinition(
				`
name: resource-staging-demo
version: 1
nodes:
  inspect:
    type: script
    writes:
      - /resources
edges: []
`,
				{ sourcePath: path.join(workspace, "workflow.yml") },
			);
			const host = createHost();
			let capturedInput: WorkflowScriptNodeInput | undefined;
			const runtimeHost: WorkflowNodeRuntimeHost = {
				runScriptNode: async input => {
					capturedInput = input;
					return {
						summary: "inspected workflow resources",
						data: { resourceDir: input.resourceDir },
					};
				},
			};

			await runWorkflow({
				host,
				definition,
				runId: "run-resource-staging",
				startNodeId: "inspect",
				runtimeHost,
				workspaceRoot: workspace,
				frozenResources: [
					{
						path: "fixtures/message.txt",
						hash: "sha256:fixture",
						text: "resource-ok\n",
						byteLength: 12,
					},
				],
			});

			expect(capturedInput?.resourceDir).toBeDefined();
			const relativeToWorkspace = path.relative(workspace, capturedInput!.resourceDir!);
			expect(relativeToWorkspace.startsWith("..")).toBe(true);
			expect(capturedInput?.resourceDir).toContain(path.join(agentDir, "cache", "workflows", "resources"));
			expect(
				await Bun.file(path.join(workspace, "workflow-output", "tmp", "fixtures", "message.txt")).exists(),
			).toBe(false);
		} finally {
			if (previousTmpDir === undefined) {
				delete process.env.TMPDIR;
				delete Bun.env.TMPDIR;
			} else {
				process.env.TMPDIR = previousTmpDir;
				Bun.env.TMPDIR = previousTmpDir;
			}
			setAgentDir(previousAgentDir);
			await fs.rm(workspace, { recursive: true, force: true });
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});

	it("falls back from a workspace-local temp root for workflow resources", () => {
		const selected = selectWorkflowResourceTempRoot(
			"/repo/workspace/workflow-output/tmp",
			"/repo/workspace",
			"/home/user/.omp/agent/cache/workflows/resources",
		);

		expect(selected).toBe("/home/user/.omp/agent/cache/workflows/resources");
	});
});
