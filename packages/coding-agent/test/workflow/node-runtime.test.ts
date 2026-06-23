import { describe, expect, it } from "bun:test";
import { parseWorkflowDefinition } from "../../src/workflow/definition";
import { executeWorkflowNode, type WorkflowNodeRuntimeHost } from "../../src/workflow/node-runtime";
import type { WorkflowActivation, WorkflowMappedActivationContext } from "../../src/workflow/scheduler";
import { escapeJsonPointerSegment, unescapeJsonPointerSegment } from "../../src/workflow/state-schema";

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

function activation(nodeId: string, mapped?: WorkflowMappedActivationContext): WorkflowActivation {
	return {
		id: `activation-${nodeId}`,
		nodeId,
		graphRevisionId: "test-graph",
		status: "running",
		parentActivationIds: [],
		mapped,
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
	it("escapes JSON Pointer segments in mapped review verdict paths", async () => {
		const definition = parseWorkflowDefinition(
			`
name: review-mapped-pointer-demo
version: 1
nodes:
  qualityGate:
    type: review
    agent: reviewer
    prompt: ./prompts/review.md
    writes:
      - /quality/results
    gates:
      - clean
edges: []
`,
			{ sourcePath: "workflow.yml" },
		);
		const node = definition.nodes[0]!;
		const mapped: WorkflowMappedActivationContext = {
			poolId: "pool",
			poolActivationId: "activation-pool",
			itemKey: "a/b~c/d~e",
			phase: "worker",
			item: { id: "a/b~c/d~e" },
		};
		const host: WorkflowNodeRuntimeHost = {
			runReviewNode: async () => ({
				summary: "quality gate passed",
				verdict: "clean",
			}),
		};

		const result = await executeWorkflowNode(node, activation("qualityGate", mapped), host);

		expect(result.statePatch).toEqual([
			{ op: "set", path: "/quality/results/a~1b~0c~1d~0e/verdict", value: "clean" },
		]);
	});

	it("deep-clones activation.mapped so script mutations cannot corrupt scheduler state", async () => {
		const definition = parseWorkflowDefinition(
			`
name: script-mapped-demo
version: 1
nodes:
  reducer:
    type: script
    script:
      file: ./scripts/reducer.js
      language: js
edges: []
`,
			{ sourcePath: "workflow.yml" },
		);
		const node = definition.nodes[0]!;
		const originalItem = { nested: { x: 1 } };
		const mapped: WorkflowMappedActivationContext = {
			poolId: "pool",
			poolActivationId: "activation-pool",
			itemKey: "item-1",
			phase: "reducer",
			item: originalItem,
		};
		const originalActivation = activation("reducer", mapped);
		const host: WorkflowNodeRuntimeHost = {
			runScriptNode: async input => {
				if (input.context?.activation.mapped?.item) {
					(input.context.activation.mapped.item as { nested: { x: number } }).nested.x = 2;
				}
				return { summary: "reducer done" };
			},
		};

		await executeWorkflowNode(node, originalActivation, host, {
			context: { state: { value: 1 }, completedActivations: [] },
		});

		expect(originalItem.nested.x).toBe(1);
		expect(originalActivation.mapped?.item).toBe(originalItem);
		expect((originalActivation.mapped?.item as { nested: { x: number } }).nested.x).toBe(1);
	});
	it("round-trips JSON Pointer segment escaping for ~ and /", () => {
		expect(escapeJsonPointerSegment("a/b~c")).toBe("a~1b~0c");
		expect(unescapeJsonPointerSegment("a~1b~0c")).toBe("a/b~c");
		expect(unescapeJsonPointerSegment(escapeJsonPointerSegment("~/~"))).toBe("~/~");
	});
});
