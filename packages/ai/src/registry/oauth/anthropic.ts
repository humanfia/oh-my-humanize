/**
 * Anthropic OAuth flow (Claude Pro/Max)
 */

import { z } from "zod/v4";
import * as AIError from "../../error";
import { claudeCodeVersion } from "../../providers/anthropic-version";
import type { FetchImpl } from "../../types";
import { OAuthCallbackFlow, parseCallbackInput } from "./callback-server";
import { generatePKCE } from "./pkce";
import type { OAuthController, OAuthCredentials } from "./types";

const decode = (s: string) => atob(s);
const CLIENT_ID = decode("OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl");
const LOOPBACK_AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const CLAUDEAI_CODE_AUTHORIZE_URL = "https://claude.com/cai/oauth/authorize";
const CONSOLE_AUTHORIZE_URL = "https://platform.claude.com/oauth/authorize";
const TOKEN_URL = "https://api.anthropic.com/v1/oauth/token";
const BOOTSTRAP_URL = "https://api.anthropic.com/api/claude_cli/bootstrap";
const CLAUDE_CODE_BOOTSTRAP_MODEL = "claude-opus-4-8";
const CLAUDE_CODE_BOOTSTRAP_USER_AGENT = `claude-code/${claudeCodeVersion}`;
const CALLBACK_PORT = 54545;
const CALLBACK_PATH = "/callback";
const CODE_REDIRECT_URI = "https://platform.claude.com/oauth/code/callback";
// Scopes required for direct OAuth-token inference (user:inference) plus account/session management.
// Claude Code uses the same requested scope set for both browser callback and pasted-code logins.
const SCOPES =
	"org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";

export type AnthropicCodeLoginSource = "claudeai" | "console";

function formatErrorDetails(error: unknown): string {
	if (error instanceof Error) {
		const details: string[] = [`${error.name}: ${error.message}`];
		const errorWithCode = error as Error & { code?: string; errno?: number | string; cause?: unknown };
		if (errorWithCode.code) details.push(`code=${errorWithCode.code}`);
		if (typeof errorWithCode.errno !== "undefined") details.push(`errno=${String(errorWithCode.errno)}`);
		if (typeof error.cause !== "undefined") {
			details.push(`cause=${formatErrorDetails(error.cause)}`);
		}
		if (error.stack) {
			details.push(`stack=${error.stack}`);
		}
		return details.join("; ");
	}
	return String(error);
}

async function postJson(
	url: string,
	body: Record<string, string | number>,
	fetchImpl: FetchImpl,
	extraHeaders?: Record<string, string>,
): Promise<string> {
	const response = await fetchImpl(url, {
		method: "POST",
		headers: {
			// No Accept header: CC omits it on OAuth token requests.
			...extraHeaders,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(30_000),
	});

	const responseBody = await response.text();
	if (!response.ok) {
		throw new AIError.ProviderHttpError(
			`HTTP request failed. status=${response.status}; url=${url}; body=${responseBody}`,
			response.status,
		);
	}
	return responseBody;
}

const AnthropicTokenResponseSchema = z
	.object({
		access_token: z.string(),
		refresh_token: z.string(),
		expires_in: z.number(),
		account: z
			.object({
				uuid: z.string().optional(),
				email_address: z.string().optional(),
			})
			.passthrough()
			.optional(),
	})
	.passthrough();

type AnthropicTokenResponse = z.infer<typeof AnthropicTokenResponseSchema>;

const AnthropicBootstrapResponseSchema = z
	.object({
		oauth_account: z
			.object({
				account_uuid: z.string().optional(),
				account_email: z.string().optional(),
			})
			.passthrough()
			.optional(),
	})
	.passthrough();

type AnthropicBootstrapResponse = z.infer<typeof AnthropicBootstrapResponseSchema>;

function parseOAuthTokenResponse(responseBody: string, operation: string): AnthropicTokenResponse {
	try {
		return AnthropicTokenResponseSchema.parse(JSON.parse(responseBody));
	} catch (error) {
		throw new AIError.OAuthError(
			`Anthropic ${operation} returned invalid JSON. url=${TOKEN_URL}; body=${responseBody}; details=${formatErrorDetails(error)}`,
			{ kind: "validation", provider: "anthropic", cause: error },
		);
	}
}

/**
 * Lift the OAuth response's `account: { uuid, email_address }` block onto
 * {@link OAuthCredentials} so downstream identity propagation (e.g.
 * `metadata.user_id.account_uuid`, usage tracking) works without a separate
 * `/api/oauth/profile` round-trip. Returns `undefined` for either field when
 * the response omits it or carries a non-string / empty value.
 */
function extractAccountFromTokenResponse(data: AnthropicTokenResponse): {
	accountId?: string;
	email?: string;
} {
	const accountUuid = data.account?.uuid;
	const emailAddress = data.account?.email_address;
	return {
		accountId: typeof accountUuid === "string" && accountUuid.length > 0 ? accountUuid : undefined,
		email: typeof emailAddress === "string" && emailAddress.length > 0 ? emailAddress : undefined,
	};
}

async function fetchBootstrapIdentity(
	accessToken: string,
	fetchImpl: FetchImpl,
): Promise<{ accountId?: string; email?: string }> {
	const url = `${BOOTSTRAP_URL}?entrypoint=cli&model=${encodeURIComponent(CLAUDE_CODE_BOOTSTRAP_MODEL)}`;
	const response = await fetchImpl(url, {
		method: "GET",
		headers: {
			Accept: "application/json, text/plain, */*",
			Authorization: `Bearer ${accessToken}`,
			"Content-Type": "application/json",
			"User-Agent": CLAUDE_CODE_BOOTSTRAP_USER_AGENT,
			"anthropic-beta": "oauth-2025-04-20",
		},
		signal: AbortSignal.timeout(30_000),
	});
	const responseBody = await response.text();
	if (!response.ok) {
		throw new AIError.ProviderHttpError(
			`HTTP request failed. status=${response.status}; url=${url}; body=${responseBody}`,
			response.status,
		);
	}
	let data: AnthropicBootstrapResponse;
	try {
		data = AnthropicBootstrapResponseSchema.parse(JSON.parse(responseBody));
	} catch (error) {
		throw new AIError.OAuthError(
			`Anthropic bootstrap returned invalid JSON. url=${url}; body=${responseBody}; details=${formatErrorDetails(error)}`,
			{ kind: "validation", provider: "anthropic", cause: error },
		);
	}
	const accountUuid = data.oauth_account?.account_uuid;
	const accountEmail = data.oauth_account?.account_email;
	return {
		accountId: typeof accountUuid === "string" && accountUuid.length > 0 ? accountUuid : undefined,
		email: typeof accountEmail === "string" && accountEmail.length > 0 ? accountEmail : undefined,
	};
}

async function resolveAccountIdentity(
	data: AnthropicTokenResponse,
	fetchImpl: FetchImpl,
): Promise<{ accountId?: string; email?: string }> {
	const identity = extractAccountFromTokenResponse(data);
	if (identity.accountId && identity.email) return identity;
	try {
		const bootstrap = await fetchBootstrapIdentity(data.access_token, fetchImpl);
		return {
			accountId: identity.accountId ?? bootstrap.accountId,
			email: identity.email ?? bootstrap.email,
		};
	} catch {
		return identity;
	}
}

function generateState(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return Array.from(bytes)
		.map(value => value.toString(16).padStart(2, "0"))
		.join("");
}

function buildAnthropicAuthorizeUrl(
	authorizeUrl: string,
	state: string,
	redirectUri: string,
	challenge: string,
): string {
	const authParams = new URLSearchParams({
		code: "true",
		client_id: CLIENT_ID,
		response_type: "code",
		redirect_uri: redirectUri,
		scope: SCOPES,
		code_challenge: challenge,
		code_challenge_method: "S256",
		state,
	});
	return `${authorizeUrl}?${authParams.toString()}`;
}

function normalizeAuthorizationCodeInput(code: string, state: string): { code: string; state: string } {
	const parsed = parseCallbackInput(code);
	return {
		code: parsed.code ?? code,
		state: parsed.state && parsed.state.length > 0 ? parsed.state : state,
	};
}

async function exchangeAnthropicAuthorizationCode(args: {
	code: string;
	state: string;
	redirectUri: string;
	verifier: string;
	fetchImpl: FetchImpl;
}): Promise<AnthropicTokenResponse> {
	const { code, state, redirectUri, verifier, fetchImpl } = args;
	const normalized = normalizeAuthorizationCodeInput(code, state);
	let responseBody: string;
	try {
		responseBody = await postJson(
			TOKEN_URL,
			{
				grant_type: "authorization_code",
				client_id: CLIENT_ID,
				code: normalized.code,
				state: normalized.state,
				redirect_uri: redirectUri,
				code_verifier: verifier,
			},
			fetchImpl,
		);
	} catch (error) {
		throw new AIError.OAuthError(
			`Token exchange request failed. url=${TOKEN_URL}; redirect_uri=${redirectUri}; response_type=authorization_code; details=${formatErrorDetails(error)}`,
			{ kind: "token-exchange", provider: "anthropic", cause: error },
		);
	}

	return parseOAuthTokenResponse(responseBody, "token exchange");
}

export class AnthropicOAuthFlow extends OAuthCallbackFlow {
	#verifier: string = "";
	#challenge: string = "";
	#fetch: FetchImpl;

	constructor(ctrl: OAuthController) {
		super(ctrl, CALLBACK_PORT, CALLBACK_PATH);
		this.#fetch = ctrl.fetch ?? fetch;
	}

	async generateAuthUrl(state: string, redirectUri: string): Promise<{ url: string; instructions?: string }> {
		const pkce = await generatePKCE();
		this.#verifier = pkce.verifier;
		this.#challenge = pkce.challenge;

		const url = buildAnthropicAuthorizeUrl(LOOPBACK_AUTHORIZE_URL, state, redirectUri, this.#challenge);

		return {
			url,
			instructions:
				"Complete login in your browser. If the browser cannot reach this machine, paste the final redirect URL or authorization code when prompted.",
		};
	}

	async exchangeToken(code: string, state: string, redirectUri: string): Promise<OAuthCredentials> {
		const tokenData = await exchangeAnthropicAuthorizationCode({
			code,
			state,
			redirectUri,
			verifier: this.#verifier,
			fetchImpl: this.#fetch,
		});
		const { accountId, email } = await resolveAccountIdentity(tokenData, this.#fetch);

		return {
			refresh: tokenData.refresh_token,
			access: tokenData.access_token,
			expires: Date.now() + tokenData.expires_in * 1000 - 5 * 60 * 1000,
			accountId,
			email,
		};
	}
}

export class AnthropicCodeOAuthFlow {
	#verifier: string = "";
	#challenge: string = "";
	#fetch: FetchImpl;
	#source: AnthropicCodeLoginSource;
	ctrl: OAuthController;

	constructor(ctrl: OAuthController, source: AnthropicCodeLoginSource) {
		this.ctrl = ctrl;
		this.#source = source;
		this.#fetch = ctrl.fetch ?? fetch;
	}

	async generateAuthUrl(state: string): Promise<{ url: string; instructions?: string }> {
		const pkce = await generatePKCE();
		this.#verifier = pkce.verifier;
		this.#challenge = pkce.challenge;

		const authorizeUrl = this.#source === "console" ? CONSOLE_AUTHORIZE_URL : CLAUDEAI_CODE_AUTHORIZE_URL;
		const label = this.#source === "console" ? "Anthropic Console" : "Claude";
		return {
			url: buildAnthropicAuthorizeUrl(authorizeUrl, state, CODE_REDIRECT_URI, this.#challenge),
			instructions: `Complete ${label} login in a browser, then paste the authorization code shown by Anthropic.`,
		};
	}

	async exchangeToken(code: string, state: string): Promise<OAuthCredentials> {
		const tokenData = await exchangeAnthropicAuthorizationCode({
			code,
			state,
			redirectUri: CODE_REDIRECT_URI,
			verifier: this.#verifier,
			fetchImpl: this.#fetch,
		});
		const { accountId, email } = await resolveAccountIdentity(tokenData, this.#fetch);

		return {
			refresh: tokenData.refresh_token,
			access: tokenData.access_token,
			expires: Date.now() + tokenData.expires_in * 1000 - 5 * 60 * 1000,
			accountId,
			email,
		};
	}

	async login(): Promise<OAuthCredentials> {
		const state = generateState();
		const { url, instructions } = await this.generateAuthUrl(state);
		this.ctrl.onAuth?.({ url, instructions });
		this.ctrl.onProgress?.("Waiting for pasted authorization code...");
		const input = await this.#waitForCode(state);
		this.ctrl.onProgress?.("Exchanging authorization code for tokens...");
		return this.exchangeToken(input.code, input.state);
	}

	async #waitForCode(expectedState: string): Promise<{ code: string; state: string }> {
		while (true) {
			if (this.ctrl.signal?.aborted) {
				throw new AIError.LoginCancelledError(`OAuth login cancelled: ${this.ctrl.signal.reason}`);
			}
			const input = await this.#readCodeInput();
			const parsed = parseCallbackInput(input);
			if (!parsed.code) {
				this.ctrl.onProgress?.("No authorization code found in pasted input. Try again.");
				continue;
			}
			if (parsed.state && parsed.state !== expectedState) {
				this.ctrl.onProgress?.("Pasted authorization state did not match this login attempt. Try again.");
				continue;
			}
			return { code: parsed.code, state: parsed.state ?? expectedState };
		}
	}

	#readCodeInput(): Promise<string> {
		if (this.ctrl.onManualCodeInput) return this.ctrl.onManualCodeInput();
		if (this.ctrl.onPrompt) {
			return this.ctrl.onPrompt({ message: "Paste the authorization code (or full redirect URL):" });
		}
		throw new AIError.ConfigurationError("Anthropic pasted-code OAuth requires a manual code input callback.");
	}
}

/**
 * Login with Anthropic OAuth using a local callback server.
 */
export async function loginAnthropic(ctrl: OAuthController): Promise<OAuthCredentials> {
	const flow = new AnthropicOAuthFlow(ctrl);
	return flow.login();
}

/**
 * Login with Anthropic OAuth using Claude Code's pasted-code redirect page.
 */
export async function loginAnthropicCode(
	ctrl: OAuthController,
	source: AnthropicCodeLoginSource = "claudeai",
): Promise<OAuthCredentials> {
	const flow = new AnthropicCodeOAuthFlow(ctrl, source);
	return flow.login();
}

/**
 * Refresh Anthropic OAuth token
 */
export async function refreshAnthropicToken(
	refreshToken: string,
	fetchOverride?: FetchImpl,
): Promise<OAuthCredentials> {
	const fetchImpl = fetchOverride ?? fetch;
	let responseBody: string;
	try {
		responseBody = await postJson(
			TOKEN_URL,
			{
				grant_type: "refresh_token",
				client_id: CLIENT_ID,
				refresh_token: refreshToken,
			},
			fetchImpl,
			{
				// CC sends these on refresh but not on the initial code exchange
				"anthropic-beta": "oauth-2025-04-20",
				"User-Agent": "anthropic-sdk-typescript/0.94.0 userOAuthProvider",
			},
		);
	} catch (error) {
		throw new AIError.OAuthError(
			`Anthropic token refresh request failed. url=${TOKEN_URL}; details=${formatErrorDetails(error)}`,
			{
				kind: "token-refresh",
				provider: "anthropic",
				cause: error,
			},
		);
	}

	const data = parseOAuthTokenResponse(responseBody, "token refresh");
	const { accountId, email } = await resolveAccountIdentity(data, fetchImpl);

	return {
		refresh: data.refresh_token || refreshToken,
		access: data.access_token,
		expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
		accountId,
		email,
	};
}
