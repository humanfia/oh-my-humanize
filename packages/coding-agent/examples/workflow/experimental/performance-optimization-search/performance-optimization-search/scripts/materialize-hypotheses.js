const planActivation = latestCompletedActivation("planHypotheses");
const summary = activationSummary(planActivation);
const data = activationData(planActivation);

if (!summary && Object.keys(data).length === 0) {
	throw new Error("performance optimization planHypotheses produced no materializable summary or data");
}

const hypotheses = {
	status: "materialized",
	producer_node: "materializeHypotheses",
	source_node: "planHypotheses",
	source_activation_id: planActivation.id,
	summary,
	...(Object.keys(data).length > 0 ? { data } : {}),
};

await Bun.write("workflow-output/performance-hypotheses.json", `${JSON.stringify(hypotheses, null, 2)}\n`);

return {
	summary: "materialized performance hypotheses for parallel branch prompts",
	data: hypotheses,
	artifacts: ["local://workflow-output/performance-hypotheses.json"],
};

function latestCompletedActivation(nodeId) {
	const completed = Array.isArray(workflowContext.completedActivations)
		? workflowContext.completedActivations.filter(
				activation => activation.nodeId === nodeId && activation.status === "completed",
			)
		: [];
	const activation = completed.at(-1);
	if (activation) return activation;
	throw new Error(`performance optimization could not find completed ${nodeId} activation`);
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
