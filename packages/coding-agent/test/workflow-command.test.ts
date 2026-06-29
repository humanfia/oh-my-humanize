import { afterEach, describe, expect, test, vi } from "bun:test";
import { commands, isSubcommand, resolveCliArgv } from "@oh-my-pi/pi-coding-agent/cli-commands";
import {
	buildHeadlessAgentTaskArgs,
	buildHeadlessAgentTaskEnv,
	resolveWorkflowCommandArgs,
} from "../src/cli/workflow-cli";
import Workflow from "../src/commands/workflow";
import {
	WORKFLOW_SUBAGENT_MODEL_OVERRIDE_AUTH_FALLBACK_ENV,
	WORKFLOW_SUBAGENT_MODEL_OVERRIDE_ENV,
} from "../src/workflow/model-env";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("workflow command is registered as a top-level subcommand", () => {
	test("CLI runner routes workflow commands to the workflow command, not launch", () => {
		const entry = commands.find(command => command.name === "workflow");

		expect(entry?.aliases).toContain("flow");
		expect(isSubcommand("workflow")).toBe(true);
		expect(isSubcommand("flow")).toBe(true);
		expect(resolveCliArgv(["workflow", "list"])).toEqual({ argv: ["workflow", "list"] });
		expect(resolveCliArgv(["flow", "start", "humanize-rlcr"])).toEqual({
			argv: ["flow", "start", "humanize-rlcr"],
		});
		expect(resolveCliArgv(["workflows"])).toEqual({
			error: '`omh workflows` is not a command. Use `omh workflow list`, `omh workflow --help`, or run `omh launch workflows` if you meant to send "workflows" as a prompt.',
		});
		expect(resolveCliArgv(["workflows", "list"])).toEqual({
			error: '`omh workflows` is not a command. Use `omh workflow list`, `omh workflow --help`, or run `omh launch workflows` if you meant to send "workflows" as a prompt.',
		});
	});

	test("help examples expose packaged experimental flows with an explicit namespace", () => {
		const examples = Workflow.examples.join("\n");

		expect(examples).not.toContain("Start a flow by built-in name");
		expect(examples).not.toContain("\n  omp workflow start humanize-rlcr");
		expect(examples).toContain("omh workflow start experimental::humanize-rlcr");
		expect(examples).toContain("experimental::");
	});
});

describe("workflow command user-facing errors", () => {
	test("renders workflow help through the help action", async () => {
		const stdout: string[] = [];
		vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
			stdout.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
			return true;
		});

		await new Workflow(["help", "start"], {
			bin: "omh",
			version: "test",
			commands: new Map([["workflow", Workflow]]),
		}).run();

		const output = stdout.join("");
		expect(output).toContain("omh workflow - Manage and run .omhflow workflow artifacts");
		expect(output).toContain("omh workflow start experimental::humanize-rlcr --max-activations 1");
	});

	test("prints parse failures without a source stack trace", async () => {
		const originalExitCode = process.exitCode;
		const stderr: string[] = [];
		vi.spyOn(process.stderr, "write").mockImplementation(chunk => {
			stderr.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
			return true;
		});
		process.exitCode = undefined;
		try {
			await new Workflow(["start", "experimental::humanize-rlcr", "--max-activations", "nope"], {
				bin: "omh",
				version: "test",
				commands: new Map([["workflow", Workflow]]),
			}).run();
		} finally {
			process.exitCode = originalExitCode ?? 0;
		}

		const output = stderr.join("");
		expect(output).toContain('Expected integer for --max-activations, got "nope"');
		expect(output).not.toContain("packages/utils/src/cli.ts");
		expect(output).not.toContain("workflow-cli.ts");
	});

	test("prints unsupported action recovery hints without a source stack trace", async () => {
		const originalExitCode = process.exitCode;
		const stderr: string[] = [];
		vi.spyOn(process.stderr, "write").mockImplementation(chunk => {
			stderr.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
			return true;
		});
		process.exitCode = undefined;
		try {
			await new Workflow(["graph"], {
				bin: "omh",
				version: "test",
				commands: new Map([["workflow", Workflow]]),
			}).run();
		} finally {
			process.exitCode = originalExitCode ?? 0;
		}

		const output = stderr.join("");
		expect(output).toContain("Headless workflow commands support list, freeze, start, install, and uninstall.");
		expect(output).toContain("Run omh workflow help.");
		expect(output).not.toContain("packages/utils/src/cli.ts");
	});
});

describe("resolveWorkflowCommandArgs", () => {
	test("defaults to listing workflows", () => {
		expect(resolveWorkflowCommandArgs(undefined, [], {})).toEqual({
			action: "list",
			args: [],
			flags: {},
		});
	});

	test("keeps non-interactive start options typed for the runner", () => {
		expect(
			resolveWorkflowCommandArgs("start", ["humanize-rlcr"], {
				json: true,
				"run-id": "run-1",
				"family-id": "family-1",
				start: "planCompliancePrecheck",
				"max-activations": 5,
				"max-node-activations": 3,
				"max-runtime-ms": 1234,
				background: true,
				cwd: "/tmp/project",
			}),
		).toEqual({
			action: "start",
			args: ["humanize-rlcr"],
			flags: {
				json: true,
				runId: "run-1",
				familyId: "family-1",
				startNodeId: "planCompliancePrecheck",
				maxActivations: 5,
				maxNodeActivations: 3,
				maxRuntimeMs: 1234,
				background: true,
				cwd: "/tmp/project",
			},
		});
	});

	test("delegates headless agent nodes through the launch CLI with model and prompt preserved", () => {
		const args = buildHeadlessAgentTaskArgs("/repo", "Implement the workflow task.", "rust-cat/gpt-5.5");

		expect(args.slice(-7)).toEqual([
			"launch",
			"--cwd",
			"/repo",
			"--model",
			"rust-cat/gpt-5.5",
			"-p",
			"Implement the workflow task.",
		]);
	});

	test("pins nested headless workflow subagents to the exact workflow model", () => {
		const env = buildHeadlessAgentTaskEnv({ PATH: "/bin" }, "rust-cat/gpt-5.5", false);

		expect(env.PATH).toBe("/bin");
		expect(env[WORKFLOW_SUBAGENT_MODEL_OVERRIDE_ENV]).toBe("rust-cat/gpt-5.5");
		expect(env[WORKFLOW_SUBAGENT_MODEL_OVERRIDE_AUTH_FALLBACK_ENV]).toBe("false");
	});
});
