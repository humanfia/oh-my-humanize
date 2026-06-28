import { beforeAll, describe, expect, it } from "bun:test";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { Settings } from "../../src/config/settings";
import type { ExtensionUIContext, ExtensionUISelectItem } from "../../src/extensibility/extensions";
import { initTheme } from "../../src/modes/theme/theme";
import type { ToolSession } from "../../src/tools";
import { createAskToolHumanInputRunner } from "../../src/workflow/human-tool-runtime";
import { WorkflowNodeAbortedError } from "../../src/workflow/node-runtime";

function createToolSession(): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({
			"ask.notify": "off",
			"ask.timeout": 0,
		}),
	};
}

function createToolContext(ui: ExtensionUIContext): AgentToolContext {
	return {
		hasUI: true,
		ui,
		abort: () => {},
	} as unknown as AgentToolContext;
}

beforeAll(async () => {
	await initTheme(false);
});

describe("workflow human input ask tool runtime adapter", () => {
	it("asks through the existing ask tool and returns the selected response", async () => {
		let capturedTitle: string | undefined;
		let capturedOptions: ExtensionUISelectItem[] | undefined;
		const ui = {
			select: async (title: string, options: ExtensionUISelectItem[]) => {
				capturedTitle = title;
				capturedOptions = options;
				return "Decision: proceed";
			},
			editor: async () => undefined,
		} as unknown as ExtensionUIContext;
		const runner = createAskToolHumanInputRunner(createToolSession(), () => createToolContext(ui));

		const result = await runner({
			activationId: "activation-approve",
			nodeId: "approve",
			question: "Approve this workflow result?",
		});

		expect(capturedTitle).toBe("Approve this workflow result?");
		expect(capturedOptions?.map(option => (typeof option === "string" ? option : option.label))).toEqual([
			"Decision: stop (Recommended)",
			"Decision: proceed",
			"Checkpoint for /workflow commands",
			"Other (type your own)",
		]);
		expect(result).toEqual({
			response: "Decision: proceed",
			selectedOptions: ["Decision: proceed"],
		});
	});

	it("maps the visible stop option to a durable stop decision", async () => {
		const ui = {
			select: async () => "Decision: stop",
			editor: async () => undefined,
		} as unknown as ExtensionUIContext;
		const runner = createAskToolHumanInputRunner(createToolSession(), () => createToolContext(ui));

		const result = await runner({
			activationId: "activation-stop",
			nodeId: "approve",
			question: "Approve this workflow result?",
		});

		expect(result).toEqual({
			response: "Decision: stop",
			selectedOptions: ["Decision: stop"],
		});
	});

	it("turns the checkpoint option into a workflow abort for lifecycle commands", async () => {
		const ui = {
			select: async () => "Checkpoint for /workflow commands",
			editor: async () => undefined,
		} as unknown as ExtensionUIContext;
		const runner = createAskToolHumanInputRunner(createToolSession(), () => createToolContext(ui));

		await expect(
			runner({
				activationId: "activation-checkpoint",
				nodeId: "operatorGate",
				question: "Approve this workflow mutation?",
			}),
		).rejects.toThrow('workflow human node "operatorGate" checkpointed for /workflow commands');
	});

	it("maps user cancellation to a workflow node abort instead of a failed checkpoint", async () => {
		let aborted = false;
		const ui = {
			select: async () => undefined,
			editor: async () => undefined,
		} as unknown as ExtensionUIContext;
		const runner = createAskToolHumanInputRunner(createToolSession(), () => ({
			...createToolContext(ui),
			abort: () => {
				aborted = true;
			},
		}));

		await expect(
			runner({
				activationId: "activation-cancel",
				nodeId: "operatorGate",
				question: "Approve this workflow mutation?",
			}),
		).rejects.toThrow(WorkflowNodeAbortedError);
		expect(aborted).toBe(true);
	});
});
