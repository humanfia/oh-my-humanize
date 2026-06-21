import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import { validateWorkflowActivationOutput } from "../../src/workflow/state";

interface ScriptResult {
	summary: string;
	verdict?: string;
	artifacts?: string[];
	statePatch?: Array<{
		op: "set";
		path: string;
		value: unknown;
	}>;
	data?: {
		artifact?: string;
		producer_node?: string;
		preexisting_final_artifacts?: Array<{
			original: string;
			quarantine: string;
		}>;
		validation?: {
			environment?: Record<string, string>;
			runtime_environment?: Record<string, string>;
			result?: string;
			exitCode?: number;
			stdoutArtifact?: string;
			stderrArtifact?: string;
		};
		checked_inputs?: {
			generic_validation_aliases?: string[];
			integration_artifacts?: string[];
			premature_decision_artifacts?: string[];
			failed_validation_artifacts?: string[];
			lane_hard_stop_artifacts?: string[];
			ignored_nonterminal_lane_hard_stop_artifacts?: string[];
			rollback_artifacts?: string[];
			missing_rollback_files?: string[];
		};
	};
}

interface WorkflowContext {
	activation: {
		id: string;
	};
	completedActivations: unknown[];
	state?: object;
}

const ScriptFunctionConstructor = Object.getPrototypeOf(async () => {}).constructor as new (
	workflowContextName: string,
	code: string,
) => (workflowContext: WorkflowContext) => Promise<ScriptResult>;

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("parallel-implementation-review flow contract", () => {
	it("records task contracts with a workflow-owned finalization rule", async () => {
		const cwd = await createTempDir();
		await Bun.write(
			path.join(cwd, "task.md"),
			[
				"Objective:",
				"Improve routing path evidence.",
				"Acceptance Criteria:",
				"- If files change, the final archive must map every changed file to validation and rollback.",
				"Validation Command:",
				"npm test",
				"Lane Ownership:",
				"implementation lane owns source; test lane owns regression; docs lane owns evidence.",
				"Stop Conditions:",
				"Stop on unresolved setup blockers.",
			].join("\n"),
		);

		const result = await runScript(cwd, "precheck-task-contract.js", {});
		const taskContract = result.statePatch?.find(patch => patch.path === "/taskContract")?.value;

		expect(typeof taskContract).toBe("string");
		expect(taskContract).toContain("Workflow-owned finalization rule");
		expect(taskContract).toContain("final archive");
		expect(taskContract).toContain("finalizer node");
		expect(taskContract).toContain("must not write workflow-output artifacts whose basename starts with `final-`");
	});

	it("writes tuple-scoped validation stdout and stderr artifacts without generic txt aliases", async () => {
		const cwd = await createTempDir();
		await writeTupleFiles(cwd, "P06-T06-test");
		await Bun.write(path.join(cwd, "task.md"), "Validation Command:\ntrue\n");
		await fs.mkdir(path.join(cwd, "workflow-output"), { recursive: true });

		const result = await runScript(cwd, "run-declared-validation.js", {});

		expect(result.data?.validation).toMatchObject({
			stdoutArtifact: "workflow-output/validation-P06-T06-test.stdout",
			stderrArtifact: "workflow-output/validation-P06-T06-test.stderr",
		});
		expect(await fileExists(path.join(cwd, "workflow-output", "validation-P06-T06-test.stdout"))).toBe(true);
		expect(await fileExists(path.join(cwd, "workflow-output", "validation-P06-T06-test.stderr"))).toBe(true);
		expect(await fileExists(path.join(cwd, "workflow-output", "validation-P06-T06-test.stdout.txt"))).toBe(false);
		expect(await fileExists(path.join(cwd, "workflow-output", "validation-P06-T06-test.stderr.txt"))).toBe(false);
	});

	it("uses an OS temp directory for validation when the task does not declare temp vars", async () => {
		const cwd = await createTempDir();
		await writeTupleFiles(cwd, "P06-T06-test");
		await Bun.write(path.join(cwd, "task.md"), "Validation Command:\nprintf '%s' \"$TMPDIR\"\n");
		await fs.mkdir(path.join(cwd, "workflow-output"), { recursive: true });

		const result = await runScript(cwd, "run-declared-validation.js", {});

		expect(result.verdict).toBe("PASS");
		expect(result.data?.validation?.environment).toEqual({});
		expect(result.data?.validation?.runtime_environment?.TMPDIR).toStartWith(
			path.join(os.tmpdir(), "omh-validation-"),
		);
		expect(result.data?.validation?.runtime_environment?.TMPDIR).not.toStartWith(cwd);
		const stdout = await Bun.file(path.join(cwd, "workflow-output", "validation-P06-T06-test.stdout")).text();
		expect(stdout).toStartWith(path.join(os.tmpdir(), "omh-validation-"));
		expect(stdout).not.toStartWith(cwd);
	});

	it("preserves declared validation temp vars while controlling undeclared temp vars", async () => {
		const cwd = await createTempDir();
		await writeTupleFiles(cwd, "P06-T06-test");
		await Bun.write(
			path.join(cwd, "task.md"),
			"Validation Command:\nprintf '%s' \"$TMPDIR\"\nValidation Environment:\nTMPDIR=workflow-output/declared-tmp\n",
		);
		await fs.mkdir(path.join(cwd, "workflow-output"), { recursive: true });

		const result = await runScript(cwd, "run-declared-validation.js", {});

		expect(result.verdict).toBe("PASS");
		expect(result.data?.validation?.environment).toEqual({ TMPDIR: "workflow-output/declared-tmp" });
		expect(result.data?.validation?.runtime_environment?.TMPDIR).toBe("workflow-output/declared-tmp");
		expect(await fileExists(path.join(cwd, "workflow-output", "declared-tmp", ".omh-validation-tmp"))).toBe(true);
		const stdout = await Bun.file(path.join(cwd, "workflow-output", "validation-P06-T06-test.stdout")).text();
		expect(stdout).toBe("workflow-output/declared-tmp");
	});

	it("records failed declared validation as structured evidence instead of throwing", async () => {
		const cwd = await createTempDir();
		await writeTupleFiles(cwd, "P06-T06-test");
		await Bun.write(path.join(cwd, "task.md"), "Validation Command:\nfalse\n");
		await fs.mkdir(path.join(cwd, "workflow-output"), { recursive: true });

		const result = await runScript(cwd, "run-declared-validation.js", {});

		expect(result.verdict).toBe("FAIL");
		expect(result.data).toMatchObject({
			artifact: "workflow-output/validation-P06-T06-test.json",
			producer_node: "runDeclaredValidation",
			validation: {
				result: "failed",
				exitCode: 1,
			},
		});
		await expect(
			Bun.file(path.join(cwd, "workflow-output", "validation-P06-T06-test.json")).json(),
		).resolves.toMatchObject({
			validation: {
				result: "failed",
				exitCode: 1,
			},
		});
	});

	it("reports generic validation aliases as repair evidence before strong review", async () => {
		const cwd = await createTempDir();
		await writeReadyEvidence(cwd, "P06-T06-test");
		await Bun.write(path.join(cwd, "workflow-output", "validation.txt"), "generic validation alias\n");

		const result = await runScript(cwd, "evidence-contract-guard.js", {});

		expect(result.verdict).toBe("REPAIR");
		expect(result.data?.checked_inputs?.generic_validation_aliases).toEqual(["workflow-output/validation.txt"]);
		await expect(
			Bun.file(path.join(cwd, "workflow-output", "evidence-contract-guard-P06-T06-test.json")).json(),
		).resolves.toMatchObject({
			verdict: "REPAIR",
			checked_inputs: {
				generic_validation_aliases: ["workflow-output/validation.txt"],
			},
		});
	});

	it("reports any premature final namespace artifact as repair evidence before strong review", async () => {
		const cwd = await createTempDir();
		await writeReadyEvidence(cwd, "P06-T06-test");
		await Bun.write(path.join(cwd, "workflow-output", "P06-T06-test-final-validation.json"), "{}\n");

		const result = await runScript(cwd, "evidence-contract-guard.js", {});

		expect(result.verdict).toBe("REPAIR");
		expect(result.data?.checked_inputs?.premature_decision_artifacts).toEqual([
			"workflow-output/P06-T06-test-final-validation.json",
		]);
		await expect(
			Bun.file(path.join(cwd, "workflow-output", "evidence-contract-guard-P06-T06-test.json")).json(),
		).resolves.toMatchObject({
			verdict: "REPAIR",
			checked_inputs: {
				premature_decision_artifacts: ["workflow-output/P06-T06-test-final-validation.json"],
			},
		});
	});

	it("materializes tuple-scoped integration review evidence from the completed review activation", async () => {
		const cwd = await createTempDir();
		await writeTupleFiles(cwd, "P06-T06-test");
		await fs.mkdir(path.join(cwd, "workflow-output"), { recursive: true });
		await Bun.write(path.join(cwd, "workflow-output", "core-lane-P06-T06-test.json"), "{}\n");
		await Bun.write(path.join(cwd, "workflow-output", "tests-lane-P06-T06-test.json"), "{}\n");
		await Bun.write(path.join(cwd, "workflow-output", "docs-lane-P06-T06-test.json"), "{}\n");

		const result = await runScript(cwd, "materialize-integration-review.js", {
			completedActivations: [
				{
					id: "activation-integration",
					nodeId: "integrationReview",
					graphRevisionId: "graph",
					status: "completed",
					parentActivationIds: [],
					output: {
						summary: "integration reviewed tracked and untracked files",
						data: { reviewer: "integration" },
						artifacts: ["workflow-output/reviewer-note.txt"],
					},
				},
			],
		});

		expect(result.verdict).toBe("materialized");
		expect(result.data).toMatchObject({
			artifact: "workflow-output/integration-review-materialized-P06-T06-test.json",
			producer_node: "materializeIntegrationReview",
			status: "materialized",
			review_activation: {
				node_id: "integrationReview",
				summary: "integration reviewed tracked and untracked files",
			},
			lane_artifacts: [
				"workflow-output/core-lane-P06-T06-test.json",
				"workflow-output/docs-lane-P06-T06-test.json",
				"workflow-output/tests-lane-P06-T06-test.json",
			],
		});
		await expect(
			Bun.file(path.join(cwd, "workflow-output", "integration-review-materialized-P06-T06-test.json")).json(),
		).resolves.toMatchObject({
			status: "materialized",
			producer_node: "materializeIntegrationReview",
		});
		expect(() => validateWorkflowActivationOutput(result)).not.toThrow();
	});

	it("accepts materialized integration review evidence for the evidence contract", async () => {
		const cwd = await createTempDir();
		await writeReadyEvidence(cwd, "P06-T06-test", { integrationReviewArtifact: false });
		await runScript(cwd, "materialize-integration-review.js", {
			completedActivations: [
				{
					id: "activation-integration",
					nodeId: "integrationReview",
					graphRevisionId: "graph",
					status: "completed",
					parentActivationIds: [],
					output: {
						summary: "integration reviewed all lanes",
					},
				},
			],
		});

		const result = await runScript(cwd, "evidence-contract-guard.js", {});

		expect(result.verdict).toBe("READY");
		expect(result.data?.checked_inputs?.integration_artifacts).toEqual([
			"workflow-output/integration-review-materialized-P06-T06-test.json",
		]);
	});

	it("requires rollback evidence to cover every changed project file after parallel lanes join", async () => {
		const cwd = await createTempDir();
		await initGitRepo(cwd);
		await fs.mkdir(path.join(cwd, "src"), { recursive: true });
		await fs.mkdir(path.join(cwd, "tests"), { recursive: true });
		await Bun.write(path.join(cwd, "src", "walk.rs"), "fn walk() {}\n");
		await Bun.write(path.join(cwd, "tests", "tests.rs"), "test baseline\n");
		await $`git add src/walk.rs tests/tests.rs`.cwd(cwd).quiet();
		await $`git -c user.name=omh-test -c user.email=omh-test@example.invalid commit -m baseline`.cwd(cwd).quiet();
		await Bun.write(path.join(cwd, "src", "walk.rs"), "fn walk() { /* changed */ }\n");
		await Bun.write(path.join(cwd, "tests", "tests.rs"), "test baseline\ntest new behavior\n");
		await writeReadyEvidence(cwd, "P06-T06-test");
		await Bun.write(
			path.join(cwd, "workflow-output", "rollback-P06-T06-test.md"),
			"Rollback steps:\n- Revert src/walk.rs to restore traversal behavior.\n",
		);

		const result = await runScript(cwd, "evidence-contract-guard.js", {});

		expect(result.verdict).toBe("REPAIR");
		expect(result.data?.checked_inputs?.rollback_artifacts).toEqual(["workflow-output/rollback-P06-T06-test.md"]);
		expect(result.data?.checked_inputs?.missing_rollback_files).toEqual(["tests/tests.rs"]);
	});

	it("materializes final rollback coverage for every changed project file before evidence guard", async () => {
		const cwd = await createTempDir();
		await initGitRepo(cwd);
		await fs.mkdir(path.join(cwd, "src"), { recursive: true });
		await fs.mkdir(path.join(cwd, "tests"), { recursive: true });
		await Bun.write(path.join(cwd, "src", "walk.rs"), "fn walk() {}\n");
		await Bun.write(path.join(cwd, "tests", "tests.rs"), "test baseline\n");
		await $`git add src/walk.rs tests/tests.rs`.cwd(cwd).quiet();
		await $`git -c user.name=omh-test -c user.email=omh-test@example.invalid commit -m baseline`.cwd(cwd).quiet();
		await Bun.write(path.join(cwd, "src", "walk.rs"), "fn walk() { /* changed */ }\n");
		await Bun.write(path.join(cwd, "tests", "tests.rs"), "test baseline\ntest new behavior\n");
		await writeReadyEvidence(cwd, "P06-T06-test");
		await Bun.write(
			path.join(cwd, "workflow-output", "rollback-P06-T06-test.md"),
			"Rollback steps:\n- Revert src/walk.rs to restore traversal behavior.\n",
		);

		const rollbackResult = await runScript(cwd, "finalize-rollback-coverage.js", {});
		const guardResult = await runScript(cwd, "evidence-contract-guard.js", {});

		expect(rollbackResult.verdict).toBe("ready");
		expect(rollbackResult.data).toMatchObject({
			artifact: "workflow-output/final-rollback-coverage-P06-T06-test.md",
			producer_node: "finalizeRollbackCoverage",
			changed_files: ["src/walk.rs", "tests/tests.rs"],
		});
		const rollbackText = await Bun.file(
			path.join(cwd, "workflow-output", "final-rollback-coverage-P06-T06-test.md"),
		).text();
		expect(rollbackText).toContain("src/walk.rs");
		expect(rollbackText).toContain("tests/tests.rs");
		expect(guardResult.verdict).toBe("READY");
		expect(guardResult.data?.checked_inputs?.missing_rollback_files).toEqual([]);
	});

	it("lets finalization reject failed declared validation through the evidence contract path", async () => {
		const cwd = await createTempDir();
		await writeTupleFiles(cwd, "P06-T06-test");
		await Bun.write(path.join(cwd, "task.md"), "Validation Command:\nfalse\n");
		await fs.mkdir(path.join(cwd, "workflow-output"), { recursive: true });
		await Bun.write(path.join(cwd, "workflow-output", "core-lane-P06-T06-test.json"), "{}\n");
		await Bun.write(path.join(cwd, "workflow-output", "tests-lane-P06-T06-test.json"), "{}\n");
		await Bun.write(path.join(cwd, "workflow-output", "docs-lane-P06-T06-test.json"), "{}\n");
		await Bun.write(path.join(cwd, "workflow-output", "integration-review-P06-T06-test.json"), "{}\n");
		await runScript(cwd, "run-declared-validation.js", {});

		const guardResult = await runScript(cwd, "evidence-contract-guard.js", {});
		const finalResult = await runScript(cwd, "finalize-strong-review.js", {
			state: {
				verdict: { verdict: "promote" },
				evidenceContract: guardResult.data,
			},
		});

		expect(guardResult.verdict).toBe("REPAIR");
		expect(guardResult.data?.checked_inputs?.failed_validation_artifacts).toEqual([
			"workflow-output/validation-P06-T06-test.json",
		]);
		expect(finalResult.verdict).toBe("reject");
		await expect(Bun.file(path.join(cwd, "workflow-output", "tuple-state.json")).json()).resolves.toMatchObject({
			status: "rejected",
			terminal: true,
			verdict: "reject",
			evidence_contract_verdict: "REPAIR",
		});
	});

	it("finalizes into a final-review artifact instead of claiming strongReview provenance", async () => {
		const cwd = await createTempDir();
		await writeReadyEvidence(cwd, "P06-T06-test");

		const result = await runScript(cwd, "finalize-strong-review.js", {
			state: {
				verdict: { verdict: "promote" },
				evidenceContract: { verdict: "READY" },
			},
		});

		expect(result.data).toMatchObject({
			artifact: "workflow-output/final-review-P06-T06-test.json",
			producer_node: "finalizeStrongReview",
		});
		expect(await fileExists(path.join(cwd, "workflow-output", "final-review-P06-T06-test.json"))).toBe(true);
		expect(await fileExists(path.join(cwd, "workflow-output", "strong-review-P06-T06-test.json"))).toBe(false);
		await expect(Bun.file(path.join(cwd, "workflow-output", "tuple-state.json")).json()).resolves.toMatchObject({
			tuple_id: "P06-T06-test",
			flow: "parallel-implementation-review",
			status: "completed",
			terminal: true,
			final_artifact: "workflow-output/final-review-P06-T06-test.json",
		});
	});

	it("finalizer fails closed when evidence contract is not ready", async () => {
		const cwd = await createTempDir();
		await writeReadyEvidence(cwd, "P06-T06-test");

		const result = await runScript(cwd, "finalize-strong-review.js", {
			state: {
				verdict: { verdict: "promote" },
				evidenceContract: { verdict: "REPAIR", reasons: ["premature final namespace artifact"] },
			},
		});

		expect(result.verdict).toBe("reject");
		expect(result.data).toMatchObject({
			producer_node: "finalizeStrongReview",
			strong_review: {
				verdict: "reject",
				accepted: false,
			},
			evidence_contract: {
				verdict: "REPAIR",
			},
		});
		await expect(Bun.file(path.join(cwd, "workflow-output", "tuple-state.json")).json()).resolves.toMatchObject({
			status: "rejected",
			terminal: true,
			verdict: "reject",
			evidence_contract_verdict: "REPAIR",
		});
	});

	it("finalizer preserves preexisting final artifacts before writing workflow-owned output", async () => {
		const cwd = await createTempDir();
		await writeReadyEvidence(cwd, "P06-T06-test");
		await Bun.write(
			path.join(cwd, "workflow-output", "final-review-P06-T06-test.json"),
			`${JSON.stringify({ producer_node: "integrationReview", note: "premature review artifact" })}\n`,
		);
		await Bun.write(
			path.join(cwd, "workflow-output", "P06-T06-test-final-archive.md"),
			"# premature archive\n\nProducer: docs lane\n",
		);

		const result = await runScript(cwd, "finalize-strong-review.js", {
			state: {
				verdict: { verdict: "promote" },
				evidenceContract: {
					verdict: "REPAIR",
					checked_inputs: {
						premature_decision_artifacts: [
							"workflow-output/final-review-P06-T06-test.json",
							"workflow-output/P06-T06-test-final-archive.md",
						],
					},
				},
			},
		});

		expect(result.verdict).toBe("reject");
		expect(result.data?.preexisting_final_artifacts).toEqual([
			{
				original: "workflow-output/final-review-P06-T06-test.json",
				quarantine: "workflow-output/quarantined-premature-final-artifacts/final-review-P06-T06-test.json",
			},
			{
				original: "workflow-output/P06-T06-test-final-archive.md",
				quarantine: "workflow-output/quarantined-premature-final-artifacts/P06-T06-test-final-archive.md",
			},
		]);
		await expect(
			Bun.file(
				path.join(
					cwd,
					"workflow-output",
					"quarantined-premature-final-artifacts",
					"final-review-P06-T06-test.json",
				),
			).json(),
		).resolves.toMatchObject({
			producer_node: "integrationReview",
			note: "premature review artifact",
		});
		await expect(
			Bun.file(path.join(cwd, "workflow-output", "final-review-P06-T06-test.json")).json(),
		).resolves.toMatchObject({
			producer_node: "finalizeStrongReview",
			strong_review: {
				verdict: "reject",
			},
		});
	});

	it("allows integration review when no lane reports a hard stop", async () => {
		const cwd = await createTempDir();
		await writeTupleFiles(cwd, "P06-T06-test");
		await fs.mkdir(path.join(cwd, "workflow-output"), { recursive: true });

		const result = await runScript(cwd, "lane-hard-stop-guard.js", {});

		expect(result.verdict).toBe("continue");
		expect(result.data).toMatchObject({
			artifact: "workflow-output/lane-hard-stop-guard-P06-T06-test.json",
			producer_node: "laneHardStopGuard",
		});
	});

	it("records lane hard stops as repairable contract evidence instead of failing the attempt", async () => {
		const cwd = await createTempDir();
		await writeTupleFiles(cwd, "P06-T06-test");
		await fs.mkdir(path.join(cwd, "workflow-output"), { recursive: true });
		await Bun.write(
			path.join(cwd, "workflow-output", "lane-hard-stop-P06-T06-test.json"),
			`${JSON.stringify({
				tuple_id: "P06-T06-test",
				producer_node: "implementCore",
				status: "hard_stop",
				terminal_scope: "workflow",
				reason: "prior feature::f1414_no_require_git semantic failure reproduced",
			})}\n`,
		);

		const result = await runScript(cwd, "lane-hard-stop-guard.js", {});

		expect(result.verdict).toBe("hard_stop");
		const guardArtifact = await Bun.file(
			path.join(cwd, "workflow-output", "lane-hard-stop-guard-P06-T06-test.json"),
		).json();
		expect(guardArtifact).toMatchObject({
			tuple_id: "P06-T06-test",
			producer_node: "laneHardStopGuard",
			status: "hard_stop",
		});
		expect(await fileExists(path.join(cwd, "workflow-output", "tuple-state.json"))).toBe(false);
	});

	it("lets finalization reject active lane hard stops through the evidence contract path", async () => {
		const cwd = await createTempDir();
		await writeReadyEvidence(cwd, "P06-T06-test");
		await Bun.write(
			path.join(cwd, "workflow-output", "lane-hard-stop-P06-T06-test.json"),
			`${JSON.stringify({
				tuple_id: "P06-T06-test",
				producer_node: "implementTests",
				status: "hard_stop",
				terminal_scope: "workflow",
				reason: "declared validation environment mismatch",
			})}\n`,
		);
		await runScript(cwd, "lane-hard-stop-guard.js", {});

		const guardResult = await runScript(cwd, "evidence-contract-guard.js", {});
		const finalResult = await runScript(cwd, "finalize-strong-review.js", {
			state: {
				verdict: { verdict: "promote" },
				evidenceContract: guardResult.data,
			},
		});

		expect(guardResult.verdict).toBe("REPAIR");
		expect(guardResult.data?.checked_inputs?.lane_hard_stop_artifacts).toEqual([
			"workflow-output/lane-hard-stop-P06-T06-test.json",
		]);
		expect(finalResult.verdict).toBe("reject");
		await expect(Bun.file(path.join(cwd, "workflow-output", "tuple-state.json")).json()).resolves.toMatchObject({
			tuple_id: "P06-T06-test",
			flow: "parallel-implementation-review",
			status: "rejected",
			terminal: true,
			verdict: "reject",
			evidence_contract_verdict: "REPAIR",
		});
	});

	it("lets evidence contract ignore lane-local validation hard stops", async () => {
		const cwd = await createTempDir();
		await writeReadyEvidence(cwd, "P06-T06-test");
		await Bun.write(
			path.join(cwd, "workflow-output", "lane-hard-stop-P06-T06-test.json"),
			`${JSON.stringify({
				tuple_id: "P06-T06-test",
				producer_node: "implementCore",
				status: "hard_stop",
				terminal_scope: "lane",
				reason:
					"lane-shell cargo test failed because TMPDIR was task-local; runDeclaredValidation owns final validation evidence",
			})}\n`,
		);

		const result = await runScript(cwd, "evidence-contract-guard.js", {});

		expect(result.verdict).toBe("READY");
		expect(result.data?.checked_inputs?.lane_hard_stop_artifacts).toEqual([]);
		expect(result.data?.checked_inputs?.ignored_nonterminal_lane_hard_stop_artifacts).toEqual([
			"workflow-output/lane-hard-stop-P06-T06-test.json",
		]);
	});

	it("ignores a lane hard stop only when a superseding evidence artifact exists", async () => {
		const cwd = await createTempDir();
		await writeTupleFiles(cwd, "P06-T06-test");
		await fs.mkdir(path.join(cwd, "workflow-output"), { recursive: true });
		await Bun.write(path.join(cwd, "workflow-output", "core-lane-P06-T06-test-resolution.json"), "{}\n");
		await Bun.write(
			path.join(cwd, "workflow-output", "lane-hard-stop-P06-T06-test.json"),
			`${JSON.stringify({
				tuple_id: "P06-T06-test",
				producer_node: "implementCore",
				status: "hard_stop",
				terminal_scope: "workflow",
				reason: "historical validation environment blocker",
				superseded_by: "workflow-output/core-lane-P06-T06-test-resolution.json",
			})}\n`,
		);

		const result = await runScript(cwd, "lane-hard-stop-guard.js", {});

		expect(result.verdict).toBe("continue");
		const guardArtifact = await Bun.file(
			path.join(cwd, "workflow-output", "lane-hard-stop-guard-P06-T06-test.json"),
		).json();
		expect(guardArtifact).toMatchObject({
			status: "continue",
			hard_stop_artifacts: [],
			ignored_historical_hard_stop_artifacts: ["workflow-output/lane-hard-stop-P06-T06-test.json"],
		});
		expect(await fileExists(path.join(cwd, "workflow-output", "tuple-state.json"))).toBe(false);
	});

	it("ignores lane-local validation hard stops that do not claim workflow terminal scope", async () => {
		const cwd = await createTempDir();
		await writeTupleFiles(cwd, "P06-T06-test");
		await fs.mkdir(path.join(cwd, "workflow-output"), { recursive: true });
		await Bun.write(
			path.join(cwd, "workflow-output", "lane-hard-stop-P06-T06-test.json"),
			`${JSON.stringify({
				tuple_id: "P06-T06-test",
				producer_node: "implementCore",
				status: "hard_stop",
				terminal_scope: "lane",
				reason:
					"lane-shell cargo test failed because TMPDIR was task-local; the dedicated validation runner evidence owns the workflow-level decision",
			})}\n`,
		);

		const result = await runScript(cwd, "lane-hard-stop-guard.js", {});

		expect(result.verdict).toBe("continue");
		const guardArtifact = await Bun.file(
			path.join(cwd, "workflow-output", "lane-hard-stop-guard-P06-T06-test.json"),
		).json();
		expect(guardArtifact).toMatchObject({
			status: "continue",
			hard_stop_artifacts: [],
			ignored_nonterminal_hard_stop_artifacts: ["workflow-output/lane-hard-stop-P06-T06-test.json"],
		});
	});
});

async function runScript(cwd: string, scriptName: string, context: Partial<WorkflowContext>): Promise<ScriptResult> {
	const scriptPath = path.resolve(
		import.meta.dir,
		"../../examples/workflow/experimental/parallel-implementation-review/parallel-implementation-review/scripts",
		scriptName,
	);
	const script = await Bun.file(scriptPath).text();
	const execute = new ScriptFunctionConstructor("workflowContext", script);
	const originalCwd = process.cwd();
	try {
		process.chdir(cwd);
		return await execute({
			activation: { id: `activation-${scriptName}` },
			completedActivations: [],
			...context,
		});
	} finally {
		process.chdir(originalCwd);
	}
}

async function writeReadyEvidence(
	cwd: string,
	tupleId: string,
	options: { integrationReviewArtifact?: boolean } = {},
): Promise<void> {
	await writeTupleFiles(cwd, tupleId);
	await Bun.write(path.join(cwd, "task.md"), "Validation Command:\ntrue\n");
	await fs.mkdir(path.join(cwd, "workflow-output"), { recursive: true });
	await Bun.write(path.join(cwd, "workflow-output", `core-lane-${tupleId}.json`), "{}\n");
	await Bun.write(path.join(cwd, "workflow-output", `tests-lane-${tupleId}.json`), "{}\n");
	await Bun.write(path.join(cwd, "workflow-output", `docs-lane-${tupleId}.json`), "{}\n");
	if (options.integrationReviewArtifact !== false) {
		await Bun.write(path.join(cwd, "workflow-output", `integration-review-${tupleId}.json`), "{}\n");
	}
	await Bun.write(
		path.join(cwd, "workflow-output", `validation-${tupleId}.json`),
		`${JSON.stringify(
			{
				tuple_id: tupleId,
				artifact: `workflow-output/validation-${tupleId}.json`,
				producer_node: "runDeclaredValidation",
				producer_kind: "workflow-script",
				validation: {
					command: "true",
					environment: {},
					result: "passed",
					status: "passed",
					exitCode: 0,
					stdoutArtifact: `workflow-output/validation-${tupleId}.stdout`,
					stderrArtifact: `workflow-output/validation-${tupleId}.stderr`,
				},
			},
			null,
			2,
		)}\n`,
	);
}

async function writeTupleFiles(cwd: string, tupleId: string): Promise<void> {
	await Bun.write(path.join(cwd, "monitor-assignment.json"), `${JSON.stringify({ tupleId })}\n`);
}

async function initGitRepo(cwd: string): Promise<void> {
	await $`git init`.cwd(cwd).quiet();
}

async function createTempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omh-parallel-contract-"));
	tempDirs.push(dir);
	return dir;
}

async function fileExists(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}
