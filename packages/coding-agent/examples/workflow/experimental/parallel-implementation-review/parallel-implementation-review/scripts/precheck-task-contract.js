let taskText = "";
try {
	taskText = await Bun.file("task.md").text();
} catch {
	taskText = "";
}

const taskContract = taskText.trim();
if (!taskContract) {
	throw new Error("parallel-implementation-review requires a task.md contract in the project root");
}
assertTaskContract(taskContract);
const runtimeTaskContract = taskContractWithWorkflowFinalizationRule(taskContract);

return {
	summary: "parallel implementation task contract recorded from task.md",
	statePatch: [
		{ op: "set", path: "/taskContract", value: runtimeTaskContract.slice(0, 8000) },
		{ op: "set", path: "/runtime", value: runtimeFromTaskContract(taskContract) },
	],
};

function runtimeFromTaskContract() {
	return {
		startedAtMs: Date.now(),
	};
}

function assertTaskContract(text) {
	const missing = [];
	if (!hasHeadingOrField(text, "objective")) missing.push("Objective");
	if (!hasHeadingOrField(text, "acceptance criteria")) missing.push("Acceptance Criteria");
	if (!hasValidationContract(text)) missing.push("Validation Command or Manual Evidence Allowed");
	if (!hasHeadingOrField(text, "lane ownership")) missing.push("Lane Ownership");
	if (!hasHeadingOrField(text, "stop conditions")) missing.push("Stop Conditions");
	if (missing.length > 0) {
		throw new Error(`parallel-implementation-review task.md missing required contract fields: ${missing.join(", ")}`);
	}
}

function taskContractWithWorkflowFinalizationRule(text) {
	return [workflowFinalizationRule(), text].join("\n\n");
}

function workflowFinalizationRule() {
	return [
		"Workflow-owned finalization rule:",
		"- Any task requirement for a final archive, final review, final status, promotion decision, or tuple state is satisfied only by the workflow finalizer node after evidenceContractGuard and strongReview.",
		"- Lane, integration-review, and reviewer agents must not write workflow-output artifacts whose basename starts with `final-`, starts with `final_`, contains `-final-`, starts with `strong-review`, starts with `promotion-decision`, or is `tuple-state.json`.",
		"- Agents must use lane/reviewer names such as `docs-evidence-<tuple-id>.md`, `integration-review-<tuple-id>.json`, or `reviewer-notes-<tuple-id>.md`; the finalizer node will later produce the final archive and final review artifacts.",
	].join("\n");
}

function hasValidationContract(text) {
	return hasHeadingOrField(text, "validation command") || hasHeadingOrField(text, "manual evidence allowed");
}

function hasHeadingOrField(text, label) {
	const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const pattern = new RegExp(`(^|\\n)\\s*(?:#+\\s*)?${escaped}\\s*:`, "iu");
	const headingPattern = new RegExp(`(^|\\n)\\s*#+\\s*${escaped}\\s*$`, "iu");
	return pattern.test(text) || headingPattern.test(text);
}
