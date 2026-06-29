const state = workflowContext.state && typeof workflowContext.state === "object" ? workflowContext.state : {};
const humanize = state.humanize && typeof state.humanize === "object" ? state.humanize : {};
const ledger = humanize.ledger && typeof humanize.ledger === "object" ? humanize.ledger : {};
const operatorGate = humanize.operatorGate && typeof humanize.operatorGate === "object" ? humanize.operatorGate : {};
const startedAtMs = Number.isFinite(operatorGate.recordedAtMs) ? operatorGate.recordedAtMs : Date.now();
const elapsedMs = Math.max(0, Date.now() - startedAtMs);
const enteredAfterRound = Number.isFinite(ledger.currentRound) ? ledger.currentRound : 0;
const summaryReviewFile = `workflow-output/round-${enteredAfterRound}-codex-summary-review.json`;
const summaryReviewOutput = latestParentOutput("codexSummaryReview");
const taskText = await readTaskText();
const baseBranchMatch = taskText.match(/(?:^|\n)\s*(?:base\s*branch|baseBranch|review\s*base)\s*:\s*([^\n]+)/iu);
const envBaseBranch = Bun.env.OMH_HUMANIZE_BASE_BRANCH?.trim();
const taskBaseBranch = baseBranchMatch?.[1]?.trim();
const baseBranch = envBaseBranch || taskBaseBranch || "main";
const reviewPhase = {
	baseBranch,
	status: "active",
	enteredAfterRound,
	openIssueCount: Array.isArray(ledger.openIssues) ? ledger.openIssues.length : 0,
	queuedIssueCount: Array.isArray(ledger.queuedIssues) ? ledger.queuedIssues.length : 0,
	summaryReviewFile,
};
const runtime = {
	startedAtMs,
	elapsedMs,
};

await Bun.write(
	summaryReviewFile,
	`${JSON.stringify(
		{
			flow: "humanize-rlcr",
			node: "codexSummaryReview",
			round: enteredAfterRound,
			output: summaryReviewOutput,
			reviewPhase,
			runtime,
			recordedAtMs: Date.now(),
		},
		null,
		2,
	)}\n`,
);

return {
	summary: "entered code review phase with ledger snapshot",
	statePatch: [
		{ op: "set", path: "/humanize/reviewPhase", value: reviewPhase },
		{ op: "set", path: "/humanize/runtime", value: runtime },
	],
};

function latestParentOutput(nodeId) {
	const parentIds = Array.isArray(workflowContext.activation.parentActivationIds)
		? workflowContext.activation.parentActivationIds
		: [];
	const activations = Array.isArray(workflowContext.completedActivations) ? workflowContext.completedActivations : [];
	for (let index = activations.length - 1; index >= 0; index -= 1) {
		const activation = activations[index];
		if (activation?.nodeId === nodeId && parentIds.includes(activation.id)) return activation.output ?? {};
	}
	for (let index = activations.length - 1; index >= 0; index -= 1) {
		const activation = activations[index];
		if (activation?.nodeId === nodeId) return activation.output ?? {};
	}
	return {};
}

async function readTaskText() {
	for (const source of ["task.md", "TASK.md"]) {
		try {
			return await Bun.file(source).text();
		} catch {}
	}
	return "";
}
