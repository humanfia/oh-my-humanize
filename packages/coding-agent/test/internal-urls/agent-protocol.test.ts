import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-protocol-"));
	try {
		return await fn(dir);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

function fakeSession(artifactsDir: string): AgentSession {
	return {
		messages: [{ role: "user", content: "live transcript", timestamp: 1 }],
		sessionManager: {
			getArtifactsDir: () => artifactsDir,
		},
	} as unknown as AgentSession;
}

describe("agent:// protocol", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		InternalUrlRouter.resetForTests();
	});

	afterEach(() => {
		InternalUrlRouter.resetForTests();
		AgentRegistry.resetGlobalForTests();
	});

	it("distinguishes a running agent transcript from a finalized output artifact", async () => {
		await withTempDir(async dir => {
			const artifactsDir = path.join(dir, "artifacts");
			await fs.mkdir(artifactsDir, { recursive: true });
			await Bun.write(path.join(artifactsDir, "planner.md"), "planner output");
			AgentRegistry.global().register({
				id: "buildBranch",
				displayName: "Build branch",
				kind: "sub",
				session: fakeSession(artifactsDir),
				status: "running",
			});

			const error = await InternalUrlRouter.instance()
				.resolve("agent://buildBranch")
				.then(
					() => null,
					err => err as Error,
				);

			expect(error).toBeInstanceOf(Error);
			expect(error?.message).toContain("Output not ready: buildBranch");
			expect(error?.message).toContain("Agent buildBranch is running");
			expect(error?.message).toContain("Read the transcript with history://buildBranch");
			expect(error?.message).toContain("Available finalized outputs: planner");
		});
	});
});
