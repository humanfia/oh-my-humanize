const taskText = await readRequiredTaskText();
const validationCommand = requiredCommand(taskText, "Validation Command");
const compatibilityCommand = optionalCommand(taskText, "Compatibility Command");
validateShellCommand(validationCommand, "Validation Command");
if (compatibilityCommand) validateShellCommand(compatibilityCommand, "Compatibility Command");
const runtime = runtimeFromTaskContract(taskText);
const compatibilityPreflight = compatibilityCommand ? await runShell(compatibilityCommand) : undefined;
const validationPreflight = await runShell(validationCommand);

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
	return line.startsWith("#") || /^[A-Z][A-Za-z /-]{0,80}:\s*$/u.test(line);
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

function bounded(text) {
	const limit = 12000;
	if (text.length <= limit) return text;
	return `${text.slice(0, limit)}\n[truncated ${text.length - limit} bytes]`;
}
