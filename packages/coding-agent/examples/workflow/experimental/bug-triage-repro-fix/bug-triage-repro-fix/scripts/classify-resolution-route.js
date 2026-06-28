const state = workflowContext.state && typeof workflowContext.state === "object" ? workflowContext.state : {};
const task = state.task && typeof state.task === "object" ? state.task : {};
const repro = state.repro && typeof state.repro === "object" ? state.repro : {};
const cause = state.cause && typeof state.cause === "object" ? state.cause : {};

const reproductionExitCode = typeof repro.exitCode === "number" ? repro.exitCode : null;
const allowedNoCodeResolution = allowsNoCodeResolution(task);
const route = allowedNoCodeResolution && reproductionExitCode === 0 ? "no-code" : "patch";
const resolution = {
	route,
	allowedNoCodeResolution,
	reproductionExitCode,
	reason:
		route === "no-code"
			? "task contract permits no-code resolution and the task-declared reproduction command exited successfully"
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
		`- The task-declared reproduction command exited with ${String(reproductionExitCode)}.`,
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
		"Because the frozen task contract permits no-code resolution and the reproduction command passed,",
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
	return /\bNo-Code Resolution\s*:\s*allowed\b/iu.test(taskText);
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
