import { afterEach, describe, expect, it } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { registerArtifactsDir, resetRegisteredArtifactDirsForTests } from "../registry-helpers";
import { InternalUrlRouter } from "../router";

describe("agent-output:// protocol", () => {
	afterEach(() => {
		resetRegisteredArtifactDirsForTests();
		InternalUrlRouter.resetForTests();
	});

	it("resolves workflow agent output references as finalized agent artifacts", async () => {
		using tempDir = TempDir.createSync("@omh-agent-output-protocol-");
		const artifactsDir = tempDir.path();
		await Bun.write(`${artifactsDir}/workflow-try1.md`, "# Candidate Output\n\nchanged count_words\n");
		registerArtifactsDir(artifactsDir);

		const resource = await InternalUrlRouter.instance().resolve("agent-output://workflow-try1");

		expect(resource.content).toBe("# Candidate Output\n\nchanged count_words\n");
		expect(resource.contentType).toBe("text/markdown");
		expect(resource.sourcePath).toBe(`${artifactsDir}/workflow-try1.md`);
	});
});
