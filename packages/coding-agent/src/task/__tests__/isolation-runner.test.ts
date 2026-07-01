import { describe, expect, it } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { materializeDeclaredWorkflowArtifacts } from "../isolation-runner";

describe("isolated workflow artifacts", () => {
	it("copies declared workflow-output artifacts from an isolated worktree to the parent workspace", async () => {
		using tempDir = TempDir.createSync("@omh-isolated-workflow-artifacts-");
		const parentRoot = `${tempDir.path()}/parent`;
		const isolationDir = `${tempDir.path()}/lane`;
		await Bun.write(`${isolationDir}/workflow-output/report.md`, "lane report\n");
		await Bun.write(`${isolationDir}/workflow-output/candidate.diff`, "diff --git a/a b/a\n");

		const result = await materializeDeclaredWorkflowArtifacts({
			parentRoot,
			isolationDir,
			result: {
				id: "branch",
				exitCode: 0,
				extractedToolData: {
					yield: [
						{
							status: "success",
							data: {
								artifacts: ["workflow-output/report.md"],
								statePatch: [
									{
										op: "set",
										path: "/branch",
										value: { patchPath: "workflow-output/candidate.diff" },
									},
								],
							},
						},
					],
				},
			},
		});

		expect(result).toEqual({
			copied: ["workflow-output/report.md", "workflow-output/candidate.diff"],
			missing: [],
		});
		expect(await Bun.file(`${parentRoot}/workflow-output/report.md`).text()).toBe("lane report\n");
		expect(await Bun.file(`${parentRoot}/workflow-output/candidate.diff`).text()).toBe("diff --git a/a b/a\n");
	});

	it("reports missing declared workflow-output artifacts instead of advertising false paths", async () => {
		using tempDir = TempDir.createSync("@omh-isolated-workflow-artifacts-missing-");
		const parentRoot = `${tempDir.path()}/parent`;
		const isolationDir = `${tempDir.path()}/lane`;

		const result = await materializeDeclaredWorkflowArtifacts({
			parentRoot,
			isolationDir,
			result: {
				id: "branch",
				exitCode: 0,
				extractedToolData: {
					yield: [
						{
							data: {
								artifacts: ["workflow-output/missing.md"],
							},
						},
					],
				},
			},
		});

		expect(result).toEqual({
			copied: [],
			missing: ["workflow-output/missing.md"],
		});
		expect(await Bun.file(`${parentRoot}/workflow-output/missing.md`).exists()).toBe(false);
	});
});
