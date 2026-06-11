import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Settings } from "../../src/config/settings";
import type { InteractiveModeContext } from "../../src/modes/types";
import type { AgentSession } from "../../src/session/agent-session";
import type { SessionManager } from "../../src/session/session-manager";
import { executeAcpBuiltinSlashCommand } from "../../src/slash-commands/acp-builtins";
import { executeBuiltinSlashCommand } from "../../src/slash-commands/builtin-registry";
import { parseWorkflowDefinition } from "../../src/workflow/definition";
import type { FlowFreeze } from "../../src/workflow/freeze";
import {
	appendWorkflowAttemptActivationCompleted,
	appendWorkflowAttemptActivationStarted,
	approveWorkflowChangeRequest,
	proposeWorkflowChangeRequest,
	reconstructWorkflowFamilies,
	recordWorkflowFreeze,
	startWorkflowAttempt,
	startWorkflowFamily,
} from "../../src/workflow/lifecycle";
import type { WorkflowNodeRuntimeHost } from "../../src/workflow/node-runtime";
import {
	appendWorkflowActivationCompleted,
	appendWorkflowActivationStarted,
	appendWorkflowGraphPatchApplied,
	appendWorkflowGraphPatchProposed,
	reconstructWorkflowRuns,
	startWorkflowRun,
	type WorkflowRunStoreHost,
} from "../../src/workflow/run-store";
import type { WorkflowAgentTaskRunner } from "../../src/workflow/session-runtime";

interface CapturedEntry {
	type: "custom";
	customType: string;
	data?: unknown;
}

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

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-workflow-slash-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

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

function createRuntime(entries: CapturedEntry[], workflowRuntimeHost?: WorkflowNodeRuntimeHost) {
	const output: string[] = [];
	const session = {} as AgentSession;
	const sessionManager = {
		appendCustomEntry: (customType: string, data?: unknown) => {
			entries.push({ type: "custom", customType, data });
			return `entry-${entries.length}`;
		},
		getBranch: () => entries,
	} as unknown as SessionManager;
	return {
		output,
		runtime: {
			session,
			sessionManager,
			settings: Settings.isolated(),
			cwd: path.resolve("temp", "project"),
			output: (text: string) => {
				output.push(text);
			},
			createWorkflowRuntimeHost: workflowRuntimeHost ? () => workflowRuntimeHost : undefined,
			refreshCommands: () => {},
			reloadPlugins: async () => {},
		},
	};
}

function createTuiRuntime(entries: CapturedEntry[], cwd: string, runner: WorkflowAgentTaskRunner) {
	const output: string[] = [];
	const session = {
		getWorkflowAgentTaskRunner: () => runner,
		getWorkflowScriptEvalRunner: () => undefined,
		getWorkflowHumanInputRunner: () => undefined,
		getAvailableModels: () => [openAiModel],
		modelRegistry: {
			getAvailable: () => [openAiModel],
		},
		model: openAiModel,
	} as unknown as AgentSession;
	const sessionManager = {
		appendCustomEntry: (customType: string, data?: unknown) => {
			entries.push({ type: "custom", customType, data });
			return `entry-${entries.length}`;
		},
		getBranch: () => entries,
		getCwd: () => cwd,
	} as unknown as SessionManager;
	const ctx = {
		session,
		sessionManager,
		settings: Settings.isolated(),
		showStatus: (text: string) => {
			output.push(text);
		},
		editor: { setText: () => {} },
		refreshSlashCommandState: () => {},
	} as unknown as InteractiveModeContext;
	return {
		output,
		runtime: {
			ctx,
			handleBackgroundCommand: () => {},
		},
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
		modelChanges: [],
		permissionChanges: [],
		modelRoleChanges: [],
		warnings: [],
	};
}

describe("/workflow slash command", () => {
	it("reports when the current session has no workflow runs", async () => {
		const { output, runtime } = createRuntime([]);

		const result = await executeAcpBuiltinSlashCommand("/workflow inspect", runtime);

		expect(result).toEqual({ consumed: true });
		expect(output).toEqual(["No workflow runs or workflow families found."]);
	});

	it("prints a compact inspection summary for the latest workflow run", async () => {
		const host = createHost();
		const definition = parseWorkflowDefinition(
			`
name: slash-demo
version: 1
nodes:
  build:
    type: agent
  review:
    type: review
edges:
  - from: build
    to: review
`,
			{ sourcePath: "workflow.yml" },
		);
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
				requestedPattern: "openai/gpt-4o",
				unavailablePolicy: "fallback-to-parent",
				resolvedModel: "openai/gpt-4o",
				explicitThinkingLevel: false,
				fallbackUsed: false,
			},
		});
		const { output, runtime } = createRuntime(host.entries);

		const result = await executeAcpBuiltinSlashCommand("/workflow inspect", runtime);

		expect(result).toEqual({ consumed: true });
		expect(output[0]).toContain("Workflow run: run-1");
		expect(output[0]).toContain("Graph: 2 nodes, 1 edge");
		expect(output[0]).toContain("Graph nodes:");
		expect(output[0]).toContain("- build (agent)");
		expect(output[0]).toContain("- review (review)");
		expect(output[0]).toContain("Graph edges:");
		expect(output[0]).toContain("- build -> review");
		expect(output[0]).toContain("Activations: 1 completed");
		expect(output[0]).toContain("activation-1 build completed - built");
		expect(output[0]).toContain("activation-1 build openai/gpt-4o (workflow-default)");
	});

	it("prints graph patch audit summaries for workflow inspection", async () => {
		const host = createHost();
		const definition = parseWorkflowDefinition(
			`
name: slash-patch-demo
version: 1
nodes:
  build:
    type: agent
  review:
    type: review
edges:
  - from: build
    to: review
`,
			{ sourcePath: "workflow.yml" },
		);
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
		const { output, runtime } = createRuntime(host.entries);

		const result = await executeAcpBuiltinSlashCommand("/workflow inspect", runtime);

		expect(result).toEqual({ consumed: true });
		expect(output[0]).toContain("Graph patches: 1 pending, 1 applied");
		expect(output[0]).toContain("Pending graph patch proposals:");
		expect(output[0]).toContain(
			"- proposal-pending agent - request human gate (1 added node, 1 changed node, 1 added edge)",
		);
		expect(output[0]).toContain("Applied graph patches:");
		expect(output[0]).toContain(
			"- run-1:graph-1 supervisor from proposal-applied - approved scoreboard (1 added node, 1 changed node, 1 added edge)",
		);
	});

	it("starts a workflow package through an injected runtime host", async () => {
		const dir = await createTempDir();
		await Bun.write(
			path.join(dir, "workflow.yml"),
			`
name: slash-start-demo
version: 1
nodes:
  build:
    type: script
  finish:
    type: script
edges:
  - from: build
    to: finish
`,
		);
		const entries: CapturedEntry[] = [];
		const calls: string[] = [];
		const runtimeHost: WorkflowNodeRuntimeHost = {
			runScriptNode: async input => {
				calls.push(input.node.id);
				return { summary: `ran ${input.node.id}` };
			},
		};
		const { output, runtime } = createRuntime(entries, runtimeHost);

		const result = await executeAcpBuiltinSlashCommand(`/workflow start ${dir} --run-id run-1`, runtime);

		expect(result).toEqual({ consumed: true });
		expect(calls).toEqual(["build", "finish"]);
		expect(output[0]).toContain("Workflow run: run-1");
		expect(output[0]).toContain("Graph: 2 nodes, 1 edge");
		expect(output[0]).toContain("Activations: 2 completed");
		const runs = reconstructWorkflowRuns(entries);
		expect(runs[0]?.definition.name).toBe("slash-start-demo");
		expect(runs[0]?.activations.map(activation => [activation.nodeId, activation.status])).toEqual([
			["build", "completed"],
			["finish", "completed"],
		]);
	});

	it("freezes .omhflow resources before starting a lifecycle attempt", async () => {
		const dir = await createTempDir();
		await fs.mkdir(path.join(dir, "release", "prompts"), { recursive: true });
		await Bun.write(path.join(dir, "release", "prompts", "build.md"), "Use the frozen prompt.\n");
		await Bun.write(
			path.join(dir, "release.omhflow"),
			`---
name: portable-slash-demo
version: 1
schema: omhflow/v1
checkpoint:
  stopDeadlineMs: 50
changePolicy:
  agentsCanPropose: true
  humansCanApprove: true
---
# Portable Slash Demo

\`\`\`yaml workflow
nodes:
  build:
    type: script
  usePrompt:
    type: agent
    agent: task
    prompt:
      file: prompts/build.md
edges:
  - from: build
    to: usePrompt
\`\`\`
`,
		);
		const entries: CapturedEntry[] = [];
		let receivedPrompt: string | undefined;
		const runtimeHost: WorkflowNodeRuntimeHost = {
			runScriptNode: async input => {
				if (input.node.id === "build") {
					await Bun.write(path.join(dir, "release", "prompts", "build.md"), "Use the mutated prompt.\n");
				}
				return { summary: `ran ${input.node.id}` };
			},
			runAgentNode: async input => {
				receivedPrompt = input.prompt;
				return { summary: "used prompt" };
			},
		};
		const { output, runtime } = createRuntime(entries, runtimeHost);

		const result = await executeAcpBuiltinSlashCommand(
			`/workflow start ${path.join(dir, "release.omhflow")} --run-id run-omhflow --family-id family-omhflow`,
			runtime,
		);

		expect(result).toEqual({ consumed: true });
		expect(receivedPrompt).toBe("Use the frozen prompt.\n");
		expect(output[0]).toContain("Workflow run: run-omhflow");
		const families = reconstructWorkflowFamilies(entries);
		expect(families).toHaveLength(1);
		expect(families[0]?.freezes[0]?.flowPath).toBe(path.join(dir, "release.omhflow"));
		expect(families[0]?.attempts.map(attempt => [attempt.id, attempt.freezeId, attempt.status])).toEqual([
			["run-omhflow:attempt-1", families[0]?.freezes[0]?.id, "completed"],
		]);

		await executeAcpBuiltinSlashCommand("/workflow inspect", runtime);

		expect(output[1]).toContain("Workflow family: family-omhflow");
		expect(output[1]).toContain(`Freezes: ${families[0]?.freezes[0]?.id}`);
		expect(output[1]).toContain("run-omhflow:attempt-1 completed");
		expect(output[1]).toContain("binding=run-omhflow:binding-1");
	});

	it("freezes artifacts and records file-based change request approvals", async () => {
		const dir = await createTempDir();
		await fs.mkdir(path.join(dir, "release"), { recursive: true });
		await Bun.write(
			path.join(dir, "release.omhflow"),
			`---
name: change-command-demo
version: 1
schema: omhflow/v1
checkpoint:
  stopDeadlineMs: 50
changePolicy:
  agentsCanPropose: true
  humansCanApprove: true
---
# Change Command Demo

\`\`\`yaml workflow
nodes:
  build:
    type: script
edges: []
\`\`\`
`,
		);
		await Bun.write(
			path.join(dir, "change.json"),
			JSON.stringify({
				id: "change-1",
				actor: "agent:reviewer",
				origin: "internal-agent",
				reason: "insert verification",
				operations: [{ op: "add_node", node: { id: "verify", type: "script" } }],
				frontierMapping: { build: "verify" },
			}),
		);
		const entries: CapturedEntry[] = [];
		const { output, runtime } = createRuntime(entries);

		expect(
			await executeAcpBuiltinSlashCommand(
				`/workflow freeze ${path.join(dir, "release.omhflow")} --family-id family-1`,
				runtime,
			),
		).toEqual({ consumed: true });
		expect(
			await executeAcpBuiltinSlashCommand(
				`/workflow request-change ${path.join(dir, "change.json")} --family-id family-1 --attempt-id attempt-1`,
				runtime,
			),
		).toEqual({ consumed: true });
		expect(
			await executeAcpBuiltinSlashCommand("/workflow approve-change change-1 --actor human:sihao", runtime),
		).toEqual({
			consumed: true,
		});

		const families = reconstructWorkflowFamilies(entries);
		expect(output[0]).toContain("Workflow freeze: flowfreeze:");
		expect(output[1]).toContain("Workflow change request: change-1");
		expect(output[2]).toBe("Workflow change request approved: change-1");
		expect(families[0]?.id).toBe("family-1");
		expect(families[0]?.freezes).toHaveLength(1);
		expect(families[0]?.changeRequests).toMatchObject([
			{
				id: "change-1",
				status: "approved",
				actor: "agent:reviewer",
				origin: "internal-agent",
				approvedBy: "human:sihao",
				frontierMapping: { build: "verify" },
			},
		]);
	});

	it("starts agent workflows through the TUI session task runner", async () => {
		const dir = await createTempDir();
		await Bun.write(
			path.join(dir, "workflow.yml"),
			`
name: slash-agent-demo
version: 1
models:
  roles:
    builder: openai/gpt-4o
  defaults:
    agent: builder
nodes:
  build:
    type: agent
    agent: task
    prompt: Implement the workflow feature.
edges: []
`,
		);
		const entries: CapturedEntry[] = [];
		let requestedTask: unknown;
		const runner: WorkflowAgentTaskRunner = async request => {
			requestedTask = request.task;
			return { exitCode: 0, output: "agent completed" };
		};
		const { output, runtime } = createTuiRuntime(entries, dir, runner);

		const result = await executeBuiltinSlashCommand(`/workflow start ${dir} --run-id run-1`, runtime);

		expect(result).toBe(true);
		expect(requestedTask).toEqual({
			id: "build",
			description: "build",
			assignment: "Implement the workflow feature.",
		});
		expect(output[0]).toContain("Workflow run: run-1");
		expect(output[0]).toContain("Activations: 1 completed");
		expect(output[0]).toContain("activation-1 build openai/gpt-4o (workflow-default)");
		const runs = reconstructWorkflowRuns(entries);
		expect(runs[0]?.activations[0]?.output).toEqual({
			summary: "agent completed",
			data: { exitCode: 0 },
		});
		expect(runs[0]?.activations[0]?.modelAudit?.resolvedModel).toBe("openai/gpt-4o");
	});

	it("stops a running lifecycle attempt, checkpoints it, and restarts from a freeze", async () => {
		const entries: CapturedEntry[] = [];
		const freezeA = createFreeze("flowfreeze:a", ["build", "review"]);
		const freezeB = createFreeze("flowfreeze:b", ["review"]);
		const host = createHostFromEntries(entries);
		startWorkflowFamily(host, { familyId: "family-1" });
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
		appendWorkflowAttemptActivationStarted(host, {
			attemptId: "attempt-1",
			activationId: "activation-2",
			nodeId: "review",
			parentActivationIds: ["activation-1"],
		});
		proposeWorkflowChangeRequest(host, {
			changeRequestId: "change-1",
			familyId: "family-1",
			attemptId: "attempt-1",
			actor: "agent:reviewer",
			origin: "internal-agent",
			reason: "switch to reviewed freeze",
			operations: [{ op: "add_node", node: { id: "review", type: "script" } }],
			frontierMapping: { review: "review" },
		});
		approveWorkflowChangeRequest(host, {
			changeRequestId: "change-1",
			actor: "human:sihao",
		});
		recordWorkflowFreeze(host, freezeB, { familyId: "family-1" });
		const calls: string[] = [];
		const runtimeHost: WorkflowNodeRuntimeHost = {
			runScriptNode: async input => {
				calls.push(input.node.id);
				return { summary: `ran ${input.node.id}` };
			},
		};
		const { output, runtime } = createRuntime(entries, runtimeHost);

		expect(await executeAcpBuiltinSlashCommand("/workflow stop attempt-1 --deadline-ms 5", runtime)).toEqual({
			consumed: true,
		});
		expect(
			await executeAcpBuiltinSlashCommand(
				"/workflow restart attempt-1:checkpoint-1 --freeze-id flowfreeze:b",
				runtime,
			),
		).toEqual({
			consumed: true,
		});

		const families = reconstructWorkflowFamilies(entries);
		expect(calls).toEqual(["review"]);
		expect(output.at(-2)).toContain("Workflow checkpoint: attempt-1:checkpoint-1");
		expect(output.at(-1)).toContain("Workflow restart attempt: attempt-2");
		expect(families[0]?.attempts.map(attempt => [attempt.id, attempt.freezeId, attempt.status])).toEqual([
			["attempt-1", "flowfreeze:a", "stopped"],
			["attempt-2", "flowfreeze:b", "completed"],
		]);
		expect(families[0]?.checkpoints[0]).toMatchObject({
			id: "attempt-1:checkpoint-1",
			completedActivationIds: ["activation-1"],
			abortedActivationIds: ["activation-2"],
			frontierNodeIds: ["review"],
		});
		expect(families[0]?.changeRequests).toMatchObject([
			{
				id: "change-1",
				status: "approved",
				actor: "agent:reviewer",
				approvedBy: "human:sihao",
				frontierMapping: { review: "review" },
			},
		]);
	});
});

function createHostFromEntries(entries: CapturedEntry[]): WorkflowRunStoreHost & { entries: CapturedEntry[] } {
	return {
		entries,
		appendCustomEntry: (customType, data) => {
			entries.push({ type: "custom", customType, data });
			return `entry-${entries.length}`;
		},
		getBranch: () => entries,
	};
}

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

function createFreeze(id: string, nodeIds: string[]): FlowFreeze {
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
			nodes: Object.fromEntries(nodeIds.map(nodeId => [nodeId, { sourceBlock: "workflow:0" }])),
		},
		staticCheckReport: { status: "passed", checks: [{ name: "fixture", status: "passed" }] },
		portableDefaults: { models: { roles: { builder: "openai/gpt-4o" }, defaults: { agent: "builder" } } },
		definition: {
			name: id,
			version: 1,
			models: { roles: { builder: "openai/gpt-4o" }, defaults: { agent: "builder" } },
			nodes: nodeIds.map(nodeId => ({ id: nodeId, type: "script" })),
			edges:
				nodeIds.length > 1
					? nodeIds.slice(0, -1).map((nodeId, index) => ({ from: nodeId, to: nodeIds[index + 1]! }))
					: [],
		},
	};
}
