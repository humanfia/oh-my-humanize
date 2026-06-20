const review = latestActivationOutput("reviewRound");
const reviewVerdict = normalizeVerdict(review.data?.verdict ?? review.summary);
const reviewSummary = typeof review.summary === "string" ? review.summary : "";
const setupBlockerEvidenceFiles = await findSetupBlockerEvidenceFiles(reviewSummary);

let decision = reviewVerdict === "continue" ? "continue" : "complete";
let reason =
	decision === "continue"
		? "review requested another build round"
		: "review accepted the current implementation evidence";

if (setupBlockerEvidenceFiles.length > 0) {
	decision = "reject";
	reason = "setup blocker evidence is terminal; archive/reject instead of looping into another build round";
}

const route = {
	decision,
	reason,
	reviewVerdict,
	reviewSummary,
	setupBlockerEvidenceFiles,
	checkedAtMs: Date.now(),
};

return {
	summary:
		decision === "reject"
			? `review route rejected due to setup blocker evidence: ${setupBlockerEvidenceFiles.join(", ")}`
			: `review route ${decision}: ${reason}`,
	data: route,
	statePatch: [{ op: "set", path: "/reviewRoute", value: route }],
};

function latestActivationOutput(nodeId) {
	const activations = Array.isArray(workflowContext.completedActivations) ? workflowContext.completedActivations : [];
	for (let index = activations.length - 1; index >= 0; index -= 1) {
		const activation = activations[index];
		if (activation?.nodeId === nodeId) return activation.output ?? {};
	}
	return {};
}

function normalizeVerdict(value) {
	const text = typeof value === "string" ? value.toLowerCase() : "";
	return /\bcontinue\b/u.test(text) ? "continue" : "complete";
}

async function findSetupBlockerEvidenceFiles(reviewSummary) {
	const files = new Set();
	if (isSetupBlockerText(reviewSummary)) files.add("reviewRound:summary");
	try {
		const glob = new Bun.Glob("workflow-output/**/*");
		for await (const file of glob.scan({ cwd: process.cwd(), onlyFiles: true })) {
			if (isSetupBlockerFileName(file)) {
				files.add(file);
				continue;
			}
			if (!isRoundEvidenceFile(file)) continue;
			if (await fileContainsSetupBlocker(file)) files.add(file);
		}
	} catch {
		return Array.from(files).sort();
	}
	return Array.from(files).sort();
}

function isSetupBlockerFileName(file) {
	return /(^|\/)setup[-_]?blocker/i.test(file);
}

function isRoundEvidenceFile(file) {
	return /^workflow-output\/round-\d+\//u.test(file);
}

async function fileContainsSetupBlocker(file) {
	try {
		const source = Bun.file(file);
		if (source.size > 128_000) return false;
		const text = await source.text();
		return isSetupBlockerText(text);
	} catch {
		return false;
	}
}

function isSetupBlockerText(text) {
	return (
		/\bsetup[- ]blocker\b/iu.test(text) ||
		/\bmissing validation dependencies after preflight\b/iu.test(text) ||
		/\bvalidation (?:copy|sandbox|environment).{0,120}\bmissing dependency\b/ius.test(text) ||
		/\b(?:prepared\s+)?clean copy.{0,160}\bmissing validation dependencies\b/ius.test(text) ||
		/\bvalidation dependencies\b.{0,160}\bmissing\b/ius.test(text) ||
		/\bclean-copy validation (?:is )?impossible\b/iu.test(text) ||
		usesNondurableValidationArtifact(text)
	);
}

function usesNondurableValidationArtifact(text) {
	return (
		/\b(?:validation|stdout|stderr|evidence|harness).{0,160}\bartifact:\/\/\d+\b/ius.test(text) ||
		/\bartifact:\/\/\d+\b.{0,160}\b(?:validation|stdout|stderr|evidence|harness)\b/ius.test(text)
	);
}
