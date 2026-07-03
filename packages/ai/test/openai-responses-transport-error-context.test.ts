import { describe, expect, it } from "bun:test";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import type { Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { finalizeErrorMessage } from "@oh-my-pi/pi-ai/utils/http-inspector";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const context: Context = {
	systemPrompt: ["test"],
	messages: [{ role: "user", content: "ping", timestamp: Date.now() }],
};

function createRustCatResponsesModel(): Model<"openai-responses"> {
	return buildModel({
		api: "openai-responses",
		provider: "rust-cat",
		id: "gpt-5.5",
		name: "GPT-5.5 via rust.cat",
		baseUrl: "https://rust.cat/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 32768,
		omitMaxOutputTokens: true,
	});
}

describe("openai-responses transport error context", () => {
	it("includes provider request context when a compatible endpoint fails during transport parsing", async () => {
		const fetchMock: FetchImpl = async () => {
			throw new Error("JSON Parse error: Unexpected EOF");
		};

		const result = await streamOpenAIResponses(createRustCatResponsesModel(), context, {
			apiKey: "runtime-key",
			fetch: fetchMock,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("JSON Parse error: Unexpected EOF");
		expect(result.errorMessage).toContain("provider=rust-cat");
		expect(result.errorMessage).toContain("api=openai-responses");
		expect(result.errorMessage).toContain("model=gpt-5.5");
		expect(result.errorMessage).toContain("url=https://rust.cat/v1/responses");
	});

	it("keeps request context when the transport parse error is surfaced directly", async () => {
		const message = await finalizeErrorMessage(new Error("JSON Parse error: Unexpected EOF"), {
			provider: "rust-cat",
			api: "openai-responses",
			model: "gpt-5.5",
			method: "POST",
			url: "https://rust.cat/v1/responses",
		});

		expect(message).toContain("JSON Parse error: Unexpected EOF");
		expect(message).toContain("request-context:");
		expect(message).toContain("provider=rust-cat");
		expect(message).toContain("api=openai-responses");
		expect(message).toContain("model=gpt-5.5");
		expect(message).toContain("url=https://rust.cat/v1/responses");
	});

	it("keeps request context when an HTTP auth error has no response body", async () => {
		const error = new Error("401 status code (no body)") as Error & { status?: number };
		error.status = 401;
		const message = await finalizeErrorMessage(error, {
			provider: "rust-cat",
			api: "openai-responses",
			model: "gpt-5.5",
			method: "POST",
			url: "https://rust.cat/v1/responses",
		});

		expect(message).toContain("401 status code (no body)");
		expect(message).toContain("request-context:");
		expect(message).toContain("provider=rust-cat");
		expect(message).toContain("api=openai-responses");
		expect(message).toContain("model=gpt-5.5");
		expect(message).toContain("url=https://rust.cat/v1/responses");
	});
});
