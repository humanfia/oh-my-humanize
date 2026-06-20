const review = latestActivationOutput("reviewRound");
const reviewVerdict = normalizeVerdict(review.data?.verdict ?? review.summary);
const reviewSummary = typeof review.summary === "string" ? review.summary : "";
const reviewRound = completedActivationCount("reviewRound");
const taskText = await readOptionalText("task.md");
const setupBlockerEvidenceFiles = await findSetupBlockerEvidenceFiles(reviewSummary);
const externalValidationBlockerEvidenceFiles = await findRepeatedExternalValidationBlockerEvidenceFiles(taskText);
const terminalBlockerEvidenceFiles = uniqueSorted([
	...setupBlockerEvidenceFiles,
	...externalValidationBlockerEvidenceFiles,
]);

let decision = reviewVerdict === "continue" ? "continue" : "complete";
let reason =
	decision === "continue"
		? "review requested another build round"
		: "review accepted the current implementation evidence";

if (terminalBlockerEvidenceFiles.length > 0) {
	decision = "reject";
	reason =
		setupBlockerEvidenceFiles.length > 0
			? "setup blocker evidence is terminal; archive/reject instead of looping into another build round"
			: "terminal validation blocker evidence repeated outside task scope; archive/reject instead of looping into another build round";
}

const reviewDecisionTrailFile = `workflow-output/review-route-${Math.max(reviewRound, 1)}.json`;
const route = {
	decision,
	reason,
	reviewVerdict,
	reviewSummary,
	setupBlockerEvidenceFiles,
	externalValidationBlockerEvidenceFiles,
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

async function findRepeatedExternalValidationBlockerEvidenceFiles(taskText) {
	const changedFiles = await changedProjectFiles();
	const allowedScopes = taskAllowedScopes(taskText);
	const groups = new Map();
	for (const file of await workflowOutputFiles()) {
		if (!/^workflow-output\/round-\d+\//u.test(file)) continue;
		if (!/(?:validation-(?:summary|stderr)|changed-file-inventory|project-changed-files)\.txt$/u.test(file)) continue;
		const text = await readOptionalText(file);
		const signature = validationFailureSignature(text);
		if (signature === null) continue;
		if (!isExternalValidationBlocker({ text, signature, changedFiles, allowedScopes })) continue;
		const files = groups.get(signature.key) ?? [];
		files.push(file);
		groups.set(signature.key, files);
	}
	const evidenceFiles = [];
	for (const files of groups.values()) {
		if (files.length >= 3) evidenceFiles.push(...files);
	}
	return uniqueSorted(evidenceFiles);
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
	const failurePath = firstFailurePath(text);
	if (!failurePath) return null;
	const kind = /\b(?:TimeoutError|timed out|timeout)\b/iu.test(text) ? "timeout" : "failure";
	return {
		key: `${failurePath}:${kind}`,
		path: failurePath,
		kind,
	};
}

function firstFailurePath(text) {
	const patterns = [
		/\bFAIL\s+([./\w@-][^\s\[]+)/iu,
		/\bfailed\s+in\s+([./\w@-][^\s\[]+)/iu,
		/\bfail(?:ed|ure)?\s+(?:during|in)\s+([./\w@-][^\s\[]+)/iu,
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
		/\boutside (?:this |the )?task scope\b/iu.test(text);
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
		file.startsWith("transcripts/")
	);
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
