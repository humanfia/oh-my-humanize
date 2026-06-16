import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "../../src/config/settings";
import * as bashExecutor from "../../src/exec/bash-executor";
import type { ToolSession } from "../../src/tools";
import { createShellScriptRunner } from "../../src/workflow/shell-script-runtime";

const tempRoot = path.resolve(process.cwd(), "../../temp/test-workflow-shell-runtime");
const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
	await fs.mkdir(tempRoot, { recursive: true });
	const dir = await fs.mkdtemp(path.join(tempRoot, "case-"));
	tempDirs.push(dir);
	return dir;
}

async function waitForFileText(filePath: string, needle: string): Promise<string> {
	for (let attempt = 0; attempt < 300; attempt++) {
		try {
			const text = await Bun.file(filePath).text();
			if (text.includes(needle)) return text;
		} catch {
			// The producer may not have created the file yet.
		}
		await Bun.sleep(10);
	}
	throw new Error(`Timed out waiting for ${filePath} to contain ${needle}`);
}

function createToolSession(cwd: string): ToolSession {
	const settings = Settings.isolated({});
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getSessionId: () => "workflow-shell-test",
		settings,
	} as unknown as ToolSession;
}

afterEach(async () => {
	resetSettingsForTest();
	vi.restoreAllMocks();
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("workflow shell script runtime adapter", () => {
	it("runs shell scripts in the workflow cwd and preserves stdout for structured output parsing", async () => {
		const cwd = await createTempDir();
		await Bun.write(path.join(cwd, "input.txt"), "workflow input\n");
		const runner = createShellScriptRunner(createToolSession(cwd));

		const result = await runner({
			activationId: "activation-build",
			nodeId: "build",
			code: [
				"cat input.txt",
				'printf \'%s\\n\' \'{"summary":"shell build ok","data":{"source":"input.txt"}}\'',
			].join("\n"),
			language: "sh",
			title: "build",
		});

		expect(result).toEqual({
			exitCode: 0,
			output: 'workflow input\n{"summary":"shell build ok","data":{"source":"input.txt"}}',
			language: "sh",
		});
	});

	it("preserves long structured JSON output lines for workflow state parsing", async () => {
		resetSettingsForTest();
		await Settings.init({
			inMemory: true,
			overrides: { "tools.outputMaxColumns": 96 },
		});
		const cwd = await createTempDir();
		const runner = createShellScriptRunner(createToolSession(cwd));
		const longCommand = `mkdir -p workflow-output && GOCACHE="$(pwd)/workflow-output/go-build" GOMODCACHE="$(pwd)/workflow-output/go-mod" go test ./... ${"x".repeat(520)}`;

		const result = await runner({
			activationId: "activation-long-json",
			nodeId: "load-contract",
			code: [
				`LONG_COMMAND='${longCommand}'`,
				'jq -cn --arg command "$LONG_COMMAND" \'{summary:"loaded baseline contract",statePatch:[{op:"set",path:"/baseline/command",value:$command}]}\'',
			].join("\n"),
			language: "sh",
			title: "load-contract",
		});

		const parsed = JSON.parse(result.output) as {
			summary: string;
			statePatch: [{ value: string }];
		};
		expect(parsed.summary).toBe("loaded baseline contract");
		expect(parsed.statePatch[0].value).toBe(longCommand);
		expect(result.output).not.toContain("…");
	});

	it("returns non-zero shell exits as workflow script failures", async () => {
		const cwd = await createTempDir();
		const runner = createShellScriptRunner(createToolSession(cwd));

		const result = await runner({
			activationId: "activation-fail",
			nodeId: "fail",
			code: "echo before failure\nexit 7",
			language: "sh",
			title: "fail",
		});

		expect(result.exitCode).toBe(7);
		expect(result.output).toContain("before failure");
		expect(result.error).toBe("exit code 7");
		expect(result.language).toBe("sh");
	});

	it("runs each activation through a one-shot shell so long workflow loops do not accumulate shell sessions", async () => {
		const cwd = await createTempDir();
		const executeSpy = vi.spyOn(bashExecutor, "executeBash").mockResolvedValue({
			exitCode: 0,
			output: '{"summary":"ok"}',
			cancelled: false,
			truncated: false,
			totalLines: 1,
			totalBytes: 16,
			outputLines: 1,
			outputBytes: 16,
		});
		const runner = createShellScriptRunner(createToolSession(cwd));

		await runner({
			activationId: "activation-hold-180",
			nodeId: "longRunningHold",
			code: 'printf \'{"summary":"ok"}\\n\'',
			language: "sh",
			title: "hold",
		});

		expect(executeSpy).toHaveBeenCalledTimes(1);
		expect(executeSpy.mock.calls[0]?.[1]).toMatchObject({
			sessionKey: "workflow-shell-test:workflow:activation-hold-180",
			reuseShellSession: false,
		});
	});

	it("returns cancellation promptly when shell workflow scripts are aborted", async () => {
		const cwd = await createTempDir();
		await Settings.init({ inMemory: true, overrides: { shellPath: "/bin/sh" } });
		const runner = createShellScriptRunner(createToolSession(cwd));
		const controller = new AbortController();

		const run = runner({
			activationId: "activation-abort",
			nodeId: "hold",
			code: [
				"printf 'started\\n' >> hold.log",
				"sleep 2",
				"printf '%s\\n' '{\"summary\":\"should not finish\"}'",
			].join("\n"),
			language: "sh",
			title: "hold",
			signal: controller.signal,
		});
		await waitForFileText(path.join(cwd, "hold.log"), "started");

		const abortStartedAt = Date.now();
		controller.abort("test stop deadline elapsed");
		const result = await run;

		expect(Date.now() - abortStartedAt).toBeLessThan(1_000);
		expect(result.exitCode).toBe(1);
		expect(result.error).toContain("Command cancelled");
		expect(result.language).toBe("sh");
	}, 5_000);
});
