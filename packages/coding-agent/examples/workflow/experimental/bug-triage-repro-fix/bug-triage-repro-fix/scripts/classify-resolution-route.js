const state = workflowContext.state && typeof workflowContext.state === "object" ? workflowContext.state : {};
const task = state.task && typeof state.task === "object" ? state.task : {};
const repro = state.repro && typeof state.repro === "object" ? state.repro : {};
const cause = state.cause && typeof state.cause === "object" ? state.cause : {};

const reproductionExitCode = typeof repro.exitCode === "number" ? repro.exitCode : null;
const allowedNoCodeResolution = allowsNoCodeResolution(task);
const noCodeCauseResolution = hasNoCodeCauseResolution(cause);
const patchableCauseEvidence = hasPatchableCauseEvidence(cause);
const reproductionPassed = reproductionExitCode === 0;
if (reproductionPassed && !patchableCauseEvidence && !allowedNoCodeResolution && !noCodeCauseResolution) {
	throw new Error(
		"bug triage reproduction exited successfully without patchable cause evidence and the task contract does not permit no-code resolution; provide a failing reproduction command, record concrete patchable cause evidence, or declare `No-Code Resolution: allowed` / `No-Code/No-Change Allowed: Yes`",
	);
}
const route = allowedNoCodeResolution && !patchableCauseEvidence && (reproductionPassed || noCodeCauseResolution) ? "no-code" : "patch";
const noCodeBasis = reproductionPassed
	? "the task-declared reproduction command exited successfully"
	: "isolateCause explicitly recorded no-code resolution evidence";
const resolution = {
	route,
	allowedNoCodeResolution,
	reproductionExitCode,
	noCodeCauseResolution,
	patchableCauseEvidence,
	reason:
		route === "no-code"
			? `task contract permits no-code resolution and ${noCodeBasis}`
			: patchableCauseEvidence
				? "isolateCause recorded concrete patchable cause evidence, so route to a code or test patch path"
				: "task-declared reproduction still requires a code or test patch path",
};

if (route !== "no-code") {
	return {
		summary: "bug triage route requires patching",
		data: resolution,
		statePatch: [
			{
				op: "set",
				path: "/resolution",
				value: resolution,
			},
		],
	};
}

const rollbackPath = "workflow-output/bugfix-rollback.md";
const rootCauseReconciliationPath = "workflow-output/no-bug-root-cause.md";
const reproductionPath = typeof repro.outputPath === "string" ? repro.outputPath : "workflow-output/reproduction.md";
await Bun.write(
	rollbackPath,
	[
		"# Bugfix Rollback",
		"",
		"No project files were changed.",
		"",
		"## Evidence",
		"",
		"- The frozen task contract explicitly allows `No-Code Resolution: allowed`.",
		`- Route basis: ${noCodeBasis}.`,
		`- The task-declared reproduction command exited with ${String(reproductionExitCode)}.`,
		noCodeCauseResolution ? "- isolateCause explicitly recorded `resolution: no-code`." : "",
		`- Reproduction evidence: ${reproductionPath}.`,
		"",
		"## Rollback",
		"",
		"No rollback is needed because the no-code route leaves the project tree unchanged.",
		"",
		"## Invalidation",
		"",
		"Reopen the patch route if the reproduction command is later shown not to exercise the reported behavior.",
		"",
	].join("\n"),
);
await Bun.write(
	rootCauseReconciliationPath,
	[
		"# No-Code Root-Cause Analysis",
		"",
		"## Cause Reconciliation",
		"",
		"The isolateCause handoff is reconciled against the task-declared reproduction command.",
		`Because the frozen task contract permits no-code resolution and ${noCodeBasis},`,
		"any defect-like fix boundary from isolateCause is treated as refuted for this run unless later evidence",
		"shows that the reproduction command did not exercise the reported behavior.",
		"",
		"## Cause Evidence Summary",
		"",
		boundedLines(evidenceText(cause), 80) || "(no structured cause evidence was recorded)",
		"",
	].join("\n"),
);

return {
	summary: "bug triage route selected no-code evidence path",
	data: resolution,
	statePatch: [
		{
			op: "set",
			path: "/resolution",
			value: resolution,
		},
		{
			op: "set",
			path: "/patch",
			value: {
				mode: "no-code",
				changedFiles: [],
				rollbackPath,
				rootCauseReconciliationPath,
			},
		},
	],
};

function allowsNoCodeResolution(value) {
	const taskText = typeof value.taskText === "string" ? value.taskText : typeof value.text === "string" ? value.text : "";
	return [
		/\bNo-Code Resolution\s*:\s*allowed\b/iu,
		/\bNo-Code(?:\s*\/\s*No-Change)?\s+Allowed\s*:\s*(?:yes|true|allowed)\b/iu,
	].some(pattern => pattern.test(taskText));
}

function hasNoCodeCauseResolution(value) {
	return (
		typeof value.resolution === "string" &&
		/^no[-\s]?code$/iu.test(value.resolution.trim())
	);
}

function hasPatchableCauseEvidence(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	if (hasNoCodeCauseResolution(value)) return false;
	const boundary = value.narrowest_fix_boundary;
	if (boundary && typeof boundary === "object" && !Array.isArray(boundary)) {
		return hasMeaningfulField(boundary.target) || hasMeaningfulField(boundary.likely_change_surface) || hasMeaningfulField(boundary.test_boundary);
	}
	return false;
}

function hasMeaningfulField(value) {
	if (typeof value === "string") return value.trim().length > 0;
	if (Array.isArray(value)) return value.some(hasMeaningfulField);
	return false;
}

function evidenceText(value) {
	if (value === undefined || value === null) return "";
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (Array.isArray(value)) return value.map(evidenceText).join("\n");
	if (typeof value !== "object") return "";
	return Object.entries(value)
		.map(([key, entry]) => `${key}: ${evidenceText(entry)}`)
		.join("\n");
}

function boundedLines(text, limit) {
	const lines = text.split(/\r?\n/u);
	const kept = lines.slice(0, limit);
	if (lines.length > limit) kept.push(`[truncated ${lines.length - limit} additional lines]`);
	return kept.join("\n");
}
