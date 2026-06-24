const MAX_REVIEW_HANDOFF_BYTES = 16 * 1024;
const taskText = await readText("task.md");
const tupleId = await tupleIdFromRunArtifacts(taskText);
const integrationActivation = latestCompletedActivation("integrationReview");
const status = integrationActivation ? "materialized" : "missing_review_activation";
const changedFiles = await changedProjectFiles();
const diffStat = await gitOutput(["git", "diff", "--stat"]);
const laneArtifacts = await laneEvidenceArtifacts(tupleId);
const validationArtifacts = await validationEvidenceArtifacts(tupleId);
const artifactPath = `workflow-output/integration-review-materialized${tupleId ? `-${tupleId}` : ""}.json`;
const handoffArtifact = `workflow-output/review-handoff${tupleId ? `-${tupleId}` : ""}.json`;
const payload = {
	tuple_id: tupleId,
	artifact: artifactPath,
	producer_node: "materializeIntegrationReview",
	producer_kind: "workflow-script",
	status,
	review_activation: integrationActivation
		? {
				id: integrationActivation.id,
				node_id: integrationActivation.nodeId,
				summary: integrationActivation.output?.summary ?? "",
				data: integrationActivation.output?.data ?? {},
				artifacts: integrationActivation.output?.artifacts ?? [],
			}
		: null,
	changed_files: changedFiles,
	diff_stat: diffStat,
	lane_artifacts: laneArtifacts,
	validation_artifacts: validationArtifacts,
	checked_at_ms: Date.now(),
};
const reviewHandoff = boundedReviewHandoff({
	tupleId,
	status,
	artifactPath,
	handoffArtifact,
	changedFiles,
	diffStat,
	laneArtifacts,
	validationArtifacts,
});

await Bun.write(artifactPath, `${JSON.stringify(payload, null, 2)}\n`);
await Bun.write(handoffArtifact, `${reviewHandoff}\n`);

const resultData = {
	tuple_id: tupleId,
	artifact: artifactPath,
	producer_node: "materializeIntegrationReview",
	producer_kind: "workflow-script",
	status,
	review_handoff_artifact: handoffArtifact,
	review_handoff_bytes: new TextEncoder().encode(reviewHandoff).byteLength,
	review_activation: integrationActivation
		? {
				id: integrationActivation.id,
				node_id: integrationActivation.nodeId,
				summary: truncateText(integrationActivation.output?.summary ?? "", 1600),
				summary_truncated: (integrationActivation.output?.summary ?? "").length > 1600,
				artifacts: boundedArray(integrationActivation.output?.artifacts ?? [], 20),
			}
		: null,
	changed_files: boundedArray(changedFiles, 40),
	diff_stat: truncateText(diffStat, 1600),
	lane_artifacts: boundedArray(laneArtifacts, 40),
	validation_artifacts: boundedArray(validationArtifacts, 40),
};

return {
	summary:
		status === "materialized"
			? `materialized integration review evidence: ${artifactPath}; compact review handoff: ${handoffArtifact}`
			: `integration review activation missing; wrote diagnostic artifact: ${artifactPath}; compact review handoff: ${handoffArtifact}`,
	verdict: status === "materialized" ? "materialized" : "missing_review_activation",
	data: resultData,
	statePatch: [
		{ op: "set", path: "/integrationReviewArtifact", value: resultData },
		{ op: "set", path: "/reviewHandoff", value: reviewHandoff },
	],
};

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

function latestCompletedActivation(nodeId) {
	const activations = workflowContext.completedActivations ?? [];
	for (let index = activations.length - 1; index >= 0; index -= 1) {
		const activation = activations[index];
		if (activation?.nodeId === nodeId && activation.status === "completed") return activation;
	}
	return null;
}

function boundedReviewHandoff(input) {
	const handoff = {
		status: "compact_review_handoff",
		producer_node: "materializeIntegrationReview",
		tuple_id: input.tupleId,
		instruction:
			"Use this bounded handoff for strong review. It summarizes evidence and points to durable artifacts; do not paste raw artifacts into downstream prompts.",
		integration_review_artifact: input.artifactPath,
		review_handoff_artifact: input.handoffArtifact,
		integration_review_status: input.status,
		lane_outputs: {
			core: activationHandoff("implementCore"),
			tests: activationHandoff("implementTests"),
			docs: activationHandoff("implementDocs"),
			integration_review: activationHandoff("integrationReview"),
		},
		changed_files: boundedArray(input.changedFiles, 40),
		diff_stat: truncateText(input.diffStat, 1600),
		lane_artifacts: boundedArray(input.laneArtifacts, 50),
		validation_artifacts: boundedArray(input.validationArtifacts, 50),
	};
	return truncateUtf8Bytes(safeJsonStringify(handoff), MAX_REVIEW_HANDOFF_BYTES);
}

function activationHandoff(nodeId) {
	const activation = latestCompletedActivation(nodeId);
	if (!activation) return { node_id: nodeId, status: "missing" };
	const output = activation.output ?? {};
	return {
		node_id: nodeId,
		activation_id: activation.id,
		status: activation.status,
		verdict: output.verdict ?? output.status ?? null,
		summary: truncateText(output.summary ?? "", 1800),
		artifacts: boundedArray(output.artifacts ?? [], 20),
		data_keys: output.data && typeof output.data === "object" ? Object.keys(output.data).slice(0, 30) : [],
	};
}

async function changedProjectFiles() {
	const text = await gitOutput(["git", "status", "--short", "--untracked-files=all"]);
	return text
		.split(/\r?\n/u)
		.map(statusLineToPath)
		.filter(Boolean)
		.filter(file => !ignoredEvidencePath(file))
		.sort((left, right) => left.localeCompare(right, "en"));
}

function statusLineToPath(line) {
	const trimmed = line.trim();
	if (!trimmed) return "";
	const rename = /^R[ MDA?]?\s+(.+?)\s+->\s+(.+)$/u.exec(trimmed);
	if (rename) return normalizeGitPath(rename[2]?.trim() ?? "");
	return normalizeGitPath(trimmed.slice(2).trim());
}

function normalizeGitPath(filePath) {
	if (filePath.startsWith('"') && filePath.endsWith('"')) return filePath.slice(1, -1);
	return filePath;
}

async function laneEvidenceArtifacts(tupleId) {
	const files = [];
	const glob = new Bun.Glob("workflow-output/**");
	for await (const file of glob.scan({ cwd: process.cwd(), onlyFiles: true })) {
		if (!isLaneEvidenceArtifact(file)) continue;
		if (tupleId && !file.includes(tupleId)) continue;
		files.push(file);
	}
	return files.sort((left, right) => left.localeCompare(right, "en"));
}

async function validationEvidenceArtifacts(tupleId) {
	const files = [];
	const glob = new Bun.Glob("workflow-output/**");
	for await (const file of glob.scan({ cwd: process.cwd(), onlyFiles: true })) {
		if (!isValidationEvidenceArtifact(file)) continue;
		if (tupleId && !file.includes(tupleId)) continue;
		files.push(file);
	}
	return files.sort((left, right) => left.localeCompare(right, "en"));
}

function boundedArray(values, limit) {
	if (!Array.isArray(values)) return [];
	const bounded = values.slice(0, limit);
	if (values.length > limit) {
		bounded.push(`... omitted ${values.length - limit} items`);
	}
	return bounded;
}

function safeJsonStringify(value) {
	try {
		return JSON.stringify(value, null, 2) ?? "null";
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return JSON.stringify({ status: "unserializable_review_handoff", reason }, null, 2);
	}
}

function truncateText(text, maxLength) {
	const value = typeof text === "string" ? text : safeJsonStringify(text);
	if (value.length <= maxLength) return value;
	return `${value.slice(0, Math.max(0, maxLength - 64))}...[truncated ${value.length - maxLength} chars]`;
}

function truncateUtf8Bytes(text, maxBytes) {
	const bytes = new TextEncoder().encode(text);
	if (bytes.byteLength <= maxBytes) return text;
	const suffix = "\n... [truncated to workflow review handoff byte budget]";
	const suffixBytes = new TextEncoder().encode(suffix).byteLength;
	const decoder = new TextDecoder();
	return `${decoder.decode(bytes.slice(0, Math.max(0, maxBytes - suffixBytes)))}${suffix}`;
}

function isLaneEvidenceArtifact(file) {
	return /(^|\/)(core-lane|tests?-lane|docs?-lane|docs?-evidence|lane-hard-stop)[^/]*\.(?:json|md|txt|log)$/iu.test(
		file,
	);
}

function isValidationEvidenceArtifact(file) {
	return /(^|\/)(validation|verify|test|tests)[^/]*\.(?:json|md|txt|log|stdout|stderr)$/iu.test(file);
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
