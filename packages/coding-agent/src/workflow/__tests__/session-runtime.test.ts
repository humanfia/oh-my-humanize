import { describe, expect, it, spyOn } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../../config/settings";
import type { ToolSession } from "../../tools";
import { EvalTool, type EvalToolParams } from "../../tools/eval";
import { parseWorkflowDefinition, type WorkflowDefinition, type WorkflowNode } from "../definition";
import { createEvalToolScriptRunner } from "../eval-tool-runtime";
import { runWorkflow } from "../runner";
import {
	createSessionWorkflowRuntimeHost,
	type WorkflowAgentTaskRequest,
	type WorkflowHumanInputRequest,
	type WorkflowScriptEvalRequest,
	type WorkflowShellScriptRequest,
} from "../session-runtime";

describe("createSessionWorkflowRuntimeHost review nodes", () => {
	it("parses workflow node isolation contracts", () => {
		const definition = parseWorkflowDefinition(`
name: lane-isolation
version: 1
models:
  roles: {}
  defaults: {}
nodes:
  - id: branch
    type: agent
    agent: task
    prompt: Try a lane-local change.
    isolation:
      enabled: true
      apply: false
      merge: false
    writes:
      - /branch
edges: []
`);

		expect(definition.nodes[0]?.isolation).toEqual({ enabled: true, apply: false, merge: false });
	});

	it("passes workflow node isolation to task runners and exposes captured patch metadata", async () => {
		let capturedRequest: WorkflowAgentTaskRequest | undefined;
		const host = createSessionWorkflowRuntimeHost({
			cwd: "/workspace",
			runAgentTask: async request => {
				capturedRequest = request;
				return {
					exitCode: 0,
					output: "lane completed in isolation",
					patchPath: "/workspace/.omh/artifacts/lane.patch",
					changesApplied: null,
				};
			},
		});
		if (host.runAgentNode === undefined) throw new Error("agent runtime missing");

		const node: WorkflowNode = {
			id: "branch",
			type: "agent",
			agent: "task",
			prompt: "Try a lane-local change.",
			isolation: { enabled: true, apply: false, merge: false },
		};
		const output = await host.runAgentNode({
			node,
			activation: workflowActivation(node.id),
			agent: "task",
			prompt: node.prompt,
		});

		expect(capturedRequest?.isolated).toBe(true);
		expect(capturedRequest?.apply).toBe(false);
		expect(capturedRequest?.merge).toBe(false);
		expect(output.data).toMatchObject({
			exitCode: 0,
			patchPath: "/workspace/.omh/artifacts/lane.patch",
			changesApplied: null,
		});
	});

	it("retries transient provider failures for agent nodes before completing", async () => {
		const calls: string[] = [];
		const host = createSessionWorkflowRuntimeHost({
			cwd: "/workspace",
			agentTaskRetryPolicy: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
			runAgentTask: async request => {
				calls.push(request.nodeId);
				if (calls.length < 3) {
					return {
						exitCode: 1,
						output: "",
						error: "429 Upstream rate limit exceeded, please retry later",
					};
				}
				return {
					exitCode: 0,
					output: JSON.stringify({ summary: "agent completed after transient retry" }),
				};
			},
		});
		if (host.runAgentNode === undefined) throw new Error("agent runtime missing");

		const node: WorkflowNode = { id: "build", type: "agent", prompt: "Build the thing." };
		const output = await host.runAgentNode({
			node,
			activation: workflowActivation(node.id),
			agent: "builder",
			prompt: node.prompt,
		});

		expect(calls).toEqual(["build", "build", "build"]);
		expect(output.summary).toBe("agent completed after transient retry");
	});

	it("honors retry-after hints and jitter for transient workflow agent retries", async () => {
		const delays: number[] = [];
		let calls = 0;
		const host = createSessionWorkflowRuntimeHost({
			cwd: "/workspace",
			agentTaskRetryPolicy: { maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 1_000, jitterRatio: 0.5 },
			retryDelay: async delayMs => {
				delays.push(delayMs);
			},
			retryRandom: () => 0.5,
			runAgentTask: async () => {
				calls += 1;
				if (calls === 1) {
					return {
						exitCode: 1,
						output: "",
						error: "429 Too Many Requests retry-after-ms=400",
					};
				}
				return {
					exitCode: 0,
					output: JSON.stringify({ summary: "agent recovered after provider retry" }),
				};
			},
		});
		if (host.runAgentNode === undefined) throw new Error("agent runtime missing");

		const node: WorkflowNode = { id: "build", type: "agent", prompt: "Build the thing." };
		const output = await host.runAgentNode({
			node,
			activation: workflowActivation(node.id),
			agent: "builder",
			prompt: node.prompt,
		});

		expect(calls).toBe(2);
		expect(delays).toEqual([500]);
		expect(output.summary).toBe("agent recovered after provider retry");
	});

	it("caps retry-after hints at the workflow agent retry max delay", async () => {
		const delays: number[] = [];
		let calls = 0;
		const host = createSessionWorkflowRuntimeHost({
			cwd: "/workspace",
			agentTaskRetryPolicy: { maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 1_000, jitterRatio: 0 },
			retryDelay: async delayMs => {
				delays.push(delayMs);
			},
			runAgentTask: async () => {
				calls += 1;
				if (calls === 1) {
					return {
						exitCode: 1,
						output: "",
						error: "503 Service Unavailable retry-after-ms=5000",
					};
				}
				return {
					exitCode: 0,
					output: JSON.stringify({ summary: "agent recovered after capped retry" }),
				};
			},
		});
		if (host.runAgentNode === undefined) throw new Error("agent runtime missing");

		const node: WorkflowNode = { id: "build", type: "agent", prompt: "Build the thing." };
		const output = await host.runAgentNode({
			node,
			activation: workflowActivation(node.id),
			agent: "builder",
			prompt: node.prompt,
		});

		expect(calls).toBe(2);
		expect(delays).toEqual([1_000]);
		expect(output.summary).toBe("agent recovered after capped retry");
	});

	it("retries transient HTTP/2 transport errors for workflow agent nodes", async () => {
		const calls: string[] = [];
		const host = createSessionWorkflowRuntimeHost({
			cwd: "/workspace",
			agentTaskRetryPolicy: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
			runAgentTask: async request => {
				calls.push(request.nodeId);
				if (calls.length === 1) {
					return {
						exitCode: 1,
						output: "",
						error: "HTTP/2 stream 1 was not closed cleanly: INTERNAL_ERROR (err 2)",
					};
				}
				return {
					exitCode: 0,
					output: JSON.stringify({ summary: "agent recovered after HTTP/2 transport retry" }),
				};
			},
		});
		if (host.runAgentNode === undefined) throw new Error("agent runtime missing");

		const node: WorkflowNode = { id: "build", type: "agent", prompt: "Build the thing." };
		const output = await host.runAgentNode({
			node,
			activation: workflowActivation(node.id),
			agent: "builder",
			prompt: node.prompt,
		});

		expect(calls).toEqual(["build", "build"]);
		expect(output.summary).toBe("agent recovered after HTTP/2 transport retry");
	});

	it("retries interrupted provider streams for workflow agent nodes", async () => {
		const calls: string[] = [];
		const host = createSessionWorkflowRuntimeHost({
			cwd: "/workspace",
			agentTaskRetryPolicy: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
			runAgentTask: async request => {
				calls.push(request.nodeId);
				if (calls.length === 1) {
					return {
						exitCode: 1,
						output: "",
						error: "Error Code stream_read_error: stream_read_error",
					};
				}
				return {
					exitCode: 0,
					output: JSON.stringify({ summary: "agent recovered after interrupted stream retry" }),
				};
			},
		});
		if (host.runAgentNode === undefined) throw new Error("agent runtime missing");

		const node: WorkflowNode = { id: "build", type: "agent", prompt: "Build the thing." };
		const output = await host.runAgentNode({
			node,
			activation: workflowActivation(node.id),
			agent: "builder",
			prompt: node.prompt,
		});

		expect(calls).toEqual(["build", "build"]);
		expect(output.summary).toBe("agent recovered after interrupted stream retry");
		expect(output.data).toMatchObject({
			retryHistory: [
				{
					attempt: 1,
					reason: "Error Code stream_read_error: stream_read_error",
					nextAttempt: 2,
				},
			],
		});
	});

	it("does not retry non-transient agent failures", async () => {
		let calls = 0;
		const host = createSessionWorkflowRuntimeHost({
			cwd: "/workspace",
			agentTaskRetryPolicy: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
			runAgentTask: async () => {
				calls += 1;
				return {
					exitCode: 1,
					output: "",
					error: "implementation review rejected the candidate",
				};
			},
		});
		if (host.runAgentNode === undefined) throw new Error("agent runtime missing");

		const node: WorkflowNode = { id: "build", type: "agent", prompt: "Build the thing." };
		await expect(
			host.runAgentNode({
				node,
				activation: workflowActivation(node.id),
				agent: "builder",
				prompt: node.prompt,
			}),
		).rejects.toThrow('workflow agent node "build" failed: implementation review rejected the candidate');

		expect(calls).toBe(1);
	});

	it("records failed agent nodes in workflow observability", async () => {
		using tempDir = TempDir.createSync("@omh-workflow-failed-observability-");
		const cwd = tempDir.path();
		const host = createSessionWorkflowRuntimeHost({
			cwd,
			runAgentTask: async () => ({
				exitCode: 1,
				output: "",
				error: "candidate branch failed before writing evidence",
			}),
		});
		if (host.runAgentNode === undefined) throw new Error("agent runtime missing");

		const node: WorkflowNode = { id: "tryCandidate", type: "agent", prompt: "Try a candidate branch." };
		await expect(
			host.runAgentNode({
				node,
				activation: workflowActivation(node.id),
				agent: "builder",
				prompt: node.prompt,
			}),
		).rejects.toThrow('workflow agent node "tryCandidate" failed: candidate branch failed before writing evidence');

		const observability = await Bun.file(`${cwd}/workflow-output/omh-runtime/observability.json`).json();
		expect(observability.activations[0]).toMatchObject({
			activationId: "tryCandidate:activation-1",
			nodeId: "tryCandidate",
			type: "agent",
			status: "failed",
			error: 'workflow agent node "tryCandidate" failed: candidate branch failed before writing evidence',
		});
		const progress = await Bun.file(`${cwd}/workflow-output/omh-runtime/progress.md`).text();
		expect(progress).toContain("Failed activations: 1");
		expect(progress).toContain("tryCandidate");
		expect(progress).toContain("candidate branch failed before writing evidence");
	});

	it("writes a project-local workflow observability index for completed agent nodes", async () => {
		using tempDir = TempDir.createSync("@omh-workflow-observability-");
		const cwd = tempDir.path();
		const outputPath = `${cwd}/.agent-output/build.md`;
		const sessionFile = `${cwd}/.omh/sessions/build.jsonl`;
		const host = createSessionWorkflowRuntimeHost({
			cwd,
			runAgentTask: async () => {
				await Bun.write(outputPath, "build markdown transcript");
				await Bun.write(sessionFile, '{"type":"session"}\n');
				return {
					exitCode: 0,
					output: JSON.stringify({ summary: "agent produced a bounded patch" }),
					agentId: "agent-build",
					outputPath,
					sessionFile,
				};
			},
		});
		if (host.runAgentNode === undefined) throw new Error("agent runtime missing");

		const node: WorkflowNode = { id: "build", type: "agent", prompt: "Build the thing." };
		await host.runAgentNode({
			node,
			activation: workflowActivation(node.id),
			agent: "builder",
			prompt: node.prompt,
		});

		const mirroredOutput = "workflow-output/omh-runtime/artifacts/build_activation-1/1-build.md";
		const mirroredSession = "workflow-output/omh-runtime/artifacts/build_activation-1/2-build.jsonl";
		const mirroredOutputPath = `${cwd}/${mirroredOutput}`;
		const mirroredSessionPath = `${cwd}/${mirroredSession}`;
		const observability = await Bun.file(`${cwd}/workflow-output/omh-runtime/observability.json`).json();
		expect(observability).toMatchObject({
			version: 1,
			activations: [
				{
					activationId: "build:activation-1",
					nodeId: "build",
					type: "agent",
					status: "completed",
					summary: "agent produced a bounded patch",
					artifacts: ["agent-output://agent-build", mirroredOutput, mirroredSession],
				},
			],
		});
		expect(await Bun.file(mirroredOutputPath).text()).toBe("build markdown transcript");
		expect(await Bun.file(mirroredSessionPath).text()).toBe('{"type":"session"}\n');
		const progress = await Bun.file(`${cwd}/workflow-output/omh-runtime/progress.md`).text();
		expect(progress).toContain("## Completed Activations");
		expect(progress).toContain("build");
		expect(progress).toContain("agent-output://agent-build");
		expect(progress).toContain(mirroredOutput);
		expect(progress).not.toContain(mirroredOutputPath);
		expect(progress).not.toContain(`${cwd}/.agent-output/build.md`);
		expect(progress).not.toContain(`local://${cwd}/.agent-output/build.md`);
	});

	it("keeps runtime observability authoritative when agents write the runtime directory", async () => {
		using tempDir = TempDir.createSync("@omh-workflow-observability-owned-");
		const cwd = tempDir.path();
		const host = createSessionWorkflowRuntimeHost({
			cwd,
			runAgentTask: async request => {
				if (request.nodeId === "build") {
					await Bun.write(
						`${cwd}/workflow-output/omh-runtime/observability.json`,
						`${JSON.stringify(
							{
								version: 1,
								activations: [
									{
										ts: "2026-06-28T00:00:00.000Z",
										activationId: "build:activation-1",
										nodeId: "implementationRound",
										type: "agent",
										status: "completed",
										summary: "agent-authored runtime progress",
										artifacts: ["workflow-output/agent-authored-evidence.md"],
									},
								],
								lifecycle: [],
							},
							null,
							2,
						)}\n`,
					);
					await Bun.write(`${cwd}/workflow-output/omh-runtime/progress.md`, "# Agent-authored runtime progress\n");
				}
				return {
					exitCode: 0,
					output: JSON.stringify({ summary: `${request.nodeId} completed` }),
				};
			},
		});
		if (host.runAgentNode === undefined) throw new Error("agent runtime missing");

		const buildNode: WorkflowNode = { id: "build", type: "agent", prompt: "Build the thing." };
		const reviewNode: WorkflowNode = { id: "review", type: "agent", prompt: "Review the thing." };
		await host.runAgentNode({
			node: buildNode,
			activation: workflowActivation(buildNode.id),
			agent: "builder",
			prompt: buildNode.prompt,
		});
		await host.runAgentNode({
			node: reviewNode,
			activation: workflowActivation(reviewNode.id),
			agent: "reviewer",
			prompt: reviewNode.prompt,
		});

		const observability = await Bun.file(`${cwd}/workflow-output/omh-runtime/observability.json`).json();
		expect(observability.activations.map((activation: { nodeId: string }) => activation.nodeId)).toEqual([
			"build",
			"review",
		]);
		expect(observability.activations.map((activation: { activationId: string }) => activation.activationId)).toEqual([
			"build:activation-1",
			"review:activation-1",
		]);
		const progress = await Bun.file(`${cwd}/workflow-output/omh-runtime/progress.md`).text();
		expect(progress).toContain("build");
		expect(progress).toContain("review");
		expect(progress).not.toContain("implementationRound");
		expect(progress).not.toContain("agent-authored runtime progress");
	});

	it("surfaces recovered transient retries in workflow observability", async () => {
		using tempDir = TempDir.createSync("@omh-workflow-retry-observability-");
		const cwd = tempDir.path();
		let calls = 0;
		const host = createSessionWorkflowRuntimeHost({
			cwd,
			agentTaskRetryPolicy: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
			runAgentTask: async () => {
				calls += 1;
				if (calls === 1) {
					return {
						exitCode: 1,
						output: "",
						error: "Error Code stream_read_error: stream_read_error",
					};
				}
				return {
					exitCode: 0,
					output: JSON.stringify({ summary: "agent recovered after stream retry" }),
				};
			},
		});
		if (host.runAgentNode === undefined) throw new Error("agent runtime missing");

		const node: WorkflowNode = { id: "build", type: "agent", prompt: "Build the thing." };
		await host.runAgentNode({
			node,
			activation: workflowActivation(node.id),
			agent: "builder",
			prompt: node.prompt,
		});

		const observability = await Bun.file(`${cwd}/workflow-output/omh-runtime/observability.json`).json();
		expect(observability.activations[0]).toMatchObject({
			nodeId: "build",
			retries: [
				{
					attempt: 1,
					reason: "Error Code stream_read_error: stream_read_error",
					nextAttempt: 2,
				},
			],
		});
		expect(await Bun.file(`${cwd}/workflow-output/omh-runtime/progress.md`).text()).toContain("recovered retries=1");
	});

	it("keeps workflow progress tables compact while preserving full observability summaries", async () => {
		using tempDir = TempDir.createSync("@omh-workflow-observability-compact-");
		const cwd = tempDir.path();
		const longSummary = `agent produced ${"evidence ".repeat(80)}`;
		const host = createSessionWorkflowRuntimeHost({
			cwd,
			runAgentTask: async () => ({
				exitCode: 0,
				output: JSON.stringify({ summary: longSummary }),
				agentId: "agent-audit",
			}),
		});
		if (host.runAgentNode === undefined) throw new Error("agent runtime missing");

		const node: WorkflowNode = { id: "audit", type: "agent", prompt: "Audit the thing." };
		await host.runAgentNode({
			node,
			activation: workflowActivation(node.id),
			agent: "auditor",
			prompt: node.prompt,
		});

		const observability = await Bun.file(`${cwd}/workflow-output/omh-runtime/observability.json`).json();
		expect(observability.activations[0].summary).toBe(longSummary.trim());
		const progress = await Bun.file(`${cwd}/workflow-output/omh-runtime/progress.md`).text();
		expect(progress).toContain("agent produced evidence evidence");
		expect(progress).toContain("...");
		expect(progress).not.toContain("evidence ".repeat(40));
	});

	it("preserves the human node prompt in activation output for closeout audit", async () => {
		const requests: WorkflowHumanInputRequest[] = [];
		const host = createSessionWorkflowRuntimeHost({
			cwd: "/workspace",
			runHumanInput: async request => {
				requests.push(request);
				return {
					response: "Approve",
					selectedOptions: ["Approve"],
				};
			},
		});
		if (host.runHumanNode === undefined) throw new Error("human runtime missing");

		const node: WorkflowNode = { id: "operatorGate", type: "human", prompt: "Approve the plan after reading it." };
		const output = await host.runHumanNode({
			node,
			activation: workflowActivation(node.id),
			prompt: node.prompt,
		});

		expect(requests).toEqual([
			{
				activationId: "operatorGate:activation-1",
				nodeId: "operatorGate",
				question: "Approve the plan after reading it.",
			},
		]);
		expect(output.data).toMatchObject({
			question: "Approve the plan after reading it.",
			response: "Approve",
			selectedOptions: ["Approve"],
		});
		expect(output.summary).toBe("Approve");
	});

	it("passes the human node abort signal to the human input runner", async () => {
		let capturedRequest: WorkflowHumanInputRequest | undefined;
		const host = createSessionWorkflowRuntimeHost({
			cwd: "/workspace",
			runHumanInput: async request => {
				capturedRequest = request;
				return { response: "Reject", selectedOptions: ["Reject"] };
			},
		});
		if (host.runHumanNode === undefined) throw new Error("human runtime missing");

		const controller = new AbortController();
		const node: WorkflowNode = { id: "operatorGate", type: "human", prompt: "Approve the plan." };
		await host.runHumanNode({
			node,
			activation: workflowActivation(node.id),
			prompt: node.prompt,
			signal: controller.signal,
		});

		expect(capturedRequest?.signal).toBe(controller.signal);
	});

	it("retries transient provider failures for review nodes before parsing verdicts", async () => {
		let calls = 0;
		const host = createSessionWorkflowRuntimeHost({
			cwd: "/workspace",
			agentTaskRetryPolicy: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
			runAgentTask: async () => {
				calls += 1;
				if (calls === 1) {
					return {
						exitCode: 1,
						output: "",
						stderr: "503 Service Unavailable from upstream provider",
					};
				}
				return {
					exitCode: 0,
					output: "COMPLETE\nLooks good after retry.",
				};
			},
		});
		if (host.runReviewNode === undefined) throw new Error("review runtime missing");

		const node: WorkflowNode = {
			id: "review",
			type: "review",
			prompt: "Review the thing.",
			gates: ["CONTINUE", "COMPLETE"],
		};
		const output = await host.runReviewNode({
			node,
			activation: workflowActivation(node.id),
			prompt: node.prompt,
			gates: node.gates,
		});

		expect(calls).toBe(2);
		expect(output.verdict).toBe("COMPLETE");
	});

	it("retries review schema violations before accepting a valid review", async () => {
		let calls = 0;
		const host = createSessionWorkflowRuntimeHost({
			cwd: "/workspace",
			agentTaskRetryPolicy: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
			runAgentTask: async () => {
				calls += 1;
				if (calls === 1) {
					return {
						exitCode: 1,
						output: JSON.stringify({
							error: "schema_violation",
							message: "explanation: is required",
							missingRequired: ["explanation", "confidence"],
							data: JSON.stringify({ overall_correctness: "correct" }),
						}),
						stderr: "schema_violation: missing required fields: explanation, confidence",
					};
				}
				return {
					exitCode: 0,
					output: JSON.stringify({
						overall_correctness: "correct",
						explanation: "verdict finish\nValidation evidence is complete.",
						confidence: 0.92,
					}),
				};
			},
		});
		if (host.runReviewNode === undefined) throw new Error("review runtime missing");

		const node: WorkflowNode = {
			id: "review",
			type: "review",
			prompt: "Review the thing.",
			gates: ["continue", "finish"],
			fallbackVerdict: "continue",
		};
		const output = await host.runReviewNode({
			node,
			activation: workflowActivation(node.id),
			prompt: node.prompt,
			gates: node.gates,
			fallbackVerdict: node.fallbackVerdict,
		});

		expect(calls).toBe(2);
		expect(output.verdict).toBe("finish");
		expect(output.retryHistory).toHaveLength(1);
		expect(output.retryHistory?.[0]?.reason).toContain("schema_violation");
	});

	it("recovers repeated schema-invalid reviewer correctness after a bounded retry", async () => {
		let calls = 0;
		const delays: number[] = [];
		const host = createSessionWorkflowRuntimeHost({
			cwd: "/workspace",
			agentTaskRetryPolicy: { maxAttempts: 6, baseDelayMs: 10_000, maxDelayMs: 60_000 },
			retryDelay: async delayMs => {
				delays.push(delayMs);
			},
			runAgentTask: async () => {
				calls += 1;
				return {
					exitCode: 1,
					output: JSON.stringify({
						error: "schema_violation",
						message: "explanation: is required",
						missingRequired: ["explanation", "confidence"],
						data: JSON.stringify({ overall_correctness: "correct" }),
					}),
					stderr: "schema_violation: missing required fields: explanation, confidence",
				};
			},
		});
		if (host.runReviewNode === undefined) throw new Error("review runtime missing");

		const node: WorkflowNode = {
			id: "testReview",
			type: "review",
			prompt: "Return finish only with schema-valid test evidence.",
			gates: ["continue", "finish"],
			fallbackVerdict: "continue",
		};

		const output = await host.runReviewNode({
			node,
			activation: workflowActivation(node.id),
			prompt: node.prompt,
			gates: node.gates,
			fallbackVerdict: node.fallbackVerdict,
		});

		expect(calls).toBe(2);
		expect(delays).toEqual([]);
		expect(output.verdict).toBe("finish");
		expect(output.summary).toContain("recovered schema_violation as verdict finish");
		expect(output.retryHistory).toHaveLength(1);
	});

	it("uses the first non-empty line as the verdict before falling back", async () => {
		const host = createSessionWorkflowRuntimeHost({
			cwd: "/workspace",
			runAgentTask: async () => ({
				exitCode: 0,
				output: "COMPLETE\nValidation passed after the required loop round.",
			}),
		});
		if (host.runReviewNode === undefined) throw new Error("review runtime missing");

		const node: WorkflowNode = {
			id: "reviewAuditEvents",
			type: "review",
			prompt: "Return a verdict on the first line.",
			gates: ["CONTINUE", "COMPLETE"],
			fallbackVerdict: "CONTINUE",
		};

		const output = await host.runReviewNode({
			node,
			activation: {
				id: "activation-1",
				nodeId: node.id,
				graphRevisionId: "run-1:graph-0",
				status: "running",
				parentActivationIds: [],
			},
			prompt: node.prompt,
			gates: node.gates,
			fallbackVerdict: node.fallbackVerdict,
		});

		expect(output.verdict).toBe("COMPLETE");
		expect(output.summary).toBe("COMPLETE\nValidation passed after the required loop round.");
	});

	it("bridges workflow review gates to the reviewer output schema", async () => {
		let capturedRequest: WorkflowAgentTaskRequest | undefined;
		const host = createSessionWorkflowRuntimeHost({
			cwd: "/workspace",
			runAgentTask: async request => {
				capturedRequest = request;
				return {
					exitCode: 0,
					output: JSON.stringify({
						overall_correctness: "correct",
						explanation: "verdict finish\nThe generated tests are coherent and validation passed.",
						confidence: 0.91,
					}),
				};
			},
		});
		if (host.runReviewNode === undefined) throw new Error("review runtime missing");

		const reviewPrompt = "Return finish only when generated tests are coherent and validation passed.";
		const node: WorkflowNode = {
			id: "testReview",
			type: "review",
			prompt: reviewPrompt,
			gates: ["continue", "finish"],
			fallbackVerdict: "continue",
		};
		const output = await host.runReviewNode({
			node,
			activation: workflowActivation(node.id),
			prompt: node.prompt,
			gates: node.gates,
			fallbackVerdict: node.fallbackVerdict,
		});

		const assignment = capturedRequest?.task.assignment;
		if (assignment === undefined) throw new Error("review assignment missing");
		expect(assignment).toContain("Workflow review adapter:");
		expect(assignment).toContain("one terminal `yield` tool call");
		expect(assignment).toContain('"overall_correctness": "correct" | "incorrect"');
		expect(assignment).toContain('set `type: "result"`');
		expect(assignment).toContain("Do not put a second nested `result` key inside `data`");
		expect(assignment).not.toContain("Use incremental `yield` sections");
		expect(assignment).not.toContain('type: ["overall_correctness"]');
		expect(assignment).toContain("Declared workflow gates: continue, finish");
		expect(assignment).toContain(reviewPrompt);
		expect(assignment.lastIndexOf("Workflow review adapter:")).toBeGreaterThan(assignment.indexOf(reviewPrompt));
		expect(output.verdict).toBe("finish");
	});

	it("keeps reviewer schema instructions after text-verdict workflow prompts", async () => {
		let capturedRequest: WorkflowAgentTaskRequest | undefined;
		const host = createSessionWorkflowRuntimeHost({
			cwd: "/workspace",
			runAgentTask: async request => {
				capturedRequest = request;
				return {
					exitCode: 0,
					output: JSON.stringify({
						overall_correctness: "correct",
						explanation: "verdict finish\nValidation passed with durable evidence.",
						confidence: 0.89,
					}),
				};
			},
		});
		if (host.runReviewNode === undefined) throw new Error("review runtime missing");

		const prompt = [
			"You are the workflow reviewer.",
			"",
			"Output contract:",
			"- First line must be exactly `continue` or `finish`.",
			"- After the first line, include concise review evidence.",
		].join("\n");
		const node: WorkflowNode = {
			id: "fixReview",
			type: "review",
			prompt,
			gates: ["continue", "finish"],
			fallbackVerdict: "continue",
		};
		const output = await host.runReviewNode({
			node,
			activation: workflowActivation(node.id),
			prompt: node.prompt,
			gates: node.gates,
			fallbackVerdict: node.fallbackVerdict,
		});

		const assignment = capturedRequest?.task.assignment;
		if (assignment === undefined) throw new Error("review assignment missing");
		expect(assignment).toContain("First line must be exactly");
		expect(assignment.lastIndexOf('"confidence": 0.0-1.0')).toBeGreaterThan(
			assignment.lastIndexOf("First line must be exactly"),
		);
		expect(assignment).toContain("Do not submit separate section yields");
		expect(assignment).not.toContain("Use incremental `yield` sections");
		expect(output.verdict).toBe("finish");
	});

	it("recovers schema-invalid success review payloads after retry exhaustion", async () => {
		const host = createSessionWorkflowRuntimeHost({
			cwd: "/workspace",
			agentTaskRetryPolicy: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
			runAgentTask: async () => ({
				exitCode: 1,
				output: JSON.stringify(
					{
						error: "schema_violation",
						message: "explanation: is required",
						missingRequired: ["explanation", "confidence"],
						data: JSON.stringify({ overall_correctness: "correct" }),
					},
					null,
					2,
				),
				stderr: "schema_violation: missing required fields: explanation, confidence",
				outputPath: "/tmp/reportReview.md",
				sessionFile: "/tmp/reportReview.jsonl",
			}),
		});
		if (host.runReviewNode === undefined) throw new Error("review runtime missing");

		const node: WorkflowNode = {
			id: "reportReview",
			type: "review",
			prompt: "Return finish only when reproduction evidence is accepted.",
			gates: ["continue", "finish"],
			fallbackVerdict: "continue",
		};

		const output = await host.runReviewNode({
			node,
			activation: workflowActivation(node.id),
			prompt: node.prompt,
			gates: node.gates,
			fallbackVerdict: node.fallbackVerdict,
		});

		expect(output.verdict).toBe("finish");
		expect(output.summary).toContain("recovered schema_violation as verdict finish");
		expect(output.artifacts).toEqual(["/tmp/reportReview.md", "/tmp/reportReview.jsonl"]);
	});

	it("recovers schema-invalid reviewer objects nested under result", async () => {
		const host = createSessionWorkflowRuntimeHost({
			cwd: "/workspace",
			agentTaskRetryPolicy: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
			runAgentTask: async () => ({
				exitCode: 1,
				output: JSON.stringify({
					error: "schema_violation",
					message: "top-level reviewer fields are required",
					missingRequired: ["overall_correctness", "explanation", "confidence"],
					data: JSON.stringify({
						result: {
							data: {
								overall_correctness: "correct",
								explanation: "verdict finish\nReproduction and validation evidence are accepted.",
								confidence: 0.86,
							},
						},
					}),
				}),
				stderr: "schema_violation: missing required fields: overall_correctness, explanation, confidence",
			}),
		});
		if (host.runReviewNode === undefined) throw new Error("review runtime missing");

		const node: WorkflowNode = {
			id: "reportReview",
			type: "review",
			prompt: "Return finish only when reproduction evidence is accepted.",
			gates: ["continue", "finish"],
			fallbackVerdict: "continue",
		};

		const output = await host.runReviewNode({
			node,
			activation: workflowActivation(node.id),
			prompt: node.prompt,
			gates: node.gates,
			fallbackVerdict: node.fallbackVerdict,
		});

		expect(output.verdict).toBe("finish");
		expect(output.summary).toContain("recovered schema_violation as verdict finish");
		expect(output.summary).toContain("Reproduction and validation evidence are accepted.");
	});

	it("recovers declared workflow gates placed in partial reviewer correctness fields", async () => {
		const host = createSessionWorkflowRuntimeHost({
			cwd: "/workspace",
			agentTaskRetryPolicy: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
			runAgentTask: async () => ({
				exitCode: 1,
				output: JSON.stringify({
					error: "schema_violation",
					message: "explanation: is required",
					missingRequired: ["explanation", "confidence"],
					data: JSON.stringify({ overall_correctness: "finish" }),
				}),
				stderr: "schema_violation: missing required fields: explanation, confidence",
			}),
		});
		if (host.runReviewNode === undefined) throw new Error("review runtime missing");

		const node: WorkflowNode = {
			id: "fixReview",
			type: "review",
			prompt: "Return finish only when no-code bug evidence is accepted.",
			gates: ["continue", "finish"],
			fallbackVerdict: "continue",
		};

		const output = await host.runReviewNode({
			node,
			activation: workflowActivation(node.id),
			prompt: node.prompt,
			gates: node.gates,
			fallbackVerdict: node.fallbackVerdict,
		});

		expect(output.verdict).toBe("finish");
		expect(output.summary).toContain("recovered schema_violation as verdict finish");
	});

	it("recovers correct reviewer schema violations to the semantic success gate", async () => {
		const host = createSessionWorkflowRuntimeHost({
			cwd: "/workspace",
			agentTaskRetryPolicy: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
			runAgentTask: async () => ({
				exitCode: 1,
				output: JSON.stringify({
					error: "schema_violation",
					message: "explanation: is required",
					missingRequired: ["explanation", "confidence"],
					data: JSON.stringify({ overall_correctness: "correct" }),
				}),
				stderr: "schema_violation: missing required fields: explanation, confidence",
			}),
		});
		if (host.runReviewNode === undefined) throw new Error("review runtime missing");

		const node: WorkflowNode = {
			id: "reviewRound",
			type: "review",
			prompt: "Return complete only when the build/review loop is done.",
			gates: ["continue", "complete"],
			fallbackVerdict: "continue",
		};

		const output = await host.runReviewNode({
			node,
			activation: workflowActivation(node.id),
			prompt: node.prompt,
			gates: node.gates,
			fallbackVerdict: node.fallbackVerdict,
		});

		expect(output.verdict).toBe("complete");
		expect(output.summary).toContain("recovered schema_violation as verdict complete");
	});

	it("recovers findings-only reviewer schema violations to a semantic repair gate", async () => {
		const host = createSessionWorkflowRuntimeHost({
			cwd: "/workspace",
			agentTaskRetryPolicy: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
			runAgentTask: async () => ({
				exitCode: 1,
				output: JSON.stringify({
					error: "schema_violation",
					message: "overall_correctness: is required",
					missingRequired: ["overall_correctness", "explanation", "confidence"],
					data: JSON.stringify({
						findings: [
							{
								title: "Separate top-level tests with two blank lines",
								body: "The newest diff violates project style, so another build round should repair it.",
								priority: 2,
							},
						],
					}),
				}),
				stderr: "schema_violation: missing required fields: overall_correctness, explanation, confidence",
			}),
		});
		if (host.runReviewNode === undefined) throw new Error("review runtime missing");

		const node: WorkflowNode = {
			id: "reviewRound",
			type: "review",
			prompt: "Return complete only when the build/review loop is done.",
			gates: ["complete", "continue"],
			fallbackVerdict: "continue",
		};

		const output = await host.runReviewNode({
			node,
			activation: workflowActivation(node.id),
			prompt: node.prompt,
			gates: node.gates,
			fallbackVerdict: node.fallbackVerdict,
		});

		expect(output.verdict).toBe("continue");
		expect(output.summary).toContain("recovered schema_violation as verdict continue");
		expect(output.summary).toContain("Separate top-level tests with two blank lines");
	});

	it("routes one-line reviewer verdict prefixes before falling back", async () => {
		const result = await runRetryReview("COMPLETE Validation passed after the required loop round.");

		expect(result.scheduler.activations.map(activation => activation.nodeId)).toEqual(["review", "done"]);
		expect(result.scheduler.state).toEqual({ verdict: "COMPLETE" });
	});

	it("does not let a final finish token override an explicit incorrect reviewer verdict", async () => {
		const result = await runPerformanceReview(
			['{"overall_correctness":"incorrect","summary":"validation failed; not ready for selection"}', "finish"].join(
				"\n",
			),
		);

		expect(result.scheduler.activations.map(activation => activation.nodeId)).toEqual(["review", "retry"]);
		expect(result.scheduler.state).toEqual({ verdict: "continue" });
	});

	it("routes reviewer object summary verdict prefixes before falling back", async () => {
		const result = await runRetryReview(
			JSON.stringify({ summary: "COMPLETE Validation passed after the required loop round." }),
		);

		expect(result.scheduler.activations.map(activation => activation.nodeId)).toEqual(["review", "done"]);
		expect(result.scheduler.state).toEqual({ verdict: "COMPLETE" });
	});

	it("passes workflow state and activation context to shell script nodes", async () => {
		const requests: WorkflowShellScriptRequest[] = [];
		const host = createSessionWorkflowRuntimeHost({
			cwd: "/workspace",
			runShellScript: async request => {
				requests.push(request);
				if (request.nodeId === "seed") {
					return {
						exitCode: 0,
						output: JSON.stringify({
							summary: "seeded",
							statePatch: [{ op: "set", path: "/ledger", value: { round: 1 } }],
						}),
					};
				}
				return {
					exitCode: 0,
					output: JSON.stringify({ summary: "ledger observed" }),
				};
			},
		});

		const result = await runWorkflow({
			host: new MemoryWorkflowHost(),
			definition: contextScriptDefinition(),
			runId: "run-1",
			startNodeId: "seed",
			runtimeHost: host,
		});

		expect(requests).toHaveLength(2);
		expect(requests[1]?.context).toEqual({
			activation: {
				id: "activation-2",
				nodeId: "record",
				graphRevisionId: "run-1:graph-0",
				parentActivationIds: ["activation-1"],
			},
			node: {
				id: "record",
				type: "script",
			},
			state: {
				ledger: {
					round: 1,
				},
			},
			completedActivations: [
				{
					id: "activation-1",
					nodeId: "seed",
					graphRevisionId: "run-1:graph-0",
					status: "completed",
					parentActivationIds: [],
					output: {
						summary: "seeded",
						statePatch: [{ op: "set", path: "/ledger", value: { round: 1 } }],
					},
				},
			],
		});
		expect(result.scheduler.state).toEqual({ ledger: { round: 1 } });
	});

	it("exposes materialized frozen resources to shell script nodes", async () => {
		const requests: WorkflowShellScriptRequest[] = [];
		const host = createSessionWorkflowRuntimeHost({
			cwd: "/workspace",
			runShellScript: async request => {
				requests.push(request);
				if (request.resourceDir === undefined) {
					return { exitCode: 1, output: "", error: "missing workflow resource directory" };
				}
				const text = await Bun.file(`${request.resourceDir}/fixtures/message.txt`).text();
				return {
					exitCode: 0,
					output: JSON.stringify({
						summary: "resource observed",
						statePatch: [{ op: "set", path: "/resourceText", value: text }],
					}),
				};
			},
		});

		const result = await runWorkflow({
			host: new MemoryWorkflowHost(),
			definition: frozenResourceDefinition(),
			runId: "run-resource",
			startNodeId: "readResource",
			runtimeHost: host,
			frozenResources: [
				{
					path: "fixtures/message.txt",
					hash: "sha256:test",
					text: "hello resource\n",
					byteLength: 15,
				},
			],
		});

		expect(result.scheduler.state).toEqual({ resourceText: "hello resource\n" });
		expect(requests[0]?.resourceDir).toBeDefined();
		expect(requests[0]?.context?.resources?.root).toBe(requests[0]?.resourceDir);
	});

	it("exposes workflow context to js eval script nodes", async () => {
		const host = createSessionWorkflowRuntimeHost({
			cwd: "/workspace",
			runEvalScript: async request => {
				const AsyncFunctionConstructor = Object.getPrototypeOf(async () => {}).constructor as new (
					consoleName: string,
					code: string,
				) => (consoleValue: { log: (...items: unknown[]) => void }) => Promise<unknown>;
				const logs: string[] = [];
				const logger = {
					log: (...items: unknown[]) => {
						logs.push(items.map(item => String(item)).join(" "));
					},
				};
				const execute = new AsyncFunctionConstructor("console", request.code).bind(undefined, logger);
				await execute();
				return {
					exitCode: 0,
					output: logs.join("\n"),
				};
			},
		});

		const result = await runWorkflow({
			host: new MemoryWorkflowHost(),
			definition: contextEvalDefinition(),
			runId: "run-1",
			startNodeId: "seed",
			runtimeHost: host,
		});

		expect(result.scheduler.state).toEqual({ ledger: { round: 3 } });
	});

	it("passes the node abort signal to js eval script nodes", async () => {
		const requests: WorkflowScriptEvalRequest[] = [];
		const controller = new AbortController();
		const host = createSessionWorkflowRuntimeHost({
			cwd: "/workspace",
			runEvalScript: async request => {
				requests.push(request);
				return { exitCode: 0, output: JSON.stringify({ summary: "ok" }) };
			},
		});

		await runWorkflow({
			host: new MemoryWorkflowHost(),
			definition: singleEvalDefinition(),
			runId: "run-eval-abort-signal",
			startNodeId: "longEval",
			runtimeHost: host,
			nodeAbortSignal: controller.signal,
		});

		expect(requests[0]?.signal).toBe(controller.signal);
	});

	it("captures returned js workflow script objects through the real eval tool runner", async () => {
		using tempDir = TempDir.createSync("@omp-workflow-eval-context-");
		const settings = await Settings.init();
		const session: ToolSession = {
			cwd: tempDir.path(),
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => null,
			settings,
		};
		const host = createSessionWorkflowRuntimeHost({
			cwd: tempDir.path(),
			runEvalScript: createEvalToolScriptRunner(session),
		});

		const result = await runWorkflow({
			host: new MemoryWorkflowHost(),
			definition: contextEvalDefinition(),
			runId: "run-real-eval",
			startNodeId: "seed",
			runtimeHost: host,
		});

		expect(result.scheduler.state).toEqual({ ledger: { round: 3 } });
	});

	it("isolates Python user-site pollution for child processes spawned by js workflow scripts", async () => {
		using tempDir = TempDir.createSync("@omp-workflow-eval-python-env-");
		const previousPythonPath = Bun.env.PYTHONPATH;
		const previousPythonNoUserSite = Bun.env.PYTHONNOUSERSITE;
		Bun.env.PYTHONPATH = "/stale/editable/site";
		delete Bun.env.PYTHONNOUSERSITE;
		try {
			const settings = await Settings.init();
			const session: ToolSession = {
				cwd: tempDir.path(),
				hasUI: false,
				getSessionFile: () => null,
				getSessionSpawns: () => null,
				settings,
			};
			const host = createSessionWorkflowRuntimeHost({
				cwd: tempDir.path(),
				runEvalScript: createEvalToolScriptRunner(session),
			});

			const result = await runWorkflow({
				host: new MemoryWorkflowHost(),
				definition: jsSpawnEnvDefinition(),
				runId: "run-real-eval-python-env",
				startNodeId: "checkEnv",
				runtimeHost: host,
			});

			expect(result.scheduler.state).toEqual({ pythonEnv: "1:unset" });
		} finally {
			if (previousPythonPath === undefined) delete Bun.env.PYTHONPATH;
			else Bun.env.PYTHONPATH = previousPythonPath;
			if (previousPythonNoUserSite === undefined) delete Bun.env.PYTHONNOUSERSITE;
			else Bun.env.PYTHONNOUSERSITE = previousPythonNoUserSite;
		}
	});

	it("does not pass serialized workflow context to child processes spawned by js workflow scripts", async () => {
		using tempDir = TempDir.createSync("@omp-workflow-eval-context-child-env-");
		const settings = await Settings.init();
		const session: ToolSession = {
			cwd: tempDir.path(),
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => null,
			settings,
		};
		const host = createSessionWorkflowRuntimeHost({
			cwd: tempDir.path(),
			runEvalScript: createEvalToolScriptRunner(session),
		});

		const result = await runWorkflow({
			host: new MemoryWorkflowHost(),
			definition: jsWorkflowContextChildEnvDefinition(),
			runId: "run-real-eval-context-child-env",
			startNodeId: "seed",
			runtimeHost: host,
		});

		expect(result.scheduler.state).toMatchObject({
			ledger: { round: 9 },
			contextChildEnv: "clean",
		});
	});

	it("gives js workflow script nodes the workflow script timeout by default", async () => {
		const calls: EvalToolParams[] = [];
		const executeSpy = spyOn(EvalTool.prototype, "execute").mockImplementation(async (_toolCallId, params) => {
			calls.push(params);
			return {
				content: [{ type: "text", text: "ok" }],
				details: undefined,
			};
		});
		try {
			using tempDir = TempDir.createSync("@omp-workflow-eval-timeout-");
			const settings = await Settings.init();
			const session: ToolSession = {
				cwd: tempDir.path(),
				hasUI: false,
				getSessionFile: () => null,
				getSessionSpawns: () => null,
				settings,
			};
			const runner = createEvalToolScriptRunner(session);

			const result = await runner({
				activationId: "activation-timeout-js",
				nodeId: "runValidation",
				code: "return { summary: 'ok' };",
				language: "js",
				title: "run-validation.js",
			});

			expect(result.exitCode).toBe(0);
			expect(calls[0]?.timeout).toBe(3600);
		} finally {
			executeSpy.mockRestore();
		}
	});

	it("cancels a running js workflow script through the real eval tool runner", async () => {
		using tempDir = TempDir.createSync("@omp-workflow-eval-cancel-");
		const settings = await Settings.init();
		const session: ToolSession = {
			cwd: tempDir.path(),
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => null,
			settings,
		};
		const runner = createEvalToolScriptRunner(session);
		const controller = new AbortController();
		const startedAt = performance.now();
		const abortSoon = Bun.sleep(50).then(() => controller.abort("stop workflow"));

		const result = await runner({
			activationId: "activation-cancel-js",
			nodeId: "longEval",
			code: 'await Bun.sleep(10_000); return { summary: "should-not-finish" };',
			language: "js",
			title: "long-eval.js",
			timeoutMs: 5_000,
			signal: controller.signal,
		});
		await abortSoon;

		expect(performance.now() - startedAt).toBeLessThan(2_000);
		expect(result.exitCode).toBe(1);
		expect(result.error).toBeDefined();
		expect(result.output).not.toContain("should-not-finish");
	});
});

function workflowActivation(nodeId: string) {
	return {
		id: `${nodeId}:activation-1`,
		nodeId,
		graphRevisionId: "run-1:graph-0",
		status: "running" as const,
		parentActivationIds: [],
	};
}

async function runRetryReview(reviewOutput: string) {
	const host = createSessionWorkflowRuntimeHost({
		cwd: "/workspace",
		runAgentTask: async () => ({
			exitCode: 0,
			output: reviewOutput,
		}),
		runShellScript: async input => ({
			exitCode: 0,
			output: `${input.nodeId} completed`,
		}),
	});

	return runWorkflow({
		host: new MemoryWorkflowHost(),
		definition: retryReviewDefinition(),
		runId: "run-1",
		startNodeId: "review",
		runtimeHost: host,
	});
}

async function runPerformanceReview(reviewOutput: string) {
	const host = createSessionWorkflowRuntimeHost({
		cwd: "/workspace",
		runAgentTask: async () => ({
			exitCode: 0,
			output: reviewOutput,
		}),
		runShellScript: async input => ({
			exitCode: 0,
			output: `${input.nodeId} completed`,
		}),
	});

	return runWorkflow({
		host: new MemoryWorkflowHost(),
		definition: performanceReviewDefinition(),
		runId: "run-performance-review",
		startNodeId: "review",
		runtimeHost: host,
	});
}

class MemoryWorkflowHost {
	appendCustomEntry(): string {
		return "entry-1";
	}

	getBranch(): [] {
		return [];
	}
}

function retryReviewDefinition(): WorkflowDefinition {
	return {
		name: "retry-review",
		version: 1,
		models: { roles: {}, defaults: {} },
		nodes: [
			{
				id: "review",
				type: "review",
				prompt: "Return a verdict.",
				gates: ["CONTINUE", "COMPLETE"],
				fallbackVerdict: "CONTINUE",
				writes: ["/verdict"],
			},
			{
				id: "retry",
				type: "script",
				script: { language: "sh", code: "retry" },
			},
			{
				id: "done",
				type: "script",
				script: { language: "sh", code: "done" },
			},
		],
		edges: [
			{ from: "review", to: "retry", condition: { source: 'outputs.review.verdict == "CONTINUE"' } },
			{ from: "review", to: "done", condition: { source: 'outputs.review.verdict != "CONTINUE"' } },
		],
	};
}

function performanceReviewDefinition(): WorkflowDefinition {
	return {
		name: "performance-review",
		version: 1,
		models: { roles: {}, defaults: {} },
		nodes: [
			{
				id: "review",
				type: "review",
				prompt: "Return continue or finish.",
				gates: ["continue", "finish"],
				fallbackVerdict: "continue",
				writes: ["/verdict"],
			},
			{
				id: "retry",
				type: "script",
				script: { language: "sh", code: "retry" },
			},
			{
				id: "done",
				type: "script",
				script: { language: "sh", code: "done" },
			},
		],
		edges: [
			{ from: "review", to: "retry", condition: { source: 'outputs.review.verdict == "continue"' } },
			{ from: "review", to: "done", condition: { source: 'outputs.review.verdict == "finish"' } },
		],
	};
}

function contextScriptDefinition(): WorkflowDefinition {
	return {
		name: "script-context",
		version: 1,
		models: { roles: {}, defaults: {} },
		nodes: [
			{
				id: "seed",
				type: "script",
				script: { language: "sh", code: "seed" },
				writes: ["/ledger"],
			},
			{
				id: "record",
				type: "script",
				script: { language: "sh", code: "record" },
				reads: ["/ledger"],
				writes: ["/ledger"],
			},
		],
		edges: [{ from: "seed", to: "record" }],
	};
}

function frozenResourceDefinition(): WorkflowDefinition {
	return {
		name: "frozen-resource-context",
		version: 1,
		models: { roles: {}, defaults: {} },
		nodes: [
			{
				id: "readResource",
				type: "script",
				script: { language: "sh", code: "read" },
				writes: ["/resourceText"],
			},
		],
		edges: [],
	};
}

function contextEvalDefinition(): WorkflowDefinition {
	return {
		name: "eval-context",
		version: 1,
		models: { roles: {}, defaults: {} },
		nodes: [
			{
				id: "seed",
				type: "script",
				script: {
					language: "js",
					code: 'return { summary: "seeded", statePatch: [{ op: "set", path: "/ledger", value: { round: 2 } }] };',
				},
				writes: ["/ledger"],
			},
			{
				id: "record",
				type: "script",
				script: {
					language: "js",
					code: [
						"return {",
						'  summary: "eval context observed",',
						"  statePatch: [{",
						'    op: "set",',
						'    path: "/ledger/round",',
						"    value: workflowContext.state.ledger.round + 1,",
						"  }],",
						"};",
					].join("\n"),
				},
				reads: ["/ledger"],
				writes: ["/ledger"],
			},
		],
		edges: [{ from: "seed", to: "record" }],
	};
}

function jsSpawnEnvDefinition(): WorkflowDefinition {
	const pythonNoUserSiteExpansion = "$" + "{PYTHONNOUSERSITE-unset}";
	const pythonPathExpansion = "$" + "{PYTHONPATH-unset}";
	const shellCommand = `printf "%s:%s\\n" "${pythonNoUserSiteExpansion}" "${pythonPathExpansion}"`;
	return {
		name: "eval-child-env",
		version: 1,
		models: { roles: {}, defaults: {} },
		nodes: [
			{
				id: "checkEnv",
				type: "script",
				script: {
					language: "js",
					code: [
						`const proc = Bun.spawn(${JSON.stringify(["sh", "-c", shellCommand])}, { stdout: "pipe", stderr: "pipe" });`,
						"const [stdout, stderr, exitCode] = await Promise.all([",
						"  new Response(proc.stdout).text(),",
						"  new Response(proc.stderr).text(),",
						"  proc.exited,",
						"]);",
						'if (exitCode !== 0) throw new Error(stderr || "child exited " + exitCode);',
						"return {",
						'  summary: "child env observed",',
						'  statePatch: [{ op: "set", path: "/pythonEnv", value: stdout.trim() }],',
						"};",
					].join("\n"),
				},
				writes: ["/pythonEnv"],
			},
		],
		edges: [],
	};
}

function jsWorkflowContextChildEnvDefinition(): WorkflowDefinition {
	const contextExpansion = "$" + "{OMP_WORKFLOW_CONTEXT-clean}";
	const shellCommand = `printf "%s\\n" "${contextExpansion}"`;
	return {
		name: "eval-context-child-env",
		version: 1,
		models: { roles: {}, defaults: {} },
		nodes: [
			{
				id: "seed",
				type: "script",
				script: {
					language: "js",
					code: 'return { summary: "seeded", statePatch: [{ op: "set", path: "/ledger", value: { round: 8 } }] };',
				},
				writes: ["/ledger"],
			},
			{
				id: "checkEnv",
				type: "script",
				script: {
					language: "js",
					code: [
						"const observedRound = workflowContext.state.ledger.round + 1;",
						`const proc = Bun.spawn(${JSON.stringify(["sh", "-c", shellCommand])}, { stdout: "pipe", stderr: "pipe" });`,
						"const [stdout, stderr, exitCode] = await Promise.all([",
						"  new Response(proc.stdout).text(),",
						"  new Response(proc.stderr).text(),",
						"  proc.exited,",
						"]);",
						'if (exitCode !== 0) throw new Error(stderr || "child exited " + exitCode);',
						"return {",
						'  summary: "workflow context stayed local to js runtime",',
						"  statePatch: [",
						'    { op: "set", path: "/ledger/round", value: observedRound },',
						'    { op: "set", path: "/contextChildEnv", value: stdout.trim() },',
						"  ],",
						"};",
					].join("\n"),
				},
				reads: ["/ledger"],
				writes: ["/ledger", "/contextChildEnv"],
			},
		],
		edges: [{ from: "seed", to: "checkEnv" }],
	};
}

function singleEvalDefinition(): WorkflowDefinition {
	return {
		name: "single-eval",
		version: 1,
		models: { roles: {}, defaults: {} },
		nodes: [
			{
				id: "longEval",
				type: "script",
				script: {
					language: "js",
					code: 'return { summary: "ok" };',
				},
			},
		],
		edges: [],
	};
}
