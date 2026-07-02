import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

interface WorkflowActivationOutput {
	verdict?: string;
	summary?: string;
}

interface WorkflowActivation {
	nodeId: string;
	status: string;
	output?: WorkflowActivationOutput;
}

interface WorkflowContext {
	activation: {
		id: string;
	};
	completedActivations: WorkflowActivation[];
	state?: {
		validation?: {
			status?: string;
			docsExitCode?: number;
			validationExitCode?: number;
			validationStdoutPath?: string;
			validationStderrPath?: string;
		};
		validationStartup?: {
			status?: string;
			docsExitCode?: number;
			validationExitCode?: number;
			outputPath?: string;
		};
		patch?: {
			changed_files?: string[];
			rollback_notes?: string[];
			resolved_review_feedback?: string[];
		};
		auditDigest?: Record<string, unknown>;
		audit?: {
			status?: string;
			smallestCoherentRepair?: {
				decision?: string;
				changedFileTargets?: string[];
				patchRequired?: boolean;
			};
			selectedRepair?: {
				changedFileTargets?: string[];
			};
			selectedRepairPlan?: {
				changedFileTargets?: string[];
			};
			selectedRepairTargets?: Array<{
				id?: string;
				changedFileTargets?: string[];
			}>;
			selectedSmallestCoherentRepair?: {
				changedFileTargets?: string[];
			};
		};
		review?: string;
	};
}

interface ScriptResult {
	summary: string;
	statePatch?: Array<{
		op: "set";
		path: string;
		value: Record<string, unknown>;
	}>;
}

const ScriptFunctionConstructor = Object.getPrototypeOf(async () => {}).constructor as new (
	workflowContextName: string,
	code: string,
) => (workflowContext: WorkflowContext) => Promise<ScriptResult>;

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("documentation-audit flow contract", () => {
	it("fails closed when consolidation ignores actionable lane findings", async () => {
		const cwd = await createGitRepo();

		await expect(
			runScriptFile(cwd, "guard-review-repair.js", {
				auditDigest: {
					apiDocsAudit: {
						source: "apiDocsAudit",
						excerpt: JSON.stringify({
							status: "actionable_missing_contract",
							finding: "dependency security overrides need a public docs contract",
						}),
					},
					tutorialAudit: {
						source: "tutorialAudit",
						excerpt: JSON.stringify({
							verdict: "docs_gap_patch_recommended",
							targets: ["docs/en/docs/advanced/testing-dependencies.md"],
						}),
					},
					examplesAudit: {
						source: "examplesAudit",
						excerpt: JSON.stringify({
							repair_needed: true,
							targets: ["docs_src/dependency_overrides/tutorial001.py"],
						}),
					},
				},
				audit: {
					status: "complete_no_patch_recommended",
					smallestCoherentRepair: {
						decision: "no_code_no_change",
						changedFileTargets: [],
						patchRequired: false,
					},
				},
				patch: {
					changed_files: [],
					rollback_notes: [],
					resolved_review_feedback: [],
				},
				review: "No previous documentation review yet.",
			}),
		).rejects.toThrow(/consolidated documentation audit selected no-patch despite actionable lane findings/iu);
	});

	it("fails closed when selectedRepair targets are not covered by the docs patch", async () => {
		const cwd = await createGitRepo();
		await fs.mkdir(path.join(cwd, "docs"), { recursive: true });
		await Bun.write(path.join(cwd, "docs/a.md"), "old a\n");
		await Bun.write(path.join(cwd, "docs/b.md"), "old b\n");
		await runCommand(["git", "add", "docs/a.md", "docs/b.md"], cwd);
		await runCommand(["git", "commit", "-m", "baseline"], cwd);
		await Bun.write(path.join(cwd, "docs/a.md"), "new a\n");

		await expect(
			runScriptFile(cwd, "guard-review-repair.js", {
				audit: {
					selectedRepair: {
						changedFileTargets: ["docs/a.md", "docs/b.md"],
					},
				},
				patch: {
					changed_files: ["docs/a.md"],
					rollback_notes: ["Restore docs/a.md."],
					resolved_review_feedback: [],
				},
				review: "No previous documentation review yet.",
			}),
		).rejects.toThrow(/documentation patch did not cover selected audit targets.*docs\/b\.md/iu);
	});

	it("fails closed when a docs patch omits selected audit targets", async () => {
		const cwd = await createGitRepo();
		await fs.mkdir(path.join(cwd, "docs"), { recursive: true });
		await Bun.write(path.join(cwd, "docs/a.md"), "old a\n");
		await Bun.write(path.join(cwd, "docs/b.md"), "old b\n");
		await runCommand(["git", "add", "docs/a.md", "docs/b.md"], cwd);
		await runCommand(["git", "commit", "-m", "baseline"], cwd);
		await Bun.write(path.join(cwd, "docs/a.md"), "new a\n");

		await expect(
			runScriptFile(cwd, "guard-review-repair.js", {
				audit: {
					selectedSmallestCoherentRepair: {
						changedFileTargets: ["docs/a.md", "docs/b.md", "workflow-output/documentation-audit-repair.md"],
					},
				},
				patch: {
					changed_files: ["docs/a.md"],
					rollback_notes: ["Restore docs/a.md."],
					resolved_review_feedback: [],
				},
				review: "No previous documentation review yet.",
			}),
		).rejects.toThrow(/documentation patch did not cover selected audit targets.*docs\/b\.md/iu);
	});

	it("accepts docs patches that cover selected audit targets", async () => {
		const cwd = await createGitRepo();
		await fs.mkdir(path.join(cwd, "docs"), { recursive: true });
		await Bun.write(path.join(cwd, "docs/a.md"), "old a\n");
		await Bun.write(path.join(cwd, "docs/b.md"), "old b\n");
		await runCommand(["git", "add", "docs/a.md", "docs/b.md"], cwd);
		await runCommand(["git", "commit", "-m", "baseline"], cwd);
		await Bun.write(path.join(cwd, "docs/a.md"), "new a\n");
		await Bun.write(path.join(cwd, "docs/b.md"), "new b\n");

		const result = await runScriptFile(cwd, "guard-review-repair.js", {
			audit: {
				selectedSmallestCoherentRepair: {
					changedFileTargets: ["docs/a.md", "docs/b.md", "workflow-output/documentation-audit-repair.md"],
				},
			},
			patch: {
				changed_files: ["docs/a.md", "docs/b.md"],
				rollback_notes: ["Restore docs/a.md and docs/b.md."],
				resolved_review_feedback: [],
			},
			review: "No previous documentation review yet.",
		});
		const reviewRepair = result.statePatch?.find(patch => patch.path === "/reviewRepair")?.value;

		expect(result.summary).toBe("no prior continue review feedback requires repair evidence");
		expect(reviewRepair).toMatchObject({
			status: "pass",
			selectedAuditTargetsCovered: true,
			selectedAuditTargets: ["docs/a.md", "docs/b.md"],
		});
	});

	it("accepts docs patches that cover selectedRepairPlan targets", async () => {
		const cwd = await createGitRepo();
		await fs.mkdir(path.join(cwd, "docs"), { recursive: true });
		await Bun.write(path.join(cwd, "docs/security.md"), "old security\n");
		await Bun.write(path.join(cwd, "src/security.py"), "old source\n");
		await runCommand(["git", "add", "docs/security.md", "src/security.py"], cwd);
		await runCommand(["git", "commit", "-m", "baseline"], cwd);
		await Bun.write(path.join(cwd, "docs/security.md"), "new security\n");
		await Bun.write(path.join(cwd, "src/security.py"), "new source\n");

		const result = await runScriptFile(cwd, "guard-review-repair.js", {
			audit: {
				selectedRepairPlan: {
					changedFileTargets: ["docs/security.md", "src/security.py"],
				},
			},
			patch: {
				changed_files: ["docs/security.md", "src/security.py"],
				rollback_notes: ["Restore docs/security.md and src/security.py."],
				resolved_review_feedback: [],
			},
			review: "No previous documentation review yet.",
		});
		const reviewRepair = result.statePatch?.find(patch => patch.path === "/reviewRepair")?.value;

		expect(result.summary).toBe("no prior continue review feedback requires repair evidence");
		expect(reviewRepair).toMatchObject({
			status: "pass",
			selectedAuditTargetsCovered: true,
			selectedAuditTargets: ["docs/security.md", "src/security.py"],
		});
		const guard = await Bun.file(path.join(cwd, "workflow-output/documentation-review-repair.md")).text();
		expect(guard).toContain("- docs/security.md");
		expect(guard).not.toContain("did not declare selected project targets");
	});

	it("accepts docs patches that cover selectedRepairTargets entries", async () => {
		const cwd = await createGitRepo();
		await fs.mkdir(path.join(cwd, "docs/en/docs/tutorial/security"), { recursive: true });
		await fs.mkdir(path.join(cwd, "fastapi/security"), { recursive: true });
		await Bun.write(path.join(cwd, "docs/en/docs/tutorial/security/index.md"), "old tutorial\n");
		await Bun.write(path.join(cwd, "fastapi/security/api_key.py"), "old docstrings\n");
		await runCommand(["git", "add", "docs/en/docs/tutorial/security/index.md", "fastapi/security/api_key.py"], cwd);
		await runCommand(["git", "commit", "-m", "baseline"], cwd);
		await Bun.write(path.join(cwd, "docs/en/docs/tutorial/security/index.md"), "new tutorial\n");
		await Bun.write(path.join(cwd, "fastapi/security/api_key.py"), "new docstrings\n");

		const result = await runScriptFile(cwd, "guard-review-repair.js", {
			audit: {
				selectedRepairTargets: [
					{
						id: "api-key-reference",
						changedFileTargets: ["fastapi/security/api_key.py"],
					},
					{
						id: "security-tutorial-bridge",
						changedFileTargets: ["docs/en/docs/tutorial/security/index.md"],
					},
				],
			},
			patch: {
				changed_files: ["fastapi/security/api_key.py", "docs/en/docs/tutorial/security/index.md"],
				rollback_notes: ["Restore API key docstrings and tutorial bridge."],
				resolved_review_feedback: [],
			},
			review: "No previous documentation review yet.",
		});
		const reviewRepair = result.statePatch?.find(patch => patch.path === "/reviewRepair")?.value;

		expect(result.summary).toBe("no prior continue review feedback requires repair evidence");
		expect(reviewRepair).toMatchObject({
			status: "pass",
			selectedAuditTargetsCovered: true,
			selectedAuditTargets: ["docs/en/docs/tutorial/security/index.md", "fastapi/security/api_key.py"],
		});
		const guard = await Bun.file(path.join(cwd, "workflow-output/documentation-review-repair.md")).text();
		expect(guard).toContain("- docs/en/docs/tutorial/security/index.md");
		expect(guard).toContain("- fastapi/security/api_key.py");
		expect(guard).not.toContain("did not declare selected project targets");
	});

	it("archives accepted docs repairs when task validation has the same startable baseline failure", async () => {
		const cwd = await createTempDir();
		await fs.mkdir(path.join(cwd, "workflow-output"), { recursive: true });
		await fs.mkdir(path.join(cwd, "workflow-output/omh-runtime/artifacts/activation-8"), { recursive: true });
		await fs.mkdir(path.join(cwd, "workflow-output/omh-runtime/artifacts/activation-12"), { recursive: true });
		await Bun.write(
			path.join(cwd, "task.md"),
			[
				"Objective: repair copyable docs examples.",
				"Validation Command: python -m pytest tests/test_cli.py",
				"Docs Command: python -m py_compile src/flask/app.py",
				"",
			].join("\n"),
		);
		await Bun.write(
			path.join(cwd, "workflow-output/omh-runtime/artifacts/activation-8/1-consolidateAudit.md"),
			"Consolidated finding: docs/config.rst needs a copyable example repair.\n",
		);
		await Bun.write(
			path.join(cwd, "workflow-output/documentation-patch.md"),
			[
				"# Documentation Patch Evidence",
				"",
				"## Patch rationale",
				"",
				"- docs/config.rst: added the missing copyable example.",
				"",
			].join("\n"),
		);
		await Bun.write(
			path.join(cwd, "workflow-output/omh-runtime/artifacts/activation-12/1-consistencyReview.md"),
			"verdict finish\nThe docs repair addresses the copyable example feedback.\n",
		);
		await Bun.write(
			path.join(cwd, "workflow-output/documentation-validation-startup.md"),
			validationEvidence("python -m pytest tests/test_cli.py", 2, "ImportError: cannot import name 'notset'"),
		);
		await Bun.write(
			path.join(cwd, "workflow-output/documentation-validation.md"),
			validationEvidence("python -m pytest tests/test_cli.py", 2, "ImportError: cannot import name 'notset'"),
		);
		await Bun.write(
			path.join(cwd, "workflow-output/validation-stdout.txt"),
			"ImportError: cannot import name 'notset'",
		);
		await Bun.write(path.join(cwd, "workflow-output/validation-stderr.txt"), "");

		const result = await runArchiveScript(cwd, {
			validationStartup: {
				status: "startable-command-failed",
				docsExitCode: 0,
				validationExitCode: 2,
				outputPath: "workflow-output/documentation-validation-startup.md",
			},
			validation: {
				status: "fail",
				docsExitCode: 0,
				validationExitCode: 2,
				validationStdoutPath: "workflow-output/validation-stdout.txt",
				validationStderrPath: "workflow-output/validation-stderr.txt",
			},
			patch: {
				changed_files: ["docs/config.rst"],
				rollback_notes: ["Revert docs/config.rst."],
				resolved_review_feedback: ["Added missing copyable example."],
			},
			review: "finish",
		});
		const archivePatch = result.statePatch?.find(patch => patch.path === "/archive")?.value;
		const archive = await Bun.file(path.join(cwd, "workflow-output/documentation-audit-archive.md")).text();

		expect(result.summary).toBe("archived documentation audit evidence");
		expect(archivePatch).toMatchObject({
			validation: "baseline-waived",
			validationWaiver: "startable-baseline-failure",
		});
		expect(archive).toContain("Baseline Validation Waiver");
		expect(archive).toContain("ImportError: cannot import name 'notset'");
	});

	it("archives consolidated findings, patch rationale, and final reviewer verdict", async () => {
		const cwd = await createTempDir();
		await fs.mkdir(path.join(cwd, "workflow-output/omh-runtime/artifacts/activation-8"), { recursive: true });
		await fs.mkdir(path.join(cwd, "workflow-output/omh-runtime/artifacts/activation-9"), { recursive: true });
		await fs.mkdir(path.join(cwd, "workflow-output/omh-runtime/artifacts/activation-12"), { recursive: true });
		await Bun.write(
			path.join(cwd, "task.md"),
			[
				"Objective: archive documentation audit evidence.",
				"Validation Command: python -m pytest tests/test_docs.py",
				"",
			].join("\n"),
		);
		await Bun.write(
			path.join(cwd, "workflow-output/omh-runtime/artifacts/activation-8/1-consolidateAudit.md"),
			[
				"# Consolidated Documentation Audit",
				"",
				"rankedDeduplicatedFindings:",
				"selectedRepair.projectTargets: docs/a.md, docs/b.md",
				"changedFileTargets: docs/a.md, docs/b.md",
				"reviewerDecision: repair accepted",
				"Finding: docs/a.md and docs/b.md drift from tested CLI help.",
				"",
			].join("\n"),
		);
		await Bun.write(
			path.join(cwd, "workflow-output/documentation-audit-digest.md"),
			[
				"# Documentation Audit Digest",
				"",
				"Digest-only truncated summary that must not replace the consolidator artifact.",
				"",
			].join("\n"),
		);
		await Bun.write(
			path.join(cwd, "workflow-output/documentation-patch.md"),
			[
				"# Documentation Patch Evidence",
				"",
				"## Patch rationale",
				"",
				"- docs/a.md: refreshed copyable command output.",
				"- docs/b.md: added missing required argument section.",
				"",
			].join("\n"),
		);
		await Bun.write(
			path.join(cwd, "workflow-output/omh-runtime/artifacts/activation-12/1-consistencyReview.md"),
			["verdict finish", "The docs diff covers every selected target and validation passed.", ""].join("\n"),
		);
		await Bun.write(
			path.join(cwd, "workflow-output/documentation-review-repair.md"),
			[
				"# Documentation Review Repair Guard",
				"",
				"## Selected Audit Target Coverage",
				"",
				"- docs/a.md",
				"- docs/b.md",
				"",
			].join("\n"),
		);
		await Bun.write(
			path.join(cwd, "workflow-output/documentation-validation.md"),
			validationEvidence("python -m pytest tests/test_docs.py", 0, "2 passed"),
		);
		await Bun.write(path.join(cwd, "workflow-output/documentation-rollback.md"), "Revert docs/a.md and docs/b.md.");

		const result = await runScriptFile(
			cwd,
			"archive-docs.js",
			{
				validation: {
					status: "pass",
					docsExitCode: 0,
					validationExitCode: 0,
				},
				patch: {
					changed_files: ["docs/a.md", "docs/b.md"],
					rollback_notes: ["Revert docs/a.md and docs/b.md."],
					resolved_review_feedback: [],
				},
				review: "finish",
			},
			[
				{
					nodeId: "consistencyReview",
					status: "completed",
					output: {
						verdict: "finish",
						summary: "finish after selected docs targets and validation passed",
					},
				},
			],
		);
		const archive = await Bun.file(path.join(cwd, "workflow-output/documentation-audit-archive.md")).text();

		expect(result.summary).toBe("archived documentation audit evidence");
		expect(archive).toContain("## Consolidated Audit Findings");
		expect(archive).toContain("rankedDeduplicatedFindings:");
		expect(archive).toContain("selectedRepair.projectTargets: docs/a.md, docs/b.md");
		expect(archive).toContain("changedFileTargets: docs/a.md, docs/b.md");
		expect(archive).toContain("reviewerDecision: repair accepted");
		expect(archive.indexOf("rankedDeduplicatedFindings:")).toBeLessThan(
			archive.indexOf("Digest-only truncated summary"),
		);
		expect(archive).toContain("## Patch Rationale");
		expect(archive).toContain("docs/a.md: refreshed copyable command output");
		expect(archive).toContain("## Reviewer Verdict");
		expect(archive).toContain("verdict finish");
		expect(archive).toContain("## Review Repair Evidence");
		expect(archive).toContain("docs/b.md");
	});
});

async function runArchiveScript(cwd: string, state: WorkflowContext["state"]): Promise<ScriptResult> {
	return runScriptFile(cwd, "archive-docs.js", state, [
		{
			nodeId: "consistencyReview",
			status: "completed",
			output: {
				verdict: "continue",
				summary: "continue until copyable example is repaired",
			},
		},
		{
			nodeId: "consistencyReview",
			status: "completed",
			output: {
				verdict: "finish",
				summary: "finish with the same known baseline validation failure",
			},
		},
	]);
}

async function runScriptFile(
	cwd: string,
	scriptFileName: string,
	state: WorkflowContext["state"],
	completedActivations: WorkflowActivation[] = [],
): Promise<ScriptResult> {
	const scriptPath = path.resolve(
		import.meta.dir,
		"../../examples/workflow/experimental/documentation-audit/documentation-audit/scripts",
		scriptFileName,
	);
	const script = await Bun.file(scriptPath).text();
	const execute = new ScriptFunctionConstructor("workflowContext", script);
	const originalCwd = process.cwd();
	try {
		process.chdir(cwd);
		return await execute({
			activation: { id: `activation-${scriptFileName}` },
			completedActivations,
			state,
		});
	} finally {
		process.chdir(originalCwd);
	}
}

async function createTempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omh-documentation-audit-"));
	tempDirs.push(dir);
	return dir;
}

async function createGitRepo(): Promise<string> {
	const dir = await createTempDir();
	await runCommand(["git", "init"], dir);
	await runCommand(["git", "config", "user.email", "test@example.com"], dir);
	await runCommand(["git", "config", "user.name", "Test User"], dir);
	await runCommand(["git", "config", "commit.gpgsign", "false"], dir);
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
		throw new Error(`${command.join(" ")} failed: ${stderr || stdout}`);
	}
}

function validationEvidence(command: string, exitCode: number, stdout: string): string {
	return [
		"# Documentation Validation Evidence",
		"",
		"## Validation Command",
		"",
		"```sh",
		command,
		"```",
		"",
		`Exit code: ${exitCode}`,
		"",
		"### Stdout",
		"",
		"```text",
		stdout,
		"```",
		"",
	].join("\n");
}
