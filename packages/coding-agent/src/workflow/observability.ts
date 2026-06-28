import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import type { WorkflowNode } from "./definition";
import type { WorkflowCheckpointWorkspaceSnapshot } from "./lifecycle";
import type { WorkflowReviewNodeOutput } from "./node-runtime";
import type { WorkflowActivationOutput, WorkflowActivationRetryHistoryEntry } from "./state";

const WORKFLOW_OBSERVABILITY_INDEX_PATH = "workflow-output/omh-runtime/observability.json";
const WORKFLOW_OBSERVABILITY_PROGRESS_PATH = "workflow-output/omh-runtime/progress.md";
const WORKFLOW_OBSERVABILITY_ARTIFACTS_PATH = "workflow-output/omh-runtime/artifacts";
const PROGRESS_SUMMARY_MAX_CHARS = 140;

export type WorkflowObservabilityRecorder = (event: WorkflowObservabilityActivation) => Promise<void>;

interface WorkflowObservabilityIndex {
	version: 1;
	activations: WorkflowObservabilityActivation[];
	lifecycle: WorkflowObservabilityLifecycleEvent[];
}

interface WorkflowObservabilityActivation {
	ts: string;
	activationId: string;
	nodeId: string;
	type: WorkflowNode["type"];
	status: "completed";
	summary: string;
	artifacts: string[];
	verdict?: string;
	retries?: WorkflowActivationRetryHistoryEntry[];
}

interface WorkflowObservabilityLifecycleEvent {
	ts: string;
	event: "checkpoint_created";
	attemptId: string;
	checkpointId: string;
	completedActivationIds: string[];
	abortedActivationIds: string[];
	frontierNodeIds: string[];
	workspaceStatus?: string;
	summary: string;
}

export interface RecordWorkflowCheckpointObservabilityOptions {
	attemptId: string;
	checkpointId: string;
	completedActivationIds: string[];
	abortedActivationIds: string[];
	frontierNodeIds: string[];
	workspace?: WorkflowCheckpointWorkspaceSnapshot;
}

export function createWorkflowObservabilityRecorder(cwd: string): WorkflowObservabilityRecorder {
	let pendingWrite: Promise<void> = Promise.resolve();
	return event => {
		const write = pendingWrite.then(() => writeWorkflowObservabilityEvent(cwd, event)).catch(() => undefined);
		pendingWrite = write;
		return write;
	};
}

export async function recordWorkflowActivationObservability(
	record: WorkflowObservabilityRecorder,
	node: WorkflowNode,
	activationId: string,
	output: WorkflowActivationOutput | WorkflowReviewNodeOutput,
): Promise<void> {
	await record(workflowObservabilityActivation(node, activationId, output));
}

export async function recordWorkflowCheckpointObservability(
	cwd: string | undefined,
	options: RecordWorkflowCheckpointObservabilityOptions,
): Promise<void> {
	if (cwd === undefined) return;
	const event: WorkflowObservabilityLifecycleEvent = {
		ts: new Date().toISOString(),
		event: "checkpoint_created",
		attemptId: options.attemptId,
		checkpointId: options.checkpointId,
		completedActivationIds: [...options.completedActivationIds],
		abortedActivationIds: [...options.abortedActivationIds],
		frontierNodeIds: [...options.frontierNodeIds],
		summary: `checkpoint ${options.checkpointId}: completed ${options.completedActivationIds.length}, aborted ${options.abortedActivationIds.length}, frontier ${options.frontierNodeIds.join(", ") || "none"}`,
	};
	if (options.workspace !== undefined) event.workspaceStatus = options.workspace.status;
	await writeWorkflowObservabilityEvent(cwd, event);
}

function workflowObservabilityActivation(
	node: WorkflowNode,
	activationId: string,
	output: WorkflowActivationOutput | WorkflowReviewNodeOutput,
): WorkflowObservabilityActivation {
	const summarySource =
		typeof output.summary === "string" ? output.summary : "verdict" in output ? output.verdict : "";
	const event: WorkflowObservabilityActivation = {
		ts: new Date().toISOString(),
		activationId,
		nodeId: node.id,
		type: node.type,
		status: "completed",
		summary: summarySource.trim() || `workflow node "${node.id}" completed`,
		artifacts: output.artifacts ?? [],
	};
	if ("verdict" in output) event.verdict = output.verdict;
	const retries = workflowObservabilityRetryHistory(output);
	if (retries.length > 0) event.retries = retries;
	return event;
}

function workflowObservabilityRetryHistory(
	output: WorkflowActivationOutput | WorkflowReviewNodeOutput,
): WorkflowActivationRetryHistoryEntry[] {
	if ("retryHistory" in output && output.retryHistory !== undefined) {
		return output.retryHistory.map(entry => ({ ...entry }));
	}
	if (!("data" in output) || output.data === undefined) return [];
	return workflowObservabilityRetryHistoryFromData(output.data);
}

function workflowObservabilityRetryHistoryFromData(
	data: Record<string, unknown>,
): WorkflowActivationRetryHistoryEntry[] {
	const value = data.retryHistory;
	if (!Array.isArray(value)) return [];
	const retries: WorkflowActivationRetryHistoryEntry[] = [];
	for (const entry of value) {
		if (!isWorkflowObservabilityRetryHistoryEntry(entry)) continue;
		retries.push({ ...entry });
	}
	return retries;
}

async function writeWorkflowObservabilityEvent(
	cwd: string,
	event: WorkflowObservabilityActivation | WorkflowObservabilityLifecycleEvent,
): Promise<void> {
	const indexPath = `${cwd}/${WORKFLOW_OBSERVABILITY_INDEX_PATH}`;
	const materializedEvent =
		"activationId" in event ? await materializeWorkflowObservabilityArtifacts(cwd, event) : event;
	const previous = await readWorkflowObservabilityIndex(indexPath);
	const next: WorkflowObservabilityIndex =
		"activationId" in materializedEvent
			? { ...previous, activations: [...previous.activations, materializedEvent] }
			: { ...previous, lifecycle: [...previous.lifecycle, materializedEvent] };
	await Bun.write(indexPath, `${JSON.stringify(next, null, 2)}\n`);
	await Bun.write(`${cwd}/${WORKFLOW_OBSERVABILITY_PROGRESS_PATH}`, renderWorkflowObservabilityProgress(next));
}

async function materializeWorkflowObservabilityArtifacts(
	cwd: string,
	event: WorkflowObservabilityActivation,
): Promise<WorkflowObservabilityActivation> {
	if (event.artifacts.length === 0) return event;
	const artifacts: string[] = [];
	let fileArtifactIndex = 0;
	for (const artifact of event.artifacts) {
		const source = workflowObservabilityFileArtifactPath(artifact);
		const materialized =
			source === undefined
				? artifact
				: await materializeWorkflowObservabilityArtifact(cwd, event, artifact, source, ++fileArtifactIndex);
		if (!artifacts.includes(materialized)) artifacts.push(materialized);
	}
	return { ...event, artifacts };
}

async function materializeWorkflowObservabilityArtifact(
	cwd: string,
	event: WorkflowObservabilityActivation,
	artifact: string,
	source: string,
	indexValue: number,
): Promise<string> {
	const target = workflowObservabilityArtifactMirrorPath(cwd, event, source, indexValue);
	try {
		await Bun.write(target, await Bun.file(source).arrayBuffer());
		return workflowObservabilityPortablePath(path.relative(cwd, target));
	} catch (error) {
		if (isEnoent(error)) return artifact;
		throw error;
	}
}

function workflowObservabilityFileArtifactPath(artifact: string): string | undefined {
	if (path.isAbsolute(artifact)) return artifact;
	if (!artifact.startsWith("local:///")) return undefined;
	const resolved = artifact.slice("local://".length);
	return path.isAbsolute(resolved) ? resolved : undefined;
}

function workflowObservabilityArtifactMirrorPath(
	cwd: string,
	event: WorkflowObservabilityActivation,
	source: string,
	indexValue: number,
): string {
	const activationDir = sanitizeWorkflowObservabilityPathSegment(event.activationId);
	const basename = sanitizeWorkflowObservabilityPathSegment(path.basename(source));
	return path.join(cwd, WORKFLOW_OBSERVABILITY_ARTIFACTS_PATH, activationDir, `${indexValue}-${basename}`);
}

function sanitizeWorkflowObservabilityPathSegment(value: string): string {
	const sanitized = value.replace(/[^A-Za-z0-9._-]+/gu, "_").replace(/^_+|_+$/gu, "");
	return sanitized || "artifact";
}

function workflowObservabilityPortablePath(value: string): string {
	return value.split(path.sep).join("/");
}

async function readWorkflowObservabilityIndex(indexPath: string): Promise<WorkflowObservabilityIndex> {
	try {
		const parsed: unknown = JSON.parse(await Bun.file(indexPath).text());
		if (isWorkflowObservabilityIndex(parsed)) return parsed;
		return emptyWorkflowObservabilityIndex();
	} catch (error) {
		if (isEnoent(error)) return emptyWorkflowObservabilityIndex();
		throw error;
	}
}

function isWorkflowObservabilityIndex(value: unknown): value is WorkflowObservabilityIndex {
	if (!isWorkflowRecord(value)) return false;
	if (value.version !== 1) return false;
	if (!Array.isArray(value.activations)) return false;
	if (!value.activations.every(isWorkflowObservabilityActivation)) return false;
	if (value.lifecycle === undefined) return true;
	return Array.isArray(value.lifecycle) && value.lifecycle.every(isWorkflowObservabilityLifecycleEvent);
}

function isWorkflowObservabilityActivation(value: unknown): value is WorkflowObservabilityActivation {
	if (!isWorkflowRecord(value)) return false;
	return (
		typeof value.ts === "string" &&
		typeof value.activationId === "string" &&
		typeof value.nodeId === "string" &&
		typeof value.type === "string" &&
		value.status === "completed" &&
		typeof value.summary === "string" &&
		Array.isArray(value.artifacts) &&
		value.artifacts.every(artifact => typeof artifact === "string") &&
		(value.verdict === undefined || typeof value.verdict === "string") &&
		(value.retries === undefined ||
			(Array.isArray(value.retries) && value.retries.every(isWorkflowObservabilityRetryHistoryEntry)))
	);
}

function isWorkflowObservabilityRetryHistoryEntry(value: unknown): value is WorkflowActivationRetryHistoryEntry {
	if (!isWorkflowRecord(value)) return false;
	return (
		typeof value.attempt === "number" &&
		Number.isInteger(value.attempt) &&
		typeof value.maxAttempts === "number" &&
		Number.isInteger(value.maxAttempts) &&
		typeof value.reason === "string" &&
		typeof value.nextAttempt === "number" &&
		Number.isInteger(value.nextAttempt) &&
		typeof value.delayMs === "number" &&
		Number.isInteger(value.delayMs)
	);
}

function isWorkflowObservabilityLifecycleEvent(value: unknown): value is WorkflowObservabilityLifecycleEvent {
	if (!isWorkflowRecord(value)) return false;
	return (
		typeof value.ts === "string" &&
		value.event === "checkpoint_created" &&
		typeof value.attemptId === "string" &&
		typeof value.checkpointId === "string" &&
		Array.isArray(value.completedActivationIds) &&
		value.completedActivationIds.every(id => typeof id === "string") &&
		Array.isArray(value.abortedActivationIds) &&
		value.abortedActivationIds.every(id => typeof id === "string") &&
		Array.isArray(value.frontierNodeIds) &&
		value.frontierNodeIds.every(id => typeof id === "string") &&
		(value.workspaceStatus === undefined || typeof value.workspaceStatus === "string") &&
		typeof value.summary === "string"
	);
}

function isWorkflowRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emptyWorkflowObservabilityIndex(): WorkflowObservabilityIndex {
	return { version: 1, activations: [], lifecycle: [] };
}

function renderWorkflowObservabilityProgress(index: WorkflowObservabilityIndex): string {
	const lines = [
		"# OMH Workflow Progress",
		"",
		`Last updated: ${lastWorkflowObservabilityTimestamp(index)}`,
		`Completed activations: ${index.activations.length}`,
		`Lifecycle events: ${index.lifecycle.length}`,
		"",
		"## Completed Activations",
		"",
		"| # | Node | Type | Activation | Summary |",
		"| - | - | - | - | - |",
	];
	for (const [indexValue, activation] of index.activations.entries()) {
		lines.push(
			`| ${[
				String(indexValue + 1),
				markdownTableCell(activation.nodeId),
				markdownTableCell(activation.type),
				markdownTableCell(activation.activationId),
				markdownTableCell(compactWorkflowProgressSummary(workflowActivationProgressSummary(activation))),
			].join(" | ")} |`,
		);
	}
	lines.push("", "## Lifecycle Events", "", "| # | Event | Attempt | Summary |", "| - | - | - | - |");
	for (const [indexValue, event] of index.lifecycle.entries()) {
		lines.push(
			`| ${[
				String(indexValue + 1),
				markdownTableCell(event.event),
				markdownTableCell(event.attemptId),
				markdownTableCell(compactWorkflowProgressSummary(event.summary)),
			].join(" | ")} |`,
		);
	}
	lines.push("", "## Artifact References", "");
	for (const activation of index.activations) {
		if (activation.artifacts.length === 0) continue;
		lines.push(`### ${activation.nodeId} (${activation.activationId})`, "");
		for (const artifact of activation.artifacts) {
			lines.push(`- ${artifact}`);
		}
		lines.push("");
	}
	return `${lines.join("\n").trimEnd()}\n`;
}

function workflowActivationProgressSummary(activation: WorkflowObservabilityActivation): string {
	const retryCount = activation.retries?.length ?? 0;
	if (retryCount === 0) return activation.summary;
	return `${activation.summary} (recovered retries=${retryCount})`;
}

function lastWorkflowObservabilityTimestamp(index: WorkflowObservabilityIndex): string {
	const lastActivationTs = index.activations.at(-1)?.ts;
	const lastLifecycleTs = index.lifecycle.at(-1)?.ts;
	return lastLifecycleTs ?? lastActivationTs ?? "n/a";
}

function compactWorkflowProgressSummary(value: string): string {
	const compact = value.replace(/\s+/gu, " ").trim();
	if (compact.length <= PROGRESS_SUMMARY_MAX_CHARS) return compact;
	return `${compact.slice(0, PROGRESS_SUMMARY_MAX_CHARS - 3).trimEnd()}...`;
}

function markdownTableCell(value: string): string {
	return value.replaceAll("\n", " ").replaceAll("|", "\\|").trim();
}
