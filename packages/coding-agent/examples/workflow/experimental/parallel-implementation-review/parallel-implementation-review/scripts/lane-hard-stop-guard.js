const tupleId = await tupleIdFromRunArtifacts();
const laneReadiness = await requiredLaneEvidence(tupleId);
const hardStopResult = await laneHardStopArtifacts(tupleId);
const hardStopArtifacts = hardStopResult.active;
const reservedFinalArtifacts = await reservedFinalArtifactFiles(tupleId);
const quarantinedReservedFinalArtifacts = await quarantineReservedFinalArtifacts(reservedFinalArtifacts);
const hasBlockingArtifacts =
	hardStopArtifacts.length > 0 ||
	reservedFinalArtifacts.length > 0 ||
	laneReadiness.missing.length > 0 ||
	laneReadiness.blocking.length > 0;
const artifactPath = `workflow-output/lane-hard-stop-guard${tupleId ? `-${tupleId}` : ""}.json`;
const diagnostic = {
	tuple_id: tupleId,
	producer_node: "laneHardStopGuard",
	producer_kind: "workflow-script",
	status: hasBlockingArtifacts ? "hard_stop" : "continue",
	lane_artifacts: laneReadiness.present,
	missing_lane_artifacts: laneReadiness.missing,
	blocking_lane_artifacts: laneReadiness.blocking,
	hard_stop_artifacts: hardStopArtifacts,
	reserved_final_artifacts: reservedFinalArtifacts,
	quarantined_reserved_final_artifacts: quarantinedReservedFinalArtifacts,
	ignored_historical_hard_stop_artifacts: hardStopResult.ignored,
	ignored_nonterminal_hard_stop_artifacts: hardStopResult.nonterminal,
	checked_at_ms: Date.now(),
};

await Bun.write(artifactPath, `${JSON.stringify(diagnostic, null, 2)}\n`);

if (hasBlockingArtifacts) {
	const blockers = [
		...hardStopArtifacts,
		...reservedFinalArtifacts,
		...laneReadiness.missing.map(item => `${item.lane}:missing-lane-evidence`),
		...laneReadiness.blocking.map(item => `${item.file}:${item.status || item.reason}`),
	].sort((left, right) => left.localeCompare(right, "en"));
	return {
		summary: `parallel lane hard stop reported: ${blockers.join(", ")}`,
		verdict: "hard_stop",
		data: {
			artifact: artifactPath,
			producer_node: "laneHardStopGuard",
			status: "hard_stop",
			lane_artifacts: laneReadiness.present,
			missing_lane_artifacts: laneReadiness.missing,
			blocking_lane_artifacts: laneReadiness.blocking,
			hard_stop_artifacts: hardStopArtifacts,
			reserved_final_artifacts: reservedFinalArtifacts,
			quarantined_reserved_final_artifacts: quarantinedReservedFinalArtifacts,
		},
		statePatch: [{ op: "set", path: "/laneHardStopGuard", value: diagnostic }],
	};
}

return {
	summary: "no parallel lane hard stop reported",
	verdict: "continue",
	data: {
		artifact: artifactPath,
		producer_node: "laneHardStopGuard",
		status: "continue",
		lane_artifacts: laneReadiness.present,
	},
	statePatch: [{ op: "set", path: "/laneHardStopGuard", value: diagnostic }],
};

async function requiredLaneEvidence(tupleId) {
	if (!tupleId) {
		return {
			present: [],
			missing: [],
			blocking: [],
		};
	}

	const workflowFiles = await workflowOutputFiles();
	const present = [];
	const missing = [];
	const blocking = [];
	for (const lane of requiredLanes(tupleId)) {
		const artifacts = workflowFiles.filter(filePath => lane.pattern.test(artifactBasename(filePath)));
		if (artifacts.length === 0) {
			missing.push({
				lane: lane.id,
				accepted_artifacts: lane.acceptedArtifacts,
			});
			continue;
		}
		for (const artifact of artifacts) {
			const classification = await laneArtifactClassification(artifact);
			const record = {
				lane: lane.id,
				file: artifact,
				status: classification.status,
				validation_status: classification.validationStatus,
				validation_exit_code: classification.validationExitCode,
			};
			present.push(record);
			if (classification.blockingReason) {
				blocking.push({
					...record,
					reason: classification.blockingReason,
				});
			}
		}
	}

	return {
		present: present.sort(compareLaneArtifacts),
		missing: missing.sort((left, right) => left.lane.localeCompare(right.lane, "en")),
		blocking: blocking.sort(compareLaneArtifacts),
	};
}

function requiredLanes(tupleId) {
	return [
		{
			id: "implementCore",
			pattern: new RegExp(`^(?:core-lane|lane-implementCore).*${escapeRegExp(tupleId)}.*\\.json$`, "iu"),
			acceptedArtifacts: [`workflow-output/core-lane-${tupleId}.json`, `workflow-output/lane-implementCore-${tupleId}.json`],
		},
		{
			id: "implementTests",
			pattern: new RegExp(`^(?:tests?-lane|lane-implementTests).*${escapeRegExp(tupleId)}.*\\.json$`, "iu"),
			acceptedArtifacts: [`workflow-output/tests-lane-${tupleId}.json`, `workflow-output/lane-implementTests-${tupleId}.json`],
		},
		{
			id: "implementDocs",
			pattern: new RegExp(`^(?:docs?-lane|lane-implementDocs).*${escapeRegExp(tupleId)}.*\\.json$`, "iu"),
			acceptedArtifacts: [`workflow-output/docs-lane-${tupleId}.json`, `workflow-output/lane-implementDocs-${tupleId}.json`],
		},
	];
}

async function workflowOutputFiles() {
	const files = [];
	try {
		const glob = new Bun.Glob("workflow-output/**");
		for await (const filePath of glob.scan({ cwd: process.cwd(), onlyFiles: true })) {
			if (filePath.startsWith("workflow-output/tmp/")) continue;
			if (filePath.startsWith("workflow-output/quarantined-premature-final-artifacts/")) continue;
			files.push(filePath);
		}
	} catch {
		return [];
	}
	return files.sort((left, right) => left.localeCompare(right, "en"));
}

async function laneArtifactClassification(filePath) {
	if (!filePath.endsWith(".json")) {
		return {
			status: "",
			validationStatus: "",
			validationExitCode: null,
			blockingReason: "",
		};
	}

	try {
		const data = await Bun.file(filePath).json();
		const status = normalizedStatus(stringField(data, "status") || stringField(data, "verdict") || stringField(data, "result"));
		const validation = objectField(data, "validation");
		const validationStatus = normalizedStatus(
			stringField(validation, "status") || stringField(validation, "result") || stringField(validation, "verdict"),
		);
		const validationExitCode = numberField(validation, "exitCode") ?? numberField(validation, "exit_code");
		if (isBlockingStatus(status)) {
			return {
				status,
				validationStatus,
				validationExitCode,
				blockingReason: "lane artifact reports a blocking status",
			};
		}
		if (isBlockingStatus(validationStatus)) {
			return {
				status,
				validationStatus,
				validationExitCode,
				blockingReason: "lane validation reports a blocking status",
			};
		}
		if (validationExitCode !== null && validationExitCode !== 0 && !isPassingStatus(validationStatus)) {
			return {
				status,
				validationStatus,
				validationExitCode,
				blockingReason: "lane validation recorded a non-zero exit code without a passing status",
			};
		}
		return {
			status,
			validationStatus,
			validationExitCode,
			blockingReason: "",
		};
	} catch {
		return {
			status: "",
			validationStatus: "",
			validationExitCode: null,
			blockingReason: "lane artifact is not readable JSON",
		};
	}
}

async function laneHardStopArtifacts(tupleId) {
	const glob = new Bun.Glob("workflow-output/lane-hard-stop-*.json");
	const active = [];
	const ignored = [];
	const nonterminal = [];
	for await (const filePath of glob.scan({ cwd: process.cwd(), onlyFiles: true })) {
		if (isLaneHardStopGuardArtifact(filePath)) continue;
		if (tupleId && !filePath.includes(tupleId)) continue;
		const classification = await hardStopClassification(filePath);
		if (classification === "active") active.push(filePath);
		if (classification === "superseded") ignored.push(filePath);
		if (classification === "nonterminal") nonterminal.push(filePath);
	}
	return {
		active: active.sort((left, right) => left.localeCompare(right, "en")),
		ignored: ignored.sort((left, right) => left.localeCompare(right, "en")),
		nonterminal: nonterminal.sort((left, right) => left.localeCompare(right, "en")),
	};
}

async function reservedFinalArtifactFiles(tupleId) {
	const files = [];
	try {
		const glob = new Bun.Glob("workflow-output/**");
		for await (const filePath of glob.scan({ cwd: process.cwd(), onlyFiles: true })) {
			if (filePath.startsWith("workflow-output/tmp/")) continue;
			if (filePath.startsWith("workflow-output/quarantined-premature-final-artifacts/")) continue;
			if (!isReservedFinalArtifact(filePath)) continue;
			if (tupleId && hasOtherTupleId(filePath, tupleId)) continue;
			files.push(filePath);
		}
	} catch {
		return [];
	}
	return files.sort((left, right) => left.localeCompare(right, "en"));
}

async function quarantineReservedFinalArtifacts(files) {
	const preserved = [];
	for (const file of files) {
		const quarantine = `workflow-output/quarantined-premature-final-artifacts/${artifactBasename(file)}`;
		await Bun.write(quarantine, await Bun.file(file).text());
		await Bun.file(file).delete();
		preserved.push({ original: file, quarantine });
	}
	return preserved;
}

function isReservedFinalArtifact(filePath) {
	if (/(^|\/)final-rollback-coverage[^/]*\.(?:json|md|txt)$/iu.test(filePath)) return false;
	return /(^|\/)(?:(?:strong-review|promotion-decision)[^/]*|[^/]*final-[^/]*)\.(?:json|md|txt)$/iu.test(filePath);
}

function hasOtherTupleId(filePath, tupleId) {
	const tupleMatches = filePath.match(/[A-Z][0-9]{2}-T[0-9]{2}(?:-[A-Za-z0-9]+)?/gu) ?? [];
	return tupleMatches.length > 0 && !tupleMatches.includes(tupleId);
}

function artifactBasename(filePath) {
	return filePath.split("/").pop()?.replace(/[^\w.-]/gu, "_") || "artifact";
}

async function hardStopClassification(filePath) {
	try {
		const data = await Bun.file(filePath).json();
		const isHardStop = stringField(data, "status") === "hard_stop" || stringField(data, "verdict") === "hard_stop";
		if (!isHardStop) return "none";
		if (!isWorkflowTerminalHardStop(data)) return "nonterminal";
		if (await hasSupersedingEvidence(data)) return "superseded";
		return "active";
	} catch {
		return "none";
	}
}

async function hasSupersedingEvidence(data) {
	const supersededBy = stringField(data, "superseded_by");
	if (!supersededBy.startsWith("workflow-output/")) return false;
	if (supersededBy.includes("..")) return false;
	try {
		return await Bun.file(supersededBy).exists();
	} catch {
		return false;
	}
}

function isWorkflowTerminalHardStop(data) {
	const terminalScope = stringField(data, "terminal_scope");
	if (terminalScope) return terminalScope === "workflow";
	return data?.workflow_terminal === true;
}

async function tupleIdFromRunArtifacts() {
	const monitorTuple = await tupleIdFromJsonFile("monitor-assignment.json");
	if (monitorTuple) return monitorTuple;
	const manifestTuple = await tupleIdFromJsonFile("manifest-entry.json");
	if (manifestTuple) return manifestTuple;
	try {
		const taskText = await Bun.file("task.md").text();
		const taskTuple = tupleIdFromTaskText(taskText);
		if (taskTuple) return taskTuple;
	} catch {
		// Tuple IDs are optional for ad hoc local use.
	}
	return "";
}

function isLaneHardStopGuardArtifact(filePath) {
	return /(^|\/)lane-hard-stop-guard[^/]*\.json$/iu.test(filePath);
}

function compareLaneArtifacts(left, right) {
	return `${left.lane}:${left.file}`.localeCompare(`${right.lane}:${right.file}`, "en");
}

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function normalizedStatus(value) {
	return typeof value === "string" ? value.trim().toLowerCase().replace(/\s+/gu, "_") : "";
}

function isBlockingStatus(value) {
	return [
		"blocked",
		"error",
		"fail",
		"failed",
		"fail_closed",
		"fail-closed",
		"hard_stop",
		"hard-stop",
		"invalid",
		"rejected",
		"validation_failed",
		"validation-failed",
	].includes(value);
}

function isPassingStatus(value) {
	return ["complete", "completed", "continue", "pass", "passed", "ready"].includes(value);
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

function stringField(value, key) {
	if (!value || typeof value !== "object") return "";
	const field = value[key];
	return typeof field === "string" ? field : "";
}

function objectField(value, key) {
	if (!value || typeof value !== "object") return {};
	const field = value[key];
	return field && typeof field === "object" ? field : {};
}

function numberField(value, key) {
	if (!value || typeof value !== "object") return null;
	const field = value[key];
	return typeof field === "number" && Number.isFinite(field) ? field : null;
}
