import { describe, expect, it } from "bun:test";
import { parseWorkflowDefinition } from "../../src/workflow/definition";
import type { WorkflowActivation } from "../../src/workflow/scheduler";
import { createSessionWorkflowRuntimeHost, type WorkflowAgentTaskRequest } from "../../src/workflow/session-runtime";

const scriptWorkflow = `
name: session-runtime-demo
version: 1
nodes:
  shell:
    type: script
    prompt: printf workflow-ok
  build:
    type: agent
    agent: task
    prompt: Implement the workflow feature.
edges: []
`;

function activation(nodeId: string): WorkflowActivation {
	return {
		id: `activation-${nodeId}`,
		nodeId,
		status: "running",
		parentActivationIds: [],
	};
}

describe("session workflow runtime host", () => {
	it("executes script nodes through the shell executor", async () => {
		const definition = parseWorkflowDefinition(scriptWorkflow, { sourcePath: "workflow.yml" });
		const node = definition.nodes.find(candidate => candidate.id === "shell");
		if (!node) throw new Error("expected shell node");
		const host = createSessionWorkflowRuntimeHost({ cwd: process.cwd() });

		const output = await host.runScriptNode?.({
			node,
			activation: activation(node.id),
			script: node.prompt,
			model: node.model,
		});

		expect(output).toEqual({
			summary: "workflow-ok",
			data: { exitCode: 0 },
		});
	});

	it("fails agent nodes until a real subagent adapter is configured", async () => {
		const definition = parseWorkflowDefinition(scriptWorkflow, { sourcePath: "workflow.yml" });
		const node = definition.nodes.find(candidate => candidate.id === "build");
		if (!node) throw new Error("expected build node");
		const host = createSessionWorkflowRuntimeHost({ cwd: process.cwd() });

		await expect(
			host.runAgentNode?.({
				node,
				activation: activation(node.id),
				agent: "task",
				prompt: node.prompt,
				model: node.model,
			}),
		).rejects.toThrow('workflow agent node "build" requires a subagent runtime adapter');
	});

	it("maps agent nodes to a single task runner invocation when configured", async () => {
		const definition = parseWorkflowDefinition(scriptWorkflow, { sourcePath: "workflow.yml" });
		const node = definition.nodes.find(candidate => candidate.id === "build");
		if (!node) throw new Error("expected build node");
		let capturedRequest: WorkflowAgentTaskRequest | undefined;
		const host = createSessionWorkflowRuntimeHost({
			cwd: process.cwd(),
			runAgentTask: async request => {
				capturedRequest = request;
				return {
					exitCode: 0,
					output: "agent completed",
				};
			},
		});

		const output = await host.runAgentNode?.({
			node,
			activation: activation(node.id),
			agent: "task",
			prompt: node.prompt,
			model: node.model,
		});

		expect(capturedRequest).toEqual({
			agent: "task",
			activationId: "activation-build",
			nodeId: "build",
			task: {
				id: "build",
				description: "build",
				assignment: "Implement the workflow feature.",
			},
		});
		expect(output).toEqual({
			summary: "agent completed",
			data: { exitCode: 0 },
		});
	});
});
