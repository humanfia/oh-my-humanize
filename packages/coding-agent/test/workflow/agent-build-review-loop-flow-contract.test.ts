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
		requiredRoundCount?: number;
		setupBlockerEvidenceFiles: string[];
		externalValidationBlockerEvidenceFiles?: string[];
		terminalBlockerEvidenceFiles?: string[];
		reviewDecisionTrailFile?: string;
		reviewVerdict?: string;
		reviewSummary?: string;
		completionSatisfiedButContinued?: boolean;
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
		state?: {
			reviewRoute?: {
				decision?: string;
				reason?: string;
				reviewVerdict?: string;
				reviewSummary?: string;
				setupBlockerEvidenceFiles?: string[];
			};
		};
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

	it("routes downstream-finalization-only continue reviews to semantic guard after required rounds", async () => {
		const cwd = await createTempDir();
		await fs.mkdir(path.join(cwd, "workflow-output"), { recursive: true });
		await Bun.write(
			path.join(cwd, "task.md"),
			[
				"Validation Command:",
				"./workflow-output/run-validation.sh",
				"Requires at least two meaningful build/review cycles.",
			].join("\n"),
		);
		await Bun.write(
			path.join(cwd, "progress.md"),
			["ROUND 1: source/test update; result=pass", "ROUND 2: docs/evidence update; result=pass"].join("\n"),
		);

		const result = await runReviewRouteClassifier(cwd, {
			verdict: "continue",
			summary:
				"Another build round is needed because the latest evidence says the semantic archive guard/final archive and post-round route selection have not been produced yet. There are 2 ROUND entries in progress.md and the latest declared validation command passed, but task-required final archive/guard evidence remains absent, so acceptance is not yet satisfied.",
		});

		expect(result.data).toMatchObject({
			decision: "complete",
			reviewVerdict: "continue",
			reason: "review requested downstream finalization rather than more build work",
		});
		await expect(Bun.file(path.join(cwd, "workflow-output", "review-route-1.json")).json()).resolves.toMatchObject({
			decision: "complete",
			reviewVerdict: "continue",
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

	it("routes repeated external pytest node blockers in summaries to reject", async () => {
		const cwd = await createTempDir();
		for (const round of [2, 3]) {
			await fs.mkdir(path.join(cwd, "workflow-output", `round-${round}`), { recursive: true });
			await Bun.write(
				path.join(cwd, "workflow-output", `round-${round}`, "validation-summary.txt"),
				[
					`Round ${round} validation summary`,
					"Declared validation command: python -m pytest tests/test_tutorial",
					"Result: fail",
					"Focused result: pass",
					"Task-scoped observation: tests/test_tutorial/test_arguments/test_envvar/test_tutorial002.py passed in the declared validation log.",
					"External blocker: the declared validation fails only in out-of-scope Rich formatting assertions in tests/test_tutorial/test_printing/test_tutorial001.py::test_cli and tests/test_tutorial/test_printing/test_tutorial002.py::test_cli. Those failures are unrelated to the envvar documentation hardening in this round.",
				].join("\n"),
			);
		}

		const result = await runReviewRouteClassifier(cwd, {
			verdict: "continue",
			summary:
				"progress.md has 3 ROUND entries, but latest validation failed with out-of-scope Rich printing assertions, so another route decision is required.",
		});

		expect(result.data).toMatchObject({
			decision: "reject",
			reviewVerdict: "continue",
			setupBlockerEvidenceFiles: [],
			externalValidationBlockerEvidenceFiles: [
				"workflow-output/round-2/validation-summary.txt",
				"workflow-output/round-3/validation-summary.txt",
			],
		});
		expect(result.data.reason).toContain("terminal validation blocker");
	});

	it("routes reviewer-declared terminal external blockers to reject without another build round", async () => {
		const cwd = await createTempDir();
		await fs.mkdir(path.join(cwd, "workflow-output", "round-2"), { recursive: true });
		await Bun.write(
			path.join(cwd, "workflow-output", "round-2", "validation-summary.txt"),
			[
				"Command: python -m pytest tests/test_tutorial",
				"Result: fail (exit code 1)",
				"External blocker: out-of-scope failures in tests/test_tutorial/test_printing/test_tutorial001.py::test_cli and tests/test_tutorial/test_printing/test_tutorial002.py::test_cli; both failures are Rich formatting expectation mismatches in printing tutorial tests, outside the envvar argument scope.",
			].join("\n"),
		);
		await Bun.write(
			path.join(cwd, "progress.md"),
			[
				"ROUND 1: documented empty envvar fallback; validation=python -m pytest tests/test_tutorial; result=fail",
				"ROUND 2: documented CLI argument precedence across multiple env vars; validation=python -m pytest tests/test_tutorial; result=fail",
			].join("\n"),
		);

		const result = await runReviewRouteClassifier(cwd, {
			verdict: "continue",
			summary:
				"progress.md has 2 lines beginning with ROUND, satisfying the contract's minimum. However the declared validation command's latest run still failed; the current failure is a terminal external validation blocker in out-of-scope printing tutorial tests (tests/test_tutorial/test_printing/test_tutorial001.py::test_cli and tests/test_tutorial/test_printing/test_tutorial002.py::test_cli), so continue for route-classifier rejection/archive rather than asking for unrelated fixes.",
		});

		expect(result.data).toMatchObject({
			decision: "reject",
			reviewVerdict: "continue",
			setupBlockerEvidenceFiles: [],
			externalValidationBlockerEvidenceFiles: ["workflow-output/round-2/validation-summary.txt"],
			terminalBlockerEvidenceFiles: ["workflow-output/round-2/validation-summary.txt"],
		});
		expect(result.data.reason).toContain("terminal validation blocker");
	});

	it("routes reviewer-declared external_blocker validation summaries to reject", async () => {
		const cwd = await createTempDir();
		await fs.mkdir(path.join(cwd, "workflow-output", "round-1"), { recursive: true });
		await Bun.write(
			path.join(cwd, "task.md"),
			[
				"Acceptance Criteria:",
				"- Complete at least three concrete semantic work packages before completion.",
				"Validation Command:",
				"./workflow-output/run-validation.sh",
			].join("\n"),
		);
		await Bun.write(
			path.join(cwd, "progress.md"),
			"ROUND 1: hardened asset URL handling; validation=./workflow-output/run-validation.sh; result=fail\n",
		);
		await Bun.write(
			path.join(cwd, "workflow-output", "round-1", "validation-summary.txt"),
			[
				"attempts:",
				"- attempt: 1",
				"  command: ./workflow-output/run-validation.sh",
				"  exit_code: 127",
				"result: fail",
				"external_blocker: create-vite build could not start because tsdown is unavailable and node_modules is missing after preflight; task rules forbid dependency bootstrapping during validation.",
			].join("\n"),
		);

		const result = await runReviewRouteClassifier(cwd, {
			verdict: "continue",
			summary:
				"progress.md has 1 line beginning with ROUND, and the task contract requires at least three concrete semantic work packages before completion. The declared validation command's latest recorded run failed with exit code 127 because create-vite build could not start: tsdown is unavailable and node_modules is missing, which is a terminal external validation blocker rather than an in-scope source bug.",
		});

		expect(result.data).toMatchObject({
			decision: "reject",
			reviewVerdict: "continue",
			setupBlockerEvidenceFiles: [],
			externalValidationBlockerEvidenceFiles: ["workflow-output/round-1/validation-summary.txt"],
			terminalBlockerEvidenceFiles: ["workflow-output/round-1/validation-summary.txt"],
		});
		expect(result.data.reason).toContain("terminal validation blocker");
	});

	it("does not route negated terminal blocker wording to reject", async () => {
		const cwd = await createTempDir();
		await fs.mkdir(path.join(cwd, "workflow-output", "round-1"), { recursive: true });
		await Bun.write(
			path.join(cwd, "task.md"),
			[
				"Produce at least twelve meaningful build/review cycles.",
				"Validation Command:",
				"./workflow-output/run-validation.sh",
			].join("\n"),
		);
		await Bun.write(
			path.join(cwd, "progress.md"),
			"ROUND 1: fixed import.meta.glob restored query extension placement before URL hashes; validation=./workflow-output/run-validation.sh; result=pass\n",
		);
		await Bun.write(
			path.join(cwd, "workflow-output", "round-1", "validation-summary.txt"),
			["attempts=1", "exit_code=0", "result=pass"].join("\n"),
		);

		const result = await runReviewRouteClassifier(cwd, {
			verdict: "continue",
			summary:
				"Continue: progress.md currently has 1 line beginning ROUND, while task.md requires at least 12 meaningful build/review cycles before archive. The declared validation command's latest recorded run passed, and no terminal external validation blocker is present, but the minimum round count and broad canary coverage are not yet satisfied.",
		});

		expect(result.data).toMatchObject({
			decision: "continue",
			reviewVerdict: "continue",
			requiredRoundCount: 12,
			setupBlockerEvidenceFiles: [],
			externalValidationBlockerEvidenceFiles: [],
			terminalBlockerEvidenceFiles: [],
		});
		expect(result.data.reason).toContain("review requested another build round");
	});

	it("does not route conditional terminal blocker acceptance language to reject", async () => {
		const cwd = await createTempDir();
		await fs.mkdir(path.join(cwd, "workflow-output", "round-1"), { recursive: true });
		await Bun.write(
			path.join(cwd, "task.md"),
			[
				"Acceptance Criteria:",
				"- Produce at least twelve meaningful build/review cycles before archive unless a terminal setup or external blocker is proven.",
				"Validation Command:",
				"./workflow-output/run-validation.sh",
			].join("\n"),
		);
		await Bun.write(
			path.join(cwd, "progress.md"),
			"ROUND 1: fixed import.meta asset URL fragment handling; validation=./workflow-output/run-validation.sh; result=pass\n",
		);
		await Bun.write(
			path.join(cwd, "workflow-output", "round-1", "validation-summary.txt"),
			["attempts=1", "exit_code=0", "result=pass"].join("\n"),
		);

		const result = await runReviewRouteClassifier(cwd, {
			verdict: "continue",
			summary:
				"Only 1 line beginning with ROUND is present in progress.md, but task.md requires at least 12 meaningful build/review cycles before archive unless a terminal setup or external blocker is proven. Latest clean-copy validation evidence under workflow-output/round-1 reports exit_code=0/result=pass, and the newest round made scoped source/test changes, so the next build round is needed to satisfy the declared minimum round count.",
		});

		expect(result.data).toMatchObject({
			decision: "continue",
			reviewVerdict: "continue",
			requiredRoundCount: 12,
			setupBlockerEvidenceFiles: [],
			externalValidationBlockerEvidenceFiles: [],
			terminalBlockerEvidenceFiles: [],
		});
		expect(result.data.reason).toContain("review requested another build round");
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

	it("routes archive-readiness-only continue reviews to downstream finalization", async () => {
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
				"progress.md has 2 ROUND entries, satisfying the declared minimum, and the latest scoped validation via workflow-output/run-validation.sh passed. The only remaining work is task-required archive completion evidence: semantic-archive-guard.json and archive output are absent, so semanticArchiveGuard/archiveLoop have not completed with the project-only changed-file inventory.",
		});

		expect(result.data).toMatchObject({
			decision: "complete",
			reviewVerdict: "continue",
			setupBlockerEvidenceFiles: [],
			externalValidationBlockerEvidenceFiles: [],
			terminalBlockerEvidenceFiles: [],
		});
		expect(result.data.reason).toContain("downstream finalization");
	});

	it("routes terminal-evidence-only continue reviews to downstream finalization", async () => {
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
				"progress.md has 2 ROUND entries and the latest scoped clean-copy validation passed, with real source/test changes in the newest round. The implementation is complete; the only missing required terminal evidence is semantic-archive-guard.json/archiveLoop output and the project-only changed-file inventory required by task.md.",
		});

		expect(result.data).toMatchObject({
			decision: "complete",
			reviewVerdict: "continue",
			setupBlockerEvidenceFiles: [],
			externalValidationBlockerEvidenceFiles: [],
			terminalBlockerEvidenceFiles: [],
		});
		expect(result.data.reason).toContain("downstream finalization");
	});

	it("routes task-complete continue reviews to downstream finalization after required rounds", async () => {
		const cwd = await createTempDir();
		await fs.mkdir(path.join(cwd, "workflow-output"), { recursive: true });
		await Bun.write(
			path.join(cwd, "task.md"),
			[
				"Complete at least three meaningful build/review cycles.",
				"Validation Command:",
				"./workflow-output/run-validation.sh",
			].join("\n"),
		);
		await Bun.write(
			path.join(cwd, "progress.md"),
			[
				"ROUND 1: fixed progress evidence capture; validation=./workflow-output/run-validation.sh; result=pass",
				"ROUND 2: added transcript regression coverage; validation=./workflow-output/run-validation.sh; result=pass",
				"ROUND 3: tightened output artifact guard; validation=./workflow-output/run-validation.sh; result=pass",
			].join("\n"),
		);

		const result = await runReviewRouteClassifier(cwd, {
			verdict: "continue",
			summary:
				"The task is complete: progress.md has 3 lines beginning with ROUND, satisfying the contract's three concrete semantic work packages; the latest declared validation evidence records ./workflow-output/run-validation.sh passing; and round 3 added real source/test/evidence improvements without disallowed task-specific byproducts. Downstream finalization/archive artifacts are not required for this review-route completion decision.",
		});

		expect(result.data).toMatchObject({
			decision: "complete",
			reviewVerdict: "continue",
			requiredRoundCount: 3,
			completedRoundCount: 3,
			completionSatisfiedButContinued: true,
			setupBlockerEvidenceFiles: [],
			externalValidationBlockerEvidenceFiles: [],
			terminalBlockerEvidenceFiles: [],
		});
		expect(result.data.reason).toContain("completion satisfied");
	});

	it("routes satisfied-round-minimum finalization-only reviews to downstream finalization", async () => {
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
				"progress.md has 2 lines beginning with ROUND, satisfying the declared minimum, and the latest clean-copy validation evidence under workflow-output/round-2 shows the declared command passed. No more build work is needed; only task-required terminal evidence is missing: semantic-archive-guard.json, archive output, and changed-file inventory were not found, so semanticArchiveGuard/archiveLoop have not completed as required.",
		});

		expect(result.data).toMatchObject({
			decision: "complete",
			reviewVerdict: "continue",
			setupBlockerEvidenceFiles: [],
			externalValidationBlockerEvidenceFiles: [],
			terminalBlockerEvidenceFiles: [],
		});
		expect(result.data.reason).toContain("downstream finalization");
	});

	it("does not invent a round minimum when the task omits one", async () => {
		const cwd = await createTempDir();
		await fs.mkdir(path.join(cwd, "workflow-output"), { recursive: true });
		await Bun.write(path.join(cwd, "task.md"), "Validation Command:\n./workflow-output/run-validation.sh\n");
		await Bun.write(
			path.join(cwd, "progress.md"),
			"ROUND 1: added focused regression coverage; validation=./workflow-output/run-validation.sh; result=pass\n",
		);

		const result = await runReviewRouteClassifier(cwd, {
			verdict: "complete",
			summary:
				"No minimum round count is declared; progress.md has 1 ROUND line, the latest declared validation command passed, and the retained diff is task-scoped.",
		});

		expect(result.data).toMatchObject({
			decision: "complete",
			reviewVerdict: "complete",
			completedRoundCount: 1,
		});
		expect(result.data.requiredRoundCount).toBeUndefined();
		await expect(
			Bun.file(path.join(cwd, "workflow-output", "review-route-1.json")).json(),
		).resolves.not.toHaveProperty("requiredRoundCount");
	});

	it("routes archive-only continue evidence gaps to downstream finalization", async () => {
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
				"continue: progress.md contains 2 ROUND lines and the latest scoped clean-copy validation passed, but task.md also requires semanticArchiveGuard and archiveLoop evidence with a project-only changed-file inventory; no semantic-archive-guard or archive output files are present, so only the downstream archive nodes remain.",
		});

		expect(result.data).toMatchObject({
			decision: "complete",
			reviewVerdict: "continue",
			setupBlockerEvidenceFiles: [],
			externalValidationBlockerEvidenceFiles: [],
			terminalBlockerEvidenceFiles: [],
		});
		expect(result.data.reason).toContain("downstream finalization");
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

	it("parses task-required round counts above ten before archive routing", async () => {
		const cwd = await createTempDir();
		await fs.mkdir(path.join(cwd, "workflow-output"), { recursive: true });
		await Bun.write(path.join(cwd, "task.md"), "Produce at least twelve meaningful build/review cycles.\n");
		await Bun.write(
			path.join(cwd, "progress.md"),
			Array.from(
				{ length: 4 },
				(_, index) =>
					`ROUND ${index + 1}: completed scoped implementation surface ${index + 1}; validation=./workflow-output/run-validation.sh; result=pass`,
			).join("\n"),
		);

		const result = await runReviewRouteClassifier(cwd, {
			verdict: "continue",
			summary:
				"progress.md contains 4 ROUND lines and the latest scoped clean-copy validation passed, but semanticArchiveGuard and archiveLoop evidence is missing.",
		});

		expect(result.data).toMatchObject({
			decision: "continue",
			reviewVerdict: "continue",
			requiredRoundCount: 12,
			setupBlockerEvidenceFiles: [],
			externalValidationBlockerEvidenceFiles: [],
			terminalBlockerEvidenceFiles: [],
		});
	});

	it("routes archive-only continue gaps after task-required round minimum to downstream finalization", async () => {
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
		expect(result.data.reason).toContain("downstream finalization");
	});

	it("routes archive-only next-route continue wording after task-required round minimum to downstream finalization", async () => {
		const cwd = await createTempDir();
		await fs.mkdir(path.join(cwd, "workflow-output"), { recursive: true });
		await Bun.write(path.join(cwd, "task.md"), "Produce at least twelve meaningful build/review cycles.\n");
		await Bun.write(
			path.join(cwd, "progress.md"),
			Array.from(
				{ length: 14 },
				(_, index) =>
					`ROUND ${index + 1}: completed Vite asset surface ${index + 1}; validation=./workflow-output/run-validation.sh; result=pass`,
			).join("\n"),
		);

		const result = await runReviewRouteClassifier(cwd, {
			verdict: "continue",
			summary:
				"continue: progress.md has 14 ROUND entries and the latest round-14 validation summary reports exit_code=0, but the task-required completion evidence is still incomplete because semantic-archive-guard.json and archive output are absent. Another build/review route is needed to produce semanticArchiveGuard/archiveLoop evidence before the result can be accepted as complete.",
		});

		expect(result.data).toMatchObject({
			decision: "complete",
			reviewVerdict: "continue",
			requiredRoundCount: 12,
			setupBlockerEvidenceFiles: [],
			externalValidationBlockerEvidenceFiles: [],
			terminalBlockerEvidenceFiles: [],
		});
		expect(result.data.reason).toContain("downstream finalization");
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

	it("keeps building when archive evidence is missing but reviewer also identifies scope gaps", async () => {
		const cwd = await createTempDir();
		await fs.mkdir(path.join(cwd, "workflow-output"), { recursive: true });
		await Bun.write(
			path.join(cwd, "task.md"),
			[
				"Produce at least eight meaningful build/review cycles.",
				"Allowed paths: src/allowed.ts, tests/allowed.test.ts, workflow-output/**, progress.md.",
			].join("\n"),
		);
		await Bun.write(
			path.join(cwd, "progress.md"),
			Array.from(
				{ length: 9 },
				(_, index) =>
					`ROUND ${index + 1}: completed scoped implementation surface ${index + 1}; validation=./workflow-output/run-validation.sh; result=pass`,
			).join("\n"),
		);

		const result = await runReviewRouteClassifier(cwd, {
			verdict: "continue",
			summary:
				"progress.md has 9 ROUND entries and the latest workflow-output/round-9 validation passed, but completion is not coherent yet: the required semanticArchiveGuard/archiveLoop evidence and project-only changed-file inventory are missing, and the current diff modifies src/out-of-scope.ts outside task.md's declared allowed paths. Another build round is needed to resolve the scope/evidence gaps rather than archive.",
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

	it("requires repair when progress uses non-positive round numbers", async () => {
		const cwd = await createTempDir();
		await fs.mkdir(path.join(cwd, "workflow-output", "round-0"), { recursive: true });
		await Bun.write(
			path.join(cwd, "progress.md"),
			"ROUND 0: added focused regression coverage; validation=./workflow-output/run-validation.sh; result=pass\n",
		);
		await Bun.write(path.join(cwd, "workflow-output", "round-0", "validation-stdout.txt"), "ok\n");
		await Bun.write(path.join(cwd, "workflow-output", "round-0", "validation-stderr.txt"), "\n");

		const result = await runSemanticArchiveGuard(cwd);

		expect(result.verdict).toBe("REPAIR");
		const finding = result.data.findings.find(item => item.file === "progress.md");
		expect(finding).toMatchObject({
			reason: "progress uses non-positive workflow round numbers",
		});
	});

	it("requires repair when a build round creates archive-owned tuple state early", async () => {
		const cwd = await createTempDir();
		await fs.mkdir(path.join(cwd, "workflow-output", "round-1"), { recursive: true });
		await Bun.write(
			path.join(cwd, "workflow-output", "tuple-state.json"),
			JSON.stringify({ tuple_id: "EARLY", verdict: "pass" }),
		);

		const result = await runSemanticArchiveGuard(cwd);

		expect(result.verdict).toBe("REPAIR");
		const finding = result.data.findings.find(item => item.file === "workflow-output/tuple-state.json");
		expect(finding).toMatchObject({
			reason: "workflow finalization artifact was created before archiveLoop",
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

	it("requires repair when validation reruns overwrite round evidence instead of preserving attempt logs", async () => {
		const cwd = await createTempDir();
		await fs.mkdir(path.join(cwd, "workflow-output", "round-1"), { recursive: true });
		await Bun.write(
			path.join(cwd, "progress.md"),
			"ROUND 1: changed asset tests; validation=./workflow-output/run-validation.sh; result=fail\n",
		);
		await Bun.write(
			path.join(cwd, "workflow-output", "round-1", "validation-stdout.txt"),
			"latest validation stdout\n",
		);
		await Bun.write(
			path.join(cwd, "workflow-output", "round-1", "validation-stderr.txt"),
			"latest validation stderr\n",
		);
		await Bun.write(
			path.join(cwd, "workflow-output", "round-1", "validation-summary.txt"),
			"I reran validation after an earlier validation failure and overwrote the validation stdout/stderr logs.\n",
		);

		const result = await runSemanticArchiveGuard(cwd);

		expect(result.verdict).toBe("REPAIR");
		const finding = result.data.findings.find(
			item => item.reason === "validation rerun evidence is missing immutable attempt stdout/stderr logs",
		);
		expect(finding).toMatchObject({
			file: "workflow-output/round-1",
		});
	});

	it("requires repair when the final validation attempt only has canonical logs", async () => {
		const cwd = await createTempDir();
		await fs.mkdir(path.join(cwd, "workflow-output", "round-1"), { recursive: true });
		await Bun.write(
			path.join(cwd, "progress.md"),
			"ROUND 1: changed asset tests; validation=./workflow-output/run-validation.sh; result=pass\n",
		);
		await Bun.write(
			path.join(cwd, "workflow-output", "round-1", "validation-attempt-1-stdout.txt"),
			"first attempt stdout\n",
		);
		await Bun.write(
			path.join(cwd, "workflow-output", "round-1", "validation-attempt-1-stderr.txt"),
			"first attempt stderr\n",
		);
		await Bun.write(path.join(cwd, "workflow-output", "round-1", "validation-stdout.txt"), "latest stdout\n");
		await Bun.write(path.join(cwd, "workflow-output", "round-1", "validation-stderr.txt"), "latest stderr\n");
		await Bun.write(
			path.join(cwd, "workflow-output", "round-1", "validation-summary.txt"),
			[
				"Round 1 validation attempts",
				"",
				"Attempt 1:",
				"- Logs: workflow-output/round-1/validation-attempt-1-stdout.txt and workflow-output/round-1/validation-attempt-1-stderr.txt",
				"- Result: fail",
				"",
				"Attempt 2:",
				"- Logs: workflow-output/round-1/validation-stdout.txt and workflow-output/round-1/validation-stderr.txt",
				"- Result: pass",
			].join("\n"),
		);

		const result = await runSemanticArchiveGuard(cwd);

		expect(result.verdict).toBe("REPAIR");
		const finding = result.data.findings.find(
			item => item.reason === "validation rerun evidence is missing immutable attempt stdout/stderr logs",
		);
		expect(finding).toMatchObject({
			file: "workflow-output/round-1",
			missingFiles: [
				"workflow-output/round-1/validation-attempt-2-stdout.txt",
				"workflow-output/round-1/validation-attempt-2-stderr.txt",
			],
		});
	});

	it("rejects archiving when the final validation attempt only has canonical logs", async () => {
		const cwd = await createTempDir();
		await fs.mkdir(path.join(cwd, "workflow-output", "round-1"), { recursive: true });
		await Bun.write(
			path.join(cwd, "task.md"),
			"Validation Command:\n./workflow-output/run-validation.sh\n\nNo-Code Allowed: yes\n",
		);
		await Bun.write(
			path.join(cwd, "progress.md"),
			"ROUND 1: changed asset tests; validation=./workflow-output/run-validation.sh; result=pass\n",
		);
		await Bun.write(path.join(cwd, "workflow-output", "round-1", "validation-attempt-1-stdout.txt"), "fail\n");
		await Bun.write(path.join(cwd, "workflow-output", "round-1", "validation-attempt-1-stderr.txt"), "err\n");
		await Bun.write(path.join(cwd, "workflow-output", "round-1", "validation-stdout.txt"), "pass\n");
		await Bun.write(path.join(cwd, "workflow-output", "round-1", "validation-stderr.txt"), "\n");
		await Bun.write(
			path.join(cwd, "workflow-output", "round-1", "validation-summary.txt"),
			[
				"Attempt 1:",
				"- Logs: workflow-output/round-1/validation-attempt-1-stdout.txt and workflow-output/round-1/validation-attempt-1-stderr.txt",
				"Attempt 2:",
				"- Logs: workflow-output/round-1/validation-stdout.txt and workflow-output/round-1/validation-stderr.txt",
			].join("\n"),
		);

		await expect(runArchiveLoop(cwd, { decision: "complete" })).rejects.toThrow(
			"validation rerun evidence lacks immutable attempt logs",
		);
	});

	it("rejects archiving when progress uses non-positive round numbers", async () => {
		const cwd = await createTempDir();
		await fs.mkdir(path.join(cwd, "workflow-output", "round-0"), { recursive: true });
		await Bun.write(path.join(cwd, "task.md"), "Validation Command:\ntrue\n\nNo-Code Allowed: yes\n");
		await Bun.write(
			path.join(cwd, "progress.md"),
			"ROUND 0: changed allowed behavior; validation=true; result=pass\n",
		);
		await Bun.write(path.join(cwd, "workflow-output", "round-0", "validation-stdout.txt"), "ok\n");
		await Bun.write(path.join(cwd, "workflow-output", "round-0", "validation-stderr.txt"), "\n");

		await expect(runArchiveLoop(cwd, { decision: "complete" })).rejects.toThrow(
			"progress.md uses non-positive workflow round numbers",
		);
	});

	it("rejects archiving when tuple-state already exists before archiveLoop writes it", async () => {
		const cwd = await createTempDir();
		await fs.mkdir(path.join(cwd, "workflow-output", "round-1"), { recursive: true });
		await Bun.write(path.join(cwd, "task.md"), "Validation Command:\ntrue\n\nNo-Code Allowed: yes\n");
		await Bun.write(
			path.join(cwd, "progress.md"),
			"ROUND 1: changed allowed behavior; validation=true; result=pass\n",
		);
		await Bun.write(path.join(cwd, "workflow-output", "round-1", "validation-stdout.txt"), "ok\n");
		await Bun.write(path.join(cwd, "workflow-output", "round-1", "validation-stderr.txt"), "\n");
		await Bun.write(path.join(cwd, "workflow-output", "tuple-state.json"), JSON.stringify({ verdict: "pass" }));

		await expect(runArchiveLoop(cwd, { decision: "complete" })).rejects.toThrow(
			"archive-owned finalization artifacts already exist",
		);
	});

	it("requires repair when changed project files escape task allowed paths", async () => {
		const cwd = await createTempDir();
		await initGitRepo(cwd);
		await fs.mkdir(path.join(cwd, "src"), { recursive: true });
		await Bun.write(
			path.join(cwd, "task.md"),
			["Validation Command:", "true", "Allowed paths: src/allowed.ts, workflow-output/**, progress.md."].join("\n"),
		);
		await Bun.write(path.join(cwd, "src", "out-of-scope.ts"), "export const escaped = true;\n");

		const result = await runSemanticArchiveGuard(cwd);

		expect(result.verdict).toBe("REPAIR");
		const finding = result.data.findings.find(item => item.file === "src/out-of-scope.ts");
		expect(finding).toMatchObject({
			reason: "changed file is outside task allowed paths",
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

	it("rejects archiving validation reruns without immutable attempt logs", async () => {
		const cwd = await createTempDir();
		await fs.mkdir(path.join(cwd, "workflow-output", "round-1"), { recursive: true });
		await Bun.write(
			path.join(cwd, "task.md"),
			"Validation Command:\n./workflow-output/run-validation.sh\n\nNo-Code Allowed: yes\n",
		);
		await Bun.write(
			path.join(cwd, "progress.md"),
			"ROUND 1: changed asset tests; validation=./workflow-output/run-validation.sh; result=fail\n",
		);
		await Bun.write(
			path.join(cwd, "workflow-output", "round-1", "validation-stdout.txt"),
			"latest validation stdout\n",
		);
		await Bun.write(
			path.join(cwd, "workflow-output", "round-1", "validation-stderr.txt"),
			"latest validation stderr\n",
		);
		await Bun.write(
			path.join(cwd, "workflow-output", "round-1", "validation-summary.txt"),
			"The builder reran validation after an earlier validation failure but only kept the latest stdout/stderr.\n",
		);

		await expect(runArchiveLoop(cwd, { decision: "complete" })).rejects.toThrow(
			"validation rerun evidence lacks immutable attempt logs",
		);
	});

	it("rejects archiving changed files outside task allowed paths", async () => {
		const cwd = await createTempDir();
		await initGitRepo(cwd);
		await fs.mkdir(path.join(cwd, "src"), { recursive: true });
		await fs.mkdir(path.join(cwd, "workflow-output", "round-1"), { recursive: true });
		await Bun.write(
			path.join(cwd, "task.md"),
			["Validation Command:", "true", "Allowed paths: src/allowed.ts, workflow-output/**, progress.md."].join("\n"),
		);
		await Bun.write(
			path.join(cwd, "progress.md"),
			"ROUND 1: changed allowed behavior; validation=true; result=pass\n",
		);
		await Bun.write(path.join(cwd, "workflow-output", "round-1", "validation-stdout.txt"), "ok\n");
		await Bun.write(path.join(cwd, "workflow-output", "round-1", "validation-stderr.txt"), "\n");
		await Bun.write(path.join(cwd, "src", "out-of-scope.ts"), "export const escaped = true;\n");

		await expect(runArchiveLoop(cwd, { decision: "complete" })).rejects.toThrow(
			"changed files are outside task allowed paths",
		);
	});

	it("rejects archiving a complete route whose reviewer still requests another build round", async () => {
		const cwd = await createTempDir();
		await fs.mkdir(path.join(cwd, "workflow-output", "round-1"), { recursive: true });
		await Bun.write(path.join(cwd, "task.md"), "Validation Command:\ntrue\n\nNo-Code Allowed: yes\n");
		await Bun.write(
			path.join(cwd, "progress.md"),
			"ROUND 1: changed allowed behavior; validation=true; result=pass\n",
		);
		await Bun.write(path.join(cwd, "workflow-output", "round-1", "validation-stdout.txt"), "ok\n");
		await Bun.write(path.join(cwd, "workflow-output", "round-1", "validation-stderr.txt"), "\n");

		await expect(
			runArchiveLoop(cwd, {
				decision: "complete",
				reviewVerdict: "continue",
				reviewSummary:
					"Validation passed, but another build round is needed to resolve scope/evidence gaps before archive.",
			}),
		).rejects.toThrow("review route still requests build or repair work");
	});

	it("writes normalized terminal tuple-state fields for completed archives", async () => {
		const cwd = await createTempDir();
		await fs.mkdir(path.join(cwd, "workflow-output", "round-1"), { recursive: true });
		await Bun.write(
			path.join(cwd, "task.md"),
			"Tuple: AGENT-LOOP-TUPLE-1\n\nValidation Command:\ntrue\n\nNo-Code Allowed: yes\n",
		);
		await Bun.write(
			path.join(cwd, "progress.md"),
			"ROUND 1: changed allowed behavior; validation=true; result=pass\n",
		);
		await Bun.write(path.join(cwd, "workflow-output", "round-1", "validation-stdout.txt"), "ok\n");
		await Bun.write(path.join(cwd, "workflow-output", "round-1", "validation-stderr.txt"), "\n");

		await runArchiveLoop(cwd, {
			decision: "complete",
			reason: "review accepted the completed project work",
			reviewVerdict: "complete",
		});

		await expect(Bun.file(path.join(cwd, "workflow-output", "tuple-state.json")).json()).resolves.toMatchObject({
			flow: "agent-build-review-loop",
			tuple_id: "AGENT-LOOP-TUPLE-1",
			status: "completed",
			terminal: true,
			verdict: "complete",
			evidence_contract_verdict: "READY",
			final_artifact: "workflow-output/final-agent-loop-archive.md",
			review_decision: "complete",
			review_verdict: "complete",
		});
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
		await expect(Bun.file(path.join(cwd, "workflow-output", "tuple-state.json")).json()).resolves.toMatchObject({
			flow: "agent-build-review-loop",
			status: "rejected",
			terminal: true,
			verdict: "reject",
			evidence_contract_verdict: "REPAIR",
			final_artifact: "workflow-output/final-agent-loop-reject.md",
		});
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
		await expect(Bun.file(path.join(cwd, "workflow-output", "tuple-state.json")).json()).resolves.toMatchObject({
			flow: "agent-build-review-loop",
			status: "rejected",
			terminal: true,
			verdict: "reject",
			evidence_contract_verdict: "REPAIR",
			final_artifact: "workflow-output/final-agent-loop-reject.md",
		});
	});

	it("reserves review-route artifacts for the classifier node", async () => {
		const prompt = await Bun.file(
			path.resolve(
				import.meta.dir,
				"../../examples/workflow/experimental/agent-build-review-loop/agent-build-review-loop/prompts/build-round.md",
			),
		).text();

		expect(prompt).toContain("workflow-output/review-route-<n>.json");
		expect(prompt).toContain("classifyReviewRoute");
		expect(prompt).toContain("must not create");
	});

	it("requires immutable validation attempt logs when a build round reruns validation", async () => {
		const prompt = await Bun.file(
			path.resolve(
				import.meta.dir,
				"../../examples/workflow/experimental/agent-build-review-loop/agent-build-review-loop/prompts/build-round.md",
			),
		).text();

		expect(prompt).toContain("validation-attempt-<k>-stdout.txt");
		expect(prompt).toContain("validation-attempt-<k>-stderr.txt");
		expect(prompt).toContain("must not overwrite");
		expect(prompt).toContain("including the final/latest attempt");
		expect(prompt).toContain("Canonical latest logs do not count");
	});

	it("keeps downstream finalization artifacts out of reviewer-triggered build work", async () => {
		const prompt = await Bun.file(
			path.resolve(
				import.meta.dir,
				"../../examples/workflow/experimental/agent-build-review-loop/agent-build-review-loop/prompts/review-round.md",
			),
		).text();

		expect(prompt).toContain("Do not return `continue` merely because finalization artifacts");
		expect(prompt).toContain("produced by downstream workflow nodes");
		expect(prompt).toContain("return `complete`");
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
	reviewRoute: {
		decision?: string;
		reason?: string;
		reviewVerdict?: string;
		reviewSummary?: string;
		setupBlockerEvidenceFiles?: string[];
	} = { decision: "reject" },
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

async function initGitRepo(cwd: string): Promise<void> {
	const proc = Bun.spawn(["git", "init"], {
		cwd,
		stdout: "ignore",
		stderr: "ignore",
	});
	const exitCode = await proc.exited;
	if (exitCode !== 0) throw new Error(`git init failed in ${cwd}`);
}
