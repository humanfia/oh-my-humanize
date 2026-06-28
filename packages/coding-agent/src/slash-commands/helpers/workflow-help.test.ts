import { describe, expect, it } from "bun:test";
import type { WorkflowMonitorDisplayMode } from "../../workflow/monitor-display-mode";
import type { SlashCommandRuntime } from "../types";
import { handleWorkflowAcp } from "./workflow";

describe("/workflow help", () => {
	it("exposes a nested guide path from the top-level workflow help", async () => {
		const { output, runtime } = createWorkflowHelpRuntime();

		await handleWorkflowAcp({ name: "workflow", args: "help", text: "/workflow help" }, runtime);

		const text = output.join("\n");
		expect(text).toContain("/workflow dashboard help");
		expect(text).toContain("/workflow status help");
		expect(text).toContain("/workflow help agents");
		expect(text).toContain("/workflow dashboard collapse");
	});

	it("documents dashboard display controls without advertising hide as the primary verb", async () => {
		const { output, runtime } = createWorkflowHelpRuntime();

		await handleWorkflowAcp({ name: "workflow", args: "dashboard help", text: "/workflow dashboard help" }, runtime);

		const text = output.join("\n");
		expect(text).toContain("/workflow dashboard collapse");
		expect(text).toContain("/workflow dashboard compact");
		expect(text).toContain("/workflow dashboard show");
		expect(text).not.toContain("/workflow dashboard hide");
	});

	it("supports status help as a second-level workflow guide", async () => {
		const { output, runtime } = createWorkflowHelpRuntime();

		await handleWorkflowAcp({ name: "workflow", args: "status help", text: "/workflow status help" }, runtime);

		const text = output.join("\n");
		expect(text).toContain("/workflow manager");
		expect(text).toContain("/workflow graph");
		expect(text).toContain("/workflow list");
	});

	it("documents how to inspect and steer workflow nodes", async () => {
		const { output, runtime } = createWorkflowHelpRuntime();

		await handleWorkflowAcp({ name: "workflow", args: "help agents", text: "/workflow help agents" }, runtime);

		const text = output.join("\n");
		expect(text).toContain("Agent Hub");
		expect(text).toContain("Enter to steer");
		expect(text).toContain("/workflow interrupt");
		expect(text).toContain("/workflow manager");
	});

	it("documents the human-gate checkpoint path for lifecycle commands", async () => {
		const { output, runtime } = createWorkflowHelpRuntime();

		await handleWorkflowAcp({ name: "workflow", args: "help lifecycle", text: "/workflow help lifecycle" }, runtime);

		const text = output.join("\n");
		expect(text).toContain("Checkpoint for /workflow commands");
		expect(text).toContain("/workflow restart");
	});

	it("changes dashboard mode through the visible collapse command", async () => {
		const { output, runtime, getMode } = createWorkflowHelpRuntime();

		await handleWorkflowAcp(
			{ name: "workflow", args: "dashboard collapse", text: "/workflow dashboard collapse" },
			runtime,
		);

		expect(getMode()).toBe("collapsed");
		expect(output.join("\n")).toContain("Workflow dashboard display mode: collapsed.");
	});
});

function createWorkflowHelpRuntime(): {
	output: string[];
	runtime: SlashCommandRuntime;
	getMode: () => WorkflowMonitorDisplayMode;
} {
	const output: string[] = [];
	let mode: WorkflowMonitorDisplayMode = "full";
	return {
		output,
		getMode: () => mode,
		runtime: {
			session: {} as SlashCommandRuntime["session"],
			sessionManager: {} as SlashCommandRuntime["sessionManager"],
			settings: {} as SlashCommandRuntime["settings"],
			cwd: "/tmp",
			output: text => {
				output.push(text);
			},
			getWorkflowGraphMonitorDisplayMode: () => mode,
			setWorkflowGraphMonitorDisplayMode: next => {
				mode = next;
			},
			refreshCommands: () => {},
			reloadPlugins: async () => {},
		},
	};
}
