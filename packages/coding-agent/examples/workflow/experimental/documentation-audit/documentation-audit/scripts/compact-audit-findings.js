const state = workflowContext.state && typeof workflowContext.state === "object" ? workflowContext.state : {};
const SECTION_CHAR_LIMIT = 1600;
const SIGNAL_LIMIT = 32;
const SIGNAL_TEXT_LIMIT = 280;

const auditDigest = {
	inventory: compactSection("inventory", state.inventory),
	apiDocsAudit: compactSection("apiDocsAudit", state.apiDocsAudit),
	tutorialAudit: compactSection("tutorialAudit", state.tutorialAudit),
	examplesAudit: compactSection("examplesAudit", state.examplesAudit),
};

await Bun.write("workflow-output/documentation-audit-digest.md", digestMarkdown(auditDigest));

return {
	summary: "compacted documentation audit fan-in for bounded consolidation",
	data: auditDigest,
	statePatch: [{ op: "set", path: "/auditDigest", value: auditDigest }],
};

function compactSection(name, value) {
	const text = stableString(value);
	return {
		source: name,
		originalChars: text.length,
		excerpt: truncateMiddle(text, SECTION_CHAR_LIMIT),
		truncated: text.length > SECTION_CHAR_LIMIT,
		signals: extractSignals(value),
	};
}

function stableString(value) {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value, sortObjectKeys, 2) ?? "";
	} catch {
		return String(value);
	}
}

function sortObjectKeys(_key, value) {
	if (Array.isArray(value) || value === null || typeof value !== "object") return value;
	const sorted = {};
	for (const key of Object.keys(value).sort()) sorted[key] = value[key];
	return sorted;
}

function truncateMiddle(text, maxChars) {
	if (text.length <= maxChars) return text;
	const half = Math.floor((maxChars - 80) / 2);
	return `${text.slice(0, half)}\n\n...[omitted ${text.length - maxChars} chars]...\n\n${text.slice(-half)}`;
}

function extractSignals(value) {
	const signals = [];
	collectSignals(value, [], signals);
	return uniqueSignals(signals).slice(0, SIGNAL_LIMIT);
}

function collectSignals(value, path, signals) {
	if (Array.isArray(value)) {
		for (let index = 0; index < value.length; index += 1) {
			collectSignals(value[index], [...path, String(index)], signals);
		}
		return;
	}
	if (!value || typeof value !== "object") return;
	const signal = signalFromObject(value, path);
	if (signal) signals.push(signal);
	for (const [key, child] of Object.entries(value)) collectSignals(child, [...path, key], signals);
}

function signalFromObject(value, path) {
	const id = firstString(value, ["id", "findingId", "finding_id", "gapId", "gap_id", "anchor", "name", "title"]);
	const status = firstString(value, ["status", "verdict", "decision", "result", "classification"]);
	const targets = uniqueStrings([
		...pathStrings(value, ["changedFileTargets", "changed_file_targets", "selectedTargets", "selected_targets"]),
		...pathStrings(value, ["targets", "targetFiles", "target_files", "files", "docs", "examples"]),
		...pathStrings(value, ["file", "path", "target", "artifact"]),
	]);
	const summary = firstString(value, [
		"finding",
		"gap",
		"issue",
		"summary",
		"recommendation",
		"coverageExpectation",
		"coverage_expectation",
		"evidence",
		"reason",
		"why",
		"description",
	]);
	const text = [id, status, summary, ...targets].join(" ");
	const actionable = /\b(?:actionable|missing|stale|gap|patch|repair|recommended|required|must|should|drift|blocked)\b/iu.test(
		text,
	);
	if (!id && targets.length === 0 && !actionable) return undefined;
	return {
		id: truncateText(id || path.filter(Boolean).join(".") || "audit-signal", SIGNAL_TEXT_LIMIT),
		...(status ? { status: truncateText(status, SIGNAL_TEXT_LIMIT) } : {}),
		...(targets.length > 0 ? { targets } : {}),
		...(summary ? { summary: truncateText(summary, SIGNAL_TEXT_LIMIT) } : {}),
	};
}

function firstString(value, keys) {
	for (const key of keys) {
		const text = stringFromValue(value[key]);
		if (text) return text;
	}
	return "";
}

function stringFromValue(value) {
	if (typeof value === "string") return value.trim();
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (Array.isArray(value)) return value.map(stringFromValue).filter(Boolean).join("; ");
	return "";
}

function pathStrings(value, keys) {
	const paths = [];
	for (const key of keys) collectPathStrings(value[key], paths);
	return paths.map(normalizePath).filter(isProjectPathLike);
}

function collectPathStrings(value, paths) {
	if (typeof value === "string") {
		paths.push(value);
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) collectPathStrings(item, paths);
		return;
	}
	if (!value || typeof value !== "object") return;
	for (const key of ["file", "path", "target"]) collectPathStrings(value[key], paths);
}

function normalizePath(value) {
	return value
		.replace(/^`+|`+$/gu, "")
		.replace(/^['"]|['"]$/gu, "")
		.trim()
		.replace(/^\.\//u, "");
}

function isProjectPathLike(value) {
	return value !== "" && !/\s/u.test(value) && /[./]/u.test(value);
}

function uniqueSignals(signals) {
	const seen = new Set();
	const unique = [];
	for (const signal of signals) {
		const key = JSON.stringify(signal);
		if (seen.has(key)) continue;
		seen.add(key);
		unique.push(signal);
	}
	return unique;
}

function uniqueStrings(values) {
	return [...new Set(values)];
}

function truncateText(text, maxChars) {
	return text.length <= maxChars ? text : `${text.slice(0, maxChars - 3)}...`;
}

function digestMarkdown(digest) {
	const lines = ["# Documentation Audit Digest", ""];
	for (const [name, section] of Object.entries(digest)) {
		lines.push(`## ${name}`, "", `Original chars: ${section.originalChars}`, `Truncated: ${section.truncated}`, "", "```json");
		lines.push(section.excerpt);
		lines.push("```", "");
		if (section.signals.length > 0) {
			lines.push("### Preserved Signals", "", "```json", JSON.stringify(section.signals, null, 2), "```", "");
		}
	}
	return lines.join("\n");
}
