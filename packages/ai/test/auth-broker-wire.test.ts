import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, REMOTE_REFRESH_SENTINEL, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import {
	AuthBrokerClient,
	type AuthBrokerServerHandle,
	AuthBrokerStreamUnsupportedError,
	type SnapshotStreamEvent,
	startAuthBroker,
} from "@oh-my-pi/pi-ai/auth-broker";
import * as oauthUtils from "@oh-my-pi/pi-ai/registry/oauth";
import { removeWithRetries } from "../../utils/src/temp";

const ANTHROPIC_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"] as const;
const savedEnv: Partial<Record<(typeof ANTHROPIC_ENV)[number], string | undefined>> = {};

function mintOAuthCredential(suffix: string, expires: number) {
	return {
		type: "oauth" as const,
		access: `access-${suffix}`,
		refresh: `refresh-${suffix}`,
		expires,
		accountId: `account-${suffix}`,
		email: `${suffix}@example.com`,
	};
}

function mintPeerProfiledCredential() {
	return {
		type: "api_key" as const,
		key: "peer-console-key",
		apiKeyRequestProfile: "anthropic-console" as const,
	};
}

describe("auth-broker wire surface", () => {
	let tempDir = "";
	let store: SqliteAuthCredentialStore | undefined;
	let storage: AuthStorage | undefined;
	let peerStore: SqliteAuthCredentialStore | undefined;
	let peerStorage: AuthStorage | undefined;
	let handle: AuthBrokerServerHandle | undefined;
	let token = "";

	beforeEach(async () => {
		for (const key of ANTHROPIC_ENV) {
			savedEnv[key] = process.env[key];
			delete process.env[key];
		}
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "auth-broker-wire-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		store.saveOAuth("anthropic", mintOAuthCredential("a", Date.now() + 60_000));
		storage = new AuthStorage(store);
		await storage.reload();
		token = "test-bearer";
		handle = startAuthBroker({
			storage,
			bind: "127.0.0.1:0",
			bearerTokens: [token],
			disableRefresher: true,
		});
	});

	async function connectPeerStorage(): Promise<SqliteAuthCredentialStore> {
		peerStore = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		peerStorage = new AuthStorage(peerStore);
		await peerStorage.reload();
		return peerStore;
	}

	async function expectPeerProfilePreserved(id: number): Promise<void> {
		await peerStorage!.reload();
		const expectedRows = [
			{
				id,
				provider: "anthropic",
				disabledCause: null,
				credential: mintPeerProfiledCredential(),
			},
		];
		expect(peerStore!.listAuthCredentials("anthropic")).toEqual(expectedRows);
		expect(store!.listAuthCredentials("anthropic")).toEqual(expectedRows);
		expect(peerStorage!.listStoredCredentials("anthropic")).toEqual(expectedRows);
	}
	afterEach(async () => {
		vi.restoreAllMocks();
		await handle?.close();
		peerStorage?.close();
		peerStore?.close();
		storage?.close();
		store?.close();
		await removeWithRetries(tempDir);
		for (const key of ANTHROPIC_ENV) {
			if (savedEnv[key] === undefined) delete process.env[key];
			else process.env[key] = savedEnv[key];
		}
	});

	test("GET /v1/healthz returns ok without auth", async () => {
		const res = await fetch(`${handle!.url}/v1/healthz`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean };
		expect(body.ok).toBe(true);
	});

	test("GET /v1/snapshot requires bearer and redacts refresh tokens", async () => {
		const unauthorized = await fetch(`${handle!.url}/v1/snapshot`);
		expect(unauthorized.status).toBe(401);

		const client = new AuthBrokerClient({ url: handle!.url, token });
		const snapshotResult = await client.fetchSnapshot();
		if (snapshotResult.status !== 200) throw new Error("expected snapshot");
		const snapshot = snapshotResult.snapshot;
		expect(snapshot.credentials).toHaveLength(1);
		const entry = snapshot.credentials[0];
		expect(entry.provider).toBe("anthropic");
		expect(entry.credential.type).toBe("oauth");
		if (entry.credential.type === "oauth") {
			expect(entry.credential.access).toBe("access-a");
			// Refresh token is replaced with the wire sentinel — clients never see it.
			expect(entry.credential.refresh).toBe(REMOTE_REFRESH_SENTINEL);
		}
	});

	test("strict v1 upload rejects a profiled API key without changing generation or stored state", async () => {
		storage!.upsertCredential("strict-profile", { type: "api_key", key: "old-key" });
		const generationBefore = storage!.getGeneration();

		const response = await fetch(`${handle!.url}/v1/credential`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				provider: "strict-profile",
				credential: {
					type: "api_key",
					key: "console-key",
					apiKeyRequestProfile: "anthropic-console",
				},
			}),
		});

		expect(response.status).toBe(400);
		expect(storage!.getGeneration()).toBe(generationBefore);
		expect(store!.listAuthCredentials("strict-profile").map(entry => entry.credential)).toEqual([
			{ type: "api_key", key: "old-key" },
		]);
		const snapshotResult = await new AuthBrokerClient({ url: handle!.url, token }).fetchSnapshot();
		if (snapshotResult.status !== 200) throw new Error("expected snapshot");
		expect(snapshotResult.generation).toBe(generationBefore);
		expect(
			snapshotResult.snapshot.credentials
				.filter(entry => entry.provider === "strict-profile")
				.map(entry => entry.credential),
		).toEqual([{ type: "api_key", key: "old-key" }]);
	});

	test("legacy v1 uploads reject a provider containing a profiled API key before any mutation", async () => {
		storage!.upsertCredential("anthropic", {
			type: "api_key",
			key: "console-key",
			apiKeyRequestProfile: "anthropic-console",
		});
		const client = new AuthBrokerClient({ url: handle!.url, token });
		const initialClientResult = await client.fetchSnapshot();
		if (initialClientResult.status !== 200) throw new Error("expected snapshot");
		const generationBefore = storage!.getGeneration();
		const storedRowsBefore = structuredClone(store!.listAuthCredentials("anthropic"));
		const brokerRowsBefore = structuredClone(storage!.exportSnapshot().credentials);
		const clientRowsBefore = structuredClone(initialClientResult.snapshot.credentials);
		expect(initialClientResult.generation).toBe(generationBefore);

		const upsertSpy = vi.spyOn(storage!, "upsertCredential");
		const attempts = [
			mintOAuthCredential("legacy-upload", Date.now() + 120_000),
			{ type: "api_key" as const, key: "console-key" },
		];

		for (const credential of attempts) {
			const response = await fetch(`${handle!.url}/v1/credential`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ provider: "anthropic", credential }),
			});

			expect(response.status).toBe(409);
			expect(await response.json()).toEqual({
				error: "Provider anthropic contains credentials unsupported by auth-broker v1",
			});
			expect(upsertSpy).toHaveBeenCalledTimes(0);
			expect(store!.listAuthCredentials("anthropic")).toEqual(storedRowsBefore);
			expect(storage!.exportSnapshot().credentials).toEqual(brokerRowsBefore);
			expect(storage!.getGeneration()).toBe(generationBefore);

			const clientResult = await client.fetchSnapshot();
			if (clientResult.status !== 200) throw new Error("expected snapshot");
			expect(clientResult.status).toBe(200);
			expect(clientResult.generation).toBe(generationBefore);
			expect(clientResult.snapshot.credentials).toEqual(clientRowsBefore);
		}
	});

	test("hidden profiled credential ids return identical 404s without invoking storage mutations", async () => {
		storage!.upsertCredential("anthropic", {
			type: "api_key",
			key: "hidden-console-key",
			apiKeyRequestProfile: "anthropic-console",
		});
		const hiddenRow = store!
			.listAuthCredentials("anthropic")
			.find(row => row.credential.type === "api_key" && row.credential.apiKeyRequestProfile !== undefined);
		if (!hiddenRow) throw new Error("expected profiled credential row");

		const client = new AuthBrokerClient({ url: handle!.url, token });
		const initialClientResult = await client.fetchSnapshot();
		if (initialClientResult.status !== 200) throw new Error("expected snapshot");
		const generationBefore = storage!.getGeneration();
		const storedRowsBefore = structuredClone(store!.listAuthCredentials());
		const brokerRowsBefore = structuredClone(storage!.exportSnapshot().credentials);
		const clientRowsBefore = structuredClone(initialClientResult.snapshot.credentials);
		expect(initialClientResult.generation).toBe(generationBefore);

		const refreshSpy = vi.spyOn(storage!, "refreshCredentialById");
		const disableSpy = vi.spyOn(storage!, "disableCredentialById");
		const expectedError = { error: `No credential with id=${hiddenRow.id}` };
		const requests: RequestInit[] = [
			{ method: "POST", headers: { Authorization: `Bearer ${token}` } },
			{
				method: "POST",
				headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
				body: JSON.stringify({ cause: "must remain hidden" }),
			},
		];
		const suffixes = ["refresh", "disable"];

		for (let index = 0; index < suffixes.length; index += 1) {
			const response = await fetch(
				`${handle!.url}/v1/credential/${hiddenRow.id}/${suffixes[index]}`,
				requests[index],
			);
			expect(response.status).toBe(404);
			expect(await response.json()).toEqual(expectedError);
			expect(refreshSpy).toHaveBeenCalledTimes(0);
			expect(disableSpy).toHaveBeenCalledTimes(0);
			expect(store!.listAuthCredentials()).toEqual(storedRowsBefore);
			expect(storage!.exportSnapshot().credentials).toEqual(brokerRowsBefore);
			expect(storage!.getGeneration()).toBe(generationBefore);

			const clientResult = await client.fetchSnapshot();
			if (clientResult.status !== 200) throw new Error("expected snapshot");
			expect(clientResult.status).toBe(200);
			expect(clientResult.generation).toBe(generationBefore);
			expect(clientResult.snapshot.credentials).toEqual(clientRowsBefore);
		}
	});

	test("disable loses a shared-SQLite race to a peer profiled replacement", async () => {
		const peer = await connectPeerStorage();
		const cachedRows = store!.listAuthCredentials("anthropic");
		expect(cachedRows).toHaveLength(1);
		const id = cachedRows[0].id;
		const generationBefore = storage!.getGeneration();
		const brokerRowsBefore = structuredClone(storage!.exportSnapshot().credentials);
		const originalTryDisable = store!.tryDisableAuthCredentialIfMatches.bind(store!);
		vi.spyOn(store!, "tryDisableAuthCredentialIfMatches").mockImplementation(
			(credentialId, expectedData, disabledCause) => {
				peer.updateAuthCredential(credentialId, mintPeerProfiledCredential());
				return originalTryDisable(credentialId, expectedData, disabledCause);
			},
		);

		const response = await fetch(`${handle!.url}/v1/credential/${id}/disable`, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify({ cause: "stale broker must not disable peer row" }),
		});

		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: `No credential with id=${id}` });
		await expectPeerProfilePreserved(id);
		expect(storage!.getGeneration()).toBe(generationBefore);
		expect(storage!.exportSnapshot().credentials).toEqual(brokerRowsBefore);
	});

	test("refresh loses a shared-SQLite race to a peer profiled replacement", async () => {
		const peer = await connectPeerStorage();
		const cachedRows = store!.listAuthCredentials("anthropic");
		expect(cachedRows).toHaveLength(1);
		const id = cachedRows[0].id;
		const generationBefore = storage!.getGeneration();
		const brokerRowsBefore = structuredClone(storage!.exportSnapshot().credentials);
		vi.spyOn(oauthUtils, "refreshOAuthToken").mockResolvedValue({
			access: "stale-broker-refreshed-access",
			refresh: "stale-broker-refreshed-token",
			expires: Date.now() + 120_000,
			accountId: "account-a",
			email: "a@example.com",
		});
		const originalTryUpdate = store!.tryUpdateAuthCredentialIfMatches.bind(store!);
		vi.spyOn(store!, "tryUpdateAuthCredentialIfMatches").mockImplementation(
			(credentialId, provider, expectedData, credential) => {
				peer.updateAuthCredential(credentialId, mintPeerProfiledCredential());
				return originalTryUpdate(credentialId, provider, expectedData, credential);
			},
		);

		const response = await fetch(`${handle!.url}/v1/credential/${id}/refresh`, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}` },
		});

		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: `No credential with id=${id}` });
		await expectPeerProfilePreserved(id);
		expect(storage!.getGeneration()).toBe(generationBefore);
		expect(storage!.exportSnapshot().credentials).toEqual(brokerRowsBefore);
	});

	test("legacy upload atomically rejects a peer profiled replacement after its cached guard", async () => {
		const peer = await connectPeerStorage();
		const cachedRows = store!.listAuthCredentials("anthropic");
		expect(cachedRows).toHaveLength(1);
		const id = cachedRows[0].id;
		const generationBefore = storage!.getGeneration();
		const brokerRowsBefore = structuredClone(storage!.exportSnapshot().credentials);
		const originalGuardedUpsert = store!.upsertAuthCredentialForProviderIfUnprofiled.bind(store!);
		vi.spyOn(store!, "upsertAuthCredentialForProviderIfUnprofiled").mockImplementation((provider, credential) => {
			peer.updateAuthCredential(id, mintPeerProfiledCredential());
			return originalGuardedUpsert(provider, credential);
		});

		const response = await fetch(`${handle!.url}/v1/credential`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				provider: "anthropic",
				credential: { type: "api_key", key: "legacy-client-key" },
			}),
		});

		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({
			error: "Provider anthropic contains credentials unsupported by auth-broker v1",
		});
		await expectPeerProfilePreserved(id);
		expect(storage!.getGeneration()).toBe(generationBefore);
		expect(storage!.exportSnapshot().credentials).toEqual(brokerRowsBefore);
	});

	test("v1 snapshot and SSE omit profiled rows without hiding supported credentials", async () => {
		const profiledCredential = {
			type: "api_key" as const,
			key: "console-key",
			apiKeyRequestProfile: "anthropic-console" as const,
		};
		storage!.upsertCredential("console-initial", profiledCredential);
		storage!.upsertCredential("plain-initial", { type: "api_key", key: "plain-key" });

		const client = new AuthBrokerClient({ url: handle!.url, token });
		const snapshotResult = await client.fetchSnapshot();
		if (snapshotResult.status !== 200) throw new Error("expected snapshot");
		expect(snapshotResult.snapshot.credentials.map(entry => entry.provider).sort()).toEqual([
			"anthropic",
			"plain-initial",
		]);
		expect(snapshotResult.snapshot.credentials.find(entry => entry.provider === "plain-initial")?.credential).toEqual(
			{ type: "api_key", key: "plain-key" },
		);
		expect(
			snapshotResult.snapshot.credentials.find(entry => entry.provider === "anthropic")?.credential,
		).toMatchObject({
			type: "oauth",
			access: "access-a",
			refresh: REMOTE_REFRESH_SENTINEL,
		});

		const controller = new AbortController();
		const iter = client.openSnapshotStream({ signal: controller.signal });
		try {
			const first = await iter.next();
			if (first.done || first.value.kind !== "snapshot") throw new Error("expected snapshot frame");
			expect(first.value.credentials.map(entry => entry.provider).sort()).toEqual(["anthropic", "plain-initial"]);

			storage!.upsertCredential("console-delta", {
				...profiledCredential,
				key: "console-delta-key",
			});
			storage!.upsertCredential("plain-delta", { type: "api_key", key: "plain-delta-key" });

			const next = await nextMatching(iter, event => event.kind === "entry");
			if (next.kind !== "entry") throw new Error("expected entry frame");
			expect(next.entry.provider).toBe("plain-delta");
			expect(next.entry.credential).toEqual({ type: "api_key", key: "plain-delta-key" });
		} finally {
			controller.abort();
			await iter.return(undefined).catch(() => {});
		}
	});

	test("GET /v1/snapshot returns generation headers and 304 for unchanged long-poll", async () => {
		const res = await fetch(`${handle!.url}/v1/snapshot`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { generation: number; serverNowMs: number; refresher: { enabled: boolean } };
		expect(res.headers.get("etag")).toBe(`"${body.generation}"`);
		expect(res.headers.get("cache-control")).toBe("no-store");
		expect(body.generation).toBeGreaterThan(0);
		expect(body.serverNowMs).toBeGreaterThan(0);
		expect(body.refresher.enabled).toBe(false);

		const client = new AuthBrokerClient({ url: handle!.url, token });
		const unchanged = await client.fetchSnapshot({ ifGenerationGt: body.generation, waitMs: 10 });
		expect(unchanged.status).toBe(304);
		expect(unchanged.generation).toBe(body.generation);
	});

	test("GET /v1/snapshot long-poll wakes when generation changes", async () => {
		const client = new AuthBrokerClient({ url: handle!.url, token });
		const initial = await client.fetchSnapshot();
		if (initial.status !== 200) throw new Error("expected snapshot");

		const pending = client.fetchSnapshot({ ifGenerationGt: initial.generation, waitMs: 1000 });
		setTimeout(() => {
			storage!.upsertCredential("anthropic", mintOAuthCredential("b", Date.now() + 120_000));
		}, 10);

		const changed = await pending;
		expect(changed.status).toBe(200);
		if (changed.status !== 200) throw new Error("expected changed snapshot");
		expect(changed.generation).toBeGreaterThan(initial.generation);
		expect(
			changed.snapshot.credentials.some(
				entry => entry.credential.type === "oauth" && entry.credential.access === "access-b",
			),
		).toBe(true);
	});

	test("POST /v1/credential/:id/refresh mutates a visible OAuth row and returns its wire projection", async () => {
		const refreshed = {
			access: "access-rotated",
			refresh: "refresh-rotated",
			expires: Date.now() + 120_000,
			accountId: "account-a",
			email: "a@example.com",
		};
		vi.spyOn(oauthUtils, "refreshOAuthToken").mockResolvedValue(refreshed);

		const persistedBefore = store!.listAuthCredentials("anthropic");
		expect(persistedBefore).toHaveLength(1);
		const id = persistedBefore[0].id;
		const generationBefore = storage!.getGeneration();
		const response = await fetch(`${handle!.url}/v1/credential/${id}/refresh`, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}` },
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			entry: {
				id,
				provider: "anthropic",
				credential: { type: "oauth", ...refreshed, refresh: REMOTE_REFRESH_SENTINEL },
				identityKey: "email:a@example.com",
			},
		});
		expect(store!.listAuthCredentials()).toEqual([
			{
				id,
				provider: "anthropic",
				disabledCause: null,
				credential: { type: "oauth", ...refreshed },
			},
		]);
		expect(storage!.getGeneration()).toBeGreaterThan(generationBefore);

		const brokerRows = storage!.exportSnapshot().credentials;
		expect(brokerRows).toEqual([
			{
				id,
				provider: "anthropic",
				credential: { type: "oauth", ...refreshed, refresh: REMOTE_REFRESH_SENTINEL },
				identityKey: "email:a@example.com",
			},
		]);
		const clientResult = await new AuthBrokerClient({ url: handle!.url, token }).fetchSnapshot();
		if (clientResult.status !== 200) throw new Error("expected snapshot");
		expect(clientResult.status).toBe(200);
		expect(clientResult.generation).toBe(storage!.getGeneration());
		expect(clientResult.snapshot.credentials).toEqual(brokerRows.map(entry => ({ ...entry, rotatesInMs: null })));
	});

	test("POST /v1/credential/:id/disable mutates a visible API-key row and surfaces 404 thereafter", async () => {
		storage!.upsertCredential("visible-api-key", { type: "api_key", key: "visible-key" });
		const persistedBefore = structuredClone(store!.listAuthCredentials());
		const brokerRowsBefore = structuredClone(storage!.exportSnapshot().credentials);
		const apiKeyRow = persistedBefore.find(row => row.provider === "visible-api-key");
		if (!apiKeyRow) throw new Error("expected visible API-key row");
		const generationBefore = storage!.getGeneration();

		const response = await fetch(`${handle!.url}/v1/credential/${apiKeyRow.id}/disable`, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify({ cause: "revoked by user" }),
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true });

		const expectedPersistedRows = persistedBefore.filter(row => row.id !== apiKeyRow.id);
		const expectedBrokerRows = brokerRowsBefore.filter(row => row.id !== apiKeyRow.id);
		expect(store!.listAuthCredentials()).toEqual(expectedPersistedRows);
		expect(storage!.exportSnapshot().credentials).toEqual(expectedBrokerRows);
		expect(storage!.getGeneration()).toBeGreaterThan(generationBefore);

		const clientResult = await new AuthBrokerClient({ url: handle!.url, token }).fetchSnapshot();
		if (clientResult.status !== 200) throw new Error("expected snapshot");
		expect(clientResult.status).toBe(200);
		expect(clientResult.generation).toBe(storage!.getGeneration());
		expect(clientResult.snapshot.credentials).toEqual(
			expectedBrokerRows.map(entry => ({ ...entry, rotatesInMs: null })),
		);

		const missingResponse = await fetch(`${handle!.url}/v1/credential/${apiKeyRow.id}/refresh`, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(missingResponse.status).toBe(404);
		expect(await missingResponse.json()).toEqual({ error: `No credential with id=${apiKeyRow.id}` });
		expect(store!.listAuthCredentials()).toEqual(expectedPersistedRows);
		expect(storage!.exportSnapshot().credentials).toEqual(expectedBrokerRows);
		expect(storage!.getGeneration()).toBe(clientResult.generation);
	});

	test("Unknown route returns 404", async () => {
		const res = await fetch(`${handle!.url}/v1/nope`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(res.status).toBe(404);
	});

	test("GET /v1/snapshot/stream requires bearer", async () => {
		const res = await fetch(`${handle!.url}/v1/snapshot/stream`);
		expect(res.status).toBe(401);
	});

	test("SSE stream emits initial snapshot then upsert delta", async () => {
		const client = new AuthBrokerClient({ url: handle!.url, token });
		const controller = new AbortController();
		const iter = client.openSnapshotStream({ signal: controller.signal });
		try {
			const first = await iter.next();
			if (first.done) throw new Error("expected snapshot frame");
			expect(first.value.kind).toBe("snapshot");
			if (first.value.kind === "snapshot") {
				expect(first.value.credentials).toHaveLength(1);
				expect(first.value.credentials[0].provider).toBe("anthropic");
			}

			storage!.upsertCredential("anthropic", mintOAuthCredential("b", Date.now() + 120_000));

			const next = await nextMatching(iter, event => event.kind === "entry");
			if (next.kind !== "entry") throw new Error("expected entry frame");
			expect(next.entry.provider).toBe("anthropic");
			expect(next.entry.credential.type).toBe("oauth");
			if (next.entry.credential.type === "oauth") {
				expect(next.entry.credential.access).toBe("access-b");
				expect(next.entry.credential.refresh).toBe(REMOTE_REFRESH_SENTINEL);
			}
		} finally {
			controller.abort();
			await iter.return(undefined).catch(() => {});
		}
	});

	test("SSE stream pushes entry frame on refresh", async () => {
		const refreshed = {
			access: "access-rotated",
			refresh: "refresh-rotated",
			expires: Date.now() + 120_000,
			accountId: "account-a",
			email: "a@example.com",
		};
		vi.spyOn(oauthUtils, "refreshOAuthToken").mockResolvedValue(refreshed);

		const initialSnapshot = await new AuthBrokerClient({ url: handle!.url, token }).fetchSnapshot();
		if (initialSnapshot.status !== 200) throw new Error("expected snapshot");
		const id = initialSnapshot.snapshot.credentials[0].id;

		const client = new AuthBrokerClient({ url: handle!.url, token });
		const controller = new AbortController();
		const iter = client.openSnapshotStream({ signal: controller.signal });
		try {
			const first = await iter.next();
			if (first.done) throw new Error("expected snapshot frame");

			await storage!.refreshCredentialById(id);

			const next = await nextMatching(
				iter,
				event => event.kind === "entry" && event.entry.credential.type === "oauth" && event.entry.id === id,
			);
			if (next.kind !== "entry") throw new Error("expected entry frame");
			if (next.entry.credential.type !== "oauth") throw new Error("expected oauth credential");
			expect(next.entry.credential.access).toBe("access-rotated");
			expect(next.entry.credential.refresh).toBe(REMOTE_REFRESH_SENTINEL);
		} finally {
			controller.abort();
			await iter.return(undefined).catch(() => {});
		}
	});

	test("SSE stream pushes removed frame on disable", async () => {
		const initialSnapshot = await new AuthBrokerClient({ url: handle!.url, token }).fetchSnapshot();
		if (initialSnapshot.status !== 200) throw new Error("expected snapshot");
		const id = initialSnapshot.snapshot.credentials[0].id;

		const client = new AuthBrokerClient({ url: handle!.url, token });
		const controller = new AbortController();
		const iter = client.openSnapshotStream({ signal: controller.signal });
		try {
			const first = await iter.next();
			if (first.done) throw new Error("expected snapshot frame");

			const disabled = storage!.disableCredentialById(id, "revoked by test");
			expect(disabled).toBe(true);

			const next = await nextMatching(iter, event => event.kind === "removed");
			if (next.kind !== "removed") throw new Error("expected removed frame");
			expect(next.id).toBe(id);
		} finally {
			controller.abort();
			await iter.return(undefined).catch(() => {});
		}
	});

	test("SSE stream keepalive comment arrives on cadence", async () => {
		const localStore = await SqliteAuthCredentialStore.open(path.join(tempDir, "keepalive.db"));
		localStore.saveOAuth("anthropic", mintOAuthCredential("k", Date.now() + 60_000));
		const localStorage = new AuthStorage(localStore);
		await localStorage.reload();
		const localToken = "keepalive-bearer";
		const localHandle = startAuthBroker({
			storage: localStorage,
			bind: "127.0.0.1:0",
			bearerTokens: [localToken],
			disableRefresher: true,
			streamKeepaliveMs: 25,
		});
		const controller = new AbortController();
		try {
			const res = await fetch(`${localHandle.url}/v1/snapshot/stream`, {
				headers: { Authorization: `Bearer ${localToken}`, Accept: "text/event-stream" },
				signal: controller.signal,
			});
			expect(res.status).toBe(200);
			expect(res.headers.get("content-type") ?? "").toContain("text/event-stream");
			expect(res.body).not.toBeNull();
			const reader = (res.body as ReadableStream<Uint8Array>).getReader();
			const decoder = new TextDecoder();
			const deadline = Date.now() + 1_000;
			let seenKeepalive = false;
			let buffer = "";
			try {
				while (Date.now() < deadline) {
					const { value, done } = await reader.read();
					if (done) break;
					buffer += decoder.decode(value, { stream: true });
					if (buffer.includes(": keepalive\n\n")) {
						seenKeepalive = true;
						break;
					}
				}
			} finally {
				await reader.cancel().catch(() => {});
			}
			expect(seenKeepalive).toBe(true);
		} finally {
			controller.abort();
			await localHandle.close();
			localStorage.close();
			localStore.close();
		}
	});

	test("openSnapshotStream throws AuthBrokerStreamUnsupportedError on 404", async () => {
		const dummy = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => new Response("Not Found", { status: 404 }),
		});
		try {
			const client = new AuthBrokerClient({ url: `http://${dummy.hostname}:${dummy.port}`, token });
			const iter = client.openSnapshotStream();
			await expect(iter.next()).rejects.toBeInstanceOf(AuthBrokerStreamUnsupportedError);
		} finally {
			dummy.stop(true);
		}
	});

	test("openSnapshotStream rejects 200 responses that are not SSE", async () => {
		const dummy = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }),
		});
		try {
			const client = new AuthBrokerClient({ url: `http://${dummy.hostname}:${dummy.port}`, token });
			const iter = client.openSnapshotStream();
			await expect(iter.next()).rejects.toThrow(/non-SSE/);
		} finally {
			dummy.stop(true);
		}
	});

	test("openSnapshotStream rejects SSE responses without an initial snapshot", async () => {
		const dummy = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () =>
				new Response(": keepalive\n\n", { status: 200, headers: { "Content-Type": "text/event-stream" } }),
		});
		try {
			const client = new AuthBrokerClient({ url: `http://${dummy.hostname}:${dummy.port}`, token });
			const iter = client.openSnapshotStream();
			await expect(iter.next()).rejects.toThrow(/initial snapshot/);
		} finally {
			dummy.stop(true);
		}
	});
});

async function nextMatching(
	iter: AsyncGenerator<SnapshotStreamEvent>,
	predicate: (event: SnapshotStreamEvent) => boolean,
	timeoutMs = 2_000,
): Promise<SnapshotStreamEvent> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const remaining = deadline - Date.now();
		if (remaining <= 0) throw new Error("nextMatching timeout");
		const timer = Promise.withResolvers<never>();
		const handle = setTimeout(() => timer.reject(new Error("nextMatching timeout")), remaining);
		try {
			const res = await Promise.race([iter.next(), timer.promise]);
			if (res.done) throw new Error("stream ended before predicate satisfied");
			if (predicate(res.value)) return res.value;
		} finally {
			clearTimeout(handle);
		}
	}
}
