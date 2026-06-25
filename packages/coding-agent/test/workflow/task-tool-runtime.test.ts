import { afterEach, describe, expect, it, vi } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Settings } from "../../src/config/settings";
import type { TaskParams, TaskToolDetails } from "../../src/task";
import * as taskModule from "../../src/task";
import type { ToolSession } from "../../src/tools";
import type { WorkflowAgentTaskRequest } from "../../src/workflow/session-runtime";
import { createTaskToolAgentRunner } from "../../src/workflow/task-tool-runtime";

afterEach(() => {
	vi.restoreAllMocks();
});

function createToolSession(settings: Settings = Settings.isolated()): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings,
	};
}

function createRequest(): WorkflowAgentTaskRequest {
	return {
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
	};
}

describe("workflow task tool runtime adapter", () => {
	it("runs a workflow agent task through TaskTool and returns the first task result", async () => {
		let capturedParams: TaskParams | undefined;
		const outputPath = path.join(os.tmpdir(), "agent-output.md");
		const sessionFile = path.join(os.tmpdir(), "agent-session.jsonl");
		const taskTool = {
			execute: async (_toolCallId: string, params: unknown): Promise<AgentToolResult<TaskToolDetails>> => {
				capturedParams = params as TaskParams;
				return {
					content: [{ type: "text", text: "task tool completed" }],
					details: {
						projectAgentsDir: null,
						totalDurationMs: 12,
						results: [
							{
								index: 0,
								id: "build",
								agent: "task",
								agentSource: "project",
								task: "Implement the workflow feature.",
								assignment: "Implement the workflow feature.",
								description: "Builder · Build",
								exitCode: 0,
								output: "agent completed",
								stderr: "",
								truncated: false,
								durationMs: 12,
								tokens: 0,
								requests: 1,
								outputPath,
								sessionFile,
							},
						],
					},
				};
			},
		};
		vi.spyOn(taskModule.TaskTool, "create").mockResolvedValue(taskTool as unknown as taskModule.TaskTool);
		const runner = createTaskToolAgentRunner(createToolSession());

		const result = await runner(createRequest());

		expect(capturedParams).toEqual({
			agent: "task",
			id: "build",
			description: "Builder · Build",
			role: "Builder · Build",
			assignment: "Implement the workflow feature.",
			modelOverride: "openai/gpt-4o",
			modelOverrideAuthFallback: false,
		});
		expect(result).toEqual({
			exitCode: 0,
			output: "agent completed",
			stderr: "",
			agentId: "build",
			outputPath,
			sessionFile,
		});
	});

	it("preserves the final successful yield data for workflow agent nodes", async () => {
		const taskTool = {
			execute: async (): Promise<AgentToolResult<TaskToolDetails>> => ({
				content: [{ type: "text", text: "task tool completed" }],
				details: {
					projectAgentsDir: null,
					totalDurationMs: 12,
					results: [
						{
							index: 0,
							id: "build",
							agent: "task",
							agentSource: "project",
							task: "Implement the workflow feature.",
							assignment: "Implement the workflow feature.",
							description: "Builder · Build",
							exitCode: 0,
							output: "agent completed",
							stderr: "",
							truncated: false,
							durationMs: 12,
							tokens: 0,
							requests: 1,
							extractedToolData: {
								yield: [
									{ data: { status: "draft" }, status: "success" },
									{
										data: {
											status: "verified",
											verification: [{ command: "bun test", result: "pass" }],
										},
										status: "success",
									},
								],
							},
						},
					],
				},
			}),
		};
		vi.spyOn(taskModule.TaskTool, "create").mockResolvedValue(taskTool as unknown as taskModule.TaskTool);
		const runner = createTaskToolAgentRunner(createToolSession());

		const result = await runner(createRequest());

		expect(result.data).toEqual({
			status: "verified",
			verification: [{ command: "bun test", result: "pass" }],
		});
	});

	it("keeps workflow task execution synchronous when parent async tasks are enabled", async () => {
		const parentSettings = Settings.isolated({ "async.enabled": true });
		let capturedSession: ToolSession | undefined;
		const taskTool = {
			execute: async (): Promise<AgentToolResult<TaskToolDetails>> => ({
				content: [{ type: "text", text: "task tool completed" }],
				details: {
					projectAgentsDir: null,
					totalDurationMs: 12,
					results: [
						{
							index: 0,
							id: "build",
							agent: "task",
							agentSource: "project",
							task: "Implement the workflow feature.",
							assignment: "Implement the workflow feature.",
							description: "Builder · Build",
							exitCode: 0,
							output: "agent completed",
							stderr: "",
							truncated: false,
							durationMs: 12,
							tokens: 0,
							requests: 1,
						},
					],
				},
			}),
		};
		vi.spyOn(taskModule.TaskTool, "create").mockImplementation(async session => {
			capturedSession = session;
			return taskTool as unknown as taskModule.TaskTool;
		});
		const runner = createTaskToolAgentRunner(createToolSession(parentSettings));

		const result = await runner(createRequest());

		expect(result.exitCode).toBe(0);
		expect(capturedSession?.settings.get("async.enabled")).toBe(false);
		expect(parentSettings.get("async.enabled")).toBe(true);
	});

	it("uses a conservative retry profile for workflow-owned task agents", async () => {
		const parentSettings = Settings.isolated({
			"retry.baseDelayMs": 500,
			"retry.maxDelayMs": 5_000,
		});
		let capturedSession: ToolSession | undefined;
		const taskTool = {
			execute: async (): Promise<AgentToolResult<TaskToolDetails>> => ({
				content: [{ type: "text", text: "task tool completed" }],
				details: {
					projectAgentsDir: null,
					totalDurationMs: 12,
					results: [
						{
							index: 0,
							id: "build",
							agent: "task",
							agentSource: "project",
							task: "Implement the workflow feature.",
							assignment: "Implement the workflow feature.",
							description: "Builder · Build",
							exitCode: 0,
							output: "agent completed",
							stderr: "",
							truncated: false,
							durationMs: 12,
							tokens: 0,
							requests: 1,
						},
					],
				},
			}),
		};
		vi.spyOn(taskModule.TaskTool, "create").mockImplementation(async session => {
			capturedSession = session;
			return taskTool as unknown as taskModule.TaskTool;
		});
		const runner = createTaskToolAgentRunner(createToolSession(parentSettings));

		const result = await runner(createRequest());

		expect(result.exitCode).toBe(0);
		expect(capturedSession?.settings.get("retry.baseDelayMs")).toBe(30_000);
		expect(capturedSession?.settings.get("retry.maxDelayMs")).toBe(300_000);
		expect(parentSettings.get("retry.baseDelayMs")).toBe(500);
		expect(parentSettings.get("retry.maxDelayMs")).toBe(5_000);
	});

	it("parks workflow-owned agents after synchronous task results", async () => {
		let capturedSession: ToolSession | undefined;
		const taskTool = {
			execute: async (): Promise<AgentToolResult<TaskToolDetails>> => ({
				content: [{ type: "text", text: "task tool completed" }],
				details: {
					projectAgentsDir: null,
					totalDurationMs: 12,
					results: [
						{
							index: 0,
							id: "build",
							agent: "task",
							agentSource: "project",
							task: "Implement the workflow feature.",
							assignment: "Implement the workflow feature.",
							description: "Builder · Build",
							exitCode: 0,
							output: "agent completed",
							stderr: "",
							truncated: false,
							durationMs: 12,
							tokens: 0,
							requests: 1,
						},
					],
				},
			}),
		};
		vi.spyOn(taskModule.TaskTool, "create").mockImplementation(async session => {
			capturedSession = session;
			return taskTool as unknown as taskModule.TaskTool;
		});
		const runner = createTaskToolAgentRunner(createToolSession());

		const result = await runner(createRequest());

		expect(result.exitCode).toBe(0);
		expect(capturedSession?.taskAgentCompletionLifecycle).toBe("park");
	});

	it("passes workflow abort signals into TaskTool execution", async () => {
		const controller = new AbortController();
		let capturedSignal: AbortSignal | undefined;
		const taskTool = {
			execute: async (
				_toolCallId: string,
				_params: unknown,
				signal?: AbortSignal,
			): Promise<AgentToolResult<TaskToolDetails>> => {
				capturedSignal = signal;
				return {
					content: [{ type: "text", text: "task tool completed" }],
					details: {
						projectAgentsDir: null,
						totalDurationMs: 12,
						results: [
							{
								index: 0,
								id: "build",
								agent: "task",
								agentSource: "project",
								task: "Implement the workflow feature.",
								assignment: "Implement the workflow feature.",
								description: "Builder · Build",
								exitCode: 0,
								output: "agent completed",
								stderr: "",
								truncated: false,
								durationMs: 12,
								tokens: 0,
								requests: 1,
							},
						],
					},
				};
			},
		};
		vi.spyOn(taskModule.TaskTool, "create").mockResolvedValue(taskTool as unknown as taskModule.TaskTool);
		const runner = createTaskToolAgentRunner(createToolSession());

		const request = {
			...createRequest(),
			signal: controller.signal,
		};
		await runner(request);

		expect(capturedSignal).toBe(controller.signal);
	});
});
