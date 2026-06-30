const task = workflowContext.state?.task;
const validationCommand = task?.validationCommand;
const docsCommand = task?.docsCommand;

if (typeof validationCommand !== "string" || validationCommand.trim() === "") {
	throw new Error("documentation-audit requires /task.validationCommand before runDocsValidation");
}

const docs = typeof docsCommand === "string" && docsCommand.trim() !== "" ? await runShell(docsCommand) : undefined;
const validation = await runShell(validationCommand);
const outputPath = "workflow-output/documentation-validation.md";
const docsStdoutPath = docs ? "workflow-output/docs-stdout.txt" : undefined;
const docsStderrPath = docs ? "workflow-output/docs-stderr.txt" : undefined;
const validationStdoutPath = "workflow-output/validation-stdout.txt";
const validationStderrPath = "workflow-output/validation-stderr.txt";
if (docs && docsStdoutPath && docsStderrPath) {
	await Bun.write(docsStdoutPath, docs.stdout);
	await Bun.write(docsStderrPath, docs.stderr);
}
await Bun.write(validationStdoutPath, validation.stdout);
await Bun.write(validationStderrPath, validation.stderr);
await Bun.write(
	outputPath,
	evidenceMarkdown(docsCommand, docs, validationCommand, validation, {
		docsStdoutPath,
		docsStderrPath,
		validationStdoutPath,
		validationStderrPath,
	}),
);

const docsPass = docs === undefined || docs.exitCode === 0;
const validationPass = validation.exitCode === 0;
const startFailure = commandStartFailure(docs, "docs") ?? commandStartFailure(validation, "validation");
if (startFailure !== undefined) {
	throw new Error(`fail_closed_validation_unstartable: ${startFailure}`);
}

return {
	summary: `documentation validation docs=${docsPass ? "pass" : "fail"} validation=${
		validationPass ? "pass" : "fail"
	}`,
	data: { docs, validation },
	statePatch: [
		{
			op: "set",
			path: "/validation",
			value: {
				docsCommand,
				docsExitCode: docs?.exitCode,
				validationCommand,
				validationExitCode: validation.exitCode,
				docsStdoutPath,
				docsStderrPath,
				validationStdoutPath,
				validationStderrPath,
				status: docsPass && validationPass ? "pass" : "fail",
				outputPath,
			},
		},
	],
};

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

function evidenceMarkdown(docsCommand, docs, validationCommand, validation, paths) {
	const lines = ["# Documentation Validation Evidence", ""];
	if (docsCommand && docs) {
		lines.push(
			"## Docs Command",
			"",
			"```sh",
			docsCommand,
			"```",
			"",
			`Exit code: ${docs.exitCode}`,
			"",
			`Stdout artifact: ${paths.docsStdoutPath}`,
			`Stderr artifact: ${paths.docsStderrPath}`,
			"",
			"### Stdout",
			"",
			"```text",
			docs.stdout || "(empty)",
			"```",
			"",
			"### Stderr",
			"",
			"```text",
			docs.stderr || "(empty)",
			"```",
			"",
		);
	}
	lines.push(
		"## Validation Command",
		"",
		"```sh",
		validationCommand,
		"```",
		"",
		`Exit code: ${validation.exitCode}`,
		"",
		`Stdout artifact: ${paths.validationStdoutPath}`,
		`Stderr artifact: ${paths.validationStderrPath}`,
		"",
		"### Stdout",
		"",
		"```text",
		validation.stdout || "(empty)",
		"```",
		"",
		"### Stderr",
		"",
		"```text",
		validation.stderr || "(empty)",
		"```",
		"",
	);
	return lines.join("\n");
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
