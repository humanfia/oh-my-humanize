let taskText = "";
try {
	taskText = await Bun.file("task.md").text();
} catch {
	taskText = "";
}

const taskContract = taskText.trim();
if (!taskContract) {
	throw new Error("kda-humanize requires a task.md contract in the project root");
}
assertTaskContract(taskContract);

const recordedAtMs = Date.now();

return {
	summary: "loaded KDA task contract from task.md",
	statePatch: [
		{ op: "set", path: "/taskContract", value: taskContract.slice(0, 8000) },
		{
			op: "set",
			path: "/kda/runtime",
			value: {
				startedAtMs: recordedAtMs,
				elapsedMs: 0,
			},
		},
	],
};

function assertTaskContract(text) {
	const missing = [];
	if (!hasHeadingOrField(text, "objective")) missing.push("Objective");
	if (!hasHeadingOrField(text, "acceptance criteria")) missing.push("Acceptance Criteria");
	if (!hasValidationContract(text)) missing.push("Validation Command or Manual Evidence Allowed");
	if (!hasHeadingOrField(text, "stop conditions")) missing.push("Stop Conditions");
	if (!hasHeadingOrField(text, "rollback plan") && !hasHeadingOrField(text, "metric")) {
		missing.push("Rollback Plan or Metric");
	}
	if (missing.length > 0) {
		throw new Error(`kda-humanize task.md missing required contract fields: ${missing.join(", ")}`);
	}
}

function hasValidationContract(text) {
	return hasHeadingOrField(text, "validation command") || hasHeadingOrField(text, "manual evidence allowed");
}

function hasHeadingOrField(text, label) {
	const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const pattern = new RegExp(`(^|\\n)\\s*(?:#+\\s*)?${escaped}\\s*:`, "iu");
	const headingPattern = new RegExp(`^\\s*#+\\s*${escaped}\\s*$`, "imu");
	return pattern.test(text) || headingPattern.test(text);
}
