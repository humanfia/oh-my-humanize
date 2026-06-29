const MAX_HANDOFF_BYTES = 12 * 1024;
const RAW_PLAN_MAX_BYTES = 512 * 1024;
const tupleId = await tupleIdFromRunArtifacts();
if (!tupleId) {
	throw new Error(
		"parallel-implementation-review requires a canonical tuple id before materializing tuple-scoped scope handoff artifacts",
	);
}
const suffix = tupleId ? `-${tupleId}` : "";
const rawArtifact = `workflow-output/scope-plan-raw${suffix}.json`;
const handoffArtifact = `workflow-output/scope-plan-handoff${suffix}.json`;
const rawPlan = workflowContext.state?.plan ?? null;
if (rawPlan === null || rawPlan === undefined) {
	throw new Error("parallel-implementation-review scope plan is missing; refusing to fan out parallel lanes");
}
const rawPlanText = safeJsonStringify(rawPlan);
const rawPlanForDisk = truncateUtf8Bytes(rawPlanText, RAW_PLAN_MAX_BYTES);

await Bun.write(rawArtifact, `${rawPlanForDisk}\n`);

const compactPlan = planWithCanonicalTupleId(compactValue(rawPlan, 0), tupleId);
const handoff = {
	status: "compact_plan_handoff",
	producer_node: "materializePlanHandoff",
	canonical_tuple_id: tupleId,
	raw_plan_artifact: rawArtifact,
	raw_plan_truncated: rawPlanText !== rawPlanForDisk,
	instruction:
		"Use this compact handoff for coordination. Read the raw plan artifact only when needed; do not paste the raw artifact into downstream prompts. Use canonical_tuple_id for every tuple-scoped workflow-output artifact.",
	plan: compactPlan,
};
let handoffText = safeJsonStringify(handoff);
handoffText = truncateUtf8Bytes(handoffText, MAX_HANDOFF_BYTES);
await Bun.write(handoffArtifact, `${handoffText}\n`);

return {
	summary: `compact scope handoff materialized at ${handoffArtifact}`,
	statePatch: [{ op: "set", path: "/planHandoff", value: handoffText }],
	data: {
		artifact: handoffArtifact,
		raw_plan_artifact: rawArtifact,
		max_handoff_bytes: MAX_HANDOFF_BYTES,
		handoff_bytes: new TextEncoder().encode(handoffText).byteLength,
	},
};

async function tupleIdFromRunArtifacts() {
	for (const file of ["monitor-assignment.json", "manifest-entry.json"]) {
		try {
			const parsed = await Bun.file(file).json();
			const tupleId =
				normalizeTupleId(parsed.tupleId) ||
				normalizeTupleId(parsed.tuple_id) ||
				normalizeTupleId(parsed.runId) ||
				normalizeTupleId(parsed.run_id);
			if (tupleId) return tupleId;
		} catch {
			// Try the next source.
		}
	}
	try {
		const taskText = await Bun.file("task.md").text();
		const taskTuple = tupleIdFromTaskText(taskText);
		if (taskTuple) return taskTuple;
	} catch {
		// Tuple ids are optional for local demos.
	}
	return "";
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

function compactValue(value, depth) {
	if (value === null || typeof value === "number" || typeof value === "boolean") return value;
	if (typeof value === "string") return truncateText(value, depth === 0 ? 1600 : 700);
	if (Array.isArray(value)) return compactArray(value, depth);
	if (typeof value === "object") return compactObject(value, depth);
	return String(value);
}

function planWithCanonicalTupleId(plan, canonicalTupleId) {
	if (!canonicalTupleId) return plan;
	if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
		return {
			canonical_tuple_id: canonicalTupleId,
			tuple_id: canonicalTupleId,
			tuple: canonicalTupleId,
			plan,
		};
	}
	return {
		...plan,
		canonical_tuple_id: canonicalTupleId,
		tuple_id: canonicalTupleId,
		tuple: canonicalTupleId,
	};
}

function compactArray(values, depth) {
	const limit = depth === 0 ? 14 : 8;
	const result = values.slice(0, limit).map(value => compactValue(value, depth + 1));
	if (values.length > limit) {
		result.push({ __omitted_items: values.length - limit });
	}
	return result;
}

function compactObject(value, depth) {
	const result = {};
	const entries = Object.entries(value);
	const limit = depth === 0 ? 18 : 10;
	for (const [key, child] of entries.slice(0, limit)) {
		result[key] = compactValue(child, depth + 1);
	}
	if (entries.length > limit) {
		result.__omitted_keys = entries.slice(limit).map(([key]) => key);
	}
	return result;
}

function safeJsonStringify(value) {
	try {
		return JSON.stringify(value, null, 2) ?? "null";
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return JSON.stringify({ status: "unserializable_plan", reason }, null, 2);
	}
}

function truncateText(text, maxLength) {
	if (text.length <= maxLength) return text;
	return `${text.slice(0, Math.max(0, maxLength - 64))}...[truncated ${text.length - maxLength} chars]`;
}

function truncateUtf8Bytes(text, maxBytes) {
	const bytes = new TextEncoder().encode(text);
	if (bytes.byteLength <= maxBytes) return text;
	const suffix = "\n... [truncated to workflow handoff byte budget]";
	const suffixBytes = new TextEncoder().encode(suffix).byteLength;
	const decoder = new TextDecoder();
	return `${decoder.decode(bytes.slice(0, Math.max(0, maxBytes - suffixBytes)))}${suffix}`;
}
