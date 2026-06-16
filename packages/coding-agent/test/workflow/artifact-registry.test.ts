import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	getBuiltinWorkflowRoot,
	installWorkflowArtifact,
	listWorkflowFlowSpecs,
	resolveWorkflowFlowSpec,
	uninstallWorkflowArtifact,
} from "../../src/workflow/artifact-registry";
import { freezeWorkflowArtifact } from "../../src/workflow/freeze";
import { loadWorkflowArtifact } from "../../src/workflow/package-loader";
import { DEFAULT_WORKFLOW_MAX_PROMPT_BYTES } from "../../src/workflow/prompt-source";
import { reconstructWorkflowRuns, type WorkflowRunStoreHost } from "../../src/workflow/run-store";
import { runWorkflow } from "../../src/workflow/runner";
import { workflowScriptEnvironment } from "../../src/workflow/script-runtime-env";
import {
	createSessionWorkflowRuntimeHost,
	type WorkflowScriptEvalRequest,
	type WorkflowScriptEvalResult,
	type WorkflowShellScriptRequest,
} from "../../src/workflow/session-runtime";

const tempDirs: string[] = [];

interface CapturedEntry {
	type: "custom";
	customType: string;
	data?: unknown;
}

async function createTempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-workflow-registry-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("workflow artifact registry", () => {
	it("resolves and freezes only bundled practical workflow artifacts by name", async () => {
		const expected = ["humanize-rlcr", "kda-humanize", "parallel-implementation-review", "agent-build-review-loop"];
		const listed = await listWorkflowFlowSpecs({ cwd: process.cwd(), flowDirs: [] });

		expect(listed.map(spec => spec.name)).toEqual([...expected].sort());

		for (const name of expected) {
			const spec = await resolveWorkflowFlowSpec(name, { cwd: process.cwd(), flowDirs: [] });

			expect(spec).toMatchObject({
				kind: "named",
				name,
				source: "builtin",
			});
			expect(spec.path).toBe(path.join(getBuiltinWorkflowRoot(), name, `${name}.omhflow`));
			const freeze = await freezeWorkflowArtifact(await loadWorkflowArtifact(spec.path));
			expect(freeze).toMatchObject({
				definition: { name },
			});
			expect(
				freeze.definition.nodes.some(
					node => node.type === "agent" || node.type === "review" || node.type === "human",
				),
			).toBe(true);
			const reviewNodes = freeze.definition.nodes.filter(node => node.type === "review");
			if (reviewNodes.length > 0) {
				expect(freeze.definition.capabilities?.agents ?? []).toContain("reviewer");
			}
			for (const node of reviewNodes) {
				expect(node.agent).toBe("reviewer");
			}
			expect(freeze.resourceSnapshots.some(resource => resource.path.startsWith("seed/"))).toBe(false);
		}
	});

	it("keeps demo and primitive workflow artifacts out of named practical built-in resolution", async () => {
		const retiredNames = [
			"branch-conditional",
			"loop-until-done",
			"parallel-join",
			"human-interactive-dev",
			"recflow-audit-events-cockpit",
			"recflow-lab-audit-events-demo",
			"kda-humanize-reference",
			"parallel-weak-implementation",
		];
		const listedNames = (await listWorkflowFlowSpecs({ cwd: process.cwd(), flowDirs: [] })).map(spec => spec.name);

		for (const name of retiredNames) {
			expect(listedNames).not.toContain(name);
			await expect(resolveWorkflowFlowSpec(name, { cwd: process.cwd(), flowDirs: [] })).rejects.toThrow(
				`workflow flow "${name}" was not found`,
			);
		}
	});

	it("runs explicit control-flow primitive example artifacts in a generic workspace", async () => {
		const demoRoot = path.join(path.dirname(getBuiltinWorkflowRoot()), "workflow-demos");
		for (const name of ["branch-conditional", "loop-until-done", "parallel-join"]) {
			const spec = await resolveWorkflowFlowSpec(path.join(demoRoot, name, `${name}.omhflow`), {
				cwd: process.cwd(),
				flowDirs: [],
			});
			const artifact = await loadWorkflowArtifact(spec.path);
			const freeze = await freezeWorkflowArtifact(artifact);
			const taskDir = await createTempDir();
			await Bun.write(
				path.join(taskDir, "task.md"),
				[
					"# Primitive built-in smoke",
					"",
					"## Objective",
					"",
					`Run ${name} in a generic workspace with no project-specific binaries.`,
				].join("\n"),
			);
			const host = createRunHost();

			const result = await runWorkflow({
				host,
				definition: freeze.definition,
				runId: `${name}-generic`,
				startNodeId: freeze.definition.nodes[0]?.id ?? "",
				runtimeHost: createSessionWorkflowRuntimeHost({
					cwd: taskDir,
					runEvalScript: request => runBunWorkflowScript(taskDir, request),
				}),
				packageRoot: artifact.resourceDir,
				frozenResources: freeze.resourceSnapshots,
				maxActivations: 16,
			});

			expect(result.scheduler.activations.every(activation => activation.status === "completed")).toBe(true);
			expect(result.scheduler.frontierNodeIds).toEqual([]);
			expect(reconstructWorkflowRuns(host.getBranch())[0]?.state).toBeDefined();
			await expect(Bun.file(path.join(taskDir, "workflow-output", "task-report.md")).text()).resolves.toContain(
				"Status: passed",
			);
		}
	});

	it("runs bundled Humanize RLCR with durable ledger across reviewer-controlled rounds", async () => {
		const spec = await resolveWorkflowFlowSpec("humanize-rlcr", { cwd: process.cwd(), flowDirs: [] });
		const artifact = await loadWorkflowArtifact(spec.path);
		const freeze = await freezeWorkflowArtifact(artifact);
		const taskDir = await createTempDir();
		await Bun.write(
			path.join(taskDir, "task.md"),
			[
				"# Long-running RLCR ledger smoke",
				"",
				"Goal: make a documented behavior change with verification evidence.",
				"Acceptance: implementation evidence, negative-test thinking, review cleanup, and final alignment.",
			].join("\n"),
		);
		const host = createRunHost();
		let implementationRound = 0;
		let summaryReviewRound = 0;
		let humanQuestion = "";
		const summaryReviewAssignments: string[] = [];

		const result = await runWorkflow({
			host,
			definition: freeze.definition,
			runId: "humanize-ledger",
			startNodeId: "planCompliancePrecheck",
			runtimeHost: createSessionWorkflowRuntimeHost({
				cwd: taskDir,
				runEvalScript: request => runBunFunctionWorkflowScript(taskDir, request),
				runHumanInput: async request => {
					humanQuestion = request.question;
					return {
						response: "proceed: this is a bounded smoke validation for the local workflow contract.",
					};
				},
				runAgentTask: async request => {
					if (request.nodeId === "implementRound") {
						implementationRound++;
						return {
							exitCode: 0,
							output: `round ${implementationRound} implementation evidence with verification notes`,
						};
					}
					if (request.nodeId === "codexSummaryReview") {
						summaryReviewRound++;
						summaryReviewAssignments.push(request.task.assignment);
						return {
							exitCode: 0,
							output:
								summaryReviewRound === 1
									? "CONTINUE\nNeed negative-test evidence before code review."
									: "COMPLETE\nAcceptance evidence and negative-test thinking are present.",
						};
					}
					if (request.nodeId === "fixReviewIssues") {
						return { exitCode: 0, output: "fixed all blocking code-review issues" };
					}
					if (request.nodeId === "codexCodeReview") {
						return { exitCode: 0, output: "CLEAN\nNo blocking review issues remain." };
					}
					if (request.nodeId === "finalAlignmentCheck") {
						return { exitCode: 0, output: "finish\nFinal alignment passes." };
					}
					return { exitCode: 0, output: `completed ${request.nodeId}` };
				},
			}),
			packageRoot: artifact.resourceDir,
			frozenResources: freeze.resourceSnapshots,
			maxActivations: 24,
		});

		const nodeIds = result.scheduler.activations.map(activation => activation.nodeId);
		expect(humanQuestion).toContain("eight hours is the minimum");
		expect(nodeIds.filter(nodeId => nodeId === "recordOperatorGate")).toHaveLength(1);
		expect(nodeIds.filter(nodeId => nodeId === "implementRound")).toHaveLength(2);
		expect(nodeIds.filter(nodeId => nodeId === "writeRoundSummary")).toHaveLength(2);
		expect(result.scheduler.activations.every(activation => activation.status === "completed")).toBe(true);
		expect(result.scheduler.frontierNodeIds).toEqual([]);
		const humanize = expectRecord(result.scheduler.state.humanize, "humanize state");
		const operatorGate = expectRecord(humanize.operatorGate, "humanize operator gate");
		expect(operatorGate.decision).toBe("proceed");
		expect(operatorGate.longRunningRequested).toBe(false);
		expect(operatorGate.minimumRuntimeMs).toBe(28_800_000);
		expect(operatorGate.maximumRuntimeMs).toBe(432_000_000);
		expect(operatorGate.minimumSatisfied).toBe(true);
		const runtime = expectRecord(humanize.runtime, "humanize runtime");
		const longRunning = expectRecord(runtime.longRunning, "humanize long-running runtime");
		expect(longRunning.minimumSatisfied).toBe(true);
		const latestSummaryReviewAssignment = summaryReviewAssignments.at(-1) ?? "";
		expect(latestSummaryReviewAssignment).toContain('"minimumRuntimeMs":28800000');
		expect(latestSummaryReviewAssignment).toContain('"minimumSatisfied":true');
		const ledger = expectRecord(humanize.ledger, "humanize ledger");
		const rounds = expectArray(ledger.rounds, "humanize ledger rounds");
		expect(ledger.currentRound).toBe(2);
		expect(rounds).toHaveLength(2);
		expect(expectRecord(humanize.reviewPhase, "humanize review phase").enteredAfterRound).toBe(2);
		expect(expectRecord(humanize.final, "humanize final").rounds).toBe(2);
	});

	it("carries bundled Humanize RLCR implementation yield evidence into summary review prompts", async () => {
		const spec = await resolveWorkflowFlowSpec("humanize-rlcr", { cwd: process.cwd(), flowDirs: [] });
		const artifact = await loadWorkflowArtifact(spec.path);
		const freeze = await freezeWorkflowArtifact(artifact);
		const taskDir = await createTempDir();
		await Bun.write(
			path.join(taskDir, "task.md"),
			[
				"# Humanize RLCR evidence propagation",
				"",
				"Goal: implement a change and let summary review judge concrete verification evidence.",
				"Acceptance: the reviewer sees the observed command result instead of evidence placeholders.",
			].join("\n"),
		);
		const host = createRunHost();
		const summaryReviewAssignments: string[] = [];

		const result = await runWorkflow({
			host,
			definition: freeze.definition,
			runId: "humanize-yield-evidence",
			startNodeId: "planCompliancePrecheck",
			runtimeHost: createSessionWorkflowRuntimeHost({
				cwd: taskDir,
				runEvalScript: request => runBunFunctionWorkflowScript(taskDir, request),
				runHumanInput: async () => ({
					response: "proceed: this is a bounded smoke validation for evidence propagation.",
				}),
				runAgentTask: async request => {
					if (request.nodeId === "implementRound") {
						return {
							exitCode: 0,
							output: JSON.stringify({
								status: "implementation_verified_not_long_running_final",
								summary: "implemented evaluator and tests",
								changedFiles: ["src/evaluator.ts", "test/evaluator.test.ts"],
								acceptanceEvidence: ["Post-fix focused test passed: bun test"],
								negativeRegressionScenarios: ["division by zero throws", "invalid parser state is reported"],
							}),
							data: {
								status: "implementation_verified_not_long_running_final",
								summary: "implemented evaluator and tests",
								changedFiles: ["src/evaluator.ts", "test/evaluator.test.ts"],
								acceptanceEvidence: ["Post-fix focused test passed: bun test"],
								negativeRegressionScenarios: ["division by zero throws", "invalid parser state is reported"],
							},
						};
					}
					if (request.nodeId === "codexSummaryReview") {
						summaryReviewAssignments.push(request.task.assignment);
						return {
							exitCode: 0,
							output: "COMPLETE\nObserved verification and negative-test evidence are present.",
						};
					}
					return { exitCode: 0, output: `completed ${request.nodeId}` };
				},
			}),
			packageRoot: artifact.resourceDir,
			frozenResources: freeze.resourceSnapshots,
			maxActivations: 7,
		});

		expect(result.scheduler.activations.find(activation => activation.status === "failed")?.error).toBeUndefined();
		expect(summaryReviewAssignments).toHaveLength(1);
		const summaryReviewAssignment = summaryReviewAssignments[0] ?? "";
		expect(summaryReviewAssignment).toContain("src/evaluator.ts");
		expect(summaryReviewAssignment).toContain("Post-fix focused test passed: bun test");
		expect(summaryReviewAssignment).toContain("division by zero throws");
		expect(summaryReviewAssignment).toContain("invalid parser state is reported");
		expect(summaryReviewAssignment).not.toContain('"changedFiles":"not-reported"');
		expect(summaryReviewAssignment).not.toContain('"verification":"required-before-complete"');
		expect(summaryReviewAssignment).not.toContain('"negativeTests":"required-before-complete"');
		expect(summaryReviewAssignment).not.toContain('"acceptanceDelta":"reviewer-must-check"');
	});

	it("routes bundled Humanize RLCR through a hold loop after implementation completes before the long-running gate is satisfied", async () => {
		const spec = await resolveWorkflowFlowSpec("humanize-rlcr", { cwd: process.cwd(), flowDirs: [] });
		const artifact = await loadWorkflowArtifact(spec.path);
		const freeze = await freezeWorkflowArtifact(artifact);
		const taskDir = await createTempDir();
		await Bun.write(
			path.join(taskDir, "task.md"),
			[
				"# Long-running RLCR gate smoke",
				"",
				"Goal: keep the workflow active when the operator requested long-running evidence.",
				"Acceptance: reviewer COMPLETE cannot exit the implementation loop before the runtime floor is met.",
			].join("\n"),
		);
		const host = createRunHost();
		let implementationRound = 0;
		const summaryReviewAssignments: string[] = [];
		const previousHoldSeconds = Bun.env.OMH_LONG_RUNNING_HOLD_SECONDS;
		Bun.env.OMH_LONG_RUNNING_HOLD_SECONDS = "0";

		try {
			const result = await runWorkflow({
				host,
				definition: freeze.definition,
				runId: "humanize-long-running-gate",
				startNodeId: "planCompliancePrecheck",
				runtimeHost: createSessionWorkflowRuntimeHost({
					cwd: taskDir,
					runEvalScript: request => runBunFunctionWorkflowScript(taskDir, request),
					runShellScript: request => runShellWorkflowScript(taskDir, request),
					runHumanInput: async () => ({
						response:
							"proceed: this is intended as long-running validation with an eight hour minimum and five day maximum.",
					}),
					runAgentTask: async request => {
						if (request.nodeId === "implementRound") {
							implementationRound++;
							return {
								exitCode: 0,
								output: `round ${implementationRound} implementation evidence with verification notes`,
							};
						}
						if (request.nodeId === "codexSummaryReview") {
							summaryReviewAssignments.push(request.task.assignment);
							return {
								exitCode: 0,
								output: "COMPLETE\nAcceptance evidence is present, but the runtime floor is not met.",
							};
						}
						return { exitCode: 0, output: `completed ${request.nodeId}` };
					},
				}),
				packageRoot: artifact.resourceDir,
				frozenResources: freeze.resourceSnapshots,
				maxActivations: 9,
			});

			const nodeIds = result.scheduler.activations.map(activation => activation.nodeId);
			expect(nodeIds.filter(nodeId => nodeId === "implementRound")).toHaveLength(1);
			expect(nodeIds.filter(nodeId => nodeId === "codexSummaryReview")).toHaveLength(1);
			expect(nodeIds.filter(nodeId => nodeId === "longRunningHold")).toHaveLength(1);
			expect(nodeIds.filter(nodeId => nodeId === "longRunningHoldCheck")).toHaveLength(1);
			expect(nodeIds).not.toContain("enterReviewPhase");
			expect(result.scheduler.frontierNodeIds).toEqual(["longRunningHold"]);
			const humanize = expectRecord(result.scheduler.state.humanize, "humanize state");
			const operatorGate = expectRecord(humanize.operatorGate, "humanize operator gate");
			expect(operatorGate.longRunningRequested).toBe(true);
			expect(operatorGate.minimumSatisfied).toBe(false);
			const runtime = expectRecord(humanize.runtime, "humanize runtime");
			const longRunning = expectRecord(runtime.longRunning, "humanize long-running runtime");
			expect(longRunning.minimumSatisfied).toBe(false);
			const holdCheckActivation = result.scheduler.activations.find(
				activation => activation.nodeId === "longRunningHoldCheck",
			);
			expect(holdCheckActivation?.output?.summary).toContain("elapsed");
			expect(holdCheckActivation?.output?.summary).toContain("remaining");
			const summaryReviewAssignment = summaryReviewAssignments.at(-1) ?? "";
			expect(summaryReviewAssignment).toContain('"minimumSatisfied":false');
			expect(summaryReviewAssignment).toContain(
				"The workflow routes that `COMPLETE` verdict to the hold/check loop",
			);
			expect(summaryReviewAssignment).not.toContain("do not emit `COMPLETE`");
		} finally {
			if (previousHoldSeconds === undefined) {
				delete Bun.env.OMH_LONG_RUNNING_HOLD_SECONDS;
			} else {
				Bun.env.OMH_LONG_RUNNING_HOLD_SECONDS = previousHoldSeconds;
			}
		}
	});

	it("derives bundled Humanize RLCR long-running intent from default approval and task contract", async () => {
		const spec = await resolveWorkflowFlowSpec("humanize-rlcr", { cwd: process.cwd(), flowDirs: [] });
		const artifact = await loadWorkflowArtifact(spec.path);
		const freeze = await freezeWorkflowArtifact(artifact);
		const taskDir = await createTempDir();
		await Bun.write(
			path.join(taskDir, "task.md"),
			[
				"# Long-running RLCR default approval",
				"",
				"Goal: run a realistic project-flow-task evaluation through Humanize RLCR.",
				"Acceptance: the workflow must run for at least eight hours before a COMPLETE reviewer verdict can exit.",
				"Timeout: five days.",
			].join("\n"),
		);
		const host = createRunHost();

		const result = await runWorkflow({
			host,
			definition: freeze.definition,
			runId: "humanize-default-approval-long-running",
			startNodeId: "planCompliancePrecheck",
			runtimeHost: createSessionWorkflowRuntimeHost({
				cwd: taskDir,
				runEvalScript: request => runBunFunctionWorkflowScript(taskDir, request),
				runHumanInput: async () => ({
					response: "Approve",
				}),
				runAgentTask: async request => ({
					exitCode: 0,
					output:
						request.nodeId === "codexSummaryReview"
							? "COMPLETE\nThe implementation appears aligned, but the long-running floor is not met."
							: `completed ${request.nodeId}`,
				}),
			}),
			packageRoot: artifact.resourceDir,
			frozenResources: freeze.resourceSnapshots,
			maxActivations: 7,
		});

		const humanize = expectRecord(result.scheduler.state.humanize, "humanize state");
		const operatorGate = expectRecord(humanize.operatorGate, "humanize operator gate");
		expect(operatorGate.decision).toBe("proceed");
		expect(operatorGate.longRunningRequested).toBe(true);
		expect(operatorGate.minimumSatisfied).toBe(false);
		expect(result.scheduler.frontierNodeIds).toEqual(["longRunningHold"]);
	});

	it("keeps the explicit Humanize operator decision when later instructions mention stop", async () => {
		const spec = await resolveWorkflowFlowSpec("humanize-rlcr", { cwd: process.cwd(), flowDirs: [] });
		const artifact = await loadWorkflowArtifact(spec.path);
		const freeze = await freezeWorkflowArtifact(artifact);
		const taskDir = await createTempDir();
		await Bun.write(
			path.join(taskDir, "task.md"),
			[
				"# Long-running RLCR explicit operator decision",
				"",
				"Goal: preserve the operator's explicit first decision while recording stop/checkpoint constraints.",
				"Acceptance: the workflow records proceed, not stop, when the response begins with Proceed.",
			].join("\n"),
		);
		const host = createRunHost();

		const result = await runWorkflow({
			host,
			definition: freeze.definition,
			runId: "humanize-explicit-proceed-with-stop-instructions",
			startNodeId: "planCompliancePrecheck",
			runtimeHost: createSessionWorkflowRuntimeHost({
				cwd: taskDir,
				runEvalScript: request => runBunFunctionWorkflowScript(taskDir, request),
				runHumanInput: async () => ({
					response:
						"Proceed. Preserve workflow-output evidence, stop/checkpoint behavior, and stop/quarantine if an OMH infra bug appears.",
				}),
				runAgentTask: async request => ({
					exitCode: 0,
					output: `completed ${request.nodeId}`,
				}),
			}),
			packageRoot: artifact.resourceDir,
			frozenResources: freeze.resourceSnapshots,
			maxActivations: 4,
		});

		const humanize = expectRecord(result.scheduler.state.humanize, "humanize state");
		const operatorGate = expectRecord(humanize.operatorGate, "humanize operator gate");
		expect(operatorGate.decision).toBe("proceed");
	});

	it("stops bundled Humanize RLCR before implementation when the operator gate says stop", async () => {
		const spec = await resolveWorkflowFlowSpec("humanize-rlcr", { cwd: process.cwd(), flowDirs: [] });
		const artifact = await loadWorkflowArtifact(spec.path);
		const freeze = await freezeWorkflowArtifact(artifact);
		const taskDir = await createTempDir();
		await Bun.write(
			path.join(taskDir, "task.md"),
			[
				"# Humanize RLCR operator stop",
				"",
				"Goal: verify the operator gate can stop the flow before implementation.",
			].join("\n"),
		);
		const host = createRunHost();

		const result = await runWorkflow({
			host,
			definition: freeze.definition,
			runId: "humanize-operator-stop",
			startNodeId: "planCompliancePrecheck",
			runtimeHost: createSessionWorkflowRuntimeHost({
				cwd: taskDir,
				runEvalScript: request => runBunFunctionWorkflowScript(taskDir, request),
				runHumanInput: async () => ({ response: "stop: the plan is not ready for implementation." }),
				runAgentTask: async request => ({ exitCode: 0, output: `unexpected ${request.nodeId}` }),
			}),
			packageRoot: artifact.resourceDir,
			frozenResources: freeze.resourceSnapshots,
			maxActivations: 12,
		});

		const nodeIds = result.scheduler.activations.map(activation => activation.nodeId);
		expect(nodeIds).toContain("recordOperatorGate");
		expect(nodeIds).toContain("operatorGateExit");
		expect(nodeIds).not.toContain("initializeGoalTracker");
		expect(nodeIds).not.toContain("implementRound");
		expect(result.scheduler.frontierNodeIds).toEqual([]);
		const humanize = expectRecord(result.scheduler.state.humanize, "humanize state");
		const operatorGate = expectRecord(humanize.operatorGate, "humanize operator gate");
		expect(operatorGate.decision).toBe("stop");
		const operatorExit = expectRecord(humanize.operatorExit, "humanize operator exit");
		expect(operatorExit.status).toBe("stopped-by-operator");
		expect(operatorExit.decision).toBe("stop");
	});

	it("records bundled Humanize task-contract precheck risks instead of unconditional pass", async () => {
		const spec = await resolveWorkflowFlowSpec("humanize-rlcr", { cwd: process.cwd(), flowDirs: [] });
		const artifact = await loadWorkflowArtifact(spec.path);
		const freeze = await freezeWorkflowArtifact(artifact);
		const taskDir = await createTempDir();
		await Bun.write(
			path.join(taskDir, "task.md"),
			[
				"# Humanize RLCR precheck",
				"",
				"Goal: inspect the task contract precheck.",
				"Requirement: switch branch to release-candidate before implementation.",
			].join("\n"),
		);
		const host = createRunHost();

		const result = await runWorkflow({
			host,
			definition: freeze.definition,
			runId: "humanize-precheck-risk",
			startNodeId: "planCompliancePrecheck",
			runtimeHost: createSessionWorkflowRuntimeHost({
				cwd: taskDir,
				runEvalScript: request => runBunFunctionWorkflowScript(taskDir, request),
			}),
			packageRoot: artifact.resourceDir,
			frozenResources: freeze.resourceSnapshots,
			maxActivations: 1,
		});

		expect(result.scheduler.activations.map(activation => activation.nodeId)).toEqual(["planCompliancePrecheck"]);
		expect(result.scheduler.frontierNodeIds).toEqual(["planUnderstandingQuiz"]);
		const humanize = expectRecord(result.scheduler.state.humanize, "humanize state");
		const precheck = expectRecord(humanize.precheck, "humanize precheck");
		expect(precheck.status).toBe("needs-operator-confirmation");
		expect(precheck.branchSwitchingRequested).toBe(true);
		expect(precheck.taskSource).toBe("task.md");
	});

	it("keeps bundled Humanize RLCR in a hold loop without growing implementation prompts", async () => {
		const spec = await resolveWorkflowFlowSpec("humanize-rlcr", { cwd: process.cwd(), flowDirs: [] });
		const artifact = await loadWorkflowArtifact(spec.path);
		const freeze = await freezeWorkflowArtifact(artifact);
		const taskDir = await createTempDir();
		await Bun.write(
			path.join(taskDir, "task.md"),
			[
				"# Long-running RLCR prompt budget regression",
				"",
				"Goal: keep iterating through many reviewer-controlled rounds without unbounded prompt growth.",
				"Acceptance: review prompts stay below the default workflow prompt budget while durable round counters advance.",
			].join("\n"),
		);
		const host = createRunHost();
		const promptEncoder = new TextEncoder();
		let implementationRound = 0;
		const summaryReviewPromptBytes: number[] = [];
		const previousHoldSeconds = Bun.env.OMH_LONG_RUNNING_HOLD_SECONDS;
		Bun.env.OMH_LONG_RUNNING_HOLD_SECONDS = "0";

		try {
			const result = await runWorkflow({
				host,
				definition: freeze.definition,
				runId: "humanize-long-loop-prompt-budget",
				startNodeId: "planCompliancePrecheck",
				runtimeHost: createSessionWorkflowRuntimeHost({
					cwd: taskDir,
					runEvalScript: request => runBunFunctionWorkflowScript(taskDir, request),
					runShellScript: request => runShellWorkflowScript(taskDir, request),
					runHumanInput: async () => ({
						response:
							"proceed: this is intended as long-running validation with an eight hour minimum and five day maximum.",
					}),
					runAgentTask: async request => {
						if (request.nodeId === "implementRound") {
							implementationRound++;
							return {
								exitCode: 0,
								output: [
									`round ${implementationRound} implementation evidence with verification notes`,
									`evidence payload: ${"x".repeat(1_850)}`,
								].join("\n"),
							};
						}
						if (request.nodeId === "codexSummaryReview") {
							summaryReviewPromptBytes.push(promptEncoder.encode(request.task.assignment).byteLength);
							return {
								exitCode: 0,
								output: "COMPLETE\nAcceptance evidence is present, but the long-running floor is not met.",
							};
						}
						return { exitCode: 0, output: `completed ${request.nodeId}` };
					},
				}),
				packageRoot: artifact.resourceDir,
				frozenResources: freeze.resourceSnapshots,
				maxActivations: 52,
			});

			const failed = result.scheduler.activations.filter(activation => activation.status === "failed");
			expect(failed).toEqual([]);
			const nodeIds = result.scheduler.activations.map(activation => activation.nodeId);
			expect(nodeIds.filter(nodeId => nodeId === "implementRound")).toHaveLength(1);
			expect(nodeIds.filter(nodeId => nodeId === "codexSummaryReview")).toHaveLength(1);
			expect(nodeIds.filter(nodeId => nodeId === "longRunningHold").length).toBeGreaterThan(0);
			expect(nodeIds.filter(nodeId => nodeId === "longRunningHoldCheck").length).toBeGreaterThan(0);
			expect(summaryReviewPromptBytes).toHaveLength(1);
			expect(summaryReviewPromptBytes.find(bytes => bytes > DEFAULT_WORKFLOW_MAX_PROMPT_BYTES)).toBeUndefined();
			const humanize = expectRecord(result.scheduler.state.humanize, "humanize state");
			const ledger = expectRecord(humanize.ledger, "humanize ledger");
			expect(ledger.currentRound).toBe(1);
			expect(expectNumber(ledger.archivedRoundCount, "humanize archived round count")).toBe(0);
			expect(expectArray(ledger.rounds, "humanize ledger rounds")).toHaveLength(1);
			expect(result.scheduler.frontierNodeIds).toEqual(["longRunningHoldCheck"]);
		} finally {
			if (previousHoldSeconds === undefined) {
				delete Bun.env.OMH_LONG_RUNNING_HOLD_SECONDS;
			} else {
				Bun.env.OMH_LONG_RUNNING_HOLD_SECONDS = previousHoldSeconds;
			}
		}
	});

	it("treats explicit paths as paths even when the basename matches an installed flow name", async () => {
		const dir = await createTempDir();
		const flowPath = await writeFlowArtifact(dir, "humanize-rlcr");

		const spec = await resolveWorkflowFlowSpec("./humanize-rlcr.omhflow", { cwd: dir, flowDirs: [] });

		expect(spec).toEqual({ kind: "path", input: "./humanize-rlcr.omhflow", path: flowPath });
	});

	it("keeps infrastructure usable without bundled flow artifacts when a path is supplied", async () => {
		const dir = await createTempDir();
		const missingBuiltinRoot = path.join(dir, "missing-builtins");
		const flowPath = await writeFlowArtifact(dir, "standalone-flow");

		await expect(listWorkflowFlowSpecs({ builtinRoot: missingBuiltinRoot, flowDirs: [] })).resolves.toEqual([]);
		await expect(
			resolveWorkflowFlowSpec(flowPath, { cwd: dir, builtinRoot: missingBuiltinRoot, flowDirs: [] }),
		).resolves.toEqual({ kind: "path", input: flowPath, path: flowPath });
		await expect(freezeWorkflowArtifact(await loadWorkflowArtifact(flowPath))).resolves.toMatchObject({
			definition: { name: "standalone-flow" },
		});
	});

	it("resolves OMHFLOW_DIR names from flat and nested artifact layouts", async () => {
		const flatRoot = await createTempDir();
		const nestedRoot = await createTempDir();
		const flatPath = await writeFlowArtifact(flatRoot, "flat-flow");
		const nestedPath = await writeFlowArtifact(path.join(nestedRoot, "nested-flow"), "nested-flow");

		await expect(resolveWorkflowFlowSpec("flat-flow", { cwd: process.cwd(), flowDirs: [flatRoot] })).resolves.toEqual(
			{
				kind: "named",
				input: "flat-flow",
				name: "flat-flow",
				path: flatPath,
				root: flatRoot,
				source: "omhflow-dir",
			},
		);
		await expect(
			resolveWorkflowFlowSpec("nested-flow", { cwd: process.cwd(), flowDirs: [nestedRoot] }),
		).resolves.toEqual({
			kind: "named",
			input: "nested-flow",
			name: "nested-flow",
			path: nestedPath,
			root: nestedRoot,
			source: "omhflow-dir",
		});
	});

	it("rejects ambiguous external flow names across multiple OMHFLOW_DIR roots", async () => {
		const left = await createTempDir();
		const right = await createTempDir();
		await writeFlowArtifact(path.join(left, "dupe-flow"), "dupe-flow");
		await writeFlowArtifact(path.join(right, "dupe-flow"), "dupe-flow");

		await expect(
			resolveWorkflowFlowSpec("dupe-flow", { cwd: process.cwd(), flowDirs: [left, right] }),
		).rejects.toThrow(/workflow flow "dupe-flow" is ambiguous/);
	});

	it("rejects ambiguous flow names between bundled and OMHFLOW_DIR artifacts", async () => {
		const installRoot = await createTempDir();
		await writeFlowArtifact(path.join(installRoot, "humanize-rlcr"), "humanize-rlcr");

		await expect(
			resolveWorkflowFlowSpec("humanize-rlcr", { cwd: process.cwd(), flowDirs: [installRoot] }),
		).rejects.toThrow(/workflow flow "humanize-rlcr" is ambiguous/);
	});

	it("installs, lists, and uninstalls distributable .omhflow artifacts in the target flow dir", async () => {
		const sourceRoot = await createTempDir();
		const installRoot = await createTempDir();
		const sourcePath = await writeFlowArtifact(sourceRoot, "installed-flow", {
			resourcePath: "prompts/task.md",
			resourceText: "Do the installed task.\n",
		});

		const installed = await installWorkflowArtifact(sourcePath, {
			flowDirs: [installRoot],
		});
		const listed = await listWorkflowFlowSpecs({ flowDirs: [installRoot] });
		const resolved = await resolveWorkflowFlowSpec("installed-flow", { cwd: process.cwd(), flowDirs: [installRoot] });
		const uninstall = await uninstallWorkflowArtifact("installed-flow", { flowDirs: [installRoot] });

		expect(installed).toMatchObject({
			name: "installed-flow",
			path: path.join(installRoot, "installed-flow", "installed-flow.omhflow"),
			root: installRoot,
		});
		expect(listed.map(flow => [flow.name, flow.source])).toContainEqual(["installed-flow", "omhflow-dir"]);
		expect(resolved.path).toBe(installed.path);
		expect(uninstall.path).toBe(installed.path);
		expect(await Bun.file(installed.path).exists()).toBe(false);
	});

	it("refuses to uninstall built-in flows from the user flow directory command", async () => {
		const installRoot = await createTempDir();

		await expect(uninstallWorkflowArtifact("humanize-rlcr", { flowDirs: [installRoot] })).rejects.toThrow(
			'built-in workflow flow "humanize-rlcr" cannot be uninstalled',
		);
	});
});

function createRunHost(): WorkflowRunStoreHost & { entries: CapturedEntry[] } {
	const entries: CapturedEntry[] = [];
	return {
		entries,
		appendCustomEntry: (customType, data) => {
			entries.push({ type: "custom", customType, data });
			return `entry-${entries.length}`;
		},
		getBranch: () => entries,
	};
}

async function runBunWorkflowScript(
	cwd: string,
	request: WorkflowScriptEvalRequest,
): Promise<WorkflowScriptEvalResult> {
	const scriptPath = path.join(cwd, `.workflow-${request.activationId}.js`);
	await Bun.write(scriptPath, request.code);
	const proc = Bun.spawn([process.execPath, scriptPath], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return {
		exitCode,
		output: [stdout, stderr]
			.filter(text => text.trim().length > 0)
			.join("\n")
			.trim(),
		language: request.language,
		...(exitCode === 0 ? {} : { error: stderr.trim() || stdout.trim() || `exit code ${exitCode}` }),
	};
}

async function runBunFunctionWorkflowScript(
	cwd: string,
	request: WorkflowScriptEvalRequest,
): Promise<WorkflowScriptEvalResult> {
	const scriptPath = path.join(cwd, `.workflow-${request.activationId}.js`);
	await Bun.write(
		scriptPath,
		[
			"(async () => {",
			request.code,
			"})()",
			"  .then(value => {",
			"    if (value !== undefined) console.log(JSON.stringify(value));",
			"  })",
			"  .catch(error => {",
			"    console.error(error instanceof Error ? error.stack ?? error.message : String(error));",
			"    process.exit(1);",
			"  });",
		].join("\n"),
	);
	const proc = Bun.spawn([process.execPath, scriptPath], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return {
		exitCode,
		output: [stdout, stderr]
			.filter(text => text.trim().length > 0)
			.join("\n")
			.trim(),
		language: request.language,
		...(exitCode === 0 ? {} : { error: stderr.trim() || stdout.trim() || `exit code ${exitCode}` }),
	};
}

async function runShellWorkflowScript(
	cwd: string,
	request: WorkflowShellScriptRequest,
): Promise<WorkflowScriptEvalResult> {
	const proc = Bun.spawn(["sh", "-c", request.code], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: workflowScriptEnvironment(request, Bun.env),
		signal: request.signal,
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return {
		exitCode,
		output: [stdout, stderr]
			.filter(text => text.trim().length > 0)
			.join("\n")
			.trim(),
		language: request.language,
		...(exitCode === 0 ? {} : { error: stderr.trim() || stdout.trim() || `exit code ${exitCode}` }),
	};
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
	if (value !== null && typeof value === "object" && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	throw new Error(`Expected ${label} to be a record`);
}

function expectArray(value: unknown, label: string): unknown[] {
	if (Array.isArray(value)) return value;
	throw new Error(`Expected ${label} to be an array`);
}

function expectNumber(value: unknown, label: string): number {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	throw new Error(`Expected ${label} to be a finite number`);
}

async function writeFlowArtifact(
	root: string,
	name: string,
	resource?: { resourcePath: string; resourceText: string },
): Promise<string> {
	await fs.mkdir(path.join(root, name), { recursive: true });
	if (resource !== undefined) {
		await Bun.write(path.join(root, name, resource.resourcePath), resource.resourceText);
	}
	const resources =
		resource === undefined
			? ""
			: `resources:
  - path: ${resource.resourcePath}
    kind: prompt
`;
	const flowPath = path.join(root, `${name}.omhflow`);
	await Bun.write(
		flowPath,
		`---
name: ${name}
version: 1
schema: omhflow/v1
checkpoint:
  stopDeadlineMs: 50
changePolicy:
  agentsCanPropose: true
  humansCanApprove: true
---

\`\`\`yaml workflow
${resources}nodes:
  build:
    type: script
    script:
      inline: |
        return { summary: "built ${name}" };
edges: []
\`\`\`
`,
	);
	return flowPath;
}
