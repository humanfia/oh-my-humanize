import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { freezeWorkflowArtifact } from "../../src/workflow/freeze";
import { buildWorkflowLifecycleInspection } from "../../src/workflow/inspection";
import {
	approveWorkflowChangeRequest,
	createWorkflowCheckpoint,
	proposeWorkflowChangeRequest,
	type RuntimeBindingSnapshot,
	reconstructWorkflowFamilies,
	recordWorkflowFreeze,
	requestWorkflowAttemptStop,
	type WorkflowLifecycleStoreHost,
} from "../../src/workflow/lifecycle";
import type { WorkflowNodeRuntimeHost } from "../../src/workflow/node-runtime";
import { loadWorkflowArtifact } from "../../src/workflow/package-loader";
import { runWorkflow } from "../../src/workflow/runner";

interface CapturedEntry {
	type: "custom";
	customType: string;
	data?: unknown;
}

const tempDirs: string[] = [];
const workflowTestTempRoot = path.resolve(import.meta.dir, "../../../..", "temp", "workflow-tests");

async function createTempDir(): Promise<string> {
	await fs.mkdir(workflowTestTempRoot, { recursive: true });
	const dir = await fs.mkdtemp(path.join(workflowTestTempRoot, "omp-workflow-benchmark-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

function createHost(): WorkflowLifecycleStoreHost & { entries: CapturedEntry[] } {
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

describe("workflow benchmark scenarios", () => {
	it("runs the optimizer search-to-integration benchmark deterministically", async () => {
		const dir = await createTempDir();
		const searchFlowPath = await writeFlow(
			dir,
			"optimizer-search",
			`
sequence:
  - node:
      id: start
      type: script
  - parallel:
      - node:
          id: tryTiling
          type: script
          writes:
            - /candidates
      - node:
          id: tryFusion
          type: script
          writes:
            - /candidates
    join:
      id: evaluate
      type: script
      writes:
        - /decision
`,
		);
		const integrationFlowPath = await writeFlow(
			dir,
			"optimizer-integration",
			`
sequence:
  - node:
      id: integrate
      type: script
      reads:
        - /decision
      writes:
        - /feature
  - node:
      id: review
      type: review
      reads:
        - /feature
      gates:
        - finish
`,
		);
		const searchArtifact = await loadWorkflowArtifact(searchFlowPath);
		const searchFreeze = await freezeWorkflowArtifact(searchArtifact);
		const integrationFreeze = await freezeWorkflowArtifact(await loadWorkflowArtifact(integrationFlowPath));
		const host = createHost();
		const runtimeHost: WorkflowNodeRuntimeHost = {
			runScriptNode: async input => {
				if (input.node.id === "tryTiling") {
					return {
						summary: "candidate tryTiling positive +18%",
						data: { branch: "tryTiling", speedup: 18, outcome: "positive" },
						statePatch: [{ op: "set", path: "/candidates/tryTiling", value: { speedup: 18 } }],
					};
				}
				if (input.node.id === "tryFusion") {
					return {
						summary: "candidate tryFusion negative -3%",
						data: { branch: "tryFusion", speedup: -3, outcome: "negative" },
						statePatch: [{ op: "set", path: "/candidates/tryFusion", value: { speedup: -3 } }],
					};
				}
				if (input.node.id === "evaluate") {
					return {
						summary: "selected tryTiling; abandoned tryFusion",
						data: { selected: "tryTiling", abandoned: ["tryFusion"] },
						statePatch: [
							{
								op: "set",
								path: "/decision",
								value: { selected: "tryTiling", abandoned: ["tryFusion"], speedup: 18 },
							},
						],
					};
				}
				if (input.node.id === "integrate") {
					return {
						summary: "integrated tiling optimization as feature",
						data: { feature: "tiling" },
						statePatch: [{ op: "set", path: "/feature/name", value: "tiling" }],
					};
				}
				return { summary: `ran ${input.node.id}` };
			},
			runReviewNode: async () => ({ summary: "strong review accepted tiling feature", verdict: "finish" }),
		};

		const searchResult = await runWorkflow({
			host,
			definition: searchFreeze.definition,
			runId: "optimizer-search-run",
			startNodeId: "start",
			runtimeHost,
			lifecycle: {
				familyId: "family-optimizer",
				attemptId: "attempt-search",
				objective: "optimize inference kernels",
				freeze: searchFreeze,
				runtimeBindingSnapshot: binding("binding-search"),
			},
		});
		proposeWorkflowChangeRequest(host, {
			changeRequestId: "change-promote-tiling",
			familyId: "family-optimizer",
			attemptId: "attempt-search",
			actor: "agent:evaluator",
			origin: "internal-agent",
			reason: "promote positive tryTiling branch and abandon negative tryFusion branch",
			operations: [{ op: "add_node", node: { id: "integrate", type: "script" } }],
			frontierMapping: { evaluate: "integrate" },
		});
		approveWorkflowChangeRequest(host, {
			changeRequestId: "change-promote-tiling",
			actor: "human:sihao",
		});
		requestWorkflowAttemptStop(host, {
			attemptId: "attempt-search",
			deadlineMs: 10,
			reason: "switch to strong-review integration flow",
		});
		createWorkflowCheckpoint(host, {
			checkpointId: "checkpoint-search",
			familyId: "family-optimizer",
			attemptId: "attempt-search",
			completedActivationIds: completedActivationIds(host, "attempt-search"),
			abortedActivationIds: [],
			frontierNodeIds: ["evaluate"],
			state: searchResult.scheduler.state,
			sourceMapping: { evaluate: "integrate" },
		});
		recordWorkflowFreeze(host, integrationFreeze, { familyId: "family-optimizer" });
		await runWorkflow({
			host,
			definition: integrationFreeze.definition,
			runId: "optimizer-integration-run",
			startNodeId: "integrate",
			runtimeHost,
			initialState: searchResult.scheduler.state,
			lifecycle: {
				familyId: "family-optimizer",
				attemptId: "attempt-integrate",
				checkpointId: "checkpoint-search",
				freeze: integrationFreeze,
				runtimeBindingSnapshot: binding("binding-integrate"),
				recordFamily: false,
				recordFreeze: false,
			},
		});

		const evaluate = searchFreeze.definition.nodes.find(node => node.id === "evaluate");
		const family = reconstructWorkflowFamilies(host.getBranch())[0]!;
		const inspection = buildWorkflowLifecycleInspection(family);

		expect(evaluate?.waitFor).toEqual(["tryTiling", "tryFusion"]);
		expect(searchFreeze.definition.edges.map(edge => [edge.from, edge.to])).toEqual([
			["start", "tryTiling"],
			["start", "tryFusion"],
			["tryTiling", "evaluate"],
			["tryFusion", "evaluate"],
		]);
		expect(inspection.attempts.map(attempt => [attempt.id, attempt.status, attempt.checkpointId])).toEqual([
			["attempt-search", "stopped", undefined],
			["attempt-integrate", "completed", "checkpoint-search"],
		]);
		expect(inspection.attempts[0]?.activations.map(activation => [activation.nodeId, activation.summary])).toEqual([
			["start", "ran start"],
			["tryTiling", "candidate tryTiling positive +18%"],
			["tryFusion", "candidate tryFusion negative -3%"],
			["evaluate", "selected tryTiling; abandoned tryFusion"],
		]);
		expect(inspection.attempts[1]?.activations.map(activation => [activation.nodeId, activation.summary])).toEqual([
			["integrate", "integrated tiling optimization as feature"],
			["review", "strong review accepted tiling feature"],
		]);
		expect(inspection.changeRequests).toMatchObject([
			{
				id: "change-promote-tiling",
				status: "approved",
				approvedBy: "human:sihao",
				frontierMapping: { evaluate: "integrate" },
			},
		]);
		expect(inspection.checkpoints).toMatchObject([
			{
				id: "checkpoint-search",
				attemptId: "attempt-search",
				frontierNodeIds: ["evaluate"],
				sourceMapping: { evaluate: "integrate" },
			},
		]);
	});

	it("runs the project phase-transition benchmark deterministically", async () => {
		const dir = await createTempDir();
		const earlyFreeze = await freezeWorkflowArtifact(
			await loadWorkflowArtifact(
				await writeFlow(
					dir,
					"project-early",
					`
sequence:
  - node:
      id: kickoff
      type: script
  - parallel:
      - node:
          id: implementApi
          type: script
      - node:
          id: implementUi
          type: script
    join:
      id: weakReview
      type: review
      gates:
        - continue
`,
				),
			),
		);
		const middleFreeze = await freezeWorkflowArtifact(
			await loadWorkflowArtifact(
				await writeFlow(
					dir,
					"project-middle",
					`
sequence:
  - node:
      id: designContract
      type: script
  - node:
      id: implementSerial
      type: script
  - node:
      id: strongReview
      type: review
      gates:
        - finish
`,
				),
			),
		);
		const lateFreeze = await freezeWorkflowArtifact(
			await loadWorkflowArtifact(
				await writeFlow(
					dir,
					"project-late",
					`
sequence:
  - node:
      id: triage
      type: script
  - parallel:
      - node:
          id: regressionTest
          type: script
      - node:
          id: securityReview
          type: review
      - node:
          id: docsAudit
          type: review
    join:
      id: maintenanceDecision
      type: script
`,
				),
			),
		);
		const host = createHost();
		const runtimeHost: WorkflowNodeRuntimeHost = {
			runScriptNode: async input => ({ summary: `script ${input.node.id}` }),
			runReviewNode: async input => ({ summary: `review ${input.node.id}`, verdict: "finish" }),
		};

		const earlyResult = await runWorkflow({
			host,
			definition: earlyFreeze.definition,
			runId: "project-early-run",
			startNodeId: "kickoff",
			runtimeHost,
			lifecycle: {
				familyId: "family-project",
				attemptId: "attempt-early",
				objective: "adapt workflow structure across project phases",
				freeze: earlyFreeze,
				runtimeBindingSnapshot: binding("binding-early"),
			},
		});
		checkpointTransition(host, {
			familyId: "family-project",
			attemptId: "attempt-early",
			changeRequestId: "change-to-middle",
			reason: "component coupling requires serial implementation and stronger review",
			checkpointId: "checkpoint-early",
			frontierNodeId: "weakReview",
			nextNodeId: "designContract",
			state: earlyResult.scheduler.state,
			nextFreezeId: middleFreeze.id,
		});
		recordWorkflowFreeze(host, middleFreeze, { familyId: "family-project" });
		const middleResult = await runWorkflow({
			host,
			definition: middleFreeze.definition,
			runId: "project-middle-run",
			startNodeId: "designContract",
			runtimeHost,
			initialState: earlyResult.scheduler.state,
			lifecycle: {
				familyId: "family-project",
				attemptId: "attempt-middle",
				checkpointId: "checkpoint-early",
				freeze: middleFreeze,
				runtimeBindingSnapshot: binding("binding-middle"),
				recordFamily: false,
				recordFreeze: false,
			},
		});
		checkpointTransition(host, {
			familyId: "family-project",
			attemptId: "attempt-middle",
			changeRequestId: "change-to-late",
			reason: "maintenance phase shifts effort to testing and review",
			checkpointId: "checkpoint-middle",
			frontierNodeId: "strongReview",
			nextNodeId: "triage",
			state: middleResult.scheduler.state,
			nextFreezeId: lateFreeze.id,
		});
		recordWorkflowFreeze(host, lateFreeze, { familyId: "family-project" });
		await runWorkflow({
			host,
			definition: lateFreeze.definition,
			runId: "project-late-run",
			startNodeId: "triage",
			runtimeHost,
			initialState: middleResult.scheduler.state,
			lifecycle: {
				familyId: "family-project",
				attemptId: "attempt-late",
				checkpointId: "checkpoint-middle",
				freeze: lateFreeze,
				runtimeBindingSnapshot: binding("binding-late"),
				recordFamily: false,
				recordFreeze: false,
			},
		});

		const family = reconstructWorkflowFamilies(host.getBranch())[0]!;
		const inspection = buildWorkflowLifecycleInspection(family);

		expect(earlyFreeze.definition.nodes.find(node => node.id === "weakReview")?.waitFor).toEqual([
			"implementApi",
			"implementUi",
		]);
		expect(middleFreeze.definition.edges.map(edge => [edge.from, edge.to])).toEqual([
			["designContract", "implementSerial"],
			["implementSerial", "strongReview"],
		]);
		expect(lateFreeze.definition.nodes.find(node => node.id === "maintenanceDecision")?.waitFor).toEqual([
			"regressionTest",
			"securityReview",
			"docsAudit",
		]);
		expect(inspection.freezeIds).toEqual([earlyFreeze.id, middleFreeze.id, lateFreeze.id]);
		expect(inspection.attempts.map(attempt => [attempt.id, attempt.status, attempt.checkpointId])).toEqual([
			["attempt-early", "stopped", undefined],
			["attempt-middle", "stopped", "checkpoint-early"],
			["attempt-late", "completed", "checkpoint-middle"],
		]);
		expect(inspection.checkpoints.map(checkpoint => [checkpoint.id, checkpoint.sourceMapping])).toEqual([
			["checkpoint-early", { weakReview: "designContract" }],
			["checkpoint-middle", { strongReview: "triage" }],
		]);
		expect(inspection.changeRequests.map(request => [request.id, request.status, request.frontierMapping])).toEqual([
			["change-to-middle", "approved", { weakReview: "designContract" }],
			["change-to-late", "approved", { strongReview: "triage" }],
		]);
	});
});

async function writeFlow(dir: string, name: string, workflowBlock: string): Promise<string> {
	await fs.mkdir(path.join(dir, name), { recursive: true });
	const flowPath = path.join(dir, `${name}.omhflow`);
	await Bun.write(
		flowPath,
		`---
name: ${name}
version: 1
schema: omhflow/v1
checkpoint:
  stopDeadlineMs: 10
changePolicy:
  agentsCanPropose: true
  humansCanApprove: true
---
# ${name}

\`\`\`yaml workflow
${workflowBlock.trim()}
\`\`\`
`,
	);
	return flowPath;
}

function checkpointTransition(
	host: WorkflowLifecycleStoreHost,
	options: {
		familyId: string;
		attemptId: string;
		changeRequestId: string;
		reason: string;
		checkpointId: string;
		frontierNodeId: string;
		nextNodeId: string;
		state: Record<string, unknown>;
		nextFreezeId: string;
	},
): void {
	proposeWorkflowChangeRequest(host, {
		changeRequestId: options.changeRequestId,
		familyId: options.familyId,
		attemptId: options.attemptId,
		actor: "agent:workflow-manager",
		origin: "internal-agent",
		reason: options.reason,
		operations: [{ op: "add_node", node: { id: options.nextNodeId, type: "script" } }],
		frontierMapping: { [options.frontierNodeId]: options.nextNodeId },
	});
	approveWorkflowChangeRequest(host, {
		changeRequestId: options.changeRequestId,
		actor: "human:sihao",
	});
	requestWorkflowAttemptStop(host, {
		attemptId: options.attemptId,
		deadlineMs: 10,
		reason: `switch to ${options.nextFreezeId}`,
	});
	createWorkflowCheckpoint(host, {
		checkpointId: options.checkpointId,
		familyId: options.familyId,
		attemptId: options.attemptId,
		completedActivationIds: completedActivationIds(host, options.attemptId),
		abortedActivationIds: [],
		frontierNodeIds: [options.frontierNodeId],
		state: options.state,
		sourceMapping: { [options.frontierNodeId]: options.nextNodeId },
	});
}

function completedActivationIds(host: WorkflowLifecycleStoreHost, attemptId: string): string[] {
	return (
		reconstructWorkflowFamilies(host.getBranch())
			.flatMap(family => family.attempts)
			.find(attempt => attempt.id === attemptId)
			?.activations.filter(activation => activation.status === "completed")
			.map(activation => activation.id) ?? []
	);
}

function binding(id: string): RuntimeBindingSnapshot {
	return {
		id,
		requestedRoles: {},
		resolvedModels: {},
		tools: ["eval", "task"],
		agents: ["task"],
		unavailable: [],
		warnings: [],
	};
}
