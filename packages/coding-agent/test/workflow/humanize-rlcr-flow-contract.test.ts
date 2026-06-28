import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

interface WorkflowActivationOutput {
	summary?: string;
	data?: {
		response?: string;
		[key: string]: unknown;
	};
}

interface WorkflowActivation {
	id: string;
	nodeId: string;
	output?: WorkflowActivationOutput;
}

interface WorkflowContext {
	activation: {
		id: string;
	};
	completedActivations: WorkflowActivation[];
}

interface OperatorGateStatePatch {
	op: "set";
	path: string;
	value: {
		decision?: string;
		strength?: string;
		reasons?: string[];
		response?: string;
	};
}

interface ScriptResult {
	summary: string;
	statePatch: OperatorGateStatePatch[];
}

interface DiffGuardPatch {
	op: "set";
	path: string;
	value: {
		verdict?: string;
		reasons?: string[];
		untrackedProjectFiles?: string[];
	};
}

interface DiffGuardResult {
	summary: string;
	data: {
		verdict: string;
		reasons: string[];
		untrackedProjectFiles: string[];
	};
	statePatch: DiffGuardPatch[];
}

interface FinalizeResult {
	summary: string;
	statePatch: Array<{
		op: "set";
		path: string;
		value: {
			archiveFile?: string;
			inventoryFile?: string;
			patchInventory?: {
				stagedProjectFiles?: string[];
				unstagedProjectFiles?: string[];
				untrackedProjectFiles?: string[];
			};
		};
	}>;
}

interface RoundSummaryResult {
	summary: string;
	statePatch: Array<{
		op: "set";
		path: string;
		value: object;
	}>;
}

interface RoundSummaryExecution {
	cwd: string;
	result: RoundSummaryResult;
}

interface EnterReviewResult {
	summary: string;
	statePatch: Array<{
		op: "set";
		path: string;
		value: {
			summaryReviewFile?: string;
		};
	}>;
}

const AsyncFunctionConstructor = Object.getPrototypeOf(async () => {}).constructor as new (
	workflowContextName: string,
	code: string,
) => (workflowContext: WorkflowContext) => Promise<ScriptResult>;

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("humanize-rlcr flow contract", () => {
	it("maps undeclared Codex code-review tokens to a conservative issues verdict", async () => {
		const flow = await Bun.file(
			path.resolve(import.meta.dir, "../../examples/workflow/experimental/humanize-rlcr/humanize-rlcr.omhflow"),
		).text();

		expect(flow).toContain("id: codexCodeReview");
		expect(flow).toMatch(/id:\s*codexCodeReview[\s\S]*?fallbackVerdict:\s*ISSUES/u);
	});

	it("accepts canary evidence-class acknowledgement as an explicit proceed gate", async () => {
		const result = await runRecordOperatorGate(
			[
				"Decision: proceed.",
				"Scope is Axum routing, extractor, response, service boundary, and axum-extra test work.",
				"The components connect through Router, MethodRouter, State, FromRef, rejection ordering, and Tower service request handling.",
				"This is a canary-grade real development run; if it completes quickly, archive it honestly as short semantic evidence and enlarge the next real task.",
			].join("\n"),
		);

		const gate = result.statePatch.find(patch => patch.path === "/humanize/operatorGate")?.value;

		expect(gate).toMatchObject({
			decision: "proceed",
			strength: "explicit",
			reasons: [],
		});
	});

	it("accepts natural component-list wording in the operator proceed gate", async () => {
		const result = await runRecordOperatorGate(
			[
				"Proceed. Components to watch: serializer payload/loads error boundary, signer verification, timestamp max_age/SignatureExpired, and BadSignature propagation.",
				"They connect through Serializer/TimedSerializer delegating signing/unsigning and surfacing bad payload/signature semantics.",
				"This is not long-running validation; continue only while transcript shows semantic progress, and stop on padding, repeated no-op failures, or validation not startable.",
			].join(" "),
		);

		const gate = result.statePatch.find(patch => patch.path === "/humanize/operatorGate")?.value;

		expect(gate).toMatchObject({
			decision: "proceed",
			strength: "explicit",
			reasons: [],
		});
	});

	it("accepts the formal Decision proceed field as an explicit proceed gate", async () => {
		const result = await runRecordOperatorGate("Decision: proceed");

		const gate = result.statePatch.find(patch => patch.path === "/humanize/operatorGate")?.value;

		expect(gate).toMatchObject({
			decision: "proceed",
			strength: "explicit",
			reasons: [],
		});
	});

	it("accepts the default OMH human approval button as an explicit proceed gate", async () => {
		const result = await runRecordOperatorGate("Approve.");

		const gate = result.statePatch.find(patch => patch.path === "/humanize/operatorGate")?.value;

		expect(gate).toMatchObject({
			decision: "proceed",
			strength: "explicit",
			reasons: [],
		});
	});

	it("requires repair when an implementation creates an untracked project deliverable", async () => {
		const repo = await createGitRepo();
		await Bun.write(path.join(repo, "task.md"), "Objective:\nAdd one tracked test file.\n");
		await Bun.write(path.join(repo, "existing.txt"), "baseline\n");
		await runCommand(["git", "add", "task.md", "existing.txt"], repo);
		await runCommand(["git", "commit", "-m", "init"], repo);
		await Bun.write(path.join(repo, "new-test.txt"), "real test content\n");

		const result = await runDiffDisciplineGuard(repo);
		const evidence = await Bun.file(path.join(repo, "workflow-output", "round-1-diff-discipline-guard.json")).json();

		expect(result.data.verdict).toBe("REPAIR");
		expect(result.data.untrackedProjectFiles).toContain("new-test.txt");
		expect(result.data.reasons.join("\n")).toContain("untracked project files must be staged or explicitly excluded");
		expect(evidence).toMatchObject({
			flow: "humanize-rlcr",
			node: "diffDisciplineGuard",
			round: 1,
			verdict: "REPAIR",
		});
	});

	it("requires repair for untracked project deliverables even when broad changes are allowed", async () => {
		const repo = await createGitRepo();
		await Bun.write(
			path.join(repo, "task.md"),
			[
				"Objective:",
				"Perform a repo-wide characterization task.",
				"",
				"Diff Gate:",
				"Repo-wide changes are allowed, but project deliverables must be tracked before review.",
				"",
			].join("\n"),
		);
		await Bun.write(path.join(repo, "existing.txt"), "baseline\n");
		await runCommand(["git", "add", "task.md", "existing.txt"], repo);
		await runCommand(["git", "commit", "-m", "init"], repo);
		await Bun.write(path.join(repo, "new-cross-crate-test.rs"), "real test content\n");

		const result = await runDiffDisciplineGuard(repo);

		expect(result.data.verdict).toBe("REPAIR");
		expect(result.data.untrackedProjectFiles).toContain("new-cross-crate-test.rs");
		expect(result.data.reasons.join("\n")).toContain("untracked project files must be staged or explicitly excluded");
	});

	it("does not treat out-of-scope broad churn text as broad change permission", async () => {
		const repo = await createGitRepo();
		await Bun.write(
			path.join(repo, "task.md"),
			[
				"Objective:",
				"Add focused tests for routing behavior.",
				"",
				"Out of scope: repo-wide formatting, broad rewrite, and mechanical migration.",
				"",
			].join("\n"),
		);
		for (let index = 0; index < 20; index += 1) {
			await Bun.write(path.join(repo, `file-${index}.txt`), "baseline\n");
		}
		await runCommand(["git", "add", "."], repo);
		await runCommand(["git", "commit", "-m", "init"], repo);
		for (let index = 0; index < 20; index += 1) {
			await Bun.write(path.join(repo, `file-${index}.txt`), `baseline\nfocused change ${index}\n`);
		}

		const result = await runDiffDisciplineGuard(repo);

		expect(result.data.verdict).toBe("REPAIR");
		expect(result.data.reasons.join("\n")).toContain("without an explicit repo-wide task contract");
	});

	it("enforces a task-declared whitespace churn budget", async () => {
		const repo = await createGitRepo();
		await Bun.write(
			path.join(repo, "task.md"),
			[
				"Objective:",
				"Add a focused semantic change without formatter churn.",
				"",
				"Diff Gate:",
				"Whitespace-only or formatter-driven changes must stay below 20 percent of the diff.",
				"",
			].join("\n"),
		);
		await Bun.write(path.join(repo, "src.rs"), numberedLines("let value = ", 40));
		await runCommand(["git", "add", "task.md", "src.rs"], repo);
		await runCommand(["git", "commit", "-m", "init"], repo);
		await Bun.write(path.join(repo, "src.rs"), `${numberedLines("\tlet value = ", 40)}\nlet semantic_value = 41;\n`);

		const result = await runDiffDisciplineGuard(repo);

		expect(result.data.verdict).toBe("REPAIR");
		expect(result.data.reasons.join("\n")).toContain("mechanical whitespace/style overhead exceeds task diff gate");
	});

	it("requires repair when implementation evidence uses nondurable artifact urls", async () => {
		const repo = await createGitRepo();
		await fs.mkdir(path.join(repo, "workflow-output"), { recursive: true });
		await Bun.write(path.join(repo, "task.md"), "Objective:\nAdd focused tests.\n");
		await Bun.write(path.join(repo, "existing.txt"), "baseline\n");
		await runCommand(["git", "add", "task.md", "existing.txt"], repo);
		await runCommand(["git", "commit", "-m", "init"], repo);
		await Bun.write(path.join(repo, "existing.txt"), "baseline\nsemantic change\n");
		await Bun.write(
			path.join(repo, "workflow-output", "implementation-round-example.json"),
			JSON.stringify({
				validation: {
					status: "passed",
					rawOutputArtifact: "artifact://18",
				},
			}),
		);

		const result = await runDiffDisciplineGuard(repo);

		expect(result.data.verdict).toBe("REPAIR");
		expect(result.data.reasons.join("\n")).toContain("nondurable artifact references");
	});

	it("rejects implementation round evidence that claims downstream review completion", async () => {
		await expect(
			runWriteRoundSummary(
				{
					summary: "implemented focused tests",
					data: {
						changedFiles: ["src/lib.rs"],
						reviewSummary: { status: "passed", findings: [] },
						finalAlignmentCheck: "all done",
					},
				},
				await createTempDir(),
			),
		).rejects.toThrow("implementation round evidence cannot claim downstream review or final-alignment results");
	});

	it("rejects implementation round evidence that uses nondurable artifact urls", async () => {
		await expect(
			runWriteRoundSummary(
				{
					summary: "implemented focused tests",
					data: {
						changedFiles: ["src/lib.rs"],
						verification: {
							status: "passed",
							rawOutputArtifact: "artifact://18",
						},
					},
				},
				await createTempDir(),
			),
		).rejects.toThrow("implementation round evidence cannot use nondurable artifact references");
	});

	it("writes durable round and summary-review evidence for each implementation round", async () => {
		const roundDir = await createTempDir();
		const { result } = await runWriteRoundSummary(
			{
				summary: "implemented focused tests",
				data: {
					status: "ready",
					changedFiles: ["src/lib.rs"],
					verification: ["bun test src/lib.test.ts"],
					negativeTests: ["rejects invalid input"],
				},
			},
			roundDir,
		);
		const ledger = result.statePatch.find(patch => patch.path === "/humanize/ledger")?.value;
		const roundEvidence = await Bun.file(path.join(roundDir, "workflow-output", "round-1-summary.json")).json();
		const reviewResult = await runEnterReviewPhase(roundDir);
		const reviewEvidence = await Bun.file(
			path.join(roundDir, "workflow-output", "round-1-codex-summary-review.json"),
		).json();

		expect(ledger).toMatchObject({ currentRound: 1 });
		expect(roundEvidence).toMatchObject({
			flow: "humanize-rlcr",
			node: "writeRoundSummary",
			round: 1,
			entry: { artifactFile: "workflow-output/round-1-summary.json" },
		});
		expect(reviewResult.statePatch.find(patch => patch.path === "/humanize/reviewPhase")?.value).toMatchObject({
			summaryReviewFile: "workflow-output/round-1-codex-summary-review.json",
		});
		expect(reviewEvidence).toMatchObject({
			flow: "humanize-rlcr",
			node: "codexSummaryReview",
			round: 1,
		});
	});

	it("finalizes with a durable archive and combined staged unstaged untracked patch inventory", async () => {
		const repo = await createGitRepo();
		await fs.mkdir(path.join(repo, "workflow-output"), { recursive: true });
		await Bun.write(path.join(repo, "task.md"), "Objective:\nCapture final patch evidence.\n");
		await Bun.write(path.join(repo, "staged.txt"), "old\n");
		await Bun.write(path.join(repo, "unstaged.txt"), "old\n");
		await runCommand(["git", "add", "task.md", "staged.txt", "unstaged.txt"], repo);
		await runCommand(["git", "commit", "-m", "init"], repo);
		await Bun.write(path.join(repo, "staged.txt"), "new\n");
		await Bun.write(path.join(repo, "unstaged.txt"), "new\n");
		await Bun.write(path.join(repo, "untracked.txt"), "new\n");
		await Bun.write(path.join(repo, "workflow-output", "validation-final.txt"), "validation passed\n");
		await Bun.write(path.join(repo, "workflow-output", "round-1-summary.json"), "{}\n");
		await Bun.write(path.join(repo, "workflow-output", "round-1-diff-discipline-guard.json"), "{}\n");
		await Bun.write(path.join(repo, "workflow-output", "round-1-codex-summary-review.json"), "{}\n");
		await runCommand(["git", "add", "staged.txt"], repo);

		const result = await runFinalize(repo);
		const final = result.statePatch.find(patch => patch.path === "/humanize/final")?.value;

		expect(final?.archiveFile).toBe("workflow-output/final-humanize-rlcr-archive.md");
		expect(final?.inventoryFile).toBe("workflow-output/final-humanize-rlcr-inventory.json");
		expect(final?.patchInventory?.stagedProjectFiles).toContain("staged.txt");
		expect(final?.patchInventory?.unstagedProjectFiles).toContain("unstaged.txt");
		expect(final?.patchInventory?.untrackedProjectFiles).toContain("untracked.txt");
		const archive = await Bun.file(path.join(repo, "workflow-output", "final-humanize-rlcr-archive.md")).text();
		expect(archive).toContain("validation-final.txt");
		expect(archive).toContain("round-1-summary.json");
		expect(archive).toContain("final-codex-code-review.json");
		expect(await Bun.file(path.join(repo, "workflow-output", "final-codex-code-review.json")).json()).toMatchObject({
			flow: "humanize-rlcr",
			node: "codexCodeReview",
		});
	});

	it("refuses to finalize when durable round evidence is missing", async () => {
		const repo = await createGitRepo();
		await fs.mkdir(path.join(repo, "workflow-output"), { recursive: true });
		await Bun.write(path.join(repo, "task.md"), "Objective:\nCapture final patch evidence.\n");
		await runCommand(["git", "add", "task.md"], repo);
		await runCommand(["git", "commit", "-m", "init"], repo);
		await Bun.write(path.join(repo, "workflow-output", "round-1-summary.json"), "{}\n");

		await expect(runFinalize(repo)).rejects.toThrow("humanize RLCR finalize missing durable evidence");
	});
});

async function runRecordOperatorGate(response: string): Promise<ScriptResult> {
	const scriptPath = path.resolve(
		import.meta.dir,
		"../../examples/workflow/experimental/humanize-rlcr/humanize-rlcr/scripts/record-operator-gate.js",
	);
	const script = await Bun.file(scriptPath).text();
	const execute = new AsyncFunctionConstructor("workflowContext", script);
	return execute({
		activation: { id: "activation-record" },
		completedActivations: [
			{
				id: "activation-human",
				nodeId: "planUnderstandingQuiz",
				output: {
					summary: response,
					data: { response },
				},
			},
		],
	});
}

async function runDiffDisciplineGuard(cwd: string): Promise<DiffGuardResult> {
	const scriptPath = path.resolve(
		import.meta.dir,
		"../../examples/workflow/experimental/humanize-rlcr/humanize-rlcr/scripts/diff-discipline-guard.js",
	);
	const script = await Bun.file(scriptPath).text();
	const execute = new AsyncFunctionConstructor("workflowContext", script) as unknown as (
		workflowContext: WorkflowContext,
	) => Promise<DiffGuardResult>;
	const originalCwd = process.cwd();
	try {
		process.chdir(cwd);
		return await execute({
			activation: { id: "activation-diff-guard" },
			completedActivations: [],
		});
	} finally {
		process.chdir(originalCwd);
	}
}

async function runWriteRoundSummary(
	implementationOutput: WorkflowActivationOutput,
	cwd: string,
): Promise<RoundSummaryExecution> {
	const scriptPath = path.resolve(
		import.meta.dir,
		"../../examples/workflow/experimental/humanize-rlcr/humanize-rlcr/scripts/write-round-summary.js",
	);
	const script = await Bun.file(scriptPath).text();
	const execute = new AsyncFunctionConstructor("workflowContext", script) as unknown as (
		workflowContext: WorkflowContext & {
			activation: { id: string; parentActivationIds: string[] };
			state: {
				humanize: {
					operatorGate: { recordedAtMs: number };
					ledger: { currentRound: number; rounds: unknown[]; archivedRoundCount: number };
				};
			};
		},
	) => Promise<RoundSummaryResult>;
	const originalCwd = process.cwd();
	try {
		process.chdir(cwd);
		const result = await execute({
			activation: { id: "activation-write-summary", parentActivationIds: ["activation-implementation"] },
			completedActivations: [
				{
					id: "activation-implementation",
					nodeId: "implementRound",
					output: implementationOutput,
				},
			],
			state: {
				humanize: {
					operatorGate: { recordedAtMs: Date.now() },
					ledger: { currentRound: 0, rounds: [], archivedRoundCount: 0 },
				},
			},
		});
		return { cwd, result };
	} finally {
		process.chdir(originalCwd);
	}
}

async function runEnterReviewPhase(cwd: string): Promise<EnterReviewResult> {
	const scriptPath = path.resolve(
		import.meta.dir,
		"../../examples/workflow/experimental/humanize-rlcr/humanize-rlcr/scripts/enter-review-phase.js",
	);
	const script = await Bun.file(scriptPath).text();
	const execute = new AsyncFunctionConstructor("workflowContext", script) as unknown as (
		workflowContext: WorkflowContext & {
			activation: { id: string; parentActivationIds: string[] };
			state: {
				humanize: {
					operatorGate: { recordedAtMs: number };
					ledger: { currentRound: number; openIssues: unknown[]; queuedIssues: unknown[] };
				};
			};
		},
	) => Promise<EnterReviewResult>;
	const originalCwd = process.cwd();
	try {
		process.chdir(cwd);
		return await execute({
			activation: { id: "activation-enter-review", parentActivationIds: ["activation-summary-review"] },
			completedActivations: [
				{
					id: "activation-summary-review",
					nodeId: "codexSummaryReview",
					output: { summary: "summary review passed", data: { verdict: "complete" } },
				},
			],
			state: {
				humanize: {
					operatorGate: { recordedAtMs: Date.now() },
					ledger: { currentRound: 1, openIssues: [], queuedIssues: [] },
				},
			},
		});
	} finally {
		process.chdir(originalCwd);
	}
}

async function runFinalize(cwd: string): Promise<FinalizeResult> {
	const scriptPath = path.resolve(
		import.meta.dir,
		"../../examples/workflow/experimental/humanize-rlcr/humanize-rlcr/scripts/finalize.js",
	);
	const script = await Bun.file(scriptPath).text();
	const execute = new AsyncFunctionConstructor("workflowContext", script) as unknown as (
		workflowContext: WorkflowContext & {
			state: {
				humanize: {
					operatorGate: { recordedAtMs: number };
					ledger: { currentRound: number; openIssues: unknown[]; queuedIssues: unknown[] };
				};
			};
		},
	) => Promise<FinalizeResult>;
	const originalCwd = process.cwd();
	try {
		process.chdir(cwd);
		return await execute({
			activation: { id: "activation-finalize" },
			completedActivations: [
				{
					id: "activation-code-review",
					nodeId: "codexCodeReview",
					output: { summary: "code review clean", data: { verdict: "complete" } },
				},
				{
					id: "activation-final-alignment",
					nodeId: "finalAlignmentCheck",
					output: { summary: "final alignment clean", data: { verdict: "complete" } },
				},
			],
			state: {
				humanize: {
					operatorGate: { recordedAtMs: Date.now() },
					ledger: { currentRound: 2, openIssues: [], queuedIssues: [] },
				},
			},
		});
	} finally {
		process.chdir(originalCwd);
	}
}

async function createTempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omh-humanize-contract-"));
	tempDirs.push(dir);
	return dir;
}

async function createGitRepo(): Promise<string> {
	const dir = await createTempDir();
	await runCommand(["git", "init"], dir);
	await runCommand(["git", "config", "user.email", "test@example.com"], dir);
	await runCommand(["git", "config", "user.name", "Test User"], dir);
	return dir;
}

async function runCommand(command: string[], cwd: string): Promise<void> {
	const proc = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (exitCode !== 0) {
		throw new Error(`command failed (${exitCode}): ${command.join(" ")}\n${stdout}\n${stderr}`);
	}
}

function numberedLines(prefix: string, count: number): string {
	return Array.from({ length: count }, (_, index) => `${prefix}${index};`).join("\n");
}
