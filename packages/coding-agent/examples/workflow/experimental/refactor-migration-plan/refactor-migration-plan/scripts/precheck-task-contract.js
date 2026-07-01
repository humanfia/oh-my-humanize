const taskText = await readRequiredTaskText();
const validationCommand = requiredCommand(taskText, "Validation Command");
const compatibilityCommand = optionalCommand(taskText, "Compatibility Command");
validateShellCommand(validationCommand, "Validation Command");
if (compatibilityCommand) validateShellCommand(compatibilityCommand, "Compatibility Command");
const runtime = runtimeFromTaskContract(taskText);
const compatibilityPreflight = compatibilityCommand
	? await runPreflightShell(compatibilityCommand, "Compatibility Command")
	: undefined;
const validationPreflight = await runPreflightShell(validationCommand, "Validation Command");
const preflightResults = [compatibilityPreflight, validationPreflight].filter(Boolean);
const preflightCleanup = preflightResults.flatMap(result => result.cleanup);
const preflightSideEffects = preflightResults.flatMap(result => result.sideEffects);

await Bun.write(
	"workflow-output/refactor-migration-precheck.md",
	[
		"# Refactor Migration Precheck",
		"",
		"## Validation Command",
		"",
		"```text",
		validationCommand,
		"```",
		"",
		"## Compatibility Command",
		"",
		"```text",
		compatibilityCommand || "(not declared)",
		"```",
		"",
		"## Compatibility Preflight",
		"",
		compatibilityPreflight
			? commandEvidenceMarkdown(compatibilityCommand, compatibilityPreflight)
			: "(not declared)",
		"",
		"## Validation Preflight",
		"",
		commandEvidenceMarkdown(validationCommand, validationPreflight),
		"",
		"## Preflight Workspace Cleanup",
		"",
		preflightCleanupMarkdown(preflightCleanup, preflightSideEffects),
		"",
	].join("\n"),
);

if (compatibilityPreflight !== undefined && compatibilityPreflight.exitCode !== 0) {
	throw new Error(
		`compatibility command failed preflight with exit code ${compatibilityPreflight.exitCode}`,
	);
}
if (validationPreflight.exitCode !== 0) {
	throw new Error(`validation command failed preflight with exit code ${validationPreflight.exitCode}`);
}
if (preflightSideEffects.length > 0) {
	throw new Error(`preflight command modified tracked workspace files: ${preflightSideEffects.join(", ")}`);
}

return {
	summary: "validated refactor migration task contract",
	statePatch: [
		{
			op: "set",
			path: "/task",
			value: {
				file: "task.md",
				text: taskText,
				validationCommand,
				compatibilityCommand,
				compatibilityPreflight,
				validationPreflight,
				preflightByproducts: preflightCleanup.map(entry => entry.path),
				preflightCleanup,
			},
		},
		{
			op: "set",
			path: "/runtime",
			value: runtime,
		},
		{
			op: "set",
			path: "/review",
			value: "No previous migration review yet.",
		},
		{
			op: "set",
			path: "/validation",
			value: {
				status: "not-run",
				summary: "Validation preflight passed; no migration validation has run after edits yet.",
				compatibilityPreflightExitCode: compatibilityPreflight?.exitCode,
				validationPreflightExitCode: validationPreflight.exitCode,
			},
		},
	],
};

async function readRequiredTaskText() {
	let text = "";
	try {
		text = await Bun.file("task.md").text();
	} catch {
		throw new Error("refactor-migration-plan requires task.md in the project root");
	}
	if (!text.trim()) throw new Error("refactor-migration-plan task.md must not be empty");
	return text;
}

function requiredCommand(taskContract, label) {
	const command = optionalCommand(taskContract, label);
	if (!command) throw new Error(`refactor-migration-plan task.md must declare ${label}`);
	return command;
}

function validateShellCommand(command, label) {
	if (/\\[nr]/u.test(command)) {
		throw new Error(
			`${label} must not contain escaped newline sequences; put multi-step validation logic in a project script and call that script from task.md`,
		);
	}
	if (/<<-?\s*['"]?[\w-]+/u.test(command)) {
		throw new Error(
			`${label} must not use shell here-documents; put multi-step validation logic in a project script and call that script from task.md`,
		);
	}
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
		return followingSingleLineCommand(lines, index + 1, label);
	}
	return "";
}

function followingSingleLineCommand(lines, startIndex, label) {
	const commandLines = [];
	let inFence = false;
	for (const line of lines.slice(startIndex)) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		if (trimmed.startsWith("```")) {
			if (inFence) break;
			inFence = true;
			continue;
		}
		if (!inFence && isTaskSectionHeading(trimmed)) break;
		commandLines.push(trimmed);
	}
	if (commandLines.length > 1) {
		throw new Error(
			`${label} must be a single-line command; put multi-step validation logic in a project script and call that script from task.md`,
		);
	}
	return commandLines[0] ?? "";
}

function isTaskSectionHeading(line) {
	return line.startsWith("#") || /^[A-Za-z][A-Za-z0-9 /()_-]{0,80}:\s*(?:\S.*)?$/u.test(line);
}

function runtimeFromTaskContract() {
	return {
		startedAtMs: Date.now(),
	};
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

async function runPreflightShell(command, label) {
	const before = await gitStatusEntries();
	const result = await runShell(command);
	const cleanup = await cleanNewUntrackedByproducts(before, label);
	const sideEffects = await newTrackedSideEffects(before);
	return {
		...result,
		cleanup,
		sideEffects,
	};
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

async function cleanNewUntrackedByproducts(before, label) {
	const after = await gitStatusEntries();
	const beforeKeys = new Set(before.map(entry => statusEntryKey(entry)));
	const byproducts = after.filter(entry => {
		if (entry.status !== "??") return false;
		if (beforeKeys.has(statusEntryKey(entry))) return false;
		return shouldCleanPreflightByproduct(entry.path);
	});
	if (byproducts.length === 0) return [];
	const paths = byproducts.map(entry => entry.path);
	const clean = Bun.spawn(["git", "clean", "-ffd", "--", ...paths], {
		cwd: process.cwd(),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(clean.stdout).text(),
		new Response(clean.stderr).text(),
		clean.exited,
	]);
	if (exitCode !== 0) {
		throw new Error(`failed to clean preflight byproducts: ${stderr.trim() || stdout.trim()}`);
	}
	return paths.map(path => ({ path, label }));
}

async function newTrackedSideEffects(before) {
	const after = await gitStatusEntries();
	const beforeKeys = new Set(before.map(entry => statusEntryKey(entry)));
	return after
		.filter(entry => entry.status !== "??" && !beforeKeys.has(statusEntryKey(entry)))
		.map(entry => `${entry.status} ${entry.path}`);
}

async function gitStatusEntries() {
	const proc = Bun.spawn(["git", "status", "--porcelain=v1", "-z", "--untracked-files=all"], {
		cwd: process.cwd(),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (exitCode !== 0) throw new Error(`git status failed during refactor migration precheck: ${stderr || stdout}`);
	const entries = [];
	for (const raw of stdout.split("\0")) {
		if (!raw) continue;
		const status = raw.slice(0, 2);
		const path = raw.slice(3);
		if (path) entries.push({ status, path });
	}
	return entries;
}

function statusEntryKey(entry) {
	return `${entry.status}\0${entry.path}`;
}

function shouldCleanPreflightByproduct(path) {
	return (
		!path.startsWith("workflow-output/") &&
		!path.startsWith("transcripts/") &&
		path !== "task.md" &&
		path !== "manifest-entry.json" &&
		path !== "monitor-assignment.json" &&
		path !== "progress.md"
	);
}

function preflightCleanupMarkdown(cleanup, sideEffects) {
	const lines = [];
	if (cleanup.length === 0) {
		lines.push("- No untracked preflight byproducts needed cleanup.");
	} else {
		for (const entry of cleanup) {
			lines.push(`- removed untracked preflight byproduct \`${entry.path}\` after ${entry.label}`);
		}
	}
	if (sideEffects.length > 0) {
		lines.push("", "Tracked side effects:", ...sideEffects.map(effect => `- ${effect}`));
	}
	return lines.join("\n");
}

function bounded(text) {
	const limit = 12000;
	if (text.length <= limit) return text;
	return `${text.slice(0, limit)}\n[truncated ${text.length - limit} bytes]`;
}
