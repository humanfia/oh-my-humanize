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

		const result = await runScript(cwd, {
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
});

async function runScript(cwd: string, state: WorkflowContext["state"]): Promise<ScriptResult> {
	const scriptPath = path.resolve(
		import.meta.dir,
		"../../examples/workflow/experimental/release-hardening/release-hardening/scripts/enforce-release-gate.js",
	);
	const script = await Bun.file(scriptPath).text();
	const execute = new ScriptFunctionConstructor("workflowContext", script);
	const originalCwd = process.cwd();
	try {
		process.chdir(cwd);
		return await execute({
			activation: { id: "activation-enforceReleaseGate" },
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
