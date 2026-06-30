import { describe, expect, it } from "bun:test";
import { parseWorkflowDefinition } from "../../src/workflow/definition";
import { executeWorkflowNode } from "../../src/workflow/node-runtime";
import type { WorkflowActivation } from "../../src/workflow/scheduler";
import {
	createSessionWorkflowRuntimeHost,
	type WorkflowAgentTaskRequest,
	type WorkflowHumanInputRequest,
	type WorkflowScriptEvalRequest,
	type WorkflowShellScriptRequest,
} from "../../src/workflow/session-runtime";
import { DEFAULT_WORKFLOW_MAX_SUMMARY_BYTES, validateWorkflowActivationOutput } from "../../src/workflow/state";

const scriptWorkflow = `
name: session-runtime-demo
version: 1
nodes:
  shell:
    type: script
    prompt: return "workflow-ok";
  python:
    type: script
    script:
      language: py
      inline: print("workflow-ok")
  command:
    type: script
    script:
      language: sh
      inline: printf '{"summary":"shell-ok","data":{"kind":"command"}}\\n'
  build:
    type: agent
    agent: task
    prompt: Implement the workflow feature.
  review:
    type: review
    agent: reviewer
    prompt: Review the workflow result.
    gates:
      - continue
      - finish
  approve:
    type: human
    prompt: Approve this workflow result?
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

describe("session workflow runtime host", () => {
	it("maps script nodes to an eval runner when configured", async () => {
		const definition = parseWorkflowDefinition(scriptWorkflow, { sourcePath: "workflow.yml" });
		const node = definition.nodes.find(candidate => candidate.id === "shell");
		if (!node) throw new Error("expected shell node");
		let capturedRequest: WorkflowScriptEvalRequest | undefined;
		const host = createSessionWorkflowRuntimeHost({
			cwd: process.cwd(),
			runEvalScript: async request => {
				capturedRequest = request;
				return {
					exitCode: 0,
					output: "workflow-ok",
					artifactId: "eval-output",
				};
			},
		});

		const output = await host.runScriptNode?.({
			node,
			activation: activation(node.id),
			script: node.prompt,
			model: node.model,
		});

		expect(capturedRequest).toEqual({
			activationId: "activation-shell",
			nodeId: "shell",
			code: 'return "workflow-ok";',
			language: "js",
			title: "shell",
		});
		expect(output).toEqual({
			summary: "workflow-ok",
			data: { exitCode: 0 },
			artifacts: ["artifact://eval-output"],
		});
	});

	it("maps explicit Python script nodes to an eval runner", async () => {
		const definition = parseWorkflowDefinition(scriptWorkflow, { sourcePath: "workflow.yml" });
		const node = definition.nodes.find(candidate => candidate.id === "python");
		if (!node) throw new Error("expected python node");
		let capturedRequest: WorkflowScriptEvalRequest | undefined;
		const host = createSessionWorkflowRuntimeHost({
			cwd: process.cwd(),
			runEvalScript: async request => {
				capturedRequest = request;
				return {
					exitCode: 0,
					output: "workflow-ok",
				};
			},
		});

		const output = await executeWorkflowNode(node, activation(node.id), host);

		expect(capturedRequest).toEqual({
			activationId: "activation-python",
			nodeId: "python",
			code: 'print("workflow-ok")',
			language: "py",
			title: "python",
		});
		expect(output).toEqual({
			summary: "workflow-ok",
			data: { exitCode: 0 },
		});
	});

	it("passes script runtime budgets to eval runners", async () => {
		const definition = parseWorkflowDefinition(
			`
name: eval-timeout
version: 1
nodes:
  validate:
    type: script
    script:
      language: js
      timeoutMs: 90000
      inline: |
        return { summary: "validated" };
edges: []
`,
			{ sourcePath: "timeout.yml" },
		);
		const node = definition.nodes[0];
		if (!node) throw new Error("expected validate node");
		let capturedRequest: WorkflowScriptEvalRequest | undefined;
		const host = createSessionWorkflowRuntimeHost({
			cwd: process.cwd(),
			runEvalScript: async request => {
				capturedRequest = request;
				return {
					exitCode: 0,
					output: "validated",
				};
			},
		});

		await executeWorkflowNode(node, activation(node.id), host);

		expect(capturedRequest?.timeoutMs).toBe(90000);
	});

	it("maps shell script nodes to a shell runner without using the eval runner", async () => {
		const definition = parseWorkflowDefinition(scriptWorkflow, { sourcePath: "workflow.yml" });
		const node = definition.nodes.find(candidate => candidate.id === "command");
		if (!node) throw new Error("expected command node");
		let capturedRequest: WorkflowShellScriptRequest | undefined;
		let evalCalled = false;
		const host = createSessionWorkflowRuntimeHost({
			cwd: process.cwd(),
			runEvalScript: async () => {
				evalCalled = true;
				return {
					exitCode: 0,
					output: "wrong runner",
				};
			},
			runShellScript: async request => {
				capturedRequest = request;
				return {
					exitCode: 0,
					output: JSON.stringify({ summary: "shell-ok", data: { kind: "command" } }),
					language: request.language,
				};
			},
		});

		const output = await executeWorkflowNode(node, activation(node.id), host);

		expect(evalCalled).toBe(false);
		expect(capturedRequest).toEqual({
			activationId: "activation-command",
			nodeId: "command",
			code: 'printf \'{"summary":"shell-ok","data":{"kind":"command"}}\\n\'',
			language: "sh",
			title: "command",
		});
		expect(output).toEqual({
			summary: "shell-ok",
			data: { kind: "command" },
		});
	});

	it("passes script runtime budgets to shell runners", async () => {
		const definition = parseWorkflowDefinition(
			`
name: shell-timeout
version: 1
nodes:
  validate:
    type: script
    script:
      language: sh
      timeoutMs: 120000
      inline: printf '{"summary":"validated"}\\n'
edges: []
`,
			{ sourcePath: "timeout.yml" },
		);
		const node = definition.nodes[0];
		if (!node) throw new Error("expected validate node");
		let capturedRequest: WorkflowShellScriptRequest | undefined;
		const host = createSessionWorkflowRuntimeHost({
			cwd: process.cwd(),
			runShellScript: async request => {
				capturedRequest = request;
				return {
					exitCode: 0,
					output: JSON.stringify({ summary: "validated" }),
				};
			},
		});

		await executeWorkflowNode(node, activation(node.id), host);

		expect(capturedRequest?.timeoutMs).toBe(120000);
	});

	it("accepts structured activation output from script stdout JSON", async () => {
		const definition = parseWorkflowDefinition(scriptWorkflow, { sourcePath: "workflow.yml" });
		const node = definition.nodes.find(candidate => candidate.id === "shell");
		if (!node) throw new Error("expected shell node");
		const host = createSessionWorkflowRuntimeHost({
			cwd: process.cwd(),
			runEvalScript: async () => ({
				exitCode: 0,
				output: JSON.stringify({
					summary: "loop round 1",
					data: { verdict: "continue", round: 1 },
					statePatch: [{ op: "set", path: "/loop/round", value: 1 }],
					artifacts: ["artifact://workflow/run-1/loop.json"],
				}),
			}),
		});

		const output = await executeWorkflowNode(node, activation(node.id), host);

		expect(output).toEqual({
			summary: "loop round 1",
			data: { verdict: "continue", round: 1 },
			statePatch: [{ op: "set", path: "/loop/round", value: 1 }],
			artifacts: ["artifact://workflow/run-1/loop.json"],
		});
	});

	it("accepts structured activation output from the final script stdout JSON line", async () => {
		const definition = parseWorkflowDefinition(scriptWorkflow, { sourcePath: "workflow.yml" });
		const node = definition.nodes.find(candidate => candidate.id === "shell");
		if (!node) throw new Error("expected shell node");
		const host = createSessionWorkflowRuntimeHost({
			cwd: process.cwd(),
			runEvalScript: async () => ({
				exitCode: 0,
				output: [
					"running validation command",
					JSON.stringify({
						summary: "validation passed",
						data: { reviewPrompt: "Review the validation report." },
						statePatch: [{ op: "set", path: "/validation/passed", value: 77 }],
					}),
				].join("\n"),
			}),
		});

		const output = await executeWorkflowNode(node, activation(node.id), host);

		expect(output).toEqual({
			summary: "validation passed",
			data: { reviewPrompt: "Review the validation report." },
			statePatch: [{ op: "set", path: "/validation/passed", value: 77 }],
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
			modelOverride: "openai/gpt-4o",
		});

		expect(capturedRequest).toEqual({
			agent: "task",
			activationId: "activation-build",
			nodeId: "build",
			modelOverride: "openai/gpt-4o",
			modelOverrideAuthFallback: false,
			task: {
				id: "build",
				description: "Builder · Build",
				role: "Builder · Build",
				assignment: "Implement the workflow feature.",
			},
		});
		expect(output).toEqual({
			summary: "agent completed",
			data: { exitCode: 0 },
		});
	});

	it("records workflow agent outputs and transcript sessions as focusable artifacts", async () => {
		const definition = parseWorkflowDefinition(scriptWorkflow, { sourcePath: "workflow.yml" });
		const node = definition.nodes.find(candidate => candidate.id === "build");
		if (!node) throw new Error("expected build node");
		const host = createSessionWorkflowRuntimeHost({
			cwd: process.cwd(),
			runAgentTask: async () => ({
				exitCode: 0,
				output: "agent completed",
				agentId: "build",
				sessionFile: "/tmp/omp-workflow-agent.jsonl",
			}),
		});

		const output = await host.runAgentNode?.({
			node,
			activation: activation(node.id),
			agent: "task",
			prompt: node.prompt,
			model: node.model,
		});
		if (output === undefined) throw new Error("expected agent output");

		expect(output).toEqual({
			summary: "agent completed",
			data: { exitCode: 0, agentId: "build", sessionFile: "/tmp/omp-workflow-agent.jsonl" },
			artifacts: ["agent-output://build", "/tmp/omp-workflow-agent.jsonl"],
		});
		expect(validateWorkflowActivationOutput(output)).toEqual(output);
	});

	it("keeps transcript metadata in data for downstream workflow materializers", async () => {
		const definition = parseWorkflowDefinition(scriptWorkflow, { sourcePath: "workflow.yml" });
		const node = definition.nodes.find(candidate => candidate.id === "build");
		if (!node) throw new Error("expected build node");
		const host = createSessionWorkflowRuntimeHost({
			cwd: process.cwd(),
			runAgentTask: async () => ({
				exitCode: 0,
				output: "The structured report is in the session transcript.",
				agentId: "workflow-build-activation-build",
				outputPath: "/tmp/workflow-build-output.md",
				sessionFile: "/tmp/workflow-build.jsonl",
			}),
		});

		const output = await host.runAgentNode?.({
			node,
			activation: activation(node.id),
			agent: "task",
			prompt: node.prompt,
			model: node.model,
		});
		if (output === undefined) throw new Error("expected agent output");

		expect(output.data).toMatchObject({
			exitCode: 0,
			agentId: "workflow-build-activation-build",
			outputPath: "/tmp/workflow-build-output.md",
			sessionFile: "/tmp/workflow-build.jsonl",
		});
		expect(output.artifacts).toEqual([
			"agent-output://workflow-build-activation-build",
			"/tmp/workflow-build-output.md",
			"/tmp/workflow-build.jsonl",
		]);
	});

	it("bounds unstructured agent output summaries and keeps full output references", async () => {
		const definition = parseWorkflowDefinition(scriptWorkflow, { sourcePath: "workflow.yml" });
		const node = definition.nodes.find(candidate => candidate.id === "build");
		if (!node) throw new Error("expected build node");
		const longOutput = "workspace finding\n".repeat(900);
		const host = createSessionWorkflowRuntimeHost({
			cwd: process.cwd(),
			runAgentTask: async () => ({
				exitCode: 0,
				output: longOutput,
				agentId: "agent-long",
				outputPath: "/tmp/workflow-long-output.md",
			}),
		});

		const output = await host.runAgentNode?.({
			node,
			activation: activation(node.id),
			agent: "task",
			prompt: node.prompt,
			model: node.model,
		});
		if (output === undefined) throw new Error("expected agent output");

		expect(new TextEncoder().encode(output.summary ?? "").byteLength).toBeLessThanOrEqual(
			DEFAULT_WORKFLOW_MAX_SUMMARY_BYTES,
		);
		expect(output.summary).toContain("[workflow summary truncated");
		expect(output.data).toMatchObject({
			exitCode: 0,
			summaryTruncated: true,
			summaryBytes: new TextEncoder().encode(longOutput.trim()).byteLength,
		});
		expect(output.artifacts).toEqual(["agent-output://agent-long", "/tmp/workflow-long-output.md"]);
		expect(validateWorkflowActivationOutput(output)).toEqual(output);
	});

	it("accepts structured activation output from agent task results", async () => {
		const definition = parseWorkflowDefinition(scriptWorkflow, { sourcePath: "workflow.yml" });
		const node = definition.nodes.find(candidate => candidate.id === "build");
		if (!node) throw new Error("expected build node");
		const host = createSessionWorkflowRuntimeHost({
			cwd: process.cwd(),
			runAgentTask: async () => ({
				exitCode: 0,
				output: JSON.stringify({
					summary: "agent selected retry path",
					data: { decision: "retry" },
					statePatch: [{ op: "set", path: "/agent/decision", value: "retry" }],
				}),
			}),
		});

		const output = await host.runAgentNode?.({
			node,
			activation: activation(node.id),
			agent: "task",
			prompt: node.prompt,
			model: node.model,
		});

		expect(output).toEqual({
			summary: "agent selected retry path",
			data: { decision: "retry" },
			statePatch: [{ op: "set", path: "/agent/decision", value: "retry" }],
		});
	});

	it("preserves structured yield data from agent task results", async () => {
		const definition = parseWorkflowDefinition(scriptWorkflow, { sourcePath: "workflow.yml" });
		const node = definition.nodes.find(candidate => candidate.id === "build");
		if (!node) throw new Error("expected build node");
		const host = createSessionWorkflowRuntimeHost({
			cwd: process.cwd(),
			runAgentTask: async () => ({
				exitCode: 0,
				output: JSON.stringify(
					{
						status: "implementation_verified_not_long_running_final",
						summary: "implemented evaluator and tests",
						verification: [{ command: "bun test", result: "pass" }],
					},
					null,
					2,
				),
				agentId: "build",
				data: {
					status: "implementation_verified_not_long_running_final",
					summary: "implemented evaluator and tests",
					verification: [{ command: "bun test", result: "pass" }],
				},
			}),
		});

		const output = await host.runAgentNode?.({
			node,
			activation: activation(node.id),
			agent: "task",
			prompt: node.prompt,
			model: node.model,
		});

		expect(output).toEqual({
			summary: "implemented evaluator and tests",
			data: {
				agentId: "build",
				status: "implementation_verified_not_long_running_final",
				summary: "implemented evaluator and tests",
				verification: [{ command: "bun test", result: "pass" }],
			},
			artifacts: ["agent-output://build"],
		});
	});

	it("treats agent JSON with object summary as unstructured task output", async () => {
		const definition = parseWorkflowDefinition(scriptWorkflow, { sourcePath: "workflow.yml" });
		const node = definition.nodes.find(candidate => candidate.id === "build");
		if (!node) throw new Error("expected build node");
		const taskOutput = JSON.stringify({
			summary: {
				documentation_files: ["docs/shell-completion.md"],
				tests_run: [{ command: "PYTHONPATH=src python -m pytest tests/test_shell_completion.py -q" }],
			},
		});
		const host = createSessionWorkflowRuntimeHost({
			cwd: process.cwd(),
			runAgentTask: async () => ({
				exitCode: 0,
				output: taskOutput,
				agentId: "build",
			}),
		});

		const output = await host.runAgentNode?.({
			node,
			activation: activation(node.id),
			agent: "task",
			prompt: node.prompt,
			model: node.model,
		});

		expect(output).toEqual({
			summary: taskOutput,
			data: { exitCode: 0, agentId: "build" },
			artifacts: ["agent-output://build"],
		});
	});

	it("propagates abort signals to agent task requests", async () => {
		const definition = parseWorkflowDefinition(scriptWorkflow, { sourcePath: "workflow.yml" });
		const node = definition.nodes.find(candidate => candidate.id === "build");
		if (!node) throw new Error("expected build node");
		const controller = new AbortController();
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

		await host.runAgentNode?.({
			node,
			activation: activation(node.id),
			agent: "task",
			prompt: node.prompt,
			model: node.model,
			signal: controller.signal,
		});

		const captured = capturedRequest as (WorkflowAgentTaskRequest & { signal?: AbortSignal }) | undefined;
		expect(captured?.signal).toBe(controller.signal);
	});

	it("preserves provider request context in failed agent node diagnostics", async () => {
		const definition = parseWorkflowDefinition(scriptWorkflow, { sourcePath: "workflow.yml" });
		const node = definition.nodes.find(candidate => candidate.id === "build");
		if (!node) throw new Error("expected build node");
		const host = createSessionWorkflowRuntimeHost({
			cwd: process.cwd(),
			runAgentTask: async () => ({
				exitCode: 1,
				output: "",
				error: [
					"JSON Parse error: Unexpected EOF",
					"request-context: provider=rust-cat api=openai-responses model=gpt-5.5 url=https://rust.cat/v1/responses",
				].join("\n"),
			}),
		});

		await expect(
			host.runAgentNode?.({
				node,
				activation: activation(node.id),
				agent: "task",
				prompt: node.prompt,
				model: node.model,
			}),
		).rejects.toThrow(/provider=rust-cat api=openai-responses model=gpt-5\.5/u);
	});

	it("maps review nodes to a reviewer task and extracts a structured verdict", async () => {
		const definition = parseWorkflowDefinition(scriptWorkflow, { sourcePath: "workflow.yml" });
		const node = definition.nodes.find(candidate => candidate.id === "review");
		if (!node) throw new Error("expected review node");
		let capturedRequest: WorkflowAgentTaskRequest | undefined;
		const host = createSessionWorkflowRuntimeHost({
			cwd: process.cwd(),
			runAgentTask: async request => {
				capturedRequest = request;
				return {
					exitCode: 0,
					output: JSON.stringify({ verdict: "continue", summary: "review passed" }),
				};
			},
		});

		const output = await host.runReviewNode?.({
			node,
			activation: activation(node.id),
			agent: node.agent,
			prompt: node.prompt,
			model: node.model,
			modelOverride: "openai/gpt-4o",
			gates: node.gates,
		});

		expect(capturedRequest).toMatchObject({
			agent: "reviewer",
			activationId: "activation-review",
			nodeId: "review",
			modelOverride: "openai/gpt-4o",
			modelOverrideAuthFallback: false,
			task: {
				id: "review",
				description: "Reviewer · Review",
				role: "Reviewer · Review",
			},
		});
		expect(capturedRequest?.task.assignment).toContain("Workflow review adapter:");
		expect(capturedRequest?.task.assignment).toContain("Review the workflow result.");
		expect(capturedRequest?.task.assignment).toContain("Declared workflow gates: continue, finish");
		expect(output).toEqual({
			summary: "review passed",
			verdict: "continue",
		});
	});

	it("bounds review summaries after parsing a declared verdict", async () => {
		const definition = parseWorkflowDefinition(scriptWorkflow, { sourcePath: "workflow.yml" });
		const node = definition.nodes.find(candidate => candidate.id === "review");
		if (!node) throw new Error("expected review node");
		const longReview = `${"review detail\n".repeat(900)}finish`;
		const host = createSessionWorkflowRuntimeHost({
			cwd: process.cwd(),
			runAgentTask: async () => ({
				exitCode: 0,
				output: longReview,
				agentId: "review-long",
				outputPath: "/tmp/workflow-review-output.md",
				sessionFile: "/tmp/workflow-review-session.jsonl",
			}),
		});

		const output = await executeWorkflowNode(node, activation(node.id), host);

		expect(output.data).toEqual({ verdict: "finish" });
		expect(new TextEncoder().encode(output.summary ?? "").byteLength).toBeLessThanOrEqual(
			DEFAULT_WORKFLOW_MAX_SUMMARY_BYTES,
		);
		expect(output.summary).toContain("[workflow summary truncated");
		expect(output.artifacts).toEqual([
			"agent-output://review-long",
			"/tmp/workflow-review-output.md",
			"/tmp/workflow-review-session.jsonl",
		]);
		expect(validateWorkflowActivationOutput(output)).toEqual(output);
	});

	it("propagates abort signals to review task requests", async () => {
		const definition = parseWorkflowDefinition(scriptWorkflow, { sourcePath: "workflow.yml" });
		const node = definition.nodes.find(candidate => candidate.id === "review");
		if (!node) throw new Error("expected review node");
		const controller = new AbortController();
		let capturedRequest: WorkflowAgentTaskRequest | undefined;
		const host = createSessionWorkflowRuntimeHost({
			cwd: process.cwd(),
			runAgentTask: async request => {
				capturedRequest = request;
				return {
					exitCode: 0,
					output: JSON.stringify({ verdict: "continue" }),
				};
			},
		});

		await host.runReviewNode?.({
			node,
			activation: activation(node.id),
			agent: node.agent,
			prompt: node.prompt,
			model: node.model,
			gates: node.gates,
			signal: controller.signal,
		});

		const captured = capturedRequest as (WorkflowAgentTaskRequest & { signal?: AbortSignal }) | undefined;
		expect(captured?.signal).toBe(controller.signal);
	});

	it("extracts review verdicts nested in the reviewer output explanation", async () => {
		const definition = parseWorkflowDefinition(scriptWorkflow, { sourcePath: "workflow.yml" });
		const node = definition.nodes.find(candidate => candidate.id === "review");
		if (!node) throw new Error("expected review node");
		const host = createSessionWorkflowRuntimeHost({
			cwd: process.cwd(),
			runAgentTask: async () => ({
				exitCode: 0,
				output: JSON.stringify({
					overall_correctness: "correct",
					explanation: JSON.stringify({ verdict: "pass", summary: "workflow-review-runtime-ok" }),
					confidence: 1,
				}),
			}),
		});

		const output = await host.runReviewNode?.({
			node,
			activation: activation(node.id),
			agent: node.agent,
			prompt: node.prompt,
			model: node.model,
			gates: ["pass", "fail"],
		});

		expect(output).toEqual({
			summary: "workflow-review-runtime-ok",
			verdict: "pass",
		});
	});

	it("extracts Humanize-style review verdicts from the last non-empty output line", async () => {
		const definition = parseWorkflowDefinition(scriptWorkflow, { sourcePath: "workflow.yml" });
		const node = definition.nodes.find(candidate => candidate.id === "review");
		if (!node) throw new Error("expected review node");
		const host = createSessionWorkflowRuntimeHost({
			cwd: process.cwd(),
			runAgentTask: async () => ({
				exitCode: 0,
				output: ["Review findings:", "- all acceptance criteria are satisfied", "", "COMPLETE"].join("\n"),
			}),
		});

		const output = await host.runReviewNode?.({
			node,
			activation: activation(node.id),
			agent: node.agent,
			prompt: node.prompt,
			model: node.model,
			gates: ["COMPLETE", "STOP"],
		});

		expect(output).toEqual({
			summary: "Review findings:\n- all acceptance criteria are satisfied\n\nCOMPLETE",
			verdict: "COMPLETE",
		});
	});

	it("extracts declared Humanize gates from reviewer explanation text before pass/fail mapping", async () => {
		const definition = parseWorkflowDefinition(scriptWorkflow, { sourcePath: "workflow.yml" });
		const node = definition.nodes.find(candidate => candidate.id === "review");
		if (!node) throw new Error("expected review node");
		const host = createSessionWorkflowRuntimeHost({
			cwd: process.cwd(),
			runAgentTask: async () => ({
				exitCode: 0,
				output: JSON.stringify({
					overall_correctness: "correct",
					explanation:
						"README.md satisfies round 1, but the Humanize loop must continue until round 10.\nCONTINUE",
					confidence: 0.93,
				}),
			}),
		});

		const output = await host.runReviewNode?.({
			node,
			activation: activation(node.id),
			agent: node.agent,
			prompt: node.prompt,
			model: node.model,
			gates: ["CONTINUE", "COMPLETE", "STOP"],
			fallbackVerdict: "CONTINUE",
		});

		expect(output).toEqual({
			summary: "README.md satisfies round 1, but the Humanize loop must continue until round 10.\nCONTINUE",
			verdict: "CONTINUE",
		});
	});

	it("prefers declared Humanize gates over generic structured pass verdicts", async () => {
		const definition = parseWorkflowDefinition(scriptWorkflow, { sourcePath: "workflow.yml" });
		const node = definition.nodes.find(candidate => candidate.id === "review");
		if (!node) throw new Error("expected review node");
		const host = createSessionWorkflowRuntimeHost({
			cwd: process.cwd(),
			runAgentTask: async () => ({
				exitCode: 0,
				output: JSON.stringify({
					verdict: "pass",
					overall_correctness: "correct",
					explanation:
						"The implementation summary satisfies the Humanize review gate; downstream KDA validation remains outside this subflow. COMPLETE",
					confidence: 0.9,
				}),
			}),
		});

		const output = await host.runReviewNode?.({
			node,
			activation: activation(node.id),
			agent: node.agent,
			prompt: node.prompt,
			model: node.model,
			gates: ["CONTINUE", "COMPLETE", "STOP"],
			fallbackVerdict: "CONTINUE",
		});

		expect(output).toEqual({
			summary:
				"The implementation summary satisfies the Humanize review gate; downstream KDA validation remains outside this subflow. COMPLETE",
			verdict: "COMPLETE",
		});
	});

	it("extracts declared gates after a verdict label in reviewer explanation text", async () => {
		const definition = parseWorkflowDefinition(scriptWorkflow, { sourcePath: "workflow.yml" });
		const node = definition.nodes.find(candidate => candidate.id === "review");
		if (!node) throw new Error("expected review node");
		const host = createSessionWorkflowRuntimeHost({
			cwd: process.cwd(),
			runAgentTask: async () => ({
				exitCode: 0,
				output: JSON.stringify({
					overall_correctness: "correct",
					explanation:
						"Verdict complete: progress.md has 2 ROUND lines, validation passed, and the adaptive review upgrade request artifact is present.",
					confidence: 0.92,
				}),
			}),
		});

		const output = await host.runReviewNode?.({
			node,
			activation: activation(node.id),
			agent: node.agent,
			prompt: node.prompt,
			model: node.model,
			gates: ["continue", "complete"],
			fallbackVerdict: "continue",
		});

		expect(output).toEqual({
			summary:
				"Verdict complete: progress.md has 2 ROUND lines, validation passed, and the adaptive review upgrade request artifact is present.",
			verdict: "complete",
		});
	});

	it("maps reviewer correctness output to a declared completion gate when no fallback exists", async () => {
		const definition = parseWorkflowDefinition(scriptWorkflow, { sourcePath: "workflow.yml" });
		const node = definition.nodes.find(candidate => candidate.id === "review");
		if (!node) throw new Error("expected review node");
		const host = createSessionWorkflowRuntimeHost({
			cwd: process.cwd(),
			runAgentTask: async () => ({
				exitCode: 0,
				output: JSON.stringify({
					overall_correctness: "correct",
					explanation: "No blocking findings remain.",
					confidence: 0.91,
				}),
			}),
		});

		const output = await host.runReviewNode?.({
			node,
			activation: activation(node.id),
			agent: node.agent,
			prompt: node.prompt,
			model: node.model,
			gates: ["continue", "complete"],
		});

		expect(output).toEqual({
			summary: "No blocking findings remain.",
			verdict: "complete",
		});
	});

	it("maps differently cased review gate tokens to the declared gate", async () => {
		const definition = parseWorkflowDefinition(scriptWorkflow, { sourcePath: "workflow.yml" });
		const node = definition.nodes.find(candidate => candidate.id === "review");
		if (!node) throw new Error("expected review node");
		const host = createSessionWorkflowRuntimeHost({
			cwd: process.cwd(),
			runAgentTask: async () => ({
				exitCode: 0,
				output: JSON.stringify({
					overall_correctness: "correct",
					explanation:
						"PROMOTE. The candidate summary matches the observed checkout diff and validation evidence.",
					confidence: 0.91,
				}),
			}),
		});

		const output = await host.runReviewNode?.({
			node,
			activation: activation(node.id),
			agent: node.agent,
			prompt: node.prompt,
			model: node.model,
			gates: ["revise", "promote"],
			fallbackVerdict: "revise",
		});

		expect(output).toEqual({
			summary: "PROMOTE. The candidate summary matches the observed checkout diff and validation evidence.",
			verdict: "promote",
		});
	});

	it("prefers an explicit review-text prefix over later gate mentions", async () => {
		const definition = parseWorkflowDefinition(scriptWorkflow, { sourcePath: "workflow.yml" });
		const node = definition.nodes.find(candidate => candidate.id === "review");
		if (!node) throw new Error("expected review node");
		const host = createSessionWorkflowRuntimeHost({
			cwd: process.cwd(),
			runAgentTask: async () => ({
				exitCode: 0,
				output: JSON.stringify({
					overall_correctness: "incorrect",
					explanation:
						"REWORK: the selected candidate has measurements, but the evidence floor is still missing; collect a transcript audit before PASS.",
					confidence: 0.91,
				}),
			}),
		});

		const output = await host.runReviewNode?.({
			node,
			activation: activation(node.id),
			agent: node.agent,
			prompt: node.prompt,
			model: node.model,
			gates: ["PASS", "REWORK"],
		});

		expect(output).toEqual({
			summary:
				"REWORK: the selected candidate has measurements, but the evidence floor is still missing; collect a transcript audit before PASS.",
			verdict: "REWORK",
		});
	});

	it("extracts declared Humanize gates from generic review text yielded by task agents", async () => {
		const definition = parseWorkflowDefinition(scriptWorkflow, { sourcePath: "workflow.yml" });
		const node = definition.nodes.find(candidate => candidate.id === "review");
		if (!node) throw new Error("expected review node");
		const host = createSessionWorkflowRuntimeHost({
			cwd: process.cwd(),
			runAgentTask: async () => ({
				exitCode: 0,
				output: JSON.stringify({
					review:
						"README contract exists and covers purpose, acceptance criteria, and Humanize mapping.\nCONTINUE",
				}),
			}),
		});

		const output = await host.runReviewNode?.({
			node,
			activation: activation(node.id),
			agent: node.agent,
			prompt: node.prompt,
			model: node.model,
			gates: ["CONTINUE", "COMPLETE", "STOP"],
			fallbackVerdict: "CONTINUE",
		});

		expect(output).toEqual({
			summary: "README contract exists and covers purpose, acceptance criteria, and Humanize mapping.\nCONTINUE",
			verdict: "CONTINUE",
		});
	});

	it("maps unmatched Humanize-style review text to an explicit fallback verdict", async () => {
		const definition = parseWorkflowDefinition(scriptWorkflow, { sourcePath: "workflow.yml" });
		const node = definition.nodes.find(candidate => candidate.id === "review");
		if (!node) throw new Error("expected review node");
		const host = createSessionWorkflowRuntimeHost({
			cwd: process.cwd(),
			runAgentTask: async () => ({
				exitCode: 0,
				output: [
					"Review findings:",
					"- acceptance criterion AC-2 is still missing",
					"- continue implementation before review can pass",
				].join("\n"),
			}),
		});

		const output = await host.runReviewNode?.({
			node,
			activation: activation(node.id),
			agent: node.agent,
			prompt: node.prompt,
			model: node.model,
			gates: ["CONTINUE", "COMPLETE"],
			fallbackVerdict: "CONTINUE",
		});

		expect(output).toEqual({
			summary:
				"Review findings:\n- acceptance criterion AC-2 is still missing\n- continue implementation before review can pass",
			verdict: "CONTINUE",
		});
	});

	it("maps reviewer correctness output to the declared completion gate", async () => {
		const definition = parseWorkflowDefinition(scriptWorkflow, { sourcePath: "workflow.yml" });
		const node = definition.nodes.find(candidate => candidate.id === "review");
		if (!node) throw new Error("expected review node");
		const host = createSessionWorkflowRuntimeHost({
			cwd: process.cwd(),
			runAgentTask: async () => ({
				exitCode: 0,
				output: JSON.stringify({
					overall_correctness: "correct",
					explanation: "Round 7 artifact is present, but the loop has not reached the completion threshold.",
					confidence: 0.88,
				}),
			}),
		});

		const output = await host.runReviewNode?.({
			node,
			activation: activation(node.id),
			agent: node.agent,
			prompt: node.prompt,
			model: node.model,
			gates: ["CONTINUE", "COMPLETE", "STOP"],
			fallbackVerdict: "CONTINUE",
		});

		expect(output).toEqual({
			summary: "Round 7 artifact is present, but the loop has not reached the completion threshold.",
			verdict: "COMPLETE",
		});
	});

	it("extracts structured review verdicts from the final JSON output line", async () => {
		const definition = parseWorkflowDefinition(scriptWorkflow, { sourcePath: "workflow.yml" });
		const node = definition.nodes.find(candidate => candidate.id === "review");
		if (!node) throw new Error("expected review node");
		const host = createSessionWorkflowRuntimeHost({
			cwd: process.cwd(),
			runAgentTask: async () => ({
				exitCode: 0,
				output: [
					"Review findings:",
					"- benchmark evidence is missing",
					JSON.stringify({ verdict: "retry", summary: "benchmark evidence is missing" }),
				].join("\n"),
			}),
		});

		const output = await host.runReviewNode?.({
			node,
			activation: activation(node.id),
			agent: node.agent,
			prompt: node.prompt,
			model: node.model,
			gates: ["retry", "finish"],
		});

		expect(output).toEqual({
			summary: "benchmark evidence is missing",
			verdict: "retry",
		});
	});

	it("maps reviewer correctness output to declared pass/fail gates", async () => {
		const definition = parseWorkflowDefinition(scriptWorkflow, { sourcePath: "workflow.yml" });
		const node = definition.nodes.find(candidate => candidate.id === "review");
		if (!node) throw new Error("expected review node");
		const host = createSessionWorkflowRuntimeHost({
			cwd: process.cwd(),
			runAgentTask: async () => ({
				exitCode: 0,
				output: JSON.stringify({
					overall_correctness: "incorrect",
					explanation: "validation failed",
					confidence: 0.8,
				}),
			}),
		});

		const output = await host.runReviewNode?.({
			node,
			activation: activation(node.id),
			agent: node.agent,
			prompt: node.prompt,
			model: node.model,
			gates: ["pass", "fail"],
		});

		expect(output).toEqual({
			summary: "validation failed",
			verdict: "fail",
		});
	});

	it("maps human nodes to a human input runner when configured", async () => {
		const definition = parseWorkflowDefinition(scriptWorkflow, { sourcePath: "workflow.yml" });
		const node = definition.nodes.find(candidate => candidate.id === "approve");
		if (!node) throw new Error("expected approve node");
		let capturedRequest: WorkflowHumanInputRequest | undefined;
		const host = createSessionWorkflowRuntimeHost({
			cwd: process.cwd(),
			runHumanInput: async request => {
				capturedRequest = request;
				return {
					response: "approved",
					selectedOptions: ["Approve"],
				};
			},
		});

		const output = await host.runHumanNode?.({
			node,
			activation: activation(node.id),
			prompt: node.prompt,
		});

		expect(capturedRequest).toEqual({
			activationId: "activation-approve",
			nodeId: "approve",
			question: "Approve this workflow result?",
		});
		expect(output).toEqual({
			summary: "approved",
			data: {
				question: "Approve this workflow result?",
				response: "approved",
				selectedOptions: ["Approve"],
			},
		});
	});
});
