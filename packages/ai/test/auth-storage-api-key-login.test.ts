import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import * as deepseekModule from "@oh-my-pi/pi-ai/registry/deepseek";
import * as kagiModule from "@oh-my-pi/pi-ai/registry/kagi";
import {
	type OAuthProviderInterface,
	registerOAuthProvider,
	unregisterOAuthProviders,
} from "@oh-my-pi/pi-ai/registry/oauth";
import * as anthropicModule from "@oh-my-pi/pi-ai/registry/oauth/anthropic";
import * as ollamaCloudModule from "@oh-my-pi/pi-ai/registry/ollama-cloud";
import * as aiStream from "@oh-my-pi/pi-ai/stream";
import { removeWithRetries } from "../../utils/src/temp";

const RUNTIME_PROVIDER_SOURCE = "auth-storage-api-key-login-test";

function countCredentialRows(dbPath: string, provider: string): number {
	const db = new Database(dbPath, { readonly: true });
	try {
		const row = db.prepare("SELECT COUNT(*) AS count FROM auth_credentials WHERE provider = ?").get(provider) as
			| { count?: number }
			| undefined;
		return row?.count ?? 0;
	} finally {
		db.close();
	}
}

function countCredentialRowsByDisabledState(dbPath: string, provider: string, disabled: boolean): number {
	const disabledClause = disabled ? "IS NOT NULL" : "IS NULL";
	const db = new Database(dbPath, { readonly: true });
	try {
		const row = db
			.prepare(
				`SELECT COUNT(*) AS count FROM auth_credentials WHERE provider = ? AND disabled_cause ${disabledClause}`,
			)
			.get(provider) as { count?: number } | undefined;
		return row?.count ?? 0;
	} finally {
		db.close();
	}
}

describe("AuthStorage api-key login upsert", () => {
	// A live env var now (correctly) overrides a stored static api_key. These tests verify that a
	// freshly stored api_key resolves through AuthStorage.getApiKey, so neutralize the env leg
	// entirely — this ignores every provider's ambient env key, not just the few set locally.
	let tempDir = "";
	let dbPath = "";
	let store: SqliteAuthCredentialStore | null = null;
	let authStorage: AuthStorage | null = null;
	let loginAnthropicConsoleSpy: Mock<typeof anthropicModule.loginAnthropicConsole>;
	let loginDeepSeekSpy: Mock<typeof deepseekModule.loginDeepSeek>;
	let loginKagiSpy: Mock<typeof kagiModule.loginKagi>;
	let loginOllamaCloudSpy: Mock<typeof ollamaCloudModule.loginOllamaCloud>;

	beforeEach(async () => {
		vi.spyOn(aiStream, "getEnvApiKey").mockReturnValue(undefined);
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-auth-api-key-login-"));
		dbPath = path.join(tempDir, "agent.db");
		store = await SqliteAuthCredentialStore.open(dbPath);
		authStorage = new AuthStorage(store);
		loginAnthropicConsoleSpy = vi.spyOn(anthropicModule, "loginAnthropicConsole");
		loginDeepSeekSpy = vi.spyOn(deepseekModule, "loginDeepSeek");
		loginKagiSpy = vi.spyOn(kagiModule, "loginKagi");
		loginOllamaCloudSpy = vi.spyOn(ollamaCloudModule, "loginOllamaCloud");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		unregisterOAuthProviders(RUNTIME_PROVIDER_SOURCE);
		store?.close();
		store = null;
		authStorage = null;
		dbPath = "";
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
		}
	});

	it("reuses the stored api-key row when re-login returns the same key", async () => {
		if (!store || !authStorage || !dbPath) throw new Error("test setup failed");

		loginKagiSpy.mockResolvedValueOnce("same-kagi-key").mockResolvedValueOnce("same-kagi-key");

		const controller = {
			onAuth: () => {},
			onPrompt: async () => "",
		};

		await authStorage.login("kagi", controller);
		await authStorage.login("kagi", controller);

		expect(countCredentialRows(dbPath, "kagi")).toBe(1);
		const credentials = store.listAuthCredentials("kagi");
		expect(credentials).toHaveLength(1);
		const [stored] = credentials;
		expect(stored?.credential.type).toBe("api_key");
		if (stored?.credential.type !== "api_key") {
			throw new Error("expected stored api-key credential");
		}
		expect(stored.credential.key).toBe("same-kagi-key");
		expect(store.getApiKey("kagi")).toBe("same-kagi-key");
		expect(await authStorage.getApiKey("kagi", "session-kagi-relogin")).toBe("same-kagi-key");
		expect(await authStorage.resolveApiKey("kagi", "session-kagi-relogin")).toEqual({
			apiKey: "same-kagi-key",
		});
	});

	it("persists only Console logins with the Anthropic request profile across SQLite reopen", async () => {
		if (!store || !authStorage || !dbPath) throw new Error("test setup failed");

		await authStorage.set("anthropic", {
			type: "oauth",
			access: "oauth-access-token",
			refresh: "oauth-refresh-token",
			expires: Date.now() + 60 * 60_000,
		});
		expect(await authStorage.resolveApiKey("anthropic", "oauth-session")).toEqual({
			apiKey: "oauth-access-token",
		});

		loginAnthropicConsoleSpy.mockResolvedValueOnce("console-api-key");
		await authStorage.login("anthropic-console", {
			onAuth: () => {},
			onPrompt: async () => "",
		});

		expect(store.listAuthCredentials("anthropic-console")).toEqual([]);
		expect(store.listAuthCredentials("anthropic").map(entry => entry.credential)).toEqual([
			{ type: "api_key", key: "console-api-key", apiKeyRequestProfile: "anthropic-console" },
		]);

		store.close();
		store = await SqliteAuthCredentialStore.open(dbPath);
		authStorage = new AuthStorage(store);
		await authStorage.reload();

		expect(await authStorage.resolveApiKey("anthropic", "reopened-session")).toEqual({
			apiKey: "console-api-key",
			apiKeyRequestProfile: "anthropic-console",
		});
	});

	it("does not let a runtime provider assign the reserved Anthropic Console request profile", async () => {
		if (!store || !authStorage) throw new Error("test setup failed");

		const runtimeProvider: OAuthProviderInterface & { readonly apiKeyRequestProfile: "anthropic-console" } = {
			id: "runtime-console-profile",
			name: "Untrusted runtime Console profile",
			sourceId: RUNTIME_PROVIDER_SOURCE,
			storeCredentialsAs: "anthropic",
			apiKeyRequestProfile: "anthropic-console",
			login: async () => "runtime-api-key",
		};
		registerOAuthProvider(runtimeProvider);

		await authStorage.login("runtime-console-profile", {
			onAuth: () => {},
			onPrompt: async () => "",
		});

		expect(store.listAuthCredentials("runtime-console-profile")).toEqual([]);
		expect(store.listAuthCredentials("anthropic").map(entry => entry.credential)).toEqual([
			{ type: "api_key", key: "runtime-api-key" },
		]);
		expect(await authStorage.resolveApiKey("anthropic", "runtime-profile-session")).toEqual({
			apiKey: "runtime-api-key",
		});
	});

	it("keeps legacy profile-free API-key rows profile-free after SQLite reopen", async () => {
		if (!store || !authStorage || !dbPath) throw new Error("test setup failed");

		store.saveApiKey("anthropic", "legacy-api-key");
		store.close();
		store = await SqliteAuthCredentialStore.open(dbPath);
		authStorage = new AuthStorage(store);
		await authStorage.reload();

		expect(await authStorage.resolveApiKey("anthropic", "legacy-session")).toEqual({
			apiKey: "legacy-api-key",
		});
	});

	it("clears a resolver's Console profile when a retry resolves a plain API key", async () => {
		if (!authStorage) throw new Error("test setup failed");

		await authStorage.set("anthropic", {
			type: "api_key",
			key: "console-api-key",
			apiKeyRequestProfile: "anthropic-console",
		});
		const resolver = authStorage.resolver("anthropic", { sessionId: "profile-switch-session" });
		const resolveWithProfile = async (lastChance: boolean, error: unknown) =>
			resolver.resolveWithMetadata?.({ lastChance, error });

		expect(await resolveWithProfile(false, undefined)).toEqual({
			apiKey: "console-api-key",
			apiKeyRequestProfile: "anthropic-console",
		});

		await authStorage.set("anthropic", { type: "api_key", key: "plain-api-key" });
		expect(await resolveWithProfile(false, Object.assign(new Error("401"), { status: 401 }))).toEqual({
			apiKey: "plain-api-key",
			apiKeyRequestProfile: undefined,
		});
	});
	it("appends a different api-key row when re-login returns a new key", async () => {
		if (!store || !authStorage || !dbPath) throw new Error("test setup failed");

		loginKagiSpy.mockResolvedValueOnce("first-kagi-key").mockResolvedValueOnce("second-kagi-key");

		const controller = {
			onAuth: () => {},
			onPrompt: async () => "",
		};

		await authStorage.login("kagi", controller);
		await authStorage.login("kagi", controller);

		expect(countCredentialRows(dbPath, "kagi")).toBe(2);
		expect(countCredentialRowsByDisabledState(dbPath, "kagi", false)).toBe(2);
		expect(countCredentialRowsByDisabledState(dbPath, "kagi", true)).toBe(0);

		const credentials = store.listAuthCredentials("kagi");
		expect(credentials.map(entry => entry.credential)).toEqual([
			{ type: "api_key", key: "first-kagi-key" },
			{ type: "api_key", key: "second-kagi-key" },
		]);
		const rotatedKeys = [await authStorage.getApiKey("kagi"), await authStorage.getApiKey("kagi")].sort();
		expect(rotatedKeys).toEqual(["first-kagi-key", "second-kagi-key"]);
	});

	it("hard-deletes superseded api-key rows when a different key replaces them", () => {
		if (!store || !dbPath) throw new Error("test setup failed");

		store.saveApiKey("kagi", "old-key-123");
		store.saveApiKey("kagi", "new-key-456");

		expect(countCredentialRows(dbPath, "kagi")).toBe(1);
		expect(countCredentialRowsByDisabledState(dbPath, "kagi", false)).toBe(1);
		expect(countCredentialRowsByDisabledState(dbPath, "kagi", true)).toBe(0);
		expect(store.getApiKey("kagi")).toBe("new-key-456");
	});

	it("reuses the stored api-key row when ollama-cloud re-login returns the same key", async () => {
		if (!store || !authStorage || !dbPath) throw new Error("test setup failed");

		loginOllamaCloudSpy.mockResolvedValueOnce("same-ollama-cloud-key").mockResolvedValueOnce("same-ollama-cloud-key");

		const controller = {
			onAuth: () => {},
			onPrompt: async () => "",
		};

		await authStorage.login("ollama-cloud", controller);
		await authStorage.login("ollama-cloud", controller);

		expect(countCredentialRows(dbPath, "ollama-cloud")).toBe(1);
		const credentials = store.listAuthCredentials("ollama-cloud");
		expect(credentials).toHaveLength(1);
		const [stored] = credentials;
		expect(stored?.credential.type).toBe("api_key");
		if (stored?.credential.type !== "api_key") {
			throw new Error("expected stored api-key credential");
		}
		expect(stored.credential.key).toBe("same-ollama-cloud-key");
		expect(store.getApiKey("ollama-cloud")).toBe("same-ollama-cloud-key");
		expect(await authStorage.getApiKey("ollama-cloud", "session-ollama-cloud-relogin")).toBe("same-ollama-cloud-key");
	});

	it("stores DeepSeek login credentials as a reusable api-key credential", async () => {
		if (!store || !authStorage || !dbPath) throw new Error("test setup failed");

		loginDeepSeekSpy.mockResolvedValueOnce("same-deepseek-key").mockResolvedValueOnce("same-deepseek-key");

		const controller = {
			onAuth: () => {},
			onPrompt: async () => "",
		};

		await authStorage.login("deepseek", controller);
		await authStorage.login("deepseek", controller);

		expect(countCredentialRows(dbPath, "deepseek")).toBe(1);
		const credentials = store.listAuthCredentials("deepseek");
		expect(credentials).toHaveLength(1);
		const [stored] = credentials;
		expect(stored?.credential.type).toBe("api_key");
		if (stored?.credential.type !== "api_key") {
			throw new Error("expected stored api-key credential");
		}
		expect(stored.credential.key).toBe("same-deepseek-key");
		expect(store.getApiKey("deepseek")).toBe("same-deepseek-key");
		expect(await authStorage.getApiKey("deepseek", "session-deepseek-relogin")).toBe("same-deepseek-key");
	});
});
