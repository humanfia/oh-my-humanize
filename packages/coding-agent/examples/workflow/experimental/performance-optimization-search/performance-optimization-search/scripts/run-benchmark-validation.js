const task = workflowContext.state?.task;
const benchmarkCommand = task?.benchmarkCommand;
const validationCommand = task?.validationCommand;
if (typeof benchmarkCommand !== "string" || benchmarkCommand.trim() === "") {
	throw new Error("performance-optimization-search requires /task.benchmarkCommand before benchmarkCandidates");
}
if (typeof validationCommand !== "string" || validationCommand.trim() === "") {
	throw new Error("performance-optimization-search requires /task.validationCommand before benchmarkCandidates");
}

const projectChangedFiles = await gitDiffHeadChangedFiles();
if (projectChangedFiles.length > 0) {
	const outputPath = "workflow-output/performance-benchmark.md";
	await Bun.write(outputPath, isolationViolationMarkdown(projectChangedFiles));
	return {
		summary: `parallel lane isolation violation: ${projectChangedFiles.length} shared project file(s) changed`,
		data: { isolationViolation: true, projectChangedFiles },
		statePatch: [
			{
				op: "set",
				path: "/benchmark",
				value: {
					status: "fail",
					isolationViolation: true,
					projectChangedFiles,
					benchmarkCommand,
					validationCommand,
					outputPath,
				},
			},
		],
	};
}

const benchmark = await runShell(benchmarkCommand);
const validation = await runShell(validationCommand);
const outputPath = "workflow-output/performance-benchmark.md";
await Bun.write(outputPath, evidenceMarkdown(benchmarkCommand, benchmark, validationCommand, validation));

return {
	summary: `benchmark=${benchmark.exitCode === 0 ? "pass" : "fail"} validation=${
		validation.exitCode === 0 ? "pass" : "fail"
	}`,
	data: { benchmark, validation },
	statePatch: [
		{
			op: "set",
			path: "/benchmark",
			value: {
				benchmarkCommand,
				benchmarkExitCode: benchmark.exitCode,
				validationCommand,
				validationExitCode: validation.exitCode,
				status: benchmark.exitCode === 0 && validation.exitCode === 0 ? "pass" : "fail",
				outputPath,
			},
		},
	],
};

async function gitDiffHeadChangedFiles() {
	const proc = Bun.spawn(["git", "diff", "HEAD", "--name-only"], {
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
		throw new Error(`git diff HEAD failed before performance benchmark join: ${stderr.trim() || stdout.trim()}`);
	}
	return stdout
		.split(/\r?\n/u)
		.map((line) => line.trim())
		.filter((line) => line && !line.startsWith("workflow-output/") && line !== "task.md");
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

function evidenceMarkdown(benchmarkCommand, benchmark, validationCommand, validation) {
	return [
		"# Performance Benchmark Evidence",
		"",
		"## Benchmark Command",
		"",
		"```sh",
		benchmarkCommand,
		"```",
		"",
		`Exit code: ${benchmark.exitCode}`,
		"",
		"```text",
		benchmark.stdout || benchmark.stderr || "(empty)",
		"```",
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
	].join("\n");
}

function isolationViolationMarkdown(projectChangedFiles) {
	return [
		"# Performance Benchmark Evidence",
		"",
		"## Parallel Lane Isolation Violation",
		"",
		"Parallel optimization lanes must leave no project-file edits in the shared workspace before the join.",
		"Candidate patches and measurements belong in lane-local scratch workspaces or patch artifacts; the selection repair node may apply at most one candidate after the branches join.",
		"",
		"## Shared Project Changes",
		"",
		projectChangedFiles.map((file) => `- ${file}`).join("\n"),
		"",
	].join("\n");
}

function bounded(text) {
	const limit = 12000;
	if (text.length <= limit) return text;
	return `${text.slice(0, limit)}\n[truncated ${text.length - limit} bytes]`;
}
