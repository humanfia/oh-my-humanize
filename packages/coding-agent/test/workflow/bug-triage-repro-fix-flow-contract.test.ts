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
		task?: {
			taskText?: string;
			text?: string;
		};
		cause?: object;
		regression?: {
			status?: string;
		};
	};
}

interface ScriptResult {
	summary: string;
	statePatch?: Array<{
		op: "set";
		path: string;
		value: unknown;
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

describe("bug-triage-repro-fix flow contract", () => {
	it("rejects multiline heredoc reproduction commands before they can be truncated", async () => {
		const cwd = await createGitRepo();
		await Bun.write(
			path.join(cwd, "task.md"),
			[
				"Objective:",
				"Reproduce a bug without truncating the shell command.",
				"",
				"Reproduction Command:",
				"```sh",
				"PYTHONPATH=src python - <<'PY'",
				"raise AssertionError('real reproduction body')",
				"PY",
				"```",
				"",
				"Validation Command:",
				"python -c \"print('validation')\"",
				"",
			].join("\n"),
		);

		await expect(runScriptFile(cwd, "precheck-task-contract.js", {})).rejects.toThrow(
			"Reproduction Command must be a single-line command",
		);
	});

	it("rejects archiving when untracked workspace byproducts escape the allowed paths", async () => {
		const cwd = await createGitRepo();
		const taskText = [
			"Objective:",
			"Fix a scoped bug.",
			"",
			"Reproduction Command: python -c \"raise AssertionError('bug')\"",
			"Validation Command: python -c \"print('validation pass')\"",
			"Allowed paths: src/app.py, tests/test_app.py, workflow-output/**, task.md.",
			"",
		].join("\n");
		await fs.mkdir(path.join(cwd, "src"), { recursive: true });
		await fs.mkdir(path.join(cwd, "tests"), { recursive: true });
		await fs.mkdir(path.join(cwd, "workflow-output"), { recursive: true });
		await Bun.write(path.join(cwd, "task.md"), taskText);
		await Bun.write(path.join(cwd, "src/app.py"), "VALUE = 1\n");
		await Bun.write(path.join(cwd, "tests/test_app.py"), "def test_app():\n    assert True\n");
		await runCommand(["git", "add", "task.md", "src/app.py", "tests/test_app.py"], cwd);
		await runCommand(["git", "commit", "-m", "init"], cwd);

		await Bun.write(path.join(cwd, "src/app.py"), "VALUE = 2\n");
		await fs.mkdir(path.join(cwd, ".venv", "bin"), { recursive: true });
		await Bun.write(path.join(cwd, ".venv", "bin", "python"), "# workspace byproduct\n");

		await expect(
			runScriptFile(cwd, "archive-bugfix.js", {
				task: { taskText },
				regression: { status: "pass" },
			}),
		).rejects.toThrow(".venv/bin/python changed outside task allowed paths");
	});
});

async function runScriptFile(
	cwd: string,
	scriptFileName: string,
	state: WorkflowContext["state"],
): Promise<ScriptResult> {
	const scriptPath = path.resolve(
		import.meta.dir,
		"../../examples/workflow/experimental/bug-triage-repro-fix/bug-triage-repro-fix/scripts",
		scriptFileName,
	);
	const script = await Bun.file(scriptPath).text();
	const execute = new ScriptFunctionConstructor("workflowContext", script);
	const originalCwd = process.cwd();
	try {
		process.chdir(cwd);
		return await execute({
			activation: { id: `activation-${scriptFileName}` },
			completedActivations: [],
			state,
		});
	} finally {
		process.chdir(originalCwd);
	}
}

async function createGitRepo(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omh-bug-triage-"));
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
