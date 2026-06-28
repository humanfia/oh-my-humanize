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
const assessment = operatorDecision(normalized);
const decision = assessment.decision;
const recordedAtMs = Date.now();

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
				strength: assessment.strength,
				reasons: assessment.reasons,
				recordedAtMs,
				response: response.slice(0, 4000),
			},
		},
		{
			op: "set",
			path: "/humanize/runtime",
			value: {
				startedAtMs: recordedAtMs,
				elapsedMs: 0,
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
		const match = /^(?:[-*]\s*)?(?:decision\s*[:=-]\s*)?(proceed|approve|approved|hold|stop|reject|rejected)\b/u.exec(line);
		if (match) return assessDecision(match[1], text);
	}
	const match = /\b(proceed|approve|approved|hold|stop|reject|rejected)\b/u.exec(text);
	return match
		? assessDecision(match[1], text)
		: {
				decision: "hold",
				strength: "missing",
				reasons: ["missing explicit proceed, hold, or stop decision"],
			};
}

function assessDecision(token, text) {
	if (token === "hold") {
		return { decision: "hold", strength: "explicit", reasons: [] };
	}
	if (token === "stop" || token === "reject" || token === "rejected") {
		return { decision: "stop", strength: "explicit", reasons: [] };
	}
	if (token === "approve" || token === "approved") {
		return { decision: "proceed", strength: "explicit", reasons: [] };
	}

	const reasons = [];
	if (!hasComponentAcknowledgement(text)) {
		reasons.push("missing components or changed surfaces acknowledgement");
	}
	if (!hasConnectionAcknowledgement(text)) {
		reasons.push("missing connection or interaction acknowledgement");
	}
	if (!hasLongRunningAcknowledgement(text)) {
		reasons.push("missing long-running, eight-hour, or five-day acknowledgement");
	}
	return reasons.length === 0
		? { decision: "proceed", strength: "explicit", reasons: [] }
		: { decision: "hold", strength: "weak", reasons };
}

function hasComponentAcknowledgement(text) {
	return /\b(components?|surfaces?|files?|crates?|packages?|modules?|paths?|scopes?|changes?|touch(?:es|ed|ing)?|routing|extractors?|services?|tests?|serializers?|signers?|timestamps?|boundar(?:y|ies))\b/u.test(text);
}

function hasConnectionAcknowledgement(text) {
	return /\b(connect(?:s|ed|ing)?|connections?|interact(?:s|ed|ing)?|interactions?|coupled|coupling|boundar(?:y|ies)|through|between|via|route|routes|routing|forward|forwards|depend|depends|drives?)\b/u.test(
		text,
	);
}

function hasLongRunningAcknowledgement(text) {
	return (
		/\b(long[-\s]?running|8\s*(?:h|hour|hours)|eight\s+hours?|5\s*(?:d|day|days)|five\s+days?|minimum)\b/u.test(text) ||
		/\b(canary(?:[-\s]?grade)?|short semantic evidence|short evidence|not (?:an? )?(?:8\s*(?:h|hour|hours)|eight\s+hours?)|enlarge the next (?:real )?task|no (?:sleep|hold|no-op|timer|duration padding))\b/u.test(
			text,
		)
	);
}
