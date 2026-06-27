import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	WORKFLOW_SUBAGENT_RETRY_BASE_DELAY_MS_ENV,
	WORKFLOW_SUBAGENT_RETRY_MAX_DELAY_MS_ENV,
} from "../../workflow/model-env";
import { buildHeadlessAgentTaskEnv, runWorkflowCommand, type WorkflowStartSignalTarget } from "../workflow-cli";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("workflow CLI", () => {
	it("passes a conservative retry profile to headless workflow subagents", () => {
		const env = buildHeadlessAgentTaskEnv(
			{
				PATH: "/bin",
			},
			undefined,
			undefined,
		);

		expect(env[WORKFLOW_SUBAGENT_RETRY_BASE_DELAY_MS_ENV]).toBe("30000");
		expect(env[WORKFLOW_SUBAGENT_RETRY_MAX_DELAY_MS_ENV]).toBe("300000");
		expect(env.PATH).toBe("/bin");
	});

	it("prints ambiguous flow lookup errors without a source stack trace", async () => {
		using tempDir = TempDir.createSync("@omp-workflow-cli-ambiguous-flow-");
		const root = tempDir.path();
		const firstRoot = `${root}/first`;
		const secondRoot = `${root}/second`;
		await Bun.write(`${firstRoot}/humanize-rlcr/humanize-rlcr.omhflow`, workflowAmbiguousHumanizeRlcrFlow());
		await Bun.write(`${firstRoot}/humanize-rlcr/humanize-rlcr/scripts/noop.sh`, "#!/bin/sh\nprintf '{}\\n'\n");
		await Bun.write(`${secondRoot}/humanize-rlcr/humanize-rlcr.omhflow`, workflowAmbiguousHumanizeRlcrFlow());
		await Bun.write(`${secondRoot}/humanize-rlcr/humanize-rlcr/scripts/noop.sh`, "#!/bin/sh\nprintf '{}\\n'\n");
		const originalFlowDir = process.env.OMHFLOW_DIR;
		const originalExitCode = process.exitCode;
		const stdout: string[] = [];
		const stderr: string[] = [];
		vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
			stdout.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
			return true;
		});
		vi.spyOn(process.stderr, "write").mockImplementation(chunk => {
			stderr.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
			return true;
		});
		process.env.OMHFLOW_DIR = [firstRoot, secondRoot].join(path.delimiter);
		process.exitCode = undefined;
		try {
			await runWorkflowCommand({
				action: "freeze",
				args: ["humanize-rlcr"],
				flags: {},
			});
		} finally {
			if (originalFlowDir === undefined) delete process.env.OMHFLOW_DIR;
			else process.env.OMHFLOW_DIR = originalFlowDir;
			process.exitCode = originalExitCode ?? 0;
		}

		const errorOutput = stderr.join("");
		expect(stdout.join("")).toBe("");
		expect(errorOutput).toContain('workflow flow "humanize-rlcr" is ambiguous');
		expect(errorOutput).toContain("Use an explicit .omhflow path to select one artifact.");
		expect(errorOutput).not.toContain("artifact-registry.ts");
		expect(errorOutput).not.toContain("WorkflowArtifactRegistryError");
	});

	it("prints artifact package errors without a source stack trace", async () => {
		using tempDir = TempDir.createSync("@omp-workflow-cli-package-error-");
		const root = tempDir.path();
		await Bun.write(`${root}/not-a-flow/readme.txt`, "not an omhflow artifact");
		const originalExitCode = process.exitCode;
		const stderr: string[] = [];
		vi.spyOn(process.stderr, "write").mockImplementation(chunk => {
			stderr.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
			return true;
		});
		process.exitCode = undefined;
		try {
			await runWorkflowCommand({
				action: "freeze",
				args: ["not-a-flow"],
				flags: { cwd: root },
			});
		} finally {
			process.exitCode = originalExitCode ?? 0;
		}

		const errorOutput = stderr.join("");
		expect(errorOutput).toContain(".omhflow artifact path must be a file");
		expect(errorOutput).not.toContain("package-loader.ts");
		expect(errorOutput).not.toContain("WorkflowPackageError");
	});

	it("rejects headless starts from non-artifact workflow packages", async () => {
		using tempDir = TempDir.createSync("@omp-workflow-cli-start-artifact-");
		const root = tempDir.path();
		await Bun.write(
			`${root}/workflow.yml`,
			["name: raw-start", "version: 1", "nodes:", "  build:", "    type: script", "edges: []", ""].join("\n"),
		);
		const originalExitCode = process.exitCode;
		const stdout: string[] = [];
		const stderr: string[] = [];
		vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
			stdout.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
			return true;
		});
		vi.spyOn(process.stderr, "write").mockImplementation(chunk => {
			stderr.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
			return true;
		});
		process.exitCode = undefined;
		try {
			await runWorkflowCommand({
				action: "start",
				args: [root],
				flags: { cwd: root, runId: "raw-start" },
			});
		} finally {
			process.exitCode = originalExitCode ?? 0;
		}

		expect(stdout.join("")).toBe("");
		const errorOutput = stderr.join("");
		expect(errorOutput).toContain("Workflow start requires a frozen .omhflow artifact");
		expect(errorOutput).not.toContain("workflow-cli.ts");
		expect(errorOutput).not.toContain("WorkflowPackageError");
	});

	it("passes frozen data resources to headless shell script nodes", async () => {
		using tempDir = TempDir.createSync("@omp-workflow-cli-resources-");
		const root = tempDir.path();
		await Bun.write(`${root}/resource-smoke.omhflow`, workflowResourceSmokeFlow());
		await Bun.write(`${root}/resource-smoke/scripts/read-resource.sh`, workflowResourceSmokeScript());
		await Bun.write(`${root}/resource-smoke/data/message.txt`, "resource-ok");
		const output: string[] = [];
		vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
			output.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
			return true;
		});

		await runWorkflowCommand({
			action: "start",
			args: [`${root}/resource-smoke.omhflow`],
			flags: {
				cwd: root,
				json: true,
				runId: "resource-smoke-run",
			},
		});

		const result = JSON.parse(output.join("").trim()) as {
			run: { status: string; completed: number; failed: number };
			runs: { stateKeys: string[] }[];
		};
		expect(result.run).toMatchObject({ status: "completed", completed: 1, failed: 0 });
		expect(result.runs[0]?.stateKeys).toEqual(["message"]);
	});

	it("disables Python user-site pollution for headless shell script nodes", async () => {
		using tempDir = TempDir.createSync("@omp-workflow-cli-python-env-");
		const root = tempDir.path();
		await Bun.write(`${root}/python-env-smoke.omhflow`, workflowPythonEnvSmokeFlow());
		await Bun.write(`${root}/python-env-smoke/scripts/check-python-env.sh`, workflowPythonEnvSmokeScript());
		const output: string[] = [];
		vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
			output.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
			return true;
		});

		await runWorkflowCommand({
			action: "start",
			args: [`${root}/python-env-smoke.omhflow`],
			flags: {
				cwd: root,
				json: true,
				runId: "python-env-smoke-run",
			},
		});

		const result = JSON.parse(output.join("").trim()) as {
			run: { status: string; completed: number; failed: number };
			runs: { stateKeys: string[] }[];
		};
		expect(result.run).toMatchObject({ status: "completed", completed: 1, failed: 0 });
		expect(result.runs[0]?.stateKeys).toEqual(["pythonEnv"]);
	});

	it("runs headless js workflow scripts from the requested cwd", async () => {
		using tempDir = TempDir.createSync("@omp-workflow-cli-js-cwd-");
		const root = tempDir.path();
		const runCwd = `${root}/workspace`;
		await Bun.write(`${root}/cwd-smoke.omhflow`, workflowJsCwdSmokeFlow());
		await Bun.write(`${root}/cwd-smoke/scripts/read-cwd.js`, workflowJsCwdSmokeScript());
		await Bun.write(`${runCwd}/marker.txt`, "cwd-ok");
		const output: string[] = [];
		vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
			output.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
			return true;
		});

		await runWorkflowCommand({
			action: "start",
			args: [`${root}/cwd-smoke.omhflow`],
			flags: {
				cwd: runCwd,
				json: true,
				runId: "js-cwd-smoke-run",
			},
		});

		const result = JSON.parse(output.join("").trim()) as {
			run: { status: string; completed: number; failed: number };
			runs: { stateKeys: string[] }[];
		};
		expect(result.run).toMatchObject({ status: "completed", completed: 1, failed: 0 });
		expect(result.runs[0]?.stateKeys).toEqual(["marker"]);
	});

	it("checkpoints headless workflow starts on SIGINT instead of leaving a run alive", async () => {
		using tempDir = TempDir.createSync("@omp-workflow-cli-sigint-");
		const root = tempDir.path();
		await Bun.write(`${root}/sigint-stop.omhflow`, workflowSigintStopFlow());
		await Bun.write(`${root}/sigint-stop/scripts/hold.sh`, workflowSigintHoldScript());
		const output: string[] = [];
		const signalTarget = new FakeWorkflowStartSignalTarget();
		vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
			output.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
			return true;
		});

		const timer = setTimeout(() => {
			signalTarget.emit("SIGINT");
		}, 30);
		timer.unref?.();
		try {
			await runWorkflowCommand(
				{
					action: "start",
					args: [`${root}/sigint-stop.omhflow`],
					flags: {
						cwd: root,
						json: true,
						runId: "sigint-stop-run",
						familyId: "sigint-stop-family",
					},
				},
				{ signalTarget },
			);
		} finally {
			clearTimeout(timer);
		}

		const result = JSON.parse(output.join("").trim()) as {
			run: { status: string; frontier: string[] };
			families: { attempts: { status: string }[]; checkpoints: { frontier: string[] }[] }[];
		};
		expect(result.run.status).toBe("stopped");
		expect(result.run.frontier).toEqual(["hold"]);
		expect(result.families[0]?.attempts[0]?.status).toBe("stopped");
		expect(result.families[0]?.checkpoints[0]?.frontier).toEqual(["hold"]);
		expect(signalTarget.listenerCount("SIGINT")).toBe(0);
		expect(signalTarget.listenerCount("SIGTERM")).toBe(0);
	});
});

class FakeWorkflowStartSignalTarget implements WorkflowStartSignalTarget {
	#listeners = new Map<"SIGINT" | "SIGTERM", Set<() => void>>();

	once(event: "SIGINT" | "SIGTERM", listener: () => void): void {
		this.#listenersFor(event).add(listener);
	}

	off(event: "SIGINT" | "SIGTERM", listener: () => void): void {
		this.#listenersFor(event).delete(listener);
	}

	emit(event: "SIGINT" | "SIGTERM"): void {
		for (const listener of [...this.#listenersFor(event)]) {
			this.off(event, listener);
			listener();
		}
	}

	listenerCount(event: "SIGINT" | "SIGTERM"): number {
		return this.#listenersFor(event).size;
	}

	#listenersFor(event: "SIGINT" | "SIGTERM"): Set<() => void> {
		let listeners = this.#listeners.get(event);
		if (listeners === undefined) {
			listeners = new Set();
			this.#listeners.set(event, listeners);
		}
		return listeners;
	}
}

function workflowAmbiguousHumanizeRlcrFlow(): string {
	return [
		"---",
		"name: humanize-rlcr",
		"version: 1",
		"schema: omhflow/v1",
		"resourceDir: humanize-rlcr",
		"models:",
		"  roles: {}",
		"  defaults: {}",
		"checkpoint:",
		"  stopDeadlineMs: 30000",
		"changePolicy:",
		"  agentsCanPropose: true",
		"  humansCanApprove: true",
		"---",
		"# Ambiguous humanize-rlcr fixture",
		"",
		"```yaml workflow",
		"resources:",
		"  - path: scripts/noop.sh",
		"    kind: script",
		"sequence:",
		"  - node:",
		"      id: noop",
		"      type: script",
		"      script:",
		"        language: sh",
		"        file: scripts/noop.sh",
		"```",
	].join("\n");
}

function workflowResourceSmokeFlow(): string {
	return [
		"---",
		"name: resource-smoke",
		"version: 1",
		"schema: omhflow/v1",
		"resourceDir: resource-smoke",
		"models:",
		"  roles: {}",
		"  defaults: {}",
		"checkpoint:",
		"  stopDeadlineMs: 30000",
		"changePolicy:",
		"  agentsCanPropose: true",
		"  humansCanApprove: true",
		"---",
		"# Resource smoke",
		"",
		"```yaml workflow",
		"stateSchema:",
		"  version: 1",
		"  shape:",
		"    message: string",
		"resources:",
		"  - path: scripts/read-resource.sh",
		"    kind: script",
		"  - path: data/message.txt",
		"    kind: data",
		"sequence:",
		"  - node:",
		"      id: readResource",
		"      type: script",
		"      script:",
		"        language: sh",
		"        file: scripts/read-resource.sh",
		"      writes:",
		"        - /message",
		"```",
	].join("\n");
}

function workflowResourceSmokeScript(): string {
	return [
		"#!/bin/sh",
		"set -eu",
		'message=$(cat "$OMP_WORKFLOW_RESOURCE_DIR/data/message.txt")',
		'printf \'{"summary":"resource observed","statePatch":[{"op":"set","path":"/message","value":"%s"}]}\\n\' "$message"',
	].join("\n");
}

function workflowPythonEnvSmokeFlow(): string {
	return [
		"---",
		"name: python-env-smoke",
		"version: 1",
		"schema: omhflow/v1",
		"resourceDir: python-env-smoke",
		"models:",
		"  roles: {}",
		"  defaults: {}",
		"checkpoint:",
		"  stopDeadlineMs: 30000",
		"changePolicy:",
		"  agentsCanPropose: true",
		"  humansCanApprove: true",
		"---",
		"# Python env smoke",
		"",
		"```yaml workflow",
		"stateSchema:",
		"  version: 1",
		"  shape:",
		"    pythonEnv: object",
		"resources:",
		"  - path: scripts/check-python-env.sh",
		"    kind: script",
		"sequence:",
		"  - node:",
		"      id: checkPythonEnv",
		"      type: script",
		"      script:",
		"        language: sh",
		"        file: scripts/check-python-env.sh",
		"      writes:",
		"        - /pythonEnv",
		"```",
	].join("\n");
}

function workflowPythonEnvSmokeScript(): string {
	const pythonNoUserSiteExpansion = "$" + "{PYTHONNOUSERSITE:-}";
	const pythonPathSetExpansion = "$" + "{PYTHONPATH+x}";
	const pythonPathExpansion = "$" + "{PYTHONPATH-unset}";
	return [
		"#!/bin/sh",
		"set -eu",
		`test "${pythonNoUserSiteExpansion}" = "1"`,
		`test "${pythonPathSetExpansion}" != "x"`,
		`printf '{"summary":"python env isolated","statePatch":[{"op":"set","path":"/pythonEnv","value":{"noUserSite":"%s","pythonPath":"%s"}}]}\\n' "$PYTHONNOUSERSITE" "${pythonPathExpansion}"`,
	].join("\n");
}

function workflowJsCwdSmokeFlow(): string {
	return [
		"---",
		"name: cwd-smoke",
		"version: 1",
		"schema: omhflow/v1",
		"resourceDir: cwd-smoke",
		"models:",
		"  roles: {}",
		"  defaults: {}",
		"checkpoint:",
		"  stopDeadlineMs: 30000",
		"changePolicy:",
		"  agentsCanPropose: true",
		"  humansCanApprove: true",
		"---",
		"# JS cwd smoke",
		"",
		"```yaml workflow",
		"stateSchema:",
		"  version: 1",
		"  shape:",
		"    marker: string",
		"resources:",
		"  - path: scripts/read-cwd.js",
		"    kind: script",
		"sequence:",
		"  - node:",
		"      id: readCwd",
		"      type: script",
		"      script:",
		"        language: js",
		"        file: scripts/read-cwd.js",
		"      writes:",
		"        - /marker",
		"```",
	].join("\n");
}

function workflowJsCwdSmokeScript(): string {
	return [
		'const marker = (await Bun.file("marker.txt").text()).trim();',
		"return {",
		'  summary: "cwd marker observed",',
		'  statePatch: [{ op: "set", path: "/marker", value: marker }],',
		"};",
	].join("\n");
}

function workflowSigintStopFlow(): string {
	return [
		"---",
		"name: sigint-stop",
		"version: 1",
		"schema: omhflow/v1",
		"resourceDir: sigint-stop",
		"models:",
		"  roles: {}",
		"  defaults: {}",
		"checkpoint:",
		"  stopDeadlineMs: 30000",
		"changePolicy:",
		"  agentsCanPropose: true",
		"  humansCanApprove: true",
		"---",
		"# SIGINT stop",
		"",
		"```yaml workflow",
		"resources:",
		"  - path: scripts/hold.sh",
		"    kind: script",
		"sequence:",
		"  - node:",
		"      id: hold",
		"      type: script",
		"      script:",
		"        language: sh",
		"        file: scripts/hold.sh",
		"```",
	].join("\n");
}

function workflowSigintHoldScript(): string {
	return ["#!/bin/sh", "set -eu", "sleep 2", 'printf \'{"summary":"unexpected completion"}\\n\''].join("\n");
}
