const completed = workflowContext.completedActivations;
const parentIds = workflowContext.activation.parentActivationIds;
const parent = [...completed].reverse().find(activation => parentIds.includes(activation.id));
const output = parent?.output && typeof parent.output === "object" ? parent.output : {};
const data = output.data && typeof output.data === "object" ? output.data : {};
const verdict =
	typeof data.verdict === "string"
		? data.verdict
		: typeof output.verdict === "string"
			? output.verdict
			: "operator-gate";
const summary = typeof output.summary === "string" ? output.summary : "nested Humanize subflow stopped";

throw new Error(`nested Humanize subflow stopped before promotion: ${verdict}: ${summary.slice(0, 1000)}`);
