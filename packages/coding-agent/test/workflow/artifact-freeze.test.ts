import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { freezeWorkflowArtifact } from "../../src/workflow/freeze";
import { loadWorkflowArtifact } from "../../src/workflow/package-loader";

const tempDirs: string[] = [];
const workflowTestTempRoot = path.resolve(import.meta.dir, "../../../..", "temp", "workflow-tests");

async function createTempDir(): Promise<string> {
	await fs.mkdir(workflowTestTempRoot, { recursive: true });
	const dir = await fs.mkdtemp(path.join(workflowTestTempRoot, "omp-omhflow-artifact-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe(".omhflow artifact freeze", () => {
	it("freezes a markdown workflow file with resources from the same-name directory", async () => {
		const dir = await createTempDir();
		await fs.mkdir(path.join(dir, "release", "prompts"), { recursive: true });
		await fs.mkdir(path.join(dir, "release", "scripts"), { recursive: true });
		await Bun.write(path.join(dir, "release", "prompts", "build.md"), "Build the release artifact.\n");
		await Bun.write(path.join(dir, "release", "scripts", "check.js"), "return { ok: true };\n");
		const flowPath = path.join(dir, "release.omhflow");
		await Bun.write(
			flowPath,
			omhflowSource(`
nodes:
  build:
    type: agent
    agent: task
    model:
      role: builder
    prompt:
      file: prompts/build.md
  verify:
    type: script
    script:
      language: js
      file: scripts/check.js
edges:
  - from: build
    to: verify
`),
		);

		const artifact = await loadWorkflowArtifact(flowPath);
		const freeze = await freezeWorkflowArtifact(artifact);

		expect(artifact.flowPath).toBe(flowPath);
		expect(artifact.resourceDir).toBe(path.join(dir, "release"));
		expect(artifact.definition.nodes.map(node => node.id)).toEqual(["build", "verify"]);
		expect(freeze.id).toStartWith("flowfreeze:");
		expect(freeze.flowPath).toBe(flowPath);
		expect(freeze.resourceDir).toBe(path.join(dir, "release"));
		expect(freeze.mainContentHash).toStartWith("sha256:");
		expect(freeze.canonicalGraphHash).toStartWith("sha256:");
		expect(freeze.resourceHashes.map(entry => entry.path)).toEqual(["prompts/build.md", "scripts/check.js"]);
		expect(freeze.staticCheckReport.status).toBe("passed");
		expect(freeze.sourceMapping.nodes.build).toMatchObject({ sourceBlock: "workflow:0" });
		expect(freeze.portableDefaults.models.roles.builder).toBe("openai/gpt-4o");
	});

	it("rejects resource references that escape the same-name resource directory", async () => {
		const dir = await createTempDir();
		await fs.mkdir(path.join(dir, "release"), { recursive: true });
		await Bun.write(path.join(dir, "secret.md"), "do not read me\n");
		const flowPath = path.join(dir, "release.omhflow");
		await Bun.write(
			flowPath,
			omhflowSource(`
nodes:
  build:
    type: agent
    agent: task
    prompt:
      file: ../secret.md
edges: []
`),
		);

		const artifact = await loadWorkflowArtifact(flowPath);

		await expect(freezeWorkflowArtifact(artifact)).rejects.toThrow(
			'workflow resource path "../secret.md" escapes the same-name resource directory',
		);
	});

	it("does not fall back to cwd or legacy package-root resources", async () => {
		const dir = await createTempDir();
		await fs.mkdir(path.join(dir, "release"), { recursive: true });
		await fs.mkdir(path.join(dir, "prompts"), { recursive: true });
		await Bun.write(path.join(dir, "prompts", "build.md"), "legacy package-root prompt\n");
		const flowPath = path.join(dir, "release.omhflow");
		await Bun.write(
			flowPath,
			omhflowSource(`
nodes:
  build:
    type: agent
    agent: task
    prompt:
      file: ./prompts/build.md
edges: []
`),
		);

		const artifact = await loadWorkflowArtifact(flowPath);

		await expect(freezeWorkflowArtifact(artifact)).rejects.toThrow(
			'workflow resource path "./prompts/build.md" was not found in the same-name resource directory',
		);
	});

	it("rejects production freezes without checkpoint and change policy", async () => {
		const dir = await createTempDir();
		await fs.mkdir(path.join(dir, "release"), { recursive: true });
		const flowPath = path.join(dir, "release.omhflow");
		await Bun.write(
			flowPath,
			`---
name: release-flow
version: 1
schema: omhflow/v1
---
# Release Flow

\`\`\`yaml workflow
nodes:
  build:
    type: script
edges: []
\`\`\`
`,
		);

		const artifact = await loadWorkflowArtifact(flowPath);

		await expect(freezeWorkflowArtifact(artifact)).rejects.toThrow(
			".omhflow frontmatter must define checkpoint.stopDeadlineMs for production freeze",
		);
	});
});

function omhflowSource(workflowBlock: string): string {
	return `---
name: release-flow
version: 1
schema: omhflow/v1
models:
  roles:
    builder: openai/gpt-4o
  defaults:
    agent: builder
checkpoint:
  stopDeadlineMs: 50
changePolicy:
  agentsCanPropose: true
  humansCanApprove: true
---
# Release Flow

\`\`\`yaml workflow
${workflowBlock.trim()}
\`\`\`
`;
}
