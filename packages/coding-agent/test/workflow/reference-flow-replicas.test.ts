import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { WorkflowNode } from "../../src/workflow/definition";
import { type FlowFreezeResourceSnapshot, freezeWorkflowArtifact } from "../../src/workflow/freeze";
import type { WorkflowNodeRuntimeHost } from "../../src/workflow/node-runtime";
import { loadWorkflowArtifact } from "../../src/workflow/package-loader";
import { resolveWorkflowPrompt } from "../../src/workflow/prompt-source";
import { reconstructWorkflowRuns, type WorkflowRunStoreHost } from "../../src/workflow/run-store";
import { runWorkflow } from "../../src/workflow/runner";
import type { WorkflowActivation } from "../../src/workflow/scheduler";

interface CapturedEntry {
	type: "custom";
	customType: string;
	data?: unknown;
}

const tempDirs: string[] = [];
const workflowTestTempRoot = path.resolve(import.meta.dir, "../../../..", "temp", "workflow-tests");

async function createTempDir(): Promise<string> {
	await fs.mkdir(workflowTestTempRoot, { recursive: true });
	const dir = await fs.mkdtemp(path.join(workflowTestTempRoot, "omp-reference-flow-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

function createHost(): WorkflowRunStoreHost & { entries: CapturedEntry[] } {
	const entries: CapturedEntry[] = [];
	return {
		entries,
		appendCustomEntry: (customType, data) => {
			entries.push({ type: "custom", customType, data });
			return `entry-${entries.length}`;
		},
		getBranch: () => entries,
	};
}

describe("reference workflow replicas", () => {
	it("replicates Humanize review loops as a reusable KDA subflow", async () => {
		const dir = await createTempDir();
		const kdaPath = await writeKdaHumanizeReferenceFlow(dir);
		const artifact = await loadWorkflowArtifact(kdaPath);
		const freeze = await freezeWorkflowArtifact(artifact);
		const host = createHost();
		const reviewCounts = new Map<string, number>();
		const agentCounts = new Map<string, number>();
		const runtimeHost: WorkflowNodeRuntimeHost = {
			runHumanNode: async input => {
				if (input.node.id === "defineContract") {
					return {
						summary: "defined task contract",
						statePatch: [
							{
								op: "set",
								path: "/taskContract",
								value: "Optimize the vector add kernel while preserving correctness.",
							},
						],
					};
				}
				return { summary: "plan quiz acknowledged" };
			},
			runAgentNode: async input => {
				const count = nextCount(agentCounts, input.node.id);
				if (input.node.id === "inspectWorkspace") {
					expect(input.prompt).toContain("Optimize the vector add kernel");
					return {
						summary: "inspected workspace",
						statePatch: [{ op: "set", path: "/workspace", value: "CUDA task workspace with tests" }],
					};
				}
				if (input.node.id === "draftPlan") {
					expect(input.prompt).toContain("CUDA task workspace");
					return {
						summary: "drafted implementation plan",
						statePatch: [{ op: "set", path: "/plan", value: "Implement candidate, validate, and measure." }],
					};
				}
				if (input.node.id === "humanize__implementRound") {
					expect(input.prompt).toContain("Implement candidate, validate, and measure.");
					return {
						summary: count === 1 ? "implemented partial plan" : "implemented accepted plan",
						statePatch: [
							{
								op: "set",
								path: "/implementationSummary",
								value: count === 1 ? "partial plan" : "accepted plan",
							},
						],
					};
				}
				if (input.node.id === "humanize__fixReviewIssues") {
					return {
						summary: count === 1 ? "addressed first review issue" : "review clean",
						statePatch: [{ op: "set", path: "/codeReviewFix", value: count }],
					};
				}
				if (input.node.id === "implementCandidate") {
					expect(input.prompt).toContain("Optimize the vector add kernel");
					expect(input.prompt).toContain("Implement candidate, validate, and measure.");
					return {
						summary: count === 1 ? "candidate v1 needs more evidence" : "candidate v2 has evidence",
						statePatch: [
							{
								op: "set",
								path: "/candidate",
								value: count === 1 ? "candidate-v1" : "candidate-v2",
							},
						],
					};
				}
				return { summary: `ran ${input.node.id}` };
			},
			runReviewNode: async input => {
				const count = nextCount(reviewCounts, input.node.id);
				if (input.node.id === "humanize__planCompliance") {
					expect(input.prompt).toContain("Implement candidate, validate, and measure.");
					return { summary: "plan is relevant and branch safe", verdict: "pass" };
				}
				if (input.node.id === "humanize__implementationReview") {
					expect(input.prompt).toContain(count === 1 ? "implemented partial plan" : "implemented accepted plan");
					return {
						summary: count === 1 ? "summary review requires another round" : "summary review complete",
						verdict: count === 1 ? "continue" : "complete",
					};
				}
				if (input.node.id === "humanize__codeReview") {
					return {
						summary: count === 1 ? "code review found issues" : "code review clean",
						verdict: count === 1 ? "issues" : "clean",
					};
				}
				if (input.node.id === "validateCandidate") {
					expect(input.prompt).toContain(
						count === 1 ? "candidate v1 needs more evidence" : "candidate v2 has evidence",
					);
					return {
						summary: count === 1 ? "validation asks for revision" : "validation supports promotion",
						verdict: count === 1 ? "revise" : "promote",
					};
				}
				return { summary: "promoted final candidate", verdict: "promote" };
			},
			runScriptNode: async input => {
				if (input.node.id === "humanize__finalize") {
					return {
						summary: "humanize loop finalized",
						statePatch: [{ op: "set", path: "/humanize/status", value: "complete" }],
					};
				}
				if (input.node.id === "recordEvidence") {
					return {
						summary: "recorded benchmark evidence",
						statePatch: [{ op: "set", path: "/evidence", value: "candidate-v2 validated" }],
					};
				}
				return { summary: `ran ${input.node.id}` };
			},
		};

		const result = await runWorkflow({
			host,
			definition: freeze.definition,
			runId: "kda-humanize-reference-run",
			startNodeId: "defineContract",
			runtimeHost,
			packageRoot: artifact.resourceDir,
			frozenResources: freeze.resourceSnapshots,
			maxNodeActivations: 5,
		});
		const run = reconstructWorkflowRuns(host.getBranch())[0]!;

		expect(freeze.definition.nodes.map(node => node.id)).toEqual(
			expect.arrayContaining([
				"defineContract",
				"draftPlan",
				"humanize__planCompliance",
				"humanize__planQuiz",
				"humanize__implementRound",
				"humanize__implementationReview",
				"humanize__fixReviewIssues",
				"humanize__codeReview",
				"humanize__finalize",
				"implementCandidate",
				"validateCandidate",
				"promotionDecision",
			]),
		);
		expect(freeze.definition.edges.map(edge => [edge.from, edge.to, edge.condition?.source])).toContainEqual([
			"humanize__implementationReview",
			"humanize__implementRound",
			'outputs.humanize__implementationReview.verdict == "continue"',
		]);
		expect(freeze.definition.edges.map(edge => [edge.from, edge.to, edge.condition?.source])).toContainEqual([
			"validateCandidate",
			"implementCandidate",
			'outputs.validateCandidate.verdict == "revise"',
		]);
		expect(freeze.resourceSnapshots.map(resource => resource.path)).toEqual(
			expect.arrayContaining([
				"humanize/prompts/implementation-review.md",
				"humanize/prompts/code-review.md",
				"prompts/candidate.md",
				"prompts/validation.md",
			]),
		);
		expect(result.scheduler.activations.find(activation => activation.status === "failed")?.error).toBeUndefined();
		expect(activationCount(result.scheduler.activations, "humanize__implementRound")).toBe(2);
		expect(activationCount(result.scheduler.activations, "humanize__implementationReview")).toBe(2);
		expect(activationCount(result.scheduler.activations, "humanize__fixReviewIssues")).toBe(2);
		expect(activationCount(result.scheduler.activations, "humanize__codeReview")).toBe(2);
		expect(activationCount(result.scheduler.activations, "implementCandidate")).toBe(2);
		expect(activationCount(result.scheduler.activations, "validateCandidate")).toBe(2);
		expect(activationCount(result.scheduler.activations, "promotionDecision")).toBe(1);
		expect(result.scheduler.state).toMatchObject({
			taskContract: "Optimize the vector add kernel while preserving correctness.",
			plan: "Implement candidate, validate, and measure.",
			humanize: { status: "complete" },
			candidate: "candidate-v2",
			evidence: "candidate-v2 validated",
		});
		expect(
			run.activations.find(activation => activation.nodeId === "validateCandidate")?.input?.prompt?.value,
		).toContain("Candidate summary:\ncandidate v1 needs more evidence");
	});

	it("keeps KDA retry review prompts stable across checkpoint restarts", async () => {
		const dir = await createTempDir();
		const kdaPath = await writeKdaHumanizeReferenceFlow(dir);
		const artifact = await loadWorkflowArtifact(kdaPath);
		const freeze = await freezeWorkflowArtifact(artifact);

		await expectReviewPromptUsesLatestOutput(
			freeze.definition.nodes,
			artifact.resourceDir,
			freeze.resourceSnapshots,
			"humanize__implementationReview",
			"humanize__implementRound",
			"second Humanize implementation summary",
		);
		await expectReviewPromptUsesLatestOutput(
			freeze.definition.nodes,
			artifact.resourceDir,
			freeze.resourceSnapshots,
			"humanize__codeReview",
			"humanize__fixReviewIssues",
			"second Humanize code-review fix",
		);
		await expectReviewPromptUsesLatestOutput(
			freeze.definition.nodes,
			artifact.resourceDir,
			freeze.resourceSnapshots,
			"validateCandidate",
			"implementCandidate",
			"second KDA candidate summary",
		);
	});
});

function activationCount(activations: { nodeId: string }[], nodeId: string): number {
	return activations.filter(activation => activation.nodeId === nodeId).length;
}

function nextCount(counts: Map<string, number>, key: string): number {
	const count = (counts.get(key) ?? 0) + 1;
	counts.set(key, count);
	return count;
}

async function expectReviewPromptUsesLatestOutput(
	nodes: WorkflowNode[],
	packageRoot: string,
	frozenResources: FlowFreezeResourceSnapshot[],
	reviewNodeId: string,
	outputNodeId: string,
	expectedLatestSummary: string,
): Promise<void> {
	const node = nodes.find(candidate => candidate.id === reviewNodeId);
	if (!node) throw new Error(`expected node ${reviewNodeId}`);
	const completedActivations = [
		completedActivation("activation-1", outputNodeId, "stale checkpoint summary"),
		completedActivation("activation-2", outputNodeId, expectedLatestSummary),
	];
	const resolved = await resolveWorkflowPrompt(node, {
		state: { plan: "test plan" },
		completedActivations,
		parentActivationIds: completedActivations.map(activation => activation.id),
		packageRoot,
		frozenResources,
	});

	expect(resolved?.value).toContain(expectedLatestSummary);
}

function completedActivation(id: string, nodeId: string, summary: string): WorkflowActivation {
	return {
		id,
		nodeId,
		graphRevisionId: "checkpoint-graph",
		status: "completed",
		parentActivationIds: [],
		output: { summary },
	};
}

async function writeKdaHumanizeReferenceFlow(dir: string): Promise<string> {
	await writePrompt(dir, "kda/prompts/task-contract.md", "Task contract:\n{{taskContract}}\n");
	await writePrompt(dir, "kda/prompts/draft-plan.md", "Workspace:\n{{workspace}}\n\nContract:\n{{taskContract}}\n");
	await writePrompt(dir, "kda/prompts/candidate.md", "Contract:\n{{taskContract}}\n\nPlan:\n{{plan}}\n");
	await writePrompt(dir, "kda/prompts/validation.md", "Candidate summary:\n{{candidateSummary}}\n");
	await writePrompt(dir, "kda/prompts/promotion.md", "Evidence:\n{{evidence}}\n");
	await writePrompt(dir, "kda/humanize/prompts/plan-compliance.md", "Plan compliance check:\n{{plan}}\n");
	await writePrompt(dir, "kda/humanize/prompts/plan-quiz.md", "Plan quiz:\n{{plan}}\n");
	await writePrompt(dir, "kda/humanize/prompts/implementation.md", "Implement the full plan:\n{{plan}}\n");
	await writePrompt(
		dir,
		"kda/humanize/prompts/implementation-review.md",
		"Plan:\n{{plan}}\n\nRound summary:\n{{roundSummary}}\n",
	);
	await writePrompt(dir, "kda/humanize/prompts/fix-review.md", "Fix code review issues for:\n{{plan}}\n");
	await writePrompt(dir, "kda/humanize/prompts/code-review.md", "Review code quality after:\n{{fixSummary}}\n");
	await Bun.write(path.join(dir, "kda", "humanize.omhflow"), omhflowSource("humanize-reference", humanizeBlock()));
	const kdaPath = path.join(dir, "kda.omhflow");
	await Bun.write(kdaPath, omhflowSource("kda-humanize-reference", kdaBlock()));
	return kdaPath;
}

async function writePrompt(dir: string, relativePath: string, content: string): Promise<void> {
	await Bun.write(path.join(dir, relativePath), content);
}

function omhflowSource(name: string, workflowBlock: string): string {
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

function humanizeBlock(): string {
	return `
resources:
  - path: prompts/plan-compliance.md
    kind: prompt
  - path: prompts/plan-quiz.md
    kind: prompt
  - path: prompts/implementation.md
    kind: prompt
  - path: prompts/implementation-review.md
    kind: prompt
  - path: prompts/fix-review.md
    kind: prompt
  - path: prompts/code-review.md
    kind: prompt
sequence:
  - node:
      id: planCompliance
      type: review
      reads:
        - /plan
      prompt:
        template:
          file: prompts/plan-compliance.md
          bindings:
            plan:
              state: /plan
      gates:
        - pass
        - fail
  - node:
      id: planQuiz
      type: human
      reads:
        - /plan
      prompt:
        template:
          file: prompts/plan-quiz.md
          bindings:
            plan:
              state: /plan
  - template:
      kind: retry_until
      body:
        id: implementRound
        type: agent
        agent: task
        reads:
          - /plan
        writes:
          - /implementationSummary
        prompt:
          template:
            file: prompts/implementation.md
            bindings:
              plan:
                state: /plan
      review:
        id: implementationReview
        type: review
        reads:
          - /plan
          - /summary
        prompt:
          template:
            file: prompts/implementation-review.md
            bindings:
              plan:
                state: /plan
              roundSummary:
                output:
                  node: implementRound
                  path: /summary
                  activation: latest-completed
        gates:
          - continue
          - complete
        fallbackVerdict: continue
      retryWhen: outputs.implementationReview.verdict == "continue"
  - template:
      kind: retry_until
      body:
        id: fixReviewIssues
        type: agent
        agent: task
        reads:
          - /plan
        writes:
          - /codeReviewFix
        prompt:
          template:
            file: prompts/fix-review.md
            bindings:
              plan:
                state: /plan
      review:
        id: codeReview
        type: review
        reads:
          - /summary
        prompt:
          template:
            file: prompts/code-review.md
            bindings:
              fixSummary:
                output:
                  node: fixReviewIssues
                  path: /summary
                  activation: latest-completed
        gates:
          - issues
          - clean
        fallbackVerdict: issues
      retryWhen: outputs.codeReview.verdict == "issues"
  - node:
      id: finalize
      type: script
      script:
        inline: |
          return { summary: "finalized" };
      writes:
        - /humanize
`;
}

function kdaBlock(): string {
	return `
imports:
  humanize:
    path: ./kda/humanize.omhflow
resources:
  - path: prompts/task-contract.md
    kind: prompt
  - path: prompts/draft-plan.md
    kind: prompt
  - path: prompts/candidate.md
    kind: prompt
  - path: prompts/validation.md
    kind: prompt
  - path: prompts/promotion.md
    kind: prompt
capabilities:
  agents:
    - task
sequence:
  - node:
      id: defineContract
      type: human
      writes:
        - /taskContract
      prompt: Define objective, validation, evaluation, and promotion criteria.
  - node:
      id: inspectWorkspace
      type: agent
      agent: task
      reads:
        - /taskContract
      writes:
        - /workspace
      prompt:
        template:
          file: prompts/task-contract.md
          bindings:
            taskContract:
              state: /taskContract
  - node:
      id: draftPlan
      type: agent
      agent: task
      reads:
        - /taskContract
        - /workspace
      writes:
        - /plan
      prompt:
        template:
          file: prompts/draft-plan.md
          bindings:
            taskContract:
              state: /taskContract
            workspace:
              state: /workspace
  - use: humanize
  - template:
      kind: retry_until
      body:
        id: implementCandidate
        type: agent
        agent: task
        reads:
          - /taskContract
          - /plan
        writes:
          - /candidate
        prompt:
          template:
            file: prompts/candidate.md
            bindings:
              taskContract:
                state: /taskContract
              plan:
                state: /plan
      review:
        id: validateCandidate
        type: review
        reads:
          - /summary
        prompt:
          template:
            file: prompts/validation.md
            bindings:
              candidateSummary:
                output:
                  node: implementCandidate
                  path: /summary
                  activation: latest-completed
        gates:
          - revise
          - promote
      retryWhen: outputs.validateCandidate.verdict == "revise"
  - node:
      id: recordEvidence
      type: script
      script:
        inline: |
          return { summary: "recorded evidence" };
      writes:
        - /evidence
  - node:
      id: promotionDecision
      type: review
      reads:
        - /evidence
      prompt:
        template:
          file: prompts/promotion.md
          bindings:
            evidence:
              state: /evidence
      gates:
        - reject
        - promote
`;
}
