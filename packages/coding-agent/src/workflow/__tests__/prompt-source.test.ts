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
		expect(prompt?.value).toContain("__omh_compacted_binding");
		expect(prompt?.value).toContain('"name": "evidence"');
		expect(prompt?.value).toContain("originalBytes");
		expect(prompt?.value).toContain("sha256:");
		expect(prompt?.value).toContain("tail evidence: validation 896 passed");
	});

	it("keeps compacted JSON template bindings parseable", async () => {
		const packageRoot = await makePackageRoot();
		await Bun.write(`${packageRoot}/audit.md`, ["Inventory:", "{{inventory}}"].join("\n"));
		const node: WorkflowNode = {
			id: "auditApiDocs",
			type: "agent",
			reads: ["/inventory"],
			promptSource: {
				kind: "template",
				file: "audit.md",
				bindings: {
					inventory: { kind: "state", path: "/inventory" },
				},
			},
		};

		const prompt = await resolveWorkflowPrompt(node, {
			packageRoot,
			state: {
				inventory: {
					status: "complete_read_only",
					inspected_surfaces: Array.from({ length: 120 }, (_, index) => ({
						file: `docs/surface-${index}.md`,
						evidence: "click documentation behavior ".repeat(20),
					})),
					ranked_risks_for_next_node: [{ rank: 1, risk: "suffix stripping docs gap" }],
				},
			},
			completedActivations: [],
			parentActivationIds: [],
			maxPromptBytes: 2048,
		});

		const value = prompt?.value ?? "";
		const compacted = value.slice(value.indexOf("{"));
		const parsed = JSON.parse(compacted) as Record<string, unknown>;
		expect(parsed.status).toBe("complete_read_only");
		expect(parsed.__omh_compacted_binding).toMatchObject({
			name: "inventory",
			node: "auditApiDocs",
		});
		expect(value).toContain("suffix stripping docs gap");
	});
});

async function makePackageRoot(): Promise<string> {
	const parent = path.join(process.cwd(), "temp");
	await fs.mkdir(parent, { recursive: true });
	const dir = await fs.mkdtemp(path.join(parent, "workflow-prompt-source-"));
	tempDirs.push(dir);
	return dir;
}
