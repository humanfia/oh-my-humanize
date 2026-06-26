const state = workflowContext.state && typeof workflowContext.state === "object" ? workflowContext.state : {};
const validation = state.validation && typeof state.validation === "object" ? state.validation : {};

if (validation.status !== "pass") {
	throw new Error("cannot archive refactor migration flow before task-declared validation passes");
}

const archivePath = "workflow-output/refactor-migration-archive.md";
const taskText = await readOptionalText("task.md");
const validationText = await readOptionalText("workflow-output/refactor-migration-validation.md");
const rollbackText = await rollbackEvidenceText();
const materialProjectDiff = await projectMaterialDiff();
const outcome = materialProjectDiff.status === "empty" ? "rejected" : "accepted";

await Bun.write(
	archivePath,
	[
		"# Refactor Migration Archive",
		"",
		`Outcome: ${outcome}`,
		"",
		"## Materiality Gate",
		"",
		materialityMarkdown(materialProjectDiff),
		"",
		"## Task",
		"",
		boundedLines(taskText, 120),
		"",
		"## Validation",
		"",
		boundedLines(validationText, 160),
		"",
		"## Rollback",
		"",
		rollbackText.trim() ? boundedLines(rollbackText, 120) : "No rollback notes were present.",
		"",
	].join("\n"),
);

return {
	summary: `archived ${outcome} refactor migration evidence`,
	statePatch: [
		{
			op: "set",
			path: "/archive",
			value: {
				file: archivePath,
				status: outcome,
				validation: "pass",
				materialProjectDiff,
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

async function rollbackEvidenceText() {
	const sections = [];
	for (const filePath of [
		"workflow-output/refactor-migration-rollback.md",
		"workflow-output/caller-migration.md",
		"workflow-output/cleanup-dead-path.md",
	]) {
		const text = await readOptionalText(filePath);
		if (!text.trim()) continue;
		sections.push(["### ", filePath, "\n\n", boundedLines(text, 120)].join(""));
	}
	return sections.join("\n\n");
}

async function projectMaterialDiff() {
	const proc = Bun.spawn(
		[
			"git",
			"diff",
			"--ignore-blank-lines",
			"--ignore-space-change",
			"--",
			".",
			":(exclude)workflow-output/**",
			":(exclude)task.md",
			":(exclude)progress.md",
		],
		{
			cwd: process.cwd(),
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (exitCode !== 0) {
		return {
			status: "unknown",
			exitCode,
			stderr: bounded(stderr),
		};
	}
	const trimmed = stdout.trim();
	return {
		status: trimmed ? "present" : "empty",
		bytes: stdout.length,
		diffPreview: bounded(stdout, 4000),
	};
}

function materialityMarkdown(materialProjectDiff) {
	if (materialProjectDiff.status === "empty") {
		return "No material project diff remains after ignoring blank-line and whitespace-only churn.";
	}
	if (materialProjectDiff.status === "present") {
		return ["Material project diff detected:", "", "```diff", materialProjectDiff.diffPreview, "```"].join("\n");
	}
	return [
		"Material project diff could not be checked.",
		"",
		`Exit code: ${materialProjectDiff.exitCode}`,
		"",
		"```text",
		materialProjectDiff.stderr || "(empty stderr)",
		"```",
	].join("\n");
}

function boundedLines(text, limit) {
	const lines = text.split(/\r?\n/u);
	const kept = lines.slice(0, limit);
	if (lines.length > limit) kept.push(`[truncated ${lines.length - limit} additional lines]`);
	return kept.join("\n");
}

function bounded(text, limit = 12000) {
	if (text.length <= limit) return text;
	return `${text.slice(0, limit)}\n[truncated ${text.length - limit} bytes]`;
}
