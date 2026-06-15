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
const retainedRoundLimit = 6;
const implementationSummaryLimit = 1200;
const currentRound = Number.isFinite(ledger.currentRound) ? ledger.currentRound : rounds.length;
const archivedRoundCount = Number.isFinite(ledger.archivedRoundCount) ? ledger.archivedRoundCount : 0;
const parents = workflowContext.activation.parentActivationIds;
const parentOutputs = workflowContext.completedActivations
	.filter(activation => parents.includes(activation.id))
	.map(activation => activation.output)
	.filter(output => output && typeof output === "object");
const implementationOutput = parentOutputs.at(-1) ?? {};
const implementationSummary =
	typeof implementationOutput.summary === "string" ? implementationOutput.summary : "implementation round completed";
const boundedImplementationSummary = implementationSummary.slice(0, implementationSummaryLimit);
const implementationData =
	implementationOutput.data && typeof implementationOutput.data === "object" && !Array.isArray(implementationOutput.data)
		? implementationOutput.data
		: {};
const evidenceValueLimit = 4000;
const boundedEvidenceValue = (value, fallback) => {
	if (value === undefined) return fallback;
	const serialized = JSON.stringify(value);
	if (serialized === undefined) return fallback;
	if (serialized.length <= evidenceValueLimit) return value;
	return {
		truncated: true,
		preview: serialized.slice(0, evidenceValueLimit),
	};
};
const firstEvidenceValue = keys => {
	for (const key of keys) {
		if (implementationData[key] !== undefined) return implementationData[key];
	}
	return undefined;
};
const roundNumber = currentRound + 1;
const entry = {
	round: roundNumber,
	status: "ready-for-summary-review",
	summaryActivationId: workflowContext.activation.id,
	implementationActivationIds: parents,
	implementationSummary: boundedImplementationSummary,
	evidence: {
		status: boundedEvidenceValue(implementationData.status, "not-reported"),
		changedFiles: boundedEvidenceValue(firstEvidenceValue(["changedFiles", "changed_files"]), "not-reported"),
		negativeTests: boundedEvidenceValue(
			firstEvidenceValue([
				"negativeAndRegressionRiskScenarios",
				"negative_tests_or_regression_risks",
				"negativeTests",
			]),
			"required-before-complete",
		),
		verification: boundedEvidenceValue(implementationData.verification, "required-before-complete"),
		acceptanceDelta: boundedEvidenceValue(
			firstEvidenceValue(["acceptanceCriteriaEvidence", "acceptance_evidence", "acceptanceEvidence"]),
			"reviewer-must-check",
		),
		longRunningMinimum: longRunningRequested ? (minimumSatisfied ? "satisfied" : "not-yet-satisfied") : "not-requested",
	},
};
const nextRounds = [...rounds, entry];
const retainedRounds = nextRounds.slice(-retainedRoundLimit);
const archivedThisRound = Math.max(0, nextRounds.length - retainedRounds.length);
const nextLedger = {
	...ledger,
	currentRound: roundNumber,
	archivedRoundCount: archivedRoundCount + archivedThisRound,
	retainedRoundLimit,
	oldestRetainedRound: retainedRounds[0]?.round ?? roundNumber,
	latestRetainedRound: retainedRounds.at(-1)?.round ?? roundNumber,
	rounds: retainedRounds,
};
const summary = {
	round: roundNumber,
	status: "ready-for-summary-review",
	implementationSummary: boundedImplementationSummary,
	openIssueCount: Array.isArray(nextLedger.openIssues) ? nextLedger.openIssues.length : 0,
	queuedIssueCount: Array.isArray(nextLedger.queuedIssues) ? nextLedger.queuedIssues.length : 0,
	archivedRoundCount: nextLedger.archivedRoundCount,
	retainedRoundCount: retainedRounds.length,
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
