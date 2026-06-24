const review = latestActivationOutput("reviewRound");
const reviewVerdict = normalizeVerdict(review.data?.verdict ?? review.summary);
const reviewSummary = typeof review.summary === "string" ? review.summary : "";
const reviewRound = completedActivationCount("reviewRound");
const taskText = await readOptionalText("task.md");
const progressText = await readOptionalText("progress.md");
const requiredRoundCount = taskRequiredRoundCount(taskText);
const completedRoundCount = progressRoundCount(progressText);
const roundMinimumSatisfied = requiredRoundCount === null || completedRoundCount >= requiredRoundCount;
const setupBlockerEvidenceFiles = await findSetupBlockerEvidenceFiles(reviewSummary);
const reviewerDeclaredTerminalValidationBlockerEvidenceFiles =
	await findReviewerDeclaredTerminalValidationBlockerEvidenceFiles(reviewSummary);
const reviewerDeclaredTerminalBlockerEvidenceFiles =
	findReviewerDeclaredTerminalReviewBlockerEvidenceFiles(reviewSummary);
const externalValidationBlockerEvidenceFiles = uniqueSorted([
	...(await findRepeatedExternalValidationBlockerEvidenceFiles(taskText)),
	...reviewerDeclaredTerminalValidationBlockerEvidenceFiles,
]);
const terminalBlockerEvidenceFiles = uniqueSorted([
	...setupBlockerEvidenceFiles,
	...externalValidationBlockerEvidenceFiles,
	...reviewerDeclaredTerminalBlockerEvidenceFiles,
]);
const buildRepairRequested = mentionsBuildRepairRequest(reviewSummary);
const downstreamFinalizationOnly =
	reviewVerdict === "continue" &&
	roundMinimumSatisfied &&
	!buildRepairRequested &&
	isDownstreamFinalizationOnlyReview(reviewSummary);
const completionSatisfiedButContinued =
	reviewVerdict === "continue" &&
	roundMinimumSatisfied &&
	!buildRepairRequested &&
	isCompletionSatisfiedReview(reviewSummary);

let decision = reviewVerdict === "continue" ? "continue" : "complete";
let reason =
	decision === "continue"
		? "review requested another build round"
		: "review accepted the current implementation evidence";

if (reviewVerdict === "complete" && buildRepairRequested) {
	decision = "continue";
	reason = "review summary requested build repair despite complete verdict";
}

if (downstreamFinalizationOnly || completionSatisfiedButContinued) {
	decision = "complete";
	reason = downstreamFinalizationOnly
		? "review requested downstream finalization rather than more build work"
		: "review continuation contradicted completion satisfied evidence";
}

if (terminalBlockerEvidenceFiles.length > 0) {
	decision = "reject";
	reason =
		setupBlockerEvidenceFiles.length > 0
			? "setup blocker evidence is terminal; archive/reject instead of looping into another build round"
			: externalValidationBlockerEvidenceFiles.length > 0
				? "terminal validation blocker evidence repeated outside task scope; archive/reject instead of looping into another build round"
				: "terminal reviewer blocker evidence is terminal; archive/reject instead of looping into another build round";
}

const reviewDecisionTrailFile = `workflow-output/review-route-${Math.max(reviewRound, 1)}.json`;
const route = {
	decision,
	reason,
	reviewVerdict,
	reviewSummary,
	...(requiredRoundCount === null ? {} : { requiredRoundCount }),
	completedRoundCount,
	downstreamFinalizationOnly,
	completionSatisfiedButContinued,
	setupBlockerEvidenceFiles,
	externalValidationBlockerEvidenceFiles,
	reviewerDeclaredTerminalBlockerEvidenceFiles,
	terminalBlockerEvidenceFiles,
	reviewDecisionTrailFile,
	checkedAtMs: Date.now(),
};

await Bun.write(reviewDecisionTrailFile, `${JSON.stringify(route, null, 2)}\n`);

return {
	summary:
		decision === "reject"
			? setupBlockerEvidenceFiles.length > 0
				? `review route rejected due to setup blocker evidence: ${setupBlockerEvidenceFiles.join(", ")}`
				: `review route rejected due to terminal validation blocker evidence: ${terminalBlockerEvidenceFiles.join(", ")}`
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

function completedActivationCount(nodeId) {
	const activations = Array.isArray(workflowContext.completedActivations) ? workflowContext.completedActivations : [];
	return activations.filter(activation => activation?.nodeId === nodeId).length;
}

function normalizeVerdict(value) {
	const text = typeof value === "string" ? value.toLowerCase() : "";
	return /\bcontinue\b/u.test(text) ? "continue" : "complete";
}

function taskRequiredRoundCount(text) {
	const countWordPattern =
		"one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty";
	const matches = [
		...text.matchAll(
			new RegExp(`\\bat least\\s+((?:${countWordPattern})|\\d+)\\s+meaningful\\s+build/review\\s+cycles?\\b`, "giu"),
		),
		...text.matchAll(
			new RegExp(
				`\\brequires?\\s+(?:at least\\s+)?((?:${countWordPattern})|\\d+)\\s+meaningful\\s+build/review\\s+cycles?\\b`,
				"giu",
			),
		),
	];
	const counts = matches
		.map(match => parseRoundCount(match[1] ?? ""))
		.filter(count => count !== null);
	return counts.length === 0 ? null : Math.max(...counts);
}

function parseRoundCount(text) {
	const numeric = Number.parseInt(text, 10);
	if (Number.isFinite(numeric) && numeric > 0) return numeric;
	const words = new Map([
		["one", 1],
		["two", 2],
		["three", 3],
		["four", 4],
		["five", 5],
		["six", 6],
		["seven", 7],
		["eight", 8],
		["nine", 9],
		["ten", 10],
		["eleven", 11],
		["twelve", 12],
		["thirteen", 13],
		["fourteen", 14],
		["fifteen", 15],
		["sixteen", 16],
		["seventeen", 17],
		["eighteen", 18],
		["nineteen", 19],
		["twenty", 20],
	]);
	return words.get(text.toLowerCase()) ?? null;
}

function progressRoundCount(text) {
	return [...text.matchAll(/^\s*ROUND\s+(\d+)\s*:/gimu)]
		.map(match => Number(match[1]))
		.filter(round => Number.isInteger(round) && round > 0).length;
}

function isDownstreamFinalizationOnlyReview(text) {
	return mentionsDownstreamFinalization(text) && !mentionsBuildOwnedGap(text);
}

function isCompletionSatisfiedReview(text) {
	if (mentionsBuildOwnedGap(text)) return false;
	return mentionsCompletionSatisfied(text) && !mentionsCompletionNegation(text);
}

function mentionsCompletionSatisfied(text) {
	return (
		/\b(?:task|work|implementation|result)\s+is\s+complete\b/iu.test(text) ||
		/\b(?:review\s+route|route)\s+is\s+complete\b/iu.test(text) ||
		/\b(?:acceptance criteria|acceptance|task-specific acceptance)\b.{0,120}\b(?:satisfied|met|complete)\b/ius.test(
			text,
		) ||
		/\bsatisfying the contract\b/iu.test(text) ||
		/\btask contract\b.{0,180}\brequired\s+semantic\s+rounds?\s+are\s+present\b/ius.test(text) ||
		/\b(?:satisfying|satisfies)\s+the\s+task\s+contract'?s?\s+minimum\b/iu.test(text) ||
		/\btask\s+contract'?s?\s+minimum\b.{0,120}\b(?:satisfied|met|complete)\b/ius.test(text)
	);
}

function mentionsCompletionNegation(text) {
	return (
		/\b(?:not|never|no longer|without)\b.{0,80}\b(?:complete|satisfied|met|ready|accepted)\b/ius.test(text) ||
		/\b(?:incomplete|unsatisfied|unmet)\b/iu.test(text) ||
		/\b(?:not yet|still not)\b.{0,80}\b(?:complete|satisfied|met|ready|accepted)\b/ius.test(text)
	);
}

function mentionsDownstreamFinalization(text) {
	return (
		/\bsemantic[- ]?archive[- ]?guard\b/iu.test(text) ||
		/\bsemanticArchiveGuard\b/u.test(text) ||
		/\barchiveLoop\b/u.test(text) ||
		/\barchive[- ]?output\b/iu.test(text) ||
		/\bfinal archive\b/iu.test(text) ||
		/\bterminal evidence\b/iu.test(text) ||
		/\bproject-only changed-file inventory\b/iu.test(text) ||
		/\bpost-round route selection\b/iu.test(text) ||
		/\bdownstream archive nodes?\b/iu.test(text)
	);
}

function mentionsBuildOwnedGap(text) {
	return (
		mentionsBuildRepairRequest(text) ||
		/\btask-specific acceptance\b.{0,120}\b(?:not yet met|not met|unmet)\b/ius.test(text) ||
		/\bacceptance criteria\b.{0,120}\b(?:not yet met|not met|unmet)\b/ius.test(text) ||
		/\b(?:scope\/evidence|scope and evidence|scope)\s+gaps?\b/iu.test(text) ||
		/\b(?:outside|escapes?)\b.{0,120}\b(?:task\.md'?s?\s+declared\s+)?allowed paths?\b/ius.test(text) ||
		/\bcurrent diff\b.{0,120}\boutside\b/ius.test(text) ||
		/\bno corresponding source or behavioral-test improvement\b/iu.test(text) ||
		/\bimplementation needs another focused fix\b/iu.test(text)
	);
}

function mentionsBuildRepairRequest(text) {
	if (mentionsDownstreamFinalization(text) && !mentionsConcreteBuildRepairSurface(text)) return false;
	return (
		/\banother\s+build(?:\/review)?(?:\/archive)?\s+(?:round|route|cycle)\s+(?:is\s+)?(?:still\s+)?needed\b/iu.test(
			text,
		) ||
		/\b(?:needs?|requires?)\s+another\s+(?:focused\s+)?(?:build|implementation|repair)\s+round\b/iu.test(text)
	);
}

function mentionsConcreteBuildRepairSurface(text) {
	return /\b(?:formatting|ruff|lint|style|scope|local instructions?|diff|implementation|source|tests?|docs?|validation failed|fix|repair|blank line|byproduct)\b/iu.test(
		text,
	);
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
		/\bmissing validation dependencies after preflight\b/iu.test(text) ||
		/\bvalidation (?:copy|sandbox|environment).{0,120}\bmissing dependency\b/ius.test(text) ||
		/\b(?:prepared\s+)?clean copy.{0,160}\bmissing validation dependencies\b/ius.test(text) ||
		/\bvalidation dependencies\b.{0,160}\bmissing\b/ius.test(text) ||
		/\bclean-copy validation (?:is )?impossible\b/iu.test(text) ||
		usesNondurableValidationArtifact(text)
	);
}

async function findRepeatedExternalValidationBlockerEvidenceFiles(taskText) {
	const changedFiles = await changedProjectFiles();
	const allowedScopes = taskAllowedScopes(taskText);
	const groups = new Map();
	for (const file of await workflowOutputFiles()) {
		const round = workflowOutputRound(file);
		if (round === null) continue;
		if (!/(?:validation-(?:summary|stderr)|changed-file-inventory|project-changed-files)\.txt$/u.test(file)) continue;
		const text = await readOptionalText(file);
		const signature = validationFailureSignature(text);
		if (signature === null) continue;
		if (!isExternalValidationBlocker({ text, signature, changedFiles, allowedScopes })) continue;
		const group = groups.get(signature.key) ?? { files: [], rounds: new Set() };
		group.files.push(file);
		group.rounds.add(round);
		groups.set(signature.key, group);
	}
	const evidenceFiles = [];
	for (const group of groups.values()) {
		if (group.rounds.size >= 2) evidenceFiles.push(...group.files);
	}
	return uniqueSorted(evidenceFiles);
}

async function findReviewerDeclaredTerminalValidationBlockerEvidenceFiles(reviewSummary) {
	if (!isReviewerDeclaredTerminalValidationBlocker(reviewSummary)) return [];
	const summaryFiles = await latestRoundEvidenceFiles("validation-summary.txt");
	const matchingSummaryFiles = [];
	for (const file of summaryFiles) {
		const text = await readOptionalText(file);
		if (isExternalValidationBlockerText(text) || reviewSummaryReferencesEvidenceText(reviewSummary, text)) {
			matchingSummaryFiles.push(file);
		}
	}
	if (matchingSummaryFiles.length > 0) return uniqueSorted(matchingSummaryFiles);
	return ["reviewRound:summary"];
}

function findReviewerDeclaredTerminalReviewBlockerEvidenceFiles(reviewSummary) {
	if (!isReviewerDeclaredTerminalReviewBlocker(reviewSummary)) return [];
	return ["reviewRound:summary"];
}

async function latestRoundEvidenceFiles(fileName) {
	const files = [];
	let latestRound = 0;
	for (const file of await workflowOutputFiles()) {
		if (!file.endsWith(`/${fileName}`)) continue;
		const round = workflowOutputRound(file);
		if (round === null) continue;
		if (round > latestRound) {
			latestRound = round;
			files.length = 0;
		}
		if (round === latestRound) files.push(file);
	}
	return files.sort();
}

function isReviewerDeclaredTerminalValidationBlocker(text) {
	if (negatesTerminalValidationBlocker(text)) return false;
	return (
		/\bterminal\b.{0,120}\b(?:external|out[- ]of[- ]scope|unrelated|environment(?:al)?)\b.{0,120}\b(?:validation\s+)?blocker\b/ius.test(
			text,
		) ||
		/\b(?:external|out[- ]of[- ]scope|unrelated|environment(?:al)?)\b.{0,120}\bterminal\b.{0,120}\b(?:validation\s+)?blocker\b/ius.test(
			text,
		)
	);
}

function negatesTerminalValidationBlocker(text) {
	return (
		/\b(?:unless|until|if|only\s+if|when)\b.{0,80}\bterminal\b.{0,120}\b(?:external|out[- ]of[- ]scope|unrelated|environment(?:al)?)\b.{0,120}\b(?:validation\s+)?blocker\b.{0,80}\b(?:is|was|were|has\s+been|gets?)?\s*(?:proven|proved|confirmed|demonstrated|shown|established)\b/ius.test(
			text,
		) ||
		/\b(?:no|without)\b.{0,80}\bterminal\b.{0,120}\b(?:external|out[- ]of[- ]scope|unrelated|environment(?:al)?)\b.{0,120}\b(?:validation\s+)?blocker\b/ius.test(
			text,
		) ||
		/\bnot\s+(?:an?\s+)?terminal\b.{0,120}\b(?:external|out[- ]of[- ]scope|unrelated|environment(?:al)?)\b.{0,120}\b(?:validation\s+)?blocker\b/ius.test(
			text,
		) ||
		/\bterminal\b.{0,120}\b(?:external|out[- ]of[- ]scope|unrelated|environment(?:al)?)\b.{0,120}\b(?:validation\s+)?blocker\b.{0,80}\b(?:is|are)?\s*(?:not|absent|missing|not present|no longer present)\b/ius.test(
			text,
		)
	);
}

function isReviewerDeclaredTerminalReviewBlocker(text) {
	if (/\bif\s+the\s+next\s+round\b.{0,100}\b(?:cannot|can't)\b/ius.test(text)) return false;
	return (
		/\brecords?\s+this\s+as\s+a\s+terminal\b.{0,120}\bblocker\b/ius.test(text) ||
		/\bterminal\b.{0,80}\b(?:local[- ]instruction|instruction|policy|contract|changelog|issue|PR)\b.{0,80}\bblocker\b.{0,160}\b(?:because|no real|fabricat|cannot|can't)\b/ius.test(
			text,
		)
	);
}

function isExternalValidationBlockerText(text) {
	return (
		/\bexternal[_ -]?blocker\s*:/iu.test(text) ||
		/\b(?:external|out[- ]of[- ]scope|unrelated|environment(?:al)?|flaky)\b.{0,160}\b(?:validation\s+)?blocker\b/ius.test(
			text,
		) ||
		/\b(?:validation\s+)?blocker\b.{0,160}\b(?:external|out[- ]of[- ]scope|unrelated|environment(?:al)?|flaky)\b/ius.test(
			text,
		) ||
		/\boutside (?:this |the )?task scope\b/iu.test(text)
	);
}

function reviewSummaryReferencesEvidenceText(reviewSummary, evidenceText) {
	const reviewPath = firstFailurePath(reviewSummary);
	return Boolean(reviewPath && evidenceText.includes(reviewPath));
}

function workflowOutputRound(file) {
	const roundText = /^workflow-output\/round-(\d+)\//u.exec(file)?.[1];
	if (roundText === undefined) return null;
	const round = Number.parseInt(roundText, 10);
	return Number.isFinite(round) ? round : null;
}

async function changedProjectFiles() {
	const proc = Bun.spawn(["git", "status", "--short", "--untracked-files=all"], {
		cwd: process.cwd(),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
	if (exitCode !== 0) return [];
	return stdout
		.split(/\r?\n/u)
		.map(statusLineToPath)
		.filter(Boolean)
		.filter(file => !ignoredEvidencePath(file));
}

async function workflowOutputFiles() {
	try {
		const files = [];
		const glob = new Bun.Glob("workflow-output/**/*");
		for await (const file of glob.scan({ cwd: process.cwd(), onlyFiles: true })) {
			files.push(file);
		}
		return files.sort();
	} catch {
		return [];
	}
}

function validationFailureSignature(text) {
	const dependencySignature = validationDependencyBlockerSignature(text);
	if (dependencySignature !== null) return dependencySignature;
	const failurePath = firstFailurePath(text);
	if (!failurePath) return null;
	const kind = /\b(?:TimeoutError|timed out|timeout)\b/iu.test(text) ? "timeout" : "failure";
	return {
		key: `${failurePath}:${kind}`,
		path: failurePath,
		kind,
	};
}

function validationDependencyBlockerSignature(text) {
	if (!isValidationDependencyBlockerText(text)) return null;
	const missingDependencies = Array.from(
		new Set(
			[...text.matchAll(/\b(?:Cannot find (?:package|module)|Could not resolve)\s+['"`]([^'"`]+)['"`]/giu)]
				.map(match => match[1])
				.filter(Boolean)
				.map(normalizeDependencyName),
		),
	).sort((left, right) => left.localeCompare(right, "en"));
	const key =
		missingDependencies.length === 0
			? "validation-environment-dependencies"
			: `validation-environment-dependencies:${missingDependencies.join(",")}`;
	return {
		key,
		path: "validation-environment-dependencies",
		kind: "failure",
	};
}

function isValidationDependencyBlockerText(text) {
	return (
		(/\b(?:validation copy|clean[- ]copy|clean copy|prepared validation copy|validation sandbox)\b/iu.test(text) &&
			/\b(?:missing dependenc|missing package|missing module|excludes node_modules|exclude node_modules|Cannot find (?:package|module)|Could not resolve)\b/iu.test(
				text,
			)) ||
		/\bnode_modules\b.{0,80}\bmissing\b.{0,120}\bafter preflight\b/ius.test(text) ||
		/\b(?:unavailable|missing)\b.{0,80}\b(?:dependency|dependencies|package|module|binary)\b/ius.test(text)
	);
}

function normalizeDependencyName(name) {
	return name.replace(/\/(?:package\.json|dist\/[^/\s]+)$/u, "");
}

function firstFailurePath(text) {
	const patterns = [
		/\bFAIL\s+([./\w@-][^\s\[]+)/iu,
		/\bfailed\s+in\s+([./\w@-][^\s\[]+)/iu,
		/\bfail(?:ed|ure)?\s+(?:during|in)\s+([./\w@-][^\s\[]+)/iu,
		/\b((?:[./]?[\w@-]+\/)+[\w@.-]+\.(?:c|cc|cpp|go|h|hpp|java|js|jsx|py|pyi|rs|ts|tsx)(?:::[A-Za-z_][\w.-]*)?)\b/u,
	];
	for (const pattern of patterns) {
		const match = pattern.exec(text);
		const rawPath = match?.[1]?.trim();
		if (rawPath) return normalizeEvidencePath(rawPath);
	}
	return "";
}

function isExternalValidationBlocker({ text, signature, changedFiles, allowedScopes }) {
	const explicitExternal =
		/\b(?:out[- ]of[- ]scope|external|unrelated|environment(?:al)?|flaky)\b/iu.test(text) ||
		/\boutside (?:this |the )?task scope\b/iu.test(text) ||
		signature.path === "validation-environment-dependencies";
	const outsideChangedFiles = changedFiles.every(file => !pathsOverlap(file, signature.path));
	const outsideAllowedScope =
		allowedScopes.length === 0 ? false : allowedScopes.every(scope => !scopeMatchesPath(scope, signature.path));
	return explicitExternal || (signature.kind === "timeout" && outsideChangedFiles && outsideAllowedScope);
}

function taskAllowedScopes(taskText) {
	const allowedLine = /Allowed paths:\s*([^\n]+)/iu.exec(taskText)?.[1] ?? "";
	const scopes = [];
	for (const match of allowedLine.matchAll(/`([^`]+)`/gu)) {
		const rawScope = match[1]?.trim();
		if (!rawScope || ignoredEvidencePath(rawScope)) continue;
		scopes.push(rawScope);
	}
	return scopes;
}

function scopeMatchesPath(scope, filePath) {
	const normalizedScope = normalizeEvidencePath(scope);
	if (normalizedScope.endsWith("/**")) {
		return filePath.startsWith(normalizedScope.slice(0, -2));
	}
	if (normalizedScope.endsWith("/*")) {
		return filePath.startsWith(normalizedScope.slice(0, -1));
	}
	return filePath === normalizedScope || filePath.startsWith(`${normalizedScope}/`);
}

function pathsOverlap(left, right) {
	const normalizedLeft = normalizeEvidencePath(left);
	const normalizedRight = normalizeEvidencePath(right);
	return (
		normalizedLeft === normalizedRight ||
		normalizedLeft.startsWith(`${normalizedRight}/`) ||
		normalizedRight.startsWith(`${normalizedLeft}/`)
	);
}

function statusLineToPath(line) {
	const trimmed = line.trim();
	if (!trimmed) return "";
	const rename = /^R[ MDA?]?\s+(.+?)\s+->\s+(.+)$/u.exec(trimmed);
	if (rename) return normalizeGitPath(rename[2]?.trim() ?? "");
	return normalizeGitPath(trimmed.slice(2).trim());
}

function normalizeGitPath(filePath) {
	if (filePath.startsWith('"') && filePath.endsWith('"')) return filePath.slice(1, -1);
	return filePath;
}

function normalizeEvidencePath(filePath) {
	return filePath.replace(/^\.\//u, "").replace(/\\/gu, "/").replace(/[),.;:]+$/u, "");
}

function ignoredEvidencePath(file) {
	return (
		file === "task.md" ||
		file === "progress.md" ||
		file === "manifest-entry.json" ||
		file === "monitor-assignment.json" ||
		file === "evidence-ledger.jsonl" ||
		file.startsWith("workflow-output/") ||
		file.startsWith("transcripts/") ||
		ignoredProjectArtifactPath(file)
	);
}

function ignoredProjectArtifactPath(file) {
	const ignoredSegments = new Set([".venv", "node_modules", ".pytest_cache", ".mypy_cache", ".ruff_cache", "__pycache__"]);
	return normalizeEvidencePath(file)
		.split("/")
		.some(segment => ignoredSegments.has(segment));
}

function uniqueSorted(files) {
	return Array.from(new Set(files)).sort((left, right) => left.localeCompare(right, "en"));
}

function usesNondurableValidationArtifact(text) {
	return (
		/\b(?:validation|stdout|stderr|evidence|harness).{0,160}\bartifact:\/\/\d+\b/ius.test(text) ||
		/\bartifact:\/\/\d+\b.{0,160}\b(?:validation|stdout|stderr|evidence|harness)\b/ius.test(text)
	);
}

async function readOptionalText(filePath) {
	try {
		return await Bun.file(filePath).text();
	} catch {
		return "";
	}
}
