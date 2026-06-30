import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { $ } from "bun";
import {
	WORKFLOW_SUBAGENT_REQUIRE_YIELD_TOOL_ENV,
	WORKFLOW_SUBAGENT_RETRY_BASE_DELAY_MS_ENV,
	WORKFLOW_SUBAGENT_RETRY_MAX_DELAY_MS_ENV,
	WORKFLOW_SUBAGENT_SHELL_ENVIRONMENT_POLICY_ENV,
} from "../../workflow/model-env";
import {
	buildHeadlessAgentTaskEnv,
	runHeadlessAgentTask,
	runWorkflowCommand,
	type WorkflowStartSignalTarget,
} from "../workflow-cli";

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
		expect(env[WORKFLOW_SUBAGENT_SHELL_ENVIRONMENT_POLICY_ENV]).toBe("workflow");
		expect(env[WORKFLOW_SUBAGENT_REQUIRE_YIELD_TOOL_ENV]).toBe("true");
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

	it("rejects module-style js workflow scripts before production freeze", async () => {
		using tempDir = TempDir.createSync("@omp-workflow-cli-js-module-script-");
		const root = tempDir.path();
		await Bun.write(`${root}/js-module-script.omhflow`, workflowJsModuleScriptFlow());
		await Bun.write(
			`${root}/js-module-script/scripts/module-style.js`,
			['import * as path from "node:path";', 'return { summary: path.basename("artifact.txt") };'].join("\n"),
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
				action: "freeze",
				args: [`${root}/js-module-script.omhflow`],
				flags: { cwd: root },
			});
		} finally {
			process.exitCode = originalExitCode ?? 0;
		}

		expect(stdout.join("")).toBe("");
		const errorOutput = stderr.join("");
		expect(errorOutput).toContain('workflow js script node "moduleStyle"');
		expect(errorOutput).toContain("async function body");
		expect(errorOutput).toContain("static import/export declarations");
		expect(errorOutput).not.toContain("freeze.ts");
		expect(errorOutput).not.toContain("WorkflowFreezeError");
	});

	it("lists workflow names without long artifact paths by default", async () => {
		const stdout: string[] = [];
		vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
			stdout.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
			return true;
		});

		await runWorkflowCommand({
			action: "list",
			args: [],
			flags: {},
		});

		const output = stdout.join("");
		expect(output).toContain("experimental::humanize-rlcr");
		expect(output).not.toContain("/examples/workflow/");
		expect(output).not.toContain("\\examples\\workflow\\");
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

	it("includes failed activation diagnostics in headless workflow JSON", async () => {
		using tempDir = TempDir.createSync("@omp-workflow-cli-failed-diagnostics-");
		const root = tempDir.path();
		await Bun.write(`${root}/failed-diagnostics.omhflow`, workflowFailedDiagnosticsFlow());
		await Bun.write(`${root}/failed-diagnostics/scripts/fail.sh`, workflowFailedDiagnosticsScript());
		const output: string[] = [];
		vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
			output.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
			return true;
		});
		const originalExitCode = process.exitCode;
		process.exitCode = undefined;

		try {
			await runWorkflowCommand({
				action: "start",
				args: [`${root}/failed-diagnostics.omhflow`],
				flags: {
					cwd: root,
					json: true,
					runId: "failed-diagnostics-run",
				},
			});
		} finally {
			process.exitCode = originalExitCode ?? 0;
		}

		const result = JSON.parse(output.join("").trim()) as {
			run: { status: string; failed: number };
			failedActivations?: Array<{ id: string; nodeId: string; error: string }>;
			diagnostics?: { progressPath: string; observabilityPath: string };
		};
		expect(result.run).toMatchObject({ status: "failed", failed: 1 });
		expect(result.failedActivations?.[0]).toEqual({
			id: "activation-1",
			nodeId: "fail",
			error: 'workflow script node "fail" failed: boom',
		});
		expect(result.diagnostics).toEqual({
			progressPath: path.join(root, "workflow-output/omh-runtime/progress.md"),
			observabilityPath: path.join(root, "workflow-output/omh-runtime/observability.json"),
		});
	});

	it("exits nonzero and records observability for prompt binding failures", async () => {
		using tempDir = TempDir.createSync("@omp-workflow-cli-binding-diagnostics-");
		const root = tempDir.path();
		await Bun.write(`${root}/binding-diagnostics.omhflow`, workflowBindingDiagnosticsFlow());
		await Bun.write(`${root}/binding-diagnostics/prompts/needs-binding.md`, "Missing value: {{missingValue}}\n");
		const output: string[] = [];
		vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
			output.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
			return true;
		});
		const originalExitCode = process.exitCode;
		let observedExitCode: string | number | undefined;
		process.exitCode = undefined;
		try {
			await runWorkflowCommand({
				action: "start",
				args: [`${root}/binding-diagnostics.omhflow`],
				flags: {
					cwd: root,
					json: true,
					runId: "binding-diagnostics-run",
				},
			});
			observedExitCode = process.exitCode;
		} finally {
			process.exitCode = originalExitCode ?? 0;
		}

		const result = JSON.parse(output.join("").trim()) as {
			run: { status: string; failed: number };
			failedActivations?: Array<{ id: string; nodeId: string; error: string }>;
		};
		expect(Number(observedExitCode)).toBe(1);
		expect(result.run).toMatchObject({ status: "failed", failed: 1 });
		expect(result.failedActivations?.[0]?.nodeId).toBe("needsBinding");
		const observability = await Bun.file(`${root}/workflow-output/omh-runtime/observability.json`).json();
		expect(observability.activations).toEqual([
			expect.objectContaining({
				activationId: "activation-1",
				nodeId: "needsBinding",
				status: "failed",
				error: expect.stringContaining("missingValue"),
			}),
		]);
	});

	it("uses workflow shell policy for headless shell script nodes", async () => {
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

	it("runs isolated headless workflow agents outside the parent checkout and captures a patch", async () => {
		using tempDir = TempDir.createSync("@omp-workflow-cli-agent-isolation-");
		const root = tempDir.path();
		await initGitRepo(root);
		const artifactsDir = path.join(root, "agent-artifacts");
		const launchedCwds: string[] = [];

		const result = await runHeadlessAgentTask(
			root,
			{
				activationId: "activation-1",
				nodeId: "branch",
				agent: "task",
				task: {
					id: "branch",
					description: "branch",
					role: "optimizer",
					assignment: "write a lane-local artifact",
				},
				isolated: true,
				apply: false,
				merge: false,
			},
			{
				artifactsDir,
				runProcess: async (_args, options) => {
					launchedCwds.push(options.cwd);
					await Bun.write(path.join(options.cwd, "lane-output.txt"), "isolated lane output\n");
					return {
						exitCode: 0,
						stdout: JSON.stringify({ summary: "lane finished" }),
						stderr: "",
					};
				},
			},
		);

		expect(result.exitCode).toBe(0);
		expect(result.changesApplied).toBe(null);
		expect(result.patchPath).toBe(path.join(artifactsDir, "workflow-branch-activation-1.patch"));
		expect(launchedCwds).toHaveLength(1);
		expect(launchedCwds[0]).not.toBe(root);
		expect(await Bun.file(path.join(root, "lane-output.txt")).exists()).toBe(false);
		expect(await Bun.file(result.patchPath ?? "").text()).toContain("lane-output.txt");
	});

	it("records non-isolated headless workflow agent stdout and session artifacts", async () => {
		using tempDir = TempDir.createSync("@omp-workflow-cli-agent-artifacts-");
		const root = tempDir.path();
		const artifactsDir = path.join(root, "agent-artifacts");
		let launchedArgs: string[] = [];

		const result = await runHeadlessAgentTask(
			root,
			{
				activationId: "activation-1",
				nodeId: "build",
				agent: "task",
				task: {
					id: "build",
					description: "build",
					role: "builder",
					assignment: "write structured workflow evidence",
				},
			},
			{
				artifactsDir,
				runProcess: async args => {
					launchedArgs = args;
					const sessionDirFlag = args.indexOf("--session-dir");
					const sessionDir = args[sessionDirFlag + 1];
					if (sessionDir === undefined) throw new Error("expected workflow subagent session dir");
					await Bun.write(path.join(sessionDir, "session.jsonl"), '{"type":"session"}\n');
					return {
						exitCode: 0,
						stdout: '{"summary":"agent produced structured evidence"}\n',
						stderr: "",
					};
				},
			},
		);

		const agentDir = path.join(artifactsDir, "workflow-build-activation-1");
		const sessionDir = path.join(agentDir, "sessions");
		expect(launchedArgs).toContain("--session-dir");
		expect(launchedArgs[launchedArgs.indexOf("--session-dir") + 1]).toBe(sessionDir);
		expect(result).toMatchObject({
			exitCode: 0,
			output: '{"summary":"agent produced structured evidence"}',
			agentId: "workflow-build-activation-1",
			outputPath: path.join(agentDir, "output.md"),
			sessionFile: path.join(sessionDir, "session.jsonl"),
		});
		expect(await Bun.file(path.join(agentDir, "output.md")).text()).toBe(
			'{"summary":"agent produced structured evidence"}\n',
		);
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

async function initGitRepo(root: string): Promise<void> {
	await Bun.write(path.join(root, "README.md"), "baseline\n");
	await $`git init`.cwd(root).quiet();
	await $`git add README.md`.cwd(root).quiet();
	await $`git -c user.name=omh-test -c user.email=omh-test@example.invalid -c commit.gpgsign=false commit -m baseline`
		.cwd(root)
		.quiet();
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

function workflowFailedDiagnosticsFlow(): string {
	return [
		"---",
		"name: failed-diagnostics",
		"version: 1",
		"schema: omhflow/v1",
		"resourceDir: failed-diagnostics",
		"models:",
		"  roles: {}",
		"  defaults: {}",
		"checkpoint:",
		"  stopDeadlineMs: 30000",
		"changePolicy:",
		"  agentsCanPropose: true",
		"  humansCanApprove: true",
		"---",
		"# Failed diagnostics smoke",
		"",
		"```yaml workflow",
		"resources:",
		"  - path: scripts/fail.sh",
		"    kind: script",
		"sequence:",
		"  - node:",
		"      id: fail",
		"      type: script",
		"      script:",
		"        language: sh",
		"        file: scripts/fail.sh",
		"```",
	].join("\n");
}

function workflowFailedDiagnosticsScript(): string {
	return ["#!/bin/sh", "set -eu", "printf 'boom\\n' >&2", "exit 7"].join("\n");
}

function workflowBindingDiagnosticsFlow(): string {
	return [
		"---",
		"name: binding-diagnostics",
		"version: 1",
		"schema: omhflow/v1",
		"resourceDir: binding-diagnostics",
		"models:",
		"  roles: {}",
		"  defaults: {}",
		"checkpoint:",
		"  stopDeadlineMs: 30000",
		"changePolicy:",
		"  agentsCanPropose: true",
		"  humansCanApprove: true",
		"---",
		"# Binding diagnostics smoke",
		"",
		"```yaml workflow",
		"resources:",
		"  - path: prompts/needs-binding.md",
		"    kind: prompt",
		"sequence:",
		"  - node:",
		"      id: needsBinding",
		"      type: agent",
		"      agent: task",
		"      prompt:",
		"        template:",
		"          file: prompts/needs-binding.md",
		"          bindings:",
		"            missingValue:",
		"              state: /missingValue",
		"```",
	].join("\n");
}

function workflowJsModuleScriptFlow(): string {
	return [
		"---",
		"name: js-module-script",
		"version: 1",
		"schema: omhflow/v1",
		"resourceDir: js-module-script",
		"models:",
		"  roles: {}",
		"  defaults: {}",
		"checkpoint:",
		"  stopDeadlineMs: 30000",
		"changePolicy:",
		"  agentsCanPropose: true",
		"  humansCanApprove: true",
		"---",
		"# JS module script fixture",
		"",
		"```yaml workflow",
		"resources:",
		"  - path: scripts/module-style.js",
		"    kind: script",
		"sequence:",
		"  - node:",
		"      id: moduleStyle",
		"      type: script",
		"      script:",
		"        language: js",
		"        file: scripts/module-style.js",
		"```",
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
	const pythonNoUserSiteExpansion = "$" + "{PYTHONNOUSERSITE-unset}";
	const pythonPathSetExpansion = "$" + "{PYTHONPATH+x}";
	const pythonPathExpansion = "$" + "{PYTHONPATH-unset}";
	return [
		"#!/bin/sh",
		"set -eu",
		`test "${pythonNoUserSiteExpansion}" = "unset"`,
		`test "${pythonPathSetExpansion}" != "x"`,
		`printf '{"summary":"python env follows workflow policy","statePatch":[{"op":"set","path":"/pythonEnv","value":{"noUserSite":"%s","pythonPath":"%s"}}]}\\n' "${pythonNoUserSiteExpansion}" "${pythonPathExpansion}"`,
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
