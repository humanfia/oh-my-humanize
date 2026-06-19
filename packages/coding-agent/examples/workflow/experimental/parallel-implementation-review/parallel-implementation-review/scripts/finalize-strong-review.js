const taskText = await readText("task.md");
const tupleId = await tupleIdFromRunArtifacts(taskText);
const verdict = verdictFromWorkflowState();
const evidenceContract = objectState("/evidenceContract");
const changedFiles = await changedProjectFiles();
const evidenceFiles = await workflowEvidenceFiles();
const finalReviewArtifact = `workflow-output/final-review${tupleId ? `-${tupleId}` : ""}.json`;
const finalArchiveArtifact = `workflow-output/final-parallel-implementation-review-archive${tupleId ? `-${tupleId}` : ""}.md`;
const payload = {
	tuple_id: tupleId,
	artifact: finalReviewArtifact,
	producer_node: "finalizeStrongReview",
	producer_kind: "workflow-script",
	strong_review: {
		verdict,
		accepted: verdict === "promote",
	},
	evidence_contract: evidenceContract,
	changed_files: changedFiles,
	evidence_files: evidenceFiles,
	checked_at_ms: Date.now(),
};

await Bun.write(finalReviewArtifact, `${JSON.stringify(payload, null, 2)}\n`);
await Bun.write(finalArchiveArtifact, archiveText({ taskText, payload, finalReviewArtifact, finalArchiveArtifact }));

return {
	summary: `final strong review archived with verdict ${verdict}`,
	verdict,
	data: payload,
	statePatch: [{ op: "set", path: "/finalReview", value: payload }],
};

function verdictFromWorkflowState() {
	const verdictState = objectState("/verdict");
	const candidates = [
		verdictState?.verdict,
		verdictState?.decision,
		verdictState?.status,
		typeof verdictState === "string" ? verdictState : "",
	];
	const verdict = candidates.find(candidate => candidate === "promote" || candidate === "reject");
	return verdict || "reject";
}

function objectState(path) {
	const value = stateValueAtPath(workflowContext.state, path);
	return value && typeof value === "object" ? value : value ?? null;
}

function stateValueAtPath(state, pointer) {
	if (!state || typeof state !== "object") return null;
	const segments = pointer
		.split("/")
		.slice(1)
		.map(segment => segment.replace(/~1/gu, "/").replace(/~0/gu, "~"));
	let current = state;
	for (const segment of segments) {
		if (!current || typeof current !== "object" || !(segment in current)) return null;
		current = current[segment];
	}
	return current;
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
	const taskTuple = /(?:tuple|monitor)[^A-Za-z0-9]+([A-Z][0-9]{2}-T[0-9]{2}(?:-[A-Za-z0-9]+)?)/u.exec(taskText);
	if (taskTuple?.[1]) return taskTuple[1];
	return "";
}

async function tupleIdFromJsonFile(filePath) {
	try {
		const data = await Bun.file(filePath).json();
		const candidate = stringField(data, "tupleId") || stringField(data, "tuple_id");
		return candidate.trim();
	} catch {
		return "";
	}
}

function stringField(value, key) {
	if (!value || typeof value !== "object") return "";
	const field = value[key];
	return typeof field === "string" ? field : "";
}

async function changedProjectFiles() {
	const proc = Bun.spawn(["git", "diff", "--name-only"], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const exitCode = await proc.exited;
	if (exitCode !== 0) return [];
	const text = await new Response(proc.stdout).text();
	return text
		.split(/\r?\n/u)
		.map(line => line.trim())
		.filter(Boolean)
		.filter(file => !file.startsWith("workflow-output/") && file !== "progress.md" && file !== "task.md")
		.sort((left, right) => left.localeCompare(right, "en"));
}

async function workflowEvidenceFiles() {
	const proc = Bun.spawn(["find", "workflow-output", "-maxdepth", "2", "-type", "f"], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const exitCode = await proc.exited;
	if (exitCode !== 0) return [];
	const text = await new Response(proc.stdout).text();
	return text
		.split(/\r?\n/u)
		.map(line => line.trim())
		.filter(Boolean)
		.filter(file => !ignoredEvidenceFile(file))
		.sort((left, right) => left.localeCompare(right, "en"));
}

function ignoredEvidenceFile(file) {
	return (
		/^workflow-output\/(?:validation|verify|test|tests)\.(?:json|md|txt|log)$/iu.test(file) ||
		/(^|\/)(?:strong-review|final-review|final-parallel-implementation-review-archive)[^/]*\.(?:json|md|txt)$/iu.test(file)
	);
}

function archiveText({ taskText, payload, finalReviewArtifact, finalArchiveArtifact }) {
	return [
		"# Parallel Implementation Review Archive",
		"",
		"## Verdict",
		"",
		payload.strong_review.verdict,
		"",
		"## Final Review Artifact",
		"",
		finalReviewArtifact,
		"",
		"## Final Archive Artifact",
		"",
		finalArchiveArtifact,
		"",
		"## Evidence Contract",
		"",
		`verdict: ${payload.evidence_contract?.verdict ?? payload.evidence_contract?.status ?? "unknown"}`,
		"",
		"## Changed Files",
		"",
		...(payload.changed_files.length > 0 ? payload.changed_files.map(file => `- ${file}`) : ["- (none)"]),
		"",
		"## Evidence Files",
		"",
		...(payload.evidence_files.length > 0 ? payload.evidence_files.map(file => `- ${file}`) : ["- (none)"]),
		"",
		"## Task",
		"",
		taskText.trim() || "(missing task.md)",
		"",
	].join("\n");
}
