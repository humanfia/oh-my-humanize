import { describe, expect, it, spyOn } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../../config/settings";
import type { ToolSession } from "../../tools";
import { EvalTool, type EvalToolParams } from "../../tools/eval";
import type { WorkflowDefinition, WorkflowNode } from "../definition";
import { createEvalToolScriptRunner } from "../eval-tool-runtime";
import { runWorkflow } from "../runner";
import {
	createSessionWorkflowRuntimeHost,
	type WorkflowHumanInputRequest,
	type WorkflowScriptEvalRequest,
	type WorkflowShellScriptRequest,
} from "../session-runtime";

describe("createSessionWorkflowRuntimeHost review nodes", () => {
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

	it("writes a project-local workflow observability index for completed agent nodes", async () => {
		using tempDir = TempDir.createSync("@omh-workflow-observability-");
		const cwd = tempDir.path();
		const host = createSessionWorkflowRuntimeHost({
			cwd,
			runAgentTask: async () => ({
				exitCode: 0,
				output: JSON.stringify({ summary: "agent produced a bounded patch" }),
				agentId: "agent-build",
				outputPath: `${cwd}/.agent-output/build.md`,
				sessionFile: `${cwd}/.omh/sessions/build.jsonl`,
			}),
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
		expect(observability).toMatchObject({
			version: 1,
			activations: [
				{
					activationId: "build:activation-1",
					nodeId: "build",
					type: "agent",
					status: "completed",
					summary: "agent produced a bounded patch",
					artifacts: [
						"agent-output://agent-build",
						`${cwd}/.agent-output/build.md`,
						`${cwd}/.omh/sessions/build.jsonl`,
					],
				},
			],
		});
		const progress = await Bun.file(`${cwd}/workflow-output/omh-runtime/progress.md`).text();
		expect(progress).toContain("## Completed Activations");
		expect(progress).toContain("build");
		expect(progress).toContain("agent-output://agent-build");
		expect(progress).toContain(`${cwd}/.agent-output/build.md`);
		expect(progress).not.toContain(`local://${cwd}/.agent-output/build.md`);
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
