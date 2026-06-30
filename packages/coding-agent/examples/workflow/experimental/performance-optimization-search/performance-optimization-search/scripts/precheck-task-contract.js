const taskText = await readRequiredTaskText();
const benchmarkCommand = requiredCommand(taskText, "Benchmark Command");
const validationCommand = requiredCommand(taskText, "Validation Command");
const baselineCommand = optionalCommand(taskText, "Baseline Command") || benchmarkCommand;
const scratchRoot = requiredScratchRoot(taskText);
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
			sharedGitWorktrees,
			commandScratchViolations,
			validationPreflight: null,
		}),
	);
	throw new Error("performance-optimization-search task commands use disallowed scratch roots");
}
const validationPreflight = await runShell(validationCommand);

await Bun.write(
	"workflow-output/performance-precheck.md",
	precheckMarkdown({
		benchmarkCommand,
		validationCommand,
		baselineCommand,
		scratchRoot,
		sharedGitWorktrees,
		commandScratchViolations: [],
		validationPreflight,
	}),
);

if (validationPreflight.exitCode !== 0) {
	throw new Error(
		`performance-optimization-search validation command failed preflight with exit code ${validationPreflight.exitCode}`,
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
				sharedGitWorktrees,
				validationPreflight: {
					exitCode: validationPreflight.exitCode,
					stdout: validationPreflight.stdout,
					stderr: validationPreflight.stderr,
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
	sharedGitWorktrees,
	commandScratchViolations,
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
	return [
		"```sh",
		command,
		"```",
		"",
		`Exit code: ${result.exitCode}`,
		"",
		"```text",
		result.stdout || result.stderr || "(empty)",
		"```",
	].join("\n");
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
