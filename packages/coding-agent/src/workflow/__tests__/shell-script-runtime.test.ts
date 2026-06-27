import { afterEach, describe, expect, it } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../../config/settings";
import type { ToolSession } from "../../tools";
import { createShellScriptRunner } from "../shell-script-runtime";

const zshPath = findZshPath();
let previousShell: string | undefined;
let previousHome: string | undefined;
let previousPythonPath: string | undefined;
let previousPythonNoUserSite: string | undefined;

afterEach(() => {
	if (previousShell === undefined) {
		delete Bun.env.SHELL;
	} else {
		Bun.env.SHELL = previousShell;
	}
	previousShell = undefined;
	if (previousHome === undefined) {
		delete Bun.env.HOME;
	} else {
		Bun.env.HOME = previousHome;
	}
	previousHome = undefined;
	if (previousPythonPath === undefined) {
		delete Bun.env.PYTHONPATH;
	} else {
		Bun.env.PYTHONPATH = previousPythonPath;
	}
	previousPythonPath = undefined;
	if (previousPythonNoUserSite === undefined) {
		delete Bun.env.PYTHONNOUSERSITE;
	} else {
		Bun.env.PYTHONNOUSERSITE = previousPythonNoUserSite;
	}
	previousPythonNoUserSite = undefined;
});

describe.skipIf(!zshPath)("createShellScriptRunner", () => {
	it("runs sh workflow scripts with sh semantics under a zsh user shell", async () => {
		using tempDir = TempDir.createSync("@omp-workflow-sh-runtime-");
		previousShell = Bun.env.SHELL;
		Bun.env.SHELL = zshPath ?? "";

		const settings = await Settings.init();
		const session: ToolSession = {
			cwd: tempDir.path(),
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => null,
			settings,
		};
		const runner = createShellScriptRunner(session);

		const result = await runner({
			activationId: "activation-1",
			nodeId: "statusNode",
			code: ["status=0", 'printf \'{"summary":"ok","data":{"status":"%s"}}\\n\' "$status"'].join("\n"),
			language: "sh",
			title: "status-node.sh",
		});

		expect(result.exitCode).toBe(0);
		expect(result.error).toBeUndefined();
		expect(result.output).toContain('"status":"0"');
	});

	it("exposes workflow context to sh scripts through OMP_WORKFLOW_CONTEXT", async () => {
		using tempDir = TempDir.createSync("@omp-workflow-sh-context-");
		previousShell = Bun.env.SHELL;
		Bun.env.SHELL = zshPath ?? "";

		const settings = await Settings.init();
		const session: ToolSession = {
			cwd: tempDir.path(),
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => null,
			settings,
		};
		const runner = createShellScriptRunner(session);

		const result = await runner({
			activationId: "activation-2",
			nodeId: "recordLedger",
			code: "printf '%s\\n' \"$OMP_WORKFLOW_CONTEXT\"",
			language: "sh",
			title: "record-ledger.sh",
			context: {
				activation: {
					id: "activation-2",
					nodeId: "recordLedger",
					graphRevisionId: "graph-1",
					parentActivationIds: ["activation-1"],
				},
				node: {
					id: "recordLedger",
					type: "script",
				},
				state: {
					ledger: {
						round: 2,
					},
				},
				completedActivations: [],
			},
		});

		expect(result.exitCode).toBe(0);
		expect(result.error).toBeUndefined();
		expect(JSON.parse(result.output)).toEqual({
			activation: {
				id: "activation-2",
				nodeId: "recordLedger",
				graphRevisionId: "graph-1",
				parentActivationIds: ["activation-1"],
			},
			node: {
				id: "recordLedger",
				type: "script",
			},
			state: {
				ledger: {
					round: 2,
				},
			},
			completedActivations: [],
		});
	});

	it("exposes the materialized resource directory through OMP_WORKFLOW_RESOURCE_DIR", async () => {
		using tempDir = TempDir.createSync("@omp-workflow-sh-resources-");
		previousShell = Bun.env.SHELL;
		Bun.env.SHELL = zshPath ?? "";

		const resourceDir = `${tempDir.path()}/resources`;
		await Bun.write(`${resourceDir}/fixtures/message.txt`, "resource-ok\n");
		const settings = await Settings.init();
		const session: ToolSession = {
			cwd: tempDir.path(),
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => null,
			settings,
		};
		const runner = createShellScriptRunner(session);

		const result = await runner({
			activationId: "activation-3",
			nodeId: "readResource",
			code: 'cat "$OMP_WORKFLOW_RESOURCE_DIR/fixtures/message.txt"',
			language: "sh",
			title: "read-resource.sh",
			resourceDir,
		});

		expect(result.exitCode).toBe(0);
		expect(result.error).toBeUndefined();
		expect(result.output).toBe("resource-ok");
	});

	it("disables inherited Python user-site pollution in workflow shell scripts", async () => {
		using tempDir = TempDir.createSync("@omp-workflow-sh-python-env-");
		previousShell = Bun.env.SHELL;
		previousHome = Bun.env.HOME;
		previousPythonPath = Bun.env.PYTHONPATH;
		previousPythonNoUserSite = Bun.env.PYTHONNOUSERSITE;
		Bun.env.SHELL = zshPath ?? "";
		Bun.env.HOME = tempDir.path();
		Bun.env.PYTHONPATH = "/stale/editable/site";
		Bun.env.PYTHONNOUSERSITE = "1";

		const settings = await Settings.init();
		const session: ToolSession = {
			cwd: tempDir.path(),
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => null,
			settings,
		};
		const runner = createShellScriptRunner(session);
		const homeExpansion = "$" + "{HOME-unset}";
		const pythonPathExpansion = "$" + "{PYTHONPATH-unset}";
		const pythonNoUserSiteExpansion = "$" + "{PYTHONNOUSERSITE-unset}";

		const result = await runner({
			activationId: "activation-python-env",
			nodeId: "pythonEnv",
			code: [
				`home="${homeExpansion}"`,
				`python_path="${pythonPathExpansion}"`,
				`python_no_user_site="${pythonNoUserSiteExpansion}"`,
				'printf "HOME=%s\\nPYTHONPATH=%s\\nPYTHONNOUSERSITE=%s\\n" "$home" "$python_path" "$python_no_user_site"',
			].join("\n"),
			language: "sh",
			title: "python-env.sh",
		});

		expect(result.exitCode).toBe(0);
		expect(result.error).toBeUndefined();
		expect(result.output).toContain(`HOME=${tempDir.path()}`);
		expect(result.output).toContain("PYTHONPATH=unset");
		expect(result.output).toContain("PYTHONNOUSERSITE=1");
	});

	it("cancels a running sh workflow script through the abort signal", async () => {
		using tempDir = TempDir.createSync("@omp-workflow-sh-cancel-");
		previousShell = Bun.env.SHELL;
		Bun.env.SHELL = zshPath ?? "";

		const settings = await Settings.init();
		const session: ToolSession = {
			cwd: tempDir.path(),
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => null,
			settings,
		};
		const runner = createShellScriptRunner(session);
		const controller = new AbortController();
		const startedAt = performance.now();
		const abortSoon = Bun.sleep(50).then(() => controller.abort("stop workflow"));

		const result = await runner({
			activationId: "activation-cancel",
			nodeId: "longHold",
			code: ["sleep 10", "printf 'should-not-finish\\n'"].join("\n"),
			language: "sh",
			title: "long-hold.sh",
			signal: controller.signal,
		});
		await abortSoon;

		expect(performance.now() - startedAt).toBeLessThan(2_000);
		expect(result.exitCode).toBe(1);
		expect(result.error).toContain("Command cancelled");
		expect(result.output).toContain("Command cancelled");
		expect(result.output).not.toContain("should-not-finish");
	});
});

function findZshPath(): string | undefined {
	const result = Bun.spawnSync({
		cmd: ["sh", "-lc", "command -v zsh"],
		stdout: "pipe",
		stderr: "ignore",
	});
	if (result.exitCode !== 0) return undefined;
	const output = new TextDecoder().decode(result.stdout).trim();
	return output || undefined;
}
