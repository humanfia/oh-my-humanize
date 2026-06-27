const task = workflowContext.state?.task;
const validationCommand = task?.validationCommand;
const securityCommand = task?.securityCommand;
if (typeof validationCommand !== "string" || validationCommand.trim() === "") {
	throw new Error("release-hardening requires /task.validationCommand before runReleaseChecks");
}
await assertTaskContractUnchanged(task);

const validation = await runShell(validationCommand, "release-validation");
const hasSecurityCommand = typeof securityCommand === "string" && securityCommand.trim() !== "";
const security = hasSecurityCommand ? await runShell(securityCommand, "release-security") : undefined;
const outputPath = "workflow-output/release-checks.md";
await Bun.write(outputPath, evidenceMarkdown(validationCommand, validation, securityCommand, security));

const validationPass = validation.exitCode === 0;
const securityStatus = security === undefined ? "skipped" : security.exitCode === 0 ? "pass" : "fail";
const securityPass = securityStatus !== "fail";

return {
	summary: `ran release checks; validation=${validationPass ? "pass" : "fail"} security=${securityStatus}`,
	data: { validation, security },
	statePatch: [
		{
			op: "set",
			path: "/checks",
			value: {
				validationCommand,
				validationExitCode: validation.exitCode,
				validationStdoutPath: validation.stdoutPath,
				validationStderrPath: validation.stderrPath,
				securityCommand,
				securityExitCode: security?.exitCode,
				securityStdoutPath: security?.stdoutPath,
				securityStderrPath: security?.stderrPath,
				securityStatus,
				status: validationPass && securityPass ? "pass" : "fail",
				outputPath,
			},
		},
	],
};

async function runShell(command, artifactPrefix) {
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
	const stdoutPath = `workflow-output/${artifactPrefix}-stdout.txt`;
	const stderrPath = `workflow-output/${artifactPrefix}-stderr.txt`;
	await Bun.write(stdoutPath, stdout);
	await Bun.write(stderrPath, stderr);
	return {
		exitCode,
		stdout: bounded(stdout),
		stderr: bounded(stderr),
		stdoutPath,
		stderrPath,
	};
}

async function assertTaskContractUnchanged(task) {
	const expected = task?.taskText;
	if (typeof expected !== "string" || expected.trim() === "") {
		throw new Error("release-hardening requires /task.taskText from precheck before runReleaseChecks");
	}
	const current = await Bun.file("task.md").text();
	if (current !== expected) {
		throw new Error(
			"task.md changed after release-hardening precheck; stop this attempt, inspect the task contract, then restart from a fresh freeze",
		);
	}
}

function evidenceMarkdown(validationCommand, validation, securityCommand, security) {
	const lines = [
		"# Release Check Evidence",
		"",
	];
	appendCommandEvidence(lines, "Validation", validationCommand, validation);
	if (securityCommand && security) {
		appendCommandEvidence(lines, "Security", securityCommand, security);
	} else {
		lines.push("## Security Command", "", "Security command: not declared", "");
	}
	return lines.join("\n");
}

function appendCommandEvidence(lines, label, command, result) {
	lines.push(
		`## ${label} Command`,
		"",
		"```sh",
		command,
		"```",
		"",
		`Exit code: ${result.exitCode}`,
		"",
		`### ${label} stdout`,
		"",
		`Raw artifact: \`${result.stdoutPath}\``,
		"",
		"```text",
		result.stdout || "(empty)",
		"```",
		"",
		`### ${label} stderr`,
		"",
		`Raw artifact: \`${result.stderrPath}\``,
		"",
		"```text",
		result.stderr || "(empty)",
		"```",
		"",
	);
}

function bounded(text) {
	const limit = 12000;
	if (text.length <= limit) return text;
	return `${text.slice(0, limit)}\n[truncated ${text.length - limit} bytes]`;
}
