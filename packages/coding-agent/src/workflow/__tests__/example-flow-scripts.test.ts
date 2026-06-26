import { describe, expect, it } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../../config/settings";
import type { ToolSession } from "../../tools";
import type { WorkflowDefinition } from "../definition";
import { createEvalToolScriptRunner } from "../eval-tool-runtime";
import type { WorkflowLifecycleBranchEntry } from "../lifecycle";
import { runWorkflow, type WorkflowRunnerResult } from "../runner";
import { createSessionWorkflowRuntimeHost } from "../session-runtime";

const PARALLEL_REVIEW_SCRIPT_DIR = `${import.meta.dir}/../../../examples/workflow/experimental/parallel-implementation-review/parallel-implementation-review/scripts`;
const DOCUMENTATION_AUDIT_SCRIPT_DIR = `${import.meta.dir}/../../../examples/workflow/experimental/documentation-audit/documentation-audit/scripts`;
const PERFORMANCE_OPTIMIZATION_SCRIPT_DIR = `${import.meta.dir}/../../../examples/workflow/experimental/performance-optimization-search/performance-optimization-search/scripts`;
const REFACTOR_MIGRATION_SCRIPT_DIR = `${import.meta.dir}/../../../examples/workflow/experimental/refactor-migration-plan/refactor-migration-plan/scripts`;
const TEST_GENERATION_HARDENING_DIR = `${import.meta.dir}/../../../examples/workflow/experimental/test-generation-hardening/test-generation-hardening`;
const KDA_HUMANIZE_SUBFLOW_DIR = `${import.meta.dir}/../../../examples/workflow/experimental/kda-humanize/kda-humanize/humanize-rlcr-subflow`;

describe("example workflow scripts", () => {
	it("records the manifest run id as the canonical tuple id in the task contract", async () => {
		using tempDir = TempDir.createSync("@omh-parallel-review-precheck-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();
		const tupleId = "P06-T04-c92d811c8-canary-g";

		await Bun.write(
			`${cwd}/task.md`,
			[
				"Objective:",
				"Prove the canonical tuple id contract.",
				"",
				"Acceptance Criteria:",
				"- Precheck records the manifest run id.",
				"",
				"Validation Command:",
				"echo validate",
				"",
				"Lane Ownership:",
				"core owns source; tests owns validation; docs owns operator evidence.",
				"",
				"Stop Conditions:",
				"Stop on tuple-id drift.",
				"",
				"Tuple:",
				"c92d811c8 x P06-T04 x ripgrep x parallel-implementation-review x regex-path-metric",
			].join("\n"),
		);
		await Bun.write(`${cwd}/manifest-entry.json`, `${JSON.stringify({ runId: tupleId }, null, 2)}\n`);

		const result = await runExampleScript({
			cwd,
			previousCwd,
			nodeId: "precheckTaskContract",
			scriptFileName: "precheck-task-contract.js",
		});

		expect(result.scheduler.state.runtime).toMatchObject({ canonicalTupleId: tupleId });
		expect(result.scheduler.state.taskContract).toContain(`Canonical tuple id: ${tupleId}`);
		expect(result.scheduler.state.taskContract).toContain(
			"Every lane-authored tuple-scoped artifact must use the exact Canonical tuple id above",
		);
	});

	it("reuses declared validation evidence keyed by the manifest run id", async () => {
		using tempDir = TempDir.createSync("@omh-parallel-review-script-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();
		const tupleId = "P06-T04-c92d811c8-canary-g";
		const validationCommand = "echo validate";
		const validationEnvironment = { TMPDIR: `${cwd}/workflow-output/tmp` };
		const stdoutArtifact = `workflow-output/validation-attempt-1-stdout-${tupleId}.txt`;
		const stderrArtifact = `workflow-output/validation-attempt-1-stderr-${tupleId}.txt`;
		const exitCodeArtifact = `workflow-output/validation-attempt-1-exitcode-${tupleId}.txt`;

		await Bun.write(
			`${cwd}/task.md`,
			[
				"Objective:",
				"Prove reusable validation handoff.",
				"",
				"Acceptance Criteria:",
				"- Reuse the test lane declared validation.",
				"",
				"Validation Command:",
				validationCommand,
				"",
				"Validation Environment:",
				`TMPDIR=${validationEnvironment.TMPDIR}`,
			].join("\n"),
		);
		await Bun.write(
			`${cwd}/manifest-entry.json`,
			`${JSON.stringify(
				{
					runId: tupleId,
					familyId: `phase3-${tupleId}`,
				},
				null,
				2,
			)}\n`,
		);
		await Bun.write(`${cwd}/${stdoutArtifact}`, "validation stdout\n");
		await Bun.write(`${cwd}/${stderrArtifact}`, "");
		await Bun.write(`${cwd}/${exitCodeArtifact}`, "0\n");
		await Bun.write(
			`${cwd}/workflow-output/tests-lane-${tupleId}.json`,
			`${JSON.stringify(
				{
					schema: "tests-lane-v1",
					tuple_id: tupleId,
					producer_node: "implementTests",
					status: "complete",
					declared_validation: {
						command: validationCommand,
						environment: validationEnvironment,
						result: "pass",
						exit_code: 0,
						attempts: [
							{
								attempt: 1,
								result: "pass",
								exit_code: 0,
								stdout_path: stdoutArtifact,
								stderr_path: stderrArtifact,
								exitcode_path: exitCodeArtifact,
							},
						],
					},
				},
				null,
				2,
			)}\n`,
		);

		const result = await runExampleScript({
			cwd,
			previousCwd,
			nodeId: "runDeclaredValidation",
			scriptFileName: "run-declared-validation.js",
		});

		expect(result.scheduler.state.declaredValidation).toMatchObject({
			tuple_id: tupleId,
			validation: {
				command: validationCommand,
				environment: validationEnvironment,
				result: "passed",
				exitCode: 0,
				stdoutArtifact,
				stderrArtifact,
				exitCodeArtifact,
				reusedFromTestLane: `workflow-output/tests-lane-${tupleId}.json`,
			},
		});
		expect(await Bun.file(`${cwd}/workflow-output/validation-${tupleId}.json`).json()).toMatchObject({
			tuple_id: tupleId,
			validation: {
				reusedFromTestLane: `workflow-output/tests-lane-${tupleId}.json`,
			},
		});
	});

	it("promotes validation command shell-prefix assignments into the declared environment", async () => {
		using tempDir = TempDir.createSync("@omh-parallel-review-env-prefix-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();
		const tupleId = "P06-T06-env-prefix";
		const validationCommand = "TMPDIR=/tmp OMP_WORKFLOW_TMP=./temp echo validate";
		const validationEnvironment = { TMPDIR: "/tmp", OMP_WORKFLOW_TMP: "./temp" };
		const stdoutArtifact = `workflow-output/validation-attempt-1-stdout-${tupleId}.txt`;
		const stderrArtifact = `workflow-output/validation-attempt-1-stderr-${tupleId}.txt`;
		const exitCodeArtifact = `workflow-output/validation-attempt-1-exitcode-${tupleId}.txt`;

		await Bun.write(
			`${cwd}/task.md`,
			[
				"Objective:",
				"Preserve shell-prefix validation environment assignments.",
				"",
				"Acceptance Criteria:",
				"- The declared validation environment records command-prefix assignments.",
				"",
				"Validation Command:",
				validationCommand,
			].join("\n"),
		);
		await Bun.write(`${cwd}/manifest-entry.json`, `${JSON.stringify({ runId: tupleId }, null, 2)}\n`);
		await Bun.write(`${cwd}/${stdoutArtifact}`, "validate\n");
		await Bun.write(`${cwd}/${stderrArtifact}`, "");
		await Bun.write(`${cwd}/${exitCodeArtifact}`, "0\n");
		await Bun.write(
			`${cwd}/workflow-output/tests-lane-${tupleId}.json`,
			`${JSON.stringify(
				{
					schema: "tests-lane-v1",
					tuple_id: tupleId,
					producer_node: "implementTests",
					status: "complete",
					declared_validation: {
						command: validationCommand,
						environment: validationEnvironment,
						result: "pass",
						exit_code: 0,
						attempts: [
							{
								attempt: 1,
								result: "pass",
								exit_code: 0,
								stdout_path: stdoutArtifact,
								stderr_path: stderrArtifact,
								exitcode_path: exitCodeArtifact,
							},
						],
					},
				},
				null,
				2,
			)}\n`,
		);

		const result = await runExampleScript({
			cwd,
			previousCwd,
			nodeId: "runDeclaredValidation",
			scriptFileName: "run-declared-validation.js",
		});

		expect(result.scheduler.state.declaredValidation).toMatchObject({
			tuple_id: tupleId,
			validation: {
				command: validationCommand,
				environment: validationEnvironment,
				result: "passed",
				exitCode: 0,
			},
		});
		expect(await Bun.file(`${cwd}/workflow-output/validation-${tupleId}.json`).json()).toMatchObject({
			validation: {
				environment: validationEnvironment,
			},
		});
	});

	it("bounds documentation audit fan-in before consolidation", async () => {
		using tempDir = TempDir.createSync("@omh-documentation-audit-compact-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();
		const largeEvidence = "stale doc finding with reproducible evidence\n".repeat(500);

		const result = await runExampleScript({
			cwd,
			previousCwd,
			nodeId: "compactAuditFindings",
			scriptFileName: "compact-audit-findings.js",
			scriptDir: DOCUMENTATION_AUDIT_SCRIPT_DIR,
			writes: ["/auditDigest"],
			initialState: {
				task: {
					objective: "Keep documentation consistent with shell completion behavior.",
					validationCommand: "python -m pytest tests/test_shell_completion.py",
				},
				inventory: {
					docs: ["docs/shell-completion.md", "docs/testing.md"],
				},
				apiDocsAudit: { findings: [largeEvidence, largeEvidence] },
				tutorialAudit: { findings: [largeEvidence, largeEvidence] },
				examplesAudit: { findings: [largeEvidence, largeEvidence] },
			},
		});

		expect(result.scheduler.state.auditDigest).toMatchObject({
			apiDocsAudit: {
				source: "apiDocsAudit",
				truncated: true,
			},
			tutorialAudit: {
				source: "tutorialAudit",
				truncated: true,
			},
			examplesAudit: {
				source: "examplesAudit",
				truncated: true,
			},
		});
		const digest = JSON.stringify(result.scheduler.state.auditDigest);
		expect(digest.length).toBeLessThan(10000);
		expect(digest).toContain("omitted");
		expect(await Bun.file(`${cwd}/workflow-output/documentation-audit-digest.md`).text()).toContain(
			"# Documentation Audit Digest",
		);
	});

	it("keeps documentation patch evidence separate from terminal workflow artifacts", async () => {
		const prompt = await Bun.file(
			`${import.meta.dir}/../../../examples/workflow/experimental/documentation-audit/documentation-audit/prompts/patch-docs.md`,
		).text();

		expect(prompt).toContain("Do not write terminal workflow artifacts");
		expect(prompt).toContain("workflow-output/documentation-validation.md");
		expect(prompt).toContain("workflow-output/documentation-audit-archive.md");
		expect(prompt).toContain("workflow-output/review-decision.md");
		expect(prompt).toContain("workflow-output/final");
		expect(prompt).toContain("workflow-output/documentation-rollback.md");
		expect(prompt).toContain("Final response contract");
		expect(prompt).toContain("changed_files");
		expect(prompt).toContain("rollback_notes");
	});

	it("initializes documentation patch state before reviewer binding", async () => {
		using tempDir = TempDir.createSync("@omh-documentation-audit-patch-state-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();

		await Bun.write(
			`${cwd}/task.md`,
			[
				"Objective:",
				"Repair stale documentation examples.",
				"",
				"Validation Command:",
				"python -m pytest tests/test_docs.py",
			].join("\n"),
		);

		const result = await runExampleScript({
			cwd,
			previousCwd,
			nodeId: "precheckTaskContract",
			scriptFileName: "precheck-task-contract.js",
			scriptDir: DOCUMENTATION_AUDIT_SCRIPT_DIR,
			writes: ["/task", "/runtime", "/review", "/validation", "/patch"],
		});

		expect(result.scheduler.state.patch).toMatchObject({
			status: "not-run",
			summary: "No documentation repair has run yet.",
			changed_files: [],
			rollback_notes: [],
		});

		const flow = await Bun.file(
			`${import.meta.dir}/../../../examples/workflow/experimental/documentation-audit/documentation-audit.omhflow`,
		).text();
		expect(flow).toMatch(/id:\s*precheckTaskContract[\s\S]*?writes:[\s\S]*?- \/patch/u);
	});

	it("fails performance optimization closed when the baseline command is not reproducible", async () => {
		using tempDir = TempDir.createSync("@omh-performance-baseline-fail-closed-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();

		const result = await runExampleScript({
			cwd,
			previousCwd,
			nodeId: "captureBaseline",
			scriptFileName: "capture-baseline.js",
			scriptDir: PERFORMANCE_OPTIMIZATION_SCRIPT_DIR,
			writes: ["/baseline"],
			initialState: {
				task: {
					baselineCommand: "printf 'missing dependency\\n' >&2; exit 17",
				},
			},
		});

		expect(result.scheduler.activations.find(activation => activation.nodeId === "captureBaseline")?.status).toBe(
			"failed",
		);
		expect(result.scheduler.state.baseline).toBeUndefined();
		const evidence = await Bun.file(`${cwd}/workflow-output/performance-baseline.md`).text();
		expect(evidence).toContain("Exit code: 17");
		expect(evidence).toContain("missing dependency");
	});

	it("routes performance optimization through selection repair before reviewer loops", async () => {
		const flow = await Bun.file(
			`${import.meta.dir}/../../../examples/workflow/experimental/performance-optimization-search/performance-optimization-search.omhflow`,
		).text();
		const repairPrompt = await Bun.file(
			`${import.meta.dir}/../../../examples/workflow/experimental/performance-optimization-search/performance-optimization-search/prompts/selection-repair.md`,
		).text();
		const hypothesesPrompt = await Bun.file(
			`${import.meta.dir}/../../../examples/workflow/experimental/performance-optimization-search/performance-optimization-search/prompts/hypotheses.md`,
		).text();
		const optimizationPrompt = await Bun.file(
			`${import.meta.dir}/../../../examples/workflow/experimental/performance-optimization-search/performance-optimization-search/prompts/optimization.md`,
		).text();

		expect(flow).toMatch(/path:\s*prompts\/selection-repair\.md/u);
		expect(flow).toMatch(
			/id:\s*repairPerformanceSelection[\s\S]*?reads:[\s\S]*?- \/benchmark[\s\S]*?writes:[\s\S]*?- \/selectionRepair[\s\S]*?id:\s*guardSelectionRepair[\s\S]*?writes:[\s\S]*?- \/selectionGuard[\s\S]*?id:\s*perfReview/u,
		);
		expect(flow).toMatch(/selectionRepair:[\s\S]*?state:\s*\/selectionRepair/u);
		expect(flow).toMatch(/selectionGuard:[\s\S]*?state:\s*\/selectionGuard/u);
		expect(repairPrompt).toContain("workflow-output/performance-selection-repair.md");
		expect(repairPrompt).toContain("Do not start a new broad optimization attempt");
		expect(repairPrompt).toContain("Do not write terminal workflow artifacts");
		expect(repairPrompt).toContain("workflow-output/performance-final-archive.md");
		expect(hypothesesPrompt).toContain("selection/rollback repair");
		expect(optimizationPrompt).toContain("selection/rollback repair");
	});

	it("keeps performance parallel lanes lane-local until selection applies a candidate", async () => {
		const optimizationPrompt = await Bun.file(
			`${import.meta.dir}/../../../examples/workflow/experimental/performance-optimization-search/performance-optimization-search/prompts/optimization.md`,
		).text();
		const repairPrompt = await Bun.file(
			`${import.meta.dir}/../../../examples/workflow/experimental/performance-optimization-search/performance-optimization-search/prompts/selection-repair.md`,
		).text();
		const reviewPrompt = await Bun.file(
			`${import.meta.dir}/../../../examples/workflow/experimental/performance-optimization-search/performance-optimization-search/prompts/perf-review.md`,
		).text();

		expect(optimizationPrompt).toContain("Do not leave project-file edits in the shared workspace");
		expect(optimizationPrompt).toContain("candidate patch");
		expect(optimizationPrompt).toContain("git apply --check");
		expect(optimizationPrompt).toContain("outside the project tree");
		expect(optimizationPrompt).not.toContain("workflow-output/tmp/{{strategy}}-*");
		expect(repairPrompt).toContain("apply at most one selected candidate patch");
		expect(repairPrompt).toContain("clean shared workspace");
		expect(repairPrompt).toContain("project-local scratch");
		expect(reviewPrompt).toContain("branch left no project-file edits in the shared workspace");
		expect(reviewPrompt).toContain("outside the project tree");
	});

	it("blocks performance benchmark joins when parallel lanes leave shared project edits", async () => {
		using tempDir = TempDir.createSync("@omh-performance-shared-diff-guard-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();

		await Bun.write(`${cwd}/src.txt`, "baseline\n");
		await Bun.write(
			`${cwd}/task.md`,
			["Benchmark Command:", "echo benchmark", "", "Validation Command:", "echo validation"].join("\n"),
		);
		await runGit(cwd, ["init"]);
		await runGit(cwd, ["config", "user.email", "omh@example.invalid"]);
		await runGit(cwd, ["config", "user.name", "OMH Test"]);
		await runGit(cwd, ["add", "src.txt", "task.md"]);
		await runGit(cwd, ["commit", "-m", "baseline"]);
		await Bun.write(`${cwd}/src.txt`, "candidate leaked into shared workspace\n");

		const result = await runExampleScript({
			cwd,
			previousCwd,
			nodeId: "benchmarkCandidates",
			scriptFileName: "run-benchmark-validation.js",
			scriptDir: PERFORMANCE_OPTIMIZATION_SCRIPT_DIR,
			writes: ["/benchmark"],
			initialState: {
				task: {
					benchmarkCommand: "echo benchmark",
					validationCommand: "echo validation",
				},
			},
		});

		expect(result.scheduler.state.benchmark).toMatchObject({
			status: "fail",
			isolationViolation: true,
			projectChangedFiles: ["src.txt"],
		});
		expect(await Bun.file(`${cwd}/workflow-output/performance-benchmark.md`).text()).toContain(
			"Parallel Lane Isolation Violation",
		);
	});

	it("blocks performance benchmark joins when lane scratch lives inside the project tree", async () => {
		using tempDir = TempDir.createSync("@omh-performance-project-scratch-guard-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();

		await Bun.write(`${cwd}/src.txt`, "baseline\n");
		await Bun.write(
			`${cwd}/task.md`,
			["Benchmark Command:", "echo benchmark", "", "Validation Command:", "echo validation"].join("\n"),
		);
		await runGit(cwd, ["init"]);
		await runGit(cwd, ["config", "user.email", "omh@example.invalid"]);
		await runGit(cwd, ["config", "user.name", "OMH Test"]);
		await runGit(cwd, ["add", "src.txt", "task.md"]);
		await runGit(cwd, ["commit", "-m", "baseline"]);
		await Bun.write(`${cwd}/workflow-output/tmp/algorithmic-worktree/marker.txt`, "project-local scratch\n");

		const result = await runExampleScript({
			cwd,
			previousCwd,
			nodeId: "benchmarkCandidates",
			scriptFileName: "run-benchmark-validation.js",
			scriptDir: PERFORMANCE_OPTIMIZATION_SCRIPT_DIR,
			writes: ["/benchmark"],
			initialState: {
				task: {
					benchmarkCommand: "echo benchmark",
					validationCommand: "echo validation",
				},
			},
		});

		expect(result.scheduler.state.benchmark).toMatchObject({
			status: "fail",
			isolationViolation: true,
			projectLocalScratchPaths: ["workflow-output/tmp"],
		});
		expect(await Bun.file(`${cwd}/workflow-output/performance-benchmark.md`).text()).toContain(
			"Project-Local Scratch Isolation Violation",
		);
	});

	it("blocks performance benchmark joins when lanes leave untracked project-local scratch", async () => {
		using tempDir = TempDir.createSync("@omh-performance-untracked-scratch-guard-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();

		await Bun.write(`${cwd}/src.txt`, "baseline\n");
		await Bun.write(
			`${cwd}/task.md`,
			["Benchmark Command:", "echo benchmark", "", "Validation Command:", "echo validation"].join("\n"),
		);
		await runGit(cwd, ["init"]);
		await runGit(cwd, ["config", "user.email", "omh@example.invalid"]);
		await runGit(cwd, ["config", "user.name", "OMH Test"]);
		await runGit(cwd, ["add", "src.txt", "task.md"]);
		await runGit(cwd, ["commit", "-m", "baseline"]);
		await Bun.write(`${cwd}/lane-scratch/algorithmic-worktree/marker.txt`, "project-local scratch\n");

		const result = await runExampleScript({
			cwd,
			previousCwd,
			nodeId: "benchmarkCandidates",
			scriptFileName: "run-benchmark-validation.js",
			scriptDir: PERFORMANCE_OPTIMIZATION_SCRIPT_DIR,
			writes: ["/benchmark"],
			initialState: {
				task: {
					benchmarkCommand: "echo benchmark",
					validationCommand: "echo validation",
				},
			},
		});

		expect(result.scheduler.state.benchmark).toMatchObject({
			status: "fail",
			isolationViolation: true,
			projectChangedFiles: ["lane-scratch/algorithmic-worktree/marker.txt"],
		});
		expect(await Bun.file(`${cwd}/workflow-output/performance-benchmark.md`).text()).toContain(
			"Parallel Lane Isolation Violation",
		);
	});

	it("archives performance no-win evidence when validation is blocked without retained project changes", async () => {
		using tempDir = TempDir.createSync("@omh-performance-no-win-validation-blocked-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();
		const taskText = [
			"# Performance no-win canary",
			"",
			"Benchmark Command:",
			"cargo test --no-run",
			"",
			"Validation Command:",
			"cargo test",
			"",
			"No-Code/No-Change Allowed: Yes",
		].join("\n");

		await Bun.write(`${cwd}/README.md`, "baseline\n");
		await Bun.write(`${cwd}/task.md`, taskText);
		await runGit(cwd, ["init"]);
		await runGit(cwd, ["config", "user.email", "omh@example.invalid"]);
		await runGit(cwd, ["config", "user.name", "OMH Test"]);
		await runGit(cwd, ["add", "README.md", "task.md"]);
		await runGit(cwd, ["commit", "-m", "baseline"]);

		await Bun.write(
			`${cwd}/workflow-output/perf-algorithmic.md`,
			["# Algorithmic", "", "final-selection: no", "rollback evidence: no retained changes"].join("\n"),
		);
		await Bun.write(
			`${cwd}/workflow-output/perf-caching.md`,
			[
				"# Caching",
				"",
				"final-selection: no",
				"no-win-result: yes",
				"rollback evidence: no project changes remain after failed validation",
			].join("\n"),
		);
		await Bun.write(
			`${cwd}/workflow-output/perf-io.md`,
			["# IO", "", "final-selection: no", "rollback evidence: no retained changes"].join("\n"),
		);
		await Bun.write(
			`${cwd}/workflow-output/performance-benchmark.md`,
			[
				"# Performance Benchmark Evidence",
				"",
				"## Benchmark Command",
				"",
				"Exit code: 0",
				"",
				"## Validation Command",
				"",
				"Exit code: 101",
				"",
				"test_respect_ignore_files failed",
			].join("\n"),
		);

		const finalize = await runExampleScript({
			cwd,
			previousCwd,
			nodeId: "finalizePerformanceSelection",
			scriptFileName: "finalize-performance-selection.js",
			scriptDir: PERFORMANCE_OPTIMIZATION_SCRIPT_DIR,
			writes: ["/selection"],
			initialState: {
				task: {
					text: taskText,
				},
				benchmark: {
					benchmarkExitCode: 0,
					validationExitCode: 101,
					status: "fail",
					outputPath: "workflow-output/performance-benchmark.md",
				},
				selectionRepair: {
					status: "terminal no-win selection repair complete",
				},
			},
		});

		expect(finalize.scheduler.state.selection).toMatchObject({
			status: "blocked",
			terminalState: "no-win-validation-blocked",
			validationPassed: false,
			noWinBranches: ["caching"],
		});

		const archive = await runExampleScript({
			cwd,
			previousCwd,
			nodeId: "archivePerformance",
			scriptFileName: "archive-performance.js",
			scriptDir: PERFORMANCE_OPTIMIZATION_SCRIPT_DIR,
			writes: ["/archive"],
			initialState: finalize.scheduler.state,
		});

		expect(archive.scheduler.state.archive).toMatchObject({
			benchmark: "pass",
			validation: "blocked",
			noWin: true,
		});
		expect(await Bun.file(`${cwd}/workflow-output/performance-archive.md`).text()).toContain(
			"terminalState: no-win-validation-blocked",
		);
	});

	it("blocks performance repair nodes from writing terminal archive artifacts", async () => {
		using tempDir = TempDir.createSync("@omh-performance-repair-terminal-artifact-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();

		await Bun.write(`${cwd}/README.md`, "baseline\n");
		await Bun.write(
			`${cwd}/task.md`,
			["Benchmark Command:", "echo benchmark", "", "Validation Command:", "echo validation"].join("\n"),
		);
		await runGit(cwd, ["init"]);
		await runGit(cwd, ["config", "user.email", "omh@example.invalid"]);
		await runGit(cwd, ["config", "user.name", "OMH Test"]);
		await runGit(cwd, ["add", "README.md", "task.md"]);
		await runGit(cwd, ["commit", "-m", "baseline"]);
		await Bun.write(`${cwd}/workflow-output/performance-final-archive.md`, "premature final archive\n");

		const result = await runExampleScript({
			cwd,
			previousCwd,
			nodeId: "guardSelectionRepair",
			scriptFileName: "guard-selection-repair.js",
			scriptDir: PERFORMANCE_OPTIMIZATION_SCRIPT_DIR,
			writes: ["/selectionGuard"],
			initialState: {
				task: {
					text: await Bun.file(`${cwd}/task.md`).text(),
				},
				benchmark: {
					benchmarkExitCode: 0,
					validationExitCode: 0,
					status: "pass",
				},
				selectionRepair: {
					status: "patched",
				},
			},
		});

		expect(
			result.scheduler.activations.find(activation => activation.nodeId === "guardSelectionRepair")?.status,
		).toBe("failed");
	});

	it("blocks positive performance repair when validation failed with retained project changes", async () => {
		using tempDir = TempDir.createSync("@omh-performance-validation-blocked-positive-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();
		const taskText = ["Benchmark Command:", "echo benchmark", "", "Validation Command:", "exit 101"].join("\n");

		await Bun.write(`${cwd}/src.txt`, "baseline\n");
		await Bun.write(`${cwd}/task.md`, taskText);
		await runGit(cwd, ["init"]);
		await runGit(cwd, ["config", "user.email", "omh@example.invalid"]);
		await runGit(cwd, ["config", "user.name", "OMH Test"]);
		await runGit(cwd, ["add", "src.txt", "task.md"]);
		await runGit(cwd, ["commit", "-m", "baseline"]);
		await Bun.write(`${cwd}/src.txt`, "selected positive candidate\n");
		await Bun.write(
			`${cwd}/workflow-output/perf-algorithmic.md`,
			["# Algorithmic", "", "final-selection: yes", "rollback evidence: git apply -R candidate"].join("\n"),
		);
		await Bun.write(
			`${cwd}/workflow-output/perf-caching.md`,
			["# Caching", "", "final-selection: no", "rollback evidence: no retained changes"].join("\n"),
		);
		await Bun.write(
			`${cwd}/workflow-output/perf-io.md`,
			["# IO", "", "final-selection: no", "rollback evidence: no retained changes"].join("\n"),
		);

		const result = await runExampleScript({
			cwd,
			previousCwd,
			nodeId: "guardSelectionRepair",
			scriptFileName: "guard-selection-repair.js",
			scriptDir: PERFORMANCE_OPTIMIZATION_SCRIPT_DIR,
			writes: ["/selectionGuard"],
			initialState: {
				task: {
					text: taskText,
				},
				benchmark: {
					benchmarkExitCode: 0,
					validationExitCode: 101,
					status: "fail",
				},
				selectionRepair: {
					status: "terminal positive selection repair complete",
				},
			},
		});

		expect(
			result.scheduler.activations.find(activation => activation.nodeId === "guardSelectionRepair")?.status,
		).toBe("failed");
	});

	it("keeps test-hardening repair evidence separate from suite output", async () => {
		const generatePrompt = await Bun.file(`${TEST_GENERATION_HARDENING_DIR}/prompts/generate-tests.md`).text();
		const repairPrompt = await Bun.file(`${TEST_GENERATION_HARDENING_DIR}/prompts/repair-tests.md`).text();
		const reviewPrompt = await Bun.file(`${TEST_GENERATION_HARDENING_DIR}/prompts/test-review.md`).text();
		const archiveScript = await Bun.file(`${TEST_GENERATION_HARDENING_DIR}/scripts/archive-tests.js`).text();
		const gapPrompt = await Bun.file(`${TEST_GENERATION_HARDENING_DIR}/prompts/test-gaps.md`).text();

		expect(gapPrompt).toContain("workflow-output/test-hardening-gap-report.md");
		expect(generatePrompt).toContain("workflow-output/test-hardening-gap-report.md");
		for (const prompt of [generatePrompt, repairPrompt, reviewPrompt]) {
			expect(prompt).toContain("workflow-output/test-hardening-repair-evidence.md");
		}
		expect(generatePrompt).toContain("Do not edit `workflow-output/test-suite.md`");
		expect(repairPrompt).toContain("Do not edit `workflow-output/test-suite.md`");
		expect(reviewPrompt).toContain("test-hardening-repair-evidence");
		expect(archiveScript).toContain("workflow-output/test-hardening-repair-evidence.md");
	});

	it("materializes test-hardening gap reports and fails closed on blocked validation", async () => {
		using tempDir = TempDir.createSync("@omh-test-hardening-gap-report-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();

		const ready = await runExampleScript({
			cwd,
			previousCwd,
			nodeId: "materializeGapReport",
			scriptFileName: "materialize-gap-report.js",
			scriptDir: `${TEST_GENERATION_HARDENING_DIR}/scripts`,
			writes: ["/gaps"],
			initialState: {
				gaps: {
					status: "ready",
					summary: "console width wrapping lacks regression coverage",
					unitGaps: ["Console width boundaries"],
					integrationGaps: ["Table layout with wrapped cells"],
					filesLikelyToNeedTestChanges: ["tests/test_console.py"],
					validation: {
						startable: true,
						command: "python -m pytest tests/test_console.py",
					},
				},
			},
		});

		expect(ready.scheduler.state.gaps).toMatchObject({
			gapReportPath: "workflow-output/test-hardening-gap-report.md",
		});
		const report = await Bun.file(`${cwd}/workflow-output/test-hardening-gap-report.md`).text();
		expect(report).toContain("console width wrapping lacks regression coverage");
		expect(report).toContain("Console width boundaries");
		expect(report).toContain("tests/test_console.py");

		using blockedDir = TempDir.createSync("@omh-test-hardening-gap-blocked-");
		const blocked = await runExampleScript({
			cwd: blockedDir.path(),
			previousCwd,
			nodeId: "materializeGapReport",
			scriptFileName: "materialize-gap-report.js",
			scriptDir: `${TEST_GENERATION_HARDENING_DIR}/scripts`,
			writes: ["/gaps"],
			initialState: {
				gaps: {
					status: "blocked",
					summary: "validation command cannot start",
					validation: {
						startable: false,
						command: "python -m pytest tests/test_console.py",
						stderr: "/usr/bin/python: No module named pytest",
					},
				},
			},
		});

		expect(
			blocked.scheduler.activations.find(activation => activation.nodeId === "materializeGapReport")?.status,
		).toBe("failed");
		expect(await Bun.file(`${blockedDir.path()}/workflow-output/test-hardening-gap-report.md`).text()).toContain(
			"No module named pytest",
		);
	});

	it("blocks refactor migration when compatibility design is fail-closed", async () => {
		using tempDir = TempDir.createSync("@omh-refactor-compat-gate-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();

		const blocked = await runExampleScript({
			cwd,
			previousCwd,
			nodeId: "enforceCompatibilityGate",
			scriptFileName: "enforce-compatibility-gate.js",
			scriptDir: REFACTOR_MIGRATION_SCRIPT_DIR,
			writes: ["/compatibilityGate"],
			initialState: {
				task: {
					validationCommand: "python -m pytest tests/test_config.py",
				},
				compatibility: {
					status: "designed_fail_closed_no_source_change",
					validation: {
						validation_exit_code: 1,
						stop_condition_hit: "missing pytest",
						validation_stdout_stderr: "/usr/bin/python: No module named pytest\n",
					},
					migration_decision: {
						source_edits_performed: false,
						reason: "missing pytest prevents a safe baseline",
					},
				},
			},
		});

		expect(
			blocked.scheduler.activations.find(activation => activation.nodeId === "enforceCompatibilityGate")?.status,
		).toBe("failed");
		const report = await Bun.file(`${cwd}/workflow-output/refactor-migration-compatibility-gate.md`).text();
		expect(report).toContain("blocked");
		expect(report).toContain("missing pytest");

		using readyDir = TempDir.createSync("@omh-refactor-compat-gate-ready-");
		const ready = await runExampleScript({
			cwd: readyDir.path(),
			previousCwd,
			nodeId: "enforceCompatibilityGate",
			scriptFileName: "enforce-compatibility-gate.js",
			scriptDir: REFACTOR_MIGRATION_SCRIPT_DIR,
			writes: ["/compatibilityGate"],
			initialState: {
				task: {
					validationCommand: "bun test",
				},
				compatibility: {
					status: "ready",
					strategy: "preserve the public call boundary before moving callers",
				},
			},
		});

		expect(ready.scheduler.state.compatibilityGate).toMatchObject({
			status: "pass",
			reportPath: "workflow-output/refactor-migration-compatibility-gate.md",
		});
	});

	it("treats nested Humanize stop paths as structured handoffs instead of script failures", async () => {
		using tempDir = TempDir.createSync("@omh-kda-humanize-stop-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();
		const stopScript = await Bun.file(`${KDA_HUMANIZE_SUBFLOW_DIR}/scripts/stop-subflow.js`).text();

		const result = await runExampleDefinition({
			cwd,
			previousCwd,
			definition: {
				name: "kda-humanize-stop-contract",
				version: 1,
				models: { roles: {}, defaults: {} },
				nodes: [
					{
						id: "planCompliance",
						type: "script",
						script: {
							language: "js",
							code: 'return { summary: "plan needs a narrower implementation route", data: { verdict: "FAIL_RELEVANCE" } };',
						},
					},
					{
						id: "stopSubflow",
						type: "script",
						script: {
							language: "js",
							code: stopScript,
						},
						writes: ["/humanize", "/finalizeSummary"],
					},
				],
				edges: [{ from: "planCompliance", to: "stopSubflow" }],
			},
		});

		expect(result.scheduler.activations.find(activation => activation.nodeId === "stopSubflow")?.status).toBe(
			"completed",
		);
		expect(result.scheduler.activations.every(activation => activation.status !== "failed")).toBe(true);
		expect(result.scheduler.state.humanize).toMatchObject({
			subflowStop: {
				verdict: "FAIL_RELEVANCE",
				sourceNodeId: "planCompliance",
			},
		});
		expect(result.scheduler.state.finalizeSummary).toMatchObject({
			status: "stopped",
			verdict: "FAIL_RELEVANCE",
		});
		expect(await Bun.file(`${cwd}/workflow-output/humanize-stop-summary.md`).text()).toContain("FAIL_RELEVANCE");
	});

	it("does not require completed validation evidence before Humanize accepts an executable KDA plan", async () => {
		const prompt = await Bun.file(`${KDA_HUMANIZE_SUBFLOW_DIR}/prompts/plan-compliance.md`).text();

		expect(prompt).toMatch(/does not\s+need completed validation evidence before implementation/u);
		expect(prompt).toContain("concrete validation plan");
	});
});

class MemoryWorkflowHost {
	#entries: WorkflowLifecycleBranchEntry[] = [];

	appendCustomEntry(customType: string, data?: unknown): string {
		const id = `entry-${this.#entries.length + 1}`;
		this.#entries.push({ type: "custom", customType, data });
		return id;
	}

	getBranch(): WorkflowLifecycleBranchEntry[] {
		return this.#entries;
	}
}

async function singleScriptDefinitionFrom({
	nodeId,
	scriptFileName,
	scriptDir,
	writes,
}: {
	nodeId: string;
	scriptFileName: string;
	scriptDir: string;
	writes: string[];
}): Promise<WorkflowDefinition> {
	return {
		name: "example-flow-script-test",
		version: 1,
		models: { roles: {}, defaults: {} },
		nodes: [
			{
				id: nodeId,
				type: "script",
				script: {
					language: "js",
					code: await Bun.file(`${scriptDir}/${scriptFileName}`).text(),
				},
				writes,
			},
		],
		edges: [],
	};
}

async function runExampleScript({
	cwd,
	previousCwd,
	nodeId,
	scriptFileName,
	scriptDir = PARALLEL_REVIEW_SCRIPT_DIR,
	writes = ["/declaredValidation", "/taskContract", "/runtime"],
	initialState,
}: {
	cwd: string;
	previousCwd: string;
	nodeId: string;
	scriptFileName: string;
	scriptDir?: string;
	writes?: string[];
	initialState?: Record<string, unknown>;
}): Promise<WorkflowRunnerResult> {
	const settings = await Settings.init();
	const session: ToolSession = {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings,
	};
	const host = createSessionWorkflowRuntimeHost({
		cwd,
		runEvalScript: createEvalToolScriptRunner(session),
	});
	try {
		process.chdir(cwd);
		return await runWorkflow({
			host: new MemoryWorkflowHost(),
			definition: await singleScriptDefinitionFrom({ nodeId, scriptFileName, scriptDir, writes }),
			runId: `run-${nodeId}`,
			startNodeId: nodeId,
			runtimeHost: host,
			initialState,
		});
	} finally {
		process.chdir(previousCwd);
	}
}

async function runExampleDefinition({
	cwd,
	previousCwd,
	definition,
	initialState,
}: {
	cwd: string;
	previousCwd: string;
	definition: WorkflowDefinition;
	initialState?: Record<string, unknown>;
}): Promise<WorkflowRunnerResult> {
	const settings = await Settings.init();
	const session: ToolSession = {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings,
	};
	const host = createSessionWorkflowRuntimeHost({
		cwd,
		runEvalScript: createEvalToolScriptRunner(session),
	});
	try {
		process.chdir(cwd);
		return await runWorkflow({
			host: new MemoryWorkflowHost(),
			definition,
			runId: `run-${definition.name}`,
			startNodeId: definition.nodes[0]?.id ?? "",
			runtimeHost: host,
			initialState,
		});
	} finally {
		process.chdir(previousCwd);
	}
}

async function runGit(cwd: string, args: string[]): Promise<void> {
	const proc = Bun.spawn(["git", "-c", "commit.gpgsign=false", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${stderr.trim() || stdout.trim()}`);
	}
}
