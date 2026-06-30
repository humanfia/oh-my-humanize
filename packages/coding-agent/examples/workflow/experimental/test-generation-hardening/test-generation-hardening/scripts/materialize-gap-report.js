const RUNTIME_DATA_KEYS = new Set([
	"exitCode",
	"summaryTruncated",
	"summaryBytes",
	"agentId",
	"outputPath",
	"sessionFile",
	"patchPath",
	"branchName",
	"changesApplied",
	"retryHistory",
]);

const gaps = workflowContext.state?.gaps ?? (await materializeCoverageGapHandoff(latestCompletedActivation("inspectCoverage")));
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
	if (validation.startable === false) return true;
	if (typeof validation.exitCode === "number" && validation.exitCode !== 0) return true;
	if (typeof validation.status !== "string") return false;
	return /\b(?:blocked|fail|failed|failure|cannot|unclean)\b/iu.test(validation.status);
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

function latestCompletedActivation(nodeId) {
	const completed = Array.isArray(workflowContext.completedActivations)
		? workflowContext.completedActivations.filter(
				activation => activation.nodeId === nodeId && activation.status === "completed",
			)
		: [];
	const activation = completed.at(-1);
	if (activation) return activation;
	throw new Error(`test-generation-hardening could not find completed ${nodeId} activation`);
}

async function materializeCoverageGapHandoff(activation) {
	const summary = activationSummary(activation);
	const data = activationData(activation);
	const source =
		gapReportSource(parseObjectFromText(summary)) ??
		gapReportSource(data) ??
		gapReportSource(await parseGapReportFromActivationSession(activation));
	if (!source) {
		throw new Error(`test-generation-hardening ${activation.nodeId} did not return a structured coverage gap report`);
	}
	const value = {
		...source,
		status: stringValue(source.status, "ready"),
		summary: stringValue(source.summary, summary || "Coverage inspection completed."),
		source_node: "inspectCoverage",
		source_activation_id: activation.id,
	};
	return value;
}

function activationSummary(activation) {
	const summary = activation?.output?.summary;
	return typeof summary === "string" ? summary.trim() : "";
}

function activationData(activation) {
	const value = activation?.output?.data;
	if (!isRecord(value)) return {};
	const data = {};
	for (const [key, child] of Object.entries(value)) {
		if (RUNTIME_DATA_KEYS.has(key)) continue;
		data[key] = child;
	}
	return data;
}

async function parseGapReportFromActivationSession(activation) {
	const sessionFile = activation?.output?.data?.sessionFile;
	if (typeof sessionFile !== "string" || !sessionFile.trim()) return undefined;
	let records = [];
	try {
		records = Bun.JSONL.parse(await Bun.file(sessionFile).text());
	} catch {
		return undefined;
	}
	for (const record of records.toReversed()) {
		for (const text of assistantTextBlocks(record).toReversed()) {
			const source = gapReportSource(parseObjectFromText(text));
			if (source) return source;
		}
	}
	return undefined;
}

function assistantTextBlocks(record) {
	if (!isRecord(record)) return [];
	if (record.type !== "message") return [];
	const message = record.message;
	if (!isRecord(message) || message.role !== "assistant") return [];
	const content = Array.isArray(message.content) ? message.content : [];
	const texts = [];
	for (const item of content) {
		if (!isRecord(item) || item.type !== "text" || typeof item.text !== "string") continue;
		texts.push(item.text);
	}
	return texts;
}

function gapReportSource(value) {
	if (!isRecord(value)) return undefined;
	if (isRecord(value.data)) {
		const nested = gapReportSource(value.data);
		if (nested) {
			return typeof value.summary === "string" && !nested.summary ? { ...nested, summary: value.summary } : nested;
		}
	}
	if (!isStructuredGapReport(value)) return undefined;
	return value;
}

function isStructuredGapReport(value) {
	if (typeof value.status === "string" && value.status.trim()) return true;
	if (isRecord(value.validation)) return true;
	if (hasNonEmptyArray(value.unitGaps)) return true;
	if (hasNonEmptyArray(value.integrationGaps)) return true;
	if (hasNonEmptyArray(value.regressionRisks)) return true;
	if (hasNonEmptyArray(value.filesLikelyToNeedTestChanges)) return true;
	if (hasNonEmptyArray(value.smallestUsefulTestAdditions)) return true;
	return false;
}

function hasNonEmptyArray(value) {
	return Array.isArray(value) && value.length > 0;
}

function parseObjectFromText(text) {
	if (!text.trim()) return undefined;
	const direct = parseJsonObject(text.trim());
	if (direct) return direct;
	const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/iu);
	if (fence?.[1]) {
		const fenced = parseJsonObject(fence[1].trim());
		if (fenced) return fenced;
	}
	const lines = text
		.split(/\r?\n/)
		.map(line => line.trim())
		.filter(line => line.length > 0);
	for (const line of lines.toReversed()) {
		const parsed = parseJsonObject(line);
		if (parsed) return parsed;
	}
	return undefined;
}

function parseJsonObject(text) {
	try {
		const parsed = JSON.parse(text);
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
