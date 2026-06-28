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

const ScriptFunctionConstructor = Object.getPrototypeOf(async () => {}).constructor as new (
	workflowContextName: string,
	code: string,
) => (workflowContext: WorkflowContext) => Promise<ReviewContextResult>;

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("refactor-migration-plan flow contract", () => {
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
});

async function runScript(cwd: string, state: WorkflowContext["state"]): Promise<ReviewContextResult> {
	const scriptPath = path.resolve(
		import.meta.dir,
		"../../examples/workflow/experimental/refactor-migration-plan/refactor-migration-plan/scripts/prepare-review-context.js",
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
