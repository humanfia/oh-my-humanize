import { afterEach, describe, expect, test } from "bun:test";
import { runAuthBrokerCommand } from "@oh-my-pi/pi-coding-agent/cli/auth-broker-cli";

const ORIGINAL_STDOUT_WRITE = process.stdout.write.bind(process.stdout);

function captureStdout(): () => string {
	let captured = "";
	process.stdout.write = ((chunk: string | Uint8Array): boolean => {
		captured += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
		return true;
	}) as typeof process.stdout.write;
	return () => captured;
}

describe("auth-broker Codex device login", () => {
	afterEach(() => {
		process.stdout.write = ORIGINAL_STDOUT_WRITE;
	});

	test("maps --device-auth to the Codex device-code provider for remote dry runs", async () => {
		const readStdout = captureStdout();

		await runAuthBrokerCommand({
			action: "login",
			flags: { deviceAuth: true, via: "user@broker", dryRun: true },
		});

		const output = readStdout();
		expect(output).toContain("ssh user@broker");
		expect(output).toContain("auth-broker login openai-codex-device");
		expect(output).not.toContain(" -L ");
	});

	test("accepts codex as the browser-login provider alias", async () => {
		const readStdout = captureStdout();

		await runAuthBrokerCommand({
			action: "login",
			flags: { provider: "codex", via: "user@broker", dryRun: true },
		});

		const output = readStdout();
		expect(output).toContain("1455:127.0.0.1:1455");
		expect(output).toContain("auth-broker login openai-codex");
	});
});
