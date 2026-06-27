const state = workflowContext.state && typeof workflowContext.state === "object" ? workflowContext.state : {};
const task = state.task && typeof state.task === "object" ? state.task : {};
const benchmark = state.benchmark && typeof state.benchmark === "object" ? state.benchmark : {};
const selectionRepair = state.selectionRepair && typeof state.selectionRepair === "object" ? state.selectionRepair : {};
const selectionRepairText = await readOptionalText("workflow-output/performance-selection-repair.md");

const terminalArtifacts = await findPrematureTerminalArtifacts();
const changedFiles = await gitDiffHeadChangedFiles();
const projectChangedFiles = changedFiles.filter((file) => !file.startsWith("workflow-output/") && file !== "task.md");
const branchReports = await readBranchReports();
const joinedText = branchReports.map((report) => report.text).join("\n");
const selectedBranches = branchReports.filter((report) => /\bfinal-selection\s*:\s*yes\b/iu.test(report.text));
const noWinBranches = branchReports.filter((report) => /\bno-win-result\s*:\s*yes\b/iu.test(report.text));
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
		reports.push({ name, file, text: await readOptionalText(file) });
	}
	return reports;
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
	const lines = text
		.split(/\r?\n/u)
		.filter((line) => commandPattern.test(line))
		.filter((line) => /\b(?:exited|exit code)\s*(?:code\s*)?\d+\b/iu.test(line));
	const latest = lines.at(-1);
	if (!latest) return undefined;
	const commandNamePattern = commandName === "benchmark" ? "benchmark" : "validation";
	const match = new RegExp(
		String.raw`\b${commandNamePattern}(?: command)?\b.{0,160}\b(?:exited|exit code)\s*(?:code\s*)?(\d+)\b`,
		"iu",
	).exec(latest);
	if (!match) return undefined;
	return Number(match[1]) === 0;
}

async function readOptionalText(filePath) {
	try {
		return await Bun.file(filePath).text();
	} catch {
		return "";
	}
}
