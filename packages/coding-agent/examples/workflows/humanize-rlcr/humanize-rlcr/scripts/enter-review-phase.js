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
const reviewPhase = {
	baseBranch: "main",
	status: "active",
	enteredAfterRound: Number.isFinite(ledger.currentRound) ? ledger.currentRound : 0,
	openIssueCount: Array.isArray(ledger.openIssues) ? ledger.openIssues.length : 0,
	queuedIssueCount: Array.isArray(ledger.queuedIssues) ? ledger.queuedIssues.length : 0,
	longRunningMinimumSatisfied: minimumSatisfied,
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
	summary: "entered code review phase with ledger snapshot",
	statePatch: [
		{ op: "set", path: "/humanize/reviewPhase", value: reviewPhase },
		{ op: "set", path: "/humanize/runtime", value: runtime },
		{ op: "set", path: "/humanize/operatorGate/minimumSatisfied", value: minimumSatisfied },
	],
};
