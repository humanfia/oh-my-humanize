import {
	assertWorkflowStateWriteMatchesSchema,
	unescapeJsonPointerSegment,
	type WorkflowStateSchema,
} from "./state-schema";

export const DEFAULT_WORKFLOW_MAX_INLINE_VALUE_BYTES = 32 * 1024;
export const DEFAULT_WORKFLOW_MAX_SUMMARY_BYTES = 8 * 1024;

export interface WorkflowStatePatchOperation {
	op: "set";
	path: string;
	value: unknown;
}

export interface WorkflowActivationOutput {
	summary?: string;
	data?: Record<string, unknown>;
	statePatch?: WorkflowStatePatchOperation[];
	artifacts?: string[];
}

export interface WorkflowStateAccessPolicy {
	allowedReadPaths?: string[];
	allowedWritePaths?: string[];
	maxInlineValueBytes?: number;
	maxSummaryBytes?: number;
	stateSchema?: WorkflowStateSchema;
}

export class WorkflowStateError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WorkflowStateError";
	}
}

export function readWorkflowState(
	state: Record<string, unknown>,
	pointer: string,
	policy: WorkflowStateAccessPolicy = {},
): unknown {
	assertPointerAllowed(pointer, policy.allowedReadPaths, "read from");
	return getStatePath(state, pointer);
}

export function applyWorkflowStatePatch(
	state: Record<string, unknown>,
	patch: WorkflowStatePatchOperation[],
	policy: WorkflowStateAccessPolicy = {},
): void {
	assertNoConflictingWrites(patch);
	for (const operation of patch) {
		assertWorkflowStateWriteAllowed(operation, policy);
	}
	for (const operation of patch) {
		setStatePath(state, operation.path, operation.value);
	}
}

export function validateWorkflowActivationOutput(
	output: unknown,
	policy: WorkflowStateAccessPolicy = {},
): WorkflowActivationOutput {
	const raw = expectRecord(output, "workflow activation output");
	assertNoRawTranscriptFields(raw);
	const result: WorkflowActivationOutput = {};
	if (raw.summary !== undefined) {
		result.summary = expectString(raw.summary, "workflow activation output summary");
		assertInlineText("workflow activation output summary", result.summary, maxSummaryBytes(policy));
	}
	if (raw.artifacts !== undefined) {
		result.artifacts = expectStringList(raw.artifacts, "workflow activation output artifacts");
		for (const reference of result.artifacts) {
			assertArtifactReference(reference);
		}
	}
	if (raw.data !== undefined) {
		result.data = expectRecord(raw.data, "workflow activation output data");
		assertInlineActivationData(result.data, policy);
	}
	if (raw.statePatch !== undefined) {
		result.statePatch = expectStatePatch(raw.statePatch);
		assertNoConflictingWrites(result.statePatch);
		for (const operation of result.statePatch) {
			assertWorkflowStateWriteAllowed(operation, policy);
		}
	}
	return result;
}

function assertWorkflowStateWriteAllowed(
	operation: WorkflowStatePatchOperation,
	policy: WorkflowStateAccessPolicy,
): void {
	assertPointerAllowed(operation.path, policy.allowedWritePaths, "write to");
	assertInlineValue(operation.path, operation.value, policy);
	assertWorkflowStateWriteMatchesSchema(operation.path, operation.value, policy.stateSchema);
}

function assertNoConflictingWrites(patch: WorkflowStatePatchOperation[]): void {
	const seen = new Set<string>();
	for (const operation of patch) {
		if (seen.has(operation.path)) {
			throw new WorkflowStateError(`workflow state patch writes "${operation.path}" more than once`);
		}
		seen.add(operation.path);
	}
}

function getStatePath(state: Record<string, unknown>, pointer: string): unknown {
	let current: unknown = state;
	for (const segment of parseJsonPointer(pointer)) {
		if (!isRecord(current)) return undefined;
		current = current[segment];
	}
	return current;
}

function setStatePath(state: Record<string, unknown>, pointer: string, value: unknown): void {
	const segments = parseJsonPointer(pointer);
	if (segments.length === 0) {
		throw new WorkflowStateError("workflow state patch cannot replace the state root");
	}
	let current = state;
	for (const segment of segments.slice(0, -1)) {
		const existing = current[segment];
		if (isRecord(existing)) {
			current = existing;
			continue;
		}
		const next: Record<string, unknown> = {};
		current[segment] = next;
		current = next;
	}
	const leaf = segments.at(-1);
	if (leaf === undefined) {
		throw new WorkflowStateError("workflow state patch cannot replace the state root");
	}
	current[leaf] = value;
}

function parseJsonPointer(pointer: string): string[] {
	if (!pointer.startsWith("/")) {
		throw new WorkflowStateError(`workflow state path must be a JSON pointer: ${pointer}`);
	}
	return pointer.slice(1).split("/").map(unescapeJsonPointerSegment);
}

function assertPointerAllowed(pointer: string, allowedScopes: string[] | undefined, action: string): void {
	parseJsonPointer(pointer);
	if (allowedScopes === undefined) return;
	if (allowedScopes.some(scope => pointerWithinScope(pointer, scope))) return;
	throw new WorkflowStateError(`workflow state ${action} "${pointer}" is not allowed`);
}

function pointerWithinScope(pointer: string, scope: string): boolean {
	parseJsonPointer(scope);
	if (scope === "/") return pointer.startsWith("/");
	return pointer === scope || pointer.startsWith(`${scope}/`);
}

function assertInlineValue(pointer: string, value: unknown, policy: WorkflowStateAccessPolicy): void {
	const serialized = JSON.stringify(value);
	if (serialized === undefined) return;
	if (new TextEncoder().encode(serialized).byteLength <= maxInlineValueBytes(policy)) return;
	throw new WorkflowStateError(`workflow state value at "${pointer}" exceeds the inline size limit`);
}

function assertInlineActivationData(data: Record<string, unknown>, policy: WorkflowStateAccessPolicy): void {
	const serialized = JSON.stringify(data);
	if (serialized === undefined) return;
	if (new TextEncoder().encode(serialized).byteLength <= maxInlineValueBytes(policy)) return;
	throw new WorkflowStateError('workflow activation output data at "/data" exceeds the inline size limit');
}

function assertInlineText(label: string, value: string, maxBytes: number): void {
	if (new TextEncoder().encode(value).byteLength <= maxBytes) return;
	throw new WorkflowStateError(`${label} exceeds the inline size limit`);
}

function maxInlineValueBytes(policy: WorkflowStateAccessPolicy): number {
	return policy.maxInlineValueBytes ?? DEFAULT_WORKFLOW_MAX_INLINE_VALUE_BYTES;
}

function maxSummaryBytes(policy: WorkflowStateAccessPolicy): number {
	return policy.maxSummaryBytes ?? DEFAULT_WORKFLOW_MAX_SUMMARY_BYTES;
}

function assertArtifactReference(reference: string): void {
	if (
		reference.startsWith("artifact://") ||
		reference.startsWith("agent-output://") ||
		reference.startsWith("local://")
	) {
		return;
	}
	throw new WorkflowStateError(`workflow artifact reference must use a supported scheme: ${reference}`);
}

function assertNoRawTranscriptFields(raw: Record<string, unknown>): void {
	for (const field of ["transcript", "rawTranscript", "rawOutput"]) {
		if (raw[field] !== undefined) {
			throw new WorkflowStateError("workflow activation output must store transcripts as artifact references");
		}
	}
}

function expectStatePatch(value: unknown): WorkflowStatePatchOperation[] {
	if (!Array.isArray(value)) {
		throw new WorkflowStateError("workflow activation output statePatch must be an array");
	}
	return value.map((entry, index) => {
		const operation = expectRecord(entry, `workflow activation output statePatch.${index}`);
		if (operation.op !== "set") {
			throw new WorkflowStateError(`workflow activation output statePatch.${index}.op must be set`);
		}
		return {
			op: "set",
			path: expectString(operation.path, `workflow activation output statePatch.${index}.path`),
			value: operation.value,
		};
	});
}

function expectStringList(value: unknown, label: string): string[] {
	if (!Array.isArray(value)) {
		throw new WorkflowStateError(`${label} must be an array`);
	}
	return value.map((entry, index) => expectString(entry, `${label}.${index}`));
}

function expectString(value: unknown, label: string): string {
	if (typeof value === "string") return value;
	throw new WorkflowStateError(`${label} must be a string`);
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
	if (isRecord(value)) return value;
	throw new WorkflowStateError(`${label} must be an object`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
