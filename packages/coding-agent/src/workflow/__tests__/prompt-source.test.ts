import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { WorkflowNode } from "../definition";
import { resolveWorkflowPrompt } from "../prompt-source";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.map(dir => fs.rm(dir, { recursive: true, force: true })));
	tempDirs.length = 0;
});

describe("resolveWorkflowPrompt", () => {
	it("compacts large template bindings instead of failing reviewer prompts", async () => {
		const packageRoot = await makePackageRoot();
		await Bun.write(
			path.join(packageRoot, "review.md"),
			["Review the reproduced evidence.", "", "Task:", "{{task}}", "", "Evidence:", "{{evidence}}"].join("\n"),
		);
		const node: WorkflowNode = {
			id: "reportReview",
			type: "review",
			reads: ["/task", "/evidence"],
			promptSource: {
				kind: "template",
				file: "review.md",
				bindings: {
					task: { kind: "state", path: "/task" },
					evidence: { kind: "state", path: "/evidence" },
				},
			},
		};

		const prompt = await resolveWorkflowPrompt(node, {
			packageRoot,
			state: {
				task: "Reproduce alias configuration behavior and review the combined validation evidence.",
				evidence: {
					rows: Array.from({ length: 160 }, (_, index) => ({
						case: `alias-config-${index}`,
						stdout: "passed ".repeat(60),
						stderr: "warning ".repeat(60),
					})),
					finalValidationSummary: "tail evidence: validation 896 passed",
				},
			},
			completedActivations: [],
			parentActivationIds: [],
			maxPromptBytes: 2048,
		});

		expect(prompt).toBeDefined();
		expect(prompt?.byteLength).toBeLessThanOrEqual(2048);
		expect(prompt?.value).toContain("Review the reproduced evidence.");
		expect(prompt?.value).toContain("Reproduce alias configuration behavior");
		expect(prompt?.value).toContain('workflow prompt binding "evidence" was compacted');
		expect(prompt?.value).toContain("originalBytes");
		expect(prompt?.value).toContain("sha256:");
		expect(prompt?.value).toContain("tail evidence: validation 896 passed");
	});
});

async function makePackageRoot(): Promise<string> {
	const parent = path.join(process.cwd(), "temp");
	await fs.mkdir(parent, { recursive: true });
	const dir = await fs.mkdtemp(path.join(parent, "workflow-prompt-source-"));
	tempDirs.push(dir);
	return dir;
}
