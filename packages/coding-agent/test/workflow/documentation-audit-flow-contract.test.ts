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
		review?: string;
	};
}

interface ScriptResult {
	summary: string;
	statePatch?: Array<{
		op: "set";
		path: string;
		value: {
			validation?: string;
			validationWaiver?: string;
		};
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
	it("archives accepted docs repairs when task validation has the same startable baseline failure", async () => {
		const cwd = await createTempDir();
		await fs.mkdir(path.join(cwd, "workflow-output"), { recursive: true });
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

		const result = await runScript(cwd, {
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
});

async function runScript(cwd: string, state: WorkflowContext["state"]): Promise<ScriptResult> {
	const scriptPath = path.resolve(
		import.meta.dir,
		"../../examples/workflow/experimental/documentation-audit/documentation-audit/scripts/archive-docs.js",
	);
	const script = await Bun.file(scriptPath).text();
	const execute = new ScriptFunctionConstructor("workflowContext", script);
	const originalCwd = process.cwd();
	try {
		process.chdir(cwd);
		return await execute({
			activation: { id: "activation-archiveDocs" },
			completedActivations: [
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
			],
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
