const outputPath = "workflow-output/performance-selection-repair.md";
const text = (await readRequiredText(outputPath)).trim();

if (text.length === 0) {
	throw new Error(`${outputPath} is empty; repairPerformanceSelection must write durable repair evidence`);
}

const selectionRepair = {
	status: "materialized",
	file: outputPath,
	text,
	benchmark: commandEvidence(text, "benchmark"),
	validation: commandEvidence(text, "validation"),
	selectedBranch: selectionValue(text, ["Selected branch", "Selected positive optimization branch"]),
	noWinBranch: noWinBranchValue(text),
	noWinBranches: noWinBranches(text),
};

await Bun.write("workflow-output/performance-selection-repair.json", `${JSON.stringify(selectionRepair, null, 2)}\n`);

return {
	summary: "materialized performance selection repair evidence for reviewer prompts",
	statePatch: [
		{
			op: "set",
			path: "/selectionRepair",
			value: selectionRepair,
		},
	],
	artifacts: ["local://workflow-output/performance-selection-repair.json", `local://${outputPath}`],
};

async function readRequiredText(filePath) {
	try {
		return await Bun.file(filePath).text();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`${filePath} is required before materializeSelectionRepair: ${message}`);
	}
}

function commandEvidence(report, commandName) {
	const lines = commandEvidenceLines(report, commandName);
	const evidence = {
		status: "unknown",
	};
	for (const line of lines) {
		const status = statusFromLine(line);
		if (status !== undefined) evidence.status = status;
		const exitCode = exitCodeFromLine(line);
		if (exitCode !== undefined) evidence.exitCode = exitCode;
	}
	return evidence;
}

function commandEvidenceLines(report, commandName) {
	const lines = report.split(/\r?\n/u);
	const evidenceLines = [];
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		if (!commandLineMatches(line, commandName)) continue;
		evidenceLines.push(line);
		for (const nextLine of lines.slice(index + 1)) {
			if (/^##\s+/u.test(nextLine)) break;
			if (
				/\b(?:benchmark|validation)(?: command)?\s*:/iu.test(nextLine) &&
				!commandLineMatches(nextLine, commandName)
			) {
				break;
			}
			evidenceLines.push(nextLine);
		}
	}
	return evidenceLines;
}

function commandLineMatches(line, commandName) {
	const pattern =
		commandName === "benchmark"
			? /\b(?:declared\s+)?benchmark(?: command)?\b/iu
			: /\b(?:declared\s+)?validation(?: command)?\b/iu;
	return pattern.test(line);
}

function statusFromLine(line) {
	if (/\b(?:status|result)\s*:\s*(?:pass|passed|success|ok)\b/iu.test(line)) return "pass";
	if (/\b(?:status|result)\s*:\s*(?:fail|failed|failure|blocked|error)\b/iu.test(line)) return "fail";
	const exitCode = exitCodeFromLine(line);
	if (exitCode !== undefined) return exitCode === 0 ? "pass" : "fail";
	return undefined;
}

function exitCodeFromLine(line) {
	const match = /\b(?:exited|exit code|exit)\s*:?\s*(?:code\s*)?(\d+)\b/iu.exec(line);
	if (!match) return undefined;
	return Number(match[1]);
}

function selectionValue(report, labels) {
	const labelList = Array.isArray(labels) ? labels : [labels];
	for (const label of labelList) {
		const pattern = new RegExp(String.raw`\b${escapeRegExp(label)}\s*:\s*([^.\n]+)`, "iu");
		const match = pattern.exec(report);
		if (match) return stripMarkdown(match[1] ?? "").trim() || "unknown";
	}
	return "unknown";
}

function noWinBranchValue(report) {
	const explicit = selectionValue(report, "No-win branch");
	if (explicit !== "unknown") return explicit;
	const branches = noWinBranches(report);
	return branches.length > 0 ? branches.join(", ") : "unknown";
}

function noWinBranches(report) {
	return uniqueStrings([...branchListValue(selectionValue(report, "No-win branch")), ...inferredNoWinBranches(report)]);
}

function branchListValue(value) {
	const normalized = value.trim().toLowerCase();
	if (normalized === "" || normalized === "unknown" || /\bnone\b/iu.test(normalized)) return [];
	return value
		.split(/[,/]/u)
		.map((item) => stripMarkdown(item).toLowerCase())
		.filter((item) => ["algorithmic", "caching", "io", "no-win"].includes(item));
}

function inferredNoWinBranches(report) {
	return ["algorithmic", "caching", "io"].filter((branch) => /\bno-win-result\s*:\s*(?:yes|true)\b/iu.test(branchSection(report, branch)));
}

function branchSection(report, branch) {
	const lines = report.split(/\r?\n/u);
	const startPattern = new RegExp(String.raw`^\s*-?\s*${escapeRegExp(branch)}(?:\s+branch)?\s*:`, "iu");
	const otherStartPattern = new RegExp(
		String.raw`^\s*-?\s*(?:${["algorithmic", "caching", "io"].filter((name) => name !== branch).map(escapeRegExp).join("|")})(?:\s+branch)?\s*:`,
		"iu",
	);
	const section = [];
	let collecting = false;
	for (const line of lines) {
		if (startPattern.test(line)) {
			collecting = true;
			section.push(line);
			continue;
		}
		if (!collecting) continue;
		if (/^##\s+/u.test(line) || otherStartPattern.test(line)) break;
		section.push(line);
	}
	return section.join("\n");
}

function uniqueStrings(values) {
	return [...new Set(values.filter(Boolean))];
}

function stripMarkdown(value) {
	return value.replace(/[`*_]/gu, "").trim();
}

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
