const review = latestActivationOutput("reviewRound");
const reviewVerdict = normalizeVerdict(review.data?.verdict ?? review.summary);
const reviewSummary = typeof review.summary === "string" ? review.summary : "";
const reviewRound = completedActivationCount("reviewRound");
const taskText = await readOptionalText("task.md");
const requiredRoundCount = taskRequiredRoundCount(taskText);
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
	requiredRoundCount,
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
	return counts.length === 0 ? 2 : Math.max(...counts);
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
		/\b(?:validation copy|clean[- ]copy|clean copy|prepared validation copy|validation sandbox)\b/iu.test(text) &&
		/\b(?:missing dependenc|missing package|missing module|excludes node_modules|exclude node_modules|Cannot find (?:package|module)|Could not resolve)\b/iu.test(
			text,
		)
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
