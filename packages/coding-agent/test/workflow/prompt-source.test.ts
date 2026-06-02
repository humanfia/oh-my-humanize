import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseWorkflowDefinition } from "../../src/workflow/definition";
import type { WorkflowNodeRuntimeHost } from "../../src/workflow/node-runtime";
import { reconstructWorkflowRuns, type WorkflowRunStoreHost } from "../../src/workflow/run-store";
import { runWorkflow } from "../../src/workflow/runner";

interface CapturedEntry {
	type: "custom";
	customType: string;
	data?: unknown;
}

const tempDirs: string[] = [];

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

async function createTempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-workflow-prompt-source-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("workflow prompt source resolution", () => {
	it("uses a prior agent activation output as the downstream agent prompt", async () => {
		const definition = parseWorkflowDefinition(
			`
name: agent-produced-prompt-demo
version: 1
nodes:
  planner:
    type: agent
    agent: planner
  build:
    type: agent
    agent: task
    prompt:
      output:
        node: planner
        path: /data/nextPrompt
        activation: latest-completed
edges:
  - from: planner
    to: build
`,
			{ sourcePath: "workflow.yml" },
		);
		const host = createHost();
		const receivedPrompts: string[] = [];
		const runtimeHost: WorkflowNodeRuntimeHost = {
			runAgentNode: async input => {
				if (input.node.id === "planner") {
					return {
						summary: "planned",
						data: { nextPrompt: "Build a playable terminal puzzle game." },
					};
				}
				receivedPrompts.push(input.prompt ?? "");
				return { summary: "built" };
			},
		};

		await runWorkflow({
			host,
			definition,
			runId: "run-1",
			startNodeId: "planner",
			runtimeHost,
		});

		expect(receivedPrompts).toEqual(["Build a playable terminal puzzle game."]);
		const reconstructed = reconstructWorkflowRuns(host.getBranch());
		expect(reconstructed[0]?.activations[1]?.input).toEqual({
			prompt: {
				value: "Build a playable terminal puzzle game.",
				byteLength: 38,
				contentHash: "sha256:7e5f5407597e0e2d187c5ed742e0033554dcb2a61825417c9b9c674457ac10d8",
				source: {
					kind: "output",
					node: "planner",
					path: "/data/nextPrompt",
					activation: "latest-completed",
					activationId: "activation-1",
				},
			},
		});
	});

	it("fails before running a downstream node when an output prompt is not a string", async () => {
		const definition = parseWorkflowDefinition(
			`
name: invalid-agent-produced-prompt-demo
version: 1
nodes:
  planner:
    type: agent
    agent: planner
  build:
    type: agent
    agent: task
    prompt:
      output:
        node: planner
        path: /data/nextPrompt
        activation: latest-completed
edges:
  - from: planner
    to: build
`,
			{ sourcePath: "workflow.yml" },
		);
		const host = createHost();
		let buildRan = false;
		const runtimeHost: WorkflowNodeRuntimeHost = {
			runAgentNode: async input => {
				if (input.node.id === "planner") {
					return {
						summary: "planned",
						data: { nextPrompt: 42 },
					};
				}
				buildRan = true;
				return { summary: "built" };
			},
		};

		const result = await runWorkflow({
			host,
			definition,
			runId: "run-1",
			startNodeId: "planner",
			runtimeHost,
		});

		expect(buildRan).toBe(false);
		expect(result.scheduler.activations.map(activation => [activation.nodeId, activation.status])).toEqual([
			["planner", "completed"],
			["build", "failed"],
		]);
		expect(result.scheduler.activations[1]?.error).toBe(
			'workflow prompt source for node "build" at "/data/nextPrompt" must resolve to a string',
		);
	});

	it("resolves package-local prompt files before agent execution", async () => {
		const dir = await createTempDir();
		await Bun.write(path.join(dir, "prompts", "build.md"), "Implement the package workflow.\n");
		const definition = parseWorkflowDefinition(
			`
name: file-prompt-demo
version: 1
nodes:
  build:
    type: agent
    agent: task
    prompt: ./prompts/build.md
edges: []
`,
			{ sourcePath: path.join(dir, "workflow.yml") },
		);
		const host = createHost();
		let receivedPrompt: string | undefined;
		const runtimeHost: WorkflowNodeRuntimeHost = {
			runAgentNode: async input => {
				receivedPrompt = input.prompt;
				return { summary: "built" };
			},
		};

		await runWorkflow({
			host,
			definition,
			runId: "run-1",
			startNodeId: "build",
			runtimeHost,
			packageRoot: dir,
		});

		expect(receivedPrompt).toBe("Implement the package workflow.\n");
	});
});
