export interface WorkflowDslCompileResult {
	nodes: unknown;
	edges: Record<string, unknown>[];
	entries: string[];
	exits: WorkflowDslCompileExit[];
	models?: unknown;
	stateSchema?: unknown;
	resources?: unknown;
	capabilities?: unknown;
	migrations?: unknown;
	subflows?: unknown;
	checkpointPolicy?: unknown;
	changePolicy?: unknown;
	changeRequests?: unknown;
}

export interface WorkflowDslCompileExit {
	nodeId: string;
	condition?: string;
}

export interface WorkflowDslExternalModule {
	name?: string;
	version?: number;
	nodes: Record<string, Record<string, unknown>>;
	edges: Record<string, unknown>[];
	entries?: string[];
	exits?: WorkflowDslCompileExit[];
	resources?: Record<string, unknown>[];
	capabilities?: Record<string, unknown>;
	resourcePrefix?: string;
}

export interface WorkflowDslCompileOptions {
	externalModules?: Record<string, WorkflowDslExternalModule>;
}

interface CompileResult {
	entries: string[];
	exits: WorkflowDslCompileExit[];
}

export class WorkflowDslError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WorkflowDslError";
	}
}

export function compileWorkflowDslBlock(
	block: Record<string, unknown>,
	options: WorkflowDslCompileOptions = {},
): WorkflowDslCompileResult {
	if (block.nodes !== undefined) {
		const nodes = block.nodes;
		const edges = expectArray(block.edges ?? [], "workflow block edges").map(edge =>
			expectRecord(edge, "workflow block edge"),
		);
		const graphBoundary = inferRawGraphBoundary(nodes, edges);
		const result: WorkflowDslCompileResult = {
			nodes,
			edges,
			entries: graphBoundary.entries,
			exits: graphBoundary.exits,
			models: block.models,
		};
		addWorkflowContracts(result, block);
		return result;
	}
	const compiler = new WorkflowDslCompiler(block, options.externalModules ?? {});
	const result = compiler.compileStep(block, "workflow");
	if (result.entries.length === 0) {
		throw new WorkflowDslError("workflow DSL must compile to at least one entry node");
	}
	const compiled: WorkflowDslCompileResult = {
		nodes: compiler.nodesRecord(),
		edges: compiler.sortedEdges(),
		entries: result.entries,
		exits: result.exits,
		models: block.models,
	};
	addWorkflowContracts(compiled, block);
	mergeExternalContracts(compiled, compiler.externalResources, compiler.externalCapabilities);
	if (compiler.externalSubflows.length > 0) compiled.subflows = compiler.externalSubflows;
	return compiled;
}

function addWorkflowContracts(result: WorkflowDslCompileResult, block: Record<string, unknown>): void {
	if (block.stateSchema !== undefined) result.stateSchema = block.stateSchema;
	if (block.resources !== undefined) result.resources = block.resources;
	if (block.capabilities !== undefined) result.capabilities = block.capabilities;
	if (block.migrations !== undefined) result.migrations = block.migrations;
	if (block.checkpoint_policy !== undefined) result.checkpointPolicy = block.checkpoint_policy;
	if (block.change_policy !== undefined) result.changePolicy = block.change_policy;
	if (block.change_request !== undefined && block.change_requests !== undefined) {
		throw new WorkflowDslError("workflow block must not define both change_request and change_requests");
	}
	if (block.change_request !== undefined) result.changeRequests = block.change_request;
	if (block.change_requests !== undefined) result.changeRequests = block.change_requests;
}

class WorkflowDslCompiler {
	#nodes = new Map<string, Record<string, unknown>>();
	#moduleStack = new Set<string>();
	#externalModuleStack = new Set<string>();
	readonly edges: Record<string, unknown>[] = [];
	readonly modules: Record<string, unknown>;
	readonly externalResources: Record<string, unknown>[] = [];
	readonly externalCapabilities: Record<string, unknown>[] = [];
	readonly externalSubflows: Record<string, unknown>[] = [];
	readonly externalModules: Record<string, WorkflowDslExternalModule>;

	constructor(block: Record<string, unknown>, externalModules: Record<string, WorkflowDslExternalModule>) {
		this.modules = block.modules === undefined ? {} : expectRecord(block.modules, "workflow modules");
		this.externalModules = externalModules;
	}

	nodesRecord(): Record<string, unknown> {
		return Object.fromEntries(this.#nodes);
	}

	sortedEdges(): Record<string, unknown>[] {
		const order = new Map([...this.#nodes.keys()].map((nodeId, index) => [nodeId, index]));
		return [...this.edges].sort((left, right) => compareEdges(left, right, order));
	}

	compileStep(rawStep: unknown, path: string): CompileResult {
		const step = expectRecord(rawStep, path);
		if (step.use !== undefined) {
			const moduleName = expectString(step.use, `${path}.use`);
			const module = this.modules[moduleName];
			if (module !== undefined) {
				if (this.#moduleStack.has(moduleName)) {
					throw new WorkflowDslError(`${path}.use creates a module cycle at "${moduleName}"`);
				}
				this.#moduleStack.add(moduleName);
				try {
					return this.compileStep(module, `modules.${moduleName}`);
				} finally {
					this.#moduleStack.delete(moduleName);
				}
			}
			const externalModule = this.externalModules[moduleName];
			if (externalModule !== undefined) {
				return this.compileExternalModule(moduleName, externalModule, path);
			}
			throw new WorkflowDslError(`${path}.use references unknown module "${moduleName}"`);
		}
		if (step.sequence !== undefined) {
			return this.compileSequence(expectArray(step.sequence, `${path}.sequence`), `${path}.sequence`);
		}
		if (step.parallel !== undefined) {
			return this.compileParallel(step, path);
		}
		if (step.template !== undefined) {
			return this.compileTemplate(step.template, `${path}.template`);
		}
		if (step.node !== undefined) {
			return this.compileNode(step.node, `${path}.node`);
		}
		throw new WorkflowDslError(`${path} must define one of node, sequence, parallel, template, or use`);
	}

	compileSequence(steps: unknown[], path: string): CompileResult {
		let entries: string[] = [];
		let previousExits: WorkflowDslCompileExit[] = [];
		for (let index = 0; index < steps.length; index += 1) {
			const compiled = this.compileStep(steps[index], `${path}.${index}`);
			if (compiled.entries.length === 0) continue;
			if (entries.length === 0) entries = compiled.entries;
			for (const from of previousExits) {
				for (const to of compiled.entries) {
					this.pushEdgeFromExit(from, to);
				}
			}
			previousExits = compiled.exits;
		}
		return { entries, exits: previousExits };
	}

	compileParallel(step: Record<string, unknown>, path: string): CompileResult {
		const branches = expectArray(step.parallel, `${path}.parallel`);
		const compiledBranches = branches.map((branch, index) => this.compileStep(branch, `${path}.parallel.${index}`));
		const entries = compiledBranches.flatMap(branch => branch.entries);
		let exits = compiledBranches.flatMap(branch => branch.exits);
		if (step.join !== undefined) {
			const joinNode = this.normalizeNode(step.join, `${path}.join`);
			joinNode.waitFor = exits.map(exit => exit.nodeId);
			this.addNode(joinNode, `${path}.join`);
			for (const exit of exits) {
				this.pushEdgeFromExit(exit, joinNode.id);
			}
			exits = [nodeExit(joinNode.id)];
		}
		return { entries, exits };
	}

	compileNode(rawNode: unknown, path: string): CompileResult {
		const node = this.normalizeNode(rawNode, path);
		this.addNode(node, path);
		return { entries: [node.id], exits: [nodeExit(node.id)] };
	}

	compileExternalModule(moduleName: string, externalModule: WorkflowDslExternalModule, path: string): CompileResult {
		if (this.#externalModuleStack.has(moduleName)) {
			throw new WorkflowDslError(`${path}.use creates an imported module cycle at "${moduleName}"`);
		}
		this.#externalModuleStack.add(moduleName);
		try {
			const prefix = `${moduleName}__`;
			const originalNodeIds = new Set(Object.keys(externalModule.nodes));
			for (const [nodeId, rawNode] of Object.entries(externalModule.nodes)) {
				const node = namespaceExternalNode(rawNode, prefix, originalNodeIds, externalModule.resourcePrefix);
				this.addNode(node, `${path}.use(${moduleName}).nodes.${nodeId}`);
			}
			for (const rawEdge of externalModule.edges) {
				this.edges.push(namespaceExternalEdge(rawEdge, prefix, originalNodeIds));
			}
			if (externalModule.resources) this.externalResources.push(...externalModule.resources);
			if (externalModule.capabilities) this.externalCapabilities.push(externalModule.capabilities);
			const boundary = externalModuleEntrypoints(externalModule, prefix, originalNodeIds);
			this.externalSubflows.push(
				externalModuleSubflow(moduleName, externalModule, prefix, originalNodeIds, boundary),
			);
			return boundary;
		} finally {
			this.#externalModuleStack.delete(moduleName);
		}
	}

	compileTemplate(rawTemplate: unknown, path: string): CompileResult {
		const template = expectRecord(rawTemplate, path);
		const kind = expectString(template.kind, `${path}.kind`);
		if (kind === "review_gate") return this.compileReviewGateTemplate(template, path);
		if (kind === "parallel_search") return this.compileParallelSearchTemplate(template, path);
		if (kind === "retry_until") return this.compileRetryUntilTemplate(template, path);
		if (kind === "mapped_worker_verifier_pool") return this.compileMappedWorkerVerifierPoolTemplate(template, path);
		throw new WorkflowDslError(
			`${path}.kind must be review_gate, parallel_search, retry_until, or mapped_worker_verifier_pool`,
		);
	}

	compileReviewGateTemplate(template: Record<string, unknown>, path: string): CompileResult {
		const node = this.normalizeNode({ ...template, type: template.type ?? "review", kind: undefined }, path);
		this.addNode(node, path);
		return { entries: [node.id], exits: [nodeExit(node.id)] };
	}

	compileParallelSearchTemplate(template: Record<string, unknown>, path: string): CompileResult {
		const branches = expectArray(template.branches, `${path}.branches`);
		const compiledBranches = branches.map((branch, index) =>
			this.compileTemplateBranch(branch, `${path}.branches.${index}`),
		);
		const entries = compiledBranches.flatMap(branch => branch.entries);
		let exits = compiledBranches.flatMap(branch => branch.exits);
		const joinNode = this.normalizeNode(template.join, `${path}.join`);
		joinNode.waitFor = exits.map(exit => exit.nodeId);
		this.addNode(joinNode, `${path}.join`);
		for (const exit of exits) this.pushEdgeFromExit(exit, joinNode.id);
		exits = [nodeExit(joinNode.id)];
		return { entries, exits };
	}

	compileRetryUntilTemplate(template: Record<string, unknown>, path: string): CompileResult {
		const body = this.compileTemplateBranch(template.body, `${path}.body`);
		const reviewNode = this.normalizeNode(
			{ ...expectRecord(template.review, `${path}.review`), type: template.reviewType ?? "review" },
			`${path}.review`,
		);
		this.addNode(reviewNode, `${path}.review`);
		for (const exit of body.exits) this.pushEdgeFromExit(exit, reviewNode.id);
		const retryWhen = expectString(template.retryWhen, `${path}.retryWhen`);
		for (const entry of body.entries) this.edges.push({ from: reviewNode.id, to: entry, when: retryWhen });
		return { entries: body.entries, exits: [{ nodeId: reviewNode.id, condition: negateCondition(retryWhen) }] };
	}

	compileMappedWorkerVerifierPoolTemplate(template: Record<string, unknown>, path: string): CompileResult {
		const poolId = expectString(template.id, `${path}.id`);
		const itemSource = expectJsonPointer(template.itemSource, `${path}.itemSource`);
		const itemKey = expectJsonPointer(template.itemKey, `${path}.itemKey`);
		const maxConcurrency = expectPositiveInteger(template.maxConcurrency, `${path}.maxConcurrency`);
		const maxItems = expectPositiveInteger(template.maxItems, `${path}.maxItems`);
		const workerNode = expectRecord(template.worker, `${path}.worker`);
		const verifierNode = expectRecord(template.verifier, `${path}.verifier`);
		const reducerNode = expectRecord(template.reducer, `${path}.reducer`);
		const workerNodeId = `${poolId}.${expectString(workerNode.id, `${path}.worker.id`)}`;
		const verifierNodeId = `${poolId}.${expectString(verifierNode.id, `${path}.verifier.id`)}`;
		const reducerNodeId = `${poolId}.${expectString(reducerNode.id, `${path}.reducer.id`)}`;
		const normalizeInternalNode = (
			raw: Record<string, unknown>,
			nodePath: string,
			id: string,
		): Record<string, unknown> & { id: string } => {
			const normalized = this.normalizeNode({ ...raw, id }, nodePath);
			return normalized;
		};
		this.addNode(normalizeInternalNode(workerNode, `${path}.worker`, workerNodeId), `${path}.worker`);
		this.addNode(normalizeInternalNode(verifierNode, `${path}.verifier`, verifierNodeId), `${path}.verifier`);
		this.addNode(normalizeInternalNode(reducerNode, `${path}.reducer`, reducerNodeId), `${path}.reducer`);
		const poolNode: Record<string, unknown> = {
			id: poolId,
			type: "mapped_pool",
			mappedPool: {
				itemSource,
				itemKey,
				maxConcurrency,
				maxItems,
				worker: workerNodeId,
				verifier: verifierNodeId,
				reducer: reducerNodeId,
			},
		};
		if (template.stopWhen !== undefined) {
			poolNode.mappedPool = {
				...(poolNode.mappedPool as Record<string, unknown>),
				stopWhen: expectString(template.stopWhen, `${path}.stopWhen`),
			};
		}
		this.addNode(poolNode as Record<string, unknown> & { id: string }, path);
		return { entries: [poolId], exits: [nodeExit(poolId)] };
	}

	compileTemplateBranch(rawBranch: unknown, path: string): CompileResult {
		const branch = expectRecord(rawBranch, path);
		if (
			branch.node !== undefined ||
			branch.sequence !== undefined ||
			branch.parallel !== undefined ||
			branch.template !== undefined ||
			branch.use !== undefined
		) {
			return this.compileStep(branch, path);
		}
		return this.compileNode(branch, path);
	}

	normalizeNode(rawNode: unknown, path: string): Record<string, unknown> & { id: string } {
		const node = { ...expectRecord(rawNode, path) };
		const id = expectString(node.id, `${path}.id`);
		return { ...node, id };
	}

	addNode(node: Record<string, unknown> & { id: string }, path: string): void {
		if (this.#nodes.has(node.id)) throw new WorkflowDslError(`${path} duplicates node id "${node.id}"`);
		this.#nodes.set(node.id, node);
	}

	pushEdgeFromExit(exit: WorkflowDslCompileExit, to: string): void {
		const edge: Record<string, unknown> = { from: exit.nodeId, to };
		if (exit.condition !== undefined) edge.when = exit.condition;
		this.edges.push(edge);
	}
}

function nodeExit(nodeId: string): WorkflowDslCompileExit {
	return { nodeId };
}

function namespaceExternalNode(
	rawNode: Record<string, unknown>,
	prefix: string,
	knownNodeIds: Set<string>,
	resourcePrefix?: string,
): Record<string, unknown> & { id: string } {
	const node = structuredClone(rawNode) as Record<string, unknown>;
	const id = expectString(node.id, "imported node id");
	node.id = `${prefix}${id}`;
	const waitFor = node.waitFor;
	if (Array.isArray(waitFor)) {
		node.waitFor = waitFor.map(value => (typeof value === "string" ? `${prefix}${value}` : value));
	}
	const promptSource = node.promptSource;
	if (isRecord(promptSource)) {
		node.promptSource = namespacePromptSource(promptSource, prefix, knownNodeIds, resourcePrefix);
	}
	const prompt = node.prompt;
	if (isRecord(prompt)) {
		node.prompt = namespaceRawPrompt(prompt, prefix, knownNodeIds, resourcePrefix);
	}
	const script = node.script;
	if (isRecord(script) && typeof script.file === "string" && resourcePrefix) {
		node.script = { ...script, file: joinResourcePath(resourcePrefix, script.file) };
	}
	return node as Record<string, unknown> & { id: string };
}

function namespacePromptSource(
	promptSource: Record<string, unknown>,
	prefix: string,
	knownNodeIds: Set<string>,
	resourcePrefix?: string,
): Record<string, unknown> {
	const source = { ...promptSource };
	if (source.kind === "output" && typeof source.node === "string" && knownNodeIds.has(source.node)) {
		source.node = `${prefix}${source.node}`;
	}
	if (source.kind === "file" && typeof source.path === "string" && resourcePrefix) {
		source.path = joinResourcePath(resourcePrefix, source.path);
	}
	if (source.kind === "template") {
		if (typeof source.file === "string" && resourcePrefix) {
			source.file = joinResourcePath(resourcePrefix, source.file);
		}
		const bindings = source.bindings;
		if (isRecord(bindings)) {
			source.bindings = namespaceTemplatePromptBindings(bindings, prefix, knownNodeIds);
		}
	}
	return source;
}

function namespaceRawPrompt(
	prompt: Record<string, unknown>,
	prefix: string,
	knownNodeIds: Set<string>,
	resourcePrefix?: string,
): Record<string, unknown> {
	const source = { ...prompt };
	if (typeof source.file === "string" && resourcePrefix) {
		source.file = joinResourcePath(resourcePrefix, source.file);
	}
	const template = source.template;
	if (isRecord(template)) {
		source.template = namespaceRawTemplatePrompt(template, prefix, knownNodeIds, resourcePrefix);
	}
	const output = source.output;
	if (isRecord(output) && typeof output.node === "string" && knownNodeIds.has(output.node)) {
		source.output = { ...output, node: `${prefix}${output.node}` };
	}
	return source;
}

function namespaceRawTemplatePrompt(
	template: Record<string, unknown>,
	prefix: string,
	knownNodeIds: Set<string>,
	resourcePrefix?: string,
): Record<string, unknown> {
	const next = { ...template };
	if (typeof next.file === "string" && resourcePrefix) {
		next.file = joinResourcePath(resourcePrefix, next.file);
	}
	const bindings = next.bindings;
	if (isRecord(bindings)) {
		next.bindings = namespaceTemplatePromptBindings(bindings, prefix, knownNodeIds);
	}
	return next;
}

function namespaceTemplatePromptBindings(
	bindings: Record<string, unknown>,
	prefix: string,
	knownNodeIds: Set<string>,
): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(bindings).map(([name, binding]) => [
			name,
			isRecord(binding) ? namespaceTemplatePromptBinding(binding, prefix, knownNodeIds) : binding,
		]),
	);
}

function namespaceTemplatePromptBinding(
	binding: Record<string, unknown>,
	prefix: string,
	knownNodeIds: Set<string>,
): Record<string, unknown> {
	const next = { ...binding };
	if (next.kind === "output" && typeof next.node === "string" && knownNodeIds.has(next.node)) {
		next.node = `${prefix}${next.node}`;
	}
	const output = next.output;
	if (isRecord(output) && typeof output.node === "string" && knownNodeIds.has(output.node)) {
		next.output = { ...output, node: `${prefix}${output.node}` };
	}
	return next;
}

function namespaceExternalEdge(
	rawEdge: Record<string, unknown>,
	prefix: string,
	knownNodeIds: Set<string>,
): Record<string, unknown> {
	const edge: Record<string, unknown> = {
		from: `${prefix}${expectString(rawEdge.from, "imported edge from")}`,
		to: `${prefix}${expectString(rawEdge.to, "imported edge to")}`,
	};
	const when = importedEdgeCondition(rawEdge);
	if (when !== undefined) edge.when = namespaceOutputConditionReferences(when, prefix, knownNodeIds);
	if (typeof rawEdge.label === "string") edge.label = rawEdge.label;
	return edge;
}

function namespaceOutputConditionReferences(source: string, prefix: string, knownNodeIds: Set<string>): string {
	let result = source;
	for (const nodeId of [...knownNodeIds].sort((left, right) => right.length - left.length)) {
		result = result.replaceAll(outputConditionReferencePattern(nodeId), `outputs.${prefix}${nodeId}.`);
	}
	return result;
}

function outputConditionReferencePattern(nodeId: string): RegExp {
	return new RegExp(`\\boutputs\\.${escapeRegExp(nodeId)}\\.`, "gu");
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function importedEdgeCondition(edge: Record<string, unknown>): string | undefined {
	if (typeof edge.when === "string") return edge.when;
	const condition = edge.condition;
	if (isRecord(condition) && typeof condition.source === "string") return condition.source;
	return undefined;
}

function externalModuleSubflow(
	alias: string,
	module: WorkflowDslExternalModule,
	prefix: string,
	knownNodeIds: Set<string>,
	boundary: CompileResult,
): Record<string, unknown> {
	const subflow: Record<string, unknown> = {
		alias,
		name: module.name ?? alias,
		version: module.version ?? 1,
		namespace: prefix,
		nodeIds: [...knownNodeIds].map(nodeId => `${prefix}${nodeId}`),
		entryNodeIds: boundary.entries,
		exitNodeIds: boundary.exits.map(exit => exit.nodeId),
	};
	if (module.resourcePrefix !== undefined && module.resourcePrefix !== ".")
		subflow.resourcePrefix = module.resourcePrefix;
	return subflow;
}

function externalModuleEntrypoints(
	module: WorkflowDslExternalModule,
	prefix: string,
	knownNodeIds: Set<string>,
): CompileResult {
	if (module.entries !== undefined && module.exits !== undefined) {
		return {
			entries: module.entries.map(nodeId => `${prefix}${nodeId}`),
			exits: module.exits.map(exit => {
				const compiled: WorkflowDslCompileExit = { nodeId: `${prefix}${exit.nodeId}` };
				if (exit.condition !== undefined) {
					compiled.condition = namespaceOutputConditionReferences(exit.condition, prefix, knownNodeIds);
				}
				return compiled;
			}),
		};
	}
	const nodeIds = Object.keys(module.nodes);
	const targeted = new Set<string>();
	const outgoing = new Map<string, Array<string | undefined>>();
	for (const edge of module.edges) {
		if (typeof edge.from === "string") {
			const conditions = outgoing.get(edge.from) ?? [];
			conditions.push(importedEdgeCondition(edge));
			outgoing.set(edge.from, conditions);
		}
		if (typeof edge.to === "string") targeted.add(edge.to);
	}
	for (const node of Object.values(module.nodes)) {
		if (Array.isArray(node.waitFor) && node.waitFor.length > 0 && typeof node.id === "string") {
			targeted.add(node.id);
		}
	}
	const entries = nodeIds.filter(nodeId => !targeted.has(nodeId)).map(nodeId => `${prefix}${nodeId}`);
	const exits = nodeIds.flatMap(nodeId => externalModuleNodeExits(nodeId, outgoing.get(nodeId), prefix, knownNodeIds));
	return { entries, exits };
}

function externalModuleNodeExits(
	nodeId: string,
	outgoingConditions: Array<string | undefined> | undefined,
	prefix: string,
	knownNodeIds: Set<string>,
): WorkflowDslCompileExit[] {
	if (outgoingConditions === undefined || outgoingConditions.length === 0) return [nodeExit(`${prefix}${nodeId}`)];
	const negatedConditions: string[] = [];
	for (const condition of outgoingConditions) {
		if (condition === undefined) return [];
		negatedConditions.push(`!(${namespaceOutputConditionReferences(condition, prefix, knownNodeIds)})`);
	}
	return [
		{
			nodeId: `${prefix}${nodeId}`,
			condition: negatedConditions.join(" && "),
		},
	];
}

function mergeExternalContracts(
	result: WorkflowDslCompileResult,
	resources: Record<string, unknown>[],
	capabilities: Record<string, unknown>[],
): void {
	if (resources.length > 0) {
		result.resources = [...optionalRecordArray(result.resources, "workflow resources"), ...resources];
	}
	if (capabilities.length > 0) {
		result.capabilities = mergeCapabilities(result.capabilities, capabilities);
	}
}

function optionalRecordArray(value: unknown, label: string): Record<string, unknown>[] {
	if (value === undefined) return [];
	return expectArray(value, label).map(entry => expectRecord(entry, label));
}

function mergeCapabilities(base: unknown, additions: Record<string, unknown>[]): Record<string, unknown> {
	const result = base === undefined ? {} : { ...expectRecord(base, "workflow capabilities") };
	for (const addition of additions) {
		for (const [key, value] of Object.entries(addition)) {
			mergeCapabilityList(result, key, value);
		}
	}
	return result;
}

function mergeCapabilityList(result: Record<string, unknown>, key: string, value: unknown): void {
	if (result[key] === undefined) {
		result[key] = value;
		return;
	}
	if (Array.isArray(result[key]) && Array.isArray(value)) {
		result[key] = [...new Set([...(result[key] as unknown[]), ...value])];
		return;
	}
	result[key] = value;
}

function joinResourcePath(prefix: string, resourcePath: string): string {
	return `${prefix.replace(/\/+$/, "")}/${resourcePath.replace(/^\/+/, "")}`;
}

function negateCondition(source: string): string {
	return `!(${source})`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
	if (!isRecord(value)) throw new WorkflowDslError(`${label} must be an object`);
	return value;
}

function expectArray(value: unknown, label: string): unknown[] {
	if (!Array.isArray(value)) throw new WorkflowDslError(`${label} must be an array`);
	return value;
}

function expectString(value: unknown, label: string): string {
	if (typeof value === "string" && value.trim()) return value;
	throw new WorkflowDslError(`${label} must be a non-empty string`);
}

function expectJsonPointer(value: unknown, label: string): string {
	const pointer = expectString(value, label);
	if (!pointer.startsWith("/")) throw new WorkflowDslError(`${label} must be a JSON pointer`);
	return pointer;
}

function expectPositiveInteger(value: unknown, label: string): number {
	if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
	throw new WorkflowDslError(`${label} must be a positive integer`);
}

function compareEdges(
	left: Record<string, unknown>,
	right: Record<string, unknown>,
	order: Map<string, number>,
): number {
	return compareNodeReference(left.from, right.from, order) || compareNodeReference(left.to, right.to, order);
}

function compareNodeReference(left: unknown, right: unknown, order: Map<string, number>): number {
	const leftKey = typeof left === "string" ? left : "";
	const rightKey = typeof right === "string" ? right : "";
	const leftOrder = order.get(leftKey) ?? Number.MAX_SAFE_INTEGER;
	const rightOrder = order.get(rightKey) ?? Number.MAX_SAFE_INTEGER;
	return leftOrder - rightOrder || leftKey.localeCompare(rightKey);
}

function inferRawGraphBoundary(nodes: unknown, edges: Record<string, unknown>[]): CompileResult {
	const nodeIds = rawNodeIds(nodes);
	const targeted = new Set<string>();
	const outgoing = new Set<string>();
	for (const edge of edges) {
		if (typeof edge.to === "string") targeted.add(edge.to);
		if (typeof edge.from === "string") outgoing.add(edge.from);
	}
	return {
		entries: nodeIds.filter(nodeId => !targeted.has(nodeId)),
		exits: nodeIds.filter(nodeId => !outgoing.has(nodeId)).map(nodeId => ({ nodeId })),
	};
}

function rawNodeIds(nodes: unknown): string[] {
	if (Array.isArray(nodes)) {
		return nodes.flatMap((node, index) => {
			const raw = expectRecord(node, `workflow block nodes.${index}`);
			return [expectString(raw.id, `workflow block nodes.${index}.id`)];
		});
	}
	return Object.keys(expectRecord(nodes, "workflow block nodes"));
}
