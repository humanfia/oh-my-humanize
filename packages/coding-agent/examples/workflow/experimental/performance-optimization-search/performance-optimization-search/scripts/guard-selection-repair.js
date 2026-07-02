const state = workflowContext.state && typeof workflowContext.state === "object" ? workflowContext.state : {};
const task = state.task && typeof state.task === "object" ? state.task : {};
const benchmark = state.benchmark && typeof state.benchmark === "object" ? state.benchmark : {};
const selectionRepair = state.selectionRepair && typeof state.selectionRepair === "object" ? state.selectionRepair : {};
const selectionRepairText = await readOptionalText("workflow-output/performance-selection-repair.md");
const reviewResolutionRequired = previousReviewRequiresResolution(state.review);

const terminalArtifacts = await findPrematureTerminalArtifacts();
const changedFiles = await gitStatusHeadChangedFiles();
const projectChangedFiles = changedFiles.filter((file) => !file.startsWith("workflow-output/") && file !== "task.md");
const branchReports = await readBranchReports();
const joinedText = branchReports.map((report) => report.text).join("\n");
const selectedBranches = branchReports.filter((report) => /\bfinal-selection\s*:\s*yes\b/iu.test(report.text));
const selectedBranchNames = new Set(selectedBranches.map((report) => report.name));
const noWinBranches = branchReports.filter((report) => /\bno-win-result\s*:\s*yes\b/iu.test(report.text));
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
const benchmarkRelevanceBlockers = [
	...selectedBranches
		.filter((report) => !benchmarkRelevantBranches.some((matched) => matched.name === report.name))
		.map((report) => `${report.name} selected without benchmark relevance evidence`),
	...positiveUnselectedBranches
		.filter(
			(report) =>
				!offBenchmarkRejectedBranches.some((matched) => matched.name === report.name) &&
				!benchmarkCoveredRejectedBranches.some((matched) => matched.name === report.name),
		)
		.map(
			(report) =>
				`${report.name} reported positive benchmark evidence without off-benchmark rejection or comparative rejection evidence`,
		),
];
const reviewFeedbackBlockers =
	reviewResolutionRequired && selectedBranches.length > 0
		? selectedBranches
				.filter((report) => !reviewFeedbackAddressed(`${reportEvidenceText(report, selectionRepairText)}\n${selectionRepairText}`))
				.map(
					(report) =>
						`${report.name} selected candidate does not record resolution for previous continue review feedback`,
				)
		: [];
const validationPassed = validationCommandPassed(benchmark, selectionRepair, selectionRepairText);
const benchmarkPassed = benchmarkCommandPassed(benchmark, selectionRepair, selectionRepairText);
const outputPath = "workflow-output/performance-selection-guard.md";

await Bun.write(
	outputPath,
	[
		"# Performance Selection Repair Guard",
		"",
		`benchmarkPassed: ${benchmarkPassed ? "yes" : "no"}`,
		`validationPassed: ${validationPassed ? "yes" : "no"}`,
		`projectChangedFiles: ${projectChangedFiles.length}`,
		`selectedBranches: ${selectedBranches.map((report) => report.name).join(", ") || "none"}`,
		`noWinBranches: ${noWinBranches.map((report) => report.name).join(", ") || "none"}`,
		`benchmarkRelevantBranches: ${benchmarkRelevantBranches.map((report) => report.name).join(", ") || "none"}`,
		`positiveUnselectedBranches: ${positiveUnselectedBranches.map((report) => report.name).join(", ") || "none"}`,
		`offBenchmarkRejectedBranches: ${offBenchmarkRejectedBranches.map((report) => report.name).join(", ") || "none"}`,
		`benchmarkCoveredRejectedBranches: ${benchmarkCoveredRejectedBranches.map((report) => report.name).join(", ") || "none"}`,
		`benchmarkRelevanceBlockers: ${benchmarkRelevanceBlockers.join("; ") || "none"}`,
		`reviewResolutionRequired: ${reviewResolutionRequired ? "yes" : "no"}`,
		`reviewFeedbackBlockers: ${reviewFeedbackBlockers.join("; ") || "none"}`,
		`terminalArtifacts: ${terminalArtifacts.join(", ") || "none"}`,
		`selectionRepairStatus: ${String(selectionRepair.status ?? "unknown")}`,
		"",
		"## Project Changed Files",
		"",
		projectChangedFiles.length > 0 ? projectChangedFiles.map((file) => `- ${file}`).join("\n") : "No project changes.",
		"",
	].join("\n"),
);

if (terminalArtifacts.length > 0) {
	throw new Error(
		`selection repair nodes must not write terminal performance artifacts before finalize/archive nodes: ${terminalArtifacts.join(", ")}`,
	);
}

if (benchmarkRelevanceBlockers.length > 0) {
	throw new Error(`performance selection benchmark relevance contract failed: ${benchmarkRelevanceBlockers.join("; ")}`);
}

if (reviewFeedbackBlockers.length > 0) {
	throw new Error(`performance selection review feedback contract failed: ${reviewFeedbackBlockers.join("; ")}`);
}

if (benchmarkPassed && !validationPassed && projectChangedFiles.length > 0) {
	throw new Error(
		"validation-blocked performance repair cannot retain project changes; fix validation first, or revert changes and record explicit no-win validation-blocked evidence",
	);
}

if (!validationPassed && projectChangedFiles.length === 0 && selectedBranches.length > 0) {
	throw new Error("validation-blocked no-change performance repair cannot contain `final-selection: yes`");
}

return {
	summary: "performance selection repair guard passed",
	statePatch: [
		{
			op: "set",
			path: "/selectionGuard",
			value: {
				status: "pass",
				file: outputPath,
				benchmarkPassed,
				validationPassed,
				projectChangedFiles,
				selectedBranches: selectedBranches.map((report) => report.name),
				noWinBranches: noWinBranches.map((report) => report.name),
				benchmarkRelevantBranches: benchmarkRelevantBranches.map((report) => report.name),
				positiveUnselectedBranches: positiveUnselectedBranches.map((report) => report.name),
				offBenchmarkRejectedBranches: offBenchmarkRejectedBranches.map((report) => report.name),
				benchmarkCoveredRejectedBranches: benchmarkCoveredRejectedBranches.map((report) => report.name),
				benchmarkRelevanceBlockers,
				reviewResolutionRequired,
				reviewFeedbackBlockers,
				hasRollbackEvidence: /\brollback\b/iu.test(joinedText),
			},
		},
	],
};

async function findPrematureTerminalArtifacts() {
	const files = await workflowOutputFiles();
	return files
		.map((file) => `workflow-output/${file}`)
		.filter((file) =>
			/^workflow-output\/performance-(?:selection|archive|final-archive)\.md$/iu.test(file) ||
			/^workflow-output\/final[-_a-z0-9.]*$/iu.test(file),
		);
}

async function workflowOutputFiles() {
	const proc = Bun.spawn(["sh", "-c", "test -d workflow-output && find workflow-output -maxdepth 1 -type f -printf '%P\\n' || true"], {
		cwd: process.cwd(),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (exitCode !== 0) throw new Error(`workflow-output scan failed: ${stderr.trim() || stdout.trim()}`);
	return stdout
		.split(/\r?\n/u)
		.map((line) => line.trim())
		.filter(Boolean);
}

async function gitStatusHeadChangedFiles() {
	const proc = Bun.spawn(["git", "status", "--porcelain", "--untracked-files=all"], {
		cwd: process.cwd(),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (exitCode !== 0) throw new Error(`git status failed: ${stderr.trim() || stdout.trim()}`);
	return stdout
		.split(/\r?\n/u)
		.flatMap(statusLineFiles)
		.filter(Boolean);
}

function statusLineFiles(line) {
	if (line.trim() === "") return [];
	const status = line.slice(0, 2);
	const body = line.slice(3).trim();
	if (body === "") return [];
	if (status[0] === "R" || status[0] === "C") {
		const paths = body.split(/\s+->\s+/u).map((file) => file.trim()).filter(Boolean);
		return paths.length > 0 ? [paths[paths.length - 1]] : [];
	}
	return [body];
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
		/\b(?:selected|winner|winning|chosen|retained)\b.{0,100}\b(?:candidate|branch)\b.{0,180}\b(?:larger|greater|higher|stronger|better|faster|more\s+stable|lower)\b.{0,120}\b(?:benchmark|improvement|speedup|win|movement)\b/ius.test(
			text,
		)
	);
}

function hasPositiveBenchmarkEvidence(text) {
	const evidenceText = text
		.split(/\r?\n/u)
		.filter((line) => !dismissesPositiveBenchmarkEvidence(line))
		.join("\n");
	return (
		/\bbenchmark[- ]covered\s+rejection\s*:\s*(?:yes|true)\b/iu.test(evidenceText) ||
		/\bpositive\s+result\s+was\s+covered\s+by\s+(?:the\s+)?(?:task[- ]declared\s+)?benchmark\b/iu.test(
			evidenceText,
		) ||
		/\bpositive[^\S\r\n]+benchmark\b/iu.test(evidenceText) ||
		/\bbenchmark[^\S\r\n]+(?:improvement|speedup|win)\b/iu.test(evidenceText) ||
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

function previousReviewRequiresResolution(review) {
	if (review === undefined || review === null) return false;
	const text = reviewText(review);
	const normalized = text.toLowerCase();
	const correctness =
		review && typeof review === "object" && typeof review.overall_correctness === "string"
			? review.overall_correctness.toLowerCase().trim()
			: "";
	return (
		correctness === "incorrect" ||
		/\b(verdict|decision|gate)\s*:\s*continue\b/iu.test(text) ||
		/^\s*continue\b/imu.test(text) ||
		/\bshould\s+continue\s+rather\s+than\s+finish\b/iu.test(normalized)
	);
}

function reviewText(review) {
	return typeof review === "string" ? review : JSON.stringify(review, null, 2);
}

function reviewFeedbackAddressed(text) {
	return (
		/\breview-feedback-addressed\s*:\s*(?:yes|true|pass|passed)\b/iu.test(text) &&
		/\breview feedback evidence\s*:/iu.test(text)
	);
}

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
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

async function readOptionalText(filePath) {
	try {
		return await Bun.file(filePath).text();
	} catch {
		return "";
	}
}
