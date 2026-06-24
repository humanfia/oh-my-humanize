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

async function singleScriptDefinition(nodeId: string, scriptFileName: string): Promise<WorkflowDefinition> {
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
					code: await Bun.file(`${PARALLEL_REVIEW_SCRIPT_DIR}/${scriptFileName}`).text(),
				},
				writes: ["/declaredValidation", "/taskContract", "/runtime"],
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
}: {
	cwd: string;
	previousCwd: string;
	nodeId: string;
	scriptFileName: string;
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
			definition: await singleScriptDefinition(nodeId, `${scriptFileName}`),
			runId: `run-${nodeId}`,
			startNodeId: nodeId,
			runtimeHost: host,
		});
	} finally {
		process.chdir(previousCwd);
	}
}
