import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

interface WorkflowContext {
	activation: {
		id: string;
	};
	completedActivations: unknown[];
	state?: {
		gaps?: object;
	};
}

interface ScriptResult {
	summary: string;
	statePatch?: Array<{
		op: "set";
		path: string;
		value: unknown;
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

describe("test-generation-hardening flow contract", () => {
	it("treats a startable failing validation probe as gap evidence instead of a blocker", async () => {
		const cwd = await createTempDir();
		const result = await runScript(cwd, {
			gaps: {
				status: "ready",
				summary: "Regression anchor is missing before test generation.",
				validation: {
					command: "python -c 'raise SystemExit(1)'",
					startable: true,
					status: "ran",
					exitCode: 1,
					stderr: "",
				},
				regressionRisks: ["missing regression anchor"],
				smallestUsefulTestAdditions: ["add focused regression assertion"],
				filesLikelyToNeedTestChanges: ["test/res.json.js"],
			},
		});

		const report = await Bun.file(path.join(cwd, "workflow-output", "test-hardening-gap-report.md")).text();
		const gapsPatch = result.statePatch?.find(patch => patch.path === "/gaps")?.value;

		expect(result.summary).toContain("materialized coverage gap report");
		expect(report).toContain("Regression anchor is missing before test generation.");
		expect(report).toContain("- Exit code: 1");
		expect(gapsPatch).toMatchObject({
			gapReportPath: "workflow-output/test-hardening-gap-report.md",
		});
	});

	it("fails closed when the validation probe could not be started", async () => {
		const cwd = await createTempDir();

		await expect(
			runScript(cwd, {
				gaps: {
					status: "ready",
					summary: "Validation harness was unavailable.",
					validation: {
						command: "npm test",
						startable: false,
						status: "blocked",
					},
				},
			}),
		).rejects.toThrow("coverage inspection blocked");
	});
});

async function runScript(cwd: string, state: WorkflowContext["state"]): Promise<ScriptResult> {
	const scriptPath = path.resolve(
		import.meta.dir,
		"../../examples/workflow/experimental/test-generation-hardening/test-generation-hardening/scripts/materialize-gap-report.js",
	);
	const script = await Bun.file(scriptPath).text();
	const execute = new ScriptFunctionConstructor("workflowContext", script);
	const originalCwd = process.cwd();
	try {
		process.chdir(cwd);
		return await execute({
			activation: { id: "activation-materializeGapReport" },
			completedActivations: [],
			state,
		});
	} finally {
		process.chdir(originalCwd);
	}
}

async function createTempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omh-test-generation-hardening-"));
	tempDirs.push(dir);
	return dir;
}
