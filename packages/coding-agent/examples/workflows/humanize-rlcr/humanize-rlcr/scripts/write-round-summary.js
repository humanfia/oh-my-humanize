const state = workflowContext.state;
const humanize = state.humanize && typeof state.humanize === "object" ? state.humanize : {};
const ledger = humanize.ledger && typeof humanize.ledger === "object" ? humanize.ledger : {};
const operatorGate = humanize.operatorGate && typeof humanize.operatorGate === "object" ? humanize.operatorGate : {};
const startedAtMs = Number.isFinite(operatorGate.recordedAtMs) ? operatorGate.recordedAtMs : Date.now();
const minimumRuntimeMs = Number.isFinite(operatorGate.minimumRuntimeMs) ? operatorGate.minimumRuntimeMs : 8 * 60 * 60 * 1000;
const maximumRuntimeMs = Number.isFinite(operatorGate.maximumRuntimeMs) ? operatorGate.maximumRuntimeMs : 5 * 24 * 60 * 60 * 1000;
const elapsedMs = Math.max(0, Date.now() - startedAtMs);
const longRunningRequested = operatorGate.longRunningRequested === true;
const minimumSatisfied = !longRunningRequested || elapsedMs >= minimumRuntimeMs;
const rounds = Array.isArray(ledger.rounds) ? ledger.rounds : [];
const parents = workflowContext.activation.parentActivationIds;
const parentOutputs = workflowContext.completedActivations
	.filter(activation => parents.includes(activation.id))
	.map(activation => activation.output)
	.filter(output => output && typeof output === "object");
const implementationOutput = parentOutputs.at(-1) ?? {};
const implementationSummary =
	typeof implementationOutput.summary === "string" ? implementationOutput.summary : "implementation round completed";
const roundNumber = rounds.length + 1;
const entry = {
	round: roundNumber,
	status: "ready-for-summary-review",
	summaryActivationId: workflowContext.activation.id,
	implementationActivationIds: parents,
	implementationSummary: implementationSummary.slice(0, 2000),
	evidence: {
		negativeTests: "required-before-complete",
		verification: "required-before-complete",
		acceptanceDelta: "reviewer-must-check",
		longRunningMinimum: longRunningRequested ? (minimumSatisfied ? "satisfied" : "not-yet-satisfied") : "not-requested",
	},
};
const nextLedger = {
	...ledger,
	currentRound: roundNumber,
	rounds: [...rounds, entry],
};
const summary = {
	round: roundNumber,
	status: "ready-for-summary-review",
	implementationSummary: implementationSummary.slice(0, 2000),
	openIssueCount: Array.isArray(nextLedger.openIssues) ? nextLedger.openIssues.length : 0,
	queuedIssueCount: Array.isArray(nextLedger.queuedIssues) ? nextLedger.queuedIssues.length : 0,
	longRunningMinimumSatisfied: minimumSatisfied,
	elapsedMs,
};
const runtime = {
	startedAtMs,
	elapsedMs,
	longRunning: {
		requested: longRunningRequested,
		minimumRuntimeMs,
		maximumRuntimeMs,
		minimumSatisfied,
	},
};

return {
	summary: `round ${roundNumber} summary written for reviewer-controlled RLCR loop`,
	statePatch: [
		{ op: "set", path: "/humanize/ledger", value: nextLedger },
		{ op: "set", path: "/humanize/summary", value: summary },
		{ op: "set", path: "/humanize/runtime", value: runtime },
		{ op: "set", path: "/humanize/operatorGate/minimumSatisfied", value: minimumSatisfied },
	],
};
