const taskText = await readText("task.md");
const tupleId = await tupleIdFromRunArtifacts(taskText);
const integrationActivation = latestCompletedActivation("integrationReview");
const status = integrationActivation ? "materialized" : "missing_review_activation";
const changedFiles = await changedProjectFiles();
const diffStat = await gitOutput(["git", "diff", "--stat"]);
const laneArtifacts = await laneEvidenceArtifacts(tupleId);
const validationArtifacts = await validationEvidenceArtifacts(tupleId);
const artifactPath = `workflow-output/integration-review-materialized${tupleId ? `-${tupleId}` : ""}.json`;
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

await Bun.write(artifactPath, `${JSON.stringify(payload, null, 2)}\n`);

return {
	summary:
		status === "materialized"
			? `materialized integration review evidence: ${artifactPath}`
			: `integration review activation missing; wrote diagnostic artifact: ${artifactPath}`,
	verdict: status === "materialized" ? "materialized" : "missing_review_activation",
	data: payload,
	artifacts: [artifactPath],
	statePatch: [{ op: "set", path: "/integrationReviewArtifact", value: payload }],
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

function latestCompletedActivation(nodeId) {
	const activations = workflowContext.completedActivations ?? [];
	for (let index = activations.length - 1; index >= 0; index -= 1) {
		const activation = activations[index];
		if (activation?.nodeId === nodeId && activation.status === "completed") return activation;
	}
	return null;
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
		file.includes("/node_modules/") ||
		file.includes("/.venv/") ||
		file.includes("/.pytest_cache/")
	);
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
