import { describe, expect, it } from "bun:test";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { parseWorkflowDefinition } from "../../src/workflow/definition";
import { buildWorkflowInspection } from "../../src/workflow/inspection";
import type { WorkflowNodeRuntimeHost } from "../../src/workflow/node-runtime";
import { reconstructWorkflowRuns, type WorkflowRunStoreHost } from "../../src/workflow/run-store";
import { runWorkflow } from "../../src/workflow/runner";

const openAiModel: Model<Api> = {
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
};

const source = `
name: humanize-like-loop
version: 1
models:
  roles:
    builder: openai/gpt-4o
    reviewer: openai/gpt-4o
  defaults:
    agent: builder
    review: reviewer
nodes:
  planner:
    type: agent
    agent: task
    prompt: Plan the next build assignment.
  build:
    type: agent
    agent: task
    prompt:
      output:
        node: planner
        path: /data/nextPrompt
        activation: latest-completed
    writes:
      - /work
  review:
    type: review
    agent: reviewer
    model:
      role: reviewer
      unavailable: fail
    prompt: Review the build result.
    gates:
      - continue
      - finish
    writes:
      - /verdict
  finish:
    type: script
    prompt: return "workflow complete";
edges:
  - from: planner
    to: build
  - from: build
    to: review
  - from: review
    to: planner
    when: outputs.review.verdict == "continue"
  - from: review
    to: finish
    when: outputs.review.verdict == "finish"
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

describe("workflow end-to-end smoke", () => {
	it("runs a Humanize-like loop and exposes prompt provenance in inspection", async () => {
		const host = createHost();
		const definition = parseWorkflowDefinition(source, { sourcePath: "workflow.yml" });
		let planCount = 0;
		let buildCount = 0;
		let reviewCount = 0;
		const buildPrompts: string[] = [];
		const runtimeHost: WorkflowNodeRuntimeHost = {
			runAgentNode: async input => {
				if (input.node.id === "planner") {
					planCount++;
					return {
						summary: `planned ${planCount}`,
						data: { nextPrompt: `Build round ${planCount}` },
					};
				}
				buildCount++;
				buildPrompts.push(input.prompt ?? "");
				return {
					summary: `built ${buildCount}`,
					data: { round: buildCount },
					statePatch: [{ op: "set", path: "/work/round", value: buildCount }],
				};
			},
			runReviewNode: async () => {
				reviewCount++;
				const verdict = reviewCount === 1 ? "continue" : "finish";
				return {
					summary: `review ${verdict}`,
					verdict,
				};
			},
			runScriptNode: async () => ({
				summary: "workflow complete",
				data: { exitCode: 0 },
			}),
		};

		const result = await runWorkflow({
			host,
			definition,
			runId: "run-e2e",
			startNodeId: "planner",
			runtimeHost,
			modelResolution: { availableModels: [openAiModel] },
			maxActivations: 10,
			maxNodeActivations: 4,
		});

		expect(result.scheduler.activations.map(activation => [activation.nodeId, activation.status])).toEqual([
			["planner", "completed"],
			["build", "completed"],
			["review", "completed"],
			["planner", "completed"],
			["build", "completed"],
			["review", "completed"],
			["finish", "completed"],
		]);
		expect(buildPrompts).toEqual(["Build round 1", "Build round 2"]);

		const reconstructed = reconstructWorkflowRuns(host.getBranch());
		const run = reconstructed[0];
		if (!run) throw new Error("expected reconstructed run");
		const inspection = buildWorkflowInspection(run);

		expect(run.state).toEqual({ work: { round: 2 }, verdict: "finish" });
		expect(inspection.graphRevisions).toEqual([{ id: "run-e2e:graph-0", nodeCount: 4, edgeCount: 4 }]);
		expect(inspection.modelAssignments.map(assignment => [assignment.nodeId, assignment.resolvedModel])).toEqual([
			["planner", "openai/gpt-4o"],
			["build", "openai/gpt-4o"],
			["review", "openai/gpt-4o"],
			["planner", "openai/gpt-4o"],
			["build", "openai/gpt-4o"],
			["review", "openai/gpt-4o"],
		]);
		expect(
			inspection.activations
				.filter(activation => activation.nodeId === "build")
				.map(activation => activation.prompt),
		).toEqual([
			{
				value: "Build round 1",
				byteLength: 13,
				contentHash: "sha256:88d770bb27b60717a4377c68b9c9dacb19260b9e3d4bb4d3ec6912c0dfaeff9c",
				source: {
					kind: "output",
					node: "planner",
					path: "/data/nextPrompt",
					activation: "latest-completed",
					activationId: "activation-1",
				},
			},
			{
				value: "Build round 2",
				byteLength: 13,
				contentHash: "sha256:0cebaf4ba498d8318e0b7b48168f5cb7991e1ff301f5900fe28d59b994bdc73b",
				source: {
					kind: "output",
					node: "planner",
					path: "/data/nextPrompt",
					activation: "latest-completed",
					activationId: "activation-4",
				},
			},
		]);
	});
});
