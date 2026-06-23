import {
	escapeJsonPointerSegment,
	type WorkflowStateSchema,
	workflowStateSchemaDeclaresConditionPath,
} from "./state-schema";

export type WorkflowConditionOperator = "==" | "!=" | ">=" | "<=" | ">" | "<";
export type WorkflowConditionLiteral = string | number | boolean | null;

export type WorkflowConditionAst =
	| WorkflowComparisonCondition
	| WorkflowLogicalCondition
	| WorkflowNotCondition
	| WorkflowExistsCondition;

export interface WorkflowComparisonCondition {
	kind: "comparison";
	leftPath: string[];
	operator: WorkflowConditionOperator;
	right: WorkflowConditionLiteral;
}

export interface WorkflowLogicalCondition {
	kind: "and" | "or";
	left: WorkflowConditionAst;
	right: WorkflowConditionAst;
}

export interface WorkflowNotCondition {
	kind: "not";
	expression: WorkflowConditionAst;
}

export interface WorkflowExistsCondition {
	kind: "exists";
	path: string[];
}

export interface WorkflowConditionExpression {
	source: string;
	ast: WorkflowConditionAst;
}

export interface WorkflowConditionContext {
	state?: unknown;
	outputs?: Record<string, unknown>;
}

export interface WorkflowConditionReference {
	path: string[];
	kind: "comparison" | "exists";
	operator?: WorkflowConditionOperator;
	right?: WorkflowConditionLiteral;
}

export interface WorkflowConditionReferenceNode {
	id: string;
	type: string;
	gates?: readonly string[];
}

export class WorkflowConditionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WorkflowConditionError";
	}
}

export function parseWorkflowCondition(source: string): WorkflowConditionExpression {
	const trimmed = source.trim();
	const tokens = tokenize(trimmed);
	const parser = { tokens, index: 0 };
	const ast = parseOr(parser);
	expectToken(parser, "eof");
	return { source: trimmed, ast };
}

export function evaluateWorkflowCondition(
	condition: string | WorkflowConditionExpression,
	context: WorkflowConditionContext,
): boolean {
	const expression = typeof condition === "string" ? parseWorkflowCondition(condition) : condition;
	return evaluateAst(expression.ast, context);
}

export function collectWorkflowConditionReferences(
	condition: string | WorkflowConditionExpression,
): WorkflowConditionReference[] {
	const expression = typeof condition === "string" ? parseWorkflowCondition(condition) : condition;
	const references: WorkflowConditionReference[] = [];
	collectAstReferences(expression.ast, references);
	return references;
}

export function diagnoseWorkflowConditionReferences(
	condition: string | WorkflowConditionExpression,
	nodes: readonly WorkflowConditionReferenceNode[],
	stateSchema?: WorkflowStateSchema,
): string[] {
	const nodesById = new Map(nodes.map(node => [node.id, node]));
	const diagnostics: string[] = [];
	for (const reference of collectWorkflowConditionReferences(condition)) {
		const [root, outputNodeId, field] = reference.path;
		if (root !== "state" && root !== "outputs") {
			diagnostics.push("must reference state.* or outputs.*");
			continue;
		}
		if (root === "state") {
			const pointer = conditionStateReferenceToJsonPointer(reference.path);
			if (!workflowStateSchemaDeclaresConditionPath(pointer, stateSchema)) {
				diagnostics.push(`references undeclared state path "${pointer}"`);
			}
			continue;
		}
		if (outputNodeId === undefined) {
			diagnostics.push("must reference outputs.<nodeId>.*");
			continue;
		}
		const outputNode = nodesById.get(outputNodeId);
		if (!outputNode) {
			diagnostics.push(`references unknown output node "${outputNodeId}"`);
			continue;
		}
		if (
			outputNode.type === "review" &&
			field === "verdict" &&
			reference.kind === "comparison" &&
			typeof reference.right === "string" &&
			outputNode.gates !== undefined &&
			!outputNode.gates.includes(reference.right)
		) {
			diagnostics.push(`references undeclared verdict "${reference.right}" for review node "${outputNodeId}"`);
		}
	}
	return diagnostics;
}

function conditionStateReferenceToJsonPointer(path: string[]): string {
	const segments = path.slice(1);
	if (segments.length === 0) return "/";
	return `/${segments.map(escapeJsonPointerSegment).join("/")}`;
}

function collectAstReferences(ast: WorkflowConditionAst, references: WorkflowConditionReference[]): void {
	switch (ast.kind) {
		case "comparison":
			references.push({
				path: ast.leftPath,
				kind: "comparison",
				operator: ast.operator,
				right: ast.right,
			});
			break;
		case "exists":
			references.push({ path: ast.path, kind: "exists" });
			break;
		case "and":
		case "or":
			collectAstReferences(ast.left, references);
			collectAstReferences(ast.right, references);
			break;
		case "not":
			collectAstReferences(ast.expression, references);
			break;
	}
}

function evaluateAst(ast: WorkflowConditionAst, context: WorkflowConditionContext): boolean {
	switch (ast.kind) {
		case "comparison":
			return evaluateComparison(ast, context);
		case "and":
			return evaluateAst(ast.left, context) && evaluateAst(ast.right, context);
		case "or":
			return evaluateAst(ast.left, context) || evaluateAst(ast.right, context);
		case "not":
			return !evaluateAst(ast.expression, context);
		case "exists":
			return resolvePath(ast.path, context) !== undefined;
	}
}

function evaluateComparison(ast: WorkflowComparisonCondition, context: WorkflowConditionContext): boolean {
	const left = resolvePath(ast.leftPath, context);
	if (left === undefined) return false;
	switch (ast.operator) {
		case "==":
			return left === ast.right;
		case "!=":
			return left !== ast.right;
		case ">=":
			return compareNumbers(left, ast.right, (a, b) => a >= b);
		case "<=":
			return compareNumbers(left, ast.right, (a, b) => a <= b);
		case ">":
			return compareNumbers(left, ast.right, (a, b) => a > b);
		case "<":
			return compareNumbers(left, ast.right, (a, b) => a < b);
	}
}

type WorkflowConditionToken =
	| { kind: "path"; value: string }
	| { kind: "literal"; value: WorkflowConditionLiteral }
	| { kind: "operator"; value: WorkflowConditionOperator }
	| { kind: "and" }
	| { kind: "or" }
	| { kind: "not" }
	| { kind: "lparen" }
	| { kind: "rparen" }
	| { kind: "eof" };

interface ParserState {
	tokens: WorkflowConditionToken[];
	index: number;
}

function parseOr(parser: ParserState): WorkflowConditionAst {
	let left = parseAnd(parser);
	while (matchToken(parser, "or")) {
		left = { kind: "or", left, right: parseAnd(parser) };
	}
	return left;
}

function parseAnd(parser: ParserState): WorkflowConditionAst {
	let left = parseUnary(parser);
	while (matchToken(parser, "and")) {
		left = { kind: "and", left, right: parseUnary(parser) };
	}
	return left;
}

function parseUnary(parser: ParserState): WorkflowConditionAst {
	if (matchToken(parser, "not")) {
		return { kind: "not", expression: parseUnary(parser) };
	}
	return parsePrimary(parser);
}

function parsePrimary(parser: ParserState): WorkflowConditionAst {
	const token = peekToken(parser);
	if (token.kind === "path" && token.value === "exists") {
		return parseExists(parser);
	}
	if (token.kind === "path" && peekToken(parser, 1).kind === "lparen") {
		throw new WorkflowConditionError(
			`arbitrary function calls are not allowed in workflow conditions: "${token.value}"`,
		);
	}
	if (matchToken(parser, "lparen")) {
		const expression = parseOr(parser);
		expectToken(parser, "rparen");
		return expression;
	}
	return parseComparison(parser);
}

function parseExists(parser: ParserState): WorkflowExistsCondition {
	consumeToken(parser);
	expectToken(parser, "lparen");
	const pathToken = consumeToken(parser);
	if (pathToken.kind !== "path") {
		throw new WorkflowConditionError("exists expects a state or output path");
	}
	expectToken(parser, "rparen");
	return { kind: "exists", path: pathToken.value.split(".") };
}

function parseComparison(parser: ParserState): WorkflowComparisonCondition {
	const pathToken = consumeToken(parser);
	if (pathToken.kind !== "path") {
		throw new WorkflowConditionError("expected state or output path");
	}
	const operatorToken = consumeToken(parser);
	if (operatorToken.kind !== "operator") {
		throw new WorkflowConditionError(`expected comparison operator after "${pathToken.value}"`);
	}
	const literalToken = consumeToken(parser);
	if (literalToken.kind !== "literal") {
		throw new WorkflowConditionError("expected literal value");
	}
	return {
		kind: "comparison",
		leftPath: pathToken.value.split("."),
		operator: operatorToken.value,
		right: literalToken.value,
	};
}

function tokenize(source: string): WorkflowConditionToken[] {
	const tokens: WorkflowConditionToken[] = [];
	let index = 0;
	while (index < source.length) {
		const char = source[index];
		if (char === undefined) break;
		if (/\s/.test(char)) {
			index += 1;
			continue;
		}
		const two = source.slice(index, index + 2);
		if (two === "&&") {
			tokens.push({ kind: "and" });
			index += 2;
			continue;
		}
		if (two === "||") {
			tokens.push({ kind: "or" });
			index += 2;
			continue;
		}
		if (two === "==" || two === "!=" || two === ">=" || two === "<=") {
			tokens.push({ kind: "operator", value: two });
			index += 2;
			continue;
		}
		if (char === ">" || char === "<") {
			tokens.push({ kind: "operator", value: char });
			index += 1;
			continue;
		}
		if (char === "!") {
			tokens.push({ kind: "not" });
			index += 1;
			continue;
		}
		if (char === "(") {
			tokens.push({ kind: "lparen" });
			index += 1;
			continue;
		}
		if (char === ")") {
			tokens.push({ kind: "rparen" });
			index += 1;
			continue;
		}
		if (char === '"' || char === "'") {
			const parsed = readString(source, index, char);
			tokens.push({ kind: "literal", value: parsed.value });
			index = parsed.nextIndex;
			continue;
		}
		const numberMatch = /^-?\d+(?:\.\d+)?/.exec(source.slice(index));
		if (numberMatch) {
			const raw = numberMatch[0] ?? "";
			tokens.push({ kind: "literal", value: Number(raw) });
			index += raw.length;
			continue;
		}
		const pathMatch = /^[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*)*/.exec(source.slice(index));
		if (pathMatch) {
			const raw = pathMatch[0] ?? "";
			if (raw === "true") {
				tokens.push({ kind: "literal", value: true });
			} else if (raw === "false") {
				tokens.push({ kind: "literal", value: false });
			} else if (raw === "null") {
				tokens.push({ kind: "literal", value: null });
			} else {
				tokens.push({ kind: "path", value: raw });
			}
			index += raw.length;
			continue;
		}
		throw new WorkflowConditionError(`unexpected token "${char}"`);
	}
	tokens.push({ kind: "eof" });
	return tokens;
}

function readString(source: string, startIndex: number, quote: string): { value: string; nextIndex: number } {
	let index = startIndex + 1;
	let value = "";
	while (index < source.length) {
		const char = source[index];
		if (char === quote) {
			return { value, nextIndex: index + 1 };
		}
		if (char === undefined) break;
		value += char;
		index += 1;
	}
	throw new WorkflowConditionError("unterminated string literal");
}

function matchToken(parser: ParserState, kind: WorkflowConditionToken["kind"]): boolean {
	if (peekToken(parser).kind !== kind) return false;
	parser.index += 1;
	return true;
}

function expectToken(parser: ParserState, kind: WorkflowConditionToken["kind"]): WorkflowConditionToken {
	const token = consumeToken(parser);
	if (token.kind !== kind) {
		throw new WorkflowConditionError(`expected ${kind}`);
	}
	return token;
}

function consumeToken(parser: ParserState): WorkflowConditionToken {
	const token = parser.tokens[parser.index];
	if (!token) return { kind: "eof" };
	parser.index += 1;
	return token;
}

function peekToken(parser: ParserState, offset = 0): WorkflowConditionToken {
	return parser.tokens[parser.index + offset] ?? { kind: "eof" };
}

function resolvePath(path: string[], context: WorkflowConditionContext): unknown {
	const [root, ...segments] = path;
	let current: unknown;
	if (root === "state") {
		current = context.state;
	} else if (root === "outputs") {
		current = context.outputs;
	} else {
		return undefined;
	}
	for (const segment of segments) {
		if (!isRecord(current)) return undefined;
		current = current[segment];
	}
	return current;
}

function compareNumbers(
	left: unknown,
	right: WorkflowConditionLiteral,
	compare: (left: number, right: number) => boolean,
): boolean {
	if (typeof left !== "number" || typeof right !== "number") return false;
	return compare(left, right);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
