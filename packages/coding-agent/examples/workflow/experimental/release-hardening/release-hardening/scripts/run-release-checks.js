const task = workflowContext.state?.task;
const validationCommand = task?.validationCommand;
const securityCommand = task?.securityCommand;
if (typeof validationCommand !== "string" || validationCommand.trim() === "") {
	throw new Error("release-hardening requires /task.validationCommand before runReleaseChecks");
}
await assertTaskContractUnchanged(task);

const validation = await runShell(validationCommand, "release-validation");
const hasSecurityCommand = typeof securityCommand === "string" && securityCommand.trim() !== "";
const security = hasSecurityCommand ? await runShell(securityCommand, "release-security") : undefined;
const workspaceScope = await workspaceScopeGuard(task.taskText);
const outputPath = "workflow-output/release-checks.md";
await Bun.write(outputPath, evidenceMarkdown(validationCommand, validation, securityCommand, security, workspaceScope));

const validationPass = validation.exitCode === 0;
const securityStatus = security === undefined ? "skipped" : security.exitCode === 0 ? "pass" : "fail";
const securityPass = securityStatus !== "fail";
const scopePass = workspaceScope.status !== "blocked";

return {
	summary: `ran release checks; validation=${validationPass ? "pass" : "fail"} security=${securityStatus} scope=${workspaceScope.status}`,
	data: { validation, security },
	statePatch: [
		{
			op: "set",
			path: "/checks",
			value: {
				validationCommand,
				validationExitCode: validation.exitCode,
				validationStdoutPath: validation.stdoutPath,
				validationStderrPath: validation.stderrPath,
				securityCommand,
				securityExitCode: security?.exitCode,
				securityStdoutPath: security?.stdoutPath,
				securityStderrPath: security?.stderrPath,
				securityStatus,
				workspaceScope,
				status: validationPass && securityPass && scopePass ? "pass" : "fail",
				outputPath,
			},
		},
	],
};

async function runShell(command, artifactPrefix) {
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
	const stdoutPath = `workflow-output/${artifactPrefix}-stdout.txt`;
	const stderrPath = `workflow-output/${artifactPrefix}-stderr.txt`;
	await Bun.write(stdoutPath, stdout);
	await Bun.write(stderrPath, stderr);
	return {
		exitCode,
		stdout: bounded(stdout),
		stderr: bounded(stderr),
		stdoutPath,
		stderrPath,
	};
}

async function assertTaskContractUnchanged(task) {
	const expected = task?.taskText;
	if (typeof expected !== "string" || expected.trim() === "") {
		throw new Error("release-hardening requires /task.taskText from precheck before runReleaseChecks");
	}
	const current = await Bun.file("task.md").text();
	if (current !== expected) {
		throw new Error(
			"task.md changed after release-hardening precheck; stop this attempt, inspect the task contract, then restart from a fresh freeze",
		);
	}
}

function evidenceMarkdown(validationCommand, validation, securityCommand, security, workspaceScope) {
	const lines = [
		"# Release Check Evidence",
		"",
	];
	appendCommandEvidence(lines, "Validation", validationCommand, validation);
	if (securityCommand && security) {
		appendCommandEvidence(lines, "Security", securityCommand, security);
	} else {
		lines.push("## Security Command", "", "Security command: not declared", "");
	}
	lines.push("## Workspace Scope", "", workspaceScopeMarkdown(workspaceScope), "");
	return lines.join("\n");
}

function appendCommandEvidence(lines, label, command, result) {
	lines.push(
		`## ${label} Command`,
		"",
		"```sh",
		command,
		"```",
		"",
		`Exit code: ${result.exitCode}`,
		"",
		`### ${label} stdout`,
		"",
		`Raw artifact: \`${result.stdoutPath}\``,
		"",
		"```text",
		result.stdout || "(empty)",
		"```",
		"",
		`### ${label} stderr`,
		"",
		`Raw artifact: \`${result.stderrPath}\``,
		"",
		"```text",
		result.stderr || "(empty)",
		"```",
		"",
	);
}

function bounded(text) {
	const limit = 12000;
	if (text.length <= limit) return text;
	return `${text.slice(0, limit)}\n[truncated ${text.length - limit} bytes]`;
}

async function workspaceScopeGuard(taskText) {
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
	const blockers = outsideAllowedChangedFiles.map(filePath => `${filePath} changed outside task allowed paths`);
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
			return { unavailable: true, reason, entries: [] };
		}
		throw new Error(`git status failed before release checks: ${reason}`);
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
	return uniqueStrings(scopes);
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
	return allowedScopeText(text)
		.split(/[,;]/u)
		.map(normalizeScope)
		.filter(isPathScope);
}

function allowedScopeText(text) {
	const match = /\b(?:out of scope|out-of-scope|not allowed|do not edit|do not modify)\b/iu.exec(text);
	if (!match) return text;
	return text.slice(0, match.index);
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

function isPathScope(scope) {
	if (!scope) return false;
	if (/\s/u.test(scope)) return false;
	return /[*./\\]/u.test(scope) || /^[A-Za-z0-9_-]+$/u.test(scope);
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

function workspaceScopeMarkdown(workspaceScope) {
	return [
		`Status: ${workspaceScope.status}`,
		...(workspaceScope.reason ? ["", `Reason: ${workspaceScope.reason}`] : []),
		"",
		"### Allowed Scopes",
		"",
		workspaceScope.allowedScopes.length > 0
			? workspaceScope.allowedScopes.map(scope => `- ${scope}`).join("\n")
			: "- No task allowed paths declared.",
		"",
		"### Changed Files",
		"",
		workspaceScope.changedFiles.length > 0
			? workspaceScope.changedFiles.map(entry => `- ${entry.status} ${entry.path}`).join("\n")
			: "- No changed project files outside workflow artifacts.",
		"",
		"### Blockers",
		"",
		workspaceScope.blockers.length > 0
			? workspaceScope.blockers.map(blocker => `- ${blocker}`).join("\n")
			: "- No workspace scope blockers.",
	].join("\n");
}
