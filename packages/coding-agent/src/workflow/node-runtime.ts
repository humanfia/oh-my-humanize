import type {
	WorkflowChildWorkflowInvocation,
	WorkflowForeachBody,
	WorkflowForeachDefinition,
	WorkflowModelContext,
	WorkflowNode,
	WorkflowScriptLanguage,
} from "./definition";
import type { WorkflowActivation } from "./scheduler";
import { readWorkflowState, type WorkflowActivationOutput } from "./state";

export interface WorkflowNodeRuntimeInput {
	node: WorkflowNode;
	activation: WorkflowActivation;
	signal?: AbortSignal;
}

export interface WorkflowAgentNodeInput extends WorkflowNodeRuntimeInput {
	agent: string;
	prompt?: string;
	model?: WorkflowModelContext;
	modelOverride?: string;
}

export interface WorkflowScriptNodeInput extends WorkflowNodeRuntimeInput {
	script?: string;
	scriptLanguage?: WorkflowScriptLanguage;
	scriptPath?: string;
	timeoutMs?: number;
	resourceDir?: string;
	model?: WorkflowModelContext;
	context?: WorkflowScriptContext;
}

export interface WorkflowHumanNodeInput extends WorkflowNodeRuntimeInput {
	prompt?: string;
}

export interface WorkflowReviewNodeInput extends WorkflowNodeRuntimeInput {
	agent?: string;
	prompt?: string;
	model?: WorkflowModelContext;
	modelOverride?: string;
	gates?: string[];
	fallbackVerdict?: string;
}

export interface WorkflowReviewNodeOutput {
	summary?: string;
	verdict: string;
	artifacts?: string[];
}

export interface WorkflowWorkflowNodeInput extends WorkflowNodeRuntimeInput {
	workflowPath: string;
	state: Record<string, unknown>;
	item?: unknown;
	itemKey?: string;
	itemIndex?: number;
	parentNodeId?: string;
	workflowBasePath?: string;
}

export interface WorkflowWorkflowNodeOutput {
	summary?: string;
	data?: Record<string, unknown>;
	artifacts?: string[];
	childFamilyId: string;
	childAttemptId: string;
}

export interface WorkflowNodeRuntimeHost {
	runAgentNode?: (input: WorkflowAgentNodeInput) => Promise<WorkflowActivationOutput>;
	runScriptNode?: (input: WorkflowScriptNodeInput) => Promise<WorkflowActivationOutput>;
	runHumanNode?: (input: WorkflowHumanNodeInput) => Promise<WorkflowActivationOutput>;
	runReviewNode?: (input: WorkflowReviewNodeInput) => Promise<WorkflowReviewNodeOutput>;
	runWorkflowNode?: (input: WorkflowWorkflowNodeInput) => Promise<WorkflowWorkflowNodeOutput>;
}

export interface WorkflowNodeExecutionContext {
	state: Record<string, unknown>;
	completedActivations: WorkflowActivation[];
}

export interface WorkflowScriptContext {
	activation: Pick<WorkflowActivation, "id" | "nodeId" | "graphRevisionId" | "parentActivationIds">;
	node: Pick<WorkflowNode, "id" | "type">;
	state: Record<string, unknown>;
	completedActivations: WorkflowActivation[];
	resources?: WorkflowScriptResourceContext;
}

export interface WorkflowScriptResourceContext {
	root: string;
}

export interface WorkflowNodeRuntimeOptions {
	modelOverride?: string;
	signal?: AbortSignal;
	context?: WorkflowNodeExecutionContext;
	resourceDir?: string;
	workflowBasePath?: string;
}

export class WorkflowNodeRuntimeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WorkflowNodeRuntimeError";
	}
}

export async function executeWorkflowNode(
	node: WorkflowNode,
	activation: WorkflowActivation,
	host: WorkflowNodeRuntimeHost,
	options: WorkflowNodeRuntimeOptions = {},
): Promise<WorkflowActivationOutput> {
	if (node.type === "agent") {
		return executeAgentNode(node, activation, host, options);
	}
	if (node.type === "script") {
		return executeScriptNode(node, activation, host, options);
	}
	if (node.type === "human") {
		return executeHumanNode(node, activation, host, options);
	}
	if (node.type === "review") {
		return executeReviewNode(node, activation, host, options);
	}
	if (node.type === "foreach") {
		return executeForeachNode(node, activation, host, options);
	}
	if (node.type === "workflow") {
		return executeWorkflowInvocationNode(node, activation, host, options);
	}
	throw new WorkflowNodeRuntimeError(`unsupported workflow node type: ${node.type}`);
}

async function executeAgentNode(
	node: WorkflowNode,
	activation: WorkflowActivation,
	host: WorkflowNodeRuntimeHost,
	options: WorkflowNodeRuntimeOptions,
): Promise<WorkflowActivationOutput> {
	if (!node.agent) {
		throw new WorkflowNodeRuntimeError(`agent node "${node.id}" must define an agent`);
	}
	if (!host.runAgentNode) {
		throw new WorkflowNodeRuntimeError("workflow runtime host does not support agent nodes");
	}
	const input: WorkflowAgentNodeInput = {
		node,
		activation,
		agent: node.agent,
		prompt: node.prompt,
		model: node.model,
	};
	if (options.modelOverride !== undefined) {
		input.modelOverride = options.modelOverride;
	}
	if (options.signal !== undefined) {
		input.signal = options.signal;
	}
	return host.runAgentNode(input);
}

async function executeScriptNode(
	node: WorkflowNode,
	activation: WorkflowActivation,
	host: WorkflowNodeRuntimeHost,
	options: WorkflowNodeRuntimeOptions,
): Promise<WorkflowActivationOutput> {
	if (!host.runScriptNode) {
		throw new WorkflowNodeRuntimeError("workflow runtime host does not support script nodes");
	}
	const input: WorkflowScriptNodeInput = {
		node,
		activation,
		script: node.script?.code ?? node.prompt,
		scriptLanguage: node.script?.language,
		scriptPath: node.script?.file,
		timeoutMs: node.script?.timeoutMs,
		model: node.model,
	};
	if (options.resourceDir !== undefined) {
		input.resourceDir = options.resourceDir;
	}
	const context = workflowScriptContextSnapshot(node, activation, options.context, options.resourceDir);
	if (context !== undefined) {
		input.context = context;
	}
	if (options.signal !== undefined) {
		input.signal = options.signal;
	}
	return host.runScriptNode(input);
}

function workflowScriptContextSnapshot(
	node: WorkflowNode,
	activation: WorkflowActivation,
	context: WorkflowNodeExecutionContext | undefined,
	resourceDir: string | undefined,
): WorkflowScriptContext | undefined {
	if (context === undefined) return undefined;
	const snapshot: WorkflowScriptContext = {
		activation: {
			id: activation.id,
			nodeId: activation.nodeId,
			graphRevisionId: activation.graphRevisionId,
			parentActivationIds: [...activation.parentActivationIds],
		},
		node: {
			id: node.id,
			type: node.type,
		},
		state: structuredClone(context.state),
		completedActivations: structuredClone(context.completedActivations),
	};
	if (resourceDir !== undefined) {
		snapshot.resources = { root: resourceDir };
	}
	return snapshot;
}

async function executeHumanNode(
	node: WorkflowNode,
	activation: WorkflowActivation,
	host: WorkflowNodeRuntimeHost,
	options: WorkflowNodeRuntimeOptions,
): Promise<WorkflowActivationOutput> {
	if (!host.runHumanNode) {
		throw new WorkflowNodeRuntimeError("workflow runtime host does not support human nodes");
	}
	const input: WorkflowHumanNodeInput = {
		node,
		activation,
		prompt: node.prompt,
	};
	if (options.signal !== undefined) {
		input.signal = options.signal;
	}
	return host.runHumanNode(input);
}

async function executeReviewNode(
	node: WorkflowNode,
	activation: WorkflowActivation,
	host: WorkflowNodeRuntimeHost,
	options: WorkflowNodeRuntimeOptions,
): Promise<WorkflowActivationOutput> {
	if (!host.runReviewNode) {
		throw new WorkflowNodeRuntimeError("workflow runtime host does not support review nodes");
	}
	const input: WorkflowReviewNodeInput = {
		node,
		activation,
		agent: node.agent,
		prompt: node.prompt,
		model: node.model,
		gates: node.gates,
	};
	if (node.fallbackVerdict !== undefined) {
		input.fallbackVerdict = node.fallbackVerdict;
	}
	if (options.modelOverride !== undefined) {
		input.modelOverride = options.modelOverride;
	}
	if (options.signal !== undefined) {
		input.signal = options.signal;
	}
	const output = await host.runReviewNode(input);
	if (node.gates?.length && !node.gates.includes(output.verdict)) {
		throw new WorkflowNodeRuntimeError(
			`workflow review node "${node.id}" returned undeclared verdict "${output.verdict}"`,
		);
	}
	const result: WorkflowActivationOutput = {
		summary: output.summary,
		data: { verdict: output.verdict },
		statePatch: [{ op: "set", path: reviewVerdictStatePath(node), value: output.verdict }],
	};
	if (output.artifacts !== undefined) result.artifacts = output.artifacts;
	return result;
}

function reviewVerdictStatePath(node: WorkflowNode): string {
	return node.writes?.[0] ?? "/verdict";
}

async function executeWorkflowInvocationNode(
	node: WorkflowNode,
	activation: WorkflowActivation,
	host: WorkflowNodeRuntimeHost,
	options: WorkflowNodeRuntimeOptions,
): Promise<WorkflowActivationOutput> {
	if (node.workflow === undefined) {
		throw new WorkflowNodeRuntimeError(`workflow node "${node.id}" must define a child workflow invocation`);
	}
	const output = await runChildWorkflowInvocation(node.workflow, node, activation, host, options, {
		state: options.context?.state ?? {},
	});
	return childWorkflowOutputToActivationOutput(output);
}

async function executeForeachNode(
	node: WorkflowNode,
	activation: WorkflowActivation,
	host: WorkflowNodeRuntimeHost,
	options: WorkflowNodeRuntimeOptions,
): Promise<WorkflowActivationOutput> {
	const foreach = node.foreach;
	if (foreach === undefined) {
		throw new WorkflowNodeRuntimeError(`foreach node "${node.id}" must define foreach metadata`);
	}
	const parentState = options.context?.state;
	if (parentState === undefined) {
		throw new WorkflowNodeRuntimeError(`foreach node "${node.id}" requires workflow state context`);
	}
	const items = readWorkflowState(parentState, foreach.items, { allowedReadPaths: node.reads });
	if (!Array.isArray(items)) {
		throw new WorkflowNodeRuntimeError(
			`foreach node "${node.id}" items path "${foreach.items}" must resolve to an array`,
		);
	}
	const records = createForeachItemRecords(foreach, items);
	const failFastError = await runForeachItemPool({
		node,
		activation,
		host,
		options,
		foreach,
		items,
		records,
		parentState,
	});
	if (failFastError !== undefined && foreach.failureMode === "failFast") {
		throw new WorkflowNodeRuntimeError(failFastError);
	}
	const aggregate = {
		records: records.map(record => compactForeachItemRecord(record)),
		lifecycle: foreachLifecycle(records),
	};
	return {
		summary: formatForeachSummary(node, aggregate.lifecycle),
		data: aggregate,
		statePatch: [{ op: "set", path: foreach.output.path, value: aggregate }],
	};
}

type WorkflowForeachItemStatus = "queued" | "running" | "completed" | "failed" | "aborted";

interface WorkflowForeachItemRecord {
	key: string;
	index: number;
	status: WorkflowForeachItemStatus;
	summary?: string;
	data?: Record<string, unknown>;
	artifacts?: string[];
	error?: string;
	childFamilyId?: string;
	childAttemptId?: string;
}

interface WorkflowForeachLifecycle {
	queuedKeys: string[];
	runningKeys: string[];
	completedKeys: string[];
	failedKeys: string[];
	abortedKeys: string[];
}

interface WorkflowForeachPoolInput {
	node: WorkflowNode;
	activation: WorkflowActivation;
	host: WorkflowNodeRuntimeHost;
	options: WorkflowNodeRuntimeOptions;
	foreach: WorkflowForeachDefinition;
	items: unknown[];
	records: WorkflowForeachItemRecord[];
	parentState: Record<string, unknown>;
}

function createForeachItemRecords(foreach: WorkflowForeachDefinition, items: unknown[]): WorkflowForeachItemRecord[] {
	const seen = new Set<string>();
	return items.map((item, index) => {
		const key = foreachItemKey(foreach, item, index);
		if (seen.has(key)) {
			throw new WorkflowNodeRuntimeError(`foreach item key "${key}" is not unique`);
		}
		seen.add(key);
		return { key, index, status: "queued" };
	});
}

async function runForeachItemPool(input: WorkflowForeachPoolInput): Promise<string | undefined> {
	let nextIndex = 0;
	let stopScheduling = false;
	let failFastError: string | undefined;
	const workerCount = Math.min(input.foreach.concurrency ?? 1, input.items.length);
	const workers = Array.from({ length: workerCount }, () =>
		runForeachWorker(input, {
			nextIndex: () => {
				if (stopScheduling || workflowAbortReason(input.options.signal)) return undefined;
				const index = nextIndex;
				nextIndex += 1;
				return index < input.items.length ? index : undefined;
			},
			stop: (error: string | undefined) => {
				stopScheduling = true;
				if (error !== undefined && failFastError === undefined) failFastError = error;
			},
		}),
	);
	await Promise.all(workers);
	return failFastError;
}

interface WorkflowForeachWorkerControl {
	nextIndex: () => number | undefined;
	stop: (error: string | undefined) => void;
}

async function runForeachWorker(input: WorkflowForeachPoolInput, control: WorkflowForeachWorkerControl): Promise<void> {
	while (true) {
		const index = control.nextIndex();
		if (index === undefined) return;
		const record = input.records[index];
		const item = input.items[index];
		if (record === undefined || item === undefined) return;
		record.status = "running";
		try {
			const output = await executeForeachBody(input, item, record);
			record.status = "completed";
			copyForeachOutputToRecord(record, output);
			if (workflowAbortReason(input.options.signal)) control.stop(undefined);
		} catch (error) {
			const message = formatError(error);
			if (workflowAbortReason(input.options.signal)) {
				record.status = "aborted";
				record.error = message;
				control.stop(undefined);
				continue;
			}
			record.status = "failed";
			record.error = message;
			if (input.foreach.failureMode === "failFast") {
				control.stop(`foreach node "${input.node.id}" item "${record.key}" failed: ${message}`);
			}
		}
	}
}

async function executeForeachBody(
	input: WorkflowForeachPoolInput,
	item: unknown,
	record: WorkflowForeachItemRecord,
): Promise<WorkflowActivationOutput> {
	if (input.foreach.body.kind === "workflow") {
		const childOutput = await runChildWorkflowInvocation(
			input.foreach.body.workflow,
			input.node,
			itemActivation(input.activation, input.node, record),
			input.host,
			input.options,
			{
				state: foreachItemState(input.parentState, input.foreach, item),
				item,
				itemKey: record.key,
				itemIndex: record.index,
				parentNodeId: input.node.id,
			},
		);
		return childWorkflowOutputToActivationOutput(childOutput);
	}
	return executeForeachNodeBody(input.foreach.body, input, item, record);
}

function executeForeachNodeBody(
	body: Extract<WorkflowForeachBody, { kind: "node" }>,
	input: WorkflowForeachPoolInput,
	item: unknown,
	record: WorkflowForeachItemRecord,
): Promise<WorkflowActivationOutput> {
	return executeWorkflowNode(body.node, itemActivation(input.activation, body.node, record), input.host, {
		...input.options,
		context: {
			state: foreachItemState(input.parentState, input.foreach, item),
			completedActivations: input.options.context?.completedActivations ?? [],
		},
	});
}

function itemActivation(
	parentActivation: WorkflowActivation,
	node: WorkflowNode,
	record: WorkflowForeachItemRecord,
): WorkflowActivation {
	return {
		id: `${parentActivation.id}:item:${record.key}`,
		nodeId: node.id,
		graphRevisionId: parentActivation.graphRevisionId,
		status: "running",
		parentActivationIds: [parentActivation.id],
	};
}

function foreachItemState(
	parentState: Record<string, unknown>,
	foreach: WorkflowForeachDefinition,
	item: unknown,
): Record<string, unknown> {
	const state = structuredClone(parentState);
	state[foreach.itemName ?? "item"] = item;
	return state;
}

async function runChildWorkflowInvocation(
	invocation: WorkflowChildWorkflowInvocation,
	node: WorkflowNode,
	activation: WorkflowActivation,
	host: WorkflowNodeRuntimeHost,
	options: WorkflowNodeRuntimeOptions,
	extra: {
		state: Record<string, unknown>;
		item?: unknown;
		itemKey?: string;
		itemIndex?: number;
		parentNodeId?: string;
	},
): Promise<WorkflowWorkflowNodeOutput> {
	if (!host.runWorkflowNode) {
		throw new WorkflowNodeRuntimeError("workflow runtime host does not support child workflow nodes");
	}
	const input: WorkflowWorkflowNodeInput = {
		node,
		activation,
		workflowPath: invocation.path,
		state: extra.state,
	};
	if (options.signal !== undefined) input.signal = options.signal;
	if (options.workflowBasePath !== undefined) input.workflowBasePath = options.workflowBasePath;
	if (extra.item !== undefined) input.item = extra.item;
	if (extra.itemKey !== undefined) input.itemKey = extra.itemKey;
	if (extra.itemIndex !== undefined) input.itemIndex = extra.itemIndex;
	if (extra.parentNodeId !== undefined) input.parentNodeId = extra.parentNodeId;
	return host.runWorkflowNode(input);
}

function childWorkflowOutputToActivationOutput(output: WorkflowWorkflowNodeOutput): WorkflowActivationOutput {
	assertNoTranscriptRecord(output.data);
	const data: Record<string, unknown> = {
		...(output.data ?? {}),
		childFamilyId: output.childFamilyId,
		childAttemptId: output.childAttemptId,
	};
	const result: WorkflowActivationOutput = { data };
	if (output.summary !== undefined) result.summary = output.summary;
	if (output.artifacts !== undefined) result.artifacts = output.artifacts;
	return result;
}

function copyForeachOutputToRecord(record: WorkflowForeachItemRecord, output: WorkflowActivationOutput): void {
	assertNoTranscriptRecord(output.data);
	if (output.summary !== undefined) record.summary = output.summary;
	if (output.data !== undefined) {
		const childFamilyId = output.data.childFamilyId;
		const childAttemptId = output.data.childAttemptId;
		const data = { ...output.data };
		delete data.childFamilyId;
		delete data.childAttemptId;
		if (Object.keys(data).length > 0) record.data = data;
		if (typeof childFamilyId === "string") record.childFamilyId = childFamilyId;
		if (typeof childAttemptId === "string") record.childAttemptId = childAttemptId;
	}
	if (output.artifacts !== undefined) record.artifacts = output.artifacts;
}

function compactForeachItemRecord(record: WorkflowForeachItemRecord): WorkflowForeachItemRecord {
	const compacted: WorkflowForeachItemRecord = {
		key: record.key,
		index: record.index,
		status: record.status,
	};
	if (record.summary !== undefined) compacted.summary = record.summary;
	if (record.data !== undefined) compacted.data = record.data;
	if (record.artifacts !== undefined) compacted.artifacts = record.artifacts;
	if (record.error !== undefined) compacted.error = record.error;
	if (record.childFamilyId !== undefined) compacted.childFamilyId = record.childFamilyId;
	if (record.childAttemptId !== undefined) compacted.childAttemptId = record.childAttemptId;
	return compacted;
}

function foreachLifecycle(records: WorkflowForeachItemRecord[]): WorkflowForeachLifecycle {
	return {
		queuedKeys: records.filter(record => record.status === "queued").map(record => record.key),
		runningKeys: records.filter(record => record.status === "running").map(record => record.key),
		completedKeys: records.filter(record => record.status === "completed").map(record => record.key),
		failedKeys: records.filter(record => record.status === "failed").map(record => record.key),
		abortedKeys: records.filter(record => record.status === "aborted").map(record => record.key),
	};
}

function foreachItemKey(foreach: WorkflowForeachDefinition, item: unknown, index: number): string {
	if (foreach.key === undefined) return String(index);
	const value = readJsonPointer(item, foreach.key);
	if (value === undefined || value === null) {
		throw new WorkflowNodeRuntimeError(`foreach item ${index} key path "${foreach.key}" is missing`);
	}
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
	throw new WorkflowNodeRuntimeError(`foreach item ${index} key path "${foreach.key}" must resolve to a scalar`);
}

function readJsonPointer(value: unknown, pointer: string): unknown {
	let current = value;
	for (const segment of parseJsonPointer(pointer)) {
		if (Array.isArray(current)) {
			const index = Number(segment);
			if (!Number.isSafeInteger(index) || index < 0) return undefined;
			current = current[index];
			continue;
		}
		if (!isRecord(current)) return undefined;
		current = current[segment];
	}
	return current;
}

function parseJsonPointer(pointer: string): string[] {
	if (pointer === "") return [];
	if (!pointer.startsWith("/")) {
		throw new WorkflowNodeRuntimeError(`workflow state path must be a JSON pointer: ${pointer}`);
	}
	return pointer
		.slice(1)
		.split("/")
		.map(segment => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
}

function formatForeachSummary(node: WorkflowNode, lifecycle: WorkflowForeachLifecycle): string {
	const failed = lifecycle.failedKeys.length;
	const aborted = lifecycle.abortedKeys.length;
	const completed = lifecycle.completedKeys.length;
	if (aborted > 0) return `foreach ${node.id} stopped after ${completed} completed, ${aborted} aborted`;
	if (failed > 0) return `foreach ${node.id} completed with ${failed} failed item${failed === 1 ? "" : "s"}`;
	return `foreach ${node.id} completed ${completed} item${completed === 1 ? "" : "s"}`;
}

function assertNoTranscriptRecord(data: Record<string, unknown> | undefined): void {
	if (data === undefined) return;
	for (const field of ["transcript", "rawTranscript", "rawOutput"]) {
		if (data[field] !== undefined) {
			throw new WorkflowNodeRuntimeError("workflow item output must store transcripts as artifact references");
		}
	}
}

function workflowAbortReason(signal: AbortSignal | undefined): string | undefined {
	if (!signal?.aborted) return undefined;
	const reason: unknown = signal.reason;
	if (reason instanceof Error) return reason.message;
	if (typeof reason === "string" && reason.length > 0) return reason;
	if (reason !== undefined && reason !== null) return String(reason);
	return "workflow activation aborted";
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
