const state = workflowContext.state && typeof workflowContext.state === "object" ? workflowContext.state : {};
const task = state.task && typeof state.task === "object" ? state.task : {};
const benchmark = state.benchmark && typeof state.benchmark === "object" ? state.benchmark : {};
const selectionRepair = state.selectionRepair && typeof state.selectionRepair === "object" ? state.selectionRepair : {};
const selectionRepairText = await readOptionalText("workflow-output/performance-selection-repair.md");
const reviewGate = reviewFinishGate(state.review);

if (benchmark.isolationViolation === true && !isolationViolationResolvedBySelectionRepair(selectionRepair, selectionRepairText)) {
	throw new Error("cannot finalize performance selection after a parallel lane isolation violation");
}

if (!reviewGate.passed) {
	throw new Error(`cannot finalize performance selection before reviewer finish: ${reviewGate.reason}`);
}

if (!benchmarkCommandPassed(benchmark, selectionRepair, selectionRepairText)) {
	throw new Error("cannot finalize performance selection before the benchmark command passes");
}

const changedFiles = await gitDiffHeadChangedFiles();
const projectChangedFiles = changedFiles.filter((file) => !file.startsWith("workflow-output/") && file !== "task.md");
const branchReports = await readBranchReports();
const joinedText = branchReports.map((report) => report.text).join("\n");
const selectedBranches = branchReports.filter((report) => /\bfinal-selection\s*:\s*yes\b/iu.test(report.text));
const selectedBranchNames = new Set(selectedBranches.map((report) => report.name));
const noWinBranches = branchReports.filter((report) => /\bno-win-result\s*:\s*yes\b/iu.test(report.text));
const selectedNoWinBranches = selectedBranches.filter((report) => /\bno-win-result\s*:\s*yes\b/iu.test(report.text));
const benchmarkRelevantBranches = selectedBranches.filter((report) =>
	benchmarkRelevanceConfirmed(reportEvidenceText(report, selectionRepairText)),
);
const positiveUnselectedBranches = branchReports.filter((report) => {
	if (selectedBranchNames.has(report.name)) return false;
	if (isNoWinWithoutRetainedPositiveEvidence(report.text, selectionRepairText)) return false;
	const evidenceText = reportEvidenceText(report, selectionRepairText);
	return hasPositiveBenchmarkEvidence(evidenceText);
});
const offBenchmarkRejectedBranches = positiveUnselectedBranches.filter((report) =>
	benchmarkRelevanceRejected(reportEvidenceText(report, selectionRepairText)),
);
const benchmarkCoveredRejectedBranches = positiveUnselectedBranches.filter((report) =>
	benchmarkCoveredLosingRejected(reportEvidenceText(report, selectionRepairText)),
);
const hasRollbackEvidence = /\brollback\b/iu.test(joinedText);
const hasSemanticProbeEvidence = semanticProbeEvidencePresent(joinedText, selectionRepairText);
const noWinAllowed = allowsNoWinArchive(task);
const validationPassed = validationCommandPassed(benchmark, selectionRepair, selectionRepairText);

let terminalState;
let selectionStatus = "pass";
if (selectedBranches.length > 0) {
	if (selectedNoWinBranches.length > 0) {
		throw new Error("positive performance selection cannot also contain `no-win-result: yes`");
	}
	if (!validationPassed) {
		throw new Error("positive performance selection requires the task-declared validation command to pass");
	}
	if (selectedBranches.length !== 1) {
		throw new Error(
			"positive performance selection requires exactly one retained branch with `final-selection: yes`",
		);
	}
	if (!hasSemanticProbeEvidence) {
		throw new Error(
			"positive performance selection requires semantic probe evidence for the retained candidate",
		);
	}
	if (benchmarkRelevantBranches.length !== selectedBranches.length) {
		throw new Error("positive performance selection requires benchmark relevance evidence for the retained candidate");
	}
	const rejectedPositiveUnselectedBranches = uniqueReports([
		...offBenchmarkRejectedBranches,
		...benchmarkCoveredRejectedBranches,
	]);
	if (positiveUnselectedBranches.length !== rejectedPositiveUnselectedBranches.length) {
		throw new Error(
			"positive performance selection requires off-benchmark rejection or comparative rejection evidence for unselected positive benchmark candidates",
		);
	}
	if (!hasRollbackEvidence) {
		throw new Error("positive performance selection requires rollback evidence for the retained/rejected branches");
	}
	terminalState = "positive";
} else {
	if (noWinBranches.length === 0) {
		throw new Error("no-win performance selection requires at least one branch with `no-win-result: yes`");
	}
	if (projectChangedFiles.length !== 0) {
		throw new Error("no-win performance selection requires an empty project diff");
	}
	if (!hasRollbackEvidence) {
		throw new Error("no-win performance selection requires rollback or no-change evidence");
	}
	if (!noWinAllowed) {
		terminalState = "rejected-no-win-not-authorized";
		selectionStatus = "rejected";
	} else {
		terminalState = validationPassed ? "no-win" : "no-win-validation-blocked";
		selectionStatus = validationPassed ? "pass" : "blocked";
	}
}

const outputPath = "workflow-output/performance-selection.md";
await Bun.write(
	outputPath,
	[
		"# Performance Selection",
		"",
		`terminalState: ${terminalState}`,
		`projectChangedFiles: ${projectChangedFiles.length}`,
		`selectedBranches: ${selectedBranches.map((report) => report.name).join(", ") || "none"}`,
		`noWinBranches: ${noWinBranches.map((report) => report.name).join(", ") || "none"}`,
		`benchmarkRelevantBranches: ${benchmarkRelevantBranches.map((report) => report.name).join(", ") || "none"}`,
		`positiveUnselectedBranches: ${positiveUnselectedBranches.map((report) => report.name).join(", ") || "none"}`,
		`offBenchmarkRejectedBranches: ${offBenchmarkRejectedBranches.map((report) => report.name).join(", ") || "none"}`,
		`benchmarkCoveredRejectedBranches: ${benchmarkCoveredRejectedBranches.map((report) => report.name).join(", ") || "none"}`,
		`validationPassed: ${validationPassed ? "yes" : "no"}`,
		`rollbackEvidence: ${hasRollbackEvidence ? "yes" : "no"}`,
		"",
		"## Project Changed Files",
		"",
		projectChangedFiles.length > 0 ? projectChangedFiles.map((file) => `- ${file}`).join("\n") : "No project changes.",
		"",
	].join("\n"),
);

return {
	summary: `finalized performance selection: ${terminalState}`,
	statePatch: [
		{
			op: "set",
			path: "/selection",
			value: {
				status: selectionStatus,
				terminalState,
				file: outputPath,
				projectChangedFiles,
				selectedBranches: selectedBranches.map((report) => report.name),
				noWinBranches: noWinBranches.map((report) => report.name),
				benchmarkRelevantBranches: benchmarkRelevantBranches.map((report) => report.name),
				positiveUnselectedBranches: positiveUnselectedBranches.map((report) => report.name),
				offBenchmarkRejectedBranches: offBenchmarkRejectedBranches.map((report) => report.name),
				benchmarkCoveredRejectedBranches: benchmarkCoveredRejectedBranches.map((report) => report.name),
				validationPassed,
				rollbackEvidence: hasRollbackEvidence,
				semanticProbeEvidence: hasSemanticProbeEvidence,
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

async function readBranchReports() {
	const reports = [];
	for (const name of ["algorithmic", "caching", "io", "no-win"]) {
		const file = `workflow-output/perf-${name}.md`;
		const text = await readOptionalText(file);
		if (text.trim() !== "") reports.push({ name, file, text });
	}
	return reports;
}

function reportEvidenceText(report, repairText) {
	if (typeof repairText !== "string" || repairText.trim() === "") return report.text;
	const namePattern = new RegExp(String.raw`\b${escapeRegExp(report.name)}\b`, "iu");
	const repairLines = repairText
		.split(/\r?\n/u)
		.filter((line) => namePattern.test(line) || line.includes(report.file))
		.join("\n");
	const repairSection = branchRepairSection(repairText, report.name);
	return `${report.text}\n${repairLines}\n${repairSection}`;
}

function branchRepairSection(text, branchName) {
	const lines = text.split(/\r?\n/u);
	const branchHeaderPattern = new RegExp(String.raw`^-\s+.*\b${escapeRegExp(branchName)}\b`, "iu");
	const otherBranchHeaderPattern = new RegExp(
		String.raw`^-\s+.*\b(?:${["algorithmic", "caching", "io", "no-win"].filter((name) => name !== branchName).map(escapeRegExp).join("|")})\b`,
		"iu",
	);
	const section = [];
	let collecting = false;
	for (const line of lines) {
		if (branchHeaderPattern.test(line)) {
			collecting = true;
			section.push(line);
			continue;
		}
		if (!collecting) continue;
		if (/^##\s+/u.test(line) || otherBranchHeaderPattern.test(line)) break;
		if (line.trim() === "" || /^\s{2,}-\s+/u.test(line) || !/^\s*-\s+\S/u.test(line)) {
			section.push(line);
			continue;
		}
		break;
	}
	return section.join("\n");
}

function benchmarkRelevanceConfirmed(text) {
	return (
		/\bbenchmark[- ]relevance\s*:\s*(?:yes|true|covered)\b/iu.test(text) ||
		/\bcovered\s+by\s+(?:the\s+)?(?:task[- ]declared\s+)?benchmark\b/iu.test(text) ||
		/\b(?:task[- ]declared\s+)?benchmark(?: command)?\s+covers\b/iu.test(text)
	);
}

function benchmarkRelevanceRejected(text) {
	return (
		/\bbenchmark[- ]relevance\s*:\s*(?:no|false|off[- ]benchmark|not[- ]covered|not\s+covered)\b/iu.test(text) ||
		/\boff[- ]benchmark\s*:\s*(?:yes|true)\b/iu.test(text) ||
		/\bnot\s+covered\s+by\s+(?:the\s+)?(?:task[- ]declared\s+)?benchmark\b/iu.test(text) ||
		/\b(?:task[- ]declared\s+)?benchmark(?: command)?\s+does\s+not\s+cover\b/iu.test(text) ||
		/\boutside\s+(?:the\s+)?(?:task[- ]declared\s+)?benchmark\b/iu.test(text)
	);
}

function benchmarkCoveredLosingRejected(text) {
	if (!benchmarkRelevanceConfirmed(text)) return false;
	return (
		/\bbenchmark[- ]covered\s+rejection\s*:\s*(?:yes|true)\b/iu.test(text) ||
		/\bcovered\s+by\s+(?:the\s+)?(?:task[- ]declared\s+)?benchmark\b.{0,240}\b(?:weaker|noisier|regress(?:ed|ion)|slower|less\s+stable)\b/ius.test(
			text,
		) ||
		/\b(?:positive\s+benchmark|benchmark[- ]covered|covered\s+the\s+task\s+benchmark)\b.{0,240}\b(?:weaker|noisier|regress(?:ed|ion)|slower|less\s+stable)\b/ius.test(
			text,
		) ||
		/\b(?:weaker|noisier|regress(?:ed|ion)|slower|less\s+stable)\b.{0,240}\b(?:selected|winner|winning|chosen|retained)\b/ius.test(
			text,
		) ||
		/\b(?:selected|retained)\s+candidate\b.{0,160}\b(?:better|faster|more\s+stable|lower|wins?)\b/iu.test(
			text,
		) ||
		/\b(?:selected|winner|winning|chosen|retained)\b.{0,100}\b(?:candidate|branch)\b.{0,180}\b(?:larger|greater|higher|stronger|better|faster|more\s+stable|lower)\b.{0,120}\b(?:benchmark|improvement|speedup|win|movement)\b/ius.test(
			text,
		)
	);
}

function uniqueReports(reports) {
	const seen = new Set();
	const unique = [];
	for (const report of reports) {
		if (seen.has(report.name)) continue;
		seen.add(report.name);
		unique.push(report);
	}
	return unique;
}

function hasPositiveBenchmarkEvidence(text) {
	const evidenceText = text
		.split(/\r?\n/u)
		.filter((line) => !dismissesPositiveBenchmarkEvidence(line))
		.join("\n");
	if (
		/\bno\s+(?:measured\s+)?positive\s+(?:movement|result|candidate|optimization)\b/iu.test(evidenceText) ||
		/\bno\s+stable\s+positive\s+result\b/iu.test(evidenceText) ||
		/\bwithout\s+(?:a\s+)?positive\s+(?:movement|result|candidate|optimization)\b/iu.test(evidenceText)
	) {
		return false;
	}
	return (
		/\bbenchmark[- ]covered\s+rejection\s*:\s*(?:yes|true)\b/iu.test(evidenceText) ||
		/\bpositive\s+result\s+was\s+covered\s+by\s+(?:the\s+)?(?:task[- ]declared\s+)?benchmark\b/iu.test(
			evidenceText,
		) ||
		/\bpositive\s+benchmark\b/iu.test(evidenceText) ||
		/\bbenchmark\s+(?:improvement|speedup|win)\b/iu.test(evidenceText) ||
		/\b(?:improved|faster|speedup|reduced|lower)\b.{0,100}\bbenchmark\b/iu.test(evidenceText) ||
		/\bbenchmark\b.{0,100}\b(?:improved|faster|speedup|reduced|lower|win)\b/iu.test(evidenceText)
	);
}

function isNoWinWithoutRetainedPositiveEvidence(reportText, repairText) {
	const structuredState = branchStructuredState(reportText);
	if (structuredState && structuredNoWinWithoutRetainedPositiveEvidence(structuredState)) return true;
	if (!/\bno-win-result\s*:\s*yes\b/iu.test(reportText) || !/\bfinal-selection\s*:\s*no\b/iu.test(reportText)) {
		return false;
	}
	const evidenceText = `${reportText}\n${repairText}`;
	return (
		/\b(?:no candidate patch exists|candidatePatchPath["']?\s*:\s*null|no .*project-code changes are retained|no .*code changes|retained no code changes)\b/iu.test(
			evidenceText,
		) &&
		/\b(?:reverted|slower|no improvement|none improved|flat|neutral|negative|equal)\b/iu.test(evidenceText)
	);
}

function branchStructuredState(text) {
	const match = /```json\s*([\s\S]*?)```/iu.exec(text);
	if (!match) return undefined;
	try {
		const value = JSON.parse(match[1]);
		return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

function structuredNoWinWithoutRetainedPositiveEvidence(state) {
	const status = stringValue(state.status);
	const finalSelection = stringValue(state.finalSelection);
	const noWinResult = stringValue(state.noWinResult);
	if (status !== "no-win" && noWinResult !== "yes" && noWinResult !== "true") return false;
	if (finalSelection !== "" && finalSelection !== "no" && finalSelection !== "false") return false;
	if (hasRetainedBranchArtifact(state)) return false;
	const measurements = Array.isArray(state.measurements) ? state.measurements : [];
	return measurements.length === 0 || measurements.every(measurementDismissesPositiveResult);
}

function hasRetainedBranchArtifact(state) {
	if (nonEmptyArray(state.retainedFiles)) return true;
	if (nonEmptyArray(state.retainedProjectFiles)) return true;
	if (nonEmptyArray(state.retainedCodeChanges)) return true;
	if (nonEmptyArray(state.retainedSourceChanges)) return true;
	const candidatePatchRetained = stringValue(state.candidatePatchRetained);
	if (candidatePatchRetained === "yes" || candidatePatchRetained === "true") return true;
	if (candidatePatchRetained === "no" || candidatePatchRetained === "false") return false;
	const candidatePatchPath = state.candidatePatchPath;
	if (typeof candidatePatchPath === "string" && candidatePatchPath.trim() !== "") return true;
	return false;
}

function nonEmptyArray(value) {
	return Array.isArray(value) && value.length > 0;
}

function measurementDismissesPositiveResult(measurement) {
	if (!measurement || typeof measurement !== "object") return false;
	const decision = typeof measurement.decision === "string" ? measurement.decision : "";
	return /\b(?:reverted|slower|no improvement|none improved|flat|neutral|negative|equal|retained no code changes)\b/iu.test(
		decision,
	);
}

function stringValue(value) {
	if (typeof value === "boolean") return value ? "yes" : "no";
	return typeof value === "string" ? value.trim().toLowerCase().replace(/_/gu, "-") : "";
}

function dismissesPositiveBenchmarkEvidence(line) {
	return (
		/\bno[^\S\r\n]+(?:measured[^\S\r\n]+)?positive[^\S\r\n]+(?:movement|result|candidate|optimization)\b/iu.test(
			line,
		) ||
		/\bno[^\S\r\n]+positive[^\S\r\n]+(?:task[^\S\r\n]+)?benchmark(?:[- ]like)?[^\S\r\n]+(?:movement|result|candidate|optimization)\b/iu.test(
			line,
		) ||
		/\bdid[^\S\r\n]+not[^\S\r\n]+report\b.{0,120}\bpositive[^\S\r\n]+(?:task[^\S\r\n]+)?benchmark(?:[- ]like)?[^\S\r\n]+(?:movement|result|candidate|optimization)\b/iu.test(
			line,
		) ||
		/\bnot[^\S\r\n]+(?:a[^\S\r\n]+)?safe[^\S\r\n]+positive[^\S\r\n]+result\b/iu.test(line) ||
		/\bno[^\S\r\n]+stable[^\S\r\n]+positive[^\S\r\n]+result\b/iu.test(line) ||
		/\bwithout[^\S\r\n]+(?:a[^\S\r\n]+)?positive[^\S\r\n]+(?:movement|result|candidate|optimization)\b/iu.test(
			line,
		) ||
		/\bbenchmark[^\S\r\n]+(?:result|measurement)[^\S\r\n]+was[^\S\r\n]+(?:flat|neutral|negative)\b/iu.test(line) ||
		/\bspeedup\s*`?0(?:\.0+)?%`?\b/iu.test(line) ||
		/\b(?:selected|retained|winning|chosen)\b.{0,120}\bpositive[^\S\r\n]+benchmark(?:[- ]covered)?[^\S\r\n]+(?:movement|result|candidate|optimization|win)\b/iu.test(
			line,
		)
	);
}

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
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

function isolationViolationResolvedBySelectionRepair(selectionRepairValue, repairText) {
	const repairStatus = typeof selectionRepairValue.status === "string" ? selectionRepairValue.status.toLowerCase() : "";
	const repairBody = `${repairText}\n${JSON.stringify(selectionRepairValue)}`;
	const hasMaterializedRepair =
		["materialized", "pass", "passed"].includes(repairStatus) ||
		/\bperformance selection repair\b/iu.test(repairBody);
	const hasRollbackBeforeSelection =
		selectionRepairValue.cleanedBeforeSelection === true ||
		nonEmptyArray(selectionRepairValue.revertedProjectFiles) ||
		nonEmptyArray(selectionRepairValue.projectFilesRevertedBeforeSelection) ||
		typeof selectionRepairValue.rollbackBeforeSelection === "string" && selectionRepairValue.rollbackBeforeSelection.trim() !== "" ||
		/\b(?:rollback before (?:selection|judging winners)|restored polluted shared|git restore|revert(?:ed|ing)? leaked shared[- ]workspace|cleanedBeforeSelection\s*:\s*true|revertedProjectFiles\s*:)\b/iu.test(repairBody);
	const hasCandidateApplyCheck =
		commandPassedFromRepairEvidence(selectionRepairValue.applyCheck) === true ||
		/\bapply[- ]?check\b.{0,160}\b(?:pass|passed|success|ok|exited?\s*:?\s*(?:code\s*)?0)\b/iu.test(repairBody) ||
		/\bgit apply --check\b.{0,160}\b(?:exit(?:ed)?\s*:?\s*(?:code\s*)?0)\b/iu.test(repairBody);
	return hasMaterializedRepair && hasRollbackBeforeSelection && hasCandidateApplyCheck;
}

function nonEmptyArray(value) {
	return Array.isArray(value) && value.length > 0;
}

function benchmarkCommandPassed(benchmarkValue, selectionRepairValue, repairText) {
	const repairBenchmark = commandPassedFromRepairEvidence(selectionRepairValue?.benchmark);
	if (repairBenchmark !== undefined) return repairBenchmark;
	const repairReportBenchmark = commandPassedFromRepairReport(repairText, "benchmark");
	if (repairReportBenchmark !== undefined) return repairReportBenchmark;
	if (typeof benchmarkValue.benchmarkExitCode === "number") return benchmarkValue.benchmarkExitCode === 0;
	return benchmarkValue.status === "pass";
}

function validationCommandPassed(benchmarkValue, selectionRepairValue, repairText) {
	const repairValidation = commandPassedFromRepairEvidence(selectionRepairValue?.validation);
	if (repairValidation !== undefined) return repairValidation;
	const repairReportValidation = commandPassedFromRepairReport(repairText, "validation");
	if (repairReportValidation !== undefined) return repairReportValidation;
	if (typeof benchmarkValue.validationExitCode === "number") return benchmarkValue.validationExitCode === 0;
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
	return { passed: true, reason: "review allows finalize" };
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
