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
		reasons?: string[];
		validation_command?: string;
		validation_environment?: Record<string, string>;
		review_handoff_artifact?: string;
		review_handoff_bytes?: number;
		preexisting_final_artifacts?: Array<{
			original: string;
			quarantine: string;
		}>;
		reserved_final_artifacts?: string[];
		quarantined_reserved_final_artifacts?: Array<{
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
			exitCodeArtifact?: string;
			reusedFromTestLane?: string;
			reusedArtifactHashes?: Record<string, string>;
			reusedCoverageProfiles?: Array<{ path: string; sha256: string }>;
		};
		checked_inputs?: {
			final_validation_artifacts?: string[];
			generic_validation_aliases?: string[];
			integration_artifacts?: string[];
			premature_decision_artifacts?: string[];
			reserved_final_artifacts?: string[];
			quarantined_reserved_final_artifacts?: Array<{
				original: string;
				quarantine: string;
			}>;
			failed_validation_artifacts?: string[];
			superseded_failed_validation_artifacts?: string[];
			trusted_failed_final_validation_artifacts?: string[];
			trusted_final_validation_artifacts?: string[];
			validation_attempt_log_findings?: Array<{
				file: string;
				reason: string;
				missing_files?: string[];
			}>;
			lane_hard_stop_artifacts?: string[];
			ignored_nonterminal_lane_hard_stop_artifacts?: string[];
			mechanical_surface_inventory_artifacts?: string[];
			rollback_artifacts?: string[];
			missing_rollback_files?: string[];
			stale_validation_hash_artifacts?: string[];
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
		expect(taskContract).toContain("Workflow evidence quality rule");
		expect(taskContract).toContain("final archive");
		expect(taskContract).toContain("finalizer node");
		expect(taskContract).toContain("Mechanical inventories from parsed file names");
		expect(taskContract).toContain("index-only");
		expect(taskContract).toContain("must not write workflow-output artifacts whose basename starts with `final-`");
		expect(taskContract).toContain("Archive evidence package means lane-owned evidence, not final archive");
		expect(taskContract).toContain("workflow-output/lane-archive-<lane>-<tuple-id>.md");
	});

	it("fails closed instead of rerunning declared validation when test-lane evidence is missing", async () => {
		const cwd = await createTempDir();
		await writeTupleFiles(cwd, "P06-T06-test");
		await Bun.write(
			path.join(cwd, "task.md"),
			"Validation Command:\nbash -lc 'echo rerun > workflow-output/rerun-marker'\n",
		);
		await fs.mkdir(path.join(cwd, "workflow-output"), { recursive: true });

		await expect(runScript(cwd, "run-declared-validation.js", {})).rejects.toThrow(
			/reusable test-lane declared validation evidence/u,
		);
		expect(await fileExists(path.join(cwd, "workflow-output", "rerun-marker"))).toBe(false);
	});

	it("reuses exact passed test-lane validation when tuple-scoped artifact hashes still match", async () => {
		const cwd = await createTempDir();
		await initGitRepo(cwd);
		await writeTupleFiles(cwd, "P06-T06-test");
		await fs.mkdir(path.join(cwd, "workflow-output"), { recursive: true });
		await Bun.write(
			path.join(cwd, "task.md"),
			[
				"Validation Command:",
				"bash -lc 'echo should-not-rerun > workflow-output/rerun-marker; exit 42'",
				"Validation Environment:",
				"TMPDIR=workflow-output/reuse-tmp",
			].join("\n"),
		);
		await Bun.write(path.join(cwd, "workflow-output", "test-validation-P06-T06-test.stdout"), "passed once\n");
		await Bun.write(path.join(cwd, "workflow-output", "test-validation-P06-T06-test.stderr"), "");
		await Bun.write(path.join(cwd, "workflow-output", "test-validation-P06-T06-test.exitcode"), "0\n");
		await Bun.write(path.join(cwd, "workflow-output", "unit-cover-P06-T06-test.out"), "mode: atomic\n");
		const laneArtifact = {
			tuple_id: "P06-T06-test",
			producer_node: "implementTests",
			status: "completed",
			validation: {
				command: "bash -lc 'echo should-not-rerun > workflow-output/rerun-marker; exit 42'",
				environment: { TMPDIR: "workflow-output/reuse-tmp" },
				result: "pass",
				exit_code: 0,
				stdout_path: "workflow-output/test-validation-P06-T06-test.stdout",
				stderr_path: "workflow-output/test-validation-P06-T06-test.stderr",
				exit_code_path: "workflow-output/test-validation-P06-T06-test.exitcode",
			},
			artifact_hashes: {
				"workflow-output/test-validation-P06-T06-test.stdout": await sha256File(
					path.join(cwd, "workflow-output", "test-validation-P06-T06-test.stdout"),
				),
				"workflow-output/test-validation-P06-T06-test.stderr": await sha256File(
					path.join(cwd, "workflow-output", "test-validation-P06-T06-test.stderr"),
				),
				"workflow-output/test-validation-P06-T06-test.exitcode": await sha256File(
					path.join(cwd, "workflow-output", "test-validation-P06-T06-test.exitcode"),
				),
			},
			coverage_profiles: [
				{
					path: "workflow-output/unit-cover-P06-T06-test.out",
					sha256: await sha256File(path.join(cwd, "workflow-output", "unit-cover-P06-T06-test.out")),
				},
			],
		};
		await Bun.write(
			path.join(cwd, "workflow-output", "tests-lane-P06-T06-test.json"),
			`${JSON.stringify(laneArtifact, null, 2)}\n`,
		);

		const result = await runScript(cwd, "run-declared-validation.js", {});

		expect(result.verdict).toBe("PASS");
		expect(result.data?.validation).toMatchObject({
			result: "passed",
			exitCode: 0,
			stdoutArtifact: "workflow-output/test-validation-P06-T06-test.stdout",
			stderrArtifact: "workflow-output/test-validation-P06-T06-test.stderr",
			reusedFromTestLane: "workflow-output/tests-lane-P06-T06-test.json",
		});
		expect(await fileExists(path.join(cwd, "workflow-output", "rerun-marker"))).toBe(false);
		expect(await sha256File(path.join(cwd, "workflow-output", "unit-cover-P06-T06-test.out"))).toBe(
			laneArtifact.coverage_profiles[0]?.sha256,
		);
	});

	it("reuses latest attempt validation evidence after real product changes", async () => {
		const cwd = await createTempDir();
		await initGitRepo(cwd);
		await writeTupleFiles(cwd, "P06-T06-test");
		await fs.mkdir(path.join(cwd, "src"), { recursive: true });
		await fs.mkdir(path.join(cwd, "workflow-output"), { recursive: true });
		const command = "bash -lc 'echo should-not-rerun > workflow-output/rerun-marker; exit 42'";
		await Bun.write(
			path.join(cwd, "task.md"),
			["Validation Command:", command, "Validation Environment:", "TMPDIR=workflow-output/reuse-tmp"].join("\n"),
		);
		await Bun.write(path.join(cwd, "src", "real-change.ts"), "export const fixed = true;\n");
		await Bun.write(path.join(cwd, "workflow-output", "validation-attempt-1-stdout-P06-T06-test.txt"), "baseline\n");
		await Bun.write(path.join(cwd, "workflow-output", "validation-attempt-1-stderr-P06-T06-test.txt"), "");
		await Bun.write(path.join(cwd, "workflow-output", "validation-attempt-1-exitcode-P06-T06-test.txt"), "0\n");
		await Bun.write(path.join(cwd, "workflow-output", "validation-attempt-2-stdout-P06-T06-test.txt"), "latest\n");
		await Bun.write(path.join(cwd, "workflow-output", "validation-attempt-2-stderr-P06-T06-test.txt"), "");
		await Bun.write(path.join(cwd, "workflow-output", "validation-attempt-2-exitcode-P06-T06-test.txt"), "0\n");
		await Bun.write(path.join(cwd, "workflow-output", "race-cover-P06-T06-test.out"), "mode: atomic\n");
		await Bun.write(
			path.join(cwd, "workflow-output", "tests-lane-P06-T06-test.json"),
			`${JSON.stringify(
				{
					tuple_id: "P06-T06-test",
					producer_node: "implementTests",
					status: "complete",
					result: "pass",
					validation: {
						command,
						environment: { TMPDIR: "workflow-output/reuse-tmp" },
						result: "pass",
						latest_attempt: 2,
						latest_stdout: "workflow-output/validation-attempt-2-stdout-P06-T06-test.txt",
						latest_stderr: "workflow-output/validation-attempt-2-stderr-P06-T06-test.txt",
						latest_exit_code: "workflow-output/validation-attempt-2-exitcode-P06-T06-test.txt",
						attempts: [
							{
								attempt: 1,
								result: "pass",
								stdout: "workflow-output/validation-attempt-1-stdout-P06-T06-test.txt",
								stderr: "workflow-output/validation-attempt-1-stderr-P06-T06-test.txt",
								exit_code: "workflow-output/validation-attempt-1-exitcode-P06-T06-test.txt",
							},
							{
								attempt: 2,
								result: "pass",
								stdout: "workflow-output/validation-attempt-2-stdout-P06-T06-test.txt",
								stderr: "workflow-output/validation-attempt-2-stderr-P06-T06-test.txt",
								exit_code: "workflow-output/validation-attempt-2-exitcode-P06-T06-test.txt",
							},
						],
					},
				},
				null,
				2,
			)}\n`,
		);

		const result = await runScript(cwd, "run-declared-validation.js", {});

		expect(result.verdict).toBe("PASS");
		expect(result.data?.validation).toMatchObject({
			result: "passed",
			exitCode: 0,
			stdoutArtifact: "workflow-output/validation-attempt-2-stdout-P06-T06-test.txt",
			stderrArtifact: "workflow-output/validation-attempt-2-stderr-P06-T06-test.txt",
			exitCodeArtifact: "workflow-output/validation-attempt-2-exitcode-P06-T06-test.txt",
			reusedFromTestLane: "workflow-output/tests-lane-P06-T06-test.json",
		});
		expect(result.data?.validation?.reusedArtifactHashes).toMatchObject({
			"workflow-output/validation-attempt-2-stdout-P06-T06-test.txt": await sha256File(
				path.join(cwd, "workflow-output", "validation-attempt-2-stdout-P06-T06-test.txt"),
			),
			"workflow-output/race-cover-P06-T06-test.out": await sha256File(
				path.join(cwd, "workflow-output", "race-cover-P06-T06-test.out"),
			),
		});
		expect(await fileExists(path.join(cwd, "workflow-output", "rerun-marker"))).toBe(false);
	});

	it("reuses validation evidence with test-lane file hash and exit-code file aliases", async () => {
		const cwd = await createTempDir();
		await writeTupleFiles(cwd, "P06-T06-test");
		await fs.mkdir(path.join(cwd, "workflow-output"), { recursive: true });
		const command = "bash -lc 'echo should-not-rerun > workflow-output/rerun-marker; exit 42'";
		const environment = { GOTMPDIR: "/tmp/omh-parallel-validation-node" };
		await Bun.write(
			path.join(cwd, "task.md"),
			["Validation Command:", command, "Validation Environment:", "GOTMPDIR=/tmp/omh-parallel-validation-node"].join(
				"\n",
			),
		);
		const stdoutPath = "workflow-output/validation-attempt-1-stdout-P06-T06-test.txt";
		const stderrPath = "workflow-output/validation-attempt-1-stderr-P06-T06-test.txt";
		const exitCodePath = "workflow-output/validation-attempt-1-exitcode-P06-T06-test.txt";
		const coveragePath = "workflow-output/scheduler-runtime-race-cover-P06-T06-test.out";
		await Bun.write(path.join(cwd, stdoutPath), "scheduler validation passed\n");
		await Bun.write(path.join(cwd, stderrPath), "");
		await Bun.write(path.join(cwd, exitCodePath), "0\n");
		await Bun.write(path.join(cwd, coveragePath), "mode: atomic\n");
		const fileHashes: Record<string, string> = {};
		for (const filePath of [stdoutPath, stderrPath, exitCodePath, coveragePath]) {
			fileHashes[filePath] = await sha256File(path.join(cwd, filePath));
		}
		await Bun.write(
			path.join(cwd, "workflow-output", "tests-lane-P06-T06-test.json"),
			`${JSON.stringify(
				{
					tuple_id: "P06-T06-test",
					producer_node: "implementTests",
					status: "complete",
					validation: {
						command,
						environment,
						result: "pass",
						exit_code: 0,
					},
					validation_attempts: [
						{
							attempt: 1,
							stdout: stdoutPath,
							stderr: stderrPath,
							exit_code_file: exitCodePath,
							exit_code: 0,
							result: "pass",
						},
					],
					file_hashes_sha256: fileHashes,
					coverage_profiles: [{ path: coveragePath, sha256: fileHashes[coveragePath] }],
				},
				null,
				2,
			)}\n`,
		);

		const result = await runScript(cwd, "run-declared-validation.js", {});

		expect(result.verdict).toBe("PASS");
		expect(result.data?.validation).toMatchObject({
			result: "passed",
			exitCode: 0,
			stdoutArtifact: stdoutPath,
			stderrArtifact: stderrPath,
			exitCodeArtifact: exitCodePath,
			reusedFromTestLane: "workflow-output/tests-lane-P06-T06-test.json",
		});
		expect(result.data?.validation?.reusedArtifactHashes).toMatchObject({
			[stdoutPath]: fileHashes[stdoutPath],
			[exitCodePath]: fileHashes[exitCodePath],
			[coveragePath]: fileHashes[coveragePath],
		});
		expect(result.data?.validation?.reusedCoverageProfiles).toEqual([
			{ path: coveragePath, sha256: fileHashes[coveragePath] },
		]);
		expect(await fileExists(path.join(cwd, "workflow-output", "rerun-marker"))).toBe(false);
	});

	it("reuses validation attempt aliases emitted by the test lane", async () => {
		const cwd = await createTempDir();
		await writeTupleFiles(cwd, "P06-T06-test");
		await fs.mkdir(path.join(cwd, "workflow-output"), { recursive: true });
		const command = "bash -lc 'echo should-not-rerun > workflow-output/rerun-marker; exit 42'";
		await Bun.write(path.join(cwd, "task.md"), `Validation Command:\n${command}\n`);
		await Bun.write(path.join(cwd, "workflow-output", "validation-attempt-1-stdout-P06-T06-test.txt"), "passed\n");
		await Bun.write(path.join(cwd, "workflow-output", "validation-attempt-1-stderr-P06-T06-test.txt"), "");
		await Bun.write(path.join(cwd, "workflow-output", "validation-attempt-1-exitcode-P06-T06-test.txt"), "0\n");
		await Bun.write(path.join(cwd, "workflow-output", "validation-stdout-P06-T06-test.txt"), "passed\n");
		await Bun.write(path.join(cwd, "workflow-output", "validation-stderr-P06-T06-test.txt"), "");
		await Bun.write(path.join(cwd, "workflow-output", "validation-exitcode-P06-T06-test.txt"), "0\n");
		await Bun.write(path.join(cwd, "workflow-output", "unit-cover-P06-T06-test.out"), "mode: atomic\n");
		const hashPaths = [
			"workflow-output/validation-attempt-1-stdout-P06-T06-test.txt",
			"workflow-output/validation-attempt-1-stderr-P06-T06-test.txt",
			"workflow-output/validation-attempt-1-exitcode-P06-T06-test.txt",
		];
		const artifactHashes: Record<string, string> = {};
		for (const file of hashPaths) {
			artifactHashes[file] = await sha256File(path.join(cwd, file));
		}
		await Bun.write(
			path.join(cwd, "workflow-output", "tests-lane-P06-T06-test.json"),
			`${JSON.stringify(
				{
					tuple_id: "P06-T06-test",
					producer_node: "implementTests",
					status: "complete",
					lane: "tests",
					validation: {
						command,
						environment: {},
						result: "pass",
						exit_code: 0,
						attempts: [
							{
								attempt: 1,
								stdout: "workflow-output/validation-attempt-1-stdout-P06-T06-test.txt",
								stderr: "workflow-output/validation-attempt-1-stderr-P06-T06-test.txt",
								exitcode: "workflow-output/validation-attempt-1-exitcode-P06-T06-test.txt",
								exit_code_value: 0,
								result: "pass",
							},
						],
						latest_aliases: {
							stdout: "workflow-output/validation-stdout-P06-T06-test.txt",
							stderr: "workflow-output/validation-stderr-P06-T06-test.txt",
							exitcode: "workflow-output/validation-exitcode-P06-T06-test.txt",
						},
						coverage_profiles: ["workflow-output/unit-cover-P06-T06-test.out"],
					},
					artifact_hashes_sha256: artifactHashes,
				},
				null,
				2,
			)}\n`,
		);

		const result = await runScript(cwd, "run-declared-validation.js", {});

		expect(result.verdict).toBe("PASS");
		expect(result.data?.validation).toMatchObject({
			result: "passed",
			exitCode: 0,
			stdoutArtifact: "workflow-output/validation-attempt-1-stdout-P06-T06-test.txt",
			stderrArtifact: "workflow-output/validation-attempt-1-stderr-P06-T06-test.txt",
			exitCodeArtifact: "workflow-output/validation-attempt-1-exitcode-P06-T06-test.txt",
			reusedFromTestLane: "workflow-output/tests-lane-P06-T06-test.json",
		});
		expect(result.data?.validation?.reusedArtifactHashes).toMatchObject(artifactHashes);
		expect(await fileExists(path.join(cwd, "workflow-output", "rerun-marker"))).toBe(false);
	});

	it("reuses tuple-scoped declared validation when task command and environment are markdown-coded", async () => {
		const cwd = await createTempDir();
		const tupleId = "C92-K8S-PAR-test";
		await writeTupleFiles(cwd, tupleId);
		await fs.mkdir(path.join(cwd, "workflow-output"), { recursive: true });
		await Bun.write(
			path.join(cwd, "task.md"),
			[
				"Validation Command:",
				"`./workflow-output/run-k8s-deep-validation.sh`",
				"",
				"Validation Environment",
				"",
				"- `GOTMPDIR=/tmp/omh-run-tmp/C92-K8S-PAR-test/go-tmp`",
				"- `GOCACHE=/tmp/omh-cache/go-build`",
				"- `GOMODCACHE=/tmp/omh-cache/go-mod`",
			].join("\n"),
		);
		for (const attempt of [1, 2, 3]) {
			await Bun.write(path.join(cwd, `workflow-output/validation-attempt-${attempt}-stdout-${tupleId}.txt`), "ok\n");
			await Bun.write(path.join(cwd, `workflow-output/validation-attempt-${attempt}-stderr-${tupleId}.txt`), "");
			await Bun.write(
				path.join(cwd, `workflow-output/validation-attempt-${attempt}-exitcode-${tupleId}.txt`),
				attempt === 3 ? "0\n" : "1\n",
			);
		}
		await Bun.write(path.join(cwd, `workflow-output/scheduler-deep-coverage-${tupleId}.out`), "mode: atomic\n");
		await Bun.write(
			path.join(cwd, `workflow-output/tests-lane-${tupleId}.json`),
			`${JSON.stringify(
				{
					tuple_id: tupleId,
					producer_node: "implementTests",
					status: "complete",
					declared_validation: {
						command: "./workflow-output/run-k8s-deep-validation.sh",
						environment: {
							GOTMPDIR: "/tmp/omh-run-tmp/C92-K8S-PAR-test/go-tmp",
							GOCACHE: "/tmp/omh-cache/go-build",
							GOMODCACHE: "/tmp/omh-cache/go-mod",
						},
						result: "pass",
						latest_valid_attempt: 3,
					},
					validation_attempts: [
						{
							attempt: 1,
							result: "fail",
							stdout: `workflow-output/validation-attempt-1-stdout-${tupleId}.txt`,
							stderr: `workflow-output/validation-attempt-1-stderr-${tupleId}.txt`,
							exitcode: `workflow-output/validation-attempt-1-exitcode-${tupleId}.txt`,
						},
						{
							attempt: 2,
							result: "fail",
							stdout: `workflow-output/validation-attempt-2-stdout-${tupleId}.txt`,
							stderr: `workflow-output/validation-attempt-2-stderr-${tupleId}.txt`,
							exitcode: `workflow-output/validation-attempt-2-exitcode-${tupleId}.txt`,
						},
						{
							attempt: 3,
							result: "pass",
							stdout: `workflow-output/validation-attempt-3-stdout-${tupleId}.txt`,
							stderr: `workflow-output/validation-attempt-3-stderr-${tupleId}.txt`,
							exitcode: `workflow-output/validation-attempt-3-exitcode-${tupleId}.txt`,
						},
					],
				},
				null,
				2,
			)}\n`,
		);

		const result = await runScript(cwd, "run-declared-validation.js", {});

		expect(result.verdict).toBe("PASS");
		expect(result.summary).toContain("reused exact passed test-lane evidence");
		expect(result.data?.validation).toMatchObject({
			command: "./workflow-output/run-k8s-deep-validation.sh",
			environment: {
				GOTMPDIR: "/tmp/omh-run-tmp/C92-K8S-PAR-test/go-tmp",
				GOCACHE: "/tmp/omh-cache/go-build",
				GOMODCACHE: "/tmp/omh-cache/go-mod",
			},
			result: "passed",
			exitCode: 0,
			stdoutArtifact: `workflow-output/validation-attempt-3-stdout-${tupleId}.txt`,
			stderrArtifact: `workflow-output/validation-attempt-3-stderr-${tupleId}.txt`,
			exitCodeArtifact: `workflow-output/validation-attempt-3-exitcode-${tupleId}.txt`,
			reusedFromTestLane: `workflow-output/tests-lane-${tupleId}.json`,
		});
		expect(result.data?.validation?.reusedCoverageProfiles).toEqual([
			{
				path: `workflow-output/scheduler-deep-coverage-${tupleId}.out`,
				sha256: await sha256File(path.join(cwd, `workflow-output/scheduler-deep-coverage-${tupleId}.out`)),
			},
		]);
	});

	it("reuses C92-style test-lane latest attempt aliases without rerunning", async () => {
		const cwd = await createTempDir();
		const tupleId = "C92R3-K8S-PAR-test";
		const command = "./workflow-output/run-k8s-deep-validation.sh";
		const environment = {
			GOTMPDIR: "/tmp/omh-run-tmp/C92R3-K8S-PAR-test/go-tmp",
			GOCACHE: "/tmp/omh-cache/go-build",
			GOMODCACHE: "/tmp/omh-cache/go-mod",
		};
		await writeTupleFiles(cwd, tupleId);
		await fs.mkdir(path.join(cwd, "workflow-output"), { recursive: true });
		await Bun.write(
			path.join(cwd, "task.md"),
			[
				"Validation Command:",
				command,
				"Validation Environment:",
				Object.entries(environment)
					.map(([key, value]) => `${key}=${value}`)
					.join(" "),
			].join("\n"),
		);
		await Bun.write(path.join(cwd, `workflow-output/validation-attempt-4-stdout-${tupleId}.txt`), "ok\n");
		await Bun.write(path.join(cwd, `workflow-output/validation-attempt-4-stderr-${tupleId}.txt`), "");
		await Bun.write(path.join(cwd, `workflow-output/validation-attempt-4-exitcode-${tupleId}.txt`), "0\n");
		await Bun.write(path.join(cwd, `workflow-output/scheduler-deep-coverage-${tupleId}.out`), "mode: atomic\n");
		await Bun.write(
			path.join(cwd, `workflow-output/validation-attempt-4-metadata-${tupleId}.json`),
			`${JSON.stringify(
				{
					attempt: 4,
					command,
					environment,
					exit_code: 0,
					result: "pass",
					evidence_paths: {
						stdout: `workflow-output/validation-attempt-4-stdout-${tupleId}.txt`,
						stderr: `workflow-output/validation-attempt-4-stderr-${tupleId}.txt`,
						exitcode: `workflow-output/validation-attempt-4-exitcode-${tupleId}.txt`,
						coverage: `workflow-output/scheduler-deep-coverage-${tupleId}.out`,
					},
				},
				null,
				2,
			)}\n`,
		);
		await Bun.write(
			path.join(cwd, `workflow-output/tests-lane-${tupleId}.json`),
			`${JSON.stringify(
				{
					tuple_id: tupleId,
					producer_node: "implementTests",
					status: "complete",
					validation: {
						command,
						environment,
						result: "pass",
						latest_attempt: 4,
						latest_attempt_metadata: `workflow-output/validation-attempt-4-metadata-${tupleId}.json`,
						latest_attempt_stdout: `workflow-output/validation-attempt-4-stdout-${tupleId}.txt`,
						latest_attempt_stderr: `workflow-output/validation-attempt-4-stderr-${tupleId}.txt`,
						latest_attempt_exitcode: `workflow-output/validation-attempt-4-exitcode-${tupleId}.txt`,
						coverage_profile: `workflow-output/scheduler-deep-coverage-${tupleId}.out`,
					},
				},
				null,
				2,
			)}\n`,
		);

		const result = await runScript(cwd, "run-declared-validation.js", {});

		expect(result.verdict).toBe("PASS");
		expect(result.data?.validation).toMatchObject({
			result: "passed",
			exitCode: 0,
			stdoutArtifact: `workflow-output/validation-attempt-4-stdout-${tupleId}.txt`,
			stderrArtifact: `workflow-output/validation-attempt-4-stderr-${tupleId}.txt`,
			exitCodeArtifact: `workflow-output/validation-attempt-4-exitcode-${tupleId}.txt`,
			reusedFromTestLane: `workflow-output/tests-lane-${tupleId}.json`,
		});
		expect(result.data?.validation?.reusedArtifactHashes).toMatchObject({
			[`workflow-output/validation-attempt-4-stdout-${tupleId}.txt`]: await sha256File(
				path.join(cwd, `workflow-output/validation-attempt-4-stdout-${tupleId}.txt`),
			),
			[`workflow-output/validation-attempt-4-exitcode-${tupleId}.txt`]: await sha256File(
				path.join(cwd, `workflow-output/validation-attempt-4-exitcode-${tupleId}.txt`),
			),
			[`workflow-output/scheduler-deep-coverage-${tupleId}.out`]: await sha256File(
				path.join(cwd, `workflow-output/scheduler-deep-coverage-${tupleId}.out`),
			),
		});
		expect(await fileExists(path.join(cwd, "workflow-output", "rerun-marker"))).toBe(false);
	});

	it("accepts markdown-coded declared validation after final validation supersedes failed attempts", async () => {
		const cwd = await createTempDir();
		const tupleId = "C92-K8S-PAR-test";
		const command = "./workflow-output/run-k8s-deep-validation.sh";
		const environment = {
			GOTMPDIR: "/tmp/omh-run-tmp/C92-K8S-PAR-test/go-tmp",
			GOCACHE: "/tmp/omh-cache/go-build",
			GOMODCACHE: "/tmp/omh-cache/go-mod",
		};
		await writeTupleFiles(cwd, tupleId);
		await fs.mkdir(path.join(cwd, "workflow-output"), { recursive: true });
		await Bun.write(
			path.join(cwd, "task.md"),
			[
				"## Validation Command",
				"",
				"`./workflow-output/run-k8s-deep-validation.sh`",
				"",
				"## Validation Environment",
				"",
				"- `GOTMPDIR=/tmp/omh-run-tmp/C92-K8S-PAR-test/go-tmp`",
				"- `GOCACHE=/tmp/omh-cache/go-build`",
				"- `GOMODCACHE=/tmp/omh-cache/go-mod`",
			].join("\n"),
		);
		await Bun.write(path.join(cwd, "workflow-output", `core-lane-${tupleId}.json`), "{}\n");
		await Bun.write(path.join(cwd, "workflow-output", `docs-lane-${tupleId}.json`), "{}\n");
		await Bun.write(path.join(cwd, "workflow-output", `integration-review-${tupleId}.json`), "{}\n");
		for (const attempt of [1, 2, 3]) {
			await Bun.write(
				path.join(cwd, `workflow-output/validation-attempt-${attempt}-stdout-${tupleId}.txt`),
				attempt === 3 ? "ok\n" : "FAIL\n",
			);
			await Bun.write(path.join(cwd, `workflow-output/validation-attempt-${attempt}-stderr-${tupleId}.txt`), "");
			await Bun.write(
				path.join(cwd, `workflow-output/validation-attempt-${attempt}-exitcode-${tupleId}.txt`),
				attempt === 3 ? "0\n" : "1\n",
			);
		}
		await Bun.write(
			path.join(cwd, "workflow-output", `tests-lane-${tupleId}.json`),
			`${JSON.stringify(
				{
					tuple_id: tupleId,
					producer_node: "implementTests",
					status: "completed",
					validation: {
						command,
						environment,
						result: "pass",
						latest_attempt: 3,
						attempts: [
							{
								attempt: 1,
								result: "not_credited",
								stdout: `workflow-output/validation-attempt-1-stdout-${tupleId}.txt`,
								stderr: `workflow-output/validation-attempt-1-stderr-${tupleId}.txt`,
								exit_code: `workflow-output/validation-attempt-1-exitcode-${tupleId}.txt`,
							},
							{
								attempt: 2,
								result: "fail",
								stdout: `workflow-output/validation-attempt-2-stdout-${tupleId}.txt`,
								stderr: `workflow-output/validation-attempt-2-stderr-${tupleId}.txt`,
								exit_code: `workflow-output/validation-attempt-2-exitcode-${tupleId}.txt`,
							},
							{
								attempt: 3,
								result: "pass",
								stdout: `workflow-output/validation-attempt-3-stdout-${tupleId}.txt`,
								stderr: `workflow-output/validation-attempt-3-stderr-${tupleId}.txt`,
								exit_code: `workflow-output/validation-attempt-3-exitcode-${tupleId}.txt`,
							},
						],
					},
				},
				null,
				2,
			)}\n`,
		);
		await Bun.write(
			path.join(cwd, "workflow-output", `validation-${tupleId}.json`),
			`${JSON.stringify(
				{
					tuple_id: tupleId,
					artifact: `workflow-output/validation-${tupleId}.json`,
					producer_node: "runDeclaredValidation",
					producer_kind: "workflow-script",
					validation: {
						command,
						environment,
						result: "passed",
						status: "passed",
						exitCode: 0,
						stdoutArtifact: `workflow-output/validation-attempt-3-stdout-${tupleId}.txt`,
						stderrArtifact: `workflow-output/validation-attempt-3-stderr-${tupleId}.txt`,
						exitCodeArtifact: `workflow-output/validation-attempt-3-exitcode-${tupleId}.txt`,
					},
				},
				null,
				2,
			)}\n`,
		);

		const guardResult = await runScript(cwd, "evidence-contract-guard.js", {});

		expect(guardResult.verdict).toBe("READY");
		expect(guardResult.data?.validation_command).toBe(command);
		expect(guardResult.data?.validation_environment).toEqual(environment);
		expect(guardResult.data?.checked_inputs?.trusted_final_validation_artifacts).toEqual([
			`workflow-output/validation-${tupleId}.json`,
		]);
		expect(guardResult.data?.checked_inputs?.failed_validation_artifacts).toEqual([]);
	});

	it("reuses exact failed test-lane validation without rerunning the same command", async () => {
		const cwd = await createTempDir();
		await initGitRepo(cwd);
		await writeTupleFiles(cwd, "P06-T06-test");
		await fs.mkdir(path.join(cwd, "workflow-output"), { recursive: true });
		const command = "bash -lc 'printf rerun > workflow-output/should-not-rerun; exit 1'";
		await Bun.write(path.join(cwd, "task.md"), `Validation Command:\n${command}\n`);
		await Bun.write(path.join(cwd, "workflow-output", "test-validation-P06-T06-test.stdout"), "failed once\n");
		await Bun.write(path.join(cwd, "workflow-output", "test-validation-P06-T06-test.stderr"), "failure details\n");
		await Bun.write(path.join(cwd, "workflow-output", "test-validation-P06-T06-test.exitcode"), "1\n");
		const laneArtifact = {
			tuple_id: "P06-T06-test",
			producer_node: "implementTests",
			status: "completed",
			validation: {
				command,
				environment: {},
				runtime_environment: {},
				result: "failed",
				status: "failed",
				exitCode: 1,
				stdout_path: "workflow-output/test-validation-P06-T06-test.stdout",
				stderr_path: "workflow-output/test-validation-P06-T06-test.stderr",
				exit_code_path: "workflow-output/test-validation-P06-T06-test.exitcode",
			},
			artifact_hashes: {
				"workflow-output/test-validation-P06-T06-test.stdout": await sha256File(
					path.join(cwd, "workflow-output", "test-validation-P06-T06-test.stdout"),
				),
				"workflow-output/test-validation-P06-T06-test.stderr": await sha256File(
					path.join(cwd, "workflow-output", "test-validation-P06-T06-test.stderr"),
				),
				"workflow-output/test-validation-P06-T06-test.exitcode": await sha256File(
					path.join(cwd, "workflow-output", "test-validation-P06-T06-test.exitcode"),
				),
			},
		};
		await Bun.write(
			path.join(cwd, "workflow-output", "tests-lane-P06-T06-test.json"),
			`${JSON.stringify(laneArtifact, null, 2)}\n`,
		);

		const result = await runScript(cwd, "run-declared-validation.js", {});

		expect(result.verdict).toBe("FAIL");
		expect(result.summary).toContain("reused exact failed test-lane evidence");
		expect(result.data?.validation).toMatchObject({
			result: "failed",
			exitCode: 1,
			stdoutArtifact: "workflow-output/test-validation-P06-T06-test.stdout",
			stderrArtifact: "workflow-output/test-validation-P06-T06-test.stderr",
			reusedFromTestLane: "workflow-output/tests-lane-P06-T06-test.json",
		});
		expect(await fileExists(path.join(cwd, "workflow-output", "should-not-rerun"))).toBe(false);
		expect(await fileExists(path.join(cwd, "workflow-output", "validation-P06-T06-test.stdout"))).toBe(false);
	});

	it("reuses nested test-lane validation hashes without rerunning the same command", async () => {
		const cwd = await createTempDir();
		await initGitRepo(cwd);
		await writeTupleFiles(cwd, "P06-T06-test");
		await fs.mkdir(path.join(cwd, "workflow-output"), { recursive: true });
		const command = "bash -lc 'printf rerun > workflow-output/should-not-rerun; exit 42'";
		await Bun.write(path.join(cwd, "task.md"), `Validation Command:\n${command}\n`);
		await Bun.write(path.join(cwd, "workflow-output", "nested-validation-P06-T06-test.stdout"), "passed once\n");
		await Bun.write(path.join(cwd, "workflow-output", "nested-validation-P06-T06-test.stderr"), "");
		await Bun.write(path.join(cwd, "workflow-output", "nested-validation-P06-T06-test.exitcode"), "0\n");
		await Bun.write(path.join(cwd, "workflow-output", "nested-cover-P06-T06-test.out"), "mode: atomic\n");
		const stdoutPath = "workflow-output/nested-validation-P06-T06-test.stdout";
		const stderrPath = "workflow-output/nested-validation-P06-T06-test.stderr";
		const exitCodePath = "workflow-output/nested-validation-P06-T06-test.exitcode";
		const coveragePath = "workflow-output/nested-cover-P06-T06-test.out";
		const coverageHash = await sha256File(path.join(cwd, coveragePath));
		const laneArtifact = {
			tuple_id: "P06-T06-test",
			producer_node: "implementTests",
			status: "completed",
			validation: {
				command,
				environment: {},
				result: "pass",
				exit_code: 0,
				stdout_path: stdoutPath,
				stderr_path: stderrPath,
				exit_code_path: exitCodePath,
				evidence_hashes: {
					[stdoutPath]: await sha256File(path.join(cwd, stdoutPath)),
					[stderrPath]: await sha256File(path.join(cwd, stderrPath)),
					[exitCodePath]: await sha256File(path.join(cwd, exitCodePath)),
				},
				coverage_profiles: [{ path: coveragePath, sha256: coverageHash }],
			},
		};
		await Bun.write(
			path.join(cwd, "workflow-output", "tests-lane-P06-T06-test.json"),
			`${JSON.stringify(laneArtifact, null, 2)}\n`,
		);

		const result = await runScript(cwd, "run-declared-validation.js", {});

		expect(result.verdict).toBe("PASS");
		expect(result.data?.validation).toMatchObject({
			result: "passed",
			exitCode: 0,
			stdoutArtifact: stdoutPath,
			stderrArtifact: stderrPath,
			reusedFromTestLane: "workflow-output/tests-lane-P06-T06-test.json",
			reusedArtifactHashes: {
				[stdoutPath]: laneArtifact.validation.evidence_hashes[stdoutPath],
				[stderrPath]: laneArtifact.validation.evidence_hashes[stderrPath],
				[exitCodePath]: laneArtifact.validation.evidence_hashes[exitCodePath],
				[coveragePath]: coverageHash,
			},
			reusedCoverageProfiles: [{ path: coveragePath, sha256: coverageHash }],
		});
		expect(await fileExists(path.join(cwd, "workflow-output", "should-not-rerun"))).toBe(false);
		expect(await fileExists(path.join(cwd, "workflow-output", "validation-P06-T06-test.stdout"))).toBe(false);
	});

	it("reuses tuple-scoped test-lane validation files when the lane omits optional command metadata", async () => {
		const cwd = await createTempDir();
		await initGitRepo(cwd);
		await writeTupleFiles(cwd, "P06-T06-test");
		await fs.mkdir(path.join(cwd, "workflow-output"), { recursive: true });
		const command = "bash -lc 'printf rerun > workflow-output/should-not-rerun; exit 42'";
		await Bun.write(path.join(cwd, "task.md"), `Validation Command:\n${command}\n`);
		await Bun.write(path.join(cwd, "workflow-output", "validation-P06-T06-test.stdout"), "phase=unit\nok package\n");
		await Bun.write(path.join(cwd, "workflow-output", "validation-P06-T06-test.stderr"), "");
		await Bun.write(path.join(cwd, "workflow-output", "validation-P06-T06-test.exitcode"), "0\n");
		await Bun.write(path.join(cwd, "workflow-output", "unit-cover-P06-T06-test.out"), "mode: atomic\n");
		const coveragePath = "workflow-output/unit-cover-P06-T06-test.out";
		const laneArtifact = {
			tuple_id: "P06-T06-test",
			producer_node: "implementTests",
			status: "completed",
			declared_validation: {
				command,
				environment: {},
				result: "pass",
				exit_code: 0,
				stdout_path: "workflow-output/validation-P06-T06-test.stdout",
				stderr_path: "workflow-output/validation-P06-T06-test.stderr",
				exitcode_path: "workflow-output/validation-P06-T06-test.exitcode",
				failure_classification: "none; declared validation passed",
				phase_order: ["unit"],
			},
			coverage_profiles: {
				[coveragePath]: { exists: true, bytes: "mode: atomic\n".length },
			},
			checksums: {
				"workflow-output/validation-P06-T06-test.stdout": await sha256File(
					path.join(cwd, "workflow-output", "validation-P06-T06-test.stdout"),
				),
				"workflow-output/validation-P06-T06-test.stderr": await sha256File(
					path.join(cwd, "workflow-output", "validation-P06-T06-test.stderr"),
				),
				"workflow-output/validation-P06-T06-test.exitcode": await sha256File(
					path.join(cwd, "workflow-output", "validation-P06-T06-test.exitcode"),
				),
			},
		};
		await Bun.write(
			path.join(cwd, "workflow-output", "tests-lane-P06-T06-test.json"),
			`${JSON.stringify(laneArtifact, null, 2)}\n`,
		);

		const result = await runScript(cwd, "run-declared-validation.js", {});

		expect(result.verdict).toBe("PASS");
		expect(result.summary).toContain("reused exact passed test-lane evidence");
		expect(result.data?.validation).toMatchObject({
			command,
			result: "passed",
			exitCode: 0,
			stdoutArtifact: "workflow-output/validation-P06-T06-test.stdout",
			stderrArtifact: "workflow-output/validation-P06-T06-test.stderr",
			exitCodeArtifact: "workflow-output/validation-P06-T06-test.exitcode",
			reusedFromTestLane: "workflow-output/tests-lane-P06-T06-test.json",
			reusedCoverageProfiles: [{ path: coveragePath, sha256: await sha256File(path.join(cwd, coveragePath)) }],
		});
		expect(result.data?.validation?.reusedArtifactHashes?.["workflow-output/validation-P06-T06-test.stdout"]).toBe(
			await sha256File(path.join(cwd, "workflow-output", "validation-P06-T06-test.stdout")),
		);
		expect(await fileExists(path.join(cwd, "workflow-output", "should-not-rerun"))).toBe(false);
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

	it("rejects mechanical surface inventories as semantic lane evidence", async () => {
		const cwd = await createTempDir();
		await writeReadyEvidence(cwd, "P06-T06-test");
		await Bun.write(
			path.join(cwd, "workflow-output", "core-lane-P06-T06-test.json"),
			`${JSON.stringify(
				{
					tuple_id: "P06-T06-test",
					producer_node: "implementCore",
					status: "complete",
					surface_audit: {
						candidate_test_count: 3567,
						selected_concrete_surface_count: 430,
						meets_340_surface_requirement: true,
						surface_inventory_path: "workflow-output/core-evidence-P06-T06-test.md",
					},
				},
				null,
				2,
			)}\n`,
		);
		await Bun.write(
			path.join(cwd, "workflow-output", "core-evidence-P06-T06-test.md"),
			[
				"# Core lane evidence",
				"Candidate test functions discovered in declared matrix packages: 3567",
				"Concrete surfaces selected and named below: 430",
				"1. `pkg/example/example_test.go` `TestExample`: Verifies unit behavior for Example within the declared stable matrix. Gate role: stable_matrix_candidate.",
			].join("\n"),
		);
		await Bun.write(
			path.join(cwd, "workflow-output", "docs-evidence-P06-T06-test.md"),
			[
				"# Docs evidence",
				"Concrete scoped surface inventory: 3720 parsed Go test/benchmark/fuzz entry points across wrapper package arguments.",
				"Archived concrete entry points are listed as production evidence.",
			].join("\n"),
		);

		const result = await runScript(cwd, "evidence-contract-guard.js", {});

		expect(result.verdict).toBe("REPAIR");
		expect(result.summary).toContain("mechanical surface inventory used as semantic evidence");
		expect(result.data?.checked_inputs?.mechanical_surface_inventory_artifacts).toEqual([
			"workflow-output/core-evidence-P06-T06-test.md",
			"workflow-output/core-lane-P06-T06-test.json",
			"workflow-output/docs-evidence-P06-T06-test.md",
		]);
	});

	it("requires immutable attempt logs when test-lane validation is rerun", async () => {
		const cwd = await createTempDir();
		await writeReadyEvidence(cwd, "P06-T06-test");
		await Bun.write(path.join(cwd, "workflow-output", "validation-stdout-implementTests-P06-T06-test.txt"), "ok\n");
		await Bun.write(path.join(cwd, "workflow-output", "validation-stderr-implementTests-P06-T06-test.txt"), "");
		await Bun.write(path.join(cwd, "workflow-output", "validation-exit-code-implementTests-P06-T06-test.txt"), "0\n");
		await Bun.write(
			path.join(cwd, "workflow-output", "tests-lane-P06-T06-test.json"),
			`${JSON.stringify(
				{
					tuple_id: "P06-T06-test",
					producer_node: "implementTests",
					status: "completed",
					validation: {
						command: "true",
						environment: {},
						result: "pass",
						exit_code: 0,
						stdout_path: "workflow-output/validation-stdout-implementTests-P06-T06-test.txt",
						stderr_path: "workflow-output/validation-stderr-implementTests-P06-T06-test.txt",
						exit_code_path: "workflow-output/validation-exit-code-implementTests-P06-T06-test.txt",
					},
					notes: "First full wrapper failed, then the test lane reran validation after a focused fix and only kept the latest canonical logs.",
				},
				null,
				2,
			)}\n`,
		);

		const result = await runScript(cwd, "evidence-contract-guard.js", {});

		expect(result.verdict).toBe("REPAIR");
		expect(result.data?.checked_inputs?.validation_attempt_log_findings).toEqual([
			{
				file: "workflow-output/tests-lane-P06-T06-test.json",
				reason: "validation rerun evidence is missing immutable attempt stdout/stderr/exitcode logs",
				missing_files: [
					"workflow-output/validation-attempt-1-stdout-P06-T06-test.txt",
					"workflow-output/validation-attempt-1-stderr-P06-T06-test.txt",
					"workflow-output/validation-attempt-1-exitcode-P06-T06-test.txt",
					"workflow-output/validation-attempt-2-stdout-P06-T06-test.txt",
					"workflow-output/validation-attempt-2-stderr-P06-T06-test.txt",
					"workflow-output/validation-attempt-2-exitcode-P06-T06-test.txt",
				],
			},
		]);
	});

	it("accepts single-attempt test-lane validation with immutable attempt logs", async () => {
		const cwd = await createTempDir();
		await writeReadyEvidence(cwd, "P06-T06-test");
		const attemptFiles = [
			"workflow-output/validation-attempt-1-stdout-P06-T06-test.txt",
			"workflow-output/validation-attempt-1-stderr-P06-T06-test.txt",
			"workflow-output/validation-attempt-1-exitcode-P06-T06-test.txt",
		];
		for (const file of attemptFiles) {
			await Bun.write(path.join(cwd, file), file.includes("exitcode") ? "0\n" : `${file}\n`);
		}
		await Bun.write(
			path.join(cwd, "workflow-output", "tests-lane-P06-T06-test.json"),
			`${JSON.stringify(
				{
					tuple_id: "P06-T06-test",
					producer_node: "implementTests",
					status: "completed",
					validation: {
						command: "true",
						environment: {},
						result: "pass",
						exit_code: 0,
						failure_classification: "not_applicable_passing_validation",
					},
					attempts: [
						{
							attempt: 1,
							command: "true",
							environment: {},
							result: "pass",
							exit_code_path: "workflow-output/validation-attempt-1-exitcode-P06-T06-test.txt",
							stdout_path: "workflow-output/validation-attempt-1-stdout-P06-T06-test.txt",
							stderr_path: "workflow-output/validation-attempt-1-stderr-P06-T06-test.txt",
						},
					],
					validation_artifacts_changed_by_tests_lane: attemptFiles,
				},
				null,
				2,
			)}\n`,
		);

		const result = await runScript(cwd, "evidence-contract-guard.js", {});

		expect(result.verdict).toBe("READY");
		expect(result.data?.checked_inputs?.validation_attempt_log_findings).toEqual([]);
	});

	it("accepts validation reruns when every attempt has immutable stdout stderr and exitcode logs", async () => {
		const cwd = await createTempDir();
		await writeReadyEvidence(cwd, "P06-T06-test");
		const attemptFiles = [
			"workflow-output/validation-attempt-1-stdout-P06-T06-test.txt",
			"workflow-output/validation-attempt-1-stderr-P06-T06-test.txt",
			"workflow-output/validation-attempt-1-exitcode-P06-T06-test.txt",
			"workflow-output/validation-attempt-2-stdout-P06-T06-test.txt",
			"workflow-output/validation-attempt-2-stderr-P06-T06-test.txt",
			"workflow-output/validation-attempt-2-exitcode-P06-T06-test.txt",
		];
		for (const file of attemptFiles) {
			await Bun.write(path.join(cwd, file), file.includes("exitcode") ? "0\n" : `${file}\n`);
		}
		await Bun.write(
			path.join(cwd, "workflow-output", "tests-lane-P06-T06-test.json"),
			`${JSON.stringify(
				{
					tuple_id: "P06-T06-test",
					producer_node: "implementTests",
					status: "completed",
					validation_attempts: [
						{
							attempt: 1,
							result: "failed",
							stdout_path: "workflow-output/validation-attempt-1-stdout-P06-T06-test.txt",
							stderr_path: "workflow-output/validation-attempt-1-stderr-P06-T06-test.txt",
							exitcode_path: "workflow-output/validation-attempt-1-exitcode-P06-T06-test.txt",
						},
						{
							attempt: 2,
							result: "pass",
							stdout_path: "workflow-output/validation-attempt-2-stdout-P06-T06-test.txt",
							stderr_path: "workflow-output/validation-attempt-2-stderr-P06-T06-test.txt",
							exitcode_path: "workflow-output/validation-attempt-2-exitcode-P06-T06-test.txt",
						},
					],
					validation: {
						command: "true",
						environment: {},
						result: "pass",
						exit_code: 0,
						stdout_path: "workflow-output/validation-attempt-2-stdout-P06-T06-test.txt",
						stderr_path: "workflow-output/validation-attempt-2-stderr-P06-T06-test.txt",
						exitcode_path: "workflow-output/validation-attempt-2-exitcode-P06-T06-test.txt",
					},
				},
				null,
				2,
			)}\n`,
		);

		const result = await runScript(cwd, "evidence-contract-guard.js", {});

		expect(result.verdict).toBe("READY");
		expect(result.data?.checked_inputs?.validation_attempt_log_findings).toEqual([]);
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

	it("reports premature final archive artifacts as repair evidence before strong review", async () => {
		const cwd = await createTempDir();
		await writeReadyEvidence(cwd, "P06-T06-test");
		await Bun.write(path.join(cwd, "workflow-output", "final-archive-P06-T06-test.md"), "# premature archive\n");

		const result = await runScript(cwd, "evidence-contract-guard.js", {});

		expect(result.verdict).toBe("REPAIR");
		expect(result.data?.checked_inputs?.premature_decision_artifacts).toEqual([
			"workflow-output/final-archive-P06-T06-test.md",
		]);
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

	it("materializes a bounded review handoff before strong review consumes lane evidence", async () => {
		const cwd = await createTempDir();
		await writeTupleFiles(cwd, "P06-T06-test");
		await fs.mkdir(path.join(cwd, "workflow-output"), { recursive: true });
		await Bun.write(path.join(cwd, "workflow-output", "core-lane-P06-T06-test.json"), "{}\n");
		await Bun.write(path.join(cwd, "workflow-output", "tests-lane-P06-T06-test.json"), "{}\n");
		await Bun.write(path.join(cwd, "workflow-output", "docs-lane-P06-T06-test.json"), "{}\n");
		const largeSummary = "tracked and untracked integration detail ".repeat(3000);

		const result = await runScript(cwd, "materialize-integration-review.js", {
			completedActivations: [
				{
					id: "activation-core",
					nodeId: "implementCore",
					graphRevisionId: "graph",
					status: "completed",
					parentActivationIds: [],
					output: {
						summary: "core lane detail ".repeat(3000),
						artifacts: ["workflow-output/core-lane-P06-T06-test.json"],
					},
				},
				{
					id: "activation-tests",
					nodeId: "implementTests",
					graphRevisionId: "graph",
					status: "completed",
					parentActivationIds: [],
					output: {
						summary: "tests lane detail ".repeat(3000),
						artifacts: ["workflow-output/tests-lane-P06-T06-test.json"],
					},
				},
				{
					id: "activation-docs",
					nodeId: "implementDocs",
					graphRevisionId: "graph",
					status: "completed",
					parentActivationIds: [],
					output: {
						summary: "docs lane detail ".repeat(3000),
						artifacts: ["workflow-output/docs-lane-P06-T06-test.json"],
					},
				},
				{
					id: "activation-integration",
					nodeId: "integrationReview",
					graphRevisionId: "graph",
					status: "completed",
					parentActivationIds: [],
					output: {
						summary: largeSummary,
						data: { findings: Array.from({ length: 200 }, (_, index) => ({ index, detail: largeSummary })) },
						artifacts: ["workflow-output/reviewer-note.txt"],
					},
				},
			],
		});
		const handoff = result.statePatch?.find(patch => patch.path === "/reviewHandoff")?.value;

		expect(typeof handoff).toBe("string");
		expect(new TextEncoder().encode(handoff as string).byteLength).toBeLessThanOrEqual(16 * 1024);
		expect(handoff as string).toContain("workflow-output/integration-review-materialized-P06-T06-test.json");
		expect(handoff as string).toContain("workflow-output/review-handoff-P06-T06-test.json");
		expect(handoff as string).toContain("[truncated");
		expect(handoff as string).not.toContain(largeSummary);
		expect(result.data).toMatchObject({
			review_handoff_artifact: "workflow-output/review-handoff-P06-T06-test.json",
			review_handoff_bytes: expect.any(Number),
		});
		expect(() => validateWorkflowActivationOutput(result)).not.toThrow();
	});

	it("materializes a single bounded strong-review packet from large final evidence", async () => {
		const cwd = await createTempDir();
		await writeTupleFiles(cwd, "P06-T06-test");
		await fs.mkdir(path.join(cwd, "workflow-output"), { recursive: true });
		const largePlanHandoff = [
			"workflow-output/scope-plan-handoff-P06-T06-test.json",
			"surface contract ".repeat(1200),
		].join("\n");
		const largeReviewHandoff = [
			"workflow-output/review-handoff-P06-T06-test.json",
			"lane summary ".repeat(2200),
		].join("\n");
		const largeTaskContract = [
			"Objective:",
			"Improve a real project behavior.",
			"Acceptance Criteria:",
			"- Keep evidence complete.",
			"Detailed scope:",
			"task details ".repeat(1600),
		].join("\n");
		const evidenceContract = {
			verdict: "READY",
			reasons: [],
			changed_files: Array.from({ length: 160 }, (_, index) => `src/changed-${index}.ts`),
			evidence_files: Array.from({ length: 260 }, (_, index) => `workflow-output/evidence-${index}.json`),
			checked_inputs: {
				lane_artifacts: Array.from({ length: 120 }, (_, index) => `workflow-output/lane-${index}.json`),
				validation_artifacts: Array.from({ length: 120 }, (_, index) => `workflow-output/validation-${index}.json`),
			},
		};

		const result = await runScript(cwd, "materialize-strong-review-packet.js", {
			state: {
				planHandoff: largePlanHandoff,
				taskContract: largeTaskContract,
				reviewHandoff: largeReviewHandoff,
				evidenceContract,
			},
		});
		const packet = result.statePatch?.find(patch => patch.path === "/strongReviewPacket")?.value;

		expect(typeof packet).toBe("string");
		expect(new TextEncoder().encode(packet as string).byteLength).toBeLessThanOrEqual(18 * 1024);
		expect(packet as string).toContain("workflow-output/strong-review-packet-P06-T06-test.md");
		expect(packet as string).toContain("workflow-output/review-handoff-P06-T06-test.json");
		expect(packet as string).toContain("Evidence contract verdict: READY");
		expect(packet as string).toContain("changed files omitted");
		expect(packet as string).not.toContain("lane summary ".repeat(500));
		expect(result.data).toMatchObject({
			artifact: "workflow-output/strong-review-packet-P06-T06-test.md",
			producer_node: "materializeStrongReviewPacket",
			packet_bytes: expect.any(Number),
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

	it("keeps integration review read-only while the materializer owns durable evidence writes", async () => {
		const prompt = await Bun.file(
			path.join(
				import.meta.dir,
				"../../examples/workflow/experimental/parallel-implementation-review/parallel-implementation-review/prompts/integration-review.md",
			),
		).text();

		expect(prompt).toContain("materializeIntegrationReview");
		expect(prompt).toContain("Do not write `workflow-output/integration-review-<tuple-id>.json`");
		expect(prompt).not.toContain("Before yielding, write `workflow-output/integration-review-<tuple-id>.json`");
	});

	it("materializes a bounded plan handoff before fan-out prompts consume scope output", async () => {
		const cwd = await createTempDir();
		await writeTupleFiles(cwd, "P06-T06-test");
		const largePlan = {
			status: "scope_plan",
			surface_matrix: Array.from({ length: 120 }, (_, index) => ({
				area: `area-${index}`,
				file: `pkg/area-${index}/implementation.go`,
				test: `pkg/area-${index}/implementation_test.go`,
				contract: `Repository-wide contract ${index} `.repeat(40),
			})),
			known_conflicts_and_locks: Array.from(
				{ length: 40 },
				(_, index) => `lock-${index}: ${"validation ownership ".repeat(20)}`,
			),
			unresolved_risks: Array.from({ length: 40 }, (_, index) => `risk-${index}: ${"large repo ".repeat(30)}`),
		};

		const result = await runScript(cwd, "materialize-plan-handoff.js", {
			state: { plan: largePlan },
		});
		const handoff = result.statePatch?.find(patch => patch.path === "/planHandoff")?.value;

		expect(typeof handoff).toBe("string");
		expect(new TextEncoder().encode(handoff as string).byteLength).toBeLessThanOrEqual(12 * 1024);
		expect(handoff as string).toContain("workflow-output/scope-plan-raw-P06-T06-test.json");
		expect(handoff as string).toContain("__omitted_items");
		expect(result.artifacts).toBeUndefined();
		expect(result.data).toMatchObject({
			artifact: "workflow-output/scope-plan-handoff-P06-T06-test.json",
			raw_plan_artifact: "workflow-output/scope-plan-raw-P06-T06-test.json",
		});
		expect(() => validateWorkflowActivationOutput(result)).not.toThrow();
		expect(await fileExists(path.join(cwd, "workflow-output", "scope-plan-raw-P06-T06-test.json"))).toBe(true);
		expect(await fileExists(path.join(cwd, "workflow-output", "scope-plan-handoff-P06-T06-test.json"))).toBe(true);
	});

	it("routes fan-out and review prompts through compact plan handoff text", async () => {
		const workflow = await Bun.file(
			path.join(
				import.meta.dir,
				"../../examples/workflow/experimental/parallel-implementation-review/parallel-implementation-review.omhflow",
			),
		).text();
		const prompts = await Promise.all(
			[
				"implement-core.md",
				"implement-tests.md",
				"implement-docs.md",
				"integration-review.md",
				"strong-review.md",
			].map(async file =>
				Bun.file(
					path.join(
						import.meta.dir,
						"../../examples/workflow/experimental/parallel-implementation-review/parallel-implementation-review/prompts",
						file,
					),
				).text(),
			),
		);

		expect(workflow).toContain("id: materializePlanHandoff");
		expect(workflow).toContain("id: materializeStrongReviewPacket");
		expect(workflow).toContain("- /reviewHandoff");
		expect(workflow).toContain("strongReviewPacket:\n              state: /strongReviewPacket");
		expect(workflow).toContain("- /planHandoff");
		expect(workflow).toContain("planHandoff:\n                  state: /planHandoff");
		expect(workflow).toContain("planHandoff:\n              state: /planHandoff");
		expect(workflow).not.toContain("taskContract:\n              state: /taskContract\n            reviewHandoff:");
		expect(workflow).not.toContain("evidenceContract:\n              state: /evidenceContract\n      gates:");
		expect(workflow).not.toContain("integrationSummary:\n              output:");
		expect(workflow).not.toContain("{{jsonStringify plan}}");
		for (const prompt of prompts.slice(0, 4)) {
			expect(prompt).toContain("{{planHandoff}}");
			expect(prompt).not.toContain("{{jsonStringify plan}}");
		}
		expect(prompts[0]).toContain("mechanical inventories");
		expect(prompts[0]).toContain("index-only");
		expect(prompts[2]).toContain("mechanical inventories");
		expect(prompts[2]).toContain("index-only");
		expect(prompts[3]).toContain("mechanical inventories");
		expect(prompts[3]).toContain("index-only");
		expect(prompts[4]).toContain("{{strongReviewPacket}}");
		expect(prompts[4]).toContain("mechanical inventories");
		expect(prompts[4]).toContain("index-only");
		expect(prompts[4]).not.toContain("{{taskContract}}");
		expect(prompts[4]).not.toContain("{{planHandoff}}");
		expect(prompts[4]).not.toContain("{{reviewHandoff}}");
		expect(prompts[4]).not.toContain("{{jsonStringify evidenceContract}}");
		expect(prompts[4]).not.toContain("{{integrationSummary}}");
		expect(prompts[4]).not.toContain("{{coreSummary}}");
		expect(prompts[4]).not.toContain("{{testsSummary}}");
		expect(prompts[4]).not.toContain("{{docsSummary}}");
		expect(prompts[0]).toContain("Do not edit validation or run-control scripts");
		expect(prompts[2]).toContain("Do not edit validation or run-control scripts");
		expect(prompts[1]).toContain("validation-attempt-<n>-stdout-<tuple-id>.txt");
		expect(prompts[1]).toContain("must not overwrite");
		expect(prompts[3]).toContain("Validation rerun evidence rule");
		expect(prompts[3]).toContain("immutable attempt logs");
		expect(prompts[4]).toContain("immutable");
		expect(prompts[4]).toContain("validation-attempt-<n>-stdout-<tuple-id>.txt");
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
		const command = "false";
		await Bun.write(path.join(cwd, "task.md"), `Validation Command:\n${command}\n`);
		await fs.mkdir(path.join(cwd, "workflow-output"), { recursive: true });
		await Bun.write(path.join(cwd, "workflow-output", "core-lane-P06-T06-test.json"), "{}\n");
		await Bun.write(path.join(cwd, "workflow-output", "docs-lane-P06-T06-test.json"), "{}\n");
		await Bun.write(path.join(cwd, "workflow-output", "integration-review-P06-T06-test.json"), "{}\n");
		await Bun.write(path.join(cwd, "workflow-output", "test-validation-P06-T06-test.stdout"), "failed once\n");
		await Bun.write(path.join(cwd, "workflow-output", "test-validation-P06-T06-test.stderr"), "failure details\n");
		await Bun.write(path.join(cwd, "workflow-output", "test-validation-P06-T06-test.exitcode"), "1\n");
		const stdoutPath = "workflow-output/test-validation-P06-T06-test.stdout";
		const stderrPath = "workflow-output/test-validation-P06-T06-test.stderr";
		const exitCodePath = "workflow-output/test-validation-P06-T06-test.exitcode";
		await Bun.write(
			path.join(cwd, "workflow-output", "tests-lane-P06-T06-test.json"),
			`${JSON.stringify(
				{
					tuple_id: "P06-T06-test",
					producer_node: "implementTests",
					status: "completed",
					validation: {
						command,
						environment: {},
						result: "failed",
						exitCode: 1,
						stdout_path: stdoutPath,
						stderr_path: stderrPath,
						exit_code_path: exitCodePath,
					},
					artifact_hashes: {
						[stdoutPath]: await sha256File(path.join(cwd, stdoutPath)),
						[stderrPath]: await sha256File(path.join(cwd, stderrPath)),
						[exitCodePath]: await sha256File(path.join(cwd, exitCodePath)),
					},
				},
				null,
				2,
			)}\n`,
		);
		await runScript(cwd, "run-declared-validation.js", {});

		const guardResult = await runScript(cwd, "evidence-contract-guard.js", {});
		const finalResult = await runScript(cwd, "finalize-strong-review.js", {
			state: {
				verdict: { verdict: "promote" },
				evidenceContract: guardResult.data,
			},
		});

		expect(guardResult.verdict).toBe("REPAIR");
		expect(guardResult.data?.checked_inputs?.final_validation_artifacts).toEqual([
			"workflow-output/validation-P06-T06-test.json",
		]);
		expect(guardResult.data?.checked_inputs?.trusted_failed_final_validation_artifacts).toEqual([
			"workflow-output/validation-P06-T06-test.json",
		]);
		expect(guardResult.data?.checked_inputs?.failed_validation_artifacts).toEqual([
			"workflow-output/validation-P06-T06-test.json",
		]);
		expect(guardResult.data?.checked_inputs?.superseded_failed_validation_artifacts).toEqual([
			"workflow-output/tests-lane-P06-T06-test.json",
		]);
		expect(guardResult.data?.reasons).toContain(
			"trusted runDeclaredValidation artifact reported failed validation: workflow-output/validation-P06-T06-test.json",
		);
		expect(guardResult.data?.reasons?.some(reason => reason.includes("no trusted runDeclaredValidation"))).toBe(
			false,
		);
		expect(guardResult.data?.reasons?.some(reason => reason.includes("conflicting failed validation"))).toBe(false);
		expect(finalResult.verdict).toBe("reject");
		await expect(Bun.file(path.join(cwd, "workflow-output", "tuple-state.json")).json()).resolves.toMatchObject({
			status: "rejected",
			terminal: true,
			verdict: "reject",
			evidence_contract_verdict: "REPAIR",
		});
	});

	it("rejects promotion when recorded validation evidence hashes are stale", async () => {
		const cwd = await createTempDir();
		await writeReadyEvidence(cwd, "P06-T06-test");
		const coveragePath = "workflow-output/unit-cover-P06-T06-test.out";
		const stdoutPath = "workflow-output/test-validation-P06-T06-test.stdout";
		const stderrPath = "workflow-output/test-validation-P06-T06-test.stderr";
		const exitCodePath = "workflow-output/test-validation-P06-T06-test.exitcode";
		await Bun.write(path.join(cwd, stdoutPath), "original stdout\n");
		await Bun.write(path.join(cwd, stderrPath), "");
		await Bun.write(path.join(cwd, exitCodePath), "0\n");
		await Bun.write(path.join(cwd, coveragePath), "mode: atomic\noriginal\n");
		const stdoutHash = await sha256File(path.join(cwd, stdoutPath));
		const stderrHash = await sha256File(path.join(cwd, stderrPath));
		const exitCodeHash = await sha256File(path.join(cwd, exitCodePath));
		const coverageHash = await sha256File(path.join(cwd, coveragePath));
		await Bun.write(
			path.join(cwd, "workflow-output", "tests-lane-P06-T06-test.json"),
			`${JSON.stringify(
				{
					tuple_id: "P06-T06-test",
					producer_node: "implementTests",
					status: "completed",
					declared_validation: {
						command: "true",
						environment: {},
						result: "pass",
						exit_code: 0,
						stdout_path: stdoutPath,
						stderr_path: stderrPath,
						exitcode_path: exitCodePath,
					},
					checksums: {
						[stdoutPath]: stdoutHash,
						[stderrPath]: stderrHash,
						[exitCodePath]: exitCodeHash,
					},
					coverage_profiles: {
						[coveragePath]: { exists: true, bytes: "mode: atomic\noriginal\n".length },
					},
				},
				null,
				2,
			)}\n`,
		);
		const validationResult = await runScript(cwd, "run-declared-validation.js", {});
		expect(validationResult.verdict).toBe("PASS");
		expect(validationResult.data?.validation?.reusedCoverageProfiles).toEqual([
			{ path: coveragePath, sha256: coverageHash },
		]);
		await Bun.write(path.join(cwd, coveragePath), "mode: atomic\noverwritten by duplicate validation\n");

		const guardResult = await runScript(cwd, "evidence-contract-guard.js", {});
		const finalResult = await runScript(cwd, "finalize-strong-review.js", {
			state: {
				verdict: { verdict: "promote" },
				evidenceContract: guardResult.data,
			},
		});

		expect(guardResult.verdict).toBe("REPAIR");
		expect(guardResult.summary).toContain("stale validation evidence hashes");
		expect(guardResult.data?.checked_inputs?.stale_validation_hash_artifacts).toEqual([
			"workflow-output/validation-P06-T06-test.json -> workflow-output/unit-cover-P06-T06-test.out",
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

	it("quarantines lane-created final artifacts before integration review can consume them", async () => {
		const cwd = await createTempDir();
		await writeTupleFiles(cwd, "P06-T06-test");
		await fs.mkdir(path.join(cwd, "workflow-output"), { recursive: true });
		await Bun.write(
			path.join(cwd, "workflow-output", "final-review-P06-T06-test.json"),
			`${JSON.stringify({ producer_node: "implementDocs", status: "premature" })}\n`,
		);
		await Bun.write(
			path.join(cwd, "workflow-output", "final-archive-P06-T06-test.md"),
			"# premature archive\n\nProducer: implementDocs\n",
		);

		const result = await runScript(cwd, "lane-hard-stop-guard.js", {});

		expect(result.verdict).toBe("hard_stop");
		expect(result.data?.reserved_final_artifacts).toEqual([
			"workflow-output/final-archive-P06-T06-test.md",
			"workflow-output/final-review-P06-T06-test.json",
		]);
		expect(result.data?.quarantined_reserved_final_artifacts).toEqual([
			{
				original: "workflow-output/final-archive-P06-T06-test.md",
				quarantine: "workflow-output/quarantined-premature-final-artifacts/final-archive-P06-T06-test.md",
			},
			{
				original: "workflow-output/final-review-P06-T06-test.json",
				quarantine: "workflow-output/quarantined-premature-final-artifacts/final-review-P06-T06-test.json",
			},
		]);
		expect(await fileExists(path.join(cwd, "workflow-output", "final-review-P06-T06-test.json"))).toBe(false);
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
			producer_node: "implementDocs",
			status: "premature",
		});
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
		const laneGuardResult = await runScript(cwd, "lane-hard-stop-guard.js", {});

		const guardResult = await runScript(cwd, "evidence-contract-guard.js", {
			state: stateFromPatches(laneGuardResult),
		});
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

	it("rejects promotion when the lane guard quarantined premature final artifacts", async () => {
		const cwd = await createTempDir();
		await writeReadyEvidence(cwd, "P06-T06-test");
		await Bun.write(
			path.join(cwd, "workflow-output", "final-review-P06-T06-test.json"),
			`${JSON.stringify({ producer_node: "implementDocs", status: "premature" })}\n`,
		);
		const laneGuardResult = await runScript(cwd, "lane-hard-stop-guard.js", {});

		const guardResult = await runScript(cwd, "evidence-contract-guard.js", {
			state: stateFromPatches(laneGuardResult),
		});

		expect(guardResult.verdict).toBe("REPAIR");
		expect(guardResult.data?.checked_inputs?.reserved_final_artifacts).toEqual([
			"workflow-output/final-review-P06-T06-test.json",
		]);
		expect(guardResult.data?.checked_inputs?.quarantined_reserved_final_artifacts).toEqual([
			{
				original: "workflow-output/final-review-P06-T06-test.json",
				quarantine: "workflow-output/quarantined-premature-final-artifacts/final-review-P06-T06-test.json",
			},
		]);
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

		const laneGuardResult = await runScript(cwd, "lane-hard-stop-guard.js", {});
		const result = await runScript(cwd, "evidence-contract-guard.js", {
			state: stateFromPatches(laneGuardResult),
		});

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

function stateFromPatches(...results: ScriptResult[]): object {
	const state: Record<string, unknown> = {};
	for (const result of results) {
		for (const patch of result.statePatch ?? []) {
			if (patch.op !== "set" || !patch.path.startsWith("/")) continue;
			state[patch.path.slice(1)] = patch.value;
		}
	}
	return state;
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

async function sha256File(filePath: string): Promise<string> {
	const bytes = new Uint8Array(await Bun.file(filePath).arrayBuffer());
	return new Bun.SHA256().update(bytes).digest("hex");
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
