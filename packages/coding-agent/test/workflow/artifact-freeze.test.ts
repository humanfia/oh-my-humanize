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
		expect(freeze.checkpointPolicy).toEqual({ stopDeadlineMs: 50 });
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

	it("freezes workflow block change request file declarations as artifact resources", async () => {
		const dir = await createTempDir();
		await fs.mkdir(path.join(dir, "release", "changes"), { recursive: true });
		const flowPath = path.join(dir, "release.omhflow");
		await Bun.write(
			path.join(dir, "release", "changes", "promote.json"),
			JSON.stringify({
				id: "promote-positive-branch",
				reason: "promote the selected branch",
				operations: [{ op: "add_node", node: { id: "verify", type: "script" } }],
				frontierMapping: { build: "verify" },
			}),
		);
		await Bun.write(
			flowPath,
			omhflowSource(`
change_request:
  id: promote-positive-branch
  file: changes/promote.json
nodes:
  build:
    type: script
    script:
      inline: |
        return { summary: "built" };
edges: []
`),
		);

		const artifact = await loadWorkflowArtifact(flowPath);
		const freeze = await freezeWorkflowArtifact(artifact);

		expect(artifact.changeRequests).toEqual([{ id: "promote-positive-branch", path: "changes/promote.json" }]);
		expect(freeze.changeRequests).toEqual([{ id: "promote-positive-branch", path: "changes/promote.json" }]);
		expect(freeze.resourceSnapshots.map(snapshot => snapshot.path)).toEqual(["changes/promote.json"]);
	});

	it("rejects declared change request files with unsupported operations before production freeze", async () => {
		const dir = await createTempDir();
		await fs.mkdir(path.join(dir, "release", "changes"), { recursive: true });
		const flowPath = path.join(dir, "release.omhflow");
		await Bun.write(
			path.join(dir, "release", "changes", "bad.json"),
			JSON.stringify({
				id: "bad-change",
				operations: [{ op: "teleport_node", nodeId: "build" }],
			}),
		);
		await Bun.write(
			flowPath,
			omhflowSource(`
change_request:
  id: bad-change
  file: changes/bad.json
nodes:
  build:
    type: script
    script:
      inline: |
        return { summary: "built" };
edges: []
`),
		);

		const artifact = await loadWorkflowArtifact(flowPath);

		await expect(freezeWorkflowArtifact(artifact)).rejects.toThrow(
			'changes/bad.json: operations.0: unsupported workflow change operation "teleport_node"',
		);
	});

	it("rejects change request file declarations that escape the resource directory", async () => {
		const dir = await createTempDir();
		await fs.mkdir(path.join(dir, "release"), { recursive: true });
		await Bun.write(path.join(dir, "change.json"), "{}\n");
		const flowPath = path.join(dir, "release.omhflow");
		await Bun.write(
			flowPath,
			omhflowSource(`
change_request:
  id: escaping-change
  file: ../change.json
nodes:
  build:
    type: script
    script:
      inline: |
        return { summary: "built" };
edges: []
`),
		);

		const artifact = await loadWorkflowArtifact(flowPath);

		await expect(freezeWorkflowArtifact(artifact)).rejects.toThrow(
			'workflow resource path "../change.json" escapes the same-name resource directory',
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
    script:
      inline: |
        return { summary: "built" };
edges: []
\`\`\`
`,
		);

		const artifact = await loadWorkflowArtifact(flowPath);

		await expect(freezeWorkflowArtifact(artifact)).rejects.toThrow(
			".omhflow frontmatter must define checkpoint.stopDeadlineMs for production freeze",
		);
	});

	it("rejects non-positive checkpoint stop deadlines before production freeze", async () => {
		const dir = await createTempDir();
		await fs.mkdir(path.join(dir, "release"), { recursive: true });
		const flowPath = path.join(dir, "release.omhflow");
		await Bun.write(
			flowPath,
			`---
name: invalid-deadline
version: 1
schema: omhflow/v1
checkpoint:
  stopDeadlineMs: -1
changePolicy:
  agentsCanPropose: true
  humansCanApprove: true
---
# Invalid Deadline

\`\`\`yaml workflow
nodes:
  build:
    type: script
    script:
      inline: |
        return { summary: "built" };
edges: []
\`\`\`
`,
		);

		const artifact = await loadWorkflowArtifact(flowPath);

		await expect(freezeWorkflowArtifact(artifact)).rejects.toThrow(
			".omhflow frontmatter checkpoint.stopDeadlineMs must be a positive number",
		);
	});

	it("accepts checkpoint policy declared in the workflow DSL block", async () => {
		const dir = await createTempDir();
		await fs.mkdir(path.join(dir, "release"), { recursive: true });
		const flowPath = path.join(dir, "release.omhflow");
		await Bun.write(
			flowPath,
			`---
name: release-flow
version: 1
schema: omhflow/v1
changePolicy:
  agentsCanPropose: true
  humansCanApprove: true
---
# Release Flow

\`\`\`yaml workflow
checkpoint_policy:
  stopDeadlineMs: 125
nodes:
  build:
    type: script
    script:
      inline: |
        return { summary: "built" };
edges: []
\`\`\`
`,
		);

		const artifact = await loadWorkflowArtifact(flowPath);
		const freeze = await freezeWorkflowArtifact(artifact);

		expect(artifact.metadata.checkpoint).toEqual({ stopDeadlineMs: 125 });
		expect(freeze.checkpointPolicy).toEqual({ stopDeadlineMs: 125 });
	});

	it("accepts change policy declared in the workflow DSL block", async () => {
		const dir = await createTempDir();
		await fs.mkdir(path.join(dir, "release"), { recursive: true });
		const flowPath = path.join(dir, "release.omhflow");
		await Bun.write(
			flowPath,
			`---
name: release-flow
version: 1
schema: omhflow/v1
checkpoint:
  stopDeadlineMs: 50
---
# Release Flow

\`\`\`yaml workflow
change_policy:
  agentsCanPropose: true
  humansCanApprove: true
  supervisorsCanApprove: true
nodes:
  build:
    type: script
    script:
      inline: |
        return { summary: "built" };
edges: []
\`\`\`
`,
		);

		const artifact = await loadWorkflowArtifact(flowPath);
		const freeze = await freezeWorkflowArtifact(artifact);

		expect(artifact.metadata.changePolicy).toEqual({
			agentsCanPropose: true,
			humansCanApprove: true,
			supervisorsCanApprove: true,
		});
		expect(freeze.changePolicy).toEqual({
			agentsCanPropose: true,
			humansCanApprove: true,
			supervisorsCanApprove: true,
		});
	});

	it("rejects conflicting frontmatter and workflow DSL checkpoint policies", async () => {
		const dir = await createTempDir();
		await fs.mkdir(path.join(dir, "release"), { recursive: true });
		const flowPath = path.join(dir, "release.omhflow");
		await Bun.write(
			flowPath,
			omhflowSource(`
checkpoint_policy:
  stopDeadlineMs: 125
nodes:
  build:
    type: script
edges: []
`),
		);

		await expect(loadWorkflowArtifact(flowPath)).rejects.toThrow(
			"workflow block checkpoint_policy conflicts with frontmatter.checkpoint",
		);
	});

	it("rejects conflicting frontmatter and workflow DSL change policies", async () => {
		const dir = await createTempDir();
		await fs.mkdir(path.join(dir, "release"), { recursive: true });
		const flowPath = path.join(dir, "release.omhflow");
		await Bun.write(
			flowPath,
			omhflowSource(`
change_policy:
  agentsCanPropose: false
  humansCanApprove: true
nodes:
  build:
    type: script
edges: []
`),
		);

		await expect(loadWorkflowArtifact(flowPath)).rejects.toThrow(
			"workflow block change_policy conflicts with frontmatter.changePolicy",
		);
	});

	it("rejects script nodes without inline code or file resources before production freeze", async () => {
		const dir = await createTempDir();
		await fs.mkdir(path.join(dir, "release"), { recursive: true });
		const flowPath = path.join(dir, "release.omhflow");
		await Bun.write(
			flowPath,
			omhflowSource(`
nodes:
  baseline:
    type: script
edges: []
`),
		);

		const artifact = await loadWorkflowArtifact(flowPath);

		await expect(freezeWorkflowArtifact(artifact)).rejects.toThrow(
			'workflow script node "baseline" must define inline code or a script file before production freeze',
		);
	});

	it("rejects review and human nodes without prompt sources before production freeze", async () => {
		const dir = await createTempDir();
		await fs.mkdir(path.join(dir, "release"), { recursive: true });
		const flowPath = path.join(dir, "release.omhflow");
		await Bun.write(
			flowPath,
			omhflowSource(`
nodes:
  approve:
    type: human
  review:
    type: review
edges:
  - from: approve
    to: review
`),
		);

		const artifact = await loadWorkflowArtifact(flowPath);

		await expect(freezeWorkflowArtifact(artifact)).rejects.toThrow(
			'workflow human node "approve" must define a prompt before production freeze',
		);
	});

	it("rejects invalid state permission scopes before production freeze", async () => {
		const dir = await createTempDir();
		await fs.mkdir(path.join(dir, "release"), { recursive: true });
		const flowPath = path.join(dir, "release.omhflow");
		await Bun.write(
			flowPath,
			omhflowSource(`
nodes:
  build:
    type: script
    script:
      inline: |
        return { summary: "built" };
    writes:
      - state/build
edges: []
`),
		);

		const artifact = await loadWorkflowArtifact(flowPath);

		await expect(freezeWorkflowArtifact(artifact)).rejects.toThrow(
			'workflow node "build" write scope must be a JSON pointer: state/build',
		);
	});

	it("rejects prompt state reads that are not declared in node permissions before production freeze", async () => {
		const dir = await createTempDir();
		await fs.mkdir(path.join(dir, "release"), { recursive: true });
		const flowPath = path.join(dir, "release.omhflow");
		await Bun.write(
			flowPath,
			omhflowSource(`
nodes:
  review:
    type: review
    prompt:
      state: /reviewPrompt
    reads:
      - /other
    gates:
      - finish
edges: []
`),
		);

		const artifact = await loadWorkflowArtifact(flowPath);

		await expect(freezeWorkflowArtifact(artifact)).rejects.toThrow(
			'workflow node "review" prompt reads "/reviewPrompt" outside declared read scopes',
		);
	});

	it("rejects prompt template output reads outside node permissions before production freeze", async () => {
		const dir = await createTempDir();
		await fs.mkdir(path.join(dir, "release", "prompts"), { recursive: true });
		await Bun.write(path.join(dir, "release", "prompts", "build.md"), "Review: {{reviewSummary}}\n");
		const flowPath = path.join(dir, "release.omhflow");
		await Bun.write(
			flowPath,
			omhflowSource(`
nodes:
  review:
    type: review
    prompt: Review the implementation.
  build:
    type: agent
    agent: task
    reads:
      - /plan
    prompt:
      template:
        file: prompts/build.md
        bindings:
          reviewSummary:
            output:
              node: review
              path: /summary
              activation: latest-completed
edges:
  - from: review
    to: build
`),
		);

		const artifact = await loadWorkflowArtifact(flowPath);

		await expect(freezeWorkflowArtifact(artifact)).rejects.toThrow(
			'workflow node "build" prompt reads "/summary" outside declared read scopes',
		);
	});

	it("rejects waitFor references to unknown nodes before production freeze", async () => {
		const dir = await createTempDir();
		await fs.mkdir(path.join(dir, "release"), { recursive: true });
		const flowPath = path.join(dir, "release.omhflow");
		await Bun.write(
			flowPath,
			omhflowSource(`
nodes:
  review:
    type: review
    waitFor:
      - missing
edges: []
`),
		);

		await expect(
			(async () => {
				const artifact = await loadWorkflowArtifact(flowPath);
				await freezeWorkflowArtifact(artifact);
			})(),
		).rejects.toThrow('node "review" waitFor references unknown node "missing"');
	});

	it("rejects migration frontier targets that are absent from the frozen graph", async () => {
		const dir = await createTempDir();
		await fs.mkdir(path.join(dir, "release"), { recursive: true });
		const flowPath = path.join(dir, "release.omhflow");
		await Bun.write(
			flowPath,
			omhflowSource(`
migrations:
  - from: weak-review
    to: strong-review
    frontierMapping:
      weakReview: strongReview
nodes:
  build:
    type: script
edges: []
`),
		);

		await expect(
			(async () => {
				const artifact = await loadWorkflowArtifact(flowPath);
				await freezeWorkflowArtifact(artifact);
			})(),
		).rejects.toThrow(
			'migration "weak-review" -> "strong-review" maps frontier "weakReview" to unknown node "strongReview"',
		);
	});

	it("captures dynamic foreach and child workflow metadata in static checks", async () => {
		const dir = await createTempDir();
		await fs.mkdir(path.join(dir, "release"), { recursive: true });
		const childPath = path.join(dir, "child.omhflow");
		await Bun.write(
			childPath,
			omhflowSource(`
nodes:
  child:
    type: script
    script:
      inline: |
        return { summary: "child" };
edges: []
`),
		);
		const flowPath = path.join(dir, "release.omhflow");
		await Bun.write(
			flowPath,
			omhflowSource(`
nodes:
  fanout:
    type: foreach
    foreach:
      items: /tasks
      key: /id
      output:
        path: /childRuns
      body:
        workflow:
          path: ./child.omhflow
edges: []
`),
		);

		const artifact = await loadWorkflowArtifact(flowPath);
		const freeze = await freezeWorkflowArtifact(artifact);

		expect(freeze.staticCheckReport.checks).toContainEqual({
			name: "dynamic-topology",
			status: "passed",
			details: ["foreach fanout reads /tasks -> /childRuns", "child workflow fanout -> ./child.omhflow"],
		});
		expect(freeze.childWorkflowHashes?.map(hash => hash.path)).toEqual(["child.omhflow"]);
		expect(freeze.childWorkflowHashes?.[0]?.hash).toMatch(/^sha256:/u);
	});

	it("rejects missing child workflow files before production freeze", async () => {
		const dir = await createTempDir();
		await fs.mkdir(path.join(dir, "release"), { recursive: true });
		const flowPath = path.join(dir, "release.omhflow");
		await Bun.write(
			flowPath,
			omhflowSource(`
nodes:
  invokeChild:
    type: workflow
    workflow:
      path: ./missing-child.omhflow
edges: []
`),
		);

		const artifact = await loadWorkflowArtifact(flowPath);

		await expect(freezeWorkflowArtifact(artifact)).rejects.toThrow(
			'workflow child node "invokeChild" references unreadable child flow "./missing-child.omhflow"',
		);
	});

	it("rejects pure script loops before production freeze", async () => {
		const dir = await createTempDir();
		await fs.mkdir(path.join(dir, "release"), { recursive: true });
		const flowPath = path.join(dir, "release.omhflow");
		await Bun.write(
			flowPath,
			omhflowSource(`
nodes:
  hold:
    type: script
    script:
      inline: |
        return { summary: "hold tick" };
  check:
    type: script
    script:
      inline: |
        return { summary: "still pending" };
edges:
  - from: hold
    to: check
  - from: check
    to: hold
    when: state.runtime.minimumSatisfied == false
`),
		);

		const artifact = await loadWorkflowArtifact(flowPath);

		await expect(freezeWorkflowArtifact(artifact)).rejects.toThrow(
			'workflow script-only loop "check -> hold" cannot prove meaningful progress before production freeze',
		);
	});

	it("allows review-controlled loops because they can produce semantic progress", async () => {
		const dir = await createTempDir();
		await fs.mkdir(path.join(dir, "release"), { recursive: true });
		const flowPath = path.join(dir, "release.omhflow");
		await Bun.write(
			flowPath,
			omhflowSource(`
nodes:
  build:
    type: agent
    agent: task
    prompt:
      inline: Build the requested change.
  review:
    type: review
    agent: reviewer
    prompt:
      inline: Review the build and return continue or finish.
    gates:
      - continue
      - finish
edges:
  - from: build
    to: review
  - from: review
    to: build
    when: outputs.review.verdict == "continue"
`),
		);

		const artifact = await loadWorkflowArtifact(flowPath);

		await expect(freezeWorkflowArtifact(artifact)).resolves.toMatchObject({
			staticCheckReport: { status: "passed" },
		});
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
