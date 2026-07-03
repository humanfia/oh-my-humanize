import { beforeAll, describe, expect, it } from "bun:test";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { Settings } from "../../config/settings";
import type { ExtensionUIContext, ExtensionUISelectItem } from "../../extensibility/extensions/types";
import { getThemeByName, setThemeInstance } from "../../modes/theme/theme";
import type { ToolSession } from "../../tools";
import { ToolAbortError } from "../../tools/tool-errors";
import { createAskToolHumanInputRunner } from "../human-tool-runtime";
import { WorkflowNodeAbortedError } from "../node-runtime";

let testTheme: ExtensionUIContext["theme"] | undefined;

beforeAll(async () => {
	const theme = await getThemeByName("dark");
	if (!theme) throw new Error("theme unavailable");
	setThemeInstance(theme);
	testTheme = theme;
});

describe("createAskToolHumanInputRunner", () => {
	it("turns the workflow command checkpoint option into a restartable human checkpoint", async () => {
		const selectedOptions: ExtensionUISelectItem[][] = [];
		const runner = createAskToolHumanInputRunner(toolSession(), () =>
			toolContext({
				select: async (_title, options) => {
					selectedOptions.push(options);
					return "Checkpoint for /workflow commands";
				},
			}),
		);

		await expect(
			runner({
				activationId: "activation-1",
				nodeId: "operatorGate",
				question: "Inspect the adaptive proposal before deciding.",
			}),
		).rejects.toThrow(WorkflowNodeAbortedError);

		await expect(
			runner({
				activationId: "activation-2",
				nodeId: "operatorGate",
				question: "Inspect the adaptive proposal before deciding.",
			}),
		).rejects.toThrow('workflow human node "operatorGate" checkpointed for /workflow commands');
		expect(selectedOptions[0]?.map(labelOf)).toContain("Checkpoint for /workflow commands");
	});

	it("defaults the human checkpoint selection to stop", async () => {
		let initialIndex: number | undefined;
		let optionLabels: string[] = [];
		const runner = createAskToolHumanInputRunner(toolSession(), () =>
			toolContext({
				select: async (_title, options, options_) => {
					initialIndex = options_?.initialIndex;
					optionLabels = options.map(labelOf);
					return "Decision: stop (Recommended)";
				},
			}),
		);

		const output = await runner({
			activationId: "activation-1",
			nodeId: "operatorGate",
			question: "Proceed after reviewing the plan?",
		});

		expect(initialIndex).toBe(0);
		expect(optionLabels[0]).toBe("Decision: stop (Recommended)");
		expect(output.response).toBe("Decision: stop");
	});
});

function toolSession(): ToolSession {
	return {
		cwd: "/workspace",
		hasUI: true,
		settings: Settings.isolated({ "ask.timeout": 0 }),
		getSessionFile: () => null,
		getSessionSpawns: () => null,
	};
}

function toolContext(overrides: Partial<ExtensionUIContext>): AgentToolContext {
	const theme = setThemeForTest();
	return {
		sessionManager: {} as AgentToolContext["sessionManager"],
		modelRegistry: {} as AgentToolContext["modelRegistry"],
		model: undefined,
		isIdle: () => true,
		hasQueuedMessages: () => false,
		abort: () => {},
		settings: Settings.isolated({ "ask.timeout": 0 }),
		hasUI: true,
		ui: {
			select: async () => undefined,
			confirm: async () => false,
			input: async () => undefined,
			notify: () => {},
			onTerminalInput: () => () => {},
			setStatus: () => {},
			setWorkingMessage: () => {},
			setWidget: () => {},
			setFooter: () => {},
			setHeader: () => {},
			setTitle: () => {},
			editor: async () => undefined,
			custom: async () => {
				throw new ToolAbortError("custom UI unavailable in test");
			},
			setEditorText: () => {},
			pasteToEditor: () => {},
			getEditorText: () => "",
			setEditorComponent: () => {},
			theme,
			getAllThemes: async () => [],
			getTheme: async () => undefined,
			setTheme: async () => ({ success: true }),
			getToolsExpanded: () => false,
			setToolsExpanded: () => {},
			...overrides,
		},
	};
}

function setThemeForTest(): ExtensionUIContext["theme"] {
	if (testTheme === undefined) {
		throw new Error("test theme must be initialized in beforeAll");
	}
	return testTheme;
}

function labelOf(item: ExtensionUISelectItem): string {
	return typeof item === "string" ? item : item.label;
}
