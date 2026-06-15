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
let taskContract = "";
try {
	taskContract = await Bun.file("task.md").text();
} catch {
	taskContract = "";
}
const normalizedContract = taskContract.toLowerCase();
const decision = /\bstop\b/u.test(normalized)
	? "stop"
	: /\bhold\b/u.test(normalized)
		? "hold"
		: /\b(?:proceed|approve|approved)\b/u.test(normalized)
			? "proceed"
			: "unknown";
const recordedAtMs = Date.now();
const minimumRuntimeMs = 8 * 60 * 60 * 1000;
const maximumRuntimeMs = 5 * 24 * 60 * 60 * 1000;
const operatorLongRunningPattern =
	/\b8[-\s]*hours?\b|\beight[-\s]+hours?\b|\bat\s+least\s+eight[-\s]+hours?\b|\blong[-\s]?running\b|\b5[-\s]*days?\b|\bfive[-\s]+days?\b|\bshort\s+smoke\b/u;
const contractLongRunningPattern =
	/\b8[-\s]*hours?\b|\beight[-\s]+hours?\b|\bat\s+least\s+eight[-\s]+hours?\b|\b5[-\s]*days?\b|\bfive[-\s]+days?\b/u;
const longRunningRequested =
	operatorLongRunningPattern.test(normalized) || contractLongRunningPattern.test(normalizedContract);

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
