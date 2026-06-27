const task = workflowContext.state?.task;
const benchmarkCommand = task?.benchmarkCommand;
const validationCommand = task?.validationCommand;
if (typeof benchmarkCommand !== "string" || benchmarkCommand.trim() === "") {
	throw new Error("performance-optimization-search requires /task.benchmarkCommand before benchmarkCandidates");
}
if (typeof validationCommand !== "string" || validationCommand.trim() === "") {
	throw new Error("performance-optimization-search requires /task.validationCommand before benchmarkCandidates");
}

const projectChangedFiles = await changedProjectFiles();
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

function allowedScratchRoots(task) {
	const taskText = typeof task?.text === "string" ? task.text : "";
	return [process.env.OMH_RUN_TMP, optionalTaskField(taskText, "Scratch Directory"), optionalTaskField(taskText, "Scratch Root")]
		.filter(path => typeof path === "string" && path.trim() !== "")
		.map(path => normalizeAbsolutePath(path.trim()))
		.filter(path => path !== "");
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
	return scratchEvidenceLines(text).some(line =>
		extractEvidencePaths(line).some(path => {
			const normalized = normalizeAbsolutePath(path);
			return normalized !== "" && !roots.some(root => pathIsUnder(normalized, root));
		}),
	);
}

function scratchEvidenceLines(text) {
	return text
		.split(/\r?\n/u)
		.filter(line => /\b(?:scratch|worktree|cwd|built from|applycheck|lane-local|run-local)\b/iu.test(line));
}

function extractEvidencePaths(line) {
	const matches = line.match(/(?:\/[^\s`"'<>),;]+)+/gu);
	return matches ?? [];
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

function disallowedScratchRootViolationMarkdown(disallowedScratchReferences, roots) {
	return [
		"# Performance Benchmark Evidence",
		"",
		"## Disallowed Scratch Root Violation",
		"",
		"Parallel optimization lanes must keep scratch copies, worktrees, benchmark fixtures, and temporary data under this run's allowed scratch root.",
		"Evidence that points at `/tmp` or another scratch root outside `OMH_RUN_TMP` or the task-declared scratch directory cannot prove tuple isolation.",
		"",
		"## Allowed Scratch Roots",
		"",
		roots.length > 0 ? roots.map(root => `- ${root}`).join("\n") : "- none declared",
		"",
		"## Evidence Files With Disallowed Scratch Roots",
		"",
		disallowedScratchReferences.map((file) => `- ${file}`).join("\n"),
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
