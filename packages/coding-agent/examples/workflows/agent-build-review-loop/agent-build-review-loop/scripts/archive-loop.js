const archivePath = "workflow-output/final-agent-loop-archive.md";
const taskText = await readOptionalText("task.md");
const progressText = await readOptionalText("progress.md");
const verifyCommand = taskValidationCommand(taskText);
const verification = await runTaskVerification(verifyCommand);
const archive = [
	"# Agent Build/Review Loop Archive",
	"",
	"## Task",
	"",
	taskText.trim() ? boundedLines(taskText, 160) : "No task.md was present.",
	"",
	"## Progress",
	"",
	progressText.trim() ? boundedLines(progressText, 160) : "No progress.md was present.",
	"",
	"## Final Verification",
	"",
	"```text",
	verification.output,
	"```",
	"",
	"## Workspace Snapshot",
	"",
	"Workspace file listing is intentionally omitted from this portable flow script.",
	"Reviewers should inspect the current project diff and task contract directly.",
	"",
].join("\n");

await Bun.write(archivePath, archive);

if (verification.status !== "pass") {
	throw new Error("final task-declared verification did not pass");
}

return {
	summary: "archived completed agent build/review loop",
	statePatch: [
		{
			op: "set",
			path: "/archive",
			value: {
				file: archivePath,
				verification: "pass",
			},
		},
	],
};

async function readOptionalText(filePath) {
	try {
		return await Bun.file(filePath).text();
	} catch {
		return "";
	}
}

function taskValidationCommand(taskText) {
	for (const line of taskText.split(/\r?\n/u)) {
		const match = /^\s*(?:verify|verification command|validation command)\s*:\s*(.+)\s*$/iu.exec(line);
		if (match?.[1]) return match[1].trim();
	}
	return "";
}

async function runTaskVerification(command) {
	if (!command) {
		return {
			status: "not-specified",
			output: "No verification command declared in task.md.",
		};
	}
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
	const output = [stdout, stderr]
		.filter(text => text.trim().length > 0)
		.join("\n")
		.trim();
	return {
		status: exitCode === 0 ? "pass" : "fail",
		output: output || `verification command exited with code ${exitCode}`,
	};
}

function boundedLines(text, limit) {
	const lines = text.split(/\r?\n/u);
	const kept = lines.slice(0, limit);
	if (lines.length > limit) kept.push(`[truncated ${lines.length - limit} additional lines]`);
	return kept.join("\n");
}
