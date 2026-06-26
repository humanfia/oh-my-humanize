const state = workflowContext.state && typeof workflowContext.state === "object" ? workflowContext.state : {};
const reproduction = state.reproduction && typeof state.reproduction === "object" ? state.reproduction : {};
const variant = state.variant && typeof state.variant === "object" ? state.variant : {};
const structuredEvidence = await readStructuredEvidence(reproduction, variant);

if (reproduction.exercised !== true || structuredEvidence.reproduction.exercised !== true) {
	throw new Error("cannot archive research reproduction before the Reproduction Command exercises the declared claim");
}
if (variant.validationExercised !== true || structuredEvidence.validation.exercised !== true) {
	throw new Error("cannot archive research reproduction before the Validation Command exercises the declared claim");
}

const outcome = reproduction.status === "pass" && variant.status === "pass" ? "accepted" : "rejected";

const outputPath = "workflow-output/reproduction-archive.md";
const precheck = await readOptionalText("workflow-output/reproduction-precheck.md");
const setup = await readOptionalText("workflow-output/reproduction-setup.md");
const baseline = await readOptionalText("workflow-output/reproduction-baseline.md");
const variantText = await readOptionalText("workflow-output/reproduction-variant.md");

await Bun.write(
	outputPath,
	[
		"# Research Reproduction Archive",
		"",
		`Outcome: ${outcome}`,
		`Reproduction status: ${String(reproduction.status ?? "unknown")}`,
		`Validation status: ${String(variant.status ?? "unknown")}`,
		"",
		"## Precheck",
		"",
		boundedLines(precheck, 100),
		"",
		"## Setup",
		"",
		boundedLines(setup, 100),
		"",
		"## Reproduction",
		"",
		boundedLines(baseline, 160),
		"",
		"## Variant And Validation",
		"",
		boundedLines(variantText, 160),
		"",
		"## Structured Evidence Summary",
		"",
		`- reproduction exercised: ${structuredEvidence.reproduction.exercised}`,
		`- reproduction positive signals: ${structuredEvidence.reproduction.positiveSignals.join(", ") || "none"}`,
		`- reproduction ok packages: ${structuredEvidence.reproduction.okPackages}`,
		`- validation exercised: ${structuredEvidence.validation.exercised}`,
		`- validation positive signals: ${structuredEvidence.validation.positiveSignals.join(", ") || "none"}`,
		`- validation ok packages: ${structuredEvidence.validation.okPackages}`,
		"",
	].join("\n"),
);

return {
	summary: `archived ${outcome} research reproduction evidence`,
	statePatch: [
		{
			op: "set",
			path: "/archive",
			value: {
				file: outputPath,
				outcome,
				reproduction: String(reproduction.status ?? "unknown"),
				validation: String(variant.status ?? "unknown"),
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

async function readStructuredEvidence(reproductionState, variantState) {
	const reproductionEvidence = await readRequiredJson(reproductionState.evidencePath, "reproduction structured evidence");
	const variantEvidence = await readRequiredJson(variantState.evidencePath, "variant structured evidence");
	const reproductionSummary = reproductionEvidence.exerciseSummary ?? {};
	const validationSummary = variantEvidence.validationExerciseSummary ?? {};
	return {
		reproduction: normalizeExerciseSummary(reproductionSummary),
		validation: normalizeExerciseSummary(validationSummary),
	};
}

async function readRequiredJson(filePath, label) {
	if (typeof filePath !== "string" || filePath.trim() === "") {
		throw new Error(`cannot archive research reproduction without ${label} path`);
	}
	try {
		return await Bun.file(filePath).json();
	} catch (error) {
		throw new Error(`cannot read ${label}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function normalizeExerciseSummary(summary) {
	return {
		exercised: summary.exercised === true,
		positiveSignals: Array.isArray(summary.positiveSignals) ? summary.positiveSignals.map(String) : [],
		negativeSignals: summary.negativeSignals === true,
		okPackages: Number.isFinite(summary.okPackages) ? summary.okPackages : 0,
		passedCounts: Number.isFinite(summary.passedCounts) ? summary.passedCounts : 0,
	};
}

function boundedLines(text, limit) {
	const lines = text.split(/\r?\n/u);
	const kept = lines.slice(0, limit);
	if (lines.length > limit) kept.push(`[truncated ${lines.length - limit} additional lines]`);
	return kept.join("\n");
}
