import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

interface WorkflowActivationOutput {
	summary?: string;
	data?: {
		verdict?: string;
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

interface ReviewRouteResult {
	summary: string;
	data: {
		decision: string;
		reason: string;
		setupBlockerEvidenceFiles: string[];
		reviewVerdict?: string;
	};
	statePatch: Array<{
		op: "set";
		path: string;
		value: ReviewRouteResult["data"];
	}>;
}

interface SemanticArchiveGuardResult {
	summary: string;
	verdict: "PASS" | "REPAIR";
	data: {
		verdict: "PASS" | "REPAIR";
		findings: Array<{
			file: string;
			reason: string;
		}>;
	};
}

interface ArchiveLoopResult {
	summary: string;
	verdict?: string;
	statePatch: Array<{
		op: "set";
		path: string;
		value: object;
	}>;
}

interface InitializeLoopResult {
	summary: string;
	statePatch: Array<{
		op: "set";
		path: string;
		value: {
			validationPreflight?: {
				status?: string;
				missingDependencyRoots?: string[];
			};
		};
	}>;
}

const InitializeLoopFunctionConstructor = Object.getPrototypeOf(async () => {}).constructor as new (
	workflowContextName: string,
	code: string,
) => (workflowContext: WorkflowContext) => Promise<InitializeLoopResult>;

const ReviewRouteFunctionConstructor = Object.getPrototypeOf(async () => {}).constructor as new (
	workflowContextName: string,
	code: string,
) => (workflowContext: WorkflowContext) => Promise<ReviewRouteResult>;

const SemanticArchiveGuardFunctionConstructor = Object.getPrototypeOf(async () => {}).constructor as new (
	workflowContextName: string,
	code: string,
) => (workflowContext: WorkflowContext) => Promise<SemanticArchiveGuardResult>;

const ArchiveLoopFunctionConstructor = Object.getPrototypeOf(async () => {}).constructor as new (
	workflowContextName: string,
	code: string,
) => (
	workflowContext: WorkflowContext & {
		state?: { reviewRoute?: { decision?: string; reason?: string; setupBlockerEvidenceFiles?: string[] } };
	},
) => Promise<ArchiveLoopResult>;

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("agent-build-review-loop flow contract", () => {
	it("fails closed before builder work when validation harness needs missing dependency roots", async () => {
		const cwd = await createTempDir();
		await fs.mkdir(path.join(cwd, "workflow-output"), { recursive: true });
		await Bun.write(path.join(cwd, "task.md"), "Validation Command:\n./workflow-output/run-validation.sh\n");
		await Bun.write(
			path.join(cwd, "workflow-output", "run-validation.sh"),
			[
				"#!/usr/bin/env bash",
				"set -euo pipefail",
				"mapfile -t dependency_dirs < <(find . -path './node_modules' -type d -prune -print)",
				"pnpm test",
			].join("\n"),
		);

		await expect(runInitializeLoop(cwd)).rejects.toThrow("validation preflight setup blocker");
		const evidence = await Bun.file(
			path.join(cwd, "workflow-output", "setup-blocker-validation-preflight.json"),
		).json();

		expect(evidence).toMatchObject({
			status: "setup-blocker",
			missingDependencyRoots: ["node_modules"],
			validationCommand: "./workflow-output/run-validation.sh",
		});
	});

	it("initializes when package-manager validation dependency roots are present", async () => {
		const cwd = await createTempDir();
		await fs.mkdir(path.join(cwd, "workflow-output"), { recursive: true });
		await fs.mkdir(path.join(cwd, "node_modules"), { recursive: true });
		await Bun.write(path.join(cwd, "task.md"), "Validation Command:\n./workflow-output/run-validation.sh\n");
		await Bun.write(
			path.join(cwd, "workflow-output", "run-validation.sh"),
			[
				"#!/usr/bin/env bash",
				"set -euo pipefail",
				"mapfile -t dependency_dirs < <(find . -path './node_modules' -type d -prune -print)",
				"pnpm test",
			].join("\n"),
		);

		const result = await runInitializeLoop(cwd);
		const progress = result.statePatch.find(patch => patch.path === "/progress")?.value;

		expect(progress?.validationPreflight).toMatchObject({
			status: "pass",
			missingDependencyRoots: [],
		});
		expect(await Bun.file(path.join(cwd, "workflow-output", "initial-loop-snapshot.md")).text()).toContain(
			"./workflow-output/run-validation.sh",
		);
	});

	it("routes explicit setup-blocker evidence to reject instead of another build round", async () => {
		const cwd = await createTempDir();
		await fs.mkdir(path.join(cwd, "workflow-output"), { recursive: true });
		await Bun.write(
			path.join(cwd, "workflow-output", "setup-blocker-evidence.json"),
			JSON.stringify({ status: "setup-blocker", reason: "validation dependencies missing" }),
		);

		const result = await runReviewRouteClassifier(cwd, {
			verdict: "continue",
			summary: "Validation dependencies are missing, so another build round should investigate.",
		});

		expect(result.data).toMatchObject({
			decision: "reject",
			reviewVerdict: "continue",
		});
		expect(result.data.setupBlockerEvidenceFiles).toContain("workflow-output/setup-blocker-evidence.json");
		expect(result.summary).toContain("setup blocker");
	});

	it("routes setup-level validation dependency blockers to reject even without setup-blocker file names", async () => {
		const cwd = await createTempDir();
		await fs.mkdir(path.join(cwd, "workflow-output", "round-2"), { recursive: true });
		await Bun.write(
			path.join(cwd, "workflow-output", "round-2", "validation-summary.txt"),
			[
				"The clean-copy validation completed package builds.",
				"The command still fails during pnpm test-unit because the validation copy is missing dependency fixtures.",
				"This matches the task stop condition for missing validation dependencies after preflight.",
			].join("\n"),
		);

		const result = await runReviewRouteClassifier(cwd, {
			verdict: "continue",
			summary: "Validation still fails, but it is a setup-level missing validation dependency stop condition.",
		});

		expect(result.data).toMatchObject({
			decision: "reject",
			reviewVerdict: "continue",
			setupBlockerEvidenceFiles: ["workflow-output/round-2/validation-summary.txt"],
		});
		expect(result.summary).toContain("setup blocker");
	});

	it("routes clean-copy missing dependency stop-condition language to reject", async () => {
		const cwd = await createTempDir();
		await fs.mkdir(path.join(cwd, "workflow-output", "round-2"), { recursive: true });
		await Bun.write(
			path.join(cwd, "workflow-output", "round-2", "build-summary.txt"),
			[
				"Validation:",
				"- Result: fail",
				"- Latest run failed during test-serve because the prepared clean copy is missing validation dependencies such as @vitejs/plugin-legacy, stylus, express, escape-html, sirv, and oxc-parser.",
				"- Per task stop conditions, dependency bootstrap was not attempted.",
			].join("\n"),
		);

		const result = await runReviewRouteClassifier(cwd, {
			verdict: "continue",
			summary: "Continue after validating the latest build summary.",
		});

		expect(result.data).toMatchObject({
			decision: "reject",
			reviewVerdict: "continue",
			setupBlockerEvidenceFiles: ["workflow-output/round-2/build-summary.txt"],
		});
	});

	it("routes nondurable validation artifact references to reject", async () => {
		const cwd = await createTempDir();
		await fs.mkdir(path.join(cwd, "workflow-output", "round-2"), { recursive: true });
		await Bun.write(
			path.join(cwd, "workflow-output", "round-2", "build-summary.txt"),
			[
				"Validation:",
				"- Command: ./workflow-output/run-vite-validation.sh",
				"- Result: fail",
				"- Full latest validation stdout/stderr is captured by harness artifact artifact://20.",
			].join("\n"),
		);

		const result = await runReviewRouteClassifier(cwd, {
			verdict: "continue",
			summary: "Review found useful work but asks for another build round.",
		});

		expect(result.data).toMatchObject({
			decision: "reject",
			reviewVerdict: "continue",
			setupBlockerEvidenceFiles: ["workflow-output/round-2/build-summary.txt"],
		});
		expect(result.data.reason).toContain("setup blocker");
	});

	it("preserves an ordinary continue review when no setup blocker evidence exists", async () => {
		const cwd = await createTempDir();
		await fs.mkdir(path.join(cwd, "workflow-output"), { recursive: true });

		const result = await runReviewRouteClassifier(cwd, {
			verdict: "continue",
			summary: "Validation failed because the implementation needs another focused fix.",
		});

		expect(result.data).toMatchObject({
			decision: "continue",
			reviewVerdict: "continue",
			setupBlockerEvidenceFiles: [],
		});
	});

	it("does not treat task text copied into the initial snapshot as setup-blocker evidence", async () => {
		const cwd = await createTempDir();
		await fs.mkdir(path.join(cwd, "workflow-output"), { recursive: true });
		await Bun.write(
			path.join(cwd, "workflow-output", "initial-loop-snapshot.md"),
			[
				"# Initial Loop Snapshot",
				"",
				"## Task",
				"",
				"Stop Conditions:",
				"Stop if clean-copy validation is impossible or if setup blocker evidence is produced.",
			].join("\n"),
		);

		const result = await runReviewRouteClassifier(cwd, {
			verdict: "continue",
			summary: "Validation failed after real build work; run another focused implementation round.",
		});

		expect(result.data).toMatchObject({
			decision: "continue",
			reviewVerdict: "continue",
			setupBlockerEvidenceFiles: [],
		});
	});

	it("requires repair when round evidence claims downstream guard or archive nodes completed", async () => {
		const cwd = await createTempDir();
		await fs.mkdir(path.join(cwd, "workflow-output", "round-2"), { recursive: true });
		await Bun.write(
			path.join(cwd, "workflow-output", "round-2", "archive-output.json"),
			JSON.stringify({ archiveLoop: "complete", semanticArchiveGuard: "complete" }),
		);

		const result = await runSemanticArchiveGuard(cwd);

		expect(result.verdict).toBe("REPAIR");
		const finding = result.data.findings.find(item => item.file === "workflow-output/round-2/archive-output.json");
		expect(finding).toMatchObject({
			reason: "round evidence claims downstream workflow node completion",
		});
	});

	it("requires repair when round validation evidence points to nondurable artifact urls", async () => {
		const cwd = await createTempDir();
		await fs.mkdir(path.join(cwd, "workflow-output", "round-2"), { recursive: true });
		await Bun.write(
			path.join(cwd, "workflow-output", "round-2", "build-summary.txt"),
			"Full latest validation stdout/stderr is captured by harness artifact artifact://20.\n",
		);

		const result = await runSemanticArchiveGuard(cwd);

		expect(result.verdict).toBe("REPAIR");
		const finding = result.data.findings.find(item => item.file === "workflow-output/round-2/build-summary.txt");
		expect(finding).toMatchObject({
			reason: "round evidence uses nondurable artifact reference for validation output",
		});
	});

	it("requires repair when a validation round lacks durable stdout and stderr logs", async () => {
		const cwd = await createTempDir();
		await fs.mkdir(path.join(cwd, "workflow-output", "round-1"), { recursive: true });
		await Bun.write(
			path.join(cwd, "progress.md"),
			"ROUND 1: changed parser tests; validation=./check.sh; result=fail\n",
		);
		await Bun.write(
			path.join(cwd, "workflow-output", "round-1", "evidence.txt"),
			"Validation command ./check.sh failed after real project work.\n",
		);

		const result = await runSemanticArchiveGuard(cwd);

		expect(result.verdict).toBe("REPAIR");
		const finding = result.data.findings.find(
			item => item.reason === "validation round is missing durable stdout/stderr artifacts",
		);
		expect(finding).toMatchObject({
			file: "workflow-output/round-1",
		});
	});

	it("rejects archiving round evidence that claims downstream guard or archive completion", async () => {
		const cwd = await createTempDir();
		await fs.mkdir(path.join(cwd, "workflow-output", "round-2"), { recursive: true });
		await Bun.write(path.join(cwd, "task.md"), "Validation Command:\ntrue\n");
		await Bun.write(path.join(cwd, "progress.md"), "ROUND 1: recorded setup blocker; validation=true; result=fail\n");
		await Bun.write(
			path.join(cwd, "workflow-output", "round-2", "archive-output.json"),
			JSON.stringify({ archiveLoop: "complete", semanticArchiveGuard: "complete" }),
		);

		await expect(runArchiveLoop(cwd)).rejects.toThrow("round evidence claims downstream workflow node completion");
	});

	it("rejects archiving round evidence that references nondurable validation artifacts", async () => {
		const cwd = await createTempDir();
		await fs.mkdir(path.join(cwd, "workflow-output", "round-2"), { recursive: true });
		await Bun.write(path.join(cwd, "task.md"), "Validation Command:\ntrue\n");
		await Bun.write(path.join(cwd, "progress.md"), "ROUND 1: validation artifact was nondurable; result=fail\n");
		await Bun.write(
			path.join(cwd, "workflow-output", "round-2", "build-summary.txt"),
			"Full latest validation stdout/stderr is captured by harness artifact artifact://20.\n",
		);

		await expect(runArchiveLoop(cwd)).rejects.toThrow("round evidence uses nondurable artifact references");
	});

	it("rejects archiving validation rounds without durable stdout and stderr logs", async () => {
		const cwd = await createTempDir();
		await fs.mkdir(path.join(cwd, "workflow-output", "round-1"), { recursive: true });
		await Bun.write(path.join(cwd, "task.md"), "Validation Command:\n./check.sh\n\nNo-Code Allowed: yes\n");
		await Bun.write(
			path.join(cwd, "progress.md"),
			"ROUND 1: changed parser tests; validation=./check.sh; result=fail\n",
		);
		await Bun.write(
			path.join(cwd, "workflow-output", "round-1", "evidence.txt"),
			"Validation command ./check.sh failed after real project work.\n",
		);

		await expect(runArchiveLoop(cwd, { decision: "complete" })).rejects.toThrow(
			"validation rounds are missing durable stdout/stderr artifacts",
		);
	});

	it("writes a rejected archive and fails the attempt for setup-blocker routes", async () => {
		const cwd = await createTempDir();
		await fs.mkdir(path.join(cwd, "workflow-output"), { recursive: true });
		await Bun.write(path.join(cwd, "task.md"), "Validation Command:\ntrue\n");
		await Bun.write(
			path.join(cwd, "workflow-output", "setup-blocker-evidence.json"),
			JSON.stringify({ status: "setup-blocker", reason: "clean-copy validation missing dependencies" }),
		);

		await expect(runArchiveLoop(cwd)).rejects.toThrow("agent-build-review-loop rejected");
		const archive = await Bun.file(path.join(cwd, "workflow-output", "final-agent-loop-reject.md")).text();
		expect(archive).toContain("Terminal decision: reject");
		expect(archive).toContain("setup-blocker-evidence.json");
	});

	it("writes a rejected archive and fails when setup-blocker evidence only lives in review summary", async () => {
		const cwd = await createTempDir();
		await fs.mkdir(path.join(cwd, "workflow-output"), { recursive: true });
		await Bun.write(path.join(cwd, "task.md"), "Validation Command:\ntrue\n");

		await expect(
			runArchiveLoop(cwd, {
				decision: "reject",
				reason: "setup blocker evidence is terminal; archive/reject instead of looping into another build round",
				setupBlockerEvidenceFiles: ["reviewRound:summary"],
			}),
		).rejects.toThrow("agent-build-review-loop rejected");
		const archive = await Bun.file(path.join(cwd, "workflow-output", "final-agent-loop-reject.md")).text();
		expect(archive).toContain("Terminal decision: reject");
		expect(archive).toContain("reviewRound:summary");
		expect(archive).toContain("setup blocker evidence is terminal");
	});
});

async function runInitializeLoop(cwd: string): Promise<InitializeLoopResult> {
	const scriptPath = path.resolve(
		import.meta.dir,
		"../../examples/workflow/experimental/agent-build-review-loop/agent-build-review-loop/scripts/initialize-loop.js",
	);
	const script = await Bun.file(scriptPath).text();
	const execute = new InitializeLoopFunctionConstructor("workflowContext", script);
	const originalCwd = process.cwd();
	try {
		process.chdir(cwd);
		return await execute({
			activation: { id: "activation-initialize-loop" },
			completedActivations: [],
		});
	} finally {
		process.chdir(originalCwd);
	}
}

async function runReviewRouteClassifier(
	cwd: string,
	reviewOutput: { verdict: string; summary: string },
): Promise<ReviewRouteResult> {
	const scriptPath = path.resolve(
		import.meta.dir,
		"../../examples/workflow/experimental/agent-build-review-loop/agent-build-review-loop/scripts/classify-review-route.js",
	);
	const script = await Bun.file(scriptPath).text();
	const execute = new ReviewRouteFunctionConstructor("workflowContext", script);
	const originalCwd = process.cwd();
	try {
		process.chdir(cwd);
		return await execute({
			activation: { id: "activation-classify-review" },
			completedActivations: [
				{
					id: "activation-review",
					nodeId: "reviewRound",
					output: {
						summary: reviewOutput.summary,
						data: { verdict: reviewOutput.verdict },
					},
				},
			],
		});
	} finally {
		process.chdir(originalCwd);
	}
}

async function runSemanticArchiveGuard(cwd: string): Promise<SemanticArchiveGuardResult> {
	const scriptPath = path.resolve(
		import.meta.dir,
		"../../examples/workflow/experimental/agent-build-review-loop/agent-build-review-loop/scripts/semantic-archive-guard.js",
	);
	const script = await Bun.file(scriptPath).text();
	const execute = new SemanticArchiveGuardFunctionConstructor("workflowContext", script);
	const originalCwd = process.cwd();
	try {
		process.chdir(cwd);
		return await execute({
			activation: { id: "activation-semantic-archive-guard" },
			completedActivations: [],
		});
	} finally {
		process.chdir(originalCwd);
	}
}

async function runArchiveLoop(
	cwd: string,
	reviewRoute: { decision?: string; reason?: string; setupBlockerEvidenceFiles?: string[] } = { decision: "reject" },
): Promise<ArchiveLoopResult> {
	const scriptPath = path.resolve(
		import.meta.dir,
		"../../examples/workflow/experimental/agent-build-review-loop/agent-build-review-loop/scripts/archive-loop.js",
	);
	const script = await Bun.file(scriptPath).text();
	const execute = new ArchiveLoopFunctionConstructor("workflowContext", script);
	const originalCwd = process.cwd();
	try {
		process.chdir(cwd);
		return await execute({
			activation: { id: "activation-archive-loop" },
			completedActivations: [],
			state: {
				reviewRoute,
			},
		});
	} finally {
		process.chdir(originalCwd);
	}
}

async function createTempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omh-agent-loop-contract-"));
	tempDirs.push(dir);
	return dir;
}
