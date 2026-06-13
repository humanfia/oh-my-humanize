import { describe, expect, it } from "bun:test";
import { Buffer } from "node:buffer";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { exportSessionToHtml, getTemplate } from "../../src/export/html";
import { SessionManager } from "../../src/session/session-manager";
import { parseWorkflowDefinition } from "../../src/workflow/definition";
import type { FlowFreeze } from "../../src/workflow/freeze";
import type { WorkflowInspection, WorkflowLifecycleInspection } from "../../src/workflow/inspection";
import {
	appendWorkflowAttemptActivationAborted,
	appendWorkflowAttemptActivationCompleted,
	appendWorkflowAttemptActivationStarted,
	approveWorkflowChangeRequest,
	completeWorkflowAttempt,
	createWorkflowCheckpoint,
	proposeWorkflowChangeRequest,
	recordWorkflowChangeRequestApplied,
	recordWorkflowFreeze,
	requestWorkflowAttemptStop,
	restartWorkflowAttempt,
	startWorkflowAttempt,
	startWorkflowFamily,
} from "../../src/workflow/lifecycle";
import {
	appendWorkflowActivationCompleted,
	appendWorkflowActivationStarted,
	appendWorkflowStatePatch,
	startWorkflowRun,
} from "../../src/workflow/run-store";

const workflowSource = `
name: export-visible-workflow
version: 1
models:
  defaults:
    agent: openai/gpt-4o
nodes:
  build:
    type: agent
    agent: task
    prompt: Build the artifact.
edges: []
`;

interface ExportedSessionData {
	entries?: unknown[];
	workflowInspections?: WorkflowInspection[];
	workflowLifecycleInspections?: WorkflowLifecycleInspection[];
}

const exportTestTempRoot = path.resolve(import.meta.dir, "../../../..", "temp", "html-workflow-export-tests");

async function createTempDir(): Promise<string> {
	await fs.mkdir(exportTestTempRoot, { recursive: true });
	return fs.mkdtemp(path.join(exportTestTempRoot, "omp-html-workflow-export-"));
}

describe("HTML export workflow inspection support", () => {
	it("exports compact workflow inspection data reconstructed from session events", async () => {
		const dir = await createTempDir();
		const sm = SessionManager.create(dir, dir);
		const outputPath = path.join(dir, "session.html");
		const definition = parseWorkflowDefinition(workflowSource, { sourcePath: path.join(dir, "workflow.yml") });
		try {
			startWorkflowRun(sm, definition, { runId: "run-export", graphRevisionId: "graph-0" });
			appendWorkflowActivationStarted(sm, "run-export", {
				activationId: "activation-1",
				nodeId: "build",
				graphRevisionId: "graph-0",
				parentActivationIds: [],
				input: {
					prompt: {
						value: "Build the artifact.",
						byteLength: 19,
						contentHash: "sha256:export-prompt",
						source: { kind: "inline", text: "Build the artifact." },
					},
				},
			});
			appendWorkflowActivationCompleted(sm, "run-export", {
				activationId: "activation-1",
				output: {
					summary: "built package",
					artifacts: ["artifact://build-log"],
				},
				modelAudit: {
					nodeId: "build",
					source: "workflow-default",
					requestedPattern: "openai/gpt-4o",
					unavailablePolicy: "fallback-to-parent",
					resolvedModel: "openai/gpt-4o",
					explicitThinkingLevel: false,
					fallbackUsed: false,
				},
			});
			appendWorkflowStatePatch(sm, "run-export", {
				patch: [{ op: "set", path: "/score", value: 0.92 }],
				reason: "export fixture",
			});

			await exportSessionToHtml(sm, undefined, { outputPath });
			const exported = decodeSessionData(await Bun.file(outputPath).text());

			expect(exported.workflowInspections).toEqual([
				{
					runId: "run-export",
					currentGraphRevisionId: "graph-0",
					graph: {
						nodes: [{ id: "build", type: "agent" }],
						edges: [],
					},
					state: { score: 0.92 },
					graphRevisions: [{ id: "graph-0", nodeCount: 1, edgeCount: 0 }],
					pendingGraphPatchProposals: [],
					activations: [
						{
							id: "activation-1",
							nodeId: "build",
							graphRevisionId: "graph-0",
							parentActivationIds: [],
							status: "completed",
							prompt: {
								value: "Build the artifact.",
								byteLength: 19,
								contentHash: "sha256:export-prompt",
								source: { kind: "inline", text: "Build the artifact." },
							},
							summary: "built package",
							artifacts: ["artifact://build-log"],
						},
					],
					modelAssignments: [
						{
							activationId: "activation-1",
							nodeId: "build",
							source: "workflow-default",
							requestedPattern: "openai/gpt-4o",
							resolvedModel: "openai/gpt-4o",
							fallbackUsed: false,
						},
					],
				},
			]);
		} finally {
			await sm.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("exports workflow lifecycle inspection data reconstructed from session events", async () => {
		const dir = await createTempDir();
		const sm = SessionManager.create(dir, dir);
		const outputPath = path.join(dir, "session.html");
		try {
			startWorkflowFamily(sm, { familyId: "family-export", objective: "ship export" });
			const freeze = createFreeze("flowfreeze:export");
			const freezeB = createFreeze("flowfreeze:export-v2", undefined, ["verify"]);
			recordWorkflowFreeze(sm, freeze, { familyId: "family-export" });
			startWorkflowAttempt(sm, {
				familyId: "family-export",
				attemptId: "attempt-export-1",
				freezeId: freeze.id,
				startNodeId: "build",
				runtimeBindingSnapshot: {
					id: "binding-export",
					requestedRoles: { builder: "openai/gpt-4o" },
					resolvedModels: { builder: "openai/gpt-4o" },
					tools: ["task"],
					agents: ["task"],
					unavailable: [],
					warnings: [],
				},
			});
			appendWorkflowAttemptActivationStarted(sm, {
				attemptId: "attempt-export-1",
				activationId: "activation-1",
				nodeId: "build",
				parentActivationIds: [],
			});
			appendWorkflowAttemptActivationCompleted(sm, {
				attemptId: "attempt-export-1",
				activationId: "activation-1",
				output: { summary: "built export artifact", artifacts: ["artifact://workflow/build.log"] },
			});
			appendWorkflowAttemptActivationStarted(sm, {
				attemptId: "attempt-export-1",
				activationId: "activation-2",
				nodeId: "weakReview",
				parentActivationIds: ["activation-1"],
			});
			appendWorkflowAttemptActivationAborted(sm, {
				attemptId: "attempt-export-1",
				activationId: "activation-2",
				nodeId: "weakReview",
				reason: "stop deadline elapsed",
			});
			proposeWorkflowChangeRequest(sm, {
				changeRequestId: "change-export",
				familyId: "family-export",
				attemptId: "attempt-export-1",
				actor: "agent:reviewer",
				origin: "internal-agent",
				reason: "upgrade export validation",
				operations: [{ op: "add_node", node: { id: "verify", type: "script" } }],
				frontierMapping: { build: "verify" },
			});
			approveWorkflowChangeRequest(sm, {
				changeRequestId: "change-export",
				actor: "human:sihao",
			});
			requestWorkflowAttemptStop(sm, {
				attemptId: "attempt-export-1",
				deadlineMs: 50,
				reason: "stop before export validation refreeze",
			});
			createWorkflowCheckpoint(sm, {
				checkpointId: "checkpoint-export",
				familyId: "family-export",
				attemptId: "attempt-export-1",
				completedActivationIds: ["activation-1"],
				abortedActivationIds: ["activation-2"],
				frontierNodeIds: ["build"],
				state: { score: 0.92 },
				sourceMapping: { build: "verify" },
			});
			recordWorkflowFreeze(sm, freezeB, { familyId: "family-export" });
			recordWorkflowChangeRequestApplied(sm, {
				changeRequestId: "change-export",
				target: "freeze",
				actor: "human:sihao",
				freezeId: freezeB.id,
				reason: "strict export verification freeze passed",
			});
			restartWorkflowAttempt(sm, {
				familyId: "family-export",
				attemptId: "attempt-export-2",
				checkpointId: "checkpoint-export",
				freezeId: freezeB.id,
				startNodeId: "verify",
				runtimeBindingSnapshot: {
					id: "binding-export-v2",
					requestedRoles: { verifier: "openai/gpt-4o" },
					resolvedModels: { verifier: "openai/gpt-4o" },
					tools: ["eval"],
					agents: [],
					unavailable: [],
					warnings: ["used deterministic verifier"],
				},
			});
			appendWorkflowAttemptActivationStarted(sm, {
				attemptId: "attempt-export-2",
				activationId: "activation-3",
				nodeId: "verify",
				parentActivationIds: ["activation-1"],
			});
			appendWorkflowAttemptActivationCompleted(sm, {
				attemptId: "attempt-export-2",
				activationId: "activation-3",
				output: { summary: "verified export artifact" },
			});
			completeWorkflowAttempt(sm, {
				attemptId: "attempt-export-2",
				summary: "exported lifecycle",
			});

			await exportSessionToHtml(sm, undefined, { outputPath });
			const exported = decodeSessionData(await Bun.file(outputPath).text());

			expect(exported.workflowLifecycleInspections).toMatchObject([
				{
					familyId: "family-export",
					objective: "ship export",
					freezeIds: ["flowfreeze:export", "flowfreeze:export-v2"],
					attempts: [
						{
							id: "attempt-export-1",
							freezeId: "flowfreeze:export",
							status: "stopped",
							activationCounts: { completed: 1, aborted: 1 },
							activations: [
								{
									id: "activation-1",
									nodeId: "build",
									status: "completed",
									summary: "built export artifact",
									artifacts: ["artifact://workflow/build.log"],
								},
								{
									id: "activation-2",
									nodeId: "weakReview",
									status: "aborted",
									reason: "stop deadline elapsed",
								},
							],
							runtimeBindingSnapshot: { id: "binding-export" },
						},
						{
							id: "attempt-export-2",
							freezeId: "flowfreeze:export-v2",
							status: "completed",
							checkpointId: "checkpoint-export",
							summary: "exported lifecycle",
							runtimeBindingSnapshot: { id: "binding-export-v2" },
						},
					],
					checkpoints: [
						{
							id: "checkpoint-export",
							attemptId: "attempt-export-1",
							completedActivationCount: 1,
							abortedActivationCount: 1,
							frontierNodeIds: ["build"],
							sourceMapping: { build: "verify" },
						},
					],
					changeRequests: [
						{
							id: "change-export",
							status: "approved",
							actor: "agent:reviewer",
							origin: "internal-agent",
							reason: "upgrade export validation",
							attemptId: "attempt-export-1",
							operationCount: 1,
							operations: ["add_node verify (script)"],
							frontierMapping: { build: "verify" },
							approvedBy: "human:sihao",
							applications: [
								{
									target: "freeze",
									actor: "human:sihao",
									freezeId: "flowfreeze:export-v2",
									reason: "strict export verification freeze passed",
								},
							],
						},
					],
				},
			]);
		} finally {
			await sm.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("redacts frozen resource text from raw HTML session entries", async () => {
		const dir = await createTempDir();
		const sm = SessionManager.create(dir, dir);
		const outputPath = path.join(dir, "session.html");
		try {
			startWorkflowFamily(sm, { familyId: "family-export" });
			recordWorkflowFreeze(sm, createFreeze("flowfreeze:export-secret", "SECRET_PROMPT_TEXT"), {
				familyId: "family-export",
			});

			await exportSessionToHtml(sm, undefined, { outputPath });
			const html = await Bun.file(outputPath).text();
			const exported = decodeSessionData(html);

			expect(html).not.toContain("SECRET_PROMPT_TEXT");
			expect(JSON.stringify(exported.entries)).not.toContain("SECRET_PROMPT_TEXT");
			expect(JSON.stringify(exported.entries)).toContain("[redacted from HTML export]");
		} finally {
			await sm.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("includes a workflow overview renderer in the generated template", () => {
		const template = getTemplate();
		expect(template).toContain("renderWorkflowOverview");
		expect(template).toContain("workflow-overview");
		expect(template).toContain("workflowInspections");
		expect(template).toContain("workflowLifecycleInspections");
		expect(template).toContain("Activation timeline");
		expect(template).toContain("Checkpoint frontier");
		expect(template).toContain("Change operations");
		expect(template).toContain("Restart lineage");
		expect(template).toContain("Binding diagnostics");
	});
});

function decodeSessionData(html: string): ExportedSessionData {
	const match = html.match(/<script id="session-data" type="application\/json">([^<]+)<\/script>/);
	if (!match) throw new Error("session data script not found");
	return JSON.parse(Buffer.from(match[1], "base64").toString("utf8")) as ExportedSessionData;
}

function createFreeze(id: string, resourceText?: string, nodeIds: string[] = ["build"]): FlowFreeze {
	return {
		id,
		schemaVersion: "omhflow/v1",
		flowPath: `${id}.omhflow`,
		resourceDir: id,
		mainContentHash: `sha256:main-${id}`,
		resourceHashes: [],
		resourceSnapshots:
			resourceText === undefined
				? []
				: [
						{
							path: "prompts/build.md",
							hash: `sha256:resource-${id}`,
							text: resourceText,
							byteLength: resourceText.length,
						},
					],
		canonicalGraphHash: `sha256:graph-${id}`,
		sourceMapping: {
			workflowBlocks: [{ id: "workflow:0", language: "yaml" }],
			nodes: Object.fromEntries(nodeIds.map(nodeId => [nodeId, { sourceBlock: "workflow:0" }])),
		},
		staticCheckReport: { status: "passed", checks: [{ name: "fixture", status: "passed" }] },
		portableDefaults: { models: { roles: { builder: "openai/gpt-4o" }, defaults: { agent: "builder" } } },
		definition: {
			name: id,
			version: 1,
			models: { roles: { builder: "openai/gpt-4o" }, defaults: { agent: "builder" } },
			nodes: nodeIds.map(nodeId => ({ id: nodeId, type: nodeId === "build" ? "agent" : "script" })),
			edges: [],
		},
	};
}
