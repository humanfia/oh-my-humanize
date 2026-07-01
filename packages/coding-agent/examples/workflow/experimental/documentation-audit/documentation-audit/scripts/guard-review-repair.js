const state = workflowContext.state && typeof workflowContext.state === "object" ? workflowContext.state : {};
const audit = state.audit && typeof state.audit === "object" ? state.audit : {};
const review = state.review;
const patch = state.patch && typeof state.patch === "object" ? state.patch : {};
const priorFeedback = priorReviewFeedback(review);
const resolvedReviewFeedback = resolvedReviewFeedbackFromPatch(patch);
const patchProjectFiles = patchChangedFiles(patch).filter(isProjectChangedFile);
const selectedAuditTargets = selectedAuditProjectTargets(audit);
const missingSelectedAuditTargets = missingProjectChangedFiles(selectedAuditTargets, patchProjectFiles);
const missingPatchFiles = missingProjectChangedFiles(await projectChangedFilesFromStatus(), patchProjectFiles);

if (patchStatus(patch) === "blocked") {
	throw new Error("documentation patch reported blocked before validation; reviewer must continue or operator must change task/flow");
}

if (priorFeedback && resolvedReviewFeedback.length === 0) {
	throw new Error(
		[
			"documentation patch did not resolve prior reviewer feedback",
			`prior feedback: ${truncateText(priorFeedback, 600)}`,
			"patch must include resolved_review_feedback evidence before validation can run",
		].join("; "),
	);
}

if (missingSelectedAuditTargets.length > 0) {
	throw new Error(
		[
			"documentation patch did not cover selected audit targets",
			`missing targets: ${missingSelectedAuditTargets.join(", ")}`,
			"patch changed_files must cover selected project targets from /audit.selectedSmallestCoherentRepair.changedFileTargets or return blocked",
		].join("; "),
	);
}

if (missingPatchFiles.length > 0) {
	throw new Error(
		[
			"documentation patch evidence omitted changed project files",
			`missing files: ${missingPatchFiles.join(", ")}`,
			"patch changed_files must cover tracked and untracked project files from git status --short --untracked-files=all",
		].join("; "),
	);
}

const artifactPath = "workflow-output/documentation-review-repair.md";
await Bun.write(
	artifactPath,
	[
		"# Documentation Review Repair Guard",
		"",
		`priorFeedbackRequired: ${priorFeedback ? "yes" : "no"}`,
		"",
		"## Resolved Review Feedback",
		"",
		resolvedReviewFeedback.length > 0
			? resolvedReviewFeedback.map(item => `- ${item}`).join("\n")
			: "No prior continue review required explicit repair evidence.",
		"",
		"## Patch Changed Files Coverage",
		"",
		"Patch changed_files covers all tracked and untracked project files reported by git status.",
		"",
		"## Selected Audit Target Coverage",
		"",
		selectedAuditTargets.length > 0
			? selectedAuditTargets.map(item => `- ${item}`).join("\n")
			: "The consolidated audit did not declare selected project targets.",
		"",
	].join("\n"),
);

return {
	summary: priorFeedback
		? "prior review feedback has explicit patch resolution evidence"
		: "no prior continue review feedback requires repair evidence",
	statePatch: [
		{
			op: "set",
			path: "/reviewRepair",
			value: {
				status: "pass",
				file: artifactPath,
				priorFeedbackRequired: Boolean(priorFeedback),
				resolvedReviewFeedback,
				changedFilesCovered: true,
				selectedAuditTargets,
				selectedAuditTargetsCovered: true,
			},
		},
	],
};

function patchStatus(value) {
	const status = value.status ?? value.result;
	if (typeof status !== "string") return "";
	return status.trim().toLowerCase();
}

function priorReviewFeedback(value) {
	if (typeof value !== "string") return "";
	const text = value.trim();
	if (!text) return "";
	if (/^no previous documentation review yet\.?$/iu.test(text)) return "";
	if (/\bcontinue\b/iu.test(text)) return text;
	if (/\b(missing|stale|too broad|not validated|fails to address|restore|regression|unresolved)\b/iu.test(text)) {
		return text;
	}
	return "";
}

function resolvedReviewFeedbackFromPatch(value) {
	const field = value.resolved_review_feedback ?? value.resolvedReviewFeedback;
	if (Array.isArray(field)) return field.map(reviewFeedbackItemText).filter(Boolean);
	if (typeof field === "string" && field.trim()) return [field.trim()];
	return [];
}

function patchChangedFiles(value) {
	const field = value.changed_files ?? value.changedFiles;
	if (!Array.isArray(field)) return [];
	return field.filter(item => typeof item === "string").map(normalizeProjectPath).filter(Boolean);
}

function selectedAuditProjectTargets(value) {
	const repairCandidates = [
		value.selectedSmallestCoherentRepair,
		value.selected_smallest_coherent_repair,
		value.selectedRepair,
		value.selected_repair,
	];
	const targets = [
		...pathArrayField(value, "changedFileTargets"),
		...pathArrayField(value, "changed_file_targets"),
		...pathArrayField(value, "selectedTargets"),
		...pathArrayField(value, "selected_targets"),
		...repairCandidates.flatMap(repair => [
			...pathArrayField(repair, "changedFileTargets"),
			...pathArrayField(repair, "changed_file_targets"),
			...pathArrayField(repair, "selectedTargets"),
			...pathArrayField(repair, "selected_targets"),
		]),
	];
	return uniqueProjectPaths(targets.map(normalizeProjectPath).filter(isProjectChangedFile));
}

function pathArrayField(value, key) {
	if (!value || typeof value !== "object") return [];
	const field = value[key];
	if (!Array.isArray(field)) return [];
	return field.map(pathFromTargetEntry).filter(Boolean);
}

function pathFromTargetEntry(item) {
	if (typeof item === "string") return item;
	if (!item || typeof item !== "object") return "";
	for (const key of ["file", "path", "target"]) {
		const value = item[key];
		if (typeof value === "string") return value;
	}
	return "";
}

function uniqueProjectPaths(paths) {
	return [...new Set(paths)].sort((left, right) => left.localeCompare(right, "en"));
}

function missingProjectChangedFiles(actualFiles, patchFiles) {
	const patchSet = new Set(patchFiles);
	return actualFiles.filter(file => !patchSet.has(file));
}

async function projectChangedFilesFromStatus() {
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
	if (exitCode !== 0) throw new Error(`git status failed: ${stderr.trim() || stdout.trim()}`);
	return stdout
		.split(/\r?\n/u)
		.map(statusLineToPath)
		.filter(Boolean)
		.filter(isProjectChangedFile)
		.sort((left, right) => left.localeCompare(right, "en"));
}

function statusLineToPath(line) {
	const trimmed = line.trim();
	if (!trimmed) return "";
	const rename = /^R[ MDA?]?\s+(.+?)\s+->\s+(.+)$/u.exec(trimmed);
	if (rename) return normalizeProjectPath(rename[2] ?? "");
	return normalizeProjectPath(trimmed.slice(2));
}

function normalizeProjectPath(filePath) {
	const normalized = filePath.trim().replace(/^"|"$/gu, "").replace(/^\.\//u, "").replace(/\\/gu, "/");
	return normalized === "/" ? normalized : normalized.replace(/\/+$/u, "");
}

function isProjectChangedFile(filePath) {
	if (!filePath) return false;
	return !(
		filePath === "task.md" ||
		filePath === "progress.md" ||
		filePath === "manifest-entry.json" ||
		filePath === "monitor-assignment.json" ||
		/^monitor-assignment(?:-[^/]+)?\.json$/u.test(filePath) ||
		filePath === "evidence-ledger.jsonl" ||
		filePath.startsWith("workflow-output/") ||
		filePath.startsWith("transcripts/") ||
		ignoredProjectArtifactPath(filePath)
	);
}

function ignoredProjectArtifactPath(filePath) {
	const ignoredSegments = new Set([".venv", "node_modules", ".pytest_cache", ".mypy_cache", ".ruff_cache", "__pycache__"]);
	return normalizeProjectPath(filePath)
		.split("/")
		.some(segment => ignoredSegments.has(segment));
}

function reviewFeedbackItemText(item) {
	if (typeof item === "string") return item.trim();
	if (!item || typeof item !== "object") return "";
	const feedback = typeof item.feedback === "string" ? item.feedback.trim() : "";
	const evidence = typeof item.evidence === "string" ? item.evidence.trim() : "";
	if (feedback && evidence) return `${feedback} — ${evidence}`;
	return feedback || evidence;
}

function truncateText(text, maxLength) {
	if (text.length <= maxLength) return text;
	return `${text.slice(0, Math.max(0, maxLength - 64))}...[truncated ${text.length - maxLength} chars]`;
}
