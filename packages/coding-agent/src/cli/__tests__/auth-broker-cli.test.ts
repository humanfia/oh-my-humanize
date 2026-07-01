import { afterEach, describe, expect, it, vi } from "bun:test";
import { SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { __resetDirsFromEnvForTests, getAgentDbPath, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { z } from "zod/v4";
import { runAuthBrokerCommand } from "../auth-broker-cli";

afterEach(() => {
	vi.restoreAllMocks();
});

const AuthBrokerJsonOutputSchema = z.object({
	dryRun: z.boolean().optional(),
	imported: z.array(z.object({ provider: z.string(), email: z.string().nullable().optional(), file: z.string() })),
	plan: z.array(
		z.object({
			provider: z.string(),
			email: z.string().nullable(),
			accountId: z.string().nullable(),
			expiresAt: z.number(),
			disabled: z.boolean(),
			file: z.string(),
		}),
	),
	skipped: z.array(z.object({ file: z.string(), reason: z.string() })),
});

describe("auth-broker import", () => {
	it("imports Claude Code credentials JSON as an Anthropic OAuth credential", async () => {
		using tempDir = TempDir.createSync("@omp-auth-broker-import-claude-");
		const root = tempDir.path();
		const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
		const originalBrokerUrl = process.env.OMP_AUTH_BROKER_URL;
		const originalBrokerToken = process.env.OMP_AUTH_BROKER_TOKEN;
		const stdout: string[] = [];
		const expiresAt = Date.now() + 60 * 60 * 1000;
		const source = `${root}/.claude/.credentials.json`;

		vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
			stdout.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
			return true;
		});

		setAgentDir(`${root}/agent`);
		delete process.env.OMP_AUTH_BROKER_URL;
		delete process.env.OMP_AUTH_BROKER_TOKEN;

		try {
			await Bun.write(
				source,
				JSON.stringify({
					claudeAiOauth: {
						accessToken: "claude-access-secret",
						refreshToken: "claude-refresh-secret",
						expiresAt,
						scopes: ["org:create_api_key", "user:profile", "user:inference"],
						account: {
							uuid: "account-123",
							email_address: "user@example.com",
						},
					},
				}),
			);

			await runAuthBrokerCommand({
				action: "import",
				flags: { source, json: true },
			});

			const output = stdout.join("");
			expect(output).not.toContain("claude-access-secret");
			expect(output).not.toContain("claude-refresh-secret");
			const result = AuthBrokerJsonOutputSchema.parse(JSON.parse(output));
			expect(result.skipped).toEqual([]);
			expect(result.imported).toEqual([{ provider: "anthropic", email: "user@example.com", file: source }]);
			expect(result.plan).toEqual([
				{
					provider: "anthropic",
					email: "user@example.com",
					accountId: "account-123",
					expiresAt,
					disabled: false,
					file: source,
				},
			]);

			const store = await SqliteAuthCredentialStore.open(getAgentDbPath());
			try {
				const rows = store.listAuthCredentials("anthropic");
				expect(rows).toHaveLength(1);
				expect(rows[0]?.credential).toEqual({
					type: "oauth",
					access: "claude-access-secret",
					refresh: "claude-refresh-secret",
					expires: expiresAt,
					email: "user@example.com",
					accountId: "account-123",
				});
			} finally {
				store.close();
			}
		} finally {
			if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
			if (originalBrokerUrl === undefined) delete process.env.OMP_AUTH_BROKER_URL;
			else process.env.OMP_AUTH_BROKER_URL = originalBrokerUrl;
			if (originalBrokerToken === undefined) delete process.env.OMP_AUTH_BROKER_TOKEN;
			else process.env.OMP_AUTH_BROKER_TOKEN = originalBrokerToken;
			__resetDirsFromEnvForTests();
		}
	});

	it("dry-runs Claude Code credentials without identity metadata", async () => {
		using tempDir = TempDir.createSync("@omp-auth-broker-import-claude-dry-run-");
		const source = `${tempDir.path()}/.credentials.json`;
		const stdout: string[] = [];
		const expiresAt = Date.now() + 2 * 60 * 60 * 1000;

		vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
			stdout.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
			return true;
		});

		await Bun.write(
			source,
			JSON.stringify({
				claudeAiOauth: {
					accessToken: "opaque-access-token",
					refreshToken: "opaque-refresh-token",
					expiresAt,
					scopes: ["user:inference"],
				},
			}),
		);

		await runAuthBrokerCommand({
			action: "import",
			flags: { source, json: true, dryRun: true },
		});

		const output = stdout.join("");
		expect(output).not.toContain("opaque-access-token");
		expect(output).not.toContain("opaque-refresh-token");
		const result = AuthBrokerJsonOutputSchema.parse(JSON.parse(output));
		expect(result.dryRun).toBe(true);
		expect(result.imported).toEqual([]);
		expect(result.skipped).toEqual([]);
		expect(result.plan).toEqual([
			{
				provider: "anthropic",
				email: null,
				accountId: null,
				expiresAt,
				disabled: false,
				file: source,
			},
		]);
	});
});

describe("auth-broker login", () => {
	it("dry-runs Anthropic Console remote login without a localhost tunnel", async () => {
		const stdout: string[] = [];

		vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
			stdout.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
			return true;
		});

		await runAuthBrokerCommand({
			action: "login",
			flags: { provider: "anthropic", via: "user@broker", console: true, dryRun: true },
		});

		expect(stdout.join("").trim()).toBe("ssh user@broker 'omh auth-broker login anthropic-console'");
	});

	it("dry-runs Claude headless remote login without a localhost tunnel", async () => {
		const stdout: string[] = [];

		vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
			stdout.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
			return true;
		});

		await runAuthBrokerCommand({
			action: "login",
			flags: { provider: "anthropic", via: "user@broker", headless: true, dryRun: true },
		});

		expect(stdout.join("").trim()).toBe("ssh user@broker 'omh auth-broker login anthropic-code'");
	});
});
