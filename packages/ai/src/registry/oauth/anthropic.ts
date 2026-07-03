/**
 * Anthropic OAuth flow (Claude Pro/Max)
 */

import * as AIError from "../../error";
import { claudeCodeVersion } from "../../providers/anthropic-constants";
import type { FetchImpl } from "../../types";
import { OAuthCallbackFlow, parseCallbackInput } from "./callback-server";
import { generatePKCE } from "./pkce";
import type { OAuthController, OAuthCredentials } from "./types";

const decode = (s: string) => atob(s);
const CLIENT_ID = decode("OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl");
const CLAUDE_AUTHORIZE_URL = "https://claude.com/cai/oauth/authorize";
const CONSOLE_AUTHORIZE_URL = "https://platform.claude.com/oauth/authorize";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const BOOTSTRAP_URL = "https://api.anthropic.com/api/claude_cli/bootstrap";
const OAUTH_API_KEY_URL = "https://api.anthropic.com/api/oauth/claude_cli/create_api_key";
const CLAUDE_CODE_BOOTSTRAP_MODEL = "claude-opus-4-8";
const CLAUDE_CODE_BOOTSTRAP_USER_AGENT = `claude-code/${claudeCodeVersion}`;
const CALLBACK_PORT = 54545;
const CALLBACK_PATH = "/callback";
const PASTE_REDIRECT_URI = "https://platform.claude.com/oauth/code/callback";
// Scopes required for direct OAuth-token inference (user:inference) plus account/session management.
// Console OAuth only grants API-key creation; convert that token before storage instead of
// treating it as a direct inference credential.
const DIRECT_INFERENCE_SCOPES =
	"org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";
const CONSOLE_SCOPES = DIRECT_INFERENCE_SCOPES;

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

const SENSITIVE_OAUTH_RESPONSE_KEYS: Record<string, true> = {
	access_token: true,
	refresh_token: true,
	id_token: true,
	raw_key: true,
	api_key: true,
	key: true,
};

function isRecordValue(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function redactOAuthResponseValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(redactOAuthResponseValue);
	if (isRecordValue(value)) {
		const redacted: Record<string, unknown> = {};
		for (const [key, child] of Object.entries(value)) {
			redacted[key] = SENSITIVE_OAUTH_RESPONSE_KEYS[key] ? "[redacted]" : redactOAuthResponseValue(child);
		}
		return redacted;
	}
	if (typeof value === "string" && value.startsWith("sk-ant-")) return "[redacted]";
	return value;
}

function redactOAuthResponseBody(responseBody: string): string {
	const trimmed = responseBody.trim();
	if (!trimmed) return responseBody;
	try {
		return JSON.stringify(redactOAuthResponseValue(JSON.parse(trimmed) as unknown));
	} catch {
		return responseBody.replace(/sk-ant-[A-Za-z0-9._-]+/g, "[redacted]");
	}
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
			`HTTP request failed. status=${response.status}; url=${url}; body=${redactOAuthResponseBody(responseBody)}`,
			response.status,
		);
	}
	return responseBody;
}

/**
 * Decoded shape of Anthropic's `/v1/oauth/token` response (both
 * `authorization_code` exchange and `refresh_token` refresh return the same
 * envelope). Newer responses inline `account`; older/stale credentials can
 * recover the same identity from `/api/claude_cli/bootstrap`.
 */
interface AnthropicTokenResponse {
	access_token: string;
	refresh_token: string;
	expires_in: number;
	scope?: string;
	account?: { uuid?: string; email_address?: string };
}

interface AnthropicBootstrapResponse {
	oauth_account?: {
		account_uuid?: string;
		account_email?: string;
	};
}

function parseOAuthTokenResponse(responseBody: string, operation: string): AnthropicTokenResponse {
	try {
		return JSON.parse(responseBody) as AnthropicTokenResponse;
	} catch (error) {
		throw new AIError.OAuthError(
			`Anthropic ${operation} returned invalid JSON. url=${TOKEN_URL}; body=${redactOAuthResponseBody(responseBody)}; details=${formatErrorDetails(error)}`,
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
		data = JSON.parse(responseBody) as AnthropicBootstrapResponse;
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

function createAnthropicAuthorizationUrl(args: {
	authorizationUrl: string;
	state: string;
	redirectUri: string;
	scope: string;
	challenge: string;
}): string {
	const authParams = new URLSearchParams({
		code: "true",
		client_id: CLIENT_ID,
		response_type: "code",
		redirect_uri: args.redirectUri,
		scope: args.scope,
		code_challenge: args.challenge,
		code_challenge_method: "S256",
		state: args.state,
	});
	return `${args.authorizationUrl}?${authParams.toString()}`;
}

async function exchangeAnthropicAuthorizationCode(args: {
	code: string;
	state: string;
	redirectUri: string;
	verifier: string;
	fetchImpl: FetchImpl;
	requireInferenceScope?: boolean;
}): Promise<AnthropicTokenResponse> {
	let responseBody: string;
	try {
		responseBody = await postJson(
			TOKEN_URL,
			{
				grant_type: "authorization_code",
				client_id: CLIENT_ID,
				code: args.code,
				state: args.state,
				redirect_uri: args.redirectUri,
				code_verifier: args.verifier,
			},
			args.fetchImpl,
		);
	} catch (error) {
		throw new AIError.OAuthError(
			`Token exchange request failed. url=${TOKEN_URL}; redirect_uri=${args.redirectUri}; response_type=authorization_code; details=${formatErrorDetails(error)}`,
			{ kind: "token-exchange", provider: "anthropic", cause: error },
		);
	}

	const tokenData = parseOAuthTokenResponse(responseBody, "token exchange");
	if (args.requireInferenceScope && tokenData.scope && !tokenData.scope.split(/\s+/).includes("user:inference")) {
		throw new AIError.OAuthError(
			"Anthropic OAuth token is missing user:inference scope and cannot be stored as direct inference credentials",
			{ kind: "validation", provider: "anthropic" },
		);
	}
	return tokenData;
}

async function buildOAuthCredentials(
	tokenData: AnthropicTokenResponse,
	fetchImpl: FetchImpl,
): Promise<OAuthCredentials> {
	if (!tokenData.access_token || !tokenData.refresh_token || typeof tokenData.expires_in !== "number") {
		throw new AIError.OAuthError("Anthropic token response missing required fields", {
			kind: "validation",
			provider: "anthropic",
		});
	}
	const { accountId, email } = await resolveAccountIdentity(tokenData, fetchImpl);
	return {
		refresh: tokenData.refresh_token,
		access: tokenData.access_token,
		expires: Date.now() + tokenData.expires_in * 1000 - 5 * 60 * 1000,
		accountId,
		email,
	};
}

function generateOAuthState(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return Array.from(bytes)
		.map(value => value.toString(16).padStart(2, "0"))
		.join("");
}

async function requestManualAuthorizationCode(ctrl: OAuthController): Promise<string> {
	if (ctrl.onManualCodeInput) return ctrl.onManualCodeInput();
	if (ctrl.onPrompt) return ctrl.onPrompt({ message: "Paste the authorization code (or full redirect URL):" });
	throw new AIError.OAuthError("Manual authorization code input is required for this OAuth flow", {
		kind: "validation",
		provider: "anthropic",
	});
}

async function exchangeAnthropicPastedCodeToken(
	ctrl: OAuthController,
	config: {
		authorizationUrl: string;
		scope: string;
		instructions: string;
		requireInferenceScope?: boolean;
	},
): Promise<{ tokenData: AnthropicTokenResponse; fetchImpl: FetchImpl }> {
	const fetchImpl = ctrl.fetch ?? fetch;
	const pkce = await generatePKCE();
	const state = generateOAuthState();
	if (ctrl.signal?.aborted) {
		throw new AIError.LoginCancelledError(`OAuth login cancelled: ${ctrl.signal.reason}`);
	}
	const url = createAnthropicAuthorizationUrl({
		authorizationUrl: config.authorizationUrl,
		state,
		redirectUri: PASTE_REDIRECT_URI,
		scope: config.scope,
		challenge: pkce.challenge,
	});
	ctrl.onAuth?.({ url, instructions: config.instructions });
	ctrl.onProgress?.("Waiting for pasted authorization code...");
	const input = await requestManualAuthorizationCode(ctrl);
	if (ctrl.signal?.aborted) {
		throw new AIError.LoginCancelledError(`OAuth login cancelled: ${ctrl.signal.reason}`);
	}
	const parsed = parseCallbackInput(input);
	if (!parsed.code) {
		throw new AIError.OAuthError("Authorization code is required", { kind: "validation", provider: "anthropic" });
	}
	if (parsed.state && parsed.state !== state) {
		throw new AIError.OAuthError("State mismatch - possible CSRF attack", {
			kind: "validation",
			provider: "anthropic",
		});
	}
	ctrl.onProgress?.("Exchanging authorization code for tokens...");
	const tokenData = await exchangeAnthropicAuthorizationCode({
		code: parsed.code,
		state: parsed.state ?? state,
		redirectUri: PASTE_REDIRECT_URI,
		verifier: pkce.verifier,
		fetchImpl,
		requireInferenceScope: config.requireInferenceScope,
	});
	return { tokenData, fetchImpl };
}

async function createAnthropicConsoleApiKey(accessToken: string, fetchImpl: FetchImpl): Promise<string> {
	const response = await fetchImpl(OAUTH_API_KEY_URL, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${accessToken}`,
			"Content-Type": "application/json",
		},
		signal: AbortSignal.timeout(30_000),
	});
	const responseBody = await response.text();
	if (!response.ok) {
		throw new AIError.OAuthError(
			`Claude Console API key creation failed. status=${response.status}; url=${OAUTH_API_KEY_URL}; body=${redactOAuthResponseBody(responseBody)}`,
			{ kind: "token-exchange", provider: "anthropic" },
		);
	}
	let data: unknown;
	try {
		data = JSON.parse(responseBody) as unknown;
	} catch (error) {
		throw new AIError.OAuthError(
			`Claude Console API key creation returned invalid JSON. url=${OAUTH_API_KEY_URL}; body=${redactOAuthResponseBody(responseBody)}; details=${formatErrorDetails(error)}`,
			{ kind: "validation", provider: "anthropic", cause: error },
		);
	}
	if (!isRecordValue(data)) {
		throw new AIError.OAuthError("Claude Console API key response was not an object", {
			kind: "validation",
			provider: "anthropic",
		});
	}
	const rawKey = data.raw_key ?? data.api_key ?? data.key;
	if (typeof rawKey === "string" && rawKey.length > 0) return rawKey;
	throw new AIError.OAuthError("Claude Console API key response missing raw_key", {
		kind: "validation",
		provider: "anthropic",
	});
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

		const url = createAnthropicAuthorizationUrl({
			authorizationUrl: CLAUDE_AUTHORIZE_URL,
			state,
			redirectUri,
			scope: DIRECT_INFERENCE_SCOPES,
			challenge: this.#challenge,
		});

		return {
			url,
			instructions:
				"Complete login in your browser. If the browser cannot reach this machine, paste the final redirect URL or authorization code when prompted.",
		};
	}

	async exchangeToken(code: string, state: string, redirectUri: string): Promise<OAuthCredentials> {
		let exchangeCode = code;
		let exchangeState = state;
		const codeFragmentIndex = code.indexOf("#");
		if (codeFragmentIndex >= 0) {
			exchangeCode = code.slice(0, codeFragmentIndex);
			const codeFragmentState = code.slice(codeFragmentIndex + 1);
			if (codeFragmentState.length > 0) {
				exchangeState = codeFragmentState;
			}
		}

		const tokenData = await exchangeAnthropicAuthorizationCode({
			code: exchangeCode,
			state: exchangeState,
			redirectUri,
			verifier: this.#verifier,
			fetchImpl: this.#fetch,
			requireInferenceScope: true,
		});
		return buildOAuthCredentials(tokenData, this.#fetch);
	}
}

/**
 * Login with Anthropic OAuth
 */
export async function loginAnthropic(ctrl: OAuthController): Promise<OAuthCredentials> {
	const flow = new AnthropicOAuthFlow(ctrl);
	return flow.login();
}

export async function loginAnthropicClaudeCode(ctrl: OAuthController): Promise<OAuthCredentials> {
	const { tokenData, fetchImpl } = await exchangeAnthropicPastedCodeToken(ctrl, {
		authorizationUrl: CLAUDE_AUTHORIZE_URL,
		scope: DIRECT_INFERENCE_SCOPES,
		instructions:
			"Open the URL, complete Claude Code subscription login, then paste the authorization code shown by the hosted callback page.",
		requireInferenceScope: true,
	});
	return buildOAuthCredentials(tokenData, fetchImpl);
}

export async function loginAnthropicConsole(ctrl: OAuthController): Promise<string> {
	const { tokenData, fetchImpl } = await exchangeAnthropicPastedCodeToken(ctrl, {
		authorizationUrl: CONSOLE_AUTHORIZE_URL,
		scope: CONSOLE_SCOPES,
		instructions:
			"Open the URL, authorize Claude Console API-key creation, then paste the authorization code shown by the hosted callback page.",
	});
	if (!tokenData.access_token) {
		throw new AIError.OAuthError("Claude Console token response missing access_token", {
			kind: "validation",
			provider: "anthropic",
		});
	}
	return createAnthropicConsoleApiKey(tokenData.access_token, fetchImpl);
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
