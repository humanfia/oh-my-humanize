import { YAML } from "bun";
import { diagnoseWorkflowConditionReferences, parseWorkflowCondition, WorkflowConditionError } from "./condition";
import { parseWorkflowStateSchema, type WorkflowStateSchema, WorkflowStateSchemaError } from "./state-schema";

export type WorkflowNodeType = "agent" | "script" | "human" | "review";
export type WorkflowWorkspaceAccess = "read" | "write";
export type WorkflowNodeCheckpoint = "after";
export type WorkflowModelUnavailablePolicy = "fallback-to-parent" | "fail";
export type WorkflowScriptLanguage = "js" | "py" | "sh";
export const WORKFLOW_SCRIPT_TIMEOUT_MAX_MS = 60 * 60 * 1000;
export const WORKFLOW_NODE_TIMEOUT_MAX_MS = 5 * 24 * 60 * 60 * 1000;

export interface WorkflowModelContext {
	role?: string;
	selector?: string;
	candidates?: string[];
	unavailable?: WorkflowModelUnavailablePolicy;
}

export interface WorkflowModels {
	roles: Record<string, string>;
	defaults: Record<string, string>;
	unavailable?: WorkflowModelUnavailablePolicy;
}

export interface WorkflowCondition {
	source: string;
}

export interface WorkflowEdge {
	from: string;
	to: string;
	condition?: WorkflowCondition;
	label?: string;
}

export type WorkflowResourceKind = "prompt" | "script" | "data";

export interface WorkflowResourceDeclaration {
	path: string;
	kind?: WorkflowResourceKind;
	required?: boolean;
}

export interface WorkflowCapabilityContract {
	tools?: string[];
	agents?: string[];
	plugins?: string[];
	extensions?: string[];
	skills?: string[];
}

export interface WorkflowMigrationRule {
	from: string;
	to: string;
	frontierMapping: Record<string, string>;
}

export interface WorkflowSubflowDeclaration {
	alias: string;
	name: string;
	version: number;
	namespace: string;
	nodeIds: string[];
	entryNodeIds: string[];
	exitNodeIds: string[];
	resourcePrefix?: string;
}

export type WorkflowPromptActivationSelector = "parent" | "latest-completed";

export type WorkflowPromptSource =
	| WorkflowInlinePromptSource
	| WorkflowFilePromptSource
	| WorkflowStatePromptSource
	| WorkflowOutputPromptSource
	| WorkflowHumanPromptSource
	| WorkflowTemplatePromptSource;

export type WorkflowTemplatePromptBindingSource =
	| WorkflowInlinePromptSource
	| WorkflowStatePromptSource
	| WorkflowOutputPromptSource
	| WorkflowHumanPromptSource;

export interface WorkflowInlinePromptSource {
	kind: "inline";
	text: string;
}

export interface WorkflowFilePromptSource {
	kind: "file";
	path: string;
}

export interface WorkflowStatePromptSource {
	kind: "state";
	path: string;
}

export interface WorkflowOutputPromptSource {
	kind: "output";
	node: string;
	path: string;
	activation: WorkflowPromptActivationSelector;
}

export interface WorkflowHumanPromptSource {
	kind: "human";
	path: string;
}

export interface WorkflowTemplatePromptSource {
	kind: "template";
	file: string;
	bindings: Record<string, WorkflowTemplatePromptBindingSource>;
}

export interface WorkflowScriptSource {
	language?: WorkflowScriptLanguage;
	code?: string;
	file?: string;
	timeoutMs?: number;
}

export interface WorkflowNodeIsolation {
	enabled: boolean;
	apply?: boolean;
	merge?: boolean;
	capture?: WorkflowIsolationCapture;
}

export interface WorkflowIsolationCapture {
	include?: string[];
	exclude?: string[];
}

export interface WorkflowNode {
	id: string;
	type: WorkflowNodeType;
	agent?: string;
	model?: WorkflowModelContext;
	prompt?: string;
	promptSource?: WorkflowPromptSource;
	script?: WorkflowScriptSource;
	gates?: string[];
	fallbackVerdict?: string;
	isolation?: WorkflowNodeIsolation;
	reads?: string[];
	writes?: string[];
	workspaceAccess?: WorkflowWorkspaceAccess;
	waitFor?: string[];
	checkpoint?: WorkflowNodeCheckpoint;
	timeoutMs?: number;
}

export interface WorkflowDefinition {
	name: string;
	version: number;
	sourcePath?: string;
	models: WorkflowModels;
	nodes: WorkflowNode[];
	edges: WorkflowEdge[];
	stateSchema?: WorkflowStateSchema;
	resources?: WorkflowResourceDeclaration[];
	capabilities?: WorkflowCapabilityContract;
	migrations?: WorkflowMigrationRule[];
	subflows?: WorkflowSubflowDeclaration[];
}

export interface ParseWorkflowDefinitionOptions {
	sourcePath?: string;
}

export class WorkflowDefinitionError extends Error {
	constructor(
		message: string,
		readonly sourcePath?: string,
	) {
		super(sourcePath ? `${sourcePath}: ${message}` : message);
		this.name = "WorkflowDefinitionError";
	}
}

export function parseWorkflowDefinition(
	source: string,
	options: ParseWorkflowDefinitionOptions = {},
): WorkflowDefinition {
	const raw = parseYaml(source, options.sourcePath);
	const root = expectRecord(raw, "workflow definition", options.sourcePath);
	const name = expectString(root.name, "name", options.sourcePath);
	const version = expectNumber(root.version, "version", options.sourcePath);
	const models = parseModels(root.models, options.sourcePath);
	const nodes = parseNodes(root.nodes, options.sourcePath);
	const edges = parseEdges(root.edges, options.sourcePath);
	const stateSchema = parseStateSchema(root.stateSchema, "stateSchema", options.sourcePath);
	const resources = parseResourceDeclarations(root.resources, "resources", options.sourcePath);
	const capabilities = parseCapabilityContract(root.capabilities, "capabilities", options.sourcePath);
	const migrations = parseMigrationRules(root.migrations, "migrations", options.sourcePath);
	const subflows = parseSubflowDeclarations(root.subflows, "subflows", options.sourcePath);
	validateEdgeReferences(nodes, edges, options.sourcePath);
	validateConditionReferences(nodes, edges, stateSchema, options.sourcePath);
	validateWaitForReferences(nodes, options.sourcePath);
	validatePromptSourceReferences(nodes, options.sourcePath);
	validateMigrationTargets(nodes, migrations, options.sourcePath);
	validateSubflowTargets(nodes, subflows, options.sourcePath);
	const definition: WorkflowDefinition = { name, version, sourcePath: options.sourcePath, models, nodes, edges };
	if (stateSchema !== undefined) definition.stateSchema = stateSchema;
	if (resources !== undefined) definition.resources = resources;
	if (capabilities !== undefined) definition.capabilities = capabilities;
	if (migrations !== undefined) definition.migrations = migrations;
	if (subflows !== undefined) definition.subflows = subflows;
	return definition;
}

function parseYaml(source: string, sourcePath?: string): unknown {
	try {
		return YAML.parse(source);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new WorkflowDefinitionError(`failed to parse YAML: ${message}`, sourcePath);
	}
}

function parseModels(value: unknown, sourcePath?: string): WorkflowModels {
	if (value === undefined) {
		return { roles: {}, defaults: {} };
	}
	const raw = expectRecord(value, "models", sourcePath);
	const roles = parseStringRecord(raw.roles, "models.roles", sourcePath);
	const defaults = parseStringRecord(raw.defaults, "models.defaults", sourcePath);
	const unavailable = parseUnavailable(raw.unavailable, "models.unavailable", sourcePath);
	return unavailable ? { roles, defaults, unavailable } : { roles, defaults };
}

function parseNodes(value: unknown, sourcePath?: string): WorkflowNode[] {
	const entries = parseNodeEntries(value, sourcePath);
	const seen = new Set<string>();
	return entries.map(({ id, rawNode, path }) => {
		if (seen.has(id)) {
			throw new WorkflowDefinitionError(`duplicate node id "${id}"`, sourcePath);
		}
		seen.add(id);
		const node = expectRecord(rawNode, path, sourcePath);
		const type = parseNodeType(node.type, `${path}.type`, sourcePath);
		const agent = parseOptionalString(node.agent, `${path}.agent`, sourcePath);
		const model = parseModelContext(node.model, `${path}.model`, sourcePath);
		const prompt = parsePromptSource(node.prompt, `${path}.prompt`, sourcePath);
		const script = parseScriptSource(node.script, `${path}.script`, sourcePath);
		const gates = parseOptionalStringList(node.gates, `${path}.gates`, sourcePath);
		const fallbackVerdict = parseOptionalString(node.fallbackVerdict, `${path}.fallbackVerdict`, sourcePath);
		validateFallbackVerdict(id, type, gates, fallbackVerdict, path, sourcePath);
		const isolation = parseNodeIsolation(node.isolation, `${path}.isolation`, sourcePath);
		const reads = parseOptionalStringList(node.reads, `${path}.reads`, sourcePath);
		const writes = parseOptionalStringList(node.writes, `${path}.writes`, sourcePath);
		const workspaceAccess = parseWorkspaceAccess(node.workspaceAccess, `${path}.workspaceAccess`, sourcePath);
		const waitFor = parseOptionalStringList(node.waitFor, `${path}.waitFor`, sourcePath);
		const checkpoint = parseNodeCheckpoint(node.checkpoint, `${path}.checkpoint`, sourcePath);
		const timeoutMs = parseOptionalNodeTimeoutMs(node.timeoutMs, `${path}.timeoutMs`, sourcePath);
		return compactNode({
			id,
			type,
			agent,
			model,
			...prompt,
			script,
			gates,
			fallbackVerdict,
			isolation,
			reads,
			writes,
			workspaceAccess,
			waitFor,
			checkpoint,
			timeoutMs,
		});
	});
}

function parseNodeEntries(value: unknown, sourcePath?: string): Array<{ id: string; rawNode: unknown; path: string }> {
	if (Array.isArray(value)) {
		return value.map((rawNode, index) => {
			const path = `nodes.${index}`;
			const node = expectRecord(rawNode, path, sourcePath);
			return {
				id: expectString(node.id, `${path}.id`, sourcePath),
				rawNode,
				path,
			};
		});
	}
	const rawNodes = expectRecord(value, "nodes", sourcePath);
	return Object.entries(rawNodes).map(([id, rawNode]) => ({ id, rawNode, path: `nodes.${id}` }));
}

function parseEdges(value: unknown, sourcePath?: string): WorkflowEdge[] {
	if (!Array.isArray(value)) {
		throw new WorkflowDefinitionError("edges must be an array", sourcePath);
	}
	return value.map((rawEdge, index) => {
		const edge = expectRecord(rawEdge, `edges.${index}`, sourcePath);
		const from = expectString(edge.from, `edges.${index}.from`, sourcePath);
		const to = expectString(edge.to, `edges.${index}.to`, sourcePath);
		const when = parseOptionalString(edge.when, `edges.${index}.when`, sourcePath);
		const label = parseOptionalString(edge.label, `edges.${index}.label`, sourcePath);
		const parsed: WorkflowEdge = when
			? { from, to, condition: parseConditionSource(when, `edges.${index}.when`, sourcePath) }
			: { from, to };
		if (label !== undefined) parsed.label = label;
		return parsed;
	});
}

function parseStateSchema(value: unknown, path: string, sourcePath?: string): WorkflowStateSchema | undefined {
	if (value === undefined) return undefined;
	try {
		return parseWorkflowStateSchema(value, path);
	} catch (error) {
		if (error instanceof WorkflowStateSchemaError) {
			throw new WorkflowDefinitionError(error.message, sourcePath);
		}
		throw error;
	}
}

function parseResourceDeclarations(
	value: unknown,
	path: string,
	sourcePath?: string,
): WorkflowResourceDeclaration[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) {
		throw new WorkflowDefinitionError(`${path} must be an array of resource declarations`, sourcePath);
	}
	return value.map((entry, index) => {
		if (typeof entry === "string") return { path: expectString(entry, `${path}.${index}`, sourcePath) };
		const raw = expectRecord(entry, `${path}.${index}`, sourcePath);
		const declaration: WorkflowResourceDeclaration = {
			path: expectString(raw.path, `${path}.${index}.path`, sourcePath),
		};
		const kind = parseResourceKind(raw.kind, `${path}.${index}.kind`, sourcePath);
		if (kind !== undefined) declaration.kind = kind;
		if (raw.required !== undefined) {
			if (typeof raw.required !== "boolean") {
				throw new WorkflowDefinitionError(`${path}.${index}.required must be a boolean`, sourcePath);
			}
			declaration.required = raw.required;
		}
		return declaration;
	});
}

function parseResourceKind(value: unknown, path: string, sourcePath?: string): WorkflowResourceKind | undefined {
	if (value === undefined) return undefined;
	if (value === "prompt" || value === "script" || value === "data") return value;
	throw new WorkflowDefinitionError(`${path} must be prompt, script, or data`, sourcePath);
}

function parseCapabilityContract(
	value: unknown,
	path: string,
	sourcePath?: string,
): WorkflowCapabilityContract | undefined {
	if (value === undefined) return undefined;
	const raw = expectRecord(value, path, sourcePath);
	const tools = parseOptionalStringList(raw.tools, `${path}.tools`, sourcePath);
	const agents = parseOptionalStringList(raw.agents, `${path}.agents`, sourcePath);
	const plugins = parseOptionalStringList(raw.plugins, `${path}.plugins`, sourcePath);
	const extensions = parseOptionalStringList(raw.extensions, `${path}.extensions`, sourcePath);
	const skills = parseOptionalStringList(raw.skills, `${path}.skills`, sourcePath);
	const contract: WorkflowCapabilityContract = {};
	if (tools !== undefined) contract.tools = tools;
	if (agents !== undefined) contract.agents = agents;
	if (plugins !== undefined) contract.plugins = plugins;
	if (extensions !== undefined) contract.extensions = extensions;
	if (skills !== undefined) contract.skills = skills;
	return Object.keys(contract).length > 0 ? contract : undefined;
}

function parseMigrationRules(value: unknown, path: string, sourcePath?: string): WorkflowMigrationRule[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) {
		throw new WorkflowDefinitionError(`${path} must be an array of migration rules`, sourcePath);
	}
	return value.map((entry, index) => {
		const raw = expectRecord(entry, `${path}.${index}`, sourcePath);
		return {
			from: expectString(raw.from, `${path}.${index}.from`, sourcePath),
			to: expectString(raw.to, `${path}.${index}.to`, sourcePath),
			frontierMapping: parseStringRecord(raw.frontierMapping, `${path}.${index}.frontierMapping`, sourcePath),
		};
	});
}

function parseSubflowDeclarations(
	value: unknown,
	path: string,
	sourcePath?: string,
): WorkflowSubflowDeclaration[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) {
		throw new WorkflowDefinitionError(`${path} must be an array of subflow declarations`, sourcePath);
	}
	return value.map((entry, index) => {
		const raw = expectRecord(entry, `${path}.${index}`, sourcePath);
		const declaration: WorkflowSubflowDeclaration = {
			alias: expectString(raw.alias, `${path}.${index}.alias`, sourcePath),
			name: expectString(raw.name, `${path}.${index}.name`, sourcePath),
			version: expectNumber(raw.version, `${path}.${index}.version`, sourcePath),
			namespace: expectString(raw.namespace, `${path}.${index}.namespace`, sourcePath),
			nodeIds: parseRequiredStringList(raw.nodeIds, `${path}.${index}.nodeIds`, sourcePath),
			entryNodeIds: parseRequiredStringList(raw.entryNodeIds, `${path}.${index}.entryNodeIds`, sourcePath),
			exitNodeIds: parseRequiredStringList(raw.exitNodeIds, `${path}.${index}.exitNodeIds`, sourcePath),
		};
		const resourcePrefix = parseOptionalString(raw.resourcePrefix, `${path}.${index}.resourcePrefix`, sourcePath);
		if (resourcePrefix !== undefined) declaration.resourcePrefix = resourcePrefix;
		return declaration;
	});
}

function parseConditionSource(source: string, path: string, sourcePath?: string): WorkflowCondition {
	const trimmed = source.trim();
	try {
		parseWorkflowCondition(trimmed);
	} catch (error) {
		if (error instanceof WorkflowConditionError) {
			throw new WorkflowDefinitionError(`${path} is not a valid workflow condition: ${error.message}`, sourcePath);
		}
		throw error;
	}
	return { source: trimmed };
}

function validateEdgeReferences(nodes: WorkflowNode[], edges: WorkflowEdge[], sourcePath?: string): void {
	const nodeIds = new Set(nodes.map(node => node.id));
	for (const edge of edges) {
		if (!nodeIds.has(edge.from)) {
			throw new WorkflowDefinitionError(`edge references unknown source node "${edge.from}"`, sourcePath);
		}
		if (!nodeIds.has(edge.to)) {
			throw new WorkflowDefinitionError(`edge references unknown target node "${edge.to}"`, sourcePath);
		}
	}
}

function validateConditionReferences(
	nodes: WorkflowNode[],
	edges: WorkflowEdge[],
	stateSchema: WorkflowStateSchema | undefined,
	sourcePath?: string,
): void {
	for (const [index, edge] of edges.entries()) {
		if (edge.condition === undefined) continue;
		for (const diagnostic of diagnoseWorkflowConditionReferences(edge.condition.source, nodes, stateSchema)) {
			throw new WorkflowDefinitionError(`edges.${index}.when ${diagnostic}`, sourcePath);
		}
	}
}

function validateWaitForReferences(nodes: WorkflowNode[], sourcePath?: string): void {
	const nodeIds = new Set(nodes.map(node => node.id));
	for (const node of nodes) {
		for (const dependency of node.waitFor ?? []) {
			if (!nodeIds.has(dependency)) {
				throw new WorkflowDefinitionError(
					`node "${node.id}" waitFor references unknown node "${dependency}"`,
					sourcePath,
				);
			}
		}
	}
}

function validatePromptSourceReferences(nodes: WorkflowNode[], sourcePath?: string): void {
	const nodeIds = new Set(nodes.map(node => node.id));
	for (const node of nodes) {
		const source = node.promptSource;
		if (source?.kind === "output" && !nodeIds.has(source.node)) {
			throw new WorkflowDefinitionError(
				`node "${node.id}" prompt references unknown output node "${source.node}"`,
				sourcePath,
			);
		}
		if (source?.kind === "template") {
			for (const binding of Object.values(source.bindings)) {
				if (binding.kind === "output" && !nodeIds.has(binding.node)) {
					throw new WorkflowDefinitionError(
						`node "${node.id}" prompt references unknown output node "${binding.node}"`,
						sourcePath,
					);
				}
			}
		}
	}
}

function validateMigrationTargets(
	nodes: WorkflowNode[],
	migrations: WorkflowMigrationRule[] | undefined,
	sourcePath?: string,
): void {
	if (migrations === undefined) return;
	const nodeIds = new Set(nodes.map(node => node.id));
	for (const migration of migrations) {
		for (const [frontier, target] of Object.entries(migration.frontierMapping)) {
			if (!nodeIds.has(target)) {
				throw new WorkflowDefinitionError(
					`migration "${migration.from}" -> "${migration.to}" maps frontier "${frontier}" to unknown node "${target}"`,
					sourcePath,
				);
			}
		}
	}
}

function validateSubflowTargets(
	nodes: WorkflowNode[],
	subflows: WorkflowSubflowDeclaration[] | undefined,
	sourcePath?: string,
): void {
	if (subflows === undefined) return;
	const nodeIds = new Set(nodes.map(node => node.id));
	for (const subflow of subflows) {
		for (const nodeId of subflow.nodeIds) {
			if (!nodeIds.has(nodeId)) {
				throw new WorkflowDefinitionError(
					`subflow "${subflow.alias}" references unknown node "${nodeId}"`,
					sourcePath,
				);
			}
		}
		for (const nodeId of [...subflow.entryNodeIds, ...subflow.exitNodeIds]) {
			if (!subflow.nodeIds.includes(nodeId)) {
				throw new WorkflowDefinitionError(
					`subflow "${subflow.alias}" boundary references node outside subflow "${nodeId}"`,
					sourcePath,
				);
			}
		}
	}
}

function validateFallbackVerdict(
	id: string,
	type: WorkflowNodeType,
	gates: string[] | undefined,
	fallbackVerdict: string | undefined,
	path: string,
	sourcePath?: string,
): void {
	if (fallbackVerdict === undefined) return;
	if (type !== "review") {
		throw new WorkflowDefinitionError(`${path}.fallbackVerdict is only valid for review nodes`, sourcePath);
	}
	if (!gates?.includes(fallbackVerdict)) {
		throw new WorkflowDefinitionError(
			`${path}.fallbackVerdict must be one of the declared gates for review node "${id}"`,
			sourcePath,
		);
	}
}

function parsePromptSource(
	value: unknown,
	path: string,
	sourcePath?: string,
): { prompt?: string; promptSource?: WorkflowPromptSource } {
	if (value === undefined) return {};
	if (typeof value === "string") {
		const prompt = expectString(value, path, sourcePath);
		return {
			prompt,
			promptSource: prompt.startsWith("./") ? { kind: "file", path: prompt } : { kind: "inline", text: prompt },
		};
	}
	const raw = expectRecord(value, path, sourcePath);
	const sourceKeys = ["inline", "file", "state", "output", "human", "template"].filter(key => raw[key] !== undefined);
	if (sourceKeys.length !== 1) {
		throw new WorkflowDefinitionError(
			`${path} must define exactly one of inline, file, state, output, human, or template`,
			sourcePath,
		);
	}
	const sourceKey = sourceKeys[0];
	if (sourceKey === "inline") {
		const text = expectString(raw.inline, `${path}.inline`, sourcePath);
		return { prompt: text, promptSource: { kind: "inline", text } };
	}
	if (sourceKey === "file") {
		const filePath = expectString(raw.file, `${path}.file`, sourcePath);
		return { prompt: filePath, promptSource: { kind: "file", path: filePath } };
	}
	if (sourceKey === "state") {
		const statePath = expectJsonPointer(raw.state, `${path}.state`, sourcePath);
		return { promptSource: { kind: "state", path: statePath } };
	}
	if (sourceKey === "human") {
		const humanPath = expectJsonPointer(raw.human, `${path}.human`, sourcePath);
		return { promptSource: { kind: "human", path: humanPath } };
	}
	if (sourceKey === "template") {
		return { promptSource: parseTemplatePromptSource(raw.template, `${path}.template`, sourcePath) };
	}
	const output = expectRecord(raw.output, `${path}.output`, sourcePath);
	const node = expectString(output.node, `${path}.output.node`, sourcePath);
	const outputPath = expectJsonPointer(output.path, `${path}.output.path`, sourcePath);
	const activation = parsePromptActivationSelector(output.activation, `${path}.output.activation`, sourcePath);
	return { promptSource: { kind: "output", node, path: outputPath, activation } };
}

function parseTemplatePromptSource(value: unknown, path: string, sourcePath?: string): WorkflowTemplatePromptSource {
	const raw = expectRecord(value, path, sourcePath);
	const file = expectString(raw.file, `${path}.file`, sourcePath);
	const bindings = parseTemplatePromptBindings(raw.bindings, `${path}.bindings`, sourcePath);
	return { kind: "template", file, bindings };
}

function parseTemplatePromptBindings(
	value: unknown,
	path: string,
	sourcePath?: string,
): Record<string, WorkflowTemplatePromptBindingSource> {
	const raw = expectRecord(value, path, sourcePath);
	const bindings: Record<string, WorkflowTemplatePromptBindingSource> = {};
	for (const [name, binding] of Object.entries(raw)) {
		bindings[name] = parseTemplatePromptBindingSource(binding, `${path}.${name}`, sourcePath);
	}
	return bindings;
}

function parseTemplatePromptBindingSource(
	value: unknown,
	path: string,
	sourcePath?: string,
): WorkflowTemplatePromptBindingSource {
	const raw = expectRecord(value, path, sourcePath);
	const sourceKeys = ["inline", "state", "output", "human"].filter(key => raw[key] !== undefined);
	if (sourceKeys.length !== 1) {
		throw new WorkflowDefinitionError(
			`${path} must define exactly one of inline, state, output, or human`,
			sourcePath,
		);
	}
	const sourceKey = sourceKeys[0];
	if (sourceKey === "inline") {
		return { kind: "inline", text: expectString(raw.inline, `${path}.inline`, sourcePath) };
	}
	if (sourceKey === "state") {
		return { kind: "state", path: expectJsonPointer(raw.state, `${path}.state`, sourcePath) };
	}
	if (sourceKey === "human") {
		return { kind: "human", path: expectJsonPointer(raw.human, `${path}.human`, sourcePath) };
	}
	const output = expectRecord(raw.output, `${path}.output`, sourcePath);
	return {
		kind: "output",
		node: expectString(output.node, `${path}.output.node`, sourcePath),
		path: expectJsonPointer(output.path, `${path}.output.path`, sourcePath),
		activation: parsePromptActivationSelector(output.activation, `${path}.output.activation`, sourcePath),
	};
}

function parseModelContext(value: unknown, path: string, sourcePath?: string): WorkflowModelContext | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "string") return { selector: value };
	const raw = expectRecord(value, path, sourcePath);
	const role = parseOptionalString(raw.role, `${path}.role`, sourcePath);
	const selector = parseOptionalString(raw.selector, `${path}.selector`, sourcePath);
	const candidates = parseOptionalStringList(raw.candidates, `${path}.candidates`, sourcePath);
	const unavailable = parseUnavailable(raw.unavailable, `${path}.unavailable`, sourcePath);
	const sourceCount = [role, selector, candidates].filter(entry => entry !== undefined).length;
	if (sourceCount !== 1) {
		throw new WorkflowDefinitionError(`${path} must define exactly one of role, selector, or candidates`, sourcePath);
	}
	const context: WorkflowModelContext = {};
	if (role !== undefined) context.role = role;
	if (selector !== undefined) context.selector = selector;
	if (candidates !== undefined) context.candidates = candidates;
	if (unavailable !== undefined) context.unavailable = unavailable;
	return Object.keys(context).length > 0 ? context : undefined;
}

function parseScriptSource(value: unknown, path: string, sourcePath?: string): WorkflowScriptSource | undefined {
	if (value === undefined) return undefined;
	const raw = expectRecord(value, path, sourcePath);
	const language = parseScriptLanguage(raw.language, `${path}.language`, sourcePath);
	const code = parseOptionalString(raw.inline, `${path}.inline`, sourcePath);
	const file = parseOptionalString(raw.file, `${path}.file`, sourcePath);
	const timeoutMs = parseOptionalScriptTimeoutMs(raw.timeoutMs, `${path}.timeoutMs`, sourcePath);
	const sourceCount = [code, file].filter(entry => entry !== undefined).length;
	if (sourceCount !== 1) {
		throw new WorkflowDefinitionError(`${path} must define exactly one of inline or file`, sourcePath);
	}
	const script: WorkflowScriptSource = {};
	if (language !== undefined) script.language = language;
	if (code !== undefined) script.code = code;
	if (file !== undefined) script.file = file;
	if (timeoutMs !== undefined) script.timeoutMs = timeoutMs;
	return script;
}

function parseScriptLanguage(value: unknown, path: string, sourcePath?: string): WorkflowScriptLanguage | undefined {
	if (value === undefined) return undefined;
	if (value === "js" || value === "py" || value === "sh") return value;
	throw new WorkflowDefinitionError(`${path} must be js, py, or sh`, sourcePath);
}

function parseOptionalScriptTimeoutMs(value: unknown, path: string, sourcePath?: string): number | undefined {
	if (value === undefined) return undefined;
	if (
		typeof value === "number" &&
		Number.isSafeInteger(value) &&
		value > 0 &&
		value <= WORKFLOW_SCRIPT_TIMEOUT_MAX_MS
	) {
		return value;
	}
	throw new WorkflowDefinitionError(
		`${path} must be a positive integer no greater than ${WORKFLOW_SCRIPT_TIMEOUT_MAX_MS}`,
		sourcePath,
	);
}

function parseOptionalNodeTimeoutMs(value: unknown, path: string, sourcePath?: string): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= WORKFLOW_NODE_TIMEOUT_MAX_MS) {
		return value;
	}
	throw new WorkflowDefinitionError(
		`${path} must be a positive integer no greater than ${WORKFLOW_NODE_TIMEOUT_MAX_MS}`,
		sourcePath,
	);
}

function parseUnavailable(
	value: unknown,
	path: string,
	sourcePath?: string,
): WorkflowModelUnavailablePolicy | undefined {
	if (value === undefined) return undefined;
	if (value === "fallback-to-parent" || value === "fail") return value;
	throw new WorkflowDefinitionError(`${path} must be "fallback-to-parent" or "fail"`, sourcePath);
}

function parseNodeType(value: unknown, path: string, sourcePath?: string): WorkflowNodeType {
	if (value === "agent" || value === "script" || value === "human" || value === "review") return value;
	throw new WorkflowDefinitionError(`${path} must be agent, script, human, or review`, sourcePath);
}

function parseWorkspaceAccess(value: unknown, path: string, sourcePath?: string): WorkflowWorkspaceAccess | undefined {
	if (value === undefined) return undefined;
	if (value === "read" || value === "write") return value;
	throw new WorkflowDefinitionError(`${path} must be "read" or "write"`, sourcePath);
}

function parseNodeIsolation(value: unknown, path: string, sourcePath?: string): WorkflowNodeIsolation | undefined {
	if (value === undefined) return undefined;
	const raw = expectRecord(value, path, sourcePath);
	const enabled = expectBoolean(raw.enabled, `${path}.enabled`, sourcePath);
	const isolation: WorkflowNodeIsolation = { enabled };
	if (raw.apply !== undefined) isolation.apply = expectBoolean(raw.apply, `${path}.apply`, sourcePath);
	if (raw.merge !== undefined) isolation.merge = expectBoolean(raw.merge, `${path}.merge`, sourcePath);
	if (raw.capture !== undefined) isolation.capture = parseIsolationCapture(raw.capture, `${path}.capture`, sourcePath);
	return isolation;
}

function parseIsolationCapture(value: unknown, path: string, sourcePath?: string): WorkflowIsolationCapture {
	const raw = expectRecord(value, path, sourcePath);
	const capture: WorkflowIsolationCapture = {};
	const include = parseOptionalStringList(raw.include, `${path}.include`, sourcePath);
	const exclude = parseOptionalStringList(raw.exclude, `${path}.exclude`, sourcePath);
	if (include !== undefined) capture.include = include;
	if (exclude !== undefined) capture.exclude = exclude;
	return capture;
}

function parseNodeCheckpoint(value: unknown, path: string, sourcePath?: string): WorkflowNodeCheckpoint | undefined {
	if (value === undefined) return undefined;
	if (value === "after") return value;
	throw new WorkflowDefinitionError(`${path} must be "after"`, sourcePath);
}

function parsePromptActivationSelector(
	value: unknown,
	path: string,
	sourcePath?: string,
): WorkflowPromptActivationSelector {
	if (value === "parent" || value === "latest-completed") return value;
	throw new WorkflowDefinitionError(`${path} must be parent or latest-completed`, sourcePath);
}

function compactNode(node: WorkflowNode): WorkflowNode {
	const result: WorkflowNode = { id: node.id, type: node.type };
	if (node.agent !== undefined) result.agent = node.agent;
	if (node.model !== undefined) result.model = node.model;
	if (node.prompt !== undefined) result.prompt = node.prompt;
	if (node.promptSource !== undefined) result.promptSource = node.promptSource;
	if (node.script !== undefined) result.script = node.script;
	if (node.gates !== undefined) result.gates = node.gates;
	if (node.fallbackVerdict !== undefined) result.fallbackVerdict = node.fallbackVerdict;
	if (node.isolation !== undefined) result.isolation = node.isolation;
	if (node.reads !== undefined) result.reads = node.reads;
	if (node.writes !== undefined) result.writes = node.writes;
	if (node.workspaceAccess !== undefined) result.workspaceAccess = node.workspaceAccess;
	if (node.waitFor !== undefined) result.waitFor = node.waitFor;
	if (node.checkpoint !== undefined) result.checkpoint = node.checkpoint;
	if (node.timeoutMs !== undefined) result.timeoutMs = node.timeoutMs;
	return result;
}

function parseStringRecord(value: unknown, path: string, sourcePath?: string): Record<string, string> {
	if (value === undefined) return {};
	const raw = expectRecord(value, path, sourcePath);
	const result: Record<string, string> = {};
	for (const [key, entry] of Object.entries(raw)) {
		result[key] = expectString(entry, `${path}.${key}`, sourcePath);
	}
	return result;
}

function parseRequiredStringList(value: unknown, path: string, sourcePath?: string): string[] {
	const list = parseOptionalStringList(value, path, sourcePath);
	if (list === undefined) throw new WorkflowDefinitionError(`${path} must be an array of strings`, sourcePath);
	return list;
}

function parseOptionalStringList(value: unknown, path: string, sourcePath?: string): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) {
		throw new WorkflowDefinitionError(`${path} must be an array of strings`, sourcePath);
	}
	return value.map((entry, index) => expectString(entry, `${path}.${index}`, sourcePath));
}

function parseOptionalString(value: unknown, path: string, sourcePath?: string): string | undefined {
	if (value === undefined) return undefined;
	return expectString(value, path, sourcePath);
}

function expectJsonPointer(value: unknown, path: string, sourcePath?: string): string {
	const pointer = expectString(value, path, sourcePath);
	if (pointer.startsWith("/")) return pointer;
	throw new WorkflowDefinitionError(`${path} must be a JSON pointer`, sourcePath);
}

function expectString(value: unknown, path: string, sourcePath?: string): string {
	if (typeof value === "string" && value.trim()) return value;
	throw new WorkflowDefinitionError(`${path} must be a non-empty string`, sourcePath);
}

function expectNumber(value: unknown, path: string, sourcePath?: string): number {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	throw new WorkflowDefinitionError(`${path} must be a finite number`, sourcePath);
}

function expectBoolean(value: unknown, path: string, sourcePath?: string): boolean {
	if (typeof value === "boolean") return value;
	throw new WorkflowDefinitionError(`${path} must be a boolean`, sourcePath);
}

function expectRecord(value: unknown, path: string, sourcePath?: string): Record<string, unknown> {
	if (!isRecord(value)) {
		throw new WorkflowDefinitionError(`${path} must be an object`, sourcePath);
	}
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
