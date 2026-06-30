const task = workflowContext.state?.task;
const validationCommand = task?.validationCommand;
const docsCommand = task?.docsCommand;

if (typeof validationCommand !== "string" || validationCommand.trim() === "") {
	throw new Error("documentation-audit requires /task.validationCommand before checkValidationStartup");
}

const docs = typeof docsCommand === "string" && docsCommand.trim() !== "" ? await runShell(docsCommand) : undefined;
const validation = await runShell(validationCommand);
const outputPath = "workflow-output/documentation-validation-startup.md";
await Bun.write(outputPath, evidenceMarkdown(docsCommand, docs, validationCommand, validation));

const startFailure = commandStartFailure(docs, "docs") ?? commandStartFailure(validation, "validation");
if (startFailure !== undefined) {
	throw new Error(`fail_closed_validation_unstartable: ${startFailure}`);
}

const docsPass = docs === undefined || docs.exitCode === 0;
const validationPass = validation.exitCode === 0;
const status = docsPass && validationPass ? "startable-pass" : "startable-command-failed";

return {
	summary: `documentation validation startup ${status}`,
	data: { docs, validation },
	statePatch: [
		{
			op: "set",
			path: "/validationStartup",
			value: {
				status,
				docsCommand,
				docsExitCode: docs?.exitCode,
				validationCommand,
				validationExitCode: validation.exitCode,
				outputPath,
			},
		},
	],
};

async function runShell(command) {
	const proc = Bun.spawn(["sh", "-c", command], {
		cwd: process.cwd(),
		env: process.env,
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

function evidenceMarkdown(docsCommand, docs, validationCommand, validation) {
	const lines = ["# Documentation Validation Startup Evidence", ""];
	if (docsCommand && docs) {
		pushCommandEvidence(lines, "Docs Command", docsCommand, docs);
	}
	pushCommandEvidence(lines, "Validation Command", validationCommand, validation);
	return lines.join("\n");
}

function pushCommandEvidence(lines, title, command, result) {
	lines.push(
		`## ${title}`,
		"",
		"```sh",
		command,
		"```",
		"",
		`Exit code: ${result.exitCode}`,
		"",
		"### Stdout",
		"",
		"```text",
		result.stdout || "(empty)",
		"```",
		"",
		"### Stderr",
		"",
		"```text",
		result.stderr || "(empty)",
		"```",
		"",
	);
}

function commandStartFailure(result, label) {
	if (result === undefined) return undefined;
	const stderr = result.stderr || "";
	const stdout = result.stdout || "";
	if (result.exitCode !== 126 && result.exitCode !== 127) return undefined;
	const combined = `${stderr}\n${stdout}`.trim();
	if (!/not found|command not found|No such file|cannot execute|permission denied/u.test(combined)) {
		return undefined;
	}
	return `${label} command could not start (exit ${result.exitCode}): ${combined || "(no output)"}`;
}

function bounded(text) {
	const limit = 12000;
	if (text.length <= limit) return text;
	return `${text.slice(0, limit)}\n[truncated ${text.length - limit} bytes]`;
}
