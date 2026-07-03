import { afterEach, describe, expect, it, vi } from "bun:test";
import { claudeCodeVersion } from "@oh-my-pi/pi-ai/providers/anthropic-constants";
import {
	AnthropicOAuthFlow,
	loginAnthropicClaudeCode,
	loginAnthropicConsole,
	refreshAnthropicToken,
} from "@oh-my-pi/pi-ai/registry/oauth/anthropic";
import type { OAuthController, OAuthCredentials } from "@oh-my-pi/pi-ai/registry/oauth/types";
import {
	buildAnthropicAuthConfig,
	buildAnthropicSearchHeaders,
	buildAnthropicUrl,
} from "@oh-my-pi/pi-ai/utils/anthropic-auth";
import { withEnv } from "./helpers";

const FIXED_PASTE_REDIRECT_URI = "https://platform.claude.com/oauth/code/callback";
const DIRECT_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CONSOLE_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const ANTHROPIC_DIRECT_INFERENCE_SCOPES =
	"org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";
const ANTHROPIC_CONSOLE_SCOPES = "org:create_api_key user:profile";

function tokenResponse(access = "access-token") {
	return new Response(
		JSON.stringify({
			access_token: access,
			refresh_token: "refresh-token",
			expires_in: 3600,
			account: {
				uuid: "11111111-2222-3333-4444-555555555555",
				email_address: "user@example.com",
			},
		}),
		{ status: 200, headers: { "Content-Type": "application/json" } },
	);
}

function captureTokenExchange(expectedUrl = DIRECT_TOKEN_URL) {
	const bodies: Record<string, string | number>[] = [];
	const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
		expect(typeof input === "string" ? input : input.toString()).toBe(expectedUrl);
		expect(init?.method).toBe("POST");
		bodies.push(JSON.parse(String(init?.body)) as Record<string, string | number>);
		return tokenResponse();
	});
	return { bodies, fetchMock };
}

async function runManualLogin<TResult extends OAuthCredentials | string>(
	login: (ctrl: OAuthController) => Promise<TResult>,
	manualInput: string,
	fetchMock: typeof fetch,
) {
	let authUrl: URL | undefined;
	const result = await login({
		onAuth: info => {
			authUrl = new URL(info.url);
		},
		onPrompt: async () => manualInput,
		onManualCodeInput: async () => manualInput,
		fetch: fetchMock,
	});
	if (!authUrl) throw new Error("expected login to emit an auth URL");
	return { authUrl, result };
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("anthropic oauth alignment", () => {
	it("generates auth URL with expected scope set", async () => {
		const flow = new AnthropicOAuthFlow({});
		const state = "state-123";
		const redirectUri = "http://localhost:54545/callback";

		const { url } = await flow.generateAuthUrl(state, redirectUri);
		const authUrl = new URL(url);

		expect(authUrl.origin + authUrl.pathname).toBe("https://claude.com/cai/oauth/authorize");
		expect(authUrl.searchParams.get("scope")).toBe(ANTHROPIC_DIRECT_INFERENCE_SCOPES);
		expect(authUrl.searchParams.get("state")).toBe(state);
		expect(authUrl.searchParams.get("redirect_uri")).toBe(redirectUri);
		expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
	});

	it("uses the direct inference token URL for code exchange", async () => {
		const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
			expect(typeof input === "string" ? input : input.toString()).toBe(DIRECT_TOKEN_URL);
			expect(init?.method).toBe("POST");
			return new Response(
				JSON.stringify({
					access_token: "access-token",
					refresh_token: "refresh-token",
					expires_in: 3600,
					account: {
						uuid: "11111111-2222-3333-4444-555555555555",
						email_address: "user@example.com",
					},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});

		const flow = new AnthropicOAuthFlow({ fetch: fetchMock as unknown as typeof fetch });
		await flow.generateAuthUrl("state-123", "http://localhost:54545/callback");

		const result = await flow.exchangeToken("code-123", "state-123", "http://localhost:54545/callback");

		expect(result.access).toBe("access-token");
		expect(result.refresh).toBe("refresh-token");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("parses callback code fragments into token exchange code/state", async () => {
		const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
			expect(typeof input === "string" ? input : input.toString()).toBe(DIRECT_TOKEN_URL);
			const payload = JSON.parse(String(init?.body));
			expect(payload.code).toBe("code-123");
			expect(payload.state).toBe("state-override");
			return new Response(
				JSON.stringify({
					access_token: "access-token",
					refresh_token: "refresh-token",
					expires_in: 3600,
					account: {
						uuid: "11111111-2222-3333-4444-555555555555",
						email_address: "user@example.com",
					},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});

		const flow = new AnthropicOAuthFlow({ fetch: fetchMock as unknown as typeof fetch });
		await flow.generateAuthUrl("state-123", "http://localhost:54545/callback");
		await flow.exchangeToken("code-123#state-override", "state-123", "http://localhost:54545/callback");

		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("keeps explicit state when callback code fragment state is empty", async () => {
		const fetchMock = vi.fn(async (_input: string | URL, init?: RequestInit) => {
			const payload = JSON.parse(String(init?.body));
			expect(payload.code).toBe("code-123");
			expect(payload.state).toBe("state-explicit");
			return new Response(
				JSON.stringify({
					access_token: "access-token",
					refresh_token: "refresh-token",
					expires_in: 3600,
					account: {
						uuid: "11111111-2222-3333-4444-555555555555",
						email_address: "user@example.com",
					},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});

		const flow = new AnthropicOAuthFlow({ fetch: fetchMock as unknown as typeof fetch });
		await flow.generateAuthUrl("state-123", "http://localhost:54545/callback");
		await flow.exchangeToken("code-123#", "state-explicit", "http://localhost:54545/callback");

		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
	it("uses the direct inference token URL and CC headers for refresh", async () => {
		const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
			expect(typeof input === "string" ? input : input.toString()).toBe(DIRECT_TOKEN_URL);
			expect(init?.method).toBe("POST");
			const headers = init?.headers as Record<string, string> | undefined;
			expect(headers?.["anthropic-beta"]).toBe("oauth-2025-04-20");
			expect(headers?.["User-Agent"]).toBe("anthropic-sdk-typescript/0.94.0 userOAuthProvider");
			return new Response(
				JSON.stringify({
					access_token: "new-access-token",
					refresh_token: "new-refresh-token",
					expires_in: 7200,
					account: {
						uuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
						email_address: "refreshed@example.com",
					},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});

		const result = await refreshAnthropicToken("refresh-123", fetchMock as unknown as typeof fetch);

		expect(result.access).toBe("new-access-token");
		expect(result.refresh).toBe("new-refresh-token");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("extracts account uuid and email from token-exchange response", async () => {
		const fetchMock = vi.fn(async () => {
			return new Response(
				JSON.stringify({
					access_token: "access-token",
					refresh_token: "refresh-token",
					expires_in: 3600,
					account: {
						uuid: "11111111-2222-3333-4444-555555555555",
						email_address: "user@example.com",
					},
					organization: { uuid: "99999999-8888-7777-6666-555555555555" },
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});

		const flow = new AnthropicOAuthFlow({ fetch: fetchMock as unknown as typeof fetch });
		await flow.generateAuthUrl("state-123", "http://localhost:54545/callback");
		const result = await flow.exchangeToken("code-123", "state-123", "http://localhost:54545/callback");

		expect(result.accountId).toBe("11111111-2222-3333-4444-555555555555");
		expect(result.email).toBe("user@example.com");
	});

	it("extracts account uuid and email from refresh response", async () => {
		const fetchMock = vi.fn(async () => {
			return new Response(
				JSON.stringify({
					access_token: "new-access-token",
					refresh_token: "new-refresh-token",
					expires_in: 7200,
					account: {
						uuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
						email_address: "refreshed@example.com",
					},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});

		const result = await refreshAnthropicToken("refresh-123", fetchMock as unknown as typeof fetch);

		expect(result.accountId).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
		expect(result.email).toBe("refreshed@example.com");
	});

	it("fetches bootstrap identity when token response omits account block", async () => {
		const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url === DIRECT_TOKEN_URL) {
				return new Response(
					JSON.stringify({
						access_token: "access-token",
						refresh_token: "refresh-token",
						expires_in: 3600,
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			expect(url).toBe("https://api.anthropic.com/api/claude_cli/bootstrap?entrypoint=cli&model=claude-opus-4-8");
			expect(init?.method).toBe("GET");
			const headers = init?.headers as Record<string, string> | undefined;
			expect(headers?.Authorization).toBe("Bearer access-token");
			expect(headers?.["User-Agent"]).toBe(`claude-code/${claudeCodeVersion}`);
			expect(headers?.["anthropic-beta"]).toBe("oauth-2025-04-20");
			return new Response(
				JSON.stringify({
					oauth_account: {
						account_uuid: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
						account_email: "bootstrap@example.com",
					},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});

		const flow = new AnthropicOAuthFlow({ fetch: fetchMock as unknown as typeof fetch });
		await flow.generateAuthUrl("state-noaccount", "http://localhost:54545/callback");
		const result = await flow.exchangeToken("code-noaccount", "state-noaccount", "http://localhost:54545/callback");

		expect(result.accountId).toBe("bbbbbbbb-cccc-dddd-eeee-ffffffffffff");
		expect(result.email).toBe("bootstrap@example.com");
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("leaves accountId/email undefined when token and bootstrap responses omit identity", async () => {
		const fetchMock = vi.fn(async (input: string | URL) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url === DIRECT_TOKEN_URL) {
				return new Response(
					JSON.stringify({
						access_token: "access-token",
						refresh_token: "refresh-token",
						expires_in: 3600,
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			return new Response(JSON.stringify({ client_data: null }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});

		const flow = new AnthropicOAuthFlow({ fetch: fetchMock as unknown as typeof fetch });
		await flow.generateAuthUrl("state-noaccount", "http://localhost:54545/callback");
		const result = await flow.exchangeToken("code-noaccount", "state-noaccount", "http://localhost:54545/callback");

		expect(result.accountId).toBeUndefined();
		expect(result.email).toBeUndefined();
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});
});

describe("Anthropic pasted-code OAuth logins", () => {
	it("Claude Code builds a fixed-redirect authorize URL and exchanges a raw pasted code", async () => {
		const { bodies, fetchMock } = captureTokenExchange();

		const { authUrl, result } = await runManualLogin(
			loginAnthropicClaudeCode,
			"code-from-browser",
			fetchMock as unknown as typeof fetch,
		);

		expect(authUrl.origin + authUrl.pathname).toBe("https://claude.com/cai/oauth/authorize");
		expect(authUrl.searchParams.get("redirect_uri")).toBe(FIXED_PASTE_REDIRECT_URI);
		expect(authUrl.searchParams.get("scope")).toBe(ANTHROPIC_DIRECT_INFERENCE_SCOPES);
		expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
		expect(bodies).toHaveLength(1);
		expect(bodies[0]).toMatchObject({
			grant_type: "authorization_code",
			code: "code-from-browser",
			redirect_uri: FIXED_PASTE_REDIRECT_URI,
			state: authUrl.searchParams.get("state"),
		});
		expect(typeof bodies[0]?.code_verifier).toBe("string");
		expect(result).toMatchObject({
			access: "access-token",
			refresh: "refresh-token",
			accountId: "11111111-2222-3333-4444-555555555555",
			email: "user@example.com",
		});
	});

	it("Claude Code accepts a pasted callback URL and exchanges with its callback state", async () => {
		const { bodies, fetchMock } = captureTokenExchange();
		let authUrl: URL | undefined;

		const result = await loginAnthropicClaudeCode({
			onAuth: info => {
				authUrl = new URL(info.url);
			},
			onPrompt: async () => {
				throw new Error("manual prompt should come from onManualCodeInput");
			},
			onManualCodeInput: async () => {
				if (!authUrl) throw new Error("expected auth URL before manual code prompt");
				return `${FIXED_PASTE_REDIRECT_URI}?code=code-from-callback&state=${authUrl.searchParams.get("state")}`;
			},
			fetch: fetchMock as unknown as typeof fetch,
		});
		if (!authUrl) throw new Error("expected login to emit an auth URL");

		expect(result.access).toBe("access-token");
		expect(bodies).toHaveLength(1);
		expect(bodies[0]).toMatchObject({
			code: "code-from-callback",
			state: authUrl.searchParams.get("state"),
			redirect_uri: FIXED_PASTE_REDIRECT_URI,
		});
	});

	it("Claude Console exchanges the pasted OAuth code for an Anthropic API key", async () => {
		const bodies: Record<string, string | number>[] = [];
		const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url === CONSOLE_TOKEN_URL) {
				expect(init?.method).toBe("POST");
				bodies.push(JSON.parse(String(init?.body)) as Record<string, string | number>);
				return tokenResponse("console-oauth-access-token");
			}
			expect(url).toBe("https://api.anthropic.com/api/oauth/claude_cli/create_api_key");
			expect(init?.method).toBe("POST");
			expect(init?.body).toBeUndefined();
			const headers = init?.headers as Record<string, string> | undefined;
			expect(headers?.Authorization).toBe("Bearer console-oauth-access-token");
			expect(headers?.["Content-Type"]).toBe("application/json");
			return new Response(JSON.stringify({ raw_key: "sk-ant-api-from-console" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});

		const { authUrl, result } = await runManualLogin(
			loginAnthropicConsole,
			"console-code",
			fetchMock as unknown as typeof fetch,
		);

		expect(authUrl.origin + authUrl.pathname).toBe("https://platform.claude.com/oauth/authorize");
		expect(authUrl.searchParams.get("redirect_uri")).toBe(FIXED_PASTE_REDIRECT_URI);
		expect(authUrl.searchParams.get("scope")).toBe(ANTHROPIC_CONSOLE_SCOPES);
		expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
		expect(bodies).toHaveLength(1);
		expect(bodies[0]).toMatchObject({
			code: "console-code",
			redirect_uri: FIXED_PASTE_REDIRECT_URI,
			state: authUrl.searchParams.get("state"),
		});
		expect(result).toBe("sk-ant-api-from-console");
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("redacts token-bearing OAuth error bodies", async () => {
		const leakedAccess = "sk-ant-oat-access-token-that-must-not-leak";
		const leakedRefresh = "sk-ant-oat-refresh-token-that-must-not-leak";
		const fetchMock = vi.fn(async () => {
			return new Response(
				JSON.stringify({
					error: "invalid_grant",
					access_token: leakedAccess,
					refresh_token: leakedRefresh,
				}),
				{ status: 400, headers: { "Content-Type": "application/json" } },
			);
		});

		const error = await loginAnthropicClaudeCode({
			onAuth: () => {},
			onPrompt: async () => "bad-code",
			onManualCodeInput: async () => "bad-code",
			fetch: fetchMock as unknown as typeof fetch,
		}).catch((err: unknown) => err);

		expect(error).toBeInstanceOf(Error);
		const message = String((error as Error).message);
		expect(message).toContain("invalid_grant");
		expect(message).not.toContain(leakedAccess);
		expect(message).not.toContain(leakedRefresh);
		expect(message).toContain("[redacted]");
	});
});

describe("buildAnthropicAuthConfig", () => {
	it("classifies sk-ant-oat tokens as OAuth", () => {
		const config = buildAnthropicAuthConfig("sk-ant-oat-foobar");
		expect(config.isOAuth).toBe(true);
		expect(config.apiKey).toBe("sk-ant-oat-foobar");
	});

	it("treats sk-ant-api tokens as non-OAuth", () => {
		const config = buildAnthropicAuthConfig("sk-ant-api-foobar");
		expect(config.isOAuth).toBe(false);
	});

	it("normalizes the explicit baseUrl override (trailing slash, env precedence)", async () => {
		await withEnv(
			{
				CLAUDE_CODE_USE_FOUNDRY: "true",
				FOUNDRY_BASE_URL: "https://foundry.example.com/anthropic/",
				ANTHROPIC_BASE_URL: undefined,
			},
			async () => {
				const explicit = buildAnthropicAuthConfig("sk-ant-api-key", "https://override.example.com/");
				expect(explicit.baseUrl).toBe("https://override.example.com");
				expect(buildAnthropicUrl(explicit)).toBe("https://override.example.com/v1/messages?beta=true");
			},
		);
	});

	it("falls back to FOUNDRY_BASE_URL when Foundry mode is enabled and no explicit override is given", async () => {
		await withEnv(
			{
				CLAUDE_CODE_USE_FOUNDRY: "true",
				FOUNDRY_BASE_URL: "https://foundry.example.com/anthropic/",
				ANTHROPIC_BASE_URL: undefined,
			},
			async () => {
				const config = buildAnthropicAuthConfig("sk-ant-api-key");
				expect(config.baseUrl).toBe("https://foundry.example.com/anthropic");
			},
		);
	});

	it("falls back to ANTHROPIC_BASE_URL when Foundry mode is disabled", async () => {
		await withEnv(
			{
				CLAUDE_CODE_USE_FOUNDRY: undefined,
				FOUNDRY_BASE_URL: undefined,
				ANTHROPIC_BASE_URL: "https://anthropic.example.com/",
			},
			async () => {
				const config = buildAnthropicAuthConfig("sk-ant-api-key");
				expect(config.baseUrl).toBe("https://anthropic.example.com");
			},
		);
	});

	it("uses the default Anthropic base URL when no env or override is set", async () => {
		await withEnv(
			{
				CLAUDE_CODE_USE_FOUNDRY: undefined,
				FOUNDRY_BASE_URL: undefined,
				ANTHROPIC_BASE_URL: undefined,
			},
			async () => {
				const config = buildAnthropicAuthConfig("sk-ant-api-key");
				expect(config.baseUrl).toBe("https://api.anthropic.com");
			},
		);
	});
});

describe("buildAnthropicSearchHeaders", () => {
	it("forwards ANTHROPIC_CUSTOM_HEADERS when the base URL is an enterprise gateway", async () => {
		await withEnv(
			{
				CLAUDE_CODE_USE_FOUNDRY: undefined,
				FOUNDRY_BASE_URL: undefined,
				ANTHROPIC_BASE_URL: "https://gateway.example.com",
				ANTHROPIC_CUSTOM_HEADERS: "X-Gateway-Key: secret, X-Route: search",
			},
			() => {
				const auth = buildAnthropicAuthConfig("sk-ant-api-key");
				expect(auth.baseUrl).toBe("https://gateway.example.com");
				const headers = buildAnthropicSearchHeaders(auth);
				expect(headers["X-Gateway-Key"]).toBe("secret");
				expect(headers["X-Route"]).toBe("search");
				// Non-Anthropic base URL uses Bearer auth, not X-Api-Key.
				expect(headers.Authorization).toBe("Bearer sk-ant-api-key");
				expect(headers["X-Api-Key"]).toBeUndefined();
			},
		);
	});

	it("omits ANTHROPIC_CUSTOM_HEADERS when targeting api.anthropic.com without Foundry", async () => {
		await withEnv(
			{
				CLAUDE_CODE_USE_FOUNDRY: undefined,
				FOUNDRY_BASE_URL: undefined,
				ANTHROPIC_BASE_URL: undefined,
				ANTHROPIC_CUSTOM_HEADERS: "X-Gateway-Key: secret",
			},
			() => {
				const auth = buildAnthropicAuthConfig("sk-ant-api-key");
				expect(auth.baseUrl).toBe("https://api.anthropic.com");
				const headers = buildAnthropicSearchHeaders(auth);
				expect(headers["X-Gateway-Key"]).toBeUndefined();
				expect(headers["X-Api-Key"]).toBe("sk-ant-api-key");
			},
		);
	});

	it("forwards ANTHROPIC_CUSTOM_HEADERS in Foundry mode even on an Anthropic-shaped base URL", async () => {
		await withEnv(
			{
				CLAUDE_CODE_USE_FOUNDRY: "true",
				FOUNDRY_BASE_URL: undefined,
				ANTHROPIC_BASE_URL: undefined,
				ANTHROPIC_CUSTOM_HEADERS: "user-id: alice",
			},
			() => {
				const auth = buildAnthropicAuthConfig("sk-ant-api-key", "https://api.anthropic.com");
				const headers = buildAnthropicSearchHeaders(auth);
				expect(headers["user-id"]).toBe("alice");
			},
		);
	});

	it("includes the web-search beta in Anthropic-Beta", () => {
		const auth = buildAnthropicAuthConfig("sk-ant-api-key");
		const headers = buildAnthropicSearchHeaders(auth);
		expect(headers["anthropic-beta"]).toContain("web-search-2025-03-05");
	});
});
