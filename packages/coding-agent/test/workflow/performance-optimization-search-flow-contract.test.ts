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
			baselineCommand?: string;
			validationCommand?: string;
			allowedProjectPaths?: string[];
			benchmarkTargetPaths?: string[];
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
		selection?: {
			status?: string;
			terminalState?: string;
			selectedBranches?: string[];
			noWinBranches?: string[];
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
			allowedProjectPaths?: string[];
			benchmarkTargetPaths?: string[];
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
	it("fails closed when benchmark target paths are outside the allowed project paths", async () => {
		const cwd = await createGitRepo();
		await fs.mkdir(path.join(cwd, "workflow-output"), { recursive: true });
		await Bun.write(
			path.join(cwd, "task.md"),
			[
				"# Performance task",
				"",
				"Benchmark Command: python -c \"print('split_arg_string 20000 loops 0.485742s')\"",
				"Baseline Command: python -c \"print('split_arg_string 20000 loops 0.485742s')\"",
				"Validation Command: python -c \"print('validation')\"",
				`Scratch Directory: ${path.join(cwd, "scratch")}`,
				"Allowed paths: src/click/parser.py, tests/test_parser.py, workflow-output/**, task.md",
				"Benchmark Target Paths: src/click/shell_completion.py",
				"",
			].join("\n"),
		);

		await expect(runScriptFile(cwd, "precheck-task-contract.js", {})).rejects.toThrow(
			/benchmark target paths are outside allowed project paths.*src\/click\/shell_completion\.py/iu,
		);

		const evidence = await Bun.file(path.join(cwd, "workflow-output/performance-precheck.md")).text();
		expect(evidence).toContain("## Allowed Project Paths");
		expect(evidence).toContain("src/click/parser.py");
		expect(evidence).toContain("## Benchmark Target Paths");
		expect(evidence).toContain("src/click/shell_completion.py");
		expect(evidence).toContain("Benchmark Target Path Violation");
	});

	it("materializes benchmark target paths when the allowed project paths cover them", async () => {
		const cwd = await createGitRepo();
		await fs.mkdir(path.join(cwd, "workflow-output"), { recursive: true });
		await Bun.write(
			path.join(cwd, "task.md"),
			[
				"# Performance task",
				"",
				"Benchmark Command: python -c \"print('split_arg_string 20000 loops 0.485742s')\"",
				"Baseline Command: python -c \"print('split_arg_string 20000 loops 0.485742s')\"",
				"Validation Command: python -c \"print('validation')\"",
				`Scratch Directory: ${path.join(cwd, "scratch")}`,
				"Allowed paths:",
				"- src/click/shell_completion.py",
				"- tests/test_parser.py",
				"- workflow-output/**",
				"- task.md",
				"Benchmark Target Paths:",
				"- src/click/shell_completion.py",
				"",
			].join("\n"),
		);

		const result = await runScriptFile(cwd, "precheck-task-contract.js", {});
		const task = result.statePatch?.find(patch => patch.path === "/task")?.value;

		expect(result.summary).toBe("validated performance optimization task contract");
		expect(task).toMatchObject({
			allowedProjectPaths: ["src/click/shell_completion.py", "tests/test_parser.py"],
			benchmarkTargetPaths: ["src/click/shell_completion.py"],
		});
		const evidence = await Bun.file(path.join(cwd, "workflow-output/performance-precheck.md")).text();
		expect(evidence).toContain("## Benchmark Target Paths");
		expect(evidence).not.toContain("Benchmark Target Path Violation");
	});

	it("requires benchmark target paths when task allowed paths restrict project files", async () => {
		const cwd = await createGitRepo();
		await fs.mkdir(path.join(cwd, "workflow-output"), { recursive: true });
		await Bun.write(
			path.join(cwd, "task.md"),
			[
				"# Performance task",
				"",
				"Benchmark Command: python -c \"print('split_arg_string 20000 loops 0.485742s')\"",
				"Baseline Command: python -c \"print('split_arg_string 20000 loops 0.485742s')\"",
				"Validation Command: python -c \"print('validation')\"",
				`Scratch Directory: ${path.join(cwd, "scratch")}`,
				"Allowed paths: src/click/parser.py, tests/test_parser.py, workflow-output/**, task.md",
				"",
			].join("\n"),
		);

		await expect(runScriptFile(cwd, "precheck-task-contract.js", {})).rejects.toThrow(
			/must declare Benchmark Target Paths when Allowed paths restrict project files/iu,
		);
	});

	it("fails closed when a baseline command is a truncated here document", async () => {
		const cwd = await createGitRepo();
		await fs.mkdir(path.join(cwd, "workflow-output"), { recursive: true });

		await expect(
			runScriptFile(cwd, "capture-baseline.js", {
				task: {
					baselineCommand: "python - <<'PY'",
					benchmarkCommand: "python - <<'PY'",
					validationCommand: "python -c \"print('validation')\"",
				},
			}),
		).rejects.toThrow(/fatal diagnostic.*here-document/iu);

		const evidence = await Bun.file(path.join(cwd, "workflow-output/performance-baseline.md")).text();
		expect(evidence).toContain("here-document");
		expect(evidence).toContain("Fatal Command Diagnostic");
	});

	it("fails closed when a baseline command exits without observable benchmark output", async () => {
		const cwd = await createGitRepo();
		await fs.mkdir(path.join(cwd, "workflow-output"), { recursive: true });

		await expect(
			runScriptFile(cwd, "capture-baseline.js", {
				task: {
					baselineCommand: 'python -c ""',
					benchmarkCommand: 'python -c ""',
					validationCommand: "python -c \"print('validation')\"",
				},
			}),
		).rejects.toThrow(/benchmark command produced no output/iu);

		const evidence = await Bun.file(path.join(cwd, "workflow-output/performance-baseline.md")).text();
		expect(evidence).toContain("benchmark command produced no output");
		expect(evidence).toContain("Fatal Command Diagnostic");
	});

	it("fails closed when a baseline command only emits numeric warning text", async () => {
		const cwd = await createGitRepo();
		await fs.mkdir(path.join(cwd, "workflow-output"), { recursive: true });

		await expect(
			runScriptFile(cwd, "capture-baseline.js", {
				task: {
					baselineCommand: "python -c \"import sys; print('DeprecationWarning: Click 9.0', file=sys.stderr)\"",
					benchmarkCommand: "python -c \"import sys; print('DeprecationWarning: Click 9.0', file=sys.stderr)\"",
					validationCommand: "python -c \"print('validation')\"",
				},
			}),
		).rejects.toThrow(/benchmark command produced no benchmark measurement evidence/iu);

		const evidence = await Bun.file(path.join(cwd, "workflow-output/performance-baseline.md")).text();
		expect(evidence).toContain("benchmark command produced no benchmark measurement evidence");
		expect(evidence).toContain("Fatal Command Diagnostic");
	});

	it("fails closed when benchmark validation exits without observable benchmark output", async () => {
		const cwd = await createGitRepo();
		await fs.mkdir(path.join(cwd, "workflow-output"), { recursive: true });

		const result = await runScriptFile(cwd, "run-benchmark-validation.js", {
			task: {
				benchmarkCommand: 'python -c ""',
				validationCommand: "python -c \"print('validation')\"",
			},
			runtime: { sharedProjectFilesBeforeBranches: [] },
		});
		const benchmark = result.statePatch?.find(patch => patch.path === "/benchmark")?.value;

		expect(result.summary).toBe("benchmark=fail validation=pass");
		expect(benchmark).toMatchObject({
			status: "fail",
			benchmarkFailureDiagnostic: "benchmark command produced no output",
		});
		const evidence = await Bun.file(path.join(cwd, "workflow-output/performance-benchmark.md")).text();
		expect(evidence).toContain("benchmark command produced no output");
		expect(evidence).toContain("Benchmark Fatal Command Diagnostic");
	});

	it("fails closed when benchmark validation output has no measurement", async () => {
		const cwd = await createGitRepo();
		await fs.mkdir(path.join(cwd, "workflow-output"), { recursive: true });

		const result = await runScriptFile(cwd, "run-benchmark-validation.js", {
			task: {
				benchmarkCommand: "python -c \"print('benchmark complete')\"",
				validationCommand: "python -c \"print('validation')\"",
			},
			runtime: { sharedProjectFilesBeforeBranches: [] },
		});
		const benchmark = result.statePatch?.find(patch => patch.path === "/benchmark")?.value;

		expect(result.summary).toBe("benchmark=fail validation=pass");
		expect(benchmark).toMatchObject({
			status: "fail",
			benchmarkFailureDiagnostic: "benchmark command produced no benchmark measurement evidence",
		});
		const evidence = await Bun.file(path.join(cwd, "workflow-output/performance-benchmark.md")).text();
		expect(evidence).toContain("benchmark command produced no benchmark measurement evidence");
		expect(evidence).toContain("Benchmark Fatal Command Diagnostic");
	});

	it("fails closed when benchmark validation only emits numeric warning text", async () => {
		const cwd = await createGitRepo();
		await fs.mkdir(path.join(cwd, "workflow-output"), { recursive: true });

		const result = await runScriptFile(cwd, "run-benchmark-validation.js", {
			task: {
				benchmarkCommand: "python -c \"import sys; print('DeprecationWarning: Click 9.0', file=sys.stderr)\"",
				validationCommand: "python -c \"print('validation')\"",
			},
			runtime: { sharedProjectFilesBeforeBranches: [] },
		});
		const benchmark = result.statePatch?.find(patch => patch.path === "/benchmark")?.value;

		expect(result.summary).toBe("benchmark=fail validation=pass");
		expect(benchmark).toMatchObject({
			status: "fail",
			benchmarkFailureDiagnostic: "benchmark command produced no benchmark measurement evidence",
		});
		const evidence = await Bun.file(path.join(cwd, "workflow-output/performance-benchmark.md")).text();
		expect(evidence).toContain("benchmark command produced no benchmark measurement evidence");
		expect(evidence).toContain("Benchmark Fatal Command Diagnostic");
	});

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
				"semantic-probe: yes",
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
						status: "no_win",
						strategy: "io",
						editedFiles: [],
						retainedFiles: [],
						retainedSourceChanges: [],
						candidatePatchPath: "workflow-output/perf-io-candidate.diff",
						candidatePatchRetained: false,
						benchmarkRelevance: "yes",
						finalSelection: false,
						noWinResult: true,
						measurements: {
							cleanOriginalUsec: [155, 160, 156, 159],
							cleanCandidateUsec: [160, 160, 157, 155],
							finalRevertedUsec: 159,
						},
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
				"rollback evidence: workflow-output/perf-io-candidate.diff is archived only as rejected evidence; no I/O source changes were retained in the shared workspace.",
				"",
			].join("\n"),
		);
		await Bun.write(
			path.join(cwd, "workflow-output/performance-selection-repair.md"),
			[
				"# Performance Selection Repair",
				"",
				"- Selected branch: caching.",
				"- io: not applied. Its candidate patch is archived only as rejected evidence, both measured I/O candidates were reverted by the branch, and the report remains marked `final-selection: no` and `no-win-result: yes`.",
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

		const finalize = await runScriptFile(cwd, "finalize-performance-selection.js", {
			review: "verdict: finish",
			task: { text: "No-Win Result: allowed" },
			benchmark: { status: "pass", benchmarkExitCode: 0, validationExitCode: 0 },
			selectionRepair: {
				benchmark: { status: "pass", exitCode: 0 },
				validation: { status: "pass", exitCode: 0 },
			},
		});
		const selection = finalize.statePatch?.find(patch => patch.path === "/selection")?.value;

		expect(finalize.summary).toBe("finalized performance selection: positive");
		expect(selection).toMatchObject({
			status: "pass",
			terminalState: "positive",
			selectedBranches: ["caching"],
			noWinBranches: ["io"],
			positiveUnselectedBranches: [],
		});
	});

	it("requires retained selections to address previous continue review feedback", async () => {
		const cwd = await createGitRepo();
		await fs.mkdir(path.join(cwd, "src/click"), { recursive: true });
		await fs.mkdir(path.join(cwd, "workflow-output"), { recursive: true });
		await Bun.write(path.join(cwd, "src/click/core.py"), "def core():\n    return 'old'\n");
		await runCommand(["git", "add", "src/click/core.py"], cwd);
		await runCommand(["git", "commit", "-m", "init"], cwd);
		await Bun.write(path.join(cwd, "src/click/core.py"), "def core():\n    return 'faster'\n");
		await Bun.write(
			path.join(cwd, "workflow-output/perf-caching.md"),
			[
				"# Caching branch",
				"final-selection: yes",
				"no-win-result: no",
				"benchmark-relevance: yes",
				"semantic-probe: yes",
				"semantic probe evidence: normal parse and help output still work.",
				"rollback evidence: git apply -R workflow-output/perf-caching-candidate.diff",
				"",
			].join("\n"),
		);
		await Bun.write(
			path.join(cwd, "workflow-output/performance-selection-repair.md"),
			[
				"# Performance Selection Repair",
				"",
				"selected branch: caching",
				"benchmark command exited 0",
				"validation command exited 0",
				"benchmark-relevance: yes",
				"semantic-probe: yes",
				"semantic probe evidence: normal parse and help output still work.",
				"",
			].join("\n"),
		);

		const state = {
			review:
				"overall_correctness: incorrect\nverdict: continue\nCustom generated help option prefixes must still drive shell completion.",
			benchmark: { status: "pass", benchmarkExitCode: 0, validationExitCode: 0 },
			selectionRepair: {
				benchmark: { status: "pass", exitCode: 0 },
				validation: { status: "pass", exitCode: 0 },
			},
		};

		await expect(runScriptFile(cwd, "guard-selection-repair.js", state)).rejects.toThrow(
			"selected candidate does not record resolution for previous continue review feedback",
		);

		await Bun.write(
			path.join(cwd, "workflow-output/performance-selection-repair.md"),
			[
				"# Performance Selection Repair",
				"",
				"selected branch: caching",
				"benchmark command exited 0",
				"validation command exited 0",
				"benchmark-relevance: yes",
				"semantic-probe: yes",
				"semantic probe evidence: normal parse and help output still work.",
				"review-feedback-addressed: yes",
				"review feedback evidence: custom generated help option prefixes still populate shell completion prefix detection.",
				"",
			].join("\n"),
		);

		const result = await runScriptFile(cwd, "guard-selection-repair.js", state);
		const guard = result.statePatch?.find(patch => patch.path === "/selectionGuard")?.value;

		expect(result.summary).toBe("performance selection repair guard passed");
		expect(guard).toMatchObject({
			status: "pass",
			selectedBranches: ["caching"],
			positiveUnselectedBranches: [],
			benchmarkRelevanceBlockers: [],
		});
	});

	it("finalizes a natural-language authorized no-win search without ghost branches", async () => {
		const cwd = await createGitRepo();
		await fs.mkdir(path.join(cwd, "src/click"), { recursive: true });
		await fs.mkdir(path.join(cwd, "workflow-output"), { recursive: true });
		await Bun.write(path.join(cwd, "src/click/core.py"), "def core():\n    return 'unchanged'\n");
		await runCommand(["git", "add", "src/click/core.py"], cwd);
		await runCommand(["git", "commit", "-m", "init"], cwd);
		await writeNoWinBranchReport(
			cwd,
			"algorithmic",
			"parser dispatch candidate reverted; no improvement over baseline",
		);
		await writeNoWinBranchReport(cwd, "caching", "cache candidate reverted; no repeatable improvement");
		await writeNoWinBranchReport(cwd, "io", "io candidate reverted; slower than clean repeated evidence");
		await Bun.write(
			path.join(cwd, "workflow-output/performance-selection-repair.md"),
			[
				"# Performance Selection Repair",
				"",
				"- selected branch: none",
				"- no-win branch: algorithmic, caching, and io are all retained as benchmark-relevant no-win branch findings.",
				"",
				"benchmark command exited 0",
				"validation command exited 0",
				"Negative branch findings are acceptable when archived with durable evidence and rollback reasoning.",
				"",
			].join("\n"),
		);

		const result = await runScriptFile(cwd, "finalize-performance-selection.js", {
			review: "verdict: finish",
			task: {
				text: "Negative branch findings are acceptable when archived with durable evidence and rollback reasoning.",
			},
			benchmark: { status: "pass", benchmarkExitCode: 0, validationExitCode: 0 },
			selectionRepair: {
				benchmark: { status: "pass", exitCode: 0 },
				validation: { status: "pass", exitCode: 0 },
			},
		});
		const selection = result.statePatch?.find(patch => patch.path === "/selection")?.value;

		expect(result.summary).toBe("finalized performance selection: no-win");
		expect(selection).toMatchObject({
			status: "pass",
			terminalState: "no-win",
			selectedBranches: [],
			noWinBranches: ["algorithmic", "caching", "io"],
		});
		expect(selection?.positiveUnselectedBranches).not.toContain("no-win");
	});

	it("archives a natural-language authorized no-win search without project changes", async () => {
		const cwd = await createGitRepo();
		await fs.mkdir(path.join(cwd, "src/click"), { recursive: true });
		await fs.mkdir(path.join(cwd, "workflow-output"), { recursive: true });
		await Bun.write(path.join(cwd, "src/click/core.py"), "def core():\n    return 'unchanged'\n");
		await runCommand(["git", "add", "src/click/core.py"], cwd);
		await runCommand(["git", "commit", "-m", "init"], cwd);
		await writeNoWinBranchReport(cwd, "algorithmic", "parser dispatch candidate reverted; no improvement");
		await writeNoWinBranchReport(cwd, "caching", "cache candidate reverted; no repeatable improvement");
		await writeNoWinBranchReport(cwd, "io", "io candidate reverted; slower than clean repeated evidence");
		await Bun.write(path.join(cwd, "workflow-output/performance-baseline.md"), "# Baseline\n\nexit code 0\n");
		await Bun.write(
			path.join(cwd, "workflow-output/performance-selection-repair.md"),
			[
				"# Performance Selection Repair",
				"",
				"benchmark command exited 0",
				"validation command exited 0",
				"Negative branch findings are acceptable when archived with durable evidence and rollback reasoning.",
				"",
			].join("\n"),
		);

		const result = await runScriptFile(cwd, "archive-performance.js", {
			review: "verdict: finish",
			task: {
				text: "Negative branch findings are acceptable when archived with durable evidence and rollback reasoning.",
			},
			benchmark: { status: "pass", benchmarkExitCode: 0, validationExitCode: 0 },
			selectionRepair: {
				benchmark: { status: "pass", exitCode: 0 },
				validation: { status: "pass", exitCode: 0 },
			},
			selection: {
				status: "pass",
				terminalState: "no-win",
				selectedBranches: [],
				noWinBranches: ["algorithmic", "caching", "io"],
			},
		});
		const archive = result.statePatch?.find(patch => patch.path === "/archive")?.value;

		expect(result.summary).toBe("archived performance optimization evidence");
		expect(archive).toMatchObject({
			status: "accepted",
			noWin: true,
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

async function writeNoWinBranchReport(cwd: string, strategy: string, decision: string): Promise<void> {
	await Bun.write(
		path.join(cwd, `workflow-output/perf-${strategy}.md`),
		[
			`# Performance ${strategy} Branch`,
			"",
			"## Structured Branch State",
			"",
			"```json",
			JSON.stringify(
				{
					status: "no-win",
					strategy,
					retainedFiles: [],
					candidatePatchPath: null,
					benchmarkRelevance: "yes",
					finalSelection: "no",
					noWinResult: "yes",
					measurements: [{ candidate: strategy, result: "200 loops, best of 3: 158 usec per loop", decision }],
				},
				null,
				2,
			),
			"```",
			"",
			"final-selection: no",
			"no-win-result: yes",
			"benchmark-relevance: yes",
			"benchmark-covered rejection: yes",
			`${decision}.`,
			"rollback evidence: no project-code changes are retained.",
			"",
		].join("\n"),
	);
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
