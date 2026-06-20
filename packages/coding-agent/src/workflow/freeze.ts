import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseWorkflowChangeRequestFile } from "./change-request-file";
import type {
	WorkflowDefinition,
	WorkflowNode,
	WorkflowPromptSource,
	WorkflowTemplatePromptBindingSource,
} from "./definition";
import type { WorkflowArtifact } from "./package-loader";

export interface FlowFreeze {
	id: string;
	schemaVersion: string;
	flowPath: string;
	resourceDir: string;
	mainContentHash: string;
	resourceHashes: FlowFreezeResourceHash[];
	childWorkflowHashes?: FlowFreezeResourceHash[];
	resourceSnapshots: FlowFreezeResourceSnapshot[];
	canonicalGraphHash: string;
	sourceMapping: WorkflowArtifact["sourceMapping"];
	staticCheckReport: WorkflowStaticCheckReport;
	portableDefaults: WorkflowPortableDefaults;
	checkpointPolicy?: WorkflowCheckpointPolicy;
	changePolicy?: WorkflowChangePolicy;
	changeRequests?: WorkflowArtifact["changeRequests"];
	definition: WorkflowDefinition;
}

export interface WorkflowCheckpointPolicy {
	stopDeadlineMs: number;
}

export interface WorkflowChangePolicy {
	agentsCanPropose: boolean;
	humansCanApprove: boolean;
	supervisorsCanApprove?: boolean;
}

export interface FlowFreezeResourceHash {
	path: string;
	hash: string;
}

export interface FlowFreezeResourceSnapshot {
	path: string;
	hash: string;
	text: string;
	byteLength: number;
}

export interface WorkflowStaticCheckReport {
	status: "passed";
	checks: WorkflowStaticCheck[];
}

export interface WorkflowStaticCheck {
	name: string;
	status: "passed";
	details?: string[];
}

export interface WorkflowPortableDefaults {
	models: WorkflowDefinition["models"];
}

export class WorkflowFreezeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WorkflowFreezeError";
	}
}

export async function freezeWorkflowArtifact(artifact: WorkflowArtifact): Promise<FlowFreeze> {
	await ensureResourceDirectory(artifact.resourceDir);
	const freezeMetadata = validateFreezeMetadata(artifact);
	validateNodeRuntimeContracts(artifact.definition);
	const resourceReferences = collectResourceReferences(artifact);
	await validateReferencedResources(artifact.resourceDir, resourceReferences);
	await validateChildWorkflowReferences(artifact);
	await validateDeclaredChangeRequestFiles(artifact);
	const resourceHashes = await hashResourceDirectory(artifact.resourceDir);
	const resourceSnapshots = await snapshotReferencedResources(artifact.resourceDir, resourceReferences);
	const childWorkflowHashes = await hashChildWorkflowReferences(artifact);
	const canonicalGraphHash = contentHash(stableStringify(canonicalGraph(artifact.definition)));
	const mainContentHash = contentHash(artifact.source);
	const schemaVersion = artifact.metadata.schema;
	const id = `flowfreeze:${contentHash(
		stableStringify({
			schemaVersion,
			mainContentHash,
			resourceHashes,
			resourceSnapshots,
			childWorkflowHashes,
			canonicalGraphHash,
		}),
	).slice("sha256:".length)}`;
	const freeze: FlowFreeze = {
		id,
		schemaVersion,
		flowPath: artifact.flowPath,
		resourceDir: artifact.resourceDir,
		mainContentHash,
		resourceHashes,
		resourceSnapshots,
		canonicalGraphHash,
		sourceMapping: artifact.sourceMapping,
		staticCheckReport: buildStaticCheckReport(artifact.definition),
		portableDefaults: { models: artifact.definition.models },
		checkpointPolicy: freezeMetadata.checkpointPolicy,
		changePolicy: freezeMetadata.changePolicy,
		changeRequests: structuredClone(artifact.changeRequests),
		definition: structuredClone(artifact.definition),
	};
	if (childWorkflowHashes.length > 0) freeze.childWorkflowHashes = childWorkflowHashes;
	return freeze;
}

function buildStaticCheckReport(definition: WorkflowDefinition): WorkflowStaticCheckReport {
	const checks: WorkflowStaticCheck[] = [
		{ name: "parse", status: "passed" },
		{ name: "policy", status: "passed" },
		{ name: "resources", status: "passed" },
		{ name: "contracts", status: "passed" },
	];
	const stateSchemaCheck = workflowStateSchemaCheck(definition);
	if (stateSchemaCheck !== undefined) checks.push(stateSchemaCheck);
	const dynamicTopologyCheck = workflowDynamicTopologyCheck(definition);
	if (dynamicTopologyCheck !== undefined) checks.push(dynamicTopologyCheck);
	checks.push({ name: "canonical-graph", status: "passed" });
	return { status: "passed", checks };
}

function workflowStateSchemaCheck(definition: WorkflowDefinition): WorkflowStaticCheck | undefined {
	if (definition.stateSchema === undefined) return undefined;
	return {
		name: "state-schema",
		status: "passed",
		details: Object.entries(definition.stateSchema.shape)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([field, type]) => `${field}: ${type}`),
	};
}

function workflowDynamicTopologyCheck(definition: WorkflowDefinition): WorkflowStaticCheck | undefined {
	const details: string[] = [];
	for (const node of definition.nodes) {
		if (node.foreach !== undefined) {
			details.push(`foreach ${node.id} reads ${node.foreach.items} -> ${node.foreach.output.path}`);
			if (node.foreach.body.kind === "workflow") {
				details.push(`child workflow ${node.id} -> ${node.foreach.body.workflow.path}`);
			}
		}
		if (node.workflow !== undefined) details.push(`child workflow ${node.id} -> ${node.workflow.path}`);
	}
	if (details.length === 0) return undefined;
	return {
		name: "dynamic-topology",
		status: "passed",
		details,
	};
}

function validateFreezeMetadata(artifact: WorkflowArtifact): {
	checkpointPolicy: WorkflowCheckpointPolicy;
	changePolicy: WorkflowChangePolicy;
} {
	if (artifact.metadata.schema !== "omhflow/v1") {
		throw new WorkflowFreezeError(`unsupported .omhflow schema for production freeze: ${artifact.metadata.schema}`);
	}
	const checkpoint = expectRecord(
		artifact.metadata.checkpoint,
		".omhflow frontmatter must define checkpoint.stopDeadlineMs for production freeze",
	);
	if (
		typeof checkpoint.stopDeadlineMs !== "number" ||
		!Number.isFinite(checkpoint.stopDeadlineMs) ||
		checkpoint.stopDeadlineMs <= 0
	) {
		throw new WorkflowFreezeError(".omhflow frontmatter checkpoint.stopDeadlineMs must be a positive number");
	}
	const changePolicy = expectRecord(
		artifact.metadata.changePolicy,
		".omhflow frontmatter must define changePolicy for production freeze",
	);
	if (typeof changePolicy.agentsCanPropose !== "boolean") {
		throw new WorkflowFreezeError(".omhflow frontmatter changePolicy.agentsCanPropose must be a boolean");
	}
	if (typeof changePolicy.humansCanApprove !== "boolean") {
		throw new WorkflowFreezeError(".omhflow frontmatter changePolicy.humansCanApprove must be a boolean");
	}
	if (changePolicy.supervisorsCanApprove !== undefined && typeof changePolicy.supervisorsCanApprove !== "boolean") {
		throw new WorkflowFreezeError(
			".omhflow frontmatter changePolicy.supervisorsCanApprove must be a boolean when defined",
		);
	}
	const policy: WorkflowChangePolicy = {
		agentsCanPropose: changePolicy.agentsCanPropose,
		humansCanApprove: changePolicy.humansCanApprove,
	};
	if (changePolicy.supervisorsCanApprove !== undefined) {
		policy.supervisorsCanApprove = changePolicy.supervisorsCanApprove;
	}
	return {
		checkpointPolicy: { stopDeadlineMs: checkpoint.stopDeadlineMs },
		changePolicy: policy,
	};
}

function validateNodeRuntimeContracts(definition: WorkflowDefinition): void {
	for (const node of definition.nodes) {
		validateNodeRuntimeContract(node);
		if (node.foreach?.body.kind === "node") validateNodeRuntimeContract(node.foreach.body.node);
	}
	validateLoopProgressContracts(definition);
}

function validateNodeRuntimeContract(node: WorkflowNode): void {
	validateNodeStateScopes(node);
	validatePromptReadScope(node);
	if (node.type === "script" && !node.script?.code && !node.script?.file) {
		throw new WorkflowFreezeError(
			`workflow script node "${node.id}" must define inline code or a script file before production freeze`,
		);
	}
	if (node.type === "agent" && !node.agent) {
		throw new WorkflowFreezeError(`workflow agent node "${node.id}" must define an agent before production freeze`);
	}
	if ((node.type === "human" || node.type === "review") && !node.promptSource && !node.prompt?.trim()) {
		throw new WorkflowFreezeError(
			`workflow ${node.type} node "${node.id}" must define a prompt before production freeze`,
		);
	}
}

function validateNodeStateScopes(node: WorkflowNode): void {
	for (const readScope of node.reads ?? []) {
		if (!isJsonPointer(readScope)) {
			throw new WorkflowFreezeError(`workflow node "${node.id}" read scope must be a JSON pointer: ${readScope}`);
		}
	}
	for (const writeScope of node.writes ?? []) {
		if (!isJsonPointer(writeScope)) {
			throw new WorkflowFreezeError(`workflow node "${node.id}" write scope must be a JSON pointer: ${writeScope}`);
		}
	}
}

function validatePromptReadScope(node: WorkflowNode): void {
	for (const promptPath of promptReadPaths(node.promptSource)) {
		if (statePathWithinScopes(promptPath, node.reads)) continue;
		throw new WorkflowFreezeError(
			`workflow node "${node.id}" prompt reads "${promptPath}" outside declared read scopes`,
		);
	}
}

function promptReadPaths(source: WorkflowPromptSource | undefined): string[] {
	if (source === undefined) return [];
	if (source.kind === "state" || source.kind === "human" || source.kind === "output") return [source.path];
	if (source.kind !== "template") return [];
	return Object.values(source.bindings).flatMap(templateBindingReadPaths);
}

function templateBindingReadPaths(source: WorkflowTemplatePromptBindingSource): string[] {
	if (source.kind === "state" || source.kind === "human" || source.kind === "output") return [source.path];
	return [];
}

function statePathWithinScopes(pointer: string, scopes: string[] | undefined): boolean {
	if (scopes === undefined) return true;
	return scopes.some(scope => scope === "/" || pointer === scope || pointer.startsWith(`${scope}/`));
}

function isJsonPointer(value: string): boolean {
	return value.startsWith("/");
}

function validateLoopProgressContracts(definition: WorkflowDefinition): void {
	const nodeById = new Map(definition.nodes.map(node => [node.id, node]));
	for (const component of stronglyConnectedNodeComponents(definition)) {
		if (!componentHasCycle(component, definition)) continue;
		if (!component.every(nodeId => nodeById.get(nodeId)?.type === "script")) continue;
		throw new WorkflowFreezeError(
			`workflow script-only loop "${component.sort().join(" -> ")}" cannot prove meaningful progress before production freeze; include an agent, review, or human node, or move wall-clock waiting outside the workflow graph`,
		);
	}
}

function componentHasCycle(component: string[], definition: WorkflowDefinition): boolean {
	if (component.length > 1) return true;
	const nodeId = component[0];
	return definition.edges.some(edge => edge.from === nodeId && edge.to === nodeId);
}

function stronglyConnectedNodeComponents(definition: WorkflowDefinition): string[][] {
	const adjacency = new Map<string, string[]>();
	for (const node of definition.nodes) adjacency.set(node.id, []);
	for (const edge of definition.edges) adjacency.get(edge.from)?.push(edge.to);
	for (const targets of adjacency.values()) targets.sort((left, right) => left.localeCompare(right));

	const indexByNode = new Map<string, number>();
	const lowLinkByNode = new Map<string, number>();
	const stack: string[] = [];
	const onStack = new Set<string>();
	const components: string[][] = [];
	let nextIndex = 0;

	const visit = (nodeId: string): void => {
		indexByNode.set(nodeId, nextIndex);
		lowLinkByNode.set(nodeId, nextIndex);
		nextIndex += 1;
		stack.push(nodeId);
		onStack.add(nodeId);

		for (const targetId of adjacency.get(nodeId) ?? []) {
			if (!indexByNode.has(targetId)) {
				visit(targetId);
				lowLinkByNode.set(nodeId, Math.min(lowLinkByNode.get(nodeId) ?? 0, lowLinkByNode.get(targetId) ?? 0));
				continue;
			}
			if (onStack.has(targetId)) {
				lowLinkByNode.set(nodeId, Math.min(lowLinkByNode.get(nodeId) ?? 0, indexByNode.get(targetId) ?? 0));
			}
		}

		if (lowLinkByNode.get(nodeId) !== indexByNode.get(nodeId)) return;
		const component: string[] = [];
		while (stack.length > 0) {
			const stackedNodeId = stack.pop();
			if (stackedNodeId === undefined) break;
			onStack.delete(stackedNodeId);
			component.push(stackedNodeId);
			if (stackedNodeId === nodeId) break;
		}
		components.push(component);
	};

	for (const node of definition.nodes) {
		if (!indexByNode.has(node.id)) visit(node.id);
	}
	return components;
}

function expectRecord(value: unknown, message: string): Record<string, unknown> {
	if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
	throw new WorkflowFreezeError(message);
}

async function ensureResourceDirectory(resourceDir: string): Promise<void> {
	try {
		const stat = await fs.stat(resourceDir);
		if (stat.isDirectory()) return;
		throw new WorkflowFreezeError(`workflow resource directory is not a directory: ${resourceDir}`);
	} catch (error) {
		if (error instanceof WorkflowFreezeError) throw error;
		throw new WorkflowFreezeError(`workflow same-name resource directory is not readable: ${resourceDir}`);
	}
}

async function validateReferencedResources(resourceDir: string, references: string[]): Promise<void> {
	for (const reference of references) {
		await resolveResourcePath(resourceDir, reference);
	}
}

async function validateDeclaredChangeRequestFiles(artifact: WorkflowArtifact): Promise<void> {
	for (const request of artifact.changeRequests) {
		const resolved = await resolveResourcePath(artifact.resourceDir, request.path);
		let raw: unknown;
		try {
			raw = await Bun.file(resolved).json();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new WorkflowFreezeError(`${request.path}: workflow change request file must parse as JSON: ${message}`);
		}
		try {
			parseWorkflowChangeRequestFile(raw, request.path);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new WorkflowFreezeError(message);
		}
	}
}

function collectResourceReferences(artifact: WorkflowArtifact): string[] {
	const references: string[] = [];
	const definition = artifact.definition;
	for (const node of definition.nodes) {
		references.push(...collectNodeResourceReferences(node));
		if (node.foreach?.body.kind === "node") references.push(...collectNodeResourceReferences(node.foreach.body.node));
	}
	for (const resource of definition.resources ?? []) references.push(resource.path);
	for (const request of artifact.changeRequests) references.push(request.path);
	return references;
}

function collectNodeResourceReferences(node: WorkflowNode): string[] {
	const references: string[] = [];
	if (node.promptSource?.kind === "file") {
		references.push(node.promptSource.path);
	}
	if (node.promptSource?.kind === "template") {
		references.push(node.promptSource.file);
	}
	if (node.script?.file) {
		references.push(node.script.file);
	}
	return references;
}

async function validateChildWorkflowReferences(artifact: WorkflowArtifact): Promise<void> {
	for (const node of artifact.definition.nodes) {
		if (node.workflow !== undefined) {
			await validateChildWorkflowReference(artifact.flowPath, node.id, node.workflow.path);
		}
		if (node.foreach?.body.kind === "workflow") {
			await validateChildWorkflowReference(artifact.flowPath, node.id, node.foreach.body.workflow.path);
		}
	}
}

async function hashChildWorkflowReferences(artifact: WorkflowArtifact): Promise<FlowFreezeResourceHash[]> {
	const root = path.dirname(artifact.flowPath);
	const hashes: FlowFreezeResourceHash[] = [];
	const seen = new Set<string>();
	for (const childPath of collectChildWorkflowReferences(artifact.definition)) {
		const resolved = path.resolve(root, childPath);
		const relative = path.relative(root, resolved).split(path.sep).join("/");
		if (seen.has(relative)) continue;
		seen.add(relative);
		hashes.push({
			path: relative,
			hash: await fileHash(resolved),
		});
	}
	return hashes.sort((left, right) => left.path.localeCompare(right.path));
}

function collectChildWorkflowReferences(definition: WorkflowDefinition): string[] {
	const references: string[] = [];
	for (const node of definition.nodes) {
		if (node.workflow !== undefined) references.push(node.workflow.path);
		if (node.foreach?.body.kind === "workflow") references.push(node.foreach.body.workflow.path);
	}
	return references;
}

async function validateChildWorkflowReference(flowPath: string, nodeId: string, childPath: string): Promise<void> {
	const resolved = path.resolve(path.dirname(flowPath), childPath);
	if (path.extname(resolved) !== ".omhflow") {
		throw new WorkflowFreezeError(`workflow child node "${nodeId}" must reference a .omhflow file: "${childPath}"`);
	}
	try {
		const stat = await fs.stat(resolved);
		if (stat.isFile()) return;
	} catch {
		throw new WorkflowFreezeError(`workflow child node "${nodeId}" references unreadable child flow "${childPath}"`);
	}
	throw new WorkflowFreezeError(`workflow child node "${nodeId}" references unreadable child flow "${childPath}"`);
}

async function resolveResourcePath(resourceDir: string, resourcePath: string): Promise<string> {
	if (path.isAbsolute(resourcePath)) {
		throw new WorkflowFreezeError(
			`workflow resource path "${resourcePath}" escapes the same-name resource directory`,
		);
	}
	const root = path.resolve(resourceDir);
	const resolved = path.resolve(root, resourcePath);
	const relative = path.relative(root, resolved);
	if (relative.startsWith("..") || path.isAbsolute(relative)) {
		throw new WorkflowFreezeError(
			`workflow resource path "${resourcePath}" escapes the same-name resource directory`,
		);
	}
	try {
		const stat = await fs.stat(resolved);
		if (stat.isFile()) return resolved;
	} catch {
		throw new WorkflowFreezeError(
			`workflow resource path "${resourcePath}" was not found in the same-name resource directory`,
		);
	}
	throw new WorkflowFreezeError(
		`workflow resource path "${resourcePath}" was not found in the same-name resource directory`,
	);
}

async function snapshotReferencedResources(
	resourceDir: string,
	references: string[],
): Promise<FlowFreezeResourceSnapshot[]> {
	const root = path.resolve(resourceDir);
	const snapshots: FlowFreezeResourceSnapshot[] = [];
	const seen = new Set<string>();
	for (const reference of references) {
		const resolved = await resolveResourcePath(root, reference);
		const relative = path.relative(root, resolved).split(path.sep).join("/");
		if (seen.has(relative)) continue;
		seen.add(relative);
		const text = await Bun.file(resolved).text();
		snapshots.push({
			path: relative,
			hash: contentHash(text),
			text,
			byteLength: new TextEncoder().encode(text).byteLength,
		});
	}
	return snapshots.sort((left, right) => left.path.localeCompare(right.path));
}

async function hashResourceDirectory(resourceDir: string): Promise<FlowFreezeResourceHash[]> {
	const root = path.resolve(resourceDir);
	const files = await listFiles(root);
	const hashes: FlowFreezeResourceHash[] = [];
	for (const filePath of files) {
		const relative = path.relative(root, filePath).split(path.sep).join("/");
		hashes.push({ path: relative, hash: await fileHash(filePath) });
	}
	return hashes.sort((left, right) => left.path.localeCompare(right.path));
}

async function listFiles(dir: string): Promise<string[]> {
	const entries = await fs.readdir(dir, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const entryPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await listFiles(entryPath)));
			continue;
		}
		if (entry.isFile()) {
			files.push(entryPath);
		}
	}
	return files;
}

async function fileHash(filePath: string): Promise<string> {
	return contentHash(await Bun.file(filePath).arrayBuffer());
}

function contentHash(value: string | ArrayBuffer): string {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(value);
	return `sha256:${hasher.digest("hex")}`;
}

function canonicalGraph(definition: WorkflowDefinition): Record<string, unknown> {
	return {
		name: definition.name,
		version: definition.version,
		models: definition.models,
		stateSchema: definition.stateSchema,
		resources: definition.resources,
		capabilities: definition.capabilities,
		migrations: definition.migrations,
		nodes: definition.nodes.map(canonicalNode).sort((left, right) => left.id.localeCompare(right.id)),
		edges: [...definition.edges].sort((left, right) =>
			`${left.from}\0${left.to}`.localeCompare(`${right.from}\0${right.to}`),
		),
	};
}

function canonicalNode(node: WorkflowNode): WorkflowNode {
	return structuredClone(node);
}

function stableStringify(value: unknown): string {
	if (value === null) return "null";
	if (typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(entry => stableStringify(entry)).join(",")}]`;
	if (typeof value === "object") {
		const record = value as Record<string, unknown>;
		const entries = Object.keys(record)
			.sort()
			.filter(key => record[key] !== undefined)
			.map(key => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
		return `{${entries.join(",")}}`;
	}
	return JSON.stringify(null);
}
