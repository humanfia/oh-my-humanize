const taskText = await readRequiredTaskText();
const benchmarkCommand = requiredCommand(taskText, "Benchmark Command");
const validationCommand = requiredCommand(taskText, "Validation Command");
const baselineCommand = optionalCommand(taskText, "Baseline Command") || benchmarkCommand;
const scratchRoot = requiredScratchRoot(taskText);
const allowedProjectPaths = projectPathList(taskText, "Allowed paths");
const benchmarkTargetPaths = projectPathList(taskText, "Benchmark Target Paths", "Benchmark Target Path");
const benchmarkTargetViolation = benchmarkTargetPathViolation(allowedProjectPaths, benchmarkTargetPaths);
const sharedGitWorktrees = await currentSharedGitWorktreePaths();
const runtime = runtimeFromTaskContract(taskText);
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
			sharedGitWorktrees,
			commandScratchViolations,
			benchmarkTargetViolation: null,
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
			sharedGitWorktrees,
			commandScratchViolations: [],
			benchmarkTargetViolation,
			validationPreflight: null,
		}),
	);
	throw new Error(benchmarkTargetViolation.message);
}
const validationPreflight = await runShell(validationCommand);

await Bun.write(
	"workflow-output/performance-precheck.md",
	precheckMarkdown({
		benchmarkCommand,
		validationCommand,
		baselineCommand,
		scratchRoot,
		allowedProjectPaths,
		benchmarkTargetPaths,
		sharedGitWorktrees,
		commandScratchViolations: [],
		benchmarkTargetViolation: null,
		validationPreflight,
	}),
);

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
				sharedGitWorktrees,
				validationPreflight: {
					exitCode: validationPreflight.exitCode,
					stdout: validationPreflight.stdout,
					stderr: validationPreflight.stderr,
					failureDiagnostic: validationFailureDiagnostic,
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
	sharedGitWorktrees,
	commandScratchViolations,
	benchmarkTargetViolation,
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
	} else if (validationPreflight) {
		sections.push("## Validation Preflight", "", commandEvidenceMarkdown(validationCommand, validationPreflight), "");
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
	return { stdout, stderr, exitCode };
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
		/\b(?:traceback \(most recent call last\)|syntaxerror|modulenotfounderror|importerror)\b/u.test(line)
	);
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
