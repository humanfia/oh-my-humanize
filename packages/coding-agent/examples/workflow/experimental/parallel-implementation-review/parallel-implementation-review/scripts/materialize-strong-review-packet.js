const MAX_STRONG_REVIEW_PACKET_BYTES = 18 * 1024;

const taskText = await readText("task.md");
const tupleId = await tupleIdFromRunArtifacts(taskText);
const state = workflowContext.state ?? {};
const taskContract = stringifyForPacket(state.taskContract);
const planHandoff = stringifyForPacket(state.planHandoff);
const reviewHandoff = stringifyForPacket(state.reviewHandoff);
const evidenceContract = recordValue(state.evidenceContract);
const evidenceContractText = stringifyForPacket(evidenceContract);
const artifact = `workflow-output/strong-review-packet${tupleId ? `-${tupleId}` : ""}.md`;
const packet = boundedStrongReviewPacket({
	tupleId,
	artifact,
	taskContract,
	planHandoff,
	reviewHandoff,
	evidenceContract,
	evidenceContractText,
});

await Bun.write(artifact, `${packet}\n`);

const packetBytes = new TextEncoder().encode(packet).byteLength;
const resultData = {
	tuple_id: tupleId,
	artifact,
	producer_node: "materializeStrongReviewPacket",
	producer_kind: "workflow-script",
	packet_bytes: packetBytes,
	budget_bytes: MAX_STRONG_REVIEW_PACKET_BYTES,
	evidence_contract_verdict: stringField(evidenceContract, "verdict") || stringField(evidenceContract, "status"),
	review_handoff_artifacts: extractArtifactRefs(reviewHandoff).slice(0, 20),
	checked_at_ms: Date.now(),
};

return {
	summary: `materialized bounded strong review packet: ${artifact} (${packetBytes} bytes)`,
	verdict: "ready",
	data: resultData,
	statePatch: [{ op: "set", path: "/strongReviewPacket", value: packet }],
};

async function readText(filePath) {
	try {
		return await Bun.file(filePath).text();
	} catch {
		return "";
	}
}

async function tupleIdFromRunArtifacts(fallbackText) {
	const monitorTuple = await tupleIdFromJsonFile("monitor-assignment.json");
	if (monitorTuple) return monitorTuple;
	const manifestTuple = await tupleIdFromJsonFile("manifest-entry.json");
	if (manifestTuple) return manifestTuple;
	const taskTuple = tupleIdFromTaskText(fallbackText);
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

function boundedStrongReviewPacket(input) {
	const evidenceVerdict = stringField(input.evidenceContract, "verdict") || stringField(input.evidenceContract, "status");
	const reasons = arrayField(input.evidenceContract, "reasons").slice(0, 20);
	const checkedInputs = recordValue(input.evidenceContract.checked_inputs);
	const changedFiles = arrayField(input.evidenceContract, "changed_files");
	const evidenceFiles = arrayField(input.evidenceContract, "evidence_files");
	const reviewRefs = extractArtifactRefs(input.reviewHandoff);
	const planRefs = extractArtifactRefs(input.planHandoff);
	const evidenceRefs = extractArtifactRefs(input.evidenceContractText);
	const lines = [
		"# Strong review packet",
		"",
		`Tuple: ${input.tupleId || "(unknown)"}`,
		`Packet artifact: ${input.artifact}`,
		"Purpose: give the final strong reviewer enough bounded evidence to decide promote/reject.",
		"Raw evidence remains in the durable artifact paths below; do not ask the runtime to inline raw artifacts.",
		"",
		`Evidence contract verdict: ${evidenceVerdict || "(missing)"}`,
		"",
		"Evidence contract reasons:",
		...(reasons.length > 0 ? reasons.map(reason => `- ${stringifyForPacket(reason)}`) : ["- (none)"]),
		"",
		"Durable artifact references:",
		...artifactSection("plan handoff", planRefs),
		...artifactSection("review handoff", reviewRefs),
		...artifactSection("evidence contract", evidenceRefs),
		`- strong review packet: ${input.artifact}`,
		"",
		"Changed project files:",
		...boundedList(changedFiles, 40, "changed files omitted"),
		"",
		"Lane artifacts:",
		...boundedList(arrayField(checkedInputs, "lane_artifacts"), 50, "lane artifacts omitted"),
		"",
		"Validation artifacts:",
		...boundedList(arrayField(checkedInputs, "validation_artifacts"), 50, "validation artifacts omitted"),
		"",
		"Trusted final validation artifacts:",
		...boundedList(arrayField(checkedInputs, "trusted_final_validation_artifacts"), 30, "trusted validation artifacts omitted"),
		"",
		"Rollback artifacts:",
		...boundedList(arrayField(checkedInputs, "rollback_artifacts"), 30, "rollback artifacts omitted"),
		"",
		"Task contract excerpt:",
		truncateText(input.taskContract, 2400),
		"",
		"Compact plan handoff excerpt:",
		truncateText(input.planHandoff, 2400),
		"",
		"Bounded review handoff excerpt:",
		truncateText(input.reviewHandoff, 5200),
		"",
		"Evidence contract excerpt:",
		truncateText(input.evidenceContractText, 2400),
		"",
		"Strong review checklist:",
		"- Promote only when task contract, lane outputs, declared validation, rollback coverage, and evidence guard are coherent.",
		"- Reject when evidence is missing, guard verdict is REPAIR, validation failed, lanes conflict, or work is smoke/demo evidence.",
		"- If this packet is insufficient, inspect the durable artifact paths listed above and decide from those paths.",
	];
	return truncateUtf8Bytes(lines.join("\n"), MAX_STRONG_REVIEW_PACKET_BYTES);
}

function artifactSection(label, refs) {
	const boundedRefs = refs.slice(0, 20);
	if (boundedRefs.length === 0) return [`- ${label}: (none referenced)`];
	const lines = boundedRefs.map(ref => `- ${label}: ${ref}`);
	if (refs.length > boundedRefs.length) lines.push(`- ${label}: ... ${refs.length - boundedRefs.length} artifact references omitted`);
	return lines;
}

function boundedList(values, limit, omittedLabel) {
	const strings = values.map(value => stringifyForPacket(value));
	const bounded = strings.slice(0, limit).map(value => `- ${value}`);
	if (bounded.length === 0) bounded.push("- (none)");
	if (strings.length > limit) bounded.push(`- ${strings.length - limit} ${omittedLabel}`);
	return bounded;
}

function extractArtifactRefs(text) {
	const refs = new Set();
	for (const match of stringifyForPacket(text).matchAll(/workflow-output\/[A-Za-z0-9._/@=:+,-]+/gu)) {
		refs.add(match[0].replace(/[),.;:]+$/u, ""));
	}
	return Array.from(refs).sort((left, right) => left.localeCompare(right, "en"));
}

function recordValue(value) {
	if (value && typeof value === "object" && !Array.isArray(value)) return value;
	return {};
}

function arrayField(value, key) {
	const record = recordValue(value);
	const field = record[key];
	return Array.isArray(field) ? field : [];
}

function stringField(value, key) {
	const record = recordValue(value);
	const field = record[key];
	return typeof field === "string" ? field : "";
}

function stringifyForPacket(value) {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value, null, 2) ?? "null";
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return JSON.stringify({ status: "unserializable", reason }, null, 2);
	}
}

function truncateText(text, maxLength) {
	const value = stringifyForPacket(text);
	if (value.length <= maxLength) return value;
	return `${value.slice(0, Math.max(0, maxLength - 64))}...[truncated ${value.length - maxLength} chars]`;
}

function truncateUtf8Bytes(text, maxBytes) {
	const bytes = new TextEncoder().encode(text);
	if (bytes.byteLength <= maxBytes) return text;
	const suffix = "\n... [truncated to strong review packet byte budget]";
	const suffixBytes = new TextEncoder().encode(suffix).byteLength;
	const decoder = new TextDecoder();
	return `${decoder.decode(bytes.slice(0, Math.max(0, maxBytes - suffixBytes)))}${suffix}`;
}
