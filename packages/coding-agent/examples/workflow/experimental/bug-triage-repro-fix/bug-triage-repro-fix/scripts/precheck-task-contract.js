const taskText = await readRequiredTaskText();
const reproductionCommand = requiredCommand(taskText, "Reproduction Command");
const validationCommand = requiredCommand(taskText, "Validation Command");
validateShellCommand(reproductionCommand, "Reproduction Command");
validateShellCommand(validationCommand, "Validation Command");
const runtime = runtimeFromTaskContract(taskText);

await Bun.write(
	"workflow-output/bug-triage-precheck.md",
	[
		"# Bug Triage Precheck",
		"",
		"## Frozen Task",
		"",
		"```markdown",
		taskText,
		"```",
		"",
		"## Reproduction Command",
		"",
		"```text",
		reproductionCommand,
		"```",
		"",
		"## Validation Command",
		"",
		"```text",
		validationCommand,
		"```",
		"",
	].join("\n"),
);

return {
	summary: "validated bug triage task contract",
	statePatch: [
		{
			op: "set",
			path: "/task",
			value: {
				file: "task.md",
				taskText,
				reproductionCommand,
				validationCommand,
			},
		},
		{
			op: "set",
			path: "/runtime",
			value: runtime,
		},
	],
};

async function readRequiredTaskText() {
	let text = "";
	try {
		text = await Bun.file("task.md").text();
	} catch {
		throw new Error("bug-triage-repro-fix requires task.md in the project root");
	}
	if (!text.trim()) throw new Error("bug-triage-repro-fix task.md must not be empty");
	return text;
}

function requiredCommand(taskContract, label) {
	const command = commandField(taskContract, label);
	if (!command) throw new Error(`bug-triage-repro-fix task.md must declare ${label}`);
	return command;
}

function commandField(taskContract, label) {
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

function validateShellCommand(command, label) {
	if (/\\[nr]/u.test(command)) {
		throw new Error(
			`${label} must not contain escaped newline sequences; put multi-step reproduction logic in a project script and call that script from task.md`,
		);
	}
	if (/<<-?\s*['"]?[\w-]+/u.test(command)) {
		throw new Error(
			`${label} must not use shell here-documents; put multi-step reproduction logic in a project script and call that script from task.md`,
		);
	}
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
			`${label} must be a single-line command; put multi-step reproduction logic in a project script and call that script from task.md`,
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
