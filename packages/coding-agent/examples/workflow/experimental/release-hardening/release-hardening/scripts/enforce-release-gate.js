const state = workflowContext.state && typeof workflowContext.state === "object" ? workflowContext.state : {};
const checks = state.checks && typeof state.checks === "object" ? state.checks : {};
const outputPath = "workflow-output/release-gate.md";
const reviewVerdict = String(state.review ?? "");
const holdingForFreshContract = reviewVerdict === "hold";

const auditText = await readOptionalText("workflow-output/release-audit.md");
const rollbackText = await readOptionalText("workflow-output/release-rollback.md");
const blockers = [
	...auditBlockers(state.changelog, "changelog"),
	...auditBlockers(state.compatibility, "compatibility"),
];
const unresolvedBlockers = blockers.filter(blocker => !auditResolvesBlocker(auditText, blocker));
const failures = [];

if (reviewVerdict !== "finish" && !holdingForFreshContract) {
	failures.push(`release reviewer verdict is not finish or hold: ${reviewVerdict || "(missing)"}`);
}
if (checks.status !== "pass" && !holdingForFreshContract) {
	failures.push(`declared checks did not pass: ${String(checks.status ?? "(missing)")}`);
}
if (!auditText.trim()) {
	failures.push("missing workflow-output/release-audit.md");
}
if (!rollbackText.trim()) {
	failures.push("missing workflow-output/release-rollback.md");
}
for (const blocker of unresolvedBlockers) {
	failures.push(`unresolved audit blocker from ${blocker.source}: ${blocker.text}`);
}
const holdReasons = holdingForFreshContract
	? [
			`release reviewer requested fresh task contract: ${reviewVerdict}`,
			...(checks.status === "pass" ? [] : [`declared checks did not pass: ${String(checks.status ?? "(missing)")}`]),
			...failures,
		]
	: [];
const status = holdingForFreshContract ? "hold" : failures.length === 0 ? "pass" : "fail_closed";

await Bun.write(outputPath, gateMarkdown({ checks, failures, blockers, unresolvedBlockers, status, holdReasons }));

if (failures.length > 0 && !holdingForFreshContract) {
	throw new Error(`release gate fail-closed: ${failures[0]}`);
}

return {
	summary: holdingForFreshContract ? "release gate held for fresh task contract" : "release gate passed",
	data: { status, unresolvedBlockers, holdReasons },
	statePatch: [
		{
			op: "set",
			path: "/releaseGate",
			value: {
				status,
				outcome: holdingForFreshContract ? "rejected" : "accepted",
				outputPath,
				blockerCount: blockers.length,
				unresolvedBlockers,
				holdReasons,
			},
		},
	],
};

function auditBlockers(value, source) {
	const texts = flattenEvidence(value).filter(isBlockingEvidence);
	return texts.map(text => ({ source, text: concise(text) }));
}

function flattenEvidence(value) {
	if (value === undefined || value === null) return [];
	if (typeof value === "string") return [value];
	if (typeof value === "number" || typeof value === "boolean") return [String(value)];
	if (Array.isArray(value)) return value.flatMap(flattenEvidence);
	if (typeof value !== "object") return [];
	if (isStructuredFinding(value)) return [structuredFindingText(value)];
	return Object.entries(value).flatMap(([key, entry]) => flattenEvidence(entry).map(text => `${key}: ${text}`));
}

function isStructuredFinding(value) {
	const keys = Object.keys(value).map(key => key.toLowerCase());
	return keys.some(key => ["blocker", "finding", "gap", "issue", "risk", "summary"].includes(key));
}

function structuredFindingText(value) {
	return Object.entries(value)
		.flatMap(([key, entry]) => flattenEvidence(entry).map(text => `${key}: ${text}`))
		.join("; ");
}

function isBlockingEvidence(text) {
	const normalized = text.toLowerCase();
	if (/(no|not|without)\s+(release\s+)?(blocker|risk|gap|missing|stale|repair|required)/u.test(normalized)) {
		return false;
	}
	return /\b(blocker|blocks?|must fix|repair required|required repair|missing|stale|gap|inconsistent|risk|hold)\b/u.test(
		normalized,
	);
}

function auditResolvesBlocker(auditText, blocker) {
	const normalized = auditText.toLowerCase();
	if (!/\b(resolved|waived|waiver|accepted risk|no longer blocks?)\b/u.test(normalized)) return false;
	return evidenceTokens(blocker.text).some(token => normalized.includes(token));
}

function evidenceTokens(text) {
	return [...new Set(text.toLowerCase().match(/[a-z0-9_./-]{5,}/gu) ?? [])].filter(
		token => !["finding", "summary", "status", "should", "needs", "until", "release"].includes(token),
	);
}

function gateMarkdown({ checks, failures, blockers, unresolvedBlockers, status, holdReasons }) {
	return [
		"# Release Gate Evidence",
		"",
		`status: ${status}`,
		`checks_status: ${String(checks.status ?? "(missing)")}`,
		`audit_blockers: ${blockers.length}`,
		`unresolved_blockers: ${unresolvedBlockers.length}`,
		...(holdReasons.length ? ["", "## Hold Reasons", "", ...holdReasons.map(reason => `- ${reason}`)] : []),
		"",
		"## Failures",
		"",
		...(failures.length === 0 ? ["- none"] : failures.map(failure => `- ${failure}`)),
		"",
		"## Audit Blockers",
		"",
		...(blockers.length === 0
			? ["- none"]
			: blockers.map(blocker => `- ${blocker.source}: ${blocker.text}`)),
		"",
	].join("\n");
}

async function readOptionalText(filePath) {
	try {
		return await Bun.file(filePath).text();
	} catch {
		return "";
	}
}

function concise(text) {
	const normalized = text.replace(/\s+/gu, " ").trim();
	if (normalized.length <= 280) return normalized;
	return `${normalized.slice(0, 280)}...`;
}
