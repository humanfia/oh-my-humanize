import { afterEach, describe, expect, it } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../../config/settings";
import type { ToolSession } from "../../tools";
import { createShellScriptRunner } from "../shell-script-runtime";

const zshPath = findZshPath();
let previousShell: string | undefined;

afterEach(() => {
	if (previousShell === undefined) {
		delete Bun.env.SHELL;
	} else {
		Bun.env.SHELL = previousShell;
	}
	previousShell = undefined;
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
