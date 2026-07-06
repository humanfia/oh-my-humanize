import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test, vi } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { PASTE_CODE_LOGIN_PROVIDERS, PROVIDER_REGISTRY } from "@oh-my-pi/pi-ai/registry";
import {
	getOAuthProviders,
	refreshOAuthToken,
	registerOAuthProvider,
	unregisterOAuthProviders,
} from "@oh-my-pi/pi-ai/registry/oauth";
import * as anthropicOauth from "@oh-my-pi/pi-ai/registry/oauth/anthropic";
import type { OAuthCredentials, OAuthProvider } from "@oh-my-pi/pi-ai/registry/oauth/types";
import { getEnvApiKey } from "@oh-my-pi/pi-ai/stream";

const FIXTURE_SOURCE = "provider-registry-test";
const ENV_KEYS = [
	"COREWEAVE_API_KEY",
	"ZENMUX_API_KEY",
	"EXA_API_KEY",
	"XAI_OAUTH_TOKEN",
	"UMANS_AI_CODING_PLAN_API_KEY",
	"LLAMA_CPP_API_KEY",
	"WANDB_API_KEY",
] as const;
const originalEnv = new Map(ENV_KEYS.map(key => [key, Bun.env[key]]));

afterEach(() => {
	unregisterOAuthProviders(FIXTURE_SOURCE);
	for (const key of ENV_KEYS) {
		const original = originalEnv.get(key);
		if (original === undefined) {
			delete Bun.env[key];
		} else {
			Bun.env[key] = original;
		}
	}
	vi.restoreAllMocks();
});

describe("provider registry auth surface", () => {
	test("env-key map merges catalog names, registry defs, and legacy keys", () => {
		Bun.env.ZENMUX_API_KEY = "zenmux-env";
		Bun.env.EXA_API_KEY = "exa-env";
		// Plain name derived from the catalog table's `envVars`.
		expect(getEnvApiKey("zenmux")).toBe("zenmux-env");
		Bun.env.UMANS_AI_CODING_PLAN_API_KEY = "umans-env";
		expect(getEnvApiKey("umans")).toBe("umans-env");
		Bun.env.LLAMA_CPP_API_KEY = "llama-env";
		expect(getEnvApiKey("llama.cpp")).toBe("llama-env");
		// Legacy search-tool key preserved (not a registry provider def).
		expect(getEnvApiKey("exa")).toBe("exa-env");
	});

	test("multi-var catalog env fallback picks names in order", () => {
		Bun.env.XAI_OAUTH_TOKEN = "xai-oauth-env";
		expect(getEnvApiKey("xai-oauth")).toBe("xai-oauth-env");

		Bun.env.WANDB_API_KEY = "wandb-env";
		expect(getEnvApiKey("coreweave")).toBe("wandb-env");
		Bun.env.COREWEAVE_API_KEY = "coreweave-env";
		expect(getEnvApiKey("coreweave")).toBe("coreweave-env");
	});

	test("login list contains loginable providers and excludes env-only model providers", () => {
		const ids = getOAuthProviders().map(provider => provider.id);
		expect(ids).toContain("zenmux");
		expect(ids).toContain("kagi");
		expect(ids).toContain("umans");
		expect(ids).toContain("llama.cpp");
		// openai has no interactive login flow.
		expect(ids).not.toContain("openai");
	});

	test("login list keeps Codex device flow visible beside Codex browser login", () => {
		const providers = getOAuthProviders();
		const ids = providers.map(provider => provider.id);
		const codexIndex = ids.indexOf("openai-codex");
		const deviceIndex = ids.indexOf("openai-codex-device");

		expect(codexIndex).toBeGreaterThanOrEqual(0);
		expect(deviceIndex).toBe(codexIndex + 1);
		expect(deviceIndex).toBeLessThan(10);
		expect(providers[deviceIndex]).toMatchObject({
			id: "openai-codex-device",
			name: "ChatGPT Plus/Pro (Codex, headless/device)",
			available: true,
			storeCredentialsAs: "openai-codex",
		});
	});

	test("Claude Code and Console logins share Anthropic storage and pasted-code UX", () => {
		const providers = getOAuthProviders();
		const claudeCode = providers.find(provider => provider.id === "anthropic-code");
		const claudeConsole = providers.find(provider => provider.id === "anthropic-console");

		expect(claudeCode).toMatchObject({
			id: "anthropic-code",
			available: true,
			storeCredentialsAs: "anthropic",
		});
		expect(claudeCode?.name).toContain("Claude Code");
		expect(PASTE_CODE_LOGIN_PROVIDERS.has("anthropic-code")).toBe(true);

		expect(claudeConsole).toMatchObject({
			id: "anthropic-console",
			available: true,
			storeCredentialsAs: "anthropic",
		});
		expect(claudeConsole?.name).toContain("Claude Console");
		expect(PASTE_CODE_LOGIN_PROVIDERS.has("anthropic-console")).toBe(true);

		const profiledProviders = PROVIDER_REGISTRY.filter(provider => provider.apiKeyRequestProfile !== undefined).map(
			provider => ({ id: provider.id, apiKeyRequestProfile: provider.apiKeyRequestProfile }),
		);
		expect(profiledProviders).toEqual([{ id: "anthropic-console", apiKeyRequestProfile: "anthropic-console" }]);
	});

	test("paste-code login set is derived from pasteCodeFlow", () => {
		expect([...PASTE_CODE_LOGIN_PROVIDERS].sort()).toEqual(
			[
				"anthropic",
				"anthropic-code",
				"anthropic-console",
				"devin",
				"gitlab-duo",
				"gitlab-duo-agent",
				"google-antigravity",
				"google-gemini-cli",
				"openai-codex",
			].sort(),
		);
		expect(PASTE_CODE_LOGIN_PROVIDERS.has("zenmux")).toBe(false);
	});

	test("refresh dispatch returns api-key providers unchanged and routes real refreshers", async () => {
		const creds: OAuthCredentials = { refresh: "r", access: "a", expires: Date.now() + 60_000 };
		// zenmux has no refresher → returned as-is.
		expect(await refreshOAuthToken("zenmux", creds)).toBe(creds);

		const refreshed: OAuthCredentials = { refresh: "r2", access: "a2", expires: Date.now() + 120_000 };
		const spy = vi.spyOn(anthropicOauth, "refreshAnthropicToken").mockResolvedValue(refreshed);
		expect(await refreshOAuthToken("anthropic", creds)).toBe(refreshed);
		expect(spy).toHaveBeenCalledWith("r");

		await expect(refreshOAuthToken("nonexistent-provider" as OAuthProvider, creds)).rejects.toThrow(
			"Unknown OAuth provider",
		);
	});

	test("login dispatcher handles runtime-registered extension providers", async () => {
		const store = new SqliteAuthCredentialStore(new Database(":memory:"));
		const storage = new AuthStorage(store);
		await storage.reload();
		registerOAuthProvider({
			id: "fixture-x",
			name: "Fixture X",
			sourceId: FIXTURE_SOURCE,
			login: async () => "fixture-key",
		});

		await storage.login("fixture-x", { onAuth: () => {}, onPrompt: async () => "" });

		expect(store.getApiKey("fixture-x")).toBe("fixture-key");
	});

	test("login dispatcher stores string credentials under provider aliases", async () => {
		const store = new SqliteAuthCredentialStore(new Database(":memory:"));
		const storage = new AuthStorage(store);
		await storage.reload();
		registerOAuthProvider({
			id: "fixture-alias-login",
			name: "Fixture Alias Login",
			sourceId: FIXTURE_SOURCE,
			storeCredentialsAs: "fixture-target",
			login: async () => "fixture-api-key",
		});

		await storage.login("fixture-alias-login", { onAuth: () => {}, onPrompt: async () => "" });

		expect(store.getApiKey("fixture-alias-login")).toBeNull();
		expect(store.getApiKey("fixture-target")).toBe("fixture-api-key");
	});

	test("login dispatcher can replace aliased target credentials with a returned API key", async () => {
		const store = new SqliteAuthCredentialStore(new Database(":memory:"));
		const storage = new AuthStorage(store);
		await storage.reload();
		await storage.set("fixture-target", {
			type: "oauth",
			access: "old-oauth-access",
			refresh: "old-oauth-refresh",
			expires: Date.now() + 60_000,
		});
		registerOAuthProvider({
			id: "fixture-replacing-alias-login",
			name: "Fixture Replacing Alias Login",
			sourceId: FIXTURE_SOURCE,
			storeCredentialsAs: "fixture-target",
			replaceCredentialsOnApiKeyLogin: true,
			login: async () => "fixture-api-key",
		});

		await storage.login("fixture-replacing-alias-login", { onAuth: () => {}, onPrompt: async () => "" });

		expect(await storage.getApiKey("fixture-target")).toBe("fixture-api-key");
		expect(storage.listStoredCredentials("fixture-target").map(entry => entry.credential)).toEqual([
			{ type: "api_key", key: "fixture-api-key" },
		]);
	});

	test("llama.cpp login stores a local no-auth token when no key is entered", async () => {
		const store = new SqliteAuthCredentialStore(new Database(":memory:"));
		const storage = new AuthStorage(store);
		await storage.reload();

		await storage.login("llama.cpp", { onAuth: () => {}, onPrompt: async () => "" });

		expect(store.getApiKey("llama.cpp")).toBe("llama-cpp-local");
	});
});
