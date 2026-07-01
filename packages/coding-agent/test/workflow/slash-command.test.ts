import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { $ } from "bun";
import { Settings } from "../../src/config/settings";
import { PluginManager } from "../../src/extensibility/plugins/manager";
import { MarketplaceManager } from "../../src/extensibility/plugins/marketplace";
import type { Skill } from "../../src/extensibility/skills";
import type { InteractiveModeContext } from "../../src/modes/types";
import type { AgentSession } from "../../src/session/agent-session";
import { resolveResumableSession } from "../../src/session/session-listing";
import { SessionManager } from "../../src/session/session-manager";
import { executeAcpBuiltinSlashCommand } from "../../src/slash-commands/acp-builtins";
import { type BuiltinSlashCommandRuntime, executeBuiltinSlashCommand } from "../../src/slash-commands/builtin-registry";
import {
	buildWorkflowGraphViewForRuntime,
	requestActiveWorkflowStopsForRuntime,
} from "../../src/slash-commands/helpers/workflow";
import type { ToolSession } from "../../src/tools";
import { parseWorkflowDefinition, type WorkflowDefinition } from "../../src/workflow/definition";
import type { FlowFreeze } from "../../src/workflow/freeze";
import type { WorkflowGraphActiveAgentProgress } from "../../src/workflow/graph-view";
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
import { createSessionWorkflowRuntimeHost } from "../../src/workflow/session-runtime";
import { createShellScriptRunner } from "../../src/workflow/shell-script-runtime";
import { captureWorkflowCheckpointWorkspace } from "../../src/workflow/workspace-checkpoint";

interface CapturedEntry {
	type: "custom";
	customType: string;
	data?: unknown;
}

interface VoidDeferred {
	promise: Promise<void>;
	resolve(value?: void | PromiseLike<void>): void;
	reject(reason?: unknown): void;
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

async function initializeSlashGitWorkspace(workspace: string): Promise<void> {
	await $`git init`.cwd(workspace).quiet();
	await Bun.write(path.join(workspace, "README.md"), "baseline\n");
	await $`git add README.md`.cwd(workspace).quiet();
	await $`git -c user.name=omh-test -c user.email=omh-test@example.invalid -c commit.gpgsign=false commit -m baseline`
		.cwd(workspace)
		.quiet();
}

async function waitForFileText(filePath: string, needle: string): Promise<string> {
	for (let attempt = 0; attempt < 500; attempt++) {
		try {
			const text = await Bun.file(filePath).text();
			if (text.includes(needle)) return text;
		} catch {
			// The producer may not have created the file yet.
		}
		await Bun.sleep(10);
	}
	throw new Error(`Timed out waiting for ${filePath} to contain ${needle}`);
}

async function waitForWorkflowAttemptStatus(
	entries: CapturedEntry[],
	attemptId: string,
	status: string,
): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const current = reconstructWorkflowFamilies(entries)
			.flatMap(family => family.attempts)
			.find(attemptRecord => attemptRecord.id === attemptId)?.status;
		if (current === status) return;
		await Bun.sleep(10);
	}
	throw new Error(`Timed out waiting for workflow attempt ${attemptId} to reach ${status}`);
}

async function waitForPersistedWorkflowCheckpoint(
	sessionId: string,
	cwd: string,
	sessionDir: string,
	checkpointId: string,
) {
	for (let attempt = 0; attempt < 50; attempt++) {
		const match = await resolveResumableSession(sessionId, cwd, sessionDir);
		if (match !== undefined) {
			const manager = await SessionManager.open(match.session.path, sessionDir);
			try {
				const families = reconstructWorkflowFamilies(manager.getBranch());
				if (families.some(family => family.checkpoints.some(checkpoint => checkpoint.id === checkpointId))) {
					return match;
				}
			} finally {
				await manager.close();
			}
		}
		await Bun.sleep(10);
	}
	return undefined;
}

afterEach(async () => {
	vi.restoreAllMocks();
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
	extensionPaths?: string[];
	skills?: Skill[];
	workflowAgentProgressById?: ReadonlyMap<string, WorkflowGraphActiveAgentProgress>;
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
		...(sessionOptions.extensionPaths !== undefined
			? { extensionRunner: { getExtensionPaths: () => sessionOptions.extensionPaths ?? [] } }
			: {}),
		...(sessionOptions.skills !== undefined ? { skills: sessionOptions.skills } : {}),
	} as unknown as AgentSession;
	const sessionManager = {
		appendCustomEntry: (customType: string, data?: unknown) => {
			entries.push({ type: "custom", customType, data });
			return `entry-${entries.length}`;
		},
		getBranch: () => entries,
		ensureOnDisk: async () => {},
		flush: async () => {},
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
			getWorkflowAgentProgressById: () => sessionOptions.workflowAgentProgressById ?? new Map(),
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
		ensureOnDisk: async () => {},
		flush: async () => {},
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
		getObservedSessions: () => [],
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
		abandonedBranches: [],
		rolledBackBranches: [],
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

	it("prints workflow inspection edge conditions as human-facing labels", async () => {
		const host = createHost();
		const definition = parseWorkflowDefinition(
			`
name: slash-condition-labels
version: 1
nodes:
  build:
    type: agent
  review:
    type: review
    gates: [CONTINUE, COMPLETE]
edges:
  - from: build
    to: review
  - from: review
    to: build
    when: outputs.review.verdict == "CONTINUE"
`,
			{ sourcePath: "workflow.yml" },
		);
		startWorkflowRun(host, definition, { runId: "run-conditions" });
		const { output, runtime } = createRuntime(host.entries);

		const result = await executeAcpBuiltinSlashCommand("/workflow inspect", runtime);

		expect(result).toEqual({ consumed: true });
		expect(output[0]).toContain("Graph edges:");
		expect(output[0]).toContain("- review → build when review verdict is CONTINUE");
		expect(output[0]).not.toContain('outputs.review.verdict == "CONTINUE"');
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
		await fs.mkdir(path.join(dir, "slash-start-demo"), { recursive: true });
		await Bun.write(
			path.join(dir, "slash-start-demo.omhflow"),
			`---
name: slash-start-demo
version: 1
schema: omhflow/v1
checkpoint:
  stopDeadlineMs: 50
changePolicy:
  agentsCanPropose: true
  humansCanApprove: true
---
# Slash Start Demo

\`\`\`yaml workflow
name: slash-start-demo
version: 1
nodes:
  build:
    type: script
    script:
      language: js
      inline: |
        return { summary: "built" };
  finish:
    type: script
    script:
      language: js
      inline: |
        return { summary: "finished" };
edges:
  - from: build
    to: finish
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
		const { output, runtime } = createRuntime(entries, runtimeHost, {
			availableModels: [openAiModel],
			activeModel: openAiModel,
		});

		const result = await executeAcpBuiltinSlashCommand(
			`/workflow start ${path.join(dir, "slash-start-demo.omhflow")} --run-id run-1`,
			runtime,
		);

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

	it("starts TUI workflow artifacts in the background with generated lifecycle ids by default", async () => {
		const dir = await createTempDir();
		await fs.mkdir(path.join(dir, "tui-default-background"), { recursive: true });
		const flowPath = path.join(dir, "tui-default-background.omhflow");
		await Bun.write(
			flowPath,
			`---
name: tui-default-background
version: 1
schema: omhflow/v1
checkpoint:
  stopDeadlineMs: 50
changePolicy:
  agentsCanPropose: true
  humansCanApprove: true
---
# TUI Default Background

\`\`\`yaml workflow
name: tui-default-background
version: 1
nodes:
  build:
    type: script
    script:
      language: js
      inline: |
        return { summary: "built" };
edges: []
\`\`\`
`,
		);
		const entries: CapturedEntry[] = [];
		const graphs: unknown[] = [];
		const calls: string[] = [];
		const runtimeHost: WorkflowNodeRuntimeHost = {
			runScriptNode: async input => {
				calls.push(input.node.id);
				return { summary: `ran ${input.node.id}` };
			},
		};
		const { output, runtime } = createRuntime(entries, runtimeHost, {
			availableModels: [openAiModel],
			activeModel: openAiModel,
		});
		const completionReminder = Promise.withResolvers<string>();
		const runtimeWithGraph = {
			...runtime,
			output: (text: string) => {
				runtime.output(text);
				if (text.includes("Workflow completed:") && text.includes("ran build")) completionReminder.resolve(text);
			},
			outputWorkflowGraph: (view: unknown) => {
				graphs.push(view);
			},
		};

		const result = await executeAcpBuiltinSlashCommand(`/workflow start ${flowPath}`, runtimeWithGraph);

		expect(result).toEqual({ consumed: true });
		expect(output.some(entry => entry.startsWith("Workflow background attempt started: workflow-"))).toBe(true);
		const family = reconstructWorkflowFamilies(entries)[0];
		expect(family?.id).toMatch(/^workflow-[^:]+:family$/);
		expect(family?.attempts[0]?.id).toBe(`${family?.id.replace(/:family$/u, "")}:attempt-1`);
		expect(graphs.length).toBeGreaterThan(0);
		expect(calls).toEqual(["build"]);
		const attemptId = family?.attempts[0]?.id;
		if (attemptId === undefined) throw new Error("workflow attempt was not recorded");
		expect(await completionReminder.promise).toContain(`Workflow completed: ${attemptId} - ran build`);
	});

	it("rejects workflow starts from non-artifact workflow packages", async () => {
		const dir = await createTempDir();
		await Bun.write(
			path.join(dir, "workflow.yml"),
			`
name: raw-workflow-demo
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

		expect(await executeAcpBuiltinSlashCommand(`/workflow start ${dir} --run-id raw-run`, runtime)).toEqual({
			consumed: true,
		});

		expect(calls).toEqual([]);
		expect(output.at(-1)).toContain("Workflow start requires a frozen .omhflow artifact");
		expect(reconstructWorkflowRuns(entries)).toEqual([]);
		expect(reconstructWorkflowFamilies(entries)).toEqual([]);
	});

	it("rejects workflow starts when required runtime capabilities are unavailable", async () => {
		const dir = await createTempDir();
		await fs.mkdir(path.join(dir, "missing-capability-demo"), { recursive: true });
		await Bun.write(
			path.join(dir, "missing-capability-demo.omhflow"),
			`---
name: missing-capability-demo
version: 1
schema: omhflow/v1
checkpoint:
  stopDeadlineMs: 50
changePolicy:
  agentsCanPropose: true
  humansCanApprove: true
---
# Missing Capability Demo

\`\`\`yaml workflow
name: missing-capability-demo
version: 1
nodes:
  build:
    type: script
    script:
      language: js
      inline: |
        return { summary: "built" };
edges: []
\`\`\`
`,
		);
		const entries: CapturedEntry[] = [];
		const { output, runtime } = createRuntime(entries, {});

		expect(
			await executeAcpBuiltinSlashCommand(
				`/workflow start ${path.join(dir, "missing-capability-demo.omhflow")} --run-id run-missing-capability`,
				runtime,
			),
		).toEqual({
			consumed: true,
		});

		expect(output.at(-1)).toContain(
			"Workflow runtime binding unavailable: tool:eval: workflow runtime host does not support script nodes",
		);
		expect(reconstructWorkflowRuns(entries)).toEqual([]);
		expect(reconstructWorkflowFamilies(entries)).toEqual([]);
	});

	it("rejects unattended workflow starts when the frozen flow contains human nodes", async () => {
		const dir = await createTempDir();
		await fs.mkdir(path.join(dir, "unattended-human"), { recursive: true });
		const flowPath = path.join(dir, "unattended-human.omhflow");
		await Bun.write(
			flowPath,
			`---
name: unattended-human
version: 1
schema: omhflow/v1
checkpoint:
  stopDeadlineMs: 50
changePolicy:
  agentsCanPropose: true
  humansCanApprove: true
---
# Unattended Human

\`\`\`yaml workflow
name: unattended-human
version: 1
nodes:
  approve:
    type: human
    prompt: Confirm the unattended run.
edges: []
\`\`\`
`,
		);
		const entries: CapturedEntry[] = [];
		const calls: string[] = [];
		const { output, runtime } = createRuntime(entries, {
			runHumanNode: async input => {
				calls.push(input.node.id);
				return { data: { response: "proceed" } };
			},
		});

		expect(
			await executeAcpBuiltinSlashCommand(
				`/workflow start ${flowPath} --run-id run-unattended-human --unattended --background`,
				runtime,
			),
		).toEqual({
			consumed: true,
		});

		expect(calls).toEqual([]);
		expect(output.at(-1)).toContain(
			'Workflow unattended start cannot run human nodes: approve. Start interactively or use a flow without "type: human".',
		);
		expect(reconstructWorkflowRuns(entries)).toEqual([]);
		expect(reconstructWorkflowFamilies(entries)).toEqual([]);
	});

	it("reports .omhflow freeze errors during workflow start without rejecting the command", async () => {
		const dir = await createTempDir();
		await Bun.write(
			path.join(dir, "missing-resource-dir.omhflow"),
			`---
name: missing-resource-dir
version: 1
schema: omhflow/v1
checkpoint:
  stopDeadlineMs: 50
changePolicy:
  agentsCanPropose: true
  humansCanApprove: true
---
# Missing Resource Directory

\`\`\`yaml workflow
nodes:
  check:
    type: script
    script:
      language: sh
      inline: |
        printf '{"summary":"checked"}\\n'
edges: []
\`\`\`
`,
		);
		const entries: CapturedEntry[] = [];
		const runtimeHost: WorkflowNodeRuntimeHost = {
			runScriptNode: async () => ({ summary: "checked" }),
		};
		const { output, runtime } = createRuntime(entries, runtimeHost);

		await expect(
			executeAcpBuiltinSlashCommand(
				`/workflow start ${path.join(dir, "missing-resource-dir.omhflow")} --run-id run-missing-resource --family-id family-missing-resource`,
				runtime,
			),
		).resolves.toEqual({ consumed: true });
		expect(output.at(-1)).toContain("workflow same-name resource directory is not readable");
		expect(reconstructWorkflowFamilies(entries)).toEqual([]);
	});

	it("rejects duplicate workflow start run ids before launching nodes", async () => {
		const dir = await createTempDir();
		await fs.mkdir(path.join(dir, "slash-start-duplicate-demo"), { recursive: true });
		await Bun.write(
			path.join(dir, "slash-start-duplicate-demo.omhflow"),
			`---
name: slash-start-duplicate-demo
version: 1
schema: omhflow/v1
checkpoint:
  stopDeadlineMs: 50
changePolicy:
  agentsCanPropose: true
  humansCanApprove: true
---
# Slash Start Duplicate Demo

\`\`\`yaml workflow
name: slash-start-duplicate-demo
version: 1
nodes:
  build:
    type: script
    script:
      language: js
      inline: |
        return { summary: "built" };
edges: []
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

		const flowPath = path.join(dir, "slash-start-duplicate-demo.omhflow");
		expect(
			await executeAcpBuiltinSlashCommand(`/workflow start ${flowPath} --run-id run-duplicate`, runtime),
		).toEqual({
			consumed: true,
		});
		calls.length = 0;
		expect(
			await executeAcpBuiltinSlashCommand(`/workflow start ${flowPath} --run-id run-duplicate`, runtime),
		).toEqual({
			consumed: true,
		});

		expect(calls).toEqual([]);
		expect(output.at(-1)).toContain("Workflow run already exists: run-duplicate");
		expect(reconstructWorkflowRuns(entries).map(run => run.id)).toEqual(["run-duplicate"]);
	});

	it("passes workflow start activation limits to bounded loop runs", async () => {
		const dir = await createTempDir();
		await fs.mkdir(path.join(dir, "bounded-loop-demo"), { recursive: true });
		await Bun.write(
			path.join(dir, "bounded-loop-demo.omhflow"),
			`---
name: bounded-loop-demo
version: 1
schema: omhflow/v1
checkpoint:
  stopDeadlineMs: 50
changePolicy:
  agentsCanPropose: true
  humansCanApprove: true
---
# Bounded Loop Demo

\`\`\`yaml workflow
name: bounded-loop-demo
version: 1
nodes:
  build:
    type: agent
    agent: task
    prompt: Build one bounded round.
  review:
    type: review
    agent: task
    prompt: Review one bounded round and return continue.
    gates:
      - continue
    fallbackVerdict: continue
edges:
  - from: build
    to: review
  - from: review
    to: build
    when: outputs.review.verdict == "continue"
\`\`\`
`,
		);
		const entries: CapturedEntry[] = [];
		const calls: string[] = [];
		const runtimeHost: WorkflowNodeRuntimeHost = {
			runAgentNode: async input => {
				calls.push(input.node.id);
				return { summary: `ran ${input.node.id}` };
			},
			runReviewNode: async input => {
				calls.push(input.node.id);
				return { summary: `ran ${input.node.id}`, verdict: "continue" };
			},
		};
		const { output, runtime } = createRuntime(entries, runtimeHost, {
			availableModels: [openAiModel],
			activeModel: openAiModel,
		});

		const result = await executeAcpBuiltinSlashCommand(
			`/workflow start ${path.join(dir, "bounded-loop-demo.omhflow")} --run-id run-loop --max-activations 3 --max-node-activations 2`,
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
			modelBindings: {
				build: {
					source: "workflow-default",
					requestedRole: "builder",
					requestedPattern: "openai/gpt-4o",
					resolvedModel: "openai/gpt-4o",
					fallbackUsed: false,
				},
			},
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
			modelBindings: {
				review: {
					source: "workflow-default",
					requestedRole: "reviewer",
					requestedPattern: "anthropic/claude-sonnet-4-5",
					error: 'workflow model for node "review" could not resolve requested model',
					fallbackUsed: false,
				},
			},
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

	it("treats declared bash capability as available when the workflow runtime can execute shell script nodes", async () => {
		const dir = await createTempDir();
		await fs.mkdir(path.join(dir, "bash-capability-binding"), { recursive: true });
		await Bun.write(
			path.join(dir, "bash-capability-binding.omhflow"),
			`---
name: bash-capability-binding-demo
version: 1
schema: omhflow/v1
checkpoint:
  stopDeadlineMs: 50
changePolicy:
  agentsCanPropose: true
  humansCanApprove: true
---
# Bash Capability Binding Demo

\`\`\`yaml workflow
capabilities:
  tools:
    - bash
nodes:
  build:
    type: script
    script:
      language: sh
      inline: |
        printf '{"summary":"built"}\\n'
edges: []
\`\`\`
`,
		);
		const entries: CapturedEntry[] = [];
		const runtimeHost: WorkflowNodeRuntimeHost = {
			runScriptNode: async input => ({ summary: `ran ${input.node.id}` }),
		};
		const { output, runtime } = createRuntime(entries, runtimeHost, {
			availableModels: [openAiModel],
			activeModel: openAiModel,
		});

		expect(
			await executeAcpBuiltinSlashCommand(
				`/workflow start ${path.join(dir, "bash-capability-binding.omhflow")} --run-id run-bash-binding --family-id family-bash-binding --max-activations 0`,
				runtime,
			),
		).toEqual({ consumed: true });

		const families = reconstructWorkflowFamilies(entries);
		expect(families[0]?.attempts[0]?.runtimeBindingSnapshot).toMatchObject({
			id: "run-bash-binding:binding-1",
			tools: ["bash"],
			unavailable: [],
		});

		expect(await executeAcpBuiltinSlashCommand("/workflow manager --family-id family-bash-binding", runtime)).toEqual(
			{
				consumed: true,
			},
		);
		expect(output.at(-1)).toContain("Workflow manager: family-bash-binding");
		expect(output.at(-1)).not.toContain("Diagnostics:");
		expect(output.at(-1)).not.toContain("Runtime bindings:");
		expect(output.at(-1)).not.toContain("unavailable tool:bash");
	});

	it("records plugin, extension, and skill capability binding diagnostics", async () => {
		const dir = await createTempDir();
		await fs.mkdir(path.join(dir, "portable-capabilities"), { recursive: true });
		await Bun.write(
			path.join(dir, "portable-capabilities.omhflow"),
			`---
name: portable-capabilities-demo
version: 1
schema: omhflow/v1
checkpoint:
  stopDeadlineMs: 50
changePolicy:
  agentsCanPropose: true
  humansCanApprove: true
---
# Portable Capabilities Demo

\`\`\`yaml workflow
capabilities:
  plugins:
    - humanize-loop
    - optimizer@community
    - missing-plugin
  extensions:
    - humanize-extension
    - absent-extension
  skills:
    - grill-me
    - missing-skill
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
		vi.spyOn(PluginManager.prototype, "list").mockResolvedValue([
			{
				name: "humanize-loop",
				version: "1.0.0",
				path: "/plugins/humanize-loop",
				manifest: { version: "1.0.0" },
				enabledFeatures: null,
				enabled: true,
			},
		]);
		vi.spyOn(MarketplaceManager.prototype, "listInstalledPlugins").mockResolvedValue([
			{
				id: "optimizer@community",
				scope: "user",
				entries: [
					{
						scope: "user",
						installPath: "/plugins/optimizer",
						version: "1.0.0",
						installedAt: "2026-06-13T00:00:00.000Z",
						lastUpdated: "2026-06-13T00:00:00.000Z",
						enabled: false,
					},
				],
			},
		]);
		const entries: CapturedEntry[] = [];
		const { output, runtime } = createRuntime(
			entries,
			{},
			{
				availableModels: [openAiModel],
				activeModel: openAiModel,
				extensionPaths: ["/extensions/humanize-extension.ts"],
				skills: [
					{
						name: "grill-me",
						description: "Interrogate a plan.",
						filePath: "/skills/grill-me/SKILL.md",
						baseDir: "/skills/grill-me",
						source: "test",
					},
				],
			},
		);

		expect(
			await executeAcpBuiltinSlashCommand(
				`/workflow start ${path.join(dir, "portable-capabilities.omhflow")} --run-id run-portable --family-id family-portable --max-activations 0`,
				runtime,
			),
		).toEqual({ consumed: true });

		const families = reconstructWorkflowFamilies(entries);
		expect(families[0]?.attempts[0]?.runtimeBindingSnapshot).toMatchObject({
			id: "run-portable:binding-1",
			plugins: ["humanize-loop", "missing-plugin", "optimizer@community"],
			extensions: ["absent-extension", "humanize-extension"],
			skills: ["grill-me", "missing-skill"],
			unavailable: [
				"tool:eval: workflow runtime host does not support script nodes",
				"plugin:optimizer@community: installed marketplace plugin is disabled",
				"plugin:missing-plugin: workflow runtime cannot resolve declared plugin",
				"extension:absent-extension: active session has no matching extension",
				"skill:missing-skill: active session has no matching skill",
			],
		});

		expect(await executeAcpBuiltinSlashCommand("/workflow manager --family-id family-portable", runtime)).toEqual({
			consumed: true,
		});
		expect(output.at(-1)).toContain("Diagnostics:");
		expect(output.at(-1)).toContain(
			"unavailable plugin:optimizer@community: installed marketplace plugin is disabled",
		);
		expect(output.at(-1)).not.toContain("plugins=humanize-loop");
		expect(output.at(-1)).not.toContain("Runtime bindings:");
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

	it("keeps unverified candidate names out of bundled lookup while explicit artifacts still freeze and start", async () => {
		const missingEntries: CapturedEntry[] = [];
		const missingRuntime = createRuntime(missingEntries);

		expect(
			await executeAcpBuiltinSlashCommand(
				"/workflow freeze humanize-rlcr --family-id family-unverified-candidate",
				missingRuntime.runtime,
			),
		).toEqual({ consumed: true });
		expect(missingRuntime.output.at(-1)).toContain('workflow flow "humanize-rlcr" was not found');
		expect(reconstructWorkflowFamilies(missingEntries)).toEqual([]);

		const experimentalEntries: CapturedEntry[] = [];
		const experimentalRuntime = createRuntime(experimentalEntries);
		expect(
			await executeAcpBuiltinSlashCommand(
				"/workflow freeze experimental::humanize-rlcr --family-id family-experimental-humanize",
				experimentalRuntime.runtime,
			),
		).toEqual({ consumed: true });
		const experimentalFreeze = reconstructWorkflowFamilies(experimentalEntries)[0]?.freezes[0];
		expect(experimentalFreeze?.flowPath.endsWith("experimental/humanize-rlcr/humanize-rlcr.omhflow")).toBeTrue();

		const dir = await createTempDir();
		const flowPath = path.join(dir, "release.omhflow");
		await fs.mkdir(path.join(dir, "release"), { recursive: true });
		await Bun.write(flowPath, workflowArtifactSource());
		const freezeEntries: CapturedEntry[] = [];
		const freezeRuntime = createRuntime(freezeEntries);

		expect(
			await executeAcpBuiltinSlashCommand(
				`/workflow freeze ${flowPath} --family-id family-explicit-freeze`,
				freezeRuntime.runtime,
			),
		).toEqual({ consumed: true });
		expect(reconstructWorkflowFamilies(freezeEntries)[0]?.freezes[0]?.flowPath).toBe(flowPath);

		const startEntries: CapturedEntry[] = [];
		const { runtime } = createRuntime(startEntries, {});

		expect(
			await executeAcpBuiltinSlashCommand(
				`/workflow start ${flowPath} --run-id run-explicit --family-id family-explicit-start --max-activations 0`,
				runtime,
			),
		).toEqual({ consumed: true });
		const family = reconstructWorkflowFamilies(startEntries)[0];
		expect(family?.id).toBe("family-explicit-start");
		expect(family?.freezes[0]?.flowPath).toBe(flowPath);
		expect(family?.attempts.map(attempt => [attempt.id, attempt.status])).toEqual([
			["run-explicit:attempt-1", "stopped"],
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

	it("preserves review and subflow contract fields in workflow change drafts", async () => {
		const dir = await createTempDir();
		const entries: CapturedEntry[] = [];
		const { output, runtime } = createRuntime(entries);

		await fs.mkdir(path.join(dir, "release"), { recursive: true });
		await Bun.write(path.join(dir, "release.omhflow"), workflowDraftFidelityArtifactSource());
		await Bun.write(path.join(dir, "change.json"), workflowDraftFidelityChangeSource());

		expect(
			await executeAcpBuiltinSlashCommand(
				`/workflow freeze ${path.join(dir, "release.omhflow")} --family-id family-draft-fidelity`,
				runtime,
			),
		).toEqual({ consumed: true });
		const freezeId = reconstructWorkflowFamilies(entries)[0]?.freezes[0]?.id;
		expect(freezeId).toBeDefined();
		const lifecycleHost = createHostFromEntries(entries);
		startWorkflowAttempt(lifecycleHost, {
			familyId: "family-draft-fidelity",
			attemptId: "attempt-draft-fidelity",
			freezeId: freezeId ?? "missing-freeze",
			startNodeId: "build",
			runtimeBindingSnapshot: binding("binding-draft-fidelity"),
		});
		requestWorkflowAttemptStop(lifecycleHost, {
			attemptId: "attempt-draft-fidelity",
			deadlineMs: 50,
			reason: "draft fidelity approved change",
		});
		createWorkflowCheckpoint(lifecycleHost, {
			checkpointId: "attempt-draft-fidelity:checkpoint-1",
			familyId: "family-draft-fidelity",
			attemptId: "attempt-draft-fidelity",
			completedActivationIds: [],
			abortedActivationIds: [],
			frontierNodeIds: ["build"],
			state: {},
			sourceMapping: { build: "build" },
		});
		expect(
			await executeAcpBuiltinSlashCommand(
				`/workflow request-change ${path.join(dir, "change.json")} --family-id family-draft-fidelity --attempt-id attempt-draft-fidelity`,
				runtime,
			),
		).toEqual({ consumed: true });
		expect(
			await executeAcpBuiltinSlashCommand(
				"/workflow approve-change change-draft-fidelity --actor human:sihao",
				runtime,
			),
		).toEqual({ consumed: true });

		const draftPath = path.join(dir, "release-draft.omhflow");
		expect(
			await executeAcpBuiltinSlashCommand(
				`/workflow apply-change change-draft-fidelity --draft-path ${draftPath} --actor human:sihao --reason draft generated`,
				runtime,
			),
		).toEqual({ consumed: true });
		expect(
			output.some(
				entry => entry === "Workflow change request applied: change-draft-fidelity -> draft release-draft.omhflow",
			),
		).toBeTrue();

		const draftDefinition = parseWorkflowDefinition(workflowBlockFromDraft(await Bun.file(draftPath).text()), {
			sourcePath: "release-draft.omhflow",
		});
		const review = draftDefinition.nodes.find(node => node.id === "review");
		expect(review?.fallbackVerdict).toBe("continue");
		expect(review?.workspaceAccess).toBe("read");
		expect(draftDefinition.subflows).toEqual([
			{
				alias: "review-loop",
				name: "review-loop",
				version: 1,
				namespace: "reviewLoop__",
				nodeIds: ["build", "review"],
				entryNodeIds: ["build"],
				exitNodeIds: ["review"],
				resourcePrefix: "review-loop",
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

	it("records branch disposition operations in workflow change requests", async () => {
		const dir = await createTempDir();
		await fs.mkdir(path.join(dir, "release"), { recursive: true });
		await Bun.write(path.join(dir, "release.omhflow"), workflowArtifactSource());
		await Bun.write(
			path.join(dir, "change.json"),
			JSON.stringify({
				id: "change-branch-disposition",
				actor: "agent:evaluator",
				origin: "internal-agent",
				reason: "abandon regressed branch and return to baseline",
				operations: [
					{ op: "abandon_branch", nodeId: "build", reason: "candidate regressed latency" },
					{ op: "rollback_branch", nodeId: "build", targetNodeId: "build", reason: "baseline remains active" },
				],
				frontierMapping: { build: "build" },
			}),
		);
		const entries: CapturedEntry[] = [];
		const { output, runtime } = createRuntime(entries);

		expect(
			await executeAcpBuiltinSlashCommand(
				`/workflow freeze ${path.join(dir, "release.omhflow")} --family-id family-branch-disposition`,
				runtime,
			),
		).toEqual({ consumed: true });
		expect(
			await executeAcpBuiltinSlashCommand(
				`/workflow request-change ${path.join(dir, "change.json")} --family-id family-branch-disposition`,
				runtime,
			),
		).toEqual({ consumed: true });

		const family = reconstructWorkflowFamilies(entries)[0];
		expect(output.some(entry => entry.includes("Workflow change request: change-branch-disposition"))).toBeTrue();
		expect(family?.changeRequests[0]?.operations).toEqual([
			{ op: "abandon_branch", nodeId: "build", reason: "candidate regressed latency" },
			{ op: "rollback_branch", nodeId: "build", targetNodeId: "build", reason: "baseline remains active" },
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

	it("applies attempt-scoped changes after a failed attempt checkpoints", async () => {
		const entries: CapturedEntry[] = [];
		const freezeA = createFreeze("flowfreeze:failed-a", ["build", "review"]);
		const freezeB = createFreeze("flowfreeze:failed-b", ["verify"]);
		const host = createHostFromEntries(entries);
		startWorkflowFamily(host, { familyId: "family-failed-apply" });
		recordWorkflowFreeze(host, freezeA, { familyId: "family-failed-apply" });
		startWorkflowAttempt(host, {
			familyId: "family-failed-apply",
			attemptId: "attempt-1",
			freezeId: freezeA.id,
			startNodeId: "build",
			runtimeBindingSnapshot: binding("binding-1"),
		});
		appendWorkflowAttemptActivationStarted(host, {
			attemptId: "attempt-1",
			activationId: "activation-build",
			nodeId: "build",
			parentActivationIds: [],
		});
		appendWorkflowAttemptActivationCompleted(host, {
			attemptId: "attempt-1",
			activationId: "activation-build",
			output: { summary: "built" },
		});
		appendWorkflowAttemptActivationStarted(host, {
			attemptId: "attempt-1",
			activationId: "activation-review",
			nodeId: "review",
			parentActivationIds: ["activation-build"],
		});
		appendWorkflowAttemptActivationFailed(host, {
			attemptId: "attempt-1",
			activationId: "activation-review",
			error: "review prompt missing",
		});
		failWorkflowAttempt(host, {
			attemptId: "attempt-1",
			error: "review prompt missing",
		});
		createWorkflowCheckpoint(host, {
			checkpointId: "attempt-1:checkpoint-1",
			familyId: "family-failed-apply",
			attemptId: "attempt-1",
			completedActivationIds: ["activation-build"],
			abortedActivationIds: [],
			frontierNodeIds: ["review"],
			state: {},
			sourceMapping: { review: "verify" },
		});
		proposeWorkflowChangeRequest(host, {
			changeRequestId: "change-failed-apply",
			familyId: "family-failed-apply",
			attemptId: "attempt-1",
			actor: "human:sihao",
			origin: "human",
			reason: "repair failed review path",
			operations: [{ op: "add_node", node: { id: "verify", type: "script" } }],
			frontierMapping: { review: "verify" },
		});
		approveWorkflowChangeRequest(host, {
			changeRequestId: "change-failed-apply",
			actor: "human:sihao",
		});
		recordWorkflowFreeze(host, freezeB, { familyId: "family-failed-apply" });
		const verifyStarted = Promise.withResolvers<void>();
		const releaseVerify = Promise.withResolvers<void>();
		const calls: string[] = [];
		const runtimeHost: WorkflowNodeRuntimeHost = {
			runScriptNode: async input => {
				calls.push(input.node.id);
				if (input.node.id === "verify") {
					verifyStarted.resolve();
					await releaseVerify.promise;
				}
				return { summary: `ran ${input.node.id}` };
			},
		};
		const { output, runtime } = createRuntime(entries, runtimeHost);

		expect(
			await executeAcpBuiltinSlashCommand(
				"/workflow apply-change change-failed-apply --freeze-id flowfreeze:failed-b --actor human:sihao",
				runtime,
			),
		).toEqual({ consumed: true });
		expect(output).toContain("Workflow change request applied: change-failed-apply -> freeze flowfreeze:failed-b");
		expect(
			await executeAcpBuiltinSlashCommand(
				"/workflow restart attempt-1:checkpoint-1 --freeze-id flowfreeze:failed-b --background",
				runtime,
			),
		).toEqual({ consumed: true });
		await verifyStarted.promise;
		expect(await executeAcpBuiltinSlashCommand("/workflow manager --family-id family-failed-apply", runtime)).toEqual(
			{
				consumed: true,
			},
		);

		const managerOutput = output.at(-1) ?? "";
		expect(calls).toEqual(["verify"]);
		expect(output.some(entry => entry.includes("Workflow background restart attempt started: attempt-2"))).toBeTrue();
		expect(managerOutput).toContain("- Run: attempt-2 running from checkpoint-1");
		expect(managerOutput).toContain("- Resume in progress: attempt-2 from attempt-1:checkpoint-1");
		expect(reconstructWorkflowFamilies(entries)[0]?.changeRequests[0]?.applications).toMatchObject([
			{
				target: "freeze",
				freezeId: "flowfreeze:failed-b",
				actor: "human:sihao",
			},
		]);

		releaseVerify.resolve();
		await Bun.sleep(10);
		expect(reconstructWorkflowFamilies(entries)[0]?.attempts.at(-1)?.status).toBe("completed");
	});

	it("starts agent workflows through the TUI session task runner", async () => {
		const dir = await createTempDir();
		await fs.mkdir(path.join(dir, "slash-agent-demo"), { recursive: true });
		await Bun.write(
			path.join(dir, "slash-agent-demo.omhflow"),
			`---
name: slash-agent-demo
version: 1
schema: omhflow/v1
models:
  roles:
    builder: openai/gpt-4o
  defaults:
    agent: builder
  unavailable: fail
checkpoint:
  stopDeadlineMs: 50
changePolicy:
  agentsCanPropose: true
  humansCanApprove: true
---
# Slash Agent Demo

\`\`\`yaml workflow
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
\`\`\`
`,
		);
		const entries: CapturedEntry[] = [];
		let requestedTask: unknown;
		const runner: WorkflowAgentTaskRunner = async request => {
			requestedTask = request.task;
			return { exitCode: 0, output: "agent completed" };
		};
		const { output, workflowMonitorComponents, runtime } = createTuiRuntime(entries, dir, runner);

		const result = await executeBuiltinSlashCommand(
			`/workflow start ${path.join(dir, "slash-agent-demo.omhflow")} --run-id run-1`,
			runtime,
		);

		expect(result).toBe(true);
		expect(requestedTask).toEqual({
			id: "build",
			description: "Builder · Build",
			role: "Builder · Build",
			assignment: "Implement the workflow feature.",
		});
		expect(output[0]).toBe("Workflow background attempt started: run-1:attempt-1");
		expect(workflowMonitorComponents).toHaveLength(1);
		await waitForWorkflowAttemptStatus(entries, "run-1:attempt-1", "completed");
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
		expect(output[0]).toBe("Workflow background attempt started: run-monitor:attempt-1");
		expect(output[0]).not.toContain("Current graph revision");
		expect(output[0]).not.toContain("Graph nodes:");
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
		const requestCaptured = Promise.withResolvers<Parameters<WorkflowAgentTaskRunner>[0]>();
		let capturedRequest: Parameters<WorkflowAgentTaskRunner>[0] | undefined;
		const runner: WorkflowAgentTaskRunner = async request => {
			capturedRequest = request;
			requestCaptured.resolve(request);
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
		capturedRequest = await requestCaptured.promise;
		expect(capturedRequest).toMatchObject({
			agent: "reviewer",
			activationId: "activation-1",
			nodeId: "review",
			modelOverride: "rust-cat/gpt-5.5",
			modelOverrideAuthFallback: false,
		});
		expect(capturedRequest?.task.assignment).toContain("Original workflow review assignment:\n\nReturn pass.");
		expect(output[0]).toBe("Workflow background attempt started: run-review:attempt-1");
		const families = reconstructWorkflowFamilies(entries);
		expect(families[0]?.attempts[0]?.runtimeBindingSnapshot).toMatchObject({
			resolvedModels: { review: "rust-cat/gpt-5.5" },
			modelBindings: {
				review: {
					source: "node",
					resolvedModel: "rust-cat/gpt-5.5",
				},
			},
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
		const requestCaptured = Promise.withResolvers<Parameters<WorkflowAgentTaskRunner>[0]>();
		let capturedRequest: Parameters<WorkflowAgentTaskRunner>[0] | undefined;
		const runner: WorkflowAgentTaskRunner = async request => {
			capturedRequest = request;
			requestCaptured.resolve(request);
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
		capturedRequest = await requestCaptured.promise;
		expect(capturedRequest).toMatchObject({
			agent: "reviewer",
			nodeId: "review",
			modelOverride: "rust-cat/gpt-5.5",
			modelOverrideAuthFallback: false,
		});
		const families = reconstructWorkflowFamilies(entries);
		const reviewBinding = families[0]?.attempts[0]?.runtimeBindingSnapshot?.modelBindings?.review;
		expect(reviewBinding?.source).toBe("parent-fallback");
		expect(reviewBinding?.resolvedModel).toBe("rust-cat/gpt-5.5");
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
		const requestCaptured = Promise.withResolvers<Parameters<WorkflowAgentTaskRunner>[0]>();
		let capturedRequest: Parameters<WorkflowAgentTaskRunner>[0] | undefined;
		const runner: WorkflowAgentTaskRunner = async request => {
			capturedRequest = request;
			requestCaptured.resolve(request);
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
		capturedRequest = await requestCaptured.promise;
		expect(capturedRequest).toMatchObject({
			agent: "task",
			nodeId: "build",
			modelOverride: "rust-cat/gpt-5.5",
			modelOverrideAuthFallback: false,
		});
		expect(output[0]).toBe("Workflow background attempt started: run-session-agent:attempt-1");
		const families = reconstructWorkflowFamilies(entries);
		expect(families[0]?.attempts[0]?.runtimeBindingSnapshot).toMatchObject({
			requestedRoles: { builder: "openai/gpt-4o" },
			resolvedModels: { build: "rust-cat/gpt-5.5" },
			modelBindings: {
				build: {
					source: "parent-fallback",
					requestedRole: "builder",
					requestedPattern: "openai/gpt-4o",
					resolvedModel: "rust-cat/gpt-5.5",
					fallbackUsed: true,
					fallbackReason: "parent active model overrides workflow role default",
				},
			},
		});
	});

	it("requests stop for a detached lifecycle attempt without checkpointing it", async () => {
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
		const { output, runtime } = createRuntime(entries);

		expect(await executeAcpBuiltinSlashCommand("/workflow stop attempt-1 --deadline-ms 5", runtime)).toEqual({
			consumed: true,
		});

		const families = reconstructWorkflowFamilies(entries);
		expect(
			output.some(entry => entry.includes("Workflow stop requested for detached attempt: attempt-1")),
		).toBeTrue();
		expect(output.some(entry => entry.includes("Workflow checkpoint: attempt-1:checkpoint-1"))).toBeFalse();
		expect(families[0]?.attempts.map(attempt => [attempt.id, attempt.freezeId, attempt.status])).toEqual([
			["attempt-1", "flowfreeze:a", "stop_requested"],
		]);
		expect(families[0]?.attempts[0]?.activations.map(activation => [activation.id, activation.status])).toEqual([
			["activation-1", "completed"],
			["activation-2", "running"],
		]);
		expect(families[0]?.checkpoints).toEqual([]);
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

	it("stops a uniquely matched displayed attempt id", async () => {
		const entries: CapturedEntry[] = [];
		const freeze = createFreeze("flowfreeze:short-stop", ["build"]);
		const host = createHostFromEntries(entries);
		startWorkflowFamily(host, { familyId: "family-short-stop" });
		recordWorkflowFreeze(host, freeze, { familyId: "family-short-stop" });
		startWorkflowAttempt(host, {
			familyId: "family-short-stop",
			attemptId: "workflow-abc123:attempt-1",
			freezeId: freeze.id,
			startNodeId: "build",
			runtimeBindingSnapshot: binding("binding-short-stop"),
		});
		appendWorkflowAttemptActivationStarted(host, {
			attemptId: "workflow-abc123:attempt-1",
			activationId: "activation-1",
			nodeId: "build",
			parentActivationIds: [],
		});
		const { output, runtime } = createRuntime(entries);

		expect(await executeAcpBuiltinSlashCommand("/workflow stop attempt-1 --deadline-ms 5", runtime)).toEqual({
			consumed: true,
		});

		const family = reconstructWorkflowFamilies(entries)[0];
		expect(
			output.some(entry =>
				entry.includes("Workflow stop requested for detached attempt: workflow-abc123:attempt-1"),
			),
		).toBeTrue();
		expect(
			output.some(entry => entry.includes("Workflow checkpoint: workflow-abc123:attempt-1:checkpoint-1")),
		).toBeFalse();
		expect(family?.attempts[0]?.status).toBe("stop_requested");
		expect(family?.attempts[0]?.activations[0]?.status).toBe("running");
		expect(family?.checkpoints).toEqual([]);
	});

	it("rejects ambiguous displayed attempt ids", async () => {
		const entries: CapturedEntry[] = [];
		const freeze = createFreeze("flowfreeze:ambiguous-short-stop", ["build"]);
		const host = createHostFromEntries(entries);
		for (const familyId of ["family-left", "family-right"]) {
			const attemptId = `${familyId}:attempt-1`;
			startWorkflowFamily(host, { familyId });
			recordWorkflowFreeze(host, freeze, { familyId });
			startWorkflowAttempt(host, {
				familyId,
				attemptId,
				freezeId: freeze.id,
				startNodeId: "build",
				runtimeBindingSnapshot: binding(`binding-${familyId}`),
			});
		}
		const { output, runtime } = createRuntime(entries);

		expect(await executeAcpBuiltinSlashCommand("/workflow stop attempt-1 --deadline-ms 5", runtime)).toEqual({
			consumed: true,
		});

		expect(output[0]).toContain("Workflow attempt id is ambiguous: attempt-1");
		expect(output[0]).toContain("family-left:attempt-1");
		expect(output[0]).toContain("family-right:attempt-1");
		expect(
			reconstructWorkflowFamilies(entries).flatMap(family => family.attempts.map(attempt => attempt.status)),
		).toEqual(["running", "running"]);
	});

	it("does not suffix-match partial attempt ids that contain a scope separator", async () => {
		const entries: CapturedEntry[] = [];
		const freeze = createFreeze("flowfreeze:partial-scoped-stop", ["build"]);
		const host = createHostFromEntries(entries);
		startWorkflowFamily(host, { familyId: "family-partial-scoped-stop" });
		recordWorkflowFreeze(host, freeze, { familyId: "family-partial-scoped-stop" });
		startWorkflowAttempt(host, {
			familyId: "family-partial-scoped-stop",
			attemptId: "workflow-abc123:run-live:attempt-1",
			freezeId: freeze.id,
			startNodeId: "build",
			runtimeBindingSnapshot: binding("binding-partial-scoped-stop"),
		});
		const { output, runtime } = createRuntime(entries);

		expect(await executeAcpBuiltinSlashCommand("/workflow stop run-live:attempt-1 --deadline-ms 5", runtime)).toEqual(
			{
				consumed: true,
			},
		);

		expect(output[0]).toBe("Workflow attempt not found: run-live:attempt-1");
		expect(reconstructWorkflowFamilies(entries)[0]?.attempts[0]?.status).toBe("running");
	});

	it("does not advertise checkpoint resume ids for detached stop requests", async () => {
		const cwd = await createTempDir();
		const sessionDir = path.join(cwd, "sessions");
		const manager = SessionManager.create(cwd, sessionDir);
		try {
			const freeze = createFreeze("flowfreeze:resume-checkpoint", ["build", "review"]);
			startWorkflowFamily(manager, { familyId: "family-resume-checkpoint" });
			recordWorkflowFreeze(manager, freeze, { familyId: "family-resume-checkpoint" });
			startWorkflowAttempt(manager, {
				familyId: "family-resume-checkpoint",
				attemptId: "attempt-resume-checkpoint",
				freezeId: freeze.id,
				startNodeId: "build",
				runtimeBindingSnapshot: binding("binding-resume-checkpoint"),
			});
			appendWorkflowAttemptActivationStarted(manager, {
				attemptId: "attempt-resume-checkpoint",
				activationId: "activation-1",
				nodeId: "build",
				parentActivationIds: [],
			});
			appendWorkflowAttemptActivationCompleted(manager, {
				attemptId: "attempt-resume-checkpoint",
				activationId: "activation-1",
				output: { summary: "built" },
			});
			appendWorkflowAttemptActivationStarted(manager, {
				attemptId: "attempt-resume-checkpoint",
				activationId: "activation-2",
				nodeId: "review",
				parentActivationIds: ["activation-1"],
			});

			expect(await resolveResumableSession(manager.getSessionId(), cwd, sessionDir)).toBeUndefined();

			const output: string[] = [];
			const runtime = {
				session: {} as AgentSession,
				sessionManager: manager,
				settings: Settings.isolated(),
				cwd,
				output: (text: string) => {
					output.push(text);
				},
				refreshCommands: () => {},
				reloadPlugins: async () => {},
			};

			expect(
				await executeAcpBuiltinSlashCommand("/workflow stop attempt-resume-checkpoint --deadline-ms 1", runtime),
			).toEqual({ consumed: true });

			const family = reconstructWorkflowFamilies(manager.getBranch())[0];
			expect(output.join("\n")).toContain("Workflow stop requested for detached attempt: attempt-resume-checkpoint");
			expect(
				output.some(entry => entry.includes("Workflow checkpoint: attempt-resume-checkpoint:checkpoint-1")),
			).toBeFalse();
			expect(family?.attempts[0]?.status).toBe("stop_requested");
			expect(family?.attempts[0]?.activations.map(activation => [activation.id, activation.status])).toEqual([
				["activation-1", "completed"],
				["activation-2", "running"],
			]);
			expect(family?.checkpoints).toEqual([]);
		} finally {
			await manager.close();
		}
	});

	it("persists background workflow checkpoints after the activation limit settles", async () => {
		const cwd = await createTempDir();
		const sessionDir = path.join(cwd, "sessions");
		const manager = SessionManager.create(cwd, sessionDir);
		const flowPath = path.join(cwd, "background-limit.omhflow");
		try {
			await fs.mkdir(path.join(cwd, "background-limit"), { recursive: true });
			await Bun.write(
				flowPath,
				`---
name: background-limit-demo
version: 1
schema: omhflow/v1
checkpoint:
  stopDeadlineMs: 50
changePolicy:
  agentsCanPropose: true
  humansCanApprove: true
---
# Background Limit Demo

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
			const output: string[] = [];
			const runtimeHost: WorkflowNodeRuntimeHost = {
				runScriptNode: async input => ({
					summary: `ran ${input.node.id}`,
					...(input.node.id === "build"
						? { statePatch: [{ op: "set" as const, path: "/build/status", value: "built" }] }
						: {}),
				}),
			};
			const runtime = {
				session: {} as AgentSession,
				sessionManager: manager,
				settings: Settings.isolated(),
				cwd,
				output: (text: string) => {
					output.push(text);
				},
				createWorkflowRuntimeHost: () => runtimeHost,
				refreshCommands: () => {},
				reloadPlugins: async () => {},
			};

			expect(
				await executeAcpBuiltinSlashCommand(
					`/workflow start ${flowPath} --run-id background-limit --family-id family-background-limit --max-activations 1 --background`,
					runtime,
				),
			).toEqual({ consumed: true });
			expect(
				output.some(entry => entry.includes("Workflow background attempt started: background-limit:attempt-1")),
			).toBeTrue();

			const match = await waitForPersistedWorkflowCheckpoint(
				manager.getSessionId(),
				cwd,
				sessionDir,
				"background-limit:attempt-1:checkpoint-1",
			);
			expect(match?.session.id).toBe(manager.getSessionId());
			if (!match) throw new Error("Expected background workflow session to be resumable");

			const reopened = await SessionManager.open(match.session.path, sessionDir);
			try {
				const families = reconstructWorkflowFamilies(reopened.getBranch());
				expect(families[0]?.checkpoints[0]).toMatchObject({
					id: "background-limit:attempt-1:checkpoint-1",
					completedActivationIds: ["activation-1"],
					abortedActivationIds: [],
					frontierNodeIds: ["review"],
					state: { build: { status: "built" } },
					sourceMapping: { review: "review" },
				});
			} finally {
				await reopened.close();
			}
		} finally {
			await manager.close();
		}
	});

	it("does not synthesize checkpoint evidence when stopping a detached attempt", async () => {
		const cwd = await createTempDir();
		const sessionDir = path.join(cwd, "sessions");
		const origin = SessionManager.create(cwd, sessionDir);
		try {
			const freeze = createFreeze("flowfreeze:cross-session", ["build", "review"]);
			startWorkflowFamily(origin, { familyId: "family-cross-session" });
			recordWorkflowFreeze(origin, freeze, { familyId: "family-cross-session" });
			startWorkflowAttempt(origin, {
				familyId: "family-cross-session",
				attemptId: "attempt-cross-session",
				freezeId: freeze.id,
				startNodeId: "build",
				runtimeBindingSnapshot: binding("binding-cross-session"),
			});
			appendWorkflowAttemptActivationStarted(origin, {
				attemptId: "attempt-cross-session",
				activationId: "activation-build",
				nodeId: "build",
				parentActivationIds: [],
			});
			appendWorkflowAttemptActivationCompleted(origin, {
				attemptId: "attempt-cross-session",
				activationId: "activation-build",
				output: { summary: "built" },
			});
			appendWorkflowAttemptActivationStarted(origin, {
				attemptId: "attempt-cross-session",
				activationId: "activation-review",
				nodeId: "review",
				parentActivationIds: ["activation-build"],
			});

			const stopOutput: string[] = [];
			const stopRuntime = {
				session: {} as AgentSession,
				sessionManager: origin,
				settings: Settings.isolated(),
				cwd,
				output: (text: string) => {
					stopOutput.push(text);
				},
				refreshCommands: () => {},
				reloadPlugins: async () => {},
			};

			expect(
				await executeAcpBuiltinSlashCommand("/workflow stop attempt-cross-session --deadline-ms 1", stopRuntime),
			).toEqual({
				consumed: true,
			});
			expect(stopOutput.join("\n")).toContain("Workflow stop requested for detached attempt: attempt-cross-session");
			const families = reconstructWorkflowFamilies(origin.getBranch());
			expect(families[0]?.attempts[0]?.status).toBe("stop_requested");
			expect(families[0]?.attempts[0]?.activations.map(activation => [activation.id, activation.status])).toEqual([
				["activation-build", "completed"],
				["activation-review", "running"],
			]);
			expect(families[0]?.checkpoints).toEqual([]);
		} finally {
			await origin.close();
		}
	});

	it("explains when a restart checkpoint exists in another resumable session", async () => {
		const cwd = await createTempDir();
		const sessionDir = path.join(cwd, "sessions");
		const origin = SessionManager.create(cwd, sessionDir);
		let originClosed = false;
		const checkpointId = "attempt-cross-session:checkpoint-1";
		try {
			const freeze = createFreeze("flowfreeze:cross-session", ["build", "review"]);
			startWorkflowFamily(origin, { familyId: "family-cross-session" });
			recordWorkflowFreeze(origin, freeze, { familyId: "family-cross-session" });
			startWorkflowAttempt(origin, {
				familyId: "family-cross-session",
				attemptId: "attempt-cross-session",
				freezeId: freeze.id,
				startNodeId: "build",
				runtimeBindingSnapshot: binding("binding-cross-session"),
			});
			appendWorkflowAttemptActivationStarted(origin, {
				attemptId: "attempt-cross-session",
				activationId: "activation-build",
				nodeId: "build",
				parentActivationIds: [],
			});
			appendWorkflowAttemptActivationCompleted(origin, {
				attemptId: "attempt-cross-session",
				activationId: "activation-build",
				output: { summary: "built" },
			});
			requestWorkflowAttemptStop(origin, {
				attemptId: "attempt-cross-session",
				deadlineMs: 1,
				reason: "fixture stopped",
			});
			createWorkflowCheckpoint(origin, {
				checkpointId,
				familyId: "family-cross-session",
				attemptId: "attempt-cross-session",
				completedActivationIds: ["activation-build"],
				abortedActivationIds: [],
				frontierNodeIds: ["review"],
				state: {},
				sourceMapping: { review: "review" },
			});
			await origin.ensureOnDisk();
			await origin.close();
			originClosed = true;

			const fresh = SessionManager.create(cwd, sessionDir);
			try {
				const output: string[] = [];
				const restartRuntime = {
					session: {} as AgentSession,
					sessionManager: fresh,
					settings: Settings.isolated(),
					cwd,
					output: (text: string) => {
						output.push(text);
					},
					refreshCommands: () => {},
					reloadPlugins: async () => {},
				};

				expect(await executeAcpBuiltinSlashCommand(`/workflow restart ${checkpointId}`, restartRuntime)).toEqual({
					consumed: true,
				});

				const rendered = output.join("\n");
				expect(rendered).toContain(`Workflow checkpoint not found in current session: ${checkpointId}`);
				expect(rendered).toContain(`Checkpoint exists in session ${origin.getSessionId()}.`);
				expect(rendered).toContain(`Resume that session first: omp --resume ${origin.getSessionId()}`);
			} finally {
				await fresh.close();
			}
		} finally {
			if (!originClosed) await origin.close();
		}
	});

	it("restarts from the checkpoint attempt when activation ids were reused by older attempts", async () => {
		const entries: CapturedEntry[] = [];
		const definition = parseWorkflowDefinition(
			`
name: checkpoint-parent-output-restart
version: 1
nodes:
  prepare:
    type: script
  implement:
    type: script
  review:
    type: review
    agent: task
    reads:
      - /summary
    prompt:
      output:
        node: implement
        path: /summary
        activation: parent
    gates:
      - COMPLETE
edges:
  - from: prepare
    to: implement
  - from: implement
    to: review
`,
			{ sourcePath: "workflow.yml" },
		);
		const freeze = createFreeze("flowfreeze:checkpoint-parent-output", definition);
		const host = createHostFromEntries(entries);
		startWorkflowFamily(host, { familyId: "family-checkpoint-parent-output" });
		recordWorkflowFreeze(host, freeze, { familyId: "family-checkpoint-parent-output" });
		startWorkflowAttempt(host, {
			familyId: "family-checkpoint-parent-output",
			attemptId: "attempt-old",
			freezeId: freeze.id,
			startNodeId: "prepare",
			runtimeBindingSnapshot: binding("binding-old"),
		});
		appendWorkflowAttemptActivationStarted(host, {
			attemptId: "attempt-old",
			activationId: "activation-1",
			nodeId: "prepare",
			parentActivationIds: [],
		});
		appendWorkflowAttemptActivationCompleted(host, {
			attemptId: "attempt-old",
			activationId: "activation-1",
			output: { summary: "old prepare" },
		});
		appendWorkflowAttemptActivationStarted(host, {
			attemptId: "attempt-old",
			activationId: "activation-2",
			nodeId: "implement",
			parentActivationIds: ["activation-1"],
		});
		appendWorkflowAttemptActivationCompleted(host, {
			attemptId: "attempt-old",
			activationId: "activation-2",
			output: { summary: "old implementation summary" },
		});
		completeWorkflowAttempt(host, { attemptId: "attempt-old", summary: "old attempt completed" });
		startWorkflowAttempt(host, {
			familyId: "family-checkpoint-parent-output",
			attemptId: "attempt-checkpoint",
			freezeId: freeze.id,
			startNodeId: "prepare",
			runtimeBindingSnapshot: binding("binding-checkpoint"),
		});
		appendWorkflowAttemptActivationStarted(host, {
			attemptId: "attempt-checkpoint",
			activationId: "activation-1",
			nodeId: "prepare",
			parentActivationIds: [],
		});
		appendWorkflowAttemptActivationCompleted(host, {
			attemptId: "attempt-checkpoint",
			activationId: "activation-1",
			output: { summary: "checkpoint prepare" },
		});
		appendWorkflowAttemptActivationStarted(host, {
			attemptId: "attempt-checkpoint",
			activationId: "activation-2",
			nodeId: "implement",
			parentActivationIds: ["activation-1"],
		});
		appendWorkflowAttemptActivationCompleted(host, {
			attemptId: "attempt-checkpoint",
			activationId: "activation-2",
			output: { summary: "checkpoint implementation summary" },
		});
		requestWorkflowAttemptStop(host, {
			attemptId: "attempt-checkpoint",
			deadlineMs: 1,
			reason: "checkpoint for review restart",
		});
		createWorkflowCheckpoint(host, {
			checkpointId: "checkpoint-parent-output",
			familyId: "family-checkpoint-parent-output",
			attemptId: "attempt-checkpoint",
			completedActivationIds: ["activation-1", "activation-2"],
			abortedActivationIds: [],
			frontierNodeIds: ["review"],
			state: {},
			sourceMapping: { review: "review" },
		});
		const receivedPrompts: string[] = [];
		const runtimeHost: WorkflowNodeRuntimeHost = {
			runReviewNode: async input => {
				receivedPrompts.push(input.prompt ?? "");
				return { summary: "complete", verdict: "COMPLETE" };
			},
		};
		const { output, runtime } = createRuntime(entries, runtimeHost);

		expect(
			await executeAcpBuiltinSlashCommand(
				"/workflow restart checkpoint-parent-output --freeze-id flowfreeze:checkpoint-parent-output",
				runtime,
			),
		).toEqual({ consumed: true });

		const family = reconstructWorkflowFamilies(entries)[0];
		expect(receivedPrompts).toEqual(["checkpoint implementation summary"]);
		expect(output.some(entry => entry.includes("Workflow restart attempt: attempt-3"))).toBeTrue();
		expect(family?.attempts.at(-1)).toMatchObject({
			id: "attempt-3",
			status: "completed",
			checkpointId: "checkpoint-parent-output",
		});
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
		expect(reconstructWorkflowFamilies(entries)[0]?.attempts[0]?.status).toBe("stop_requested");
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

	it("persists TUI live-stop workflow events to the session file", async () => {
		const cwd = await createTempDir();
		const sessionDir = path.join(cwd, "sessions");
		const manager = SessionManager.create(cwd, sessionDir);
		await fs.mkdir(path.join(cwd, "tui-live-stop"), { recursive: true });
		await Bun.write(
			path.join(cwd, "tui-live-stop.omhflow"),
			`---
name: tui-live-stop
version: 1
schema: omhflow/v1
checkpoint:
  stopDeadlineMs: 10
changePolicy:
  agentsCanPropose: true
  humansCanApprove: true
---
# TUI Live Stop

\`\`\`yaml workflow
nodes:
  hold:
    type: script
    script:
      language: sh
      inline: |
        printf started > hold.started
        sleep 300
edges: []
\`\`\`
`,
		);
		try {
			const output: string[] = [];
			const shellRunner = createShellScriptRunner({
				cwd,
				hasUI: false,
				getSessionFile: () => manager.getSessionFile() ?? null,
				getSessionId: () => manager.getSessionId(),
				getSessionSpawns: () => null,
				settings: Settings.isolated(),
			});
			const session = {
				getWorkflowAgentTaskRunner: () => undefined,
				getWorkflowScriptEvalRunner: () => undefined,
				getWorkflowShellScriptRunner: () => shellRunner,
				getWorkflowHumanInputRunner: () => undefined,
				getAvailableModels: () => [],
				modelRegistry: { getAvailable: () => [] },
			} as unknown as AgentSession;
			const runtime = {
				ctx: {
					session,
					sessionManager: manager,
					settings: Settings.isolated(),
					workflowMonitorSnapshotAgentDir: path.join(cwd, "agent"),
					showStatus: (text: string) => {
						output.push(text);
					},
					present: () => {},
					showWorkflowGraphMonitor: () => {},
					getObservedSessions: () => [],
					ui: { requestComponentRender: () => {}, terminal: { rows: 30 } },
					editor: { setText: () => {} },
					refreshSlashCommandState: () => {},
				},
			} as unknown as BuiltinSlashCommandRuntime;

			expect(
				await executeBuiltinSlashCommand(
					`/workflow start ${path.join(cwd, "tui-live-stop.omhflow")} --run-id tui-live-stop --family-id family-tui-live-stop --background`,
					runtime,
				),
			).toBe(true);
			let markerFound = false;
			for (let attempt = 0; attempt < 500; attempt += 1) {
				try {
					await fs.access(path.join(cwd, "hold.started"));
					markerFound = true;
					break;
				} catch {
					await Bun.sleep(10);
				}
			}
			if (!markerFound) throw new Error(`workflow shell marker was not created:\n${output.join("\n")}`);
			await expect(Bun.file(path.join(cwd, "hold.started")).text()).resolves.toBe("started");

			expect(
				await executeBuiltinSlashCommand("/workflow stop tui-live-stop:attempt-1 --deadline-ms 1", runtime),
			).toBe(true);
			expect(
				output.some(entry => entry.includes("Workflow checkpoint: tui-live-stop:attempt-1:checkpoint-1")),
			).toBeTrue();

			await manager.flush();
			const sessionFile = manager.getSessionFile();
			if (!sessionFile) throw new Error("Expected a persisted session file path");
			const reopened = await SessionManager.open(sessionFile, sessionDir);
			try {
				const families = reconstructWorkflowFamilies(reopened.getBranch());
				expect(
					families[0]?.attempts[0]?.activations.map(activation => [activation.nodeId, activation.status]),
				).toEqual([["hold", "aborted"]]);
				expect(families[0]?.checkpoints[0]).toMatchObject({
					id: "tui-live-stop:attempt-1:checkpoint-1",
					completedActivationIds: [],
					abortedActivationIds: ["activation-1"],
					frontierNodeIds: ["hold"],
					state: {},
					sourceMapping: { hold: "hold" },
				});
			} finally {
				await reopened.close();
			}
		} finally {
			await manager.close();
		}
	});

	it("checkpoints background workflow starts when max runtime elapses", async () => {
		const dir = await createTempDir();
		await fs.mkdir(path.join(dir, "runtime-timeout"), { recursive: true });
		await Bun.write(
			path.join(dir, "runtime-timeout.omhflow"),
			`---
name: runtime-timeout-demo
version: 1
schema: omhflow/v1
checkpoint:
  stopDeadlineMs: 50
changePolicy:
  agentsCanPropose: true
  humansCanApprove: true
---
# Runtime Timeout Demo

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
		const buildAborted = Promise.withResolvers<void>();
		const releaseBuild = Promise.withResolvers<void>();
		const runtimeHost: WorkflowNodeRuntimeHost = {
			runScriptNode: async input => {
				if (input.node.id === "build") {
					buildStarted.resolve();
					if (input.signal?.aborted) {
						buildAborted.resolve();
					} else {
						input.signal?.addEventListener("abort", () => buildAborted.resolve(), { once: true });
					}
					await Promise.race([buildAborted.promise, releaseBuild.promise]);
					throw new Error(input.signal?.reason ?? "workflow max runtime elapsed");
				}
				return { summary: "review should not run" };
			},
		};
		const { output, runtime } = createRuntime(entries, runtimeHost);

		const start = executeAcpBuiltinSlashCommand(
			`/workflow start ${path.join(dir, "runtime-timeout.omhflow")} --run-id run-runtime-timeout --family-id family-runtime-timeout --max-runtime-ms 5 --background`,
			runtime,
		);
		expect(await start).toEqual({ consumed: true });
		expect(output.join("\n")).toContain("Workflow background attempt started: run-runtime-timeout:attempt-1");
		const startedResult = await Promise.race([
			buildStarted.promise.then(() => "started"),
			Bun.sleep(200).then(() => "timeout"),
		]);
		expect(startedResult).toBe("started");
		const timeoutResult = await Promise.race([
			buildAborted.promise.then(() => "aborted"),
			Bun.sleep(200).then(() => "timeout"),
		]);
		expect(timeoutResult).toBe("aborted");
		releaseBuild.resolve();
		await waitForWorkflowAttemptStatus(entries, "run-runtime-timeout:attempt-1", "stopped");

		const family = reconstructWorkflowFamilies(entries)[0];
		expect(
			output.some(entry => entry.includes("Workflow background attempt started: run-runtime-timeout:attempt-1")),
		).toBeTrue();
		expect(family?.attempts.map(attempt => [attempt.id, attempt.status])).toEqual([
			["run-runtime-timeout:attempt-1", "stopped"],
		]);
		expect(family?.attempts[0]?.activations[0]).toMatchObject({
			nodeId: "build",
			status: "aborted",
			reason: "workflow max runtime elapsed after 5ms",
		});
		expect(family?.checkpoints[0]).toMatchObject({
			id: "run-runtime-timeout:attempt-1:checkpoint-1",
			completedActivationIds: [],
			abortedActivationIds: ["activation-1"],
			frontierNodeIds: ["build"],
			sourceMapping: { build: "build" },
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
		const flush = vi.spyOn(runtime.ctx.sessionManager, "flush");

		expect(
			await executeBuiltinSlashCommand(
				`/workflow start ${path.join(dir, "live-agent-stop.omhflow")} --run-id run-live-agent --family-id family-live-agent --background`,
				runtime,
			),
		).toBe(true);
		await agentStarted.promise;

		expect(capturedSignal?.aborted).toBe(false);
		flush.mockClear();
		expect(await executeBuiltinSlashCommand("/workflow stop run-live-agent:attempt-1 --deadline-ms 1", runtime)).toBe(
			true,
		);

		expect(capturedSignal?.aborted).toBe(true);
		expect(flush.mock.calls.length).toBeGreaterThanOrEqual(1);
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

	it("requests active workflow stops from an operator interrupt without parsing a slash command", async () => {
		const dir = await createTempDir();
		await fs.mkdir(path.join(dir, "operator-interrupt"), { recursive: true });
		await Bun.write(
			path.join(dir, "operator-interrupt.omhflow"),
			`---
name: operator-interrupt
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
    prompt: Build until the operator interrupts.
edges: []
\`\`\`
`,
		);
		const entries: CapturedEntry[] = [];
		const agentStarted = Promise.withResolvers<void>();
		const agentAborted = Promise.withResolvers<void>();
		let capturedSignal: AbortSignal | undefined;
		const runner: WorkflowAgentTaskRunner = async request => {
			capturedSignal = request.signal;
			request.signal?.addEventListener("abort", () => agentAborted.resolve(), { once: true });
			agentStarted.resolve();
			await agentAborted.promise;
			return {
				exitCode: 1,
				output: "",
				error: request.signal?.reason ?? "operator interrupt",
			};
		};
		const { runtime } = createTuiRuntime(entries, dir, runner);

		expect(
			await executeBuiltinSlashCommand(
				`/workflow start ${path.join(dir, "operator-interrupt.omhflow")} --run-id operator-interrupt --family-id family-operator-interrupt --background`,
				runtime,
			),
		).toBe(true);
		await agentStarted.promise;

		expect(capturedSignal?.aborted).toBe(false);
		const summary = await requestActiveWorkflowStopsForRuntime(runtime.ctx, {
			abortActiveNodes: true,
			deadlineMs: 0,
			reason: "operator interrupt",
		});
		await agentAborted.promise;

		expect(summary).toEqual({
			attemptIds: ["operator-interrupt:attempt-1"],
			abortedAttemptIds: ["operator-interrupt:attempt-1"],
		});
		expect(capturedSignal?.aborted).toBe(true);
		for (let attempt = 0; attempt < 50; attempt += 1) {
			const status = reconstructWorkflowFamilies(entries)[0]?.attempts[0]?.status;
			if (status === "stopped") break;
			await Bun.sleep(10);
		}
		const family = reconstructWorkflowFamilies(entries)[0];
		expect(family?.attempts[0]?.status).toBe("stopped");
		expect(family?.attempts[0]?.activations.map(activation => [activation.nodeId, activation.status])).toEqual([
			["build", "aborted"],
		]);
		expect(family?.checkpoints[0]).toMatchObject({
			abortedActivationIds: ["activation-1"],
			frontierNodeIds: ["build"],
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

	it("checkpoints real shell workflow nodes that abort after the stop deadline", async () => {
		const dir = await createTempDir();
		await fs.mkdir(path.join(dir, "real-shell-deadline"), { recursive: true });
		await Bun.write(
			path.join(dir, "real-shell-deadline.omhflow"),
			`---
name: real-shell-deadline
version: 1
schema: omhflow/v1
checkpoint:
  stopDeadlineMs: 50
changePolicy:
  agentsCanPropose: true
  humansCanApprove: true
---
# Real Shell Deadline

\`\`\`yaml workflow
nodes:
  hold:
    type: script
    script:
      language: sh
      inline: |
        printf 'started\\n' >> hold.log
        sleep 2
        printf '{"summary":"hold finished"}\\n'
  review:
    type: script
    script:
      inline: |
        return { summary: "review should not run" };
edges:
  - from: hold
    to: review
\`\`\`
`,
		);
		const entries: CapturedEntry[] = [];
		const shellSettings = Settings.isolated({ shellPath: "/bin/sh" });
		vi.spyOn(Settings, "init").mockResolvedValue(shellSettings);
		const toolSession = {
			cwd: dir,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getSessionId: () => "workflow-real-shell-deadline-test",
			settings: shellSettings,
		} as unknown as ToolSession;
		const { output, runtime } = createRuntime(
			entries,
			createSessionWorkflowRuntimeHost({
				cwd: dir,
				runShellScript: createShellScriptRunner(toolSession),
			}),
		);

		expect(
			await executeAcpBuiltinSlashCommand(
				`/workflow start ${path.join(dir, "real-shell-deadline.omhflow")} --run-id run-real-shell-deadline --family-id family-real-shell-deadline --background`,
				runtime,
			),
		).toEqual({ consumed: true });
		await waitForFileText(path.join(dir, "hold.log"), "started").catch(error => {
			const message = error instanceof Error ? error.message : String(error);
			const family = reconstructWorkflowFamilies(entries)[0];
			throw new Error(
				[
					message,
					"Workflow output:",
					output.join("\n") || "<none>",
					"Workflow family:",
					JSON.stringify(family, null, 2),
				].join("\n"),
			);
		});

		const stopStartedAt = Date.now();
		expect(
			await executeAcpBuiltinSlashCommand(
				"/workflow stop run-real-shell-deadline:attempt-1 --deadline-ms 25",
				runtime,
			),
		).toEqual({ consumed: true });
		expect(Date.now() - stopStartedAt).toBeLessThan(1_000);

		expect(
			output.some(entry => entry.includes("Workflow checkpoint: run-real-shell-deadline:attempt-1:checkpoint-1")),
		).toBeTrue();
		const family = reconstructWorkflowFamilies(entries)[0];
		expect(family?.attempts.map(attempt => [attempt.id, attempt.status])).toEqual([
			["run-real-shell-deadline:attempt-1", "stopped"],
		]);
		expect(family?.attempts[0]?.activations.map(activation => [activation.nodeId, activation.status])).toEqual([
			["hold", "aborted"],
		]);
		expect(family?.checkpoints[0]).toMatchObject({
			completedActivationIds: [],
			abortedActivationIds: ["activation-1"],
			frontierNodeIds: ["hold"],
			state: {},
			sourceMapping: { hold: "hold" },
		});
	}, 8_000);

	it("does not abort detached running activations when requesting stop with a deadline", async () => {
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

		expect(await executeAcpBuiltinSlashCommand("/workflow stop attempt-deadline --deadline-ms 50", runtime)).toEqual({
			consumed: true,
		});

		const family = reconstructWorkflowFamilies(entries)[0];
		expect(output.join("\n")).toContain("Workflow stop requested for detached attempt: attempt-deadline");
		expect(output.some(entry => entry.includes("Workflow checkpoint: attempt-deadline:checkpoint-1"))).toBeFalse();
		expect(family?.attempts.map(attempt => [attempt.id, attempt.status])).toEqual([
			["attempt-deadline", "stop_requested"],
		]);
		expect(family?.attempts[0]?.activations.map(activation => [activation.id, activation.status])).toEqual([
			["activation-build", "running"],
		]);
		expect(family?.checkpoints).toEqual([]);
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

	it("allows checkpoint restart after generated freeze control artifacts are written", async () => {
		const workspace = await createTempDir();
		await initializeSlashGitWorkspace(workspace);
		await Bun.write(path.join(workspace, "src", "partial.ts"), "export const partial = true;\n");
		const checkpointWorkspace = await captureWorkflowCheckpointWorkspace(workspace);

		const entries: CapturedEntry[] = [];
		const freezeA = createFreeze("flowfreeze:a", ["build", "weakReview"]);
		const freezeB = createFreeze("flowfreeze:b", ["strongReview"]);
		freezeB.flowPath = path.join(workspace, "workflow-output", "adaptive-review-upgrade.omhflow");
		freezeB.resourceDir = path.join(workspace, "workflow-output", "adaptive-review-upgrade");
		const host = createHostFromEntries(entries);
		startWorkflowFamily(host, { familyId: "family-control-artifacts" });
		recordWorkflowFreeze(host, freezeA, { familyId: "family-control-artifacts" });
		startWorkflowAttempt(host, {
			familyId: "family-control-artifacts",
			attemptId: "attempt-1",
			freezeId: freezeA.id,
			startNodeId: "build",
			runtimeBindingSnapshot: binding("binding-1"),
		});
		requestWorkflowAttemptStop(host, {
			attemptId: "attempt-1",
			deadlineMs: 5,
			reason: "stop before adaptive flow refreeze",
		});
		createWorkflowCheckpoint(host, {
			checkpointId: "checkpoint-control-artifacts",
			familyId: "family-control-artifacts",
			attemptId: "attempt-1",
			completedActivationIds: [],
			abortedActivationIds: [],
			frontierNodeIds: ["weakReview"],
			state: {},
			sourceMapping: { weakReview: "weakReview" },
			workspace: checkpointWorkspace,
		});
		proposeWorkflowChangeRequest(host, {
			changeRequestId: "change-control-artifacts",
			familyId: "family-control-artifacts",
			checkpointId: "checkpoint-control-artifacts",
			actor: "agent:reviewer",
			origin: "internal-agent",
			reason: "upgrade review after checkpoint",
			operations: [{ op: "add_node", node: { id: "strongReview", type: "script" } }],
			frontierMapping: { weakReview: "strongReview" },
		});
		approveWorkflowChangeRequest(host, {
			changeRequestId: "change-control-artifacts",
			actor: "human:operator",
		});
		recordWorkflowFreeze(host, freezeB, { familyId: "family-control-artifacts" });
		recordWorkflowChangeRequestApplied(host, {
			changeRequestId: "change-control-artifacts",
			actor: "human:operator",
			target: "freeze",
			freezeId: freezeB.id,
		});
		await Bun.write(freezeB.flowPath, "generated adaptive draft\n");
		await Bun.write(path.join(freezeB.resourceDir, "prompts", "review.md"), "review the resumed work\n");

		const calls: string[] = [];
		const runtimeHost: WorkflowNodeRuntimeHost = {
			runScriptNode: async input => {
				calls.push(input.node.id);
				return { summary: `ran ${input.node.id}` };
			},
		};
		const { output, runtime } = createRuntime(entries, runtimeHost);
		runtime.cwd = workspace;

		expect(
			await executeAcpBuiltinSlashCommand(
				"/workflow restart checkpoint-control-artifacts --freeze-id flowfreeze:b",
				runtime,
			),
		).toEqual({ consumed: true });

		expect(calls).toEqual(["strongReview"]);
		expect(output.join("\n")).not.toContain("Workflow checkpoint workspace state does not match current workspace");
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
		proposeWorkflowChangeRequest(host, {
			changeRequestId: "change-migration",
			familyId: "family-migration",
			checkpointId: "checkpoint-migration",
			actor: "human:sihao",
			origin: "human",
			reason: "apply migration frontier mapping",
			operations: [{ op: "add_node", node: { id: "strongReview", type: "script" } }],
			frontierMapping: { weakReview: "strongReview" },
		});
		approveWorkflowChangeRequest(host, {
			changeRequestId: "change-migration",
			actor: "human:sihao",
		});
		recordWorkflowChangeRequestApplied(host, {
			changeRequestId: "change-migration",
			actor: "human:sihao",
			target: "freeze",
			freezeId: freezeB.id,
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
		expect(output.some(entry => entry.includes("Frontier: weakReview to strongReview"))).toBeTrue();
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
		proposeWorkflowChangeRequest(host, {
			changeRequestId: "change-parallel-frontier",
			familyId: "family-parallel-frontier",
			checkpointId: "checkpoint-parallel",
			actor: "human:sihao",
			origin: "human",
			reason: "apply parallel frontier restart mapping",
			operations: [],
			frontierMapping: { leftReview: "leftReview", rightReview: "rightReview" },
		});
		approveWorkflowChangeRequest(host, {
			changeRequestId: "change-parallel-frontier",
			actor: "human:sihao",
		});
		recordWorkflowChangeRequestApplied(host, {
			changeRequestId: "change-parallel-frontier",
			actor: "human:sihao",
			target: "freeze",
			freezeId: freezeB.id,
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

	it("rejects checkpoint restart frontiers that would bypass join prerequisites", async () => {
		const entries: CapturedEntry[] = [];
		const freeze = createFreeze(
			"flowfreeze:join",
			parseWorkflowDefinition(
				`
name: join-frontier
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
		startWorkflowFamily(host, { familyId: "family-join-frontier" });
		recordWorkflowFreeze(host, freeze, { familyId: "family-join-frontier" });
		startWorkflowAttempt(host, {
			familyId: "family-join-frontier",
			attemptId: "attempt-1",
			freezeId: freeze.id,
			startNodeId: "leftReview",
			runtimeBindingSnapshot: binding("binding-1"),
		});
		requestWorkflowAttemptStop(host, {
			attemptId: "attempt-1",
			deadlineMs: 5,
			reason: "bad join frontier",
		});
		createWorkflowCheckpoint(host, {
			checkpointId: "checkpoint-join-frontier",
			familyId: "family-join-frontier",
			attemptId: "attempt-1",
			completedActivationIds: [],
			abortedActivationIds: [],
			frontierNodeIds: ["merge"],
			state: {},
			sourceMapping: { merge: "merge" },
		});
		const calls: string[] = [];
		const runtimeHost: WorkflowNodeRuntimeHost = {
			runScriptNode: async input => {
				calls.push(input.node.id);
				return { summary: `ran ${input.node.id}` };
			},
		};
		const { output, runtime } = createRuntime(entries, runtimeHost);

		expect(await executeAcpBuiltinSlashCommand("/workflow restart checkpoint-join-frontier", runtime)).toEqual({
			consumed: true,
		});

		expect(calls).toEqual([]);
		expect(output.at(-1)).toContain(
			'Workflow restart frontier node "merge" requires checkpoint frontier siblings: leftReview, rightReview',
		);
		expect(reconstructWorkflowFamilies(entries)[0]?.attempts).toHaveLength(1);
	});

	it("restarts checkpointed workflows in the background without blocking operator control", async () => {
		const entries: CapturedEntry[] = [];
		const freeze = createFreeze("flowfreeze:background-restart", ["build", "review"]);
		const host = createHostFromEntries(entries);
		startWorkflowFamily(host, { familyId: "family-background-restart" });
		recordWorkflowFreeze(host, freeze, { familyId: "family-background-restart" });
		startWorkflowAttempt(host, {
			familyId: "family-background-restart",
			attemptId: "attempt-1",
			freezeId: freeze.id,
			startNodeId: "build",
			runtimeBindingSnapshot: binding("binding-1"),
		});
		requestWorkflowAttemptStop(host, {
			attemptId: "attempt-1",
			deadlineMs: 5,
			reason: "restart in background",
		});
		createWorkflowCheckpoint(host, {
			checkpointId: "checkpoint-background",
			familyId: "family-background-restart",
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
				}
				return { summary: `ran ${input.node.id}` };
			},
		};
		const { output, runtime } = createRuntime(entries, runtimeHost);

		expect(
			await executeAcpBuiltinSlashCommand(
				"/workflow restart checkpoint-background --freeze-id flowfreeze:background-restart --background",
				runtime,
			),
		).toEqual({ consumed: true });
		await buildStarted.promise;

		expect(calls).toEqual(["build"]);
		expect(output.some(entry => entry.includes("Workflow background restart attempt started: attempt-2"))).toBeTrue();
		expect(output.some(entry => entry.includes("Workflow graph: family-background-restart"))).toBeTrue();
		expect(reconstructWorkflowFamilies(entries)[0]?.attempts.at(-1)).toMatchObject({
			id: "attempt-2",
			status: "running",
		});

		releaseBuild.resolve();
		await Bun.sleep(10);
		expect(reconstructWorkflowFamilies(entries)[0]?.attempts.at(-1)?.status).toBe("completed");
	});

	it("does not report a background restart as started when lifecycle validation rejects it", async () => {
		const entries: CapturedEntry[] = [];
		const freezeA = createFreeze("flowfreeze:background-restart-a", ["build"]);
		const freezeB = createFreeze("flowfreeze:background-restart-b", ["review"]);
		const host = createHostFromEntries(entries);
		startWorkflowFamily(host, { familyId: "family-background-restart-rejected" });
		recordWorkflowFreeze(host, freezeA, { familyId: "family-background-restart-rejected" });
		recordWorkflowFreeze(host, freezeB, { familyId: "family-background-restart-rejected" });
		startWorkflowAttempt(host, {
			familyId: "family-background-restart-rejected",
			attemptId: "attempt-1",
			freezeId: freezeA.id,
			startNodeId: "build",
			runtimeBindingSnapshot: binding("binding-1"),
		});
		failWorkflowAttempt(host, { attemptId: "attempt-1", error: "review rejected" });
		createWorkflowCheckpoint(host, {
			checkpointId: "checkpoint-background-rejected",
			familyId: "family-background-restart-rejected",
			attemptId: "attempt-1",
			completedActivationIds: [],
			abortedActivationIds: [],
			frontierNodeIds: ["build"],
			state: {},
			sourceMapping: { build: "review" },
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
				"/workflow restart checkpoint-background-rejected --freeze-id flowfreeze:background-restart-b --background",
				runtime,
			),
		).toEqual({ consumed: true });
		await Bun.sleep(10);

		expect(calls).toEqual([]);
		expect(output.some(entry => entry.includes("Workflow background restart attempt started"))).toBeFalse();
		expect(output.at(-1)).toContain(
			"Workflow restart attempt failed before start: attempt-2 - Workflow restart freeze is not applied to checkpoint checkpoint-background-rejected: flowfreeze:background-restart-b",
		);
		expect(reconstructWorkflowFamilies(entries)[0]?.attempts.map(attempt => attempt.id)).toEqual(["attempt-1"]);
	});

	it("allocates a unique restart attempt id when generated ids would collide", async () => {
		const entries: CapturedEntry[] = [];
		const freeze = createFreeze("flowfreeze:restart-id", ["build"]);
		const host = createHostFromEntries(entries);
		startWorkflowFamily(host, { familyId: "family-restart-id" });
		recordWorkflowFreeze(host, freeze, { familyId: "family-restart-id" });
		startWorkflowAttempt(host, {
			familyId: "family-restart-id",
			attemptId: "attempt-2",
			freezeId: freeze.id,
			startNodeId: "build",
			runtimeBindingSnapshot: binding("binding-2"),
		});
		requestWorkflowAttemptStop(host, {
			attemptId: "attempt-2",
			deadlineMs: 5,
			reason: "restart custom id",
		});
		createWorkflowCheckpoint(host, {
			checkpointId: "checkpoint-id",
			familyId: "family-restart-id",
			attemptId: "attempt-2",
			completedActivationIds: [],
			abortedActivationIds: [],
			frontierNodeIds: ["build"],
			state: {},
			sourceMapping: { build: "build" },
		});
		const runtimeHost: WorkflowNodeRuntimeHost = {
			runScriptNode: async () => ({ summary: "built" }),
		};
		const { output, runtime } = createRuntime(entries, runtimeHost);

		expect(
			await executeAcpBuiltinSlashCommand(
				"/workflow restart checkpoint-id --freeze-id flowfreeze:restart-id",
				runtime,
			),
		).toEqual({ consumed: true });

		expect(output.some(entry => entry.includes("Workflow restart attempt: attempt-3"))).toBeTrue();
		expect(reconstructWorkflowFamilies(entries)[0]?.attempts.map(attempt => attempt.id)).toEqual([
			"attempt-2",
			"attempt-3",
		]);
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

	it("requests stop for a detached persisted attempt with no activations", async () => {
		const entries: CapturedEntry[] = [];
		const freeze = createFreeze("flowfreeze:empty-activation-stop", ["build", "review"]);
		const host = createHostFromEntries(entries);
		startWorkflowFamily(host, { familyId: "family-empty-activation-stop" });
		recordWorkflowFreeze(host, freeze, { familyId: "family-empty-activation-stop" });
		startWorkflowAttempt(host, {
			familyId: "family-empty-activation-stop",
			attemptId: "attempt-empty-activation",
			freezeId: freeze.id,
			startNodeId: "build",
			runtimeBindingSnapshot: binding("binding-empty-activation"),
		});
		const { output, runtime } = createRuntime(entries);

		expect(
			await executeAcpBuiltinSlashCommand("/workflow stop attempt-empty-activation --deadline-ms 5", runtime),
		).toEqual({
			consumed: true,
		});

		const family = reconstructWorkflowFamilies(entries)[0];
		expect(
			output.some(entry => entry.includes("Workflow checkpoint: attempt-empty-activation:checkpoint-1")),
		).toBeFalse();
		expect(output.join("\n")).toContain("Workflow stop requested for detached attempt: attempt-empty-activation");
		expect(family?.attempts[0]?.status).toBe("stop_requested");
		expect(family?.checkpoints).toEqual([]);
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
		approveWorkflowChangeRequest(host, {
			changeRequestId: "change-integrate",
			actor: "human:sihao",
		});
		recordWorkflowFreeze(host, freezeB, { familyId: "family-optimizer" });
		recordWorkflowChangeRequestApplied(host, {
			changeRequestId: "change-integrate",
			actor: "human:sihao",
			target: "freeze",
			freezeId: freezeB.id,
		});
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
		expect(output[0]).toContain("Overview:");
		expect(output[0]).toContain("- Run: attempt-integrate running from checkpoint-search");
		expect(output[0]).toContain("- Frontier: evaluate to integrate");
		expect(output[0]).toContain("- On-flight: none");
		expect(output[0]).not.toContain("On-flight:\n- none");
		expect(output[0]).toContain("Change review:");
		expect(output[0]).toContain(
			"- change-integrate approved by human:sihao · applied - promote positive optimization",
		);
		expect(output[0]).toContain("Diagnostics:");
		expect(output[0]).toContain("- attempt-search: warning model:tryTiling: fallback used");
		expect(output[0]).toContain(
			"- attempt-integrate: unavailable tool:eval: workflow runtime host does not support script nodes",
		);
		expect(output[0]).toContain("Controls:");
		expect(output[0]).toContain("- Refresh · /workflow graph --family-id family-optimizer");
		expect(output[0]).toContain("- Stop attempt · /workflow stop attempt-integrate --deadline-ms 30000");
		expect(output[0]).toContain("- Resume in progress: attempt-integrate from checkpoint-search");
		expect(output[0]).not.toContain("Runtime bindings:");
		expect(output[0]).not.toContain(
			"- restart: /workflow restart checkpoint-search --freeze-id flowfreeze:b --background",
		);
	});

	it("accepts workflow status as a human-facing manager view alias", async () => {
		const entries: CapturedEntry[] = [];
		const freeze = createFreeze("flowfreeze:status", ["build", "review"]);
		const host = createHostFromEntries(entries);
		startWorkflowFamily(host, { familyId: "family-status", objective: "watch workflow health" });
		recordWorkflowFreeze(host, freeze, { familyId: "family-status" });
		startWorkflowAttempt(host, {
			familyId: "family-status",
			attemptId: "attempt-status",
			freezeId: freeze.id,
			startNodeId: "build",
			runtimeBindingSnapshot: binding("binding-status"),
		});
		const { output, runtime } = createRuntime(entries);

		expect(await executeAcpBuiltinSlashCommand("/workflow status --family-id family-status", runtime)).toEqual({
			consumed: true,
		});

		expect(output).toHaveLength(1);
		expect(output[0]).toContain("Workflow manager: family-status");
		expect(output[0]).toContain("- Run: attempt-status running");
		expect(output[0]).toContain("- Stop attempt · /workflow stop attempt-status --deadline-ms 30000");
		expect(output[0]).not.toContain("Usage: /workflow");
	});

	it("rejects restarting a checkpoint that already has a running resume attempt", async () => {
		const entries: CapturedEntry[] = [];
		const freeze = createFreeze("flowfreeze:duplicate-restart", ["build", "review"]);
		const host = createHostFromEntries(entries);
		startWorkflowFamily(host, { familyId: "family-duplicate-restart" });
		recordWorkflowFreeze(host, freeze, { familyId: "family-duplicate-restart" });
		startWorkflowAttempt(host, {
			familyId: "family-duplicate-restart",
			attemptId: "attempt-source",
			freezeId: freeze.id,
			startNodeId: "build",
			runtimeBindingSnapshot: binding("binding-source"),
		});
		requestWorkflowAttemptStop(host, {
			attemptId: "attempt-source",
			deadlineMs: 10,
			reason: "operator checkpoint",
		});
		createWorkflowCheckpoint(host, {
			checkpointId: "checkpoint-duplicate",
			familyId: "family-duplicate-restart",
			attemptId: "attempt-source",
			completedActivationIds: [],
			abortedActivationIds: [],
			frontierNodeIds: ["review"],
			state: {},
			sourceMapping: {},
		});
		restartWorkflowAttempt(host, {
			familyId: "family-duplicate-restart",
			attemptId: "attempt-resume",
			freezeId: freeze.id,
			startNodeId: "review",
			checkpointId: "checkpoint-duplicate",
			runtimeBindingSnapshot: binding("binding-resume"),
		});
		const { output, runtime } = createRuntime(entries);

		expect(await executeAcpBuiltinSlashCommand("/workflow restart checkpoint-duplicate", runtime)).toEqual({
			consumed: true,
		});

		expect(output[0]).toBe("Workflow checkpoint already has a running resume: checkpoint-duplicate (attempt-resume)");
	});

	it("shows running workflow agents in the operator manager", async () => {
		const dir = await createTempDir();
		await fs.mkdir(path.join(dir, "live-manager"), { recursive: true });
		await Bun.write(
			path.join(dir, "live-manager.omhflow"),
			`---
name: live-manager
version: 1
schema: omhflow/v1
checkpoint:
  stopDeadlineMs: 50
changePolicy:
  agentsCanPropose: true
  humansCanApprove: true
---
# Live Manager

\`\`\`yaml workflow
nodes:
  buildRound:
    type: agent
    agent: task
    prompt: Build the current round.
  reviewRound:
    type: review
    agent: task
    prompt: Review the current round.
    gates:
      - COMPLETE
edges: []
\`\`\`
`,
		);
		const entries: CapturedEntry[] = [];
		const buildStarted = Promise.withResolvers<void>();
		const reviewStarted = Promise.withResolvers<void>();
		const releaseAgents = Promise.withResolvers<void>();
		const runtimeHost: WorkflowNodeRuntimeHost = {
			runAgentNode: async () => {
				buildStarted.resolve();
				await releaseAgents.promise;
				return { summary: "built" };
			},
			runReviewNode: async () => {
				reviewStarted.resolve();
				await releaseAgents.promise;
				return { summary: "complete", verdict: "COMPLETE" };
			},
		};
		const { output, runtime } = createRuntime(entries, runtimeHost);

		expect(
			await executeAcpBuiltinSlashCommand(
				`/workflow start ${path.join(dir, "live-manager.omhflow")} --run-id live-manager --family-id family-agents --background`,
				runtime,
			),
		).toEqual({ consumed: true });
		await Promise.all([buildStarted.promise, reviewStarted.promise]);

		expect(await executeAcpBuiltinSlashCommand("/workflow manager --family-id family-agents", runtime)).toEqual({
			consumed: true,
		});

		const managerOutput = output.at(-1) ?? "";
		expect(managerOutput).toContain("On-flight:");
		expect(managerOutput).toContain(
			"- Agent Hub: double-left or observe to watch; Enter steers the selected agent; Esc returns.",
		);
		expect(managerOutput).toContain("- Builder · Build round live");
		expect(managerOutput).toContain("- Reviewer · Review round live");
		expect(managerOutput).toContain("- Builder · Build round live (watch/intervene buildRound)");
		expect(managerOutput).toContain(
			"- Interrupt Builder · Build round · /workflow interrupt live-manager:attempt-1 buildRound --deadline-ms 30000",
		);
		expect(managerOutput).toContain(
			"- Interrupt Reviewer · Review round · /workflow interrupt live-manager:attempt-1 reviewRound --deadline-ms 30000",
		);
		expect(managerOutput).toContain(
			"- Open Agent Hub · double-left or observe key; watch/intervene buildRound or reviewRound",
		);
		expect(managerOutput).toContain("- Stop attempt · /workflow stop live-manager:attempt-1 --deadline-ms 30000");
		expect(managerOutput).toContain(
			"- Steer selected agent · Agent Hub Enter attaches to the selected agent; Esc returns to workflow control",
		);
		expect(managerOutput).not.toContain("agent:task");
		expect(managerOutput).not.toContain("review:task");
		expect(managerOutput).not.toContain("/agents");

		releaseAgents.resolve();
		await Bun.sleep(10);
	});

	it("does not expose Agent Hub controls for stale active attempts that are persisted terminal", async () => {
		const dir = await createTempDir();
		await fs.mkdir(path.join(dir, "stale-active-terminal"), { recursive: true });
		await Bun.write(
			path.join(dir, "stale-active-terminal.omhflow"),
			`---
name: stale-active-terminal
version: 1
schema: omhflow/v1
checkpoint:
  stopDeadlineMs: 50
changePolicy:
  agentsCanPropose: true
  humansCanApprove: true
---
# Stale Active Terminal

\`\`\`yaml workflow
nodes:
  buildRound:
    type: agent
    agent: task
    prompt: Build the current round.
edges: []
\`\`\`
`,
		);
		const entries: CapturedEntry[] = [];
		const buildStarted = Promise.withResolvers<void>();
		const releaseBuild = Promise.withResolvers<void>();
		const runtimeHost: WorkflowNodeRuntimeHost = {
			runAgentNode: async () => {
				buildStarted.resolve();
				await releaseBuild.promise;
				return { summary: "built late" };
			},
		};
		const { output, runtime } = createRuntime(entries, runtimeHost);

		expect(
			await executeAcpBuiltinSlashCommand(
				`/workflow start ${path.join(dir, "stale-active-terminal.omhflow")} --run-id stale-active-terminal --family-id family-stale-active-terminal --background`,
				runtime,
			),
		).toEqual({ consumed: true });
		await buildStarted.promise;
		appendWorkflowAttemptActivationCompleted(runtime.sessionManager, {
			attemptId: "stale-active-terminal:attempt-1",
			activationId: "activation-1",
			output: { summary: "manually settled by persisted lifecycle" },
		});
		completeWorkflowAttempt(runtime.sessionManager, {
			attemptId: "stale-active-terminal:attempt-1",
			summary: "persisted terminal while active map is stale",
		});

		expect(
			await executeAcpBuiltinSlashCommand("/workflow manager --family-id family-stale-active-terminal", runtime),
		).toEqual({ consumed: true });

		const managerOutput = output.at(-1) ?? "";
		expect(managerOutput).toContain("Run: attempt-1 completed");
		expect(managerOutput).not.toContain("Agent Hub");
		expect(managerOutput).not.toContain("watch/intervene buildRound");
		expect(managerOutput).not.toContain("/workflow interrupt stale-active-terminal:attempt-1");

		releaseBuild.resolve();
		await Bun.sleep(10);
	});

	it("feeds live subagent progress into the runtime workflow graph view", async () => {
		const dir = await createTempDir();
		await fs.mkdir(path.join(dir, "progress-graph"), { recursive: true });
		await Bun.write(
			path.join(dir, "progress-graph.omhflow"),
			`---
name: progress-graph
version: 1
schema: omhflow/v1
checkpoint:
  stopDeadlineMs: 50
changePolicy:
  agentsCanPropose: true
  humansCanApprove: true
---
# Progress Graph

\`\`\`yaml workflow
models:
  roles:
    builder: rust-cat/gpt-5.5
  defaults:
    agent: builder
nodes:
  buildRound:
    type: agent
    agent: task
    prompt: Build the current round.
edges: []
\`\`\`
`,
		);
		const entries: CapturedEntry[] = [];
		const buildStarted = Promise.withResolvers<void>();
		const releaseBuild = Promise.withResolvers<void>();
		const runtimeHost: WorkflowNodeRuntimeHost = {
			runAgentNode: async () => {
				buildStarted.resolve();
				await releaseBuild.promise;
				return { summary: "built" };
			},
		};
		const { runtime } = createRuntime(entries, runtimeHost, {
			availableModels: [rustCatModel],
			activeModel: rustCatModel,
			workflowAgentProgressById: new Map([
				[
					"buildRound",
					{
						model: "rust-cat/gpt-5.5",
						currentTool: "bash",
						currentToolArgs: "bun test",
						lastIntent: "running the recursive workflow harness",
						durationMs: 125_000,
						toolCount: 6,
					},
				],
			]),
		});

		expect(
			await executeAcpBuiltinSlashCommand(
				`/workflow start ${path.join(dir, "progress-graph.omhflow")} --run-id progress-graph --family-id family-progress --background`,
				runtime,
			),
		).toEqual({ consumed: true });
		await buildStarted.promise;

		const family = expectDefined(
			reconstructWorkflowFamilies(runtime.sessionManager.getBranch()).find(
				candidate => candidate.id === "family-progress",
			),
		);
		const view = buildWorkflowGraphViewForRuntime(family, runtime);

		expect(view.activeAgents?.[0]).toMatchObject({
			focusAgentId: "buildRound",
			model: "rust-cat/gpt-5.5",
			tool: "bash bun test",
			activity: "running the recursive workflow harness",
			stats: "2m05s · 6 tools",
		});

		releaseBuild.resolve();
		await Bun.sleep(10);
	});

	it("interrupts a selected live workflow agent without aborting sibling agents", async () => {
		const dir = await createTempDir();
		await fs.mkdir(path.join(dir, "selected-interrupt"), { recursive: true });
		await Bun.write(
			path.join(dir, "selected-interrupt.omhflow"),
			`---
name: selected-interrupt
version: 1
schema: omhflow/v1
checkpoint:
  stopDeadlineMs: 50
changePolicy:
  agentsCanPropose: true
  humansCanApprove: true
---
# Selected Interrupt

\`\`\`yaml workflow
nodes:
  buildA:
    type: agent
    agent: task
    prompt: Build path A.
  buildB:
    type: agent
    agent: task
    prompt: Build path B.
edges: []
\`\`\`
`,
		);
		const entries: CapturedEntry[] = [];
		const started = new Map<string, VoidDeferred>();
		const aborted = new Map<string, VoidDeferred>();
		const releaseBuildB = Promise.withResolvers<void>();
		const signals = new Map<string, AbortSignal>();
		const calls: string[] = [];
		for (const nodeId of ["buildA", "buildB"]) {
			started.set(nodeId, Promise.withResolvers<void>());
			aborted.set(nodeId, Promise.withResolvers<void>());
		}
		const runner: WorkflowAgentTaskRunner = async request => {
			calls.push(request.nodeId);
			if (request.signal) {
				signals.set(request.nodeId, request.signal);
				request.signal.addEventListener("abort", () => aborted.get(request.nodeId)?.resolve(), { once: true });
			}
			started.get(request.nodeId)?.resolve();
			if (request.nodeId === "buildA") {
				await aborted.get("buildA")?.promise;
				return {
					exitCode: 1,
					output: "",
					error: request.signal?.reason ?? "workflow agent interrupted",
				};
			}
			await releaseBuildB.promise;
			return { exitCode: 0, output: JSON.stringify({ summary: "built B" }) };
		};
		const { output, runtime } = createTuiRuntime(entries, dir, runner);

		expect(
			await executeBuiltinSlashCommand(
				`/workflow start ${path.join(dir, "selected-interrupt.omhflow")} --run-id selected-interrupt --family-id family-selected-interrupt --background`,
				runtime,
			),
		).toBe(true);
		await Promise.all([started.get("buildA")?.promise, started.get("buildB")?.promise]);

		expect(await executeBuiltinSlashCommand("/workflow manager --family-id family-selected-interrupt", runtime)).toBe(
			true,
		);
		const managerOutput = output.at(-1) ?? "";
		expect(managerOutput).toContain(
			"- Interrupt Builder · Build a · /workflow interrupt selected-interrupt:attempt-1 buildA --deadline-ms 30000",
		);
		expect(managerOutput).toContain(
			"- Interrupt Builder · Build b · /workflow interrupt selected-interrupt:attempt-1 buildB --deadline-ms 30000",
		);

		const interrupt = executeBuiltinSlashCommand(
			"/workflow interrupt selected-interrupt:attempt-1 buildA --deadline-ms 1",
			runtime,
		);
		await aborted.get("buildA")?.promise;
		expect(signals.get("buildA")?.aborted).toBe(true);
		expect(signals.get("buildB")?.aborted).toBe(false);
		releaseBuildB.resolve();

		expect(await interrupt).toBe(true);
		expect(calls.sort()).toEqual(["buildA", "buildB"]);
		expect(output.some(entry => entry.includes("Workflow interrupted activation: activation-1 (buildA)"))).toBeTrue();
		expect(
			output.some(entry => entry.includes("Workflow checkpoint: selected-interrupt:attempt-1:checkpoint-1")),
		).toBeTrue();
		const family = reconstructWorkflowFamilies(entries)[0];
		expect(family?.attempts[0]?.activations.map(activation => [activation.nodeId, activation.status])).toEqual([
			["buildA", "aborted"],
			["buildB", "completed"],
		]);
		expect(family?.checkpoints[0]).toMatchObject({
			completedActivationIds: ["activation-2"],
			abortedActivationIds: ["activation-1"],
			frontierNodeIds: ["buildA"],
		});
	});

	it("accepts cockpit-displayed workflow agent ids when interrupting loop rounds", async () => {
		const dir = await createTempDir();
		await fs.mkdir(path.join(dir, "sanitized-loop-interrupt"), { recursive: true });
		await Bun.write(
			path.join(dir, "sanitized-loop-interrupt.omhflow"),
			`---
name: sanitized-loop-interrupt
version: 1
schema: omhflow/v1
checkpoint:
  stopDeadlineMs: 50
changePolicy:
  agentsCanPropose: true
  humansCanApprove: true
---
# Sanitized Loop Interrupt

\`\`\`yaml workflow
nodes:
  build-path:
    type: agent
    agent: task
    prompt: Build the current loop round.
  reviewGate:
    type: review
    agent: task
    prompt: Decide whether another build round is needed.
    gates:
      - CONTINUE
      - COMPLETE
edges:
  - from: build-path
    to: reviewGate
  - from: reviewGate
    to: build-path
    when: outputs.reviewGate.verdict == "CONTINUE"
\`\`\`
`,
		);
		const entries: CapturedEntry[] = [];
		const firstBuildStarted = Promise.withResolvers<void>();
		const secondBuildStarted = Promise.withResolvers<void>();
		const secondBuildAborted = Promise.withResolvers<void>();
		let buildCalls = 0;
		let secondBuildSignal: AbortSignal | undefined;
		const runner: WorkflowAgentTaskRunner = async request => {
			if (request.nodeId === "build-path") {
				buildCalls += 1;
				if (buildCalls === 1) {
					firstBuildStarted.resolve();
					return { exitCode: 0, output: JSON.stringify({ summary: "round 1 built" }) };
				}
				secondBuildSignal = request.signal;
				request.signal?.addEventListener("abort", () => secondBuildAborted.resolve(), { once: true });
				secondBuildStarted.resolve();
				await secondBuildAborted.promise;
				return {
					exitCode: 1,
					output: "",
					error: request.signal?.reason ?? "workflow agent interrupted",
				};
			}
			return { exitCode: 0, output: JSON.stringify({ summary: "continue", verdict: "CONTINUE" }) };
		};
		const { output, runtime } = createTuiRuntime(entries, dir, runner);

		expect(
			await executeBuiltinSlashCommand(
				`/workflow start ${path.join(dir, "sanitized-loop-interrupt.omhflow")} --run-id sanitized-loop-interrupt --family-id family-sanitized-loop --background`,
				runtime,
			),
		).toBe(true);
		await firstBuildStarted.promise;
		await secondBuildStarted.promise;

		expect(await executeBuiltinSlashCommand("/workflow manager --family-id family-sanitized-loop", runtime)).toBe(
			true,
		);
		const managerOutput = output.at(-1) ?? "";
		expect(managerOutput).toContain("- Builder · Build path live · round 2 · openai/gpt-4o");
		expect(managerOutput).toContain("(watch/intervene build_path-2)");
		expect(managerOutput).toContain(
			"- Interrupt Builder · Build path · /workflow interrupt sanitized-loop-interrupt:attempt-1 build_path-2 --deadline-ms 30000",
		);

		const interrupt = executeBuiltinSlashCommand(
			"/workflow interrupt sanitized-loop-interrupt:attempt-1 build_path-2 --deadline-ms 1",
			runtime,
		);
		await secondBuildAborted.promise;
		expect(secondBuildSignal?.aborted).toBe(true);

		expect(await interrupt).toBe(true);
		expect(
			output.some(entry => entry.includes("Workflow interrupted activation: activation-3 (build-path)")),
		).toBeTrue();
		const family = reconstructWorkflowFamilies(entries)[0];
		expect(family?.attempts[0]?.activations.map(activation => [activation.nodeId, activation.status])).toEqual([
			["build-path", "completed"],
			["reviewGate", "completed"],
			["build-path", "aborted"],
		]);
		expect(family?.checkpoints[0]).toMatchObject({
			completedActivationIds: ["activation-1", "activation-2"],
			abortedActivationIds: ["activation-3"],
			frontierNodeIds: ["build-path"],
		});
	});

	it("does not present persisted running workflow activations as live Agent Hub targets", async () => {
		const entries: CapturedEntry[] = [];
		const freeze = createFreeze("flowfreeze:stale-agents", ["buildRound", "reviewRound"]);
		freeze.definition.nodes = [
			{ id: "buildRound", type: "agent", agent: "task" },
			{ id: "reviewRound", type: "review", agent: "task" },
		];
		const host = createHostFromEntries(entries);
		startWorkflowFamily(host, { familyId: "family-stale-agents", objective: "resume stale workflow" });
		recordWorkflowFreeze(host, freeze, { familyId: "family-stale-agents" });
		startWorkflowAttempt(host, {
			familyId: "family-stale-agents",
			attemptId: "attempt-stale",
			freezeId: freeze.id,
			startNodeId: "buildRound",
			runtimeBindingSnapshot: binding("binding-stale"),
		});
		appendWorkflowAttemptActivationStarted(host, {
			attemptId: "attempt-stale",
			activationId: "activation-stale",
			nodeId: "buildRound",
			parentActivationIds: [],
		});
		const { output, runtime } = createRuntime(entries);

		expect(await executeAcpBuiltinSlashCommand("/workflow manager --family-id family-stale-agents", runtime)).toEqual(
			{
				consumed: true,
			},
		);

		expect(output[0]).toContain("On-flight:");
		expect(output[0]).toContain("- Build round running");
		expect(output[0]).toContain("- Stop attempt · /workflow stop attempt-stale --deadline-ms 30000");
		expect(output[0]).not.toContain("Agent Hub watches live transcripts");
		expect(output[0]).not.toContain("watch/intervene live agent");
		expect(output[0]).not.toContain("agent hub: double-left");
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
		recordWorkflowChangeRequestApplied(host, {
			changeRequestId: "change-strong-review",
			actor: "human:sihao",
			target: "freeze",
			freezeId: freezeB.id,
		});
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
		expect(output[0]).toContain("Overview:");
		expect(output[0]).toContain("- Run: attempt-strong failed from checkpoint-weak");
		expect(output[0]).toContain("- Flow changes: 1 approved");
		expect(output[0]).toContain("- Frontier: runValidation to runValidation");
		expect(output[0]).toContain("Diagram:");
		expect(output[0]).toContain("│◆ planner");
		expect(output[0]).toContain("checkpointed - planned validation with");
		expect(output[0]).not.toContain("planned validation\nwith extra detail");
		expect(output[0]).toContain("│✓ runValidation");
		expect(output[0]).toContain("║! strongReview");
		expect(nodeCenterHasIncomingConnector(output[0], "strongReview")).toBe(true);
		expect(output[0]).toContain("failed - error: review prompt missing");
		expect(output[0]).toContain("Recent activity:");
		expect(output[0]).toContain("- stderr · Strong review: review prompt missing");
		expect(output[0]).toContain(
			"- changes · change-strong-review approved · applied: replace weak review with strong review",
		);
		expect(output[0]).toContain("Change review:");
		expect(output[0]).toContain(
			"- change-strong-review approved by human:sihao · applied - replace weak review with strong review",
		);
		expect(output[0]).not.toContain("Latest freeze:");
		expect(output[0]).not.toContain("Runtime binding:");
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

function workflowDraftFidelityArtifactSource(): string {
	return `---
name: draft-fidelity-demo
version: 1
schema: omhflow/v1
checkpoint:
  stopDeadlineMs: 50
changePolicy:
  agentsCanPropose: true
  humansCanApprove: true
---
# Draft Fidelity Demo

\`\`\`yaml workflow
nodes:
  build:
    type: script
    script:
      inline: |
        return { summary: "built" };
  review:
    type: review
    prompt: Review the build.
    gates:
      - continue
      - complete
    fallbackVerdict: continue
    workspaceAccess: read
edges:
  - from: build
    to: review
subflows:
  - alias: review-loop
    name: review-loop
    version: 1
    namespace: reviewLoop__
    nodeIds:
      - build
      - review
    entryNodeIds:
      - build
    exitNodeIds:
      - review
    resourcePrefix: review-loop
\`\`\`
`;
}

function workflowDraftFidelityChangeSource(): string {
	return JSON.stringify({
		id: "change-draft-fidelity",
		actor: "agent:reviewer",
		origin: "internal-agent",
		reason: "insert verification while preserving existing review contracts",
		operations: [{ op: "add_node", node: { id: "verify", type: "script" } }],
	});
}

function workflowBlockFromDraft(source: string): string {
	const match = /```yaml workflow\n(?<body>[\s\S]*?)\n```/u.exec(source);
	if (!match?.groups?.body) throw new Error("expected workflow code block");
	return `name: parsed-draft\nversion: 1\n${match.groups.body}`;
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
