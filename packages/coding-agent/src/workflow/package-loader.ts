import * as fs from "node:fs/promises";
import * as path from "node:path";
import { YAML } from "bun";
import { parseWorkflowDefinition, type WorkflowDefinition } from "./definition";
import { compileWorkflowDslBlock, WorkflowDslError } from "./dsl";

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
	sourceMapping: WorkflowArtifactSourceMapping;
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
	const stat = await statWorkflowPath(inputPath);
	if (stat.isDirectory()) {
		throw new WorkflowPackageError(".omhflow artifact path must be a file");
	}
	const flowPath = inputPath;
	if (path.extname(flowPath) !== ".omhflow") {
		throw new WorkflowPackageError("workflow artifact file must use the .omhflow extension");
	}
	const source = await readWorkflowSource(flowPath);
	const metadata = parseFrontmatter(source, flowPath);
	const workflowBlocks = parseWorkflowBlocks(source, flowPath);
	if (workflowBlocks.length === 0) {
		throw new WorkflowPackageError(`${flowPath}: .omhflow must contain at least one fenced workflow block`);
	}
	const definition = parseWorkflowDefinition(
		JSON.stringify(definitionInput(metadata, workflowBlocks[0]!.value, flowPath)),
		{
			sourcePath: flowPath,
		},
	);
	return {
		flowPath,
		resourceDir: path.join(path.dirname(flowPath), path.basename(flowPath, ".omhflow")),
		source,
		metadata,
		definition,
		sourceMapping: {
			workflowBlocks: workflowBlocks.map(block => ({ id: block.id, language: block.language })),
			nodes: Object.fromEntries(definition.nodes.map(node => [node.id, { sourceBlock: workflowBlocks[0]!.id }])),
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

function definitionInput(
	metadata: WorkflowArtifactMetadata,
	block: Record<string, unknown>,
	flowPath?: string,
): Record<string, unknown> {
	try {
		const compiled = compileWorkflowDslBlock(block);
		return {
			name: metadata.name,
			version: metadata.version,
			models: compiled.models ?? metadata.models,
			nodes: compiled.nodes,
			edges: compiled.edges,
		};
	} catch (error) {
		if (error instanceof WorkflowDslError) {
			throw new WorkflowPackageError(flowPath ? `${flowPath}: ${error.message}` : error.message);
		}
		throw error;
	}
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
