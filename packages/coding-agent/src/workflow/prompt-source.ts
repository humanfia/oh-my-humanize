import * as path from "node:path";
import type { WorkflowNode, WorkflowOutputPromptSource, WorkflowPromptSource } from "./definition";
import type { WorkflowActivation } from "./scheduler";
import { readWorkflowState } from "./state";

export const DEFAULT_WORKFLOW_MAX_PROMPT_BYTES = 32 * 1024;

export interface WorkflowPromptResolutionContext {
	state: Record<string, unknown>;
	completedActivations: WorkflowActivation[];
	parentActivationIds: string[];
	packageRoot?: string;
	maxPromptBytes?: number;
}

export interface WorkflowResolvedPrompt {
	value: string;
	byteLength: number;
	contentHash: string;
	source: WorkflowResolvedPromptSource;
}

export interface WorkflowActivationInputSnapshot {
	prompt?: WorkflowResolvedPrompt;
}

export type WorkflowResolvedPromptSource = WorkflowPromptSource | WorkflowResolvedOutputPromptSource;

export interface WorkflowResolvedOutputPromptSource extends WorkflowOutputPromptSource {
	activationId: string;
}

export class WorkflowPromptSourceError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WorkflowPromptSourceError";
	}
}

export async function resolveWorkflowPrompt(
	node: WorkflowNode,
	context: WorkflowPromptResolutionContext,
): Promise<WorkflowResolvedPrompt | undefined> {
	const source = node.promptSource;
	if (!source) return undefined;
	if (source.kind === "inline") {
		return resolvedPrompt(node, source, source.text, "/inline", context);
	}
	if (source.kind === "file") {
		return resolvedPrompt(
			node,
			source,
			await readPackagePromptFile(node, source.path, context),
			source.path,
			context,
		);
	}
	if (source.kind === "state" || source.kind === "human") {
		return resolvedPrompt(
			node,
			source,
			readWorkflowState(context.state, source.path, { allowedReadPaths: node.reads }),
			source.path,
			context,
		);
	}
	const activation = selectOutputPromptActivation(node, source, context);
	return resolvedPrompt(
		node,
		{ ...source, activationId: activation.id },
		readOutputPromptValue(node, source, activation),
		source.path,
		context,
	);
}

function readOutputPromptValue(
	node: WorkflowNode,
	source: Extract<WorkflowPromptSource, { kind: "output" }>,
	activation: WorkflowActivation,
): unknown {
	if (!activation.output) {
		throw new WorkflowPromptSourceError(
			`workflow prompt source for node "${node.id}" references activation "${activation.id}" without output`,
		);
	}
	return readPointer(activation.output as Record<string, unknown>, source.path);
}

function selectOutputPromptActivation(
	node: WorkflowNode,
	source: Extract<WorkflowPromptSource, { kind: "output" }>,
	context: WorkflowPromptResolutionContext,
): WorkflowActivation {
	return source.activation === "parent"
		? selectParentActivation(node, source, context)
		: selectLatestCompletedActivation(node, source, context);
}

function selectParentActivation(
	node: WorkflowNode,
	source: Extract<WorkflowPromptSource, { kind: "output" }>,
	context: WorkflowPromptResolutionContext,
): WorkflowActivation {
	const matches = context.completedActivations.filter(
		activation => context.parentActivationIds.includes(activation.id) && activation.nodeId === source.node,
	);
	if (matches.length === 1) return matches[0]!;
	if (matches.length === 0) {
		throw new WorkflowPromptSourceError(
			`workflow prompt source for node "${node.id}" has no completed parent activation for node "${source.node}"`,
		);
	}
	throw new WorkflowPromptSourceError(
		`workflow prompt source for node "${node.id}" has multiple parent activations for node "${source.node}"`,
	);
}

function selectLatestCompletedActivation(
	node: WorkflowNode,
	source: Extract<WorkflowPromptSource, { kind: "output" }>,
	context: WorkflowPromptResolutionContext,
): WorkflowActivation {
	const activation = context.completedActivations
		.filter(candidate => candidate.nodeId === source.node && candidate.status === "completed")
		.at(-1);
	if (activation) return activation;
	throw new WorkflowPromptSourceError(
		`workflow prompt source for node "${node.id}" has no completed activation for node "${source.node}"`,
	);
}

async function readPackagePromptFile(
	node: WorkflowNode,
	promptPath: string,
	context: WorkflowPromptResolutionContext,
): Promise<string> {
	if (!context.packageRoot) {
		throw new WorkflowPromptSourceError(
			`workflow prompt source for node "${node.id}" requires a workflow package root`,
		);
	}
	if (!promptPath.startsWith("./")) {
		throw new WorkflowPromptSourceError(
			`workflow prompt file for node "${node.id}" must be package-relative: ${promptPath}`,
		);
	}
	const root = path.resolve(context.packageRoot);
	const resolved = path.resolve(root, promptPath);
	const relative = path.relative(root, resolved);
	if (relative.startsWith("..") || path.isAbsolute(relative)) {
		throw new WorkflowPromptSourceError(`workflow prompt file for node "${node.id}" escapes the package root`);
	}
	try {
		return await Bun.file(resolved).text();
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new WorkflowPromptSourceError(`workflow prompt file for node "${node.id}" is not readable: ${reason}`);
	}
}

function resolvedPrompt(
	node: WorkflowNode,
	source: WorkflowResolvedPromptSource,
	value: unknown,
	label: string,
	context: WorkflowPromptResolutionContext,
): WorkflowResolvedPrompt {
	if (typeof value !== "string") {
		throw new WorkflowPromptSourceError(
			`workflow prompt source for node "${node.id}" at "${label}" must resolve to a string`,
		);
	}
	const byteLength = new TextEncoder().encode(value).byteLength;
	if (byteLength > (context.maxPromptBytes ?? DEFAULT_WORKFLOW_MAX_PROMPT_BYTES)) {
		throw new WorkflowPromptSourceError(`workflow prompt source for node "${node.id}" exceeds the prompt size limit`);
	}
	return { value, byteLength, contentHash: contentHash(value), source };
}

function contentHash(value: string): string {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(value);
	return `sha256:${hasher.digest("hex")}`;
}

function readPointer(root: Record<string, unknown>, pointer: string): unknown {
	let current: unknown = root;
	for (const segment of parseJsonPointer(pointer)) {
		if (!isRecord(current)) return undefined;
		current = current[segment];
	}
	return current;
}

function parseJsonPointer(pointer: string): string[] {
	if (!pointer.startsWith("/")) {
		throw new WorkflowPromptSourceError(`workflow prompt source path must be a JSON pointer: ${pointer}`);
	}
	return pointer
		.slice(1)
		.split("/")
		.map(segment => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
