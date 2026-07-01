import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import { isEnoent, TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../../config/settings";
import type { ToolSession } from "../../tools";
import { evaluateWorkflowCondition } from "../condition";
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
const KDA_HUMANIZE_SCRIPT_DIR = `${import.meta.dir}/../../../examples/workflow/experimental/kda-humanize/kda-humanize/scripts`;
const KDA_HUMANIZE_SUBFLOW_DIR = `${import.meta.dir}/../../../examples/workflow/experimental/kda-humanize/kda-humanize/humanize-rlcr-subflow`;
const AGENT_BUILD_REVIEW_LOOP_SCRIPT_DIR = `${import.meta.dir}/../../../examples/workflow/experimental/agent-build-review-loop/agent-build-review-loop/scripts`;
const RESEARCH_REPRODUCTION_SCRIPT_DIR = `${import.meta.dir}/../../../examples/workflow/experimental/research-reproduction/research-reproduction/scripts`;
const RELEASE_HARDENING_SCRIPT_DIR = `${import.meta.dir}/../../../examples/workflow/experimental/release-hardening/release-hardening/scripts`;
const BUG_TRIAGE_REPRO_FIX_SCRIPT_DIR = `${import.meta.dir}/../../../examples/workflow/experimental/bug-triage-repro-fix/bug-triage-repro-fix/scripts`;

interface DirectoryEntry {
	name: string;
	isDirectory(): boolean;
	isFile(): boolean;
}

describe("example workflow scripts", () => {
	it("loads the documentation-audit workflow artifact", async () => {
		const artifact = await loadWorkflowArtifact(
			`${import.meta.dir}/../../../examples/workflow/experimental/documentation-audit/documentation-audit.omhflow`,
		);

		expect(artifact.definition.nodes.some(node => node.id === "guardReviewRepair")).toBe(true);
		expect(artifact.definition.nodes.some(node => node.id === "runDocsValidation")).toBe(true);
	});

	it("keeps parallel integration evidence outside the reviewer output schema", async () => {
		const artifact = await loadWorkflowArtifact(
			`${import.meta.dir}/../../../examples/workflow/experimental/parallel-implementation-review/parallel-implementation-review.omhflow`,
		);
		const node = artifact.definition.nodes.find(candidate => candidate.id === "integrationReview");

		expect(node).toMatchObject({
			id: "integrationReview",
			type: "agent",
			agent: "task",
			model: {
				role: "reviewer",
			},
			promptSource: {
				bindings: {
					coreSummary: {
						kind: "state",
						path: "/laneHardStopGuard/lane_summaries/implementCore",
					},
					testsSummary: {
						kind: "state",
						path: "/laneHardStopGuard/lane_summaries/implementTests",
					},
					docsSummary: {
						kind: "state",
						path: "/laneHardStopGuard/lane_summaries/implementDocs",
					},
				},
			},
		});
	});

	it("keeps research reproduction agent prompts read-only around command evidence", async () => {
		const prompt = await Bun.file(
			`${import.meta.dir}/../../../examples/workflow/experimental/research-reproduction/research-reproduction/prompts/reproduction.md`,
		).text();

		expect(prompt).toContain("Do not run shell commands, eval snippets, tests, benchmarks, or project tools.");
		expect(prompt).toContain("Do not create, modify, or delete files, including workflow-output artifacts.");
		expect(prompt).toContain("Only script nodes may execute task-declared commands and write command evidence.");
	});

	it("routes bug triage no-code evidence to validation instead of patching", async () => {
		const artifact = await loadWorkflowArtifact(
			`${import.meta.dir}/../../../examples/workflow/experimental/bug-triage-repro-fix/bug-triage-repro-fix.omhflow`,
		);
		const isolateTargets = artifact.definition.edges
			.filter(edge => edge.from === "isolateCause")
			.map(edge => edge.to);
		expect(isolateTargets).toEqual(["classifyResolutionRoute"]);

		const outgoing = artifact.definition.edges.filter(edge => edge.from === "classifyResolutionRoute");
		const noCodeTargets = outgoing
			.filter(edge =>
				edge.condition === undefined
					? true
					: evaluateWorkflowCondition(edge.condition.source, {
							state: { resolution: { route: "no-code" } },
							outputs: {},
						}),
			)
			.map(edge => edge.to);
		expect(noCodeTargets).toEqual(["runRegression"]);

		const patchTargets = outgoing
			.filter(edge =>
				edge.condition === undefined
					? true
					: evaluateWorkflowCondition(edge.condition.source, {
							state: { resolution: { route: "patch" } },
							outputs: {},
						}),
			)
			.map(edge => edge.to);
		expect(patchTargets).toEqual(["initialPatchFix"]);
	});

	it("materializes bug triage no-code evidence before validation", async () => {
		using tempDir = TempDir.createSync("@omh-bug-triage-no-code-route-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();
		const taskText = [
			"Objective:",
			"Investigate a reported behavior that may already be fixed.",
			"",
			"No-Code Resolution: allowed",
			"",
			"Reproduction Command:",
			"python -c \"print('behavior already correct')\"",
			"",
			"Validation Command:",
			"python -c \"print('validated')\"",
		].join("\n");

		const result = await runExampleScript({
			cwd,
			previousCwd,
			nodeId: "classifyResolutionRoute",
			scriptFileName: "classify-resolution-route.js",
			scriptDir: BUG_TRIAGE_REPRO_FIX_SCRIPT_DIR,
			writes: ["/resolution", "/patch"],
			initialState: {
				task: {
					taskText,
					reproductionCommand: "python -c \"print('behavior already correct')\"",
					validationCommand: "python -c \"print('validated')\"",
				},
				repro: {
					exitCode: 0,
					outputPath: "workflow-output/reproduction.md",
				},
				cause: {
					narrowest_fix_boundary: "parser default-map handling",
				},
			},
		});

		expect(result.scheduler.state.resolution).toMatchObject({
			route: "no-code",
			allowedNoCodeResolution: true,
			reproductionExitCode: 0,
		});
		expect(result.scheduler.state.patch).toMatchObject({
			mode: "no-code",
			rollbackPath: "workflow-output/bugfix-rollback.md",
			rootCauseReconciliationPath: "workflow-output/no-bug-root-cause.md",
		});
		expect(await Bun.file(`${cwd}/workflow-output/bugfix-rollback.md`).text()).toContain(
			"No project files were changed",
		);
		const reconciliation = await Bun.file(`${cwd}/workflow-output/no-bug-root-cause.md`).text();
		expect(reconciliation).toContain("## Cause Reconciliation");
		expect(reconciliation).toContain("isolateCause");
	});

	it("fails bug triage closed when reproduction passes but no-code is not authorized", async () => {
		using tempDir = TempDir.createSync("@omh-bug-triage-passing-repro-without-no-code-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();
		const taskText = [
			"Objective:",
			"Investigate a reported behavior that must have a failing reproduction before patching.",
			"",
			"Reproduction Command:",
			"python -c \"print('current behavior passes')\"",
			"",
			"Validation Command:",
			"python -c \"print('validated')\"",
		].join("\n");

		const result = await runExampleScript({
			cwd,
			previousCwd,
			nodeId: "classifyResolutionRoute",
			scriptFileName: "classify-resolution-route.js",
			scriptDir: BUG_TRIAGE_REPRO_FIX_SCRIPT_DIR,
			writes: ["/resolution", "/patch"],
			initialState: {
				task: {
					taskText,
					reproductionCommand: "python -c \"print('current behavior passes')\"",
					validationCommand: "python -c \"print('validated')\"",
				},
				repro: {
					exitCode: 0,
					outputPath: "workflow-output/reproduction.md",
				},
				cause: {
					narrowest_fix_boundary: "router edge handling",
				},
			},
		});

		expect(
			result.scheduler.activations.find(activation => activation.nodeId === "classifyResolutionRoute")?.status,
		).toBe("failed");
		expect(result.scheduler.state.resolution).toBeUndefined();
		expect(result.scheduler.state.patch).toBeUndefined();
	});

	it("routes explicit bug triage no-code cause evidence away from patching", async () => {
		using tempDir = TempDir.createSync("@omh-bug-triage-no-code-cause-route-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();
		const taskText = [
			"Objective:",
			"Investigate whether the reported behavior is an application defect or an invalid reproduction.",
			"",
			"No-Code Resolution: allowed",
			"",
			"Reproduction Command:",
			"python -c \"raise SyntaxError('bad harness')\"",
			"",
			"Validation Command:",
			"python -m py_compile src/example.py",
		].join("\n");

		const result = await runExampleScript({
			cwd,
			previousCwd,
			nodeId: "classifyResolutionRoute",
			scriptFileName: "classify-resolution-route.js",
			scriptDir: BUG_TRIAGE_REPRO_FIX_SCRIPT_DIR,
			writes: ["/resolution", "/patch"],
			initialState: {
				task: {
					taskText,
					reproductionCommand: "python -c \"raise SyntaxError('bad harness')\"",
					validationCommand: "python -m py_compile src/example.py",
				},
				repro: {
					exitCode: 1,
					outputPath: "workflow-output/reproduction.md",
				},
				cause: {
					resolution: "no-code",
					rootCause: "The frozen reproduction command failed before exercising the reported behavior.",
					evidence: ["Corrected manual reproduction rejected the tampered token."],
				},
			},
		});

		expect(result.scheduler.state.resolution).toMatchObject({
			route: "no-code",
			allowedNoCodeResolution: true,
			reproductionExitCode: 1,
		});
		expect(result.scheduler.state.patch).toMatchObject({
			mode: "no-code",
			changedFiles: [],
		});
		const rollback = await Bun.file(`${cwd}/workflow-output/bugfix-rollback.md`).text();
		expect(rollback).toContain("No project files were changed");
		expect(rollback).toContain("isolateCause");
	});

	it("binds research reproduction validation evidence as standalone prompt context", async () => {
		const artifact = await loadWorkflowArtifact(
			`${import.meta.dir}/../../../examples/workflow/experimental/research-reproduction/research-reproduction.omhflow`,
		);
		const nodes = new Map(artifact.definition.nodes.map(node => [node.id, node]));

		for (const nodeId of ["compareResults", "reportReview"]) {
			const promptSource = nodes.get(nodeId)?.promptSource;
			expect(promptSource?.kind).toBe("template");
			if (promptSource?.kind !== "template") throw new Error(`${nodeId} must use a template prompt`);
			expect(promptSource.bindings.variantCommandEvidence).toEqual({
				kind: "state",
				path: "/variant/variantCommandEvidence",
			});
			expect(promptSource.bindings.validationCommandEvidence).toEqual({
				kind: "state",
				path: "/variant/validationCommandEvidence",
			});
		}
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

	it("counts assertion-backed research reproduction commands as exercised evidence", async () => {
		using tempDir = TempDir.createSync("@omh-research-reproduction-assertion-command-");
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
					reproductionCommand: `python -c "import unittest; unittest.TestCase().assertRaises(ValueError, int, 'x'); print('claim reproduced')"`,
				},
			},
		});

		expect(result.scheduler.state.reproduction).toMatchObject({
			status: "pass",
			exercised: true,
			exitCode: 0,
			stdoutPreview: "claim reproduced\n",
			stderrPreview: "",
		});
		expect(await Bun.file(`${cwd}/workflow-output/reproduction-baseline.json`).json()).toMatchObject({
			exerciseSummary: {
				exercised: true,
				positiveSignals: ["assertion-backed-command"],
			},
		});
	});

	it("counts declared research reproduction output signals as exercised evidence", async () => {
		using tempDir = TempDir.createSync("@omh-research-reproduction-output-signal-");
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
					reproductionCommand: "printf 'read\\n'",
					reproductionSignal: "read",
				},
			},
		});

		expect(result.scheduler.state.reproduction).toMatchObject({
			status: "pass",
			exercised: true,
			exitCode: 0,
			stdoutPreview: "read\n",
		});
		expect(await Bun.file(`${cwd}/workflow-output/reproduction-baseline.json`).json()).toMatchObject({
			expectedSignal: "read",
			exerciseSummary: {
				exercised: true,
				positiveSignals: ["declared-output-signal"],
			},
		});
	});

	it("keeps research reproduction baseline streams in artifacts instead of inline state", async () => {
		using tempDir = TempDir.createSync("@omh-research-reproduction-baseline-output-state-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();
		const largeReproductionCommand = [
			"python -c 'import sys; ",
			'sys.stdout.write("3 passed\\n"); ',
			'[sys.stdout.write("baseline line\\\\n") for _ in range(500)]; ',
			'sys.stdout.write("BASELINE_" + "TAIL_UNIQUE\\\\n")\'',
		].join("");

		const result = await runExampleScript({
			cwd,
			previousCwd,
			nodeId: "reproduceBaseline",
			scriptFileName: "run-reproduction.js",
			scriptDir: RESEARCH_REPRODUCTION_SCRIPT_DIR,
			writes: ["/reproduction"],
			initialState: {
				task: {
					reproductionCommand: largeReproductionCommand,
				},
			},
		});

		expect(result.scheduler.state.reproduction).toMatchObject({
			status: "pass",
			exercised: true,
			exitCode: 0,
			stdoutPath: "workflow-output/reproduction-baseline.json",
			stderrPath: "workflow-output/reproduction-baseline.json",
		});
		const reproductionState = result.scheduler.state.reproduction as {
			stdout?: unknown;
			stderr?: unknown;
		};
		expect(reproductionState.stdout).toBeUndefined();
		expect(reproductionState.stderr).toBeUndefined();
		const serializedState = JSON.stringify(reproductionState);
		expect(serializedState).not.toContain("BASELINE_TAIL_UNIQUE");
		const evidence = await Bun.file(`${cwd}/workflow-output/reproduction-baseline.json`).json();
		expect(evidence.result.stdout).toContain("BASELINE_TAIL_UNIQUE");
	});

	it("rejects multi-line research reproduction commands before they can be truncated", async () => {
		using tempDir = TempDir.createSync("@omh-research-reproduction-multiline-command-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();

		await Bun.write(
			`${cwd}/task.md`,
			[
				"Objective:",
				"Reject command contracts that cannot be preserved as a single shell command.",
				"",
				"Claim Source:",
				"tests/test_json.py contains a concrete JSON behavior claim for this command-contract regression fixture.",
				"",
				"Setup Command:",
				"```sh",
				"PYTHONPATH=. python - <<'PY'",
				"import pydantic",
				"print(pydantic.__version__)",
				"PY",
				"```",
				"",
				"Reproduction Command:",
				"echo reproduced",
				"",
				"Validation Command:",
				"echo validated",
			].join("\n"),
		);

		const result = await runExampleScript({
			cwd,
			previousCwd,
			nodeId: "precheckTaskContract",
			scriptFileName: "precheck-task-contract.js",
			scriptDir: RESEARCH_REPRODUCTION_SCRIPT_DIR,
			writes: ["/task", "/runtime", "/review"],
		});

		expect(
			result.scheduler.activations.find(activation => activation.nodeId === "precheckTaskContract")?.status,
		).toBe("failed");
		expect(await Bun.file(`${cwd}/workflow-output/reproduction-precheck.md`).exists()).toBe(false);
	});

	it("rejects escaped-newline research reproduction commands before shell execution", async () => {
		using tempDir = TempDir.createSync("@omh-research-reproduction-escaped-newline-command-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();

		await Bun.write(
			`${cwd}/task.md`,
			[
				"Objective:",
				"Reject hidden multi-line command contracts that are fragile under shell quoting.",
				"",
				"Claim Source:",
				"tests/test_json.py contains a concrete JSON behavior claim for this escaped-newline fixture.",
				"",
				"Reproduction Command:",
				`PYTHONPATH=src python -c "print('start')\\nprint('done')"`,
				"",
				"Validation Command:",
				"echo validated",
			].join("\n"),
		);

		const result = await runExampleScript({
			cwd,
			previousCwd,
			nodeId: "precheckTaskContract",
			scriptFileName: "precheck-task-contract.js",
			scriptDir: RESEARCH_REPRODUCTION_SCRIPT_DIR,
			writes: ["/task", "/runtime", "/review"],
		});

		expect(
			result.scheduler.activations.find(activation => activation.nodeId === "precheckTaskContract")?.status,
		).toBe("failed");
		expect(await Bun.file(`${cwd}/workflow-output/reproduction-precheck.md`).exists()).toBe(false);
	});

	it("requires research reproduction tasks to provide an auditable claim source", async () => {
		using missingDir = TempDir.createSync("@omh-research-reproduction-missing-claim-source-");
		const previousCwd = process.cwd();

		await Bun.write(
			`${missingDir.path()}/task.md`,
			[
				"Objective:",
				"Reject reproduction tasks that ask the claim agent to infer a claim from broad test commands only.",
				"",
				"Reproduction Command:",
				"python -m pytest tests/test_json.py -q",
				"",
				"Validation Command:",
				"python -m pytest tests/test_json.py -q",
			].join("\n"),
		);

		const missing = await runExampleScript({
			cwd: missingDir.path(),
			previousCwd,
			nodeId: "precheckTaskContract",
			scriptFileName: "precheck-task-contract.js",
			scriptDir: RESEARCH_REPRODUCTION_SCRIPT_DIR,
			writes: ["/task", "/runtime", "/review"],
		});

		expect(
			missing.scheduler.activations.find(activation => activation.nodeId === "precheckTaskContract")?.status,
		).toBe("failed");
		expect(
			missing.scheduler.activations.find(activation => activation.nodeId === "precheckTaskContract")?.error,
		).toContain("Claim Source");

		using readyDir = TempDir.createSync("@omh-research-reproduction-ready-claim-source-");
		await Bun.write(
			`${readyDir.path()}/task.md`,
			[
				"Objective:",
				"Reproduce an explicit JSON serialization behavior.",
				"",
				"Claim Source:",
				"tests/test_json.py asserts that model JSON serialization preserves decimal string output for the selected fixture.",
				"",
				"Reproduction Command:",
				"python -m pytest tests/test_json.py -q",
				"",
				"Validation Command:",
				"python -m pytest tests/test_json.py -q",
			].join("\n"),
		);

		const ready = await runExampleScript({
			cwd: readyDir.path(),
			previousCwd,
			nodeId: "precheckTaskContract",
			scriptFileName: "precheck-task-contract.js",
			scriptDir: RESEARCH_REPRODUCTION_SCRIPT_DIR,
			writes: ["/task", "/runtime", "/review"],
		});

		expect(ready.scheduler.state.task).toMatchObject({
			claimSource:
				"tests/test_json.py asserts that model JSON serialization preserves decimal string output for the selected fixture.",
		});
	});

	it("accepts multi-line research reproduction claim evidence while commands stay single-line", async () => {
		using tempDir = TempDir.createSync("@omh-research-reproduction-multiline-claim-source-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();

		await Bun.write(
			`${cwd}/task.md`,
			[
				"Objective:",
				"Reproduce an explicit serializer compatibility claim from concrete project evidence.",
				"",
				"Claim Source:",
				"- tests/test_signer.py:42 verifies signature round trips for serializer payloads.",
				"- src/itsdangerous/serializer.py:126 documents the selected serialization boundary.",
				"",
				"Reproduction Command:",
				"python -m pytest tests/test_signer.py -q",
				"",
				"Reproduction Signal:",
				"signature round trip",
				"",
				"Validation Command:",
				"python -m pytest tests/test_signer.py -q",
				"",
				"Validation Signal:",
				"tests/test_signer.py",
			].join("\n"),
		);

		const result = await runExampleScript({
			cwd,
			previousCwd,
			nodeId: "precheckTaskContract",
			scriptFileName: "precheck-task-contract.js",
			scriptDir: RESEARCH_REPRODUCTION_SCRIPT_DIR,
			writes: ["/task", "/runtime", "/review"],
		});

		expect(
			result.scheduler.activations.find(activation => activation.nodeId === "precheckTaskContract")?.status,
		).toBe("completed");
		expect(result.scheduler.state.task).toMatchObject({
			claimSource: [
				"- tests/test_signer.py:42 verifies signature round trips for serializer payloads.",
				"- src/itsdangerous/serializer.py:126 documents the selected serialization boundary.",
			].join("\n"),
			reproductionCommand: "python -m pytest tests/test_signer.py -q",
			validationCommand: "python -m pytest tests/test_signer.py -q",
			reproductionSignal: "signature round trip",
			validationSignal: "tests/test_signer.py",
		});
	});

	it("fails research reproduction claims without concrete project evidence", async () => {
		using tempDir = TempDir.createSync("@omh-research-reproduction-claim-evidence-guard-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();

		const missingEvidence = await runExampleScript({
			cwd,
			previousCwd,
			nodeId: "guardClaimEvidence",
			scriptFileName: "guard-claim-evidence.js",
			scriptDir: RESEARCH_REPRODUCTION_SCRIPT_DIR,
			writes: ["/claimEvidence"],
			initialState: {
				task: {
					claimSource: "Project tests and source define timed signature behavior.",
				},
				claim: {
					summary:
						"Timed signatures should remain coherent. Concrete source paths and excerpts were not provided under this node boundary.",
				},
			},
		});

		expect(
			missingEvidence.scheduler.activations.find(activation => activation.nodeId === "guardClaimEvidence")?.status,
		).toBe("failed");
		expect(
			missingEvidence.scheduler.activations.find(activation => activation.nodeId === "guardClaimEvidence")?.error,
		).toContain("concrete source/test evidence");

		const accepted = await runExampleScript({
			cwd,
			previousCwd,
			nodeId: "guardClaimEvidence",
			scriptFileName: "guard-claim-evidence.js",
			scriptDir: RESEARCH_REPRODUCTION_SCRIPT_DIR,
			writes: ["/claimEvidence"],
			initialState: {
				task: {
					claimSource: "tests/test_timed.py::test_loads_max_age line 42 asserts timed max-age rejection.",
				},
				claim: {
					summary: "tests/test_timed.py::test_loads_max_age line 42 asserts max-age rejection.",
					evidence: [
						{
							path: "tests/test_timed.py",
							symbol: "test_loads_max_age",
							excerpt: "with pytest.raises(SignatureExpired)",
						},
					],
				},
			},
		});

		expect(accepted.scheduler.state.claimEvidence).toMatchObject({
			status: "pass",
			sourceRefs: expect.arrayContaining(["tests/test_timed.py"]),
		});
		expect(await Bun.file(`${cwd}/workflow-output/claim-evidence-guard.md`).text()).toContain("tests/test_timed.py");
	});

	it("accepts source-backed research claims before script evidence exists", async () => {
		using tempDir = TempDir.createSync("@omh-research-reproduction-claim-before-script-evidence-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();

		const accepted = await runExampleScript({
			cwd,
			previousCwd,
			nodeId: "guardClaimEvidence",
			scriptFileName: "guard-claim-evidence.js",
			scriptDir: RESEARCH_REPRODUCTION_SCRIPT_DIR,
			writes: ["/claimEvidence"],
			initialState: {
				task: {
					claimSource:
						"tests/test_itsdangerous/test_timed.py and tests/test_itsdangerous/test_url_safe.py define timed and URL-safe serializer behavior.",
				},
				claim: {
					status: "claim_extracted_missing_script_evidence",
					claim: {
						concrete_claim:
							"URLSafeTimedSerializer signs and later loads a URL-safe timed payload before max_age expires.",
						metric: "loads(dumps(value), max_age=N) == value",
					},
					evidence: [
						{
							path: "tests/test_itsdangerous/test_timed.py",
							line: 104,
							symbol: "TestTimedSerializer.test_max_age",
							assertion: "assert serializer.loads(signed, max_age=10) == value",
						},
						{
							path: "tests/test_itsdangerous/test_url_safe.py",
							line: 21,
							symbol: "TestURLSafeTimedSerializer",
							excerpt: "class TestURLSafeTimedSerializer(TestURLSafeSerializer, TestTimedSerializer):",
						},
					],
					script_evidence_assessment: {
						reproductionCommandEvidence:
							"missing; the script node has not provided stdout, stderr, exit code, or artifact path for the declared reproduction command.",
						validationCommandEvidence:
							"missing; the script node has not provided stdout, stderr, exit code, or artifact path for the required validation command.",
					},
				},
			},
		});

		expect(accepted.scheduler.state.claimEvidence).toMatchObject({
			status: "pass",
			sourceRefs: expect.arrayContaining([
				"tests/test_itsdangerous/test_timed.py",
				"tests/test_itsdangerous/test_url_safe.py",
			]),
		});
	});

	it("accepts materialized research claim data with concrete project evidence", async () => {
		using tempDir = TempDir.createSync("@omh-research-reproduction-materialized-claim-evidence-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();

		const accepted = await runExampleScript({
			cwd,
			previousCwd,
			nodeId: "guardClaimEvidence",
			scriptFileName: "guard-claim-evidence.js",
			scriptDir: RESEARCH_REPRODUCTION_SCRIPT_DIR,
			writes: ["/claimEvidence"],
			initialState: {
				task: {
					claimSource:
						"The current repository source and tests define URL-safe serializer tamper rejection behavior.",
				},
				claim: {
					status: "claim_materialized",
					producer_node: "materializeClaim",
					source_node: "extractClaim",
					data: {
						concreteProjectEvidence: [
							{
								path: "tests/test_itsdangerous/test_url_safe.py",
								line: 37,
								symbol: "test_loads_tamper",
								excerpt: "with pytest.raises(BadSignature)",
							},
							{
								path: "src/itsdangerous/url_safe.py",
								line: 21,
								symbol: "URLSafeSerializer",
								excerpt: "class URLSafeSerializer",
							},
						],
					},
				},
			},
		});

		expect(accepted.scheduler.state.claimEvidence).toMatchObject({
			status: "pass",
			sourceRefs: expect.arrayContaining([
				"src/itsdangerous/url_safe.py",
				"tests/test_itsdangerous/test_url_safe.py",
			]),
		});
		expect(await Bun.file(`${cwd}/workflow-output/claim-evidence-guard.md`).text()).toContain(
			"tests/test_itsdangerous/test_url_safe.py",
		);
	});

	it("accepts materialized research claim data with concrete evidence aliases", async () => {
		using tempDir = TempDir.createSync("@omh-research-reproduction-concrete-evidence-alias-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();

		const accepted = await runExampleScript({
			cwd,
			previousCwd,
			nodeId: "guardClaimEvidence",
			scriptFileName: "guard-claim-evidence.js",
			scriptDir: RESEARCH_REPRODUCTION_SCRIPT_DIR,
			writes: ["/claimEvidence"],
			initialState: {
				task: {
					claimSource: "The current repository source and tests define serializer round-trip behavior.",
				},
				claim: {
					status: "claim_materialized",
					producer_node: "materializeClaim",
					source_node: "extractClaim",
					data: {
						status: "extracted",
						claim: "Itsdangerous serializer primitives round-trip values.",
						concreteEvidence: [
							{
								path: "tests/test_itsdangerous/test_serializer.py",
								line: 52,
								symbol: "TestSerializer.test_serializer",
								excerpt: "assert serializer.loads(serializer.dumps(value)) == value",
							},
						],
					},
				},
			},
		});

		expect(accepted.scheduler.state.claimEvidence).toMatchObject({
			status: "pass",
			sourceRefs: expect.arrayContaining(["tests/test_itsdangerous/test_serializer.py"]),
		});
		expect(await Bun.file(`${cwd}/workflow-output/claim-evidence-guard.md`).text()).toContain(
			"tests/test_itsdangerous/test_serializer.py",
		);
	});

	it("keeps non-exercising research reproduction evidence on the refinement route", async () => {
		const artifact = await loadWorkflowArtifact(
			`${import.meta.dir}/../../../examples/workflow/experimental/research-reproduction/research-reproduction.omhflow`,
		);
		const outgoing = artifact.definition.edges.filter(edge => edge.from === "reportReview");
		const enabledTargets = outgoing
			.filter(edge =>
				edge.condition === undefined
					? true
					: evaluateWorkflowCondition(edge.condition.source, {
							state: {
								reproduction: { exercised: false },
								variant: { validationExercised: true },
							},
							outputs: {
								reportReview: { verdict: "finish" },
							},
						}),
			)
			.map(edge => edge.to);

		expect(enabledTargets).toEqual(["extractClaim"]);
	});

	it("archives research reproduction only after reproduction and validation both exercise the claim", async () => {
		const artifact = await loadWorkflowArtifact(
			`${import.meta.dir}/../../../examples/workflow/experimental/research-reproduction/research-reproduction.omhflow`,
		);
		const outgoing = artifact.definition.edges.filter(edge => edge.from === "reportReview");
		const enabledTargets = outgoing
			.filter(edge =>
				edge.condition === undefined
					? true
					: evaluateWorkflowCondition(edge.condition.source, {
							state: {
								reproduction: { exercised: true },
								variant: { validationExercised: true },
							},
							outputs: {
								reportReview: { verdict: "finish" },
							},
						}),
			)
			.map(edge => edge.to);

		expect(enabledTargets).toEqual(["archiveReproduction"]);
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

	it("archives research reproduction comparison rejections as rejected", async () => {
		using tempDir = TempDir.createSync("@omh-research-reproduction-comparison-reject-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();

		await Bun.write(
			`${cwd}/workflow-output/reproduction-baseline.json`,
			`${JSON.stringify(
				{
					exerciseSummary: {
						exercised: true,
						positiveSignals: ["assertion-backed-command"],
						negativeSignals: false,
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
					variantExerciseSummary: {
						exercised: false,
						positiveSignals: [],
						negativeSignals: false,
					},
					validationExerciseSummary: {
						exercised: true,
						positiveSignals: ["passed-count"],
						negativeSignals: false,
						passedCounts: 25,
					},
				},
				null,
				2,
			)}\n`,
		);

		const result = await runExampleScript({
			cwd,
			previousCwd,
			nodeId: "archiveReproduction",
			scriptFileName: "archive-reproduction.js",
			scriptDir: RESEARCH_REPRODUCTION_SCRIPT_DIR,
			writes: ["/archive"],
			initialState: {
				reproduction: {
					status: "pass",
					exercised: true,
					evidencePath: "workflow-output/reproduction-baseline.json",
				},
				variant: {
					status: "pass",
					validationExercised: true,
					evidencePath: "workflow-output/reproduction-variant.json",
				},
				comparison: {
					status: "rejected_non_exercising_variant",
					overallOutcome: "inconclusive",
				},
				review: "verdict finish; rejected/inconclusive outcome is correct",
			},
		});

		expect(result.scheduler.state.archive).toMatchObject({
			outcome: "rejected",
		});
		expect(await Bun.file(`${cwd}/workflow-output/reproduction-archive.md`).text()).toContain("Outcome: rejected");
	});

	it("archives accepted research reproduction when negative-control text contains rejected", async () => {
		using tempDir = TempDir.createSync("@omh-research-reproduction-negative-control-accepted-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();

		await Bun.write(
			`${cwd}/workflow-output/reproduction-baseline.json`,
			`${JSON.stringify(
				{
					exerciseSummary: {
						exercised: true,
						positiveSignals: ["assertion-backed-command"],
						negativeSignals: false,
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
					variantExerciseSummary: {
						exercised: true,
						positiveSignals: ["negative-control-output"],
						negativeSignals: true,
					},
					validationExerciseSummary: {
						exercised: true,
						positiveSignals: ["passed-count"],
						negativeSignals: false,
						passedCounts: 25,
					},
				},
				null,
				2,
			)}\n`,
		);
		await Bun.write(`${cwd}/workflow-output/reproduction-baseline.md`, "roundtrip passed\n");
		await Bun.write(`${cwd}/workflow-output/reproduction-variant.md`, "tamper rejected\n25 passed\n");

		const result = await runExampleScript({
			cwd,
			previousCwd,
			nodeId: "archiveReproduction",
			scriptFileName: "archive-reproduction.js",
			scriptDir: RESEARCH_REPRODUCTION_SCRIPT_DIR,
			writes: ["/archive"],
			initialState: {
				reproduction: {
					status: "pass",
					exercised: true,
					evidencePath: "workflow-output/reproduction-baseline.json",
				},
				variant: {
					status: "pass",
					validationExercised: true,
					variantCommand: "PYTHONPATH=src python workflow-output/scripts/tamper_reject.py",
					evidencePath: "workflow-output/reproduction-variant.json",
				},
				comparison: {
					status: "accepted_from_commands",
					overallOutcome: "accepted",
					summary: "The negative control printed tamper rejected, which is the expected proof signal.",
				},
				review: "finish",
			},
		});

		expect(result.scheduler.state.archive).toMatchObject({
			outcome: "accepted",
			comparison: "accepted_from_commands",
		});
		expect(await Bun.file(`${cwd}/workflow-output/reproduction-archive.md`).text()).toContain("Outcome: accepted");
	});

	it("archives materialized reproduced research comparisons as accepted", async () => {
		using tempDir = TempDir.createSync("@omh-research-reproduction-materialized-reproduced-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();

		await Bun.write(
			`${cwd}/workflow-output/reproduction-baseline.json`,
			`${JSON.stringify(
				{
					exerciseSummary: {
						exercised: true,
						positiveSignals: ["assertion-backed-command"],
						negativeSignals: false,
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
					variantExerciseSummary: {
						exercised: true,
						positiveSignals: ["assertion-backed-command"],
						negativeSignals: false,
					},
					validationExerciseSummary: {
						exercised: true,
						positiveSignals: ["passed-count"],
						negativeSignals: false,
						passedCounts: 289,
					},
				},
				null,
				2,
			)}\n`,
		);
		await Bun.write(`${cwd}/workflow-output/reproduction-baseline.md`, "round-trip payload accepted\n");
		await Bun.write(`${cwd}/workflow-output/reproduction-variant.md`, "tamper rejected as expected\n289 passed\n");

		const result = await runExampleScript({
			cwd,
			previousCwd,
			nodeId: "archiveReproduction",
			scriptFileName: "archive-reproduction.js",
			scriptDir: RESEARCH_REPRODUCTION_SCRIPT_DIR,
			writes: ["/archive"],
			initialState: {
				reproduction: {
					status: "pass",
					exercised: true,
					evidencePath: "workflow-output/reproduction-baseline.json",
				},
				variant: {
					status: "pass",
					validationExercised: true,
					variantCommand: "PYTHONPATH=src python workflow-output/scripts/tamper_reject.py",
					evidencePath: "workflow-output/reproduction-variant.json",
				},
				comparison: {
					status: "comparison_materialized",
					source_node: "compareResults",
					data: {
						status: "pass",
						decision: "reproduced",
						claim: "Round-trip valid payloads and reject tampered serializer tokens.",
						comparison: {
							baselineReproduction: { status: "pass" },
							variantCommand: { status: "pass" },
							validationCommand: { status: "pass", separateFromVariant: true },
						},
						missingEvidence: [],
					},
				},
				review: "verdict finish",
			},
		});

		expect(result.scheduler.state.archive).toMatchObject({
			outcome: "accepted",
			comparison: "comparison_materialized",
		});
		expect(await Bun.file(`${cwd}/workflow-output/reproduction-archive.md`).text()).toContain("Outcome: accepted");
	});

	it("keeps research reproduction command streams in artifacts instead of inline state", async () => {
		using tempDir = TempDir.createSync("@omh-research-reproduction-variant-output-state-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();
		const largeValidationCommand = [
			"python -c 'import sys; ",
			'sys.stdout.write("3 passed\\n"); ',
			'[sys.stdout.write("validation line\\\\n") for _ in range(500)]; ',
			'sys.stdout.write("VALIDATION_" + "TAIL_UNIQUE\\\\n")\'',
		].join("");

		const result = await runExampleScript({
			cwd,
			previousCwd,
			nodeId: "runVariant",
			scriptFileName: "run-variant.js",
			scriptDir: RESEARCH_REPRODUCTION_SCRIPT_DIR,
			writes: ["/variant"],
			initialState: {
				task: {
					variantCommand: `python -c "assert 1 + 1 == 2; print('variant reproduced')"`,
					validationCommand: largeValidationCommand,
				},
			},
		});

		expect(result.scheduler.state.variant).toMatchObject({
			status: "pass",
			variantCommandEvidence: {
				role: "variant",
				exitCode: 0,
				stdoutPath: "workflow-output/reproduction-variant.json",
			},
			validationCommandEvidence: {
				role: "validation",
				exitCode: 0,
				stdoutPath: "workflow-output/reproduction-variant.json",
			},
		});
		const variantState = result.scheduler.state.variant as {
			variantStdout?: unknown;
			validationStdout?: unknown;
		};
		expect(variantState.variantStdout).toBeUndefined();
		expect(variantState.validationStdout).toBeUndefined();
		const serializedState = JSON.stringify(variantState);
		expect(serializedState).not.toContain("VALIDATION_TAIL_UNIQUE");
		const evidence = await Bun.file(`${cwd}/workflow-output/reproduction-variant.json`).json();
		expect(evidence.validationCommandEvidence.stdout).toContain("VALIDATION_TAIL_UNIQUE");
		expect(evidence.validation.stdout).toContain("VALIDATION_TAIL_UNIQUE");
	});

	it("keeps research reproduction variant and validation command evidence separate", async () => {
		using tempDir = TempDir.createSync("@omh-research-reproduction-separated-variant-validation-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();

		const result = await runExampleScript({
			cwd,
			previousCwd,
			nodeId: "runVariant",
			scriptFileName: "run-variant.js",
			scriptDir: RESEARCH_REPRODUCTION_SCRIPT_DIR,
			writes: ["/variant"],
			initialState: {
				task: {
					variantCommand: `python -c "print('variant exercised')"`,
					validationCommand: `python -c "print('896 passed')"`,
				},
			},
		});

		expect(result.scheduler.state.variant).toMatchObject({
			variantCommandEvidence: {
				role: "variant",
				exitCode: 0,
				stdoutPreview: "variant exercised\n",
			},
			validationCommandEvidence: {
				role: "validation",
				exitCode: 0,
				stdoutPreview: "896 passed\n",
			},
		});
		const variantState = result.scheduler.state.variant as {
			variantCommandEvidence?: { stdout?: unknown };
			validationCommandEvidence?: { stdout?: unknown };
		};
		expect(variantState.variantCommandEvidence?.stdout).toBeUndefined();
		expect(variantState.validationCommandEvidence?.stdout).toBeUndefined();
		const jsonEvidence = await Bun.file(`${cwd}/workflow-output/reproduction-variant.json`).json();
		expect(jsonEvidence.variantCommandEvidence).toMatchObject({
			role: "variant",
			stdout: "variant exercised\n",
		});
		expect(jsonEvidence.validationCommandEvidence).toMatchObject({
			role: "validation",
			stdout: "896 passed\n",
		});
		const evidence = await Bun.file(`${cwd}/workflow-output/reproduction-variant.md`).text();
		expect(evidence).toContain("### Variant stdout");
		expect(evidence).toContain("variant exercised");
		expect(evidence).toContain("### Validation stdout");
		expect(evidence).toContain("896 passed");
	});

	it("counts declared research reproduction variant and validation output signals as evidence", async () => {
		using tempDir = TempDir.createSync("@omh-research-reproduction-variant-validation-signals-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();

		const result = await runExampleScript({
			cwd,
			previousCwd,
			nodeId: "runVariant",
			scriptFileName: "run-variant.js",
			scriptDir: RESEARCH_REPRODUCTION_SCRIPT_DIR,
			writes: ["/variant"],
			initialState: {
				task: {
					variantCommand: "printf 'variant-ok\\n'",
					variantSignal: "variant-ok",
					validationCommand: "printf 'validation-ok\\n'",
					validationSignal: "validation-ok",
				},
			},
		});

		expect(result.scheduler.state.variant).toMatchObject({
			status: "pass",
			variantExerciseSummary: {
				exercised: true,
				positiveSignals: ["declared-output-signal"],
			},
			exerciseSummary: {
				exercised: true,
				positiveSignals: ["declared-output-signal"],
			},
			variantCommandEvidence: {
				expectedSignal: "variant-ok",
			},
			validationCommandEvidence: {
				expectedSignal: "validation-ok",
			},
		});
		const evidence = await Bun.file(`${cwd}/workflow-output/reproduction-variant.json`).json();
		expect(evidence).toMatchObject({
			variantSignal: "variant-ok",
			validationSignal: "validation-ok",
			variantExerciseSummary: {
				exercised: true,
				positiveSignals: ["declared-output-signal"],
			},
			validationExerciseSummary: {
				exercised: true,
				positiveSignals: ["declared-output-signal"],
			},
		});
	});

	it("records absent research reproduction variant command evidence as null", async () => {
		using tempDir = TempDir.createSync("@omh-research-reproduction-absent-variant-command-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();

		const result = await runExampleScript({
			cwd,
			previousCwd,
			nodeId: "runVariant",
			scriptFileName: "run-variant.js",
			scriptDir: RESEARCH_REPRODUCTION_SCRIPT_DIR,
			writes: ["/variant"],
			initialState: {
				task: {
					validationCommand: `python -c "print('9 passed')"`,
				},
			},
		});

		expect(result.scheduler.state.variant).toMatchObject({
			status: "pass",
			variantCommandEvidence: null,
			validationCommandEvidence: {
				role: "validation",
				exitCode: 0,
			},
		});
		const jsonEvidence = await Bun.file(`${cwd}/workflow-output/reproduction-variant.json`).json();
		expect(jsonEvidence.variantCommandEvidence).toBeNull();
		expect(jsonEvidence.validationCommandEvidence).toMatchObject({
			role: "validation",
			stdout: "9 passed\n",
		});
	});

	it("counts script-backed negative controls as research reproduction variant exercise", async () => {
		using tempDir = TempDir.createSync("@omh-research-reproduction-negative-control-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();
		await Bun.write(
			`${cwd}/workflow-output/scripts/tamper_reject.py`,
			[
				"try:",
				"    raise ValueError('bad signature')",
				"except ValueError:",
				"    print('tamper rejected')",
				"else:",
				"    raise SystemExit('tamper unexpectedly accepted')",
				"",
			].join("\n"),
		);

		const result = await runExampleScript({
			cwd,
			previousCwd,
			nodeId: "runVariant",
			scriptFileName: "run-variant.js",
			scriptDir: RESEARCH_REPRODUCTION_SCRIPT_DIR,
			writes: ["/variant"],
			initialState: {
				task: {
					variantCommand: "python workflow-output/scripts/tamper_reject.py",
					validationCommand: `python -c "print('4 passed')"`,
				},
			},
		});

		expect(result.scheduler.state.variant).toMatchObject({
			status: "pass",
			variantExerciseSummary: {
				exercised: true,
				positiveSignals: ["negative-control-output"],
			},
		});
		const evidence = await Bun.file(`${cwd}/workflow-output/reproduction-variant.json`).json();
		expect(evidence.variantExerciseSummary).toMatchObject({
			exercised: true,
			positiveSignals: ["negative-control-output"],
		});
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

	it("rejects directory validation executables before agent build rounds", async () => {
		using tempDir = TempDir.createSync("@omh-agent-loop-directory-validation-command-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();
		const runTmp = `${cwd}/run-tmp`;
		await fs.mkdir(runTmp, { recursive: true });

		await Bun.write(
			`${cwd}/task.md`,
			[
				"Objective:",
				"Reject validation commands whose executable token cannot start.",
				"",
				"Validation Command:",
				`TMPDIR=${runTmp} PYTHONPATH=. ${runTmp} -m pytest tests/test_completion.py -q`,
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

		const activation = result.scheduler.activations.find(item => item.nodeId === "initializeLoop");
		expect(activation?.status).toBe("failed");
		expect(activation?.error).toContain("validation executable is a directory");
		const preflight = await Bun.file(`${cwd}/workflow-output/setup-blocker-validation-preflight.json`).json();
		expect(preflight).toMatchObject({
			status: "setup-blocker",
			executable: runTmp,
		});
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
				"",
				"No-Change Allowed:",
				"yes",
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

	it("blocks accepted agent build review archive without scheduler lineage", async () => {
		using tempDir = TempDir.createSync("@omh-agent-loop-archive-lineage-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();

		await Bun.write(
			`${cwd}/task.md`,
			[
				"Objective:",
				"Archive only after real build, review, and semantic guard activations.",
				"",
				"Validation Command:",
				"echo validate",
				"",
				"No-Change allowed:",
				"yes",
			].join("\n"),
		);
		await Bun.write(`${cwd}/progress.md`, "ROUND 1: implementation and review completed\n");
		await Bun.write(`${cwd}/workflow-output/round-1/validation-stdout.txt`, "ok\n");
		await Bun.write(`${cwd}/workflow-output/round-1/validation-stderr.txt`, "");
		await Bun.write(`${cwd}/workflow-output/review-route-1.json`, "{}\n");

		const result = await runExampleScript({
			cwd,
			previousCwd,
			nodeId: "archiveLoop",
			scriptFileName: "archive-loop.js",
			scriptDir: AGENT_BUILD_REVIEW_LOOP_SCRIPT_DIR,
			writes: ["/archive"],
			initialState: {
				reviewRoute: {
					decision: "complete",
					reason: "manually supplied complete route",
					reviewVerdict: "complete",
					reviewDecisionTrailFile: "workflow-output/review-route-1.json",
				},
				semanticGuard: {
					verdict: "PASS",
					findings: [],
				},
			},
		});

		const activation = result.scheduler.activations.find(item => item.nodeId === "archiveLoop");
		expect(activation?.status).toBe("failed");
		expect(activation?.error).toContain("missing scheduler lineage");
		expect(activation?.error).toContain("initialBuildRound");
	});

	it("routes completed agent build reviews to semantic archive despite incidental continue text", async () => {
		using tempDir = TempDir.createSync("@omh-agent-loop-complete-review-route-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();
		const classifyRouteScript = await Bun.file(
			`${AGENT_BUILD_REVIEW_LOOP_SCRIPT_DIR}/classify-review-route.js`,
		).text();

		await Bun.write(
			`${cwd}/task.md`,
			["Objective:", "Route a completed review to archive.", "", "Validation Command:", "echo validate"].join("\n"),
		);
		await Bun.write(`${cwd}/progress.md`, "ROUND 1: added focused test evidence and validation passed.\n");

		const result = await runExampleDefinition({
			cwd,
			previousCwd,
			definition: {
				name: "agent-loop-review-route",
				version: 1,
				models: { roles: {}, defaults: {} },
				nodes: [
					{
						id: "reviewRound",
						type: "script",
						script: {
							language: "js",
							code: [
								"return {",
								"  summary: 'The review assignment is complete: the task contract, progress log, diff, local instructions, and validation artifacts were checked, and the required output verdict was already determined as complete. No merge-blocking project issue was found in the reviewed state.',",
								"  data: { verdict: 'continue' },",
								"};",
							].join("\n"),
						},
						writes: ["/review"],
					},
					{
						id: "classifyReviewRoute",
						type: "script",
						script: {
							language: "js",
							code: classifyRouteScript,
						},
						writes: ["/reviewRoute"],
					},
				],
				edges: [{ from: "reviewRound", to: "classifyReviewRoute" }],
			},
		});

		expect(result.scheduler.state.reviewRoute).toMatchObject({
			decision: "complete",
			reviewVerdict: "continue",
			completionSatisfiedButContinued: true,
		});
	});

	it("routes review protocol drift to archive when the review says the route should complete", async () => {
		using tempDir = TempDir.createSync("@omh-agent-loop-review-protocol-drift-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();
		const classifyRouteScript = await Bun.file(
			`${AGENT_BUILD_REVIEW_LOOP_SCRIPT_DIR}/classify-review-route.js`,
		).text();

		await Bun.write(
			`${cwd}/task.md`,
			["Objective:", "Route a completed review to archive.", "", "Validation Command:", "echo validate"].join("\n"),
		);
		await Bun.write(`${cwd}/progress.md`, "ROUND 1: added focused test evidence and validation passed.\n");

		const result = await runExampleDefinition({
			cwd,
			previousCwd,
			definition: {
				name: "agent-loop-review-protocol-drift-route",
				version: 1,
				models: { roles: {}, defaults: {} },
				nodes: [
					{
						id: "reviewRound",
						type: "script",
						script: {
							language: "js",
							code: [
								"return {",
								"  summary: 'The build/review route should return complete: task.md declares no minimum round count, progress.md has one real ROUND line, and the declared validation command has latest passing evidence with durable stdout/stderr artifacts. No applicable local instruction violation or task-specific byproduct blocker was found.',",
								"  data: { verdict: 'continue', overall_correctness: 'correct', findings: [] },",
								"};",
							].join("\n"),
						},
						writes: ["/review"],
					},
					{
						id: "classifyReviewRoute",
						type: "script",
						script: {
							language: "js",
							code: classifyRouteScript,
						},
						writes: ["/reviewRoute"],
					},
				],
				edges: [{ from: "reviewRound", to: "classifyReviewRoute" }],
			},
		});

		expect(result.scheduler.state.reviewRoute).toMatchObject({
			decision: "complete",
			reviewVerdict: "continue",
			completionSatisfiedButContinued: true,
		});
	});

	it("routes accepted code-review shaped agent build reviews to archive", async () => {
		using tempDir = TempDir.createSync("@omh-agent-loop-code-review-accepted-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();
		const classifyRouteScript = await Bun.file(
			`${AGENT_BUILD_REVIEW_LOOP_SCRIPT_DIR}/classify-review-route.js`,
		).text();

		await Bun.write(
			`${cwd}/task.md`,
			[
				"Objective:",
				"Route a completed review to archive.",
				"",
				"Requires at least three meaningful build/review cycles.",
				"",
				"Validation Command:",
				"echo validate",
			].join("\n"),
		);
		await Bun.write(
			`${cwd}/progress.md`,
			[
				"ROUND 1: added focused implementation evidence and validation passed.",
				"ROUND 2: repaired review feedback and validation passed.",
				"ROUND 3: repaired final style issue and validation passed.",
			].join("\n"),
		);

		const result = await runExampleDefinition({
			cwd,
			previousCwd,
			definition: {
				name: "agent-loop-code-review-accepted-route",
				version: 1,
				models: { roles: {}, defaults: {} },
				nodes: [
					{
						id: "reviewRound",
						type: "script",
						script: {
							language: "js",
							code: [
								"return {",
								"  summary: 'The task contract is satisfied: progress.md has 3 ROUND entries and no further build round is required.',",
								"  data: {",
								"    verdict: 'continue',",
								"    overall_correctness: 'correct',",
								"    explanation: 'The task contract is satisfied: progress.md has 3 ROUND entries against the required minimum of 3, validation passed, and I found no applicable local instruction violation or task-specific byproduct requiring another build round.',",
								"    findings: [],",
								"  },",
								"};",
							].join("\n"),
						},
						writes: ["/review"],
					},
					{
						id: "classifyReviewRoute",
						type: "script",
						script: {
							language: "js",
							code: classifyRouteScript,
						},
						writes: ["/reviewRoute"],
					},
				],
				edges: [{ from: "reviewRound", to: "classifyReviewRoute" }],
			},
		});

		expect(result.scheduler.state.reviewRoute).toMatchObject({
			decision: "complete",
			reviewVerdict: "continue",
			completionSatisfiedButContinued: true,
		});
	});

	it("routes structurally correct reviews to archive without depending on summary wording", async () => {
		using tempDir = TempDir.createSync("@omh-agent-loop-structured-review-accepted-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();
		const classifyRouteScript = await Bun.file(
			`${AGENT_BUILD_REVIEW_LOOP_SCRIPT_DIR}/classify-review-route.js`,
		).text();

		await Bun.write(
			`${cwd}/task.md`,
			[
				"Objective:",
				"Route a completed review to archive.",
				"",
				"Requires at least three meaningful build/review cycles.",
				"",
				"Validation Command:",
				"echo validate",
			].join("\n"),
		);
		await Bun.write(
			`${cwd}/progress.md`,
			[
				"ROUND 1: added focused implementation evidence and validation passed.",
				"ROUND 2: repaired review feedback and validation passed.",
				"ROUND 3: repaired final style issue and validation passed.",
			].join("\n"),
		);

		const result = await runExampleDefinition({
			cwd,
			previousCwd,
			definition: {
				name: "agent-loop-structured-review-accepted-route",
				version: 1,
				models: { roles: {}, defaults: {} },
				nodes: [
					{
						id: "reviewRound",
						type: "script",
						script: {
							language: "js",
							code: [
								"return {",
								"  summary: 'The project-specific contract is satisfied and validation artifacts were checked.',",
								"  data: { verdict: 'continue', overall_correctness: 'correct', findings: [] },",
								"};",
							].join("\n"),
						},
						writes: ["/review"],
					},
					{
						id: "classifyReviewRoute",
						type: "script",
						script: {
							language: "js",
							code: classifyRouteScript,
						},
						writes: ["/reviewRoute"],
					},
				],
				edges: [{ from: "reviewRound", to: "classifyReviewRoute" }],
			},
		});

		expect(result.scheduler.state.reviewRoute).toMatchObject({
			decision: "complete",
			reviewVerdict: "continue",
			structuredCorrectnessAccepted: true,
		});
	});

	it("treats trailing slash allowed paths as recursive scope fences", async () => {
		using tempDir = TempDir.createSync("@omh-agent-loop-trailing-slash-scope-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();

		await runGit(cwd, ["init"]);
		await runGit(cwd, ["config", "user.email", "omh@example.invalid"]);
		await runGit(cwd, ["config", "user.name", "OMH Test"]);
		await Bun.write(
			`${cwd}/task.md`,
			[
				"Objective:",
				"Verify scope fence matching.",
				"",
				"Validation Command:",
				"echo validate",
				"",
				"Scope Fence:",
				"Allowed paths: crates/ignore/, workflow-output/, progress.md.",
			].join("\n"),
		);
		await runGit(cwd, ["add", "task.md"]);
		await runGit(cwd, ["commit", "-m", "baseline"]);
		await Bun.write(`${cwd}/crates/ignore/src/gitignore.rs`, "pub fn touched() {}\n");
		await Bun.write(
			`${cwd}/workflow-output/round-1/implementation-notes.md`,
			[
				"Changed files:",
				"- crates/ignore/src/gitignore.rs",
				"  - Rollback: remove the touched helper if this scope fixture is rejected.",
			].join("\n"),
		);

		const result = await runExampleScript({
			cwd,
			previousCwd,
			nodeId: "semanticArchiveGuard",
			scriptFileName: "semantic-archive-guard.js",
			scriptDir: AGENT_BUILD_REVIEW_LOOP_SCRIPT_DIR,
			writes: ["/semanticGuard"],
		});

		expect(result.scheduler.state.semanticGuard).toMatchObject({
			verdict: "PASS",
		});
		expect(await Bun.file(`${cwd}/workflow-output/semantic-archive-guard.json`).json()).toMatchObject({
			verdict: "PASS",
			findings: [],
		});
	});

	it("treats multiline allowed path bullets as recursive scope fences", async () => {
		using tempDir = TempDir.createSync("@omh-agent-loop-multiline-scope-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();

		await runGit(cwd, ["init"]);
		await runGit(cwd, ["config", "user.email", "omh@example.invalid"]);
		await runGit(cwd, ["config", "user.name", "OMH Test"]);
		await Bun.write(
			`${cwd}/task.md`,
			[
				"Objective:",
				"Verify multiline scope fence matching.",
				"",
				"Validation Command: python -m pytest tests/test_cli/test_help.py -q",
				"",
				"Allowed paths:",
				"- typer/",
				"- tests/test_cli/",
				"- workflow-output/",
				"- progress.md",
				"",
				"Acceptance Criteria:",
				"- Keep edits inside the declared folders.",
			].join("\n"),
		);
		await runGit(cwd, ["add", "task.md"]);
		await runGit(cwd, ["commit", "-m", "baseline"]);
		await Bun.write(`${cwd}/tests/test_cli/test_help.py`, "def test_help_panel():\n    assert True\n");
		await Bun.write(
			`${cwd}/workflow-output/round-1/implementation-notes.md`,
			[
				"Changed files:",
				"- tests/test_cli/test_help.py",
				"  - Rollback: remove the focused help panel regression if rejected.",
			].join("\n"),
		);

		const result = await runExampleScript({
			cwd,
			previousCwd,
			nodeId: "semanticArchiveGuard",
			scriptFileName: "semantic-archive-guard.js",
			scriptDir: AGENT_BUILD_REVIEW_LOOP_SCRIPT_DIR,
			writes: ["/semanticGuard"],
		});

		expect(result.scheduler.state.semanticGuard).toMatchObject({
			verdict: "PASS",
		});
		expect(await Bun.file(`${cwd}/workflow-output/semantic-archive-guard.json`).json()).toMatchObject({
			verdict: "PASS",
			findings: [],
		});
	});

	it("treats glob allowed paths as recursive scope fences", async () => {
		using tempDir = TempDir.createSync("@omh-agent-loop-glob-allowed-paths-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();

		await runGit(cwd, ["init"]);
		await runGit(cwd, ["config", "user.email", "omh@example.invalid"]);
		await runGit(cwd, ["config", "user.name", "OMH Test"]);
		await Bun.write(
			`${cwd}/task.md`,
			[
				"Objective:",
				"Verify glob scope fence matching.",
				"",
				"Validation Command:",
				"echo validate",
				"",
				"Scope Fence:",
				"Allowed paths: tests/test_tutorial/test_query_params*/**, workflow-output/, progress.md.",
			].join("\n"),
		);
		await runGit(cwd, ["add", "task.md"]);
		await runGit(cwd, ["commit", "-m", "baseline"]);
		await Bun.write(
			`${cwd}/tests/test_tutorial/test_query_params/test_tutorial006.py`,
			"def test_query_params():\n    assert True\n",
		);
		await Bun.write(
			`${cwd}/workflow-output/round-1/implementation-notes.md`,
			[
				"Changed files:",
				"- tests/test_tutorial/test_query_params/test_tutorial006.py",
				"  - Rollback: remove the focused query params regression if rejected.",
			].join("\n"),
		);

		const result = await runExampleScript({
			cwd,
			previousCwd,
			nodeId: "semanticArchiveGuard",
			scriptFileName: "semantic-archive-guard.js",
			scriptDir: AGENT_BUILD_REVIEW_LOOP_SCRIPT_DIR,
			writes: ["/semanticGuard"],
		});

		expect(result.scheduler.state.semanticGuard).toMatchObject({
			verdict: "PASS",
		});
		expect(await Bun.file(`${cwd}/workflow-output/semantic-archive-guard.json`).json()).toMatchObject({
			verdict: "PASS",
			findings: [],
		});
	});

	it("fails agent build archive guard when task.md changes after workflow initialization", async () => {
		using tempDir = TempDir.createSync("@omh-agent-loop-task-contract-drift-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();
		const frozenTask = [
			"Objective:",
			"Keep semantic edits inside the frozen task contract.",
			"",
			"Validation Command:",
			"echo validate",
			"",
			"Scope Fence:",
			"Allowed paths: src/, workflow-output/, progress.md.",
		].join("\n");
		const widenedTask = frozenTask.replace(
			"Allowed paths: src/, workflow-output/, progress.md.",
			"Allowed paths: src/, tests/, workflow-output/, progress.md.",
		);

		await runGit(cwd, ["init"]);
		await runGit(cwd, ["config", "user.email", "omh@example.invalid"]);
		await runGit(cwd, ["config", "user.name", "OMH Test"]);
		await Bun.write(`${cwd}/task.md`, frozenTask);
		await runGit(cwd, ["add", "task.md"]);
		await runGit(cwd, ["commit", "-m", "baseline"]);
		await Bun.write(`${cwd}/workflow-output/task-contract.md`, frozenTask);
		await Bun.write(`${cwd}/task.md`, widenedTask);
		await Bun.write(`${cwd}/tests/test_contract.py`, "def test_contract():\n    assert True\n");

		const result = await runExampleScript({
			cwd,
			previousCwd,
			nodeId: "semanticArchiveGuard",
			scriptFileName: "semantic-archive-guard.js",
			scriptDir: AGENT_BUILD_REVIEW_LOOP_SCRIPT_DIR,
			writes: ["/semanticGuard"],
			initialState: {
				runtime: {
					taskContractFile: "workflow-output/task-contract.md",
					taskHash: String(Bun.hash(frozenTask)),
				},
			},
		});

		expect(result.scheduler.state.semanticGuard).toMatchObject({
			verdict: "REPAIR",
			findings: expect.arrayContaining([
				expect.objectContaining({
					file: "task.md",
					reason: "task contract changed after workflow initialization",
				}),
				expect.objectContaining({
					file: "tests/test_contract.py",
					reason: "changed file is outside task allowed paths",
				}),
			]),
		});
	});

	it("fails agent build archive guard when changed files lack rollback evidence", async () => {
		using tempDir = TempDir.createSync("@omh-agent-loop-missing-rollback-evidence-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();

		await runGit(cwd, ["init"]);
		await runGit(cwd, ["config", "user.email", "omh@example.invalid"]);
		await runGit(cwd, ["config", "user.name", "OMH Test"]);
		await Bun.write(
			`${cwd}/task.md`,
			[
				"Objective:",
				"Reject archives before changed files have concrete rollback evidence.",
				"",
				"Validation Command:",
				"echo validate",
				"",
				"Scope Fence:",
				"Allowed paths: src.py, workflow-output/, progress.md.",
			].join("\n"),
		);
		await Bun.write(`${cwd}/src.py`, "value = 1\n");
		await runGit(cwd, ["add", "task.md", "src.py"]);
		await runGit(cwd, ["commit", "-m", "baseline"]);
		await Bun.write(`${cwd}/src.py`, "value = 2\n");
		await Bun.write(`${cwd}/progress.md`, "ROUND 1: changed src.py; validation=echo validate; result=pass\n");
		await Bun.write(`${cwd}/workflow-output/round-1/validation-stdout.txt`, "validate\n");
		await Bun.write(`${cwd}/workflow-output/round-1/validation-stderr.txt`, "");

		const result = await runExampleScript({
			cwd,
			previousCwd,
			nodeId: "semanticArchiveGuard",
			scriptFileName: "semantic-archive-guard.js",
			scriptDir: AGENT_BUILD_REVIEW_LOOP_SCRIPT_DIR,
			writes: ["/semanticGuard"],
		});

		expect(result.scheduler.state.semanticGuard).toMatchObject({
			verdict: "REPAIR",
			findings: expect.arrayContaining([
				expect.objectContaining({
					file: "src.py",
					reason: "changed file lacks concrete rollback evidence",
				}),
			]),
		});
	});

	it("archives concrete rollback notes for changed agent loop files", async () => {
		using tempDir = TempDir.createSync("@omh-agent-loop-archive-concrete-rollback-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();
		const taskText = [
			"Objective:",
			"Archive a scoped source change with concrete rollback evidence.",
			"",
			"Validation Command:",
			"echo validate",
			"",
			"Scope Fence:",
			"Allowed paths: src.py, workflow-output/, progress.md.",
			"",
			"Rollback Plan:",
			"Before archive, write rollback notes for every changed file.",
		].join("\n");
		const archiveCode = await Bun.file(`${AGENT_BUILD_REVIEW_LOOP_SCRIPT_DIR}/archive-loop.js`).text();
		const definition: WorkflowDefinition = {
			name: "agent-loop-archive-concrete-rollback-test",
			version: 1,
			models: { roles: {}, defaults: {} },
			nodes: [
				{
					id: "initialBuildRound",
					type: "script",
					script: { language: "js", code: "return { summary: 'build complete' };" },
					writes: ["/progress"],
				},
				{
					id: "reviewRound",
					type: "script",
					script: { language: "js", code: "return { summary: 'review complete' };" },
					writes: ["/review"],
				},
				{
					id: "classifyReviewRoute",
					type: "script",
					script: {
						language: "js",
						code: [
							"return {",
							"  summary: 'review route complete',",
							"  statePatch: [{ op: 'set', path: '/reviewRoute', value: { decision: 'complete', reason: 'review accepted concrete rollback evidence', reviewVerdict: 'complete' } }],",
							"};",
						].join("\n"),
					},
					writes: ["/reviewRoute"],
				},
				{
					id: "semanticArchiveGuard",
					type: "script",
					script: { language: "js", code: "return { summary: 'semantic guard passed' };" },
					writes: ["/semanticGuard"],
				},
				{
					id: "archiveLoop",
					type: "script",
					script: { language: "js", code: archiveCode },
					writes: ["/archive"],
				},
			],
			edges: [
				{ from: "initialBuildRound", to: "reviewRound" },
				{ from: "reviewRound", to: "classifyReviewRoute" },
				{ from: "classifyReviewRoute", to: "semanticArchiveGuard" },
				{ from: "semanticArchiveGuard", to: "archiveLoop" },
			],
		};

		await runGit(cwd, ["init"]);
		await runGit(cwd, ["config", "user.email", "omh@example.invalid"]);
		await runGit(cwd, ["config", "user.name", "OMH Test"]);
		await Bun.write(`${cwd}/task.md`, taskText);
		await Bun.write(`${cwd}/src.py`, "value = 1\n");
		await runGit(cwd, ["add", "task.md", "src.py"]);
		await runGit(cwd, ["commit", "-m", "baseline"]);
		await Bun.write(`${cwd}/src.py`, "value = 2\n");
		await Bun.write(`${cwd}/progress.md`, "ROUND 1: changed src.py; validation=echo validate; result=pass\n");
		await Bun.write(
			`${cwd}/workflow-output/round-1/validation-summary.txt`,
			[
				"Round 1 validation summary",
				"",
				"Retained project file change:",
				"",
				"- `src.py`: changed the value used by the scoped source path.",
				"",
				"Rollback procedure:",
				"",
				"- To revert the retained project-file change, restore `src.py` to `value = 1`.",
			].join("\n"),
		);
		for (const file of [
			"validation-stdout.txt",
			"validation-stderr.txt",
			"validation-attempt-1-stdout.txt",
			"validation-attempt-1-stderr.txt",
		]) {
			await Bun.write(`${cwd}/workflow-output/round-1/${file}`, "validate\n");
		}

		await runExampleDefinition({ cwd, previousCwd, definition });

		const archive = await Bun.file(`${cwd}/workflow-output/final-agent-loop-archive.md`).text();
		expect(archive).toContain("src.py: To revert the retained project-file change, restore `src.py` to `value = 1`.");
		expect(archive).not.toContain("Rollback risk: Before archive, write rollback notes for every changed file.");
	});

	it("accepts sectioned agent loop rollback procedures for changed files", async () => {
		using tempDir = TempDir.createSync("@omh-agent-loop-sectioned-rollback-procedure-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();

		await runGit(cwd, ["init"]);
		await runGit(cwd, ["config", "user.email", "omh@example.invalid"]);
		await runGit(cwd, ["config", "user.name", "OMH Test"]);
		await Bun.write(
			`${cwd}/task.md`,
			[
				"Objective:",
				"Accept sectioned rollback procedures tied to the changed file list.",
				"",
				"Validation Command:",
				"echo validate",
				"",
				"Scope Fence:",
				"Allowed paths: tests/test_tutorial/test_query_params/test_tutorial001.py, workflow-output/, progress.md.",
				"",
				"Rollback Plan:",
				"Before archive, write rollback notes for every changed file.",
			].join("\n"),
		);
		await Bun.write(
			`${cwd}/tests/test_tutorial/test_query_params/test_tutorial001.py`,
			"def test_existing():\n    pass\n",
		);
		await runGit(cwd, ["add", "task.md", "tests/test_tutorial/test_query_params/test_tutorial001.py"]);
		await runGit(cwd, ["commit", "-m", "baseline"]);
		await Bun.write(
			`${cwd}/tests/test_tutorial/test_query_params/test_tutorial001.py`,
			"def test_existing():\n    pass\n\n\ndef test_invalid_skip_limit_query_params():\n    pass\n",
		);
		await Bun.write(
			`${cwd}/progress.md`,
			"ROUND 1: tightened invalid query integer regression; validation=echo validate; result=pass\n",
		);
		await Bun.write(
			`${cwd}/workflow-output/round-1/rollback.md`,
			[
				"# Rollback Notes",
				"",
				"Retained project file change:",
				"",
				"- `tests/test_tutorial/test_query_params/test_tutorial001.py`: added `test_invalid_skip_limit_query_params` to lock the 422 JSON error surface.",
				"",
				"Rollback procedure:",
				"",
				"- To revert the retained project-file change, delete the entire `test_invalid_skip_limit_query_params` function from `tests/test_tutorial/test_query_params/test_tutorial001.py`, leaving the existing tests unchanged.",
			].join("\n"),
		);
		await Bun.write(`${cwd}/workflow-output/round-1/validation-stdout.txt`, "validate\n");
		await Bun.write(`${cwd}/workflow-output/round-1/validation-stderr.txt`, "");
		await Bun.write(`${cwd}/workflow-output/round-1/validation-attempt-1-stdout.txt`, "validate\n");
		await Bun.write(`${cwd}/workflow-output/round-1/validation-attempt-1-stderr.txt`, "");

		const result = await runExampleScript({
			cwd,
			previousCwd,
			nodeId: "semanticArchiveGuard",
			scriptFileName: "semantic-archive-guard.js",
			scriptDir: AGENT_BUILD_REVIEW_LOOP_SCRIPT_DIR,
			writes: ["/semanticGuard"],
		});

		expect(result.scheduler.state.semanticGuard).toMatchObject({
			verdict: "PASS",
			findings: [],
		});
	});

	it("accepts per-file heading rollback notes for changed agent loop files", async () => {
		using tempDir = TempDir.createSync("@omh-agent-loop-per-file-heading-rollback-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();

		await runGit(cwd, ["init"]);
		await runGit(cwd, ["config", "user.email", "omh@example.invalid"]);
		await runGit(cwd, ["config", "user.name", "OMH Test"]);
		await Bun.write(
			`${cwd}/task.md`,
			[
				"Objective:",
				"Accept per-file heading rollback evidence from a real agent build loop.",
				"",
				"Validation Command:",
				"echo validate",
				"",
				"Scope Fence:",
				"Allowed paths: tests/test_tutorial/test_query_params/test_tutorial001.py, tests/test_tutorial/test_body/test_tutorial001.py, workflow-output/, progress.md.",
			].join("\n"),
		);
		await Bun.write(
			`${cwd}/tests/test_tutorial/test_query_params/test_tutorial001.py`,
			"def test_read_user_item():\n    pass\n\n\ndef test_openapi_schema():\n    pass\n",
		);
		await Bun.write(
			`${cwd}/tests/test_tutorial/test_body/test_tutorial001.py`,
			"def test_post_with_only_name_price():\n    pass\n\n\ndef test_post_with_no_data():\n    pass\n",
		);
		await runGit(cwd, [
			"add",
			"task.md",
			"tests/test_tutorial/test_query_params/test_tutorial001.py",
			"tests/test_tutorial/test_body/test_tutorial001.py",
		]);
		await runGit(cwd, ["commit", "-m", "baseline"]);
		await Bun.write(
			`${cwd}/tests/test_tutorial/test_query_params/test_tutorial001.py`,
			"def test_read_user_item():\n    pass\n\n\ndef test_invalid_query_params():\n    pass\n\n\ndef test_openapi_schema():\n    pass\n",
		);
		await Bun.write(
			`${cwd}/tests/test_tutorial/test_body/test_tutorial001.py`,
			"def test_post_with_only_name_price():\n    pass\n\n\ndef test_post_with_multiple_invalid_numbers():\n    pass\n\n\ndef test_post_with_no_data():\n    pass\n",
		);
		await Bun.write(
			`${cwd}/progress.md`,
			"ROUND 4: added query and body validation canaries; validation=echo validate; result=pass\n",
		);
		await Bun.write(
			`${cwd}/workflow-output/round-4/rollback-evidence.md`,
			[
				"# Round 4 Rollback Evidence",
				"",
				"## tests/test_tutorial/test_query_params/test_tutorial001.py",
				"",
				"Retained change: the query tutorial test suite includes `test_invalid_query_params`.",
				"",
				"Concrete rollback/revert/restore/remove note: to roll back this file only, restore `tests/test_tutorial/test_query_params/test_tutorial001.py` from the baseline with `git restore tests/test_tutorial/test_query_params/test_tutorial001.py`. The equivalent manual rollback is to remove the entire `test_invalid_query_params` function block.",
				"",
				"## tests/test_tutorial/test_body/test_tutorial001.py",
				"",
				"Retained change: the body tutorial test suite includes `test_post_with_multiple_invalid_numbers`.",
				"",
				"Concrete per-file rollback/revert/restore/remove note: revert this file by removing the whole `test_post_with_multiple_invalid_numbers` test function. A file-level restore rollback is also valid: run `git restore -- tests/test_tutorial/test_body/test_tutorial001.py`.",
			].join("\n"),
		);
		for (const file of [
			"validation-stdout.txt",
			"validation-stderr.txt",
			"validation-attempt-1-stdout.txt",
			"validation-attempt-1-stderr.txt",
		]) {
			await Bun.write(`${cwd}/workflow-output/round-4/${file}`, "validate\n");
		}

		const result = await runExampleScript({
			cwd,
			previousCwd,
			nodeId: "semanticArchiveGuard",
			scriptFileName: "semantic-archive-guard.js",
			scriptDir: AGENT_BUILD_REVIEW_LOOP_SCRIPT_DIR,
			writes: ["/semanticGuard"],
		});

		expect(result.scheduler.state.semanticGuard).toMatchObject({
			verdict: "PASS",
			findings: [],
		});
	});

	it("does not require extra validation attempt logs for ambiguous cross-round rerun prose", async () => {
		using tempDir = TempDir.createSync("@omh-agent-loop-validation-rerun-prose-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();

		await runGit(cwd, ["init"]);
		await runGit(cwd, ["config", "user.email", "omh@example.invalid"]);
		await runGit(cwd, ["config", "user.name", "OMH Test"]);
		await Bun.write(
			`${cwd}/task.md`,
			[
				"Objective:",
				"Verify validation evidence without forcing a bookkeeping round.",
				"",
				"Validation Command:",
				"echo validate",
				"",
				"Allowed paths:",
				"- workflow-output/",
				"- progress.md",
			].join("\n"),
		);
		await runGit(cwd, ["add", "task.md"]);
		await runGit(cwd, ["commit", "-m", "baseline"]);
		await Bun.write(
			`${cwd}/progress.md`,
			"ROUND 2: repaired prior review feedback; validation = passed; result = pass\n",
		);
		await Bun.write(`${cwd}/workflow-output/round-2/validation-stdout.txt`, "validation passed\n");
		await Bun.write(`${cwd}/workflow-output/round-2/validation-stderr.txt`, "");
		await Bun.write(
			`${cwd}/workflow-output/round-2/summary.md`,
			"Reran validation after prior review feedback in a new workflow round.\n",
		);

		const result = await runExampleScript({
			cwd,
			previousCwd,
			nodeId: "semanticArchiveGuard",
			scriptFileName: "semantic-archive-guard.js",
			scriptDir: AGENT_BUILD_REVIEW_LOOP_SCRIPT_DIR,
			writes: ["/semanticGuard"],
		});

		expect(result.scheduler.state.semanticGuard).toMatchObject({
			verdict: "PASS",
		});
		expect(await Bun.file(`${cwd}/workflow-output/semantic-archive-guard.json`).json()).toMatchObject({
			verdict: "PASS",
			findings: [],
		});
	});

	it("requires durable logs when same-round validation attempt numbers are explicit", async () => {
		using tempDir = TempDir.createSync("@omh-agent-loop-validation-attempt-retention-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();

		await runGit(cwd, ["init"]);
		await runGit(cwd, ["config", "user.email", "omh@example.invalid"]);
		await runGit(cwd, ["config", "user.name", "OMH Test"]);
		await Bun.write(
			`${cwd}/task.md`,
			[
				"Objective:",
				"Verify validation attempt retention.",
				"",
				"Validation Command:",
				"echo validate",
				"",
				"Allowed paths:",
				"- workflow-output/",
				"- progress.md",
			].join("\n"),
		);
		await runGit(cwd, ["add", "task.md"]);
		await runGit(cwd, ["commit", "-m", "baseline"]);
		await Bun.write(`${cwd}/progress.md`, "ROUND 1: repaired test evidence; validation = passed; result = pass\n");
		await Bun.write(`${cwd}/workflow-output/round-1/validation-stdout.txt`, "validation passed\n");
		await Bun.write(`${cwd}/workflow-output/round-1/validation-stderr.txt`, "");
		await Bun.write(`${cwd}/workflow-output/round-1/validation-attempt-1-stdout.txt`, "failed before repair\n");
		await Bun.write(`${cwd}/workflow-output/round-1/validation-attempt-1-stderr.txt`, "failure\n");
		await Bun.write(
			`${cwd}/workflow-output/round-1/summary.md`,
			"Validation attempt 1 failed; validation attempt 2 passed after the same round repair.\n",
		);

		const result = await runExampleScript({
			cwd,
			previousCwd,
			nodeId: "semanticArchiveGuard",
			scriptFileName: "semantic-archive-guard.js",
			scriptDir: AGENT_BUILD_REVIEW_LOOP_SCRIPT_DIR,
			writes: ["/semanticGuard"],
		});

		expect(result.scheduler.state.semanticGuard).toMatchObject({
			verdict: "REPAIR",
		});
		expect(await Bun.file(`${cwd}/workflow-output/semantic-archive-guard.json`).json()).toMatchObject({
			verdict: "REPAIR",
			findings: [
				expect.objectContaining({
					reason: "validation rerun evidence is missing immutable attempt stdout/stderr logs",
					missingFiles: expect.arrayContaining([
						"workflow-output/round-1/validation-attempt-2-stdout.txt",
						"workflow-output/round-1/validation-attempt-2-stderr.txt",
					]),
				}),
			],
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

	it("accepts Markdown headings in parallel review task contracts", async () => {
		using tempDir = TempDir.createSync("@omh-parallel-review-markdown-contract-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();
		const tupleId = "P37-T01-markdown-contract";

		await Bun.write(
			`${cwd}/task.md`,
			[
				"# Objective",
				"Triage and fix one reproducible bug.",
				"",
				"# Acceptance Criteria",
				"- Produce a scoped patch.",
				"",
				"# Validation Command",
				"echo validate",
				"",
				"# Lane Ownership",
				"Core owns implementation; tests owns validation; docs owns evidence.",
				"",
				"# Stop Conditions",
				"Stop on unsafe scope expansion.",
			].join("\n"),
		);
		await Bun.write(`${cwd}/manifest-entry.json`, `${JSON.stringify({ runId: tupleId }, null, 2)}\n`);

		const result = await runExampleScript({
			cwd,
			previousCwd,
			nodeId: "precheckTaskContract",
			scriptFileName: "precheck-task-contract.js",
		});

		expect(
			result.scheduler.activations.find(activation => activation.nodeId === "precheckTaskContract")?.status,
		).toBe("completed");
		expect(result.scheduler.state.taskContract).toContain("# Validation Command");
	});

	it("fails parallel review precheck without a canonical tuple id", async () => {
		using tempDir = TempDir.createSync("@omh-parallel-review-missing-tuple-id-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();

		await Bun.write(
			`${cwd}/task.md`,
			[
				"# Objective",
				"Triage and fix one reproducible bug.",
				"",
				"# Acceptance Criteria",
				"- Produce a scoped patch.",
				"",
				"# Validation Command",
				"echo validate",
				"",
				"# Lane Ownership",
				"Core owns implementation; tests owns validation; docs owns evidence.",
				"",
				"# Stop Conditions",
				"Stop on unsafe scope expansion.",
			].join("\n"),
		);

		const result = await runExampleScript({
			cwd,
			previousCwd,
			nodeId: "precheckTaskContract",
			scriptFileName: "precheck-task-contract.js",
		});

		const activation = result.scheduler.activations.find(item => item.nodeId === "precheckTaskContract");
		expect(activation?.status).toBe("failed");
		expect(activation?.error).toContain("canonical tuple id");
		expect(result.scheduler.state.runtime).toBeUndefined();
	});

	it("fails parallel review handoff when the scope agent did not produce a plan", async () => {
		using tempDir = TempDir.createSync("@omh-parallel-review-missing-scope-plan-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();
		const tupleId = "P37-T01-scope-plan-required";

		await Bun.write(`${cwd}/manifest-entry.json`, `${JSON.stringify({ runId: tupleId }, null, 2)}\n`);

		const result = await runExampleScript({
			cwd,
			previousCwd,
			nodeId: "materializePlanHandoff",
			scriptFileName: "materialize-plan-handoff.js",
			writes: ["/planHandoff"],
		});

		const activation = result.scheduler.activations.find(item => item.nodeId === "materializePlanHandoff");
		expect(activation?.status).toBe("failed");
		expect(activation?.error).toContain("scope plan");
		expect(await Bun.file(`${cwd}/workflow-output/scope-plan-handoff-${tupleId}.json`).exists()).toBe(false);
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
		expect(await Bun.file(`${cwd}/workflow-output/validation-stdout-stderr-${tupleId}.txt`).text()).toContain(
			"validation stdout",
		);
		expect(await Bun.file(`${cwd}/workflow-output/validation-stdout-${tupleId}.txt`).text()).toBe(
			"validation stdout\n",
		);
		expect(await Bun.file(`${cwd}/workflow-output/validation-stderr-${tupleId}.txt`).text()).toBe("");
	});

	it("reuses exact declared validation evidence from any implementation lane", async () => {
		using tempDir = TempDir.createSync("@omh-parallel-review-core-validation-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();
		const tupleId = "P89-T01-core-validation";
		const validationCommand = "go test ./...";

		await Bun.write(
			`${cwd}/task.md`,
			[
				"Objective:",
				"Reuse declared validation from whichever lane already ran it.",
				"",
				"Validation Command:",
				validationCommand,
			].join("\n"),
		);
		await Bun.write(`${cwd}/manifest-entry.json`, `${JSON.stringify({ runId: tupleId }, null, 2)}\n`);
		await Bun.write(
			`${cwd}/workflow-output/core-lane-${tupleId}.json`,
			`${JSON.stringify(
				{
					tuple_id: tupleId,
					producer_node: "implementCore",
					status: "source_changed",
					verification: {
						validation: {
							command: validationCommand,
							environment: {},
							result: "pass",
							exit_code: 0,
							output: "ok github.com/spf13/cobra; ok github.com/spf13/cobra/doc",
						},
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
				environment: {},
				result: "passed",
				exitCode: 0,
				reusedFromLane: `workflow-output/core-lane-${tupleId}.json`,
			},
		});
		const artifact = await Bun.file(`${cwd}/workflow-output/validation-${tupleId}.json`).json();
		expect(artifact.validation.stdoutArtifact).toBe(`workflow-output/validation-reused-${tupleId}.stdout`);
		expect(await Bun.file(`${cwd}/workflow-output/validation-reused-${tupleId}.stdout`).text()).toContain(
			"github.com/spf13/cobra",
		);
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

	it("materializes changed-file inventory aliases for parallel strong review", async () => {
		using tempDir = TempDir.createSync("@omh-parallel-review-changed-file-inventory-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();
		const tupleId = "P46-T01-flask-parallel-cli-env";

		await runGit(cwd, ["init"]);
		await runGit(cwd, ["config", "user.email", "omh@example.invalid"]);
		await runGit(cwd, ["config", "user.name", "OMH Test"]);
		await Bun.write(`${cwd}/task.md`, "Validation Command:\necho validate\n");
		await Bun.write(`${cwd}/tests/test_cli.py`, "def test_old():\n    pass\n");
		await runGit(cwd, ["add", "task.md", "tests/test_cli.py"]);
		await runGit(cwd, ["commit", "-m", "baseline"]);
		await Bun.write(`${cwd}/manifest-entry.json`, `${JSON.stringify({ runId: tupleId }, null, 2)}\n`);
		await Bun.write(`${cwd}/tests/test_cli.py`, "def test_new():\n    pass\n");

		const result = await runExampleScript({
			cwd,
			previousCwd,
			nodeId: "finalizeRollbackCoverage",
			scriptFileName: "finalize-rollback-coverage.js",
			writes: ["/rollbackCoverage"],
		});

		expect(result.scheduler.state.rollbackCoverage).toMatchObject({
			changed_file_inventory_artifact: `workflow-output/changed-file-inventory-${tupleId}.txt`,
		});
		expect(await Bun.file(`${cwd}/workflow-output/changed-file-inventory-${tupleId}.txt`).text()).toContain(
			"tests/test_cli.py",
		);
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

	it("does not require glob-shaped workflow-output handoff hints as concrete artifacts", async () => {
		using tempDir = TempDir.createSync("@omh-parallel-review-glob-handoff-hint-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();
		const tupleId = "C222-T01-2f878a117-ripgrep-ignore-parallel-review-replacement";
		const validationCommand = "echo validate";

		await Bun.write(
			`${cwd}/task.md`,
			[
				"Objective:",
				"Guard concrete lane evidence while allowing wildcard hints for operator discovery.",
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
					`operator discovery hint workflow-output/*${tupleId}*`,
					`canonical tests evidence workflow-output/tests-lane-${tupleId}.json`,
				].join("\n"),
				reviewHandoff: {
					artifacts: [
						`workflow-output/docs-lane-${tupleId}.json`,
						`workflow-output/integration-review-materialized-${tupleId}.json`,
					],
					notes: `reviewers may inspect workflow-output/*${tupleId}* when comparing all artifacts`,
				},
			},
		});

		expect(result.scheduler.state.evidenceContract).toMatchObject({
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

	it("materializes readable evidence aliases for planned parallel lane references", async () => {
		using tempDir = TempDir.createSync("@omh-parallel-review-planned-lane-evidence-aliases-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();
		const tupleId = "P06-T04-2530e0a06-ripgrep-hotpath-canary-b";
		const validationCommand = "echo validate";

		await Bun.write(
			`${cwd}/task.md`,
			[
				"Objective:",
				"Accept canonical lane evidence when planner handoffs cite planned lane evidence documents.",
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
					`planned core evidence workflow-output/core-evidence-${tupleId}.md`,
					`planned tests evidence workflow-output/tests-evidence-${tupleId}.md`,
					`planned docs evidence workflow-output/docs-evidence-${tupleId}.md`,
				].join("\n"),
				reviewHandoff: {
					artifacts: [
						`workflow-output/core-lane-${tupleId}.json`,
						`workflow-output/tests-lane-${tupleId}.json`,
						`workflow-output/docs-lane-${tupleId}.json`,
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
		const evidenceContract = expectRecord(result.scheduler.state.evidenceContract, "evidenceContract");
		const checkedInputs = expectRecord(evidenceContract.checked_inputs, "evidenceContract.checked_inputs");
		expect(checkedInputs.materialized_alias_artifacts).toEqual(
			expect.arrayContaining([
				{
					artifact: `workflow-output/core-evidence-${tupleId}.md`,
					canonical: `workflow-output/core-lane-${tupleId}.json`,
				},
				{
					artifact: `workflow-output/docs-evidence-${tupleId}.md`,
					canonical: `workflow-output/docs-lane-${tupleId}.json`,
				},
				{
					artifact: `workflow-output/tests-evidence-${tupleId}.md`,
					canonical: `workflow-output/tests-lane-${tupleId}.json`,
				},
			]),
		);
		expect(await Bun.file(`${cwd}/workflow-output/core-evidence-${tupleId}.md`).text()).toContain(
			`Canonical artifact: workflow-output/core-lane-${tupleId}.json`,
		);
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

	it.each([
		"completed_with_unresolved_integration_risk",
		"complete_with_unresolved_integration_risk",
		"source_change_with_validation_risk",
	])("lets unresolved nonterminal lane validation risk reach integration review for %s", async status => {
		using tempDir = TempDir.createSync("@omh-parallel-review-nonterminal-validation-risk-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();
		const tupleId = "C429-T01-8cb001109-ripgrep-json-output-parallel-canary";

		await Bun.write(`${cwd}/manifest-entry.json`, `${JSON.stringify({ runId: tupleId }, null, 2)}\n`);
		await Bun.write(
			`${cwd}/workflow-output/core-lane-${tupleId}.json`,
			`${JSON.stringify({ tuple_id: tupleId, producer_node: "implementCore", status: "source_change_applied" }, null, 2)}\n`,
		);
		await Bun.write(
			`${cwd}/workflow-output/tests-lane-${tupleId}.json`,
			`${JSON.stringify(
				{
					tuple_id: tupleId,
					producer_node: "implementTests",
					status,
					validation: {
						result: "fail",
					},
					unresolved_integration_risks: [
						"Declared validation failed in unrelated ripgrep integration tests outside this lane's JSON printer change.",
					],
					hard_stop: false,
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
			status: "continue",
			blocking_lane_artifacts: [],
			lane_artifacts: [
				{
					lane: "implementCore",
					status: "source_change_applied",
				},
				{
					lane: "implementDocs",
					status: "complete",
				},
				{
					lane: "implementTests",
					status,
					validation_status: "fail",
				},
			],
		});
		expect(await Bun.file(`${cwd}/workflow-output/lane-hard-stop-guard-${tupleId}.json`).json()).toMatchObject({
			status: "continue",
			blocking_lane_artifacts: [],
		});
	});

	it("materializes parallel lane summaries at the hard-stop join", async () => {
		using tempDir = TempDir.createSync("@omh-parallel-review-lane-summary-join-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();
		const tupleId = "P06-T04-f8c67bde1-ripgrep-hotpath-recanary-d";
		const guardScript = await Bun.file(`${PARALLEL_REVIEW_SCRIPT_DIR}/lane-hard-stop-guard.js`).text();

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

		const result = await runExampleDefinition({
			cwd,
			previousCwd,
			definition: {
				name: "parallel-lane-summary-join",
				version: 1,
				models: { roles: {}, defaults: {} },
				nodes: [
					{
						id: "implementCore",
						type: "script",
						script: { language: "js", code: "return { summary: 'core hardened EOF sentinel handling' };" },
					},
					{
						id: "implementTests",
						type: "script",
						script: {
							language: "js",
							code: "return { summary: 'tests added candidate false-positive traversal coverage' };",
						},
					},
					{
						id: "implementDocs",
						type: "script",
						script: {
							language: "js",
							code: "return { summary: 'docs recorded rollback and validation evidence' };",
						},
					},
					{
						id: "laneHardStopGuard",
						type: "script",
						script: { language: "js", code: guardScript },
						writes: ["/laneHardStopGuard"],
					},
				],
				edges: [
					{ from: "implementCore", to: "implementTests" },
					{ from: "implementTests", to: "implementDocs" },
					{ from: "implementDocs", to: "laneHardStopGuard" },
				],
			},
		});

		expect(result.scheduler.state.laneHardStopGuard).toMatchObject({
			status: "continue",
			lane_summaries: {
				implementCore: "core hardened EOF sentinel handling",
				implementTests: "tests added candidate false-positive traversal coverage",
				implementDocs: "docs recorded rollback and validation evidence",
			},
		});
	});

	it("does not quarantine lane evidence only because the tuple id contains final", async () => {
		using tempDir = TempDir.createSync("@omh-parallel-review-final-word-tuple-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();
		const tupleId = "omhb0026-log-pattern-auditor-warnings-mode-final";

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
		await Bun.write(`${cwd}/workflow-output/core-attempt-warnings-${tupleId}-stdout.txt`, "2:WARN retry\n");

		const result = await runExampleScript({
			cwd,
			previousCwd,
			nodeId: "laneHardStopGuard",
			scriptFileName: "lane-hard-stop-guard.js",
			writes: ["/laneHardStopGuard"],
		});

		expect(result.scheduler.state.laneHardStopGuard).toMatchObject({
			status: "continue",
			reserved_final_artifacts: [],
			quarantined_reserved_final_artifacts: [],
		});
		expect(await Bun.file(`${cwd}/workflow-output/core-attempt-warnings-${tupleId}-stdout.txt`).text()).toBe(
			"2:WARN retry\n",
		);
		expect(await Bun.file(`${cwd}/workflow-output/lane-hard-stop-guard-${tupleId}.json`).json()).toMatchObject({
			status: "continue",
			reserved_final_artifacts: [],
		});
	});

	it("lets source-change lanes with unresolved integration risk reach integration review", async () => {
		using tempDir = TempDir.createSync("@omh-parallel-review-source-validation-risk-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();
		const tupleId = "C429-T01-8e0528dd2-ripgrep-json-output-parallel-canary";

		await Bun.write(`${cwd}/manifest-entry.json`, `${JSON.stringify({ runId: tupleId }, null, 2)}\n`);
		await Bun.write(
			`${cwd}/workflow-output/core-lane-${tupleId}.json`,
			`${JSON.stringify(
				{
					tuple_id: tupleId,
					producer_node: "implementCore",
					status: "source_change_applied",
					validation: {
						result: "fail",
						evidence: "Declared validation failed in unrelated integration tests outside this lane boundary.",
					},
					unresolved_integration_risks: [
						"The integration review should decide whether unrelated validation failures block promotion.",
					],
					hard_stop_written: false,
				},
				null,
				2,
			)}\n`,
		);
		await Bun.write(
			`${cwd}/workflow-output/tests-lane-${tupleId}.json`,
			`${JSON.stringify({ tuple_id: tupleId, producer_node: "implementTests", status: "complete" }, null, 2)}\n`,
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
			status: "continue",
			blocking_lane_artifacts: [],
			lane_artifacts: [
				{
					lane: "implementCore",
					status: "source_change_applied",
					validation_status: "fail",
				},
				{
					lane: "implementDocs",
					status: "complete",
				},
				{
					lane: "implementTests",
					status: "complete",
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

	it("keeps documentation discovery fanout outside the repair retry loop", async () => {
		const flow = await Bun.file(
			`${import.meta.dir}/../../../examples/workflow/experimental/documentation-audit/documentation-audit.omhflow`,
		).text();

		const retryLoop = flow.match(
			/kind:\s*retry_until[\s\S]*?retryWhen:\s*outputs\.consistencyReview\.verdict == "continue"/u,
		);
		expect(retryLoop?.[0]).toContain("id: consolidateAudit");
		expect(retryLoop?.[0]).toContain("id: patchDocs");
		expect(retryLoop?.[0]).toContain("id: consistencyReview");
		expect(retryLoop?.[0]).not.toContain("id: auditApiDocs");
		expect(retryLoop?.[0]).not.toContain("id: auditTutorials");
		expect(retryLoop?.[0]).not.toContain("id: auditExamples");
		expect(flow).toMatch(
			/id:\s*auditApiDocs[\s\S]*?id:\s*auditTutorials[\s\S]*?id:\s*auditExamples[\s\S]*?id:\s*compactAuditFindings[\s\S]*?kind:\s*retry_until/u,
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

		await runGit(cwd, ["init"]);
		await runGit(cwd, ["config", "user.email", "omh@example.invalid"]);
		await runGit(cwd, ["config", "user.name", "OMH Test"]);
		await Bun.write(`${cwd}/httpx/_client.py`, "# build_request base_url note\n");
		await runGit(cwd, ["add", "httpx/_client.py"]);
		await runGit(cwd, ["commit", "-m", "baseline"]);
		await Bun.write(`${cwd}/httpx/_client.py`, "# build_request base_url note\n# header precedence note\n");

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

	it("preserves documentation validation stdout and stderr as raw artifacts", async () => {
		using tempDir = TempDir.createSync("@omh-documentation-audit-validation-streams-");
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
					validationCommand: "printf 'validation stdout\\n'; printf 'validation stderr\\n' >&2",
				},
				patch: {
					status: "patched",
					changed_files: ["docs/commands-and-groups.md"],
				},
			},
		});

		expect(result.scheduler.state.validation).toMatchObject({
			status: "pass",
			validationStdoutPath: "workflow-output/validation-stdout.txt",
			validationStderrPath: "workflow-output/validation-stderr.txt",
		});
		expect(await Bun.file(`${cwd}/workflow-output/validation-stdout.txt`).text()).toBe("validation stdout\n");
		expect(await Bun.file(`${cwd}/workflow-output/validation-stderr.txt`).text()).toBe("validation stderr\n");
		const evidence = await Bun.file(`${cwd}/workflow-output/documentation-validation.md`).text();
		expect(evidence).toContain("workflow-output/validation-stdout.txt");
		expect(evidence).toContain("workflow-output/validation-stderr.txt");
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

	it("runs documentation validation startup without project Python cache byproducts", async () => {
		using tempDir = TempDir.createSync("@omh-documentation-audit-validation-clean-python-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();

		await Bun.write(`${cwd}/src/module_under_test.py`, "VALUE = 42\n");

		const result = await runExampleScript({
			cwd,
			previousCwd,
			nodeId: "checkValidationStartup",
			scriptFileName: "check-validation-startup.js",
			scriptDir: DOCUMENTATION_AUDIT_SCRIPT_DIR,
			writes: ["/validationStartup"],
			initialState: {
				task: {
					validationCommand: "python -m py_compile src/module_under_test.py",
				},
			},
		});

		expect(
			result.scheduler.activations.find(activation => activation.nodeId === "checkValidationStartup")?.status,
		).toBe("completed");
		expect(result.scheduler.state.validationStartup).toMatchObject({
			status: "startable-pass",
			validationExitCode: 0,
		});
		expect(await directoryEntriesOrEmpty(`${cwd}/src/__pycache__`)).toEqual([]);
		expect(await directoryEntriesOrEmpty(`${cwd}/.pytest_cache`)).toEqual([]);
		expect((await findRelativeFiles(`${cwd}/workflow-output/tmp`, ".pyc")).some(file => file.endsWith(".pyc"))).toBe(
			true,
		);
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

	it("blocks documentation patch validation when patch evidence omits untracked project files", async () => {
		using tempDir = TempDir.createSync("@omh-documentation-untracked-patch-evidence-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();

		await runGit(cwd, ["init"]);
		await runGit(cwd, ["config", "user.email", "omh@example.invalid"]);
		await runGit(cwd, ["config", "user.name", "OMH Test"]);
		await Bun.write(`${cwd}/docs/page.md`, "baseline\n");
		await runGit(cwd, ["add", "docs/page.md"]);
		await runGit(cwd, ["commit", "-m", "baseline"]);
		await Bun.write(`${cwd}/docs/page.md`, "updated\n");
		await Bun.write(`${cwd}/docs_src/example.py`, "print('example')\n");

		const result = await runExampleScript({
			cwd,
			previousCwd,
			nodeId: "guardReviewRepair",
			scriptFileName: "guard-review-repair.js",
			scriptDir: DOCUMENTATION_AUDIT_SCRIPT_DIR,
			writes: ["/reviewRepair"],
			initialState: {
				review: "finish",
				patch: {
					status: "patched",
					changed_files: ["docs/page.md"],
				},
			},
		});

		expect(result.scheduler.activations.find(activation => activation.nodeId === "guardReviewRepair")?.status).toBe(
			"failed",
		);
		expect(
			result.scheduler.activations.find(activation => activation.nodeId === "guardReviewRepair")?.error,
		).toContain("docs_src/example.py");
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
			summary: "ran release checks; validation=pass security=skipped scope=skipped",
		});
		expect(result.scheduler.state.checks).toMatchObject({
			status: "pass",
			securityStatus: "skipped",
		});
		expect(await Bun.file(`${cwd}/workflow-output/release-checks.md`).text()).toContain(
			"Security command: not declared",
		);
	});

	it("preserves release validation stdout and stderr as separate raw artifacts", async () => {
		using tempDir = TempDir.createSync("@omh-release-checks-stream-artifacts-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();
		const taskText = [
			"Objective:",
			"Preserve release check streams.",
			"",
			"Validation Command:",
			"printf 'validation stdout\\n'; printf 'validation stderr\\n' >&2",
		].join("\n");
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
					validationCommand: "printf 'validation stdout\\n'; printf 'validation stderr\\n' >&2",
				},
			},
		});

		expect(result.scheduler.state.checks).toMatchObject({
			validationStdoutPath: "workflow-output/release-validation-stdout.txt",
			validationStderrPath: "workflow-output/release-validation-stderr.txt",
		});
		expect(await Bun.file(`${cwd}/workflow-output/release-validation-stdout.txt`).text()).toBe("validation stdout\n");
		expect(await Bun.file(`${cwd}/workflow-output/release-validation-stderr.txt`).text()).toBe("validation stderr\n");
		const evidence = await Bun.file(`${cwd}/workflow-output/release-checks.md`).text();
		expect(evidence).toContain("### Validation stdout");
		expect(evidence).toContain("workflow-output/release-validation-stdout.txt");
		expect(evidence).toContain("### Validation stderr");
		expect(evidence).toContain("workflow-output/release-validation-stderr.txt");
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

	it("does not treat release hold criteria checklists as unresolved audit blockers", async () => {
		using tempDir = TempDir.createSync("@omh-release-gate-hold-criteria-checklist-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();

		await Bun.write(
			`${cwd}/workflow-output/release-audit.md`,
			[
				"# Release-Facing Audit Evidence",
				"",
				"Resolved Documentation/API compatibility risk in docs/api.md stale URL reference and docs/compatibility.md duplicate params wording.",
				"Resolved untracked root test artifact outside the allowed scope fence by moving keylog output under tmp_path.",
			].join("\n"),
		);
		await Bun.write(
			`${cwd}/workflow-output/release-rollback.md`,
			[
				"# Release Rollback Notes",
				"",
				"- Revert docs/api.md, docs/compatibility.md, and tests/test_config.py.",
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
					current_diff_findings: {
						status: "untracked root test is outside the allowed fence and should hold the gate",
					},
					compatibility_risks: [
						{
							area: "Documentation/API compatibility",
							risk: "docs/api.md stale URL members and docs/compatibility.md duplicate params wording should hold release until repaired",
						},
					],
					rollback_or_hold_criteria: [
						"Hold if the declared validation command or security command fails, times out on rerun, or lacks archived stdout/stderr from the runReleaseChecks node.",
						"Hold if broad churn exceeds the diff gate or touches paths outside the allowed fence.",
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
		expect(gate).not.toContain("rollback_or_hold_criteria");
	});

	it("blocks release gates with untracked project files outside workflow artifacts", async () => {
		using tempDir = TempDir.createSync("@omh-release-gate-untracked-project-file-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();

		await Bun.write(`${cwd}/httpx/_config.py`, "baseline\n");
		await Bun.write(
			`${cwd}/task.md`,
			[
				"Objective:",
				"Release harden proxy configuration without leaking temp artifacts.",
				"",
				"Validation Command:",
				"echo validate",
				"",
				"Allowed paths:",
				"httpx/, tests/test_config.py, docs/, workflow-output/, progress.md",
			].join("\n"),
		);
		await runGit(cwd, ["init"]);
		await runGit(cwd, ["config", "user.email", "omh@example.invalid"]);
		await runGit(cwd, ["config", "user.name", "OMH Test"]);
		await runGit(cwd, ["add", "httpx/_config.py", "task.md"]);
		await runGit(cwd, ["commit", "-m", "baseline"]);
		await Bun.write(`${cwd}/test`, "# TLS secrets log file, generated by OpenSSL / Python\n");
		await Bun.write(`${cwd}/workflow-output/release-audit.md`, "Resolved proxy docs risk.\n");
		await Bun.write(`${cwd}/workflow-output/release-rollback.md`, "Rollback notes: no project diff.\n");

		const result = await runExampleScript({
			cwd,
			previousCwd,
			nodeId: "enforceReleaseGate",
			scriptFileName: "enforce-release-gate.js",
			scriptDir: RELEASE_HARDENING_SCRIPT_DIR,
			writes: ["/releaseGate"],
			initialState: {
				task: {
					taskText: await Bun.file(`${cwd}/task.md`).text(),
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
		expect(await Bun.file(`${cwd}/workflow-output/release-gate.md`).text()).toContain(
			"test is an untracked project file",
		);
	});

	it("archives release hardening holds when frozen task checks require a fresh contract", async () => {
		using tempDir = TempDir.createSync("@omh-release-gate-hold-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();

		await Bun.write(
			`${cwd}/workflow-output/release-audit.md`,
			[
				"# Release-Facing Audit Evidence",
				"",
				"## Fresh contract required",
				"",
				"- Waived stale docs after a bounded repair, but the Security Command selector is absent in this checkout.",
			].join("\n"),
		);
		await Bun.write(
			`${cwd}/workflow-output/release-rollback.md`,
			["# Release Rollback Notes", "", "- Revert README.md and docs/source/introduction.rst."].join("\n"),
		);
		await Bun.write(
			`${cwd}/workflow-output/release-checks.md`,
			[
				"# Release Check Evidence",
				"",
				"## Validation Command",
				"",
				"Exit code: 0",
				"",
				"## Security Command",
				"",
				"Exit code: 4",
				"",
				"pytest: not found: Test.*Release",
			].join("\n"),
		);

		const gateResult = await runExampleScript({
			cwd,
			previousCwd,
			nodeId: "enforceReleaseGate",
			scriptFileName: "enforce-release-gate.js",
			scriptDir: RELEASE_HARDENING_SCRIPT_DIR,
			writes: ["/releaseGate"],
			initialState: {
				checks: {
					status: "fail",
					validationExitCode: 0,
					securityExitCode: 4,
					outputPath: "workflow-output/release-checks.md",
				},
				review: "hold",
			},
		});

		expect(
			gateResult.scheduler.activations.find(activation => activation.nodeId === "enforceReleaseGate")?.status,
		).toBe("completed");
		expect(gateResult.scheduler.state.releaseGate).toMatchObject({
			status: "hold",
			outcome: "rejected",
		});
		expect(await Bun.file(`${cwd}/workflow-output/release-gate.md`).text()).toContain("status: hold");

		const archiveResult = await runExampleScript({
			cwd,
			previousCwd,
			nodeId: "archiveRelease",
			scriptFileName: "archive-release.js",
			scriptDir: RELEASE_HARDENING_SCRIPT_DIR,
			writes: ["/archive"],
			initialState: gateResult.scheduler.state,
		});

		expect(archiveResult.scheduler.state.archive).toMatchObject({
			outcome: "rejected",
			validation: "hold",
		});
		expect(await Bun.file(`${cwd}/workflow-output/release-hardening-archive.md`).text()).toContain(
			"Outcome: rejected",
		);
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

	it("allows no-code bug triage archives when the proposed defect is refuted by evidence", async () => {
		using tempDir = TempDir.createSync("@omh-bug-triage-refuted-cause-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();

		await initializeCleanGitRepo(cwd);
		await Bun.write(
			`${cwd}/task.md`,
			["Objective:", "Investigate malformed JSON request caching.", "", "No-Code Resolution: allowed"].join("\n"),
		);
		await Bun.write(`${cwd}/workflow-output/reproduction.md`, "1 passed\n");
		await Bun.write(`${cwd}/workflow-output/regression.md`, "69 passed\n");
		await Bun.write(`${cwd}/workflow-output/bugfix-rollback.md`, "No rollback needed for a no-code result.\n");
		await Bun.write(
			`${cwd}/workflow-output/no-bug-root-cause.md`,
			[
				"# No-Bug Root Cause",
				"",
				"## Cause Reconciliation",
				"",
				"The classify/cause handoff identified this as a coverage-only gap unless a targeted",
				"reproducer showed an active defect. It proposed malformed JSON cache masking as",
				"the strongest potential defect boundary.",
				"",
				"That proposed defect is refuted by exercised behavior in this checkout: silent JSON",
				"parsing returned None, and the later non-silent parse still raised a 400 response.",
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
					narrowest_fix_boundary: ["Patch malformed JSON cache behavior if the focused reproducer fails."],
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

	it("fails performance optimization closed when a zero-exit baseline reports a fatal diagnostic", async () => {
		using tempDir = TempDir.createSync("@omh-performance-baseline-diagnostic-fail-closed-");
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
					baselineCommand: "printf \"Search path 'needle' is not a directory\\n\" >&2",
				},
			},
		});

		expect(result.scheduler.activations.find(activation => activation.nodeId === "captureBaseline")?.status).toBe(
			"failed",
		);
		expect(result.scheduler.state.baseline).toBeUndefined();
		const evidence = await Bun.file(`${cwd}/workflow-output/performance-baseline.md`).text();
		expect(evidence).toContain("Exit code: 0");
		expect(evidence).toContain("Fatal Command Diagnostic");
		expect(evidence).toContain("Search path 'needle' is not a directory");
	});

	it("records shared project files after successful performance baseline as the pre-branch snapshot", async () => {
		using tempDir = TempDir.createSync("@omh-performance-baseline-snapshot-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();

		await Bun.write(`${cwd}/src.txt`, "baseline\n");
		await Bun.write(`${cwd}/task.md`, "Benchmark Command:\necho benchmark\n\nValidation Command:\necho validation\n");
		await runGit(cwd, ["init"]);
		await runGit(cwd, ["config", "user.email", "omh@example.invalid"]);
		await runGit(cwd, ["config", "user.name", "OMH Test"]);
		await runGit(cwd, ["add", "src.txt", "task.md"]);
		await runGit(cwd, ["commit", "-m", "baseline"]);

		const result = await runExampleScript({
			cwd,
			previousCwd,
			nodeId: "captureBaseline",
			scriptFileName: "capture-baseline.js",
			scriptDir: PERFORMANCE_OPTIMIZATION_SCRIPT_DIR,
			writes: ["/baseline", "/runtime/sharedProjectFilesBeforeBranches"],
			initialState: {
				task: {
					baselineCommand:
						"bash -lc 'set -euo pipefail; printf generated > Cargo.lock; mkdir -p target/debug; printf build > target/debug/build-output'",
				},
			},
		});

		expect(result.scheduler.state.baseline).toMatchObject({
			status: "pass",
			exitCode: 0,
		});
		expect(result.scheduler.state.runtime).toMatchObject({
			sharedProjectFilesBeforeBranches: ["Cargo.lock", "target/debug/build-output"],
		});
		expect(result.scheduler.state.task).not.toHaveProperty("sharedProjectFilesBeforeBranches");
		expect(result.scheduler.state.baseline).not.toHaveProperty("sharedProjectFilesBeforeBranches");
	});

	it("materializes performance scratch root into task state before branch agents run", async () => {
		using tempDir = TempDir.createSync("@omh-performance-scratch-root-precheck-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();
		const previousRunTmp = process.env.OMH_RUN_TMP;
		process.env.OMH_RUN_TMP = `${cwd}/run-tmp`;

		try {
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

			const result = await runExampleScript({
				cwd,
				previousCwd,
				nodeId: "precheckTaskContract",
				scriptFileName: "precheck-task-contract.js",
				scriptDir: PERFORMANCE_OPTIMIZATION_SCRIPT_DIR,
				writes: ["/task", "/runtime", "/review"],
			});

			expect(result.scheduler.state.task).toMatchObject({
				scratchRoot: `${cwd}/run-tmp`,
				sharedGitWorktrees: [],
			});
			expect(await Bun.file(`${cwd}/workflow-output/performance-precheck.md`).text()).toContain(`${cwd}/run-tmp`);
		} finally {
			if (previousRunTmp === undefined) {
				delete process.env.OMH_RUN_TMP;
			} else {
				process.env.OMH_RUN_TMP = previousRunTmp;
			}
		}
	});

	it("fails performance optimization precheck before fanout when task commands use bare tmp scratch", async () => {
		using tempDir = TempDir.createSync("@omh-performance-tmp-command-precheck-fail-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();
		const previousRunTmp = process.env.OMH_RUN_TMP;
		process.env.OMH_RUN_TMP = `${cwd}/run-tmp`;

		try {
			await Bun.write(`${cwd}/src.txt`, "baseline\n");
			await Bun.write(
				`${cwd}/task.md`,
				[
					"Benchmark Command:",
					"echo benchmark >/tmp/word-counter-benchmark.out",
					"",
					"Validation Command:",
					"echo validation",
					"",
					"Baseline Command:",
					"echo baseline >/tmp/word-counter-baseline.out",
				].join("\n"),
			);
			await runGit(cwd, ["init"]);
			await runGit(cwd, ["config", "user.email", "omh@example.invalid"]);
			await runGit(cwd, ["config", "user.name", "OMH Test"]);
			await runGit(cwd, ["add", "src.txt", "task.md"]);
			await runGit(cwd, ["commit", "-m", "baseline"]);

			const result = await runExampleScript({
				cwd,
				previousCwd,
				nodeId: "precheckTaskContract",
				scriptFileName: "precheck-task-contract.js",
				scriptDir: PERFORMANCE_OPTIMIZATION_SCRIPT_DIR,
				writes: ["/task", "/runtime", "/review"],
			});

			expect(
				result.scheduler.activations.find(activation => activation.nodeId === "precheckTaskContract")?.status,
			).toBe("failed");
			expect(result.scheduler.state.task).toBeUndefined();
			const evidence = await Bun.file(`${cwd}/workflow-output/performance-precheck.md`).text();
			expect(evidence).toContain("## Task Command Scratch Root Violation");
			expect(evidence).toContain("Benchmark Command: `/tmp`");
			expect(evidence).toContain("Baseline Command: `/tmp`");
		} finally {
			if (previousRunTmp === undefined) {
				delete process.env.OMH_RUN_TMP;
			} else {
				process.env.OMH_RUN_TMP = previousRunTmp;
			}
		}
	});

	it("fails performance optimization precheck before fanout when validation cannot run", async () => {
		using tempDir = TempDir.createSync("@omh-performance-validation-precheck-fail-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();
		const previousRunTmp = process.env.OMH_RUN_TMP;
		process.env.OMH_RUN_TMP = `${cwd}/run-tmp`;

		try {
			await Bun.write(`${cwd}/src.txt`, "baseline\n");
			await Bun.write(
				`${cwd}/task.md`,
				[
					"Benchmark Command:",
					"echo benchmark",
					"",
					"Validation Command:",
					"printf 'validation command shape is invalid\\n' >&2; exit 17",
				].join("\n"),
			);
			await runGit(cwd, ["init"]);
			await runGit(cwd, ["config", "user.email", "omh@example.invalid"]);
			await runGit(cwd, ["config", "user.name", "OMH Test"]);
			await runGit(cwd, ["add", "src.txt", "task.md"]);
			await runGit(cwd, ["commit", "-m", "baseline"]);

			const result = await runExampleScript({
				cwd,
				previousCwd,
				nodeId: "precheckTaskContract",
				scriptFileName: "precheck-task-contract.js",
				scriptDir: PERFORMANCE_OPTIMIZATION_SCRIPT_DIR,
				writes: ["/task", "/runtime", "/review"],
			});

			expect(
				result.scheduler.activations.find(activation => activation.nodeId === "precheckTaskContract")?.status,
			).toBe("failed");
			expect(result.scheduler.state.task).toBeUndefined();
			const evidence = await Bun.file(`${cwd}/workflow-output/performance-precheck.md`).text();
			expect(evidence).toContain("## Validation Preflight");
			expect(evidence).toContain("Exit code: 17");
			expect(evidence).toContain("validation command shape is invalid");
		} finally {
			if (previousRunTmp === undefined) {
				delete process.env.OMH_RUN_TMP;
			} else {
				process.env.OMH_RUN_TMP = previousRunTmp;
			}
		}
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
		expect(
			await Bun.file(
				`${import.meta.dir}/../../../examples/workflow/experimental/performance-optimization-search/performance-optimization-search/prompts/perf-review.md`,
			).text(),
		).toContain("archive a rejected no-win result");
	});

	it("materializes performance hypothesis summaries before branch fanout", async () => {
		using tempDir = TempDir.createSync("@omh-performance-hypotheses-materialized-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();
		const materializer = await Bun.file(`${PERFORMANCE_OPTIMIZATION_SCRIPT_DIR}/materialize-hypotheses.js`).text();

		const result = await runExampleDefinition({
			cwd,
			previousCwd,
			definition: {
				name: "performance-hypotheses-materializer-test",
				version: 1,
				models: { roles: {}, defaults: {} },
				nodes: [
					{
						id: "planHypotheses",
						type: "script",
						script: {
							language: "js",
							code: 'return { summary: "Algorithmic branch: inspect numeric coercion. Caching branch: likely no-win." };',
						},
					},
					{
						id: "materializeHypotheses",
						type: "script",
						script: {
							language: "js",
							code: materializer,
						},
						writes: ["/hypotheses"],
					},
				],
				edges: [{ from: "planHypotheses", to: "materializeHypotheses" }],
			},
		});

		expect(result.scheduler.state.hypotheses).toMatchObject({
			status: "materialized",
			producer_node: "materializeHypotheses",
			source_node: "planHypotheses",
			summary: expect.stringContaining("Algorithmic branch"),
		});
	});

	it("materializes performance selection repair reports before reviewer prompts", async () => {
		using tempDir = TempDir.createSync("@omh-performance-selection-repair-materialized-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();
		await Bun.write(
			`${cwd}/workflow-output/performance-selection-repair.md`,
			[
				"# Performance Selection Repair",
				"",
				"## Current status",
				"",
				"- Benchmark command status: pass.",
				"- Validation command status: pass.",
				"",
				"## Selection decision",
				"",
				"- Selected positive optimization branch: none.",
				"- No-win branch: algorithmic.",
			].join("\n"),
		);

		const result = await runExampleScript({
			cwd,
			previousCwd,
			nodeId: "materializeSelectionRepair",
			scriptFileName: "materialize-selection-repair.js",
			scriptDir: PERFORMANCE_OPTIMIZATION_SCRIPT_DIR,
			writes: ["/selectionRepair"],
		});

		expect(
			result.scheduler.activations.find(activation => activation.nodeId === "materializeSelectionRepair")?.status,
		).toBe("completed");
		expect(result.scheduler.state.selectionRepair).toMatchObject({
			status: "materialized",
			file: "workflow-output/performance-selection-repair.md",
			benchmark: { status: "pass" },
			validation: { status: "pass" },
			selectedBranch: "none",
			noWinBranch: "algorithmic",
		});
		expect(JSON.stringify(result.scheduler.state.selectionRepair)).toContain("# Performance Selection Repair");
	});

	it("materializes refactor dependency maps before compatibility design", async () => {
		using tempDir = TempDir.createSync("@omh-refactor-dependency-map-materialized-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();
		const materializer = await Bun.file(`${REFACTOR_MIGRATION_SCRIPT_DIR}/materialize-dependency-map.js`).text();

		const result = await runExampleDefinition({
			cwd,
			previousCwd,
			definition: {
				name: "refactor-dependency-map-materializer-test",
				version: 1,
				models: { roles: {}, defaults: {} },
				nodes: [
					{
						id: "mapDependencies",
						type: "script",
						script: {
							language: "js",
							code: 'return { summary: "Inventory: renderer imports legacyCanvas; tests touch public API." };',
						},
					},
					{
						id: "materializeDependencyMap",
						type: "script",
						script: {
							language: "js",
							code: materializer,
						},
						writes: ["/dependencyMap"],
					},
				],
				edges: [{ from: "mapDependencies", to: "materializeDependencyMap" }],
			},
		});

		expect(result.scheduler.state.dependencyMap).toMatchObject({
			status: "dependency_map_materialized",
			producer_node: "materializeDependencyMap",
			source_node: "mapDependencies",
			summary: expect.stringContaining("renderer imports legacyCanvas"),
		});
	});

	it("materializes research claims before evidence guards", async () => {
		using tempDir = TempDir.createSync("@omh-research-claim-materialized-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();
		const materializer = await Bun.file(`${RESEARCH_REPRODUCTION_SCRIPT_DIR}/materialize-claim.js`).text();

		const result = await runExampleDefinition({
			cwd,
			previousCwd,
			definition: {
				name: "research-claim-materializer-test",
				version: 1,
				models: { roles: {}, defaults: {} },
				nodes: [
					{
						id: "extractClaim",
						type: "script",
						script: {
							language: "js",
							code: 'return { summary: "Claim: normalization preserves invalid UTF-8 byte boundaries." };',
						},
					},
					{
						id: "materializeClaim",
						type: "script",
						script: {
							language: "js",
							code: materializer,
						},
						writes: ["/claim"],
					},
				],
				edges: [{ from: "extractClaim", to: "materializeClaim" }],
			},
		});

		expect(result.scheduler.state.claim).toMatchObject({
			status: "claim_materialized",
			producer_node: "materializeClaim",
			source_node: "extractClaim",
			summary: expect.stringContaining("invalid UTF-8"),
		});
	});

	it("materializes research comparisons before review", async () => {
		using tempDir = TempDir.createSync("@omh-research-comparison-materialized-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();
		const materializer = await Bun.file(`${RESEARCH_REPRODUCTION_SCRIPT_DIR}/materialize-comparison.js`).text();

		const result = await runExampleDefinition({
			cwd,
			previousCwd,
			definition: {
				name: "research-comparison-materializer-test",
				version: 1,
				models: { roles: {}, defaults: {} },
				nodes: [
					{
						id: "compareResults",
						type: "script",
						script: {
							language: "js",
							code: 'return { summary: "Comparison: baseline passed, variant failed with parser evidence." };',
						},
					},
					{
						id: "materializeComparison",
						type: "script",
						script: {
							language: "js",
							code: materializer,
						},
						writes: ["/comparison"],
					},
				],
				edges: [{ from: "compareResults", to: "materializeComparison" }],
			},
		});

		expect(result.scheduler.state.comparison).toMatchObject({
			status: "comparison_materialized",
			producer_node: "materializeComparison",
			source_node: "compareResults",
			summary: expect.stringContaining("variant failed"),
		});
	});

	it("keeps performance parallel lanes lane-local until selection applies a candidate", async () => {
		const artifact = await loadWorkflowArtifact(
			`${import.meta.dir}/../../../examples/workflow/experimental/performance-optimization-search/performance-optimization-search.omhflow`,
		);
		const optimizationPrompt = await Bun.file(
			`${import.meta.dir}/../../../examples/workflow/experimental/performance-optimization-search/performance-optimization-search/prompts/optimization.md`,
		).text();
		const repairPrompt = await Bun.file(
			`${import.meta.dir}/../../../examples/workflow/experimental/performance-optimization-search/performance-optimization-search/prompts/selection-repair.md`,
		).text();
		const reviewPrompt = await Bun.file(
			`${import.meta.dir}/../../../examples/workflow/experimental/performance-optimization-search/performance-optimization-search/prompts/perf-review.md`,
		).text();

		expect(optimizationPrompt).toContain("runs this branch in an isolated lane worktree");
		expect(optimizationPrompt).toContain(
			"does not apply branch\nchanges back to the shared workspace before the join",
		);
		expect(optimizationPrompt).toContain("Treat your current\ndirectory as lane-local");
		expect(optimizationPrompt).toContain("Do not run `git worktree add` from the shared task checkout");
		expect(optimizationPrompt).toContain("git clone --no-hardlinks");
		expect(optimizationPrompt).toContain("candidate patch");
		expect(optimizationPrompt).toContain("git apply --check");
		expect(optimizationPrompt).toContain("outside the project tree");
		expect(optimizationPrompt).toContain("task.scratchRoot");
		expect(optimizationPrompt).toContain("Never use bare `/tmp`");
		expect(optimizationPrompt).toContain("writable bare `/tmp` execution surface");
		expect(optimizationPrompt).toContain("bwrap --tmpfs /tmp");
		expect(optimizationPrompt).toContain("Do not run branch build, benchmark, validation, apply-check");
		expect(optimizationPrompt).toContain("from `cwd: .` or the shared\ntask workspace");
		expect(optimizationPrompt).toContain("current OMH-managed isolated\nlane worktree");
		expect(optimizationPrompt).toContain("scratch-workspace creation commands");
		expect(optimizationPrompt).not.toContain("workflow-output/tmp/{{strategy}}-*");
		expect(optimizationPrompt).not.toContain("../workflow-scratch/{{strategy}}-*");
		expect(repairPrompt).toContain("apply at most one selected candidate patch");
		expect(repairPrompt).toContain("clean shared workspace");
		expect(repairPrompt).toContain("reject `.git/worktrees/*` metadata");
		expect(repairPrompt).toContain("project-local scratch");
		expect(repairPrompt).toContain("shared sibling scratch");
		expect(repairPrompt).toContain("bare `/tmp` scratch");
		expect(repairPrompt).toContain("writable bare `/tmp` sandbox mounts");
		expect(repairPrompt).toContain("reject branch evidence where scratch-workspace creation, build, benchmark");
		expect(repairPrompt).toContain("or the unmodified shared workspace");
		expect(repairPrompt).toContain("task.scratchRoot");
		expect(reviewPrompt).toContain("branch left no project-file edits in the shared workspace");
		expect(reviewPrompt).toContain("no branch mutated shared git metadata");
		expect(reviewPrompt).toContain("outside the project tree");
		expect(reviewPrompt).toContain("shared sibling scratch");
		expect(reviewPrompt).toContain("bare `/tmp` scratch");
		expect(reviewPrompt).toContain("writable bare `/tmp` sandbox mounts");
		expect(reviewPrompt).toContain("and candidate execution did not run from `cwd: .`");
		expect(reviewPrompt).toContain("task.scratchRoot");
		for (const nodeId of ["tryAlgorithmicChange", "tryCachingChange", "tryIOChange"]) {
			const node = artifact.definition.nodes.find(candidate => candidate.id === nodeId);
			expect(node?.isolation?.apply).toBe(false);
			expect(node?.isolation?.merge).toBe(false);
			expect(node?.isolation?.capture?.exclude ?? []).not.toContain("workflow-output/**");
		}
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

	it("allows recorded pre-branch shared command artifacts before performance benchmark joins", async () => {
		using tempDir = TempDir.createSync("@omh-performance-prebranch-artifacts-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();
		const preBranchArtifacts = ["TASK.md", "Cargo.lock", "target/debug/build-output"];

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
		await Bun.write(`${cwd}/TASK.md`, "operator-visible task mirror\n");
		await Bun.write(`${cwd}/Cargo.lock`, "generated lockfile\n");
		await Bun.write(`${cwd}/target/debug/build-output`, "shared pre-branch build cache\n");

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
				runtime: {
					sharedProjectFilesBeforeBranches: preBranchArtifacts,
				},
			},
		});

		expect(result.scheduler.state.benchmark).toMatchObject({
			status: "pass",
			benchmarkExitCode: 0,
			validationExitCode: 0,
		});
		expect(result.scheduler.state.benchmark).not.toHaveProperty("isolationViolation");
	});

	it("fails performance benchmark joins when a zero-exit benchmark reports a fatal diagnostic", async () => {
		using tempDir = TempDir.createSync("@omh-performance-benchmark-diagnostic-fail-closed-");
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

		const result = await runExampleScript({
			cwd,
			previousCwd,
			nodeId: "benchmarkCandidates",
			scriptFileName: "run-benchmark-validation.js",
			scriptDir: PERFORMANCE_OPTIMIZATION_SCRIPT_DIR,
			writes: ["/benchmark"],
			initialState: {
				task: {
					benchmarkCommand: "printf \"Search path 'needle' is not a directory\\n\" >&2",
					validationCommand: "echo validation",
				},
			},
		});

		expect(result.scheduler.state.benchmark).toMatchObject({
			status: "fail",
			benchmarkExitCode: 0,
			benchmarkFailureDiagnostic: "Search path 'needle' is not a directory",
			validationExitCode: 0,
		});
		const evidence = await Bun.file(`${cwd}/workflow-output/performance-benchmark.md`).text();
		expect(evidence).toContain("Benchmark Fatal Command Diagnostic");
		expect(evidence).toContain("Search path 'needle' is not a directory");
	});

	it("blocks performance benchmark joins when shared project edits are newer than the pre-branch snapshot", async () => {
		using tempDir = TempDir.createSync("@omh-performance-postbranch-artifacts-");
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
		await Bun.write(`${cwd}/Cargo.lock`, "generated lockfile\n");
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
				runtime: {
					sharedProjectFilesBeforeBranches: ["Cargo.lock"],
				},
			},
		});

		expect(result.scheduler.state.benchmark).toMatchObject({
			status: "fail",
			isolationViolation: true,
			projectChangedFiles: ["src.txt"],
		});
		expect(await Bun.file(`${cwd}/workflow-output/performance-benchmark.md`).text()).toContain("- src.txt");
	});

	it("blocks performance benchmark joins when branches mutate shared git worktree metadata", async () => {
		using tempDir = TempDir.createSync("@omh-performance-shared-git-worktree-guard-");
		using scratchDir = TempDir.createSync("@omh-performance-linked-worktree-");
		const cwd = tempDir.path();
		const linkedWorktree = `${scratchDir.path()}/caching-worktree`;
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
		await runGit(cwd, ["worktree", "add", "--detach", linkedWorktree, "HEAD"]);

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
					sharedGitWorktrees: [],
				},
			},
		});

		expect(result.scheduler.state.benchmark).toMatchObject({
			status: "fail",
			isolationViolation: true,
			sharedGitWorktreeMetadataPaths: [linkedWorktree],
		});
		expect(await Bun.file(`${cwd}/workflow-output/performance-benchmark.md`).text()).toContain(
			"Shared Git Worktree Metadata Violation",
		);
	});

	it("allows preexisting shared git worktrees recorded by performance precheck", async () => {
		using tempDir = TempDir.createSync("@omh-performance-existing-git-worktree-");
		using scratchDir = TempDir.createSync("@omh-performance-existing-linked-worktree-");
		const cwd = tempDir.path();
		const linkedWorktree = `${scratchDir.path()}/existing-worktree`;
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
		await runGit(cwd, ["worktree", "add", "--detach", linkedWorktree, "HEAD"]);

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
					sharedGitWorktrees: [linkedWorktree],
				},
			},
		});

		expect(result.scheduler.state.benchmark).toMatchObject({
			status: "pass",
			benchmarkExitCode: 0,
			validationExitCode: 0,
		});
		expect(result.scheduler.state.benchmark).not.toHaveProperty("isolationViolation");
	});

	it("allows empty performance workflow tmp directories before benchmark joins", async () => {
		using tempDir = TempDir.createSync("@omh-performance-empty-project-tmp-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();

		await Bun.write(`${cwd}/src.txt`, "baseline\n");
		await Bun.write(
			`${cwd}/task.md`,
			["Benchmark Command:", "echo benchmark", "", "Validation Command:", "echo validation"].join("\n"),
		);
		await fs.mkdir(`${cwd}/workflow-output/tmp`, { recursive: true });
		await runGit(cwd, ["init"]);
		await runGit(cwd, ["config", "user.email", "omh@example.invalid"]);
		await runGit(cwd, ["config", "user.name", "OMH Test"]);
		await runGit(cwd, ["add", "src.txt", "task.md"]);
		await runGit(cwd, ["commit", "-m", "baseline"]);

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
			status: "pass",
			benchmarkExitCode: 0,
			validationExitCode: 0,
		});
		expect(result.scheduler.state.benchmark).not.toHaveProperty("isolationViolation");
		expect(await Bun.file(`${cwd}/workflow-output/performance-benchmark.md`).text()).toContain("echo benchmark");
	});

	it("materializes performance branch state into canonical reports before benchmark joins", async () => {
		using tempDir = TempDir.createSync("@omh-performance-branch-state-reports-");
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
		await Bun.write(`${cwd}/workflow-output/perf-algorithmic-candidate.diff`, "candidate patch\n");

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
				algorithmic: {
					summary: JSON.stringify({
						status: "candidate-produced",
						strategy: "algorithmic",
						candidatePatchPath: "workflow-output/perf-algorithmic-candidate.diff",
						finalSelection: "no",
						noWinResult: "no",
					}),
				},
				caching: {
					summary: "Cached lookup candidate completed. final-selection: no. no-win-result: no.",
				},
				io: {
					summary: JSON.stringify({
						status: "candidate-produced",
						strategy: "io",
						branchNotePath: "workflow-output/perf-io.md",
						finalSelection: "no",
						noWinResult: "no",
					}),
				},
			},
		});

		expect(result.scheduler.state.benchmark).toMatchObject({
			status: "pass",
			benchmarkExitCode: 0,
			validationExitCode: 0,
		});
		const algorithmicReport = await Bun.file(`${cwd}/workflow-output/perf-algorithmic.md`).text();
		const cachingReport = await Bun.file(`${cwd}/workflow-output/perf-caching.md`).text();
		const ioReport = await Bun.file(`${cwd}/workflow-output/perf-io.md`).text();
		expect(algorithmicReport).toContain("candidatePatchPath");
		expect(algorithmicReport).toContain("final-selection: no");
		expect(cachingReport).toContain("Cached lookup candidate completed");
		expect(ioReport).toContain("branchNotePath");
	});

	it("materializes performance branch reports from isolated patch artifacts without applying code changes", async () => {
		using tempDir = TempDir.createSync("@omh-performance-branch-patch-report-");
		using patchDir = TempDir.createSync("@omh-performance-branch-patch-artifact-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();
		const patchPath = `${patchDir.path()}/algorithmic.patch`;

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
		await Bun.write(
			patchPath,
			[
				"diff --git a/workflow-output/perf-algorithmic.md b/workflow-output/perf-algorithmic.md",
				"new file mode 100644",
				"index 0000000..1111111",
				"--- /dev/null",
				"+++ b/workflow-output/perf-algorithmic.md",
				"@@ -0,0 +1,8 @@",
				"+# Algorithmic candidate",
				"+",
				"+Candidate patch path: workflow-output/perf-algorithmic-candidate.diff",
				"+Benchmark command ran in the OMH-managed isolated lane worktree.",
				"+benchmark-relevance: yes",
				"+final-selection: no",
				"+no-win-result: no",
				"+No writable bare /tmp execution surface was used.",
				"diff --git a/workflow-output/perf-algorithmic-candidate.diff b/workflow-output/perf-algorithmic-candidate.diff",
				"new file mode 100644",
				"index 0000000..2222222",
				"--- /dev/null",
				"+++ b/workflow-output/perf-algorithmic-candidate.diff",
				"@@ -0,0 +1 @@",
				"+candidate patch",
				"diff --git a/workflow-output/perf-algorithmic-benchmark.md b/workflow-output/perf-algorithmic-benchmark.md",
				"new file mode 100644",
				"index 0000000..3333333",
				"--- /dev/null",
				"+++ b/workflow-output/perf-algorithmic-benchmark.md",
				"@@ -0,0 +1 @@",
				"+benchmark log",
				"diff --git a/workflow-output/perf-algorithmic-validation.md b/workflow-output/perf-algorithmic-validation.md",
				"new file mode 100644",
				"index 0000000..4444444",
				"--- /dev/null",
				"+++ b/workflow-output/perf-algorithmic-validation.md",
				"@@ -0,0 +1 @@",
				"+validation log",
				"diff --git a/src.txt b/src.txt",
				"index df967b9..0000000 100644",
				"--- a/src.txt",
				"+++ b/src.txt",
				"@@ -1 +1 @@",
				"-baseline",
				"+candidate code",
				"",
			].join("\n"),
		);

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
				algorithmic: {
					summary: JSON.stringify({
						agentId: "workflow-tryAlgorithmicChange-activation-5",
						patchPath,
						changesApplied: null,
					}),
				},
			},
		});

		expect(result.scheduler.state.benchmark).toMatchObject({
			status: "pass",
			benchmarkExitCode: 0,
			validationExitCode: 0,
		});
		expect(await Bun.file(`${cwd}/workflow-output/perf-algorithmic.md`).text()).toContain("# Algorithmic candidate");
		expect(await Bun.file(`${cwd}/workflow-output/perf-algorithmic-candidate.diff`).text()).toBe("candidate patch\n");
		expect(await Bun.file(`${cwd}/workflow-output/perf-algorithmic-benchmark.md`).text()).toBe("benchmark log\n");
		expect(await Bun.file(`${cwd}/workflow-output/perf-algorithmic-validation.md`).text()).toBe("validation log\n");
		expect(await Bun.file(`${cwd}/src.txt`).text()).toBe("baseline\n");
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

	it("blocks performance benchmark joins when branch evidence references shared sibling scratch", async () => {
		using tempDir = TempDir.createSync("@omh-performance-shared-sibling-scratch-guard-");
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
		await Bun.write(
			`${cwd}/workflow-output/perf-io.md`,
			[
				"# IO candidate",
				"",
				"project-external lane-local scratch path: ../workflow-scratch/io-worktree",
				"candidate patch path: workflow-output/perf-io-candidate.diff",
			].join("\n"),
		);
		await Bun.write(
			`${cwd}/workflow-output/perf-io-candidate-cargo-test-no-run.md`,
			"Built from /tmp/old-tuple/performance-optimization-search/workflow-scratch/algorithmic-worktree\n",
		);

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
			sharedScratchReferences: [
				"workflow-output/perf-io-candidate-cargo-test-no-run.md",
				"workflow-output/perf-io.md",
			],
		});
		expect(await Bun.file(`${cwd}/workflow-output/performance-benchmark.md`).text()).toContain(
			"Shared Scratch Isolation Violation",
		);
	});

	it("blocks performance benchmark joins when branch evidence uses scratch outside the allowed run root", async () => {
		using tempDir = TempDir.createSync("@omh-performance-run-root-scratch-guard-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();
		const previousRunTmp = process.env.OMH_RUN_TMP;
		process.env.OMH_RUN_TMP = `${cwd}/.omh-run-tmp`;

		try {
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
			await Bun.write(
				`${cwd}/workflow-output/perf-caching.md`,
				[
					"# Caching candidate",
					"",
					"project-external run-local scratch path: /tmp/P31-T03-41a9b66ed-fd-performance-scratch-recanary-b-caching",
					"git apply --check workflow-output/perf-caching-candidate.diff",
				].join("\n"),
			);
			await Bun.write(
				`${cwd}/workflow-output/perf-caching-candidate-cargo-test-no-run.md`,
				"benchmark cwd: /tmp/P31-T03-41a9b66ed-fd-performance-scratch-recanary-b-caching-applycheck\n",
			);

			const result = await runExampleScript({
				cwd,
				previousCwd,
				nodeId: "benchmarkCandidates",
				scriptFileName: "run-benchmark-validation.js",
				scriptDir: PERFORMANCE_OPTIMIZATION_SCRIPT_DIR,
				writes: ["/benchmark"],
				initialState: {
					task: {
						text: await Bun.file(`${cwd}/task.md`).text(),
						benchmarkCommand: "echo benchmark",
						validationCommand: "echo validation",
					},
				},
			});

			expect(result.scheduler.state.benchmark).toMatchObject({
				status: "fail",
				isolationViolation: true,
				disallowedScratchReferences: [
					"workflow-output/perf-caching-candidate-cargo-test-no-run.md",
					"workflow-output/perf-caching.md",
				],
			});
			expect(await Bun.file(`${cwd}/workflow-output/performance-benchmark.md`).text()).toContain(
				"Disallowed Scratch Root Violation",
			);
		} finally {
			if (previousRunTmp === undefined) {
				delete process.env.OMH_RUN_TMP;
			} else {
				process.env.OMH_RUN_TMP = previousRunTmp;
			}
		}
	});

	it("allows durable workflow-output candidate paths while enforcing scratch roots", async () => {
		using tempDir = TempDir.createSync("@omh-performance-durable-artifact-path-guard-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();
		const previousRunTmp = process.env.OMH_RUN_TMP;
		const runTmp = `${cwd}/run-tmp`;
		process.env.OMH_RUN_TMP = runTmp;

		try {
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
			const laneReports = {
				algorithmic: [
					"# Algorithmic candidate",
					"",
					`Candidate worktree: ${runTmp}/lanes/algorithmic/worktree`,
					`Apply-check worktree: ${runTmp}/lanes/algorithmic/apply-check/worktree`,
					`Benchmark command cwd: ${runTmp}/lanes/algorithmic/worktree; command: /usr/bin/time -f elapsed cargo run --release -- fixtures/large.txt >/dev/null`,
					`Candidate patch path: ${cwd}/workflow-output/perf-algorithmic-candidate.diff`,
					"All build, benchmark, validation, apply-check, and candidate execution commands were run from these lane-local scratch paths, not from the shared task workspace. No `TMPDIR=/tmp`, `workflow-output/tmp`, `bwrap --tmpfs /tmp`, `bwrap --bind /tmp`, or `bwrap --dir /tmp` execution surface was used.",
				],
				caching: [
					"# Caching candidate",
					"",
					`Candidate scratch change only: src/walk.rs in ${runTmp}/lanes/caching/worktree.`,
					`Candidate patch path: ${cwd}/workflow-output/perf-caching-candidate.diff`,
					"No lane-local execution scratch, fixture, worktree, or target directory was placed under `workflow-output/tmp`; no writable bare `/tmp` sandbox mount or bare `TMPDIR=/tmp` execution surface was used.",
				],
				io: [
					"# IO candidate",
					"",
					`worktree: ${runTmp}/worktrees/io`,
					`apply-check cwd: ${runTmp}/apply-check/io`,
					`git apply --check ${cwd}/workflow-output/perf-io-candidate.diff`,
					"No branch build, benchmark, validation, apply-check, or candidate execution command was run from the shared workspace. No `bwrap`, bare `/tmp`, `TMPDIR=/tmp`, or `workflow-output/tmp` path was used.",
					"I did not use bare `/tmp`, `../workflow-scratch`, or `workflow-output/tmp`.",
					"candidate patch path: workflow-output/perf-io-candidate.diff",
					`All command cwd values below are under task.scratchRoot. All temp directories were under ${runTmp}/io/tmp. No command used \`TMPDIR=/tmp\`, \`bwrap --tmpfs /tmp\`, \`bwrap --bind /tmp\`, \`bwrap --dir /tmp\`, or another writable bare \`/tmp\` execution surface.`,
					`TMPDIR values used for branch commands were lane-local directories under task.scratchRoot. No bwrap command, writable bare \`/tmp\` mount, \`--tmpfs /tmp\`, \`--bind /tmp\`, \`--dir /tmp\`, or \`TMPDIR=/tmp\` execution surface was used.`,
				],
			};
			for (const [lane, reportLines] of Object.entries(laneReports)) {
				await Bun.write(`${cwd}/workflow-output/perf-${lane}.md`, reportLines.join("\n"));
			}

			const result = await runExampleScript({
				cwd,
				previousCwd,
				nodeId: "benchmarkCandidates",
				scriptFileName: "run-benchmark-validation.js",
				scriptDir: PERFORMANCE_OPTIMIZATION_SCRIPT_DIR,
				writes: ["/benchmark"],
				initialState: {
					task: {
						text: await Bun.file(`${cwd}/task.md`).text(),
						scratchRoot: runTmp,
						benchmarkCommand: "echo benchmark",
						validationCommand: "echo validation",
					},
				},
			});

			expect(result.scheduler.state.benchmark).toMatchObject({
				status: "pass",
				benchmarkExitCode: 0,
				validationExitCode: 0,
			});
		} finally {
			if (previousRunTmp === undefined) {
				delete process.env.OMH_RUN_TMP;
			} else {
				process.env.OMH_RUN_TMP = previousRunTmp;
			}
		}
	});

	it("allows OMH-managed isolated worktree evidence while enforcing lane scratch roots", async () => {
		using tempDir = TempDir.createSync("@omh-performance-omh-worktree-evidence-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();
		const previousRunTmp = process.env.OMH_RUN_TMP;
		const previousWorktreeDir = process.env.OMP_WORKTREE_DIR;
		const runTmp = `${cwd}/run-tmp`;
		const managedWorktreeRoot = `${cwd}/../omh-managed-wt`;
		const managedLaneWorktree = `${managedWorktreeRoot}/tryAlgorithmicChange-abcd1234/merged`;
		process.env.OMH_RUN_TMP = runTmp;
		process.env.OMP_WORKTREE_DIR = managedWorktreeRoot;

		try {
			await Bun.write(`${cwd}/src.txt`, "baseline\n");
			const taskText = [
				"Benchmark Command:",
				"echo benchmark",
				"",
				"Validation Command:",
				"echo validation",
				"",
				"Scratch Root:",
				runTmp,
			].join("\n");
			await Bun.write(`${cwd}/task.md`, taskText);
			await runGit(cwd, ["init"]);
			await runGit(cwd, ["config", "user.email", "omh@example.invalid"]);
			await runGit(cwd, ["config", "user.name", "OMH Test"]);
			await runGit(cwd, ["add", "src.txt", "task.md"]);
			await runGit(cwd, ["commit", "-m", "baseline"]);
			await Bun.write(
				`${cwd}/workflow-output/perf-algorithmic.md`,
				[
					"# Algorithmic candidate",
					"",
					`OMH-managed isolated lane worktree cwd: ${managedLaneWorktree}`,
					"Benchmark command ran in the OMH-managed isolated lane worktree.",
					`Apply-check worktree: ${runTmp}/algorithmic/apply-check`,
					`Candidate patch path: ${cwd}/workflow-output/perf-algorithmic-candidate.diff`,
					"No branch build, benchmark, validation, apply-check, or candidate execution command was run from the shared workspace.",
				].join("\n"),
			);

			const result = await runExampleScript({
				cwd,
				previousCwd,
				nodeId: "benchmarkCandidates",
				scriptFileName: "run-benchmark-validation.js",
				scriptDir: PERFORMANCE_OPTIMIZATION_SCRIPT_DIR,
				writes: ["/benchmark"],
				initialState: {
					task: {
						text: taskText,
						scratchRoot: runTmp,
						benchmarkCommand: "echo benchmark",
						validationCommand: "echo validation",
					},
				},
			});

			expect(result.scheduler.state.benchmark).toMatchObject({
				status: "pass",
				benchmarkExitCode: 0,
				validationExitCode: 0,
			});
			expect(result.scheduler.state.benchmark).not.toHaveProperty("isolationViolation");
		} finally {
			if (previousRunTmp === undefined) {
				delete process.env.OMH_RUN_TMP;
			} else {
				process.env.OMH_RUN_TMP = previousRunTmp;
			}
			if (previousWorktreeDir === undefined) {
				delete process.env.OMP_WORKTREE_DIR;
			} else {
				process.env.OMP_WORKTREE_DIR = previousWorktreeDir;
			}
		}
	});

	it("allows task-declared target cache paths while enforcing lane scratch roots", async () => {
		using tempDir = TempDir.createSync("@omh-performance-task-cache-path-guard-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();
		const previousRunTmp = process.env.OMH_RUN_TMP;
		const runTmp = `${cwd}/run-tmp/scratch`;
		const cacheRoot = `${cwd}/../cache/fd-performance-target`;
		process.env.OMH_RUN_TMP = runTmp;

		try {
			await Bun.write(`${cwd}/src.txt`, "baseline\n");
			const taskText = [
				"Benchmark Command:",
				`CARGO_TARGET_DIR=${cacheRoot} TMPDIR=${runTmp}/algorithmic/tmp echo benchmark`,
				"",
				"Validation Command:",
				`CARGO_TARGET_DIR=${cacheRoot} echo validation`,
				"",
				"Scratch Root:",
				runTmp,
			].join("\n");
			await Bun.write(`${cwd}/task.md`, taskText);
			await runGit(cwd, ["init"]);
			await runGit(cwd, ["config", "user.email", "omh@example.invalid"]);
			await runGit(cwd, ["config", "user.name", "OMH Test"]);
			await runGit(cwd, ["add", "src.txt", "task.md"]);
			await runGit(cwd, ["commit", "-m", "baseline"]);
			await Bun.write(
				`${cwd}/workflow-output/perf-algorithmic.md`,
				[
					"# Algorithmic candidate",
					"",
					`cwd: ${runTmp}/algorithmic/fd`,
					`command: CARGO_TARGET_DIR=${cacheRoot} TMPDIR=${runTmp}/algorithmic/tmp cargo test -q regex_helper`,
				].join("\n"),
			);

			const result = await runExampleScript({
				cwd,
				previousCwd,
				nodeId: "benchmarkCandidates",
				scriptFileName: "run-benchmark-validation.js",
				scriptDir: PERFORMANCE_OPTIMIZATION_SCRIPT_DIR,
				writes: ["/benchmark"],
				initialState: {
					task: {
						text: taskText,
						scratchRoot: runTmp,
						benchmarkCommand: `CARGO_TARGET_DIR=${cacheRoot} echo benchmark`,
						validationCommand: `CARGO_TARGET_DIR=${cacheRoot} echo validation`,
					},
				},
			});

			expect(result.scheduler.state.benchmark).toMatchObject({
				status: "pass",
				benchmarkExitCode: 0,
				validationExitCode: 0,
			});
		} finally {
			if (previousRunTmp === undefined) {
				delete process.env.OMH_RUN_TMP;
			} else {
				process.env.OMH_RUN_TMP = previousRunTmp;
			}
		}
	});

	it("allows read-only clone sources from the shared workspace into lane scratch", async () => {
		using tempDir = TempDir.createSync("@omh-performance-readonly-clone-source-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();
		const previousRunTmp = process.env.OMH_RUN_TMP;
		const runTmp = `${cwd}/../.run-tmp/P67-T01-5d3fe0579a-fd-performance-cache-path-recanary/scratch`;
		process.env.OMH_RUN_TMP = runTmp;

		try {
			await Bun.write(`${cwd}/src.txt`, "baseline\n");
			const taskText = ["Benchmark Command:", "echo benchmark", "", "Validation Command:", "echo validation"].join(
				"\n",
			);
			await Bun.write(`${cwd}/task.md`, taskText);
			await runGit(cwd, ["init"]);
			await runGit(cwd, ["config", "user.email", "omh@example.invalid"]);
			await runGit(cwd, ["config", "user.name", "OMH Test"]);
			await runGit(cwd, ["add", "src.txt", "task.md"]);
			await runGit(cwd, ["commit", "-m", "baseline"]);
			await Bun.write(
				`${cwd}/workflow-output/perf-algorithmic-applycheck.json`,
				`${JSON.stringify(
					{
						clone: {
							cwd: runTmp,
							command: `git clone --no-hardlinks ${cwd} ${runTmp}/algorithmic-applycheck`,
							exitCode: 0,
							stdout: "",
							stderr: `Cloning into '${runTmp}/algorithmic-applycheck'...\n`,
						},
						applyCheck: {
							cwd: `${runTmp}/algorithmic-applycheck`,
							command: `git apply --check ${cwd}/workflow-output/perf-algorithmic-candidate.diff`,
							exitCode: 0,
							stdout: "",
							stderr: "",
						},
					},
					null,
					2,
				)}\n`,
			);

			const result = await runExampleScript({
				cwd,
				previousCwd,
				nodeId: "benchmarkCandidates",
				scriptFileName: "run-benchmark-validation.js",
				scriptDir: PERFORMANCE_OPTIMIZATION_SCRIPT_DIR,
				writes: ["/benchmark"],
				initialState: {
					task: {
						text: taskText,
						scratchRoot: runTmp,
						benchmarkCommand: "echo benchmark",
						validationCommand: "echo validation",
					},
				},
			});

			expect(result.scheduler.state.benchmark).toMatchObject({
				status: "pass",
				benchmarkExitCode: 0,
				validationExitCode: 0,
			});
			expect(result.scheduler.state.benchmark).not.toHaveProperty("isolationViolation");
		} finally {
			if (previousRunTmp === undefined) {
				delete process.env.OMH_RUN_TMP;
			} else {
				process.env.OMH_RUN_TMP = previousRunTmp;
			}
		}
	});

	it("blocks performance benchmark joins when branch evidence references workflow tmp scratch", async () => {
		using tempDir = TempDir.createSync("@omh-performance-workflow-tmp-reference-guard-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();
		const previousRunTmp = process.env.OMH_RUN_TMP;
		process.env.OMH_RUN_TMP = `${cwd}/run-tmp`;

		try {
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
			await Bun.write(
				`${cwd}/workflow-output/perf-io.md`,
				[
					"# IO candidate",
					"",
					`worktree: ${cwd}/workflow-output/tmp/io-worktree`,
					"candidate patch path: workflow-output/perf-io-candidate.diff",
				].join("\n"),
			);

			const result = await runExampleScript({
				cwd,
				previousCwd,
				nodeId: "benchmarkCandidates",
				scriptFileName: "run-benchmark-validation.js",
				scriptDir: PERFORMANCE_OPTIMIZATION_SCRIPT_DIR,
				writes: ["/benchmark"],
				initialState: {
					task: {
						text: await Bun.file(`${cwd}/task.md`).text(),
						benchmarkCommand: "echo benchmark",
						validationCommand: "echo validation",
					},
				},
			});

			expect(result.scheduler.state.benchmark).toMatchObject({
				status: "fail",
				isolationViolation: true,
				disallowedScratchReferences: ["workflow-output/perf-io.md"],
			});
		} finally {
			if (previousRunTmp === undefined) {
				delete process.env.OMH_RUN_TMP;
			} else {
				process.env.OMH_RUN_TMP = previousRunTmp;
			}
		}
	});

	it("blocks performance benchmark joins when branch evidence mounts writable bare tmp", async () => {
		using tempDir = TempDir.createSync("@omh-performance-bare-tmp-sandbox-guard-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();
		const previousRunTmp = process.env.OMH_RUN_TMP;
		const runTmp = `${cwd}/run-tmp`;
		process.env.OMH_RUN_TMP = runTmp;

		try {
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
			await Bun.write(
				`${cwd}/workflow-output/perf-io.md`,
				[
					"# IO candidate",
					"",
					`worktree: ${runTmp}/branches/io/worktree`,
					"command: bwrap --die-with-parent --tmpfs /tmp --chdir /work cargo test test_respect_ignore_files --locked",
					"candidate patch path: workflow-output/perf-io-candidate.diff",
				].join("\n"),
			);

			const result = await runExampleScript({
				cwd,
				previousCwd,
				nodeId: "benchmarkCandidates",
				scriptFileName: "run-benchmark-validation.js",
				scriptDir: PERFORMANCE_OPTIMIZATION_SCRIPT_DIR,
				writes: ["/benchmark"],
				initialState: {
					task: {
						text: await Bun.file(`${cwd}/task.md`).text(),
						scratchRoot: runTmp,
						benchmarkCommand: "echo benchmark",
						validationCommand: "echo validation",
					},
				},
			});

			expect(result.scheduler.state.benchmark).toMatchObject({
				status: "fail",
				isolationViolation: true,
				disallowedScratchReferences: ["workflow-output/perf-io.md"],
			});
			expect(await Bun.file(`${cwd}/workflow-output/performance-benchmark.md`).text()).toContain(
				"Disallowed Scratch Root Violation",
			);
		} finally {
			if (previousRunTmp === undefined) {
				delete process.env.OMH_RUN_TMP;
			} else {
				process.env.OMH_RUN_TMP = previousRunTmp;
			}
		}
	});

	it("blocks performance benchmark joins when branch evidence runs validation from the shared workspace", async () => {
		using tempDir = TempDir.createSync("@omh-performance-shared-workspace-exec-guard-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();
		const previousRunTmp = process.env.OMH_RUN_TMP;
		const runTmp = `${cwd}/run-tmp`;
		process.env.OMH_RUN_TMP = runTmp;

		try {
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
			await Bun.write(
				`${cwd}/workflow-output/perf-io.md`,
				[
					"# IO candidate",
					"",
					`worktree: ${runTmp}/branches/io/worktree`,
					"Benchmark command run in the lane worktree: echo benchmark",
					"Validation command run from the unmodified shared workspace with cwd: .",
					"candidate patch path: workflow-output/perf-io-candidate.diff",
				].join("\n"),
			);

			const result = await runExampleScript({
				cwd,
				previousCwd,
				nodeId: "benchmarkCandidates",
				scriptFileName: "run-benchmark-validation.js",
				scriptDir: PERFORMANCE_OPTIMIZATION_SCRIPT_DIR,
				writes: ["/benchmark"],
				initialState: {
					task: {
						text: await Bun.file(`${cwd}/task.md`).text(),
						scratchRoot: runTmp,
						benchmarkCommand: "echo benchmark",
						validationCommand: "echo validation",
					},
				},
			});

			expect(result.scheduler.state.benchmark).toMatchObject({
				status: "fail",
				isolationViolation: true,
				sharedWorkspaceExecutionReferences: ["workflow-output/perf-io.md"],
			});
			expect(await Bun.file(`${cwd}/workflow-output/performance-benchmark.md`).text()).toContain(
				"Shared Workspace Execution Violation",
			);
		} finally {
			if (previousRunTmp === undefined) {
				delete process.env.OMH_RUN_TMP;
			} else {
				process.env.OMH_RUN_TMP = previousRunTmp;
			}
		}
	});

	it("does not treat rollback instructions as shared workspace execution evidence", async () => {
		using tempDir = TempDir.createSync("@omh-performance-rollback-shared-workspace-wording-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();
		const previousRunTmp = process.env.OMH_RUN_TMP;
		const runTmp = `${cwd}/run-tmp`;
		process.env.OMH_RUN_TMP = runTmp;

		try {
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
			await Bun.write(`${cwd}/workflow-output/perf-io-candidate.diff`, "candidate patch\n");
			await Bun.write(
				`${cwd}/workflow-output/perf-io.md`,
				[
					"# IO candidate",
					"",
					`Benchmark command cwd: ${runTmp}/branches/io/worktree`,
					`Validation command cwd: ${runTmp}/branches/io/worktree`,
					"candidate patch path: workflow-output/perf-io-candidate.diff",
					"",
					"## Rollback instructions",
					"From the lane or selected shared workspace root, run:",
					"",
					"```sh",
					"git apply -R workflow-output/perf-io-candidate.diff",
					"```",
				].join("\n"),
			);

			const result = await runExampleScript({
				cwd,
				previousCwd,
				nodeId: "benchmarkCandidates",
				scriptFileName: "run-benchmark-validation.js",
				scriptDir: PERFORMANCE_OPTIMIZATION_SCRIPT_DIR,
				writes: ["/benchmark"],
				initialState: {
					task: {
						text: await Bun.file(`${cwd}/task.md`).text(),
						scratchRoot: runTmp,
						benchmarkCommand: "echo benchmark",
						validationCommand: "echo validation",
					},
				},
			});

			expect(result.scheduler.state.benchmark).toMatchObject({
				status: "pass",
				benchmarkExitCode: 0,
				validationExitCode: 0,
			});
			expect(await Bun.file(`${cwd}/workflow-output/performance-benchmark.md`).text()).not.toContain(
				"Shared Workspace Execution Violation",
			);
		} finally {
			if (previousRunTmp === undefined) {
				delete process.env.OMH_RUN_TMP;
			} else {
				process.env.OMH_RUN_TMP = previousRunTmp;
			}
		}
	});

	it("refuses performance repair reports that try to override lane isolation violations", async () => {
		using tempDir = TempDir.createSync("@omh-performance-repair-report-finalize-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();
		const taskText = [
			"# Performance repair report canary",
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

		for (const name of ["algorithmic", "caching", "io"]) {
			await Bun.write(
				`${cwd}/workflow-output/perf-${name}.md`,
				[
					"# Branch",
					"",
					"final-selection: no",
					"no-win-result: yes",
					"rollback and no-change evidence: no project files remain changed",
				].join("\n"),
			);
		}
		await Bun.write(
			`${cwd}/workflow-output/performance-benchmark.md`,
			[
				"# Performance Benchmark Evidence",
				"",
				"## Disallowed Scratch Root Violation",
				"",
				"- workflow-output/perf-algorithmic.md",
				"- workflow-output/perf-caching.md",
				"- workflow-output/perf-io.md",
			].join("\n"),
		);
		await Bun.write(
			`${cwd}/workflow-output/performance-selection-repair.md`,
			[
				"# Performance Selection Repair",
				"",
				"- Repair-node clean shared workspace benchmark command: `cargo test --no-run` exited 0 after all rollback.",
				"- Repair-node clean shared workspace validation command: `cargo test` exited 101 after all rollback.",
				"- Post-rollback project diff: `git diff --name-only` returned no paths.",
				"- Post-rollback benchmark command: `cargo test --no-run` exited 0.",
				"- Post-rollback validation command: `cargo test` exited 101.",
			].join("\n"),
		);

		const guard = await runExampleScript({
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
					status: "fail",
					isolationViolation: true,
					outputPath: "workflow-output/performance-benchmark.md",
				},
				selectionRepair: {
					status: "completed",
				},
			},
		});

		expect(guard.scheduler.state.selectionGuard).toMatchObject({
			benchmarkPassed: true,
			validationPassed: false,
			projectChangedFiles: [],
		});

		const finalize = await runExampleScript({
			cwd,
			previousCwd,
			nodeId: "finalizePerformanceSelection",
			scriptFileName: "finalize-performance-selection.js",
			scriptDir: PERFORMANCE_OPTIMIZATION_SCRIPT_DIR,
			writes: ["/selection"],
			initialState: {
				...guard.scheduler.state,
				task: {
					text: taskText,
				},
				benchmark: {
					status: "fail",
					isolationViolation: true,
					outputPath: "workflow-output/performance-benchmark.md",
				},
				selectionRepair: {
					status: "completed",
				},
			},
		});

		expect(
			finalize.scheduler.activations.find(activation => activation.nodeId === "finalizePerformanceSelection")
				?.status,
		).toBe("failed");
		expect(finalize.scheduler.state.selection).toBeUndefined();
	});

	it("finalizes performance repair no-win evidence from branch-style exit lines", async () => {
		using tempDir = TempDir.createSync("@omh-performance-repair-branch-exit-lines-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();
		const taskText = [
			"# Performance branch-style repair evidence",
			"",
			"Benchmark Command:",
			"cargo test -q --test tests test_regex",
			"",
			"Validation Command:",
			"cargo test -q --test tests test_regex && cargo test -q --test tests test_glob",
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

		for (const name of ["algorithmic", "caching", "io"]) {
			await Bun.write(
				`${cwd}/workflow-output/perf-${name}.md`,
				[
					"# Branch",
					"",
					"final-selection: no",
					"no-win-result: yes",
					"rollback and no-change evidence: no project files remain changed",
				].join("\n"),
			);
		}
		await Bun.write(
			`${cwd}/workflow-output/performance-benchmark.md`,
			[
				"# Performance Benchmark Evidence",
				"",
				"## Prior Benchmark Failure",
				"",
				"Initial branch benchmark evidence was inconclusive before repair.",
			].join("\n"),
		);
		await Bun.write(
			`${cwd}/workflow-output/performance-selection-repair.md`,
			[
				"# Performance Selection Repair",
				"",
				"- `workflow-output/perf-algorithmic.md`: benchmark exit code 0 and validation exit code 0, but no measured positive movement.",
				"- `workflow-output/perf-caching.md`: benchmark exit code 0 and validation exit code 0, but no measured positive movement.",
				"- `workflow-output/perf-io.md`: benchmark exit code 0 and validation exit code 0, but no stable positive result.",
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
					status: "fail",
					benchmarkExitCode: 1,
					validationExitCode: 1,
					outputPath: "workflow-output/performance-benchmark.md",
				},
				selectionRepair: {
					status: "completed",
				},
			},
		});

		expect(finalize.scheduler.state.selection).toMatchObject({
			status: "pass",
			terminalState: "no-win",
			validationPassed: true,
			noWinBranches: ["algorithmic", "caching", "io"],
		});
	});

	it("finalizes performance no-win when the task contract authorizes archival in prose", async () => {
		using tempDir = TempDir.createSync("@omh-performance-prose-no-win-authorization-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();
		const taskText = [
			"# Performance search with prose no-win authorization",
			"",
			"Objective:",
			"Search for a bounded optimization without changing semantics. If no safe positive candidate exists, archive a no-win result with real benchmark evidence.",
			"",
			"Benchmark Command:",
			"cargo test -q --release --test tests test_gitignore",
			"",
			"Validation Command:",
			"cargo test -q --test tests test_gitignore",
			"",
			"Acceptance Criteria:",
			"- no-win is acceptable only with real branch evidence, not sleep/no-op loops.",
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
			[
				"# Algorithmic",
				"",
				"final-selection: no",
				"no-win-result: yes",
				"rollback evidence: clean workspace after reverting the non-reproducing candidate",
			].join("\n"),
		);
		await Bun.write(
			`${cwd}/workflow-output/perf-caching.md`,
			["# Caching", "", "final-selection: no", "rollback evidence: no retained changes"].join("\n"),
		);
		await Bun.write(
			`${cwd}/workflow-output/perf-io.md`,
			["# IO", "", "final-selection: no", "rollback evidence: no retained changes"].join("\n"),
		);
		await Bun.write(`${cwd}/workflow-output/performance-benchmark.md`, "# Benchmark\n\nExit code: 0\n");

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
					validationExitCode: 0,
					status: "pass",
					outputPath: "workflow-output/performance-benchmark.md",
				},
			},
		});

		expect(finalize.scheduler.state.selection).toMatchObject({
			status: "pass",
			terminalState: "no-win",
			noWinBranches: ["algorithmic"],
		});
	});

	it("finalizes positive performance repair evidence from status-style report lines", async () => {
		using tempDir = TempDir.createSync("@omh-performance-repair-status-lines-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();
		const taskText = [
			"# Performance status-style repair evidence",
			"",
			"Benchmark Command:",
			"python -m timeit -s 'from src.click.parser import normalize' 'normalize(\"--help\")'",
			"",
			"Validation Command:",
			"python -m pytest tests/test_parser.py -q",
			"",
			"Allowed paths:",
			"- src/click/parser.py",
			"- tests/test_parser.py",
		].join("\n");

		await Bun.write(`${cwd}/src/click/parser.py`, "def normalize(value):\n    return value\n");
		await Bun.write(`${cwd}/tests/test_parser.py`, "def test_normalize():\n    assert True\n");
		await Bun.write(`${cwd}/task.md`, taskText);
		await runGit(cwd, ["init"]);
		await runGit(cwd, ["config", "user.email", "omh@example.invalid"]);
		await runGit(cwd, ["config", "user.name", "OMH Test"]);
		await runGit(cwd, ["add", "src/click/parser.py", "tests/test_parser.py", "task.md"]);
		await runGit(cwd, ["commit", "-m", "baseline"]);
		await Bun.write(`${cwd}/src/click/parser.py`, "def normalize(value):\n    return value.lstrip('-')\n");
		await Bun.write(
			`${cwd}/tests/test_parser.py`,
			"def test_normalize():\n    assert normalize('--help') == 'help'\n",
		);

		await Bun.write(
			`${cwd}/workflow-output/perf-algorithmic.md`,
			[
				"# Algorithmic",
				"",
				"final-selection: yes",
				"benchmark-relevance: yes",
				"semantic-probe: yes",
				"semantic probe evidence: focused parser verification preserves normalize behavior",
				"rollback evidence: rejected branches were reverted before retaining this candidate",
			].join("\n"),
		);
		for (const name of ["caching", "io"]) {
			await Bun.write(
				`${cwd}/workflow-output/perf-${name}.md`,
				["# Branch", "", "final-selection: no", "rollback evidence: no retained changes"].join("\n"),
			);
		}
		await Bun.write(
			`${cwd}/workflow-output/performance-selection-repair.md`,
			[
				"# Performance Selection Repair",
				"",
				"- Benchmark status: pass.",
				"- Benchmark artifact: `workflow-output/click-benchmark.out` = `0.04297649699947215` seconds.",
				"- Validation status: pass.",
				"- Validation result: `782 passed`, `1 skipped`.",
				"- Focused parser verification: `8 passed`.",
			].join("\n"),
		);
		await Bun.write(`${cwd}/workflow-output/click-benchmark.out`, "0.04297649699947215\n");

		const guard = await runExampleScript({
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
					status: "fail",
					benchmarkExitCode: 1,
					validationExitCode: 1,
				},
				selectionRepair: {
					status: "terminal positive selection repair complete",
				},
			},
		});

		expect(guard.scheduler.state.selectionGuard).toMatchObject({
			benchmarkPassed: true,
			validationPassed: true,
			projectChangedFiles: ["src/click/parser.py", "tests/test_parser.py"],
		});

		const finalize = await runExampleScript({
			cwd,
			previousCwd,
			nodeId: "finalizePerformanceSelection",
			scriptFileName: "finalize-performance-selection.js",
			scriptDir: PERFORMANCE_OPTIMIZATION_SCRIPT_DIR,
			writes: ["/selection"],
			initialState: {
				...guard.scheduler.state,
				task: {
					text: taskText,
				},
				benchmark: {
					status: "fail",
					benchmarkExitCode: 1,
					validationExitCode: 1,
				},
				selectionRepair: {
					status: "terminal positive selection repair complete",
				},
			},
		});

		expect(finalize.scheduler.state.selection).toMatchObject({
			status: "pass",
			terminalState: "positive",
			validationPassed: true,
			selectedBranches: ["algorithmic"],
		});
	});

	it("finalizes and archives committed positive performance selections with a clean worktree", async () => {
		using tempDir = TempDir.createSync("@omh-performance-committed-positive-selection-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();
		const taskText = [
			"# Performance committed positive selection",
			"",
			"Benchmark Command:",
			"scripts/observability.sh",
			"",
			"Validation Command:",
			"test -x scripts/observability.sh",
		].join("\n");

		await Bun.write(`${cwd}/task.md`, taskText);
		await Bun.write(`${cwd}/README.md`, "baseline\n");
		await runGit(cwd, ["init"]);
		await runGit(cwd, ["config", "user.email", "omh@example.invalid"]);
		await runGit(cwd, ["config", "user.name", "OMH Test"]);
		await runGit(cwd, ["add", "task.md", "README.md"]);
		await runGit(cwd, ["commit", "-m", "baseline"]);
		await Bun.write(`${cwd}/scripts/observability.sh`, "#!/usr/bin/env sh\necho docs=1 headings=1 todos=0\n");
		await runGit(cwd, ["add", "scripts/observability.sh"]);
		await runGit(cwd, ["commit", "-m", "add selected observability script"]);

		await Bun.write(
			`${cwd}/workflow-output/perf-algorithmic.md`,
			[
				"# Algorithmic",
				"",
				"final-selection: yes",
				"benchmark-relevance: yes",
				"semantic-probe: yes",
				"semantic probe evidence: retained script matches the benchmark contract on a fixture.",
				"rollback evidence: losing branches were not retained.",
			].join("\n"),
		);
		for (const name of ["caching", "io"]) {
			await Bun.write(
				`${cwd}/workflow-output/perf-${name}.md`,
				["# Branch", "", "final-selection: no", "rollback evidence: no retained changes"].join("\n"),
			);
		}
		await Bun.write(
			`${cwd}/workflow-output/performance-selection-repair.md`,
			[
				"# Performance Selection Repair",
				"",
				"- Selected retained candidate: `algorithmic`.",
				"- Committed selected project change `abc123`: `add selected observability script`.",
				"- Benchmark status: pass, exit code 0.",
				"- Validation status: pass, exit code 0.",
			].join("\n"),
		);
		await Bun.write(`${cwd}/workflow-output/performance-baseline.md`, "# Baseline\n\nbaseline evidence\n");
		await Bun.write(`${cwd}/workflow-output/performance-benchmark.md`, "# Benchmark\n\nstale benchmark\n");

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
					status: "fail",
					benchmarkExitCode: 1,
					validationExitCode: 1,
				},
				selectionRepair: {
					status: "terminal positive selection repair complete",
				},
				review: "finish",
			},
		});

		expect(finalize.scheduler.state.selection).toMatchObject({
			status: "pass",
			terminalState: "positive",
			projectChangedFiles: [],
			selectedBranches: ["algorithmic"],
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
			status: "accepted",
			noWin: false,
			projectChangedFiles: [],
		});
		expect(await Bun.file(`${cwd}/workflow-output/performance-archive.md`).text()).toContain(
			"terminalState: positive",
		);
	});

	it("blocks positive performance repair without benchmark relevance evidence", async () => {
		using tempDir = TempDir.createSync("@omh-performance-benchmark-relevance-selected-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();
		const taskText = [
			"# Performance benchmark relevance guard",
			"",
			"Benchmark Command:",
			"python -m timeit -s 'from src.click.parser import normalize' 'normalize(\"--help\")'",
			"",
			"Validation Command:",
			"python -m pytest tests/test_parser.py -q",
		].join("\n");

		await Bun.write(`${cwd}/src/click/parser.py`, "def normalize(value):\n    return value\n");
		await Bun.write(`${cwd}/tests/test_parser.py`, "def test_normalize():\n    assert True\n");
		await Bun.write(`${cwd}/task.md`, taskText);
		await runGit(cwd, ["init"]);
		await runGit(cwd, ["config", "user.email", "omh@example.invalid"]);
		await runGit(cwd, ["config", "user.name", "OMH Test"]);
		await runGit(cwd, ["add", "src/click/parser.py", "tests/test_parser.py", "task.md"]);
		await runGit(cwd, ["commit", "-m", "baseline"]);
		await Bun.write(`${cwd}/src/click/parser.py`, "def normalize(value):\n    return value.lstrip('-')\n");
		await Bun.write(
			`${cwd}/workflow-output/perf-caching.md`,
			[
				"# Caching",
				"",
				"final-selection: yes",
				"semantic-probe: yes",
				"semantic probe evidence: focused parser verification preserves normalize behavior",
				"rollback evidence: rejected branches were reverted before retaining this candidate",
			].join("\n"),
		);
		for (const name of ["algorithmic", "io"]) {
			await Bun.write(
				`${cwd}/workflow-output/perf-${name}.md`,
				["# Branch", "", "final-selection: no", "rollback evidence: no retained changes"].join("\n"),
			);
		}
		await Bun.write(
			`${cwd}/workflow-output/performance-selection-repair.md`,
			["# Performance Selection Repair", "", "- Benchmark status: pass.", "- Validation status: pass."].join("\n"),
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
					validationExitCode: 0,
					status: "pass",
				},
				selectionRepair: {
					status: "terminal positive selection repair complete",
				},
			},
		});

		const activation = result.scheduler.activations.find(item => item.nodeId === "guardSelectionRepair");
		expect(activation?.status).toBe("failed");
		expect(activation?.error).toContain("benchmark relevance");
	});

	it("blocks unselected positive performance branches without off-benchmark rejection evidence", async () => {
		using tempDir = TempDir.createSync("@omh-performance-off-benchmark-rejection-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();
		const taskText = [
			"# Performance off-benchmark rejection guard",
			"",
			"Benchmark Command:",
			"python -m timeit -s 'from src.click.parser import normalize' 'normalize(\"--help\")'",
			"",
			"Validation Command:",
			"python -m pytest tests/test_parser.py -q",
		].join("\n");

		await Bun.write(`${cwd}/src/click/parser.py`, "def normalize(value):\n    return value\n");
		await Bun.write(`${cwd}/tests/test_parser.py`, "def test_normalize():\n    assert True\n");
		await Bun.write(`${cwd}/task.md`, taskText);
		await runGit(cwd, ["init"]);
		await runGit(cwd, ["config", "user.email", "omh@example.invalid"]);
		await runGit(cwd, ["config", "user.name", "OMH Test"]);
		await runGit(cwd, ["add", "src/click/parser.py", "tests/test_parser.py", "task.md"]);
		await runGit(cwd, ["commit", "-m", "baseline"]);
		await Bun.write(`${cwd}/src/click/parser.py`, "def normalize(value):\n    return value.lstrip('-')\n");
		await Bun.write(
			`${cwd}/workflow-output/perf-caching.md`,
			[
				"# Caching",
				"",
				"final-selection: yes",
				"benchmark-relevance: yes",
				"semantic-probe: yes",
				"semantic probe evidence: focused parser verification preserves normalize behavior",
				"rollback evidence: rejected branches were reverted before retaining this candidate",
			].join("\n"),
		);
		await Bun.write(
			`${cwd}/workflow-output/perf-algorithmic.md`,
			[
				"# Algorithmic",
				"",
				"final-selection: no",
				"reported a positive benchmark on Command.get_params cache construction",
				"rollback evidence: no retained changes",
			].join("\n"),
		);
		await Bun.write(
			`${cwd}/workflow-output/perf-io.md`,
			["# IO", "", "final-selection: no", "rollback evidence: no retained changes"].join("\n"),
		);
		await Bun.write(
			`${cwd}/workflow-output/performance-selection-repair.md`,
			["# Performance Selection Repair", "", "- Benchmark status: pass.", "- Validation status: pass."].join("\n"),
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
					validationExitCode: 0,
					status: "pass",
				},
				selectionRepair: {
					status: "terminal positive selection repair complete",
				},
			},
		});

		const activation = result.scheduler.activations.find(item => item.nodeId === "guardSelectionRepair");
		expect(activation?.status).toBe("failed");
		expect(activation?.error).toContain("off-benchmark rejection");
	});

	it("accepts benchmark-covered losing performance branches with comparative rejection evidence", async () => {
		using tempDir = TempDir.createSync("@omh-performance-covered-losing-rejection-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();
		const taskText = [
			"# Performance covered losing rejection guard",
			"",
			"Benchmark Command:",
			"python -m timeit -s 'from src.click.parser import normalize' 'normalize(\"--help\")'",
			"",
			"Validation Command:",
			"python -m pytest tests/test_parser.py -q",
		].join("\n");

		await Bun.write(`${cwd}/src/click/parser.py`, "def normalize(value):\n    return value\n");
		await Bun.write(`${cwd}/tests/test_parser.py`, "def test_normalize():\n    assert True\n");
		await Bun.write(`${cwd}/task.md`, taskText);
		await runGit(cwd, ["init"]);
		await runGit(cwd, ["config", "user.email", "omh@example.invalid"]);
		await runGit(cwd, ["config", "user.name", "OMH Test"]);
		await runGit(cwd, ["add", "src/click/parser.py", "tests/test_parser.py", "task.md"]);
		await runGit(cwd, ["commit", "-m", "baseline"]);
		await Bun.write(`${cwd}/src/click/parser.py`, "def normalize(value):\n    return value.lstrip('-')\n");
		await Bun.write(
			`${cwd}/workflow-output/perf-caching.md`,
			[
				"# Caching",
				"",
				"final-selection: yes",
				"benchmark-relevance: yes",
				"semantic-probe: yes",
				"semantic probe evidence: focused parser verification preserves normalize behavior",
				"rollback evidence: rejected branches were reverted before retaining this candidate",
			].join("\n"),
		);
		await Bun.write(
			`${cwd}/workflow-output/perf-algorithmic.md`,
			[
				"# Algorithmic",
				"",
				"final-selection: no",
				"benchmark-relevance: yes",
				"off-benchmark: no",
				"reported a positive benchmark-covered run, but the retained caching candidate has a larger measured task-benchmark improvement",
				"rollback evidence: no retained changes",
			].join("\n"),
		);
		await Bun.write(
			`${cwd}/workflow-output/perf-io.md`,
			["# IO", "", "final-selection: no", "rollback evidence: no retained changes"].join("\n"),
		);
		await Bun.write(
			`${cwd}/workflow-output/performance-selection-repair.md`,
			["# Performance Selection Repair", "", "- Benchmark status: pass.", "- Validation status: pass."].join("\n"),
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
					validationExitCode: 0,
					status: "pass",
				},
				selectionRepair: {
					status: "terminal positive selection repair complete",
				},
			},
		});

		expect(result.scheduler.state.selectionGuard).toMatchObject({
			status: "pass",
			positiveUnselectedBranches: ["algorithmic"],
			benchmarkCoveredRejectedBranches: ["algorithmic"],
		});
	});

	it("accepts sectioned performance repair rejection evidence after materialization", async () => {
		using tempDir = TempDir.createSync("@omh-performance-sectioned-repair-guard-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();
		const taskText = [
			"# Performance-aware refactor with regression checks",
			"",
			"Benchmark Command:",
			"cat fixtures/large.txt fixtures/large.txt | cargo run --release --quiet",
			"",
			"Validation Command:",
			"cargo test && printf 'alpha beta\\ngamma\\n' | cargo run --quiet | grep ^3",
		].join("\n");

		await Bun.write(`${cwd}/src/main.rs`, "fn main() {}\n");
		await Bun.write(`${cwd}/task.md`, taskText);
		await runGit(cwd, ["init"]);
		await runGit(cwd, ["config", "user.email", "omh@example.invalid"]);
		await runGit(cwd, ["config", "user.name", "OMH Test"]);
		await runGit(cwd, ["add", "src/main.rs", "task.md"]);
		await runGit(cwd, ["commit", "-m", "baseline"]);
		await Bun.write(
			`${cwd}/workflow-output/perf-algorithmic.md`,
			[
				"# Algorithmic",
				"",
				"final-selection: yes",
				"benchmark-relevance: yes",
				"semantic-probe: yes",
				"semantic probe evidence: CLI ASCII and Unicode probes passed",
			].join("\n"),
		);
		await Bun.write(
			`${cwd}/workflow-output/perf-caching.md`,
			[
				"# Caching",
				"",
				"final-selection: no",
				"positive benchmark-like result: yes",
				"rollback evidence: no retained changes",
			].join("\n"),
		);
		await Bun.write(
			`${cwd}/workflow-output/perf-io.md`,
			[
				"# IO",
				"",
				"final-selection: no",
				"no positive benchmark result; correctness-only median matched the IO candidate median",
				"rollback evidence: no retained changes",
			].join("\n"),
		);
		await Bun.write(
			`${cwd}/workflow-output/performance-selection-repair.md`,
			[
				"# Performance Selection Repair",
				"",
				"## Current benchmark and validation status",
				"",
				"- Validation command: `cargo test && printf 'alpha beta\\ngamma\\n' | cargo run --quiet | grep ^3`",
				"  - Status: pass, exit code 0.",
				"- Benchmark command: `cat fixtures/large.txt fixtures/large.txt | cargo run --release --quiet`",
				"  - Status: pass, exit code 0.",
				"",
				"## Terminal selection",
				"",
				"- Selected branch: algorithmic.",
				"- No-win branch: none for the terminal project.",
				"",
				"## Benchmark relevance and branch rejection evidence",
				"",
				"- Selected algorithmic benchmark-relevance: yes.",
				"  - The task benchmark exercises the retained ASCII byte-scanner path.",
				"- Caching rejection:",
				"  - final-selection: no.",
				"  - positive benchmark-like result: yes.",
				"  - benchmark-relevance: yes; off-benchmark: no.",
				"  - Explicit rejection reason: weaker than the retained benchmark-covered algorithmic candidate.",
				"- IO rejection:",
				"  - final-selection: no.",
				"  - benchmark-relevance: yes; off-benchmark: no.",
				"  - Explicit rejection reason: no positive benchmark result.",
			].join("\n"),
		);

		const materialized = await runExampleScript({
			cwd,
			previousCwd,
			nodeId: "materializeSelectionRepair",
			scriptFileName: "materialize-selection-repair.js",
			scriptDir: PERFORMANCE_OPTIMIZATION_SCRIPT_DIR,
			writes: ["/selectionRepair"],
		});

		expect(materialized.scheduler.state.selectionRepair).toMatchObject({
			benchmark: { status: "pass", exitCode: 0 },
			validation: { status: "pass", exitCode: 0 },
			selectedBranch: "algorithmic",
			noWinBranch: "none for the terminal project",
		});

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
					validationExitCode: 0,
					status: "pass",
				},
				selectionRepair: materialized.scheduler.state.selectionRepair,
			},
		});

		const activation = result.scheduler.activations.find(item => item.nodeId === "guardSelectionRepair");
		expect(activation?.error).toBeUndefined();
		expect(activation?.status).toBe("completed");
		expect(result.scheduler.state.selectionGuard).toMatchObject({
			status: "pass",
			benchmarkPassed: true,
			validationPassed: true,
			positiveUnselectedBranches: ["caching"],
			benchmarkCoveredRejectedBranches: ["caching"],
			benchmarkRelevanceBlockers: [],
		});
	});

	it("does not treat no positive benchmark-like repair evidence as a positive branch", async () => {
		using tempDir = TempDir.createSync("@omh-performance-no-positive-benchmark-like-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();
		const taskText = [
			"# Performance-aware refactor with regression checks",
			"",
			"Benchmark Command:",
			"cat fixtures/large.txt fixtures/large.txt | cargo run --release --quiet",
			"",
			"Validation Command:",
			"cargo test && printf 'alpha beta\\ngamma\\n' | cargo run --quiet | grep ^3",
		].join("\n");

		await Bun.write(`${cwd}/src/main.rs`, "fn main() {}\n");
		await Bun.write(`${cwd}/task.md`, taskText);
		await runGit(cwd, ["init"]);
		await runGit(cwd, ["config", "user.email", "omh@example.invalid"]);
		await runGit(cwd, ["config", "user.name", "OMH Test"]);
		await runGit(cwd, ["add", "src/main.rs", "task.md"]);
		await runGit(cwd, ["commit", "-m", "baseline"]);
		await Bun.write(`${cwd}/src/main.rs`, 'fn main() { println!("1"); }\n');
		await Bun.write(
			`${cwd}/workflow-output/perf-caching.md`,
			[
				"# Performance caching Branch",
				"",
				"- final-selection: yes",
				"- no-win-result: no",
				"- benchmark-relevance: yes",
				"- semantic-probe: yes",
				"- semantic probe evidence: repeated-line CLI behavior passed",
			].join("\n"),
		);
		await Bun.write(
			`${cwd}/workflow-output/perf-algorithmic.md`,
			[
				"# Performance algorithmic Branch",
				"",
				"- final-selection: no",
				"- no-win-result: no",
				"- benchmark-relevance: yes",
				"- off-benchmark: no",
				"- Algorithmic branch initially reported a positive benchmark-like result.",
				"- Explicit rejection reason: weaker than the selected caching candidate.",
				"- rollback evidence: no retained changes",
			].join("\n"),
		);
		await Bun.write(
			`${cwd}/workflow-output/perf-io.md`,
			[
				"# Performance io Branch",
				"",
				"- final-selection: no",
				"- no-win-result: no",
				"- benchmark-relevance: yes",
				"- IO branch reported no positive task benchmark result: baseline median `30 ms`, candidate median `30 ms`, speedup `0.00%`.",
				"- off-benchmark: no positive benchmark-like result was reported, so no off-benchmark win was rejected.",
				"- rollback evidence: no retained changes",
			].join("\n"),
		);
		await Bun.write(
			`${cwd}/workflow-output/performance-selection-repair.md`,
			[
				"# Performance Selection Repair",
				"",
				"## Current benchmark and validation status",
				"",
				"- Validation command: `cargo test && printf 'alpha beta\\ngamma\\n' | cargo run --quiet | grep ^3`",
				"  - cwd: `/workspace/project`",
				"  - exit code: 0",
				"- Benchmark command: `cat fixtures/large.txt fixtures/large.txt | cargo run --release --quiet`",
				"  - cwd: `/workspace/project`",
				"  - exit code: 0",
				"",
				"## Selection result",
				"",
				"- selected branch: caching",
				"- final-selection: yes",
				"",
				"## Off-benchmark and unselected-branch rejection evidence",
				"",
				"- algorithmic:",
				"  - final-selection: no.",
				"  - off-benchmark: no.",
				"  - Algorithmic branch initially reported a benchmark-like positive result.",
				"  - Explicit rejection reason: weaker than the selected benchmark-covered caching candidate.",
				"- IO:",
				"  - final-selection: no.",
				"  - off-benchmark: no positive benchmark-like result was reported.",
				"  - Explicit rejection reason: no positive benchmark result.",
			].join("\n"),
		);

		const materialized = await runExampleScript({
			cwd,
			previousCwd,
			nodeId: "materializeSelectionRepair",
			scriptFileName: "materialize-selection-repair.js",
			scriptDir: PERFORMANCE_OPTIMIZATION_SCRIPT_DIR,
			writes: ["/selectionRepair"],
		});

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
					validationExitCode: 0,
					status: "pass",
				},
				selectionRepair: materialized.scheduler.state.selectionRepair,
			},
		});

		expect(materialized.scheduler.state.selectionRepair).toMatchObject({
			benchmark: { status: "pass", exitCode: 0 },
			validation: { status: "pass", exitCode: 0 },
		});
		const selectionGuard = expectRecord(result.scheduler.state.selectionGuard, "selectionGuard");
		expect(selectionGuard.status).toBe("pass");
		expect(selectionGuard.positiveUnselectedBranches).toEqual(["algorithmic"]);
		expect(selectionGuard.benchmarkCoveredRejectedBranches).toEqual(["algorithmic"]);
		expect(selectionGuard.benchmarkRelevanceBlockers).toEqual([]);
	});

	it("does not treat selected-branch positive references as unselected branch wins", async () => {
		using tempDir = TempDir.createSync("@omh-performance-selected-positive-reference-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();
		const taskText = [
			"# Performance-aware refactor with regression checks",
			"",
			"Benchmark Command:",
			"cat fixtures/large.txt fixtures/large.txt | cargo run --release --quiet",
			"",
			"Validation Command:",
			"cargo test && printf 'alpha beta\\ngamma\\n' | cargo run --quiet | grep ^3",
		].join("\n");

		await Bun.write(`${cwd}/src/main.rs`, "fn main() {}\n");
		await Bun.write(`${cwd}/task.md`, taskText);
		await runGit(cwd, ["init"]);
		await runGit(cwd, ["config", "user.email", "omh@example.invalid"]);
		await runGit(cwd, ["config", "user.name", "OMH Test"]);
		await runGit(cwd, ["add", "src/main.rs", "task.md"]);
		await runGit(cwd, ["commit", "-m", "baseline"]);
		await Bun.write(`${cwd}/src/main.rs`, 'fn main() { println!("1"); }\n');
		await Bun.write(
			`${cwd}/workflow-output/perf-caching.md`,
			[
				"# Performance caching Branch",
				"",
				"final-selection: yes",
				"benchmark-relevance: yes",
				"semantic-probe: yes",
				"semantic probe evidence: repeated-line CLI behavior passed",
			].join("\n"),
		);
		await Bun.write(
			`${cwd}/workflow-output/perf-algorithmic.md`,
			[
				"# Performance algorithmic Branch",
				"",
				"final-selection: no",
				"benchmark-relevance: yes",
				"off-benchmark: no",
				"Unselected because branch evidence reported a negative benchmark result.",
				"off-benchmark: no - this branch did not report a positive benchmark-like result needing off-benchmark rejection.",
				"Its correctness-only patch was not applied because the selected caching branch had a safe positive benchmark-covered result.",
				"rollback evidence: no retained changes",
			].join("\n"),
		);
		await Bun.write(
			`${cwd}/workflow-output/perf-io.md`,
			[
				"# Performance io Branch",
				"",
				"final-selection: no",
				"benchmark-relevance: yes",
				"off-benchmark: no",
				"Unselected because the candidate was noise-band, not a safe positive result.",
				"off-benchmark: no - this branch did not report a positive benchmark-like result needing off-benchmark rejection.",
				"Its correctness-only patch was not applied because the selected caching branch had a safe positive benchmark-covered result.",
				"rollback evidence: no retained changes",
			].join("\n"),
		);
		await Bun.write(
			`${cwd}/workflow-output/performance-selection-repair.md`,
			[
				"# Performance Selection Repair",
				"",
				"## Current benchmark and validation status",
				"",
				"- Validation command: `cargo test && printf 'alpha beta\\ngamma\\n' | cargo run --quiet | grep ^3`",
				"  - exit code: 0",
				"- Benchmark command: `cat fixtures/large.txt fixtures/large.txt | cargo run --release --quiet`",
				"  - exit code: 0",
				"",
				"## Selection result",
				"",
				"- selected branch: caching",
				"- final-selection: yes",
				"",
				"## Losing branches",
				"",
				"- Algorithmic:",
				"  - final-selection: no.",
				"  - Rejection reason: benchmark was negative.",
				"  - off-benchmark: no - this branch did not report a positive benchmark-like result needing off-benchmark rejection.",
				"- IO:",
				"  - final-selection: no.",
				"  - Rejection reason: benchmark was noise-band.",
				"  - off-benchmark: no - this branch did not report a positive benchmark-like result needing off-benchmark rejection.",
			].join("\n"),
		);

		const materialized = await runExampleScript({
			cwd,
			previousCwd,
			nodeId: "materializeSelectionRepair",
			scriptFileName: "materialize-selection-repair.js",
			scriptDir: PERFORMANCE_OPTIMIZATION_SCRIPT_DIR,
			writes: ["/selectionRepair"],
		});

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
					validationExitCode: 0,
					status: "pass",
				},
				selectionRepair: materialized.scheduler.state.selectionRepair,
			},
		});

		const selectionGuard = expectRecord(result.scheduler.state.selectionGuard, "selectionGuard");
		expect(selectionGuard.status).toBe("pass");
		expect(selectionGuard.positiveUnselectedBranches).toEqual([]);
		expect(selectionGuard.benchmarkCoveredRejectedBranches).toEqual([]);
		expect(selectionGuard.benchmarkRelevanceBlockers).toEqual([]);
	});

	it("accepts repair rerun validation evidence and counts untracked retained files", async () => {
		using tempDir = TempDir.createSync("@omh-performance-repair-rerun-validation-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();
		const taskText = [
			"# Performance-aware refactor with regression checks",
			"",
			"Benchmark Command:",
			"cat fixtures/large.txt fixtures/large.txt | cargo run --release --quiet",
			"",
			"Validation Command:",
			"cargo test && printf 'alpha beta\\ngamma\\n' | cargo run --quiet | grep '^3$'",
		].join("\n");

		await Bun.write(`${cwd}/src/main.rs`, "fn main() {}\n");
		await Bun.write(`${cwd}/task.md`, taskText);
		await runGit(cwd, ["init"]);
		await runGit(cwd, ["config", "user.email", "omh@example.invalid"]);
		await runGit(cwd, ["config", "user.name", "OMH Test"]);
		await runGit(cwd, ["add", "src/main.rs", "task.md"]);
		await runGit(cwd, ["commit", "-m", "baseline"]);
		await Bun.write(
			`${cwd}/src/main.rs`,
			[
				"use std::io::{self, Read};",
				"use rust_word_counter::count_words;",
				"fn main() {",
				"\tlet mut text = String::new();",
				"\tio::stdin().read_to_string(&mut text).unwrap();",
				'\tprintln!("{}", count_words(&text));',
				"}",
				"",
			].join("\n"),
		);
		await Bun.write(
			`${cwd}/src/lib.rs`,
			[
				"pub fn count_words(input: &str) -> usize {",
				"\tif input.is_ascii() {",
				"\t\tinput.split_ascii_whitespace().count()",
				"\t} else {",
				"\t\tinput.split_whitespace().count()",
				"\t}",
				"}",
				"",
			].join("\n"),
		);
		await Bun.write(
			`${cwd}/workflow-output/perf-algorithmic.md`,
			[
				"# Performance algorithmic Branch",
				"",
				"- final-selection: yes",
				"- no-win-result: no",
				"- benchmark-relevance: yes",
				"- semantic-probe: yes",
				"- semantic probe evidence: ASCII fast path and Unicode fallback passed.",
			].join("\n"),
		);
		await Bun.write(
			`${cwd}/workflow-output/perf-caching.md`,
			["# Performance caching Branch", "", "- final-selection: no", "- rollback evidence: no retained changes"].join(
				"\n",
			),
		);
		await Bun.write(
			`${cwd}/workflow-output/perf-io.md`,
			["# Performance io Branch", "", "- final-selection: no", "- rollback evidence: no retained changes"].join(
				"\n",
			),
		);
		await Bun.write(
			`${cwd}/workflow-output/performance-selection-repair.md`,
			[
				"# Performance Selection Repair",
				"",
				"## Current status",
				"",
				"- Selected branch: algorithmic.",
				"",
				"Validation command after applying selected candidate:",
				"",
				"```sh",
				"cargo test && printf 'alpha beta\\ngamma\\n' | cargo run --quiet | grep '^3$'",
				"```",
				"",
				"Status: pass, exit code 0.",
				"",
				"Benchmark command after applying selected candidate:",
				"",
				"```sh",
				"cat fixtures/large.txt fixtures/large.txt | cargo run --release --quiet",
				"```",
				"",
				"Status: pass, exit code 0.",
				"",
				"## Selected algorithmic branch",
				"",
				"- Final marker: `final-selection: yes`.",
				"- Benchmark relevance: yes. The task benchmark covers the retained ASCII fast path.",
				"- Semantic probe: yes.",
			].join("\n"),
		);

		const materialized = await runExampleScript({
			cwd,
			previousCwd,
			nodeId: "materializeSelectionRepair",
			scriptFileName: "materialize-selection-repair.js",
			scriptDir: PERFORMANCE_OPTIMIZATION_SCRIPT_DIR,
			writes: ["/selectionRepair"],
		});

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
					validationExitCode: 0,
					status: "pass",
				},
				selectionRepair: materialized.scheduler.state.selectionRepair,
			},
		});

		const selectionGuard = expectRecord(result.scheduler.state.selectionGuard, "selectionGuard");
		expect(materialized.scheduler.state.selectionRepair).toMatchObject({
			benchmark: { status: "pass", exitCode: 0 },
			validation: { status: "pass", exitCode: 0 },
		});
		expect(selectionGuard.status).toBe("pass");
		expect(selectionGuard.validationPassed).toBe(true);
		expect(selectionGuard.projectChangedFiles).toEqual(["src/main.rs", "src/lib.rs"]);
	});

	it("finalizes benchmark-covered losing performance branches with comparative rejection evidence", async () => {
		using tempDir = TempDir.createSync("@omh-performance-finalize-covered-losing-rejection-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();
		const taskText = [
			"# Performance covered losing finalizer",
			"",
			"Benchmark Command:",
			"python -m timeit -s 'from src.click.parser import normalize' 'normalize(\"--help\")'",
			"",
			"Validation Command:",
			"python -m pytest tests/test_parser.py -q",
		].join("\n");

		await Bun.write(`${cwd}/src/click/parser.py`, "def normalize(value):\n    return value\n");
		await Bun.write(`${cwd}/tests/test_parser.py`, "def test_normalize():\n    assert True\n");
		await Bun.write(`${cwd}/task.md`, taskText);
		await runGit(cwd, ["init"]);
		await runGit(cwd, ["config", "user.email", "omh@example.invalid"]);
		await runGit(cwd, ["config", "user.name", "OMH Test"]);
		await runGit(cwd, ["add", "src/click/parser.py", "tests/test_parser.py", "task.md"]);
		await runGit(cwd, ["commit", "-m", "baseline"]);
		await Bun.write(`${cwd}/src/click/parser.py`, "def normalize(value):\n    return value.lstrip('-')\n");
		await Bun.write(
			`${cwd}/workflow-output/perf-caching.md`,
			[
				"# Caching",
				"",
				"final-selection: yes",
				"benchmark-relevance: yes",
				"semantic-probe: yes",
				"semantic probe evidence: focused parser verification preserves normalize behavior",
				"rollback evidence: rejected branches were reverted before retaining this candidate",
			].join("\n"),
		);
		await Bun.write(
			`${cwd}/workflow-output/perf-algorithmic.md`,
			[
				"# Algorithmic",
				"",
				"final-selection: no",
				"benchmark-relevance: yes",
				"off-benchmark: no",
				"reported a positive benchmark-covered run, but repeat evidence regressed and was weaker than the selected caching candidate",
				"rollback evidence: no retained changes",
			].join("\n"),
		);
		await Bun.write(
			`${cwd}/workflow-output/perf-io.md`,
			["# IO", "", "final-selection: no", "rollback evidence: no retained changes"].join("\n"),
		);
		await Bun.write(
			`${cwd}/workflow-output/performance-selection-repair.md`,
			["# Performance Selection Repair", "", "- Benchmark status: pass.", "- Validation status: pass."].join("\n"),
		);

		const result = await runExampleScript({
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
					validationExitCode: 0,
					status: "pass",
				},
				selectionRepair: {
					status: "terminal positive selection repair complete",
				},
				review: "finish",
			},
		});

		expect(result.scheduler.state.selection).toMatchObject({
			status: "pass",
			terminalState: "positive",
			selectedBranches: ["caching"],
			benchmarkCoveredRejectedBranches: ["algorithmic"],
		});
	});

	it("blocks positive performance selection without semantic probe evidence", async () => {
		using tempDir = TempDir.createSync("@omh-performance-positive-semantic-probe-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();
		const taskText = [
			"# Performance semantic probe canary",
			"",
			"Benchmark Command:",
			"python -m timeit '1 + 1'",
			"",
			"Validation Command:",
			"python -c 'print(\"ok\")'",
		].join("\n");

		await Bun.write(`${cwd}/src.txt`, "baseline\n");
		await Bun.write(`${cwd}/task.md`, taskText);
		await runGit(cwd, ["init"]);
		await runGit(cwd, ["config", "user.email", "omh@example.invalid"]);
		await runGit(cwd, ["config", "user.name", "OMH Test"]);
		await runGit(cwd, ["add", "src.txt", "task.md"]);
		await runGit(cwd, ["commit", "-m", "baseline"]);
		await Bun.write(`${cwd}/src.txt`, "selected candidate\n");
		await Bun.write(
			`${cwd}/workflow-output/perf-io.md`,
			["# IO", "", "final-selection: yes", "benchmark-relevance: yes", "rollback evidence: revert src.txt"].join(
				"\n",
			),
		);
		for (const name of ["algorithmic", "caching"]) {
			await Bun.write(
				`${cwd}/workflow-output/perf-${name}.md`,
				["# Branch", "", "final-selection: no", "rollback evidence: no retained changes"].join("\n"),
			);
		}

		const result = await runExampleScript({
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
					validationExitCode: 0,
					status: "pass",
				},
				review: "finish",
			},
		});

		const activation = result.scheduler.activations.find(item => item.nodeId === "finalizePerformanceSelection");
		expect(activation?.status).toBe("failed");
		expect(activation?.error).toContain("semantic probe evidence");
	});

	it("blocks positive performance selection without benchmark relevance evidence", async () => {
		using tempDir = TempDir.createSync("@omh-performance-positive-benchmark-relevance-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();
		const taskText = [
			"# Performance terminal relevance guard",
			"",
			"Benchmark Command:",
			"python -m timeit '1 + 1'",
			"",
			"Validation Command:",
			"python -c 'print(\"ok\")'",
		].join("\n");

		await Bun.write(`${cwd}/src.txt`, "baseline\n");
		await Bun.write(`${cwd}/task.md`, taskText);
		await runGit(cwd, ["init"]);
		await runGit(cwd, ["config", "user.email", "omh@example.invalid"]);
		await runGit(cwd, ["config", "user.name", "OMH Test"]);
		await runGit(cwd, ["add", "src.txt", "task.md"]);
		await runGit(cwd, ["commit", "-m", "baseline"]);
		await Bun.write(`${cwd}/src.txt`, "selected candidate\n");
		await Bun.write(
			`${cwd}/workflow-output/perf-io.md`,
			[
				"# IO",
				"",
				"final-selection: yes",
				"semantic-probe: yes",
				"semantic probe evidence: focused behavior probe passed",
				"rollback evidence: revert src.txt",
			].join("\n"),
		);
		for (const name of ["algorithmic", "caching"]) {
			await Bun.write(
				`${cwd}/workflow-output/perf-${name}.md`,
				["# Branch", "", "final-selection: no", "rollback evidence: no retained changes"].join("\n"),
			);
		}

		const result = await runExampleScript({
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
					validationExitCode: 0,
					status: "pass",
				},
				review: "finish",
			},
		});

		const activation = result.scheduler.activations.find(item => item.nodeId === "finalizePerformanceSelection");
		expect(activation?.status).toBe("failed");
		expect(activation?.error).toContain("benchmark relevance");
	});

	it("blocks positive performance selection when the reviewer found a semantic regression", async () => {
		using tempDir = TempDir.createSync("@omh-performance-negative-review-gate-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();
		const taskText = [
			"# Performance review-gated canary",
			"",
			"Benchmark Command:",
			"python -m timeit '1 + 1'",
			"",
			"Validation Command:",
			"python -c 'print(\"ok\")'",
		].join("\n");

		await Bun.write(`${cwd}/src/click/testing.py`, "def make_env(env):\n    return env\n");
		await Bun.write(`${cwd}/task.md`, taskText);
		await runGit(cwd, ["init"]);
		await runGit(cwd, ["config", "user.email", "omh@example.invalid"]);
		await runGit(cwd, ["config", "user.name", "OMH Test"]);
		await runGit(cwd, ["add", "src/click/testing.py", "task.md"]);
		await runGit(cwd, ["commit", "-m", "baseline"]);
		await Bun.write(`${cwd}/src/click/testing.py`, "def make_env(env):\n    return env or {}\n");
		await Bun.write(
			`${cwd}/workflow-output/perf-io.md`,
			[
				"# IO",
				"",
				"final-selection: yes",
				"benchmark-relevance: yes",
				"rollback evidence: revert src/click/testing.py if the optimization changes behavior",
			].join("\n"),
		);
		for (const name of ["algorithmic", "caching"]) {
			await Bun.write(
				`${cwd}/workflow-output/perf-${name}.md`,
				["# Branch", "", "final-selection: no", "rollback evidence: no retained changes"].join("\n"),
			);
		}

		const result = await runExampleScript({
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
					validationExitCode: 0,
					status: "pass",
				},
				review: {
					overall_correctness: "incorrect",
					explanation:
						"The selected patch changes observable subclass behavior, so this should continue rather than finish.",
				},
			},
		});

		expect(
			result.scheduler.activations.find(activation => activation.nodeId === "finalizePerformanceSelection")?.status,
		).toBe("failed");
	});

	it("blocks performance archive when a restored selection still has a negative review", async () => {
		using tempDir = TempDir.createSync("@omh-performance-negative-review-archive-gate-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();

		await Bun.write(`${cwd}/src.txt`, "baseline\n");
		await Bun.write(`${cwd}/task.md`, "Benchmark Command:\necho benchmark\n\nValidation Command:\necho validation\n");
		await runGit(cwd, ["init"]);
		await runGit(cwd, ["config", "user.email", "omh@example.invalid"]);
		await runGit(cwd, ["config", "user.name", "OMH Test"]);
		await runGit(cwd, ["add", "src.txt", "task.md"]);
		await runGit(cwd, ["commit", "-m", "baseline"]);
		await Bun.write(`${cwd}/src.txt`, "selected candidate\n");
		await Bun.write(
			`${cwd}/workflow-output/perf-io.md`,
			["# IO", "", "final-selection: yes", "rollback evidence: revert src.txt"].join("\n"),
		);
		for (const name of ["algorithmic", "caching"]) {
			await Bun.write(
				`${cwd}/workflow-output/perf-${name}.md`,
				["# Branch", "", "final-selection: no", "rollback evidence: no retained changes"].join("\n"),
			);
		}

		const result = await runExampleScript({
			cwd,
			previousCwd,
			nodeId: "archivePerformance",
			scriptFileName: "archive-performance.js",
			scriptDir: PERFORMANCE_OPTIMIZATION_SCRIPT_DIR,
			writes: ["/archive"],
			initialState: {
				benchmark: {
					benchmarkExitCode: 0,
					validationExitCode: 0,
					status: "pass",
				},
				selection: {
					status: "pass",
					terminalState: "positive",
					selectedBranches: ["io"],
					noWinBranches: [],
				},
				review: "overall_correctness: incorrect\nverdict: continue\nThe selected candidate changes behavior.",
			},
		});

		expect(result.scheduler.activations.find(activation => activation.nodeId === "archivePerformance")?.status).toBe(
			"failed",
		);
	});

	it("archives retained performance repair benchmarks instead of stale shared benchmark output", async () => {
		using tempDir = TempDir.createSync("@omh-performance-retained-repair-benchmark-archive-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();

		await Bun.write(`${cwd}/src.txt`, "baseline\n");
		await Bun.write(`${cwd}/task.md`, "Benchmark Command:\necho benchmark\n\nValidation Command:\necho validation\n");
		await runGit(cwd, ["init"]);
		await runGit(cwd, ["config", "user.email", "omh@example.invalid"]);
		await runGit(cwd, ["config", "user.name", "OMH Test"]);
		await runGit(cwd, ["add", "src.txt", "task.md"]);
		await runGit(cwd, ["commit", "-m", "baseline"]);
		await Bun.write(`${cwd}/src.txt`, "selected candidate\n");
		await Bun.write(`${cwd}/workflow-output/performance-baseline.md`, "# Baseline\n\nbench 0.0109\n");
		await Bun.write(`${cwd}/workflow-output/performance-benchmark.md`, "# Benchmark\n\nbench 0.0113\n");
		await Bun.write(
			`${cwd}/workflow-output/performance-selection-repair.md`,
			[
				"# Performance Selection Repair",
				"",
				"## Current benchmark and validation status",
				"- benchmark status: pass, exit code 0",
				"- benchmark stdout:",
				"",
				"```text",
				"bench 0.0089",
				"```",
				"- validation status: pass, exit code 0",
				"",
				"## Semantic behavior probe for retained candidate",
				"- semantic-probe: yes",
			].join("\n"),
		);
		await Bun.write(
			`${cwd}/workflow-output/perf-algorithmic.md`,
			[
				"# Algorithmic",
				"",
				"final-selection: yes",
				"semantic-probe: yes",
				"rollback evidence: git apply -R workflow-output/perf-algorithmic-candidate.diff",
			].join("\n"),
		);
		for (const name of ["caching", "io"]) {
			await Bun.write(
				`${cwd}/workflow-output/perf-${name}.md`,
				["# Branch", "", "final-selection: no", "rollback evidence: no retained changes"].join("\n"),
			);
		}

		const result = await runExampleScript({
			cwd,
			previousCwd,
			nodeId: "archivePerformance",
			scriptFileName: "archive-performance.js",
			scriptDir: PERFORMANCE_OPTIMIZATION_SCRIPT_DIR,
			writes: ["/archive"],
			initialState: {
				benchmark: {
					benchmarkExitCode: 0,
					validationExitCode: 0,
					status: "pass",
				},
				selectionRepair: {
					benchmark: { status: "pass", exit_code: 0 },
					validation: { status: "pass", exit_code: 0 },
				},
				selection: {
					status: "pass",
					terminalState: "positive",
					selectedBranches: ["algorithmic"],
					noWinBranches: [],
				},
				review: { overall_correctness: "correct" },
			},
		});

		expect(result.scheduler.state.archive).toMatchObject({
			status: "accepted",
			benchmarkEvidence: "workflow-output/performance-selection-repair.md",
		});
		const archive = await Bun.file(`${cwd}/workflow-output/performance-archive.md`).text();
		const benchmarkSection = archive.split("## Branch Notes")[0] ?? archive;
		expect(benchmarkSection).toContain("bench 0.0089");
		expect(benchmarkSection).not.toContain("bench 0.0113");
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

	it("refuses performance repair state after an isolation-blocked join", async () => {
		using tempDir = TempDir.createSync("@omh-performance-repaired-no-win-validation-blocked-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();
		const taskText = [
			"# Performance repaired no-win canary",
			"",
			"Benchmark Command:",
			"cargo run --release",
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

		for (const name of ["algorithmic", "caching", "io"]) {
			await Bun.write(
				`${cwd}/workflow-output/perf-${name}.md`,
				["# Branch", "", "final-selection: no", "rollback evidence: no retained changes"].join("\n"),
			);
		}
		await Bun.write(
			`${cwd}/workflow-output/perf-no-win.md`,
			[
				"# No-win terminal branch note",
				"",
				"final-selection: no",
				"no-win-result: yes",
				"rollback and no-change evidence: no project source, test, or documentation file is retained.",
			].join("\n"),
		);
		await Bun.write(
			`${cwd}/workflow-output/performance-benchmark.md`,
			["# Benchmark", "", "Project-Local Scratch Isolation Violation", "", "- workflow-output/tmp"].join("\n"),
		);
		await Bun.write(`${cwd}/workflow-output/repair-current-benchmark.log`, "exit code 0\n");
		await Bun.write(`${cwd}/workflow-output/repair-current-validation.log`, "exit code 101\n");

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
					status: "fail",
					isolationViolation: true,
					outputPath: "workflow-output/performance-benchmark.md",
				},
				selectionRepair: {
					status: "completed",
					decision: "terminal-no-win-validation-blocked",
					benchmark: {
						status: "pass",
						exit_code: 0,
						log: "workflow-output/repair-current-benchmark.log",
					},
					validation: {
						status: "fail",
						exit_code: 101,
						log: "workflow-output/repair-current-validation.log",
					},
				},
			},
		});

		expect(
			finalize.scheduler.activations.find(activation => activation.nodeId === "finalizePerformanceSelection")
				?.status,
		).toBe("failed");
		expect(finalize.scheduler.state.selection).toBeUndefined();
	});

	it("archives performance no-win evidence as rejected when the task lacks no-win authorization", async () => {
		using tempDir = TempDir.createSync("@omh-performance-no-win-rejected-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();
		const taskText = [
			"# Performance no-win rejected canary",
			"",
			"Benchmark Command:",
			"cargo test --no-run",
			"",
			"Validation Command:",
			"cargo test",
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
				"rollback evidence: no project changes remain after losing candidates",
			].join("\n"),
		);
		await Bun.write(
			`${cwd}/workflow-output/perf-io.md`,
			["# IO", "", "final-selection: no", "rollback evidence: no retained changes"].join("\n"),
		);
		await Bun.write(`${cwd}/workflow-output/performance-benchmark.md`, "# Benchmark\n\nExit code: 0\n");

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
					validationExitCode: 0,
					status: "pass",
					outputPath: "workflow-output/performance-benchmark.md",
				},
			},
		});

		expect(finalize.scheduler.state.selection).toMatchObject({
			status: "rejected",
			terminalState: "rejected-no-win-not-authorized",
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
			status: "rejected",
			noWin: true,
		});
		expect(await Bun.file(`${cwd}/workflow-output/performance-archive.md`).text()).toContain(
			"terminalState: rejected-no-win-not-authorized",
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

	it("continues test-hardening gap materialization when generation can create a missing validation target", async () => {
		using tempDir = TempDir.createSync("@omh-test-hardening-missing-target-gap-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();

		const result = await runExampleScript({
			cwd,
			previousCwd,
			nodeId: "materializeGapReport",
			scriptFileName: "materialize-gap-report.js",
			scriptDir: `${TEST_GENERATION_HARDENING_DIR}/scripts`,
			writes: ["/gaps"],
			initialState: {
				gaps: {
					status: "ready",
					summary:
						"Pytest is installed and the frozen validation command starts, but it exits during collection because the declared tutorial target tests/test_tutorial/test_encoder.py is absent.",
					validation: {
						startable: true,
						command:
							"python -m pytest tests/test_jsonable_encoder.py tests/test_tutorial/test_encoder.py tests/test_response_model_as_return_annotation.py",
						status:
							"started; pytest available; failed during path collection because one declared test file is missing",
						exitCode: 4,
						stderr:
							"ERROR: file or directory not found: tests/test_tutorial/test_encoder.py\ncollected 0 items\nno tests ran",
					},
					filesLikelyToNeedTestChanges: [
						{
							path: "tests/test_tutorial/test_encoder.py",
							reason: "Create the missing frozen-command tutorial target.",
						},
					],
					smallestUsefulTestAdditions: [
						{
							priority: "P1",
							file: "tests/test_tutorial/test_encoder.py",
							addition: "Add a focused tutorial encoder regression test at the declared validation target.",
						},
					],
				},
			},
		});

		expect(
			result.scheduler.activations.find(activation => activation.nodeId === "materializeGapReport")?.status,
		).toBe("completed");
		expect(result.scheduler.state.gaps).toMatchObject({
			gapReportPath: "workflow-output/test-hardening-gap-report.md",
		});
		const report = await Bun.file(`${cwd}/workflow-output/test-hardening-gap-report.md`).text();
		expect(report).toContain("tests/test_tutorial/test_encoder.py");
		expect(report).toContain("file or directory not found");
	});

	it("continues test-hardening gap materialization for actionable existing validation failures", async () => {
		using tempDir = TempDir.createSync("@omh-test-hardening-actionable-failure-gap-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();

		const result = await runExampleScript({
			cwd,
			previousCwd,
			nodeId: "materializeGapReport",
			scriptFileName: "materialize-gap-report.js",
			scriptDir: `${TEST_GENERATION_HARDENING_DIR}/scripts`,
			writes: ["/gaps"],
			initialState: {
				gaps: {
					status: "ready",
					summary:
						"Validation command starts and the scoped suite executes, but it exits non-zero on an existing timeout cleanup test. Coverage inspection found defensible gaps in event hooks and ASGI/WSGI transport passthrough.",
					validation: {
						startable: true,
						command:
							"python -m pytest tests/client/test_event_hooks.py tests/test_timeouts.py tests/test_asgi.py tests/test_wsgi.py",
						status: "started; pytest completed with an existing failure",
						exitCode: 1,
						stderr:
							"tests/test_timeouts.py::test_write_timeout[trio] failed with PytestUnraisableExceptionWarning; Summary: 1 failed, 321 passed.",
					},
					unitGaps: [
						{
							priority: 1,
							gap: "Event hooks are tested as observers, not mutation points.",
						},
					],
					integrationGaps: [
						{
							priority: 1,
							gap: "ASGITransport and WSGITransport passthrough options lack focused tests.",
						},
					],
					filesLikelyToNeedTestChanges: [
						"tests/client/test_event_hooks.py",
						"tests/test_asgi.py",
						"tests/test_wsgi.py",
					],
					smallestUsefulTestAdditions: [
						{
							priority: 1,
							files: ["tests/test_asgi.py"],
							addition: "Add one ASGI scope passthrough contract test.",
						},
						{
							priority: 2,
							files: ["tests/test_wsgi.py"],
							addition: "Add one WSGI environ passthrough contract test.",
						},
					],
				},
			},
		});

		expect(
			result.scheduler.activations.find(activation => activation.nodeId === "materializeGapReport")?.status,
		).toBe("completed");
		expect(result.scheduler.state.gaps).toMatchObject({
			gapReportPath: "workflow-output/test-hardening-gap-report.md",
		});
		const report = await Bun.file(`${cwd}/workflow-output/test-hardening-gap-report.md`).text();
		expect(report).toContain("existing timeout cleanup test");
		expect(report).toContain("ASGI scope passthrough contract test");
	});

	it("fails test-hardening gap materialization when a missing validation target collides with an existing package", async () => {
		using tempDir = TempDir.createSync("@omh-test-hardening-missing-target-package-collision-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();

		await Bun.write(`${cwd}/tests/test_tutorial/test_encoder/__init__.py`, "");
		await Bun.write(
			`${cwd}/tests/test_tutorial/test_encoder/test_tutorial001.py`,
			"def test_existing():\n    pass\n",
		);

		const result = await runExampleScript({
			cwd,
			previousCwd,
			nodeId: "materializeGapReport",
			scriptFileName: "materialize-gap-report.js",
			scriptDir: `${TEST_GENERATION_HARDENING_DIR}/scripts`,
			writes: ["/gaps"],
			initialState: {
				gaps: {
					status: "ready",
					summary:
						"Pytest is installed and the frozen validation command starts, but it exits during collection because the declared tutorial target tests/test_tutorial/test_encoder.py is absent.",
					validation: {
						startable: true,
						command:
							"python -m pytest tests/test_jsonable_encoder.py tests/test_tutorial/test_encoder.py tests/test_response_model_as_return_annotation.py",
						status:
							"started; pytest available; failed during path collection because one declared test file is missing",
						exitCode: 4,
						stderr:
							"ERROR: file or directory not found: tests/test_tutorial/test_encoder.py\ncollected 0 items\nno tests ran",
					},
					filesLikelyToNeedTestChanges: [
						{
							path: "tests/test_tutorial/test_encoder.py",
							reason: "Create the missing frozen-command tutorial target.",
						},
					],
					smallestUsefulTestAdditions: [
						{
							priority: "P1",
							file: "tests/test_tutorial/test_encoder.py",
							addition: "Add a focused tutorial encoder regression test at the declared validation target.",
						},
					],
				},
			},
		});

		expect(
			result.scheduler.activations.find(activation => activation.nodeId === "materializeGapReport")?.status,
		).toBe("failed");
		const report = await Bun.file(`${cwd}/workflow-output/test-hardening-gap-report.md`).text();
		expect(report).toContain("tests/test_tutorial/test_encoder.py");
		expect(report).toContain("file or directory not found");
	});

	it("materializes test-hardening gap reports from coverage inspection activations", async () => {
		using tempDir = TempDir.createSync("@omh-test-hardening-gap-agent-handoff-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();
		const materializer = await Bun.file(`${TEST_GENERATION_HARDENING_DIR}/scripts/materialize-gap-report.js`).text();

		const result = await runExampleDefinition({
			cwd,
			previousCwd,
			definition: {
				name: "test-hardening-gap-agent-handoff",
				version: 1,
				models: { roles: {}, defaults: {} },
				nodes: [
					{
						id: "inspectCoverage",
						type: "script",
						script: {
							language: "js",
							code: [
								"return {",
								"  summary: JSON.stringify({",
								"    status: 'ready',",
								"    summary: 'CSV validation lacks malformed row coverage',",
								"    unitGaps: ['Malformed CSV row branch'],",
								"    filesLikelyToNeedTestChanges: ['tests/test_csv.py'],",
								"    validation: { startable: true, command: 'python -m pytest tests/test_csv.py' },",
								"  }),",
								"};",
							].join("\n"),
						},
					},
					{
						id: "materializeGapReport",
						type: "script",
						script: {
							language: "js",
							code: materializer,
						},
						writes: ["/gaps"],
					},
				],
				edges: [{ from: "inspectCoverage", to: "materializeGapReport" }],
			},
		});

		expect(result.scheduler.state.gaps).toMatchObject({
			summary: "CSV validation lacks malformed row coverage",
			source_node: "inspectCoverage",
			gapReportPath: "workflow-output/test-hardening-gap-report.md",
		});
		const report = await Bun.file(`${cwd}/workflow-output/test-hardening-gap-report.md`).text();
		expect(report).toContain("Malformed CSV row branch");
		expect(report).toContain("tests/test_csv.py");
	});

	it("materializes test-hardening blocked reports from coverage inspection data handoffs", async () => {
		using tempDir = TempDir.createSync("@omh-test-hardening-gap-data-handoff-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();
		const materializer = await Bun.file(`${TEST_GENERATION_HARDENING_DIR}/scripts/materialize-gap-report.js`).text();

		const result = await runExampleDefinition({
			cwd,
			previousCwd,
			definition: {
				name: "test-hardening-gap-data-handoff",
				version: 1,
				models: { roles: {}, defaults: {} },
				nodes: [
					{
						id: "inspectCoverage",
						type: "script",
						script: {
							language: "js",
							code: [
								"return {",
								"  summary: 'Structured coverage report returned in data.',",
								"  data: {",
								"    status: 'blocked',",
								"    summary: 'pytest is unavailable in this environment',",
								"    validation: {",
								"      startable: false,",
								"      command: 'python3 -m pytest tests -q',",
								"      stderr: '/usr/bin/python3: No module named pytest',",
								"    },",
								"    agentId: 'workflow-inspectCoverage-activation-2',",
								"  },",
								"};",
							].join("\n"),
						},
					},
					{
						id: "materializeGapReport",
						type: "script",
						script: {
							language: "js",
							code: materializer,
						},
						writes: ["/gaps"],
					},
				],
				edges: [{ from: "inspectCoverage", to: "materializeGapReport" }],
			},
		});

		expect(
			result.scheduler.activations.find(activation => activation.nodeId === "materializeGapReport")?.status,
		).toBe("failed");
		expect(await Bun.file(`${cwd}/workflow-output/test-hardening-gap-report.md`).text()).toContain(
			"No module named pytest",
		);
	});

	it("materializes test-hardening gap reports from coverage inspection session transcripts", async () => {
		using tempDir = TempDir.createSync("@omh-test-hardening-gap-session-handoff-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();
		const materializer = await Bun.file(`${TEST_GENERATION_HARDENING_DIR}/scripts/materialize-gap-report.js`).text();
		await Bun.write(
			`${cwd}/inspect-session.jsonl`,
			[
				JSON.stringify({
					type: "message",
					message: {
						role: "assistant",
						content: [
							{
								type: "text",
								text: JSON.stringify({
									status: "blocked",
									summary: "pytest is unavailable in this environment",
									validation: {
										startable: false,
										command: "python3 -m pytest tests -q",
										stderr: "/usr/bin/python3: No module named pytest",
									},
									unitGaps: ["Markup spans around wide glyphs"],
								}),
							},
						],
					},
				}),
				JSON.stringify({
					type: "message",
					message: {
						role: "assistant",
						content: [
							{
								type: "text",
								text: "Todo completed. The blocked structured report was already returned.",
							},
						],
					},
				}),
			].join("\n"),
		);

		const result = await runExampleDefinition({
			cwd,
			previousCwd,
			definition: {
				name: "test-hardening-gap-session-handoff",
				version: 1,
				models: { roles: {}, defaults: {} },
				nodes: [
					{
						id: "inspectCoverage",
						type: "script",
						script: {
							language: "js",
							code: [
								"return {",
								"  summary: 'Todo completed. The blocked structured report was already returned.',",
								"  data: { sessionFile: 'inspect-session.jsonl' },",
								"};",
							].join("\n"),
						},
					},
					{
						id: "materializeGapReport",
						type: "script",
						script: {
							language: "js",
							code: materializer,
						},
						writes: ["/gaps"],
					},
				],
				edges: [{ from: "inspectCoverage", to: "materializeGapReport" }],
			},
		});

		expect(
			result.scheduler.activations.find(activation => activation.nodeId === "materializeGapReport")?.status,
		).toBe("failed");
		const report = await Bun.file(`${cwd}/workflow-output/test-hardening-gap-report.md`).text();
		expect(report).toContain("Markup spans around wide glyphs");
		expect(report).toContain("No module named pytest");
	});

	it("fails test-hardening gap materialization when coverage inspection is unstructured", async () => {
		using tempDir = TempDir.createSync("@omh-test-hardening-gap-unstructured-handoff-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();
		const materializer = await Bun.file(`${TEST_GENERATION_HARDENING_DIR}/scripts/materialize-gap-report.js`).text();

		const result = await runExampleDefinition({
			cwd,
			previousCwd,
			definition: {
				name: "test-hardening-gap-unstructured-handoff",
				version: 1,
				models: { roles: {}, defaults: {} },
				nodes: [
					{
						id: "inspectCoverage",
						type: "script",
						script: {
							language: "js",
							code: "return { summary: 'Todo completed. The structured report was already returned.' };",
						},
					},
					{
						id: "materializeGapReport",
						type: "script",
						script: {
							language: "js",
							code: materializer,
						},
						writes: ["/gaps"],
					},
				],
				edges: [{ from: "inspectCoverage", to: "materializeGapReport" }],
			},
		});

		const materialize = result.scheduler.activations.find(activation => activation.nodeId === "materializeGapReport");
		expect(materialize?.status).toBe("failed");
		expect(materialize?.error).toContain("did not return a structured coverage gap report");
		expect(result.scheduler.state.gaps).toBeUndefined();
	});

	it("fails closed when test-hardening validation has an unclean baseline", async () => {
		using tempDir = TempDir.createSync("@omh-test-hardening-gap-unclean-baseline-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();

		const result = await runExampleScript({
			cwd,
			previousCwd,
			nodeId: "materializeGapReport",
			scriptFileName: "materialize-gap-report.js",
			scriptDir: `${TEST_GENERATION_HARDENING_DIR}/scripts`,
			writes: ["/gaps"],
			initialState: {
				gaps: {
					status: "ready",
					summary: "validation command started but imported the installed package instead of this checkout",
					validation: {
						startable: true,
						command: "python -m pytest tests/test_options.py -q",
						status: "started and completed with baseline test failures",
						exitCode: 1,
						stderr:
							"798 passed, 9 failed; tracebacks resolve click to site-packages/click, not src/click in this checkout.",
					},
				},
			},
		});

		expect(
			result.scheduler.activations.find(activation => activation.nodeId === "materializeGapReport")?.status,
		).toBe("failed");
		const report = await Bun.file(`${cwd}/workflow-output/test-hardening-gap-report.md`).text();
		expect(report).toContain("baseline test failures");
		expect(report).toContain("site-packages/click");
	});

	it("blocks test-hardening archives that retain unauthorized source edits", async () => {
		using tempDir = TempDir.createSync("@omh-test-hardening-source-edit-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();

		await Bun.write(`${cwd}/src.py`, "def encode(value):\n    return value\n");
		await Bun.write(`${cwd}/tests.py`, "def test_encode():\n    assert True\n");
		await Bun.write(
			`${cwd}/task.md`,
			[
				"Objective:",
				"Add focused tests for encoder behavior without changing production code.",
				"",
				"Validation Command:",
				"python -m pytest tests.py -q",
				"",
				"Allowed paths:",
				"tests.py, workflow-output/, progress.md, task.md",
			].join("\n"),
		);
		await runGit(cwd, ["init"]);
		await runGit(cwd, ["config", "user.email", "omh@example.invalid"]);
		await runGit(cwd, ["config", "user.name", "OMH Test"]);
		await runGit(cwd, ["add", "src.py", "tests.py", "task.md"]);
		await runGit(cwd, ["commit", "-m", "baseline"]);
		await Bun.write(`${cwd}/src.py`, "def encode(value):\n    return str(value)\n");
		await Bun.write(
			`${cwd}/tests.py`,
			"def test_encode():\n    assert True\n\ndef test_new_case():\n    assert True\n",
		);
		await Bun.write(`${cwd}/workflow-output/test-suite.md`, ["# Test Suite Evidence", "", "Exit code: 0"].join("\n"));
		await Bun.write(
			`${cwd}/workflow-output/test-hardening-repair-evidence.md`,
			["# Repair Evidence", "", "Coverage gap: encoder edge case.", "Changed files: tests.py, src.py"].join("\n"),
		);
		await Bun.write(
			`${cwd}/workflow-output/test-hardening-rollback.md`,
			["# Rollback", "", "Rollback notes: revert tests.py and src.py."].join("\n"),
		);

		const result = await runExampleScript({
			cwd,
			previousCwd,
			nodeId: "archiveTests",
			scriptFileName: "archive-tests.js",
			scriptDir: `${TEST_GENERATION_HARDENING_DIR}/scripts`,
			writes: ["/archive"],
			initialState: {
				suite: {
					status: "pass",
				},
			},
		});

		expect(result.scheduler.activations.find(activation => activation.nodeId === "archiveTests")?.status).toBe(
			"failed",
		);
		expect(result.scheduler.activations.find(activation => activation.nodeId === "archiveTests")?.error).toContain(
			"unauthorized source edits",
		);
	});

	it("blocks test-hardening archive without scheduler lineage", async () => {
		using tempDir = TempDir.createSync("@omh-test-hardening-archive-lineage-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();

		await Bun.write(
			`${cwd}/task.md`,
			[
				"Objective:",
				"Archive only after real coverage, generation, suite, and review nodes.",
				"",
				"Validation Command:",
				"echo validate",
			].join("\n"),
		);
		await Bun.write(`${cwd}/workflow-output/test-suite.md`, ["# Test Suite Evidence", "", "Exit code: 0"].join("\n"));
		await Bun.write(`${cwd}/workflow-output/test-hardening-repair-evidence.md`, "# Repair Evidence\n");
		await Bun.write(`${cwd}/workflow-output/test-hardening-rollback.md`, "# Rollback\n");
		await runGit(cwd, ["init"]);
		await runGit(cwd, ["config", "user.email", "omh@example.invalid"]);
		await runGit(cwd, ["config", "user.name", "OMH Test"]);
		await runGit(cwd, ["add", "task.md"]);
		await runGit(cwd, ["commit", "-m", "baseline"]);

		const result = await runExampleScript({
			cwd,
			previousCwd,
			nodeId: "archiveTests",
			scriptFileName: "archive-tests.js",
			scriptDir: `${TEST_GENERATION_HARDENING_DIR}/scripts`,
			writes: ["/archive"],
			initialState: {
				suite: {
					status: "pass",
				},
				review: "finish",
			},
		});

		const activation = result.scheduler.activations.find(item => item.nodeId === "archiveTests");
		expect(activation?.status).toBe("failed");
		expect(activation?.error).toContain("missing scheduler lineage");
		expect(activation?.error).toContain("inspectCoverage");
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

	it("keeps refactor migration finish gates tied to structured validation state", async () => {
		const reviewPrompt = await Bun.file(
			`${import.meta.dir}/../../../examples/workflow/experimental/refactor-migration-plan/refactor-migration-plan/prompts/review.md`,
		).text();
		const cleanupPrompt = await Bun.file(
			`${import.meta.dir}/../../../examples/workflow/experimental/refactor-migration-plan/refactor-migration-plan/prompts/cleanup.md`,
		).text();

		expect(reviewPrompt).toMatch(
			/Treat the structured `Validation` object above as the canonical validation\s+state\./u,
		);
		expect(reviewPrompt).toContain("Do not return `finish` when `validation.status` is not `pass`");
		expect(cleanupPrompt).toContain("Do not overwrite `workflow-output/refactor-migration-validation.md`");
		expect(cleanupPrompt).toMatch(/request a `continue` review so the\s+program validation node can rerun/u);
	});

	it("binds refactor migration review context before reviewer decisions", async () => {
		const artifact = await loadWorkflowArtifact(
			`${import.meta.dir}/../../../examples/workflow/experimental/refactor-migration-plan/refactor-migration-plan.omhflow`,
		);
		const nodes = new Map(artifact.definition.nodes.map(node => [node.id, node]));
		const reviewNode = nodes.get("migrationReview");

		expect(nodes.get("prepareMigrationReviewContext")?.writes).toEqual(["/reviewContext"]);
		expect(reviewNode?.reads).toContain("/reviewContext");
		if (reviewNode?.promptSource?.kind !== "template") {
			throw new Error("migrationReview must use a template prompt");
		}
		expect(reviewNode.promptSource.bindings.reviewContext).toEqual({
			kind: "state",
			path: "/reviewContext",
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
		await Bun.write(
			`${cwd}/workflow-output/migrateCallers.json`,
			`${JSON.stringify(
				{
					status: "migrated-validated",
					migrationChange: {
						rollbackPath: "Revert the private helper and restore the two direct caller sites.",
					},
				},
				null,
				2,
			)}\n`,
		);
		await Bun.write(
			`${cwd}/workflow-output/cleanupDeadPath.json`,
			`${JSON.stringify(
				{
					status: "complete-no-code-cleanup",
					rollback: "No cleanup-only code rollback is needed; use the migration rollback if needed.",
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
				"workflow-output/migrateCallers.json",
				"workflow-output/migration-caller-step.json",
				"workflow-output/cleanupDeadPath.json",
				"workflow-output/refactor-migration-cleanup.md",
			],
		});
		const archive = await Bun.file(`${cwd}/workflow-output/refactor-migration-archive.md`).text();
		expect(archive).toContain("Outcome: accepted");
		expect(archive).toContain("workflow-output/compatibility-design.md");
		expect(archive).toContain("workflow-output/migrateCallers.json");
		expect(archive).toContain("workflow-output/migration-caller-step.json");
		expect(archive).toContain("workflow-output/cleanupDeadPath.json");
		expect(archive).not.toContain("No rollback notes were present");
	});

	it("blocks refactor migration archive with out-of-scope untracked project files", async () => {
		using tempDir = TempDir.createSync("@omh-refactor-migration-untracked-scope-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();

		await Bun.write(`${cwd}/httpx/_config.py`, "baseline\n");
		await Bun.write(
			`${cwd}/task.md`,
			[
				"Objective:",
				"Refactor SSL deprecation warning construction.",
				"",
				"Validation Command:",
				"echo validate",
				"",
				"Scope Fence:",
				"Allowed paths: httpx/_config.py, tests/test_config.py, workflow-output/, progress.md, task.md, manifest-entry.json, monitor-assignment.json.",
			].join("\n"),
		);
		await runGit(cwd, ["init"]);
		await runGit(cwd, ["config", "user.email", "omh@example.invalid"]);
		await runGit(cwd, ["config", "user.name", "OMH Test"]);
		await runGit(cwd, ["add", "httpx/_config.py", "task.md"]);
		await runGit(cwd, ["commit", "-m", "baseline"]);
		await Bun.write(`${cwd}/httpx/_config.py`, "material migration\n");
		await Bun.write(`${cwd}/test`, "# TLS secrets log file, generated by OpenSSL / Python\n");
		await Bun.write(
			`${cwd}/workflow-output/refactor-migration-validation.md`,
			["# Validation", "", "Exit code: 0"].join("\n"),
		);
		await Bun.write(
			`${cwd}/workflow-output/compatibility-design.md`,
			["# Compatibility Design", "", "Rollback: restore httpx/_config.py to baseline."].join("\n"),
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

	it("materializes refactor migration review context with workspace blockers and compatibility highlights", async () => {
		using tempDir = TempDir.createSync("@omh-refactor-migration-review-context-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();

		await Bun.write(`${cwd}/httpx/_config.py`, "baseline\n");
		await Bun.write(
			`${cwd}/task.md`,
			[
				"Objective:",
				"Refactor SSL deprecation warning construction.",
				"",
				"Validation Command:",
				"echo validate",
				"",
				"Scope Fence:",
				"Allowed paths: httpx/_config.py, tests/test_config.py, workflow-output/, progress.md, task.md, manifest-entry.json, monitor-assignment.json.",
			].join("\n"),
		);
		await runGit(cwd, ["init"]);
		await runGit(cwd, ["config", "user.email", "omh@example.invalid"]);
		await runGit(cwd, ["config", "user.name", "OMH Test"]);
		await runGit(cwd, ["add", "httpx/_config.py", "task.md"]);
		await runGit(cwd, ["commit", "-m", "baseline"]);
		await Bun.write(`${cwd}/httpx/_config.py`, "material migration\n");
		await Bun.write(`${cwd}/test`, "# TLS secrets log file, generated by OpenSSL / Python\n");

		const result = await runExampleScript({
			cwd,
			previousCwd,
			nodeId: "prepareMigrationReviewContext",
			scriptFileName: "prepare-review-context.js",
			scriptDir: REFACTOR_MIGRATION_SCRIPT_DIR,
			writes: ["/reviewContext"],
			initialState: {
				task: {
					text: await Bun.file(`${cwd}/task.md`).text(),
				},
				compatibility: {
					status: "ready",
					strategy_summary:
						"Compatibility boundary: verify=str branch keeps immediate cafile/capath return before cert handling.",
					review_context: {
						compatibility: {
							only_workflow_output_evidence_changed: false,
						},
					},
					notes: [
						"Behavior: lazily import warnings and call warnings.warn(message, DeprecationWarning, stacklevel=2).",
						"Rationale: stacklevel=2 keeps warnings attributed to the public caller.",
						"Rollback notes archived in the artifact; no production source files were changed.",
					],
				},
			},
		});

		expect(result.scheduler.state.reviewContext).toMatchObject({
			workspace: {
				status: "blocked",
				blockers: ["test is an untracked project file"],
			},
		});
		const reviewContext = result.scheduler.state.reviewContext;
		if (!reviewContext || typeof reviewContext !== "object" || !("compatibilityHighlights" in reviewContext)) {
			throw new Error("reviewContext must contain compatibilityHighlights");
		}
		const compatibilityHighlights = reviewContext.compatibilityHighlights;
		if (!Array.isArray(compatibilityHighlights)) {
			throw new Error("reviewContext.compatibilityHighlights must be an array");
		}
		expect(compatibilityHighlights).toContain(
			"Behavior: lazily import warnings and call warnings.warn(message, DeprecationWarning, stacklevel=2).",
		);
		expect(compatibilityHighlights).toContain(
			"Compatibility boundary: verify=str branch keeps immediate cafile/capath return before cert handling.",
		);
		const context = await Bun.file(`${cwd}/workflow-output/refactor-migration-review-context.md`).text();
		expect(context).toContain("## Allowed Scopes");
		expect(context).toContain("- httpx/_config.py");
		expect(context).toContain("- tests/test_config.py");
		expect(context).toContain("test is an untracked project file");
		expect(context).toContain("stacklevel=2 keeps warnings attributed");
		expect(context).toContain("verify=str branch keeps immediate cafile/capath return before cert handling");
		expect(context).not.toContain("no production source files were changed");
		expect(context).not.toContain("strategy_summary");
		expect(context).not.toContain('compatibility": {');
		expect(context).not.toContain("only_workflow_output_evidence_changed");
	});

	it("materializes refactor migration review context from next-line allowed paths", async () => {
		using tempDir = TempDir.createSync("@omh-refactor-migration-review-context-next-line-scope-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();

		await Bun.write(`${cwd}/typer/core.py`, "baseline\n");
		await Bun.write(
			`${cwd}/task.md`,
			[
				"Objective:",
				"Refactor Typer help dispatch helpers.",
				"",
				"Validation Command:",
				"echo validate",
				"",
				"Allowed paths:",
				"typer/, tests/test_cli/, tests/test_completion/, docs/, workflow-output/, progress.md",
				"",
				"Stop Conditions:",
				"- Stop on empty loops.",
			].join("\n"),
		);
		await runGit(cwd, ["init"]);
		await runGit(cwd, ["config", "user.email", "omh@example.invalid"]);
		await runGit(cwd, ["config", "user.name", "OMH Test"]);
		await runGit(cwd, ["add", "typer/core.py", "task.md"]);
		await runGit(cwd, ["commit", "-m", "baseline"]);
		await Bun.write(`${cwd}/typer/core.py`, "material migration\n");

		const result = await runExampleScript({
			cwd,
			previousCwd,
			nodeId: "prepareMigrationReviewContext",
			scriptFileName: "prepare-review-context.js",
			scriptDir: REFACTOR_MIGRATION_SCRIPT_DIR,
			writes: ["/reviewContext"],
			initialState: {
				task: {
					text: await Bun.file(`${cwd}/task.md`).text(),
				},
			},
		});

		expect(result.scheduler.state.reviewContext).toMatchObject({
			workspace: {
				status: "pass",
				allowedScopes: [
					"typer/",
					"tests/test_cli/",
					"tests/test_completion/",
					"docs/",
					"workflow-output/",
					"progress.md",
				],
			},
		});
		const context = await Bun.file(`${cwd}/workflow-output/refactor-migration-review-context.md`).text();
		expect(context).toContain("## Allowed Scopes\n\n- typer/");
	});

	it("archives accepted refactor migrations with runtime activation rollback evidence", async () => {
		using tempDir = TempDir.createSync("@omh-refactor-migration-runtime-artifact-rollback-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();

		await Bun.write(`${cwd}/src.txt`, "baseline\n");
		await Bun.write(
			`${cwd}/task.md`,
			[
				"Objective:",
				"Archive a migration whose agent evidence was materialized by workflow observability.",
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
			`${cwd}/workflow-output/omh-runtime/artifacts/activation-2/1-mapDependencies.md`,
			[
				"# Dependency Map",
				"",
				"Archive risk: accepted archives must obtain rollback notes from later migration evidence.",
				"Current runtime artifacts contain no rollback text yet.",
			].join("\n"),
		);
		await Bun.write(
			`${cwd}/workflow-output/omh-runtime/artifacts/activation-5/1-migrateCallers.md`,
			[
				"# Migration",
				"",
				"Rollback: revert the extracted helper and restore the previous direct caller branches.",
			].join("\n"),
		);
		await Bun.write(
			`${cwd}/workflow-output/omh-runtime/artifacts/activation-7/1-cleanupDeadPath.md`,
			["# Cleanup", "", "Rollback notes: no cleanup-only code was changed."].join("\n"),
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
				"workflow-output/omh-runtime/artifacts/activation-5/1-migrateCallers.md",
				"workflow-output/omh-runtime/artifacts/activation-7/1-cleanupDeadPath.md",
			],
		});
		const archive = await Bun.file(`${cwd}/workflow-output/refactor-migration-archive.md`).text();
		expect(archive).not.toContain("workflow-output/omh-runtime/artifacts/activation-2/1-mapDependencies.md");
		expect(archive).toContain("workflow-output/omh-runtime/artifacts/activation-5/1-migrateCallers.md");
		expect(archive).toContain("revert the extracted helper");
	});

	it("archives refactor migrations with markdown rollback sections", async () => {
		using tempDir = TempDir.createSync("@omh-refactor-migration-markdown-rollback-section-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();

		await Bun.write(`${cwd}/typer/core.py`, "baseline\n");
		await Bun.write(
			`${cwd}/task.md`,
			[
				"Objective:",
				"Archive a migration whose rollback evidence is recorded as a markdown section.",
				"",
				"Validation Command:",
				"echo validate",
				"",
				"Allowed paths:",
				"typer/, workflow-output/, progress.md",
			].join("\n"),
		);
		await runGit(cwd, ["init"]);
		await runGit(cwd, ["config", "user.email", "omh@example.invalid"]);
		await runGit(cwd, ["config", "user.name", "OMH Test"]);
		await runGit(cwd, ["add", "typer/core.py", "task.md"]);
		await runGit(cwd, ["commit", "-m", "baseline"]);
		await Bun.write(`${cwd}/typer/core.py`, "material migration\n");
		await Bun.write(
			`${cwd}/workflow-output/refactor-migration-validation.md`,
			["# Validation", "", "Exit code: 0"].join("\n"),
		);
		await Bun.write(
			`${cwd}/workflow-output/refactor-migration-implementation.md`,
			[
				"# Refactor Migration Implementation",
				"",
				"## Rollback Notes",
				"",
				"To roll back this migration step, revert `typer/core.py` and remove this implementation note.",
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
				},
			},
		});

		expect(result.scheduler.state.archive).toMatchObject({
			status: "accepted",
			rollbackEvidenceFiles: ["workflow-output/refactor-migration-implementation.md"],
		});
		const archive = await Bun.file(`${cwd}/workflow-output/refactor-migration-archive.md`).text();
		expect(archive).toContain("workflow-output/refactor-migration-implementation.md");
		expect(archive).toContain("revert `typer/core.py`");
	});

	it("blocks accepted refactor migrations with only non-actionable rollback mentions", async () => {
		using tempDir = TempDir.createSync("@omh-refactor-migration-rollback-risk-only-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();

		await Bun.write(`${cwd}/src.txt`, "baseline\n");
		await Bun.write(
			`${cwd}/task.md`,
			[
				"Objective:",
				"Reject archive evidence that only talks about rollback requirements.",
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
			`${cwd}/workflow-output/omh-runtime/artifacts/activation-2/1-mapDependencies.md`,
			[
				"# Dependency Map",
				"",
				"Archive materiality check can hide real changes if exclusions are wrong.",
				"Current runtime artifacts observed contain activation state but no rollback text yet.",
				"Later accepted archive must obtain rollback notes from migration or cleanup evidence.",
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
				},
			},
		});

		expect(result.scheduler.activations.find(activation => activation.nodeId === "archiveMigration")?.status).toBe(
			"failed",
		);
	});

	it("blocks accepted refactor migrations when runtime evidence declares rollback is not actionable", async () => {
		using tempDir = TempDir.createSync("@omh-refactor-migration-rollback-self-blocking-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();

		await Bun.write(`${cwd}/src.txt`, "baseline\n");
		await Bun.write(
			`${cwd}/task.md`,
			[
				"Objective:",
				"Reject runtime evidence that contains rollback notes but says they are not actionable.",
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
			`${cwd}/workflow-output/omh-runtime/artifacts/activation-8/1-migrationReview.md`,
			`${JSON.stringify(
				{
					archive_and_evidence_gate: {
						current_runtime_evidence:
							"Completed workflow activations exist, but they contain no actionable rollback instruction.",
						archive_decision_rule:
							"Validation can pass, but archive acceptance must remain blocked until live actionable rollback evidence exists.",
					},
					rollback_notes: [
						"Rollback evidence for archive purposes must cite a live activation that issued the actionable instruction.",
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

		expect(result.scheduler.activations.find(activation => activation.nodeId === "archiveMigration")?.status).toBe(
			"failed",
		);
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

	it("accepts Markdown headings in KDA task contracts", async () => {
		using tempDir = TempDir.createSync("@omh-kda-humanize-markdown-contract-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();

		await Bun.write(
			`${cwd}/task.md`,
			[
				"# Objective",
				"Evaluate a candidate improvement on a real project.",
				"",
				"# Acceptance Criteria",
				"- Produce a reviewable project change or terminal rejection evidence.",
				"",
				"# Validation Command",
				"echo validate",
				"",
				"# Stop Conditions",
				"Stop when validation cannot run.",
				"",
				"# Rollback Plan",
				"Revert the candidate patch.",
			].join("\n"),
		);

		const result = await runExampleScript({
			cwd,
			previousCwd,
			nodeId: "loadTaskContract",
			scriptFileName: "load-task-contract.js",
			scriptDir: KDA_HUMANIZE_SCRIPT_DIR,
			writes: ["/taskContract", "/kda/runtime"],
		});

		expect(result.scheduler.activations.find(activation => activation.nodeId === "loadTaskContract")?.status).toBe(
			"completed",
		);
		expect(result.scheduler.state.taskContract).toContain("# Rollback Plan");
	});

	it("does not require completed validation evidence before Humanize accepts an executable KDA plan", async () => {
		const prompt = await Bun.file(`${KDA_HUMANIZE_SUBFLOW_DIR}/prompts/plan-compliance.md`).text();

		expect(prompt).toMatch(/does not\s+need completed validation evidence before implementation/u);
		expect(prompt).toContain("concrete validation plan");
	});

	it("treats nested Humanize terminal rejection as a stop handoff", async () => {
		const prompt = await Bun.file(`${KDA_HUMANIZE_SUBFLOW_DIR}/prompts/implementation-review.md`).text();

		expect(prompt).toContain("completed_rejected");
		expect(prompt).toContain("promotion_decision");
		expect(prompt).toMatch(/terminal rejection[\s\S]+`STOP`/u);
	});

	it("lets KDA validation reject terminal candidates without retrying forever", async () => {
		const artifact = await loadWorkflowArtifact(
			`${import.meta.dir}/../../../examples/workflow/experimental/kda-humanize/kda-humanize.omhflow`,
		);
		const validationNode = artifact.definition.nodes.find(node => node.id === "validateCandidate");
		const retryEdge = artifact.definition.edges.find(
			edge => edge.from === "validateCandidate" && edge.to === "implementCandidate",
		);

		expect(validationNode).toMatchObject({
			gates: ["revise", "promote", "reject"],
		});
		expect(retryEdge?.condition?.source).toBe('outputs.validateCandidate.verdict == "revise"');
	});

	it("records KDA rejection evidence as terminal evidence", async () => {
		using tempDir = TempDir.createSync("@omh-kda-rejection-evidence-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();
		const recordEvidenceCode = await Bun.file(
			`${import.meta.dir}/../../../examples/workflow/experimental/kda-humanize/kda-humanize/scripts/record-evidence.js`,
		).text();
		const definition: WorkflowDefinition = {
			name: "kda-rejection-evidence-test",
			version: 1,
			models: { roles: {}, defaults: {} },
			nodes: [
				{
					id: "validateCandidate",
					type: "script",
					script: {
						language: "js",
						code: [
							"return {",
							"  summary: 'validation rejected terminal fallback candidate',",
							"  data: { verdict: 'reject', reason: 'validation cannot start' },",
							"};",
						].join("\n"),
					},
					writes: ["/validationContext"],
				},
				{
					id: "recordEvidence",
					type: "script",
					script: {
						language: "js",
						code: recordEvidenceCode,
					},
					writes: ["/evidence"],
				},
			],
			edges: [{ from: "validateCandidate", to: "recordEvidence" }],
		};

		const result = await runExampleDefinition({
			cwd,
			previousCwd,
			definition,
			initialState: {
				taskContract: [
					"Objective:",
					"Evaluate a candidate and reject it when validation cannot start.",
					"",
					"Metric:",
					"contract validation startability",
					"",
					"Rollback Plan:",
					"remove workflow evidence only",
				].join("\n"),
				plan: "evaluate candidate, reject when validation cannot start",
				finalizeSummary: {
					status: "stopped",
					verdict: "STOP",
					summary: "nested Humanize terminal rejection",
				},
				candidate: {
					status: "completed_rejected",
					promotion_decision: "rejected",
					reason: "validation cannot start",
				},
			},
		});

		expect(result.scheduler.state.evidence).toMatchObject({
			status: "recorded-prompt-summary",
			validationVerdict: "reject",
		});
		expect(await Bun.file(`${cwd}/workflow-output/kda-evidence.md`).text()).toContain("- Verdict: reject");
	});

	it("summarizes the implementation round rather than the intervening diff guard", async () => {
		using tempDir = TempDir.createSync("@omh-humanize-rlcr-round-summary-source-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();
		const writeRoundSummaryCode = await Bun.file(
			`${import.meta.dir}/../../../examples/workflow/experimental/humanize-rlcr/humanize-rlcr/scripts/write-round-summary.js`,
		).text();
		const definition: WorkflowDefinition = {
			name: "humanize-rlcr-summary-source-test",
			version: 1,
			models: { roles: {}, defaults: {} },
			nodes: [
				{
					id: "implementRound",
					type: "script",
					script: {
						language: "js",
						code: [
							"return {",
							"  summary: 'implementation round completed with durable evidence',",
							"  data: {",
							"    status: 'complete',",
							"    changed_files: ['fastapi/encoders.py'],",
							"    verification: ['94 passed'],",
							"    acceptance_evidence: ['custom encoder behavior preserved'],",
							"  },",
							"};",
						].join("\n"),
					},
					writes: ["/humanize"],
				},
				{
					id: "diffDisciplineGuard",
					type: "script",
					script: {
						language: "js",
						code: "return { summary: 'diff discipline guard passed: 2 files, 30 lines', data: { verdict: 'PASS' } };",
					},
					writes: ["/humanize"],
				},
				{
					id: "writeRoundSummary",
					type: "script",
					script: {
						language: "js",
						code: writeRoundSummaryCode,
					},
					writes: ["/humanize"],
				},
			],
			edges: [
				{ from: "implementRound", to: "diffDisciplineGuard" },
				{ from: "diffDisciplineGuard", to: "writeRoundSummary" },
			],
		};

		await runExampleDefinition({
			cwd,
			previousCwd,
			definition,
			initialState: {
				humanize: {
					operatorGate: {
						recordedAtMs: Date.now(),
					},
					ledger: {
						currentRound: 0,
						rounds: [],
					},
				},
			},
		});

		const summary = await Bun.file(`${cwd}/workflow-output/round-1-summary.json`).json();
		expect(summary.entry.implementationSummary).toBe("implementation round completed with durable evidence");
		expect(summary.entry.evidence).toMatchObject({
			status: "complete",
			changedFiles: "fastapi/encoders.py",
			verification: "94 passed",
			acceptanceDelta: "custom encoder behavior preserved",
		});
		expect(summary.entry.implementationActivationIds).toEqual(["activation-1"]);
	});

	it("accepts uppercase TASK.md as the Humanize RLCR task contract", async () => {
		using tempDir = TempDir.createSync("@omh-humanize-rlcr-uppercase-contract-");
		const cwd = tempDir.path();
		const previousCwd = process.cwd();
		const scriptDir = `${import.meta.dir}/../../../examples/workflow/experimental/humanize-rlcr/humanize-rlcr/scripts`;
		await Bun.write(
			`${cwd}/TASK.md`,
			["Implement malformed JSON diagnostics.", "", "Acceptance:", "- invalid JSON returns a diagnostic."].join(
				"\n",
			),
		);
		const definition = await singleScriptDefinitionFrom({
			nodeId: "planCompliancePrecheck",
			scriptFileName: "plan-compliance-precheck.js",
			scriptDir,
			writes: ["/humanize"],
		});

		const result = await runExampleDefinition({
			cwd,
			previousCwd,
			definition,
		});

		expect(result.scheduler.state.humanize).toMatchObject({
			precheck: {
				status: "ready-for-human-gate",
				taskSource: "TASK.md",
				taskPreview: expect.stringContaining("malformed JSON diagnostics"),
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

function expectRecord(value: unknown, name: string): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${name} must be an object`);
	}
	return value as Record<string, unknown>;
}

async function initializeCleanGitRepo(cwd: string): Promise<void> {
	await runGit(cwd, ["init"]);
	await runGit(cwd, ["config", "user.email", "omh@example.invalid"]);
	await runGit(cwd, ["config", "user.name", "OMH Test"]);
	await Bun.write(`${cwd}/README.md`, "test repo\n");
	await runGit(cwd, ["add", "README.md"]);
	await runGit(cwd, ["commit", "-m", "init"]);
}

async function directoryEntriesOrEmpty(directoryPath: string): Promise<string[]> {
	try {
		return await fs.readdir(directoryPath);
	} catch (error) {
		if (isEnoent(error)) return [];
		throw error;
	}
}

async function findRelativeFiles(rootPath: string, suffix: string): Promise<string[]> {
	const results: string[] = [];
	await collectRelativeFiles(rootPath, "", suffix, results);
	return results.sort();
}

async function collectRelativeFiles(
	rootPath: string,
	relativePath: string,
	suffix: string,
	results: string[],
): Promise<void> {
	const directoryPath = relativePath === "" ? rootPath : `${rootPath}/${relativePath}`;
	let entries: DirectoryEntry[];
	try {
		entries = await fs.readdir(directoryPath, { withFileTypes: true });
	} catch (error) {
		if (isEnoent(error)) return;
		throw error;
	}
	for (const entry of entries) {
		const entryRelativePath = relativePath === "" ? entry.name : `${relativePath}/${entry.name}`;
		if (entry.isDirectory()) {
			await collectRelativeFiles(rootPath, entryRelativePath, suffix, results);
			continue;
		}
		if (entry.isFile() && entryRelativePath.endsWith(suffix)) {
			results.push(entryRelativePath);
		}
	}
}
