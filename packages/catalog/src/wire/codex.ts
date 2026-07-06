/**
 * Constants for OpenAI Codex (ChatGPT OAuth) backend
 */

export const CODEX_BASE_URL = "https://chatgpt.com/backend-api";

export const OPENAI_HEADERS = {
	BETA: "OpenAI-Beta",
	ACCOUNT_ID: "chatgpt-account-id",
	ORIGINATOR: "originator",
	SESSION_ID: "session_id",
	CONVERSATION_ID: "conversation_id",
	/** Pins edge routing to the workspace's compute-residency pool (mirrors codex-rs). */
	RESIDENCY: "x-openai-internal-codex-residency",
} as const;

export const OPENAI_HEADER_VALUES = {
	BETA_RESPONSES: "responses=experimental",
	BETA_RESPONSES_WEBSOCKETS_V2: "responses_websockets=2026-02-06",
	ORIGINATOR_CODEX: "pi",
} as const;

export const URL_PATHS = {
	RESPONSES: "/responses",
	CODEX_RESPONSES: "/codex/responses",
} as const;

export const JWT_CLAIM_PATH = "https://api.openai.com/auth" as const;

interface CodexAuthClaims {
	chatgpt_account_id?: string;
	chatgpt_compute_residency?: string;
}

function getCodexAuthClaims(accessToken: string): CodexAuthClaims | undefined {
	try {
		const parts = accessToken.split(".");
		if (parts.length !== 3) return undefined;
		const decoded = Buffer.from(parts[1] ?? "", "base64").toString("utf-8");
		const payload = JSON.parse(decoded) as Record<string, unknown>;
		return payload[JWT_CLAIM_PATH] as CodexAuthClaims | undefined;
	} catch {
		return undefined;
	}
}

/**
 * Extract account ID from a Codex JWT access token.
 * Returns undefined if the token is not a valid Codex JWT.
 */
export function getCodexAccountId(accessToken: string): string | undefined {
	const accountId = getCodexAuthClaims(accessToken)?.chatgpt_account_id;
	return typeof accountId === "string" && accountId.length > 0 ? accountId : undefined;
}

/**
 * Extract the workspace compute-residency region (`chatgpt_compute_residency`,
 * e.g. "us") from a Codex JWT access token. Requests missing the matching
 * {@link OPENAI_HEADERS.RESIDENCY} header get geo-routed by client IP and are
 * rejected with 401 "Workspace is not authorized in this region." when the IP
 * region differs from the workspace's residency.
 */
export function getCodexComputeResidency(accessToken: string): string | undefined {
	const residency = getCodexAuthClaims(accessToken)?.chatgpt_compute_residency;
	return typeof residency === "string" && residency.length > 0 ? residency : undefined;
}
