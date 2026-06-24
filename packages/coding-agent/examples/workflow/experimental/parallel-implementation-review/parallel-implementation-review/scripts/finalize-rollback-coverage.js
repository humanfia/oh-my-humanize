const taskText = await readText("task.md");
const tupleId = await tupleIdFromRunArtifacts(taskText);
const changedEntries = await changedProjectEntries();
const changedFiles = changedEntries.map(entry => entry.path);
const existingRollbackArtifacts = await rollbackArtifacts();
const diffStat = await gitOutput(["git", "diff", "--stat"]);
const artifact = `workflow-output/final-rollback-coverage${tupleId ? `-${tupleId}` : ""}.md`;
const artifactText = rollbackCoverageText({
	tupleId,
	changedEntries,
	existingRollbackArtifacts,
	diffStat,
});
const payload = {
	tuple_id: tupleId,
	artifact,
	producer_node: "finalizeRollbackCoverage",
	producer_kind: "workflow-script",
	changed_files: changedFiles,
	existing_rollback_artifacts: existingRollbackArtifacts,
	diff_stat: diffStat,
	checked_at_ms: Date.now(),
};

await Bun.write(artifact, artifactText);

return {
	summary: `final rollback coverage materialized for ${changedFiles.length} changed project files`,
	verdict: "ready",
	data: payload,
	statePatch: [{ op: "set", path: "/rollbackCoverage", value: payload }],
};

function rollbackCoverageText({ tupleId, changedEntries, existingRollbackArtifacts, diffStat }) {
	return [
		"# Final Rollback Coverage",
		"",
		`Tuple: ${tupleId || "(unknown)"}`,
		"",
		"## Changed Files",
		"",
		...(changedEntries.length > 0
			? changedEntries.flatMap(entry => [
					`- ${entry.path}`,
					`  - status: ${entry.status || "changed"}`,
					`  - rollback: ${rollbackInstruction(entry)}`,
				])
			: ["- (none)"]),
		"",
		"## Existing Rollback Evidence",
		"",
		...(existingRollbackArtifacts.length > 0
			? existingRollbackArtifacts.map(file => `- ${file}`)
			: ["- (none)"]),
		"",
		"## Diff Stat",
		"",
		diffStat || "(none)",
		"",
	].join("\n");
}

function rollbackInstruction(entry) {
	if (entry.status.includes("?")) return `remove untracked path after review: ${entry.path}`;
	if (entry.status.includes("D")) return `restore deleted path from git: ${entry.path}`;
	return `revert this path to the pre-run version if the tuple is rejected: ${entry.path}`;
}

async function readText(filePath) {
	try {
		return await Bun.file(filePath).text();
	} catch {
		return "";
	}
}

async function tupleIdFromRunArtifacts(taskText) {
	const monitorTuple = await tupleIdFromJsonFile("monitor-assignment.json");
	if (monitorTuple) return monitorTuple;
	const manifestTuple = await tupleIdFromJsonFile("manifest-entry.json");
	if (manifestTuple) return manifestTuple;
	const taskTuple = tupleIdFromTaskText(taskText);
	if (taskTuple) return taskTuple;
	return "";
}

async function tupleIdFromJsonFile(filePath) {
	try {
		const data = await Bun.file(filePath).json();
		const candidate =
			stringField(data, "tupleId") ||
			stringField(data, "tuple_id") ||
			stringField(data, "runId") ||
			stringField(data, "run_id");
		return normalizeTupleId(candidate);
	} catch {
		return "";
	}
}

function tupleIdFromTaskText(text) {
	const match = /\b(?:tuple|tuple id|tuple-id|monitor|run id|canary tuple)\b[^A-Za-z0-9]+([A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+){1,8})/iu.exec(
		text,
	);
	return normalizeTupleId(match?.[1]);
}

function normalizeTupleId(value) {
	if (typeof value !== "string") return "";
	const trimmed = value.trim().replace(/^`+|`+$/gu, "");
	return /^[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+){1,8}$/u.test(trimmed) ? trimmed : "";
}

async function changedProjectEntries() {
	const text = await gitOutput(["git", "status", "--short", "--untracked-files=all"]);
	return text
		.split(/\r?\n/u)
		.map(statusLineToEntry)
		.filter(entry => entry.path)
		.filter(entry => !ignoredEvidencePath(entry.path))
		.sort((left, right) => left.path.localeCompare(right.path, "en"));
}

function statusLineToEntry(line) {
	const trimmed = line.trim();
	if (!trimmed) return { status: "", path: "" };
	const rename = /^(.{1,2})\s+(.+?)\s+->\s+(.+)$/u.exec(trimmed);
	if (rename) return { status: rename[1]?.trim() ?? "", path: normalizeGitPath(rename[3]?.trim() ?? "") };
	return { status: trimmed.slice(0, 2).trim(), path: normalizeGitPath(trimmed.slice(2).trim()) };
}

function normalizeGitPath(filePath) {
	if (filePath.startsWith('"') && filePath.endsWith('"')) return filePath.slice(1, -1);
	return filePath;
}

async function rollbackArtifacts() {
	const files = [];
	const glob = new Bun.Glob("workflow-output/**");
	for await (const file of glob.scan({ cwd: process.cwd(), onlyFiles: true })) {
		if (/^workflow-output\/final-rollback-coverage[^/]*\.md$/iu.test(file)) continue;
		if (/(^|\/)rollback(?!-notes)[^/]*\.(?:json|md|txt)$/iu.test(file)) files.push(file);
	}
	return files.sort((left, right) => left.localeCompare(right, "en"));
}

function ignoredEvidencePath(file) {
	return (
		file === "evidence-ledger.jsonl" ||
		file === "manifest-entry.json" ||
		file === "monitor-assignment.json" ||
		file === "task.md" ||
		file === "progress.md" ||
		file.includes("workflow-output/") ||
		ignoredProjectArtifactPath(file)
	);
}

function ignoredProjectArtifactPath(file) {
	const ignoredSegments = new Set([".venv", "node_modules", ".pytest_cache", ".mypy_cache", ".ruff_cache", "__pycache__"]);
	return normalizeGitPath(file)
		.replace(/\\/gu, "/")
		.split("/")
		.some(segment => ignoredSegments.has(segment));
}

async function gitOutput(command) {
	const proc = Bun.spawn(command, {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
	return exitCode === 0 ? stdout.trim() : "";
}

function stringField(value, key) {
	if (!value || typeof value !== "object") return "";
	const field = value[key];
	return typeof field === "string" ? field : "";
}
