/**
 * Manage and run .omhflow workflow artifacts.
 */
import { APP_NAME } from "@oh-my-pi/pi-utils";
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import {
	resolveWorkflowCommandArgs,
	runWorkflowCommand,
	type WorkflowAction,
	writeWorkflowCommandError,
} from "../cli/workflow-cli";

const ACTIONS: WorkflowAction[] = ["list", "freeze", "start", "install", "uninstall", "help"];

export default class Workflow extends Command {
	static description = "Manage and run .omhflow workflow artifacts";

	static aliases = ["flow"];

	static args = {
		action: Args.string({
			description: "Workflow action",
			required: false,
			options: [...ACTIONS, "ls"],
		}),
		targets: Args.string({
			description: "Flow names, paths, or install targets",
			required: false,
			multiple: true,
		}),
	};

	static flags = {
		json: Flags.boolean({ description: "Output JSON" }),
		force: Flags.boolean({ description: "Replace an installed workflow flow" }),
		"run-id": Flags.string({ description: "Workflow run id (start)" }),
		"family-id": Flags.string({ description: "Workflow family id (start, freeze)" }),
		start: Flags.string({ description: "Start node id (start)" }),
		"max-activations": Flags.integer({ description: "Maximum activations before checkpoint stop (start)" }),
		"max-node-activations": Flags.integer({
			description: "Maximum activations per node before checkpoint stop (start)",
		}),
		"max-runtime-ms": Flags.integer({
			description: "Maximum workflow runtime in milliseconds before checkpoint stop (start)",
		}),
		background: Flags.boolean({
			description: "Accepted for /workflow parity; headless starts already run without opening the TUI",
		}),
		cwd: Flags.string({ description: "Working directory for path resolution and headless execution" }),
	};

	static examples = [
		`# List verified built-in and installed workflow flows\n  ${APP_NAME} workflow list`,
		`# Start a distributable artifact by path without opening the TUI\n  ${APP_NAME} workflow start ./my-flow.omhflow --max-activations 1`,
		`# Start a packaged experimental flow with an explicit namespace\n  ${APP_NAME} workflow start experimental::humanize-rlcr --max-activations 1`,
		`# Install a distributable .omhflow artifact into OMHFLOW_DIR or ~/.omp/flows\n  ${APP_NAME} workflow install ./my-flow.omhflow`,
	];

	async run(): Promise<void> {
		try {
			const { args, flags } = await this.parse(Workflow);
			const targets = Array.isArray(args.targets) ? args.targets : args.targets ? [args.targets] : [];
			await runWorkflowCommand(resolveWorkflowCommandArgs(args.action, targets, flags));
		} catch (error) {
			writeWorkflowCommandError(error);
		}
	}
}
