const state = workflowContext.state && typeof workflowContext.state === "object" ? workflowContext.state : {};
const audit = state.audit && typeof state.audit === "object" ? state.audit : {};
const review = state.review;
const patch = state.patch && typeof state.patch === "object" ? state.patch : {};
const priorFeedback = priorReviewFeedback(review);
const resolvedReviewFeedback = resolvedReviewFeedbackFromPatch(patch);
const patchProjectFiles = patchChangedFiles(patch).filter(isProjectChangedFile);
const selectedAuditTargets = selectedAuditProjectTargets(audit);
const actionableLaneFindings = actionableFindingsFromDigest(state.auditDigest);
const missingSelectedAuditTargets = missingProjectChangedFiles(selectedAuditTargets, patchProjectFiles);
const missingPatchFiles = missingProjectChangedFiles(await projectChangedFilesFromStatus(), patchProjectFiles);

if (actionableLaneFindings.length > 0 && auditSelectsNoPatch(audit)) {
	throw new Error(
		[
			"consolidated documentation audit selected no-patch despite actionable lane findings",
			`findings: ${actionableLaneFindings.slice(0, 6).join("; ")}`,
			"consolidation must either select changed-file targets, mark the item blocked, or carry it into reviewer feedback",
		].join("; "),
	);
}

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
			"patch changed_files must cover selected project targets from /audit.selectedRepairPlan.changedFileTargets, /audit.selectedSmallestCoherentRepair.changedFileTargets, or return blocked",
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
		value.selectedRepairPlan,
		value.selected_repair_plan,
		value.selectedSmallestCoherentRepair,
		value.selected_smallest_coherent_repair,
		value.selectedRepair,
		value.selected_repair,
		...arrayField(value, "selectedRepairTargets"),
		...arrayField(value, "selected_repair_targets"),
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

function arrayField(value, key) {
	if (!value || typeof value !== "object") return [];
	const field = value[key];
	return Array.isArray(field) ? field : [];
}

function actionableFindingsFromDigest(value) {
	if (!value || typeof value !== "object") return [];
	const findings = [];
	for (const [sectionName, section] of Object.entries(value)) {
		if (sectionName === "inventory") continue;
		const text = digestSectionText(section);
		if (!text) continue;
		for (const signal of actionableSignals(text)) {
			findings.push(`${sectionName}: ${signal}`);
		}
	}
	return uniqueStrings(findings);
}

function digestSectionText(value) {
	if (value === undefined || value === null) return "";
	if (typeof value === "string") return value;
	if (typeof value !== "object") return String(value);
	return [value.excerpt, value.summary, value.status, value.verdict, value.finding, stableEvidenceString(value)]
		.filter(item => typeof item === "string" && item.trim())
		.join("\n");
}

function stableEvidenceString(value) {
	try {
		return JSON.stringify(value);
	} catch {
		return "";
	}
}

function actionableSignals(text) {
	const normalized = text.toLowerCase();
	const signals = [];
	if (/\bactionable_missing_contract\b/u.test(normalized)) signals.push("actionable_missing_contract");
	if (/\bdocs_gap_patch_recommended\b/u.test(normalized)) signals.push("docs_gap_patch_recommended");
	if (/\bpatch[_\s-]?recommended\b/u.test(normalized)) signals.push("patch_recommended");
	if (/\brepair[_\s-]?needed\b[^a-z0-9]{0,12}(?:true|yes)\b/u.test(normalized)) signals.push("repair_needed");
	if (/\bpatch[_\s-]?required\b[^a-z0-9]{0,12}(?:true|yes)\b/u.test(normalized)) signals.push("patch_required");
	return uniqueStrings(signals);
}

function auditSelectsNoPatch(value) {
	const text = stableEvidenceString(value).toLowerCase();
	if (!text) return false;
	const explicitNoPatch =
		/\bcomplete[_\s-]?no[_\s-]?patch[_\s-]?recommended\b/u.test(text) ||
		/\baccept[_\s-]?no[_\s-]?patch\b/u.test(text) ||
		/\bno[_\s-]?code[_\s-]?no[_\s-]?change\b/u.test(text) ||
		/\bno[_\s-]?patch\b/u.test(text);
	const noTargets = selectedAuditProjectTargets(value).length === 0;
	const patchRejected =
		/"patchrequired"\s*:\s*false/u.test(normalizedJsonKeyText(text)) ||
		/"patch_required"\s*:\s*false/u.test(text);
	return explicitNoPatch || (noTargets && patchRejected);
}

function normalizedJsonKeyText(text) {
	return text.replaceAll(/"([a-z0-9_]+)"\s*:/gu, (_match, key) => `"${key.replaceAll("_", "")}":`);
}

function uniqueStrings(values) {
	return [...new Set(values.filter(Boolean))];
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
