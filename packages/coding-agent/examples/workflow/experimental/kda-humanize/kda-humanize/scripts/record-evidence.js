const state = workflowContext.state && typeof workflowContext.state === "object" ? workflowContext.state : {};
const taskContract = state.taskContract ?? {};
const plan = evidenceValue(state.plan, "draftPlan");
const candidate = evidenceValue(state.candidate, "implementCandidate");
const humanizeHandoff = evidenceValue(state.finalizeSummary, "humanize__finalize");
const validationActivations = completedActivationsFor("validateCandidate");
const latestValidation = validationActivations.at(-1)?.output ?? {};
const validationEvidence = activationEvidence(latestValidation);
const terminalVerdict = reviewVerdict(latestValidation) ?? "unknown";
const fullEvidenceArtifact = "workflow-output/kda-evidence.md";
assertTerminalEvidence({
	taskContract,
	plan,
	candidate,
	humanizeHandoff,
	validationActivations,
	validationEvidence,
	terminalVerdict,
});
const recordedAtMs = Date.now();
const evidence = compactTerminalEvidence({
	taskContract,
	plan,
	humanizeHandoff,
	candidate,
	validationEvidence,
	terminalVerdict,
	validationActivationCount: validationActivations.length,
	recordedAtMs,
	fullEvidenceArtifact,
});
await Bun.write(
	fullEvidenceArtifact,
	[
		"# KDA Evidence",
		"",
		"## Task Contract",
		"",
		"```json",
		JSON.stringify(taskContract, null, 2),
		"```",
		"",
		"## Plan",
		"",
		"```json",
		JSON.stringify(plan, null, 2),
		"```",
		"",
		"## Nested Humanize Handoff",
		"",
		"```json",
		JSON.stringify(humanizeHandoff, null, 2),
		"```",
		"",
		"## Candidate",
		"",
		"```json",
		JSON.stringify(candidate, null, 2),
		"```",
		"",
	"## Validation",
	"",
	`- Verdict: ${String(terminalVerdict)}`,
	`- Validation activations: ${validationActivations.length}`,
		"",
		"```json",
		JSON.stringify(validationEvidence, null, 2),
		"```",
		"",
	].join("\n"),
);

return {
	summary: "recorded KDA terminal evidence from task contract, plan, nested Humanize handoff, candidate, and validation verdict",
	statePatch: [{ op: "set", path: "/evidence", value: evidence }],
	artifacts: [`local://${fullEvidenceArtifact}`],
};

function compactTerminalEvidence({
	taskContract,
	plan,
	humanizeHandoff,
	candidate,
	validationEvidence,
	terminalVerdict,
	validationActivationCount,
	recordedAtMs,
	fullEvidenceArtifact,
}) {
	for (const budget of [1400, 1000, 700, 420]) {
		const evidence = {
			status: "recorded-prompt-summary",
			fullEvidenceArtifact,
			taskContract: boundedValue(taskContract, budget),
			plan: boundedValue(plan, budget),
			nestedHumanizeHandoff: boundedValue(humanizeHandoff, budget),
			candidate: boundedValue(candidate, budget),
			validation: boundedValue(validationEvidence, budget),
			validationVerdict: terminalVerdict,
			validationActivationCount,
			recordedAtMs,
			promptBudget: {
				maxFieldChars: budget,
				note: "Full promotion evidence is stored in fullEvidenceArtifact; workflow state carries a bounded prompt summary.",
			},
		};
		if (JSON.stringify(evidence).length <= 9000) return evidence;
	}
	return {
		status: "recorded-prompt-summary",
		fullEvidenceArtifact,
		taskContract: boundedValue(taskContract, 260),
		plan: boundedValue(plan, 260),
		nestedHumanizeHandoff: boundedValue(humanizeHandoff, 260),
		candidate: boundedValue(candidate, 260),
		validation: boundedValue(validationEvidence, 260),
		validationVerdict: terminalVerdict,
		validationActivationCount,
		recordedAtMs,
		promptBudget: {
			maxFieldChars: 260,
			note: "Promotion state was aggressively compacted; inspect fullEvidenceArtifact before approving residual risk.",
		},
	};
}

function evidenceValue(stateValue, nodeId) {
	if (!isEmptyEvidence(stateValue)) return stateValue;
	return activationEvidence(latestCompletedOutput(nodeId));
}

function activationEvidence(output) {
	if (!output || typeof output !== "object") return {};
	const evidence = {};
	if (typeof output.summary === "string" && output.summary.trim()) evidence.summary = output.summary;
	if (output.data && typeof output.data === "object") evidence.data = output.data;
	if (Array.isArray(output.artifacts) && output.artifacts.length > 0) evidence.artifacts = output.artifacts;
	return evidence;
}

function reviewVerdict(output) {
	if (!output || typeof output !== "object") return undefined;
	if (typeof output.verdict === "string") return output.verdict;
	if (output.data && typeof output.data === "object" && typeof output.data.verdict === "string") {
		return output.data.verdict;
	}
	return undefined;
}

function latestCompletedOutput(nodeId) {
	return completedActivationsFor(nodeId).at(-1)?.output;
}

function completedActivationsFor(nodeId) {
	return workflowContext.completedActivations.filter(
		activation => activation.nodeId === nodeId && activation.status === "completed",
	);
}

function isEmptyEvidence(value) {
	if (value === undefined || value === null) return true;
	if (typeof value === "string") return value.trim().length === 0;
	if (Array.isArray(value)) return value.length === 0;
	if (typeof value === "object") return Object.keys(value).length === 0;
	return false;
}

function boundedValue(value, maxChars) {
	const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
	return boundedText(text, maxChars);
}

function boundedText(text, maxChars) {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n[truncated ${text.length - maxChars} chars]`;
}

function assertTerminalEvidence(input) {
	const missing = [];
	if (isEmptyEvidence(input.taskContract)) missing.push("task contract");
	if (isEmptyEvidence(input.plan)) missing.push("KDA plan");
	if (isEmptyEvidence(input.humanizeHandoff)) missing.push("nested Humanize handoff");
	if (isEmptyEvidence(input.candidate)) missing.push("candidate implementation evidence");
	if (input.validationActivations.length === 0) missing.push("validation activation");
	if (!["promote", "reject"].includes(input.terminalVerdict)) missing.push("validation terminal verdict");
	if (isEmptyEvidence(input.validationEvidence)) missing.push("validation evidence");
	if (!taskContractHasRollbackOrMetric(input.taskContract)) missing.push("rollback or metric contract");
	if (missing.length > 0) {
		throw new Error(`kda-humanize cannot record terminal evidence; missing ${missing.join(", ")}`);
	}
}

function taskContractHasRollbackOrMetric(value) {
	const text = typeof value === "string" ? value : JSON.stringify(value);
	return hasHeadingOrField(text, "rollback plan") || hasHeadingOrField(text, "metric");
}

function hasHeadingOrField(text, label) {
	const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const pattern = new RegExp(`(^|\\n)\\s*(?:#+\\s*)?${escaped}\\s*:`, "iu");
	const headingPattern = new RegExp(`^\\s*#+\\s*${escaped}\\s*$`, "imu");
	return pattern.test(text) || headingPattern.test(text);
}
