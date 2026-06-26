const state = workflowContext.state && typeof workflowContext.state === "object" ? workflowContext.state : {};
const task = state.task && typeof state.task === "object" ? state.task : {};
const cause = state.cause && typeof state.cause === "object" ? state.cause : {};
const regression = state.regression && typeof state.regression === "object" ? state.regression : {};

if (regression.status !== "pass") {
	throw new Error("cannot archive bug triage flow before task-declared validation passes");
}

const changedFiles = await gitDiffHeadChangedFiles();
const projectChangedFiles = changedFiles.filter((file) => !file.startsWith("workflow-output/") && file !== "task.md");
const noCodeArchive = projectChangedFiles.length === 0;
if (noCodeArchive) {
	if (!allowsNoCodeResolution(task)) {
		throw new Error(
			"cannot archive bug triage flow without project changes; add `No-Code Resolution: allowed` to task.md only for evidence-only investigations",
		);
	}
	const noBugRootCauseText = await readOptionalText("workflow-output/no-bug-root-cause.md");
	if (causeProposesFix(cause) && !hasCauseReconciliation(noBugRootCauseText)) {
		throw new Error(
			"cannot archive no-code bug triage while cause evidence proposes a defect or fix boundary without an explicit `Cause Reconciliation` section in workflow-output/no-bug-root-cause.md",
		);
	}
}

const archivePath = "workflow-output/bugfix-archive.md";
const taskText = await readOptionalText("task.md");
const rollbackText = await readOptionalText("workflow-output/bugfix-rollback.md");
const reproductionText = await readOptionalText("workflow-output/reproduction.md");
const regressionText = await readOptionalText("workflow-output/regression.md");
const noBugRootCauseText = await readOptionalText("workflow-output/no-bug-root-cause.md");

await Bun.write(
	archivePath,
	[
		"# Bug Triage Repro Fix Archive",
		"",
		"## Task",
		"",
		boundedLines(taskText, 120),
		"",
		"## Reproduction",
		"",
		boundedLines(reproductionText, 160),
		"",
		"## Regression",
		"",
		boundedLines(regressionText, 160),
		"",
		...(noBugRootCauseText.trim()
			? ["## No-Code Root-Cause Analysis", "", boundedLines(noBugRootCauseText, 160), ""]
			: []),
		"## Project Changes",
		"",
		projectChangedFiles.length > 0 ? projectChangedFiles.map((file) => `- ${file}`).join("\n") : "No project changes.",
		"",
		"## Rollback",
		"",
		rollbackText.trim() ? boundedLines(rollbackText, 120) : "No rollback notes were present.",
		"",
	].join("\n"),
);

return {
	summary: "archived bug triage repro/fix evidence",
	statePatch: [
		{
			op: "set",
			path: "/archive",
			value: {
				file: archivePath,
				validation: "pass",
				projectChangedFiles,
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
	if (exitCode !== 0) throw new Error(`git diff HEAD failed: ${stderr.trim() || stdout.trim()}`);
	return stdout
		.split(/\r?\n/u)
		.map((line) => line.trim())
		.filter(Boolean);
}

function allowsNoCodeResolution(task) {
	const taskText = typeof task.taskText === "string" ? task.taskText : typeof task.text === "string" ? task.text : "";
	return /\bNo-Code Resolution\s*:\s*allowed\b/iu.test(taskText);
}

function causeProposesFix(value) {
	if (hasNonEmptyEvidenceField(value, ["narrowest_fix_boundary", "fix_boundary", "fixBoundary", "recommended_fix", "recommendedFix", "patch_plan", "patchPlan"])) {
		return true;
	}
	return /\b(narrowest\s+fix\s+boundary|recommended\s+fix|proposed\s+fix|patch\s+only|add\s+narrow\s+tests|should\s+patch|needs\s+patch)\b/iu.test(
		evidenceText(value),
	);
}

function hasNonEmptyEvidenceField(value, keys) {
	if (value === undefined || value === null) return false;
	if (Array.isArray(value)) return value.some((entry) => hasNonEmptyEvidenceField(entry, keys));
	if (typeof value !== "object") return false;
	for (const [key, entry] of Object.entries(value)) {
		if (keys.includes(key) && evidenceText(entry).trim()) return true;
		if (hasNonEmptyEvidenceField(entry, keys)) return true;
	}
	return false;
}

function hasCauseReconciliation(text) {
	if (!/(^|\n)#{1,3}\s+Cause Reconciliation\b/iu.test(text)) return false;
	if (!/\b(isolateCause|cause evidence|cause finding|fix boundary)\b/iu.test(text)) return false;
	return /\b(reconcile|reconciled|resolved|refute|refuted|reject|rejected|invalidated|false positive|not a defect)\b/iu.test(
		text,
	);
}

function evidenceText(value) {
	if (value === undefined || value === null) return "";
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (Array.isArray(value)) return value.map(evidenceText).join("\n");
	if (typeof value !== "object") return "";
	return Object.entries(value)
		.map(([key, entry]) => `${key}: ${evidenceText(entry)}`)
		.join("\n");
}

async function readOptionalText(filePath) {
	try {
		return await Bun.file(filePath).text();
	} catch {
		return "";
	}
}

function boundedLines(text, limit) {
	const lines = text.split(/\r?\n/u);
	const kept = lines.slice(0, limit);
	if (lines.length > limit) kept.push(`[truncated ${lines.length - limit} additional lines]`);
	return kept.join("\n");
}
