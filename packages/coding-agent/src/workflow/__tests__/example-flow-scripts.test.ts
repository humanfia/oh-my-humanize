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
