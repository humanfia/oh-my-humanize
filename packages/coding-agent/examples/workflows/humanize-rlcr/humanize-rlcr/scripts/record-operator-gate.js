const completed = workflowContext.completedActivations;
const humanActivation = [...completed].reverse().find(activation => activation.nodeId === "planUnderstandingQuiz");
const output = humanActivation?.output && typeof humanActivation.output === "object" ? humanActivation.output : {};
const data = output.data && typeof output.data === "object" ? output.data : {};
const response =
	typeof data.response === "string"
		? data.response
		: typeof output.summary === "string"
			? output.summary
			: "";
const normalized = response.toLowerCase();
const decision = normalized.includes("stop") ? "stop" : normalized.includes("hold") ? "hold" : normalized.includes("proceed") ? "proceed" : "unknown";
const recordedAtMs = Date.now();
const minimumRuntimeMs = 8 * 60 * 60 * 1000;
const maximumRuntimeMs = 5 * 24 * 60 * 60 * 1000;
const longRunningRequested =
	/\b8\s*hours?\b|\beight\s+hours?\b|\blong[-\s]?running\b|\b5\s*days?\b|\bfive\s+days?\b|\bshort\s+smoke\b/u.test(
		normalized,
	);

return {
	summary: `operator gate recorded with decision ${decision}`,
	statePatch: [
		{
			op: "set",
			path: "/humanize/operatorGate",
			value: {
				activationId: humanActivation?.id ?? null,
				recordedByActivationId: workflowContext.activation.id,
				decision,
				longRunningRequested,
				recordedAtMs,
				minimumRuntimeMs,
				maximumRuntimeMs,
				minimumSatisfied: false,
				response: response.slice(0, 4000),
			},
		},
		{
			op: "set",
			path: "/humanize/runtime",
			value: {
				startedAtMs: recordedAtMs,
				elapsedMs: 0,
				longRunning: {
					requested: longRunningRequested,
					minimumRuntimeMs,
					maximumRuntimeMs,
					minimumSatisfied: false,
				},
			},
		},
	],
};
