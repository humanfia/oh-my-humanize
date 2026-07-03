import { afterEach, describe, expect, it, vi } from "bun:test";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

const context: Context = {
	systemPrompt: ["test"],
	messages: [{ role: "user", content: "ping", timestamp: Date.now() }],
};

function createCompletedResponsesFetch(headers: string[]): FetchImpl {
	return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
		headers.push(new Headers(init?.headers).get("authorization") ?? "");
		const event = {
			type: "response.completed",
			response: {
				status: "completed",
				usage: {
					input_tokens: 1,
					output_tokens: 1,
					total_tokens: 2,
					input_tokens_details: { cached_tokens: 0 },
				},
			},
		};
		return new Response(`data: ${JSON.stringify(event)}\n\n`, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	});
}

async function drainResponses(model: Model<"openai-responses">, apiKey: string, fetchMock: FetchImpl): Promise<void> {
	const stream = streamSimple(model, context, { apiKey, fetch: fetchMock });
	for await (const event of stream) {
		if (event.type === "done" || event.type === "error") break;
	}
}

async function drainResponsesWithoutRequestApiKey(
	model: Model<"openai-responses">,
	fetchMock: FetchImpl,
): Promise<void> {
	const stream = streamSimple(model, context, { fetch: fetchMock });
	for await (const event of stream) {
		if (event.type === "done" || event.type === "error") break;
	}
}

afterEach(() => {
	delete Bun.env.OPENAI_API_KEY;
});

describe("OpenAI-compatible auth headers", () => {
	it("uses the per-request apiKey over stale static Authorization model headers", async () => {
		const baseModel = getBundledModel("openai", "gpt-4o-mini") as Model<"openai-responses">;
		const model: Model<"openai-responses"> = {
			...baseModel,
			headers: {
				...baseModel.headers,
				Authorization: "Bearer stale-config-key",
			},
		};
		const headers: string[] = [];

		await drainResponses(model, "runtime-cli-key", createCompletedResponsesFetch(headers));

		expect(headers).toEqual(["Bearer runtime-cli-key"]);
	});

	it("uses model Authorization headers over global OpenAI fallback keys for custom compatible providers", async () => {
		Bun.env.OPENAI_API_KEY = "global-openai-key";
		const baseModel = getBundledModel("openai", "gpt-4o-mini") as Model<"openai-responses">;
		const model: Model<"openai-responses"> = {
			...baseModel,
			provider: "rust-cat",
			id: "gpt-5.5",
			baseUrl: "https://rust.cat/v1",
			headers: {
				...baseModel.headers,
				Authorization: "Bearer provider-config-key",
			},
		};
		const headers: string[] = [];

		await drainResponsesWithoutRequestApiKey(model, createCompletedResponsesFetch(headers));

		expect(headers).toEqual(["Bearer provider-config-key"]);
	});

	it("preserves configured Authorization headers when keyless custom providers pass the no-auth sentinel", async () => {
		const baseModel = getBundledModel("openai", "gpt-4o-mini") as Model<"openai-responses">;
		const model: Model<"openai-responses"> = {
			...baseModel,
			provider: "rust-cat",
			id: "gpt-5.5",
			baseUrl: "https://rust.cat/v1",
			headers: {
				...baseModel.headers,
				Authorization: "Bearer provider-config-key",
			},
		};
		const headers: string[] = [];

		await drainResponses(model, "N/A", createCompletedResponsesFetch(headers));

		expect(headers).toEqual(["Bearer provider-config-key"]);
	});
});
