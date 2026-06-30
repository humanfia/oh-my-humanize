import { describe, expect, it } from "bun:test";
import { buildWorkflowShellEnvironment } from "@oh-my-pi/pi-coding-agent/exec/shell-environment-policy";

describe("buildWorkflowShellEnvironment", () => {
	it("preserves workflow-owned project environment while dropping inherited Python pollution", () => {
		const env = buildWorkflowShellEnvironment(
			{ OMP_WORKFLOW_CONTEXT: "node", OMP_WORKFLOW_RESOURCE_DIR: "/tmp/resources" },
			{
				HOME: "/home/operator",
				PATH: "/usr/bin",
				PYTHONNOUSERSITE: "1",
				PYTHONPATH: "/stale/site",
				OMP_WORKFLOW_CONTEXT: "stale",
				OMP_WORKFLOW_RESOURCE_DIR: "/stale/resources",
			},
			"linux",
		);

		expect(env.HOME).toBe("/home/operator");
		expect(env.PATH).toBe("/usr/bin");
		expect(env.PYTHONNOUSERSITE).toBeUndefined();
		expect(env.PYTHONPATH).toBeUndefined();
		expect(env.OMP_WORKFLOW_CONTEXT).toBe("node");
		expect(env.OMP_WORKFLOW_RESOURCE_DIR).toBe("/tmp/resources");
		expect(env.GIT_TERMINAL_PROMPT).toBe("0");
	});

	it("keeps explicit workflow Python environment overrides", () => {
		const env = buildWorkflowShellEnvironment(
			{ PYTHONNOUSERSITE: "1", PYTHONPATH: "src" },
			{ PYTHONNOUSERSITE: "", PYTHONPATH: "/stale/site" },
			"linux",
		);

		expect(env.PYTHONNOUSERSITE).toBe("1");
		expect(env.PYTHONPATH).toBe("src");
	});
});
