const state = workflowContext.state && typeof workflowContext.state === "object" ? workflowContext.state : {};
const task = state.task && typeof state.task === "object" ? state.task : {};
const taskText = typeof task.text === "string" ? task.text : await readOptionalText("task.md");
const workspace = await workspaceReviewContext(taskText);
const diff = await projectDiffPreview();
const compatibilityHighlights = compatibilityReviewHighlights(state.compatibility, workspace);
const outputPath = "workflow-output/refactor-migration-review-context.md";

await Bun.write(outputPath, reviewContextMarkdown({ workspace, diff, compatibilityHighlights }));

return {
	summary: `prepared refactor migration review context: workspace ${workspace.status}`,
	statePatch: [
		{
			op: "set",
			path: "/reviewContext",
			value: {
				file: outputPath,
				workspace,
				diff,
				compatibilityHighlights,
			},
		},
	],
};

async function workspaceReviewContext(text) {
	const status = await gitStatus();
	const changedFiles = status.entries.filter(entry => !ignoredStatusPath(entry.path));
	const allowedScopes = allowedPathsFromTask(text);
	const outsideAllowedChangedFiles =
		allowedScopes.length === 0
			? []
			: changedFiles
					.filter(entry => !entry.status.includes("?"))
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
		throw new Error(`git status failed before refactor migration review: ${stderr.trim() || stdout.trim()}`);
	}
	return {
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

function allowedPathsFromTask(text) {
	const scopes = [];
	for (const line of text.split(/\r?\n/u)) {
		const trimmed = line.trim();
		const match = /^(?:[-*]\s*)?(?:allowed paths?|scope fence)\s*:\s*(.+)$/iu.exec(trimmed);
		if (!match) continue;
		scopes.push(...scopeListFromText(match[1] ?? ""));
	}
	return uniqueStrings(scopes.map(normalizeScope).filter(Boolean));
}

function scopeListFromText(text) {
	return text
		.split(/[,;]/u)
		.map(part => part.trim().replace(/[.。]$/u, ""))
		.filter(Boolean);
}

function normalizeScope(scope) {
	return scope.replace(/^`|`$/gu, "").replace(/^\.\//u, "").trim();
}

function scopeMatchesPath(scope, filePath) {
	const normalizedScope = scope.endsWith("/") ? scope : `${scope}/`;
	return filePath === scope || filePath.startsWith(normalizedScope);
}

async function projectDiffPreview() {
	const proc = Bun.spawn(
		[
			"git",
			"diff",
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
			stderr: bounded(stderr, 2000),
		};
	}
	return {
		status: stdout.trim() ? "present" : "empty",
		bytes: stdout.length,
		preview: bounded(stdout, 6000),
	};
}

function compatibilityReviewHighlights(value, workspace) {
	const lines = evidenceStrings(value)
		.map(text => text.trim())
		.filter(line =>
			/\b(?:behavior|boundary|compatibility|preserve|requirement|rollback|warning|stacklevel|public|observable|must|exact)\b/iu.test(
				line,
			),
		)
		.map(cleanHighlightLine)
		.filter(line => !staleNoSourceChangeHighlight(line, workspace))
		.filter(Boolean);
	return uniqueStrings(lines).slice(0, 40);
}

function staleNoSourceChangeHighlight(line, workspace) {
	if (!workspaceHasSourceChanges(workspace)) return false;
	return /\bno\s+(?:production\s+)?source\s+files?\s+(?:were\s+)?changed\b/iu.test(line);
}

function workspaceHasSourceChanges(workspace) {
	return workspace.changedFiles.some(entry => sourceLikeChangedPath(entry.path));
}

function sourceLikeChangedPath(filePath) {
	if (filePath.startsWith("tests/") || filePath.startsWith("test/")) return false;
	if (filePath.startsWith("docs/") || filePath.startsWith("doc/")) return false;
	if (filePath.endsWith(".md") || filePath.endsWith(".rst") || filePath.endsWith(".txt")) return false;
	return !allowedGeneratedPath(filePath);
}

function evidenceStrings(value) {
	if (typeof value === "string") return [value];
	if (value === undefined || value === null) return [];
	if (Array.isArray(value)) return value.flatMap(item => evidenceStrings(item));
	if (typeof value !== "object") return [];
	return Object.values(value).flatMap(item => evidenceStrings(item));
}

function cleanHighlightLine(line) {
	const jsonStringField = /^"?[A-Za-z0-9_. -]+"?\s*:\s*"(.*)"[,]?$/u.exec(line);
	const raw = jsonStringField?.[1] ?? line;
	return raw
		.replace(/^[-*]\s*/u, "")
		.replace(/^"/u, "")
		.replace(/",?$/u, "")
		.replace(/\\"/gu, "\"")
		.trim();
}

function reviewContextMarkdown({ workspace, diff, compatibilityHighlights }) {
	return [
		"# Refactor Migration Review Context",
		"",
		"## Workspace",
		"",
		`Status: ${workspace.status}`,
		"",
		"### Blockers",
		"",
		workspace.blockers.length > 0 ? workspace.blockers.map(blocker => `- ${blocker}`).join("\n") : "- none",
		"",
		"### Changed Files",
		"",
		workspace.changedFiles.length > 0
			? workspace.changedFiles.map(entry => `- ${entry.status} ${entry.path}`).join("\n")
			: "- none",
		"",
		"## Allowed Scopes",
		"",
		workspace.allowedScopes.length > 0 ? workspace.allowedScopes.map(scope => `- ${scope}`).join("\n") : "- none",
		"",
		"## Compatibility Highlights",
		"",
		compatibilityHighlights.length > 0
			? compatibilityHighlights.map(highlight => `- ${highlight}`).join("\n")
			: "- none",
		"",
		"## Diff Preview",
		"",
		"```diff",
		diff.preview ?? diff.stderr ?? "",
		"```",
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

function uniqueStrings(values) {
	return [...new Set(values)];
}

function bounded(text, limit) {
	return text.length > limit ? `${text.slice(0, limit)}\n[truncated ${text.length - limit} bytes]` : text;
}
