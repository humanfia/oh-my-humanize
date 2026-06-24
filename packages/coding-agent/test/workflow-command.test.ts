import { describe, expect, test } from "bun:test";
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
	});

	test("help examples keep unverified candidate flows out of built-in examples", () => {
		const examples = Workflow.examples.join("\n");

		expect(examples).not.toContain("Start a flow by built-in name");
		expect(examples).not.toContain("\n  omh workflow start humanize-rlcr");
		expect(examples).toContain("OMHFLOW_DIR=./candidate-flows omh workflow start humanize-rlcr --max-activations 1");
		expect(examples).toContain("OMHFLOW_DIR");
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
