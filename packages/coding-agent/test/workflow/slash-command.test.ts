import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../../src/config/settings";
import type { InteractiveModeContext } from "../../src/modes/types";
import type { AgentSession } from "../../src/session/agent-session";
import type { SessionManager } from "../../src/session/session-manager";
import { executeAcpBuiltinSlashCommand } from "../../src/slash-commands/acp-builtins";
import { executeBuiltinSlashCommand } from "../../src/slash-commands/builtin-registry";
import { parseWorkflowDefinition } from "../../src/workflow/definition";
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
			cwd: "/tmp/project",
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
		expect(output).toEqual(["No workflow runs found."]);
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

	it("starts agent workflows through the TUI session task runner", async () => {
		const dir = await createTempDir();
		await Bun.write(
			path.join(dir, "workflow.yml"),
			`
name: slash-agent-demo
version: 1
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
		const runs = reconstructWorkflowRuns(entries);
		expect(runs[0]?.activations[0]?.output).toEqual({
			summary: "agent completed",
			data: { exitCode: 0 },
		});
	});
});
