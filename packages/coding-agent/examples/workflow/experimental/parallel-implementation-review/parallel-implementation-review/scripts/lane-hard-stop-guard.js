const tupleId = await tupleIdFromRunArtifacts();
const hardStopResult = await laneHardStopArtifacts(tupleId);
const hardStopArtifacts = hardStopResult.active;
const artifactPath = `workflow-output/lane-hard-stop-guard${tupleId ? `-${tupleId}` : ""}.json`;
const diagnostic = {
	tuple_id: tupleId,
	producer_node: "laneHardStopGuard",
	producer_kind: "workflow-script",
	status: hardStopArtifacts.length > 0 ? "hard_stop" : "continue",
	hard_stop_artifacts: hardStopArtifacts,
	ignored_historical_hard_stop_artifacts: hardStopResult.ignored,
	checked_at_ms: Date.now(),
};

await Bun.write(artifactPath, `${JSON.stringify(diagnostic, null, 2)}\n`);

if (hardStopArtifacts.length > 0) {
	await Bun.write(
		"workflow-output/tuple-state.json",
		`${JSON.stringify(
			{
				tuple_id: tupleId,
				flow: "parallel-implementation-review",
				status: "hard_stop",
				terminal: true,
				reason: "parallel lane hard stop reported",
				terminal_artifacts: hardStopArtifacts,
				guard_artifact: artifactPath,
				checked_at_ms: Date.now(),
			},
			null,
			2,
		)}\n`,
	);
	throw new Error(`parallel lane hard stop reported; see ${artifactPath}`);
}

return {
	summary: "no parallel lane hard stop reported",
	verdict: "continue",
	data: {
		artifact: artifactPath,
		producer_node: "laneHardStopGuard",
		status: "continue",
	},
	statePatch: [{ op: "set", path: "/laneHardStopGuard", value: diagnostic }],
};

async function laneHardStopArtifacts(tupleId) {
	const glob = new Bun.Glob("workflow-output/lane-hard-stop-*.json");
	const active = [];
	const ignored = [];
	for await (const filePath of glob.scan({ cwd: process.cwd(), onlyFiles: true })) {
		if (tupleId && !filePath.includes(tupleId)) continue;
		const classification = await hardStopClassification(filePath);
		if (classification === "active") active.push(filePath);
		if (classification === "superseded") ignored.push(filePath);
	}
	return {
		active: active.sort((left, right) => left.localeCompare(right, "en")),
		ignored: ignored.sort((left, right) => left.localeCompare(right, "en")),
	};
}

async function hardStopClassification(filePath) {
	try {
		const data = await Bun.file(filePath).json();
		const isHardStop = stringField(data, "status") === "hard_stop" || stringField(data, "verdict") === "hard_stop";
		if (!isHardStop) return "none";
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

async function tupleIdFromRunArtifacts() {
	const monitorTuple = await tupleIdFromJsonFile("monitor-assignment.json");
	if (monitorTuple) return monitorTuple;
	const manifestTuple = await tupleIdFromJsonFile("manifest-entry.json");
	if (manifestTuple) return manifestTuple;
	try {
		const taskText = await Bun.file("task.md").text();
		const taskTuple = /(?:tuple|monitor)[^A-Za-z0-9]+([A-Z][0-9]{2}-T[0-9]{2}(?:-[A-Za-z0-9]+)?)/u.exec(taskText);
		if (taskTuple?.[1]) return taskTuple[1];
	} catch {
		// Tuple IDs are optional for ad hoc local use.
	}
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
