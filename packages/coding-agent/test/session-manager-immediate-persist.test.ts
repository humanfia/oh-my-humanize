import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

const tempDirs: TempDir[] = [];

function makeTempDir(prefix: string): string {
	const dir = TempDir.createSync(prefix);
	tempDirs.push(dir);
	return dir.path();
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => dir.remove()));
});

function assistantMessage(text: string) {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected built-in anthropic model to exist");
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
}

function readJsonl(file: string): Array<Record<string, unknown>> {
	return fs
		.readFileSync(file, "utf8")
		.trimEnd()
		.split("\n")
		.filter(Boolean)
		.map(line => JSON.parse(line) as Record<string, unknown>)
		.filter(entry => entry.type !== "title");
}

class DelayedAtomicStorage extends FileSessionStorage {
	readonly #atomicGates: Array<PromiseWithResolvers<void>> = [];

	async waitForAtomicStart(): Promise<boolean> {
		for (let attempt = 0; attempt < 50; attempt += 1) {
			if (this.#atomicGates.length > 0) return true;
			await Bun.sleep(0);
		}
		return false;
	}

	releaseNextAtomic(): boolean {
		const next = this.#atomicGates.shift();
		if (next === undefined) return false;
		next.resolve();
		return true;
	}

	override async writeTextAtomic(targetPath: string, content: string): Promise<void> {
		const gate = Promise.withResolvers<void>();
		this.#atomicGates.push(gate);
		await gate.promise;
		await super.writeTextAtomic(targetPath, content);
	}
}

function messageRole(entry: Record<string, unknown>): string | undefined {
	const message = entry.message;
	if (!message || typeof message !== "object") return undefined;
	const role = (message as { role?: unknown }).role;
	return typeof role === "string" ? role : undefined;
}

function messageContent(entry: Record<string, unknown>): unknown {
	const message = entry.message;
	if (!message || typeof message !== "object") return undefined;
	return (message as { content?: unknown }).content;
}

describe("SessionManager immediate JSONL persistence", () => {
	it("writes the first assistant turn and later entries before appendMessage returns", () => {
		const cwd = makeTempDir("@pi-immediate-cwd-");
		const sessionDir = path.join(cwd, "sessions");
		const manager = SessionManager.create(cwd, sessionDir);
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file path");

		manager.appendMessage({ role: "user", content: "queued before assistant", timestamp: Date.now() });
		expect(fs.existsSync(sessionFile)).toBe(false);

		manager.appendMessage(assistantMessage("hello"));
		expect(fs.existsSync(sessionFile)).toBe(true);

		let entries = readJsonl(sessionFile);
		expect(entries).toHaveLength(3);
		expect(messageRole(entries[1] ?? {})).toBe("user");
		expect(messageRole(entries[2] ?? {})).toBe("assistant");

		manager.appendMessage({ role: "user", content: "written immediately", timestamp: Date.now() });

		entries = readJsonl(sessionFile);
		expect(entries).toHaveLength(4);
		expect(messageRole(entries[3] ?? {})).toBe("user");
		expect(messageContent(entries[3] ?? {})).toBe("written immediately");
	});

	it("keeps entries appended during ensureOnDisk materialization on the visible session file", async () => {
		const cwd = makeTempDir("@pi-ensure-race-cwd-");
		const sessionDir = path.join(cwd, "sessions");
		const storage = new DelayedAtomicStorage();
		const manager = SessionManager.create(cwd, sessionDir, storage);
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file path");

		manager.appendCustomEntry("workflow-lifecycle-event", { event: "family_created", familyId: "family-race" });

		const ensure = manager.ensureOnDisk();
		const atomicStarted = await storage.waitForAtomicStart();
		manager.appendCustomEntry("workflow-run-event", { event: "activation_started", activationId: "activation-1" });
		manager.appendCustomEntry("workflow-lifecycle-event", {
			event: "checkpoint_created",
			checkpointId: "checkpoint-1",
		});
		if (atomicStarted) storage.releaseNextAtomic();
		await ensure;

		manager.appendCustomEntry("workflow-run-event", { event: "activation_aborted", activationId: "activation-1" });
		await manager.flush();

		const persisted = readJsonl(sessionFile);
		const events = persisted
			.filter(entry => entry.type === "custom")
			.map(entry => (entry.data as { event?: string } | undefined)?.event)
			.filter((event): event is string => typeof event === "string");
		expect(events).toEqual(["family_created", "activation_started", "checkpoint_created", "activation_aborted"]);
	});

	it("keeps pre-assistant sessions out of history during shutdown", async () => {
		const cwd = makeTempDir("@pi-empty-session-cwd-");
		const sessionDir = path.join(cwd, "sessions");
		const manager = SessionManager.create(cwd, sessionDir);
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file path");

		manager.flushSync();
		await manager.close();

		expect(fs.existsSync(sessionFile)).toBe(false);
		expect(await SessionManager.list(cwd, sessionDir)).toHaveLength(0);

		manager.appendMessage({ role: "user", content: "queued before assistant", timestamp: Date.now() });
		manager.flushSync();

		expect(fs.existsSync(sessionFile)).toBe(false);
		expect(await SessionManager.list(cwd, sessionDir)).toHaveLength(0);
	});

	it("lets explicit rewrites materialize pre-assistant entries", async () => {
		const cwd = makeTempDir("@pi-explicit-rewrite-cwd-");
		const sessionDir = path.join(cwd, "sessions");
		const manager = SessionManager.create(cwd, sessionDir);
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file path");

		manager.appendMessage({ role: "user", content: "persist me", timestamp: Date.now() });
		await manager.rewriteEntries();

		expect(fs.existsSync(sessionFile)).toBe(true);
		const entries = readJsonl(sessionFile);
		expect(entries).toHaveLength(2);
		expect(messageRole(entries[1] ?? {})).toBe("user");
		expect(messageContent(entries[1] ?? {})).toBe("persist me");
	});
});
