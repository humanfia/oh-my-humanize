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
const tupleId = await tupleIdFromRunArtifacts(taskContract);
const runtimeTaskContract = taskContractWithWorkflowFinalizationRule(taskContract, tupleId);

return {
	summary: "parallel implementation task contract recorded from task.md",
	statePatch: [
		{ op: "set", path: "/taskContract", value: runtimeTaskContract.slice(0, 8000) },
		{ op: "set", path: "/runtime", value: runtimeFromTaskContract(taskContract, tupleId) },
	],
};

function runtimeFromTaskContract(_taskContract, tupleId) {
	return {
		startedAtMs: Date.now(),
		canonicalTupleId: tupleId,
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

function taskContractWithWorkflowFinalizationRule(text, tupleId) {
	return [workflowFinalizationRule(tupleId), text].join("\n\n");
}

function workflowFinalizationRule(tupleId) {
	return [
		"Workflow-owned finalization rule:",
		tupleId ? `- Canonical tuple id: ${tupleId}` : "- Canonical tuple id: (not declared)",
		"- Every lane-authored tuple-scoped artifact must use the exact Canonical tuple id above. Do not derive a different tuple id from free-form task prose, commit ids, project ids, task slugs, run ids, monitor labels, or scope-agent plans.",
		"- Any task requirement for a final archive, final review, final status, promotion decision, or tuple state is satisfied only by the workflow finalizer node after evidenceContractGuard and strongReview.",
		"- Lane, integration-review, and reviewer agents must not write workflow-output artifacts whose basename starts with `final-`, starts with `final_`, contains `-final-`, starts with `strong-review`, starts with `promotion-decision`, or is `tuple-state.json`.",
		"- Archive evidence package means lane-owned evidence, not final archive. Agents must use lane/reviewer names such as `workflow-output/docs-evidence-<tuple-id>.md`, `workflow-output/lane-archive-<lane>-<tuple-id>.md`, `workflow-output/integration-review-<tuple-id>.json`, or `workflow-output/reviewer-notes-<tuple-id>.md`; the finalizer node will later produce the final archive and final review artifacts.",
		"",
		"Workflow evidence quality rule:",
		"- Mechanical inventories from parsed file names, test names, benchmarks, fuzz names, or wrapper package expansion are index-only. They may guide review, but they do not satisfy semantic investigation, implementation, documentation, or promotion evidence.",
		"- A lane may claim semantic investigation only for directly inspected behavior. Evidence must name exact files and observed contracts, and explain what was learned beyond the identifier names.",
		"- If a lane only has mechanical inventory evidence, it must record an unresolved integration risk instead of claiming completion.",
	].join("\n");
}

function hasValidationContract(text) {
	return hasHeadingOrField(text, "validation command") || hasHeadingOrField(text, "manual evidence allowed");
}

async function tupleIdFromRunArtifacts(taskText) {
	for (const file of ["monitor-assignment.json", "manifest-entry.json"]) {
		try {
			const parsed = await Bun.file(file).json();
			const tupleId =
				normalizeTupleId(parsed.tupleId) ||
				normalizeTupleId(parsed.tuple_id) ||
				normalizeTupleId(parsed.runId) ||
				normalizeTupleId(parsed.run_id);
			if (tupleId) return tupleId;
		} catch {
			// Try the next source.
		}
	}
	const taskTuple = tupleIdFromTaskText(taskText);
	if (taskTuple) return taskTuple;
	return "";
}

function tupleIdFromTaskText(text) {
	const match = /\b(?:tuple|tuple id|tuple-id|monitor|run id|canary tuple)\b[^A-Za-z0-9]+([A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+){1,8})/iu.exec(
		text,
	);
	return normalizeTupleId(match?.[1]);
}

function normalizeTupleId(value) {
	if (typeof value !== "string") return "";
	const trimmed = value.trim().replace(/^`+|`+$/gu, "");
	return /^[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+){1,8}$/u.test(trimmed) ? trimmed : "";
}

function hasHeadingOrField(text, label) {
	const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const pattern = new RegExp(`(^|\\n)\\s*(?:#+\\s*)?${escaped}\\s*:`, "iu");
	const headingPattern = new RegExp(`^\\s*#+\\s*${escaped}\\s*$`, "imu");
	return pattern.test(text) || headingPattern.test(text);
}
