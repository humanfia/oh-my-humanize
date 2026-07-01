const state = workflowContext.state && typeof workflowContext.state === "object" ? workflowContext.state : {};
const validation = state.validation && typeof state.validation === "object" ? state.validation : {};
const validationStartup =
	state.validationStartup && typeof state.validationStartup === "object" ? state.validationStartup : {};
const patch = state.patch && typeof state.patch === "object" ? state.patch : {};
const validationWaiver = await baselineValidationWaiver(validation, validationStartup);

if (validation.status !== "pass" && validationWaiver.status !== "accepted") {
	throw new Error("cannot archive documentation audit flow before task-declared validation passes");
}

const priorReviewFeedback = priorContinueReviewFeedback();
const resolvedReviewFeedback = resolvedReviewFeedbackFromPatch(patch);
if (priorReviewFeedback.length > 0 && resolvedReviewFeedback.length === 0) {
	throw new Error(
		[
			"cannot archive documentation audit flow before prior reviewer feedback has explicit patch resolution evidence",
			`prior feedback: ${priorReviewFeedback.slice(0, 3).join("; ")}`,
		].join("; "),
	);
}

const archivePath = "workflow-output/documentation-audit-archive.md";
const taskText = await readOptionalText("task.md");
const validationText = await readOptionalText("workflow-output/documentation-validation.md");
const rollbackText = await rollbackEvidenceText();
const changedFiles = projectChangedFilesFromPatch(patch);

if (changedFiles.length > 0 && !rollbackText.trim()) {
	throw new Error(
		`cannot archive documentation audit with changed files but no rollback evidence: ${changedFiles.join(", ")}`,
	);
}

await Bun.write(
	archivePath,
	[
		"# Documentation Audit Archive",
		"",
		"## Task",
		"",
		boundedLines(taskText, 120),
		"",
		"## Validation",
		"",
		boundedLines(validationText, 160),
		"",
		...(validationWaiver.status === "accepted"
			? [
					"## Baseline Validation Waiver",
					"",
					"The task-declared validation command is startable but has the same baseline failure before and after the documentation repair. Documentation validation passed, so the archive records this as a baseline waiver rather than attributing it to the docs patch.",
					"",
					`- Startup validation exit code: ${String(validationStartup.validationExitCode ?? "(missing)")}`,
					`- Final validation exit code: ${String(validation.validationExitCode ?? "(missing)")}`,
					`- Evidence signature: ${validationWaiver.signature}`,
					"",
				]
			: []),
		"## Rollback",
		"",
		rollbackText.trim() ? boundedLines(rollbackText, 120) : "No rollback notes were present.",
		"",
		"## Review Repair Evidence",
		"",
		resolvedReviewFeedback.length > 0
			? resolvedReviewFeedback.map(item => `- ${item}`).join("\n")
			: "No prior continue review required explicit repair evidence.",
		"",
	].join("\n"),
);

return {
	summary: "archived documentation audit evidence",
	statePatch: [
		{
			op: "set",
			path: "/archive",
			value: {
				file: archivePath,
				validation: validationWaiver.status === "accepted" ? "baseline-waived" : "pass",
				...(validationWaiver.status === "accepted"
					? { validationWaiver: "startable-baseline-failure", validationSignature: validationWaiver.signature }
					: {}),
				resolvedReviewFeedback,
				rollbackEvidence: rollbackText.trim() ? "present" : "not-required",
			},
		},
	],
};

async function baselineValidationWaiver(finalValidation, startupValidation) {
	if (finalValidation.status === "pass") return { status: "not-needed" };
	if (finalValidation.docsExitCode !== undefined && Number(finalValidation.docsExitCode) !== 0) {
		return { status: "rejected" };
	}
	if (startupValidation.status !== "startable-command-failed") return { status: "rejected" };
	if (
		startupValidation.validationExitCode !== undefined &&
		finalValidation.validationExitCode !== undefined &&
		Number(startupValidation.validationExitCode) !== Number(finalValidation.validationExitCode)
	) {
		return { status: "rejected" };
	}
	const startupText = await readOptionalText(
		startupValidation.outputPath ?? "workflow-output/documentation-validation-startup.md",
	);
	const finalText = [
		await readOptionalText("workflow-output/documentation-validation.md"),
		await readOptionalText(finalValidation.validationStdoutPath ?? ""),
		await readOptionalText(finalValidation.validationStderrPath ?? ""),
	]
		.filter(Boolean)
		.join("\n");
	const signature = sharedFailureSignature(startupText, finalText);
	if (!signature) return { status: "rejected" };
	return { status: "accepted", signature };
}

function sharedFailureSignature(startupText, finalText) {
	const startupSignatures = failureSignatures(startupText);
	const finalSignatures = new Set(failureSignatures(finalText));
	return startupSignatures.find(signature => finalSignatures.has(signature)) ?? "";
}

function failureSignatures(text) {
	return uniqueStrings(
		text
			.split(/\r?\n/u)
			.map(line => line.trim())
			.filter(isUsefulFailureSignature)
			.map(line => line.replace(/\s+/gu, " ").slice(0, 220)),
	);
}

function isUsefulFailureSignature(line) {
	if (line.length < 16) return false;
	return (
		/\b[A-Za-z_][A-Za-z0-9_]*(?:Error|Exception)\b/u.test(line) ||
		/\b(error|failed|failure|exception|importerror|modulenotfounderror|traceback|cannot import)\b/iu.test(line)
	);
}

function priorContinueReviewFeedback() {
	const activations = Array.isArray(workflowContext.completedActivations) ? workflowContext.completedActivations : [];
	const feedback = activations
		.filter(activation => activation?.nodeId === "consistencyReview" && activation.status === "completed")
		.filter(activation => verdictFromOutput(activation.output) === "continue")
		.map(activation => summaryFromOutput(activation.output))
		.filter(Boolean);
	const stateReviewFeedback = priorStateReviewFeedback(state.review);
	if (stateReviewFeedback) feedback.push(stateReviewFeedback);
	return feedback;
}

function priorStateReviewFeedback(value) {
	if (typeof value !== "string") return "";
	const text = value.trim();
	if (!text || /^no previous documentation review yet\.?$/iu.test(text)) return "";
	if (/\bcontinue\b/iu.test(text)) return text;
	return "";
}

function verdictFromOutput(output) {
	if (!output || typeof output !== "object") return "";
	const verdict = output.verdict ?? output.status;
	if (typeof verdict === "string") return verdict.trim().toLowerCase();
	const data = output.data;
	if (data && typeof data === "object") {
		const dataVerdict = data.verdict ?? data.status;
		if (typeof dataVerdict === "string") return dataVerdict.trim().toLowerCase();
	}
	return "";
}

function summaryFromOutput(output) {
	if (!output || typeof output !== "object") return "";
	const summary = output.summary ?? output.reason ?? output.explanation;
	if (typeof summary === "string") return summary.trim();
	const data = output.data;
	if (data && typeof data === "object") {
		const dataSummary = data.summary ?? data.reason ?? data.explanation;
		if (typeof dataSummary === "string") return dataSummary.trim();
	}
	return "";
}

function resolvedReviewFeedbackFromPatch(value) {
	const field = value.resolved_review_feedback ?? value.resolvedReviewFeedback;
	if (Array.isArray(field)) return field.map(reviewFeedbackItemText).filter(Boolean);
	if (typeof field === "string" && field.trim()) return [field.trim()];
	return [];
}

function reviewFeedbackItemText(item) {
	if (typeof item === "string") return item.trim();
	if (!item || typeof item !== "object") return "";
	const feedback = typeof item.feedback === "string" ? item.feedback.trim() : "";
	const evidence = typeof item.evidence === "string" ? item.evidence.trim() : "";
	if (feedback && evidence) return `${feedback} — ${evidence}`;
	return feedback || evidence;
}

async function readOptionalText(filePath) {
	try {
		return await Bun.file(filePath).text();
	} catch {
		return "";
	}
}

async function rollbackEvidenceText() {
	const explicitRollback = (await readOptionalText("workflow-output/documentation-rollback.md")).trim();
	const patchText = await readOptionalText("workflow-output/documentation-patch.md");
	const patchRollbackSection = markdownSection(patchText, "Rollback Notes").trim();
	const patchRollbackLines = rollbackLines(patchText).join("\n").trim();
	const patchRollbackFields = rollbackNotesFromPatch(patch).join("\n").trim();
	return [explicitRollback, patchRollbackFields, patchRollbackSection, patchRollbackLines].filter(Boolean).join("\n\n");
}

function markdownSection(text, heading) {
	const lines = text.split(/\r?\n/u);
	const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const headingPattern = new RegExp(`^#{2,6}\\s+${escapedHeading}\\s*$`, "iu");
	let start = -1;
	for (let index = 0; index < lines.length; index += 1) {
		if (headingPattern.test(lines[index] ?? "")) {
			start = index + 1;
			break;
		}
	}
	if (start < 0) return "";
	const section = [];
	for (const line of lines.slice(start)) {
		if (/^#{1,6}\s+\S/u.test(line)) break;
		section.push(line);
	}
	return section.join("\n").trim();
}

function boundedLines(text, limit) {
	const lines = text.split(/\r?\n/u);
	const kept = lines.slice(0, limit);
	if (lines.length > limit) kept.push(`[truncated ${lines.length - limit} additional lines]`);
	return kept.join("\n");
}

function stringArrayField(value, key) {
	if (!value || typeof value !== "object") return [];
	const field = value[key];
	if (!Array.isArray(field)) return [];
	return field.filter(item => typeof item === "string");
}

function rollbackNotesFromPatch(value) {
	return stringArrayField(value, "rollback_notes").concat(stringArrayField(value, "rollbackNotes"));
}

function rollbackLines(text) {
	return text
		.split(/\r?\n/u)
		.map(line => line.match(/^\s*[-*]?\s*rollback\s+notes?\s*:\s*(.+)$/iu)?.[1]?.trim() ?? "")
		.filter(Boolean);
}

function projectChangedFilesFromPatch(value) {
	return stringArrayField(value, "changed_files")
		.concat(stringArrayField(value, "changedFiles"))
		.filter(isProjectChangedFile);
}

function isProjectChangedFile(filePath) {
	if (!filePath.trim()) return false;
	return !(
		filePath === "task.md" ||
		filePath === "progress.md" ||
		filePath === "manifest-entry.json" ||
		filePath === "monitor-assignment.json" ||
		filePath.startsWith("workflow-output/") ||
		filePath.startsWith("transcripts/")
	);
}

function uniqueStrings(values) {
	return [...new Set(values)];
}
