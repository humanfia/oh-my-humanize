const progressPath = "progress.md";
const snapshotPath = "workflow-output/initial-loop-snapshot.md";

if (!(await fileExists(progressPath))) {
	await Bun.write(progressPath, "# Agent Build/Review Progress\n\n");
}

const taskText = await readRequiredTaskText();
const verifyCommand = requiredTaskValidationCommand(taskText);
assertSafeVerificationCommand(verifyCommand);
const validationPreflight = await validateVerificationPreflight(verifyCommand);
if (validationPreflight.status === "setup-blocker") {
	await Bun.write(
		"workflow-output/setup-blocker-validation-preflight.json",
		`${JSON.stringify(validationPreflight, null, 2)}\n`,
	);
	throw new Error(`agent-build-review-loop validation preflight setup blocker: ${validationPreflight.reason}`);
}
const runtime = runtimeFromTaskContract(taskText);
const snapshot = [
	"# Initial Loop Snapshot",
	"",
	"## Task",
	"",
	boundedLines(taskText, 120),
	"",
	"## Workspace Snapshot",
	"",
	"Workspace file listing is intentionally omitted from this portable flow script.",
	"Agents and reviewers should inspect the current project diff and task contract directly.",
	"",
	"## Declared Verification Command",
	"",
	"```text",
	verifyCommand,
	"```",
	"",
].join("\n");

await Bun.write(snapshotPath, snapshot);

return {
	summary: "initialized agent build/review loop with task-declared verification command",
	statePatch: [
		{
			op: "set",
			path: "/progress",
			value: {
				file: progressPath,
				snapshot: snapshotPath,
				validationCommand: verifyCommand,
				validationPreflight,
				verification: "declared",
			},
		},
		{
			op: "set",
			path: "/runtime",
			value: runtime,
		},
		{
			op: "set",
			path: "/semanticGuard",
			value: {
				verdict: "NONE",
				reasons: [],
				findings: [],
				summary: "No semantic archive guard has run yet.",
			},
		},
	],
};

async function fileExists(filePath) {
	try {
		await Bun.file(filePath).text();
		return true;
	} catch {
		return false;
	}
}

async function readOptionalText(filePath) {
	try {
		return await Bun.file(filePath).text();
	} catch {
		return "";
	}
}

async function readRequiredTaskText() {
	const taskText = await readOptionalText("task.md");
	if (!taskText.trim()) {
		throw new Error("agent-build-review-loop requires a task.md contract in the project root");
	}
	return taskText;
}

function requiredTaskValidationCommand(taskText) {
	const lines = taskText.split(/\r?\n/u);
	for (let index = 0; index < lines.length; index += 1) {
		const match = /^\s*#{0,6}\s*(?:verify|verification command|validation command)\s*:?\s*(.*)\s*$/iu.exec(
			lines[index] ?? "",
		);
		if (!match) continue;
		const inlineCommand = match[1]?.trim();
		if (inlineCommand) return inlineCommand;
		const followingCommand = firstFollowingCommandLine(lines, index + 1);
		if (followingCommand) return followingCommand;
	}
	throw new Error("agent-build-review-loop task.md must declare a Validation Command");
}

function assertSafeVerificationCommand(command) {
	const normalized = command.toLowerCase();
	if (/\b(sleep|watch|tail\s+-f|yes)\b/u.test(normalized)) {
		throw new Error("agent-build-review-loop validation command cannot be a wait/watch/sleep command");
	}
	const timeoutMatch = /\btimeout\s+(\d+)([smhd]?)\b/u.exec(normalized);
	if (timeoutMatch) {
		const value = Number(timeoutMatch[1]);
		const unit = timeoutMatch[2] || "s";
		const seconds = unit === "d" ? value * 86400 : unit === "h" ? value * 3600 : unit === "m" ? value * 60 : value;
		if (seconds > 900) {
			throw new Error("agent-build-review-loop validation command timeout must be 15 minutes or less");
		}
	}
}

async function validateVerificationPreflight(command) {
	const material = [command, await validationCommandScriptText(command)].filter(Boolean).join("\n");
	const missingDependencyRoots = [];
	if (requiresNodeDependencyRoot(material) && !(await directoryExists("node_modules"))) {
		missingDependencyRoots.push("node_modules");
	}
	const executableCheck = await explicitExecutablePreflight(command);
	const blockers = [
		...missingDependencyRoots.map(root => `missing dependency root: ${root}`),
		...(executableCheck.reason ? [executableCheck.reason] : []),
	];
	const status = blockers.length > 0 ? "setup-blocker" : "pass";
	return {
		status,
		validationCommand: command,
		executable: executableCheck.executable,
		missingDependencyRoots,
		executableCheck,
		reason:
			status === "setup-blocker"
				? `validation command cannot start: ${blockers.join("; ")}`
				: "validation command preflight did not find missing dependency roots or invalid explicit executables",
		checkedAtMs: Date.now(),
	};
}

async function explicitExecutablePreflight(command) {
	const executable = validationExecutable(command);
	if (!executable || !isExplicitPath(executable)) {
		return {
			executable,
			status: "not-explicit-path",
			reason: "",
		};
	}
	if (await pathStatus(executable, "-d")) {
		return {
			executable,
			status: "setup-blocker",
			reason: `validation executable is a directory: ${executable}`,
		};
	}
	if (!(await pathStatus(executable, "-e"))) {
		return {
			executable,
			status: "setup-blocker",
			reason: `validation executable does not exist: ${executable}`,
		};
	}
	if (!(await pathStatus(executable, "-x"))) {
		return {
			executable,
			status: "setup-blocker",
			reason: `validation executable is not executable: ${executable}`,
		};
	}
	return {
		executable,
		status: "pass",
		reason: "",
	};
}

function validationExecutable(command) {
	const tokens = commandInvocationTokens(command);
	const first = tokens[0] ?? "";
	if (!first) return "";
	if (/^(?:bash|sh|zsh)$/u.test(first) && tokens[1] === "-c") return first;
	if (/^(?:bash|sh|zsh|bun|node|python|python3)$/u.test(first)) return first;
	return first;
}

function commandInvocationTokens(command) {
	const tokens = command.trim().split(/\s+/u).filter(Boolean).map(unquoteToken);
	while (tokens.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(tokens[0] ?? "")) tokens.shift();
	if ((tokens[0] ?? "") === "env") {
		tokens.shift();
		while (tokens.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(tokens[0] ?? "")) tokens.shift();
	}
	if ((tokens[0] ?? "") === "timeout") {
		tokens.shift();
		if (/^\d+[smhd]?$/iu.test(tokens[0] ?? "")) tokens.shift();
	}
	return tokens;
}

function isExplicitPath(executable) {
	return executable.startsWith("/") || executable.startsWith("./") || executable.startsWith("../");
}

async function pathStatus(filePath, flag) {
	const proc = Bun.spawn(["test", flag, filePath], {
		stdout: "ignore",
		stderr: "ignore",
	});
	return (await proc.exited) === 0;
}

function requiresNodeDependencyRoot(material) {
	return /\bnode_modules\b/iu.test(material) && /\b(?:pnpm|npm|yarn|bun)\b/iu.test(material);
}

async function validationCommandScriptText(command) {
	const scriptPath = localValidationScriptPath(command);
	if (!scriptPath) return "";
	try {
		const file = Bun.file(scriptPath);
		if (file.size > 128_000) return "";
		return await file.text();
	} catch {
		return "";
	}
}

function localValidationScriptPath(command) {
	const tokens = commandInvocationTokens(command);
	const first = tokens[0] ?? "";
	const second = tokens[1] ?? "";
	const candidate = /^(?:bash|sh|zsh|bun|node)$/u.test(first) ? second : first;
	const unquoted = unquoteToken(candidate);
	if (!unquoted || unquoted.startsWith("-")) return "";
	if (unquoted.startsWith("./")) return unquoted;
	if (unquoted.startsWith("workflow-output/")) return unquoted;
	return "";
}

function unquoteToken(token) {
	return token.replace(/^['"]|['"]$/gu, "");
}

async function directoryExists(dirPath) {
	try {
		const glob = new Bun.Glob(dirPath);
		for await (const _match of glob.scan({ cwd: process.cwd(), onlyFiles: false })) return true;
		return false;
	} catch {
		return false;
	}
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

function boundedLines(text, limit) {
	const lines = text.split(/\r?\n/u);
	const kept = lines.slice(0, limit);
	if (lines.length > limit) kept.push(`[truncated ${lines.length - limit} additional lines]`);
	return kept.join("\n");
}

function runtimeFromTaskContract() {
	return {
		startedAtMs: Date.now(),
	};
}
