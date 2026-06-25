import * as fs from "node:fs/promises";
import * as path from "node:path";
import { YAML } from "bun";
import {
	parseWorkflowDefinition,
	type WorkflowCapabilityContract,
	type WorkflowDefinition,
	type WorkflowNode,
	type WorkflowPromptSource,
	type WorkflowScriptSource,
} from "./definition";
import {
	compileWorkflowDslBlock,
	type WorkflowDslCompileExit,
	WorkflowDslError,
	type WorkflowDslExternalModule,
} from "./dsl";

export interface WorkflowPackage {
	rootPath: string;
	workflowPath: string;
	definition: WorkflowDefinition;
}

export interface WorkflowArtifact {
	flowPath: string;
	resourceDir: string;
	source: string;
	metadata: WorkflowArtifactMetadata;
	definition: WorkflowDefinition;
	entryNodeIds: string[];
	exits: WorkflowDslCompileExit[];
	changeRequests: WorkflowArtifactChangeRequestSource[];
	sourceMapping: WorkflowArtifactSourceMapping;
}

export interface WorkflowArtifactChangeRequestSource {
	id: string;
	path: string;
	required?: boolean;
}

export interface WorkflowArtifactMetadata {
	name: string;
	version: number;
	schema: string;
	models?: unknown;
	checkpoint?: unknown;
	changePolicy?: unknown;
	compatibility?: unknown;
}

export interface WorkflowArtifactSourceMapping {
	workflowBlocks: WorkflowArtifactWorkflowBlock[];
	nodes: Record<string, WorkflowArtifactNodeSource>;
}

export interface WorkflowArtifactWorkflowBlock {
	id: string;
	language: "yaml" | "json";
}

export interface WorkflowArtifactNodeSource {
	sourceBlock: string;
}

export class WorkflowPackageError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WorkflowPackageError";
	}
}

export async function loadWorkflowPackage(inputPath: string): Promise<WorkflowPackage> {
	const stat = await statWorkflowPath(inputPath);
	const rootPath = stat.isDirectory() ? inputPath : path.dirname(inputPath);
	const workflowPath = stat.isDirectory() ? path.join(inputPath, "workflow.yml") : inputPath;
	if (path.extname(workflowPath) === ".omhflow") {
		const artifact = await loadWorkflowArtifact(workflowPath);
		return {
			rootPath: artifact.resourceDir,
			workflowPath: artifact.flowPath,
			definition: artifact.definition,
		};
	}
	const source = await readWorkflowSource(workflowPath);
	return {
		rootPath,
		workflowPath,
		definition: parseWorkflowDefinition(source, { sourcePath: workflowPath }),
	};
}

export async function loadWorkflowArtifact(inputPath: string): Promise<WorkflowArtifact> {
	return loadWorkflowArtifactInternal(inputPath, []);
}

async function loadWorkflowArtifactInternal(inputPath: string, stack: string[]): Promise<WorkflowArtifact> {
	const stat = await statWorkflowPath(inputPath);
	if (stat.isDirectory()) {
		throw new WorkflowPackageError(".omhflow artifact path must be a file");
	}
	const flowPath = path.resolve(inputPath);
	if (path.extname(flowPath) !== ".omhflow") {
		throw new WorkflowPackageError("workflow artifact file must use the .omhflow extension");
	}
	if (stack.includes(flowPath)) {
		throw new WorkflowPackageError(`${flowPath}: workflow import cycle: ${[...stack, flowPath].join(" -> ")}`);
	}
	const source = await readWorkflowSource(flowPath);
	const metadata = parseFrontmatter(source, flowPath);
	const workflowBlocks = parseWorkflowBlocks(source, flowPath);
	if (workflowBlocks.length === 0) {
		throw new WorkflowPackageError(`${flowPath}: .omhflow must contain at least one fenced workflow block`);
	}
	if (workflowBlocks.length > 1) {
		throw new WorkflowPackageError(`${flowPath}: .omhflow must contain exactly one fenced workflow block`);
	}
	const block = workflowBlocks[0]!;
	const resourceDir = workflowResourceDirForFlowPath(flowPath);
	const externalModules = await loadWorkflowImports(block.value, flowPath, resourceDir, [...stack, flowPath]);
	const compiled = compileArtifactDefinitionInput(metadata, block.value, flowPath, externalModules);
	const artifactMetadata = mergeWorkflowBlockMetadata(metadata, compiled, flowPath);
	const changeRequests = parseWorkflowArtifactChangeRequests(compiled.changeRequests, flowPath);
	const definition = parseWorkflowDefinition(JSON.stringify(compiled.definitionInput), {
		sourcePath: flowPath,
	});
	return {
		flowPath,
		resourceDir,
		source,
		metadata: artifactMetadata,
		definition,
		entryNodeIds: compiled.entryNodeIds,
		exits: compiled.exits,
		changeRequests,
		sourceMapping: {
			workflowBlocks: workflowBlocks.map(block => ({ id: block.id, language: block.language })),
			nodes: Object.fromEntries(definition.nodes.map(node => [node.id, { sourceBlock: block.id }])),
		},
	};
}

async function statWorkflowPath(inputPath: string) {
	try {
		return await fs.stat(inputPath);
	} catch (error) {
		throw new WorkflowPackageError(`workflow package path is not readable: ${formatError(error)}`);
	}
}

async function readWorkflowSource(workflowPath: string): Promise<string> {
	try {
		return await Bun.file(workflowPath).text();
	} catch (error) {
		throw new WorkflowPackageError(`workflow file is not readable: ${formatError(error)}`);
	}
}

function parseFrontmatter(source: string, flowPath: string): WorkflowArtifactMetadata {
	const lines = source.split(/\r?\n/);
	if (lines[0] !== "---") {
		throw new WorkflowPackageError(`${flowPath}: .omhflow must start with YAML frontmatter`);
	}
	const endIndex = lines.findIndex((line, index) => index > 0 && line === "---");
	if (endIndex < 0) {
		throw new WorkflowPackageError(`${flowPath}: .omhflow frontmatter is not closed`);
	}
	let raw: unknown;
	try {
		raw = YAML.parse(lines.slice(1, endIndex).join("\n"));
	} catch (error) {
		throw new WorkflowPackageError(`${flowPath}: failed to parse .omhflow frontmatter: ${formatError(error)}`);
	}
	const record = expectRecord(raw, ".omhflow frontmatter", flowPath);
	const name = expectString(record.name, "frontmatter.name", flowPath);
	const version = expectNumber(record.version, "frontmatter.version", flowPath);
	const schema = expectString(record.schema, "frontmatter.schema", flowPath);
	const metadata: WorkflowArtifactMetadata = { name, version, schema };
	if (record.models !== undefined) metadata.models = record.models;
	if (record.checkpoint !== undefined) metadata.checkpoint = record.checkpoint;
	if (record.changePolicy !== undefined) metadata.changePolicy = record.changePolicy;
	if (record.compatibility !== undefined) metadata.compatibility = record.compatibility;
	return metadata;
}

interface ParsedWorkflowBlock {
	id: string;
	language: "yaml" | "json";
	value: Record<string, unknown>;
}

function parseWorkflowBlocks(source: string, flowPath: string): ParsedWorkflowBlock[] {
	const blocks: ParsedWorkflowBlock[] = [];
	const pattern = /^```(yaml|yml|json)\s+workflow\s*\n([\s\S]*?)^```/gm;
	for (const match of source.matchAll(pattern)) {
		const language = match[1] === "json" ? "json" : "yaml";
		const body = match[2] ?? "";
		let raw: unknown;
		try {
			raw = language === "json" ? JSON.parse(body) : YAML.parse(body);
		} catch (error) {
			throw new WorkflowPackageError(
				`${flowPath}: failed to parse workflow block ${blocks.length}: ${formatError(error)}`,
			);
		}
		blocks.push({
			id: `workflow:${blocks.length}`,
			language,
			value: expectRecord(raw, `workflow block ${blocks.length}`, flowPath),
		});
	}
	return blocks;
}

function parseWorkflowArtifactChangeRequests(value: unknown, flowPath: string): WorkflowArtifactChangeRequestSource[] {
	if (value === undefined) return [];
	const entries = Array.isArray(value) ? value : [value];
	return entries.map((entry, index) =>
		parseWorkflowArtifactChangeRequest(entry, `change_requests.${index}`, flowPath),
	);
}

function parseWorkflowArtifactChangeRequest(
	value: unknown,
	label: string,
	flowPath: string,
): WorkflowArtifactChangeRequestSource {
	const record = expectRecord(value, label, flowPath);
	const id = expectString(record.id, `${label}.id`, flowPath);
	if (record.path !== undefined && record.file !== undefined) {
		throw new WorkflowPackageError(`${flowPath}: ${label} must not define both path and file`);
	}
	const requestPath = expectString(record.path ?? record.file, `${label}.path`, flowPath);
	const request: WorkflowArtifactChangeRequestSource = { id, path: requestPath };
	if (record.required !== undefined) {
		if (typeof record.required !== "boolean") {
			throw new WorkflowPackageError(`${flowPath}: ${label}.required must be a boolean`);
		}
		request.required = record.required;
	}
	return request;
}

interface CompiledWorkflowArtifactInput {
	definitionInput: Record<string, unknown>;
	entryNodeIds: string[];
	exits: WorkflowDslCompileExit[];
	checkpointPolicy?: unknown;
	changePolicy?: unknown;
	changeRequests?: unknown;
}

function compileArtifactDefinitionInput(
	metadata: WorkflowArtifactMetadata,
	block: Record<string, unknown>,
	flowPath?: string,
	externalModules: Record<string, WorkflowDslExternalModule> = {},
): CompiledWorkflowArtifactInput {
	try {
		const compiled = compileWorkflowDslBlock(block, { externalModules });
		return {
			definitionInput: {
				name: metadata.name,
				version: metadata.version,
				models: compiled.models ?? metadata.models,
				nodes: compiled.nodes,
				edges: compiled.edges,
				stateSchema: compiled.stateSchema,
				resources: compiled.resources,
				capabilities: compiled.capabilities,
				migrations: compiled.migrations,
				subflows: compiled.subflows,
			},
			entryNodeIds: compiled.entries,
			exits: compiled.exits,
			checkpointPolicy: compiled.checkpointPolicy,
			changePolicy: compiled.changePolicy,
			changeRequests: compiled.changeRequests,
		};
	} catch (error) {
		if (error instanceof WorkflowDslError) {
			throw new WorkflowPackageError(flowPath ? `${flowPath}: ${error.message}` : error.message);
		}
		throw error;
	}
}

function mergeWorkflowBlockMetadata(
	metadata: WorkflowArtifactMetadata,
	compiled: CompiledWorkflowArtifactInput,
	flowPath: string,
): WorkflowArtifactMetadata {
	if (compiled.checkpointPolicy === undefined && compiled.changePolicy === undefined) return metadata;
	let result = metadata;
	if (compiled.checkpointPolicy !== undefined) {
		const checkpoint = parseCheckpointPolicy(compiled.checkpointPolicy, "workflow block checkpoint_policy", flowPath);
		if (metadata.checkpoint !== undefined) {
			const frontmatterCheckpoint = parseCheckpointPolicy(metadata.checkpoint, "frontmatter.checkpoint", flowPath);
			if (frontmatterCheckpoint.stopDeadlineMs !== checkpoint.stopDeadlineMs) {
				throw new WorkflowPackageError(
					`${flowPath}: workflow block checkpoint_policy conflicts with frontmatter.checkpoint`,
				);
			}
		}
		result = { ...result, checkpoint };
	}
	if (compiled.changePolicy !== undefined) {
		const changePolicy = parseChangePolicy(compiled.changePolicy, "workflow block change_policy", flowPath);
		if (metadata.changePolicy !== undefined) {
			const frontmatterChangePolicy = parseChangePolicy(metadata.changePolicy, "frontmatter.changePolicy", flowPath);
			if (!sameChangePolicy(frontmatterChangePolicy, changePolicy)) {
				throw new WorkflowPackageError(
					`${flowPath}: workflow block change_policy conflicts with frontmatter.changePolicy`,
				);
			}
		}
		result = { ...result, changePolicy };
	}
	return result;
}

function parseCheckpointPolicy(value: unknown, label: string, flowPath: string): { stopDeadlineMs: number } {
	const record = expectRecord(value, label, flowPath);
	const stopDeadlineMs = record.stopDeadlineMs;
	if (typeof stopDeadlineMs !== "number" || !Number.isFinite(stopDeadlineMs) || stopDeadlineMs <= 0) {
		throw new WorkflowPackageError(`${flowPath}: ${label}.stopDeadlineMs must be a positive number`);
	}
	return { stopDeadlineMs };
}

function parseChangePolicy(
	value: unknown,
	label: string,
	flowPath: string,
): { agentsCanPropose: boolean; humansCanApprove: boolean; supervisorsCanApprove?: boolean } {
	const record = expectRecord(value, label, flowPath);
	if (typeof record.agentsCanPropose !== "boolean") {
		throw new WorkflowPackageError(`${flowPath}: ${label}.agentsCanPropose must be a boolean`);
	}
	if (typeof record.humansCanApprove !== "boolean") {
		throw new WorkflowPackageError(`${flowPath}: ${label}.humansCanApprove must be a boolean`);
	}
	const policy = {
		agentsCanPropose: record.agentsCanPropose,
		humansCanApprove: record.humansCanApprove,
	};
	if (record.supervisorsCanApprove !== undefined) {
		if (typeof record.supervisorsCanApprove !== "boolean") {
			throw new WorkflowPackageError(`${flowPath}: ${label}.supervisorsCanApprove must be a boolean when defined`);
		}
		return { ...policy, supervisorsCanApprove: record.supervisorsCanApprove };
	}
	return policy;
}

function sameChangePolicy(
	left: { agentsCanPropose: boolean; humansCanApprove: boolean; supervisorsCanApprove?: boolean },
	right: { agentsCanPropose: boolean; humansCanApprove: boolean; supervisorsCanApprove?: boolean },
): boolean {
	return (
		left.agentsCanPropose === right.agentsCanPropose &&
		left.humansCanApprove === right.humansCanApprove &&
		left.supervisorsCanApprove === right.supervisorsCanApprove
	);
}

async function loadWorkflowImports(
	block: Record<string, unknown>,
	flowPath: string,
	resourceDir: string,
	stack: string[],
): Promise<Record<string, WorkflowDslExternalModule>> {
	if (block.imports === undefined) return {};
	const rawImports = expectRecord(block.imports, "workflow imports", flowPath);
	const modules: Record<string, WorkflowDslExternalModule> = {};
	for (const [alias, rawImport] of Object.entries(rawImports)) {
		const importPath = parseImportPath(rawImport, `imports.${alias}`, flowPath);
		const importedFlowPath = path.resolve(path.dirname(flowPath), importPath);
		const artifact = await loadWorkflowArtifactInternal(importedFlowPath, stack);
		modules[alias] = artifactToExternalModule(artifact, resourceDir);
	}
	return modules;
}

function parseImportPath(rawImport: unknown, label: string, flowPath: string): string {
	if (typeof rawImport === "string") return rawImport;
	const record = expectRecord(rawImport, label, flowPath);
	return expectString(record.path, `${label}.path`, flowPath);
}

function artifactToExternalModule(artifact: WorkflowArtifact, importingResourceDir: string): WorkflowDslExternalModule {
	const resourcePrefix = toPortablePath(path.relative(importingResourceDir, artifact.resourceDir));
	const module: WorkflowDslExternalModule = {
		name: artifact.definition.name,
		version: artifact.definition.version,
		nodes: Object.fromEntries(artifact.definition.nodes.map(node => [node.id, workflowNodeToRawRecord(node)])),
		edges: artifact.definition.edges.map(edge => {
			const rawEdge: Record<string, unknown> = { from: edge.from, to: edge.to };
			if (edge.condition) rawEdge.when = edge.condition.source;
			if (edge.label !== undefined) rawEdge.label = edge.label;
			return rawEdge;
		}),
		entries: [...artifact.entryNodeIds],
		exits: artifact.exits.map(exit => structuredClone(exit)),
		resourcePrefix,
	};
	if (artifact.definition.resources) {
		module.resources = artifact.definition.resources.map(resource => ({
			...resource,
			path: joinResourcePath(resourcePrefix, resource.path),
		}));
	}
	if (artifact.definition.capabilities) {
		module.capabilities = workflowCapabilitiesToRawRecord(artifact.definition.capabilities);
	}
	return module;
}

function workflowResourceDirForFlowPath(flowPath: string): string {
	return path.join(path.dirname(flowPath), path.basename(flowPath, ".omhflow"));
}

function workflowCapabilitiesToRawRecord(capabilities: WorkflowCapabilityContract): Record<string, unknown> {
	const raw: Record<string, unknown> = {};
	if (capabilities.tools !== undefined) raw.tools = [...capabilities.tools];
	if (capabilities.agents !== undefined) raw.agents = [...capabilities.agents];
	if (capabilities.plugins !== undefined) raw.plugins = [...capabilities.plugins];
	if (capabilities.extensions !== undefined) raw.extensions = [...capabilities.extensions];
	if (capabilities.skills !== undefined) raw.skills = [...capabilities.skills];
	return raw;
}

function workflowNodeToRawRecord(node: WorkflowNode): Record<string, unknown> {
	const raw: Record<string, unknown> = { id: node.id, type: node.type };
	if (node.agent !== undefined) raw.agent = node.agent;
	if (node.model !== undefined) raw.model = structuredClone(node.model);
	if (node.promptSource !== undefined) {
		raw.prompt = promptSourceToRawPrompt(node.promptSource);
	} else if (node.prompt !== undefined) {
		raw.prompt = node.prompt;
	}
	if (node.script !== undefined) raw.script = workflowScriptSourceToRawScript(node.script);
	if (node.gates !== undefined) raw.gates = [...node.gates];
	if (node.fallbackVerdict !== undefined) raw.fallbackVerdict = node.fallbackVerdict;
	if (node.reads !== undefined) raw.reads = [...node.reads];
	if (node.writes !== undefined) raw.writes = [...node.writes];
	if (node.workspaceAccess !== undefined) raw.workspaceAccess = node.workspaceAccess;
	if (node.waitFor !== undefined) raw.waitFor = [...node.waitFor];
	return raw;
}

function workflowScriptSourceToRawScript(script: WorkflowScriptSource): Record<string, unknown> {
	const raw: Record<string, unknown> = {};
	if (script.language !== undefined) raw.language = script.language;
	if (script.code !== undefined) raw.inline = script.code;
	if (script.file !== undefined) raw.file = script.file;
	if (script.timeoutMs !== undefined) raw.timeoutMs = script.timeoutMs;
	return raw;
}

function promptSourceToRawPrompt(promptSource: WorkflowPromptSource): unknown {
	if (promptSource.kind === "inline") return { inline: promptSource.text };
	if (promptSource.kind === "file") return { file: promptSource.path };
	if (promptSource.kind === "state") return { state: promptSource.path };
	if (promptSource.kind === "human") return { human: promptSource.path };
	if (promptSource.kind === "template") {
		return {
			template: {
				file: promptSource.file,
				bindings: Object.fromEntries(
					Object.entries(promptSource.bindings).map(([name, binding]) => [name, promptSourceToRawPrompt(binding)]),
				),
			},
		};
	}
	return {
		output: {
			node: promptSource.node,
			path: promptSource.path,
			activation: promptSource.activation,
		},
	};
}

function joinResourcePath(prefix: string, resourcePath: string): string {
	if (!prefix || prefix === ".") return resourcePath;
	return `${prefix.replace(/\/+$/, "")}/${resourcePath.replace(/^\/+/, "")}`;
}

function toPortablePath(inputPath: string): string {
	return inputPath.split(path.sep).join("/");
}

function expectRecord(value: unknown, label: string, flowPath: string): Record<string, unknown> {
	if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
	throw new WorkflowPackageError(`${flowPath}: ${label} must be an object`);
}

function expectString(value: unknown, label: string, flowPath: string): string {
	if (typeof value === "string" && value.trim()) return value;
	throw new WorkflowPackageError(`${flowPath}: ${label} must be a non-empty string`);
}

function expectNumber(value: unknown, label: string, flowPath: string): number {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	throw new WorkflowPackageError(`${flowPath}: ${label} must be a finite number`);
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
