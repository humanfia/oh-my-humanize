const progressPath = "progress.md";
const snapshotPath = "workflow-output/initial-loop-snapshot.md";

if (!(await fileExists(progressPath))) {
	await Bun.write(progressPath, "# Agent Build/Review Progress\n\n");
}

const taskText = await readRequiredTaskText();
const verifyCommand = requiredTaskValidationCommand(taskText);
const verification = await runTaskVerification(verifyCommand);
const snapshot = [
	"# Initial Loop Snapshot",
	"",
	"## Task",
	"",
	boundedLines(taskText, 120),
	"",
	"## Workspace Snapshot",
	"",
	"Workspace file listing is intentionally omitted from this portable flow script.",
	"Agents and reviewers should inspect the current project diff and task contract directly.",
	"",
	"## Initial Verification Result",
	"",
	"```text",
	verification.output,
	"```",
	"",
].join("\n");

await Bun.write(snapshotPath, snapshot);

return {
	summary: `initialized agent build/review loop with task-declared verification (${verification.status})`,
	statePatch: [
		{
			op: "set",
			path: "/progress",
			value: {
				file: progressPath,
				snapshot: snapshotPath,
				verification: verification.status,
			},
		},
	],
};

async function fileExists(filePath) {
	try {
		await Bun.file(filePath).text();
		return true;
	} catch {
		return false;
	}
}

async function readOptionalText(filePath) {
	try {
		return await Bun.file(filePath).text();
	} catch {
		return "";
	}
}

async function readRequiredTaskText() {
	const taskText = await readOptionalText("task.md");
	if (!taskText.trim()) {
		throw new Error("agent-build-review-loop requires a task.md contract in the project root");
	}
	return taskText;
}

function requiredTaskValidationCommand(taskText) {
	for (const line of taskText.split(/\r?\n/u)) {
		const match = /^\s*(?:verify|verification command|validation command)\s*:\s*(.+)\s*$/iu.exec(line);
		if (match?.[1]) return match[1].trim();
	}
	throw new Error("agent-build-review-loop task.md must declare a Validation Command");
}

async function runTaskVerification(command) {
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
