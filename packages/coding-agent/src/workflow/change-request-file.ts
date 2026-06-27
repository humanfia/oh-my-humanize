import type {
	WorkflowEdge,
	WorkflowModelContext,
	WorkflowModelUnavailablePolicy,
	WorkflowNode,
	WorkflowNodeType,
	WorkflowPromptActivationSelector,
	WorkflowPromptSource,
	WorkflowScriptLanguage,
	WorkflowScriptSource,
	WorkflowTemplatePromptBindingSource,
	WorkflowTemplatePromptSource,
	WorkflowWorkspaceAccess,
} from "./definition";
import { WORKFLOW_SCRIPT_TIMEOUT_MAX_MS } from "./definition";
import type { WorkflowChangeRequestOrigin } from "./lifecycle";
import type { WorkflowGraphPatchOperation } from "./patches";

export interface WorkflowChangeRequestFile {
	id?: string;
	familyId?: string;
	attemptId?: string;
	checkpointId?: string;
	actor?: string;
	origin?: WorkflowChangeRequestOrigin;
	reason?: string;
	operations?: WorkflowGraphPatchOperation[];
	frontierMapping?: Record<string, string>;
}

export function parseWorkflowChangeRequestFile(value: unknown, filePath: string): WorkflowChangeRequestFile {
	if (!isRecord(value)) throw new Error(`${filePath}: workflow change request must be a JSON object`);
	const file: WorkflowChangeRequestFile = {};
	if (value.id !== undefined) file.id = expectWorkflowPatchString(value.id, `${filePath}: id`);
	if (value.familyId !== undefined) file.familyId = expectWorkflowPatchString(value.familyId, `${filePath}: familyId`);
	if (value.attemptId !== undefined) {
		file.attemptId = expectWorkflowPatchString(value.attemptId, `${filePath}: attemptId`);
	}
	if (value.checkpointId !== undefined) {
		file.checkpointId = expectWorkflowPatchString(value.checkpointId, `${filePath}: checkpointId`);
	}
	if (value.actor !== undefined) file.actor = expectWorkflowPatchString(value.actor, `${filePath}: actor`);
	if (value.origin !== undefined) {
		if (!isWorkflowChangeRequestOrigin(value.origin)) {
			throw new Error(`${filePath}: origin must be a supported workflow change request origin`);
		}
		file.origin = value.origin;
	}
	if (value.reason !== undefined) file.reason = expectWorkflowPatchString(value.reason, `${filePath}: reason`);
	if (value.operations !== undefined) {
		if (!Array.isArray(value.operations)) throw new Error(`${filePath}: operations must be an array`);
		file.operations = value.operations.map((operation, index) =>
			parseWorkflowGraphPatchOperation(operation, `${filePath}: operations.${index}`),
		);
	}
	if (value.frontierMapping !== undefined) {
		file.frontierMapping = parseWorkflowPatchStringRecord(value.frontierMapping, `${filePath}: frontierMapping`);
	}
	return file;
}

function parseWorkflowGraphPatchOperation(value: unknown, pathLabel: string): WorkflowGraphPatchOperation {
	const raw = expectWorkflowPatchRecord(value, pathLabel);
	const op = expectWorkflowPatchString(raw.op, `${pathLabel}.op`);
	if (op === "add_node") {
		return {
			op,
			node: parseWorkflowPatchNode(
				raw.node,
				`${pathLabel}.node`,
				"workflow change operation add_node requires node",
			),
		};
	}
	if (op === "remove_node") {
		return { op, nodeId: expectWorkflowPatchString(raw.nodeId, `${pathLabel}.nodeId`) };
	}
	if (op === "add_edge") {
		return {
			op,
			edge: parseWorkflowPatchEdge(
				raw.edge,
				`${pathLabel}.edge`,
				"workflow change operation add_edge requires edge",
			),
		};
	}
	if (op === "remove_edge") {
		return {
			op,
			from: expectWorkflowPatchString(raw.from, `${pathLabel}.from`),
			to: expectWorkflowPatchString(raw.to, `${pathLabel}.to`),
		};
	}
	if (op === "replace_edge_condition") {
		const operation: WorkflowGraphPatchOperation = {
			op,
			from: expectWorkflowPatchString(raw.from, `${pathLabel}.from`),
			to: expectWorkflowPatchString(raw.to, `${pathLabel}.to`),
		};
		if (raw.condition !== undefined) {
			operation.condition = expectWorkflowPatchString(raw.condition, `${pathLabel}.condition`);
		}
		return operation;
	}
	if (op === "replace_node_prompt_source") {
		return {
			op,
			nodeId: expectWorkflowPatchString(raw.nodeId, `${pathLabel}.nodeId`),
			promptSource: parseWorkflowPatchPromptSource(raw.promptSource, `${pathLabel}.promptSource`),
		};
	}
	if (op === "replace_node_model") {
		return {
			op,
			nodeId: expectWorkflowPatchString(raw.nodeId, `${pathLabel}.nodeId`),
			model: parseRequiredWorkflowPatchModelContext(raw.model, `${pathLabel}.model`),
		};
	}
	if (op === "replace_node_permissions") {
		const operation: WorkflowGraphPatchOperation = {
			op,
			nodeId: expectWorkflowPatchString(raw.nodeId, `${pathLabel}.nodeId`),
		};
		if (raw.reads !== undefined) operation.reads = parseWorkflowPatchStringArray(raw.reads, `${pathLabel}.reads`);
		if (raw.writes !== undefined) {
			operation.writes = parseWorkflowPatchStringArray(raw.writes, `${pathLabel}.writes`);
		}
		if (raw.workspaceAccess !== undefined) {
			operation.workspaceAccess = parseWorkflowPatchWorkspaceAccess(
				raw.workspaceAccess,
				`${pathLabel}.workspaceAccess`,
			);
		}
		return operation;
	}
	if (op === "set_model_role") {
		return {
			op,
			role: expectWorkflowPatchString(raw.role, `${pathLabel}.role`),
			selector: expectWorkflowPatchString(raw.selector, `${pathLabel}.selector`),
		};
	}
	if (op === "abandon_branch") {
		const operation: WorkflowGraphPatchOperation = {
			op,
			nodeId: expectWorkflowPatchString(raw.nodeId, `${pathLabel}.nodeId`),
		};
		if (raw.reason !== undefined) operation.reason = expectWorkflowPatchString(raw.reason, `${pathLabel}.reason`);
		return operation;
	}
	if (op === "rollback_branch") {
		const operation: WorkflowGraphPatchOperation = {
			op,
			nodeId: expectWorkflowPatchString(raw.nodeId, `${pathLabel}.nodeId`),
			targetNodeId: expectWorkflowPatchString(raw.targetNodeId, `${pathLabel}.targetNodeId`),
		};
		if (raw.reason !== undefined) operation.reason = expectWorkflowPatchString(raw.reason, `${pathLabel}.reason`);
		return operation;
	}
	throw new Error(`${pathLabel}: unsupported workflow change operation "${op}"`);
}

function parseWorkflowPatchNode(value: unknown, pathLabel: string, missingMessage?: string): WorkflowNode {
	const raw = expectWorkflowPatchRecord(value, pathLabel, missingMessage);
	const node: WorkflowNode = {
		id: expectWorkflowPatchString(raw.id, `${pathLabel}.id`),
		type: parseWorkflowPatchNodeType(raw.type, `${pathLabel}.type`),
	};
	if (raw.agent !== undefined) node.agent = expectWorkflowPatchString(raw.agent, `${pathLabel}.agent`);
	const model = parseWorkflowPatchModelContext(raw.model, `${pathLabel}.model`);
	if (model !== undefined) node.model = model;
	if (raw.prompt !== undefined && raw.promptSource !== undefined) {
		throw new Error(`${pathLabel} must not define both prompt and promptSource`);
	}
	const prompt = parseWorkflowPatchPrompt(raw.prompt, `${pathLabel}.prompt`);
	if (prompt.prompt !== undefined) node.prompt = prompt.prompt;
	if (prompt.promptSource !== undefined) node.promptSource = prompt.promptSource;
	if (raw.promptSource !== undefined) {
		const promptSource = parseWorkflowPatchPromptSource(raw.promptSource, `${pathLabel}.promptSource`);
		node.promptSource = promptSource;
		const promptText = promptTextForWorkflowPatchSource(promptSource);
		if (promptText === undefined) {
			delete node.prompt;
		} else {
			node.prompt = promptText;
		}
	}
	const script = parseWorkflowPatchScriptSource(raw.script, `${pathLabel}.script`);
	if (script !== undefined) node.script = script;
	if (raw.gates !== undefined) node.gates = parseWorkflowPatchStringArray(raw.gates, `${pathLabel}.gates`);
	if (raw.isolation !== undefined) {
		node.isolation = parseWorkflowPatchNodeIsolation(raw.isolation, `${pathLabel}.isolation`);
	}
	if (raw.reads !== undefined) node.reads = parseWorkflowPatchStringArray(raw.reads, `${pathLabel}.reads`);
	if (raw.writes !== undefined) node.writes = parseWorkflowPatchStringArray(raw.writes, `${pathLabel}.writes`);
	if (raw.workspaceAccess !== undefined) {
		node.workspaceAccess = parseWorkflowPatchWorkspaceAccess(raw.workspaceAccess, `${pathLabel}.workspaceAccess`);
	}
	if (raw.waitFor !== undefined) node.waitFor = parseWorkflowPatchStringArray(raw.waitFor, `${pathLabel}.waitFor`);
	return node;
}

function parseWorkflowPatchWorkspaceAccess(value: unknown, pathLabel: string): WorkflowWorkspaceAccess {
	if (value === "read" || value === "write") return value;
	throw new Error(`${pathLabel} must be "read" or "write"`);
}

function parseWorkflowPatchNodeIsolation(value: unknown, pathLabel: string): WorkflowNode["isolation"] {
	const raw = expectWorkflowPatchRecord(value, pathLabel);
	const isolation: NonNullable<WorkflowNode["isolation"]> = {
		enabled: expectWorkflowPatchBoolean(raw.enabled, `${pathLabel}.enabled`),
	};
	if (raw.apply !== undefined) isolation.apply = expectWorkflowPatchBoolean(raw.apply, `${pathLabel}.apply`);
	if (raw.merge !== undefined) isolation.merge = expectWorkflowPatchBoolean(raw.merge, `${pathLabel}.merge`);
	return isolation;
}

function expectWorkflowPatchBoolean(value: unknown, pathLabel: string): boolean {
	if (typeof value === "boolean") return value;
	throw new Error(`${pathLabel} must be a boolean`);
}

function parseWorkflowPatchEdge(value: unknown, pathLabel: string, missingMessage?: string): WorkflowEdge {
	const raw = expectWorkflowPatchRecord(value, pathLabel, missingMessage);
	const edge: WorkflowEdge = {
		from: expectWorkflowPatchString(raw.from, `${pathLabel}.from`),
		to: expectWorkflowPatchString(raw.to, `${pathLabel}.to`),
	};
	if (raw.condition !== undefined && raw.when !== undefined) {
		throw new Error(`${pathLabel} must not define both condition and when`);
	}
	const condition = parseWorkflowPatchEdgeCondition(
		raw.condition !== undefined ? raw.condition : raw.when,
		`${pathLabel}.condition`,
	);
	if (condition !== undefined) edge.condition = condition;
	if (raw.label !== undefined) {
		edge.label = expectWorkflowPatchString(raw.label, `${pathLabel}.label`);
	}
	return edge;
}

function parseWorkflowPatchEdgeCondition(value: unknown, pathLabel: string): WorkflowEdge["condition"] | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "string") return { source: expectWorkflowPatchString(value, pathLabel) };
	const raw = expectWorkflowPatchRecord(value, pathLabel);
	return { source: expectWorkflowPatchString(raw.source, `${pathLabel}.source`) };
}

function parseWorkflowPatchNodeType(value: unknown, pathLabel: string): WorkflowNodeType {
	if (value === "agent" || value === "script" || value === "human" || value === "review") return value;
	throw new Error(`${pathLabel} must be agent, script, human, or review`);
}

function parseWorkflowPatchPrompt(
	value: unknown,
	pathLabel: string,
): { prompt?: string; promptSource?: WorkflowPromptSource } {
	if (value === undefined) return {};
	if (typeof value === "string") {
		const prompt = expectWorkflowPatchString(value, pathLabel);
		return {
			prompt,
			promptSource: prompt.startsWith("./") ? { kind: "file", path: prompt } : { kind: "inline", text: prompt },
		};
	}
	const raw = expectWorkflowPatchRecord(value, pathLabel);
	const sourceKeys = ["inline", "file", "state", "output", "human", "template"].filter(key => raw[key] !== undefined);
	if (sourceKeys.length !== 1) {
		throw new Error(`${pathLabel} must define exactly one of inline, file, state, output, human, or template`);
	}
	const sourceKey = sourceKeys[0];
	if (sourceKey === "inline") {
		const text = expectWorkflowPatchString(raw.inline, `${pathLabel}.inline`);
		return { prompt: text, promptSource: { kind: "inline", text } };
	}
	if (sourceKey === "file") {
		const filePath = expectWorkflowPatchString(raw.file, `${pathLabel}.file`);
		return { prompt: filePath, promptSource: { kind: "file", path: filePath } };
	}
	if (sourceKey === "state") {
		return { promptSource: { kind: "state", path: expectWorkflowPatchJsonPointer(raw.state, `${pathLabel}.state`) } };
	}
	if (sourceKey === "human") {
		return { promptSource: { kind: "human", path: expectWorkflowPatchJsonPointer(raw.human, `${pathLabel}.human`) } };
	}
	if (sourceKey === "template") {
		return { promptSource: parseWorkflowPatchTemplatePrompt(raw.template, `${pathLabel}.template`) };
	}
	const output = expectWorkflowPatchRecord(raw.output, `${pathLabel}.output`);
	return {
		promptSource: {
			kind: "output",
			node: expectWorkflowPatchString(output.node, `${pathLabel}.output.node`),
			path: expectWorkflowPatchJsonPointer(output.path, `${pathLabel}.output.path`),
			activation: parseWorkflowPatchPromptActivationSelector(output.activation, `${pathLabel}.output.activation`),
		},
	};
}

function parseWorkflowPatchPromptSource(value: unknown, pathLabel: string): WorkflowPromptSource {
	const raw = expectWorkflowPatchRecord(value, pathLabel);
	const kind = expectWorkflowPatchString(raw.kind, `${pathLabel}.kind`);
	if (kind === "inline") {
		return { kind, text: expectWorkflowPatchString(raw.text, `${pathLabel}.text`) };
	}
	if (kind === "file") {
		return { kind, path: expectWorkflowPatchString(raw.path, `${pathLabel}.path`) };
	}
	if (kind === "state") {
		return { kind, path: expectWorkflowPatchJsonPointer(raw.path, `${pathLabel}.path`) };
	}
	if (kind === "human") {
		return { kind, path: expectWorkflowPatchJsonPointer(raw.path, `${pathLabel}.path`) };
	}
	if (kind === "output") {
		return {
			kind,
			node: expectWorkflowPatchString(raw.node, `${pathLabel}.node`),
			path: expectWorkflowPatchJsonPointer(raw.path, `${pathLabel}.path`),
			activation: parseWorkflowPatchPromptActivationSelector(raw.activation, `${pathLabel}.activation`),
		};
	}
	if (kind === "template") {
		return parseWorkflowPatchTemplatePrompt(raw, pathLabel);
	}
	throw new Error(`${pathLabel}.kind must be inline, file, state, output, human, or template`);
}

function parseWorkflowPatchTemplatePrompt(value: unknown, pathLabel: string): WorkflowTemplatePromptSource {
	const raw = expectWorkflowPatchRecord(value, pathLabel);
	return {
		kind: "template",
		file: expectWorkflowPatchString(raw.file, `${pathLabel}.file`),
		bindings: parseWorkflowPatchTemplateBindings(raw.bindings, `${pathLabel}.bindings`),
	};
}

function parseWorkflowPatchTemplateBindings(
	value: unknown,
	pathLabel: string,
): Record<string, WorkflowTemplatePromptBindingSource> {
	const raw = expectWorkflowPatchRecord(value, pathLabel);
	const bindings: Record<string, WorkflowTemplatePromptBindingSource> = {};
	for (const [name, binding] of Object.entries(raw)) {
		bindings[name] = parseWorkflowPatchTemplateBinding(binding, `${pathLabel}.${name}`);
	}
	return bindings;
}

function parseWorkflowPatchTemplateBinding(value: unknown, pathLabel: string): WorkflowTemplatePromptBindingSource {
	const raw = expectWorkflowPatchRecord(value, pathLabel);
	if (raw.kind !== undefined) {
		const kind = expectWorkflowPatchString(raw.kind, `${pathLabel}.kind`);
		if (kind === "inline") return { kind, text: expectWorkflowPatchString(raw.text, `${pathLabel}.text`) };
		if (kind === "state") return { kind, path: expectWorkflowPatchJsonPointer(raw.path, `${pathLabel}.path`) };
		if (kind === "human") return { kind, path: expectWorkflowPatchJsonPointer(raw.path, `${pathLabel}.path`) };
		if (kind === "output") {
			return {
				kind,
				node: expectWorkflowPatchString(raw.node, `${pathLabel}.node`),
				path: expectWorkflowPatchJsonPointer(raw.path, `${pathLabel}.path`),
				activation: parseWorkflowPatchPromptActivationSelector(raw.activation, `${pathLabel}.activation`),
			};
		}
		throw new Error(`${pathLabel}.kind must be inline, state, output, or human`);
	}
	const sourceKeys = ["inline", "state", "output", "human"].filter(key => raw[key] !== undefined);
	if (sourceKeys.length !== 1) {
		throw new Error(`${pathLabel} must define exactly one of inline, state, output, or human`);
	}
	const sourceKey = sourceKeys[0];
	if (sourceKey === "inline") {
		return { kind: "inline", text: expectWorkflowPatchString(raw.inline, `${pathLabel}.inline`) };
	}
	if (sourceKey === "state") {
		return { kind: "state", path: expectWorkflowPatchJsonPointer(raw.state, `${pathLabel}.state`) };
	}
	if (sourceKey === "human") {
		return { kind: "human", path: expectWorkflowPatchJsonPointer(raw.human, `${pathLabel}.human`) };
	}
	const output = expectWorkflowPatchRecord(raw.output, `${pathLabel}.output`);
	return {
		kind: "output",
		node: expectWorkflowPatchString(output.node, `${pathLabel}.output.node`),
		path: expectWorkflowPatchJsonPointer(output.path, `${pathLabel}.output.path`),
		activation: parseWorkflowPatchPromptActivationSelector(output.activation, `${pathLabel}.output.activation`),
	};
}

function parseWorkflowPatchPromptActivationSelector(
	value: unknown,
	pathLabel: string,
): WorkflowPromptActivationSelector {
	if (value === "parent" || value === "latest-completed") return value;
	throw new Error(`${pathLabel} must be parent or latest-completed`);
}

function parseWorkflowPatchScriptSource(value: unknown, pathLabel: string): WorkflowScriptSource | undefined {
	if (value === undefined) return undefined;
	const raw = expectWorkflowPatchRecord(value, pathLabel);
	const script: WorkflowScriptSource = {};
	const language = parseWorkflowPatchScriptLanguage(raw.language, `${pathLabel}.language`);
	if (language !== undefined) script.language = language;
	if (raw.inline !== undefined && raw.code !== undefined) {
		throw new Error(`${pathLabel} must not define both inline and code`);
	}
	const inlineOrCode = raw.code !== undefined ? raw.code : raw.inline;
	const sourceCount = [inlineOrCode !== undefined, raw.file !== undefined].filter(Boolean).length;
	if (sourceCount !== 1) {
		throw new Error(`${pathLabel} must define exactly one of inline, code, or file`);
	}
	if (inlineOrCode !== undefined) script.code = expectWorkflowPatchString(inlineOrCode, `${pathLabel}.code`);
	if (raw.file !== undefined) script.file = expectWorkflowPatchString(raw.file, `${pathLabel}.file`);
	const timeoutMs = parseWorkflowPatchScriptTimeoutMs(raw.timeoutMs, `${pathLabel}.timeoutMs`);
	if (timeoutMs !== undefined) script.timeoutMs = timeoutMs;
	return script;
}

function parseWorkflowPatchScriptLanguage(value: unknown, pathLabel: string): WorkflowScriptLanguage | undefined {
	if (value === undefined) return undefined;
	if (value === "js" || value === "py" || value === "sh") return value;
	throw new Error(`${pathLabel} must be js, py, or sh`);
}

function parseWorkflowPatchScriptTimeoutMs(value: unknown, pathLabel: string): number | undefined {
	if (value === undefined) return undefined;
	if (
		typeof value === "number" &&
		Number.isSafeInteger(value) &&
		value > 0 &&
		value <= WORKFLOW_SCRIPT_TIMEOUT_MAX_MS
	) {
		return value;
	}
	throw new Error(`${pathLabel} must be a positive integer no greater than ${WORKFLOW_SCRIPT_TIMEOUT_MAX_MS}`);
}

function parseRequiredWorkflowPatchModelContext(value: unknown, pathLabel: string): WorkflowModelContext {
	const model = parseWorkflowPatchModelContext(value, pathLabel);
	if (model !== undefined) return model;
	throw new Error(`${pathLabel} must define a workflow model context`);
}

function parseWorkflowPatchModelContext(value: unknown, pathLabel: string): WorkflowModelContext | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "string") return { selector: expectWorkflowPatchString(value, pathLabel) };
	const raw = expectWorkflowPatchRecord(value, pathLabel);
	const role = parseOptionalWorkflowPatchString(raw.role, `${pathLabel}.role`);
	const selector = parseOptionalWorkflowPatchString(raw.selector, `${pathLabel}.selector`);
	const candidates = parseOptionalWorkflowPatchStringArray(raw.candidates, `${pathLabel}.candidates`);
	const unavailable = parseWorkflowPatchModelUnavailable(raw.unavailable, `${pathLabel}.unavailable`);
	if (candidates !== undefined && candidates.length === 0) {
		throw new Error(`${pathLabel}.candidates must not be empty`);
	}
	const sourceCount = [role, selector, candidates].filter(entry => entry !== undefined).length;
	if (sourceCount !== 1) {
		throw new Error(`${pathLabel} must define exactly one of role, selector, or candidates`);
	}
	const model: WorkflowModelContext = {};
	if (role !== undefined) model.role = role;
	if (selector !== undefined) model.selector = selector;
	if (candidates !== undefined) model.candidates = candidates;
	if (unavailable !== undefined) model.unavailable = unavailable;
	return model;
}

function parseWorkflowPatchModelUnavailable(
	value: unknown,
	pathLabel: string,
): WorkflowModelUnavailablePolicy | undefined {
	if (value === undefined) return undefined;
	if (value === "fallback-to-parent" || value === "fail") return value;
	throw new Error(`${pathLabel} must be "fallback-to-parent" or "fail"`);
}

function parseOptionalWorkflowPatchString(value: unknown, pathLabel: string): string | undefined {
	if (value === undefined) return undefined;
	return expectWorkflowPatchString(value, pathLabel);
}

function parseOptionalWorkflowPatchStringArray(value: unknown, pathLabel: string): string[] | undefined {
	if (value === undefined) return undefined;
	return parseWorkflowPatchStringArray(value, pathLabel);
}

function parseWorkflowPatchStringArray(value: unknown, pathLabel: string): string[] {
	if (!Array.isArray(value)) throw new Error(`${pathLabel} must be an array of strings`);
	return value.map((entry, index) => expectWorkflowPatchString(entry, `${pathLabel}.${index}`));
}

function parseWorkflowPatchStringRecord(value: unknown, pathLabel: string): Record<string, string> {
	const raw = expectWorkflowPatchRecord(value, pathLabel);
	const record: Record<string, string> = {};
	for (const [key, entry] of Object.entries(raw)) {
		record[key] = expectWorkflowPatchString(entry, `${pathLabel}.${key}`);
	}
	return record;
}

function expectWorkflowPatchJsonPointer(value: unknown, pathLabel: string): string {
	const pointer = expectWorkflowPatchString(value, pathLabel);
	if (pointer.startsWith("/")) return pointer;
	throw new Error(`${pathLabel} must be a JSON pointer`);
}

function expectWorkflowPatchString(value: unknown, pathLabel: string): string {
	if (typeof value === "string" && value.trim()) return value;
	throw new Error(`${pathLabel} must be a non-empty string`);
}

function expectWorkflowPatchRecord(
	value: unknown,
	pathLabel: string,
	missingMessage?: string,
): Record<string, unknown> {
	if (value === undefined && missingMessage !== undefined) throw new Error(missingMessage);
	if (isRecord(value)) return value;
	throw new Error(`${pathLabel} must be an object`);
}

function promptTextForWorkflowPatchSource(source: WorkflowPromptSource): string | undefined {
	if (source.kind === "inline") return source.text;
	if (source.kind === "file") return source.path;
	return undefined;
}

function isWorkflowChangeRequestOrigin(value: unknown): value is WorkflowChangeRequestOrigin {
	return (
		value === "internal-agent" ||
		value === "supervisor" ||
		value === "human" ||
		value === "slash-command" ||
		value === "test" ||
		value === "external-api"
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
