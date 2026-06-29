const state = workflowContext.state && typeof workflowContext.state === "object" ? workflowContext.state : {};
const suite = state.suite && typeof state.suite === "object" ? state.suite : {};

if (suite.status !== "pass") {
	throw new Error("cannot archive test hardening flow before task-declared validation passes");
}

const archivePath = "workflow-output/test-hardening-archive.md";
const taskText = await readOptionalText("task.md");
const suiteText = await readOptionalText("workflow-output/test-suite.md");
const repairEvidenceText = await readOptionalText("workflow-output/test-hardening-repair-evidence.md");
const rollbackText = await readOptionalText("workflow-output/test-hardening-rollback.md");
const sourceEditGuard = await testOnlyChangeGuard(taskText);

if (sourceEditGuard.status !== "pass") {
	throw new Error(`cannot archive test hardening with unauthorized source edits: ${sourceEditGuard.blockers.join(", ")}`);
}
assertSchedulerLineage(
	["inspectCoverage", "materializeGapReport", "generateTests", "runTestSuite", "testReview"],
	"test-generation-hardening archive",
);

await Bun.write(
	archivePath,
	[
		"# Test Generation Hardening Archive",
		"",
		"## Task",
		"",
		boundedLines(taskText, 120),
		"",
		"## Suite Evidence",
		"",
		boundedLines(suiteText, 160),
		"",
		"## Repair Evidence",
		"",
		repairEvidenceText.trim() ? boundedLines(repairEvidenceText, 160) : "No repair evidence was present.",
		"",
		"## Rollback",
		"",
		rollbackText.trim() ? boundedLines(rollbackText, 120) : "No rollback notes were present.",
		"",
		"## Test-Only Change Guard",
		"",
		testOnlyChangeGuardMarkdown(sourceEditGuard),
		"",
	].join("\n"),
);

return {
	summary: "archived test hardening evidence",
	statePatch: [
		{
			op: "set",
			path: "/archive",
			value: {
				file: archivePath,
				validation: "pass",
				sourceEditGuard,
			},
		},
	],
};

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

function assertSchedulerLineage(requiredNodeIds, label) {
	const completedNodeIds = new Set(
		(Array.isArray(workflowContext.completedActivations) ? workflowContext.completedActivations : [])
			.filter(activation => activation?.status === "completed")
			.map(activation => activation.nodeId)
			.filter(Boolean),
	);
	const missing = requiredNodeIds.filter(nodeId => !completedNodeIds.has(nodeId));
	if (missing.length > 0) {
		throw new Error(`${label} missing scheduler lineage: ${missing.join(", ")}`);
	}
}

async function testOnlyChangeGuard(taskText) {
	const changedFiles = await changedProjectFiles();
	const sourceEditAllowed = explicitlyAllowsSourceEdits(taskText);
	const unauthorizedSourceEdits = sourceEditAllowed ? [] : changedFiles.filter(filePath => !isTestOrDocsPath(filePath));
	return {
		status: unauthorizedSourceEdits.length === 0 ? "pass" : "blocked",
		sourceEditAllowed,
		changedFiles,
		blockers: unauthorizedSourceEdits.map(filePath => `${filePath} is a production/source edit`),
	};
}

async function changedProjectFiles() {
	const proc = Bun.spawn(["git", "status", "--short", "--untracked-files=all"], {
		cwd: process.cwd(),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (exitCode !== 0) {
		throw new Error(`git status failed before test hardening archive: ${stderr.trim() || stdout.trim()}`);
	}
	return stdout
		.split(/\r?\n/u)
		.map(statusLineToPath)
		.filter(filePath => filePath !== undefined)
		.filter(filePath => !ignoredStatusPath(filePath));
}

function statusLineToPath(line) {
	if (!line.trim()) return undefined;
	const rawPath = line.slice(3).trim();
	const renamed = rawPath.includes(" -> ") ? rawPath.split(" -> ").at(-1) ?? rawPath : rawPath;
	const filePath = renamed.replace(/^"|"$/gu, "");
	return filePath || undefined;
}

function ignoredStatusPath(filePath) {
	return (
		filePath === "task.md" ||
		filePath === "progress.md" ||
		filePath === "manifest-entry.json" ||
		filePath === "monitor-assignment.json" ||
		filePath.startsWith("workflow-output/") ||
		filePath.startsWith("transcripts/")
	);
}

function isTestOrDocsPath(filePath) {
	const basename = filePath.split("/").at(-1) ?? filePath;
	return (
		filePath.startsWith("test/") ||
		filePath.startsWith("tests/") ||
		filePath.startsWith("__tests__/") ||
		filePath.includes("/test/") ||
		filePath.includes("/tests/") ||
		filePath.includes("/__tests__/") ||
		/^test[_-]/u.test(basename) ||
		/[_-]test\./u.test(basename) ||
		basename.endsWith(".test.ts") ||
		basename.endsWith(".test.tsx") ||
		basename.endsWith(".spec.ts") ||
		basename.endsWith(".spec.tsx") ||
		filePath.startsWith("docs/") ||
		filePath.startsWith("doc/") ||
		filePath.endsWith(".md") ||
		filePath.endsWith(".mdx") ||
		filePath.endsWith(".rst")
	);
}

function explicitlyAllowsSourceEdits(taskText) {
	return /(?:production|source|implementation)\s+(?:fix|edits?|changes?)\s+allowed\s*:\s*(?:yes|true)\b/iu.test(taskText);
}

function testOnlyChangeGuardMarkdown(sourceEditGuard) {
	return [
		`Status: ${sourceEditGuard.status}`,
		`Source edits explicitly allowed: ${sourceEditGuard.sourceEditAllowed ? "yes" : "no"}`,
		"",
		"### Changed Files",
		"",
		sourceEditGuard.changedFiles.length > 0
			? sourceEditGuard.changedFiles.map(filePath => `- ${filePath}`).join("\n")
			: "- No changed project files outside workflow artifacts.",
		"",
		"### Blockers",
		"",
		sourceEditGuard.blockers.length > 0
			? sourceEditGuard.blockers.map(blocker => `- ${blocker}`).join("\n")
			: "- No unauthorized source edits.",
	].join("\n");
}
