import { describe, expect, it } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../../config/settings";
import type { ToolSession } from "../../tools";
import type { WorkflowDefinition } from "../definition";
import { createEvalToolScriptRunner } from "../eval-tool-runtime";
import type { WorkflowLifecycleBranchEntry } from "../lifecycle";
import { loadWorkflowArtifact } from "../package-loader";
import { runWorkflow, type WorkflowRunnerResult } from "../runner";
import { createSessionWorkflowRuntimeHost } from "../session-runtime";

const PARALLEL_REVIEW_SCRIPT_DIR = `${import.meta.dir}/../../../examples/workflow/experimental/parallel-implementation-review/parallel-implementation-review/scripts`;
const DOCUMENTATION_AUDIT_SCRIPT_DIR = `${import.meta.dir}/../../../examples/workflow/experimental/documentation-audit/documentation-audit/scripts`;
const PERFORMANCE_OPTIMIZATION_SCRIPT_DIR = `${import.meta.dir}/../../../examples/workflow/experimental/performance-optimization-search/performance-optimization-search/scripts`;
const REFACTOR_MIGRATION_SCRIPT_DIR = `${import.meta.dir}/../../../examples/workflow/experimental/refactor-migration-plan/refactor-migration-plan/scripts`;
const TEST_GENERATION_HARDENING_DIR = `${import.meta.dir}/../../../examples/workflow/experimental/test-generation-hardening/test-generation-hardening`;
const KDA_HUMANIZE_SUBFLOW_DIR = `${import.meta.dir}/../../../examples/workflow/experimental/kda-humanize/kda-humanize/humanize-rlcr-subflow`;
const AGENT_BUILD_REVIEW_LOOP_SCRIPT_DIR = `${import.meta.dir}/../../../examples/workflow/experimental/agent-build-review-loop/agent-build-review-loop/scripts`;
const RESEARCH_REPRODUCTION_SCRIPT_DIR = `${import.meta.dir}/../../../examples/workflow/experimental/research-reproduction/research-reproduction/scripts`;
const RELEASE_HARDENING_SCRIPT_DIR = `${import.meta.dir}/../../../examples/workflow/experimental/release-hardening/release-hardening/scripts`;
const BUG_TRIAGE_REPRO_FIX_SCRIPT_DIR = `${import.meta.dir}/../../../examples/workflow/experimental/bug-triage-repro-fix/bug-triage-repro-fix/scripts`;

describe("example workflow scripts", () => {
	it("loads the documentation-audit workflow artifact", async () => {
		const artifact = await loadWorkflowArtifact(
			`${import.meta.dir}/../../../examples/workflow/experimental/documentation-audit/documentation-audit.omhflow`,
		);

		expect(artifact.definition.nodes.some(node => node.id === "guardReviewRepair")).toBe(true);
		expect(artifact.definition.nodes.some(node => node.id === "runDocsValidation")).toBe(true);
	});

	it("keeps research reproduction agent prompts read-only around command evidence", async () => {
		const prompt = await Bun.file(
			`${import.meta.dir}/../../../examples/workflow/experimental/research-reproduction/research-reproduction/prompts/reproduction.md`,
		).text();

		expect(prompt).toContain("Do not run shell commands, eval snippets, tests, benchmarks, or project tools.");
		expect(prompt).toContain("Do not create, modify, or delete files, including workflow-output artifacts.");
		expect(prompt).toContain("Only script nodes may execute task-declared commands and write command evidence.");
	});

	it("does not count prose markers as research reproduction exercise evidence", async () => {
		using tempDir = TempDir.createSync("@omh-research-reproduction-marker-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();

		const result = await runExampleScript({
			cwd,
			previousCwd,
			nodeId: "reproduceBaseline",
			scriptFileName: "run-reproduction.js",
			scriptDir: RESEARCH_REPRODUCTION_SCRIPT_DIR,
			writes: ["/reproduction"],
			initialState: {
				task: {
					reproductionCommand: "printf 'exercised validated\\n'",
				},
			},
		});

		expect(result.scheduler.state.reproduction).toMatchObject({
			status: "fail",
			exercised: false,
			exitCode: 0,
		});
		expect(await Bun.file(`${cwd}/workflow-output/reproduction-baseline.json`).json()).toMatchObject({
			exerciseSummary: {
				exercised: false,
				positiveSignals: [],
			},
		});
	});

	it("archives terminal research reproduction rejections instead of looping forever", async () => {
		using tempDir = TempDir.createSync("@omh-research-reproduction-terminal-reject-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();

		await Bun.write(
			`${cwd}/task.md`,
			[
				"Objective:",
				"Record a terminal reproduction rejection when stable command evidence disproves the claim.",
				"",
				"Reproduction Command:",
				"python -m pytest tests/test_json.py tests/test_type_adapter.py -q",
				"",
				"Validation Command:",
				"python -m pytest tests/test_json.py -q",
			].join("\n"),
		);
		await Bun.write(
			`${cwd}/workflow-output/reproduction-baseline.json`,
			`${JSON.stringify(
				{
					exerciseSummary: {
						exercised: true,
						positiveSignals: ["passed-count"],
						negativeSignals: false,
						passedCounts: 266,
					},
				},
				null,
				2,
			)}\n`,
		);
		await Bun.write(
			`${cwd}/workflow-output/reproduction-variant.json`,
			`${JSON.stringify(
				{
					validationExerciseSummary: {
						exercised: true,
						positiveSignals: ["passed-count"],
						negativeSignals: false,
						passedCounts: 60,
					},
				},
				null,
				2,
			)}\n`,
		);
		await Bun.write(`${cwd}/workflow-output/reproduction-baseline.md`, "Exit code: 1\n3 failed, 266 passed\n");
		await Bun.write(`${cwd}/workflow-output/reproduction-variant.md`, "Exit code: 0\n60 passed\n");

		const result = await runExampleScript({
			cwd,
			previousCwd,
			nodeId: "archiveReproduction",
			scriptFileName: "archive-reproduction.js",
			scriptDir: RESEARCH_REPRODUCTION_SCRIPT_DIR,
			writes: ["/archive"],
			initialState: {
				reproduction: {
					status: "fail",
					exercised: true,
					exitCode: 1,
					evidencePath: "workflow-output/reproduction-baseline.json",
				},
				variant: {
					status: "pass",
					validationExercised: true,
					validationExitCode: 0,
					evidencePath: "workflow-output/reproduction-variant.json",
				},
				review: "terminal rejection: validation passed but reproduction command disproved the claim\nfinish",
			},
		});

		expect(result.scheduler.state.archive).toMatchObject({
			outcome: "rejected",
			reproduction: "fail",
			validation: "pass",
		});
		expect(await Bun.file(`${cwd}/workflow-output/reproduction-archive.md`).text()).toContain("Outcome: rejected");
	});

	it("accepts markdown validation command sections in agent build review tasks", async () => {
		using tempDir = TempDir.createSync("@omh-agent-loop-validation-section-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();

		await Bun.write(
			`${cwd}/task.md`,
			[
				"Objective:",
				"Accept common markdown task contracts.",
				"",
				"## Validation Command",
				"",
				"```sh",
				"echo validate",
				"```",
			].join("\n"),
		);

		const result = await runExampleScript({
			cwd,
			previousCwd,
			nodeId: "initializeLoop",
			scriptFileName: "initialize-loop.js",
			scriptDir: AGENT_BUILD_REVIEW_LOOP_SCRIPT_DIR,
			writes: ["/progress", "/runtime", "/semanticGuard"],
		});

		expect(result.scheduler.state.progress).toMatchObject({
			validationCommand: "echo validate",
			verification: "declared",
		});
		expect(await Bun.file(`${cwd}/workflow-output/initial-loop-snapshot.md`).text()).toContain("echo validate");
	});

	it("archives rejected agent build review loops as terminal outcomes, not script failures", async () => {
		using tempDir = TempDir.createSync("@omh-agent-loop-reject-archive-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();

		await Bun.write(
			`${cwd}/task.md`,
			[
				"Objective:",
				"Reject a blocked build/review loop without reporting a runtime crash.",
				"",
				"Validation Command:",
				"echo validate",
			].join("\n"),
		);
		await Bun.write(`${cwd}/workflow-output/setup-blocker.md`, "Validation cannot start in this environment.\n");

		const result = await runExampleScript({
			cwd,
			previousCwd,
			nodeId: "archiveLoop",
			scriptFileName: "archive-loop.js",
			scriptDir: AGENT_BUILD_REVIEW_LOOP_SCRIPT_DIR,
			writes: ["/archive"],
			initialState: {
				reviewRoute: {
					decision: "reject",
					reason: "validation setup blocker",
					reviewVerdict: "continue",
					setupBlockerEvidenceFiles: ["workflow-output/setup-blocker.md"],
				},
			},
		});

		expect(result.scheduler.activations.find(activation => activation.nodeId === "archiveLoop")?.status).toBe(
			"completed",
		);
		expect(result.scheduler.state.archive).toMatchObject({
			file: "workflow-output/final-agent-loop-reject.md",
			terminalDecision: "reject",
			evidenceFiles: ["workflow-output/setup-blocker.md"],
		});
		expect(await Bun.file(`${cwd}/workflow-output/tuple-state.json`).json()).toMatchObject({
			flow: "agent-build-review-loop",
			status: "rejected",
			terminal: true,
			verdict: "reject",
			final_artifact: "workflow-output/final-agent-loop-reject.md",
		});
	});

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

	it("does not require optional parallel lane archive references when canonical lane evidence exists", async () => {
		using tempDir = TempDir.createSync("@omh-parallel-review-optional-lane-archive-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();
		const tupleId = "P07-T03C-e5dab47a8-fd-cli-option-sync";
		const validationCommand = "echo validate";

		await Bun.write(
			`${cwd}/task.md`,
			[
				"Objective:",
				"Guard canonical lane evidence without requiring optional lane archives.",
				"",
				"Acceptance Criteria:",
				"- Strong review may cite optional lane archive suggestions.",
				"",
				"Validation Command:",
				validationCommand,
				"",
				"Lane Ownership:",
				"core owns source; tests owns validation; docs owns operator evidence.",
			].join("\n"),
		);
		await Bun.write(`${cwd}/manifest-entry.json`, `${JSON.stringify({ runId: tupleId }, null, 2)}\n`);
		await Bun.write(
			`${cwd}/workflow-output/core-lane-${tupleId}.json`,
			`${JSON.stringify({ tuple_id: tupleId, producer_node: "implementCore", status: "complete" }, null, 2)}\n`,
		);
		await Bun.write(
			`${cwd}/workflow-output/tests-lane-${tupleId}.json`,
			`${JSON.stringify({ tuple_id: tupleId, producer_node: "implementTests", status: "complete" }, null, 2)}\n`,
		);
		await Bun.write(
			`${cwd}/workflow-output/docs-lane-${tupleId}.json`,
			`${JSON.stringify({ tuple_id: tupleId, producer_node: "implementDocs", status: "complete" }, null, 2)}\n`,
		);
		await Bun.write(
			`${cwd}/workflow-output/integration-review-materialized-${tupleId}.json`,
			`${JSON.stringify({ tuple_id: tupleId, producer_node: "materializeIntegrationReview" }, null, 2)}\n`,
		);
		await Bun.write(
			`${cwd}/workflow-output/validation-${tupleId}.json`,
			`${JSON.stringify(
				{
					tuple_id: tupleId,
					producer_node: "runDeclaredValidation",
					producer_kind: "workflow-script",
					validation: {
						command: validationCommand,
						environment: {},
						result: "passed",
						status: "passed",
						exitCode: 0,
					},
				},
				null,
				2,
			)}\n`,
		);

		const result = await runExampleScript({
			cwd,
			previousCwd,
			nodeId: "evidenceContractGuard",
			scriptFileName: "evidence-contract-guard.js",
			writes: ["/evidenceContract"],
			initialState: {
				laneHardStopGuard: {
					status: "continue",
				},
				planHandoff: [
					`canonical core evidence workflow-output/core-lane-${tupleId}.json`,
					`optional core archive workflow-output/lane-archive-implementCore-${tupleId}.md`,
					`canonical tests evidence workflow-output/tests-lane-${tupleId}.json`,
					`optional tests archive workflow-output/lane-archive-implementTests-${tupleId}.md`,
				].join("\n"),
				reviewHandoff: {
					artifacts: [
						`workflow-output/docs-lane-${tupleId}.json`,
						`workflow-output/integration-review-materialized-${tupleId}.json`,
					],
				},
			},
		});

		expect(result.scheduler.state.evidenceContract).toMatchObject({
			verdict: "READY",
			checked_inputs: {
				missing_referenced_artifacts: [],
			},
		});
		expect(await Bun.file(`${cwd}/workflow-output/evidence-contract-guard-${tupleId}.json`).json()).toMatchObject({
			verdict: "READY",
			checked_inputs: {
				missing_referenced_artifacts: [],
			},
		});
	});

	it("accepts canonical parallel lane artifacts for legacy handoff aliases", async () => {
		using tempDir = TempDir.createSync("@omh-parallel-review-legacy-lane-aliases-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();
		const tupleId = "P07-T03D-e108bcf88-fd-follow-validation-repair";
		const validationCommand = "echo validate";

		await Bun.write(
			`${cwd}/task.md`,
			[
				"Objective:",
				"Accept canonical lane evidence when older planner handoffs cite previous lane artifact names.",
				"",
				"Validation Command:",
				validationCommand,
			].join("\n"),
		);
		await Bun.write(`${cwd}/manifest-entry.json`, `${JSON.stringify({ runId: tupleId }, null, 2)}\n`);
		await Bun.write(
			`${cwd}/workflow-output/core-lane-${tupleId}.json`,
			`${JSON.stringify({ tuple_id: tupleId, producer_node: "implementCore", status: "complete" }, null, 2)}\n`,
		);
		await Bun.write(
			`${cwd}/workflow-output/tests-lane-${tupleId}.json`,
			`${JSON.stringify({ tuple_id: tupleId, producer_node: "implementTests", status: "complete" }, null, 2)}\n`,
		);
		await Bun.write(
			`${cwd}/workflow-output/docs-lane-${tupleId}.json`,
			`${JSON.stringify({ tuple_id: tupleId, producer_node: "implementDocs", status: "complete" }, null, 2)}\n`,
		);
		await Bun.write(
			`${cwd}/workflow-output/lane-hard-stop-guard-${tupleId}.json`,
			`${JSON.stringify({ tuple_id: tupleId, producer_node: "laneHardStopGuard", status: "continue" }, null, 2)}\n`,
		);
		await Bun.write(
			`${cwd}/workflow-output/integration-review-materialized-${tupleId}.json`,
			`${JSON.stringify({ tuple_id: tupleId, producer_node: "materializeIntegrationReview" }, null, 2)}\n`,
		);
		await Bun.write(
			`${cwd}/workflow-output/validation-${tupleId}.json`,
			`${JSON.stringify(
				{
					tuple_id: tupleId,
					producer_node: "runDeclaredValidation",
					producer_kind: "workflow-script",
					validation: {
						command: validationCommand,
						environment: {},
						result: "passed",
						status: "passed",
						exitCode: 0,
					},
				},
				null,
				2,
			)}\n`,
		);

		const result = await runExampleScript({
			cwd,
			previousCwd,
			nodeId: "evidenceContractGuard",
			scriptFileName: "evidence-contract-guard.js",
			writes: ["/evidenceContract"],
			initialState: {
				laneHardStopGuard: {
					status: "continue",
				},
				planHandoff: [
					`legacy core evidence workflow-output/lane-implementCore-${tupleId}.json`,
					`canonical tests evidence workflow-output/tests-lane-${tupleId}.json`,
					`legacy docs evidence workflow-output/implementDocs-${tupleId}.json`,
					`legacy join evidence workflow-output/lane-archive-laneHardStopGuard-${tupleId}.md`,
					`optional reviewer notes workflow-output/reviewer-notes-${tupleId}.md`,
				].join("\n"),
				reviewHandoff: {
					artifacts: [
						`workflow-output/implementCore-${tupleId}.json`,
						`workflow-output/implementDocs-${tupleId}.json`,
						`workflow-output/integration-review-${tupleId}.json`,
					],
				},
			},
		});

		expect(result.scheduler.state.evidenceContract).toMatchObject({
			verdict: "READY",
			checked_inputs: {
				missing_referenced_artifacts: [],
			},
		});
		expect(await Bun.file(`${cwd}/workflow-output/evidence-contract-guard-${tupleId}.json`).json()).toMatchObject({
			verdict: "READY",
			checked_inputs: {
				missing_referenced_artifacts: [],
			},
		});
	});

	it("blocks parallel joins when required lane evidence is missing", async () => {
		using tempDir = TempDir.createSync("@omh-parallel-review-missing-lane-evidence-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();
		const tupleId = "P07-T03D-8a753f0ed-fd-follow-validation-repair";

		await Bun.write(`${cwd}/manifest-entry.json`, `${JSON.stringify({ runId: tupleId }, null, 2)}\n`);
		await Bun.write(
			`${cwd}/workflow-output/core-lane-${tupleId}.json`,
			`${JSON.stringify({ tuple_id: tupleId, producer_node: "implementCore", status: "complete" }, null, 2)}\n`,
		);
		await Bun.write(
			`${cwd}/workflow-output/docs-lane-${tupleId}.json`,
			`${JSON.stringify({ tuple_id: tupleId, producer_node: "implementDocs", status: "complete" }, null, 2)}\n`,
		);

		const result = await runExampleScript({
			cwd,
			previousCwd,
			nodeId: "laneHardStopGuard",
			scriptFileName: "lane-hard-stop-guard.js",
			writes: ["/laneHardStopGuard"],
		});

		expect(result.scheduler.state.laneHardStopGuard).toMatchObject({
			status: "hard_stop",
			missing_lane_artifacts: [{ lane: "implementTests" }],
		});
		expect(await Bun.file(`${cwd}/workflow-output/lane-hard-stop-guard-${tupleId}.json`).json()).toMatchObject({
			status: "hard_stop",
			missing_lane_artifacts: [{ lane: "implementTests" }],
		});
	});

	it("blocks parallel joins when any lane reports failed validation", async () => {
		using tempDir = TempDir.createSync("@omh-parallel-review-failed-lane-evidence-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();
		const tupleId = "P07-T03D-8a753f0ed-fd-follow-validation-repair";

		await Bun.write(`${cwd}/manifest-entry.json`, `${JSON.stringify({ runId: tupleId }, null, 2)}\n`);
		await Bun.write(
			`${cwd}/workflow-output/core-lane-${tupleId}.json`,
			`${JSON.stringify({ tuple_id: tupleId, producer_node: "implementCore", status: "complete" }, null, 2)}\n`,
		);
		await Bun.write(
			`${cwd}/workflow-output/tests-lane-${tupleId}.json`,
			`${JSON.stringify(
				{
					tuple_id: tupleId,
					producer_node: "implementTests",
					status: "validation_failed",
					validation: {
						result: "fail",
						exit_code: 101,
					},
				},
				null,
				2,
			)}\n`,
		);
		await Bun.write(
			`${cwd}/workflow-output/docs-lane-${tupleId}.json`,
			`${JSON.stringify({ tuple_id: tupleId, producer_node: "implementDocs", status: "complete" }, null, 2)}\n`,
		);

		const result = await runExampleScript({
			cwd,
			previousCwd,
			nodeId: "laneHardStopGuard",
			scriptFileName: "lane-hard-stop-guard.js",
			writes: ["/laneHardStopGuard"],
		});

		expect(result.scheduler.state.laneHardStopGuard).toMatchObject({
			status: "hard_stop",
			blocking_lane_artifacts: [
				{
					lane: "implementTests",
					file: `workflow-output/tests-lane-${tupleId}.json`,
					status: "validation_failed",
				},
			],
		});
		expect(await Bun.file(`${cwd}/workflow-output/lane-hard-stop-guard-${tupleId}.json`).json()).toMatchObject({
			status: "hard_stop",
			blocking_lane_artifacts: [
				{
					lane: "implementTests",
					file: `workflow-output/tests-lane-${tupleId}.json`,
				},
			],
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
		expect(prompt).toContain("You may update non-terminal workflow evidence artifacts");
		expect(prompt).toContain("workflow-output/human-scope-guard.md");
		expect(prompt).toContain("workflow-output/documentation-validation.md");
		expect(prompt).toContain("workflow-output/documentation-audit-archive.md");
		expect(prompt).toContain("workflow-output/review-decision.md");
		expect(prompt).toContain("workflow-output/final");
		expect(prompt).toContain("workflow-output/documentation-rollback.md");
		expect(prompt).toContain("Final response contract");
		expect(prompt).toContain("changed_files");
		expect(prompt).toContain("resolved_review_feedback");
		expect(prompt).toContain("rollback_notes");
	});

	it("blocks documentation patch validation when prior review feedback is unresolved", async () => {
		using tempDir = TempDir.createSync("@omh-documentation-review-repair-unresolved-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();

		const result = await runExampleScript({
			cwd,
			previousCwd,
			nodeId: "guardReviewRepair",
			scriptFileName: "guard-review-repair.js",
			scriptDir: DOCUMENTATION_AUDIT_SCRIPT_DIR,
			writes: ["/reviewRepair"],
			initialState: {
				review: "continue: restore the build_request url/base_url note before archiving",
				patch: {
					status: "patched",
					changed_files: ["httpx/_client.py"],
				},
			},
		});

		expect(result.scheduler.activations.find(activation => activation.nodeId === "guardReviewRepair")?.status).toBe(
			"failed",
		);
	});

	it("allows documentation patch validation when prior review feedback is resolved", async () => {
		using tempDir = TempDir.createSync("@omh-documentation-review-repair-resolved-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();

		const result = await runExampleScript({
			cwd,
			previousCwd,
			nodeId: "guardReviewRepair",
			scriptFileName: "guard-review-repair.js",
			scriptDir: DOCUMENTATION_AUDIT_SCRIPT_DIR,
			writes: ["/reviewRepair"],
			initialState: {
				review: "continue: restore the build_request url/base_url note before archiving",
				patch: {
					status: "patched",
					changed_files: ["httpx/_client.py"],
					resolved_review_feedback: [
						{
							feedback: "restore the build_request url/base_url note",
							evidence: "httpx/_client.py keeps that note and adds header precedence separately",
						},
					],
				},
			},
		});

		expect(result.scheduler.state.reviewRepair).toMatchObject({
			status: "pass",
			priorFeedbackRequired: true,
		});
		expect(await Bun.file(`${cwd}/workflow-output/documentation-review-repair.md`).text()).toContain(
			"priorFeedbackRequired: yes",
		);
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
			writes: ["/task", "/runtime", "/review", "/validation", "/validationStartup", "/patch"],
		});

		expect(result.scheduler.state.patch).toMatchObject({
			status: "not-run",
			summary: "No documentation repair has run yet.",
			changed_files: [],
			rollback_notes: [],
		});
		expect(result.scheduler.state.validationStartup).toMatchObject({
			status: "not-run",
			summary: "No documentation validation startup probe has run yet.",
		});

		const flow = await Bun.file(
			`${import.meta.dir}/../../../examples/workflow/experimental/documentation-audit/documentation-audit.omhflow`,
		).text();
		expect(flow).toMatch(/id:\s*precheckTaskContract[\s\S]*?writes:[\s\S]*?- \/validationStartup[\s\S]*?- \/patch/u);
	});

	it("fails documentation audit closed when validation cannot start", async () => {
		using tempDir = TempDir.createSync("@omh-documentation-audit-validation-start-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();

		const result = await runExampleScript({
			cwd,
			previousCwd,
			nodeId: "runDocsValidation",
			scriptFileName: "run-doc-validation.js",
			scriptDir: DOCUMENTATION_AUDIT_SCRIPT_DIR,
			writes: ["/validation"],
			initialState: {
				task: {
					validationCommand: "omh-definitely-missing-doc-validator",
				},
				patch: {
					status: "patched",
					changed_files: ["examples/error/index.js"],
				},
			},
		});

		expect(result.scheduler.activations.find(activation => activation.nodeId === "runDocsValidation")?.status).toBe(
			"failed",
		);
		const evidence = await Bun.file(`${cwd}/workflow-output/documentation-validation.md`).text();
		expect(evidence).toContain("Exit code: 127");
		expect(evidence).toContain("omh-definitely-missing-doc-validator");
		expect(evidence).toMatch(/not found|command not found/u);
	});

	it("fails documentation audit before fanout when validation cannot start", async () => {
		using tempDir = TempDir.createSync("@omh-documentation-audit-validation-startup-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();

		const result = await runExampleScript({
			cwd,
			previousCwd,
			nodeId: "checkValidationStartup",
			scriptFileName: "check-validation-startup.js",
			scriptDir: DOCUMENTATION_AUDIT_SCRIPT_DIR,
			writes: ["/validationStartup"],
			initialState: {
				task: {
					validationCommand: "omh-definitely-missing-doc-validator",
				},
			},
		});

		expect(
			result.scheduler.activations.find(activation => activation.nodeId === "checkValidationStartup")?.status,
		).toBe("failed");
		const evidence = await Bun.file(`${cwd}/workflow-output/documentation-validation-startup.md`).text();
		expect(evidence).toContain("Exit code: 127");
		expect(evidence).toContain("omh-definitely-missing-doc-validator");
		expect(evidence).toMatch(/not found|command not found/u);

		const flow = await Bun.file(
			`${import.meta.dir}/../../../examples/workflow/experimental/documentation-audit/documentation-audit.omhflow`,
		).text();
		expect(flow).toMatch(
			/id:\s*precheckTaskContract[\s\S]*?id:\s*checkValidationStartup[\s\S]*?id:\s*inventoryDocs/u,
		);
	});

	it("does not stop documentation audit startup probe on ordinary validation failure", async () => {
		using tempDir = TempDir.createSync("@omh-documentation-audit-validation-startable-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();

		const result = await runExampleScript({
			cwd,
			previousCwd,
			nodeId: "checkValidationStartup",
			scriptFileName: "check-validation-startup.js",
			scriptDir: DOCUMENTATION_AUDIT_SCRIPT_DIR,
			writes: ["/validationStartup"],
			initialState: {
				task: {
					validationCommand: "printf 'started validation\\n'; exit 1",
				},
			},
		});

		expect(
			result.scheduler.activations.find(activation => activation.nodeId === "checkValidationStartup")?.status,
		).toBe("completed");
		expect(result.scheduler.state.validationStartup).toMatchObject({
			status: "startable-command-failed",
			validationExitCode: 1,
		});
		const evidence = await Bun.file(`${cwd}/workflow-output/documentation-validation-startup.md`).text();
		expect(evidence).toContain("started validation");
		expect(evidence).toContain("Exit code: 1");
	});

	it("blocks documentation archive when prior review feedback has no patch resolution evidence", async () => {
		using tempDir = TempDir.createSync("@omh-documentation-audit-unresolved-review-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();
		const archiveScript = await Bun.file(`${DOCUMENTATION_AUDIT_SCRIPT_DIR}/archive-docs.js`).text();

		await Bun.write(
			`${cwd}/task.md`,
			["Objective:", "Repair stale docs without dropping unrelated documented behavior."].join("\n"),
		);
		await Bun.write(`${cwd}/workflow-output/documentation-validation.md`, "44 passed\n");
		await Bun.write(`${cwd}/workflow-output/documentation-rollback.md`, "Restore changed docs.\n");

		const result = await runExampleDefinition({
			cwd,
			previousCwd,
			initialState: {
				patch: {
					status: "patched",
					changed_files: ["httpx/_client.py"],
				},
				validation: {
					status: "pass",
				},
			},
			definition: {
				name: "documentation-review-resolution-guard",
				version: 1,
				models: { roles: {}, defaults: {} },
				nodes: [
					{
						id: "consistencyReview",
						type: "script",
						script: {
							language: "js",
							code: [
								"return {",
								"  verdict: 'continue',",
								"  summary: 'Restore the build_request url/base_url note before archiving.',",
								"  statePatch: [{ op: 'set', path: '/review', value: 'continue: restore build_request url/base_url note' }],",
								"};",
							].join("\n"),
						},
						writes: ["/review"],
					},
					{
						id: "archiveDocs",
						type: "script",
						script: {
							language: "js",
							code: archiveScript,
						},
						writes: ["/archive"],
					},
				],
				edges: [{ from: "consistencyReview", to: "archiveDocs" }],
			},
		});

		expect(result.scheduler.activations.find(activation => activation.nodeId === "archiveDocs")?.status).toBe(
			"failed",
		);
	});

	it("archives documentation audit when prior review feedback has explicit resolution evidence", async () => {
		using tempDir = TempDir.createSync("@omh-documentation-audit-resolved-review-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();
		const archiveScript = await Bun.file(`${DOCUMENTATION_AUDIT_SCRIPT_DIR}/archive-docs.js`).text();

		await Bun.write(
			`${cwd}/task.md`,
			["Objective:", "Repair stale docs without dropping unrelated documented behavior."].join("\n"),
		);
		await Bun.write(`${cwd}/workflow-output/documentation-validation.md`, "44 passed\n");
		await Bun.write(`${cwd}/workflow-output/documentation-rollback.md`, "Restore changed docs.\n");

		const result = await runExampleDefinition({
			cwd,
			previousCwd,
			initialState: {
				patch: {
					status: "patched",
					changed_files: ["httpx/_client.py"],
					resolved_review_feedback: [
						{
							feedback: "Restore the build_request url/base_url note.",
							evidence: "httpx/_client.py keeps the base_url bullet and adds header precedence separately.",
						},
					],
				},
				validation: {
					status: "pass",
				},
			},
			definition: {
				name: "documentation-review-resolution-guard",
				version: 1,
				models: { roles: {}, defaults: {} },
				nodes: [
					{
						id: "consistencyReview",
						type: "script",
						script: {
							language: "js",
							code: [
								"return {",
								"  verdict: 'continue',",
								"  summary: 'Restore the build_request url/base_url note before archiving.',",
								"  statePatch: [{ op: 'set', path: '/review', value: 'continue: restore build_request url/base_url note' }],",
								"};",
							].join("\n"),
						},
						writes: ["/review"],
					},
					{
						id: "archiveDocs",
						type: "script",
						script: {
							language: "js",
							code: archiveScript,
						},
						writes: ["/archive"],
					},
				],
				edges: [{ from: "consistencyReview", to: "archiveDocs" }],
			},
		});

		expect(result.scheduler.activations.find(activation => activation.nodeId === "archiveDocs")?.status).toBe(
			"completed",
		);
		expect(result.scheduler.state.archive).toMatchObject({
			validation: "pass",
		});
	});

	it("archives documentation rollback notes from patch evidence", async () => {
		using tempDir = TempDir.createSync("@omh-documentation-audit-patch-rollback-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();
		const archiveScript = await Bun.file(`${DOCUMENTATION_AUDIT_SCRIPT_DIR}/archive-docs.js`).text();

		await Bun.write(
			`${cwd}/task.md`,
			["Objective:", "Repair docs and carry rollback evidence into the archive."].join("\n"),
		);
		await Bun.write(`${cwd}/workflow-output/documentation-validation.md`, "44 passed\n");
		await Bun.write(
			`${cwd}/workflow-output/documentation-patch.md`,
			[
				"# Documentation Patch Evidence",
				"",
				"## Changed Files",
				"",
				"- `docs/advanced/clients.md`",
				"",
				"## Rollback Notes",
				"",
				"- Restore the previous header merge example in `docs/advanced/clients.md`.",
			].join("\n"),
		);

		const result = await runExampleDefinition({
			cwd,
			previousCwd,
			initialState: {
				patch: {
					status: "patched",
					changed_files: ["docs/advanced/clients.md"],
				},
				validation: {
					status: "pass",
				},
			},
			definition: {
				name: "documentation-archive-patch-rollback",
				version: 1,
				models: { roles: {}, defaults: {} },
				nodes: [
					{
						id: "archiveDocs",
						type: "script",
						script: {
							language: "js",
							code: archiveScript,
						},
						writes: ["/archive"],
					},
				],
				edges: [],
			},
		});

		expect(result.scheduler.activations.find(activation => activation.nodeId === "archiveDocs")?.status).toBe(
			"completed",
		);
		const archive = await Bun.file(`${cwd}/workflow-output/documentation-audit-archive.md`).text();
		expect(archive).toContain("Restore the previous header merge example");
		expect(archive).not.toContain("No rollback notes were present.");
	});

	it("archives documentation rollback note lines from patch evidence", async () => {
		using tempDir = TempDir.createSync("@omh-documentation-audit-patch-rollback-line-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();
		const archiveScript = await Bun.file(`${DOCUMENTATION_AUDIT_SCRIPT_DIR}/archive-docs.js`).text();

		await Bun.write(
			`${cwd}/task.md`,
			["Objective:", "Repair docs and carry a patch-scoped rollback line into the archive."].join("\n"),
		);
		await Bun.write(`${cwd}/workflow-output/documentation-validation.md`, "44 passed\n");
		await Bun.write(
			`${cwd}/workflow-output/documentation-patch.md`,
			[
				"# Documentation Patch Evidence",
				"",
				"Changed files: docs/advanced/clients.md",
				"Patch evidence: workflow-output/documentation-patch.md",
				"Rollback note: Restore the previous header merge wording in docs/advanced/clients.md.",
			].join("\n"),
		);

		const result = await runExampleDefinition({
			cwd,
			previousCwd,
			initialState: {
				patch: {
					status: "patched",
					changed_files: ["docs/advanced/clients.md", "workflow-output/documentation-patch.md"],
					patch_evidence: "workflow-output/documentation-patch.md",
				},
				validation: {
					status: "pass",
				},
			},
			definition: {
				name: "documentation-archive-patch-rollback-line",
				version: 1,
				models: { roles: {}, defaults: {} },
				nodes: [
					{
						id: "archiveDocs",
						type: "script",
						script: {
							language: "js",
							code: archiveScript,
						},
						writes: ["/archive"],
					},
				],
				edges: [],
			},
		});

		expect(result.scheduler.activations.find(activation => activation.nodeId === "archiveDocs")?.status).toBe(
			"completed",
		);
		const archive = await Bun.file(`${cwd}/workflow-output/documentation-audit-archive.md`).text();
		expect(archive).toContain("Restore the previous header merge wording");
		expect(result.scheduler.state.archive).toMatchObject({
			rollbackEvidence: "present",
		});
	});

	it("blocks documentation archive when changed files lack rollback evidence", async () => {
		using tempDir = TempDir.createSync("@omh-documentation-audit-missing-rollback-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();
		const archiveScript = await Bun.file(`${DOCUMENTATION_AUDIT_SCRIPT_DIR}/archive-docs.js`).text();

		await Bun.write(
			`${cwd}/task.md`,
			["Objective:", "Reject documentation archives that omit rollback evidence."].join("\n"),
		);
		await Bun.write(`${cwd}/workflow-output/documentation-validation.md`, "44 passed\n");

		const result = await runExampleDefinition({
			cwd,
			previousCwd,
			initialState: {
				patch: {
					status: "patched",
					changed_files: ["docs/advanced/clients.md"],
				},
				validation: {
					status: "pass",
				},
			},
			definition: {
				name: "documentation-archive-missing-rollback",
				version: 1,
				models: { roles: {}, defaults: {} },
				nodes: [
					{
						id: "archiveDocs",
						type: "script",
						script: {
							language: "js",
							code: archiveScript,
						},
						writes: ["/archive"],
					},
				],
				edges: [],
			},
		});

		expect(result.scheduler.activations.find(activation => activation.nodeId === "archiveDocs")?.status).toBe(
			"failed",
		);
	});

	it("blocks release archive when audit blockers lack repair or waiver evidence", async () => {
		using tempDir = TempDir.createSync("@omh-release-gate-blockers-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();

		await Bun.write(
			`${cwd}/workflow-output/release-audit.md`,
			[
				"# Release-Facing Audit Evidence",
				"",
				"## Compatibility-sensitive completion behavior audit",
				"",
				"Finding: release-facing docs and tests were inspected.",
			].join("\n"),
		);
		await Bun.write(
			`${cwd}/workflow-output/release-rollback.md`,
			["# Release Rollback Notes", "", "- Delete workflow-output artifacts if this attempt is abandoned."].join(
				"\n",
			),
		);

		const result = await runExampleScript({
			cwd,
			previousCwd,
			nodeId: "enforceReleaseGate",
			scriptFileName: "enforce-release-gate.js",
			scriptDir: RELEASE_HARDENING_SCRIPT_DIR,
			writes: ["/releaseGate"],
			initialState: {
				changelog: {
					findings: ["site/content/completions/zsh.md is stale and should block release until documented"],
				},
				compatibility: {
					risks: ["ArgAliases with OnlyValidArgs has a compatibility gap that needs repair or waiver"],
				},
				checks: {
					status: "pass",
					validationExitCode: 0,
					outputPath: "workflow-output/release-checks.md",
				},
				review: "finish",
			},
		});

		expect(result.scheduler.activations.find(activation => activation.nodeId === "enforceReleaseGate")?.status).toBe(
			"failed",
		);
		const gate = await Bun.file(`${cwd}/workflow-output/release-gate.md`).text();
		expect(gate).toContain("unresolved audit blocker");
		expect(gate).toContain("zsh.md is stale");
		expect(gate).toContain("ArgAliases");
	});

	it("marks undeclared release security checks as skipped instead of passed", async () => {
		using tempDir = TempDir.createSync("@omh-release-security-skipped-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();
		const taskText = ["Objective:", "Harden release checks.", "", "Validation Command:", "printf 'ok\\n'"].join("\n");
		await Bun.write(`${cwd}/task.md`, taskText);

		const result = await runExampleScript({
			cwd,
			previousCwd,
			nodeId: "runReleaseChecks",
			scriptFileName: "run-release-checks.js",
			scriptDir: RELEASE_HARDENING_SCRIPT_DIR,
			writes: ["/checks"],
			initialState: {
				task: {
					taskText,
					validationCommand: "printf 'ok\\n'",
				},
			},
		});

		expect(
			result.scheduler.activations.find(activation => activation.nodeId === "runReleaseChecks")?.output,
		).toMatchObject({
			summary: "ran release checks; validation=pass security=skipped",
		});
		expect(result.scheduler.state.checks).toMatchObject({
			status: "pass",
			securityStatus: "skipped",
		});
		expect(await Bun.file(`${cwd}/workflow-output/release-checks.md`).text()).toContain(
			"Security command: not declared",
		);
	});

	it("allows release archive when audit blockers have explicit waiver evidence", async () => {
		using tempDir = TempDir.createSync("@omh-release-gate-waived-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();

		await Bun.write(
			`${cwd}/workflow-output/release-audit.md`,
			[
				"# Release-Facing Audit Evidence",
				"",
				"## Waivers",
				"",
				"- Waived `site/content/completions/zsh.md` stale wording: implementation and shell-specific docs agree after inspection.",
				"- Waived `ArgAliases` compatibility gap: existing tests cover the release surface and no code/doc change is required.",
			].join("\n"),
		);
		await Bun.write(
			`${cwd}/workflow-output/release-rollback.md`,
			["# Release Rollback Notes", "", "- Delete workflow-output artifacts if this attempt is abandoned."].join(
				"\n",
			),
		);

		const result = await runExampleScript({
			cwd,
			previousCwd,
			nodeId: "enforceReleaseGate",
			scriptFileName: "enforce-release-gate.js",
			scriptDir: RELEASE_HARDENING_SCRIPT_DIR,
			writes: ["/releaseGate"],
			initialState: {
				changelog: {
					findings: ["site/content/completions/zsh.md is stale and should block release until documented"],
				},
				compatibility: {
					risks: ["ArgAliases with OnlyValidArgs has a compatibility gap that needs repair or waiver"],
				},
				checks: {
					status: "pass",
					validationExitCode: 0,
					outputPath: "workflow-output/release-checks.md",
				},
				review: "finish",
			},
		});

		expect(result.scheduler.state.releaseGate).toMatchObject({
			status: "pass",
			unresolvedBlockers: [],
		});
		expect(await Bun.file(`${cwd}/workflow-output/release-gate.md`).text()).toContain("status: pass");
	});

	it("allows release archive when structured audit blockers resolve through finding context", async () => {
		using tempDir = TempDir.createSync("@omh-release-gate-structured-context-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();

		await Bun.write(
			`${cwd}/workflow-output/release-audit.md`,
			[
				"# Release-Facing Audit Evidence",
				"",
				"## Compatibility-sensitive completion behavior audit",
				"",
				"Resolved stale completion documentation by updating site/content/completions/zsh.md.",
			].join("\n"),
		);
		await Bun.write(
			`${cwd}/workflow-output/release-rollback.md`,
			[
				"# Release Rollback Notes",
				"",
				"- Restore site/content/completions/zsh.md if this attempt is abandoned.",
			].join("\n"),
		);

		const result = await runExampleScript({
			cwd,
			previousCwd,
			nodeId: "enforceReleaseGate",
			scriptFileName: "enforce-release-gate.js",
			scriptDir: RELEASE_HARDENING_SCRIPT_DIR,
			writes: ["/releaseGate"],
			initialState: {
				compatibility: {
					risks: [
						{
							risk: "stale completion documentation in site/content/completions/zsh.md",
							details: "generated shell completion behavior is correct after the documentation repair",
							severity: "release-hold until docs are corrected or intentionally waived",
						},
					],
				},
				checks: {
					status: "pass",
					validationExitCode: 0,
					outputPath: "workflow-output/release-checks.md",
				},
				review: "finish",
			},
		});

		expect(result.scheduler.state.releaseGate).toMatchObject({
			status: "pass",
			unresolvedBlockers: [],
		});
		const gate = await Bun.file(`${cwd}/workflow-output/release-gate.md`).text();
		expect(gate).toContain("status: pass");
		expect(gate).toContain("audit_blockers: 1");
	});

	it("blocks no-code bug triage archives when cause evidence proposes a fix without reconciliation", async () => {
		using tempDir = TempDir.createSync("@omh-bug-triage-unreconciled-cause-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();

		await initializeCleanGitRepo(cwd);
		await Bun.write(
			`${cwd}/task.md`,
			["Objective:", "Investigate a parser boundary.", "", "No-Code Resolution: allowed"].join("\n"),
		);
		await Bun.write(`${cwd}/workflow-output/reproduction.md`, "19 passed\n");
		await Bun.write(`${cwd}/workflow-output/regression.md`, "821 passed\n");
		await Bun.write(`${cwd}/workflow-output/bugfix-rollback.md`, "No rollback needed for a no-code result.\n");
		await Bun.write(
			`${cwd}/workflow-output/no-bug-root-cause.md`,
			["# No-Bug Root-Cause Analysis", "", "The focused reproduction passed, so no patch is needed."].join("\n"),
		);

		const result = await runExampleScript({
			cwd,
			previousCwd,
			nodeId: "archiveBugfix",
			scriptFileName: "archive-bugfix.js",
			scriptDir: BUG_TRIAGE_REPRO_FIX_SCRIPT_DIR,
			writes: ["/archive"],
			initialState: {
				task: {
					taskText: "No-Code Resolution: allowed",
				},
				cause: {
					why_evidence_points_there: [
						"Focused reproduction showed invoked callbacks receive values but parameter source is None.",
					],
					narrowest_fix_boundary: [
						"Patch Context.invoke/Context.forward source bookkeeping and add narrow tests.",
					],
				},
				regression: {
					status: "pass",
				},
			},
		});

		expect(result.scheduler.activations.find(activation => activation.nodeId === "archiveBugfix")?.status).toBe(
			"failed",
		);
		expect(result.scheduler.state.archive).toBeUndefined();
	});

	it("allows no-code bug triage archives when cause evidence is explicitly reconciled", async () => {
		using tempDir = TempDir.createSync("@omh-bug-triage-reconciled-cause-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();

		await initializeCleanGitRepo(cwd);
		await Bun.write(
			`${cwd}/task.md`,
			["Objective:", "Investigate a parser boundary.", "", "No-Code Resolution: allowed"].join("\n"),
		);
		await Bun.write(`${cwd}/workflow-output/reproduction.md`, "19 passed\n");
		await Bun.write(`${cwd}/workflow-output/regression.md`, "821 passed\n");
		await Bun.write(`${cwd}/workflow-output/bugfix-rollback.md`, "No rollback needed for a no-code result.\n");
		await Bun.write(
			`${cwd}/workflow-output/no-bug-root-cause.md`,
			[
				"# No-Bug Root-Cause Analysis",
				"",
				"## Cause Reconciliation",
				"",
				"The isolateCause fix boundary is reconciled and rejected as a false positive: the focused",
				"reproduction and validation commands exercise the same Context.invoke/Context.forward",
				"parameter-source behavior, and the observed output explains why it is not a defect.",
			].join("\n"),
		);

		const result = await runExampleScript({
			cwd,
			previousCwd,
			nodeId: "archiveBugfix",
			scriptFileName: "archive-bugfix.js",
			scriptDir: BUG_TRIAGE_REPRO_FIX_SCRIPT_DIR,
			writes: ["/archive"],
			initialState: {
				task: {
					taskText: "No-Code Resolution: allowed",
				},
				cause: {
					why_evidence_points_there: [
						"Focused reproduction showed invoked callbacks receive values but parameter source is None.",
					],
					narrowest_fix_boundary: [
						"Patch Context.invoke/Context.forward source bookkeeping and add narrow tests.",
					],
				},
				regression: {
					status: "pass",
				},
			},
		});

		expect(result.scheduler.state.archive).toMatchObject({
			validation: "pass",
			projectChangedFiles: [],
		});
		const archive = await Bun.file(`${cwd}/workflow-output/bugfix-archive.md`).text();
		expect(archive).toContain("Cause Reconciliation");
	});

	it("keeps bug triage no-code prompts tied to cause reconciliation", async () => {
		const patchPrompt = await Bun.file(
			`${import.meta.dir}/../../../examples/workflow/experimental/bug-triage-repro-fix/bug-triage-repro-fix/prompts/patch-fix.md`,
		).text();
		const reviewPrompt = await Bun.file(
			`${import.meta.dir}/../../../examples/workflow/experimental/bug-triage-repro-fix/bug-triage-repro-fix/prompts/fix-review.md`,
		).text();

		for (const prompt of [patchPrompt, reviewPrompt]) {
			expect(prompt).toContain("Cause Reconciliation");
			expect(prompt).toContain("no-code");
			expect(prompt).toContain("isolateCause");
		}
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

	it("archives refactor migrations as rejected when only whitespace churn remains", async () => {
		using tempDir = TempDir.createSync("@omh-refactor-migration-whitespace-reject-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();

		await Bun.write(`${cwd}/src.py`, "def make_response(value):\n    return value\n");
		await Bun.write(
			`${cwd}/task.md`,
			[
				"Objective:",
				"Migrate response helper callers without leaving padding-only source churn.",
				"",
				"Validation Command:",
				"echo validation passed",
			].join("\n"),
		);
		await runGit(cwd, ["init"]);
		await runGit(cwd, ["config", "user.email", "omh@example.invalid"]);
		await runGit(cwd, ["config", "user.name", "OMH Test"]);
		await runGit(cwd, ["add", "src.py", "task.md"]);
		await runGit(cwd, ["commit", "-m", "baseline"]);
		await Bun.write(`${cwd}/src.py`, "def make_response(value):\n\n    return value\n");
		await Bun.write(
			`${cwd}/workflow-output/caller-migration.md`,
			["# Caller Migration", "", "Rollback notes: remove the temporary adapter if no callers need it."].join("\n"),
		);
		await Bun.write(
			`${cwd}/workflow-output/cleanup-dead-path.md`,
			[
				"# Cleanup",
				"",
				"Rollback notes: cleanup removed the temporary adapter, leaving only whitespace churn.",
			].join("\n"),
		);

		const result = await runExampleScript({
			cwd,
			previousCwd,
			nodeId: "archiveMigration",
			scriptFileName: "archive-migration.js",
			scriptDir: REFACTOR_MIGRATION_SCRIPT_DIR,
			writes: ["/archive"],
			initialState: {
				validation: {
					status: "pass",
					validationExitCode: 0,
				},
			},
		});

		expect(result.scheduler.state.archive).toMatchObject({
			status: "rejected",
			validation: "pass",
			materialProjectDiff: {
				status: "empty",
			},
		});
		const archive = await Bun.file(`${cwd}/workflow-output/refactor-migration-archive.md`).text();
		expect(archive).toContain("Outcome: rejected");
		expect(archive).toContain("No material project diff");
		expect(archive).toContain("remove the temporary adapter");
	});

	it("archives accepted refactor migrations with canonical rollback evidence", async () => {
		using tempDir = TempDir.createSync("@omh-refactor-migration-canonical-rollback-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();

		await Bun.write(`${cwd}/src.txt`, "baseline\n");
		await Bun.write(
			`${cwd}/task.md`,
			[
				"Objective:",
				"Archive material refactor migration evidence.",
				"",
				"Validation Command:",
				"echo validate",
			].join("\n"),
		);
		await runGit(cwd, ["init"]);
		await runGit(cwd, ["config", "user.email", "omh@example.invalid"]);
		await runGit(cwd, ["config", "user.name", "OMH Test"]);
		await runGit(cwd, ["add", "src.txt", "task.md"]);
		await runGit(cwd, ["commit", "-m", "baseline"]);
		await Bun.write(`${cwd}/src.txt`, "material migration\n");
		await Bun.write(
			`${cwd}/workflow-output/refactor-migration-validation.md`,
			["# Validation", "", "Exit code: 0"].join("\n"),
		);
		await Bun.write(
			`${cwd}/workflow-output/compatibility-design.md`,
			["# Compatibility Design", "", "Rollback: restore src.txt to baseline."].join("\n"),
		);
		await Bun.write(
			`${cwd}/workflow-output/refactor-migration-cleanup.md`,
			["# Cleanup", "", "Rollback notes: no cleanup-only files were changed."].join("\n"),
		);
		await Bun.write(
			`${cwd}/workflow-output/migration-caller-step.json`,
			`${JSON.stringify(
				{
					status: "complete",
					changed_files: [
						{
							path: "src.txt",
							rollback_note: "Restore src.txt if the caller migration regresses.",
						},
					],
				},
				null,
				2,
			)}\n`,
		);

		const result = await runExampleScript({
			cwd,
			previousCwd,
			nodeId: "archiveMigration",
			scriptFileName: "archive-migration.js",
			scriptDir: REFACTOR_MIGRATION_SCRIPT_DIR,
			writes: ["/archive"],
			initialState: {
				validation: {
					status: "pass",
				},
			},
		});

		expect(result.scheduler.state.archive).toMatchObject({
			status: "accepted",
			validation: "pass",
			rollbackEvidenceFiles: [
				"workflow-output/compatibility-design.md",
				"workflow-output/migration-caller-step.json",
				"workflow-output/refactor-migration-cleanup.md",
			],
		});
		const archive = await Bun.file(`${cwd}/workflow-output/refactor-migration-archive.md`).text();
		expect(archive).toContain("Outcome: accepted");
		expect(archive).toContain("workflow-output/compatibility-design.md");
		expect(archive).toContain("workflow-output/migration-caller-step.json");
		expect(archive).not.toContain("No rollback notes were present");
	});

	it("blocks accepted refactor migrations without rollback evidence", async () => {
		using tempDir = TempDir.createSync("@omh-refactor-migration-missing-rollback-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();

		await Bun.write(`${cwd}/src.txt`, "baseline\n");
		await Bun.write(
			`${cwd}/task.md`,
			[
				"Objective:",
				"Reject material refactor migration archive without rollback evidence.",
				"",
				"Validation Command:",
				"echo validate",
			].join("\n"),
		);
		await runGit(cwd, ["init"]);
		await runGit(cwd, ["config", "user.email", "omh@example.invalid"]);
		await runGit(cwd, ["config", "user.name", "OMH Test"]);
		await runGit(cwd, ["add", "src.txt", "task.md"]);
		await runGit(cwd, ["commit", "-m", "baseline"]);
		await Bun.write(`${cwd}/src.txt`, "material migration\n");
		await Bun.write(
			`${cwd}/workflow-output/refactor-migration-validation.md`,
			["# Validation", "", "Exit code: 0"].join("\n"),
		);

		const result = await runExampleScript({
			cwd,
			previousCwd,
			nodeId: "archiveMigration",
			scriptFileName: "archive-migration.js",
			scriptDir: REFACTOR_MIGRATION_SCRIPT_DIR,
			writes: ["/archive"],
			initialState: {
				validation: {
					status: "pass",
				},
			},
		});

		expect(result.scheduler.activations.find(activation => activation.nodeId === "archiveMigration")?.status).toBe(
			"failed",
		);
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

async function initializeCleanGitRepo(cwd: string): Promise<void> {
	await runGit(cwd, ["init"]);
	await runGit(cwd, ["config", "user.email", "omh@example.invalid"]);
	await runGit(cwd, ["config", "user.name", "OMH Test"]);
	await Bun.write(`${cwd}/README.md`, "test repo\n");
	await runGit(cwd, ["add", "README.md"]);
	await runGit(cwd, ["commit", "-m", "init"]);
}
