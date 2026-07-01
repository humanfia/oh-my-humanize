/**
 * `omh auth-broker` — manage the OMH credential vault.
 */
import { APP_NAME } from "@oh-my-pi/pi-utils";
import { Args, Command, Flags, renderCommandHelp } from "@oh-my-pi/pi-utils/cli";
import {
	AUTH_BROKER_ACTIONS,
	type AuthBrokerAction,
	type AuthBrokerCommandArgs,
	runAuthBrokerCommand,
} from "../cli/auth-broker-cli";
import { initTheme } from "../modes/theme/theme";

export default class AuthBroker extends Command {
	static description = "Manage the OMH auth-broker (credential vault)";

	static args = {
		action: Args.string({
			description: "Sub-command",
			required: false,
			options: [...AUTH_BROKER_ACTIONS],
		}),
		// Second positional: provider id (login/logout) or filesystem path (import).
		source: Args.string({
			description: "OAuth provider id (login/logout) or path (import)",
			required: false,
		}),
	};

	static flags = {
		json: Flags.boolean({ description: "Output JSON" }),
		bind: Flags.string({ description: "Bind address for `serve` (host:port)", char: "b" }),
		regenerate: Flags.boolean({ description: "Regenerate the bearer token" }),
		via: Flags.string({
			description: "SSH user@host for remote login (login --via=user@host)",
		}),
		provider: Flags.string({
			description: "Override provider id for `import` (e.g. when JSON `type` is unrecognized)",
		}),
		console: Flags.boolean({
			description: "Use Anthropic Console pasted-code login (login anthropic)",
		}),
		headless: Flags.boolean({
			description: "Use Claude pasted-code login without a localhost callback (login anthropic)",
		}),
		"include-disabled": Flags.boolean({
			description: "Import credentials whose JSON has `disabled: true` (import)",
		}),
		"from-local": Flags.boolean({
			description: "migrate source: local SQLite + env vars (required for `migrate`)",
		}),
		"include-env": Flags.boolean({
			description: "Capture env-var API keys for providers not yet on broker (migrate)",
		}),
		"include-oauth": Flags.boolean({
			description: "Also upload OAuth from local SQLite during migrate (default skips them)",
		}),
		"dry-run": Flags.boolean({ description: "Print actions without executing (import / login --via / migrate)" }),
	};

	static examples = [
		`# Boot the broker against the local SQLite store\n  ${APP_NAME} auth-broker serve`,
		`# Boot on a non-default port\n  ${APP_NAME} auth-broker serve --bind=127.0.0.1:9000`,
		`# Print the bearer token\n  ${APP_NAME} auth-broker token`,
		`# Rotate the bearer token\n  ${APP_NAME} auth-broker token --regenerate`,
		`# List supported OAuth providers\n  ${APP_NAME} auth-broker list`,
		`# Local login (run on the broker host)\n  ${APP_NAME} auth-broker login anthropic`,
		`# Interactive provider selection\n  ${APP_NAME} auth-broker login`,
		`# Remote login over SSH tunnel\n  ${APP_NAME} auth-broker login anthropic --via=user@broker`,
		`# Anthropic Console login without a localhost callback\n  ${APP_NAME} auth-broker login anthropic --console`,
		`# Claude subscription login without a localhost callback\n  ${APP_NAME} auth-broker login anthropic --headless`,
		`# Log out of a provider (interactive without provider arg)\n  ${APP_NAME} auth-broker logout anthropic`,
		`# Import a CLIProxyAPI auth dump\n  ${APP_NAME} auth-broker import ~/.cliproxy/auth`,
		`# Import a single CLIProxyAPI JSON, overriding the provider mapping\n  ${APP_NAME} auth-broker import ~/.cliproxy/auth/claude-foo.json --provider anthropic`,
		`# Preview a migration from local store + env vars to the configured broker\n  ${APP_NAME} auth-broker migrate --from-local --include-env --dry-run`,
		`# Apply the migration\n  ${APP_NAME} auth-broker migrate --from-local --include-env`,
		`# Health-check the configured remote broker\n  ${APP_NAME} auth-broker status`,
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(AuthBroker);
		if (!args.action) {
			renderCommandHelp(APP_NAME, "auth-broker", AuthBroker);
			return;
		}
		const action = args.action as AuthBrokerAction;
		const cmd: AuthBrokerCommandArgs = {
			action,
			flags: {
				json: flags.json,
				bind: flags.bind,
				regenerate: flags.regenerate,
				via: flags.via,
				// `login`/`logout` reuse the legacy `provider` slot; `import` keeps `source` separate
				// so `provider` flag (used as an override) is unambiguous.
				provider: action === "import" ? flags.provider : (args.source ?? flags.provider),
				source: action === "import" ? args.source : undefined,
				includeDisabled: flags["include-disabled"],
				fromLocal: flags["from-local"],
				includeEnv: flags["include-env"],
				includeOauth: flags["include-oauth"],
				dryRun: flags["dry-run"],
				console: flags.console,
				headless: flags.headless,
			},
		};
		await initTheme();
		await runAuthBrokerCommand(cmd);
	}
}
