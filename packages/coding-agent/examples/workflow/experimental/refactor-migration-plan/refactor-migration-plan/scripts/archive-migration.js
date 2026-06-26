const state = workflowContext.state && typeof workflowContext.state === "object" ? workflowContext.state : {};
const validation = state.validation && typeof state.validation === "object" ? state.validation : {};

if (validation.status !== "pass") {
	throw new Error("cannot archive refactor migration flow before task-declared validation passes");
}

const archivePath = "workflow-output/refactor-migration-archive.md";
const taskText = await readOptionalText("task.md");
const validationText = await readOptionalText("workflow-output/refactor-migration-validation.md");
const rollbackEvidenceEntries = await rollbackEvidenceSources();
const rollbackText = rollbackEvidenceText(rollbackEvidenceEntries);
const materialProjectDiff = await projectMaterialDiff();
const outcome = materialProjectDiff.status === "empty" ? "rejected" : "accepted";
const rollbackEvidenceFiles = rollbackEvidenceEntries
	.filter(entry => entry.kind === "file")
	.map(entry => entry.source);
const rollbackEvidenceSourceLabels = rollbackEvidenceEntries.map(entry => entry.source);

if (outcome === "accepted" && rollbackEvidenceEntries.length === 0) {
	throw new Error("cannot archive accepted refactor migration without rollback evidence");
}

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
				rollbackEvidenceFiles,
				rollbackEvidenceSources: rollbackEvidenceSourceLabels,
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

function rollbackEvidenceText(entries) {
	const sections = [];
	for (const entry of entries) {
		sections.push(["### ", entry.source, "\n\n", boundedLines(entry.text, 120)].join(""));
	}
	return sections.join("\n\n");
}

async function rollbackEvidenceSources() {
	const entries = [];
	const paths = [
		"workflow-output/refactor-migration-rollback.md",
		"workflow-output/compatibility-design.md",
		"workflow-output/compatibility-design.json",
		"workflow-output/caller-migration.md",
		"workflow-output/migrateCallers.json",
		"workflow-output/migration-caller-step.json",
		"workflow-output/cleanup-dead-path.md",
		"workflow-output/cleanup-dead-path.json",
		"workflow-output/cleanupDeadPath.json",
		"workflow-output/refactor-migration-cleanup.md",
	];
	for (const filePath of paths) {
		const text = await readOptionalText(filePath);
		if (!hasRollbackEvidence(text)) continue;
		entries.push({ kind: "file", source: filePath, text });
	}
	for (const filePath of await runtimeArtifactEvidencePaths()) {
		if (paths.includes(filePath)) continue;
		const text = await readOptionalText(filePath);
		if (!hasRollbackEvidence(text)) continue;
		entries.push({ kind: "file", source: filePath, text });
	}
	for (const entry of stateRollbackEvidenceSources()) {
		if (!hasRollbackEvidence(entry.text)) continue;
		entries.push(entry);
	}
	return dedupeEvidenceEntries(entries);
}

async function runtimeArtifactEvidencePaths() {
	const matches = [];
	const glob = new Bun.Glob("workflow-output/omh-runtime/artifacts/**/*");
	for await (const match of glob.scan({ cwd: process.cwd(), dot: true, onlyFiles: true })) {
		if (!/\.(?:md|json)$/iu.test(match)) continue;
		matches.push(match);
	}
	return matches.sort();
}

function stateRollbackEvidenceSources() {
	const sources = [];
	for (const key of ["compatibility", "migration", "cleanup", "review"]) {
		const value = state[key];
		const text = evidenceTextFromStateValue(value);
		if (!text.trim()) continue;
		sources.push({ kind: "state", source: `state:/${key}`, text });
	}
	return sources;
}

function evidenceTextFromStateValue(value) {
	if (typeof value === "string") return value;
	if (value === null || typeof value !== "object") return "";
	return JSON.stringify(value, null, 2);
}

function dedupeEvidenceEntries(entries) {
	const seen = new Set();
	const deduped = [];
	for (const entry of entries) {
		if (seen.has(entry.source)) continue;
		seen.add(entry.source);
		deduped.push(entry);
	}
	return deduped;
}

function hasRollbackEvidence(text) {
	if (declaresRollbackEvidenceUnavailable(text)) return false;
	const parsed = parseJsonEvidence(text);
	if (parsed !== undefined) return hasStructuredRollbackEvidence(parsed);
	return hasMarkdownRollbackEvidence(text);
}

function declaresRollbackEvidenceUnavailable(text) {
	const normalized = text.replace(/\s+/gu, " ").toLowerCase();
	return (
		normalized.includes("no actionable rollback instruction") ||
		normalized.includes("no live actionable rollback evidence") ||
		normalized.includes("rollback-evidence acceptance must remain blocked") ||
		normalized.includes("archive acceptance must remain blocked") ||
		normalized.includes("acceptance must remain blocked until live actionable rollback evidence")
	);
}

function parseJsonEvidence(text) {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function hasStructuredRollbackEvidence(value) {
	if (Array.isArray(value)) {
		return value.some(item => hasStructuredRollbackEvidence(item));
	}
	if (value === null || typeof value !== "object") return false;
	for (const [key, child] of Object.entries(value)) {
		if (isRollbackEvidenceKey(key) && hasActionableRollbackValue(child)) return true;
		if (hasStructuredRollbackEvidence(child)) return true;
	}
	return false;
}

function isRollbackEvidenceKey(key) {
	return /^(?:rollback|rollbackPath|rollback[_-]?path|rollback[_-]?notes?|rollback[_-]?note)$/iu.test(key);
}

function hasActionableRollbackValue(value) {
	if (typeof value === "string") return value.trim().length > 0;
	if (Array.isArray(value)) return value.some(item => hasActionableRollbackValue(item));
	if (value === null || typeof value !== "object") return false;
	return Object.values(value).some(child => hasActionableRollbackValue(child));
}

function hasMarkdownRollbackEvidence(text) {
	return text.split(/\r?\n/u).some(line =>
		/^\s*(?:[-*]\s*)?(?:#{1,6}\s*)?(?:rollback(?:[_ -]?notes?)?|rollback[_ -]?path)\s*[:=-]\s*\S/iu.test(
			line,
		),
	);
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
