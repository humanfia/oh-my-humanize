import { describe, expect, it } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../../config/settings";
import type { ToolSession } from "../../tools";
import type { WorkflowDefinition, WorkflowNode } from "../definition";
import { createEvalToolScriptRunner } from "../eval-tool-runtime";
import { runWorkflow } from "../runner";
import { createSessionWorkflowRuntimeHost, type WorkflowShellScriptRequest } from "../session-runtime";

describe("createSessionWorkflowRuntimeHost review nodes", () => {
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
});

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
