const state = workflowContext.state && typeof workflowContext.state === "object" ? workflowContext.state : {};
const humanize = state.humanize && typeof state.humanize === "object" ? state.humanize : {};
const ledger = humanize.ledger && typeof humanize.ledger === "object" ? humanize.ledger : {};
const operatorGate = humanize.operatorGate && typeof humanize.operatorGate === "object" ? humanize.operatorGate : {};
const startedAtMs = Number.isFinite(operatorGate.recordedAtMs) ? operatorGate.recordedAtMs : Date.now();
const elapsedMs = Math.max(0, Date.now() - startedAtMs);
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
const normalizedEvidenceKey = key => key.replace(/[^a-z0-9]/gi, "").toLowerCase();
const downstreamClaimKeys = downstreamReviewClaimKeys(implementationData);
if (downstreamClaimKeys.length > 0) {
	throw new Error(
		`implementation round evidence cannot claim downstream review or final-alignment results: ${downstreamClaimKeys.join(", ")}`,
	);
}
if (usesNondurableArtifactReference(JSON.stringify(implementationOutput))) {
	throw new Error(
		"implementation round evidence cannot use nondurable artifact references; copy validation stdout/stderr/status into workflow-output and reference workspace-local files",
	);
}
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
const evidenceValues = acceptsKey => {
	const values = [];
	for (const [key, value] of Object.entries(implementationData)) {
		if (!acceptsKey(normalizedEvidenceKey(key))) continue;
		if (value === undefined) continue;
		if (Array.isArray(value)) {
			values.push(...value);
		} else {
			values.push(value);
		}
	}
	if (values.length === 0) return undefined;
	return values.length === 1 ? values[0] : values;
};
const changedFiles = evidenceValues(key => key === "changedfiles");
const acceptanceEvidence = evidenceValues(key => key.includes("acceptance"));
const verificationEvidence = evidenceValues(key => key.includes("verification")) ?? acceptanceEvidence;
const negativeEvidence = evidenceValues(key => key.includes("negative") || key.includes("regression"));
const roundNumber = currentRound + 1;
const roundSummaryFile = `workflow-output/round-${roundNumber}-summary.json`;
const entry = {
	round: roundNumber,
	status: "ready-for-summary-review",
	artifactFile: roundSummaryFile,
	summaryActivationId: workflowContext.activation.id,
	implementationActivationIds: parents,
	implementationSummary: boundedImplementationSummary,
	evidence: {
		status: boundedEvidenceValue(implementationData.status, "not-reported"),
		changedFiles: boundedEvidenceValue(changedFiles, "not-reported"),
		negativeTests: boundedEvidenceValue(negativeEvidence, "required-before-complete"),
		verification: boundedEvidenceValue(verificationEvidence, "required-before-complete"),
		acceptanceDelta: boundedEvidenceValue(acceptanceEvidence, "reviewer-must-check"),
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
	artifactFile: roundSummaryFile,
	implementationSummary: boundedImplementationSummary,
	openIssueCount: Array.isArray(nextLedger.openIssues) ? nextLedger.openIssues.length : 0,
	queuedIssueCount: Array.isArray(nextLedger.queuedIssues) ? nextLedger.queuedIssues.length : 0,
	archivedRoundCount: nextLedger.archivedRoundCount,
	retainedRoundCount: retainedRounds.length,
	elapsedMs,
};
const runtime = {
	startedAtMs,
	elapsedMs,
};

await Bun.write(
	roundSummaryFile,
	`${JSON.stringify(
		{
			flow: "humanize-rlcr",
			node: "writeRoundSummary",
			activationId: workflowContext.activation.id,
			round: roundNumber,
			entry,
			summary,
			runtime,
			recordedAtMs: Date.now(),
		},
		null,
		2,
	)}\n`,
);

return {
	summary: `round ${roundNumber} summary written for reviewer-controlled RLCR loop`,
	statePatch: [
		{ op: "set", path: "/humanize/ledger", value: nextLedger },
		{ op: "set", path: "/humanize/summary", value: summary },
		{ op: "set", path: "/humanize/runtime", value: runtime },
	],
};

function downstreamReviewClaimKeys(value) {
	const keys = [];
	for (const key of Object.keys(value)) {
		const normalized = normalizedEvidenceKey(key);
		if (
			normalized === "reviewsummary" ||
			normalized === "codexcodereview" ||
			normalized === "finalalignmentcheck" ||
			normalized === "finalalignment"
		) {
			keys.push(key);
		}
	}
	return keys.sort((left, right) => left.localeCompare(right, "en"));
}

function usesNondurableArtifactReference(text) {
	return (
		/\b(?:validation|stdout|stderr|evidence|harness|status).{0,160}\bartifact:\/\/\d+\b/ius.test(text) ||
		/\bartifact:\/\/\d+\b.{0,160}\b(?:validation|stdout|stderr|evidence|harness|status)\b/ius.test(text)
	);
}
