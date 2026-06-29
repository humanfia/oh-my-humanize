const task = workflowContext.state?.task;
const benchmarkCommand = task?.benchmarkCommand;
const validationCommand = task?.validationCommand;
if (typeof benchmarkCommand !== "string" || benchmarkCommand.trim() === "") {
	throw new Error("performance-optimization-search requires /task.benchmarkCommand before benchmarkCandidates");
}
if (typeof validationCommand !== "string" || validationCommand.trim() === "") {
	throw new Error("performance-optimization-search requires /task.validationCommand before benchmarkCandidates");
}

await materializeBranchStateReports(workflowContext.state);

const projectChangedFiles = projectFilesChangedAfterBranchStart(await changedProjectFiles(), task);
if (projectChangedFiles.length > 0) {
	const outputPath = "workflow-output/performance-benchmark.md";
	await Bun.write(outputPath, isolationViolationMarkdown(projectChangedFiles));
	return {
		summary: `parallel lane isolation violation: ${projectChangedFiles.length} shared project file(s) changed`,
		data: { isolationViolation: true, projectChangedFiles },
		statePatch: [
			{
				op: "set",
				path: "/benchmark",
				value: {
					status: "fail",
					isolationViolation: true,
					projectChangedFiles,
					benchmarkCommand,
					validationCommand,
					outputPath,
				},
			},
		],
	};
}

const projectLocalScratchPaths = await existingProjectLocalScratchPaths();
if (projectLocalScratchPaths.length > 0) {
	const outputPath = "workflow-output/performance-benchmark.md";
	await Bun.write(outputPath, projectLocalScratchIsolationViolationMarkdown(projectLocalScratchPaths));
	return {
		summary: `parallel lane isolation violation: ${projectLocalScratchPaths.length} project-local scratch path(s) found`,
		data: { isolationViolation: true, projectLocalScratchPaths },
		statePatch: [
			{
				op: "set",
				path: "/benchmark",
				value: {
					status: "fail",
					isolationViolation: true,
					projectLocalScratchPaths,
					benchmarkCommand,
					validationCommand,
					outputPath,
				},
			},
		],
	};
}

const sharedGitWorktreeMetadataPaths = await newSharedGitWorktreeMetadataPaths(task);
if (sharedGitWorktreeMetadataPaths.length > 0) {
	const outputPath = "workflow-output/performance-benchmark.md";
	await Bun.write(outputPath, sharedGitWorktreeMetadataViolationMarkdown(sharedGitWorktreeMetadataPaths));
	return {
		summary: `parallel lane isolation violation: ${sharedGitWorktreeMetadataPaths.length} shared git worktree metadata path(s) found`,
		data: { isolationViolation: true, sharedGitWorktreeMetadataPaths },
		statePatch: [
			{
				op: "set",
				path: "/benchmark",
				value: {
					status: "fail",
					isolationViolation: true,
					sharedGitWorktreeMetadataPaths,
					benchmarkCommand,
					validationCommand,
					outputPath,
				},
			},
		],
	};
}

const sharedScratchReferences = await branchEvidenceWithSharedScratchReferences();
if (sharedScratchReferences.length > 0) {
	const outputPath = "workflow-output/performance-benchmark.md";
	await Bun.write(outputPath, sharedScratchIsolationViolationMarkdown(sharedScratchReferences));
	return {
		summary: `parallel lane isolation violation: ${sharedScratchReferences.length} shared scratch evidence file(s) found`,
		data: { isolationViolation: true, sharedScratchReferences },
		statePatch: [
			{
				op: "set",
				path: "/benchmark",
				value: {
					status: "fail",
					isolationViolation: true,
					sharedScratchReferences,
					benchmarkCommand,
					validationCommand,
					outputPath,
				},
			},
		],
	};
}

const disallowedScratchReferences = await branchEvidenceWithDisallowedScratchRoots(task);
if (disallowedScratchReferences.length > 0) {
	const outputPath = "workflow-output/performance-benchmark.md";
	await Bun.write(outputPath, disallowedScratchRootViolationMarkdown(disallowedScratchReferences, allowedScratchRoots(task)));
	return {
		summary: `parallel lane isolation violation: ${disallowedScratchReferences.length} disallowed scratch root evidence file(s) found`,
		data: { isolationViolation: true, disallowedScratchReferences },
		statePatch: [
			{
				op: "set",
				path: "/benchmark",
				value: {
					status: "fail",
					isolationViolation: true,
					disallowedScratchReferences,
					benchmarkCommand,
					validationCommand,
					outputPath,
				},
			},
		],
	};
}

const bareTmpSandboxReferences = await branchEvidenceWithBareTmpSandboxReferences();
if (bareTmpSandboxReferences.length > 0) {
	const outputPath = "workflow-output/performance-benchmark.md";
	await Bun.write(outputPath, disallowedScratchRootViolationMarkdown(bareTmpSandboxReferences, allowedScratchRoots(task)));
	return {
		summary: `parallel lane isolation violation: ${bareTmpSandboxReferences.length} bare tmp sandbox evidence file(s) found`,
		data: { isolationViolation: true, disallowedScratchReferences: bareTmpSandboxReferences, bareTmpSandboxReferences },
		statePatch: [
			{
				op: "set",
				path: "/benchmark",
				value: {
					status: "fail",
					isolationViolation: true,
					disallowedScratchReferences: bareTmpSandboxReferences,
					bareTmpSandboxReferences,
					benchmarkCommand,
					validationCommand,
					outputPath,
				},
			},
		],
	};
}

const sharedWorkspaceExecutionReferences = await branchEvidenceWithSharedWorkspaceExecutionReferences();
if (sharedWorkspaceExecutionReferences.length > 0) {
	const outputPath = "workflow-output/performance-benchmark.md";
	await Bun.write(outputPath, sharedWorkspaceExecutionViolationMarkdown(sharedWorkspaceExecutionReferences));
	return {
		summary: `parallel lane isolation violation: ${sharedWorkspaceExecutionReferences.length} shared workspace execution evidence file(s) found`,
		data: { isolationViolation: true, sharedWorkspaceExecutionReferences },
		statePatch: [
			{
				op: "set",
				path: "/benchmark",
				value: {
					status: "fail",
					isolationViolation: true,
					sharedWorkspaceExecutionReferences,
					benchmarkCommand,
					validationCommand,
					outputPath,
				},
			},
		],
	};
}

const benchmark = await runShell(benchmarkCommand);
const validation = await runShell(validationCommand);
const outputPath = "workflow-output/performance-benchmark.md";
await Bun.write(outputPath, evidenceMarkdown(benchmarkCommand, benchmark, validationCommand, validation));

return {
	summary: `benchmark=${benchmark.exitCode === 0 ? "pass" : "fail"} validation=${
		validation.exitCode === 0 ? "pass" : "fail"
	}`,
	data: { benchmark, validation },
	statePatch: [
		{
			op: "set",
			path: "/benchmark",
			value: {
				benchmarkCommand,
				benchmarkExitCode: benchmark.exitCode,
				validationCommand,
				validationExitCode: validation.exitCode,
				status: benchmark.exitCode === 0 && validation.exitCode === 0 ? "pass" : "fail",
				outputPath,
			},
		},
	],
};

async function materializeBranchStateReports(state) {
	for (const strategy of ["algorithmic", "caching", "io"]) {
		const filePath = `workflow-output/perf-${strategy}.md`;
		if (await Bun.file(filePath).exists()) continue;
		const report = branchStateReportMarkdown(strategy, state?.[strategy]);
		if (!report) continue;
		await Bun.write(filePath, report);
	}
}

function branchStateReportMarkdown(strategy, value) {
	const text = branchStateText(value);
	if (!text.trim()) return "";
	const parsed = parseJsonObject(text);
	const lines = [`# Performance ${strategy} Branch`, ""];
	if (parsed) {
		lines.push("## Structured Branch State", "", "```json", JSON.stringify(parsed, null, 2), "```", "");
		appendBranchSelectionMarker(lines, "final-selection", parsed.finalSelection);
		appendBranchSelectionMarker(lines, "no-win-result", parsed.noWinResult);
		return `${lines.join("\n")}\n`;
	}
	lines.push("## Branch State", "", text.trim(), "");
	return `${lines.join("\n")}\n`;
}

function branchStateText(value) {
	if (typeof value === "string") return value;
	if (!value || typeof value !== "object") return "";
	if (typeof value.summary === "string") return value.summary;
	if (typeof value.output === "string") return value.output;
	if (typeof value.data === "object" && value.data !== null) return JSON.stringify(value.data, null, 2);
	return JSON.stringify(value, null, 2);
}

function parseJsonObject(text) {
	try {
		const parsed = JSON.parse(text);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function appendBranchSelectionMarker(lines, marker, value) {
	if (typeof value !== "string" && typeof value !== "boolean") return;
	const normalized = typeof value === "boolean" ? (value ? "yes" : "no") : value.trim().toLowerCase();
	if (normalized !== "yes" && normalized !== "no") return;
	lines.push(`${marker}: ${normalized}`, "");
}

async function changedProjectFiles() {
	const proc = Bun.spawn(["git", "status", "--porcelain=v1", "--untracked-files=all"], {
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
		throw new Error(`git status failed before performance benchmark join: ${stderr.trim() || stdout.trim()}`);
	}
	return stdout
		.split(/\r?\n/u)
		.map((line) => statusPath(line))
		.filter((filePath) => filePath && !isAllowedWorkflowMetadataPath(filePath));
}

function projectFilesChangedAfterBranchStart(currentFiles, task) {
	const preBranchFiles = new Set(sharedProjectFilesBeforeBranches(task));
	return currentFiles.filter(filePath => !preBranchFiles.has(filePath));
}

function sharedProjectFilesBeforeBranches(task) {
	const value = task?.sharedProjectFilesBeforeBranches;
	if (!Array.isArray(value)) return [];
	return value.filter(filePath => typeof filePath === "string" && filePath.trim() !== "");
}

function statusPath(line) {
	if (line.length < 4) return "";
	const rawPath = line.slice(3).trim();
	const renamePath = rawPath.includes(" -> ") ? rawPath.split(" -> ").at(-1)?.trim() : rawPath;
	return unquoteStatusPath(renamePath ?? "");
}

function unquoteStatusPath(filePath) {
	if (!filePath.startsWith("\"") || !filePath.endsWith("\"")) return filePath;
	try {
		return JSON.parse(filePath);
	} catch {
		return filePath.slice(1, -1);
	}
}

function isAllowedWorkflowMetadataPath(filePath) {
	return (
		filePath.startsWith("workflow-output/") ||
		filePath === "task.md" ||
		filePath === "manifest-entry.json" ||
		filePath === "monitor-assignment.json" ||
		filePath === "progress.md"
	);
}

async function existingProjectLocalScratchPaths() {
	const reservedScratchPaths = ["workflow-output/tmp"];
	const existingPaths = [];
	for (const scratchPath of reservedScratchPaths) {
		if (await pathHasChildren(scratchPath)) existingPaths.push(scratchPath);
	}
	return existingPaths;
}

async function newSharedGitWorktreeMetadataPaths(task) {
	const baseline = Array.isArray(task?.sharedGitWorktrees)
		? task.sharedGitWorktrees.map(value => (typeof value === "string" ? normalizeAbsolutePath(value) : "")).filter(Boolean)
		: [];
	const baselineSet = new Set(baseline);
	return (await currentSharedGitWorktreePaths()).filter(worktree => !baselineSet.has(worktree));
}

async function currentSharedGitWorktreePaths() {
	const proc = Bun.spawn(["git", "worktree", "list", "--porcelain"], {
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
		throw new Error(`git worktree list failed before performance benchmark join: ${stderr.trim() || stdout.trim()}`);
	}
	const currentWorkspace = normalizeAbsolutePath(process.cwd());
	return stdout
		.split(/\r?\n/u)
		.map(line => line.match(/^worktree\s+(.+)$/u)?.[1]?.trim() ?? "")
		.map(normalizeAbsolutePath)
		.filter(worktree => worktree !== "" && worktree !== currentWorkspace)
		.sort();
}

async function branchEvidenceWithSharedScratchReferences() {
	const evidenceGlob = new Bun.Glob("workflow-output/perf-*");
	const references = [];
	for await (const filePath of evidenceGlob.scan({ cwd: process.cwd(), onlyFiles: true })) {
		const text = await Bun.file(filePath).text();
		if (hasSharedScratchReference(text)) references.push(filePath);
	}
	return references.sort();
}

function hasSharedScratchReference(text) {
	return /(?:^|[\s"'`(=])(?:\.\.\/)+workflow-scratch(?:\/|$)|(?:^|[\s"'`(=])workflow-scratch(?:\/|$)|\/workflow-scratch\//u.test(
		text,
	);
}

async function branchEvidenceWithDisallowedScratchRoots(task) {
	const roots = allowedScratchRoots(task);
	if (roots.length === 0) return [];
	const evidenceGlob = new Bun.Glob("workflow-output/perf-*");
	const references = [];
	for await (const filePath of evidenceGlob.scan({ cwd: process.cwd(), onlyFiles: true })) {
		const text = await Bun.file(filePath).text();
		if (hasDisallowedScratchRoot(text, roots)) references.push(filePath);
	}
	return references.sort();
}

async function branchEvidenceWithBareTmpSandboxReferences() {
	const evidenceGlob = new Bun.Glob("workflow-output/perf-*");
	const references = [];
	for await (const filePath of evidenceGlob.scan({ cwd: process.cwd(), onlyFiles: true })) {
		const text = await Bun.file(filePath).text();
		if (hasBareTmpSandboxReference(text)) references.push(filePath);
	}
	return references.sort();
}

async function branchEvidenceWithSharedWorkspaceExecutionReferences() {
	const evidenceGlob = new Bun.Glob("workflow-output/perf-*");
	const references = [];
	const workspaceRoot = normalizeAbsolutePath(process.cwd());
	for await (const filePath of evidenceGlob.scan({ cwd: process.cwd(), onlyFiles: true })) {
		const text = await Bun.file(filePath).text();
		if (hasSharedWorkspaceExecutionReference(text, workspaceRoot)) references.push(filePath);
	}
	return references.sort();
}

function allowedScratchRoots(task) {
	const taskText = typeof task?.text === "string" ? task.text : "";
	return [
		task?.scratchRoot,
		process.env.OMH_RUN_TMP,
		optionalTaskField(taskText, "Scratch Directory"),
		optionalTaskField(taskText, "Scratch Root"),
		...workflowManagedIsolationRoots(),
	]
		.filter(path => typeof path === "string" && path.trim() !== "")
		.map(path => normalizeAbsolutePath(path.trim()))
		.filter(path => path !== "");
}

function workflowManagedIsolationRoots() {
	return [process.env.OMP_WORKTREE_DIR, defaultWorkflowManagedWorktreeRoot()];
}

function defaultWorkflowManagedWorktreeRoot() {
	const home = process.env.HOME;
	if (typeof home !== "string" || home.trim() === "") return "";
	return `${home}/.omp/wt`;
}

function optionalTaskField(taskText, label) {
	const lines = taskText.split(/\r?\n/u);
	const escaped = label.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
	const pattern = new RegExp(`^\\s*${escaped}\\s*:\\s*(.*)\\s*$`, "iu");
	for (let index = 0; index < lines.length; index += 1) {
		const match = pattern.exec(lines[index] ?? "");
		if (!match) continue;
		const inline = match[1]?.trim();
		if (inline) return inline;
		for (const line of lines.slice(index + 1)) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("```")) continue;
			if (trimmed.startsWith("#") || /^[A-Z][A-Za-z /-]{0,80}:\s*$/u.test(trimmed)) return "";
			return trimmed;
		}
	}
	return "";
}

function hasDisallowedScratchRoot(text, roots) {
	const taskCacheRoots = allowedTaskDeclaredCacheRoots(task);
	return scratchEvidenceLines(text).some(line =>
		extractEvidencePaths(line).some(path => {
			const normalized = normalizeAbsolutePath(path);
			return (
				normalized !== "" &&
				!isAllowedDurableWorkflowOutputPath(normalized) &&
				!taskCacheRoots.some(root => pathIsUnder(normalized, root)) &&
				!roots.some(root => pathIsUnder(normalized, root))
			);
		}),
	);
}

function hasBareTmpSandboxReference(text) {
	return text
		.split(/\r?\n/u)
		.filter(line => !isNegativeScratchDeclaration(line))
		.some(line => hasBareTmpExecutionSurface(line));
}

function hasSharedWorkspaceExecutionReference(text, workspaceRoot) {
	return text
		.split(/\r?\n/u)
		.filter(line => !isNegativeSharedWorkspaceDeclaration(line))
		.some(line => hasSharedWorkspaceExecutionSurface(line, workspaceRoot));
}

function scratchEvidenceLines(text) {
	return text
		.split(/\r?\n/u)
		.filter(line => /\b(?:scratch|worktree|cwd|built from|applycheck|lane-local|run-local)\b/iu.test(line))
		.filter(line => !isNegativeScratchDeclaration(line));
}

function allowedTaskDeclaredCacheRoots(task) {
	const taskText = typeof task?.text === "string" ? task.text : "";
	return [
		...taskDeclaredCacheRoots(task?.benchmarkCommand),
		...taskDeclaredCacheRoots(task?.validationCommand),
		...taskDeclaredCacheRoots(taskText),
	]
		.map(normalizeAbsolutePath)
		.filter(path => path !== "");
}

function taskDeclaredCacheRoots(text) {
	if (typeof text !== "string" || text.trim() === "") return [];
	return [...text.matchAll(/(?:^|[\s`"'(])([A-Za-z_][A-Za-z0-9_]*)=((?:\/[^\s`"'<>),;]+)+)/gu)]
		.filter(match => isCacheRootEnvName(match[1] ?? ""))
		.map(match => match[2] ?? "");
}

function isCacheRootEnvName(name) {
	return (
		name === "CARGO_TARGET_DIR" ||
		/(?:^|_)(?:CACHE|TARGET)(?:_|$)/u.test(name.toUpperCase()) ||
		/(?:CACHE|TARGET)(?:DIR|ROOT|HOME|PATH)$/u.test(name.toUpperCase())
	);
}

function hasBareTmpExecutionSurface(line) {
	return /(?:^|[\s`"'])(?:--tmpfs|--dir|--bind|--bind-try|--dev-bind|--dev-bind-try)\s+\/tmp(?:$|[\s`"'])|(?:^|[\s`"'])--setenv\s+TMPDIR\s+\/tmp(?:$|[\s`"'])|(?:^|[\s`"'])TMPDIR=\/tmp(?:$|[\s`"'])|\bmount\b[^\r\n]*\s\/tmp(?:$|[\s`"'])/iu.test(
		line,
	);
}

function hasSharedWorkspaceExecutionSurface(line, workspaceRoot) {
	const executionWords = /\b(?:benchmark|validation|validate|test|tests|apply-check|build|cargo|bun|npm|pnpm|yarn|make|command|run|ran|running|execute|executed|execution)\b/iu;
	if (!executionWords.test(line)) return false;
	if (
		/\b(?:shared|unmodified|task|project|current)\s+(?:workspace|project directory|project tree)\b/iu.test(line)
	) {
		return true;
	}
	if (/\b(?:cwd|workdir|working directory)\s*[:=]\s*["'`]?\.["'`]?(?:$|[\s,.;)])/iu.test(line)) {
		return true;
	}
	if (
		workspaceRoot !== "" &&
		/\b(?:cwd|workdir|working directory)\s*[:=]/iu.test(line) &&
		extractEvidencePaths(line).some(path => normalizeAbsolutePath(path) === workspaceRoot)
	) {
		return true;
	}
	return false;
}

function extractEvidencePaths(line) {
	return [...line.matchAll(/(?:^|[\s`"'(=])((?:\/[^\s`"'<>),;]+)+)/gu)].map(match => match[1]).filter(Boolean);
}

function isNegativeScratchDeclaration(line) {
	const scratchReference = String.raw`(?:\/tmp|workflow-output\/tmp|\.\.\/workflow-scratch)`;
	return (
		/\b(?:did not|never|not|no)\b.{0,180}\b(?:use|used|create|created|place|placed|run|ran|leave|left|mount|mounted)\b.{0,180}(?:\/tmp|workflow-output\/tmp|\.\.\/workflow-scratch)\b/iu.test(
			line,
		) ||
		new RegExp(
			String.raw`\b(?:did not|never|not|no)\b.{0,220}${scratchReference}\b.{0,220}\b(?:use|used|create|created|place|placed|run|ran|execute|executed|mount|mounted)\b`,
			"iu",
		).test(line) ||
		/(?:\/tmp|workflow-output\/tmp|\.\.\/workflow-scratch)\b.{0,180}\b(?:absent|not present|not used|was not used|were not used|unused|forbidden)\b/iu.test(
			line,
		)
	);
}

function isNegativeSharedWorkspaceDeclaration(line) {
	return (
		/\b(?:did not|never|not|no)\b.{0,100}\b(?:run|ran|execute|executed|execution|benchmark|validation|test|build|command)\b.{0,100}\b(?:shared|task|project|current)\s+(?:workspace|project directory|project tree)\b/iu.test(
			line,
		) ||
		/\bnot\b.{0,60}\bfrom\b.{0,60}\b(?:shared|task|project|current)\s+(?:workspace|project directory|project tree)\b/iu.test(
			line,
		)
	);
}

function isAllowedDurableWorkflowOutputPath(path) {
	const workflowOutputRoot = normalizeAbsolutePath(`${process.cwd()}/workflow-output`);
	const workflowOutputTmp = `${workflowOutputRoot}/tmp`;
	return pathIsUnder(path, workflowOutputRoot) && !pathIsUnder(path, workflowOutputTmp);
}

function normalizeAbsolutePath(path) {
	const replaced = path.replace(/\\/gu, "/").replace(/\/+$/u, "");
	if (!replaced.startsWith("/")) return "";
	const segments = [];
	for (const segment of replaced.split("/")) {
		if (!segment || segment === ".") continue;
		if (segment === "..") {
			segments.pop();
			continue;
		}
		segments.push(segment);
	}
	return `/${segments.join("/")}`;
}

function pathIsUnder(path, root) {
	return path === root || path.startsWith(`${root}/`);
}

async function pathHasChildren(path) {
	const childGlob = new Bun.Glob(`${path}/**`);
	for await (const _match of childGlob.scan({ cwd: process.cwd(), onlyFiles: false })) return true;
	return false;
}

async function runShell(command) {
	const proc = Bun.spawn(["sh", "-c", command], {
		cwd: process.cwd(),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return {
		exitCode,
		stdout: bounded(stdout),
		stderr: bounded(stderr),
	};
}

function evidenceMarkdown(benchmarkCommand, benchmark, validationCommand, validation) {
	return [
		"# Performance Benchmark Evidence",
		"",
		"## Benchmark Command",
		"",
		"```sh",
		benchmarkCommand,
		"```",
		"",
		`Exit code: ${benchmark.exitCode}`,
		"",
		"```text",
		benchmark.stdout || benchmark.stderr || "(empty)",
		"```",
		"",
		"## Validation Command",
		"",
		"```sh",
		validationCommand,
		"```",
		"",
		`Exit code: ${validation.exitCode}`,
		"",
		"```text",
		validation.stdout || validation.stderr || "(empty)",
		"```",
		"",
	].join("\n");
}

function projectLocalScratchIsolationViolationMarkdown(projectLocalScratchPaths) {
	return [
		"# Performance Benchmark Evidence",
		"",
		"## Project-Local Scratch Isolation Violation",
		"",
		"Parallel optimization lanes must keep scratch copies, worktrees, benchmark fixtures, and temporary data outside the project tree.",
		"Durable candidate patches and reports belong in `workflow-output/`, but lane-local execution scratch must not live under `workflow-output/tmp` or another project-scanned path.",
		"",
		"## Project-Local Scratch Paths",
		"",
		projectLocalScratchPaths.map((file) => `- ${file}`).join("\n"),
		"",
	].join("\n");
}

function sharedScratchIsolationViolationMarkdown(sharedScratchReferences) {
	return [
		"# Performance Benchmark Evidence",
		"",
		"## Shared Scratch Isolation Violation",
		"",
		"Parallel optimization lanes must use run-local scratch or worktrees.",
		"Branch evidence that points at shared sibling scratch such as `../workflow-scratch` cannot prove lane isolation and may reuse stale work from another tuple.",
		"",
		"## Evidence Files With Shared Scratch References",
		"",
		sharedScratchReferences.map((file) => `- ${file}`).join("\n"),
		"",
	].join("\n");
}

function sharedGitWorktreeMetadataViolationMarkdown(sharedGitWorktreeMetadataPaths) {
	return [
		"# Performance Benchmark Evidence",
		"",
		"## Shared Git Worktree Metadata Violation",
		"",
		"Parallel optimization lanes may not create git worktrees from the shared task checkout.",
		"`git worktree add` mutates the shared checkout's `.git/worktrees` metadata, so it is not read-only shared-workspace inspection even when the worktree path is under `task.scratchRoot`.",
		"Use an independent scratch copy or clone under `task.scratchRoot` instead, and keep branch build, benchmark, validation, apply-check, and candidate execution there.",
		"",
		"## Shared Git Worktree Metadata Paths",
		"",
		sharedGitWorktreeMetadataPaths.map((file) => `- ${file}`).join("\n"),
		"",
	].join("\n");
}

function disallowedScratchRootViolationMarkdown(disallowedScratchReferences, roots) {
	return [
		"# Performance Benchmark Evidence",
		"",
		"## Disallowed Scratch Root Violation",
		"",
		"Parallel optimization lanes must keep scratch copies, worktrees, benchmark fixtures, and temporary data under this run's allowed lane roots.",
		"Evidence that points at `/tmp` or another scratch root outside `OMH_RUN_TMP`, the task-declared scratch directory, or an OMH-managed isolation worktree cannot prove tuple isolation.",
		"Writable bare `/tmp` sandbox mounts such as `bwrap --tmpfs /tmp`, `--bind /tmp`, `--dir /tmp`, or `TMPDIR=/tmp` are not valid isolation evidence; mount or bind a directory under the allowed run-local scratch root instead.",
		"",
		"## Allowed Lane Roots",
		"",
		roots.length > 0 ? roots.map(root => `- ${root}`).join("\n") : "- none declared",
		"",
		"## Evidence Files With Disallowed Scratch Roots",
		"",
		disallowedScratchReferences.map((file) => `- ${file}`).join("\n"),
		"",
	].join("\n");
}

function sharedWorkspaceExecutionViolationMarkdown(sharedWorkspaceExecutionReferences) {
	return [
		"# Performance Benchmark Evidence",
		"",
		"## Shared Workspace Execution Violation",
		"",
		"Parallel optimization branches may inspect the shared workspace and write durable artifacts under `workflow-output/`, but branch build, benchmark, validation, apply-check, and candidate execution must run from lane-local worktrees or copies under `task.scratchRoot`.",
		"Evidence that a branch command ran from `cwd: .`, the task workspace, or the unmodified shared workspace cannot prove lane isolation.",
		"",
		"## Evidence Files With Shared Workspace Execution",
		"",
		sharedWorkspaceExecutionReferences.map((file) => `- ${file}`).join("\n"),
		"",
	].join("\n");
}

function isolationViolationMarkdown(projectChangedFiles) {
	return [
		"# Performance Benchmark Evidence",
		"",
		"## Parallel Lane Isolation Violation",
		"",
		"Parallel optimization lanes must leave no project-file edits in the shared workspace before the join.",
		"Candidate patches and measurements belong in lane-local scratch workspaces or patch artifacts; the selection repair node may apply at most one candidate after the branches join.",
		"",
		"## Shared Project Changes",
		"",
		projectChangedFiles.map((file) => `- ${file}`).join("\n"),
		"",
	].join("\n");
}

function bounded(text) {
	const limit = 12000;
	if (text.length <= limit) return text;
	return `${text.slice(0, limit)}\n[truncated ${text.length - limit} bytes]`;
}
