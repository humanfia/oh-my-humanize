const gaps = workflowContext.state?.gaps;
if (!gaps || typeof gaps !== "object") {
	throw new Error("test-generation-hardening requires /gaps before materializeGapReport");
}

const outputPath = "workflow-output/test-hardening-gap-report.md";
await Bun.write(outputPath, gapReportMarkdown(gaps));

if (isBlocked(gaps)) {
	throw new Error(`test-generation-hardening coverage inspection blocked; see ${outputPath}`);
}

return {
	summary: `materialized coverage gap report at ${outputPath}`,
	statePatch: [
		{
			op: "set",
			path: "/gaps",
			value: {
				...gaps,
				gapReportPath: outputPath,
			},
		},
	],
};

function isBlocked(gaps) {
	if (gaps.status === "blocked") return true;
	const validation = gaps.validation;
	if (!validation || typeof validation !== "object") return false;
	return validation.startable === false || validation.status === "blocked";
}

function gapReportMarkdown(gaps) {
	return [
		"# Test Hardening Gap Report",
		"",
		"## Status",
		"",
		stringValue(gaps.status, "ready"),
		"",
		"## Summary",
		"",
		stringValue(gaps.summary, "No summary provided."),
		"",
		"## Validation",
		"",
		validationMarkdown(gaps.validation),
		"",
		"## Unit Gaps",
		"",
		listMarkdown(gaps.unitGaps),
		"",
		"## Integration Gaps",
		"",
		listMarkdown(gaps.integrationGaps),
		"",
		"## Regression Risks",
		"",
		listMarkdown(gaps.regressionRisks),
		"",
		"## Files Likely To Need Test Changes",
		"",
		listMarkdown(gaps.filesLikelyToNeedTestChanges),
		"",
		"## Smallest Useful Test Additions",
		"",
		listMarkdown(gaps.smallestUsefulTestAdditions),
		"",
		"## Raw Structured Gaps",
		"",
		"```json",
		JSON.stringify(gaps, null, 2),
		"```",
		"",
	].join("\n");
}

function validationMarkdown(validation) {
	if (!validation || typeof validation !== "object") return "No validation probe was reported.";
	const lines = [];
	if (typeof validation.command === "string") lines.push(`- Command: \`${validation.command}\``);
	if (typeof validation.startable === "boolean") lines.push(`- Startable: ${validation.startable}`);
	if (typeof validation.status === "string") lines.push(`- Status: ${validation.status}`);
	if (typeof validation.exitCode === "number") lines.push(`- Exit code: ${validation.exitCode}`);
	if (typeof validation.stderr === "string" && validation.stderr.trim()) {
		lines.push("- Stderr:");
		lines.push("");
		lines.push("```text");
		lines.push(bounded(validation.stderr));
		lines.push("```");
	}
	return lines.length ? lines.join("\n") : "No validation probe was reported.";
}

function listMarkdown(value) {
	const items = Array.isArray(value) ? value : [];
	if (!items.length) return "- None reported.";
	return items.map(item => `- ${stringValue(item, JSON.stringify(item))}`).join("\n");
}

function stringValue(value, fallback) {
	return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function bounded(text) {
	const limit = 8000;
	if (text.length <= limit) return text;
	return `${text.slice(0, limit)}\n[truncated ${text.length - limit} bytes]`;
}
