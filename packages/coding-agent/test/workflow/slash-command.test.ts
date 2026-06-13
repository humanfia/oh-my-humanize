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
import { parseWorkflowDefinition, type WorkflowDefinition } from "../../src/workflow/definition";
import type { FlowFreeze } from "../../src/workflow/freeze";
import {
	appendWorkflowAttemptActivationCompleted,
	appendWorkflowAttemptActivationFailed,
	appendWorkflowAttemptActivationStarted,
	approveWorkflowChangeRequest,
	completeWorkflowAttempt,
	createWorkflowCheckpoint,
	failWorkflowAttempt,
	proposeWorkflowChangeRequest,
	reconstructWorkflowFamilies,
	recordWorkflowChangeRequestApplied,
	recordWorkflowFreeze,
	requestWorkflowAttemptStop,
	restartWorkflowAttempt,
	startWorkflowAttempt,
	startWorkflowFamily,
} from "../../src/workflow/lifecycle";
import type { WorkflowNodeRuntimeHost } from "../../src/workflow/node-runtime";
import {
	appendWorkflowActivationCompleted,
	appendWorkflowActivationFailed,
	appendWorkflowActivationStarted,
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

const rustCatModel: Model<Api> = buildModel({
	id: "gpt-5.5",
	name: "GPT-5.5 via rust.cat",
	api: "openai-responses",
	provider: "rust-cat",
	baseUrl: "https://rust.cat/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 32768,
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

interface RuntimeSessionOptions {
	availableModels?: Model<Api>[];
	activeModel?: Model<Api>;
}

function createRuntime(
	entries: CapturedEntry[],
	workflowRuntimeHost?: WorkflowNodeRuntimeHost,
	sessionOptions: RuntimeSessionOptions = {},
) {
	const output: string[] = [];
	const session = {
		...(sessionOptions.availableModels !== undefined
			? {
					getAvailableModels: () => sessionOptions.availableModels ?? [],
					modelRegistry: {
						getAvailable: () => sessionOptions.availableModels ?? [],
					},
				}
			: {}),
		...(sessionOptions.activeModel !== undefined ? { model: sessionOptions.activeModel } : {}),
	} as unknown as AgentSession;
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

function createTuiRuntime(
	entries: CapturedEntry[],
	cwd: string,
	runner: WorkflowAgentTaskRunner,
	sessionOptions: RuntimeSessionOptions = { availableModels: [openAiModel], activeModel: openAiModel },
) {
	const output: string[] = [];
	const presentedComponents: unknown[] = [];
	const workflowMonitorComponents: unknown[] = [];
	const availableModels = sessionOptions.availableModels ?? [openAiModel];
	const activeModel = sessionOptions.activeModel ?? openAiModel;
	const session = {
		getWorkflowAgentTaskRunner: () => runner,
		getWorkflowScriptEvalRunner: () => undefined,
		getWorkflowHumanInputRunner: () => undefined,
		getAvailableModels: () => availableModels,
		modelRegistry: {
			getAvailable: () => availableModels,
		},
		model: activeModel,
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
		workflowMonitorSnapshotAgentDir: path.join(cwd, "agent"),
		showStatus: (text: string) => {
			output.push(text);
		},
		present: (content: unknown) => {
			if (Array.isArray(content)) presentedComponents.push(...content);
			else presentedComponents.push(content);
		},
		showWorkflowGraphMonitor: (component: unknown) => {
			workflowMonitorComponents.splice(0, workflowMonitorComponents.length, component);
		},
		ui: { requestComponentRender: () => {} },
		editor: { setText: () => {} },
		refreshSlashCommandState: () => {},
	} as unknown as InteractiveModeContext;
	return {
		output,
		presentedComponents,
		workflowMonitorComponents,
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
		expect(output[0]).toContain("- build → review");
		expect(output[0]).toContain("Activations: 1 completed");
		expect(output[0]).toContain("activation-1 build completed - built");
		expect(output[0]).toContain("activation-1 build openai/gpt-4o (workflow-default)");
	});

	it("prints workflow activation errors in inspection summaries", async () => {
		const host = createHost();
		const definition = parseWorkflowDefinition(
			`
name: slash-demo
version: 1
nodes:
  build:
    type: agent
edges: []
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
		appendWorkflowActivationFailed(host, run.id, {
			activationId: "activation-1",
			error: 'workflow agent node "build" requires a subagent runtime adapter',
		});
		const { output, runtime } = createRuntime(host.entries);

		const result = await executeAcpBuiltinSlashCommand("/workflow inspect", runtime);

		expect(result).toEqual({ consumed: true });
		expect(output[0]).toContain(
			'activation-1 build failed - error: workflow agent node "build" requires a subagent runtime adapter',
		);
	});

	it("omits legacy active-run graph patch audit summaries from workflow inspection output", async () => {
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
		const preview = graphPatchPreview();
		appendWorkflowGraphPatchProposed(host, run.id, {
			proposalId: "proposal-pending",
			actor: "agent",
			patch: pendingPatch,
			preview,
			reason: "request human gate",
		});
		const { output, runtime } = createRuntime(host.entries);

		const result = await executeAcpBuiltinSlashCommand("/workflow inspect", runtime);

		expect(result).toEqual({ consumed: true });
		expect(output[0]).toContain("Workflow run: run-1");
		expect(output[0]).not.toContain("Graph patches:");
		expect(output[0]).not.toContain("Pending graph patch proposals:");
		expect(output[0]).not.toContain("Applied graph patches:");
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

	it("rejects duplicate workflow start run ids before launching nodes", async () => {
		const dir = await createTempDir();
		await Bun.write(
			path.join(dir, "workflow.yml"),
			`
name: slash-start-duplicate-demo
version: 1
nodes:
  build:
    type: script
edges: []
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

		expect(await executeAcpBuiltinSlashCommand(`/workflow start ${dir} --run-id run-duplicate`, runtime)).toEqual({
			consumed: true,
		});
		calls.length = 0;
		expect(await executeAcpBuiltinSlashCommand(`/workflow start ${dir} --run-id run-duplicate`, runtime)).toEqual({
			consumed: true,
		});

		expect(calls).toEqual([]);
		expect(output.at(-1)).toContain("Workflow run already exists: run-duplicate");
		expect(reconstructWorkflowRuns(entries).map(run => run.id)).toEqual(["run-duplicate"]);
	});

	it("passes workflow start activation limits to bounded loop runs", async () => {
		const dir = await createTempDir();
		await Bun.write(
			path.join(dir, "workflow.yml"),
			`
name: bounded-loop-demo
version: 1
nodes:
  build:
    type: script
  review:
    type: script
edges:
  - from: build
    to: review
  - from: review
    to: build
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

		const result = await executeAcpBuiltinSlashCommand(
			`/workflow start ${dir} --run-id run-loop --max-activations 3 --max-node-activations 2`,
			runtime,
		);

		expect(result).toEqual({ consumed: true });
		expect(calls).toEqual(["build", "review", "build"]);
		expect(output[0]).toContain("Workflow run: run-loop");
		expect(output[0]).toContain("Activations: 3 completed");
		const runs = reconstructWorkflowRuns(entries);
		expect(runs[0]?.activations.map(activation => [activation.nodeId, activation.status])).toEqual([
			["build", "completed"],
			["review", "completed"],
			["build", "completed"],
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
    script:
      inline: |
        return { summary: "built" };
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

		expect(output.at(-1)).toContain("Workflow family: family-omhflow");
		expect(output.at(-1)).toContain(`Freezes: ${families[0]?.freezes[0]?.id}`);
		expect(output.at(-1)).toContain("run-omhflow:attempt-1 completed");
		expect(output.at(-1)).toContain("binding=run-omhflow:binding-1");
	});

	it("starts every root node in a parallel .omhflow artifact when no explicit start is supplied", async () => {
		const dir = await createTempDir();
		await fs.mkdir(path.join(dir, "parallel-start"), { recursive: true });
		await Bun.write(
			path.join(dir, "parallel-start.omhflow"),
			`---
name: parallel-start-demo
version: 1
schema: omhflow/v1
checkpoint:
  stopDeadlineMs: 50
changePolicy:
  agentsCanPropose: true
  humansCanApprove: true
---

\`\`\`yaml workflow
sequence:
  - parallel:
      - node:
          id: tryLeft
          type: script
          script:
            inline: |
              return { summary: "left" };
      - node:
          id: tryRight
          type: script
          script:
            inline: |
              return { summary: "right" };
    join:
      id: evaluate
      type: script
      script:
        inline: |
          return { summary: "evaluated" };
\`\`\`
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

		const result = await executeAcpBuiltinSlashCommand(
			`/workflow start ${path.join(dir, "parallel-start.omhflow")} --run-id run-parallel --family-id family-parallel`,
			runtime,
		);

		expect(result).toEqual({ consumed: true });
		expect(calls).toEqual(["tryLeft", "tryRight", "evaluate"]);
		expect(output[0]).toContain("Workflow run: run-parallel");
		expect(output[0]).toContain("Activations: 3 completed");
		const runs = reconstructWorkflowRuns(entries);
		expect(runs[0]?.activations.map(activation => [activation.nodeId, activation.status])).toEqual([
			["tryLeft", "completed"],
			["tryRight", "completed"],
			["evaluate", "completed"],
		]);
		const families = reconstructWorkflowFamilies(entries);
		expect(families[0]?.attempts[0]?.startNodeId).toBe("tryLeft");
		expect(families[0]?.attempts[0]?.startNodeIds).toEqual(["tryLeft", "tryRight"]);
	});

	it("records runtime binding models resolved through oh-my-pi session configuration", async () => {
		const dir = await createTempDir();
		await fs.mkdir(path.join(dir, "binding"), { recursive: true });
		await Bun.write(
			path.join(dir, "binding.omhflow"),
			`---
name: binding-demo
version: 1
schema: omhflow/v1
checkpoint:
  stopDeadlineMs: 50
changePolicy:
  agentsCanPropose: true
  humansCanApprove: true
---
# Binding Demo

\`\`\`yaml workflow
models:
  roles:
    builder: openai/gpt-4o
  defaults:
    agent: builder
  unavailable: fail
nodes:
  build:
    type: agent
    agent: task
    prompt: Build the feature.
edges: []
\`\`\`
`,
		);
		const entries: CapturedEntry[] = [];
		const runtimeHost: WorkflowNodeRuntimeHost = {
			runAgentNode: async () => ({ summary: "built" }),
		};
		const { runtime } = createRuntime(entries, runtimeHost, {
			availableModels: [openAiModel],
			activeModel: openAiModel,
		});

		expect(
			await executeAcpBuiltinSlashCommand(
				`/workflow start ${path.join(dir, "binding.omhflow")} --run-id run-binding --family-id family-binding`,
				runtime,
			),
		).toEqual({ consumed: true });

		const families = reconstructWorkflowFamilies(entries);
		expect(families[0]?.attempts[0]?.runtimeBindingSnapshot).toMatchObject({
			id: "run-binding:binding-1",
			requestedRoles: { builder: "openai/gpt-4o" },
			resolvedModels: { build: "openai/gpt-4o" },
			tools: ["task"],
			agents: ["task"],
			unavailable: [],
		});
	});

	it("records runtime binding diagnostics when workflow model roles cannot resolve", async () => {
		const dir = await createTempDir();
		await fs.mkdir(path.join(dir, "missing-binding"), { recursive: true });
		await Bun.write(
			path.join(dir, "missing-binding.omhflow"),
			`---
name: missing-binding-demo
version: 1
schema: omhflow/v1
checkpoint:
  stopDeadlineMs: 50
changePolicy:
  agentsCanPropose: true
  humansCanApprove: true
---
# Missing Binding Demo

\`\`\`yaml workflow
models:
  roles:
    reviewer: anthropic/claude-sonnet-4-5
  defaults:
    review: reviewer
nodes:
  review:
    type: review
    prompt: Review the change.
edges: []
\`\`\`
`,
		);
		const entries: CapturedEntry[] = [];
		const runtimeHost: WorkflowNodeRuntimeHost = {
			runReviewNode: async () => ({ summary: "reviewed", verdict: "pass" }),
		};
		const { runtime } = createRuntime(entries, runtimeHost, {
			availableModels: [openAiModel],
			activeModel: openAiModel,
		});

		expect(
			await executeAcpBuiltinSlashCommand(
				`/workflow start ${path.join(dir, "missing-binding.omhflow")} --run-id run-missing --family-id family-missing --max-activations 0`,
				runtime,
			),
		).toEqual({ consumed: true });

		const families = reconstructWorkflowFamilies(entries);
		expect(families[0]?.attempts[0]?.runtimeBindingSnapshot).toMatchObject({
			id: "run-missing:binding-1",
			requestedRoles: { reviewer: "anthropic/claude-sonnet-4-5" },
			resolvedModels: {},
			unavailable: ['model:review: workflow model for node "review" could not resolve requested model'],
		});
	});

	it("records runtime binding diagnostics when required workflow tool adapters are unavailable", async () => {
		const dir = await createTempDir();
		await fs.mkdir(path.join(dir, "tool-binding"), { recursive: true });
		await Bun.write(
			path.join(dir, "tool-binding.omhflow"),
			`---
name: tool-binding-demo
version: 1
schema: omhflow/v1
checkpoint:
  stopDeadlineMs: 50
changePolicy:
  agentsCanPropose: true
  humansCanApprove: true
---
# Tool Binding Demo

\`\`\`yaml workflow
nodes:
  build:
    type: script
    script:
      inline: |
        return { summary: "built" };
edges: []
\`\`\`
`,
		);
		const entries: CapturedEntry[] = [];
		const { runtime } = createRuntime(
			entries,
			{},
			{
				availableModels: [openAiModel],
				activeModel: openAiModel,
			},
		);

		expect(
			await executeAcpBuiltinSlashCommand(
				`/workflow start ${path.join(dir, "tool-binding.omhflow")} --run-id run-tool-binding --family-id family-tool-binding --max-activations 0`,
				runtime,
			),
		).toEqual({ consumed: true });

		const families = reconstructWorkflowFamilies(entries);
		expect(families[0]?.attempts[0]?.runtimeBindingSnapshot).toMatchObject({
			id: "run-tool-binding:binding-1",
			tools: ["eval"],
			unavailable: ["tool:eval: workflow runtime host does not support script nodes"],
		});
	});

	it("resolves declared workflow capability contracts against the runtime host", async () => {
		const dir = await createTempDir();
		await fs.mkdir(path.join(dir, "capability-binding"), { recursive: true });
		await Bun.write(
			path.join(dir, "capability-binding.omhflow"),
			`---
name: capability-binding-demo
version: 1
schema: omhflow/v1
checkpoint:
  stopDeadlineMs: 50
changePolicy:
  agentsCanPropose: true
  humansCanApprove: true
---
# Capability Binding Demo

\`\`\`yaml workflow
capabilities:
  tools:
    - task
    - ask
    - custom-shell
  agents:
    - planner
nodes:
  build:
    type: script
    script:
      inline: |
        return { summary: "built" };
edges: []
\`\`\`
`,
		);
		const entries: CapturedEntry[] = [];
		const { runtime } = createRuntime(
			entries,
			{},
			{
				availableModels: [openAiModel],
				activeModel: openAiModel,
			},
		);

		expect(
			await executeAcpBuiltinSlashCommand(
				`/workflow start ${path.join(dir, "capability-binding.omhflow")} --run-id run-capability-binding --family-id family-capability-binding --max-activations 0`,
				runtime,
			),
		).toEqual({ consumed: true });

		const families = reconstructWorkflowFamilies(entries);
		expect(families[0]?.attempts[0]?.runtimeBindingSnapshot).toMatchObject({
			id: "run-capability-binding:binding-1",
			tools: ["ask", "custom-shell", "eval", "task"],
			agents: ["planner"],
			unavailable: [
				"tool:eval: workflow runtime host does not support script nodes",
				"tool:task: workflow runtime host does not support agent or review nodes",
				"tool:ask: workflow runtime host does not support human nodes",
				"tool:custom-shell: workflow runtime host cannot resolve declared tool",
				"agent:planner: workflow runtime host does not support agent nodes",
			],
		});
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
    script:
      inline: |
        return { summary: "built" };
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
		const freezeId = reconstructWorkflowFamilies(entries)[0]?.freezes[0]?.id;
		expect(freezeId).toBeDefined();
		const lifecycleHost = createHostFromEntries(entries);
		startWorkflowAttempt(lifecycleHost, {
			familyId: "family-1",
			attemptId: "attempt-1",
			freezeId: freezeId ?? "missing-freeze",
			startNodeId: "build",
			runtimeBindingSnapshot: binding("binding-1"),
		});
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
		requestWorkflowAttemptStop(lifecycleHost, {
			attemptId: "attempt-1",
			deadlineMs: 50,
			reason: "apply approved change",
		});
		createWorkflowCheckpoint(lifecycleHost, {
			checkpointId: "attempt-1:checkpoint-1",
			familyId: "family-1",
			attemptId: "attempt-1",
			completedActivationIds: [],
			abortedActivationIds: [],
			frontierNodeIds: ["build"],
			state: {},
			sourceMapping: { build: "build" },
		});
		expect(
			await executeAcpBuiltinSlashCommand(
				`/workflow apply-change change-1 --freeze-id ${freezeId} --actor human:sihao --reason strict freeze passed`,
				runtime,
			),
		).toEqual({
			consumed: true,
		});
		expect(output.at(-1)).toContain(
			`Workflow change request cannot be applied to freeze ${freezeId}: added node missing from freeze: verify`,
		);
		await Bun.write(
			path.join(dir, "release-v2.omhflow"),
			`---
name: change-command-demo
version: 2
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
    script:
      inline: |
        return { summary: "built" };
  verify:
    type: script
    script:
      inline: |
        return { summary: "verified" };
edges: []
\`\`\`
`,
		);
		await fs.mkdir(path.join(dir, "release-v2"), { recursive: true });
		expect(
			await executeAcpBuiltinSlashCommand(
				`/workflow freeze ${path.join(dir, "release-v2.omhflow")} --family-id family-1`,
				runtime,
			),
		).toEqual({ consumed: true });
		const freezeV2Id = reconstructWorkflowFamilies(entries)[0]?.freezes.at(-1)?.id;
		expect(freezeV2Id).toBeDefined();
		expect(
			await executeAcpBuiltinSlashCommand(
				`/workflow apply-change change-1 --freeze-id ${freezeV2Id} --actor human:sihao --reason strict freeze passed`,
				runtime,
			),
		).toEqual({
			consumed: true,
		});

		const families = reconstructWorkflowFamilies(entries);
		expect(output[0]).toContain("Workflow freeze: flowfreeze:");
		expect(output.some(entry => entry.includes("Workflow change request: change-1"))).toBeTrue();
		expect(output.some(entry => entry === "Workflow change request approved: change-1")).toBeTrue();
		expect(
			output.some(entry => entry === `Workflow change request applied: change-1 -> freeze ${freezeV2Id}`),
		).toBeTrue();
		expect(families[0]?.id).toBe("family-1");
		expect(families[0]?.freezes).toHaveLength(2);
		expect(families[0]?.changeRequests).toMatchObject([
			{
				id: "change-1",
				status: "approved",
				actor: "agent:reviewer",
				origin: "internal-agent",
				approvedBy: "human:sihao",
				frontierMapping: { build: "verify" },
				applications: [
					{
						actor: "human:sihao",
						target: "freeze",
						freezeId: freezeV2Id,
						reason: "strict freeze passed",
					},
				],
			},
		]);
	});

	it("applies an approved change to a draft .omhflow artifact for strict refreeze", async () => {
		const dir = await createTempDir();
		await fs.mkdir(path.join(dir, "release"), { recursive: true });
		await Bun.write(
			path.join(dir, "release.omhflow"),
			`---
name: draft-change-demo
version: 1
schema: omhflow/v1
checkpoint:
  stopDeadlineMs: 50
changePolicy:
  agentsCanPropose: true
  humansCanApprove: true
---
# Draft Change Demo

\`\`\`yaml workflow
nodes:
  build:
    type: script
    script:
      inline: |
        return { summary: "built" };
edges: []
\`\`\`
`,
		);
		await Bun.write(
			path.join(dir, "change.json"),
			JSON.stringify({
				id: "change-draft",
				actor: "agent:reviewer",
				origin: "internal-agent",
				reason: "insert verification draft",
				operations: [
					{
						op: "add_node",
						node: {
							id: "verify",
							type: "script",
							script: { language: "js", inline: 'return { summary: "verified" };' },
						},
					},
					{ op: "add_edge", edge: { from: "build", to: "verify" } },
				],
				frontierMapping: { build: "verify" },
			}),
		);
		const entries: CapturedEntry[] = [];
		const restartedNodes: string[] = [];
		const runtimeHost: WorkflowNodeRuntimeHost = {
			runScriptNode: async input => {
				restartedNodes.push(input.node.id);
				return { summary: `${input.node.id} ran` };
			},
		};
		const { output, runtime } = createRuntime(entries, runtimeHost);

		expect(
			await executeAcpBuiltinSlashCommand(
				`/workflow freeze ${path.join(dir, "release.omhflow")} --family-id family-draft`,
				runtime,
			),
		).toEqual({ consumed: true });
		const freezeId = reconstructWorkflowFamilies(entries)[0]?.freezes[0]?.id;
		expect(freezeId).toBeDefined();
		const lifecycleHost = createHostFromEntries(entries);
		startWorkflowAttempt(lifecycleHost, {
			familyId: "family-draft",
			attemptId: "attempt-1",
			freezeId: freezeId ?? "missing-freeze",
			startNodeId: "build",
			runtimeBindingSnapshot: binding("binding-1"),
		});
		requestWorkflowAttemptStop(lifecycleHost, {
			attemptId: "attempt-1",
			deadlineMs: 50,
			reason: "draft approved change",
		});
		createWorkflowCheckpoint(lifecycleHost, {
			checkpointId: "attempt-1:checkpoint-1",
			familyId: "family-draft",
			attemptId: "attempt-1",
			completedActivationIds: [],
			abortedActivationIds: [],
			frontierNodeIds: ["build"],
			state: {},
			sourceMapping: { build: "build" },
		});
		expect(
			await executeAcpBuiltinSlashCommand(
				`/workflow request-change ${path.join(dir, "change.json")} --family-id family-draft --attempt-id attempt-1`,
				runtime,
			),
		).toEqual({ consumed: true });
		expect(
			await executeAcpBuiltinSlashCommand("/workflow approve-change change-draft --actor human:sihao", runtime),
		).toEqual({
			consumed: true,
		});
		const draftPath = path.join(dir, "release-draft.omhflow");

		expect(
			await executeAcpBuiltinSlashCommand(
				`/workflow apply-change change-draft --draft-path ${draftPath} --actor human:sihao --reason draft generated`,
				runtime,
			),
		).toEqual({ consumed: true });
		expect(await Bun.file(draftPath).text()).toContain("verify:");
		expect(await Bun.file(draftPath).text()).toContain("from: build");
		expect(await Bun.file(draftPath).text()).toContain("to: verify");
		expect((await fs.stat(path.join(dir, "release-draft"))).isDirectory()).toBe(true);
		expect(
			await executeAcpBuiltinSlashCommand(`/workflow freeze ${draftPath} --family-id family-draft`, runtime),
		).toEqual({ consumed: true });
		const draftFreezeId = reconstructWorkflowFamilies(entries)[0]?.freezes.at(-1)?.id;
		expect(draftFreezeId).toBeDefined();
		expect(
			await executeAcpBuiltinSlashCommand(
				`/workflow restart attempt-1:checkpoint-1 --freeze-id ${draftFreezeId}`,
				runtime,
			),
		).toEqual({ consumed: true });

		const family = reconstructWorkflowFamilies(entries)[0];
		const draftId = path.basename(draftPath);
		expect(
			output.some(entry => entry === `Workflow change request applied: change-draft -> draft ${draftId}`),
		).toBeTrue();
		expect(family?.freezes).toHaveLength(2);
		expect(family?.freezes.at(-1)?.definition.nodes.map(node => node.id)).toEqual(["build", "verify"]);
		expect(restartedNodes).toEqual(["verify"]);
		expect(family?.changeRequests[0]?.applications).toMatchObject([
			{
				actor: "human:sihao",
				target: "draft",
				draftId,
				reason: "draft generated",
			},
			{
				actor: "human:sihao",
				target: "freeze",
				freezeId: draftFreezeId,
			},
		]);
	});

	it("records shell script nodes in workflow change requests", async () => {
		const dir = await createTempDir();
		await fs.mkdir(path.join(dir, "release"), { recursive: true });
		await Bun.write(path.join(dir, "release.omhflow"), workflowArtifactSource());
		await Bun.write(
			path.join(dir, "change.json"),
			JSON.stringify({
				id: "change-shell-node",
				actor: "human:sihao",
				origin: "human",
				reason: "insert shell validation before restart",
				operations: [
					{
						op: "add_node",
						node: {
							id: "shell-verify",
							type: "script",
							script: {
								language: "sh",
								file: "scripts/verify.sh",
							},
							reads: ["/build"],
							writes: ["/verification"],
						},
					},
				],
				frontierMapping: { build: "shell-verify" },
			}),
		);
		const entries: CapturedEntry[] = [];
		const { output, runtime } = createRuntime(entries);

		expect(
			await executeAcpBuiltinSlashCommand(
				`/workflow freeze ${path.join(dir, "release.omhflow")} --family-id family-shell-node`,
				runtime,
			),
		).toEqual({ consumed: true });
		expect(
			await executeAcpBuiltinSlashCommand(
				`/workflow request-change ${path.join(dir, "change.json")} --family-id family-shell-node`,
				runtime,
			),
		).toEqual({ consumed: true });

		const family = reconstructWorkflowFamilies(entries)[0];
		expect(output.some(entry => entry.includes("Workflow change request: change-shell-node"))).toBeTrue();
		expect(family?.changeRequests[0]?.operations).toEqual([
			{
				op: "add_node",
				node: {
					id: "shell-verify",
					type: "script",
					script: {
						language: "sh",
						file: "scripts/verify.sh",
					},
					reads: ["/build"],
					writes: ["/verification"],
				},
			},
		]);
	});

	it("records template prompt sources in workflow change requests", async () => {
		const dir = await createTempDir();
		await fs.mkdir(path.join(dir, "release"), { recursive: true });
		await Bun.write(path.join(dir, "release.omhflow"), workflowArtifactSource());
		await Bun.write(
			path.join(dir, "change.json"),
			JSON.stringify({
				id: "change-template-prompt",
				actor: "human:sihao",
				origin: "human",
				reason: "compose prompts from state and prior output",
				operations: [
					{
						op: "replace_node_prompt_source",
						nodeId: "build",
						promptSource: {
							kind: "template",
							file: "prompts/build.md",
							bindings: {
								plan: { kind: "state", path: "/plan" },
								reviewSummary: {
									kind: "output",
									node: "review",
									path: "/summary",
									activation: "latest-completed",
								},
								approval: { kind: "human", path: "/approval" },
								note: { kind: "inline", text: "Keep the implementation scoped." },
							},
						},
					},
					{
						op: "add_node",
						node: {
							id: "review",
							type: "review",
							reads: ["/plan", "/summary"],
							prompt: {
								template: {
									file: "prompts/review.md",
									bindings: {
										plan: { state: "/plan" },
										buildSummary: {
											output: {
												node: "build",
												path: "/summary",
												activation: "latest-completed",
											},
										},
									},
								},
							},
							gates: ["pass", "fail"],
						},
					},
				],
				frontierMapping: { build: "review" },
			}),
		);
		const entries: CapturedEntry[] = [];
		const { output, runtime } = createRuntime(entries);

		expect(
			await executeAcpBuiltinSlashCommand(
				`/workflow freeze ${path.join(dir, "release.omhflow")} --family-id family-template-prompt`,
				runtime,
			),
		).toEqual({ consumed: true });
		expect(
			await executeAcpBuiltinSlashCommand(
				`/workflow request-change ${path.join(dir, "change.json")} --family-id family-template-prompt`,
				runtime,
			),
		).toEqual({ consumed: true });

		const family = reconstructWorkflowFamilies(entries)[0];
		expect(output.some(entry => entry.includes("Workflow change request: change-template-prompt"))).toBeTrue();
		expect(family?.changeRequests[0]?.operations).toEqual([
			{
				op: "replace_node_prompt_source",
				nodeId: "build",
				promptSource: {
					kind: "template",
					file: "prompts/build.md",
					bindings: {
						plan: { kind: "state", path: "/plan" },
						reviewSummary: {
							kind: "output",
							node: "review",
							path: "/summary",
							activation: "latest-completed",
						},
						approval: { kind: "human", path: "/approval" },
						note: { kind: "inline", text: "Keep the implementation scoped." },
					},
				},
			},
			{
				op: "add_node",
				node: {
					id: "review",
					type: "review",
					promptSource: {
						kind: "template",
						file: "prompts/review.md",
						bindings: {
							plan: { kind: "state", path: "/plan" },
							buildSummary: {
								kind: "output",
								node: "build",
								path: "/summary",
								activation: "latest-completed",
							},
						},
					},
					gates: ["pass", "fail"],
					reads: ["/plan", "/summary"],
				},
			},
		]);
	});

	it("rejects unknown workflow change request operations before recording them", async () => {
		const dir = await createTempDir();
		await fs.mkdir(path.join(dir, "release"), { recursive: true });
		await Bun.write(path.join(dir, "release.omhflow"), workflowArtifactSource());
		await Bun.write(
			path.join(dir, "change.json"),
			JSON.stringify({
				id: "change-unknown",
				actor: "agent:reviewer",
				origin: "internal-agent",
				reason: "try unsupported mutation",
				operations: [{ op: "teleport_node", nodeId: "build" }],
			}),
		);
		const entries: CapturedEntry[] = [];
		const { output, runtime } = createRuntime(entries);

		expect(
			await executeAcpBuiltinSlashCommand(
				`/workflow freeze ${path.join(dir, "release.omhflow")} --family-id family-unknown-op`,
				runtime,
			),
		).toEqual({ consumed: true });
		expect(
			await executeAcpBuiltinSlashCommand(
				`/workflow request-change ${path.join(dir, "change.json")} --family-id family-unknown-op`,
				runtime,
			),
		).toEqual({ consumed: true });

		const family = reconstructWorkflowFamilies(entries)[0];
		expect(family?.changeRequests).toEqual([]);
		expect(output.at(-1)).toContain('unsupported workflow change operation "teleport_node"');
	});

	it("rejects malformed workflow change request operations before recording them", async () => {
		const dir = await createTempDir();
		await fs.mkdir(path.join(dir, "release"), { recursive: true });
		await Bun.write(path.join(dir, "release.omhflow"), workflowArtifactSource());
		await Bun.write(
			path.join(dir, "change.json"),
			JSON.stringify({
				id: "change-malformed",
				actor: "agent:reviewer",
				origin: "internal-agent",
				reason: "try malformed mutation",
				operations: [{ op: "add_node" }],
			}),
		);
		const entries: CapturedEntry[] = [];
		const { output, runtime } = createRuntime(entries);

		expect(
			await executeAcpBuiltinSlashCommand(
				`/workflow freeze ${path.join(dir, "release.omhflow")} --family-id family-malformed-op`,
				runtime,
			),
		).toEqual({ consumed: true });
		expect(
			await executeAcpBuiltinSlashCommand(
				`/workflow request-change ${path.join(dir, "change.json")} --family-id family-malformed-op`,
				runtime,
			),
		).toEqual({ consumed: true });

		const family = reconstructWorkflowFamilies(entries)[0];
		expect(family?.changeRequests).toEqual([]);
		expect(output.at(-1)).toContain("workflow change operation add_node requires node");
	});

	it("rejects supervisor change approvals unless the frozen flow policy grants them", async () => {
		const dir = await createTempDir();
		await fs.mkdir(path.join(dir, "release"), { recursive: true });
		await Bun.write(path.join(dir, "release.omhflow"), workflowArtifactSource());
		await Bun.write(path.join(dir, "change.json"), workflowChangeRequestSource());
		const entries: CapturedEntry[] = [];
		const { output, runtime } = createRuntime(entries);

		expect(
			await executeAcpBuiltinSlashCommand(
				`/workflow freeze ${path.join(dir, "release.omhflow")} --family-id family-policy`,
				runtime,
			),
		).toEqual({ consumed: true });
		expect(
			await executeAcpBuiltinSlashCommand(
				`/workflow request-change ${path.join(dir, "change.json")} --family-id family-policy --attempt-id attempt-1`,
				runtime,
			),
		).toEqual({ consumed: true });
		expect(
			await executeAcpBuiltinSlashCommand("/workflow approve-change change-1 --actor supervisor:policy", runtime),
		).toEqual({ consumed: true });

		const family = reconstructWorkflowFamilies(entries)[0];
		expect(family?.freezes[0]?.changePolicy).toEqual({
			agentsCanPropose: true,
			humansCanApprove: true,
		});
		expect(family?.changeRequests[0]?.status).toBe("proposed");
		expect(family?.changeRequests[0]?.approvedBy).toBeUndefined();
		expect(output.at(-1)).toContain(
			"Workflow change request approval denied: supervisor:policy requires changePolicy.supervisorsCanApprove",
		);
	});

	it("allows supervisor change approvals when the frozen flow policy grants them", async () => {
		const dir = await createTempDir();
		await fs.mkdir(path.join(dir, "release"), { recursive: true });
		await Bun.write(path.join(dir, "release.omhflow"), workflowArtifactSource("  supervisorsCanApprove: true\n"));
		await Bun.write(path.join(dir, "change.json"), workflowChangeRequestSource());
		const entries: CapturedEntry[] = [];
		const { output, runtime } = createRuntime(entries);

		expect(
			await executeAcpBuiltinSlashCommand(
				`/workflow freeze ${path.join(dir, "release.omhflow")} --family-id family-policy`,
				runtime,
			),
		).toEqual({ consumed: true });
		expect(
			await executeAcpBuiltinSlashCommand(
				`/workflow request-change ${path.join(dir, "change.json")} --family-id family-policy --attempt-id attempt-1`,
				runtime,
			),
		).toEqual({ consumed: true });
		expect(
			await executeAcpBuiltinSlashCommand("/workflow approve-change change-1 --actor supervisor:policy", runtime),
		).toEqual({ consumed: true });

		const family = reconstructWorkflowFamilies(entries)[0];
		expect(family?.freezes[0]?.changePolicy).toEqual({
			agentsCanPropose: true,
			humansCanApprove: true,
			supervisorsCanApprove: true,
		});
		expect(family?.changeRequests[0]?.status).toBe("approved");
		expect(family?.changeRequests[0]?.approvedBy).toBe("supervisor:policy");
		expect(output.some(entry => entry === "Workflow change request approved: change-1")).toBeTrue();
	});

	it("rejects internal-agent change requests when the frozen flow policy forbids agent proposals", async () => {
		const dir = await createTempDir();
		await fs.mkdir(path.join(dir, "release"), { recursive: true });
		await Bun.write(path.join(dir, "release.omhflow"), workflowArtifactSource("", false));
		await Bun.write(path.join(dir, "change.json"), workflowChangeRequestSource());
		const entries: CapturedEntry[] = [];
		const { output, runtime } = createRuntime(entries);

		expect(
			await executeAcpBuiltinSlashCommand(
				`/workflow freeze ${path.join(dir, "release.omhflow")} --family-id family-proposal-policy`,
				runtime,
			),
		).toEqual({ consumed: true });
		expect(
			await executeAcpBuiltinSlashCommand(
				`/workflow request-change ${path.join(dir, "change.json")} --family-id family-proposal-policy --attempt-id attempt-1`,
				runtime,
			),
		).toEqual({ consumed: true });

		const family = reconstructWorkflowFamilies(entries)[0];
		expect(family?.freezes[0]?.changePolicy).toEqual({
			agentsCanPropose: false,
			humansCanApprove: true,
		});
		expect(family?.changeRequests).toEqual([]);
		expect(output.at(-1)).toContain(
			"Workflow change request proposal denied: agent:reviewer requires changePolicy.agentsCanPropose",
		);
	});

	it("rejects applying attempt-scoped changes before the attempt is checkpointed", async () => {
		const dir = await createTempDir();
		await fs.mkdir(path.join(dir, "release"), { recursive: true });
		await Bun.write(path.join(dir, "release.omhflow"), workflowArtifactSource());
		await Bun.write(path.join(dir, "change.json"), workflowChangeRequestSource());
		const entries: CapturedEntry[] = [];
		const { output, runtime } = createRuntime(entries);

		expect(
			await executeAcpBuiltinSlashCommand(
				`/workflow freeze ${path.join(dir, "release.omhflow")} --family-id family-apply-gate`,
				runtime,
			),
		).toEqual({ consumed: true });
		expect(
			await executeAcpBuiltinSlashCommand(
				`/workflow request-change ${path.join(dir, "change.json")} --family-id family-apply-gate --attempt-id attempt-1`,
				runtime,
			),
		).toEqual({ consumed: true });
		expect(await executeAcpBuiltinSlashCommand("/workflow approve-change change-1", runtime)).toEqual({
			consumed: true,
		});
		const freezeId = reconstructWorkflowFamilies(entries)[0]?.freezes[0]?.id;
		expect(freezeId).toBeDefined();

		expect(
			await executeAcpBuiltinSlashCommand(
				`/workflow apply-change change-1 --freeze-id ${freezeId} --actor human:sihao`,
				runtime,
			),
		).toEqual({ consumed: true });

		const family = reconstructWorkflowFamilies(entries)[0];
		expect(family?.changeRequests[0]?.applications).toEqual([]);
		expect(output.at(-1)).toContain(
			"Workflow change request cannot be applied before checkpointing attempt: attempt-1",
		);
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
  unavailable: fail
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

	it("updates a persistent TUI workflow monitor instead of appending graph components to transcript", async () => {
		const dir = await createTempDir();
		await fs.mkdir(path.join(dir, "monitor"), { recursive: true });
		await Bun.write(
			path.join(dir, "monitor.omhflow"),
			`---
name: tui-monitor
version: 1
schema: omhflow/v1
checkpoint:
  stopDeadlineMs: 50
changePolicy:
  agentsCanPropose: true
  humansCanApprove: true
---

\`\`\`yaml workflow
nodes:
  build:
    type: agent
    agent: task
    prompt: Build once.
edges: []
\`\`\`
`,
		);
		const entries: CapturedEntry[] = [];
		const runner: WorkflowAgentTaskRunner = async () => ({ exitCode: 0, output: "done" });
		const { output, presentedComponents, workflowMonitorComponents, runtime } = createTuiRuntime(
			entries,
			dir,
			runner,
		);

		const result = await executeBuiltinSlashCommand(
			`/workflow start ${path.join(dir, "monitor.omhflow")} --run-id run-monitor --family-id family-monitor`,
			runtime,
		);

		expect(result).toBe(true);
		expect(output).toHaveLength(1);
		expect(output[0]).toContain("Workflow run: run-monitor");
		expect(presentedComponents).toEqual([]);
		expect(workflowMonitorComponents).toHaveLength(1);
	});

	it("starts review .omhflow artifacts with exact workflow model overrides through the TUI task runner", async () => {
		const dir = await createTempDir();
		await fs.mkdir(path.join(dir, "review-artifact", "prompts"), { recursive: true });
		await Bun.write(
			path.join(dir, "review-artifact.omhflow"),
			`---
name: review-artifact
version: 1
schema: omhflow/v1
models:
  roles:
    reviewer: rust-cat/gpt-5.5
  defaults:
    review: reviewer
checkpoint:
  stopDeadlineMs: 50
changePolicy:
  agentsCanPropose: true
  humansCanApprove: true
---

\`\`\`yaml workflow
nodes:
  review:
    type: review
    agent: reviewer
    model:
      role: reviewer
    gates:
      - pass
    prompt:
      file: prompts/review.md
edges: []
\`\`\`
`,
		);
		await Bun.write(path.join(dir, "review-artifact", "prompts", "review.md"), "Return pass.");
		const entries: CapturedEntry[] = [];
		let capturedRequest: Parameters<WorkflowAgentTaskRunner>[0] | undefined;
		const runner: WorkflowAgentTaskRunner = async request => {
			capturedRequest = request;
			return { exitCode: 0, output: JSON.stringify({ verdict: "pass", summary: "review passed" }) };
		};
		const { output, runtime } = createTuiRuntime(entries, dir, runner, {
			availableModels: [],
			activeModel: rustCatModel,
		});

		const result = await executeBuiltinSlashCommand(
			`/workflow start ${path.join(dir, "review-artifact.omhflow")} --run-id run-review`,
			runtime,
		);

		expect(result).toBe(true);
		expect(capturedRequest).toMatchObject({
			agent: "reviewer",
			activationId: "activation-1",
			nodeId: "review",
			modelOverride: "rust-cat/gpt-5.5",
			modelOverrideAuthFallback: false,
		});
		expect(capturedRequest?.task.assignment).toBe("Return pass.");
		expect(output[0]).toContain("activation-1 review rust-cat/gpt-5.5 (node)");
		const runs = reconstructWorkflowRuns(entries);
		expect(runs[0]?.activations[0]?.output).toMatchObject({
			summary: "review passed",
			data: { verdict: "pass" },
		});
	});

	it("starts review .omhflow artifacts on the active session model when the flow has no model defaults", async () => {
		const dir = await createTempDir();
		await fs.mkdir(path.join(dir, "session-review"), { recursive: true });
		await Bun.write(
			path.join(dir, "session-review.omhflow"),
			`---
name: session-review
version: 1
schema: omhflow/v1
checkpoint:
  stopDeadlineMs: 50
changePolicy:
  agentsCanPropose: true
  humansCanApprove: true
---

\`\`\`yaml workflow
nodes:
  review:
    type: review
    gates:
      - finish
    prompt: Review with the active session model.
edges: []
\`\`\`
`,
		);
		const entries: CapturedEntry[] = [];
		let capturedRequest: Parameters<WorkflowAgentTaskRunner>[0] | undefined;
		const runner: WorkflowAgentTaskRunner = async request => {
			capturedRequest = request;
			return { exitCode: 0, output: JSON.stringify({ verdict: "finish", summary: "session model used" }) };
		};
		const { runtime } = createTuiRuntime(entries, dir, runner, {
			availableModels: [rustCatModel],
			activeModel: rustCatModel,
		});

		const result = await executeBuiltinSlashCommand(
			`/workflow start ${path.join(dir, "session-review.omhflow")} --run-id run-session-review`,
			runtime,
		);

		expect(result).toBe(true);
		expect(capturedRequest).toMatchObject({
			agent: "reviewer",
			nodeId: "review",
			modelOverride: "rust-cat/gpt-5.5",
			modelOverrideAuthFallback: false,
		});
		const runs = reconstructWorkflowRuns(entries);
		expect(runs[0]?.activations[0]?.modelAudit?.source).toBe("parent-fallback");
		expect(runs[0]?.activations[0]?.modelAudit?.resolvedModel).toBe("rust-cat/gpt-5.5");
	});

	it("starts agent .omhflow artifacts on the active session model when overriding portable defaults", async () => {
		const dir = await createTempDir();
		await fs.mkdir(path.join(dir, "session-agent"), { recursive: true });
		await Bun.write(
			path.join(dir, "session-agent.omhflow"),
			`---
name: session-agent
version: 1
schema: omhflow/v1
models:
  roles:
    builder: openai/gpt-4o
  defaults:
    agent: builder
  unavailable: fallback-to-parent
checkpoint:
  stopDeadlineMs: 50
changePolicy:
  agentsCanPropose: true
  humansCanApprove: true
---

\`\`\`yaml workflow
nodes:
  build:
    type: agent
    agent: task
    model:
      role: builder
    prompt: Build with the active session model.
edges: []
\`\`\`
`,
		);
		const entries: CapturedEntry[] = [];
		let capturedRequest: Parameters<WorkflowAgentTaskRunner>[0] | undefined;
		const runner: WorkflowAgentTaskRunner = async request => {
			capturedRequest = request;
			return { exitCode: 0, output: "session model used" };
		};
		const { output, runtime } = createTuiRuntime(entries, dir, runner, {
			availableModels: [openAiModel, rustCatModel],
			activeModel: rustCatModel,
		});

		const result = await executeBuiltinSlashCommand(
			`/workflow start ${path.join(dir, "session-agent.omhflow")} --run-id run-session-agent`,
			runtime,
		);

		expect(result).toBe(true);
		expect(capturedRequest).toMatchObject({
			agent: "task",
			nodeId: "build",
			modelOverride: "rust-cat/gpt-5.5",
			modelOverrideAuthFallback: false,
		});
		expect(output[0]).toContain("activation-1 build rust-cat/gpt-5.5 (parent-fallback)");
		const families = reconstructWorkflowFamilies(entries);
		expect(families[0]?.attempts[0]?.runtimeBindingSnapshot).toMatchObject({
			requestedRoles: { builder: "openai/gpt-4o" },
			resolvedModels: { build: "rust-cat/gpt-5.5" },
		});
		const runs = reconstructWorkflowRuns(entries);
		expect(runs[0]?.activations[0]?.modelAudit?.fallbackReason).toBe(
			"parent active model overrides workflow role default",
		);
	});

	it("stops a running lifecycle attempt, checkpoints it, and restarts from a freeze", async () => {
		const entries: CapturedEntry[] = [];
		const freezeA = createFreeze("flowfreeze:a", ["build", "review"]);
		const freezeB = createFreeze("flowfreeze:b", ["verify"]);
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
			output: { summary: "built", statePatch: [{ op: "set", path: "/build/status", value: "built" }] },
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
			operations: [{ op: "add_node", node: { id: "verify", type: "script" } }],
			frontierMapping: { review: "verify" },
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
		expect(calls).toEqual(["verify"]);
		expect(output.some(entry => entry.includes("Workflow checkpoint: attempt-1:checkpoint-1"))).toBeTrue();
		expect(output.some(entry => entry.includes("Workflow restart attempt: attempt-2"))).toBeTrue();
		expect(families[0]?.attempts.map(attempt => [attempt.id, attempt.freezeId, attempt.status])).toEqual([
			["attempt-1", "flowfreeze:a", "stopped"],
			["attempt-2", "flowfreeze:b", "completed"],
		]);
		expect(families[0]?.checkpoints[0]).toMatchObject({
			id: "attempt-1:checkpoint-1",
			completedActivationIds: ["activation-1"],
			abortedActivationIds: ["activation-2"],
			frontierNodeIds: ["review"],
			state: { build: { status: "built" } },
			sourceMapping: { review: "verify" },
		});
		expect(families[0]?.changeRequests).toMatchObject([
			{
				id: "change-1",
				status: "approved",
				actor: "agent:reviewer",
				approvedBy: "human:sihao",
				frontierMapping: { review: "verify" },
			},
		]);
	});

	it("stops a live background workflow attempt before scheduling downstream nodes", async () => {
		const dir = await createTempDir();
		await fs.mkdir(path.join(dir, "live-stop"), { recursive: true });
		await Bun.write(
			path.join(dir, "live-stop.omhflow"),
			`---
name: live-stop-demo
version: 1
schema: omhflow/v1
checkpoint:
  stopDeadlineMs: 50
changePolicy:
  agentsCanPropose: true
  humansCanApprove: true
---
# Live Stop Demo

\`\`\`yaml workflow
nodes:
  build:
    type: script
    script:
      inline: |
        return { summary: "built" };
    writes:
      - /build
  review:
    type: script
    script:
      inline: |
        return { summary: "reviewed" };
edges:
  - from: build
    to: review
\`\`\`
`,
		);
		const entries: CapturedEntry[] = [];
		const buildStarted = Promise.withResolvers<void>();
		const releaseBuild = Promise.withResolvers<void>();
		const calls: string[] = [];
		const runtimeHost: WorkflowNodeRuntimeHost = {
			runScriptNode: async input => {
				calls.push(input.node.id);
				if (input.node.id === "build") {
					buildStarted.resolve();
					await releaseBuild.promise;
					return {
						summary: "built",
						statePatch: [{ op: "set", path: "/build/status", value: "built" }],
					};
				}
				return { summary: "reviewed" };
			},
		};
		const { output, runtime } = createRuntime(entries, runtimeHost);

		expect(
			await executeAcpBuiltinSlashCommand(
				`/workflow start ${path.join(dir, "live-stop.omhflow")} --run-id run-live --family-id family-live --background`,
				runtime,
			),
		).toEqual({ consumed: true });
		await buildStarted.promise;

		const stop = executeAcpBuiltinSlashCommand("/workflow stop run-live:attempt-1 --deadline-ms 50", runtime);
		await Bun.sleep(5);
		expect(calls).toEqual(["build"]);
		releaseBuild.resolve();

		expect(await stop).toEqual({ consumed: true });
		const family = reconstructWorkflowFamilies(entries)[0];
		expect(
			output.some(entry => entry.includes("Workflow background attempt started: run-live:attempt-1")),
		).toBeTrue();
		expect(output.some(entry => entry.includes("Workflow checkpoint: run-live:attempt-1:checkpoint-1"))).toBeTrue();
		expect(calls).toEqual(["build"]);
		expect(family?.attempts.map(attempt => [attempt.id, attempt.status])).toEqual([
			["run-live:attempt-1", "stopped"],
		]);
		expect(family?.checkpoints[0]).toMatchObject({
			id: "run-live:attempt-1:checkpoint-1",
			completedActivationIds: ["activation-1"],
			abortedActivationIds: [],
			frontierNodeIds: ["review"],
			state: { build: { status: "built" } },
			sourceMapping: { review: "review" },
		});
	});

	it("stops a live foreground workflow attempt before scheduling downstream nodes", async () => {
		const dir = await createTempDir();
		await fs.mkdir(path.join(dir, "live-foreground-stop"), { recursive: true });
		await Bun.write(
			path.join(dir, "live-foreground-stop.omhflow"),
			`---
name: live-foreground-stop-demo
version: 1
schema: omhflow/v1
checkpoint:
  stopDeadlineMs: 50
changePolicy:
  agentsCanPropose: true
  humansCanApprove: true
---
# Live Foreground Stop Demo

\`\`\`yaml workflow
nodes:
  build:
    type: script
    script:
      inline: |
        return { summary: "built" };
    writes:
      - /build
  review:
    type: script
    script:
      inline: |
        return { summary: "reviewed" };
edges:
  - from: build
    to: review
\`\`\`
`,
		);
		const entries: CapturedEntry[] = [];
		const buildStarted = Promise.withResolvers<void>();
		const releaseBuild = Promise.withResolvers<void>();
		const calls: string[] = [];
		const runtimeHost: WorkflowNodeRuntimeHost = {
			runScriptNode: async input => {
				calls.push(input.node.id);
				if (input.node.id === "build") {
					buildStarted.resolve();
					await releaseBuild.promise;
					return {
						summary: "built",
						statePatch: [{ op: "set", path: "/build/status", value: "built" }],
					};
				}
				return { summary: "reviewed" };
			},
		};
		const { output, runtime } = createRuntime(entries, runtimeHost);

		const start = executeAcpBuiltinSlashCommand(
			`/workflow start ${path.join(dir, "live-foreground-stop.omhflow")} --run-id run-live-foreground --family-id family-live-foreground`,
			runtime,
		);
		await buildStarted.promise;

		const stop = executeAcpBuiltinSlashCommand(
			"/workflow stop run-live-foreground:attempt-1 --deadline-ms 50",
			runtime,
		);
		await Bun.sleep(5);
		expect(calls).toEqual(["build"]);
		releaseBuild.resolve();

		expect(await stop).toEqual({ consumed: true });
		expect(await start).toEqual({ consumed: true });
		const family = reconstructWorkflowFamilies(entries)[0];
		expect(
			output.some(entry => entry.includes("Workflow checkpoint: run-live-foreground:attempt-1:checkpoint-1")),
		).toBeTrue();
		expect(calls).toEqual(["build"]);
		expect(family?.attempts.map(attempt => [attempt.id, attempt.status])).toEqual([
			["run-live-foreground:attempt-1", "stopped"],
		]);
		expect(family?.checkpoints[0]).toMatchObject({
			id: "run-live-foreground:attempt-1:checkpoint-1",
			completedActivationIds: ["activation-1"],
			abortedActivationIds: [],
			frontierNodeIds: ["review"],
			state: { build: { status: "built" } },
			sourceMapping: { review: "review" },
		});
	});

	it("stops a live restart attempt before scheduling downstream nodes", async () => {
		const entries: CapturedEntry[] = [];
		const freeze = createFreeze("flowfreeze:restart-stop", ["build", "review"]);
		const host = createHostFromEntries(entries);
		startWorkflowFamily(host, { familyId: "family-restart-stop" });
		recordWorkflowFreeze(host, freeze, { familyId: "family-restart-stop" });
		startWorkflowAttempt(host, {
			familyId: "family-restart-stop",
			attemptId: "attempt-1",
			freezeId: freeze.id,
			startNodeId: "build",
			runtimeBindingSnapshot: binding("binding-1"),
		});
		requestWorkflowAttemptStop(host, {
			attemptId: "attempt-1",
			deadlineMs: 1,
			reason: "prepare restart",
		});
		createWorkflowCheckpoint(host, {
			checkpointId: "checkpoint-1",
			familyId: "family-restart-stop",
			attemptId: "attempt-1",
			completedActivationIds: [],
			abortedActivationIds: [],
			frontierNodeIds: ["build"],
			state: {},
			sourceMapping: { build: "build" },
		});
		const buildStarted = Promise.withResolvers<void>();
		const releaseBuild = Promise.withResolvers<void>();
		const calls: string[] = [];
		const runtimeHost: WorkflowNodeRuntimeHost = {
			runScriptNode: async input => {
				calls.push(input.node.id);
				if (input.node.id === "build") {
					buildStarted.resolve();
					await releaseBuild.promise;
					return { summary: "built" };
				}
				return { summary: "reviewed" };
			},
		};
		const { output, runtime } = createRuntime(entries, runtimeHost);

		const restart = executeAcpBuiltinSlashCommand(
			"/workflow restart checkpoint-1 --freeze-id flowfreeze:restart-stop",
			runtime,
		);
		await buildStarted.promise;
		const stop = executeAcpBuiltinSlashCommand("/workflow stop attempt-2 --deadline-ms 50", runtime);
		await Bun.sleep(5);
		expect(calls).toEqual(["build"]);
		releaseBuild.resolve();

		expect(await stop).toEqual({ consumed: true });
		expect(await restart).toEqual({ consumed: true });
		const family = reconstructWorkflowFamilies(entries)[0];
		expect(output.some(entry => entry.includes("Workflow checkpoint: attempt-2:checkpoint-1"))).toBeTrue();
		expect(calls).toEqual(["build"]);
		expect(family?.attempts.map(attempt => [attempt.id, attempt.status])).toEqual([
			["attempt-1", "stopped"],
			["attempt-2", "stopped"],
		]);
		expect(family?.checkpoints.at(-1)).toMatchObject({
			id: "attempt-2:checkpoint-1",
			completedActivationIds: ["activation-1"],
			abortedActivationIds: [],
			frontierNodeIds: ["review"],
			sourceMapping: { review: "review" },
		});
	});

	it("aborts live background agent tasks through the session runtime before checkpointing", async () => {
		const dir = await createTempDir();
		await fs.mkdir(path.join(dir, "live-agent-stop"), { recursive: true });
		await Bun.write(
			path.join(dir, "live-agent-stop.omhflow"),
			`---
name: live-agent-stop-demo
version: 1
schema: omhflow/v1
checkpoint:
  stopDeadlineMs: 10
changePolicy:
  agentsCanPropose: true
  humansCanApprove: true
---
# Live Agent Stop Demo

\`\`\`yaml workflow
nodes:
  build:
    type: agent
    agent: task
    prompt: Build the artifact.
  review:
    type: script
    script:
      inline: |
        return { summary: "reviewed" };
edges:
  - from: build
    to: review
\`\`\`
`,
		);
		const entries: CapturedEntry[] = [];
		const agentStarted = Promise.withResolvers<void>();
		const agentAborted = Promise.withResolvers<void>();
		const calls: string[] = [];
		let capturedSignal: AbortSignal | undefined;
		const runner: WorkflowAgentTaskRunner = async request => {
			calls.push(request.nodeId);
			capturedSignal = request.signal;
			request.signal?.addEventListener("abort", () => agentAborted.resolve(), { once: true });
			agentStarted.resolve();
			await agentAborted.promise;
			return {
				exitCode: 1,
				output: "",
				error: request.signal?.reason ?? "stop deadline elapsed",
			};
		};
		const { output, runtime } = createTuiRuntime(entries, dir, runner);

		expect(
			await executeBuiltinSlashCommand(
				`/workflow start ${path.join(dir, "live-agent-stop.omhflow")} --run-id run-live-agent --family-id family-live-agent --background`,
				runtime,
			),
		).toBe(true);
		await agentStarted.promise;

		expect(capturedSignal?.aborted).toBe(false);
		expect(await executeBuiltinSlashCommand("/workflow stop run-live-agent:attempt-1 --deadline-ms 1", runtime)).toBe(
			true,
		);

		expect(capturedSignal?.aborted).toBe(true);
		expect(calls).toEqual(["build"]);
		const family = reconstructWorkflowFamilies(entries)[0];
		expect(
			output.some(entry => entry.includes("Workflow checkpoint: run-live-agent:attempt-1:checkpoint-1")),
		).toBeTrue();
		expect(family?.attempts.map(attempt => [attempt.id, attempt.status])).toEqual([
			["run-live-agent:attempt-1", "stopped"],
		]);
		expect(family?.attempts[0]?.activations.map(activation => [activation.nodeId, activation.status])).toEqual([
			["build", "aborted"],
		]);
		expect(family?.checkpoints[0]).toMatchObject({
			completedActivationIds: [],
			abortedActivationIds: ["activation-1"],
			frontierNodeIds: ["build"],
			state: {},
			sourceMapping: { build: "build" },
		});
	});

	it("runs the Phase 1 slash lifecycle through draft, strict refreeze, and checkpoint restart", async () => {
		const dir = await createTempDir();
		await fs.mkdir(path.join(dir, "phase-one"), { recursive: true });
		await Bun.write(
			path.join(dir, "phase-one.omhflow"),
			`---
name: phase-one-slash-demo
version: 1
schema: omhflow/v1
checkpoint:
  stopDeadlineMs: 50
changePolicy:
  agentsCanPropose: true
  humansCanApprove: true
---
# Phase One Slash Demo

\`\`\`yaml workflow
nodes:
  build:
    type: script
    script:
      inline: |
        return { summary: "built" };
    writes:
      - /build
  review:
    type: script
    script:
      inline: |
        return { summary: "reviewed" };
edges:
  - from: build
    to: review
\`\`\`
`,
		);
		await Bun.write(
			path.join(dir, "change.json"),
			JSON.stringify({
				id: "change-phase-one",
				actor: "agent:reviewer",
				origin: "internal-agent",
				reason: "replace pending review frontier with deterministic verification",
				operations: [
					{
						op: "add_node",
						node: {
							id: "verify",
							type: "script",
							script: { language: "js", inline: 'return { summary: "verified" };' },
						},
					},
					{ op: "add_edge", edge: { from: "build", to: "verify" } },
				],
				frontierMapping: { review: "verify" },
			}),
		);
		const entries: CapturedEntry[] = [];
		const buildStarted = Promise.withResolvers<void>();
		const releaseBuild = Promise.withResolvers<void>();
		const calls: string[] = [];
		const runtimeHost: WorkflowNodeRuntimeHost = {
			runScriptNode: async input => {
				calls.push(input.node.id);
				if (input.node.id === "build") {
					buildStarted.resolve();
					await releaseBuild.promise;
					return {
						summary: "built",
						statePatch: [{ op: "set", path: "/build/status", value: "built" }],
					};
				}
				return { summary: `ran ${input.node.id}` };
			},
		};
		const { output, runtime } = createRuntime(entries, runtimeHost);

		expect(
			await executeAcpBuiltinSlashCommand(
				`/workflow freeze ${path.join(dir, "phase-one.omhflow")} --family-id family-phase-one`,
				runtime,
			),
		).toEqual({ consumed: true });
		const freezeAId = reconstructWorkflowFamilies(entries)[0]?.freezes[0]?.id;
		const freezeA = expectDefined(freezeAId);
		expect(
			await executeAcpBuiltinSlashCommand(
				`/workflow start ${path.join(dir, "phase-one.omhflow")} --run-id run-phase-one --family-id family-phase-one --background`,
				runtime,
			),
		).toEqual({ consumed: true });
		await buildStarted.promise;
		expect(
			await executeAcpBuiltinSlashCommand(
				`/workflow request-change ${path.join(dir, "change.json")} --family-id family-phase-one --attempt-id run-phase-one:attempt-1`,
				runtime,
			),
		).toEqual({ consumed: true });
		expect(
			await executeAcpBuiltinSlashCommand("/workflow approve-change change-phase-one --actor human:sihao", runtime),
		).toEqual({ consumed: true });
		const stop = executeAcpBuiltinSlashCommand("/workflow stop run-phase-one:attempt-1 --deadline-ms 50", runtime);
		await Bun.sleep(5);
		expect(calls).toEqual(["build"]);
		releaseBuild.resolve();
		expect(await stop).toEqual({ consumed: true });
		const draftPath = path.join(dir, "phase-one-v2.omhflow");
		expect(
			await executeAcpBuiltinSlashCommand(
				`/workflow apply-change change-phase-one --draft-path ${draftPath} --actor human:sihao --reason draft generated`,
				runtime,
			),
		).toEqual({ consumed: true });
		expect(
			await executeAcpBuiltinSlashCommand(`/workflow freeze ${draftPath} --family-id family-phase-one`, runtime),
		).toEqual({ consumed: true });
		const freezeBId = reconstructWorkflowFamilies(entries)[0]?.freezes.at(-1)?.id;
		const freezeB = expectDefined(freezeBId);
		expect(
			await executeAcpBuiltinSlashCommand(
				`/workflow apply-change change-phase-one --freeze-id ${freezeB} --actor human:sihao --reason strict freeze passed`,
				runtime,
			),
		).toEqual({ consumed: true });
		expect(
			await executeAcpBuiltinSlashCommand(
				`/workflow restart run-phase-one:attempt-1:checkpoint-1 --freeze-id ${freezeB}`,
				runtime,
			),
		).toEqual({ consumed: true });

		const family = reconstructWorkflowFamilies(entries)[0];
		expect(calls).toEqual(["build", "verify"]);
		expect(family?.freezes.map(freeze => freeze.id)).toEqual([freezeA, freezeB]);
		expect(family?.attempts.map(attempt => [attempt.id, attempt.freezeId, attempt.status])).toEqual([
			["run-phase-one:attempt-1", freezeA, "stopped"],
			["attempt-2", freezeB, "completed"],
		]);
		expect(family?.checkpoints[0]).toMatchObject({
			id: "run-phase-one:attempt-1:checkpoint-1",
			completedActivationIds: ["activation-1"],
			frontierNodeIds: ["review"],
			state: { build: { status: "built" } },
			sourceMapping: { review: "verify" },
		});
		expect(family?.changeRequests[0]).toMatchObject({
			id: "change-phase-one",
			status: "approved",
			approvedBy: "human:sihao",
			frontierMapping: { review: "verify" },
			applications: [
				{ target: "draft", draftId: "phase-one-v2.omhflow" },
				{ target: "freeze", freezeId: freezeB },
			],
		});
		expect(
			output.some(entry => entry.includes("Workflow checkpoint: run-phase-one:attempt-1:checkpoint-1")),
		).toBeTrue();
		expect(output.some(entry => entry.includes("Workflow restart attempt: attempt-2"))).toBeTrue();
	});

	it("delays aborting live background workflow nodes until the stop deadline elapses", async () => {
		const dir = await createTempDir();
		await fs.mkdir(path.join(dir, "live-deadline"), { recursive: true });
		await Bun.write(
			path.join(dir, "live-deadline.omhflow"),
			`---
name: live-deadline
version: 1
schema: omhflow/v1
checkpoint:
  stopDeadlineMs: 50
changePolicy:
  agentsCanPropose: true
  humansCanApprove: true
---
# Live Deadline

\`\`\`yaml workflow
nodes:
  build:
    type: script
    script:
      inline: |
        return { summary: "built" };
  review:
    type: script
    script:
      inline: |
        return { summary: "reviewed" };
edges:
  - from: build
    to: review
\`\`\`
`,
		);
		const entries: CapturedEntry[] = [];
		const buildStarted = Promise.withResolvers<void>();
		const releaseBuild = Promise.withResolvers<void>();
		const calls: string[] = [];
		let buildSignal: AbortSignal | undefined;
		let observedAbortAt: number | undefined;
		const runtimeHost: WorkflowNodeRuntimeHost = {
			runScriptNode: async input => {
				calls.push(input.node.id);
				if (input.node.id === "build") {
					buildSignal = input.signal;
					input.signal?.addEventListener(
						"abort",
						() => {
							observedAbortAt = Date.now();
							releaseBuild.resolve();
						},
						{ once: true },
					);
					buildStarted.resolve();
					await releaseBuild.promise;
					return { summary: "build stopped after deadline" };
				}
				return { summary: "review should not run" };
			},
		};
		const { output, runtime } = createRuntime(entries, runtimeHost);

		expect(
			await executeAcpBuiltinSlashCommand(
				`/workflow start ${path.join(dir, "live-deadline.omhflow")} --run-id run-live-deadline --family-id family-live-deadline --background`,
				runtime,
			),
		).toEqual({ consumed: true });
		await buildStarted.promise;

		const stopStartedAt = Date.now();
		const stop = executeAcpBuiltinSlashCommand(
			"/workflow stop run-live-deadline:attempt-1 --deadline-ms 30",
			runtime,
		);
		await Bun.sleep(5);
		let failure: unknown;
		try {
			expect(buildSignal).toBeDefined();
			expect(buildSignal?.aborted).toBe(false);
		} catch (error) {
			failure = error;
			releaseBuild.resolve();
		}

		expect(await stop).toEqual({ consumed: true });
		if (failure !== undefined) throw failure;
		expect(observedAbortAt).toBeDefined();
		expect((observedAbortAt ?? stopStartedAt) - stopStartedAt).toBeGreaterThanOrEqual(15);
		expect(calls).toEqual(["build"]);
		expect(
			output.some(entry => entry.includes("Workflow checkpoint: run-live-deadline:attempt-1:checkpoint-1")),
		).toBeTrue();
		const family = reconstructWorkflowFamilies(entries)[0];
		expect(family?.checkpoints[0]?.frontierNodeIds).toEqual(["review"]);
	});

	it("checkpoints live background workflow nodes that abort after the stop deadline", async () => {
		const dir = await createTempDir();
		await fs.mkdir(path.join(dir, "live-abort-deadline"), { recursive: true });
		await Bun.write(
			path.join(dir, "live-abort-deadline.omhflow"),
			`---
name: live-abort-deadline
version: 1
schema: omhflow/v1
checkpoint:
  stopDeadlineMs: 50
changePolicy:
  agentsCanPropose: true
  humansCanApprove: true
---
# Live Abort Deadline

\`\`\`yaml workflow
nodes:
  build:
    type: script
    script:
      inline: |
        return { summary: "built" };
  review:
    type: script
    script:
      inline: |
        return { summary: "reviewed" };
edges:
  - from: build
    to: review
\`\`\`
`,
		);
		const entries: CapturedEntry[] = [];
		const buildStarted = Promise.withResolvers<void>();
		const releaseBuild = Promise.withResolvers<void>();
		const runtimeHost: WorkflowNodeRuntimeHost = {
			runScriptNode: async input => {
				if (input.node.id !== "build") return { summary: "review should not run" };
				input.signal?.addEventListener("abort", () => releaseBuild.resolve(), { once: true });
				buildStarted.resolve();
				await releaseBuild.promise;
				throw new Error(input.signal?.reason ?? "stop deadline elapsed");
			},
		};
		const { output, runtime } = createRuntime(entries, runtimeHost);

		expect(
			await executeAcpBuiltinSlashCommand(
				`/workflow start ${path.join(dir, "live-abort-deadline.omhflow")} --run-id run-live-abort-deadline --family-id family-live-abort-deadline --background`,
				runtime,
			),
		).toEqual({ consumed: true });
		await buildStarted.promise;

		expect(
			await executeAcpBuiltinSlashCommand(
				"/workflow stop run-live-abort-deadline:attempt-1 --deadline-ms 1",
				runtime,
			),
		).toEqual({ consumed: true });

		expect(
			output.some(entry => entry.includes("Workflow checkpoint: run-live-abort-deadline:attempt-1:checkpoint-1")),
		).toBeTrue();
		const family = reconstructWorkflowFamilies(entries)[0];
		expect(family?.attempts.map(attempt => [attempt.id, attempt.status])).toEqual([
			["run-live-abort-deadline:attempt-1", "stopped"],
		]);
		expect(family?.attempts[0]?.activations.map(activation => [activation.nodeId, activation.status])).toEqual([
			["build", "aborted"],
		]);
		expect(family?.checkpoints[0]).toMatchObject({
			completedActivationIds: [],
			abortedActivationIds: ["activation-1"],
			frontierNodeIds: ["build"],
			state: {},
			sourceMapping: { build: "build" },
		});
	});

	it("waits until the stop deadline before aborting running lifecycle activations", async () => {
		const entries: CapturedEntry[] = [];
		const freeze = createFreeze(
			"flowfreeze:a",
			parseWorkflowDefinition(
				`
name: stop-deadline
version: 1
nodes:
  build:
    type: script
    writes:
      - /build
  review:
    type: script
edges:
  - from: build
    to: review
`,
				{ sourcePath: "workflow.yml" },
			),
		);
		const host = createHostFromEntries(entries);
		startWorkflowFamily(host, { familyId: "family-deadline" });
		recordWorkflowFreeze(host, freeze, { familyId: "family-deadline" });
		startWorkflowAttempt(host, {
			familyId: "family-deadline",
			attemptId: "attempt-deadline",
			freezeId: freeze.id,
			startNodeId: "build",
			runtimeBindingSnapshot: binding("binding-deadline"),
		});
		appendWorkflowAttemptActivationStarted(host, {
			attemptId: "attempt-deadline",
			activationId: "activation-build",
			nodeId: "build",
			parentActivationIds: [],
		});
		const { output, runtime } = createRuntime(entries);
		const completion = (async () => {
			await Bun.sleep(5);
			appendWorkflowAttemptActivationCompleted(host, {
				attemptId: "attempt-deadline",
				activationId: "activation-build",
				output: {
					summary: "built before stop deadline",
					statePatch: [{ op: "set", path: "/build/status", value: "complete" }],
				},
			});
		})();

		expect(await executeAcpBuiltinSlashCommand("/workflow stop attempt-deadline --deadline-ms 50", runtime)).toEqual({
			consumed: true,
		});
		await completion;

		const family = reconstructWorkflowFamilies(entries)[0];
		expect(output.some(entry => entry.includes("Workflow checkpoint: attempt-deadline:checkpoint-1"))).toBeTrue();
		expect(family?.attempts.map(attempt => [attempt.id, attempt.status])).toEqual([["attempt-deadline", "stopped"]]);
		expect(family?.attempts[0]?.activations.map(activation => [activation.id, activation.status])).toEqual([
			["activation-build", "completed"],
		]);
		expect(family?.checkpoints[0]).toMatchObject({
			id: "attempt-deadline:checkpoint-1",
			completedActivationIds: ["activation-build"],
			abortedActivationIds: [],
			frontierNodeIds: ["review"],
			state: { build: { status: "complete" } },
			sourceMapping: { review: "review" },
		});
	});

	it("restarts from checkpoint with a frontier mapping approved after the checkpoint was saved", async () => {
		const entries: CapturedEntry[] = [];
		const freezeA = createFreeze("flowfreeze:a", ["build", "weakReview"]);
		const freezeB = createFreeze(
			"flowfreeze:b",
			parseWorkflowDefinition(
				`
name: restarted-review
version: 1
nodes:
  build:
    type: script
  strongReview:
    type: review
    agent: task
    prompt:
      output:
        node: build
        path: /data/reviewPrompt
        activation: parent
    reads:
      - /data/reviewPrompt
    gates:
      - approve
edges: []
`,
				{ sourcePath: "workflow.yml" },
			),
		);
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
			output: {
				summary: "built",
				data: { reviewPrompt: "Review the stopped build output." },
				statePatch: [{ op: "set", path: "/build/status", value: "built" }],
			},
		});
		requestWorkflowAttemptStop(host, {
			attemptId: "attempt-1",
			deadlineMs: 5,
			reason: "stop before editing the workflow",
		});
		createWorkflowCheckpoint(host, {
			checkpointId: "checkpoint-1",
			familyId: "family-1",
			attemptId: "attempt-1",
			completedActivationIds: ["activation-1"],
			abortedActivationIds: [],
			frontierNodeIds: ["weakReview"],
			state: { build: { status: "built" } },
			sourceMapping: { weakReview: "weakReview" },
		});
		proposeWorkflowChangeRequest(host, {
			changeRequestId: "change-1",
			familyId: "family-1",
			checkpointId: "checkpoint-1",
			actor: "human:sihao",
			origin: "human",
			reason: "upgrade the saved frontier before restart",
			operations: [{ op: "add_node", node: { id: "strongReview", type: "script" } }],
			frontierMapping: { weakReview: "strongReview" },
		});
		approveWorkflowChangeRequest(host, {
			changeRequestId: "change-1",
			actor: "human:sihao",
		});
		recordWorkflowFreeze(host, freezeB, { familyId: "family-1" });
		recordWorkflowChangeRequestApplied(host, {
			changeRequestId: "change-1",
			target: "freeze",
			freezeId: freezeB.id,
			actor: "human:sihao",
		});
		const prompts: string[] = [];
		const runtimeHost: WorkflowNodeRuntimeHost = {
			runReviewNode: async input => {
				prompts.push(input.prompt ?? "");
				return { summary: "approved", verdict: "approve" };
			},
		};
		const { output, runtime } = createRuntime(entries, runtimeHost);

		expect(
			await executeAcpBuiltinSlashCommand("/workflow restart checkpoint-1 --freeze-id flowfreeze:b", runtime),
		).toEqual({
			consumed: true,
		});

		const families = reconstructWorkflowFamilies(entries);
		expect(prompts).toEqual(["Review the stopped build output."]);
		expect(output.some(entry => entry.includes("Workflow restart attempt: attempt-2"))).toBeTrue();
		expect(families[0]?.attempts.map(attempt => [attempt.id, attempt.freezeId, attempt.status])).toEqual([
			["attempt-1", "flowfreeze:a", "stopped"],
			["attempt-2", "flowfreeze:b", "completed"],
		]);
	});

	it("does not use approved restart frontier mappings until they are applied to the selected freeze", async () => {
		const entries: CapturedEntry[] = [];
		const freezeA = createFreeze("flowfreeze:a", ["build", "weakReview"]);
		const freezeB = createFreeze("flowfreeze:b", ["strongReview"]);
		const host = createHostFromEntries(entries);
		startWorkflowFamily(host, { familyId: "family-unapplied-mapping" });
		recordWorkflowFreeze(host, freezeA, { familyId: "family-unapplied-mapping" });
		recordWorkflowFreeze(host, freezeB, { familyId: "family-unapplied-mapping" });
		startWorkflowAttempt(host, {
			familyId: "family-unapplied-mapping",
			attemptId: "attempt-1",
			freezeId: freezeA.id,
			startNodeId: "build",
			runtimeBindingSnapshot: binding("binding-1"),
		});
		requestWorkflowAttemptStop(host, {
			attemptId: "attempt-1",
			deadlineMs: 5,
			reason: "stop before mapping is applied",
		});
		createWorkflowCheckpoint(host, {
			checkpointId: "checkpoint-unapplied",
			familyId: "family-unapplied-mapping",
			attemptId: "attempt-1",
			completedActivationIds: [],
			abortedActivationIds: [],
			frontierNodeIds: ["weakReview"],
			state: {},
			sourceMapping: { weakReview: "weakReview" },
		});
		proposeWorkflowChangeRequest(host, {
			changeRequestId: "change-unapplied",
			familyId: "family-unapplied-mapping",
			checkpointId: "checkpoint-unapplied",
			actor: "human:sihao",
			origin: "human",
			reason: "upgrade review but do not apply it yet",
			operations: [{ op: "add_node", node: { id: "strongReview", type: "script" } }],
			frontierMapping: { weakReview: "strongReview" },
		});
		approveWorkflowChangeRequest(host, {
			changeRequestId: "change-unapplied",
			actor: "human:sihao",
		});
		const calls: string[] = [];
		const runtimeHost: WorkflowNodeRuntimeHost = {
			runScriptNode: async input => {
				calls.push(input.node.id);
				return { summary: `ran ${input.node.id}` };
			},
		};
		const { output, runtime } = createRuntime(entries, runtimeHost);

		expect(
			await executeAcpBuiltinSlashCommand(
				"/workflow restart checkpoint-unapplied --freeze-id flowfreeze:b",
				runtime,
			),
		).toEqual({ consumed: true });

		expect(output.at(-1)).toBe("Workflow checkpoint has no restartable frontier: checkpoint-unapplied");
		expect(calls).toEqual([]);
		expect(reconstructWorkflowFamilies(entries)[0]?.attempts).toHaveLength(1);
	});

	it("restarts from checkpoint using migration frontier mappings declared by the target freeze", async () => {
		const entries: CapturedEntry[] = [];
		const freezeA = createFreeze("flowfreeze:a", ["build", "weakReview"]);
		const freezeB = createFreeze(
			"flowfreeze:b",
			parseWorkflowDefinition(
				`
name: migrated-review
version: 2
migrations:
  - from: weak-review
    to: strong-review
    frontierMapping:
      weakReview: strongReview
nodes:
  strongReview:
    type: script
edges: []
`,
				{ sourcePath: "workflow.yml" },
			),
		);
		const host = createHostFromEntries(entries);
		startWorkflowFamily(host, { familyId: "family-migration" });
		recordWorkflowFreeze(host, freezeA, { familyId: "family-migration" });
		recordWorkflowFreeze(host, freezeB, { familyId: "family-migration" });
		startWorkflowAttempt(host, {
			familyId: "family-migration",
			attemptId: "attempt-1",
			freezeId: freezeA.id,
			startNodeId: "build",
			runtimeBindingSnapshot: binding("binding-1"),
		});
		requestWorkflowAttemptStop(host, {
			attemptId: "attempt-1",
			deadlineMs: 5,
			reason: "migrate weak review frontier",
		});
		createWorkflowCheckpoint(host, {
			checkpointId: "checkpoint-migration",
			familyId: "family-migration",
			attemptId: "attempt-1",
			completedActivationIds: [],
			abortedActivationIds: [],
			frontierNodeIds: ["weakReview"],
			state: {},
			sourceMapping: { weakReview: "weakReview" },
		});
		const calls: string[] = [];
		const runtimeHost: WorkflowNodeRuntimeHost = {
			runScriptNode: async input => {
				calls.push(input.node.id);
				return { summary: `ran ${input.node.id}` };
			},
		};
		const { output, runtime } = createRuntime(entries, runtimeHost);

		expect(
			await executeAcpBuiltinSlashCommand(
				"/workflow restart checkpoint-migration --freeze-id flowfreeze:b",
				runtime,
			),
		).toEqual({ consumed: true });

		const family = reconstructWorkflowFamilies(entries)[0];
		expect(calls).toEqual(["strongReview"]);
		expect(output.some(entry => entry.includes("Workflow restart attempt: attempt-2"))).toBeTrue();
		expect(
			output.some(entry => entry.includes("Checkpoint frontier: checkpoint-migration weakReview to strongReview")),
		).toBeTrue();
		expect(family?.attempts[1]?.startNodeIds).toEqual(["strongReview"]);
		expect(family?.attempts.map(attempt => [attempt.id, attempt.freezeId, attempt.status])).toEqual([
			["attempt-1", "flowfreeze:a", "stopped"],
			["attempt-2", "flowfreeze:b", "completed"],
		]);
	});

	it("restarts all checkpoint frontier nodes before continuing joins", async () => {
		const entries: CapturedEntry[] = [];
		const freezeA = createFreeze("flowfreeze:a", ["planner", "leftReview", "rightReview"]);
		const freezeB = createFreeze(
			"flowfreeze:b",
			parseWorkflowDefinition(
				`
name: parallel-frontier
version: 1
nodes:
  leftReview:
    type: script
  rightReview:
    type: script
  merge:
    type: script
    waitFor:
      - leftReview
      - rightReview
edges:
  - from: leftReview
    to: merge
  - from: rightReview
    to: merge
`,
				{ sourcePath: "workflow.yml" },
			),
		);
		const host = createHostFromEntries(entries);
		startWorkflowFamily(host, { familyId: "family-parallel-frontier" });
		recordWorkflowFreeze(host, freezeA, { familyId: "family-parallel-frontier" });
		recordWorkflowFreeze(host, freezeB, { familyId: "family-parallel-frontier" });
		startWorkflowAttempt(host, {
			familyId: "family-parallel-frontier",
			attemptId: "attempt-1",
			freezeId: freezeA.id,
			startNodeId: "planner",
			runtimeBindingSnapshot: binding("binding-1"),
		});
		requestWorkflowAttemptStop(host, {
			attemptId: "attempt-1",
			deadlineMs: 5,
			reason: "parallel frontier",
		});
		createWorkflowCheckpoint(host, {
			checkpointId: "checkpoint-parallel",
			familyId: "family-parallel-frontier",
			attemptId: "attempt-1",
			completedActivationIds: [],
			abortedActivationIds: [],
			frontierNodeIds: ["leftReview", "rightReview"],
			state: {},
			sourceMapping: { leftReview: "leftReview", rightReview: "rightReview" },
		});
		const calls: string[] = [];
		const runtimeHost: WorkflowNodeRuntimeHost = {
			runScriptNode: async input => {
				calls.push(input.node.id);
				return { summary: `ran ${input.node.id}` };
			},
		};
		const { output, runtime } = createRuntime(entries, runtimeHost);

		expect(
			await executeAcpBuiltinSlashCommand("/workflow restart checkpoint-parallel --freeze-id flowfreeze:b", runtime),
		).toEqual({ consumed: true });

		const family = reconstructWorkflowFamilies(entries)[0];
		expect(calls).toEqual(["leftReview", "rightReview", "merge"]);
		expect(output.some(entry => entry.includes("Workflow restart attempt: attempt-2"))).toBeTrue();
		expect(family?.attempts.map(attempt => [attempt.id, attempt.freezeId, attempt.status])).toEqual([
			["attempt-1", "flowfreeze:a", "stopped"],
			["attempt-2", "flowfreeze:b", "completed"],
		]);
		expect(family?.attempts[1]?.startNodeId).toBe("leftReview");
		expect(family?.attempts[1]?.startNodeIds).toEqual(["leftReview", "rightReview"]);
	});

	it("does not stop terminal lifecycle attempts", async () => {
		const entries: CapturedEntry[] = [];
		const freeze = createFreeze("flowfreeze:a", ["build"]);
		const host = createHostFromEntries(entries);
		startWorkflowFamily(host, { familyId: "family-1" });
		recordWorkflowFreeze(host, freeze, { familyId: "family-1" });
		startWorkflowAttempt(host, {
			familyId: "family-1",
			attemptId: "attempt-1",
			freezeId: freeze.id,
			startNodeId: "build",
			runtimeBindingSnapshot: binding("binding-1"),
		});
		completeWorkflowAttempt(host, {
			attemptId: "attempt-1",
			summary: "already complete",
		});
		const { output, runtime } = createRuntime(entries);

		expect(await executeAcpBuiltinSlashCommand("/workflow stop attempt-1 --deadline-ms 5", runtime)).toEqual({
			consumed: true,
		});

		expect(output[0]).toBe("Workflow attempt is not running: attempt-1 (completed)");
		expect(reconstructWorkflowFamilies(entries)[0]?.attempts[0]?.status).toBe("completed");
		expect(reconstructWorkflowFamilies(entries)[0]?.checkpoints).toEqual([]);
	});

	it("rejects restart when checkpoint frontier cannot be mapped into the selected freeze", async () => {
		const entries: CapturedEntry[] = [];
		const freezeA = createFreeze("flowfreeze:a", ["build", "removedReview"]);
		const freezeB = createFreeze("flowfreeze:b", ["fallbackStart"]);
		const host = createHostFromEntries(entries);
		startWorkflowFamily(host, { familyId: "family-1" });
		recordWorkflowFreeze(host, freezeA, { familyId: "family-1" });
		recordWorkflowFreeze(host, freezeB, { familyId: "family-1" });
		startWorkflowAttempt(host, {
			familyId: "family-1",
			attemptId: "attempt-1",
			freezeId: freezeA.id,
			startNodeId: "build",
			runtimeBindingSnapshot: binding("binding-1"),
		});
		requestWorkflowAttemptStop(host, {
			attemptId: "attempt-1",
			deadlineMs: 5,
			reason: "replace removed review node",
		});
		createWorkflowCheckpoint(host, {
			checkpointId: "checkpoint-1",
			familyId: "family-1",
			attemptId: "attempt-1",
			completedActivationIds: [],
			abortedActivationIds: [],
			frontierNodeIds: ["removedReview"],
			state: {},
			sourceMapping: {},
		});
		const calls: string[] = [];
		const runtimeHost: WorkflowNodeRuntimeHost = {
			runScriptNode: async input => {
				calls.push(input.node.id);
				return { summary: `ran ${input.node.id}` };
			},
		};
		const { output, runtime } = createRuntime(entries, runtimeHost);

		expect(
			await executeAcpBuiltinSlashCommand("/workflow restart checkpoint-1 --freeze-id flowfreeze:b", runtime),
		).toEqual({
			consumed: true,
		});

		expect(output[0]).toBe("Workflow checkpoint has no restartable frontier: checkpoint-1");
		expect(calls).toEqual([]);
		expect(reconstructWorkflowFamilies(entries)[0]?.attempts).toHaveLength(1);
	});

	it("lists lifecycle manager records across families, attempts, freezes, checkpoints, and changes", async () => {
		const entries: CapturedEntry[] = [];
		const freezeA = createFreeze("flowfreeze:a", ["tryTiling", "evaluate"]);
		const freezeB = createFreeze("flowfreeze:b", ["integrate", "review"]);
		const host = createHostFromEntries(entries);
		startWorkflowFamily(host, { familyId: "family-optimizer", objective: "optimize kernels" });
		recordWorkflowFreeze(host, freezeA, { familyId: "family-optimizer" });
		startWorkflowAttempt(host, {
			familyId: "family-optimizer",
			attemptId: "attempt-search",
			freezeId: freezeA.id,
			startNodeId: "tryTiling",
			runtimeBindingSnapshot: binding("binding-search"),
		});
		appendWorkflowAttemptActivationStarted(host, {
			attemptId: "attempt-search",
			activationId: "activation-1",
			nodeId: "tryTiling",
			parentActivationIds: [],
		});
		appendWorkflowAttemptActivationCompleted(host, {
			attemptId: "attempt-search",
			activationId: "activation-1",
			output: { summary: "positive branch" },
		});
		proposeWorkflowChangeRequest(host, {
			changeRequestId: "change-integrate",
			familyId: "family-optimizer",
			attemptId: "attempt-search",
			actor: "agent:evaluator",
			origin: "internal-agent",
			reason: "promote positive optimization",
			operations: [{ op: "add_node", node: { id: "integrate", type: "script" } }],
			frontierMapping: { evaluate: "integrate" },
		});
		approveWorkflowChangeRequest(host, {
			changeRequestId: "change-integrate",
			actor: "human:sihao",
		});
		recordWorkflowFreeze(host, freezeB, { familyId: "family-optimizer" });
		requestWorkflowAttemptStop(host, {
			attemptId: "attempt-search",
			deadlineMs: 10,
			reason: "accepted positive branch",
		});
		createWorkflowCheckpoint(host, {
			checkpointId: "checkpoint-search",
			familyId: "family-optimizer",
			attemptId: "attempt-search",
			completedActivationIds: ["activation-1"],
			abortedActivationIds: [],
			frontierNodeIds: ["evaluate"],
			state: {},
			sourceMapping: { evaluate: "integrate" },
		});
		startWorkflowAttempt(host, {
			familyId: "family-optimizer",
			attemptId: "attempt-integrate",
			freezeId: freezeB.id,
			startNodeId: "integrate",
			runtimeBindingSnapshot: binding("binding-integrate"),
		});
		const { output, runtime } = createRuntime(entries);

		expect(await executeAcpBuiltinSlashCommand("/workflow list", runtime)).toEqual({ consumed: true });

		expect(output[0]).toContain("Workflow families: 1");
		expect(output[0]).toContain("- family-optimizer freezes=2 attempts=2 checkpoints=1 changes=1 - optimize kernels");
		expect(output[0]).toContain("Workflow attempts:");
		expect(output[0]).toContain(
			"- attempt-search stopped freeze=flowfreeze:a start=tryTiling activations=1 binding=binding-search",
		);
		expect(output[0]).toContain(
			"- attempt-integrate running freeze=flowfreeze:b start=integrate activations=0 binding=binding-integrate",
		);
		expect(output[0]).toContain("Workflow freezes:");
		expect(output[0]).toContain("- flowfreeze:a nodes=2 resources=0 graph=sha256:graph-flowfreeze:a");
		expect(output[0]).toContain("- flowfreeze:b nodes=2 resources=0 graph=sha256:graph-flowfreeze:b");
		expect(output[0]).toContain("Workflow checkpoints:");
		expect(output[0]).toContain("- checkpoint-search attempt=attempt-search completed=1 aborted=0 frontier=evaluate");
		expect(output[0]).toContain("Workflow change requests:");
		expect(output[0]).toContain(
			"- change-integrate approved internal-agent actor=agent:evaluator ops=1 approvedBy=human:sihao - promote positive optimization",
		);
	});

	it("renders an operator workflow manager with review, interrupt, restart, and binding actions", async () => {
		const entries: CapturedEntry[] = [];
		const freezeA = createFreeze("flowfreeze:a", ["tryTiling", "evaluate"]);
		const freezeB = createFreeze("flowfreeze:b", ["integrate", "review"]);
		const host = createHostFromEntries(entries);
		startWorkflowFamily(host, { familyId: "family-optimizer", objective: "optimize kernels" });
		recordWorkflowFreeze(host, freezeA, { familyId: "family-optimizer" });
		startWorkflowAttempt(host, {
			familyId: "family-optimizer",
			attemptId: "attempt-search",
			freezeId: freezeA.id,
			startNodeId: "tryTiling",
			runtimeBindingSnapshot: {
				...binding("binding-search"),
				warnings: ["model:tryTiling: fallback used"],
			},
		});
		requestWorkflowAttemptStop(host, {
			attemptId: "attempt-search",
			deadlineMs: 10,
			reason: "accepted positive branch",
		});
		createWorkflowCheckpoint(host, {
			checkpointId: "checkpoint-search",
			familyId: "family-optimizer",
			attemptId: "attempt-search",
			completedActivationIds: [],
			abortedActivationIds: [],
			frontierNodeIds: ["evaluate"],
			state: {},
			sourceMapping: { evaluate: "integrate" },
		});
		proposeWorkflowChangeRequest(host, {
			changeRequestId: "change-integrate",
			familyId: "family-optimizer",
			checkpointId: "checkpoint-search",
			actor: "agent:evaluator",
			origin: "internal-agent",
			reason: "promote positive optimization",
			operations: [{ op: "add_node", node: { id: "integrate", type: "script" } }],
			frontierMapping: { evaluate: "integrate" },
		});
		recordWorkflowFreeze(host, freezeB, { familyId: "family-optimizer" });
		restartWorkflowAttempt(host, {
			familyId: "family-optimizer",
			attemptId: "attempt-integrate",
			freezeId: freezeB.id,
			startNodeId: "integrate",
			checkpointId: "checkpoint-search",
			runtimeBindingSnapshot: {
				...binding("binding-integrate"),
				unavailable: ["tool:eval: workflow runtime host does not support script nodes"],
			},
		});
		const { output, runtime } = createRuntime(entries);

		expect(await executeAcpBuiltinSlashCommand("/workflow manager --family-id family-optimizer", runtime)).toEqual({
			consumed: true,
		});

		expect(output[0]).toContain("Workflow manager: family-optimizer");
		expect(output[0]).toContain("Focus:");
		expect(output[0]).toContain(
			"- current attempt: attempt-integrate running freeze=flowfreeze:b from checkpoint-search",
		);
		expect(output[0]).toContain("- latest checkpoint: checkpoint-search frontier=evaluate");
		expect(output[0]).toContain("Change review:");
		expect(output[0]).toContain(
			"- change-integrate proposed internal-agent actor=agent:evaluator ops=1 - promote positive optimization",
		);
		expect(output[0]).toContain("  op: add_node integrate");
		expect(output[0]).toContain("  approve: /workflow approve-change change-integrate --actor human");
		expect(output[0]).toContain("  reject: /workflow reject-change change-integrate --actor human --reason <reason>");
		expect(output[0]).toContain("Runtime bindings:");
		expect(output[0]).toContain(
			"- attempt-search binding-search tools=task agents=task models=builder=openai/gpt-4o",
		);
		expect(output[0]).toContain("  warning: model:tryTiling: fallback used");
		expect(output[0]).toContain(
			"- attempt-integrate binding-integrate tools=task agents=task models=builder=openai/gpt-4o",
		);
		expect(output[0]).toContain("  unavailable: tool:eval: workflow runtime host does not support script nodes");
		expect(output[0]).toContain("Operator actions:");
		expect(output[0]).toContain("- graph: /workflow graph --family-id family-optimizer");
		expect(output[0]).toContain("- interrupt: /workflow stop attempt-integrate --deadline-ms 30000");
		expect(output[0]).toContain("- restart: /workflow restart checkpoint-search --freeze-id flowfreeze:b");
	});

	it("renders a human-facing lifecycle graph with node status and mutable lineage", async () => {
		const entries: CapturedEntry[] = [];
		const freezeA = createFreeze("flowfreeze:weak", ["planner", "runValidation", "weakReview"]);
		const freezeB = createFreeze("flowfreeze:strong", ["planner", "runValidation", "strongReview"]);
		freezeA.definition.nodes = [
			{ id: "planner", type: "agent", agent: "task" },
			{ id: "runValidation", type: "script", script: { language: "js", code: "console.log('ok')" } },
			{ id: "weakReview", type: "review", agent: "task" },
		];
		freezeB.definition.nodes = [
			{ id: "planner", type: "agent", agent: "task" },
			{ id: "runValidation", type: "script", script: { language: "js", code: "console.log('ok')" } },
			{ id: "strongReview", type: "review", agent: "task" },
		];
		freezeB.definition.edges = [
			{ from: "planner", to: "runValidation" },
			{ from: "runValidation", to: "strongReview" },
		];
		const host = createHostFromEntries(entries);
		startWorkflowFamily(host, { familyId: "family-mutable", objective: "upgrade review before validation" });
		recordWorkflowFreeze(host, freezeA, { familyId: "family-mutable" });
		startWorkflowAttempt(host, {
			familyId: "family-mutable",
			attemptId: "attempt-weak",
			freezeId: freezeA.id,
			startNodeId: "planner",
			runtimeBindingSnapshot: binding("binding-weak"),
		});
		appendWorkflowAttemptActivationStarted(host, {
			attemptId: "attempt-weak",
			activationId: "activation-plan",
			nodeId: "planner",
			parentActivationIds: [],
		});
		appendWorkflowAttemptActivationCompleted(host, {
			attemptId: "attempt-weak",
			activationId: "activation-plan",
			output: { summary: "planned validation\nwith extra detail" },
		});
		requestWorkflowAttemptStop(host, {
			attemptId: "attempt-weak",
			deadlineMs: 10,
			reason: "upgrade review",
		});
		createWorkflowCheckpoint(host, {
			checkpointId: "checkpoint-weak",
			familyId: "family-mutable",
			attemptId: "attempt-weak",
			completedActivationIds: ["activation-plan"],
			abortedActivationIds: [],
			frontierNodeIds: ["runValidation"],
			state: {},
			sourceMapping: { planner: "planner", runValidation: "runValidation" },
		});
		proposeWorkflowChangeRequest(host, {
			changeRequestId: "change-strong-review",
			familyId: "family-mutable",
			checkpointId: "checkpoint-weak",
			actor: "human:sihao",
			origin: "human",
			reason: "replace weak review with strong review",
			operations: [
				{ op: "remove_node", nodeId: "weakReview" },
				{ op: "add_node", node: { id: "strongReview", type: "review", agent: "task" } },
			],
			frontierMapping: { runValidation: "runValidation" },
		});
		approveWorkflowChangeRequest(host, {
			changeRequestId: "change-strong-review",
			actor: "human:sihao",
		});
		recordWorkflowFreeze(host, freezeB, { familyId: "family-mutable" });
		restartWorkflowAttempt(host, {
			familyId: "family-mutable",
			attemptId: "attempt-strong",
			freezeId: freezeB.id,
			startNodeId: "runValidation",
			checkpointId: "checkpoint-weak",
			runtimeBindingSnapshot: binding("binding-strong"),
		});
		appendWorkflowAttemptActivationStarted(host, {
			attemptId: "attempt-strong",
			activationId: "activation-validation",
			nodeId: "runValidation",
			parentActivationIds: ["activation-plan"],
		});
		appendWorkflowAttemptActivationCompleted(host, {
			attemptId: "attempt-strong",
			activationId: "activation-validation",
			output: { summary: "validation passed" },
		});
		appendWorkflowAttemptActivationStarted(host, {
			attemptId: "attempt-strong",
			activationId: "activation-review",
			nodeId: "strongReview",
			parentActivationIds: ["activation-validation"],
		});
		appendWorkflowAttemptActivationFailed(host, {
			attemptId: "attempt-strong",
			activationId: "activation-review",
			error: "review prompt missing",
		});
		failWorkflowAttempt(host, {
			attemptId: "attempt-strong",
			error: "review prompt missing",
		});
		const { output, runtime } = createRuntime(entries);

		expect(await executeAcpBuiltinSlashCommand("/workflow graph --family-id family-mutable", runtime)).toEqual({
			consumed: true,
		});

		expect(output[0]).toContain("Workflow graph: family-mutable");
		expect(output[0]).toContain("Objective: upgrade review before validation");
		expect(output[0]).toContain("Latest freeze: flowfreeze:strong");
		expect(output[0]).toContain("Current attempt: attempt-strong failed from checkpoint-weak");
		expect(output[0]).toContain("Changes: 1 approved, 0 proposed, 0 rejected");
		expect(output[0]).toContain("Diagram:");
		expect(output[0]).toContain("│◆ planner");
		expect(output[0]).toContain("checkpointed - planned validation with extra...");
		expect(output[0]).not.toContain("planned validation\nwith extra detail");
		expect(output[0]).toContain("│✓ runValidation");
		expect(output[0]).toContain("║! strongReview");
		expect(nodeCenterHasIncomingConnector(output[0], "strongReview")).toBe(true);
		expect(output[0]).toContain("failed - error: review prompt missing");
		expect(output[0]).toContain("Checkpoint frontier: checkpoint-weak runValidation to runValidation");
		expect(output[0]).toContain("Mutable lineage:");
		expect(output[0]).toContain(
			"- change-strong-review approved by human:sihao - replace weak review with strong review",
		);
	});

	it("prints workflow attempt errors in lifecycle lists", async () => {
		const entries: CapturedEntry[] = [];
		const host = createHostFromEntries(entries);
		const freeze = createFreeze("flowfreeze:error", ["build"]);
		startWorkflowFamily(host, { familyId: "family-error" });
		recordWorkflowFreeze(host, freeze, { familyId: "family-error" });
		startWorkflowAttempt(host, {
			familyId: "family-error",
			attemptId: "attempt-error",
			freezeId: freeze.id,
			startNodeId: "build",
			runtimeBindingSnapshot: binding("binding-error"),
		});
		appendWorkflowAttemptActivationStarted(host, {
			attemptId: "attempt-error",
			activationId: "activation-1",
			nodeId: "build",
			parentActivationIds: [],
		});
		appendWorkflowAttemptActivationFailed(host, {
			attemptId: "attempt-error",
			activationId: "activation-1",
			error: 'workflow agent node "build" requires a subagent runtime adapter',
		});
		failWorkflowAttempt(host, {
			attemptId: "attempt-error",
			error: 'workflow agent node "build" requires a subagent runtime adapter',
		});
		const { output, runtime } = createRuntime(entries);

		expect(await executeAcpBuiltinSlashCommand("/workflow list --family-id family-error", runtime)).toEqual({
			consumed: true,
		});

		expect(output[0]).toContain(
			'- attempt-error failed freeze=flowfreeze:error start=build activations=1 binding=binding-error - error: workflow agent node "build" requires a subagent runtime adapter',
		);
		expect(output[0]).toContain(
			'  - activation-1 build failed - error: workflow agent node "build" requires a subagent runtime adapter',
		);
	});

	it("rejects workflow change requests through the manager command", async () => {
		const entries: CapturedEntry[] = [];
		const host = createHostFromEntries(entries);
		startWorkflowFamily(host, { familyId: "family-1" });
		proposeWorkflowChangeRequest(host, {
			changeRequestId: "change-rejected",
			familyId: "family-1",
			actor: "agent:reviewer",
			origin: "internal-agent",
			reason: "add risky shortcut",
			operations: [{ op: "add_node", node: { id: "skip-review", type: "script" } }],
		});
		const { output, runtime } = createRuntime(entries);

		expect(
			await executeAcpBuiltinSlashCommand(
				"/workflow reject-change change-rejected --actor human:sihao --reason keep strong review",
				runtime,
			),
		).toEqual({ consumed: true });

		expect(output[0]).toBe("Workflow change request rejected: change-rejected");
		expect(reconstructWorkflowFamilies(entries)[0]?.changeRequests).toMatchObject([
			{
				id: "change-rejected",
				status: "rejected",
				rejectedBy: "human:sihao",
				rejectionReason: "keep strong review",
			},
		]);
	});
});

function workflowArtifactSource(extraChangePolicy = "", agentsCanPropose = true): string {
	return `---
name: change-policy-demo
version: 1
schema: omhflow/v1
checkpoint:
  stopDeadlineMs: 50
changePolicy:
  agentsCanPropose: ${agentsCanPropose}
  humansCanApprove: true
${extraChangePolicy}---
# Change Policy Demo

\`\`\`yaml workflow
nodes:
  build:
    type: script
    script:
      inline: |
        return { summary: "built" };
edges: []
\`\`\`
`;
}

function workflowChangeRequestSource(): string {
	return JSON.stringify({
		id: "change-1",
		actor: "agent:reviewer",
		origin: "internal-agent",
		reason: "insert verification",
		operations: [{ op: "add_node", node: { id: "verify", type: "script" } }],
		frontierMapping: { build: "verify" },
	});
}

function expectDefined<T>(value: T | undefined): T {
	expect(value).toBeDefined();
	if (value === undefined) throw new Error("Expected value to be defined");
	return value;
}

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

function nodeCenterHasIncomingConnector(text: string, nodeId: string): boolean {
	const lines = text.split("\n");
	const nodeLineIndex = lines.findIndex(line => line.includes(nodeId));
	if (nodeLineIndex < 0) return false;
	const nodeLine = lines[nodeLineIndex]!;
	const leftBorder = Math.max(nodeLine.indexOf("│"), nodeLine.indexOf("║"));
	const nodeStart = nodeLine.indexOf(nodeId);
	if (leftBorder < 0 || nodeStart < 0) return false;
	const centerColumn = leftBorder + Math.floor((nodeLine.length - leftBorder) / 2);
	return lines.slice(0, nodeLineIndex).some(line => line[centerColumn] === "│" || line[centerColumn] === "║");
}

function createFreeze(id: string, nodeIdsOrDefinition: string[] | WorkflowDefinition): FlowFreeze {
	const definition = Array.isArray(nodeIdsOrDefinition)
		? {
				name: id,
				version: 1,
				models: { roles: { builder: "openai/gpt-4o" }, defaults: { agent: "builder" } },
				nodes: nodeIdsOrDefinition.map(nodeId => ({ id: nodeId, type: "script" as const })),
				edges:
					nodeIdsOrDefinition.length > 1
						? nodeIdsOrDefinition
								.slice(0, -1)
								.map((nodeId, index) => ({ from: nodeId, to: nodeIdsOrDefinition[index + 1]! }))
						: [],
			}
		: nodeIdsOrDefinition;
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
			nodes: Object.fromEntries(definition.nodes.map(node => [node.id, { sourceBlock: "workflow:0" }])),
		},
		staticCheckReport: { status: "passed", checks: [{ name: "fixture", status: "passed" }] },
		portableDefaults: { models: { roles: { builder: "openai/gpt-4o" }, defaults: { agent: "builder" } } },
		definition,
	};
}
