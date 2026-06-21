const MAX_HANDOFF_BYTES = 12 * 1024;
const RAW_PLAN_MAX_BYTES = 512 * 1024;
const tupleId = await tupleIdFromRunArtifacts();
const suffix = tupleId ? `-${tupleId}` : "";
const rawArtifact = `workflow-output/scope-plan-raw${suffix}.json`;
const handoffArtifact = `workflow-output/scope-plan-handoff${suffix}.json`;
const rawPlan = workflowContext.state?.plan ?? null;
const rawPlanText = safeJsonStringify(rawPlan);
const rawPlanForDisk = truncateUtf8Bytes(rawPlanText, RAW_PLAN_MAX_BYTES);

await Bun.write(rawArtifact, `${rawPlanForDisk}\n`);

const compactPlan = compactValue(rawPlan, 0);
const handoff = {
	status: "compact_plan_handoff",
	producer_node: "materializePlanHandoff",
	raw_plan_artifact: rawArtifact,
	raw_plan_truncated: rawPlanText !== rawPlanForDisk,
	instruction:
		"Use this compact handoff for coordination. Read the raw plan artifact only when needed; do not paste the raw artifact into downstream prompts.",
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
			if (typeof parsed.tupleId === "string" && parsed.tupleId.trim()) return parsed.tupleId.trim();
			if (typeof parsed.tuple_id === "string" && parsed.tuple_id.trim()) return parsed.tuple_id.trim();
		} catch {
			// Try the next source.
		}
	}
	try {
		const taskText = await Bun.file("task.md").text();
		const match = taskText.match(/(?:tuple|tuple id|tuple-id)\s*:\s*([^\n]+)/iu);
		if (match?.[1]?.trim()) return match[1].trim();
	} catch {
		// Tuple ids are optional for local demos.
	}
	return "";
}

function compactValue(value, depth) {
	if (value === null || typeof value === "number" || typeof value === "boolean") return value;
	if (typeof value === "string") return truncateText(value, depth === 0 ? 1600 : 700);
	if (Array.isArray(value)) return compactArray(value, depth);
	if (typeof value === "object") return compactObject(value, depth);
	return String(value);
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
