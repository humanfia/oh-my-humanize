const state = workflowContext.state && typeof workflowContext.state === "object" ? workflowContext.state : {};
const task = state.task && typeof state.task === "object" ? state.task : {};
const benchmark = state.benchmark && typeof state.benchmark === "object" ? state.benchmark : {};
const selection = state.selection && typeof state.selection === "object" ? state.selection : {};
const selectionRepair = state.selectionRepair && typeof state.selectionRepair === "object" ? state.selectionRepair : {};
const selectionRepairText = await readOptionalText("workflow-output/performance-selection-repair.md");

if (!benchmarkCommandPassed(benchmark, selectionRepair, selectionRepairText)) {
	throw new Error("cannot archive performance search before the benchmark command passes");
}
if (!["pass", "blocked", "rejected"].includes(String(selection.status))) {
	throw new Error("cannot archive performance search before finalizePerformanceSelection passes");
}

const changedFiles = await gitDiffHeadChangedFiles();
const projectChangedFiles = changedFiles.filter((file) => !file.startsWith("workflow-output/") && file !== "task.md");

const outputPath = "workflow-output/performance-archive.md";
const baselineText = await readOptionalText("workflow-output/performance-baseline.md");
const benchmarkText = await readOptionalText("workflow-output/performance-benchmark.md");
const algorithmicText = await readOptionalText("workflow-output/perf-algorithmic.md");
const cachingText = await readOptionalText("workflow-output/perf-caching.md");
const ioText = await readOptionalText("workflow-output/perf-io.md");
const noWinText = await readOptionalText("workflow-output/perf-no-win.md");
const finalSelectionText = [algorithmicText, cachingText, ioText, noWinText].join("\n");
const hasRollbackEvidence = /\brollback\b/iu.test(finalSelectionText);
const hasFinalSelection = /\bfinal-selection\s*:\s*yes\b/iu.test(finalSelectionText);
const hasNoWinEvidence = /\bno-win-result\s*:\s*yes\b/iu.test(finalSelectionText);
if (!["positive", "no-win", "no-win-validation-blocked", "rejected-no-win-not-authorized"].includes(String(selection.terminalState))) {
	throw new Error(
		"cannot archive performance search before selection terminalState is positive, no-win, no-win-validation-blocked, or rejected-no-win-not-authorized",
	);
}
if (!hasRollbackEvidence) {
	throw new Error("cannot archive performance search before rollback evidence is recorded");
}
if (isNoWinTerminalState(selection.terminalState) && projectChangedFiles.length !== 0) {
	throw new Error("cannot archive no-win performance search with project changes still present");
}
if (selection.terminalState === "positive" && projectChangedFiles.length === 0) {
	throw new Error("cannot archive positive performance search without project changes");
}
if (isNoWinTerminalState(selection.terminalState) && !allowsNoWinArchive(task)) {
	throw new Error(
		"cannot archive performance search without real project changes; add explicit no-win or no-code/no-change authorization to task.md only for measured no-win investigations",
	);
}
if (isNoWinTerminalState(selection.terminalState) && !hasNoWinEvidence) {
	throw new Error("cannot archive no-win performance search before a branch records `no-win-result: yes` evidence");
}
if (selection.terminalState === "positive" && !hasFinalSelection) {
	throw new Error("cannot archive performance search with project changes before one branch records `final-selection: yes`");
}

await Bun.write(
	outputPath,
	[
		"# Performance Optimization Archive",
		"",
		"## Baseline",
		"",
		boundedLines(baselineText, 120),
		"",
		"## Benchmark",
		"",
		boundedLines(benchmarkText, 160),
		"",
		"## Branch Notes",
		"",
		"Selection:",
		"",
		`- terminalState: ${selection.terminalState}`,
		`- validation: ${selection.terminalState === "no-win-validation-blocked" ? "blocked" : "pass"}`,
		`- outcome: ${selection.status === "rejected" ? "rejected" : "accepted"}`,
		`- selectedBranches: ${Array.isArray(selection.selectedBranches) ? selection.selectedBranches.join(", ") || "none" : "unknown"}`,
		`- noWinBranches: ${Array.isArray(selection.noWinBranches) ? selection.noWinBranches.join(", ") || "none" : "unknown"}`,
		"",
		"Project changed files:",
		"",
		projectChangedFiles.length > 0 ? projectChangedFiles.map((file) => `- ${file}`).join("\n") : "No project changes.",
		"",
		"### Algorithmic",
		"",
		boundedLines(algorithmicText, 80),
		"",
		"### Caching",
		"",
		boundedLines(cachingText, 80),
		"",
		"### IO",
		"",
		boundedLines(ioText, 80),
		"",
		"### No-win",
		"",
		boundedLines(noWinText, 80),
		"",
	].join("\n"),
);

return {
	summary: "archived performance optimization evidence",
	statePatch: [
		{
			op: "set",
			path: "/archive",
			value: {
				file: outputPath,
				status: selection.status === "rejected" ? "rejected" : "accepted",
				benchmark: "pass",
				validation: selection.terminalState === "no-win-validation-blocked" ? "blocked" : "pass",
				projectChangedFiles,
				noWin: projectChangedFiles.length === 0,
			},
		},
	],
};

async function gitDiffHeadChangedFiles() {
	const proc = Bun.spawn(["git", "diff", "HEAD", "--name-only"], {
		cwd: process.cwd(),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (exitCode !== 0) throw new Error(`git diff HEAD failed: ${stderr.trim() || stdout.trim()}`);
	return stdout
		.split(/\r?\n/u)
		.map((line) => line.trim())
		.filter(Boolean);
}

function allowsNoWinArchive(taskValue) {
	const taskText = typeof taskValue.text === "string" ? taskValue.text : "";
	return (
		/\bNo-Win Result\s*:\s*allowed\b/iu.test(taskText) ||
		/\bNo-Code\/No-Change Allowed\s*:\s*(?:yes|true|allowed)\b/iu.test(taskText) ||
		/\bNo-Code Allowed\s*:\s*(?:yes|true|allowed)\b/iu.test(taskText)
	);
}

function benchmarkCommandPassed(benchmarkValue, selectionRepairValue, repairText) {
	const repairBenchmark = commandPassedFromRepairEvidence(selectionRepairValue?.benchmark);
	if (repairBenchmark !== undefined) return repairBenchmark;
	const repairReportBenchmark = commandPassedFromRepairReport(repairText, "benchmark");
	if (repairReportBenchmark !== undefined) return repairReportBenchmark;
	if (typeof benchmarkValue.benchmarkExitCode === "number") return benchmarkValue.benchmarkExitCode === 0;
	return benchmarkValue.status === "pass";
}

function commandPassedFromRepairEvidence(value) {
	if (!value || typeof value !== "object") return undefined;
	const exitCode = typeof value.exitCode === "number" ? value.exitCode : value.exit_code;
	if (typeof exitCode === "number") return exitCode === 0;
	if (typeof value.status === "string") return value.status.toLowerCase() === "pass";
	return undefined;
}

function commandPassedFromRepairReport(text, commandName) {
	if (typeof text !== "string" || text.trim() === "") return undefined;
	const commandPattern = commandName === "benchmark" ? /\bbenchmark command\b/iu : /\bvalidation command\b/iu;
	const lines = text
		.split(/\r?\n/u)
		.filter((line) => commandPattern.test(line))
		.filter((line) => /\b(?:exited|exit code)\s*(?:code\s*)?\d+\b/iu.test(line));
	const latest = lines.at(-1);
	if (!latest) return undefined;
	const match = /\b(?:exited|exit code)\s*(?:code\s*)?(\d+)\b/iu.exec(latest);
	if (!match) return undefined;
	return Number(match[1]) === 0;
}

function isNoWinTerminalState(terminalState) {
	return terminalState === "no-win" || terminalState === "no-win-validation-blocked";
}

async function readOptionalText(filePath) {
	try {
		return await Bun.file(filePath).text();
	} catch {
		return "";
	}
}

function boundedLines(text, limit) {
	const lines = text.split(/\r?\n/u);
	const kept = lines.slice(0, limit);
	if (lines.length > limit) kept.push(`[truncated ${lines.length - limit} additional lines]`);
	return kept.join("\n");
}
