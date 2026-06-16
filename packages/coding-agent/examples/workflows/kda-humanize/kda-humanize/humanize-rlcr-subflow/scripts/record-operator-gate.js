const completed = workflowContext.completedActivations;
const humanActivation = [...completed]
	.reverse()
	.find(activation => activation.nodeId === "planUnderstandingQuiz" || activation.nodeId.endsWith("__planUnderstandingQuiz"));
const output = humanActivation?.output && typeof humanActivation.output === "object" ? humanActivation.output : {};
const data = output.data && typeof output.data === "object" ? output.data : {};
const response =
	typeof data.response === "string"
		? data.response
		: typeof output.summary === "string"
			? output.summary
			: "";
const decision = operatorDecision(response.toLowerCase());

return {
	summary: `nested Humanize operator gate recorded with decision ${decision}`,
	statePatch: [
		{
			op: "set",
			path: "/humanize/operatorGate",
			value: {
				activationId: humanActivation?.id ?? null,
				recordedByActivationId: workflowContext.activation.id,
				decision,
				response: response.slice(0, 4000),
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
