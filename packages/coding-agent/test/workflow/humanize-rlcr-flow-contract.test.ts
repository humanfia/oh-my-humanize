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

	it("keeps plain approval held until the operator gives a concrete proceed decision", async () => {
		const result = await runRecordOperatorGate("Approve.");

		const gate = result.statePatch.find(patch => patch.path === "/humanize/operatorGate")?.value;

		expect(gate).toMatchObject({
			decision: "hold",
			strength: "weak",
			reasons: ["approval is not an explicit proceed decision"],
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

		expect(result.data.verdict).toBe("REPAIR");
		expect(result.data.untrackedProjectFiles).toContain("new-test.txt");
		expect(result.data.reasons.join("\n")).toContain("untracked project files must be staged or explicitly excluded");
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

	it("rejects implementation round evidence that claims downstream review completion", async () => {
		await expect(
			runWriteRoundSummary({
				summary: "implemented focused tests",
				data: {
					changedFiles: ["src/lib.rs"],
					reviewSummary: { status: "passed", findings: [] },
					finalAlignmentCheck: "all done",
				},
			}),
		).rejects.toThrow("implementation round evidence cannot claim downstream review or final-alignment results");
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
		await runCommand(["git", "add", "staged.txt"], repo);

		const result = await runFinalize(repo);
		const final = result.statePatch.find(patch => patch.path === "/humanize/final")?.value;

		expect(final?.archiveFile).toBe("workflow-output/final-humanize-rlcr-archive.md");
		expect(final?.inventoryFile).toBe("workflow-output/final-humanize-rlcr-inventory.json");
		expect(final?.patchInventory?.stagedProjectFiles).toContain("staged.txt");
		expect(final?.patchInventory?.unstagedProjectFiles).toContain("unstaged.txt");
		expect(final?.patchInventory?.untrackedProjectFiles).toContain("untracked.txt");
		expect(await Bun.file(path.join(repo, "workflow-output", "final-humanize-rlcr-archive.md")).text()).toContain(
			"validation-final.txt",
		);
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

async function runWriteRoundSummary(implementationOutput: WorkflowActivationOutput): Promise<RoundSummaryResult> {
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
	return execute({
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
			completedActivations: [],
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

async function createGitRepo(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omh-humanize-contract-"));
	tempDirs.push(dir);
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
