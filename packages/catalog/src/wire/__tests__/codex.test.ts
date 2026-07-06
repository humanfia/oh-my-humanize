import { describe, expect, it } from "bun:test";
import { getCodexAccountId, getCodexComputeResidency } from "../codex";

/**
 * The wire-level claim key is part of OpenAI's token contract, so the tests
 * assert against the literal string rather than importing the constant —
 * silently changing it in source would break real tokens.
 */
const AUTH_CLAIM = "https://api.openai.com/auth";

const HEADER_B64 = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");

/** Builds a structurally real JWT: base64url header + payload, dummy signature. */
function makeJwt(payload: unknown): string {
	return `${HEADER_B64}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

const FULL_TOKEN = makeJwt({
	[AUTH_CLAIM]: { chatgpt_compute_residency: "us", chatgpt_account_id: "acc-123" },
});

describe("getCodexComputeResidency", () => {
	it("extracts the residency region from the OpenAI auth claim", () => {
		expect(getCodexComputeResidency(FULL_TOKEN)).toBe("us");
	});

	it("accepts a standard (padded) base64 payload, not just base64url", () => {
		const json = JSON.stringify({ [AUTH_CLAIM]: { chatgpt_compute_residency: "eu" }, pad: "x" });
		const payloadB64 = Buffer.from(json).toString("base64");
		// Precondition: this encoding actually differs from base64url (has `=` padding).
		expect(payloadB64.endsWith("=")).toBe(true);
		expect(getCodexComputeResidency(`${HEADER_B64}.${payloadB64}.signature`)).toBe("eu");
	});

	it("returns undefined when the auth claim lacks residency or it is empty", () => {
		const missing = makeJwt({ [AUTH_CLAIM]: { chatgpt_account_id: "acc-123" } });
		expect(getCodexComputeResidency(missing)).toBeUndefined();

		const empty = makeJwt({ [AUTH_CLAIM]: { chatgpt_compute_residency: "" } });
		expect(getCodexComputeResidency(empty)).toBeUndefined();
	});

	it("returns undefined for a non-string residency value", () => {
		const numeric = makeJwt({ [AUTH_CLAIM]: { chatgpt_compute_residency: 42 } });
		expect(getCodexComputeResidency(numeric)).toBeUndefined();
	});

	it("returns undefined when the payload has no usable auth claim", () => {
		expect(getCodexComputeResidency(makeJwt({ sub: "user-1" }))).toBeUndefined();
		// Claim key present but not an object.
		expect(getCodexComputeResidency(makeJwt({ [AUTH_CLAIM]: "us" }))).toBeUndefined();
	});

	it("returns undefined for malformed tokens instead of throwing", () => {
		const payloadB64 = Buffer.from(
			JSON.stringify({ [AUTH_CLAIM]: { chatgpt_compute_residency: "us" } }),
		).toString("base64url");
		const malformed: Record<string, string> = {
			"empty string": "",
			"two segments": `${HEADER_B64}.${payloadB64}`,
			"junk base64 payload": `${HEADER_B64}.@@!not/valid/base64!@@.signature`,
			"valid base64 of non-JSON": `${HEADER_B64}.${Buffer.from("not json at all").toString("base64url")}.signature`,
		};
		for (const [name, token] of Object.entries(malformed)) {
			expect(getCodexComputeResidency(token), name).toBeUndefined();
		}
	});
});

describe("getCodexAccountId (shared decode path)", () => {
	it("extracts the account id from the same auth claim", () => {
		expect(getCodexAccountId(FULL_TOKEN)).toBe("acc-123");
	});

	it("reads its claim independently of residency", () => {
		const accountOnly = makeJwt({ [AUTH_CLAIM]: { chatgpt_account_id: "acc-9" } });
		expect(getCodexAccountId(accountOnly)).toBe("acc-9");
		expect(getCodexComputeResidency(accountOnly)).toBeUndefined();
	});

	it("returns undefined for missing, empty, or non-string account ids and malformed tokens", () => {
		expect(getCodexAccountId(makeJwt({ [AUTH_CLAIM]: { chatgpt_compute_residency: "us" } }))).toBeUndefined();
		expect(getCodexAccountId(makeJwt({ [AUTH_CLAIM]: { chatgpt_account_id: "" } }))).toBeUndefined();
		expect(getCodexAccountId(makeJwt({ [AUTH_CLAIM]: { chatgpt_account_id: 7 } }))).toBeUndefined();
		expect(getCodexAccountId("only.two")).toBeUndefined();
	});
});
