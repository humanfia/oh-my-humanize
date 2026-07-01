const state = workflowContext.state && typeof workflowContext.state === "object" ? workflowContext.state : {};
const task = state.task && typeof state.task === "object" ? state.task : {};
const benchmark = state.benchmark && typeof state.benchmark === "object" ? state.benchmark : {};
const selection = state.selection && typeof state.selection === "object" ? state.selection : {};
const selectionRepair = state.selectionRepair && typeof state.selectionRepair === "object" ? state.selectionRepair : {};
const selectionRepairText = await readOptionalText("workflow-output/performance-selection-repair.md");
const reviewGate = reviewFinishGate(state.review);

if (benchmark.isolationViolation === true && !isolationViolationResolvedBySelectionRepair(selectionRepair, selectionRepairText)) {
	throw new Error("cannot archive performance search after a parallel lane isolation violation");
}

if (!reviewGate.passed) {
	throw new Error(`cannot archive performance search before reviewer finish: ${reviewGate.reason}`);
}

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
const benchmarkEvidence = await finalBenchmarkEvidence(benchmark, selectionRepair, selectionRepairText);
const algorithmicText = await readOptionalText("workflow-output/perf-algorithmic.md");
const cachingText = await readOptionalText("workflow-output/perf-caching.md");
const ioText = await readOptionalText("workflow-output/perf-io.md");
const noWinText = await readOptionalText("workflow-output/perf-no-win.md");
const finalSelectionText = [algorithmicText, cachingText, ioText, noWinText].join("\n");
const hasRollbackEvidence = /\brollback\b/iu.test(finalSelectionText);
const hasFinalSelection = /\bfinal-selection\s*:\s*yes\b/iu.test(finalSelectionText);
const hasSemanticProbeEvidence = semanticProbeEvidencePresent(finalSelectionText, selectionRepairText);
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
if (selection.terminalState === "positive" && !hasSemanticProbeEvidence) {
	throw new Error(
		"cannot archive positive performance search before semantic probe evidence is recorded for the retained candidate",
	);
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
		`Evidence: ${benchmarkEvidence.file}`,
		"",
		boundedLines(benchmarkEvidence.text, 160),
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
				benchmarkEvidence: benchmarkEvidence.file,
				validation: selection.terminalState === "no-win-validation-blocked" ? "blocked" : "pass",
				projectChangedFiles,
				noWin: isNoWinOutcome(selection.terminalState),
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

async function finalBenchmarkEvidence(benchmarkValue, selectionRepairValue, repairText) {
	const repairBenchmark = commandPassedFromRepairEvidence(selectionRepairValue?.benchmark);
	const repairReportBenchmark = commandPassedFromRepairReport(repairText, "benchmark");
	if (repairText.trim() && (repairBenchmark === true || repairReportBenchmark === true)) {
		return {
			file: "workflow-output/performance-selection-repair.md",
			text: repairText,
		};
	}
	return {
		file:
			typeof benchmarkValue.outputPath === "string" && benchmarkValue.outputPath.trim()
				? benchmarkValue.outputPath.trim()
				: "workflow-output/performance-benchmark.md",
		text: await readOptionalText("workflow-output/performance-benchmark.md"),
	};
}

function allowsNoWinArchive(taskValue) {
	const taskText = typeof taskValue.text === "string" ? taskValue.text : "";
	return (
		/\bNo-Win Result\s*:\s*allowed\b/iu.test(taskText) ||
		/\bNo-Code\/No-Change Allowed\s*:\s*(?:yes|true|allowed)\b/iu.test(taskText) ||
		/\bNo-Code Allowed\s*:\s*(?:yes|true|allowed)\b/iu.test(taskText) ||
		/\bnegative\s+branch\s+findings\s+are\s+acceptable\b/iu.test(taskText) ||
		/\barchive\s+a\s+no-win\s+result\b/iu.test(taskText) ||
		/\bno-win\s+is\s+acceptable\s+only\s+with\b/iu.test(taskText) ||
		/\btask\s+(?:permits|allows|accepts)\s+a\s+no-win\s+result\b/iu.test(taskText)
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

function isolationViolationResolvedBySelectionRepair(selectionRepairValue, repairText) {
	const repairStatus = typeof selectionRepairValue.status === "string" ? selectionRepairValue.status.toLowerCase() : "";
	const repairBody = `${repairText}\n${JSON.stringify(selectionRepairValue)}`;
	const hasMaterializedRepair =
		["materialized", "pass", "passed"].includes(repairStatus) ||
		/\bperformance selection repair\b/iu.test(repairBody);
	const hasRollbackBeforeSelection =
		typeof selectionRepairValue.rollbackBeforeSelection === "string" && selectionRepairValue.rollbackBeforeSelection.trim() !== "" ||
		/\b(?:rollback before (?:selection|judging winners)|restored polluted shared|git restore)\b/iu.test(repairBody);
	const hasCandidateApplyCheck =
		commandPassedFromRepairEvidence(selectionRepairValue.applyCheck) === true ||
		/\bapply[- ]?check\b.{0,160}\b(?:pass|passed|success|ok|exited?\s*:?\s*(?:code\s*)?0)\b/iu.test(repairBody) ||
		/\bgit apply --check\b.{0,160}\b(?:exit(?:ed)?\s*:?\s*(?:code\s*)?0)\b/iu.test(repairBody);
	return hasMaterializedRepair && hasRollbackBeforeSelection && hasCandidateApplyCheck;
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
	const commandPattern = commandName === "benchmark" ? /\bbenchmark(?: command)?\b/iu : /\bvalidation(?: command)?\b/iu;
	let latestStatus;
	for (const line of text.split(/\r?\n/u).filter((line) => commandPattern.test(line))) {
		const lineStatus = commandStatusFromRepairReportLine(line, commandName);
		if (lineStatus !== undefined) latestStatus = lineStatus;
	}
	return latestStatus;
}

function commandStatusFromRepairReportLine(line, commandName) {
	const commandNamePattern = commandName === "benchmark" ? "benchmark" : "validation";
	const match = new RegExp(
		String.raw`\b${commandNamePattern}(?: command)?\b.{0,160}\b(?:exited|exit code)\s*(?:code\s*)?(\d+)\b`,
		"iu",
	).exec(line);
	if (match) return Number(match[1]) === 0;
	if (/\b(?:status|result)\s*:\s*(?:pass|passed|success|ok)\b/iu.test(line)) return true;
	if (/\b(?:status|result)\s*:\s*(?:fail|failed|failure|blocked|error)\b/iu.test(line)) return false;
	if (commandName === "validation" && /\b\d+\s+passed\b/iu.test(line) && !/\bfailed\b/iu.test(line)) return true;
	return undefined;
}

function isNoWinTerminalState(terminalState) {
	return terminalState === "no-win" || terminalState === "no-win-validation-blocked";
}

function isNoWinOutcome(terminalState) {
	return isNoWinTerminalState(terminalState) || terminalState === "rejected-no-win-not-authorized";
}

function reviewFinishGate(review) {
	if (review === undefined || review === null) return { passed: true, reason: "no reviewer output recorded yet" };
	const text = reviewText(review);
	const normalized = text.toLowerCase();
	const correctness = reviewCorrectness(review, normalized);
	if (correctness && !positiveCorrectness(correctness)) {
		return { passed: false, reason: `review correctness is ${correctness}` };
	}
	if (/\b(verdict|decision|gate)\s*:\s*continue\b/iu.test(text)) {
		return { passed: false, reason: "review verdict is continue" };
	}
	if (/\bshould\s+continue\s+rather\s+than\s+finish\b/iu.test(text)) {
		return { passed: false, reason: "review requested continue rather than finish" };
	}
	return { passed: true, reason: "review allows archive" };
}

function reviewText(review) {
	return typeof review === "string" ? review : JSON.stringify(review, null, 2);
}

function reviewCorrectness(review, normalized) {
	if (review && typeof review === "object" && typeof review.overall_correctness === "string") {
		return review.overall_correctness.toLowerCase().trim();
	}
	const match = /["']?overall_correctness["']?\s*[:=]\s*["']?([a-z_-]+)/iu.exec(normalized);
	return match?.[1]?.toLowerCase().trim();
}

function positiveCorrectness(value) {
	return ["correct", "complete", "pass", "passed", "finish", "finished"].includes(value);
}

function semanticProbeEvidencePresent(branchText, repairText) {
	const combined = `${branchText}\n${repairText}`;
	return (
		/\bsemantic-probe\s*:\s*(?:yes|true|pass|passed)\b/iu.test(combined) ||
		/\bsemantic probe evidence\s*:/iu.test(combined) ||
		/\bbehavior probe(?:s)?\b/iu.test(combined)
	);
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
