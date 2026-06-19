const taskText = await readRequiredTaskText();
const tupleId = await tupleIdFromRunArtifacts();
const validationCommand = validationCommandFromTask(taskText);
const validationEnvironment = validationEnvironmentFromTask(taskText);
const manualEvidenceAllowed = hasHeadingOrField(taskText, "manual evidence allowed");

if (!validationCommand) {
	if (manualEvidenceAllowed) {
		const artifact = await writeValidationArtifact({
			tupleId,
			validationCommand: "",
			validationEnvironment,
			result: "manual",
			exitCode: 0,
			stdout: "Manual Evidence Allowed was declared; no validation command was run.\n",
			stderr: "",
		});
		return {
			summary: "manual evidence allowed; declared validation command not required",
			verdict: "PASS",
			data: artifact,
			statePatch: [{ op: "set", path: "/declaredValidation", value: artifact }],
		};
	}
	throw new Error("parallel-implementation-review task.md must declare a Validation Command");
}

assertSafeValidationCommand(validationCommand);
await ensureDeclaredTempDirectories(validationEnvironment);

const child = Bun.spawn(["bash", "-lc", validationCommand], {
	cwd: process.cwd(),
	env: { ...process.env, ...validationEnvironment },
	stdout: "pipe",
	stderr: "pipe",
});
const [stdout, stderr, exitCode] = await Promise.all([
	new Response(child.stdout).text(),
	new Response(child.stderr).text(),
	child.exited,
]);
const result = exitCode === 0 ? "passed" : "failed";
const artifact = await writeValidationArtifact({
	tupleId,
	validationCommand,
	validationEnvironment,
	result,
	exitCode,
	stdout,
	stderr,
});

if (exitCode !== 0) {
	throw new Error(`declared validation command failed with exit code ${exitCode}; see ${artifact.stdoutArtifact} and ${artifact.stderrArtifact}`);
}

return {
	summary: `declared validation passed: ${validationCommand}`,
	verdict: "PASS",
	data: artifact,
	statePatch: [{ op: "set", path: "/declaredValidation", value: artifact }],
};

async function writeValidationArtifact({ tupleId, validationCommand, validationEnvironment, result, exitCode, stdout, stderr }) {
	const suffix = tupleId ? `-${tupleId}` : "";
	const stdoutArtifact = `workflow-output/validation${suffix}.stdout`;
	const stderrArtifact = `workflow-output/validation${suffix}.stderr`;
	const artifactPath = `workflow-output/validation${suffix}.json`;
	await Bun.write(stdoutArtifact, stdout);
	await Bun.write(stderrArtifact, stderr);
	const artifact = {
		tuple_id: tupleId,
		artifact: artifactPath,
		producer_node: "runDeclaredValidation",
		producer_kind: "workflow-script",
		validation: {
			command: validationCommand,
			environment: validationEnvironment,
			result,
			status: result,
			exitCode,
			stdoutArtifact,
			stderrArtifact,
		},
		checked_at_ms: Date.now(),
	};
	await Bun.write(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
	return artifact;
}

async function readRequiredTaskText() {
	try {
		const text = await Bun.file("task.md").text();
		if (text.trim()) return text;
	} catch {
		// Fall through to the explicit contract error below.
	}
	throw new Error("parallel-implementation-review requires a task.md contract in the project root");
}

async function tupleIdFromRunArtifacts() {
	const monitorTuple = await tupleIdFromJsonFile("monitor-assignment.json");
	if (monitorTuple) return monitorTuple;
	const manifestTuple = await tupleIdFromJsonFile("manifest-entry.json");
	if (manifestTuple) return manifestTuple;
	const taskTuple = /(?:tuple|monitor)[^A-Za-z0-9]+([A-Z][0-9]{2}-T[0-9]{2}(?:-[A-Za-z0-9]+)?)/u.exec(taskText);
	if (taskTuple?.[1]) return taskTuple[1];
	return "";
}

async function tupleIdFromJsonFile(filePath) {
	try {
		const data = await Bun.file(filePath).json();
		const candidate = stringField(data, "tupleId") || stringField(data, "tuple_id");
		return candidate.trim();
	} catch {
		return "";
	}
}

function stringField(value, key) {
	if (!value || typeof value !== "object") return "";
	const field = value[key];
	return typeof field === "string" ? field : "";
}

function validationCommandFromTask(text) {
	const lines = text.split(/\r?\n/u);
	for (let index = 0; index < lines.length; index += 1) {
		const match = /^\s*(?:verify|verification command|validation command)\s*:\s*(.*)\s*$/iu.exec(lines[index] ?? "");
		if (!match) continue;
		const inlineCommand = match[1]?.trim();
		if (inlineCommand) return inlineCommand;
		const followingCommand = firstFollowingCommandLine(lines, index + 1);
		if (followingCommand) return followingCommand;
	}
	return "";
}

function validationEnvironmentFromTask(text) {
	const lines = text.split(/\r?\n/u);
	for (let index = 0; index < lines.length; index += 1) {
		const match = /^\s*(?:validation environment|verification environment|verify environment)\s*:\s*(.*)\s*$/iu.exec(lines[index] ?? "");
		if (!match) continue;
		const inlineValue = match[1]?.trim();
		const entries = inlineValue ? [inlineValue] : followingEnvironmentLines(lines, index + 1);
		return Object.fromEntries(
			entries
				.flatMap(entry => entry.split(/\s+/u))
				.map(entry => /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(entry))
				.filter(Boolean)
				.map(matchResult => [matchResult[1] ?? "", matchResult[2] ?? ""]),
		);
	}
	return {};
}

function followingEnvironmentLines(lines, startIndex) {
	const entries = [];
	for (const line of lines.slice(startIndex)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("```")) continue;
		if (isTaskSectionHeading(trimmed)) break;
		entries.push(trimmed.replace(/^[-*]\s+/u, ""));
	}
	return entries;
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

function hasHeadingOrField(text, label) {
	const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const pattern = new RegExp(`(^|\\n)\\s*(?:#+\\s*)?${escaped}\\s*:`, "iu");
	const headingPattern = new RegExp(`(^|\\n)\\s*#+\\s*${escaped}\\s*$`, "iu");
	return pattern.test(text) || headingPattern.test(text);
}

function assertSafeValidationCommand(command) {
	const normalized = command.toLowerCase();
	if (/\b(sleep|watch|tail\s+-f|yes)\b/u.test(normalized)) {
		throw new Error("parallel-implementation-review validation command cannot be a wait/watch/sleep command");
	}
	const timeoutMatch = /\btimeout\s+(\d+)([smhd]?)\b/u.exec(normalized);
	if (!timeoutMatch) return;
	const value = Number(timeoutMatch[1]);
	const unit = timeoutMatch[2] || "s";
	const seconds = unit === "d" ? value * 86400 : unit === "h" ? value * 3600 : unit === "m" ? value * 60 : value;
	if (seconds > 3600) {
		throw new Error("parallel-implementation-review validation command timeout must be 1 hour or less");
	}
}

async function ensureDeclaredTempDirectories(environment) {
	for (const [key, value] of Object.entries(environment)) {
		if (!/^(TMPDIR|TMP|TEMP)$/u.test(key)) continue;
		if (typeof value !== "string" || !value.trim()) continue;
		await Bun.write(`${value}/.omh-validation-tmp`, "");
	}
}
