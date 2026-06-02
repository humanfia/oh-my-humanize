import * as path from "node:path";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { parseCommandArgs } from "../../utils/command-args";
import { buildWorkflowInspection, type WorkflowInspection } from "../../workflow/inspection";
import { loadWorkflowPackage } from "../../workflow/package-loader";
import { reconstructWorkflowRuns } from "../../workflow/run-store";
import { runWorkflow } from "../../workflow/runner";
import type { ParsedSlashCommand, SlashCommandResult, SlashCommandRuntime } from "../types";
import { commandConsumed, parseSubcommand, usage } from "./parse";

interface WorkflowStartArgs {
	workflowPath: string;
	runId?: string;
	startNodeId?: string;
}

export async function handleWorkflowAcp(
	command: ParsedSlashCommand,
	runtime: SlashCommandRuntime,
): Promise<SlashCommandResult> {
	const { verb, rest } = parseSubcommand(command.args);
	if (!verb || verb === "inspect") {
		return handleInspectCommand(runtime);
	}
	if (verb === "start") {
		return handleStartCommand(rest, runtime);
	}
	return usage(workflowUsage(), runtime);
}

async function handleInspectCommand(runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	const runs = reconstructWorkflowRuns(runtime.sessionManager.getBranch());
	const run = runs.at(-1);
	if (!run) {
		await runtime.output("No workflow runs found.");
		return commandConsumed();
	}
	await runtime.output(formatWorkflowInspection(buildWorkflowInspection(run)));
	return commandConsumed();
}

async function handleStartCommand(rest: string, runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	const parsed = parseWorkflowStartArgs(rest);
	if ("error" in parsed) {
		return usage(parsed.error, runtime);
	}
	if (!runtime.createWorkflowRuntimeHost) {
		return usage("Workflow start requires a workflow runtime host.", runtime);
	}
	const pkg = await loadWorkflowPackage(resolveWorkflowPath(parsed.workflowPath, runtime.cwd));
	const startNodeId = parsed.startNodeId ?? pkg.definition.nodes[0]?.id;
	if (!startNodeId) {
		return usage("Workflow start requires a workflow with at least one node.", runtime);
	}
	const runId = parsed.runId ?? `workflow-${Snowflake.next()}`;
	await runWorkflow({
		host: runtime.sessionManager,
		definition: pkg.definition,
		runId,
		startNodeId,
		runtimeHost: await runtime.createWorkflowRuntimeHost(),
		packageRoot: pkg.rootPath,
	});
	const run = reconstructWorkflowRuns(runtime.sessionManager.getBranch()).find(candidate => candidate.id === runId);
	if (!run) {
		await runtime.output(`Workflow run ${runId} started, but no run records were found.`);
		return commandConsumed();
	}
	await runtime.output(formatWorkflowInspection(buildWorkflowInspection(run)));
	return commandConsumed();
}

function parseWorkflowStartArgs(rest: string): WorkflowStartArgs | { error: string } {
	const tokens = parseCommandArgs(rest);
	let workflowPath: string | undefined;
	let runId: string | undefined;
	let startNodeId: string | undefined;
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (token === undefined) continue;
		if (token === "--run-id") {
			const value = tokens[index + 1];
			if (!value) return { error: workflowUsage() };
			runId = value;
			index += 1;
			continue;
		}
		if (token === "--start") {
			const value = tokens[index + 1];
			if (!value) return { error: workflowUsage() };
			startNodeId = value;
			index += 1;
			continue;
		}
		if (token.startsWith("--")) {
			return { error: `Unknown workflow start option: ${token}\n${workflowUsage()}` };
		}
		if (workflowPath !== undefined) {
			return { error: `Unexpected workflow start argument: ${token}\n${workflowUsage()}` };
		}
		workflowPath = token;
	}
	if (!workflowPath) {
		return { error: workflowUsage() };
	}
	return { workflowPath, runId, startNodeId };
}

function resolveWorkflowPath(workflowPath: string, cwd: string): string {
	return path.isAbsolute(workflowPath) ? workflowPath : path.resolve(cwd, workflowPath);
}

function workflowUsage(): string {
	return "Usage: /workflow inspect\nUsage: /workflow start <path> [--run-id <id>] [--start <node-id>]";
}

function formatWorkflowInspection(inspection: WorkflowInspection): string {
	const completed = inspection.activations.filter(activation => activation.status === "completed").length;
	const failed = inspection.activations.filter(activation => activation.status === "failed").length;
	const running = inspection.activations.filter(activation => activation.status === "running").length;
	const lines = [
		`Workflow run: ${inspection.runId}`,
		`Graph: ${inspection.graph.nodes.length} ${plural("node", inspection.graph.nodes.length)}, ${inspection.graph.edges.length} ${plural("edge", inspection.graph.edges.length)}`,
		`Current graph revision: ${inspection.currentGraphRevisionId}`,
		`State keys: ${Object.keys(inspection.state).join(", ") || "none"}`,
		`Activations: ${formatActivationCounts({ completed, failed, running })}`,
	];
	if (inspection.graph.nodes.length > 0) {
		lines.push("Graph nodes:");
		for (const node of inspection.graph.nodes) {
			lines.push(`- ${node.id} (${node.type})`);
		}
	}
	if (inspection.graph.edges.length > 0) {
		lines.push("Graph edges:");
		for (const edge of inspection.graph.edges) {
			lines.push(`- ${edge.from} -> ${edge.to}${formatEdgeCondition(edge.condition)}`);
		}
	}
	if (inspection.pendingGraphPatchProposals.length > 0 || inspection.appliedGraphPatches.length > 0) {
		lines.push(
			`Graph patches: ${inspection.pendingGraphPatchProposals.length} pending, ${inspection.appliedGraphPatches.length} applied`,
		);
	}
	if (inspection.pendingGraphPatchProposals.length > 0) {
		lines.push("Pending graph patch proposals:");
		for (const proposal of inspection.pendingGraphPatchProposals) {
			lines.push(
				`- ${proposal.id} ${proposal.actor}${formatReason(proposal.reason)} (${formatPatchImpact(proposal.impact)})`,
			);
		}
	}
	if (inspection.appliedGraphPatches.length > 0) {
		lines.push("Applied graph patches:");
		for (const patch of inspection.appliedGraphPatches) {
			const proposal = patch.proposalId === undefined ? "" : ` from ${patch.proposalId}`;
			lines.push(
				`- ${patch.graphRevisionId} ${patch.actor}${proposal}${formatReason(patch.reason)} (${formatPatchImpact(patch.impact)})`,
			);
		}
	}
	if (inspection.activations.length > 0) {
		lines.push("Activation details:");
		for (const activation of inspection.activations) {
			const summary = activation.summary ? ` - ${activation.summary}` : "";
			lines.push(`- ${activation.id} ${activation.nodeId} ${activation.status}${summary}`);
		}
	}
	if (inspection.modelAssignments.length > 0) {
		lines.push("Model assignments:");
		for (const assignment of inspection.modelAssignments) {
			const model = assignment.resolvedModel ?? "unresolved";
			lines.push(`- ${assignment.activationId} ${assignment.nodeId} ${model} (${assignment.source})`);
		}
	}
	return lines.join("\n");
}

function formatReason(reason: string | undefined): string {
	return reason === undefined ? "" : ` - ${reason}`;
}

function formatEdgeCondition(condition: string | undefined): string {
	return condition === undefined ? "" : ` when ${condition}`;
}

function formatPatchImpact(impact: WorkflowInspection["pendingGraphPatchProposals"][number]["impact"]): string {
	const parts = [
		formatImpactCount(impact.addedNodes, "added node"),
		formatImpactCount(impact.removedNodes, "removed node"),
		formatImpactCount(impact.changedNodes, "changed node"),
		formatImpactCount(impact.addedEdges, "added edge"),
		formatImpactCount(impact.removedEdges, "removed edge"),
		formatImpactCount(impact.changedEdges, "changed edge"),
		formatImpactCount(impact.promptSourceChanges, "prompt source change"),
		formatImpactCount(impact.modelChanges, "model change"),
		formatImpactCount(impact.permissionChanges, "permission change"),
		formatImpactCount(impact.modelRoleChanges, "model role change"),
		formatImpactCount(impact.warnings, "warning"),
	].filter(part => part !== undefined);
	return parts.length > 0 ? parts.join(", ") : "no graph changes";
}

function formatImpactCount(count: number, label: string): string | undefined {
	if (count === 0) return undefined;
	return `${count} ${plural(label, count)}`;
}

function formatActivationCounts(counts: { completed: number; failed: number; running: number }): string {
	const parts: string[] = [];
	if (counts.completed > 0) parts.push(`${counts.completed} completed`);
	if (counts.failed > 0) parts.push(`${counts.failed} failed`);
	if (counts.running > 0) parts.push(`${counts.running} running`);
	return parts.length > 0 ? parts.join(", ") : "0";
}

function plural(word: string, count: number): string {
	return count === 1 ? word : `${word}s`;
}
