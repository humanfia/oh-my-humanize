import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { compileWorkflowDslBlock } from "../../src/workflow/dsl";
import { freezeWorkflowArtifact } from "../../src/workflow/freeze";
import type { WorkflowNodeRuntimeHost } from "../../src/workflow/node-runtime";
import { loadWorkflowArtifact } from "../../src/workflow/package-loader";
import { runWorkflow } from "../../src/workflow/runner";

const tempDirs: string[] = [];
const workflowTestTempRoot = path.resolve(import.meta.dir, "../../../..", "temp", "workflow-tests");

async function createTempDir(): Promise<string> {
	await fs.mkdir(workflowTestTempRoot, { recursive: true });
	const dir = await fs.mkdtemp(path.join(workflowTestTempRoot, "omp-omhflow-dsl-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe(".omhflow structured DSL compiler", () => {
	it("compiles modules, sequence, parallel branches, and joins into a canonical graph", async () => {
		const dir = await createTempDir();
		await fs.mkdir(path.join(dir, "optimizer"), { recursive: true });
		const flowPath = path.join(dir, "optimizer.omhflow");
		await Bun.write(
			flowPath,
			`---
name: optimizer-flow
version: 1
schema: omhflow/v1
checkpoint:
  stopDeadlineMs: 50
changePolicy:
  agentsCanPropose: true
  humansCanApprove: true
---
# Optimizer Flow

\`\`\`yaml workflow
modules:
  integrateFeature:
    sequence:
      - node:
          id: integrate
          type: script
          script:
            inline: |
              return { summary: "integrated" };
      - node:
          id: review
          type: review
          prompt: Review the integrated feature.
          gates:
            - finish
sequence:
  - parallel:
      - node:
          id: tryTiling
          type: script
          script:
            inline: |
              return { summary: "tried tiling" };
      - node:
          id: tryFusion
          type: script
          script:
            inline: |
              return { summary: "tried fusion" };
    join:
      id: evaluate
      type: script
      script:
        inline: |
          return { summary: "evaluated candidates" };
  - use: integrateFeature
\`\`\`
`,
		);

		const artifact = await loadWorkflowArtifact(flowPath);
		const freeze = await freezeWorkflowArtifact(artifact);

		expect(artifact.definition.nodes.map(node => [node.id, node.type, node.waitFor])).toEqual([
			["tryTiling", "script", undefined],
			["tryFusion", "script", undefined],
			["evaluate", "script", ["tryTiling", "tryFusion"]],
			["integrate", "script", undefined],
			["review", "review", undefined],
		]);
		expect(artifact.definition.edges.map(edge => [edge.from, edge.to])).toEqual([
			["tryTiling", "evaluate"],
			["tryFusion", "evaluate"],
			["evaluate", "integrate"],
			["integrate", "review"],
		]);
		expect(freeze.canonicalGraphHash).toStartWith("sha256:");
		expect(freeze.sourceMapping.nodes.evaluate).toMatchObject({ sourceBlock: "workflow:0" });
	});

	it("rejects module cycles before graph compilation", async () => {
		const dir = await createTempDir();
		await fs.mkdir(path.join(dir, "cyclic"), { recursive: true });
		const flowPath = path.join(dir, "cyclic.omhflow");
		await Bun.write(
			flowPath,
			flowSource(`
modules:
  loop:
    use: loop
use: loop
`),
		);

		await expect(loadWorkflowArtifact(flowPath)).rejects.toThrow('modules.loop.use creates a module cycle at "loop"');
	});

	it("rejects artifacts with multiple workflow blocks", async () => {
		const dir = await createTempDir();
		await fs.mkdir(path.join(dir, "multi"), { recursive: true });
		const flowPath = path.join(dir, "multi.omhflow");
		await Bun.write(
			flowPath,
			`${flowSource(`
nodes:
  build:
    type: script
edges: []
`)}

\`\`\`yaml workflow
nodes:
  review:
    type: review
edges: []
\`\`\`
`,
		);

		await expect(loadWorkflowArtifact(flowPath)).rejects.toThrow(
			".omhflow must contain exactly one fenced workflow block",
		);
	});

	it("namespaces parsed template prompt output bindings in external modules", () => {
		const compiled = compileWorkflowDslBlock(
			{ sequence: [{ use: "humanize" }] },
			{
				externalModules: {
					humanize: {
						nodes: {
							review: { id: "review", type: "review", prompt: "Review." },
							build: {
								id: "build",
								type: "agent",
								agent: "task",
								promptSource: {
									kind: "template",
									file: "prompts/build.md",
									bindings: {
										reviewSummary: {
											kind: "output",
											node: "review",
											path: "/summary",
											activation: "latest-completed",
										},
									},
								},
							},
						},
						edges: [{ from: "review", to: "build" }],
						entries: ["review"],
						exits: [{ nodeId: "build" }],
						resourcePrefix: "humanize",
					},
				},
			},
		);

		expect(compiled.nodes).toMatchObject({
			humanize__build: {
				promptSource: {
					kind: "template",
					file: "humanize/prompts/build.md",
					bindings: {
						reviewSummary: {
							kind: "output",
							node: "humanize__review",
							path: "/summary",
							activation: "latest-completed",
						},
					},
				},
			},
		});
	});

	it("compiles workflow templates and carries static contracts into the freeze", async () => {
		const dir = await createTempDir();
		await fs.mkdir(path.join(dir, "templated", "prompts"), { recursive: true });
		await Bun.write(path.join(dir, "templated", "prompts", "brief.md"), "Optimize the hot path.\n");
		const flowPath = path.join(dir, "templated.omhflow");
		await Bun.write(
			flowPath,
			flowSource(`
stateSchema:
  version: 1
  shape:
    decision: object
    verdict: string
resources:
  - path: prompts/brief.md
    kind: prompt
capabilities:
  tools:
    - eval
  agents:
    - task
migrations:
  - from: search
    to: integrate
    frontierMapping:
      evaluate: integrate
sequence:
  - template:
      kind: parallel_search
      branches:
        - id: tryTiling
          type: script
          script:
            inline: |
              return { summary: "tried tiling" };
        - id: tryFusion
          type: script
          script:
            inline: |
              return { summary: "tried fusion" };
      join:
        id: evaluate
        type: script
        script:
          inline: |
            return { summary: "evaluated candidates" };
  - template:
      kind: retry_until
      body:
        id: integrate
        type: script
        script:
          inline: |
            return { summary: "integrated" };
      review:
        id: integrationReview
        type: review
        prompt: Review integration progress.
        gates:
          - retry
          - finish
      retryWhen: state.verdict == "retry"
  - template:
      kind: review_gate
      id: strongReview
      agent: task
      prompt: Perform the strong review.
      gates:
        - finish
`),
		);

		const artifact = await loadWorkflowArtifact(flowPath);
		const freeze = await freezeWorkflowArtifact(artifact);

		expect(artifact.definition.nodes.map(node => node.id)).toEqual([
			"tryTiling",
			"tryFusion",
			"evaluate",
			"integrate",
			"integrationReview",
			"strongReview",
		]);
		expect(artifact.definition.edges.map(edge => [edge.from, edge.to, edge.condition?.source])).toEqual([
			["tryTiling", "evaluate", undefined],
			["tryFusion", "evaluate", undefined],
			["evaluate", "integrate", undefined],
			["integrate", "integrationReview", undefined],
			["integrationReview", "integrate", 'state.verdict == "retry"'],
			["integrationReview", "strongReview", '!(state.verdict == "retry")'],
		]);
		expect(artifact.definition.resources).toEqual([{ path: "prompts/brief.md", kind: "prompt" }]);
		expect(artifact.definition.capabilities).toEqual({ tools: ["eval"], agents: ["task"] });
		expect(artifact.definition.migrations).toEqual([
			{ from: "search", to: "integrate", frontierMapping: { evaluate: "integrate" } },
		]);
		expect(artifact.definition.stateSchema).toEqual({ version: 1, shape: { decision: "object", verdict: "string" } });
		expect(freeze.resourceSnapshots.map(snapshot => snapshot.path)).toEqual(["prompts/brief.md"]);
		expect(freeze.staticCheckReport.checks.map(check => check.name)).toContain("contracts");
		expect(freeze.staticCheckReport.checks).toContainEqual({
			name: "state-schema",
			status: "passed",
			details: ["decision: object", "verdict: string"],
		});
	});

	it("does not continue past retry_until until the retry condition is false", async () => {
		const dir = await createTempDir();
		await fs.mkdir(path.join(dir, "retry-flow"), { recursive: true });
		const flowPath = path.join(dir, "retry-flow.omhflow");
		await Bun.write(
			flowPath,
			flowSource(`
sequence:
  - template:
      kind: retry_until
      body:
        id: integrate
        type: script
        script:
          inline: |
            return { summary: "integrated" };
      review:
        id: integrationReview
        type: review
        prompt: Review integration progress.
        gates:
          - retry
          - finish
      retryWhen: state.verdict == "retry"
  - node:
      id: downstream
      type: script
      script:
        inline: |
          return { summary: "downstream" };
`),
		);
		const artifact = await loadWorkflowArtifact(flowPath);
		const calls: string[] = [];
		let reviewCount = 0;
		const runtimeHost: WorkflowNodeRuntimeHost = {
			runScriptNode: async input => {
				calls.push(input.node.id);
				return { summary: input.node.id };
			},
			runReviewNode: async input => {
				calls.push(input.node.id);
				reviewCount += 1;
				return {
					summary: `review ${reviewCount}`,
					verdict: reviewCount === 1 ? "retry" : "finish",
				};
			},
		};

		await runWorkflow({
			host: createRunHost(),
			definition: artifact.definition,
			runId: "retry-flow-run",
			startNodeId: "integrate",
			runtimeHost,
		});

		expect(calls).toEqual(["integrate", "integrationReview", "integrate", "integrationReview", "downstream"]);
	});

	it("retries every parallel body entry before continuing past a review gate", async () => {
		const dir = await createTempDir();
		await fs.mkdir(path.join(dir, "parallel-retry-flow"), { recursive: true });
		const flowPath = path.join(dir, "parallel-retry-flow.omhflow");
		await Bun.write(
			flowPath,
			flowSource(`
sequence:
  - template:
      kind: retry_until
      body:
        parallel:
          - node:
              id: auditApiDocs
              type: script
              script:
                inline: |
                  return { summary: "api docs" };
          - node:
              id: auditTutorials
              type: script
              script:
                inline: |
                  return { summary: "tutorials" };
        join:
          id: consolidateAudit
          type: script
          script:
            inline: |
              return { summary: "consolidated" };
      review:
        id: consistencyReview
        type: review
        prompt: Review documentation audit consistency.
        gates:
          - continue
          - finish
      retryWhen: state.verdict == "continue"
  - node:
      id: patchDocs
      type: script
      script:
        inline: |
          return { summary: "patched docs" };
`),
		);

		const artifact = await loadWorkflowArtifact(flowPath);
		const calls: string[] = [];
		let reviewCount = 0;
		const runtimeHost: WorkflowNodeRuntimeHost = {
			runScriptNode: async input => {
				calls.push(input.node.id);
				return { summary: input.node.id };
			},
			runReviewNode: async input => {
				calls.push(input.node.id);
				reviewCount += 1;
				return {
					summary: `review ${reviewCount}`,
					verdict: reviewCount === 1 ? "continue" : "finish",
				};
			},
		};

		await runWorkflow({
			host: createRunHost(),
			definition: artifact.definition,
			runId: "parallel-retry-flow-run",
			startNodeId: "auditApiDocs",
			startNodeIds: ["auditApiDocs", "auditTutorials"],
			runtimeHost,
		});

		expect(artifact.definition.edges.map(edge => [edge.from, edge.to, edge.condition?.source])).toEqual([
			["auditApiDocs", "consolidateAudit", undefined],
			["auditTutorials", "consolidateAudit", undefined],
			["consolidateAudit", "consistencyReview", undefined],
			["consistencyReview", "auditApiDocs", 'state.verdict == "continue"'],
			["consistencyReview", "auditTutorials", 'state.verdict == "continue"'],
			["consistencyReview", "patchDocs", '!(state.verdict == "continue")'],
		]);
		expect(calls).toEqual([
			"auditApiDocs",
			"auditTutorials",
			"consolidateAudit",
			"consistencyReview",
			"auditApiDocs",
			"auditTutorials",
			"consolidateAudit",
			"consistencyReview",
			"patchDocs",
		]);
	});

	it("compiles mapped_worker_verifier_pool templates into a pool node and three target nodes", () => {
		const block = {
			sequence: [
				{
					template: {
						kind: "mapped_worker_verifier_pool",
						id: "pool",
						itemSource: "/queue",
						itemKey: "/id",
						maxConcurrency: 2,
						maxItems: 5,
						stopWhen: "state.done == true",
						worker: {
							id: "worker",
							type: "agent",
							agent: "task",
							prompt: {
								template: {
									file: "prompts/worker.md",
									bindings: {
										item: { activation: "/mapped/item" },
									},
								},
							},
						},
						verifier: {
							id: "verifier",
							type: "review",
							prompt: {
								template: {
									file: "prompts/verifier.md",
									bindings: {
										item: { activation: "/mapped/item" },
									},
								},
							},
						},
						reducer: {
							id: "reducer",
							type: "script",
							script: { file: "scripts/reduce.js" },
						},
					},
				},
			],
		};

		const compiled = compileWorkflowDslBlock(block);
		const nodes = compiled.nodes as Record<string, Record<string, unknown>>;
		expect(Object.keys(nodes)).toEqual(["pool.worker", "pool.verifier", "pool.reducer", "pool"]);
		const pool = nodes.pool;
		expect(pool?.type).toBe("mapped_pool");
		expect(pool?.mappedPool).toEqual({
			itemSource: "/queue",
			itemKey: "/id",
			maxConcurrency: 2,
			maxItems: 5,
			worker: "pool.worker",
			verifier: "pool.verifier",
			reducer: "pool.reducer",
			stopWhen: "state.done == true",
		});
	});
	it("wires sequence predecessor to pool and pool to successor, not predecessor to worker", () => {
		const block = {
			sequence: [
				{
					node: {
						id: "seed",
						type: "script",
					},
				},
				{
					template: {
						kind: "mapped_worker_verifier_pool",
						id: "pool",
						itemSource: "/queue",
						itemKey: "/id",
						maxConcurrency: 2,
						maxItems: 5,
						worker: { id: "worker", type: "agent", agent: "task" },
						verifier: { id: "verifier", type: "review" },
						reducer: { id: "reducer", type: "script", script: { file: "scripts/r.js" } },
					},
				},
				{
					node: {
						id: "finish",
						type: "script",
					},
				},
			],
		};
		const compiled = compileWorkflowDslBlock(block);
		const edges = compiled.edges as Array<Record<string, unknown>>;
		const fromSeed = edges.filter(e => e.from === "seed");
		const fromPool = edges.filter(e => e.from === "pool");
		expect(fromSeed).toHaveLength(1);
		expect(fromSeed[0]?.to).toBe("pool");
		expect(fromPool).toHaveLength(1);
		expect(fromPool[0]?.to).toBe("finish");
		const toWorker = edges.filter(e => e.to === "pool.worker");
		expect(toWorker).toHaveLength(0);
	});
});

function flowSource(workflowBlock: string): string {
	return `---
name: test-flow
version: 1
schema: omhflow/v1
checkpoint:
  stopDeadlineMs: 50
changePolicy:
  agentsCanPropose: true
  humansCanApprove: true
---
# Test Flow

\`\`\`yaml workflow
${workflowBlock.trim()}
\`\`\`
`;
}

function createRunHost() {
	const entries: Array<{ type: "custom"; customType: string; data?: unknown }> = [];
	return {
		appendCustomEntry: (customType: string, data?: unknown) => {
			entries.push({ type: "custom", customType, data });
			return `entry-${entries.length}`;
		},
		getBranch: () => entries,
	};
}
