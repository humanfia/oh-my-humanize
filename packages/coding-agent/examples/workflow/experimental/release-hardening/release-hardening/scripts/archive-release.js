const state = workflowContext.state && typeof workflowContext.state === "object" ? workflowContext.state : {};
const checks = state.checks && typeof state.checks === "object" ? state.checks : {};
const releaseGate = state.releaseGate && typeof state.releaseGate === "object" ? state.releaseGate : {};
const heldForFreshContract = releaseGate.status === "hold";

if (checks.status !== "pass" && !heldForFreshContract) {
	throw new Error("cannot archive release hardening flow before declared checks pass");
}
if (releaseGate.status !== "pass" && !heldForFreshContract) {
	throw new Error("cannot archive release hardening flow before release gate passes");
}

const archivePath = "workflow-output/release-hardening-archive.md";
const taskText = await readOptionalText("task.md");
const checksText = await readOptionalText("workflow-output/release-checks.md");
const rollbackText = await readOptionalText("workflow-output/release-rollback.md");
const gateText = await readOptionalText("workflow-output/release-gate.md");
const outcome = heldForFreshContract ? "rejected" : "accepted";
const validation = heldForFreshContract ? "hold" : "pass";

await Bun.write(
	archivePath,
	[
		"# Release Hardening Archive",
		"",
		`Outcome: ${outcome}`,
		`Validation: ${validation}`,
		"",
		"## Task",
		"",
		boundedLines(taskText, 120),
		"",
		"## Checks",
		"",
		boundedLines(checksText, 160),
		"",
		"## Rollback",
		"",
		rollbackText.trim() ? boundedLines(rollbackText, 120) : "No rollback notes were present.",
		"",
		"## Release Gate",
		"",
		boundedLines(gateText, 120),
		"",
	].join("\n"),
);

return {
	summary: "archived release hardening evidence",
	statePatch: [
		{
			op: "set",
			path: "/archive",
			value: {
				file: archivePath,
				outcome,
				validation,
			},
		},
	],
};

async function readOptionalText(filePath) {
	try {
		return await Bun.file(filePath).text();
	} catch {
		return "";
	}
}

function boundedLines(text, limit) {
	const lines = text.split(/\r?\n/u);
	const kept = lines.slice(0, limit);
	if (lines.length > limit) kept.push(`[truncated ${lines.length - limit} additional lines]`);
	return kept.join("\n");
}
