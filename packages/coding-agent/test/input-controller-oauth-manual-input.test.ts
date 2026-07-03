import { afterEach, describe, expect, it, vi } from "bun:test";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import { OAuthManualInputManager } from "@oh-my-pi/pi-coding-agent/modes/oauth-manual-input";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

type FakeEditor = {
	onSubmit?: (text: string) => Promise<void>;
	imageLinks?: readonly (string | undefined)[];
	pendingImages: ImageContent[];
	pendingImageLinks: (string | undefined)[];
	clearDraft(text?: string): void;
	setText(text: string): void;
	getText(): string;
	addToHistory(text: string): void;
};

function createContext() {
	let editorText = "";
	const oauthManualInput = new OAuthManualInputManager();
	const showStatus = vi.fn();
	const prompt = vi.fn(async () => {});
	const withLocalSubmission = vi.fn(async (_text: string, fn: () => Promise<unknown>) => await fn());
	const extensionHasHandlers = vi.fn((kind: string) => kind === "input");
	const extensionEmitInput = vi.fn(async (_text: string) => undefined);
	const editor: FakeEditor = {
		pendingImages: [],
		pendingImageLinks: [],
		clearDraft: vi.fn((text?: string) => {
			editorText = text ?? "";
		}),
		setText: vi.fn((text: string) => {
			editorText = text;
		}),
		getText: vi.fn(() => editorText),
		addToHistory: vi.fn(),
	};

	const ctx = {
		editor: editor as unknown as InteractiveModeContext["editor"],
		ui: {
			requestRender: vi.fn(),
		} as unknown as InteractiveModeContext["ui"],
		session: {
			isStreaming: false,
			isCompacting: false,
			isBashRunning: false,
			isEvalRunning: false,
			queuedMessageCount: 0,
			extensionRunner: {
				hasHandlers: extensionHasHandlers,
				emitInput: extensionEmitInput,
			},
			prompt,
		} as unknown as InteractiveModeContext["session"],
		sessionManager: {
			getSessionName: () => "existing session",
			putBlob: vi.fn(),
		} as unknown as InteractiveModeContext["sessionManager"],
		skillCommands: new Map(),
		oauthManualInput,
		isBashMode: false,
		isPythonMode: false,
		loopModeEnabled: false,
		flushPendingBashComponents: vi.fn(),
		withLocalSubmission,
		updatePendingMessagesDisplay: vi.fn(),
		updateEditorBorderColor: vi.fn(),
		handleBashCommand: vi.fn(),
		handlePythonCommand: vi.fn(),
		queueCompactionMessage: vi.fn(),
		showStatus,
		showWarning: vi.fn(),
		showError: vi.fn(),
	} as unknown as InteractiveModeContext;

	return {
		ctx,
		editor,
		oauthManualInput,
		spies: {
			extensionEmitInput,
			extensionHasHandlers,
			prompt,
			showStatus,
			withLocalSubmission,
		},
	};
}

describe("InputController OAuth manual input routing", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("claims a bare pasted OAuth code before chat submission, history, or extension input hooks", async () => {
		const { ctx, editor, oauthManualInput, spies } = createContext();
		const pendingInput = oauthManualInput.waitForInput("anthropic-code");
		new InputController(ctx).setupEditorSubmitHandler();

		await editor.onSubmit?.("auth-code-123#state");

		await expect(pendingInput).resolves.toBe("auth-code-123#state");
		expect(oauthManualInput.hasPending()).toBe(false);
		expect(spies.extensionHasHandlers).not.toHaveBeenCalled();
		expect(spies.extensionEmitInput).not.toHaveBeenCalled();
		expect(spies.prompt).not.toHaveBeenCalled();
		expect(spies.withLocalSubmission).not.toHaveBeenCalled();
		expect(editor.addToHistory).not.toHaveBeenCalled();
		expect(editor.clearDraft).toHaveBeenCalledTimes(1);
		expect(spies.showStatus).toHaveBeenCalledWith("OAuth callback received; completing login…");
	});
});
