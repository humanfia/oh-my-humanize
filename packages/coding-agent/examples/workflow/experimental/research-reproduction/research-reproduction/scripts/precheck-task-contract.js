const taskText = await readRequiredTaskText();
const claimSource = requiredField(taskText, "Claim Source");
const reproductionCommand = requiredCommand(taskText, "Reproduction Command");
const validationCommand = requiredCommand(taskText, "Validation Command");
const setupCommand = optionalCommand(taskText, "Setup Command");
const variantCommand = optionalCommand(taskText, "Variant Command");
const reproductionSignal = optionalTextField(taskText, "Reproduction Signal");
const variantSignal = optionalTextField(taskText, "Variant Signal");
const validationSignal = optionalTextField(taskText, "Validation Signal");
validateShellCommand(reproductionCommand, "Reproduction Command");
validateShellCommand(validationCommand, "Validation Command");
if (setupCommand) validateShellCommand(setupCommand, "Setup Command");
if (variantCommand) validateShellCommand(variantCommand, "Variant Command");
const runtime = runtimeFromTaskContract(taskText);

await Bun.write(
	"workflow-output/reproduction-precheck.md",
	[
		"# Research Reproduction Precheck",
		"",
		"## Claim Source",
		"",
		"```text",
		claimSource,
		"```",
		"",
		"## Reproduction Command",
		"",
		"```sh",
		reproductionCommand,
		"```",
		"",
		"## Validation Command",
		"",
		"```sh",
		validationCommand,
		"```",
		"",
		"## Setup Command",
		"",
		"```sh",
		setupCommand || "(not provided)",
		"```",
		"",
		"## Variant Command",
		"",
		"```sh",
		variantCommand || "(not provided)",
		"```",
		"",
		"## Declared Output Signals",
		"",
		`- Reproduction: ${reproductionSignal || "(not provided)"}`,
		`- Variant: ${variantSignal || "(not provided)"}`,
		`- Validation: ${validationSignal || "(not provided)"}`,
		"",
	].join("\n"),
);

return {
	summary: "validated research reproduction task contract",
	statePatch: [
		{
			op: "set",
			path: "/task",
			value: {
				file: "task.md",
				text: taskText,
				claimSource,
				reproductionCommand,
				validationCommand,
				setupCommand,
				variantCommand,
				reproductionSignal,
				variantSignal,
				validationSignal,
			},
		},
		{ op: "set", path: "/runtime", value: runtime },
		{
			op: "set",
			path: "/review",
			value: "No previous reproduction review yet.",
		},
	],
};

async function readRequiredTaskText() {
	try {
		const text = await Bun.file("task.md").text();
		if (!text.trim()) throw new Error("empty");
		return text;
	} catch {
		throw new Error("research-reproduction requires task.md in the project root");
	}
}

function requiredCommand(taskContract, label) {
	const command = optionalField(taskContract, label);
	if (!command) throw new Error(`research-reproduction task.md must declare ${label}`);
	return command;
}

function requiredField(taskContract, label) {
	const value = optionalTextField(taskContract, label);
	if (!value) throw new Error(`research-reproduction task.md must declare ${label}`);
	return value;
}

function validateShellCommand(command, label) {
	if (/\\[nr]/u.test(command)) {
		throw new Error(
			`${label} must not contain escaped newline sequences; put multi-step reproduction logic in a project script and call that script from task.md`,
		);
	}
}

function optionalCommand(taskContract, label) {
	return optionalField(taskContract, label);
}

function optionalTextField(taskContract, label) {
	const lines = taskContract.split(/\r?\n/u);
	const escaped = label.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
	const pattern = new RegExp(`^\\s*${escaped}\\s*:\\s*(.*)\\s*$`, "iu");
	for (let index = 0; index < lines.length; index += 1) {
		const match = pattern.exec(lines[index] ?? "");
		if (!match) continue;
		const inline = match[1]?.trim();
		if (inline) return inline;
		return followingTextBlock(lines, index + 1);
	}
	return "";
}

function optionalField(taskContract, label) {
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

function followingTextBlock(lines, startIndex) {
	const valueLines = [];
	let inFence = false;
	for (const line of lines.slice(startIndex)) {
		const trimmed = line.trim();
		if (!inFence && valueLines.length === 0 && !trimmed) continue;
		if (!inFence && trimmed && isTaskSectionHeading(trimmed)) break;
		if (trimmed.startsWith("```")) {
			inFence = !inFence;
			continue;
		}
		if (!inFence && !trimmed && valueLines.length > 0) {
			valueLines.push("");
			continue;
		}
		valueLines.push(inFence ? line.trimEnd() : trimmed);
	}
	return valueLines.join("\n").trim();
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
			`${label} must be a single-line command; put multi-line setup in a project script and call that script from task.md`,
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
