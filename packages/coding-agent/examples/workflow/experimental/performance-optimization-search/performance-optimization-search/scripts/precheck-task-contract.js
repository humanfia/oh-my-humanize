const taskText = await readRequiredTaskText();
const benchmarkCommand = requiredCommand(taskText, "Benchmark Command");
const validationCommand = requiredCommand(taskText, "Validation Command");
const baselineCommand = optionalCommand(taskText, "Baseline Command") || benchmarkCommand;
const scratchRoot = requiredScratchRoot(taskText);
const runtime = runtimeFromTaskContract(taskText);

await Bun.write(
	"workflow-output/performance-precheck.md",
	[
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
	].join("\n"),
);

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
