const state = workflowContext.state && typeof workflowContext.state === "object" ? workflowContext.state : {};
const task = state.task && typeof state.task === "object" ? state.task : {};
const compatibility = state.compatibility && typeof state.compatibility === "object" ? state.compatibility : undefined;

if (!compatibility) {
	throw new Error("refactor-migration-plan requires /compatibility before enforceCompatibilityGate");
}

const reasons = compatibilityBlockReasons(compatibility);
const reportPath = "workflow-output/refactor-migration-compatibility-gate.md";
await Bun.write(reportPath, gateMarkdown({ task, compatibility, reasons }));

if (reasons.length > 0) {
	throw new Error(`refactor-migration-plan compatibility gate blocked migration: ${reasons.join("; ")}`);
}

return {
	summary: "compatibility gate passed",
	statePatch: [
		{
			op: "set",
			path: "/compatibilityGate",
			value: {
				status: "pass",
				reportPath,
				checkedAtMs: Date.now(),
			},
		},
	],
};

function compatibilityBlockReasons(compatibilityState) {
	const reasons = [];
	const status = normalizedText(compatibilityState.status);
	if (statusIncludesBlocker(status)) {
		reasons.push(`compatibility status is ${String(compatibilityState.status)}`);
	}

	const validation =
		compatibilityState.validation && typeof compatibilityState.validation === "object"
			? compatibilityState.validation
			: {};
	const migrationDecision =
		compatibilityState.migration_decision && typeof compatibilityState.migration_decision === "object"
			? compatibilityState.migration_decision
			: {};

	const stopCondition = validation.stop_condition_hit ?? validation.stopConditionHit;
	if (typeof stopCondition === "string" && stopCondition.trim() !== "") {
		reasons.push(`compatibility validation stop condition: ${stopCondition.trim()}`);
	}

	if (validation.startable === false || validation.validation_startable === false) {
		reasons.push("compatibility validation command is not startable");
	}

	for (const [label, value] of [
		["validation exit code", validation.validation_exit_code ?? validation.validationExitCode],
		["compatibility exit code", validation.compatibility_exit_code ?? validation.compatibilityExitCode],
	]) {
		if (isFailingExitCode(value)) reasons.push(`${label} is ${value}`);
	}

	if (migrationDecision.source_edits_performed === false && statusIncludesBlocker(status)) {
		reasons.push("compatibility explicitly requested no source changes");
	}

	return uniqueStrings(reasons);
}

function statusIncludesBlocker(status) {
	return (
		status.includes("fail") ||
		status.includes("blocked") ||
		status.includes("no-source-change") ||
		status.includes("no_source_change") ||
		status.includes("no source change")
	);
}

function isFailingExitCode(value) {
	return typeof value === "number" && Number.isFinite(value) && value !== 0;
}

function normalizedText(value) {
	return typeof value === "string" ? value.toLowerCase().replaceAll("_", "-").trim() : "";
}

function uniqueStrings(values) {
	return [...new Set(values)];
}

function gateMarkdown({
	task,
	compatibility,
	reasons,
}) {
	const lines = [
		"# Refactor Migration Compatibility Gate",
		"",
		`Status: ${reasons.length > 0 ? "blocked" : "pass"}`,
		"",
		"## Reasons",
		"",
		reasons.length > 0 ? reasons.map(reason => `- ${reason}`).join("\n") : "- No blocking compatibility evidence.",
		"",
		"## Validation Command",
		"",
		"```text",
		typeof task.validationCommand === "string" ? task.validationCommand : "(not declared)",
		"```",
		"",
		"## Compatibility State",
		"",
		"```json",
		JSON.stringify(compatibility, null, 2),
		"```",
		"",
	];
	return lines.join("\n");
}
