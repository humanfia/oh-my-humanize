const taskText = await readText("task.md");
const tupleId = await tupleIdFromRunArtifacts(taskText);
const evidenceContract = objectState("/evidenceContract");
const evidenceContractVerdict = evidenceContract?.verdict ?? evidenceContract?.status ?? "unknown";
const requestedVerdict = verdictFromWorkflowState();
const verdict = evidenceContractVerdict === "READY" ? requestedVerdict : "reject";
const strongReviewActivation = latestCompletedActivation("strongReview");
const changedFiles = await changedProjectFiles();
const evidenceFiles = await workflowEvidenceFiles();
const finalReviewArtifact = `workflow-output/final-review${tupleId ? `-${tupleId}` : ""}.json`;
const finalArchiveArtifact = `workflow-output/final-parallel-implementation-review-archive${tupleId ? `-${tupleId}` : ""}.md`;
const preexistingFinalArtifacts = await quarantinePreexistingFinalArtifacts(
	preexistingFinalArtifactCandidates(evidenceContract, [finalReviewArtifact, finalArchiveArtifact]),
);
const payload = {
	tuple_id: tupleId,
	artifact: finalReviewArtifact,
	producer_node: "finalizeStrongReview",
	producer_kind: "workflow-script",
	strong_review: {
		verdict,
		accepted: verdict === "promote",
		requested_verdict: requestedVerdict,
		...strongReviewDetails(strongReviewActivation),
	},
	evidence_contract: evidenceContract,
	evidence_contract_verdict: evidenceContractVerdict,
	changed_files: changedFiles,
	evidence_files: evidenceFiles,
	preexisting_final_artifacts: preexistingFinalArtifacts,
	checked_at_ms: Date.now(),
};

await Bun.write(finalReviewArtifact, `${JSON.stringify(payload, null, 2)}\n`);
await Bun.write(finalArchiveArtifact, archiveText({ taskText, payload, finalReviewArtifact, finalArchiveArtifact }));
await Bun.write(
	"workflow-output/tuple-state.json",
	`${JSON.stringify(
		{
			tuple_id: tupleId,
			flow: "parallel-implementation-review",
			status: verdict === "promote" ? "completed" : "rejected",
			terminal: true,
			verdict,
			final_artifact: finalReviewArtifact,
			archive_artifact: finalArchiveArtifact,
			evidence_contract_verdict: evidenceContractVerdict,
			changed_files: changedFiles,
			evidence_files: evidenceFiles,
			preexisting_final_artifacts: preexistingFinalArtifacts,
			checked_at_ms: Date.now(),
		},
		null,
		2,
	)}\n`,
);

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

function latestCompletedActivation(nodeId) {
	const activations = workflowContext.completedActivations ?? [];
	for (let index = activations.length - 1; index >= 0; index -= 1) {
		const activation = activations[index];
		if (activation?.nodeId === nodeId && activation.status === "completed") return activation;
	}
	return null;
}

function strongReviewDetails(activation) {
	const verdictState = objectState("/verdict");
	const summary = summaryFromReviewSources(activation, verdictState);
	const artifacts = artifactsFromReviewSources(activation, verdictState);
	const data = objectField(activation?.output, "data") ?? objectField(verdictState, "data");
	const details = {
		summary,
		artifacts,
		review_activation: activation
			? {
					id: activation.id,
					node_id: activation.nodeId,
					verdict: activation.output?.verdict ?? verdictState?.verdict ?? verdictState?.status ?? null,
					artifacts,
				}
			: null,
	};
	if (data && Object.keys(data).length > 0) details.data = data;
	return details;
}

function summaryFromReviewSources(activation, verdictState) {
	return (
		stringField(activation?.output, "summary") ||
		stringField(verdictState, "summary") ||
		stringField(verdictState, "explanation") ||
		stringField(verdictState, "reason") ||
		""
	);
}

function artifactsFromReviewSources(activation, verdictState) {
	return boundedArray(
		[
			...arrayField(activation?.output, "artifacts"),
			...arrayField(verdictState, "artifacts"),
			...arrayField(verdictState, "artifact_refs"),
		].filter(value => typeof value === "string"),
		40,
	);
}

function objectField(value, key) {
	if (!value || typeof value !== "object") return null;
	const field = value[key];
	return field && typeof field === "object" && !Array.isArray(field) ? field : null;
}

function arrayField(value, key) {
	if (!value || typeof value !== "object") return [];
	const field = value[key];
	return Array.isArray(field) ? field : [];
}

function preexistingFinalArtifactCandidates(evidenceContract, finalizerArtifacts) {
	const prematureArtifacts = evidenceContract?.checked_inputs?.premature_decision_artifacts;
	const candidates = Array.isArray(prematureArtifacts) ? prematureArtifacts : [];
	return uniqueSorted(
		[...candidates, ...finalizerArtifacts]
			.filter(file => typeof file === "string")
			.filter(file => file.startsWith("workflow-output/"))
			.filter(file => !file.includes("..")),
	);
}

async function quarantinePreexistingFinalArtifacts(files) {
	const preserved = [];
	for (const file of files) {
		if (!(await fileExists(file))) continue;
		const quarantine = `workflow-output/quarantined-premature-final-artifacts/${artifactBasename(file)}`;
		await Bun.write(quarantine, await Bun.file(file).text());
		preserved.push({ original: file, quarantine });
	}
	return preserved;
}

async function fileExists(filePath) {
	try {
		return await Bun.file(filePath).exists();
	} catch {
		return false;
	}
}

function artifactBasename(filePath) {
	return filePath.split("/").pop()?.replace(/[^\w.-]/gu, "_") || "artifact";
}

function uniqueSorted(values) {
	return Array.from(new Set(values)).sort((left, right) => left.localeCompare(right, "en"));
}

function boundedArray(values, limit) {
	const bounded = values.slice(0, limit);
	if (values.length > limit) bounded.push(`... omitted ${values.length - limit} items`);
	return bounded;
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
	const taskTuple = tupleIdFromTaskText(taskText);
	if (taskTuple) return taskTuple;
	return "";
}

async function tupleIdFromJsonFile(filePath) {
	try {
		const data = await Bun.file(filePath).json();
		const candidate = stringField(data, "tupleId") || stringField(data, "tuple_id");
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
		"## Strong Review",
		"",
		`requested verdict: ${payload.strong_review.requested_verdict}`,
		`final verdict: ${payload.strong_review.verdict}`,
		"",
		"### Summary",
		"",
		payload.strong_review.summary || "(no strong review summary captured)",
		"",
		"### Artifacts",
		"",
		...(payload.strong_review.artifacts.length > 0
			? payload.strong_review.artifacts.map(artifact => `- ${artifact}`)
			: ["- (none)"]),
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
