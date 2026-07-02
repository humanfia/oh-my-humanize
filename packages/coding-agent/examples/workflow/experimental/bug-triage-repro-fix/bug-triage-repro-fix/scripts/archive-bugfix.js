const state = workflowContext.state && typeof workflowContext.state === "object" ? workflowContext.state : {};
const task = state.task && typeof state.task === "object" ? state.task : {};
const cause = state.cause && typeof state.cause === "object" ? state.cause : {};
const regression = state.regression && typeof state.regression === "object" ? state.regression : {};

if (regression.status !== "pass") {
	throw new Error("cannot archive bug triage flow before task-declared validation passes");
}

const changedFiles = await gitDiffHeadChangedFiles();
const workspaceChangedFiles = await gitStatusChangedFiles();
const allowedScopes = allowedPathsFromTask(typeof task.taskText === "string" ? task.taskText : typeof task.text === "string" ? task.text : "");
const outsideAllowedChangedFiles = allowedScopes.length > 0
	? workspaceChangedFiles.filter((file) => !isAllowedPath(file, allowedScopes))
	: [];
if (outsideAllowedChangedFiles.length > 0) {
	const blockers = outsideAllowedChangedFiles.map((filePath) => `${filePath} changed outside task allowed paths`);
	throw new Error(
		`cannot archive bug triage flow because ${blockers.join("; ")}`,
	);
}
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

async function gitStatusChangedFiles() {
	const proc = Bun.spawn(["git", "status", "--short", "--untracked-files=all"], {
		cwd: process.cwd(),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (exitCode !== 0) throw new Error(`git status failed before bug triage archive: ${stderr.trim() || stdout.trim()}`);
	return stdout
		.split(/\r?\n/u)
		.map(statusLinePath)
		.filter(Boolean);
}

function statusLinePath(line) {
	const trimmed = line.trimEnd();
	if (!trimmed) return "";
	const renamed = /^R.\s+.+\s+->\s+(.+)$/u.exec(trimmed);
	if (renamed) return normalizePath(renamed[1] ?? "");
	return normalizePath(trimmed.slice(3).trim());
}

function allowedPathsFromTask(taskText) {
	const lines = taskText.split(/\r?\n/u);
	const entries = [];
	for (let index = 0; index < lines.length; index += 1) {
		const trimmed = lines[index]?.trim() ?? "";
		const match = /^(?:[-*]\s*)?(?:allowed paths?|scope fence)\s*:\s*(.*)$/iu.exec(trimmed);
		if (!match) continue;
		for (const rawEntry of splitAllowedPathEntries(match[1] ?? "")) {
			const normalized = normalizeAllowedPath(rawEntry);
			if (normalized) entries.push(normalized);
		}
		for (const continuation of allowedPathContinuationLines(lines, index + 1)) {
			for (const rawEntry of splitAllowedPathEntries(continuation)) {
				const normalized = normalizeAllowedPath(rawEntry);
				if (normalized) entries.push(normalized);
			}
		}
		break;
	}
	return [...new Set(entries)];
}

function allowedPathContinuationLines(lines, startIndex) {
	const continuation = [];
	for (const line of lines.slice(startIndex)) {
		const trimmed = line.trim();
		if (!trimmed) break;
		if (/^(?:[-*]\s*)?(?:allowed paths?|scope fence)\s*:/iu.test(trimmed)) return [];
		if (isTaskSectionHeading(trimmed)) break;
		continuation.push(trimmed);
	}
	return continuation;
}

function splitAllowedPathEntries(text) {
	return text
		.replace(/^(?:and\s+)?allowed paths?\s+(?:are|is)\s+/iu, "")
		.replace(/\bdo not edit\b.*$/iu, "")
		.split(/[,;]/u)
		.map(entry => entry.trim())
		.filter(Boolean);
}

function normalizeAllowedPath(entry) {
	const cleaned = entry
		.replace(/^(?:and|or)\s+/iu, "")
		.replace(/\s+if present$/iu, "")
		.replace(/\s*\.$/u, "")
		.replace(/^`|`$/gu, "")
		.trim();
	if (!cleaned) return "";
	return normalizePath(cleaned);
}

function isAllowedPath(filePath, allowedScopes) {
	const normalized = normalizePath(filePath);
	if (!normalized) return false;
	return allowedScopes.some(scope => matchesAllowedScope(normalized, scope));
}

function matchesAllowedScope(filePath, scope) {
	if (scope === filePath) return true;
	if (scope.endsWith("/**")) {
		const prefix = scope.slice(0, -2);
		return filePath.startsWith(prefix);
	}
	if (scope.endsWith("/")) return filePath.startsWith(scope);
	if (!scope.includes("*")) return false;
	const escaped = scope.replace(/[.+?^${}()|[\]\\]/gu, "\\$&").replace(/\*/gu, ".*");
	return new RegExp(`^${escaped}$`, "u").test(filePath);
}

function normalizePath(filePath) {
	return filePath.replaceAll("\\", "/").replace(/^\.\/+/u, "").replace(/\/+/gu, "/").trim();
}

function isTaskSectionHeading(line) {
	return line.startsWith("#") || /^[A-Z][A-Za-z /-]{0,80}:\s*$/u.test(line);
}

function allowsNoCodeResolution(task) {
	const taskText = typeof task.taskText === "string" ? task.taskText : typeof task.text === "string" ? task.text : "";
	return [
		/\bNo-Code Resolution\s*:\s*allowed\b/iu,
		/\bNo-Code(?:\s*\/\s*No-Change)?\s+Allowed\s*:\s*(?:yes|true|allowed)\b/iu,
	].some(pattern => pattern.test(taskText));
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
	if (!/\b(isolateCause|cause evidence|cause finding|cause handoff|fix boundary|defect boundary|proposed defect)\b/iu.test(text)) return false;
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
