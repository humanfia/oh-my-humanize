import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

interface WorkflowContext {
	activation: {
		id: string;
	};
	completedActivations: unknown[];
	state?: {
		review?: string;
		checks?: {
			status?: string;
		};
		task?: {
			taskText?: string;
			validationCommand?: string;
			securityCommand?: string;
		};
		changelog?: object;
		compatibility?: object;
		releaseGate?: {
			status?: string;
		};
	};
}

interface ScriptResult {
	summary: string;
	statePatch?: Array<{
		op: "set";
		path: string;
		value: {
			status?: string;
			workspaceGuard?: {
				status?: string;
				blockers?: string[];
				allowedScopes?: string[];
			};
			workspaceScope?: {
				status?: string;
				blockers?: string[];
				allowedScopes?: string[];
			};
			resolvedBlockers?: Array<{
				source?: string;
				text?: string;
			}>;
			outcome?: string;
			validation?: string;
		};
	}>;
}

const ScriptFunctionConstructor = Object.getPrototypeOf(async () => {}).constructor as new (
	workflowContextName: string,
	code: string,
) => (workflowContext: WorkflowContext) => Promise<ScriptResult>;

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("release-hardening flow contract", () => {
	it("marks release checks failed when changed files escape task allowed paths", async () => {
		const cwd = await createGitRepo();
		const taskText = [
			"Objective: repair release docs in docs only.",
			"",
			"Validation Command: true",
			"Security Command: true",
			"Allowed paths: docs/**, workflow-output/**, task.md, manifest-entry.json, monitor-assignment.json.",
		].join("\n");
		await fs.mkdir(path.join(cwd, "docs"), { recursive: true });
		await Bun.write(path.join(cwd, "task.md"), taskText);
		await Bun.write(path.join(cwd, "README.md"), "Rich supports Python 3.8.\n");
		await Bun.write(path.join(cwd, "docs", "intro.rst"), "Rich supports Python 3.8.\n");
		await runCommand(["git", "add", "task.md", "README.md", "docs/intro.rst"], cwd);
		await runCommand(["git", "commit", "-m", "init"], cwd);
		await Bun.write(path.join(cwd, "README.md"), "Rich supports Python 3.9.\n");
		await Bun.write(path.join(cwd, "docs", "intro.rst"), "Rich supports Python 3.9.\n");

		const result = await runScript(cwd, "run-release-checks.js", {
			task: {
				taskText,
				validationCommand: "true",
				securityCommand: "true",
			},
		});
		const checks = result.statePatch?.find(patch => patch.path === "/checks")?.value;
		const evidence = await Bun.file(path.join(cwd, "workflow-output", "release-checks.md")).text();

		expect(result.summary).toBe("ran release checks; validation=pass security=pass scope=blocked");
		expect(checks).toMatchObject({
			status: "fail",
			workspaceScope: {
				status: "blocked",
				blockers: ["README.md changed outside task allowed paths"],
			},
		});
		expect(evidence).toContain("## Workspace Scope");
		expect(evidence).toContain("README.md changed outside task allowed paths");
	});

	it("does not treat scope fence prose as allowed release paths", async () => {
		const cwd = await createGitRepo();
		const taskText = [
			"Objective: harden release checks.",
			"",
			"Validation Command: true",
			"Security Command: true",
			"Scope Fence: Allowed paths are src/flask/**, tests/test_config.py, workflow-output/**. Out of scope: broad API changes, unrelated routing behavior, generated files.",
		].join("\n");
		await fs.mkdir(path.join(cwd, "src/flask"), { recursive: true });
		await fs.mkdir(path.join(cwd, "tests"), { recursive: true });
		await fs.mkdir(path.join(cwd, "broad API changes"), { recursive: true });
		await Bun.write(path.join(cwd, "task.md"), taskText);
		await Bun.write(path.join(cwd, "src/flask/config.py"), "CONFIG = True\n");
		await Bun.write(path.join(cwd, "tests/test_config.py"), "def test_config():\n    assert True\n");
		await runCommand(["git", "add", "task.md", "src/flask/config.py", "tests/test_config.py"], cwd);
		await runCommand(["git", "commit", "-m", "init"], cwd);
		await Bun.write(path.join(cwd, "broad API changes/notes.txt"), "not an allowed path\n");

		const result = await runScript(cwd, "run-release-checks.js", {
			task: {
				taskText,
				validationCommand: "true",
				securityCommand: "true",
			},
		});
		const checks = result.statePatch?.find(patch => patch.path === "/checks")?.value;
		const allowedScopes = checks?.workspaceScope?.allowedScopes ?? [];

		expect(result.summary).toBe("ran release checks; validation=pass security=pass scope=blocked");
		expect(allowedScopes).toContain("src/flask/**");
		expect(allowedScopes).toContain("tests/test_config.py");
		expect(allowedScopes).not.toContain("broad API changes");
		expect(allowedScopes).not.toContain("unrelated routing behavior");
		expect(allowedScopes).not.toContain("generated files");
		expect(checks).toMatchObject({
			workspaceScope: {
				blockers: ["broad API changes/notes.txt changed outside task allowed paths"],
			},
		});
	});

	it("scrubs inherited TLS key log configuration before release validation", async () => {
		const cwd = await createGitRepo();
		const taskText = [
			"Objective: run release validation without leaking host TLS key log paths.",
			"",
			'Validation Command: if [ -n "$SSLKEYLOGFILE" ]; then printf leak > "$SSLKEYLOGFILE"; exit 7; fi',
			"Allowed paths: workflow-output/**, task.md.",
		].join("\n");
		await Bun.write(path.join(cwd, "task.md"), taskText);
		await runCommand(["git", "add", "task.md"], cwd);
		await runCommand(["git", "commit", "-m", "init"], cwd);

		const result = await runScriptInChild(
			cwd,
			"run-release-checks.js",
			{
				task: {
					taskText,
					validationCommand: 'if [ -n "$SSLKEYLOGFILE" ]; then printf leak > "$SSLKEYLOGFILE"; exit 7; fi',
				},
			},
			{ SSLKEYLOGFILE: "test" },
		);
		const checks = result.statePatch?.find(patch => patch.path === "/checks")?.value;

		expect(result.summary).toBe("ran release checks; validation=pass security=skipped scope=pass");
		expect(checks).toMatchObject({
			status: "pass",
			workspaceScope: {
				status: "pass",
				blockers: [],
			},
		});
		expect(await Bun.file(path.join(cwd, "test")).exists()).toBe(false);
	});

	it("cleans untracked artifacts created by release validation before scope checks", async () => {
		const cwd = await createGitRepo();
		const taskText = [
			"Objective: run release validation that may produce transient test runner artifacts.",
			"",
			"Validation Command: printf '# TLS secrets log file, generated by OpenSSL / Python\\n' > test",
			"Allowed paths: workflow-output/**, task.md.",
		].join("\n");
		await Bun.write(path.join(cwd, "task.md"), taskText);
		await runCommand(["git", "add", "task.md"], cwd);
		await runCommand(["git", "commit", "-m", "init"], cwd);

		const result = await runScript(cwd, "run-release-checks.js", {
			task: {
				taskText,
				validationCommand: "printf '# TLS secrets log file, generated by OpenSSL / Python\\n' > test",
			},
		});
		const checks = result.statePatch?.find(patch => patch.path === "/checks")?.value;
		const evidence = await Bun.file(path.join(cwd, "workflow-output", "release-checks.md")).text();

		expect(result.summary).toBe("ran release checks; validation=pass security=skipped scope=pass");
		expect(checks).toMatchObject({
			status: "pass",
			workspaceScope: {
				status: "pass",
				blockers: [],
			},
		});
		expect(await Bun.file(path.join(cwd, "test")).exists()).toBe(false);
		expect(evidence).toContain("## Validation-Generated Artifacts");
		expect(evidence).toContain("test");
	});

	it("accepts scoped target diffs and workflow artifacts in the final release gate", async () => {
		const cwd = await createGitRepo();
		const taskText = [
			"Objective: harden release notes.",
			"",
			"Validation Command: python -m pytest tests/test_console.py",
			"Security Command: python -m py_compile rich/console.py",
			"Scope Fence: Allowed paths are rich/console.py, tests/test_console.py, docs/source/**, CHANGELOG.md if present, and workflow-output/**. Do not edit unrelated files.",
			"",
		].join("\n");

		await fs.mkdir(path.join(cwd, "docs/source"), { recursive: true });
		await fs.mkdir(path.join(cwd, "tests"), { recursive: true });
		await fs.mkdir(path.join(cwd, "workflow-output"), { recursive: true });
		await Bun.write(path.join(cwd, "task.md"), taskText);
		await Bun.write(path.join(cwd, "docs/source/introduction.rst"), "Rich requires Python 3.8.0 and above.\n");
		await Bun.write(path.join(cwd, "tests/test_console.py"), "def test_force_color():\n    assert True\n");
		await runCommand(["git", "add", "task.md", "docs/source/introduction.rst", "tests/test_console.py"], cwd);
		await runCommand(["git", "commit", "-m", "init"], cwd);
		await Bun.write(path.join(cwd, "docs/source/introduction.rst"), "Rich requires Python 3.9.0 and above.\n");
		await Bun.write(
			path.join(cwd, "tests/test_console.py"),
			"def test_force_color_is_terminal():\n    assert True\n",
		);
		await Bun.write(path.join(cwd, "workflow-output/release-audit.md"), "Resolved Python support blocker.\n");
		await Bun.write(path.join(cwd, "workflow-output/release-rollback.md"), "Revert scoped docs/tests edits.\n");

		const result = await runScript(cwd, "enforce-release-gate.js", {
			review: "finish",
			checks: { status: "pass" },
			task: { taskText },
			changelog: { summary: "No changelog blockers." },
			compatibility: { summary: "No compatibility blockers." },
		});
		const releaseGate = result.statePatch?.find(patch => patch.path === "/releaseGate")?.value;

		expect(result.summary).toBe("release gate passed");
		expect(releaseGate).toMatchObject({
			status: "pass",
			workspaceGuard: {
				status: "pass",
				blockers: [],
			},
		});
		expect(releaseGate?.workspaceGuard?.allowedScopes).toContain("docs/source/**");
		expect(releaseGate?.workspaceGuard?.allowedScopes).toContain("tests/test_console.py");
	});

	it("reports waived audit blockers separately from unresolved blockers", async () => {
		const cwd = await createGitRepo();
		const taskText = [
			"Objective: release hardening evidence.",
			"",
			"Validation Command: true",
			"Allowed paths: docs/**, workflow-output/**, task.md.",
		].join("\n");
		await Bun.write(path.join(cwd, "task.md"), taskText);
		await runCommand(["git", "add", "task.md"], cwd);
		await runCommand(["git", "commit", "-m", "init"], cwd);
		await Bun.write(
			path.join(cwd, "workflow-output", "release-audit.md"),
			[
				"# Release Audit",
				"",
				"## Waivers",
				"",
				"- Waived `README.md` stale Python support wording because the scoped task excludes root README files.",
				"- Resolved `Text.from_ansi` compatibility risk through focused evidence in the release repair.",
			].join("\n"),
		);
		await Bun.write(path.join(cwd, "workflow-output", "release-rollback.md"), "Rollback notes.\n");

		const result = await runScript(cwd, "enforce-release-gate.js", {
			review: "finish",
			checks: { status: "pass" },
			task: { taskText },
			changelog: { findings: ["README.md stale Python support wording should block release until repaired"] },
			compatibility: { risks: ["Text.from_ansi compatibility risk should hold release until checked"] },
		});
		const releaseGate = result.statePatch?.find(patch => patch.path === "/releaseGate")?.value;
		const gate = await Bun.file(path.join(cwd, "workflow-output", "release-gate.md")).text();

		expect(releaseGate).toMatchObject({
			status: "pass",
			unresolvedBlockers: [],
			resolvedBlockers: [{ source: "changelog" }, { source: "compatibility" }],
		});
		expect(gate).toContain("resolved_blockers: 2");
		expect(gate).toContain("unresolved_blockers: 0");
		expect(gate).toContain("## Resolved Audit Blockers");
		expect(gate).toContain("README.md stale Python support wording");
		expect(gate).toContain("Text.from_ansi compatibility risk");
	});

	it("does not fail the release gate on resolved stale compatibility hold state", async () => {
		const cwd = await createGitRepo();
		const taskText = [
			"Objective: harden scoped release docs.",
			"",
			"Validation Command: true",
			"Security Command: true",
			"Allowed paths: docs/**, workflow-output/**, task.md.",
		].join("\n");
		await fs.mkdir(path.join(cwd, "docs"), { recursive: true });
		await Bun.write(path.join(cwd, "task.md"), taskText);
		await Bun.write(path.join(cwd, "docs", "introduction.rst"), "Python 3.8.0\n");
		await runCommand(["git", "add", "task.md", "docs/introduction.rst"], cwd);
		await runCommand(["git", "commit", "-m", "init"], cwd);
		await Bun.write(path.join(cwd, "docs", "introduction.rst"), "Python 3.9.0\n");
		await Bun.write(
			path.join(cwd, "workflow-output", "release-audit.md"),
			[
				"# Release Audit",
				"",
				"Resolved stale Python support docs in docs/introduction.rst.",
				"Waived README-family stale Python support wording as outside this scoped task and requiring a fresh contract.",
			].join("\n"),
		);
		await Bun.write(
			path.join(cwd, "workflow-output", "release-rollback.md"),
			"Rollback: revert docs/introduction.rst Python support wording.\n",
		);

		const result = await runScript(cwd, "enforce-release-gate.js", {
			review: "finish",
			checks: { status: "pass" },
			task: { taskText },
			compatibility: {
				status: "hold-before-review",
				risks: [
					"stale Python support docs in docs/introduction.rst",
					"README-family stale Python support wording should use a fresh task contract",
				],
			},
		});
		const releaseGate = result.statePatch?.find(patch => patch.path === "/releaseGate")?.value;
		const gate = await Bun.file(path.join(cwd, "workflow-output", "release-gate.md")).text();

		expect(result.summary).toBe("release gate passed");
		expect(releaseGate).toMatchObject({
			status: "pass",
			unresolvedBlockers: [],
		});
		expect(gate).toContain("resolved_blockers: 2");
		expect(gate).toContain("unresolved_blockers: 0");
		expect(gate).not.toContain("compatibility: status: hold-before-review");
	});

	it("archives terminal hold when a fresh task contract is required", async () => {
		const cwd = await createGitRepo();
		const taskText = [
			"Objective: harden release checks.",
			"",
			"Validation Command: true",
			"Allowed paths: tests/test_config.py, workflow-output/**, task.md.",
		].join("\n");
		await fs.mkdir(path.join(cwd, "tests"), { recursive: true });
		await Bun.write(path.join(cwd, "task.md"), taskText);
		await Bun.write(path.join(cwd, "tests/test_config.py"), "def test_config():\n    assert True\n");
		await runCommand(["git", "add", "task.md", "tests/test_config.py"], cwd);
		await runCommand(["git", "commit", "-m", "init"], cwd);
		await Bun.write(path.join(cwd, "test"), "# TLS secrets log file, generated by OpenSSL / Python.\n");
		await Bun.write(
			path.join(cwd, "workflow-output", "release-audit.md"),
			[
				"# Release Audit",
				"",
				"Fresh-contract handoff: root-level `test` is outside the frozen allowed paths.",
				"No waiver is applied. Operator cleanup or a refreshed task contract is required.",
			].join("\n"),
		);
		await Bun.write(
			path.join(cwd, "workflow-output", "release-rollback.md"),
			"Release remains blocked until root-level `test` is removed out of band or under a refreshed contract.\n",
		);

		const gateResult = await runScript(cwd, "enforce-release-gate.js", {
			review: "hold",
			checks: { status: "pass" },
			task: { taskText },
			changelog: { summary: "No changelog blockers." },
			compatibility: { summary: "No compatibility blockers." },
		});
		const archiveResult = await runScript(cwd, "archive-release.js", {
			checks: { status: "pass" },
			releaseGate: {
				status: "hold",
			},
		});
		const releaseGate = gateResult.statePatch?.find(patch => patch.path === "/releaseGate")?.value;
		const archive = archiveResult.statePatch?.find(patch => patch.path === "/archive")?.value;
		const gate = await Bun.file(path.join(cwd, "workflow-output", "release-gate.md")).text();

		expect(gateResult.summary).toBe("release gate held for fresh task contract");
		expect(releaseGate).toMatchObject({
			status: "hold",
			workspaceGuard: {
				status: "blocked",
				blockers: ["test changed outside task allowed paths", "test is an untracked project file"],
			},
		});
		expect(gate).toContain("status: hold");
		expect(gate).toContain("release reviewer requested fresh task contract");
		expect(archiveResult.summary).toBe("archived release hardening evidence");
		expect(archive).toMatchObject({
			outcome: "rejected",
			validation: "hold",
		});
	});
});

async function runScript(cwd: string, scriptName: string, state: WorkflowContext["state"]): Promise<ScriptResult> {
	const scriptPath = path.resolve(
		import.meta.dir,
		`../../examples/workflow/experimental/release-hardening/release-hardening/scripts/${scriptName}`,
	);
	const script = await Bun.file(scriptPath).text();
	const execute = new ScriptFunctionConstructor("workflowContext", script);
	const originalCwd = process.cwd();
	try {
		process.chdir(cwd);
		return await execute({
			activation: { id: `activation-${scriptName}` },
			completedActivations: [],
			state,
		});
	} finally {
		process.chdir(originalCwd);
	}
}

async function runScriptInChild(
	cwd: string,
	scriptName: string,
	state: WorkflowContext["state"],
	envOverrides: Record<string, string | undefined>,
): Promise<ScriptResult> {
	const scriptPath = path.resolve(
		import.meta.dir,
		`../../examples/workflow/experimental/release-hardening/release-hardening/scripts/${scriptName}`,
	);
	const resultPath = path.join(cwd, "workflow-output", `child-result-${scriptName}.json`);
	const childCode = [
		`const script = await Bun.file(${JSON.stringify(scriptPath)}).text();`,
		"const ScriptFunctionConstructor = Object.getPrototypeOf(async () => {}).constructor;",
		'const execute = new ScriptFunctionConstructor("workflowContext", script);',
		`const result = await execute({ activation: { id: ${JSON.stringify(`activation-${scriptName}`)} }, completedActivations: [], state: ${JSON.stringify(state)} });`,
		`await Bun.write(${JSON.stringify(resultPath)}, JSON.stringify(result));`,
	].join("\n");
	const proc = Bun.spawn([process.execPath, "-e", childCode], {
		cwd,
		env: childEnvironment(envOverrides),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (exitCode !== 0) {
		throw new Error(`child ${scriptName} failed: ${stderr || stdout}`);
	}
	return (await Bun.file(resultPath).json()) as ScriptResult;
}

function childEnvironment(overrides: Record<string, string | undefined>): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (typeof value === "string") {
			env[key] = value;
		}
	}
	for (const [key, value] of Object.entries(overrides)) {
		if (value === undefined) {
			delete env[key];
		} else {
			env[key] = value;
		}
	}
	return env;
}

async function createGitRepo(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omh-release-hardening-"));
	tempDirs.push(dir);
	await runCommand(["git", "init"], dir);
	await runCommand(["git", "config", "user.email", "test@example.com"], dir);
	await runCommand(["git", "config", "user.name", "Test User"], dir);
	await runCommand(["git", "config", "commit.gpgsign", "false"], dir);
	return dir;
}

async function runCommand(command: string[], cwd: string): Promise<void> {
	const proc = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (exitCode !== 0) {
		throw new Error(`${command.join(" ")} failed: ${stderr || stdout}`);
	}
}
