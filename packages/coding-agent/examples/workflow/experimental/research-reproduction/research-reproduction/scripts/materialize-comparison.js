const sourceActivation = latestCompletedActivation("compareResults");
const comparison = materializeAgentHandoff(sourceActivation, {
	status: "comparison_materialized",
	producerNode: "materializeComparison",
	sourceNode: "compareResults",
	artifact: "workflow-output/research-comparison.json",
});

await Bun.write(comparison.artifact, `${JSON.stringify(comparison.value, null, 2)}\n`);

return {
	summary: `materialized research comparison for review at ${comparison.artifact}`,
	statePatch: [{ op: "set", path: "/comparison", value: comparison.value }],
	data: {
		artifact: comparison.artifact,
		source_activation_id: sourceActivation.id,
	},
	artifacts: [`local://${comparison.artifact}`],
};

function latestCompletedActivation(nodeId) {
	const completed = Array.isArray(workflowContext.completedActivations)
		? workflowContext.completedActivations.filter(
				activation => activation.nodeId === nodeId && activation.status === "completed",
			)
		: [];
	const activation = completed.at(-1);
	if (activation) return activation;
	throw new Error(`research reproduction could not find completed ${nodeId} activation`);
}

function materializeAgentHandoff(activation, options) {
	const summary = activationSummary(activation);
	const data = activationData(activation);
	if (!summary && Object.keys(data).length === 0) {
		throw new Error(`research reproduction ${options.sourceNode} produced no materializable summary or data`);
	}
	return {
		artifact: options.artifact,
		value: {
			status: options.status,
			producer_node: options.producerNode,
			source_node: options.sourceNode,
			source_activation_id: activation.id,
			summary,
			...(Object.keys(data).length > 0 ? { data } : {}),
		},
	};
}

function activationSummary(activation) {
	const summary = activation?.output?.summary;
	return typeof summary === "string" ? summary.trim() : "";
}

function activationData(activation) {
	const value = activation?.output?.data;
	if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) return {};
	const data = {};
	for (const [key, child] of Object.entries(value)) {
		if (key === "exitCode" || key === "summaryTruncated" || key === "summaryBytes") continue;
		data[key] = child;
	}
	return data;
}
