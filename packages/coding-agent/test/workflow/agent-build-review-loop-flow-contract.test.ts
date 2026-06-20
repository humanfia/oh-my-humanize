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
		externalValidationBlockerEvidenceFiles?: string[];
		terminalBlockerEvidenceFiles?: string[];
		reviewDecisionTrailFile?: string;
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

	it("routes repeated external validation blockers to reject instead of another build round", async () => {
		const cwd = await createTempDir();
		for (const round of [1, 2, 3]) {
			await fs.mkdir(path.join(cwd, "workflow-output", `round-${round}`), { recursive: true });
			await Bun.write(
				path.join(cwd, "workflow-output", `round-${round}`, "validation-summary.txt"),
				[
					"Command: ./workflow-output/run-vite-validation.sh",
					"Result: fail",
					"Failure: clean-copy validation reached test-serve and failed in playground/tailwind-sourcemap/__tests__/tailwind-sourcemap.spec.ts with page.goto timeout after 30000ms.",
					"This failure is outside the task scope and repeated after real scoped asset-platform work.",
				].join("\n"),
			);
		}

		const result = await runReviewRouteClassifier(cwd, {
			verdict: "continue",
			summary: "The latest validation did not pass, so continue.",
		});

		expect(result.data).toMatchObject({
			decision: "reject",
			reviewVerdict: "continue",
			setupBlockerEvidenceFiles: [],
			externalValidationBlockerEvidenceFiles: [
				"workflow-output/round-1/validation-summary.txt",
				"workflow-output/round-2/validation-summary.txt",
				"workflow-output/round-3/validation-summary.txt",
			],
		});
		expect(result.data.reason).toContain("terminal validation blocker");
		await expect(Bun.file(path.join(cwd, "workflow-output", "review-route-1.json")).json()).resolves.toMatchObject({
			decision: "reject",
			externalValidationBlockerEvidenceFiles: [
				"workflow-output/round-1/validation-summary.txt",
				"workflow-output/round-2/validation-summary.txt",
				"workflow-output/round-3/validation-summary.txt",
			],
		});
	});

	it("routes repeated clean-copy missing dependency blockers to reject", async () => {
		const cwd = await createTempDir();
		for (const round of [1, 2]) {
			await fs.mkdir(path.join(cwd, "workflow-output", `round-${round}`), { recursive: true });
			await Bun.write(
				path.join(cwd, "workflow-output", `round-${round}`, "validation-summary.txt"),
				[
					`Round ${round} validation command: ./workflow-output/run-vite-validation.sh`,
					"Exit code: 1",
					"External blocker: clean-copy e2e validation fails in test-serve because the validation copy excludes node_modules and the playground tests require dependencies that are not present in the clean copy.",
					"The repeated missing dependencies include @vitejs/plugin-legacy, @vue/shared, stylus, express, escape-html, sirv, and oxc-parser.",
				].join("\n"),
			);
			await Bun.write(
				path.join(cwd, "workflow-output", `round-${round}`, "validation-stderr.txt"),
				[
					"FAIL playground/legacy/__tests__/legacy.spec.ts",
					"Error: Cannot find package '@vitejs/plugin-legacy' imported from playground-temp/legacy/vite.config.js",
					"FAIL playground/fs-serve/__tests__/fs-serve.spec.ts",
					"Error: Cannot find package 'escape-html' imported from playground-temp/fs-serve/root/vite.config.js",
				].join("\n"),
			);
		}

		const result = await runReviewRouteClassifier(cwd, {
			verdict: "continue",
			summary:
				"Validation is still blocked by a repeated clean-copy dependency-environment failure after real scoped work.",
		});

		expect(result.data).toMatchObject({
			decision: "reject",
			reviewVerdict: "continue",
			setupBlockerEvidenceFiles: [],
			externalValidationBlockerEvidenceFiles: [
				"workflow-output/round-1/validation-summary.txt",
				"workflow-output/round-2/validation-summary.txt",
			],
		});
		expect(result.data.reason).toContain("terminal validation blocker");
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

	it("keeps building after a single validation failure mislabeled as setup blocker", async () => {
		const cwd = await createTempDir();
		await fs.mkdir(path.join(cwd, "workflow-output", "round-1"), { recursive: true });
		await Bun.write(path.join(cwd, "task.md"), "Produce at least eight meaningful build/review cycles.\n");
		await Bun.write(
			path.join(cwd, "progress.md"),
			"ROUND 1: cooked escaped static import.meta asset URL literals before asset resolution; validation=./workflow-output/run-vite-validation.sh; result=fail\n",
		);
		await Bun.write(
			path.join(cwd, "workflow-output", "round-1", "validation-summary.txt"),
			[
				"Round 1 validation failed after the import.meta asset URL escape regression test passed.",
				"External/setup blocker: the clean validation copy cannot satisfy existing config fixture dependencies.",
				"The same validation run also reports pre-existing cacheDir resolution expectation failures.",
				"Raw stdout and stderr are preserved in this round directory.",
			].join("\n"),
		);

		const result = await runReviewRouteClassifier(cwd, {
			verdict: "continue",
			summary:
				"Only 1 line beginning with ROUND exists in progress.md, below the task-required minimum of 8 meaningful build/review cycles. The latest declared validation command run failed, with evidence in workflow-output/round-1/ showing unresolved clean-copy config fixture dependencies and cacheDir expectation failures; only one scoped source/test improvement is present so another build round is required.",
		});

		expect(result.data).toMatchObject({
			decision: "continue",
			reviewVerdict: "continue",
			setupBlockerEvidenceFiles: [],
			externalValidationBlockerEvidenceFiles: [],
			terminalBlockerEvidenceFiles: [],
		});
	});

	it("routes archive-readiness-only reviews to semantic archive guard instead of another build round", async () => {
		const cwd = await createTempDir();
		await fs.mkdir(path.join(cwd, "workflow-output"), { recursive: true });
		await Bun.write(
			path.join(cwd, "progress.md"),
			[
				"ROUND 1: fixed asset import transform; validation=./workflow-output/run-validation.sh; result=pass",
				"ROUND 2: added SSR asset coverage; validation=./workflow-output/run-validation.sh; result=pass",
			].join("\n"),
		);

		const result = await runReviewRouteClassifier(cwd, {
			verdict: "continue",
			summary:
				"progress.md has 2 ROUND entries, satisfying the declared minimum, and the latest scoped validation via workflow-output/run-validation.sh passed. Another build round is still needed because task-required archive completion evidence is missing: semantic-archive-guard.json and archive output are absent, so semanticArchiveGuard/archiveLoop have not completed with the project-only changed-file inventory.",
		});

		expect(result.data).toMatchObject({
			decision: "complete",
			reviewVerdict: "continue",
			setupBlockerEvidenceFiles: [],
			externalValidationBlockerEvidenceFiles: [],
			terminalBlockerEvidenceFiles: [],
		});
		expect(result.data.reason).toContain("semantic archive guard");
	});

	it("routes terminal-evidence-only review wording to semantic archive guard", async () => {
		const cwd = await createTempDir();
		await fs.mkdir(path.join(cwd, "workflow-output"), { recursive: true });
		await Bun.write(
			path.join(cwd, "progress.md"),
			[
				"ROUND 1: scoped cacheDir resolution to the configured root; validation=./workflow-output/run-validation.sh; result=pass",
				"ROUND 2: preserved import.meta.url query/hash postfixes; validation=./workflow-output/run-validation.sh; result=pass",
			].join("\n"),
		);

		const result = await runReviewRouteClassifier(cwd, {
			verdict: "continue",
			summary:
				"progress.md has 2 ROUND entries and the latest scoped clean-copy validation passed, with real source/test changes in the newest round. Another build/review route is still needed because required terminal evidence is missing: semantic-archive-guard.json/archiveLoop output and the project-only changed-file inventory required by task.md are absent, so acceptance is not yet complete.",
		});

		expect(result.data).toMatchObject({
			decision: "complete",
			reviewVerdict: "continue",
			setupBlockerEvidenceFiles: [],
			externalValidationBlockerEvidenceFiles: [],
			terminalBlockerEvidenceFiles: [],
		});
		expect(result.data.reason).toContain("semantic archive guard");
	});

	it("routes satisfied-round-minimum wording to semantic archive guard", async () => {
		const cwd = await createTempDir();
		await fs.mkdir(path.join(cwd, "workflow-output"), { recursive: true });
		await Bun.write(
			path.join(cwd, "progress.md"),
			[
				"ROUND 1: fixed dynamic asset import-meta query parsing; validation=./workflow-output/run-validation.sh; result=pass",
				"ROUND 2: preserved optimizer asset URL query/hash postfixes; validation=./workflow-output/run-validation.sh; result=pass",
			].join("\n"),
		);

		const result = await runReviewRouteClassifier(cwd, {
			verdict: "continue",
			summary:
				"progress.md has 2 lines beginning with ROUND, satisfying the declared minimum, and the latest clean-copy validation evidence under workflow-output/round-2 shows the declared command passed. Another build round is still needed because task-required terminal evidence is missing: semantic-archive-guard.json, archive output, and changed-file inventory were not found, so semanticArchiveGuard/archiveLoop have not completed as required.",
		});

		expect(result.data).toMatchObject({
			decision: "complete",
			reviewVerdict: "continue",
			setupBlockerEvidenceFiles: [],
			externalValidationBlockerEvidenceFiles: [],
			terminalBlockerEvidenceFiles: [],
		});
		expect(result.data.reason).toContain("semantic archive guard");
	});

	it("routes archive-only evidence gaps using durable progress round evidence", async () => {
		const cwd = await createTempDir();
		await fs.mkdir(path.join(cwd, "workflow-output"), { recursive: true });
		await Bun.write(
			path.join(cwd, "progress.md"),
			[
				"ROUND 1: support dynamic import.meta.url hash postfixes; validation=./workflow-output/run-validation.sh; result=pass",
				"ROUND 2: add optimize-deps asset postfix coverage; validation=./workflow-output/run-validation.sh; result=pass",
			].join("\n"),
		);

		const result = await runReviewRouteClassifier(cwd, {
			verdict: "continue",
			summary:
				"continue: progress.md contains 2 ROUND lines and the latest scoped clean-copy validation passed, but task.md also requires semanticArchiveGuard and archiveLoop evidence with a project-only changed-file inventory; no semantic-archive-guard or archive output files are present, so another build/review/archive round is needed.",
		});

		expect(result.data).toMatchObject({
			decision: "complete",
			reviewVerdict: "continue",
			setupBlockerEvidenceFiles: [],
			externalValidationBlockerEvidenceFiles: [],
			terminalBlockerEvidenceFiles: [],
		});
		expect(result.data.reason).toContain("semantic archive guard");
	});

	it("keeps building when task-required round minimum is not satisfied", async () => {
		const cwd = await createTempDir();
		await fs.mkdir(path.join(cwd, "workflow-output"), { recursive: true });
		await Bun.write(path.join(cwd, "task.md"), "Produce at least four meaningful build/review cycles.\n");
		await Bun.write(
			path.join(cwd, "progress.md"),
			[
				"ROUND 1: add first asset regression; validation=./workflow-output/run-validation.sh; result=pass",
				"ROUND 2: add second asset regression; validation=./workflow-output/run-validation.sh; result=pass",
			].join("\n"),
		);

		const result = await runReviewRouteClassifier(cwd, {
			verdict: "continue",
			summary:
				"progress.md contains 2 ROUND lines and the latest scoped clean-copy validation passed, but semanticArchiveGuard and archiveLoop evidence is missing.",
		});

		expect(result.data).toMatchObject({
			decision: "continue",
			reviewVerdict: "continue",
			setupBlockerEvidenceFiles: [],
			externalValidationBlockerEvidenceFiles: [],
			terminalBlockerEvidenceFiles: [],
		});
	});

	it("routes archive-only evidence gaps after task-required round minimum", async () => {
		const cwd = await createTempDir();
		await fs.mkdir(path.join(cwd, "workflow-output"), { recursive: true });
		await Bun.write(path.join(cwd, "task.md"), "Produce at least four meaningful build/review cycles.\n");
		await Bun.write(
			path.join(cwd, "progress.md"),
			[
				"ROUND 1: add first asset regression; validation=./workflow-output/run-validation.sh; result=pass",
				"ROUND 2: add second asset regression; validation=./workflow-output/run-validation.sh; result=pass",
				"ROUND 3: add third asset regression; validation=./workflow-output/run-validation.sh; result=pass",
				"ROUND 4: add fourth asset regression; validation=./workflow-output/run-validation.sh; result=pass",
			].join("\n"),
		);

		const result = await runReviewRouteClassifier(cwd, {
			verdict: "continue",
			summary:
				"progress.md contains 4 ROUND lines and the latest scoped clean-copy validation passed, but semanticArchiveGuard and archiveLoop evidence is missing.",
		});

		expect(result.data).toMatchObject({
			decision: "complete",
			reviewVerdict: "continue",
			setupBlockerEvidenceFiles: [],
			externalValidationBlockerEvidenceFiles: [],
			terminalBlockerEvidenceFiles: [],
		});
		expect(result.data.reason).toContain("semantic archive guard");
	});

	it("keeps building when reviewer says task-specific acceptance is not met after required rounds", async () => {
		const cwd = await createTempDir();
		await fs.mkdir(path.join(cwd, "workflow-output"), { recursive: true });
		await Bun.write(
			path.join(cwd, "task.md"),
			[
				"Produce at least eight meaningful build/review cycles.",
				"Acceptance Criteria:",
				"- Cover assets-sanitize/security edge cases before archive.",
			].join("\n"),
		);
		await Bun.write(
			path.join(cwd, "progress.md"),
			Array.from(
				{ length: 8 },
				(_, index) =>
					`ROUND ${index + 1}: completed Vite asset surface ${index + 1}; validation=./workflow-output/run-validation.sh; result=pass`,
			).join("\n"),
		);

		const result = await runReviewRouteClassifier(cwd, {
			verdict: "continue",
			summary:
				"continue: progress.md contains 8 ROUND entries and the latest clean-copy validation passed, but the task-declared assets-sanitize/security surface has no corresponding source or behavioral-test improvement in the current changes. The required semantic-archive-guard/archive evidence is also absent, so task-specific acceptance is not yet met.",
		});

		expect(result.data).toMatchObject({
			decision: "continue",
			reviewVerdict: "continue",
			setupBlockerEvidenceFiles: [],
			externalValidationBlockerEvidenceFiles: [],
			terminalBlockerEvidenceFiles: [],
		});
		expect(result.data.reason).toContain("review requested another build round");
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
