const task = workflowContext.state?.task;
const command = task?.setupCommand;
const outputPath = "workflow-output/reproduction-setup.md";

if (typeof command !== "string" || command.trim() === "") {
	await Bun.write(outputPath, "# Reproduction Setup\n\nNo Setup Command was declared.\n");
	return {
		summary: "setup skipped; no command declared",
		statePatch: [{ op: "set", path: "/setup", value: { status: "skipped", command: "", outputPath } }],
	};
}

const result = await runShell(command);
await Bun.write(outputPath, evidenceMarkdown("Setup", command, result));

return {
	summary: `setup ${result.exitCode === 0 ? "pass" : "fail"}`,
	data: result,
	statePatch: [{ op: "set", path: "/setup", value: stateValue(command, result, outputPath) }],
};

async function runShell(command) {
	const proc = Bun.spawn(["sh", "-c", command], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { exitCode, stdout: bounded(stdout), stderr: bounded(stderr) };
}

function stateValue(command, result, outputPath) {
	return {
		status: result.exitCode === 0 ? "pass" : "fail",
		command,
		exitCode: result.exitCode,
		stdout: result.stdout,
		stderr: result.stderr,
		outputPath,
	};
}

function evidenceMarkdown(label, command, result) {
	return [`# ${label}`, "", "```sh", command, "```", "", `Exit code: ${result.exitCode}`, "", "```text", result.stdout || result.stderr || "(empty)", "```", ""].join("\n");
}

function bounded(text) {
	const limit = 12000;
	if (text.length <= limit) return text;
	return `${text.slice(0, limit)}\n[truncated ${text.length - limit} bytes]`;
}
