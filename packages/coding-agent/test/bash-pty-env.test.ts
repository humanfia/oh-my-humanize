import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { PtySession } from "@oh-my-pi/pi-natives";

function makeSession(options: { shellEnvironmentPolicy?: ToolSession["shellEnvironmentPolicy"] } = {}): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: true,
		skills: [],
		shellEnvironmentPolicy: options.shellEnvironmentPolicy,
		getSessionFile: () => null,
		settings: {
			get(key: string) {
				if (key === "async.enabled") return false;
				if (key === "bash.autoBackground.enabled") return false;
				if (key === "bash.autoBackground.thresholdMs") return 60_000;
				if (key === "bashInterceptor.enabled") return false;
				if (key === "astGrep.enabled") return false;
				if (key === "astEdit.enabled") return false;
				if (key === "grep.enabled") return false;
				if (key === "glob.enabled") return false;
				return undefined;
			},
			getBashInterceptorRules() {
				return [];
			},
			getShellConfig() {
				return { shell: "/bin/bash", args: ["-l", "-c"], env: {}, prefix: undefined };
			},
		},
		getClientBridge: () => undefined,
	} as unknown as ToolSession;
}

function makeContext(): AgentToolContext {
	return {
		sessionManager: {} as AgentToolContext["sessionManager"],
		modelRegistry: {} as AgentToolContext["modelRegistry"],
		model: undefined,
		isIdle: () => true,
		hasQueuedMessages: () => false,
		abort: () => {},
		hasUI: true,
		ui: {
			custom<T>(
				factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (result: T) => void) => unknown,
			) {
				const { promise, resolve } = Promise.withResolvers<T>();
				factory(
					{
						terminal: { columns: 100, rows: 32 },
						requestRender() {},
					},
					{},
					{},
					resolve,
				);
				return promise;
			},
		} as AgentToolContext["ui"],
	};
}

afterEach(() => {
	mock.restore();
});

describe("BashTool interactive PTY environment", () => {
	it("keeps non-interactive default env out of local PTY while preserving explicit env", async () => {
		let capturedEnv: Record<string, string> | undefined;
		spyOn(PtySession.prototype, "start").mockImplementation(async function start(options) {
			capturedEnv = options.env;
			return { exitCode: 0, cancelled: false, timedOut: false };
		});

		const tool = new BashTool(makeSession());
		await tool.execute(
			"call-pty-env",
			{ command: "env", pty: true, env: { TERM: "screen-256color", CUSTOM: "1" } },
			undefined,
			undefined,
			makeContext(),
		);

		expect(capturedEnv?.TERM).toBe("screen-256color");
		expect(capturedEnv?.CUSTOM).toBe("1");
		expect(capturedEnv?.CI).toBeUndefined();
		expect(capturedEnv?.NO_COLOR).toBeUndefined();
		expect(capturedEnv?.GIT_TERMINAL_PROMPT).toBeUndefined();
		expect(capturedEnv?.PAGER).toBeUndefined();
	});

	it("keeps workflow cache isolation env in local PTY without generic non-interactive defaults", async () => {
		const previousRunTmp = Bun.env.OMH_RUN_TMP;
		Bun.env.OMH_RUN_TMP = "/tmp/omh-workflow-run";
		let capturedEnv: Record<string, string> | undefined;
		spyOn(PtySession.prototype, "start").mockImplementation(async function start(options) {
			capturedEnv = options.env;
			return { exitCode: 0, cancelled: false, timedOut: false };
		});

		try {
			const tool = new BashTool(makeSession({ shellEnvironmentPolicy: "workflow" }));
			await tool.execute(
				"call-pty-workflow-env",
				{ command: "python -m py_compile x.py", pty: true, env: { PYTEST_ADDOPTS: "-q" } },
				undefined,
				undefined,
				makeContext(),
			);
		} finally {
			if (previousRunTmp === undefined) {
				delete Bun.env.OMH_RUN_TMP;
			} else {
				Bun.env.OMH_RUN_TMP = previousRunTmp;
			}
		}

		expect(capturedEnv?.PYTHONDONTWRITEBYTECODE).toBe("1");
		expect(capturedEnv?.PYTHONPYCACHEPREFIX).toBe("/tmp/omh-workflow-run/python-pycache");
		expect(capturedEnv?.RUFF_CACHE_DIR).toBe("/tmp/omh-workflow-run/ruff-cache");
		expect(capturedEnv?.PYTEST_ADDOPTS).toBe("-q");
		expect(capturedEnv?.CI).toBeUndefined();
		expect(capturedEnv?.PAGER).toBeUndefined();
	});
});
