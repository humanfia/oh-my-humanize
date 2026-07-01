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
		gaps?: object;
		review?: string;
		suite?: {
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

describe("test-generation-hardening flow contract", () => {
	it("treats a startable failing validation probe as gap evidence instead of a blocker", async () => {
		const cwd = await createTempDir();
		const result = await runMaterializeGapReport(cwd, {
			gaps: {
				status: "ready",
				summary: "Regression anchor is missing before test generation.",
				validation: {
					command: "python -c 'raise SystemExit(1)'",
					startable: true,
					status: "ran",
					exitCode: 1,
					stderr: "",
				},
				regressionRisks: ["missing regression anchor"],
				smallestUsefulTestAdditions: ["add focused regression assertion"],
				filesLikelyToNeedTestChanges: ["test/res.json.js"],
			},
		});

		const report = await Bun.file(path.join(cwd, "workflow-output", "test-hardening-gap-report.md")).text();
		const gapsPatch = result.statePatch?.find(patch => patch.path === "/gaps")?.value;

		expect(result.summary).toContain("materialized coverage gap report");
		expect(report).toContain("Regression anchor is missing before test generation.");
		expect(report).toContain("- Exit code: 1");
		expect(gapsPatch).toMatchObject({
			gapReportPath: "workflow-output/test-hardening-gap-report.md",
		});
	});

	it("fails closed when the validation probe could not be started", async () => {
		const cwd = await createTempDir();

		await expect(
			runMaterializeGapReport(cwd, {
				gaps: {
					status: "ready",
					summary: "Validation harness was unavailable.",
					validation: {
						command: "npm test",
						startable: false,
						status: "blocked",
					},
				},
			}),
		).rejects.toThrow("coverage inspection blocked");
	});

	it("archives the reviewer decision with validation evidence", async () => {
		const cwd = await createTempDir();
		await initGitRepo(cwd);
		await Bun.write(
			path.join(cwd, "task.md"),
			["Objective:", "Add focused test coverage.", "", "Validation Command:", "python -m pytest tests -q"].join(
				"\n",
			),
		);
		await fs.mkdir(path.join(cwd, "tests"), { recursive: true });
		await Bun.write(path.join(cwd, "tests", "test_parser.py"), "def test_parser_edge():\n\tassert True\n");
		await git(cwd, ["add", "task.md"]);
		await git(cwd, ["commit", "-m", "baseline"]);
		await Bun.write(
			path.join(cwd, "workflow-output", "test-suite.md"),
			["# Test Suite Evidence", "", "Command: python -m pytest tests -q", "Exit code: 0"].join("\n"),
		);
		await Bun.write(
			path.join(cwd, "workflow-output", "test-hardening-repair-evidence.md"),
			"# Repair Evidence\n\nAdded parser edge coverage.\n",
		);
		await Bun.write(
			path.join(cwd, "workflow-output", "test-hardening-rollback.md"),
			"# Rollback\n\nRevert tests/test_parser.py.\n",
		);

		const result = await runArchiveTests(cwd, {
			suite: { status: "pass" },
			review: "finish",
		});
		const archive = await Bun.file(path.join(cwd, "workflow-output", "test-hardening-archive.md")).text();

		expect(result.summary).toContain("archived test hardening evidence");
		expect(archive).toContain("## Reviewer Decision");
		expect(archive).toContain("State verdict: finish");
		expect(archive).toContain("Activation summary:");
		expect(archive).toContain("verdict finish");
		expect(archive).toContain("## Suite Evidence");
	});

	it("archives reviewer artifact evidence when the activation summary is absent", async () => {
		const cwd = await createTempDir();
		await initGitRepo(cwd);
		await Bun.write(
			path.join(cwd, "task.md"),
			["Objective:", "Add focused test coverage.", "", "Validation Command:", "python -m pytest tests -q"].join(
				"\n",
			),
		);
		await fs.mkdir(path.join(cwd, "tests"), { recursive: true });
		await Bun.write(path.join(cwd, "tests", "test_parser.py"), "def test_parser_edge():\n\tassert True\n");
		await git(cwd, ["add", "task.md"]);
		await git(cwd, ["commit", "-m", "baseline"]);
		await Bun.write(
			path.join(cwd, "workflow-output", "test-suite.md"),
			["# Test Suite Evidence", "", "Command: python -m pytest tests -q", "Exit code: 0"].join("\n"),
		);
		await Bun.write(path.join(cwd, "workflow-output", "test-hardening-repair-evidence.md"), "# Repair Evidence\n");
		await Bun.write(path.join(cwd, "workflow-output", "test-hardening-rollback.md"), "# Rollback\n");
		await Bun.write(
			path.join(cwd, "workflow-output", "omh-runtime", "artifacts", "activation-12", "1-testReview-3.md"),
			[
				"{",
				'  "overall_correctness": "correct",',
				'  "explanation": "verdict finish\\nGenerated tests are task-scoped and pass validation.",',
				'  "confidence": 0.9,',
				'  "findings": []',
				"}",
			].join("\n"),
		);

		const result = await runArchiveTestsWithActivations(
			cwd,
			{
				suite: { status: "pass" },
				review: "finish",
			},
			[
				{ nodeId: "inspectCoverage", status: "completed", summary: "coverage inspected" },
				{ nodeId: "materializeGapReport", status: "completed", summary: "gap report materialized" },
				{ nodeId: "generateTests", status: "completed", summary: "tests generated" },
				{ nodeId: "runTestSuite", status: "completed", summary: "validation passed" },
				{ id: "activation-12", nodeId: "testReview", status: "completed" },
			],
		);
		const archive = await Bun.file(path.join(cwd, "workflow-output", "test-hardening-archive.md")).text();

		expect(result.summary).toContain("archived test hardening evidence");
		expect(archive).toContain("Activation: activation-12");
		expect(archive).toContain("Generated tests are task-scoped and pass validation.");
		expect(archive).not.toContain("(missing)");
	});
});

async function runMaterializeGapReport(cwd: string, state: WorkflowContext["state"]): Promise<ScriptResult> {
	return await runScript(cwd, "materialize-gap-report.js", state, []);
}

async function runArchiveTests(cwd: string, state: WorkflowContext["state"]): Promise<ScriptResult> {
	return await runArchiveTestsWithActivations(cwd, state, [
		{ nodeId: "inspectCoverage", status: "completed", summary: "coverage inspected" },
		{ nodeId: "materializeGapReport", status: "completed", summary: "gap report materialized" },
		{ nodeId: "generateTests", status: "completed", summary: "tests generated" },
		{ nodeId: "runTestSuite", status: "completed", summary: "validation passed" },
		{ nodeId: "testReview", status: "completed", summary: "verdict finish\nGenerated tests cover the task." },
	]);
}

async function runArchiveTestsWithActivations(
	cwd: string,
	state: WorkflowContext["state"],
	completedActivations: unknown[],
): Promise<ScriptResult> {
	return await runScript(cwd, "archive-tests.js", state, completedActivations);
}

async function runScript(
	cwd: string,
	scriptName: string,
	state: WorkflowContext["state"],
	completedActivations: unknown[],
): Promise<ScriptResult> {
	const scriptPath = path.resolve(
		import.meta.dir,
		`../../examples/workflow/experimental/test-generation-hardening/test-generation-hardening/scripts/${scriptName}`,
	);
	const script = await Bun.file(scriptPath).text();
	const execute = new ScriptFunctionConstructor("workflowContext", script);
	const originalCwd = process.cwd();
	try {
		process.chdir(cwd);
		return await execute({
			activation: { id: `activation-${scriptName}` },
			completedActivations,
			state,
		});
	} finally {
		process.chdir(originalCwd);
	}
}

async function createTempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omh-test-generation-hardening-"));
	tempDirs.push(dir);
	return dir;
}

async function initGitRepo(cwd: string): Promise<void> {
	await git(cwd, ["init"]);
	await git(cwd, ["config", "user.email", "omh@example.invalid"]);
	await git(cwd, ["config", "user.name", "OMH Test"]);
	await git(cwd, ["config", "commit.gpgsign", "false"]);
}

async function git(cwd: string, args: string[]): Promise<void> {
	const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${stderr.trim() || stdout.trim()}`);
	}
}
