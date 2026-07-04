import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { startAuthGateway } from "@oh-my-pi/pi-ai/auth-gateway";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { claudeCodeSystemInstruction } from "@oh-my-pi/pi-ai/providers/anthropic";
import { encodeResponse, encodeStream, parseRequest } from "@oh-my-pi/pi-ai/providers/anthropic-messages-server";
import type { AssistantMessage, AssistantMessageEvent, ToolResultMessage } from "@oh-my-pi/pi-ai/types";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

function emptyUsage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function makeStream(events: AssistantMessageEvent[]): AssistantMessageEventStream {
	const s = new AssistantMessageEventStream();
	queueMicrotask(() => {
		for (const ev of events) s.push(ev);
		s.end();
	});
	return s;
}

interface SseEvent {
	event: string;
	data: Record<string, unknown>;
}

async function collectSse(stream: ReadableStream<Uint8Array>): Promise<SseEvent[]> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buf = "";
	const out: SseEvent[] = [];
	while (true) {
		const { value, done } = await reader.read();
		if (done) break;
		buf += decoder.decode(value, { stream: true });
	}
	buf += decoder.decode();
	for (const chunk of buf.split("\n\n")) {
		if (!chunk.trim()) continue;
		let event = "";
		let dataLine = "";
		for (const line of chunk.split("\n")) {
			if (line.startsWith("event: ")) event = line.slice(7);
			else if (line.startsWith("data: ")) dataLine = line.slice(6);
		}
		out.push({ event, data: JSON.parse(dataLine) as Record<string, unknown> });
	}
	return out;
}

describe("anthropic-messages parseRequest", () => {
	it("parses system + user + assistant(thinking,text,tool_use) + tool_result", () => {
		const parsed = parseRequest({
			model: "claude-opus-4-7",
			max_tokens: 1024,
			temperature: 0.2,
			top_p: 0.9,
			stop_sequences: ["\n\n"],
			tool_choice: { type: "any" },
			thinking: { type: "enabled", budget_tokens: 2048 },
			output_config: { task_budget: { type: "tokens", total: 64_000, remaining: 60_000 } },
			system: [
				{ type: "text", text: "You are X" },
				{ type: "text", text: "Be brief." },
			],
			tools: [
				{
					name: "lookup",
					description: "find a thing",
					input_schema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
				},
			],
			messages: [
				{ role: "user", content: "hi" },
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "hmm", signature: "sig-1" },
						{ type: "redacted_thinking", data: "REDACTED" },
						{ type: "text", text: "calling tool" },
						{ type: "tool_use", id: "toolu_abc", name: "lookup", input: { q: "x" } },
					],
				},
				{
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: "toolu_abc",
							content: [{ type: "text", text: "result text" }],
							is_error: false,
						},
					],
				},
				{
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: "toolu_def",
							content: "string body",
							is_error: true,
						},
						{ type: "text", text: "and another result coming" },
					],
				},
			],
		});

		expect(parsed.modelId).toBe("claude-opus-4-7");
		expect(parsed.stream).toBe(false);
		expect(parsed.context.systemPrompt).toEqual(["You are X\n\nBe brief."]);
		expect(parsed.options.maxOutputTokens).toBe(1024);
		expect(parsed.options.temperature).toBe(0.2);
		expect(parsed.options.topP).toBe(0.9);
		expect(parsed.options.stopSequences).toEqual(["\n\n"]);
		expect(parsed.options.toolChoice).toBe("required");
		expect(parsed.options.explicitThinkingBudgetTokens).toBe(2048);
		expect(parsed.options.taskBudget).toEqual({ type: "tokens", total: 64_000, remaining: 60_000 });
		expect(parsed.options.extra).toBeUndefined();

		expect(parsed.context.tools).toHaveLength(1);
		const tool = parsed.context.tools![0]!;
		expect(tool.name).toBe("lookup");
		expect(tool.description).toBe("find a thing");
		expect(tool.parameters).toEqual({
			type: "object",
			properties: { q: { type: "string" } },
			required: ["q"],
		});

		// messages: user("hi"), assistant(4 blocks), toolResult(toolu_abc),
		// toolResult(toolu_def), user("and another result coming")
		const msgs = parsed.context.messages;
		expect(msgs).toHaveLength(5);

		expect(msgs[0]).toMatchObject({ role: "user", content: "hi" });

		const asst = msgs[1];
		expect(asst.role).toBe("assistant");
		if (asst.role !== "assistant") throw new Error();
		expect(asst.content).toEqual([
			{ type: "thinking", thinking: "hmm", thinkingSignature: "sig-1" },
			{ type: "redactedThinking", data: "REDACTED" },
			{ type: "text", text: "calling tool" },
			{ type: "toolCall", id: "toolu_abc", name: "lookup", arguments: { q: "x" } },
		]);
		expect(asst.api).toBe("anthropic-messages");
		expect(asst.provider).toBe("anthropic");
		expect(asst.model).toBe("claude-opus-4-7");

		const tr1 = msgs[2] as ToolResultMessage;
		expect(tr1.role).toBe("toolResult");
		expect(tr1.toolCallId).toBe("toolu_abc");
		expect(tr1.isError).toBe(false);
		expect(tr1.content).toEqual([{ type: "text", text: "result text" }]);

		const tr2 = msgs[3] as ToolResultMessage;
		expect(tr2.role).toBe("toolResult");
		expect(tr2.toolCallId).toBe("toolu_def");
		expect(tr2.isError).toBe(true);
		expect(tr2.content).toEqual([{ type: "text", text: "string body" }]);

		expect(msgs[4]).toMatchObject({ role: "user", content: "and another result coming" });
	});

	it("maps tool_choice variants and suppresses user wrappers that hold only tool_result", () => {
		const auto = parseRequest({
			model: "m",
			max_tokens: 8,
			tool_choice: { type: "auto" },
			messages: [{ role: "user", content: "hi" }],
		});
		expect(auto.options.toolChoice).toBe("auto");

		const named = parseRequest({
			model: "m",
			max_tokens: 8,
			tool_choice: { type: "tool", name: "lookup" },
			messages: [{ role: "user", content: "hi" }],
		});
		expect(named.options.toolChoice).toEqual({ name: "lookup" });

		const onlyResult = parseRequest({
			model: "m",
			max_tokens: 8,
			messages: [
				{
					role: "user",
					content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "ok" }] }],
				},
			],
		});
		// no user wrapper, just the toolResult
		expect(onlyResult.context.messages).toHaveLength(1);
		expect(onlyResult.context.messages[0]!.role).toBe("toolResult");
	});

	it("splits user text/image blocks into a separate UserMessage before a tool_result", () => {
		const parsed = parseRequest({
			model: "m",
			max_tokens: 8,
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "preface text" },
						{ type: "tool_result", tool_use_id: "t1", content: "ok" },
					],
				},
			],
		});
		// Expect a flush before the tool result: user("preface text") then toolResult(t1).
		expect(parsed.context.messages).toHaveLength(2);
		expect(parsed.context.messages[0]).toMatchObject({ role: "user", content: "preface text" });
		expect(parsed.context.messages[1]!.role).toBe("toolResult");
	});

	it("rejects missing required fields and unsupported request controls", () => {
		expect(() => parseRequest({})).toThrow(/model/);
		expect(() => parseRequest({ model: "m", messages: [] })).toThrow(/max_tokens/);
		expect(() => parseRequest({ model: "m", max_tokens: 1 })).toThrow(/messages/);
		const topK = parseRequest({ model: "m", max_tokens: 1, messages: [{ role: "user", content: "hi" }], top_k: 50 });
		expect(topK.options.topK).toBe(50);
		// `metadata` is tolerated permissively and surfaced on options for
		// downstream forwarding (Anthropic clients ship `metadata.user_id`).
		const withMetadata = parseRequest({
			model: "m",
			max_tokens: 1,
			messages: [{ role: "user", content: "hi" }],
			metadata: { user_id: "u_1" },
		});
		expect(withMetadata.options.extra).toBeUndefined();
		expect(withMetadata.options.metadata).toEqual({ user_id: "u_1" });
	});

	it("rejects malformed known-type blocks instead of passing them through the unknown-block catch-all", () => {
		// `{type:"text", text: 123}` fails the typed schema and must not fall
		// into the loose catch-all (would corrupt history and TypeError downstream).
		expect(() =>
			parseRequest({
				model: "m",
				max_tokens: 1,
				messages: [{ role: "user", content: [{ type: "text", text: 123 }] }],
			}),
		).toThrow();
		expect(() =>
			parseRequest({
				model: "m",
				max_tokens: 1,
				messages: [
					{ role: "user", content: "hi" },
					{ role: "assistant", content: [{ type: "tool_use", id: "", name: "lookup" }] },
				],
			}),
		).toThrow();
		// Genuinely unknown variants are still accepted and flattened.
		const unknown = parseRequest({
			model: "m",
			max_tokens: 1,
			messages: [
				{ role: "user", content: [{ type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: [] }] },
			],
		});
		expect(unknown.context.messages).toHaveLength(1);
	});
});

describe("anthropic-messages encodeResponse", () => {
	it("encodes text + thinking + tool_use with correct ordering and stop_reason mapping", () => {
		const message: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "let me think", thinkingSignature: "sig-xyz" },
				{ type: "text", text: "calling tool now" },
				{ type: "toolCall", id: "toolu_999", name: "lookup", arguments: { q: "hello" } },
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-opus-4-7",
			usage: { ...emptyUsage(), input: 12, output: 34, cacheRead: 5, cacheWrite: 7, totalTokens: 58 },
			stopReason: "toolUse",
			timestamp: 1000,
		};
		const encoded = encodeResponse(message, "claude-opus-4-7");
		expect(encoded.type).toBe("message");
		expect(encoded.role).toBe("assistant");
		expect(encoded.model).toBe("claude-opus-4-7");
		expect(encoded.stop_reason).toBe("tool_use");
		expect(encoded.stop_sequence).toBeNull();
		expect(encoded.usage).toEqual({
			input_tokens: 12,
			output_tokens: 34,
			cache_read_input_tokens: 5,
			cache_creation_input_tokens: 7,
		});
		expect(encoded.content).toEqual([
			{ type: "thinking", thinking: "let me think", signature: "sig-xyz" },
			{ type: "text", text: "calling tool now" },
			{ type: "tool_use", id: "toolu_999", name: "lookup", input: { q: "hello" } },
		]);
		expect(typeof encoded.id).toBe("string");
		expect((encoded.id as string).startsWith("msg_")).toBe(true);
	});

	it("maps stop reasons and rejects upstream terminal errors", () => {
		const base: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "m",
			usage: emptyUsage(),
			stopReason: "stop",
			timestamp: 0,
		};
		expect(encodeResponse({ ...base, stopReason: "stop" }, "m").stop_reason).toBe("end_turn");
		expect(encodeResponse({ ...base, stopReason: "length" }, "m").stop_reason).toBe("max_tokens");
		expect(encodeResponse({ ...base, stopReason: "toolUse" }, "m").stop_reason).toBe("tool_use");
		expect(() => encodeResponse({ ...base, stopReason: "error", errorMessage: "upstream failed" }, "m")).toThrow(
			/upstream failed/,
		);
		expect(() => encodeResponse({ ...base, stopReason: "aborted", errorMessage: "request aborted" }, "m")).toThrow(
			/request aborted/,
		);
	});
});

describe("anthropic-messages encodeStream", () => {
	it("emits thinking_delta + signature_delta + text_delta + tool_use input_json_delta + message_stop", async () => {
		const finalMessage: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "thoughts", thinkingSignature: "SIG" },
				{ type: "text", text: "hi there" },
				{ type: "toolCall", id: "toolu_1", name: "go", arguments: { x: 1 } },
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-opus-4-7",
			usage: { ...emptyUsage(), input: 11, output: 42, cacheRead: 3, cacheWrite: 5 },
			stopReason: "toolUse",
			timestamp: 0,
		};

		const partialAfterThinkingEnd: AssistantMessage = {
			...finalMessage,
			content: [{ type: "thinking", thinking: "thoughts", thinkingSignature: "SIG" }],
		};
		const partialAtToolStart: AssistantMessage = {
			...finalMessage,
			content: [
				{ type: "thinking", thinking: "thoughts", thinkingSignature: "SIG" },
				{ type: "text", text: "hi there" },
				{ type: "toolCall", id: "toolu_1", name: "go", arguments: {} },
			],
		};

		const events: AssistantMessageEvent[] = [
			{ type: "start", partial: finalMessage },
			{ type: "thinking_start", contentIndex: 0, partial: finalMessage },
			{ type: "thinking_delta", contentIndex: 0, delta: "thoughts", partial: finalMessage },
			{ type: "thinking_end", contentIndex: 0, content: "thoughts", partial: partialAfterThinkingEnd },
			{ type: "text_start", contentIndex: 1, partial: finalMessage },
			{ type: "text_delta", contentIndex: 1, delta: "hi ", partial: finalMessage },
			{ type: "text_delta", contentIndex: 1, delta: "there", partial: finalMessage },
			{ type: "text_end", contentIndex: 1, content: "hi there", partial: finalMessage },
			{ type: "toolcall_start", contentIndex: 2, partial: partialAtToolStart },
			{ type: "toolcall_delta", contentIndex: 2, delta: '{"x":', partial: partialAtToolStart },
			{ type: "toolcall_delta", contentIndex: 2, delta: "1}", partial: partialAtToolStart },
			{
				type: "toolcall_end",
				contentIndex: 2,
				toolCall: { type: "toolCall", id: "toolu_1", name: "go", arguments: { x: 1 } },
				partial: finalMessage,
			},
			{ type: "done", reason: "toolUse", message: finalMessage },
		];

		const sse = await collectSse(encodeStream(makeStream(events), "claude-opus-4-7"));

		// Sequence check
		const types = sse.map(e => e.event);
		expect(types).toEqual([
			"message_start",
			"content_block_start",
			"content_block_delta",
			"content_block_delta", // signature_delta
			"content_block_stop",
			"content_block_start",
			"content_block_delta",
			"content_block_delta",
			"content_block_stop",
			"content_block_start",
			"content_block_delta",
			"content_block_delta",
			"content_block_stop",
			"message_delta",
			"message_stop",
		]);

		// message_start payload
		const start = sse[0]!.data as {
			type: string;
			message: { id: string; model: string; role: string; usage: Record<string, unknown> };
		};
		expect(start.type).toBe("message_start");
		expect(start.message.model).toBe("claude-opus-4-7");
		expect(start.message.role).toBe("assistant");
		expect(start.message.id.startsWith("msg_")).toBe(true);
		expect(start.message.usage).toEqual({
			input_tokens: 11,
			output_tokens: 42,
			cache_read_input_tokens: 3,
			cache_creation_input_tokens: 5,
		});

		// thinking block_start
		expect(sse[1]!.data).toEqual({
			type: "content_block_start",
			index: 0,
			content_block: { type: "thinking", thinking: "" },
		});
		expect(sse[2]!.data).toEqual({
			type: "content_block_delta",
			index: 0,
			delta: { type: "thinking_delta", thinking: "thoughts" },
		});
		expect(sse[3]!.data).toEqual({
			type: "content_block_delta",
			index: 0,
			delta: { type: "signature_delta", signature: "SIG" },
		});
		expect(sse[4]!.data).toEqual({ type: "content_block_stop", index: 0 });

		// text block
		expect(sse[5]!.data).toEqual({
			type: "content_block_start",
			index: 1,
			content_block: { type: "text", text: "" },
		});
		expect(sse[6]!.data).toEqual({
			type: "content_block_delta",
			index: 1,
			delta: { type: "text_delta", text: "hi " },
		});

		// tool_use block
		expect(sse[9]!.data).toEqual({
			type: "content_block_start",
			index: 2,
			content_block: { type: "tool_use", id: "toolu_1", name: "go", input: {} },
		});
		expect(sse[10]!.data).toEqual({
			type: "content_block_delta",
			index: 2,
			delta: { type: "input_json_delta", partial_json: '{"x":' },
		});

		// message_delta with mapped stop_reason
		expect(sse[13]!.data).toEqual({
			type: "message_delta",
			delta: { stop_reason: "tool_use", stop_sequence: null },
			usage: {
				input_tokens: 11,
				output_tokens: 42,
				cache_read_input_tokens: 3,
				cache_creation_input_tokens: 5,
			},
		});

		expect(sse[14]!.data).toEqual({ type: "message_stop" });
	});

	it("emits an error event when the upstream stream errors", async () => {
		const errMessage: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "m",
			usage: emptyUsage(),
			stopReason: "error",
			errorMessage: "boom",
			timestamp: 0,
		};
		const events: AssistantMessageEvent[] = [
			{ type: "start", partial: errMessage },
			{ type: "error", reason: "error", error: errMessage },
		];
		const sse = await collectSse(encodeStream(makeStream(events), "m"));
		const last = sse.at(-1)!;
		expect(last.event).toBe("error");
		expect(last.data).toEqual({ type: "error", error: { type: "api_error", message: "boom" } });
	});

	it("emits a complete envelope when the stream ends without an explicit done", async () => {
		const sse = await collectSse(encodeStream(makeStream([]), "m"));
		expect(sse.map(e => e.event)).toEqual(["message_start", "message_delta", "message_stop"]);
		const delta = sse[1]!.data as { delta: { stop_reason: string } };
		expect(delta.delta.stop_reason).toBe("end_turn");
	});
});

describe("auth-gateway Anthropic credential profiles", () => {
	it("binds each atomic key/profile resolution to its matching retry attempt", async () => {
		const model = buildModel({
			id: "claude-sonnet-4-5",
			name: "Claude Sonnet 4.5",
			api: "anthropic-messages",
			provider: "anthropic",
			baseUrl: "https://api.anthropic.com",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 8_192,
		});
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-anthropic-profile-"));
		const storage = await AuthStorage.create(path.join(dir, "auth.db"));
		const resolveSpy = spyOn(storage, "resolveApiKey")
			.mockResolvedValueOnce({ apiKey: "shared-console-key", apiKeyRequestProfile: "anthropic-console" })
			.mockResolvedValueOnce({ apiKey: "shared-console-key" });

		interface CapturedRequest {
			url: string;
			headers: Headers;
			body: { system?: Array<{ type?: string; text?: string; cache_control?: unknown }> };
		}
		const upstreamRequests: CapturedRequest[] = [];
		const originalFetch = globalThis.fetch;
		const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
			input: string | URL | Request,
			init?: RequestInit,
		): Promise<Response> => {
			const url = input instanceof Request ? input.url : input.toString();
			if (url !== "https://api.anthropic.com/v1/messages") return originalFetch(input, init);

			const request = input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
			upstreamRequests.push({
				url,
				headers: new Headers(request.headers),
				body: JSON.parse(await request.text()) as CapturedRequest["body"],
			});
			if (upstreamRequests.length === 1) {
				return new Response(
					JSON.stringify({
						type: "error",
						error: { type: "authentication_error", message: "invalid x-api-key" },
					}),
					{
						status: 401,
						headers: { "content-type": "application/json", "request-id": "req_profile_rejected" },
					},
				);
			}

			const events = [
				{
					type: "message_start",
					message: {
						id: "msg_profile_retry",
						type: "message",
						role: "assistant",
						model: model.id,
						content: [],
						stop_reason: null,
						stop_sequence: null,
						usage: { input_tokens: 4, output_tokens: 0 },
					},
				},
				{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
				{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
				{ type: "content_block_stop", index: 0 },
				{
					type: "message_delta",
					delta: { stop_reason: "end_turn", stop_sequence: null },
					usage: { output_tokens: 1 },
				},
				{ type: "message_stop" },
			];
			const stream = events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
			return new Response(stream, {
				status: 200,
				headers: { "content-type": "text/event-stream", "request-id": "req_profile_retry" },
			});
		}) as typeof globalThis.fetch);

		const handle = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["t"],
			storage,
			resolveModel: () => model,
			version: "test",
		});
		try {
			const response = await fetch(`${handle.url}/v1/messages`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
				body: JSON.stringify({
					model: model.id,
					max_tokens: 128,
					stream: false,
					system: [{ type: "text", text: "Stay concise." }],
					messages: [{ role: "user", content: "Hello" }],
				}),
			});
			const body = (await response.json()) as { content?: Array<{ type?: string; text?: string }> };

			expect(response.status).toBe(200);
			expect(body.content).toEqual([{ type: "text", text: "ok" }]);
			expect(upstreamRequests).toHaveLength(2);
			expect(
				upstreamRequests.map(request => ({
					url: request.url,
					apiKey: request.headers.get("x-api-key"),
					authorization: request.headers.get("authorization"),
				})),
			).toEqual([
				{
					url: "https://api.anthropic.com/v1/messages",
					apiKey: "shared-console-key",
					authorization: null,
				},
				{
					url: "https://api.anthropic.com/v1/messages",
					apiKey: "shared-console-key",
					authorization: null,
				},
			]);

			const firstSystem = upstreamRequests[0]!.body.system ?? [];
			expect(firstSystem).toHaveLength(3);
			expect(firstSystem[0]?.text).toStartWith("x-anthropic-billing-header:");
			expect(firstSystem[1]).toEqual({ type: "text", text: claudeCodeSystemInstruction });
			expect(firstSystem[2]).toEqual({
				type: "text",
				text: "Stay concise.",
				cache_control: { type: "ephemeral" },
			});
			expect(upstreamRequests[1]!.body.system).toEqual([
				{ type: "text", text: "Stay concise.", cache_control: { type: "ephemeral" } },
			]);
		} finally {
			fetchSpy.mockRestore();
			resolveSpy.mockRestore();
			await handle.close();
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
