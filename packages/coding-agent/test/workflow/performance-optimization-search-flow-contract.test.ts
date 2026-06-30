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
		task?: {
			text?: string;
			benchmarkCommand?: string;
			validationCommand?: string;
		};
		runtime?: {
			sharedProjectFilesBeforeBranches?: string[];
		};
		benchmark?: {
			status?: string;
			benchmarkExitCode?: number;
			validationExitCode?: number;
			isolationViolation?: boolean;
		};
		selectionRepair?: {
			benchmark?: {
				status?: string;
				exitCode?: number;
			};
			validation?: {
				status?: string;
				exitCode?: number;
			};
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
			terminalState?: string;
			selectedBranches?: string[];
			noWinBranches?: string[];
			positiveUnselectedBranches?: string[];
			benchmarkRelevanceBlockers?: string[];
			evidenceViolation?: boolean;
			missingDeclaredArtifacts?: string[];
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

describe("performance-optimization-search flow contract", () => {
	it("fails closed when a branch report advertises missing durable artifacts", async () => {
		const cwd = await createGitRepo();
		await fs.mkdir(path.join(cwd, "workflow-output"), { recursive: true });
		await Bun.write(path.join(cwd, "README.md"), "perf fixture\n");
		await runCommand(["git", "add", "README.md"], cwd);
		await runCommand(["git", "commit", "-m", "init"], cwd);
		await Bun.write(
			path.join(cwd, "workflow-output/perf-caching.md"),
			[
				"# Caching branch",
				"candidate patch path: workflow-output/perf-caching-candidate.diff",
				"benchmark log: workflow-output/perf-caching-benchmark.log",
				"validation log: workflow-output/perf-caching-validation.log",
				"final-selection: no",
				"",
			].join("\n"),
		);

		const result = await runScriptFile(cwd, "run-benchmark-validation.js", {
			task: {
				benchmarkCommand: "python -c \"print('benchmark')\"",
				validationCommand: "python -c \"print('validation')\"",
			},
			runtime: { sharedProjectFilesBeforeBranches: [] },
		});
		const benchmark = result.statePatch?.find(patch => patch.path === "/benchmark")?.value;

		expect(result.summary).toBe("branch evidence materialization violation: 3 missing durable artifact(s)");
		expect(benchmark).toMatchObject({
			status: "fail",
			evidenceViolation: true,
			missingDeclaredArtifacts: [
				"workflow-output/perf-caching-benchmark.log",
				"workflow-output/perf-caching-candidate.diff",
				"workflow-output/perf-caching-validation.log",
			],
		});
	});

	it("accepts a positive retained branch when an unselected branch records no-win evidence", async () => {
		const cwd = await createGitRepo();
		await fs.mkdir(path.join(cwd, "src/click"), { recursive: true });
		await fs.mkdir(path.join(cwd, "workflow-output"), { recursive: true });
		await Bun.write(path.join(cwd, "src/click/core.py"), "def parse():\n    return 'old core'\n");
		await Bun.write(path.join(cwd, "src/click/parser.py"), "def parser():\n    return 'old parser'\n");
		await runCommand(["git", "add", "src/click/core.py", "src/click/parser.py"], cwd);
		await runCommand(["git", "commit", "-m", "init"], cwd);
		await Bun.write(path.join(cwd, "src/click/core.py"), "def parse():\n    return 'faster core'\n");
		await Bun.write(path.join(cwd, "src/click/parser.py"), "def parser():\n    return 'faster parser'\n");
		await Bun.write(
			path.join(cwd, "workflow-output/perf-algorithmic.md"),
			[
				"# Algorithmic branch",
				"final-selection: yes",
				"benchmark-relevance: yes",
				"benchmark improvement: selected candidate is faster on the task-declared benchmark.",
				"rollback evidence: git apply -R workflow-output/perf-algorithmic-candidate.diff",
				"",
			].join("\n"),
		);
		await Bun.write(
			path.join(cwd, "workflow-output/perf-caching.md"),
			[
				"# Caching branch",
				"final-selection: no",
				"benchmark-relevance: yes",
				"positive benchmark improvement: yes",
				"benchmark-covered rejection: yes",
				"rejected because the selected algorithmic candidate is faster.",
				"rollback evidence: no caching code was applied.",
				"",
			].join("\n"),
		);
		await Bun.write(
			path.join(cwd, "workflow-output/perf-io.md"),
			[
				"# IO branch",
				"final-selection: no",
				"no-win-result: yes",
				"no stable positive result after IO experiments.",
				"rollback evidence: the IO branch reverted its experiments and retained no code.",
				"",
			].join("\n"),
		);
		await Bun.write(
			path.join(cwd, "workflow-output/performance-selection-repair.md"),
			[
				"# Performance Selection Repair",
				"semantic-probe: yes",
				"benchmark command exit code 0",
				"validation command exit code 0",
				"selected branch: algorithmic",
				"",
			].join("\n"),
		);

		const result = await runScriptFile(cwd, "finalize-performance-selection.js", {
			review: "verdict: finish",
			task: { text: "No-Win Result: allowed" },
			benchmark: { status: "pass", benchmarkExitCode: 0, validationExitCode: 0 },
			selectionRepair: {
				benchmark: { status: "pass", exitCode: 0 },
				validation: { status: "pass", exitCode: 0 },
			},
		});
		const selection = result.statePatch?.find(patch => patch.path === "/selection")?.value;

		expect(result.summary).toBe("finalized performance selection: positive");
		expect(selection).toMatchObject({
			status: "pass",
			terminalState: "positive",
			selectedBranches: ["algorithmic"],
			noWinBranches: ["io"],
		});
	});

	it("accepts a benchmark-relevant no-win branch without retained positive evidence", async () => {
		const cwd = await createGitRepo();
		await fs.mkdir(path.join(cwd, "src/click"), { recursive: true });
		await fs.mkdir(path.join(cwd, "workflow-output"), { recursive: true });
		await Bun.write(path.join(cwd, "src/click/decorators.py"), "def help_option():\n    return 'old'\n");
		await runCommand(["git", "add", "src/click/decorators.py"], cwd);
		await runCommand(["git", "commit", "-m", "init"], cwd);
		await Bun.write(path.join(cwd, "src/click/decorators.py"), "def help_option():\n    return 'cached'\n");
		await Bun.write(
			path.join(cwd, "workflow-output/perf-caching.md"),
			[
				"# Performance caching Branch",
				"final-selection: yes",
				"benchmark-relevance: yes",
				"benchmark improvement: selected candidate measured 114 usec against the 158 usec baseline.",
				"rollback evidence: git apply -R workflow-output/perf-caching-candidate.diff",
				"",
			].join("\n"),
		);
		await Bun.write(
			path.join(cwd, "workflow-output/perf-io.md"),
			[
				"# Performance io Branch",
				"",
				"## Structured Branch State",
				"",
				"```json",
				JSON.stringify(
					{
						status: "no-win",
						strategy: "io",
						editedFiles: [],
						retainedFiles: [],
						candidatePatchPath: null,
						benchmarkRelevance: "yes",
						finalSelection: "no",
						noWinResult: "yes",
						measurements: [
							{
								candidate: "lazy mixed-output buffer",
								result: "200 loops, best of 3: 163 usec per loop",
								decision: "reverted; slower than 158 usec baseline",
							},
							{
								candidate: "no-input helper reorder",
								result: "200 loops, best of 3: 158 usec per loop",
								decision: "reverted; no improvement over 158 usec baseline",
							},
						],
					},
					null,
					2,
				),
				"```",
				"",
				"final-selection: no",
				"no-win-result: yes",
				"benchmark-relevance: yes",
				"benchmark relevance evidence: the measured I/O candidates were evaluated under the task-declared benchmark path, but none improved over the recorded 158 usec baseline.",
				"rollback evidence: no I/O candidate patch exists, no I/O project-code changes are retained.",
				"",
			].join("\n"),
		);
		await Bun.write(
			path.join(cwd, "workflow-output/performance-selection-repair.md"),
			[
				"# Performance Selection Repair",
				"",
				"- Selected branch: caching.",
				"- io: not applied. No candidate patch exists, both measured I/O candidates were reverted by the branch, and the report remains marked `final-selection: no` and `no-win-result: yes`.",
				"",
				"benchmark command exited 0",
				"validation command exited 0",
				"",
				"Selected caching branch:",
				"benchmark-relevance: yes",
				"The retained caching candidate is on the task benchmark path.",
				"",
				"Unselected I/O branch:",
				"The I/O branch did not report a positive benchmark-like retained result. Its measured candidates were `163 usec` and `158 usec` against the `158 usec` baseline, so no off-benchmark marker is needed.",
				"",
			].join("\n"),
		);

		const result = await runScriptFile(cwd, "guard-selection-repair.js", {
			benchmark: { status: "pass", benchmarkExitCode: 0, validationExitCode: 0 },
			selectionRepair: {
				benchmark: { status: "pass", exitCode: 0 },
				validation: { status: "pass", exitCode: 0 },
			},
		});
		const guard = result.statePatch?.find(patch => patch.path === "/selectionGuard")?.value;

		expect(result.summary).toBe("performance selection repair guard passed");
		expect(guard).toMatchObject({
			status: "pass",
			selectedBranches: ["caching"],
			noWinBranches: ["io"],
			positiveUnselectedBranches: [],
			benchmarkRelevanceBlockers: [],
		});
	});
});

async function runScriptFile(
	cwd: string,
	scriptFileName: string,
	state: WorkflowContext["state"],
): Promise<ScriptResult> {
	const scriptPath = path.resolve(
		import.meta.dir,
		"../../examples/workflow/experimental/performance-optimization-search/performance-optimization-search/scripts",
		scriptFileName,
	);
	const script = await Bun.file(scriptPath).text();
	const execute = new ScriptFunctionConstructor("workflowContext", script);
	const originalCwd = process.cwd();
	try {
		process.chdir(cwd);
		return await execute({
			activation: { id: "activation-finalizePerformanceSelection" },
			completedActivations: [],
			state,
		});
	} finally {
		process.chdir(originalCwd);
	}
}

async function createGitRepo(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omh-performance-search-"));
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
