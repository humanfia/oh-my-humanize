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
	statePatch: Array<{
		op: "set";
		path: string;
		value: object;
	}>;
}

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
	workflowContext: WorkflowContext & { state?: { reviewRoute?: { decision?: string } } },
) => Promise<ArchiveLoopResult>;

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("agent-build-review-loop flow contract", () => {
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
			setupBlockerEvidenceFiles: ["workflow-output/setup-blocker-evidence.json"],
		});
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
});

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

async function runArchiveLoop(cwd: string): Promise<ArchiveLoopResult> {
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
				reviewRoute: {
					decision: "reject",
				},
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
