import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { freezeWorkflowArtifact } from "../../src/workflow/freeze";
import { loadWorkflowArtifact, loadWorkflowPackage } from "../../src/workflow/package-loader";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-workflow-package-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("workflow package loader", () => {
	it("loads workflow.yml from a package directory", async () => {
		const dir = await createTempDir();
		const workflowPath = path.join(dir, "workflow.yml");
		await Bun.write(
			workflowPath,
			`
name: package-demo
version: 1
nodes:
  build:
    type: agent
edges: []
`,
		);

		const pkg = await loadWorkflowPackage(dir);

		expect(pkg.rootPath).toBe(dir);
		expect(pkg.workflowPath).toBe(workflowPath);
		expect(pkg.definition.name).toBe("package-demo");
		expect(pkg.definition.sourcePath).toBe(workflowPath);
	});

	it("loads a direct workflow YAML file path", async () => {
		const dir = await createTempDir();
		const workflowPath = path.join(dir, "custom.yml");
		await Bun.write(
			workflowPath,
			`
name: file-demo
version: 1
nodes:
  review:
    type: review
edges: []
`,
		);

		const pkg = await loadWorkflowPackage(workflowPath);

		expect(pkg.rootPath).toBe(dir);
		expect(pkg.workflowPath).toBe(workflowPath);
		expect(pkg.definition.nodes.map(node => node.id)).toEqual(["review"]);
	});

	it("composes an imported .omhflow artifact as a namespaced reusable flow", async () => {
		const dir = await createTempDir();
		await fs.mkdir(path.join(dir, "kda", "humanize", "prompts"), { recursive: true });
		await Bun.write(
			path.join(dir, "kda", "humanize", "prompts", "review.md"),
			"Review the implementation summary.\n",
		);
		const humanizePath = path.join(dir, "kda", "humanize.omhflow");
		await Bun.write(
			humanizePath,
			artifactSource(
				"humanize-rlcr",
				`
capabilities:
  agents:
    - task
  tools:
    - eval
resources:
  - path: prompts/review.md
    kind: prompt
sequence:
  - node:
      id: planQuiz
      type: human
      prompt: Confirm plan understanding.
  - template:
      kind: retry_until
      body:
        id: implementRound
        type: agent
        agent: task
        prompt: Implement one round and write a summary.
      review:
        id: codexSummaryReview
        type: review
        prompt:
          file: prompts/review.md
        gates:
          - retry
          - complete
        fallbackVerdict: retry
      retryWhen: state.summaryVerdict == "retry"
	`,
			),
		);
		const kdaPath = path.join(dir, "kda.omhflow");
		await Bun.write(
			kdaPath,
			artifactSource(
				"kda-flow",
				`
imports:
  humanize:
    path: ./kda/humanize.omhflow
capabilities:
  agents:
    - profiler
sequence:
  - parallel:
      - node:
          id: kernelWikiResearch
          type: agent
          agent: profiler
          prompt: Research the kernel design space.
      - node:
          id: baselineProfile
          type: script
          script:
            inline: |
              return { summary: "profiled baseline" };
    join:
      id: draftCandidatePlan
      type: script
      script:
        inline: |
          return { summary: "drafted candidate plan" };
  - use: humanize
  - node:
      id: promotionDecision
      type: review
      prompt: Decide whether evidence supports promotion.
      gates:
        - reject
        - promote
`,
			),
		);

		const artifact = await loadWorkflowArtifact(kdaPath);

		expect(artifact.definition.nodes.map(node => [node.id, node.type])).toEqual([
			["kernelWikiResearch", "agent"],
			["baselineProfile", "script"],
			["draftCandidatePlan", "script"],
			["humanize__planQuiz", "human"],
			["humanize__implementRound", "agent"],
			["humanize__codexSummaryReview", "review"],
			["promotionDecision", "review"],
		]);
		expect(artifact.definition.nodes.find(node => node.id === "humanize__codexSummaryReview")?.fallbackVerdict).toBe(
			"retry",
		);
		expect(artifact.definition.edges.map(edge => [edge.from, edge.to, edge.condition?.source])).toEqual([
			["kernelWikiResearch", "draftCandidatePlan", undefined],
			["baselineProfile", "draftCandidatePlan", undefined],
			["draftCandidatePlan", "humanize__planQuiz", undefined],
			["humanize__planQuiz", "humanize__implementRound", undefined],
			["humanize__implementRound", "humanize__codexSummaryReview", undefined],
			["humanize__codexSummaryReview", "humanize__implementRound", 'state.summaryVerdict == "retry"'],
			["humanize__codexSummaryReview", "promotionDecision", '!(state.summaryVerdict == "retry")'],
		]);
		expect(artifact.definition.capabilities).toEqual({
			agents: ["profiler", "task"],
			tools: ["eval"],
		});
		expect(artifact.definition.resources).toEqual([{ path: "humanize/prompts/review.md", kind: "prompt" }]);
		expect(artifact.definition.nodes.find(node => node.id === "humanize__codexSummaryReview")?.promptSource).toEqual({
			kind: "file",
			path: "humanize/prompts/review.md",
		});
		const freeze = await freezeWorkflowArtifact(artifact);
		expect(freeze.resourceHashes.map(resource => resource.path)).toContain("humanize.omhflow");
	});

	it("namespaces imported subflow prompt template resources and output bindings", async () => {
		const dir = await createTempDir();
		await fs.mkdir(path.join(dir, "caller", "humanize", "prompts"), { recursive: true });
		await Bun.write(
			path.join(dir, "caller", "humanize", "prompts", "build.md"),
			"Plan:\n{{plan}}\n\nReview:\n{{reviewSummary}}\n",
		);
		await Bun.write(
			path.join(dir, "caller", "humanize.omhflow"),
			artifactSource(
				"humanize-template-prompt",
				`
resources:
  - path: prompts/build.md
    kind: prompt
sequence:
  - node:
      id: review
      type: review
      prompt: Review the current plan.
      gates:
        - retry
        - complete
  - node:
      id: build
      type: agent
      agent: task
      reads:
        - /plan
        - /summary
      prompt:
        template:
          file: prompts/build.md
          bindings:
            plan:
              state: /plan
            reviewSummary:
              output:
                node: review
                path: /summary
                activation: latest-completed
`,
			),
		);
		const callerPath = path.join(dir, "caller.omhflow");
		await Bun.write(
			callerPath,
			artifactSource(
				"caller-flow",
				`
imports:
  humanize:
    path: ./caller/humanize.omhflow
sequence:
  - use: humanize
`,
			),
		);

		const artifact = await loadWorkflowArtifact(callerPath);

		expect(artifact.definition.resources).toEqual([{ path: "humanize/prompts/build.md", kind: "prompt" }]);
		expect(artifact.definition.nodes.find(node => node.id === "humanize__build")?.promptSource).toEqual({
			kind: "template",
			file: "humanize/prompts/build.md",
			bindings: {
				plan: { kind: "state", path: "/plan" },
				reviewSummary: {
					kind: "output",
					node: "humanize__review",
					path: "/summary",
					activation: "latest-completed",
				},
			},
		});
	});

	it("rejects imported subflow resources that escape the caller artifact at freeze time", async () => {
		const dir = await createTempDir();
		await fs.mkdir(path.join(dir, "humanize", "prompts"), { recursive: true });
		await fs.mkdir(path.join(dir, "kda"), { recursive: true });
		await Bun.write(path.join(dir, "humanize", "prompts", "review.md"), "Review the implementation summary.\n");
		await Bun.write(
			path.join(dir, "humanize.omhflow"),
			artifactSource(
				"humanize-rlcr",
				`
resources:
  - path: prompts/review.md
    kind: prompt
sequence:
  - node:
      id: review
      type: review
      prompt:
        file: prompts/review.md
`,
			),
		);
		await Bun.write(
			path.join(dir, "kda.omhflow"),
			artifactSource(
				"kda-flow",
				`
imports:
  humanize:
    path: ./humanize.omhflow
sequence:
  - use: humanize
`,
			),
		);

		const artifact = await loadWorkflowArtifact(path.join(dir, "kda.omhflow"));

		expect(artifact.definition.resources).toEqual([{ path: "../humanize/prompts/review.md", kind: "prompt" }]);
		await expect(freezeWorkflowArtifact(artifact)).rejects.toThrow(
			'workflow resource path "../humanize/prompts/review.md" escapes the same-name resource directory',
		);
	});

	it("connects caller steps only to real exits of an imported subflow", async () => {
		const dir = await createTempDir();
		await fs.mkdir(path.join(dir, "caller", "humanize"), { recursive: true });
		const humanizePath = path.join(dir, "caller", "humanize.omhflow");
		await Bun.write(
			humanizePath,
			artifactSource(
				"humanize-with-finalize",
				`
sequence:
  - template:
      kind: retry_until
      body:
        id: implementRound
        type: agent
        agent: task
        prompt: Implement one round.
      review:
        id: summaryReview
        type: review
        prompt: Return retry or complete.
        gates:
          - retry
          - complete
      retryWhen: outputs.summaryReview.verdict == "retry"
  - node:
      id: finalize
      type: script
      script:
        inline: |
          return { summary: "finalized" };
`,
			),
		);
		const callerPath = path.join(dir, "caller.omhflow");
		await Bun.write(
			callerPath,
			artifactSource(
				"caller-flow",
				`
imports:
  humanize:
    path: ./caller/humanize.omhflow
sequence:
  - use: humanize
  - node:
      id: downstream
      type: script
      script:
        inline: |
          return { summary: "downstream" };
`,
			),
		);

		const artifact = await loadWorkflowArtifact(callerPath);

		expect(artifact.definition.edges.map(edge => [edge.from, edge.to, edge.condition?.source])).toEqual([
			["humanize__implementRound", "humanize__summaryReview", undefined],
			["humanize__summaryReview", "humanize__implementRound", 'outputs.humanize__summaryReview.verdict == "retry"'],
			["humanize__summaryReview", "humanize__finalize", '!(outputs.humanize__summaryReview.verdict == "retry")'],
			["humanize__finalize", "downstream", undefined],
		]);
	});

	it("namespaces output references on imported subflow boundary exits", async () => {
		const dir = await createTempDir();
		await fs.mkdir(path.join(dir, "caller", "humanize"), { recursive: true });
		await Bun.write(
			path.join(dir, "caller", "humanize.omhflow"),
			artifactSource(
				"humanize-boundary-exit",
				`
sequence:
  - template:
      kind: retry_until
      body:
        id: implementRound
        type: agent
        agent: task
        prompt: Implement one round.
      review:
        id: summaryReview
        type: review
        prompt: Return retry or complete.
        gates:
          - retry
          - complete
      retryWhen: outputs.summaryReview.verdict == "retry"
`,
			),
		);
		const callerPath = path.join(dir, "caller.omhflow");
		await Bun.write(
			callerPath,
			artifactSource(
				"caller-flow",
				`
imports:
  humanize:
    path: ./caller/humanize.omhflow
sequence:
  - use: humanize
  - node:
      id: downstream
      type: script
      script:
        inline: |
          return { summary: "downstream" };
`,
			),
		);

		const artifact = await loadWorkflowArtifact(callerPath);

		expect(artifact.definition.edges.map(edge => [edge.from, edge.to, edge.condition?.source])).toEqual([
			["humanize__implementRound", "humanize__summaryReview", undefined],
			["humanize__summaryReview", "humanize__implementRound", 'outputs.humanize__summaryReview.verdict == "retry"'],
			["humanize__summaryReview", "downstream", '!(outputs.humanize__summaryReview.verdict == "retry")'],
		]);
	});
});

function artifactSource(name: string, workflowBlock: string): string {
	return `---
name: ${name}
version: 1
schema: omhflow/v1
checkpoint:
  stopDeadlineMs: 30000
changePolicy:
  agentsCanPropose: true
  humansCanApprove: true
---
# ${name}

\`\`\`yaml workflow
${workflowBlock.trim()}
\`\`\`
`;
}
