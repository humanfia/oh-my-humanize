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
			text?: string;
			validationCommand?: string;
			compatibilityCommand?: string;
		};
		compatibility?: object;
		migration?: object;
		cleanup?: object;
		validation?: object;
	};
}

interface ReviewContextResult {
	summary: string;
	statePatch?: Array<{
		op: "set";
		path: string;
		value: {
			workspace?: {
				allowedScopes?: string[];
				blockers?: string[];
				status?: string;
			};
		};
	}>;
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
) => (workflowContext: WorkflowContext) => Promise<ReviewContextResult>;

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("refactor-migration-plan flow contract", () => {
	it("rejects multiline compatibility command contracts before shell execution", async () => {
		const cwd = await createGitRepo();
		await Bun.write(
			path.join(cwd, "task.md"),
			[
				"Objective:",
				"Reject fragile multiline compatibility commands.",
				"",
				"Compatibility Command:",
				"```sh",
				"PYTHONPATH=. python - <<'PY'",
				"print('compat')",
				"PY",
				"```",
				"",
				"Validation Command:",
				"python -c \"print('validation')\"",
				"",
			].join("\n"),
		);

		await expect(runScriptFile(cwd, "precheck-task-contract.js", {})).rejects.toThrow(
			"Compatibility Command must be a single-line command",
		);
	});

	it("rejects validation commands that fail preflight before migration agents edit", async () => {
		const cwd = await createGitRepo();
		await Bun.write(
			path.join(cwd, "task.md"),
			[
				"Objective:",
				"Reject validation commands that cannot run before migration.",
				"",
				"Validation Command:",
				"python -m definitely_missing_omh_refactor_validation_module -q",
				"",
			].join("\n"),
		);

		await expect(runScriptFile(cwd, "precheck-task-contract.js", {})).rejects.toThrow(
			"validation command failed preflight",
		);
		const precheck = await Bun.file(path.join(cwd, "workflow-output", "refactor-migration-precheck.md")).text();
		expect(precheck).toContain("## Validation Preflight");
		expect(precheck).toContain("definitely_missing_omh_refactor_validation_module");
	});

	it("cleans untracked preflight byproducts before migration agents edit", async () => {
		const cwd = await createGitRepo();
		await Bun.write(path.join(cwd, "tracked.py"), "print('tracked')\n");
		await Bun.write(
			path.join(cwd, "task.md"),
			[
				"Objective:",
				"Keep validation preflight side effects out of the shared workspace.",
				"",
				"Compatibility Command:",
				"python -c \"open('test', 'w').write('TLS secrets log file')\"",
				"",
				"Validation Command:",
				"python -c \"print('validation ok')\"",
				"",
			].join("\n"),
		);
		await runCommand(["git", "add", "tracked.py", "task.md"], cwd);
		await runCommand(["git", "commit", "-m", "baseline"], cwd);

		const result = await runScriptFile(cwd, "precheck-task-contract.js", {});

		expect(await Bun.file(path.join(cwd, "test")).exists()).toBe(false);
		expect(await gitStatus(cwd)).toBe("?? workflow-output/refactor-migration-precheck.md");
		const taskState = result.statePatch?.find(patch => patch.path === "/task")?.value;
		expect(taskState).toMatchObject({
			preflightByproducts: ["test"],
		});
		const precheck = await Bun.file(path.join(cwd, "workflow-output", "refactor-migration-precheck.md")).text();
		expect(precheck).toContain("## Preflight Workspace Cleanup");
		expect(precheck).toContain("- removed untracked preflight byproduct `test`");
	});

	it("exposes continuation lines from multiline allowed paths in the review context", async () => {
		const cwd = await createGitRepo();
		const taskText = [
			"Objective:",
			"Migrate repeated rich help assertions to a helper.",
			"",
			"Compatibility Command:",
			"python -m py_compile tests/test_rich_markup_mode.py",
			"",
			"Validation Command:",
			"python -c \"print('ok')\"",
			"",
			"Scope Fence:",
			"Allowed paths: tests/test_rich_markup_mode.py, workflow-output/**, task.md,",
			"manifest-entry.json, monitor-assignment.json.",
			"",
		].join("\n");
		await fs.mkdir(path.join(cwd, "tests"), { recursive: true });
		await Bun.write(path.join(cwd, "task.md"), taskText);
		await Bun.write(path.join(cwd, "tests", "test_rich_markup_mode.py"), "def test_existing():\n    assert True\n");
		await runCommand(["git", "add", "task.md", "tests/test_rich_markup_mode.py"], cwd);
		await runCommand(["git", "commit", "-m", "init"], cwd);
		await Bun.write(
			path.join(cwd, "tests", "test_rich_markup_mode.py"),
			"def has_rounded_help_panel(output: str) -> bool:\n    return bool(output)\n",
		);

		const result = await runScript(cwd, {
			task: { text: taskText },
			compatibility: {
				behavior: "Preserve rich help border detection semantics.",
			},
		});
		const reviewContext = result.statePatch?.find(patch => patch.path === "/reviewContext")?.value;

		expect(reviewContext?.workspace?.status).toBe("pass");
		expect(reviewContext?.workspace?.blockers).toEqual([]);
		expect(reviewContext?.workspace?.allowedScopes).toEqual([
			"tests/test_rich_markup_mode.py",
			"workflow-output/**",
			"task.md",
			"manifest-entry.json",
			"monitor-assignment.json",
		]);
		const artifact = await Bun.file(path.join(cwd, "workflow-output", "refactor-migration-review-context.md")).text();
		expect(artifact).toContain("- manifest-entry.json");
		expect(artifact).toContain("- monitor-assignment.json");
	});

	it("treats recursive glob allowed paths as review context scope fences", async () => {
		const cwd = await createGitRepo();
		const taskText = [
			"Objective:",
			"Migrate HTTPX keylog tests away from root workspace byproducts.",
			"",
			"Compatibility Command:",
			"python -m py_compile tests/test_config.py",
			"",
			"Validation Command:",
			"python -c \"print('ok')\"",
			"",
			"Allowed paths: httpx/**, tests/**, docs/**, workflow-output/**, task.md, manifest-entry.json, monitor-assignment.json.",
			"",
		].join("\n");
		await fs.mkdir(path.join(cwd, "tests"), { recursive: true });
		await Bun.write(path.join(cwd, "task.md"), taskText);
		await Bun.write(path.join(cwd, "tests", "test_config.py"), "def test_keylog():\n    assert True\n");
		await runCommand(["git", "add", "task.md", "tests/test_config.py"], cwd);
		await runCommand(["git", "commit", "-m", "init"], cwd);
		await Bun.write(path.join(cwd, "tests", "test_config.py"), "def test_keylog(tmp_path):\n    assert tmp_path\n");

		const result = await runScript(cwd, {
			task: { text: taskText },
			compatibility: {
				behavior: "Preserve SSL keylog behavior while keeping test byproducts in tmp_path.",
			},
		});
		const reviewContext = result.statePatch?.find(patch => patch.path === "/reviewContext")?.value;

		expect(reviewContext?.workspace?.status).toBe("pass");
		expect(reviewContext?.workspace?.blockers).toEqual([]);
		expect(reviewContext?.workspace?.allowedScopes).toContain("tests/**");
		const artifact = await Bun.file(path.join(cwd, "workflow-output", "refactor-migration-review-context.md")).text();
		expect(artifact).toContain("- tests/**");
		expect(artifact).toContain("-  M tests/test_config.py");
		expect(artifact).not.toContain("tests/test_config.py changed outside task allowed paths");
	});
});

async function runScript(cwd: string, state: WorkflowContext["state"]): Promise<ReviewContextResult> {
	return (await runScriptFile(cwd, "prepare-review-context.js", state)) as ReviewContextResult;
}

async function runScriptFile(
	cwd: string,
	scriptFileName: string,
	state: WorkflowContext["state"],
): Promise<ScriptResult> {
	const scriptPath = path.resolve(
		import.meta.dir,
		"../../examples/workflow/experimental/refactor-migration-plan/refactor-migration-plan/scripts",
		scriptFileName,
	);
	const script = await Bun.file(scriptPath).text();
	const execute = new ScriptFunctionConstructor("workflowContext", script);
	const originalCwd = process.cwd();
	try {
		process.chdir(cwd);
		return await execute({
			activation: { id: "activation-prepareMigrationReviewContext" },
			completedActivations: [],
			state,
		});
	} finally {
		process.chdir(originalCwd);
	}
}

async function createGitRepo(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omh-refactor-migration-"));
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

async function gitStatus(cwd: string): Promise<string> {
	const proc = Bun.spawn(["git", "status", "--short", "--untracked-files=all"], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (exitCode !== 0) throw new Error(`git status failed: ${stderr || stdout}`);
	return stdout.trim();
}
