export type WorkflowStateSchemaValueType = "string" | "number" | "boolean" | "object" | "array" | "null";

export interface WorkflowStateSchema {
	version: 1;
	shape: Record<string, WorkflowStateSchemaValueType>;
}

export class WorkflowStateSchemaError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WorkflowStateSchemaError";
	}
}

export function parseWorkflowStateSchema(value: unknown, label: string): WorkflowStateSchema {
	const raw = expectRecord(value, label);
	if (raw.version !== 1) {
		throw new WorkflowStateSchemaError(`${label}.version must be 1`);
	}
	const shape = expectRecord(raw.shape, `${label}.shape`);
	const parsedShape: Record<string, WorkflowStateSchemaValueType> = {};
	const normalizedPaths = new Set<string>();
	for (const [field, entry] of Object.entries(shape)) {
		if (field.length === 0) {
			throw new WorkflowStateSchemaError(`${label}.shape cannot declare an empty field name`);
		}
		const pointer = stateSchemaShapeKeyToPointer(field);
		if (pointer === "/") {
			throw new WorkflowStateSchemaError(`${label}.shape must not declare the state root`);
		}
		if (normalizedPaths.has(pointer)) {
			throw new WorkflowStateSchemaError(`${label}.shape declares duplicate state path "${pointer}"`);
		}
		normalizedPaths.add(pointer);
		parsedShape[field] = expectStateSchemaValueType(entry, `${label}.shape.${field}`);
	}
	return { version: 1, shape: parsedShape };
}

export function assertWorkflowStateWriteMatchesSchema(
	pointer: string,
	value: unknown,
	schema: WorkflowStateSchema | undefined,
): void {
	if (schema === undefined) return;
	const exact = workflowStateSchemaValueTypeForPath(pointer, schema);
	if (exact !== undefined) {
		const actual = workflowStateValueType(value);
		if (actual === exact) {
			assertNestedStateSchemaValues(pointer, value, schema);
			return;
		}
		throw new WorkflowStateSchemaError(
			`workflow state schema rejects write to "${pointer}": expected ${exact}, received ${actual}`,
		);
	}
	const nearest = nearestWorkflowStateSchemaAncestor(pointer, schema);
	if (nearest === undefined) {
		const field = parseJsonPointer(pointer)[0];
		throw new WorkflowStateSchemaError(
			`workflow state schema rejects write to "${pointer}": top-level field "${field}" is not declared`,
		);
	}
	if (nearest.type !== "object") {
		throw new WorkflowStateSchemaError(
			`workflow state schema rejects write to "${pointer}": "${nearest.path}" is ${nearest.type} and cannot contain children`,
		);
	}
	assertNestedStateSchemaValues(pointer, value, schema);
}

export function workflowStateSchemaDeclaresConditionPath(
	pointer: string,
	schema: WorkflowStateSchema | undefined,
): boolean {
	if (schema === undefined) return true;
	const segments = parseJsonPointer(pointer);
	if (segments.length === 0) return true;
	if (segments.length === 1) return workflowStateSchemaValueTypeForPath(pointer, schema) !== undefined;
	return workflowStateSchemaValueTypeForPath(pointer, schema) !== undefined;
}

function workflowStateSchemaValueTypeForPath(
	pointer: string,
	schema: WorkflowStateSchema,
): WorkflowStateSchemaValueType | undefined {
	for (const [field, type] of Object.entries(schema.shape)) {
		if (stateSchemaShapeKeyToPointer(field) === pointer) return type;
	}
	return undefined;
}

function nearestWorkflowStateSchemaAncestor(
	pointer: string,
	schema: WorkflowStateSchema,
): { path: string; type: WorkflowStateSchemaValueType } | undefined {
	const segments = parseJsonPointer(pointer);
	for (let length = segments.length - 1; length > 0; length -= 1) {
		const candidate = jsonPointerFromSegments(segments.slice(0, length));
		const type = workflowStateSchemaValueTypeForPath(candidate, schema);
		if (type !== undefined) return { path: candidate, type };
	}
	return undefined;
}

function assertNestedStateSchemaValues(pointer: string, value: unknown, schema: WorkflowStateSchema): void {
	const baseSegments = parseJsonPointer(pointer);
	for (const [field, type] of Object.entries(schema.shape)) {
		const declaredPointer = stateSchemaShapeKeyToPointer(field);
		const declaredSegments = parseJsonPointer(declaredPointer);
		if (declaredSegments.length <= baseSegments.length) continue;
		if (!segmentsStartWith(declaredSegments, baseSegments)) continue;
		const nested = nestedValueAt(value, declaredSegments.slice(baseSegments.length));
		if (!nested.exists) continue;
		const actual = workflowStateValueType(nested.value);
		if (actual === type) continue;
		throw new WorkflowStateSchemaError(
			`workflow state schema rejects write to "${declaredPointer}": expected ${type}, received ${actual}`,
		);
	}
}

function nestedValueAt(value: unknown, segments: string[]): { exists: boolean; value?: unknown } {
	let current = value;
	for (const segment of segments) {
		if (!isRecord(current) || !(segment in current)) return { exists: false };
		current = current[segment];
	}
	return { exists: true, value: current };
}

function segmentsStartWith(segments: string[], prefix: string[]): boolean {
	if (prefix.length > segments.length) return false;
	return prefix.every((segment, index) => segments[index] === segment);
}

function stateSchemaShapeKeyToPointer(field: string): string {
	if (field.startsWith("/")) {
		parseJsonPointer(field);
		return field;
	}
	return `/${escapeJsonPointerSegment(field)}`;
}

function parseJsonPointer(pointer: string): string[] {
	if (!pointer.startsWith("/")) {
		throw new WorkflowStateSchemaError(`workflow state path must be a JSON pointer: ${pointer}`);
	}
	return pointer.slice(1).split("/").map(unescapeJsonPointerSegment);
}

export function unescapeJsonPointerSegment(segment: string): string {
	return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}

export function escapeJsonPointerSegment(segment: string): string {
	return segment.replaceAll("~", "~0").replaceAll("/", "~1");
}

function jsonPointerFromSegments(segments: string[]): string {
	return `/${segments.map(escapeJsonPointerSegment).join("/")}`;
}

function workflowStateValueType(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	return typeof value;
}

function expectStateSchemaValueType(value: unknown, label: string): WorkflowStateSchemaValueType {
	if (
		value === "string" ||
		value === "number" ||
		value === "boolean" ||
		value === "object" ||
		value === "array" ||
		value === "null"
	) {
		return value;
	}
	throw new WorkflowStateSchemaError(`${label} must be string, number, boolean, object, array, or null`);
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
	if (isRecord(value)) return value;
	throw new WorkflowStateSchemaError(`${label} must be an object`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
