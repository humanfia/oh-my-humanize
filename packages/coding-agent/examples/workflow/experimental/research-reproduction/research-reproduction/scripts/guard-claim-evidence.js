const state = workflowContext.state && typeof workflowContext.state === "object" ? workflowContext.state : {};
const task = state.task && typeof state.task === "object" ? state.task : {};
const claim = state.claim && typeof state.claim === "object" ? state.claim : {};
const claimText = structuredText(claim);
const sourceEvidenceText = structuredText(sourceEvidenceCandidates(claim, task));
const sourceRefs = collectSourceRefs(sourceEvidenceText || claimText);
const negativeEvidence = /\b(?:no concrete|not provided|not available|did not inspect|cannot cite|only named)\b/iu.test(
	sourceEvidenceText || claimText,
);

if (negativeEvidence || sourceRefs.length === 0 || !hasConcreteAnchor(sourceEvidenceText || claimText)) {
	await Bun.write(
		"workflow-output/claim-evidence-guard.md",
		[
			"# Claim Evidence Guard",
			"",
			"Status: fail",
			"",
			"Research reproduction requires concrete source/test evidence before running commands.",
			"The extracted claim must cite at least one project file plus a line, symbol, assertion, or excerpt.",
			"",
			"## Extracted Claim Preview",
			"",
			boundedLines(claimText || "(empty claim)", 80),
			"",
		].join("\n"),
	);
	throw new Error("research-reproduction claim lacks concrete source/test evidence");
}

const uniqueRefs = [...new Set(sourceRefs)].sort();
await Bun.write(
	"workflow-output/claim-evidence-guard.md",
	[
		"# Claim Evidence Guard",
		"",
		"Status: pass",
		"",
		"## Source References",
		"",
		...uniqueRefs.map(ref => `- ${ref}`),
		"",
	].join("\n"),
);

return {
	summary: `validated ${uniqueRefs.length} concrete claim evidence reference${uniqueRefs.length === 1 ? "" : "s"}`,
	statePatch: [
		{
			op: "set",
			path: "/claimEvidence",
			value: {
				status: "pass",
				file: "workflow-output/claim-evidence-guard.md",
				sourceCount: uniqueRefs.length,
				sourceRefs: uniqueRefs,
			},
		},
	],
};

function collectSourceRefs(text) {
	const refs = [];
	const pattern =
		/(?:^|[\s"'`([])([A-Za-z0-9_./-]+\.(?:c|cc|cpp|go|h|hpp|java|js|jsx|kt|md|py|rb|rs|rst|sh|ts|tsx|txt|yml|yaml)(?::\d+)?(?:::[A-Za-z_][A-Za-z0-9_]*)?)/giu;
	let match = pattern.exec(text);
	while (match !== null) {
		if (match[1] !== undefined) refs.push(match[1]);
		match = pattern.exec(text);
	}
	return refs;
}

function hasConcreteAnchor(text) {
	return (
		/:\d+\b/u.test(text) ||
		/\b(?:line|lines|L)\s*\d+\b/iu.test(text) ||
		/\b(?:test_[A-Za-z0-9_]+|def\s+[A-Za-z_][A-Za-z0-9_]*|fn\s+[A-Za-z_][A-Za-z0-9_]*)\b/u.test(text) ||
		/\b(?:assert|expect\(|raises\(|throws?|with pytest\.raises|should|must)\b/iu.test(text) ||
		/[`"'][^`"']{12,}[`"']/u.test(text)
	);
}

function sourceEvidenceCandidates(claim, task) {
	return [
		claim.evidence,
		claim.sourceEvidence,
		claim.source_refs,
		claim.sourceRefs,
		claim.concreteProjectEvidence,
		claim.projectEvidence,
		nestedObjectValue(claim, ["data", "concreteProjectEvidence"]),
		nestedObjectValue(claim, ["data", "projectEvidence"]),
		nestedObjectValue(claim, ["data", "sourceEvidence"]),
		nestedObjectValue(claim, ["data", "sourceRefs"]),
		nestedObjectValue(claim, ["claim", "evidence"]),
		nestedObjectValue(claim, ["claim", "sourceEvidence"]),
		task.claimSource,
	];
}

function nestedObjectValue(value, path) {
	let current = value;
	for (const segment of path) {
		if (current === null || current === undefined || typeof current !== "object" || Array.isArray(current)) return undefined;
		current = current[segment];
	}
	return current;
}

function structuredText(value) {
	if (value === null || value === undefined) return "";
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (Array.isArray(value)) return value.map(structuredText).join("\n");
	if (typeof value === "object") return Object.values(value).map(structuredText).join("\n");
	return "";
}

function boundedLines(text, limit) {
	const lines = text.split(/\r?\n/u);
	const kept = lines.slice(0, limit);
	if (lines.length > limit) kept.push(`[truncated ${lines.length - limit} additional lines]`);
	return kept.join("\n");
}
