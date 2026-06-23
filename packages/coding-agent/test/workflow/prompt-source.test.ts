import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseWorkflowDefinition } from "../../src/workflow/definition";
import type { WorkflowNodeRuntimeHost } from "../../src/workflow/node-runtime";
import { resolveWorkflowPrompt } from "../../src/workflow/prompt-source";
import { reconstructWorkflowRuns, type WorkflowRunStoreHost } from "../../src/workflow/run-store";
import { runWorkflow } from "../../src/workflow/runner";
import type { WorkflowActivation } from "../../src/workflow/scheduler";

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
	it("resolves state and human prompt sources through declared read scopes", async () => {
		const definition = parseWorkflowDefinition(
			`
name: state-and-human-prompt-demo
version: 1
nodes:
  seed:
    type: script
    writes:
      - /assignments
      - /human
  build:
    type: agent
    agent: task
    reads:
      - /assignments
    prompt:
      state: /assignments/build
  approval-question:
    type: human
    reads:
      - /human
    prompt:
      human: /human/question
edges:
  - from: seed
    to: build
  - from: build
    to: approval-question
`,
			{ sourcePath: "workflow.yml" },
		);
		const host = createHost();
		const receivedAgentPrompts: string[] = [];
		const receivedHumanPrompts: string[] = [];
		const runtimeHost: WorkflowNodeRuntimeHost = {
			runScriptNode: async () => ({
				summary: "seeded",
				statePatch: [
					{ op: "set", path: "/assignments/build", value: "Build from structured workflow state." },
					{ op: "set", path: "/human/question", value: "Approve the generated workflow assignment?" },
				],
			}),
			runAgentNode: async input => {
				receivedAgentPrompts.push(input.prompt ?? "");
				return { summary: "built" };
			},
			runHumanNode: async input => {
				receivedHumanPrompts.push(input.prompt ?? "");
				return { summary: "approved" };
			},
		};

		await runWorkflow({
			host,
			definition,
			runId: "run-1",
			startNodeId: "seed",
			runtimeHost,
		});

		expect(receivedAgentPrompts).toEqual(["Build from structured workflow state."]);
		expect(receivedHumanPrompts).toEqual(["Approve the generated workflow assignment?"]);
		const reconstructed = reconstructWorkflowRuns(host.getBranch());
		const promptSources = reconstructed[0]?.activations
			.map(activation => activation.input?.prompt?.source)
			.filter(source => source !== undefined);
		expect(promptSources).toEqual([
			{ kind: "state", path: "/assignments/build" },
			{ kind: "human", path: "/human/question" },
		]);
	});

	it("resolves activation prompt bindings from the mapped activation context", async () => {
		const definition = parseWorkflowDefinition(
			`
name: activation-binding-demo
version: 1
nodes:
  worker:
    type: agent
    agent: task
    reads:
      - /plan
    prompt:
      template:
        file: prompts/item.md
        bindings:
          item:
            activation: /mapped/item
          itemKey:
            activation: /mapped/itemKey
edges: []
`,
			{ sourcePath: "workflow.yml" },
		);
		const node = definition.nodes[0]!;
		const dir = await createTempDir();
		await fs.mkdir(path.join(dir, "prompts"), { recursive: true });
		await Bun.write(path.join(dir, "prompts", "item.md"), "Item {{item}} key {{itemKey}}");
		const resolved = await resolveWorkflowPrompt(node, {
			state: { plan: "plan" },
			completedActivations: [],
			parentActivationIds: [],
			activation: {
				id: "activation-1",
				nodeId: "worker",
				graphRevisionId: "graph-1",
				status: "running",
				parentActivationIds: [],
				mapped: {
					poolId: "pool",
					poolActivationId: "activation-0",
					itemKey: "item-2",
					item: { id: "item-2", value: "second" },
					phase: "worker",
				},
			},
			packageRoot: dir,
		});
		expect(resolved?.value).toBe(`Item {\n  "id": "item-2",\n  "value": "second"\n} key item-2`);
	});

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

	it("uses script and human activation outputs as downstream agent prompts", async () => {
		const definition = parseWorkflowDefinition(
			`
name: non-agent-produced-prompt-demo
version: 1
nodes:
  plan-script:
    type: script
  build-from-script:
    type: agent
    agent: task
    prompt:
      output:
        node: plan-script
        path: /data/nextPrompt
        activation: parent
  human-choice:
    type: human
    prompt: Choose the follow-up assignment.
  build-from-human:
    type: agent
    agent: task
    prompt:
      output:
        node: human-choice
        path: /data/nextPrompt
        activation: parent
edges:
  - from: plan-script
    to: build-from-script
  - from: build-from-script
    to: human-choice
  - from: human-choice
    to: build-from-human
`,
			{ sourcePath: "workflow.yml" },
		);
		const host = createHost();
		const receivedPrompts: string[] = [];
		const runtimeHost: WorkflowNodeRuntimeHost = {
			runScriptNode: async () => ({
				summary: "script planned",
				data: { nextPrompt: "Build the script-produced assignment." },
			}),
			runAgentNode: async input => {
				receivedPrompts.push(input.prompt ?? "");
				return { summary: `ran ${input.node.id}` };
			},
			runHumanNode: async () => ({
				summary: "human supplied follow-up",
				data: { nextPrompt: "Build the human-produced assignment." },
			}),
		};

		await runWorkflow({
			host,
			definition,
			runId: "run-1",
			startNodeId: "plan-script",
			runtimeHost,
		});

		expect(receivedPrompts).toEqual([
			"Build the script-produced assignment.",
			"Build the human-produced assignment.",
		]);
		const reconstructed = reconstructWorkflowRuns(host.getBranch());
		const promptSources = reconstructed[0]?.activations
			.map(activation => activation.input?.prompt?.source)
			.filter(source => source !== undefined);
		expect(promptSources).toEqual([
			{
				kind: "output",
				node: "plan-script",
				path: "/data/nextPrompt",
				activation: "parent",
				activationId: "activation-1",
			},
			{
				kind: "inline",
				text: "Choose the follow-up assignment.",
			},
			{
				kind: "output",
				node: "human-choice",
				path: "/data/nextPrompt",
				activation: "parent",
				activationId: "activation-3",
			},
		]);
	});

	it("uses review output prompts deterministically across looped parent and latest selectors", async () => {
		const definition = parseWorkflowDefinition(
			`
name: looped-review-produced-prompt-demo
version: 1
nodes:
  review:
    type: review
    prompt: Review the current build.
    gates:
      - continue
      - finish
    writes:
      - /verdict
  build-from-parent:
    type: agent
    agent: task
    prompt:
      output:
        node: review
        path: /summary
        activation: parent
  build-from-latest:
    type: agent
    agent: task
    prompt:
      output:
        node: review
        path: /summary
        activation: latest-completed
edges:
  - from: review
    to: build-from-parent
    when: outputs.review.verdict == "continue"
  - from: build-from-parent
    to: review
  - from: review
    to: build-from-latest
    when: outputs.review.verdict == "finish"
`,
			{ sourcePath: "workflow.yml" },
		);
		const host = createHost();
		const receivedPrompts: string[] = [];
		let reviewCount = 0;
		const runtimeHost: WorkflowNodeRuntimeHost = {
			runReviewNode: async () => {
				reviewCount += 1;
				const verdict = reviewCount === 1 ? "continue" : "finish";
				return {
					verdict,
					summary: `review prompt ${reviewCount}`,
				};
			},
			runAgentNode: async input => {
				receivedPrompts.push(input.prompt ?? "");
				return { summary: `ran ${input.node.id}` };
			},
		};

		await runWorkflow({
			host,
			definition,
			runId: "run-1",
			startNodeId: "review",
			runtimeHost,
		});

		expect(receivedPrompts).toEqual(["review prompt 1", "review prompt 2"]);
		const reconstructed = reconstructWorkflowRuns(host.getBranch());
		const buildPromptSources = reconstructed[0]?.activations
			.filter(activation => activation.nodeId.startsWith("build"))
			.map(activation => activation.input?.prompt?.source);
		expect(buildPromptSources).toEqual([
			{
				kind: "output",
				node: "review",
				path: "/summary",
				activation: "parent",
				activationId: "activation-1",
			},
			{
				kind: "output",
				node: "review",
				path: "/summary",
				activation: "latest-completed",
				activationId: "activation-3",
			},
		]);
	});

	it("fails before consuming an ambiguous parallel parent prompt", async () => {
		const definition = parseWorkflowDefinition(
			`
name: ambiguous-parent-prompt-demo
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
        activation: parent
edges: []
`,
			{ sourcePath: "workflow.yml" },
		);
		const buildNode = definition.nodes.find(node => node.id === "build");
		if (!buildNode) throw new Error("expected build node");
		const completedActivations: WorkflowActivation[] = [
			completedActivation("activation-1", "planner", "first prompt"),
			completedActivation("activation-2", "planner", "second prompt"),
		];

		await expect(
			resolveWorkflowPrompt(buildNode, {
				state: {},
				completedActivations,
				parentActivationIds: ["activation-1", "activation-2"],
			}),
		).rejects.toThrow('workflow prompt source for node "build" has multiple parent activations for node "planner"');
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

	it("fails before running a downstream node when an output prompt exceeds read scopes", async () => {
		const definition = parseWorkflowDefinition(
			`
name: scoped-agent-produced-prompt-demo
version: 1
nodes:
  planner:
    type: agent
    agent: planner
  build:
    type: agent
    agent: task
    reads:
      - /summary
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
						data: { nextPrompt: "Build the scoped prompt." },
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
		expect(result.scheduler.activations[1]?.error).toBe('workflow state read from "/data/nextPrompt" is not allowed');
	});

	it("renders file-backed prompt templates with explicit state and output bindings", async () => {
		const dir = await createTempDir();
		await Bun.write(path.join(dir, "prompts", "build.md"), "Plan:\n{{plan}}\n\nLatest review:\n{{reviewSummary}}\n");
		const definition = parseWorkflowDefinition(
			`
name: template-prompt-demo
version: 1
nodes:
  review:
    type: review
    prompt: Review the current plan.
  build:
    type: agent
    agent: task
    reads:
      - /plan
      - /summary
    prompt:
      template:
        file: prompts/build.md
        bindings:
          plan:
            state: /plan
          reviewSummary:
            output:
              node: review
              path: /summary
              activation: latest-completed
edges:
  - from: review
    to: build
`,
			{ sourcePath: path.join(dir, "workflow.yml") },
		);
		const buildNode = definition.nodes.find(node => node.id === "build");
		if (!buildNode) throw new Error("expected build node");

		const resolved = await resolveWorkflowPrompt(buildNode, {
			state: { plan: "Implement the resumable workflow loop." },
			completedActivations: [
				{
					id: "activation-1",
					nodeId: "review",
					graphRevisionId: "workflow-graph",
					status: "completed",
					parentActivationIds: [],
					output: { summary: "Tighten the checkpoint restart criteria." },
				},
			],
			parentActivationIds: ["activation-1"],
			packageRoot: dir,
		});

		expect(resolved?.value).toBe(
			"Plan:\nImplement the resumable workflow loop.\n\nLatest review:\nTighten the checkpoint restart criteria.",
		);
		expect(resolved?.source).toEqual({
			kind: "template",
			file: "prompts/build.md",
			bindings: {
				plan: { kind: "state", path: "/plan" },
				reviewSummary: {
					kind: "output",
					node: "review",
					path: "/summary",
					activation: "latest-completed",
					activationId: "activation-1",
				},
			},
		});
	});

	it("renders structured prompt template bindings as readable JSON text", async () => {
		const dir = await createTempDir();
		await Bun.write(path.join(dir, "prompts", "promotion.md"), "Evidence:\n{{evidence}}\n");
		const definition = parseWorkflowDefinition(
			`
name: structured-template-prompt-demo
version: 1
nodes:
  decide:
    type: review
    reads:
      - /evidence
    prompt:
      template:
        file: prompts/promotion.md
        bindings:
          evidence:
            state: /evidence
edges: []
`,
			{ sourcePath: path.join(dir, "workflow.yml") },
		);
		const decideNode = definition.nodes.find(node => node.id === "decide");
		if (!decideNode) throw new Error("expected decide node");

		const resolved = await resolveWorkflowPrompt(decideNode, {
			state: {
				evidence: {
					verdict: "promote",
					checks: ["unit", "integration"],
					metrics: { passed: 219 },
					ready: true,
				},
			},
			completedActivations: [],
			parentActivationIds: [],
			packageRoot: dir,
		});

		expect(resolved?.value).toBe(
			'Evidence:\n{\n  "verdict": "promote",\n  "checks": [\n    "unit",\n    "integration"\n  ],\n  "metrics": {\n    "passed": 219\n  },\n  "ready": true\n}',
		);
		expect(resolved?.value).not.toContain("[object Object]");
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

	it("resolves .omhflow resource prompt files relative to the supplied resource root", async () => {
		const dir = await createTempDir();
		await Bun.write(path.join(dir, "prompts", "build.md"), "Implement the portable workflow.\n");
		const definition = parseWorkflowDefinition(
			`
name: resource-prompt-demo
version: 1
nodes:
  build:
    type: agent
    agent: task
    prompt:
      file: prompts/build.md
edges: []
`,
			{ sourcePath: path.join(dir, "release.omhflow") },
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

		expect(receivedPrompt).toBe("Implement the portable workflow.\n");
	});
});

function completedActivation(id: string, nodeId: string, nextPrompt: string): WorkflowActivation {
	return {
		id,
		nodeId,
		graphRevisionId: "workflow-graph",
		status: "completed",
		parentActivationIds: [],
		output: {
			summary: `completed ${nodeId}`,
			data: { nextPrompt },
		},
	};
}
