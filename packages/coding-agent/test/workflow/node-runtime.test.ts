import { describe, expect, it } from "bun:test";
import { parseWorkflowDefinition } from "../../src/workflow/definition";
import { executeWorkflowNode, type WorkflowNodeRuntimeHost } from "../../src/workflow/node-runtime";
import type { WorkflowActivation } from "../../src/workflow/scheduler";

const agentWorkflow = `
name: node-runtime-demo
version: 1
nodes:
  build:
    type: agent
    agent: task
    prompt: ./prompts/build.md
    model:
      role: builder
edges: []
`;

const scriptHumanWorkflow = `
name: script-human-demo
version: 1
nodes:
  summarize:
    type: script
    prompt: ./scripts/summarize.ts
    model:
      role: helper
  approve:
    type: human
    prompt: ./prompts/approve.md
edges: []
`;

const reviewWorkflow = `
name: review-demo
version: 1
nodes:
  review:
    type: review
    agent: reviewer
    prompt: ./prompts/review.md
    model:
      role: reviewer
      unavailable: fail
    gates:
      - continue
      - finish
edges: []
`;

function activation(nodeId: string): WorkflowActivation {
	return {
		id: `activation-${nodeId}`,
		nodeId,
		graphRevisionId: "test-graph",
		status: "running",
		parentActivationIds: [],
	};
}

describe("workflow node runtime adapters", () => {
	it("dispatches agent nodes with agent name, prompt, and model context", async () => {
		const definition = parseWorkflowDefinition(agentWorkflow, { sourcePath: "workflow.yml" });
		const node = definition.nodes[0]!;
		const calls: unknown[] = [];
		const host: WorkflowNodeRuntimeHost = {
			runAgentNode: async input => {
				calls.push(input);
				return { summary: "agent finished" };
			},
		};

		const output = await executeWorkflowNode(node, activation(node.id), host);

		expect(output.summary).toBe("agent finished");
		expect(calls).toEqual([
			{
				node,
				activation: activation("build"),
				agent: "task",
				prompt: "./prompts/build.md",
				model: { role: "builder" },
			},
		]);
	});

	it("dispatches script and human nodes to their dedicated host adapters", async () => {
		const definition = parseWorkflowDefinition(scriptHumanWorkflow, { sourcePath: "workflow.yml" });
		const calls: unknown[] = [];
		const host: WorkflowNodeRuntimeHost = {
			runScriptNode: async input => {
				calls.push({ kind: "script", input });
				return { summary: "script finished" };
			},
			runHumanNode: async input => {
				calls.push({ kind: "human", input });
				return { summary: "human answered" };
			},
		};

		await executeWorkflowNode(definition.nodes[0]!, activation("summarize"), host);
		await executeWorkflowNode(definition.nodes[1]!, activation("approve"), host);

		expect(calls).toEqual([
			{
				kind: "script",
				input: {
					node: definition.nodes[0],
					activation: activation("summarize"),
					script: "./scripts/summarize.ts",
					model: { role: "helper" },
				},
			},
			{
				kind: "human",
				input: {
					node: definition.nodes[1],
					activation: activation("approve"),
					prompt: "./prompts/approve.md",
				},
			},
		]);
	});

	it("passes abort signals to runtime host adapters when provided", async () => {
		const definition = parseWorkflowDefinition(scriptHumanWorkflow, { sourcePath: "workflow.yml" });
		const node = definition.nodes[0]!;
		const controller = new AbortController();
		let signal: AbortSignal | undefined;
		const host: WorkflowNodeRuntimeHost = {
			runScriptNode: async input => {
				signal = input.signal;
				return { summary: "script finished" };
			},
		};

		await executeWorkflowNode(node, activation("summarize"), host, { signal: controller.signal });

		expect(signal).toBe(controller.signal);
	});

	it("dispatches review nodes and maps valid verdicts into state patches", async () => {
		const definition = parseWorkflowDefinition(reviewWorkflow, { sourcePath: "workflow.yml" });
		const node = definition.nodes[0]!;
		const host: WorkflowNodeRuntimeHost = {
			runReviewNode: async input => ({
				summary: `reviewed with ${input.agent}`,
				verdict: "continue",
			}),
		};

		const output = await executeWorkflowNode(node, activation("review"), host);

		expect(output).toEqual({
			summary: "reviewed with reviewer",
			data: { verdict: "continue" },
			statePatch: [{ op: "set", path: "/verdict", value: "continue" }],
		});
	});

	it("writes review verdicts to the declared workflow state path", async () => {
		const definition = parseWorkflowDefinition(
			`
name: review-custom-verdict-path
version: 1
nodes:
  qualityGate:
    type: review
    agent: reviewer
    writes:
      - /qualityVerdict
    gates:
      - ISSUES
      - CLEAN
edges: []
`,
			{ sourcePath: "workflow.yml" },
		);
		const node = definition.nodes[0]!;
		const host: WorkflowNodeRuntimeHost = {
			runReviewNode: async () => ({
				summary: "quality gate passed",
				verdict: "CLEAN",
			}),
		};

		const output = await executeWorkflowNode(node, activation(node.id), host);

		expect(output).toEqual({
			summary: "quality gate passed",
			data: { verdict: "CLEAN" },
			statePatch: [{ op: "set", path: "/qualityVerdict", value: "CLEAN" }],
		});
	});

	it("rejects review verdicts outside the declared gates", async () => {
		const definition = parseWorkflowDefinition(reviewWorkflow, { sourcePath: "workflow.yml" });
		const node = definition.nodes[0]!;
		const host: WorkflowNodeRuntimeHost = {
			runReviewNode: async () => ({
				summary: "reviewed",
				verdict: "retry",
			}),
		};

		await expect(executeWorkflowNode(node, activation("review"), host)).rejects.toThrow(
			'workflow review node "review" returned undeclared verdict "retry"',
		);
	});
});
