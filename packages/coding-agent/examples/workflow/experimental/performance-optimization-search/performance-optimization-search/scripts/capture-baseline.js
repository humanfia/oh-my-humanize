const task = workflowContext.state?.task;
const command = task?.baselineCommand || task?.benchmarkCommand;
if (typeof command !== "string" || command.trim() === "") {
	throw new Error("performance-optimization-search requires /task.baselineCommand before captureBaseline");
}

const result = await runShell(command);
const outputPath = "workflow-output/performance-baseline.md";
const failureDiagnostic = commandFailureDiagnostic(result);
await Bun.write(outputPath, evidenceMarkdown("Baseline", command, result, failureDiagnostic));

if (result.exitCode !== 0) {
	throw new Error(
		`baseline command failed with exit code ${result.exitCode}; evidence written to ${outputPath}; fix the task environment or command before planning optimizations`,
	);
}
if (failureDiagnostic) {
	throw new Error(
		`baseline command produced a fatal diagnostic despite exit code 0: ${failureDiagnostic}; evidence written to ${outputPath}; fix the task command before planning optimizations`,
	);
}

const sharedProjectFilesBeforeBranches = await changedProjectFiles();

return {
	summary: `captured performance baseline; exit=${result.exitCode}`,
	data: result,
	statePatch: [
		{
			op: "set",
			path: "/baseline",
			value: {
				command,
				exitCode: result.exitCode,
				failureDiagnostic,
				outputPath,
				status: result.exitCode === 0 && !failureDiagnostic ? "pass" : "fail",
			},
		},
		{
			op: "set",
			path: "/runtime/sharedProjectFilesBeforeBranches",
			value: sharedProjectFilesBeforeBranches,
		},
	],
};

async function changedProjectFiles() {
	const proc = Bun.spawn(["git", "status", "--porcelain=v1", "--untracked-files=all"], {
		cwd: process.cwd(),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (exitCode !== 0) {
		throw new Error(`git status failed after performance baseline: ${stderr.trim() || stdout.trim()}`);
	}
	return stdout
		.split(/\r?\n/u)
		.map((line) => statusPath(line))
		.filter((filePath) => filePath && !isAllowedWorkflowMetadataPath(filePath))
		.sort();
}

function statusPath(line) {
	if (line.length < 4) return "";
	const rawPath = line.slice(3).trim();
	const renamePath = rawPath.includes(" -> ") ? rawPath.split(" -> ").at(-1)?.trim() : rawPath;
	return unquoteStatusPath(renamePath ?? "");
}

function unquoteStatusPath(filePath) {
	if (!filePath.startsWith("\"") || !filePath.endsWith("\"")) return filePath;
	try {
		return JSON.parse(filePath);
	} catch {
		return filePath.slice(1, -1);
	}
}

function isAllowedWorkflowMetadataPath(filePath) {
	return (
		filePath.startsWith("workflow-output/") ||
		filePath === "task.md" ||
		filePath === "manifest-entry.json" ||
		filePath === "monitor-assignment.json" ||
		filePath === "progress.md"
	);
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

function evidenceMarkdown(label, command, result, failureDiagnostic) {
	const lines = [
		`# Performance ${label} Evidence`,
		"",
		"## Command",
		"",
		"```sh",
		command,
		"```",
		"",
		`Exit code: ${result.exitCode}`,
		"",
		"## Stdout",
		"",
		"```text",
		result.stdout || "(empty)",
		"```",
		"",
		"## Stderr",
		"",
		"```text",
		result.stderr || "(empty)",
		"```",
		"",
	];
	if (failureDiagnostic) {
		lines.push("## Fatal Command Diagnostic", "", failureDiagnostic, "");
	}
	return lines.join("\n");
}

function bounded(text) {
	const limit = 12000;
	if (text.length <= limit) return text;
	return `${text.slice(0, limit)}\n[truncated ${text.length - limit} bytes]`;
}

function commandFailureDiagnostic(result) {
	const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
	if (!output) return "benchmark command produced no output";
	const text = `${result.stderr ?? ""}\n${result.stdout ?? ""}`;
	for (const line of text.split(/\r?\n/u)) {
		const diagnostic = line.trim();
		if (!diagnostic) continue;
		if (isFatalCommandDiagnostic(diagnostic)) return diagnostic;
	}
	if (!hasNumericMeasurement(output)) return "benchmark command produced no numeric measurement";
	return "";
}

function hasNumericMeasurement(output) {
	return /\d/u.test(output);
}

function isFatalCommandDiagnostic(line) {
	return (
		/\b(?:command not found|no such file or directory|not a directory|is not a directory|permission denied)\b/iu.test(
			line,
		) ||
		/\b(?:unknown|unrecognized|invalid)\s+(?:option|flag|argument|parameter)\b/iu.test(line) ||
		/^usage:\s+/iu.test(line) ||
		/\bhere-document\b/iu.test(line) ||
		/\b(?:traceback \(most recent call last\)|syntaxerror|modulenotfounderror|importerror)\b/u.test(line)
	);
}
