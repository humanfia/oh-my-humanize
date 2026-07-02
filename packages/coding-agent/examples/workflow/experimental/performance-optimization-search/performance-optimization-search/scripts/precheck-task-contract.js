const taskText = await readRequiredTaskText();
const benchmarkCommand = requiredCommand(taskText, "Benchmark Command");
const validationCommand = requiredCommand(taskText, "Validation Command");
const baselineCommand = optionalCommand(taskText, "Baseline Command") || benchmarkCommand;
const scratchRoot = requiredScratchRoot(taskText);
const allowedProjectPaths = projectPathList(taskText, "Allowed paths");
const benchmarkTargetPaths = projectPathList(taskText, "Benchmark Target Paths", "Benchmark Target Path");
const benchmarkSourceRoots = benchmarkSourceRootsFromTask(taskText, benchmarkTargetPaths);
const benchmarkTargetViolation = benchmarkTargetPathViolation(allowedProjectPaths, benchmarkTargetPaths);
const sharedGitWorktrees = await currentSharedGitWorktreePaths();
const runtime = runtimeFromTaskContract(taskText);
let baselinePreflight = null;
let benchmarkPreflight = null;
let validationPreflight = null;
const commandScratchViolations = disallowedTaskCommandScratchReferences([
	{ label: "Benchmark Command", command: benchmarkCommand },
	{ label: "Validation Command", command: validationCommand },
	{ label: "Baseline Command", command: baselineCommand },
]);
if (commandScratchViolations.length > 0) {
	await Bun.write(
		"workflow-output/performance-precheck.md",
		precheckMarkdown({
			benchmarkCommand,
			validationCommand,
			baselineCommand,
			scratchRoot,
			allowedProjectPaths,
			benchmarkTargetPaths,
			benchmarkSourceRoots,
			sharedGitWorktrees,
			commandScratchViolations,
			benchmarkTargetViolation: null,
			baselinePreflight,
			benchmarkPreflight,
			validationPreflight: null,
		}),
	);
	throw new Error("performance-optimization-search task commands use disallowed scratch roots");
}
if (benchmarkTargetViolation) {
	await Bun.write(
		"workflow-output/performance-precheck.md",
		precheckMarkdown({
			benchmarkCommand,
			validationCommand,
			baselineCommand,
			scratchRoot,
			allowedProjectPaths,
			benchmarkTargetPaths,
			benchmarkSourceRoots,
			sharedGitWorktrees,
			commandScratchViolations: [],
			benchmarkTargetViolation,
			baselinePreflight,
			benchmarkPreflight,
			validationPreflight: null,
		}),
	);
	throw new Error(benchmarkTargetViolation.message);
}
baselinePreflight = await runShell(baselineCommand, benchmarkSourceRoots);
benchmarkPreflight = benchmarkCommand === baselineCommand ? baselinePreflight : await runShell(benchmarkCommand, benchmarkSourceRoots);
validationPreflight = await runShell(validationCommand, benchmarkSourceRoots);

await Bun.write(
	"workflow-output/performance-precheck.md",
	precheckMarkdown({
		benchmarkCommand,
		validationCommand,
		baselineCommand,
		scratchRoot,
		allowedProjectPaths,
		benchmarkTargetPaths,
		benchmarkSourceRoots,
		sharedGitWorktrees,
		commandScratchViolations: [],
		benchmarkTargetViolation: null,
		baselinePreflight,
		benchmarkPreflight,
		validationPreflight,
	}),
);

if (baselinePreflight.exitCode !== 0) {
	throw new Error(
		`performance-optimization-search baseline command failed preflight with exit code ${baselinePreflight.exitCode}`,
	);
}
const baselineFailureDiagnostic = commandFailureDiagnostic(baselinePreflight);
if (baselineFailureDiagnostic) {
	throw new Error(
		`performance-optimization-search baseline command produced a fatal diagnostic despite exit code 0: ${baselineFailureDiagnostic}`,
	);
}
if (benchmarkPreflight.exitCode !== 0) {
	throw new Error(
		`performance-optimization-search benchmark command failed preflight with exit code ${benchmarkPreflight.exitCode}`,
	);
}
const benchmarkFailureDiagnostic = commandFailureDiagnostic(benchmarkPreflight);
if (benchmarkFailureDiagnostic) {
	throw new Error(
		`performance-optimization-search benchmark command produced a fatal diagnostic despite exit code 0: ${benchmarkFailureDiagnostic}`,
	);
}
if (validationPreflight.exitCode !== 0) {
	throw new Error(
		`performance-optimization-search validation command failed preflight with exit code ${validationPreflight.exitCode}`,
	);
}
const validationFailureDiagnostic = commandFailureDiagnostic(validationPreflight);
if (validationFailureDiagnostic) {
	throw new Error(
		`performance-optimization-search validation command produced a fatal diagnostic despite exit code 0: ${validationFailureDiagnostic}`,
	);
}

return {
	summary: "validated performance optimization task contract",
	statePatch: [
		{
			op: "set",
			path: "/task",
			value: {
				file: "task.md",
				text: taskText,
				benchmarkCommand,
				validationCommand,
				baselineCommand,
				scratchRoot,
				allowedProjectPaths,
				benchmarkTargetPaths,
				benchmarkSourceRoots,
				sharedGitWorktrees,
				validationPreflight: {
					exitCode: validationPreflight.exitCode,
					stdout: validationPreflight.stdout,
					stderr: validationPreflight.stderr,
					failureDiagnostic: validationFailureDiagnostic,
				},
				baselinePreflight: {
					exitCode: baselinePreflight.exitCode,
					stdout: baselinePreflight.stdout,
					stderr: baselinePreflight.stderr,
					failureDiagnostic: baselineFailureDiagnostic,
				},
				benchmarkPreflight: {
					exitCode: benchmarkPreflight.exitCode,
					stdout: benchmarkPreflight.stdout,
					stderr: benchmarkPreflight.stderr,
					failureDiagnostic: benchmarkFailureDiagnostic,
				},
			},
		},
		{ op: "set", path: "/runtime", value: runtime },
		{
			op: "set",
			path: "/review",
			value: "No previous performance review yet.",
		},
	],
};

async function readRequiredTaskText() {
	try {
		const text = await Bun.file("task.md").text();
		if (!text.trim()) throw new Error("empty");
		return text;
	} catch {
		throw new Error("performance-optimization-search requires task.md in the project root");
	}
}

function requiredCommand(taskContract, label) {
	const command = optionalCommand(taskContract, label);
	if (!command) throw new Error(`performance-optimization-search task.md must declare ${label}`);
	return command;
}

function requiredScratchRoot(taskContract) {
	const scratchRoot =
		optionalCommand(taskContract, "Scratch Directory") ||
		optionalCommand(taskContract, "Scratch Root") ||
		process.env.OMH_RUN_TMP ||
		"";
	const normalized = normalizeAbsolutePath(scratchRoot.trim());
	if (!normalized) {
		throw new Error(
			"performance-optimization-search requires OMH_RUN_TMP or an absolute Scratch Directory / Scratch Root in task.md",
		);
	}
	return normalized;
}

function optionalCommand(taskContract, label) {
	const lines = taskContract.split(/\r?\n/u);
	const escaped = label.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
	const pattern = new RegExp(`^\\s*${escaped}\\s*:\\s*(.*)\\s*$`, "iu");
	for (let index = 0; index < lines.length; index += 1) {
		const match = pattern.exec(lines[index] ?? "");
		if (!match) continue;
		const inline = match[1]?.trim();
		if (inline) return inline;
		return firstFollowingCommandLine(lines, index + 1);
	}
	return "";
}

function firstFollowingCommandLine(lines, startIndex) {
	for (const line of lines.slice(startIndex)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("```")) continue;
		if (isTaskSectionHeading(trimmed)) return "";
		return trimmed;
	}
	return "";
}

function isTaskSectionHeading(line) {
	return line.startsWith("#") || /^[A-Z][A-Za-z /-]{0,80}:\s*$/u.test(line);
}

function projectPathList(taskContract, ...labels) {
	const lines = taskContract.split(/\r?\n/u);
	const values = [];
	for (const label of labels) {
		const escaped = label.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
		const pattern = new RegExp(`^\\s*${escaped}\\s*:\\s*(.*)\\s*$`, "iu");
		for (let index = 0; index < lines.length; index += 1) {
			const match = pattern.exec(lines[index] ?? "");
			if (!match) continue;
			const inline = match[1]?.trim();
			if (inline) {
				values.push(...pathListItems(inline));
			} else {
				values.push(...followingPathListItems(lines, index + 1));
			}
		}
	}
	return [...new Set(values.map(normalizeProjectPathPattern).filter(isProjectPathPattern))];
}

function followingPathListItems(lines, startIndex) {
	const values = [];
	for (const line of lines.slice(startIndex)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("```")) continue;
		if (isTaskSectionHeading(trimmed)) break;
		values.push(...pathListItems(trimmed));
	}
	return values;
}

function pathListItems(text) {
	return text
		.split(",")
		.map(value => value.trim())
		.map(value => value.replace(/^[-*]\s+/u, ""))
		.map(value => value.replace(/^\d+[.)]\s+/u, ""))
		.filter(Boolean);
}

function normalizeProjectPathPattern(value) {
	return value
		.replace(/^`|`$/gu, "")
		.replace(/[.;]\s*$/u, "")
		.replace(/\\/gu, "/")
		.replace(/^\.\/+/u, "")
		.replace(/\/{2,}/gu, "/")
		.trim();
}

function isProjectPathPattern(value) {
	if (!value) return false;
	if (value.startsWith("/") || value.startsWith("../") || value.includes("/../")) return false;
	if (value === "." || value === "..") return false;
	if (value.startsWith(".git/") || value === ".git") return false;
	if (isWorkflowContractPath(value)) return false;
	return true;
}

function isWorkflowContractPath(value) {
	return (
		value === "task.md" ||
		value === "TASK.md" ||
		value === "manifest-entry.json" ||
		value === "monitor-assignment.json" ||
		value === "monitor-assignment*.json" ||
		value === "workflow-output" ||
		value === "workflow-output/**" ||
		value.startsWith("workflow-output/")
	);
}

function benchmarkTargetPathViolation(allowedProjectPaths, benchmarkTargetPaths) {
	if (allowedProjectPaths.length === 0) return null;
	if (benchmarkTargetPaths.length === 0) {
		return {
			message:
				"performance-optimization-search task.md must declare Benchmark Target Paths when Allowed paths restrict project files",
			missingTargets: true,
			uncoveredTargets: [],
		};
	}
	const uncoveredTargets = benchmarkTargetPaths.filter(
		target => !allowedProjectPaths.some(pattern => projectPathCovers(pattern, target)),
	);
	if (uncoveredTargets.length === 0) return null;
	return {
		message: `performance-optimization-search benchmark target paths are outside allowed project paths: ${uncoveredTargets.join(", ")}`,
		missingTargets: false,
		uncoveredTargets,
	};
}

function benchmarkSourceRootsFromTask(taskContract, benchmarkTargetPaths) {
	const explicitSourceRoots = projectPathList(taskContract, "Benchmark Source Roots", "Benchmark Source Root");
	if (explicitSourceRoots.length > 0) return explicitSourceRoots;
	return [...new Set(benchmarkTargetPaths.map(inferSourceRoot).filter(Boolean))];
}

function inferSourceRoot(targetPath) {
	if (targetPath === "src" || targetPath.startsWith("src/")) return "src";
	return "";
}

function projectPathCovers(pattern, target) {
	if (pattern === target) return true;
	if (pattern.endsWith("/**")) {
		const prefix = pattern.slice(0, -3);
		return target === prefix || target.startsWith(`${prefix}/`);
	}
	if (pattern.endsWith("/")) return target.startsWith(pattern);
	if (!pattern.includes("*")) return false;
	return globPatternRegExp(pattern).test(target);
}

function globPatternRegExp(pattern) {
	let source = "^";
	for (let index = 0; index < pattern.length; index += 1) {
		const char = pattern[index];
		if (char === "*") {
			if (pattern[index + 1] === "*") {
				source += ".*";
				index += 1;
			} else {
				source += "[^/]*";
			}
			continue;
		}
		source += char.replace(/[\\^$+?.()|[\]{}]/gu, "\\$&");
	}
	source += "$";
	return new RegExp(source, "u");
}

function runtimeFromTaskContract() {
	return {
		startedAtMs: Date.now(),
	};
}

function precheckMarkdown({
	benchmarkCommand,
	validationCommand,
	baselineCommand,
	scratchRoot,
	allowedProjectPaths,
	benchmarkTargetPaths,
	benchmarkSourceRoots,
	sharedGitWorktrees,
	commandScratchViolations,
	benchmarkTargetViolation,
	baselinePreflight,
	benchmarkPreflight,
	validationPreflight,
}) {
	const sections = [
		"# Performance Optimization Precheck",
		"",
		"## Benchmark Command",
		"",
		"```sh",
		benchmarkCommand,
		"```",
		"",
		"## Validation Command",
		"",
		"```sh",
		validationCommand,
		"```",
		"",
		"## Baseline Command",
		"",
		"```sh",
		baselineCommand,
		"```",
		"",
		"## Scratch Root",
		"",
		scratchRoot,
		"",
		"## Allowed Project Paths",
		"",
		allowedProjectPaths.length > 0 ? allowedProjectPaths.map(value => `- ${value}`).join("\n") : "- unrestricted",
		"",
		"## Benchmark Target Paths",
		"",
		benchmarkTargetPaths.length > 0 ? benchmarkTargetPaths.map(value => `- ${value}`).join("\n") : "- not declared",
		"",
		"## Benchmark Source Roots",
		"",
		benchmarkSourceRoots.length > 0 ? benchmarkSourceRoots.map(value => `- ${value}`).join("\n") : "- not declared",
		"",
		"## Shared Git Worktrees At Start",
		"",
		sharedGitWorktrees.length > 0 ? sharedGitWorktrees.map(worktree => `- ${worktree}`).join("\n") : "- none",
		"",
	];

	if (commandScratchViolations.length > 0) {
		sections.push(
			"## Task Command Scratch Root Violation",
			"",
			"Performance branch agents run in parallel, so task-declared benchmark, baseline, and validation commands must not write lane-local evidence to bare `/tmp`, `workflow-output/tmp`, or shared sibling scratch.",
			"Use `/dev/null` for disposable benchmark output, or an explicit run-local scratch path under the task scratch root.",
			"",
			...commandScratchViolations.map(violation => `- ${violation.label}: \`${violation.reference}\``),
			"",
		);
	} else if (benchmarkTargetViolation) {
		sections.push(
			"## Benchmark Target Path Violation",
			"",
			benchmarkTargetViolation.missingTargets
				? "Task allowed paths restrict project files, so the task must declare Benchmark Target Paths for the measured hot path."
				: "Task-declared benchmark target paths must be covered by the allowed project paths before parallel optimization begins.",
			"",
			...(benchmarkTargetViolation.uncoveredTargets.length > 0
				? benchmarkTargetViolation.uncoveredTargets.map(value => `- uncovered target: ${value}`)
				: []),
			"",
		);
	} else {
		if (baselinePreflight) {
			sections.push("## Baseline Preflight", "", commandEvidenceMarkdown(baselineCommand, baselinePreflight), "");
		}
		if (benchmarkPreflight) {
			sections.push("## Benchmark Preflight", "", commandEvidenceMarkdown(benchmarkCommand, benchmarkPreflight), "");
		}
		if (validationPreflight) {
			sections.push("## Validation Preflight", "", commandEvidenceMarkdown(validationCommand, validationPreflight), "");
		}
	}

	return sections.join("\n");
}

function disallowedTaskCommandScratchReferences(commands) {
	return commands.flatMap(({ label, command }) => {
		const reference = disallowedTaskCommandScratchReference(command);
		return reference ? [{ label, reference }] : [];
	});
}

function disallowedTaskCommandScratchReference(command) {
	if (/\bTMPDIR\s*=\s*["']?\/tmp(?:\/|\b)/u.test(command)) return "TMPDIR=/tmp";
	if (/(?:^|[\s"'(=<>|&;])\/tmp(?:\/|\b)/u.test(command)) return "/tmp";
	if (/(?:^|[\s"'(=<>|&;])workflow-output\/tmp(?:\/|\b)/u.test(command)) return "workflow-output/tmp";
	if (/(?:^|[\s"'(=<>|&;])\.\.\/workflow-scratch(?:\/|\b)/u.test(command)) return "../workflow-scratch";
	return "";
}

async function runShell(command, sourceRoots = []) {
	const proc = Bun.spawn(["sh", "-c", command], {
		cwd: process.cwd(),
		env: sourceRootEnv(sourceRoots),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout: bounded(stdout), stderr: bounded(stderr), exitCode };
}

function sourceRootEnv(sourceRoots) {
	const env = { ...process.env };
	const absoluteRoots = sourceRoots.map(root => normalizeProjectRoot(root)).filter(Boolean);
	if (absoluteRoots.length === 0) return env;
	const separator = process.platform === "win32" ? ";" : ":";
	const current = typeof process.env.PYTHONPATH === "string" && process.env.PYTHONPATH !== "" ? process.env.PYTHONPATH : "";
	env.PYTHONPATH = [...absoluteRoots, current].filter(Boolean).join(separator);
	return env;
}

function normalizeProjectRoot(root) {
	const normalized = normalizeProjectPathPattern(root);
	if (!normalized || normalized.includes("*")) return "";
	return `${process.cwd().replace(/\/+$/u, "")}/${normalized}`;
}

function commandEvidenceMarkdown(command, result) {
	const failureDiagnostic = commandFailureDiagnostic(result);
	const lines = [
		"```sh",
		command,
		"```",
		"",
		`Exit code: ${result.exitCode}`,
		"",
		"```text",
		result.stdout || result.stderr || "(empty)",
		"```",
		"",
	];
	if (failureDiagnostic) {
		lines.push("### Fatal Command Diagnostic", "", failureDiagnostic, "");
	}
	return lines.join("\n");
}

function commandFailureDiagnostic(result) {
	const text = `${result.stderr ?? ""}\n${result.stdout ?? ""}`;
	for (const line of text.split(/\r?\n/u)) {
		const diagnostic = line.trim();
		if (!diagnostic) continue;
		if (isFatalCommandDiagnostic(diagnostic)) return diagnostic;
	}
	return "";
}

function isFatalCommandDiagnostic(line) {
	return (
		/\b(?:command not found|no such file or directory|not a directory|is not a directory|permission denied)\b/iu.test(
			line,
		) ||
		/\b(?:unknown|unrecognized|invalid)\s+(?:option|flag|argument|parameter)\b/iu.test(line) ||
		/^usage:\s+/iu.test(line) ||
		/\bhere-document\b/iu.test(line) ||
		/\b(?:traceback \(most recent call last\)|syntaxerror|modulenotfounderror|importerror)\b/iu.test(line)
	);
}

function bounded(text) {
	const limit = 12000;
	if (text.length <= limit) return text;
	return `${text.slice(0, limit)}\n[truncated ${text.length - limit} bytes]`;
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
		throw new Error(`git worktree list failed during performance precheck: ${stderr.trim() || stdout.trim()}`);
	}
	const currentWorkspace = normalizeAbsolutePath(process.cwd());
	return stdout
		.split(/\r?\n/u)
		.map(line => line.match(/^worktree\s+(.+)$/u)?.[1]?.trim() ?? "")
		.map(normalizeAbsolutePath)
		.filter(worktree => worktree !== "" && worktree !== currentWorkspace)
		.sort();
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
