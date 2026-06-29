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
	selectedBranch: selectionValue(text, "Selected positive optimization branch"),
	noWinBranch: selectionValue(text, "No-win branch"),
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
	const lines = report.split(/\r?\n/u).filter((line) => commandLineMatches(line, commandName));
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

function commandLineMatches(line, commandName) {
	const pattern = commandName === "benchmark" ? /\bbenchmark(?: command)?\b/iu : /\bvalidation(?: command)?\b/iu;
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
	const match = /\b(?:exited|exit code)\s*(?:code\s*)?(\d+)\b/iu.exec(line);
	if (!match) return undefined;
	return Number(match[1]);
}

function selectionValue(report, label) {
	const pattern = new RegExp(String.raw`\b${escapeRegExp(label)}\s*:\s*([^.\n]+)`, "iu");
	const match = pattern.exec(report);
	if (!match) return "unknown";
	return stripMarkdown(match[1] ?? "").trim() || "unknown";
}

function stripMarkdown(value) {
	return value.replace(/[`*_]/gu, "").trim();
}

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
