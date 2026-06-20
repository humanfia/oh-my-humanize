import type { WorkflowDefinition, WorkflowNode } from "./definition";
import type { RuntimeBindingSnapshot } from "./lifecycle";

const CAPABILITY_UNAVAILABLE_PREFIXES = ["tool:", "agent:", "plugin:", "extension:", "skill:"] as const;

export function runtimeBindingCapabilityUnavailable(snapshot: RuntimeBindingSnapshot): string[] {
	return snapshot.unavailable.filter(isRuntimeCapabilityUnavailable);
}

export function workflowRuntimeBindingUnavailableError(
	snapshot: RuntimeBindingSnapshot,
	definition: WorkflowDefinition,
	startNodeIds: readonly string[],
): string | undefined {
	const unavailable = runtimeBindingBlockingUnavailable(snapshot, definition, startNodeIds);
	if (unavailable.length === 0) return undefined;
	return `Workflow runtime binding unavailable: ${unavailable.join("; ")}`;
}

function runtimeBindingBlockingUnavailable(
	snapshot: RuntimeBindingSnapshot,
	definition: WorkflowDefinition,
	startNodeIds: readonly string[],
): string[] {
	const requiredCapabilities = workflowStartNodeCapabilities(definition, startNodeIds);
	return runtimeBindingCapabilityUnavailable(snapshot).filter(entry =>
		[...requiredCapabilities].some(capability => entry.startsWith(`${capability}:`)),
	);
}

function workflowStartNodeCapabilities(definition: WorkflowDefinition, startNodeIds: readonly string[]): Set<string> {
	const nodesById = new Map(definition.nodes.map(node => [node.id, node]));
	const capabilities = new Set<string>();
	for (const nodeId of startNodeIds) {
		const node = nodesById.get(nodeId);
		if (node === undefined) continue;
		for (const capability of workflowNodeRuntimeCapabilities(node)) {
			capabilities.add(capability);
		}
	}
	return capabilities;
}

function workflowNodeRuntimeCapabilities(node: WorkflowNode): string[] {
	if (node.type === "script") return [`tool:${node.script?.language === "sh" ? "bash" : "eval"}`];
	if (node.type === "human") return ["tool:ask"];
	if (node.type === "agent") return ["tool:task", ...(node.agent ? [`agent:${node.agent}`] : [])];
	if (node.type === "review") return ["tool:task", ...(node.agent ? [`agent:${node.agent}`] : [])];
	if (node.type === "workflow") return ["tool:workflow"];
	if (node.type === "foreach") {
		if (node.foreach?.body.kind === "workflow") return ["tool:workflow"];
		if (node.foreach?.body.kind === "node") return workflowNodeRuntimeCapabilities(node.foreach.body.node);
	}
	return [];
}

function isRuntimeCapabilityUnavailable(entry: string): boolean {
	return CAPABILITY_UNAVAILABLE_PREFIXES.some(prefix => entry.startsWith(prefix));
}
