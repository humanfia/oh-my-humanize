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
const decision = operatorDecision(normalized);
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

function operatorDecision(text) {
	const lines = text
		.split(/\r?\n/u)
		.map(line => line.trim())
		.filter(Boolean);
	for (const line of lines) {
		const match = /^(?:[-*]\s*)?(?:decision\s*[:=-]\s*)?(proceed|approve|approved|hold|stop)\b/u.exec(line);
		if (match) return normalizeDecision(match[1]);
	}
	const match = /\b(proceed|approve|approved|hold|stop)\b/u.exec(text);
	return match ? normalizeDecision(match[1]) : "unknown";
}

function normalizeDecision(token) {
	return token === "approve" || token === "approved" ? "proceed" : token;
}
