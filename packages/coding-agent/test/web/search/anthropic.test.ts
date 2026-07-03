import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { AuthStorage, FetchImpl } from "@oh-my-pi/pi-ai";
import { claudeCodeSystemInstruction } from "@oh-my-pi/pi-ai/providers/anthropic";
import { AuthStorage as CodingAuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { searchAnthropic } from "@oh-my-pi/pi-coding-agent/web/search/providers/anthropic";
import { TempDir } from "@oh-my-pi/pi-utils";

type CapturedAnthropicRequest = {
	url: string;
	headers: Headers;
	body: Record<string, unknown>;
	rawBody: string;
};

function makeCaptureFetch(): {
	fetch: FetchImpl;
	body: () => Record<string, unknown> | undefined;
	request: () => CapturedAnthropicRequest | undefined;
} {
	let captured: CapturedAnthropicRequest | undefined;
	const fetch: FetchImpl = async (input, init) => {
		const raw = init?.body;
		const rawBody =
			typeof raw === "string" ? raw : raw instanceof Uint8Array ? new TextDecoder().decode(raw) : String(raw);
		captured = {
			url: String(input),
			headers: new Headers(init?.headers),
			body: JSON.parse(rawBody),
			rawBody,
		};
		return new Response(
			JSON.stringify({
				id: "msg_test",
				model: "claude-haiku-4-5",
				content: [],
				usage: { input_tokens: 1, output_tokens: 2 },
			}),
			{ status: 200, headers: { "Content-Type": "application/json" } },
		);
	};
	return { fetch, body: () => captured?.body, request: () => captured };
}

const ANTHROPIC_ENV_KEYS = [
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_OAUTH_TOKEN",
	"ANTHROPIC_SEARCH_API_KEY",
	"ANTHROPIC_SEARCH_BASE_URL",
	"ANTHROPIC_SEARCH_MODEL",
] as const;
const originalAnthropicEnv: Record<(typeof ANTHROPIC_ENV_KEYS)[number], string | undefined> = {
	ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
	ANTHROPIC_OAUTH_TOKEN: process.env.ANTHROPIC_OAUTH_TOKEN,
	ANTHROPIC_SEARCH_API_KEY: process.env.ANTHROPIC_SEARCH_API_KEY,
	ANTHROPIC_SEARCH_BASE_URL: process.env.ANTHROPIC_SEARCH_BASE_URL,
	ANTHROPIC_SEARCH_MODEL: process.env.ANTHROPIC_SEARCH_MODEL,
};

beforeEach(() => {
	for (const key of ANTHROPIC_ENV_KEYS) delete process.env[key];
});

afterEach(() => {
	for (const key of ANTHROPIC_ENV_KEYS) {
		const original = originalAnthropicEnv[key];
		if (original === undefined) delete process.env[key];
		else process.env[key] = original;
	}
});

describe("Anthropic search request body", () => {
	it("forwards the raw session id as metadata.user_id for API-key auth", async () => {
		using tempDir = TempDir.createSync("@pi-anthropic-search-apikey-");
		const authStorage = await CodingAuthStorage.create(path.join(tempDir.path(), "auth.db"));
		try {
			authStorage.setRuntimeApiKey("anthropic", "test-key");

			const cap = makeCaptureFetch();
			await searchAnthropic({
				query: "gateway attribution requirements",
				systemPrompt: "Use web search.",
				sessionId: "session-2295",
				authStorage,
				fetch: cap.fetch,
			});

			expect(cap.body()?.metadata).toEqual({ user_id: "session-2295" });
		} finally {
			authStorage.close();
		}
	});

	it("adds the Console billing fingerprint only to an official non-Haiku API-key request", async () => {
		using tempDir = TempDir.createSync("@pi-anthropic-search-console-profile-");
		const authStorage = await CodingAuthStorage.create(path.join(tempDir.path(), "auth.db"));
		try {
			await authStorage.set("anthropic", {
				type: "api_key",
				key: "shared-console-key",
				apiKeyRequestProfile: "anthropic-console",
			});
			process.env.ANTHROPIC_SEARCH_MODEL = "claude-sonnet-4-5";

			const cap = makeCaptureFetch();
			await searchAnthropic({
				query: "Console profile web search attestation",
				systemPrompt: "Use web search.",
				sessionId: "console-profile-session",
				authStorage,
				fetch: cap.fetch,
			});

			const request = cap.request();
			expect(request).toBeDefined();
			const system = request!.body.system as
				| Array<{ type?: string; text?: string; cache_control?: unknown }>
				| undefined;
			expect(request!.url).toBe("https://api.anthropic.com/v1/messages?beta=true");
			expect(request!.headers.get("x-api-key")).toBe("shared-console-key");
			expect(request!.headers.get("authorization")).toBeNull();
			expect(system).toHaveLength(3);
			expect(system?.[0]?.text).toStartWith("x-anthropic-billing-header:");
			expect(system?.[0]?.cache_control).toBeUndefined();
			expect(system?.[1]).toEqual({ type: "text", text: claudeCodeSystemInstruction });
			expect(system?.[2]).toEqual({
				type: "text",
				text: "Use web search.",
				cache_control: { type: "ephemeral" },
			});

			const cch = system?.[0]?.text?.match(/cch=([0-9a-f]{5});/)?.[1];
			const bodyWithPlaceholder = request!.rawBody.replace(/cch=[0-9a-f]{5}/, "cch=00000");
			const expectedCch = (
				Bun.hash.xxHash64(new TextEncoder().encode(bodyWithPlaceholder), 0x4d659218e32a3268n) & 0xfffffn
			)
				.toString(16)
				.padStart(5, "0");
			expect(cch).toBe(expectedCch);
		} finally {
			authStorage.close();
		}
	});

	it("omits the Console fingerprint without the profile or outside official non-Haiku requests", async () => {
		using tempDir = TempDir.createSync("@pi-anthropic-search-console-ineligible-");
		const authStorage = await CodingAuthStorage.create(path.join(tempDir.path(), "auth.db"));
		try {
			const cases: Array<{
				name: string;
				profile: boolean;
				model?: string;
				expectedModel: string;
				baseUrl?: string;
			}> = [
				{
					name: "same official key without profile",
					profile: false,
					model: "claude-sonnet-4-5",
					expectedModel: "claude-sonnet-4-5",
				},
				{
					name: "default Haiku with profile",
					profile: true,
					expectedModel: "claude-haiku-4-5",
				},
				{
					name: "explicit Haiku with profile",
					profile: true,
					model: "claude-3-5-haiku-latest",
					expectedModel: "claude-3-5-haiku-latest",
				},
				{
					name: "custom base URL with profile",
					profile: true,
					model: "claude-sonnet-4-5",
					expectedModel: "claude-sonnet-4-5",
					baseUrl: "https://gateway.example.test/anthropic",
				},
			];

			for (const testCase of cases) {
				await authStorage.set("anthropic", {
					type: "api_key",
					key: "shared-console-key",
					...(testCase.profile ? { apiKeyRequestProfile: "anthropic-console" as const } : {}),
				});
				if (testCase.model === undefined) delete process.env.ANTHROPIC_SEARCH_MODEL;
				else process.env.ANTHROPIC_SEARCH_MODEL = testCase.model;
				if (testCase.baseUrl === undefined) delete process.env.ANTHROPIC_SEARCH_BASE_URL;
				else process.env.ANTHROPIC_SEARCH_BASE_URL = testCase.baseUrl;

				const cap = makeCaptureFetch();
				await searchAnthropic({
					query: "No Console fingerprint expected",
					systemPrompt: "Use web search.",
					sessionId: `ineligible-${testCase.name}`,
					authStorage,
					fetch: cap.fetch,
				});

				const request = cap.request();
				expect(request).toBeDefined();
				expect({
					name: testCase.name,
					model: request!.body.model,
					system: request!.body.system,
				}).toEqual({
					name: testCase.name,
					model: testCase.expectedModel,
					system: [
						{
							type: "text",
							text: "Use web search.",
							cache_control: { type: "ephemeral" },
						},
					],
				});
				expect({ name: testCase.name, hasCch: request!.rawBody.includes("cch=") }).toEqual({
					name: testCase.name,
					hasCch: false,
				});
			}
		} finally {
			authStorage.close();
		}
	});

	it("builds a Claude-Code-shaped metadata.user_id for OAuth auth", async () => {
		const accountUuid = "abcd1234-abcd-1234-abcd-1234abcd1234";
		const oauthAuthStorage = {
			resolver: () => () => Promise.resolve("sk-ant-oat-fake-oauth-token"),
			getOAuthAccountId: () => accountUuid,
			hasAuth: () => true,
		} as unknown as AuthStorage;

		const cap = makeCaptureFetch();
		await searchAnthropic({
			query: "oauth attribution",
			systemPrompt: "Use web search.",
			sessionId: "session-2295",
			authStorage: oauthAuthStorage,
			fetch: cap.fetch,
		});

		const metadata = cap.body()?.metadata as { user_id: string } | undefined;
		expect(metadata).toBeDefined();
		const userId = JSON.parse(metadata!.user_id) as {
			session_id: string;
			account_uuid?: string;
			device_id?: string;
		};
		expect(userId.session_id).toBe("session-2295");
		expect(userId.account_uuid).toBe(accountUuid);
		expect(userId.device_id).toMatch(/^[0-9a-f]{64}$/);
	});
});
