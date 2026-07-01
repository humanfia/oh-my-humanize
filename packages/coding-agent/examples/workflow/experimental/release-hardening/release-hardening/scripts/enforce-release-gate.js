const state = workflowContext.state && typeof workflowContext.state === "object" ? workflowContext.state : {};
const checks = state.checks && typeof state.checks === "object" ? state.checks : {};
const outputPath = "workflow-output/release-gate.md";
const reviewVerdict = String(state.review ?? "");
const holdingForFreshContract = reviewVerdict === "hold";

const auditText = await readOptionalText("workflow-output/release-audit.md");
const rollbackText = await readOptionalText("workflow-output/release-rollback.md");
const taskText = await taskContractText(state.task);
const workspaceGuard = await workspaceCleanlinessGuard(taskText);
const blockers = [
	...auditBlockers(state.changelog, "changelog"),
	...auditBlockers(state.compatibility, "compatibility"),
];
const resolvedBlockers = blockers.filter(blocker => auditResolvesBlocker(auditText, blocker));
const unresolvedBlockers = blockers.filter(blocker => !auditResolvesBlocker(auditText, blocker));
const failures = [];

if (reviewVerdict !== "finish" && !holdingForFreshContract) {
	failures.push(`release reviewer verdict is not finish or hold: ${reviewVerdict || "(missing)"}`);
}
if (checks.status !== "pass" && !holdingForFreshContract) {
	failures.push(`declared checks did not pass: ${String(checks.status ?? "(missing)")}`);
}
if (!auditText.trim()) {
	failures.push("missing workflow-output/release-audit.md");
}
if (!rollbackText.trim()) {
	failures.push("missing workflow-output/release-rollback.md");
}
for (const blocker of workspaceGuard.blockers) {
	failures.push(`workspace cleanliness blocker: ${blocker}`);
}
for (const blocker of unresolvedBlockers) {
	failures.push(`unresolved audit blocker from ${blocker.source}: ${blocker.text}`);
}
const holdReasons = holdingForFreshContract
	? [
			`release reviewer requested fresh task contract: ${reviewVerdict}`,
			...(checks.status === "pass" ? [] : [`declared checks did not pass: ${String(checks.status ?? "(missing)")}`]),
			...failures,
		]
	: [];
const status = holdingForFreshContract ? "hold" : failures.length === 0 ? "pass" : "fail_closed";

await Bun.write(
	outputPath,
	gateMarkdown({ checks, failures, blockers, resolvedBlockers, unresolvedBlockers, status, holdReasons }),
);

if (failures.length > 0 && !holdingForFreshContract) {
	throw new Error(`release gate fail-closed: ${failures[0]}`);
}

return {
	summary: holdingForFreshContract ? "release gate held for fresh task contract" : "release gate passed",
	data: { status, unresolvedBlockers, holdReasons },
	statePatch: [
		{
			op: "set",
			path: "/releaseGate",
			value: {
				status,
				outcome: holdingForFreshContract ? "rejected" : "accepted",
				outputPath,
				blockerCount: blockers.length,
				resolvedBlockers,
				unresolvedBlockers,
				holdReasons,
				workspaceGuard,
			},
		},
	],
};

function auditBlockers(value, source) {
	const texts = flattenEvidence(value).filter(isBlockingEvidence);
	return texts.map(text => ({ source, text: concise(text) }));
}

function flattenEvidence(value) {
	if (value === undefined || value === null) return [];
	if (typeof value === "string") return [value];
	if (value === false) return [];
	if (typeof value === "number" || typeof value === "boolean") return [String(value)];
	if (Array.isArray(value)) return value.flatMap(flattenEvidence);
	if (typeof value !== "object") return [];
	if (isStructuredFinding(value)) return [structuredFindingText(value)];
	return Object.entries(value).flatMap(([key, entry]) =>
		isAdvisoryEvidenceKey(key) ? [] : flattenEvidence(entry).map(text => `${key}: ${text}`),
	);
}

function isAdvisoryEvidenceKey(key) {
	return [
		"commands_run",
		"coverage_gaps_to_note",
		"project_native_validation",
		"public_interfaces_inspected",
		"risk_coverage",
		"rollback_or_hold_criteria",
		"status",
		"verdict",
	].includes(key.toLowerCase());
}

function isStructuredFinding(value) {
	const keys = Object.keys(value).map(key => key.toLowerCase());
	return keys.some(key => ["blocker", "finding", "gap", "issue", "risk", "summary"].includes(key));
}

function structuredFindingText(value) {
	return Object.entries(value)
		.flatMap(([key, entry]) => flattenEvidence(entry).map(text => `${key}: ${text}`))
		.join("; ");
}

function isBlockingEvidence(text) {
	const normalized = text.toLowerCase();
	if (/(no|not|without)\s+(release\s+)?(blocker|risk|gap|missing|stale|repair|required)/u.test(normalized)) {
		return false;
	}
	return /\b(blocker|blocks?|must fix|repair required|required repair|missing|stale|gap|inconsistent|risk|hold)\b/u.test(
		normalized,
	);
}

function auditResolvesBlocker(auditText, blocker) {
	const normalized = auditText.toLowerCase();
	if (!/\b(resolved|waived|waiver|accepted risk|no longer blocks?)\b/u.test(normalized)) return false;
	return evidenceTokens(blocker.text).some(token => normalized.includes(token));
}

function evidenceTokens(text) {
	return [...new Set(text.toLowerCase().match(/[a-z0-9_./-]{5,}/gu) ?? [])].filter(
		token => !["finding", "summary", "status", "should", "needs", "until", "release"].includes(token),
	);
}

function gateMarkdown({ checks, failures, blockers, resolvedBlockers, unresolvedBlockers, status, holdReasons }) {
	return [
		"# Release Gate Evidence",
		"",
		`status: ${status}`,
		`checks_status: ${String(checks.status ?? "(missing)")}`,
		`audit_blockers: ${blockers.length}`,
		`resolved_blockers: ${resolvedBlockers.length}`,
		`unresolved_blockers: ${unresolvedBlockers.length}`,
		...(holdReasons.length ? ["", "## Hold Reasons", "", ...holdReasons.map(reason => `- ${reason}`)] : []),
		"",
		"## Workspace Cleanliness",
		"",
		workspaceGuardMarkdown(workspaceGuard),
		"",
		"## Failures",
		"",
		...(failures.length === 0 ? ["- none"] : failures.map(failure => `- ${failure}`)),
		"",
		"## Audit Blockers",
		"",
		...(blockers.length === 0
			? ["- none"]
			: blockers.map(blocker => `- ${blocker.source}: ${blocker.text}`)),
		"",
		"## Resolved Audit Blockers",
		"",
		...(resolvedBlockers.length === 0
			? ["- none"]
			: resolvedBlockers.map(blocker => `- ${blocker.source}: ${blocker.text}`)),
		"",
		"## Unresolved Audit Blockers",
		"",
		...(unresolvedBlockers.length === 0
			? ["- none"]
			: unresolvedBlockers.map(blocker => `- ${blocker.source}: ${blocker.text}`)),
		"",
	].join("\n");
}

async function readOptionalText(filePath) {
	try {
		return await Bun.file(filePath).text();
	} catch {
		return "";
	}
}

async function taskContractText(task) {
	if (task && typeof task === "object" && typeof task.taskText === "string") return task.taskText;
	return await readOptionalText("task.md");
}

async function workspaceCleanlinessGuard(taskText) {
	const status = await gitStatus();
	if (status.unavailable) {
		return {
			status: "skipped",
			blockers: [],
			changedFiles: [],
			allowedScopes: allowedPathsFromTask(taskText),
			reason: status.reason,
		};
	}
	const changedFiles = status.entries.filter(entry => !ignoredStatusPath(entry.path));
	const allowedScopes = allowedPathsFromTask(taskText);
	const outsideAllowedChangedFiles =
		allowedScopes.length === 0
			? []
			: changedFiles
					.map(entry => entry.path)
					.filter(filePath => allowedScopes.every(scope => !scopeMatchesPath(scope, filePath)));
	const untrackedProjectFiles = changedFiles
		.filter(entry => entry.status.includes("?"))
		.map(entry => entry.path)
		.filter(filePath => !allowedGeneratedPath(filePath));
	const blockers = [
		...outsideAllowedChangedFiles.map(filePath => `${filePath} changed outside task allowed paths`),
		...untrackedProjectFiles.map(filePath => `${filePath} is an untracked project file`),
	];
	return {
		status: blockers.length === 0 ? "pass" : "blocked",
		blockers,
		changedFiles: changedFiles.map(entry => ({ status: entry.status, path: entry.path })).slice(0, 100),
		allowedScopes,
	};
}

async function gitStatus() {
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
	if (exitCode !== 0) {
		const reason = stderr.trim() || stdout.trim();
		if (/not a git repository/iu.test(reason)) {
			return {
				unavailable: true,
				reason,
				entries: [],
			};
		}
		throw new Error(`git status failed before release gate: ${reason}`);
	}
	return {
		unavailable: false,
		entries: stdout
			.split(/\r?\n/u)
			.map(statusLineToEntry)
			.filter(entry => entry !== undefined),
	};
}

function statusLineToEntry(line) {
	if (!line.trim()) return undefined;
	const status = line.slice(0, 2);
	const rawPath = line.slice(3).trim();
	const renamed = rawPath.includes(" -> ") ? rawPath.split(" -> ").at(-1) ?? rawPath : rawPath;
	const path = renamed.replace(/^"|"$/gu, "");
	return path ? { status, path } : undefined;
}

function ignoredStatusPath(filePath) {
	return (
		filePath === "task.md" ||
		filePath === "progress.md" ||
		filePath === "manifest-entry.json" ||
		filePath === "monitor-assignment.json" ||
		filePath.startsWith("workflow-output/") ||
		filePath.startsWith("transcripts/")
	);
}

function allowedGeneratedPath(filePath) {
	return ignoredStatusPath(filePath) || filePath === ".pytest_cache" || filePath.startsWith(".pytest_cache/");
}

function allowedPathsFromTask(taskText) {
	const scopes = [];
	const lines = taskText.split(/\r?\n/u);
	for (let index = 0; index < lines.length; index += 1) {
		const trimmed = lines[index]?.trim() ?? "";
		const match = /^(?:[-*]\s*)?(?:allowed paths?|scope fence)\s*:\s*(.*)$/iu.exec(trimmed);
		if (!match) continue;
		const scopeText = [match[1] ?? ""];
		for (
			let nextIndex = index + 1;
			shouldReadScopeContinuation(scopeText.at(-1) ?? "", lines[nextIndex], scopeText);
			nextIndex += 1
		) {
			scopeText.push(lines[nextIndex]?.trim() ?? "");
		}
		scopes.push(...scopeListFromText(scopeText.join(" ")));
	}
	return uniqueStrings(scopes.map(normalizeScope).filter(Boolean));
}

function shouldReadScopeContinuation(previousLine, nextLine, scopeText) {
	const next = nextLine?.trim() ?? "";
	if (!next) return false;
	if (next.startsWith("```")) return false;
	if (isTaskSectionHeading(next)) return false;
	if (/^(?:[-*]\s*)?(?:allowed paths?|scope fence)\s*:/iu.test(next)) return false;
	const hasCurrentScopeText = scopeText.some(line => line.trim() !== "");
	if (!hasCurrentScopeText) return true;
	if (/^[-*]\s+/u.test(next)) return true;
	if (!/[,;]\s*$/u.test(previousLine.trim())) return false;
	return true;
}

function isTaskSectionHeading(line) {
	return line.startsWith("#") || /^[A-Z][A-Za-z /-]{0,80}:\s*$/u.test(line);
}

function scopeListFromText(text) {
	return text
		.split(/[,;]/u)
		.map(scope => scope.trim())
		.filter(Boolean);
}

function normalizeScope(scope) {
	return scope
		.replace(/^`+|`+$/gu, "")
		.replace(/^['"]|['"]$/gu, "")
		.replace(/\.\s+[A-Z].*$/u, "")
		.replace(/^(?:and\s+)?allowed paths?\s+(?:are|is)\s+/iu, "")
		.replace(/^and\s+/iu, "")
		.replace(/\s+if present$/iu, "")
		.replace(/[.。]$/u, "")
		.trim()
		.replace(/^\.\//u, "");
}

function scopeMatchesPath(scope, filePath) {
	if (scope.endsWith("/**")) {
		const prefix = scope.slice(0, -3);
		return filePath === prefix || filePath.startsWith(`${prefix}/`);
	}
	if (scope.endsWith("/")) return filePath.startsWith(scope);
	return filePath === scope || filePath.startsWith(`${scope}/`);
}

function uniqueStrings(values) {
	return [...new Set(values)];
}

function workspaceGuardMarkdown(workspaceGuard) {
	return [
		`Status: ${workspaceGuard.status}`,
		...(workspaceGuard.reason ? ["", `Reason: ${workspaceGuard.reason}`] : []),
		"",
		"### Blockers",
		"",
		workspaceGuard.blockers.length > 0
			? workspaceGuard.blockers.map(blocker => `- ${blocker}`).join("\n")
			: "- No workspace cleanliness blockers.",
		"",
		"### Changed Files",
		"",
		workspaceGuard.changedFiles.length > 0
			? workspaceGuard.changedFiles.map(entry => `- ${entry.status} ${entry.path}`).join("\n")
			: "- No changed project files outside ignored workflow artifacts.",
	].join("\n");
}

function concise(text) {
	const normalized = text.replace(/\s+/gu, " ").trim();
	if (normalized.length <= 280) return normalized;
	return `${normalized.slice(0, 280)}...`;
}
