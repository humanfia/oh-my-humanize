import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

interface ScriptResult {
	summary: string;
	verdict?: string;
	data?: {
		artifact?: string;
		producer_node?: string;
		validation?: {
			stdoutArtifact?: string;
			stderrArtifact?: string;
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

	it("rejects generic validation aliases before strong review", async () => {
		const cwd = await createTempDir();
		await writeReadyEvidence(cwd, "P06-T06-test");
		await Bun.write(path.join(cwd, "workflow-output", "validation.txt"), "generic validation alias\n");

		await expect(runScript(cwd, "evidence-contract-guard.js", {})).rejects.toThrow("generic validation aliases");
	});

	it("rejects any premature final namespace artifact before strong review", async () => {
		const cwd = await createTempDir();
		await writeReadyEvidence(cwd, "P06-T06-test");
		await Bun.write(path.join(cwd, "workflow-output", "P06-T06-test-final-validation.json"), "{}\n");

		await expect(runScript(cwd, "evidence-contract-guard.js", {})).rejects.toThrow(
			"premature final decision artifacts",
		);
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

	it("stops before integration review when a lane reports a hard stop", async () => {
		const cwd = await createTempDir();
		await writeTupleFiles(cwd, "P06-T06-test");
		await fs.mkdir(path.join(cwd, "workflow-output"), { recursive: true });
		await Bun.write(
			path.join(cwd, "workflow-output", "lane-hard-stop-P06-T06-test.json"),
			`${JSON.stringify({
				tuple_id: "P06-T06-test",
				producer_node: "implementCore",
				status: "hard_stop",
				reason: "prior feature::f1414_no_require_git semantic failure reproduced",
			})}\n`,
		);

		await expect(runScript(cwd, "lane-hard-stop-guard.js", {})).rejects.toThrow("parallel lane hard stop reported");
		const guardArtifact = await Bun.file(
			path.join(cwd, "workflow-output", "lane-hard-stop-guard-P06-T06-test.json"),
		).json();
		expect(guardArtifact).toMatchObject({
			tuple_id: "P06-T06-test",
			producer_node: "laneHardStopGuard",
			status: "hard_stop",
		});
		await expect(Bun.file(path.join(cwd, "workflow-output", "tuple-state.json")).json()).resolves.toMatchObject({
			tuple_id: "P06-T06-test",
			flow: "parallel-implementation-review",
			status: "hard_stop",
			terminal: true,
			terminal_artifacts: ["workflow-output/lane-hard-stop-P06-T06-test.json"],
		});
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

async function writeReadyEvidence(cwd: string, tupleId: string): Promise<void> {
	await writeTupleFiles(cwd, tupleId);
	await Bun.write(path.join(cwd, "task.md"), "Validation Command:\ntrue\n");
	await fs.mkdir(path.join(cwd, "workflow-output"), { recursive: true });
	await Bun.write(path.join(cwd, "workflow-output", `core-lane-${tupleId}.json`), "{}\n");
	await Bun.write(path.join(cwd, "workflow-output", `tests-lane-${tupleId}.json`), "{}\n");
	await Bun.write(path.join(cwd, "workflow-output", `docs-lane-${tupleId}.json`), "{}\n");
	await Bun.write(path.join(cwd, "workflow-output", `integration-review-${tupleId}.json`), "{}\n");
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
