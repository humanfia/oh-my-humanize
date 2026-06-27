import * as path from "node:path";
import { prompt as promptTemplate } from "@oh-my-pi/pi-utils";
import type {
	WorkflowHumanPromptSource,
	WorkflowInlinePromptSource,
	WorkflowNode,
	WorkflowOutputPromptSource,
	WorkflowPromptSource,
	WorkflowStatePromptSource,
	WorkflowTemplatePromptSource,
} from "./definition";
import type { FlowFreezeResourceSnapshot } from "./freeze";
import type { WorkflowActivation } from "./scheduler";
import { readWorkflowState } from "./state";

export const DEFAULT_WORKFLOW_MAX_PROMPT_BYTES = 32 * 1024;
const MIN_WORKFLOW_TEMPLATE_BINDING_BYTES = 512;
const TEXT_ENCODER = new TextEncoder();

export interface WorkflowPromptResolutionContext {
	state: Record<string, unknown>;
	completedActivations: WorkflowActivation[];
	parentActivationIds: string[];
	packageRoot?: string;
	maxPromptBytes?: number;
	frozenResources?: FlowFreezeResourceSnapshot[];
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

export type WorkflowResolvedPromptSource =
	| Exclude<WorkflowPromptSource, WorkflowOutputPromptSource | WorkflowTemplatePromptSource>
	| WorkflowResolvedOutputPromptSource
	| WorkflowResolvedTemplatePromptSource;

export interface WorkflowResolvedOutputPromptSource extends WorkflowOutputPromptSource {
	activationId: string;
}

export type WorkflowResolvedTemplatePromptBindingSource =
	| WorkflowInlinePromptSource
	| WorkflowHumanPromptSource
	| WorkflowStatePromptSource
	| WorkflowResolvedOutputPromptSource;

export interface WorkflowResolvedTemplatePromptSource {
	kind: "template";
	file: string;
	bindings: Record<string, WorkflowResolvedTemplatePromptBindingSource>;
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
	if (source.kind === "template") {
		const template = await readPackagePromptFile(node, source.file, context);
		const bindings = resolveTemplatePromptBindings(node, source, context);
		return resolvedPrompt(
			node,
			{ kind: "template", file: source.file, bindings: bindings.sources },
			promptTemplate.render(template, bindings.values),
			source.file,
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

function resolveTemplatePromptBindings(
	node: WorkflowNode,
	source: WorkflowTemplatePromptSource,
	context: WorkflowPromptResolutionContext,
): {
	values: Record<string, string>;
	sources: Record<string, WorkflowResolvedTemplatePromptBindingSource>;
} {
	const values: Record<string, string> = {};
	const sources: Record<string, WorkflowResolvedTemplatePromptBindingSource> = {};
	const entries = Object.entries(source.bindings);
	const maxPromptBytes = context.maxPromptBytes ?? DEFAULT_WORKFLOW_MAX_PROMPT_BYTES;
	const bindingBudget = Math.max(
		MIN_WORKFLOW_TEMPLATE_BINDING_BYTES,
		Math.floor(maxPromptBytes / Math.max(2, entries.length + 1)),
	);
	for (const [name, binding] of entries) {
		if (binding.kind === "inline") {
			values[name] = compactPromptTemplateBindingText(node, name, binding.text, bindingBudget);
			sources[name] = binding;
			continue;
		}
		if (binding.kind === "state" || binding.kind === "human") {
			values[name] = promptTemplateBindingText(
				node,
				name,
				readWorkflowState(context.state, binding.path, { allowedReadPaths: node.reads }),
				bindingBudget,
			);
			sources[name] = binding;
			continue;
		}
		const activation = selectOutputPromptActivation(node, binding, context);
		values[name] = promptTemplateBindingText(
			node,
			name,
			readOutputPromptValue(node, binding, activation),
			bindingBudget,
		);
		sources[name] = { ...binding, activationId: activation.id };
	}
	return { values, sources };
}

function promptTemplateBindingText(node: WorkflowNode, bindingName: string, value: unknown, maxBytes: number): string {
	if (typeof value === "string") {
		return compactPromptTemplateBindingText(node, bindingName, value, maxBytes);
	}
	try {
		const serialized = JSON.stringify(value, null, 2);
		if (serialized !== undefined) return compactPromptTemplateBindingText(node, bindingName, serialized, maxBytes);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new WorkflowPromptSourceError(
			`workflow prompt template binding "${bindingName}" for node "${node.id}" is not JSON serializable: ${reason}`,
		);
	}
	throw new WorkflowPromptSourceError(
		`workflow prompt template binding "${bindingName}" for node "${node.id}" must resolve to a string or JSON value`,
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
	return readWorkflowState(activation.output as Record<string, unknown>, source.path, {
		allowedReadPaths: node.reads,
	});
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
	if (path.isAbsolute(promptPath)) {
		throw new WorkflowPromptSourceError(`workflow prompt file for node "${node.id}" escapes the package root`);
	}
	const root = path.resolve(context.packageRoot);
	const resolved = path.resolve(root, promptPath);
	const relative = path.relative(root, resolved);
	if (relative.startsWith("..") || path.isAbsolute(relative)) {
		throw new WorkflowPromptSourceError(`workflow prompt file for node "${node.id}" escapes the package root`);
	}
	const snapshot = findFrozenResourceSnapshot(context.frozenResources, relative);
	if (snapshot) return snapshot.text;
	if (context.frozenResources) {
		throw new WorkflowPromptSourceError(
			`workflow prompt file for node "${node.id}" was not captured in the workflow freeze: ${promptPath}`,
		);
	}
	try {
		return await Bun.file(resolved).text();
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new WorkflowPromptSourceError(`workflow prompt file for node "${node.id}" is not readable: ${reason}`);
	}
}

function findFrozenResourceSnapshot(
	snapshots: FlowFreezeResourceSnapshot[] | undefined,
	relativePath: string,
): FlowFreezeResourceSnapshot | undefined {
	if (!snapshots) return undefined;
	const normalized = relativePath.split(path.sep).join("/");
	return snapshots.find(snapshot => snapshot.path === normalized);
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
	const maxPromptBytes = context.maxPromptBytes ?? DEFAULT_WORKFLOW_MAX_PROMPT_BYTES;
	let promptValue = value;
	let byteLength = utf8ByteLength(promptValue);
	if (byteLength > maxPromptBytes && source.kind === "template") {
		promptValue = compactRenderedTemplatePrompt(node, promptValue, maxPromptBytes);
		byteLength = utf8ByteLength(promptValue);
	}
	if (byteLength > maxPromptBytes) {
		throw new WorkflowPromptSourceError(`workflow prompt source for node "${node.id}" exceeds the prompt size limit`);
	}
	return { value: promptValue, byteLength, contentHash: contentHash(promptValue), source };
}

function contentHash(value: string): string {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(value);
	return `sha256:${hasher.digest("hex")}`;
}

function compactPromptTemplateBindingText(
	node: WorkflowNode,
	bindingName: string,
	value: string,
	maxBytes: number,
): string {
	return compactPromptText(value, maxBytes, original =>
		[
			`workflow prompt binding "${bindingName}" was compacted for node "${node.id}"`,
			`originalBytes=${original.byteLength}`,
			`contentHash=${original.contentHash}`,
			"full value remains in workflow state or activation artifacts referenced by this flow",
		].join("; "),
	);
}

function compactRenderedTemplatePrompt(node: WorkflowNode, value: string, maxBytes: number): string {
	return compactPromptText(value, maxBytes, original =>
		[
			`workflow template prompt for node "${node.id}" was compacted after rendering`,
			`originalBytes=${original.byteLength}`,
			`contentHash=${original.contentHash}`,
			"reduce template bindings or raise maxPromptBytes for full context",
		].join("; "),
	);
}

interface PromptCompactionOriginal {
	byteLength: number;
	contentHash: string;
}

function compactPromptText(
	value: string,
	maxBytes: number,
	notice: (original: PromptCompactionOriginal) => string,
): string {
	const byteLength = utf8ByteLength(value);
	if (byteLength <= maxBytes) return value;
	const suffix = `\n\n[${notice({ byteLength, contentHash: contentHash(value) })}]`;
	const suffixBytes = utf8ByteLength(suffix);
	if (suffixBytes >= maxBytes) {
		return truncateUtf8(suffix, maxBytes);
	}
	const prefix = truncateUtf8(value, maxBytes - suffixBytes).trimEnd();
	return `${prefix}${suffix}`;
}

function truncateUtf8(value: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	if (utf8ByteLength(value) <= maxBytes) return value;
	let low = 0;
	let high = value.length;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (utf8ByteLength(value.slice(0, mid)) <= maxBytes) {
			low = mid;
		} else {
			high = mid - 1;
		}
	}
	return value.slice(0, low);
}

function utf8ByteLength(value: string): number {
	return TEXT_ENCODER.encode(value).byteLength;
}
