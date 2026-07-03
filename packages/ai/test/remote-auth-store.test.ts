import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AuthCredential, AuthStorage, REMOTE_REFRESH_SENTINEL, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import {
	AuthBrokerClient,
	type AuthBrokerServerHandle,
	RemoteAuthCredentialStore,
	startAuthBroker,
} from "@oh-my-pi/pi-ai/auth-broker";
import * as AIError from "@oh-my-pi/pi-ai/error";
import * as oauthUtils from "@oh-my-pi/pi-ai/registry/oauth";
import * as anthropicModule from "@oh-my-pi/pi-ai/registry/oauth/anthropic";
import type { UsageLimit, UsageReport } from "@oh-my-pi/pi-ai/usage";
import { removeWithRetries } from "../../utils/src/temp";

function requireLimit(report: UsageReport, id: string): UsageLimit {
	const limit = report.limits.find(candidate => candidate.id === id);
	if (!limit) throw new Error(`expected ${id} limit`);
	return limit;
}

const ANTHROPIC_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"] as const;
const savedEnv: Partial<Record<(typeof ANTHROPIC_ENV)[number], string | undefined>> = {};

describe("RemoteAuthCredentialStore + AuthStorage integration", () => {
	let tempDir = "";
	let serverStore: SqliteAuthCredentialStore | undefined;
	let serverStorage: AuthStorage | undefined;
	let handle: AuthBrokerServerHandle | undefined;
	const token = "remote-bearer";

	beforeEach(async () => {
		for (const key of ANTHROPIC_ENV) {
			savedEnv[key] = process.env[key];
			delete process.env[key];
		}
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "auth-broker-remote-"));
		serverStore = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		serverStore.saveOAuth("anthropic", {
			access: "server-access-1",
			refresh: "server-refresh-1",
			expires: Date.now() - 60_000, // expired so refresh is forced
			accountId: "account-1",
			email: "a@example.com",
		});
		serverStorage = new AuthStorage(serverStore);
		await serverStorage.reload();
		handle = startAuthBroker({
			storage: serverStorage,
			bind: "127.0.0.1:0",
			bearerTokens: [token],
			disableRefresher: true,
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await handle?.close();
		serverStorage?.close();
		serverStore?.close();
		await removeWithRetries(tempDir);
		for (const key of ANTHROPIC_ENV) {
			if (savedEnv[key] === undefined) delete process.env[key];
			else process.env[key] = savedEnv[key];
		}
	});

	test("client-side AuthStorage refreshes via broker override, never via local OAuth path", async () => {
		// Real refresh executed by the broker server; mock surfaces the rotated tokens.
		const rotated = {
			access: "server-access-rotated",
			refresh: "server-refresh-rotated",
			expires: Date.now() + 120_000,
			accountId: "account-1",
			email: "a@example.com",
		};
		const refreshSpy = vi.spyOn(oauthUtils, "refreshOAuthToken").mockResolvedValue(rotated);

		const brokerClient = new AuthBrokerClient({ url: handle!.url, token });
		const initialResult = await brokerClient.fetchSnapshot();
		if (initialResult.status !== 200) throw new Error("expected snapshot");
		const initialSnapshot = initialResult.snapshot;
		expect(initialSnapshot.credentials).toHaveLength(1);

		const remoteStore = new RemoteAuthCredentialStore({
			client: brokerClient,
			initialSnapshot,
		});

		let overrideCalls = 0;
		const clientStorage = new AuthStorage(remoteStore, {
			refreshOAuthCredential: async (_provider, credentialId, _credential) => {
				overrideCalls += 1;
				const { entry } = await brokerClient.refreshCredential(credentialId);
				if (entry.credential.type !== "oauth") throw new Error("unexpected");
				return {
					access: entry.credential.access,
					refresh: REMOTE_REFRESH_SENTINEL,
					expires: entry.credential.expires,
					accountId: entry.credential.accountId,
					email: entry.credential.email,
				};
			},
		});
		await clientStorage.reload();

		const apiKey = await clientStorage.getApiKey("anthropic");
		expect(apiKey).toBe("server-access-rotated");
		expect(overrideCalls).toBe(1);
		// The local oauth refresh helper was used exactly once — by the broker server.
		expect(refreshSpy).toHaveBeenCalledTimes(1);
		clientStorage.close();
	});
	test("suspect credential refresh updates the client snapshot from the broker response", async () => {
		const rotated = {
			access: "server-access-after-401",
			refresh: "server-refresh-after-401",
			expires: Date.now() + 120_000,
			accountId: "account-1",
			email: "a@example.com",
		};
		const refreshSpy = vi.spyOn(oauthUtils, "refreshOAuthToken").mockResolvedValue(rotated);

		const brokerClient = new AuthBrokerClient({ url: handle!.url, token });
		const initialResult = await brokerClient.fetchSnapshot();
		if (initialResult.status !== 200) throw new Error("expected snapshot");
		const initialEntry = initialResult.snapshot.credentials[0];
		if (!initialEntry) throw new Error("expected credential");

		const remoteStore = new RemoteAuthCredentialStore({
			client: brokerClient,
			initialSnapshot: initialResult.snapshot,
		});

		await remoteStore.markCredentialSuspect(initialEntry.id);
		const rows = remoteStore.listAuthCredentials("anthropic");

		expect(rows).toHaveLength(1);
		expect(rows[0]?.credential.type).toBe("oauth");
		if (rows[0]?.credential.type === "oauth") {
			expect(rows[0].credential.access).toBe("server-access-after-401");
			expect(rows[0].credential.refresh).toBe(REMOTE_REFRESH_SENTINEL);
		}
		expect(refreshSpy).toHaveBeenCalledTimes(1);
		remoteStore.close();
	});

	test("RemoteAuthCredentialStore rejects writes from the client", () => {
		const remoteStore = new RemoteAuthCredentialStore({
			client: new AuthBrokerClient({ url: handle!.url, token }),
		});
		expect(() => remoteStore.replaceAuthCredentialsForProvider("anthropic", [])).toThrow(/read-only/);
		expect(() => remoteStore.upsertAuthCredentialForProvider("anthropic", { type: "api_key", key: "x" })).toThrow(
			/read-only/,
		);
		expect(() => remoteStore.deleteAuthCredentialsForProvider("anthropic", "x")).toThrow(/read-only/);
		remoteStore.close();
	});

	test("getUsageReport coalesces parallel callers and matches by identity", async () => {
		const brokerClient = new AuthBrokerClient({ url: handle!.url, token });
		const remoteStore = new RemoteAuthCredentialStore({
			client: brokerClient,
			initialSnapshot: {
				generation: 0,
				generatedAt: 0,
				serverNowMs: 0,
				refresher: { enabled: false, intervalMs: 0, skewMs: 0, nextSweepInMs: Number.MAX_SAFE_INTEGER },
				credentials: [],
			},
		});

		const reportForA = {
			provider: "anthropic" as const,
			fetchedAt: Date.now(),
			limits: [],
			metadata: { email: "a@example.com" },
		};
		const reportForB = {
			provider: "anthropic" as const,
			fetchedAt: Date.now(),
			limits: [],
			metadata: { email: "b@example.com" },
		};
		const fetchSpy = vi
			.spyOn(brokerClient, "fetchUsage")
			.mockResolvedValue({ generatedAt: Date.now(), reports: [reportForA, reportForB] });

		const credA = {
			type: "oauth" as const,
			access: "ax",
			refresh: REMOTE_REFRESH_SENTINEL,
			expires: Date.now() + 60_000,
			email: "a@example.com",
		};
		const credB = { ...credA, email: "b@example.com" };

		const [resA, resB] = await Promise.all([
			remoteStore.getUsageReport("anthropic", credA),
			remoteStore.getUsageReport("anthropic", credB),
		]);
		// Parallel callers share a single broker round-trip.
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(resA?.metadata?.email).toBe("a@example.com");
		expect(resB?.metadata?.email).toBe("b@example.com");

		// Cached on the second call — still one fetch total.
		const cached = await remoteStore.getUsageReport("anthropic", credA);
		expect(cached?.metadata?.email).toBe("a@example.com");
		expect(fetchSpy).toHaveBeenCalledTimes(1);

		// Unknown provider → null, no extra fetch.
		const miss = await remoteStore.getUsageReport("openai-codex", credA);
		expect(miss).toBeNull();
		expect(fetchSpy).toHaveBeenCalledTimes(1);

		remoteStore.close();
	});

	test("getUsageReport caches broker fetch failure for USAGE_CACHE_TTL_MS", async () => {
		const brokerClient = new AuthBrokerClient({ url: handle!.url, token });
		const remoteStore = new RemoteAuthCredentialStore({
			client: brokerClient,
			initialSnapshot: {
				generation: 0,
				generatedAt: 0,
				serverNowMs: 0,
				refresher: { enabled: false, intervalMs: 0, skewMs: 0, nextSweepInMs: Number.MAX_SAFE_INTEGER },
				credentials: [],
			},
		});

		const fetchSpy = vi.spyOn(brokerClient, "fetchUsage").mockRejectedValue(new Error("broker offline"));

		const nowSpy = vi.spyOn(Date, "now");
		nowSpy.mockReturnValue(1_000_000);

		// First sequential failure caches null.
		const first = await remoteStore.fetchUsageReports();
		expect(first).toBeNull();
		expect(fetchSpy).toHaveBeenCalledTimes(1);

		// Second call within 15s TTL is served from the cached null — no new fetch.
		nowSpy.mockReturnValue(1_000_000 + 14_999);
		const second = await remoteStore.fetchUsageReports();
		expect(second).toBeNull();
		expect(fetchSpy).toHaveBeenCalledTimes(1);

		// getUsageReport shares the same negative cache.
		const cred = {
			type: "oauth" as const,
			access: "ax",
			refresh: REMOTE_REFRESH_SENTINEL,
			expires: Date.now() + 60_000,
			email: "a@example.com",
		};
		const perCred = await remoteStore.getUsageReport("anthropic", cred);
		expect(perCred).toBeNull();
		expect(fetchSpy).toHaveBeenCalledTimes(1);

		// After the documented 15s TTL expires, the client retries once and hits the broker again.
		nowSpy.mockReturnValue(1_000_000 + 15_000 + 1);
		const retried = await remoteStore.fetchUsageReports();
		expect(retried).toBeNull();
		expect(fetchSpy).toHaveBeenCalledTimes(2);

		remoteStore.close();
	});

	test("ingestUsageReport overlays only the matching Anthropic report and getUsageReport returns the overlaid Fable row", async () => {
		const brokerClient = new AuthBrokerClient({ url: handle!.url, token });
		const remoteStore = new RemoteAuthCredentialStore({
			client: brokerClient,
			initialSnapshot: {
				generation: 0,
				generatedAt: 0,
				serverNowMs: 0,
				refresher: { enabled: false, intervalMs: 0, skewMs: 0, nextSweepInMs: Number.MAX_SAFE_INTEGER },
				credentials: [],
			},
		});
		const now = Date.now();

		const reportForA: UsageReport = {
			provider: "anthropic",
			fetchedAt: now - 20_000,
			limits: [
				{
					id: "anthropic:5h",
					label: "Claude 5 Hour",
					scope: { provider: "anthropic", windowId: "5h", shared: true },
					window: { id: "5h", label: "5 Hour" },
					amount: { used: 42, limit: 100, usedFraction: 0.42, unit: "percent" },
					status: "ok",
				},
				{
					id: "anthropic:7d",
					label: "Claude 7 Day",
					scope: { provider: "anthropic", windowId: "7d", shared: true },
					window: { id: "7d", label: "7 Day" },
					amount: { used: 84, limit: 100, usedFraction: 0.84, unit: "percent" },
					status: "ok",
				},
				{
					id: "anthropic:7d:fable",
					label: "Claude 7 Day (Fable)",
					scope: { provider: "anthropic", windowId: "7d", tier: "fable" },
					window: { id: "7d", label: "7 Day" },
					amount: { used: 11, limit: 100, usedFraction: 0.11, unit: "percent" },
					status: "ok",
				},
				{
					id: "anthropic:7d:opus",
					label: "Claude 7 Day (Opus)",
					scope: { provider: "anthropic", windowId: "7d", tier: "opus" },
					window: { id: "7d", label: "7 Day" },
					amount: { used: 12, limit: 100, usedFraction: 0.12, unit: "percent" },
					status: "ok",
				},
			],
			metadata: { accountId: "account-a", email: "a@example.com" },
		};
		const reportForB: UsageReport = {
			provider: "anthropic",
			fetchedAt: now - 10_000,
			limits: [
				{
					id: "anthropic:7d:fable",
					label: "Claude 7 Day (Fable)",
					scope: { provider: "anthropic", windowId: "7d", tier: "fable" },
					window: { id: "7d", label: "7 Day" },
					amount: { used: 13, limit: 100, usedFraction: 0.13, unit: "percent" },
					status: "ok",
				},
			],
			metadata: { accountId: "account-b", email: "b@example.com" },
		};
		const fetchSpy = vi
			.spyOn(brokerClient, "fetchUsage")
			.mockResolvedValue({ generatedAt: now, reports: [reportForA, reportForB] });

		const credA = {
			type: "oauth" as const,
			access: "ax",
			refresh: REMOTE_REFRESH_SENTINEL,
			expires: now + 60_000,
			accountId: "account-a",
			email: "a@example.com",
		};
		const credB = { ...credA, access: "bx", accountId: "account-b", email: "b@example.com" };
		const overlay: UsageReport = {
			provider: "anthropic",
			fetchedAt: now,
			limits: [
				{
					id: "anthropic:7d:fable",
					label: "Claude 7 Day (Fable)",
					scope: { provider: "anthropic", windowId: "7d", tier: "fable" },
					window: { id: "7d", label: "7 Day", resetsAt: 1_780_617_600_000 },
					amount: {
						used: 61,
						limit: 100,
						usedFraction: 0.61,
						remainingFraction: 0.39,
						unit: "percent",
					},
					status: "ok",
				},
			],
			metadata: { accountId: "account-a", email: "a@example.com", headersUpdatedAt: 1_780_000_000_000 },
		};

		expect(remoteStore.ingestUsageReport("anthropic", credA, overlay)).toBe(true);

		const reports = await remoteStore.fetchUsageReports();
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(reports).not.toBeNull();
		const reportA = reports?.find(report => report.metadata?.accountId === "account-a");
		const reportB = reports?.find(report => report.metadata?.accountId === "account-b");
		if (!reportA || !reportB) throw new Error("expected anthropic reports for both broker accounts");

		expect(reportA.metadata?.email).toBe("a@example.com");
		expect(reportA.metadata?.headersUpdatedAt).toBe(1_780_000_000_000);
		expect(reportA.limits.filter(limit => limit.id === "anthropic:7d:fable")).toHaveLength(1);
		expect(requireLimit(reportA, "anthropic:5h").amount.used).toBe(42);
		expect(requireLimit(reportA, "anthropic:7d").amount.used).toBe(84);
		expect(requireLimit(reportA, "anthropic:7d:opus").amount.used).toBe(12);
		const overlaidFable = requireLimit(reportA, "anthropic:7d:fable");
		expect(overlaidFable.amount.used).toBe(61);
		expect(overlaidFable.amount.usedFraction).toBeCloseTo(0.61);
		expect(overlaidFable.window?.resetsAt).toBe(1_780_617_600_000);

		expect(reportB.metadata?.email).toBe("b@example.com");
		expect(reportB.metadata?.headersUpdatedAt).toBeUndefined();
		expect(requireLimit(reportB, "anthropic:7d:fable").amount.used).toBe(13);

		const perCredA = await remoteStore.getUsageReport("anthropic", credA);
		const perCredB = await remoteStore.getUsageReport("anthropic", credB);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(perCredA).not.toBeNull();
		expect(perCredB).not.toBeNull();
		expect(requireLimit(perCredA!, "anthropic:7d:fable").amount.used).toBe(61);
		expect(requireLimit(perCredB!, "anthropic:7d:fable").amount.used).toBe(13);

		remoteStore.close();
	});

	test("fetchUsageReports keeps a broker failure null even when a client overlay exists", async () => {
		const brokerClient = new AuthBrokerClient({ url: handle!.url, token });
		const remoteStore = new RemoteAuthCredentialStore({
			client: brokerClient,
			initialSnapshot: {
				generation: 0,
				generatedAt: 0,
				serverNowMs: 0,
				refresher: { enabled: false, intervalMs: 0, skewMs: 0, nextSweepInMs: Number.MAX_SAFE_INTEGER },
				credentials: [],
			},
		});
		const fetchSpy = vi.spyOn(brokerClient, "fetchUsage").mockRejectedValue(new Error("broker offline"));
		const now = Date.now();
		const cred = {
			type: "oauth" as const,
			access: "ax",
			refresh: REMOTE_REFRESH_SENTINEL,
			expires: now + 60_000,
			accountId: "account-a",
			email: "a@example.com",
		};
		const overlay: UsageReport = {
			provider: "anthropic",
			fetchedAt: now,
			limits: [
				{
					id: "anthropic:7d:fable",
					label: "Claude 7 Day (Fable)",
					scope: { provider: "anthropic", windowId: "7d", tier: "fable" },
					window: { id: "7d", label: "7 Day" },
					amount: { used: 61, limit: 100, usedFraction: 0.61, remainingFraction: 0.39, unit: "percent" },
					status: "ok",
				},
			],
			metadata: { accountId: "account-a", email: "a@example.com", headersUpdatedAt: 1_780_000_000_000 },
		};

		expect(remoteStore.ingestUsageReport("anthropic", cred, overlay)).toBe(true);

		const first = await remoteStore.fetchUsageReports();
		expect(first).toBeNull();
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const perCred = await remoteStore.getUsageReport("anthropic", cred);
		expect(perCred).not.toBeNull();
		expect(requireLimit(perCred!, "anthropic:7d:fable").amount.used).toBe(61);
		expect(fetchSpy).toHaveBeenCalledTimes(1);

		const second = await remoteStore.fetchUsageReports();
		expect(second).toBeNull();
		expect(fetchSpy).toHaveBeenCalledTimes(1);

		remoteStore.close();
	});

	test("client AuthStorage.set forwards api_key login to the broker (replace semantics)", async () => {
		// Pre-existing api_key for the same provider on the server side — a fresh
		// login should disable it and replace it with the new key.
		serverStore!.saveApiKey("kagi", "old-key");
		await serverStorage!.reload();

		const brokerClient = new AuthBrokerClient({ url: handle!.url, token });
		const initialResult = await brokerClient.fetchSnapshot();
		if (initialResult.status !== 200) throw new Error("expected snapshot");
		const remoteStore = new RemoteAuthCredentialStore({
			client: brokerClient,
			initialSnapshot: initialResult.snapshot,
		});
		const clientStorage = new AuthStorage(remoteStore);
		await clientStorage.reload();

		await clientStorage.set("kagi", { type: "api_key", key: "new-key" });

		// Server is the source of truth — only the new key should be active.
		const activeOnServer = serverStore!.listAuthCredentials("kagi");
		expect(activeOnServer).toHaveLength(1);
		expect(activeOnServer[0].credential).toEqual({ type: "api_key", key: "new-key" });

		// Client reflects the new key through the broker's `POST /v1/credential`
		// response without waiting for the long-poll snapshot tick.
		expect(clientStorage.get("kagi")).toEqual({ type: "api_key", key: "new-key" });
		clientStorage.close();
	});

	test("failed remote replace preserves visible rows when a hidden profiled credential makes upload conflict", async () => {
		serverStorage!.upsertCredential("anthropic", {
			type: "api_key",
			key: "hidden-console-key",
			apiKeyRequestProfile: "anthropic-console",
		});
		const serverRowsBefore = structuredClone(serverStore!.listAuthCredentials("anthropic"));
		expect(serverRowsBefore).toHaveLength(2);
		expect(serverRowsBefore.some(row => row.credential.type === "oauth")).toBe(true);
		expect(
			serverRowsBefore.some(
				row => row.credential.type === "api_key" && row.credential.apiKeyRequestProfile === "anthropic-console",
			),
		).toBe(true);
		const generationBefore = serverStorage!.getGeneration();

		const brokerClient = new AuthBrokerClient({ url: handle!.url, token });
		const initialResult = await brokerClient.fetchSnapshot();
		if (initialResult.status !== 200) throw new Error("expected snapshot");
		const visibleAnthropicRows = initialResult.snapshot.credentials.filter(entry => entry.provider === "anthropic");
		expect(visibleAnthropicRows).toHaveLength(1);
		expect(visibleAnthropicRows[0]?.credential.type).toBe("oauth");
		expect(initialResult.generation).toBe(generationBefore);

		const remoteStore = new RemoteAuthCredentialStore({
			client: brokerClient,
			initialSnapshot: initialResult.snapshot,
			streamSnapshots: false,
		});
		const clientStorage = new AuthStorage(remoteStore);
		await clientStorage.reload();
		const clientSnapshotBefore = structuredClone(remoteStore.snapshot);
		const uploadSpy = vi.spyOn(brokerClient, "uploadCredential");
		const disableSpy = vi.spyOn(brokerClient, "disableCredential");

		try {
			await expect(clientStorage.set("anthropic", { type: "api_key", key: "replacement-api-key" })).rejects.toThrow(
				/409 Conflict/,
			);

			expect(uploadSpy).toHaveBeenCalledTimes(1);
			expect(disableSpy).toHaveBeenCalledTimes(0);
			expect(serverStore!.listAuthCredentials("anthropic")).toEqual(serverRowsBefore);
			expect(serverStorage!.getGeneration()).toBe(generationBefore);
			expect(remoteStore.snapshot).toEqual(clientSnapshotBefore);
		} finally {
			clientStorage.close();
		}
	});

	test("same-key remote replace keeps the broker-returned active row instead of disabling it", async () => {
		const provider = "same-key-visible";
		serverStore!.saveApiKey(provider, "same-api-key");
		await serverStorage!.reload();
		const activeBefore = serverStore!.listAuthCredentials(provider);
		expect(activeBefore).toHaveLength(1);
		const existingId = activeBefore[0]!.id;

		const brokerClient = new AuthBrokerClient({ url: handle!.url, token });
		const initialResult = await brokerClient.fetchSnapshot();
		if (initialResult.status !== 200) throw new Error("expected snapshot");
		const remoteStore = new RemoteAuthCredentialStore({
			client: brokerClient,
			initialSnapshot: initialResult.snapshot,
			streamSnapshots: false,
		});
		const clientStorage = new AuthStorage(remoteStore);
		await clientStorage.reload();
		const uploadSpy = vi.spyOn(brokerClient, "uploadCredential");
		const disableSpy = vi.spyOn(brokerClient, "disableCredential");

		try {
			await clientStorage.set(provider, { type: "api_key", key: "same-api-key" });

			expect(uploadSpy).toHaveBeenCalledTimes(1);
			expect(disableSpy).toHaveBeenCalledTimes(0);
			const expectedActiveRow = {
				id: existingId,
				provider,
				credential: { type: "api_key" as const, key: "same-api-key" },
				disabledCause: null,
			};
			expect(serverStore!.listAuthCredentials(provider)).toEqual([expectedActiveRow]);
			expect(clientStorage.listStoredCredentials(provider)).toEqual([expectedActiveRow]);
		} finally {
			clientStorage.close();
		}
	});

	test.each([
		[
			"OAuth then API key",
			"legacy-multi-oauth-key",
			[
				{
					type: "oauth",
					access: "oauth-first-access",
					refresh: "oauth-first-refresh",
					expires: 4_102_444_800_000,
					accountId: "oauth-first-account",
					email: "oauth-first@example.com",
				},
				{ type: "api_key", key: "replacement-api-key" },
			] satisfies AuthCredential[],
		],
		[
			"two distinct OAuth credentials",
			"legacy-multi-two-oauth",
			[
				{
					type: "oauth",
					access: "oauth-a-access",
					refresh: "oauth-a-refresh",
					expires: 4_102_444_800_000,
					accountId: "oauth-account-a",
					email: "oauth-a@example.com",
				},
				{
					type: "oauth",
					access: "oauth-b-access",
					refresh: "oauth-b-refresh",
					expires: 4_102_444_800_000,
					accountId: "oauth-account-b",
					email: "oauth-b@example.com",
				},
			] satisfies AuthCredential[],
		],
		[
			"API key then OAuth",
			"legacy-multi-key-oauth",
			[
				{ type: "api_key", key: "replacement-api-key-first" },
				{
					type: "oauth",
					access: "oauth-second-access",
					refresh: "oauth-second-refresh",
					expires: 4_102_444_800_000,
					accountId: "oauth-second-account",
					email: "oauth-second@example.com",
				},
			] satisfies AuthCredential[],
		],
	] as const)("rejects legacy multi-replace for %s before any broker mutation", async (_name, provider, credentials) => {
		serverStore!.saveApiKey(provider, `existing-${provider}-key`);
		await serverStorage!.reload();

		const brokerClient = new AuthBrokerClient({ url: handle!.url, token });
		const initialResult = await brokerClient.fetchSnapshot();
		if (initialResult.status !== 200) throw new Error("expected snapshot");
		const remoteStore = new RemoteAuthCredentialStore({
			client: brokerClient,
			initialSnapshot: initialResult.snapshot,
			streamSnapshots: false,
		});
		const clientStorage = new AuthStorage(remoteStore);
		await clientStorage.reload();
		const serverRowsBefore = structuredClone(serverStore!.listAuthCredentials());
		const generationBefore = serverStorage!.getGeneration();
		const clientSnapshotBefore = structuredClone(remoteStore.snapshot);
		const uploadSpy = vi.spyOn(brokerClient, "uploadCredential");
		const disableSpy = vi.spyOn(brokerClient, "disableCredential");

		try {
			const rejection = await clientStorage.set(provider, credentials).then(
				() => undefined,
				(error: unknown) => error,
			);

			expect(rejection).toBeInstanceOf(AIError.AuthBrokerError);
			expect(rejection).toMatchObject({
				message:
					"Auth broker protocol v1 does not support atomic replacement with multiple credentials. Log in on the broker host or upgrade the broker protocol before replacing multiple credentials.",
			});
			expect(uploadSpy).toHaveBeenCalledTimes(0);
			expect(disableSpy).toHaveBeenCalledTimes(0);
			expect(serverStore!.listAuthCredentials()).toEqual(serverRowsBefore);
			expect(serverStorage!.getGeneration()).toBe(generationBefore);
			expect(remoteStore.snapshot).toEqual(clientSnapshotBefore);
		} finally {
			clientStorage.close();
		}
	});

	test("empty remote replace still disables the existing credential", async () => {
		const provider = "legacy-empty-replace";
		serverStore!.saveApiKey(provider, "existing-empty-replace-key");
		await serverStorage!.reload();

		const brokerClient = new AuthBrokerClient({ url: handle!.url, token });
		const initialResult = await brokerClient.fetchSnapshot();
		if (initialResult.status !== 200) throw new Error("expected snapshot");
		const remoteStore = new RemoteAuthCredentialStore({
			client: brokerClient,
			initialSnapshot: initialResult.snapshot,
			streamSnapshots: false,
		});
		const clientStorage = new AuthStorage(remoteStore);
		await clientStorage.reload();
		const uploadSpy = vi.spyOn(brokerClient, "uploadCredential");
		const disableSpy = vi.spyOn(brokerClient, "disableCredential");

		try {
			await clientStorage.set(provider, []);

			expect(uploadSpy).toHaveBeenCalledTimes(0);
			expect(disableSpy).toHaveBeenCalledTimes(1);
			expect(serverStore!.listAuthCredentials(provider)).toEqual([]);
			expect(clientStorage.listStoredCredentials(provider)).toEqual([]);
		} finally {
			clientStorage.close();
		}
	});

	test("rejects remote Console login before OAuth, key creation, or credential mutation", async () => {
		const brokerClient = new AuthBrokerClient({ url: handle!.url, token });
		const initialResult = await brokerClient.fetchSnapshot();
		if (initialResult.status !== 200) throw new Error("expected snapshot");
		const remoteStore = new RemoteAuthCredentialStore({
			client: brokerClient,
			initialSnapshot: initialResult.snapshot,
			streamSnapshots: false,
		});
		const clientStorage = new AuthStorage(remoteStore);
		await clientStorage.reload();

		const loginSpy = vi.spyOn(anthropicModule, "loginAnthropicConsole");
		const uploadSpy = vi.spyOn(brokerClient, "uploadCredential");
		const disableSpy = vi.spyOn(brokerClient, "disableCredential");
		const onAuth = vi.fn();
		const onProgress = vi.fn();
		const onPrompt = vi.fn(async () => "authorization-code");
		const onManualCodeInput = vi.fn(async () => "authorization-code");
		const createKeyFetch = vi.fn(async () => new Response('{"raw_key":"should-not-be-created"}'));
		const clientSnapshotBefore = structuredClone(remoteStore.snapshot);
		const clientCredentialsBefore = structuredClone(clientStorage.getAll());
		const serverCredentialsBefore = structuredClone(serverStore!.listAuthCredentials("anthropic"));
		const serverGenerationBefore = serverStorage!.getGeneration();

		try {
			await expect(
				clientStorage.login("anthropic-console", {
					onAuth,
					onProgress,
					onPrompt,
					onManualCodeInput,
					fetch: createKeyFetch,
				}),
			).rejects.toThrow(/Log in on the broker host or upgrade the broker protocol/);

			expect(loginSpy).toHaveBeenCalledTimes(0);
			expect(onAuth).toHaveBeenCalledTimes(0);
			expect(onProgress).toHaveBeenCalledTimes(0);
			expect(onPrompt).toHaveBeenCalledTimes(0);
			expect(onManualCodeInput).toHaveBeenCalledTimes(0);
			expect(createKeyFetch).toHaveBeenCalledTimes(0);
			expect(uploadSpy).toHaveBeenCalledTimes(0);
			expect(disableSpy).toHaveBeenCalledTimes(0);
			expect(remoteStore.snapshot).toEqual(clientSnapshotBefore);
			expect(clientStorage.getAll()).toEqual(clientCredentialsBefore);
			expect(serverStore!.listAuthCredentials("anthropic")).toEqual(serverCredentialsBefore);
			expect(serverStorage!.getGeneration()).toBe(serverGenerationBefore);
		} finally {
			clientStorage.close();
		}
	});

	test("profiled API-key upsert and replace fail closed before changing local or broker state", async () => {
		const providers = ["profiled-upsert", "profiled-replace"] as const;
		for (const provider of providers) {
			serverStorage!.upsertCredential(provider, { type: "api_key", key: `old-${provider}` });
		}

		const brokerClient = new AuthBrokerClient({ url: handle!.url, token });
		const initialResult = await brokerClient.fetchSnapshot();
		if (initialResult.status !== 200) throw new Error("expected snapshot");
		const initialGeneration = initialResult.snapshot.generation;
		const remoteStore = new RemoteAuthCredentialStore({
			client: brokerClient,
			initialSnapshot: initialResult.snapshot,
			streamSnapshots: false,
		});
		const profiledCredential = {
			type: "api_key" as const,
			key: "console-key",
			apiKeyRequestProfile: "anthropic-console" as const,
		};

		try {
			const results = await Promise.allSettled([
				remoteStore.upsertAuthCredentialRemote(providers[0], profiledCredential),
				remoteStore.replaceAuthCredentialsRemote(providers[1], [profiledCredential]),
			]);

			for (const result of results) {
				expect(result.status).toBe("rejected");
				if (result.status === "rejected") {
					expect(String(result.reason)).toContain("protocol v1 does not support profiled API keys");
				}
			}
			for (const provider of providers) {
				const expected = [{ type: "api_key", key: `old-${provider}` }] satisfies AuthCredential[];
				expect(serverStore!.listAuthCredentials(provider).map(entry => entry.credential)).toEqual(expected);
				expect(remoteStore.listAuthCredentials(provider).map(entry => entry.credential)).toEqual(expected);
			}
			expect(serverStorage!.getGeneration()).toBe(initialGeneration);
			expect(remoteStore.snapshot.generation).toBe(initialGeneration);
		} finally {
			remoteStore.close();
		}
	});

	test("client AuthStorage.remove disables every broker-side credential for the provider (logout)", async () => {
		serverStore!.saveApiKey("kagi", "k1");
		serverStore!.saveOAuth("kagi", {
			access: "oauth-access",
			refresh: "oauth-refresh",
			expires: Date.now() + 120_000,
			accountId: "acct-kagi",
			email: "user@example.com",
		});
		await serverStorage!.reload();

		const brokerClient = new AuthBrokerClient({ url: handle!.url, token });
		const initialResult = await brokerClient.fetchSnapshot();
		if (initialResult.status !== 200) throw new Error("expected snapshot");
		const remoteStore = new RemoteAuthCredentialStore({
			client: brokerClient,
			initialSnapshot: initialResult.snapshot,
		});
		const clientStorage = new AuthStorage(remoteStore);
		await clientStorage.reload();

		await clientStorage.remove("kagi");

		expect(serverStore!.listAuthCredentials("kagi")).toEqual([]);
		expect(clientStorage.get("kagi")).toBeUndefined();
		clientStorage.close();
	});
});
