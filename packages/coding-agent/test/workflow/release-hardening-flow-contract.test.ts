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
