export interface WorkflowDslCompileResult {
	nodes: unknown;
	edges: Record<string, unknown>[];
	models?: unknown;
}

interface CompileResult {
	entries: string[];
	exits: string[];
}

export class WorkflowDslError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WorkflowDslError";
	}
}

export function compileWorkflowDslBlock(block: Record<string, unknown>): WorkflowDslCompileResult {
	if (block.nodes !== undefined) {
		return {
			nodes: block.nodes,
			edges: expectArray(block.edges ?? [], "workflow block edges").map(edge =>
				expectRecord(edge, "workflow block edge"),
			),
			models: block.models,
		};
	}
	const compiler = new WorkflowDslCompiler(block);
	const result = compiler.compileStep(block, "workflow");
	if (result.entries.length === 0) {
		throw new WorkflowDslError("workflow DSL must compile to at least one entry node");
	}
	return {
		nodes: compiler.nodesRecord(),
		edges: compiler.sortedEdges(),
		models: block.models,
	};
}

class WorkflowDslCompiler {
	#nodes = new Map<string, Record<string, unknown>>();
	readonly edges: Record<string, unknown>[] = [];
	readonly modules: Record<string, unknown>;

	constructor(block: Record<string, unknown>) {
		this.modules = block.modules === undefined ? {} : expectRecord(block.modules, "workflow modules");
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
			if (module === undefined) throw new WorkflowDslError(`${path}.use references unknown module "${moduleName}"`);
			return this.compileStep(module, `modules.${moduleName}`);
		}
		if (step.sequence !== undefined) {
			return this.compileSequence(expectArray(step.sequence, `${path}.sequence`), `${path}.sequence`);
		}
		if (step.parallel !== undefined) {
			return this.compileParallel(step, path);
		}
		if (step.node !== undefined) {
			return this.compileNode(step.node, `${path}.node`);
		}
		throw new WorkflowDslError(`${path} must define one of node, sequence, parallel, or use`);
	}

	compileSequence(steps: unknown[], path: string): CompileResult {
		let entries: string[] = [];
		let previousExits: string[] = [];
		for (let index = 0; index < steps.length; index += 1) {
			const compiled = this.compileStep(steps[index], `${path}.${index}`);
			if (compiled.entries.length === 0) continue;
			if (entries.length === 0) entries = compiled.entries;
			for (const from of previousExits) {
				for (const to of compiled.entries) {
					this.edges.push({ from, to });
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
			joinNode.waitFor = exits;
			this.addNode(joinNode, `${path}.join`);
			for (const exit of exits) {
				this.edges.push({ from: exit, to: joinNode.id });
			}
			exits = [joinNode.id];
		}
		return { entries, exits };
	}

	compileNode(rawNode: unknown, path: string): CompileResult {
		const node = this.normalizeNode(rawNode, path);
		this.addNode(node, path);
		return { entries: [node.id], exits: [node.id] };
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
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
	if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
	throw new WorkflowDslError(`${label} must be an object`);
}

function expectArray(value: unknown, label: string): unknown[] {
	if (Array.isArray(value)) return value;
	throw new WorkflowDslError(`${label} must be an array`);
}

function expectString(value: unknown, label: string): string {
	if (typeof value === "string" && value.trim()) return value;
	throw new WorkflowDslError(`${label} must be a non-empty string`);
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
