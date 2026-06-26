const task = workflowContext.state?.task;
const validationCommand = task?.validationCommand;
const securityCommand = task?.securityCommand;
if (typeof validationCommand !== "string" || validationCommand.trim() === "") {
	throw new Error("release-hardening requires /task.validationCommand before runReleaseChecks");
}
await assertTaskContractUnchanged(task);

const validation = await runShell(validationCommand);
const hasSecurityCommand = typeof securityCommand === "string" && securityCommand.trim() !== "";
const security = hasSecurityCommand ? await runShell(securityCommand) : undefined;
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
				securityCommand,
				securityExitCode: security?.exitCode,
				securityStatus,
				status: validationPass && securityPass ? "pass" : "fail",
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
		"## Validation Command",
		"",
		"```sh",
		validationCommand,
		"```",
		"",
		`Exit code: ${validation.exitCode}`,
		"",
		"```text",
		validation.stdout || validation.stderr || "(empty)",
		"```",
		"",
	];
	if (securityCommand && security) {
		lines.push(
			"## Security Command",
			"",
			"```sh",
			securityCommand,
			"```",
			"",
			`Exit code: ${security.exitCode}`,
			"",
			"```text",
			security.stdout || security.stderr || "(empty)",
			"```",
			"",
		);
	} else {
		lines.push("## Security Command", "", "Security command: not declared", "");
	}
	return lines.join("\n");
}

function bounded(text) {
	const limit = 12000;
	if (text.length <= limit) return text;
	return `${text.slice(0, limit)}\n[truncated ${text.length - limit} bytes]`;
}
