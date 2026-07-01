const state = workflowContext.state && typeof workflowContext.state === "object" ? workflowContext.state : {};
const reproduction = state.reproduction && typeof state.reproduction === "object" ? state.reproduction : {};
const variant = state.variant && typeof state.variant === "object" ? state.variant : {};
const comparison = state.comparison && typeof state.comparison === "object" ? state.comparison : {};
const structuredEvidence = await readStructuredEvidence(reproduction, variant);

if (reproduction.exercised !== true || structuredEvidence.reproduction.exercised !== true) {
	throw new Error("cannot archive research reproduction before the Reproduction Command exercises the declared claim");
}
if (variant.validationExercised !== true || structuredEvidence.validation.exercised !== true) {
	throw new Error("cannot archive research reproduction before the Validation Command exercises the declared claim");
}
if (hasNegativeControlCommand(variant) && structuredEvidence.negativeControl.exercised !== true) {
	throw new Error("cannot archive research reproduction before the Negative Control Command exercises the declared control");
}

const outcome = acceptedOutcome(reproduction, variant, comparison, structuredEvidence) ? "accepted" : "rejected";

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
		`- variant exercised: ${structuredEvidence.variant.exercised}`,
		`- variant positive signals: ${structuredEvidence.variant.positiveSignals.join(", ") || "none"}`,
		`- negative control exercised: ${structuredEvidence.negativeControl.exercised}`,
		`- negative control positive signals: ${structuredEvidence.negativeControl.positiveSignals.join(", ") || "none"}`,
		`- validation exercised: ${structuredEvidence.validation.exercised}`,
		`- validation positive signals: ${structuredEvidence.validation.positiveSignals.join(", ") || "none"}`,
		`- validation ok packages: ${structuredEvidence.validation.okPackages}`,
		`- comparison outcome: ${comparisonOutcome(comparison)}`,
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
				comparison: comparisonOutcome(comparison),
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
	const variantSummary = variantEvidence.variantExerciseSummary ?? {};
	const negativeControlSummary = variantEvidence.negativeControlExerciseSummary ?? {};
	const validationSummary = variantEvidence.validationExerciseSummary ?? {};
	return {
		reproduction: normalizeExerciseSummary(reproductionSummary),
		variant: normalizeExerciseSummary(variantSummary),
		negativeControl: normalizeExerciseSummary(negativeControlSummary),
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

function acceptedOutcome(reproductionState, variantState, comparisonState, evidence) {
	if (reproductionState.status !== "pass" || variantState.status !== "pass") return false;
	if (hasVariantCommand(variantState) && evidence.variant.exercised !== true) return false;
	if (hasNegativeControlCommand(variantState) && evidence.negativeControl.exercised !== true) return false;
	const comparison = normalizedComparisonOutcome(comparisonState);
	if (comparison === "rejected") return false;
	if (comparison === "accepted") return true;
	if (comparisonRejects(comparisonState)) return false;
	return true;
}

function hasVariantCommand(variantState) {
	return typeof variantState.variantCommand === "string" && variantState.variantCommand.trim() !== "";
}

function hasNegativeControlCommand(variantState) {
	return typeof variantState.negativeControlCommand === "string" && variantState.negativeControlCommand.trim() !== "";
}

function comparisonRejects(comparisonState) {
	const text = structuredText(comparisonState);
	return /\b(?:reject(?:ed|ion)?|inconclusive|non[-_ ]exercising)\b/iu.test(text);
}

function normalizedComparisonOutcome(comparisonState) {
	for (const raw of comparisonOutcomeCandidates(comparisonState)) {
		const normalized = raw.trim().toLowerCase();
		if (!normalized) continue;
		if (/^(?:accepted|accept|pass|passed|reproduced|reproduce|accepted_from_[a-z0-9_-]+)$/u.test(normalized)) {
			return "accepted";
		}
		if (/\b(?:reject|rejected|rejection|inconclusive|non[-_ ]exercising|failed?|fail_closed)\b/u.test(normalized)) {
			return "rejected";
		}
	}
	return "unknown";
}

function comparisonOutcomeCandidates(comparisonState) {
	const candidates = [];
	appendOutcomeCandidate(candidates, comparisonState?.status);
	appendOutcomeCandidate(candidates, comparisonState?.overallOutcome);
	appendOutcomeCandidate(candidates, comparisonState?.decision);
	if (comparisonState?.data && typeof comparisonState.data === "object" && !Array.isArray(comparisonState.data)) {
		appendOutcomeCandidate(candidates, comparisonState.data.status);
		appendOutcomeCandidate(candidates, comparisonState.data.overallOutcome);
		appendOutcomeCandidate(candidates, comparisonState.data.decision);
	}
	return candidates;
}

function appendOutcomeCandidate(candidates, value) {
	if (typeof value === "string") candidates.push(value);
}

function comparisonOutcome(comparisonState) {
	const status = comparisonState.status ?? comparisonState.overallOutcome ?? "unknown";
	return String(status);
}

function structuredText(value) {
	if (value === null || value === undefined) return "";
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (Array.isArray(value)) return value.map(structuredText).join("\n");
	if (typeof value === "object") return Object.values(value).map(structuredText).join("\n");
	return "";
}

function boundedLines(text, limit) {
	const lines = text.split(/\r?\n/u);
	const kept = lines.slice(0, limit);
	if (lines.length > limit) kept.push(`[truncated ${lines.length - limit} additional lines]`);
	return kept.join("\n");
}
