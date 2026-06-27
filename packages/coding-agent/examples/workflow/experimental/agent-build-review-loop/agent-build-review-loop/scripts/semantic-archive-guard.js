const MAX_FILE_BYTES = 512_000;
const REPEATED_LINE_MIN_COUNT = 20;
const REPEATED_LINE_RATIO = 0.45;
const LOW_UNIQUE_LINE_RATIO = 0.2;
const PADDING_WORD_PATTERN = /\b(padding|dummy|placeholder|lorem|sleep|hold|no-op|noop|filler)\b/iu;
const VALIDATION_HARNESS_BOOTSTRAP_PATTERN =
	/\b(?:(?:npm|pnpm|yarn|bun)(?:\s+\S+){0,5}\s+(?:install|add|ci|update|upgrade)|(?:pip|pip3)(?:\s+\S+){0,5}\s+install|python(?:3)?\s+-m\s+pip(?:\s+\S+){0,5}\s+install|uv\s+(?:sync|add|pip\s+install)|poetry\s+(?:install|add|update)|cargo\s+(?:install|update)|bundle\s+install|go\s+(?:install|get))\b/iu;
const VALIDATION_RERUN_PATTERNS = [
	/\b(?:reran|re-ran|rerun|re-run)\s+(?:the\s+)?validation\b/iu,
	/\bvalidation\s+(?:was\s+)?(?:rerun|re-run|reran|re-ran)\b/iu,
	/\b(?:first|second|previous|earlier|prior)\s+validation\s+(?:run|attempt|failure)\b/iu,
	/\boverwrit(?:e|es|ten|ing)\s+validation[- /](?:stdout|stderr|logs?)\b/iu,
];

const taskText = await readOptionalText("task.md");
const progressText = await readOptionalText("progress.md");
const explicitAllowance = explicitLowSemanticAllowance(taskText);
const changedFiles = await changedProjectFiles();
const allowedScopes = taskAllowedScopes(taskText);
const findings = [];

for (const file of changedFiles) {
	if (ignoredEvidencePath(file)) continue;
	const text = await readTextFileIfSmall(file);
	if (text === null) continue;
	const finding = analyzeTextFile(file, text);
	if (finding !== null) findings.push(finding);
}
findings.push(...scopeFenceFindings(changedFiles, allowedScopes));
findings.push(...nonPositiveProgressRoundFindings(progressText));
findings.push(...(await earlyFinalizationArtifactFindings()));
findings.push(...(await dependencyBootstrapFindings()));
findings.push(...(await downstreamCompletionClaimFindings()));
findings.push(...(await nondurableArtifactReferenceFindings()));
findings.push(...(await missingValidationArtifactFindings(progressText)));
findings.push(...(await missingValidationAttemptRetentionFindings()));

const blockingFindings = explicitAllowance
	? findings.filter(finding => finding.category !== "low-semantic-content")
	: findings;
const verdict = blockingFindings.length === 0 ? "PASS" : "REPAIR";
const diagnostic = {
	verdict,
	changedFiles: changedFiles.slice(0, 200),
	explicitAllowance,
	findings,
	checkedAtMs: Date.now(),
};

await Bun.write(
	"workflow-output/semantic-archive-guard.json",
	`${JSON.stringify(diagnostic, null, 2)}\n`,
);

return {
	summary:
		verdict === "PASS"
			? `semantic archive guard passed: inspected ${changedFiles.length} changed project files`
			: `semantic archive guard requires repair: ${blockingFindings.map(finding => `${finding.file}: ${finding.reason}`).join("; ")}`,
	verdict,
	data: diagnostic,
	statePatch: [{ op: "set", path: "/semanticGuard", value: diagnostic }],
};

function scopeFenceFindings(changedFiles, allowedScopes) {
	if (allowedScopes.length === 0) return [];
	return changedFiles
		.filter(file => allowedScopes.every(scope => !scopeMatchesPath(scope, file)))
		.map(file => ({
			file,
			reason: "changed file is outside task allowed paths",
			policy:
				"Every semantic project change must stay within the task.md Allowed paths fence; widen the task contract explicitly or revert the out-of-scope change before archive.",
		}));
}

function nonPositiveProgressRoundFindings(progressText) {
	const invalidRounds = [...progressText.matchAll(/^\s*ROUND\s+(\d+)\s*:/gimu)]
		.map(match => Number(match[1]))
		.filter(round => Number.isInteger(round) && round <= 0);
	if (invalidRounds.length === 0) return [];
	return [
		{
			file: "progress.md",
			reason: "progress uses non-positive workflow round numbers",
			policy:
				"Agent build/review loop rounds are one-based. Rename the first round to ROUND 1 and store validation artifacts under workflow-output/round-1/ before archive.",
			rounds: invalidRounds.map(round => `ROUND ${round}`),
		},
	];
}

async function earlyFinalizationArtifactFindings() {
	const findings = [];
	for (const file of [
		"workflow-output/tuple-state.json",
		"workflow-output/final-agent-loop-archive.md",
		"workflow-output/final-agent-loop-reject.md",
	]) {
		if (!(await Bun.file(file).exists())) continue;
		findings.push({
			file,
			reason: "workflow finalization artifact was created before archiveLoop",
			policy:
				"Build and review nodes must leave terminal tuple-state and final archives to archiveLoop. Remove the premature artifact and rerun the route.",
		});
	}
	return findings;
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

async function dependencyBootstrapFindings() {
	const findings = [];
	const files = await workflowOutputFiles();
	for (const file of files) {
		if (!isValidationHarness(file)) continue;
		const text = await readOptionalText(file);
		if (!VALIDATION_HARNESS_BOOTSTRAP_PATTERN.test(text)) continue;
		findings.push({
			file,
			reason: "validation harness performs dependency bootstrap after preflight",
			policy:
				"Install or update dependencies before workflow launch as run setup; workflow rounds may run validation but must not make dependency bootstrap semantic progress.",
		});
	}
	return findings;
}

async function downstreamCompletionClaimFindings() {
	const findings = [];
	const files = await workflowOutputFiles();
	for (const file of files) {
		if (!/^workflow-output\/round-\d+\//u.test(file)) continue;
		const text = await readOptionalText(file);
		if (!claimsDownstreamWorkflowNodeCompletion(text)) continue;
		findings.push({
			file,
			reason: "round evidence claims downstream workflow node completion",
			policy:
				"Build and review agents may record evidence, but only the semanticArchiveGuard and archiveLoop workflow nodes may claim their own completion.",
		});
	}
	return findings;
}

async function nondurableArtifactReferenceFindings() {
	const findings = [];
	const files = await workflowOutputFiles();
	for (const file of files) {
		if (!/^workflow-output\/round-\d+\//u.test(file)) continue;
		const text = await readOptionalText(file);
		if (!usesNondurableValidationArtifact(text)) continue;
		findings.push({
			file,
			reason: "round evidence uses nondurable artifact reference for validation output",
			policy:
				"Validation stdout/stderr must be copied into workflow-output as workspace-local durable artifacts before archive.",
		});
	}
	return findings;
}

async function missingValidationArtifactFindings(progressText) {
	const findings = [];
	for (const round of validationRounds(progressText)) {
		const roundDir = `workflow-output/round-${round}`;
		const missingFiles = [];
		for (const file of [`${roundDir}/validation-stdout.txt`, `${roundDir}/validation-stderr.txt`]) {
			if (!(await Bun.file(file).exists())) missingFiles.push(file);
		}
		if (missingFiles.length === 0) continue;
		findings.push({
			file: roundDir,
			reason: "validation round is missing durable stdout/stderr artifacts",
			missingFiles,
			policy:
				"Every round that runs validation must store raw stdout and stderr as workflow-output/round-N/validation-stdout.txt and validation-stderr.txt.",
		});
	}
	return findings;
}

async function missingValidationAttemptRetentionFindings() {
	const findings = [];
	const files = await workflowOutputFiles();
	const requiredAttemptsByRound = new Map();
	for (const file of files) {
		const roundDir = roundEvidenceDir(file);
		if (!roundDir) continue;
		const text = await readOptionalText(file);
		const attempts = requiredValidationAttempts(text);
		if (attempts.length > 0) addRequiredAttempts(requiredAttemptsByRound, roundDir, attempts);
	}
	for (const [roundDir, attempts] of Array.from(requiredAttemptsByRound.entries()).sort((left, right) =>
		left[0].localeCompare(right[0], "en"),
	)) {
		const missingFiles = missingValidationAttemptLogFiles(files, roundDir, attempts);
		if (missingFiles.length === 0) continue;
		findings.push({
			file: roundDir,
			reason: "validation rerun evidence is missing immutable attempt stdout/stderr logs",
			missingFiles,
			policy:
				"Every validation rerun in a round must preserve per-attempt raw logs as validation-attempt-K-stdout.txt and validation-attempt-K-stderr.txt before updating canonical latest logs.",
		});
	}
	return findings;
}

function validationRounds(progressText) {
	const rounds = [];
	for (const line of progressText.split(/\r?\n/u)) {
		const match =
			/^ROUND\s+(\d+):.*?;\s*validation\s*=\s*([^;]+?)\s*;\s*result\s*=\s*([a-z-]+)/iu.exec(line.trim());
		if (!match) continue;
		const round = Number(match[1]);
		const validation = match[2]?.trim().toLowerCase() ?? "";
		const result = match[3]?.trim().toLowerCase() ?? "";
		if (!Number.isFinite(round) || round <= 0) continue;
		if (!validation || validation === "not-run" || result === "not-run") continue;
		rounds.push(round);
	}
	return rounds;
}

async function workflowOutputFiles() {
	try {
		const glob = new Bun.Glob("workflow-output/**/*");
		const files = [];
		for await (const file of glob.scan({ cwd: process.cwd(), onlyFiles: true })) {
			files.push(file);
		}
		return files.sort();
	} catch {
		return [];
	}
}

function isValidationHarness(file) {
	return /^workflow-output\/(?:run-|validate|validation|check).*\.(?:sh|bash|zsh)$/u.test(file);
}

function statusLineToPath(line) {
	const trimmed = line.trim();
	if (!trimmed) return "";
	const rename = /^R[ MDA?]?\s+(.+?)\s+->\s+(.+)$/u.exec(trimmed);
	if (rename) return normalizeEvidencePath(normalizeGitPath(rename[2]?.trim() ?? ""));
	return normalizeEvidencePath(normalizeGitPath(trimmed.slice(2).trim()));
}

function normalizeGitPath(filePath) {
	if (filePath.startsWith('"') && filePath.endsWith('"')) return filePath.slice(1, -1);
	return filePath;
}

function taskAllowedScopes(taskText) {
	const scopes = [];
	for (const match of taskText.matchAll(/Allowed paths:\s*([^\n]+)/giu)) {
		const allowedLine = match[1] ?? "";
		const backtickMatches = Array.from(allowedLine.matchAll(/`([^`]+)`/gu));
		const rawScopes =
			backtickMatches.length > 0 ? backtickMatches.map(item => item[1] ?? "") : allowedLine.split(",");
		for (const rawScope of rawScopes) {
			const scope = normalizeEvidencePath(rawScope.trim().replace(/^[-*]\s*/u, "").replace(/^and\s+/iu, ""));
			if (!scope || ignoredEvidencePath(scope)) continue;
			scopes.push(scope);
		}
	}
	return uniqueSorted(scopes);
}

function scopeMatchesPath(scope, filePath) {
	const normalizedScope = normalizeEvidencePath(scope);
	const normalizedPath = normalizeEvidencePath(filePath);
	if (normalizedScope.endsWith("/**")) {
		return normalizedPath.startsWith(normalizedScope.slice(0, -2));
	}
	if (normalizedScope.endsWith("/*")) {
		return normalizedPath.startsWith(normalizedScope.slice(0, -1));
	}
	return normalizedPath === normalizedScope || normalizedPath.startsWith(`${normalizedScope}/`);
}

function normalizeEvidencePath(filePath) {
	const normalized = filePath.replace(/^\.\//u, "").replace(/\\/gu, "/").replace(/[),.;:]+$/u, "");
	return normalized === "/" ? normalized : normalized.replace(/\/+$/u, "");
}

async function readTextFileIfSmall(filePath) {
	try {
		const file = Bun.file(filePath);
		if (file.size > MAX_FILE_BYTES) return null;
		const bytes = new Uint8Array(await file.arrayBuffer());
		if (bytes.includes(0)) return null;
		return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
	} catch {
		return null;
	}
}

function analyzeTextFile(file, text) {
	const lines = text
		.split(/\r?\n/u)
		.map(line => normalizeLine(line))
		.filter(line => line.length > 0);
	if (lines.length < REPEATED_LINE_MIN_COUNT) return null;
	const counts = new Map();
	for (const line of lines) {
		counts.set(line, (counts.get(line) ?? 0) + 1);
	}
	let topLine = "";
	let topCount = 0;
	for (const [line, count] of counts) {
		if (count > topCount) {
			topLine = line;
			topCount = count;
		}
	}
	const repeatedRatio = topCount / lines.length;
	const uniqueRatio = counts.size / lines.length;
	const paddingWord = PADDING_WORD_PATTERN.test(topLine);
	const suspiciousRepeat = topCount >= REPEATED_LINE_MIN_COUNT && repeatedRatio >= REPEATED_LINE_RATIO;
	const suspiciousLowUnique = lines.length >= 80 && uniqueRatio <= LOW_UNIQUE_LINE_RATIO && topCount >= 10;
	if (!suspiciousRepeat && !suspiciousLowUnique && !paddingWord) return null;
	return {
		file,
		category: "low-semantic-content",
		reason: "high-repetition low-semantic text content before archive",
		lineCount: lines.length,
		uniqueLineCount: counts.size,
		topRepeatedLineCount: topCount,
		repeatedRatio: Number(repeatedRatio.toFixed(3)),
		uniqueRatio: Number(uniqueRatio.toFixed(3)),
		repeatedLinePreview: topLine.slice(0, 160),
	};
}

function claimsDownstreamWorkflowNodeCompletion(text) {
	return (
		/"(?:semanticArchiveGuard|archiveLoop)"\s*:\s*"complete"/u.test(text) ||
		/\b(?:semanticArchiveGuard|archiveLoop)\s*[:=]\s*complete\b/iu.test(text) ||
		/\b(?:semantic archive guard|archive loop)\s+complete(?:d)?\b/iu.test(text)
	);
}

function usesNondurableValidationArtifact(text) {
	return (
		/\b(?:validation|stdout|stderr|evidence|harness).{0,160}\bartifact:\/\/\d+\b/ius.test(text) ||
		/\bartifact:\/\/\d+\b.{0,160}\b(?:validation|stdout|stderr|evidence|harness)\b/ius.test(text)
	);
}

function mentionsMultipleValidationAttempts(text) {
	return explicitValidationAttemptNumbers(text).length >= 2 || VALIDATION_RERUN_PATTERNS.some(pattern => pattern.test(text));
}

function requiredValidationAttempts(text) {
	const attempts = explicitValidationAttemptNumbers(text);
	if (attempts.length >= 2) return attempts;
	if (!VALIDATION_RERUN_PATTERNS.some(pattern => pattern.test(text))) return [];
	return [1, 2];
}

function explicitValidationAttemptNumbers(text) {
	const attempts = new Set();
	for (const match of text.matchAll(/\battempt\s+#?(\d+)\s*:/giu)) {
		addPositiveAttempt(attempts, match[1]);
	}
	for (const match of text.matchAll(/\bvalidation-attempt-(\d+)-(?:stdout|stderr)\.txt\b/giu)) {
		addPositiveAttempt(attempts, match[1]);
	}
	return Array.from(attempts).sort((left, right) => left - right);
}

function addPositiveAttempt(attempts, value) {
	const attempt = Number(value);
	if (Number.isInteger(attempt) && attempt > 0) attempts.add(attempt);
}

function addRequiredAttempts(requiredAttemptsByRound, roundDir, attempts) {
	const required = requiredAttemptsByRound.get(roundDir) ?? new Set();
	for (const attempt of attempts) {
		required.add(attempt);
	}
	requiredAttemptsByRound.set(roundDir, required);
}

function missingValidationAttemptLogFiles(files, roundDir, attempts) {
	const present = new Set(files);
	const missingFiles = [];
	for (const attempt of Array.from(attempts).sort((left, right) => left - right)) {
		for (const stream of ["stdout", "stderr"]) {
			const file = `${roundDir}/validation-attempt-${attempt}-${stream}.txt`;
			if (!present.has(file)) missingFiles.push(file);
		}
	}
	return missingFiles;
}

function roundEvidenceDir(file) {
	const match = /^(workflow-output\/round-\d+)\//u.exec(file);
	return match?.[1] ?? "";
}

function normalizeLine(line) {
	return line.trim().replace(/\s+/gu, " ");
}

function explicitLowSemanticAllowance(text) {
	return /(^|\n)\s*(?:#+\s*)?(?:generated fixture allowed|low-semantic repetition allowed|bulk fixture allowed)\s*:\s*yes\b/iu.test(
		text,
	);
}

function uniqueSorted(files) {
	return Array.from(new Set(files)).sort((left, right) => left.localeCompare(right, "en"));
}

async function readOptionalText(filePath) {
	try {
		return await Bun.file(filePath).text();
	} catch {
		return "";
	}
}

function ignoredEvidencePath(file) {
	return (
		file === "evidence-ledger.jsonl" ||
		file === "manifest-entry.json" ||
		file === "monitor-assignment.json" ||
		file === "task.md" ||
		file === "progress.md" ||
		file.startsWith("workflow-output/") ||
		ignoredProjectArtifactPath(file)
	);
}

function ignoredProjectArtifactPath(file) {
	const ignoredSegments = new Set([
		".venv",
		"node_modules",
		".pytest_cache",
		".mypy_cache",
		".ruff_cache",
		"__pycache__",
		"dist",
		"build",
	]);
	return normalizeEvidencePath(file)
		.split("/")
		.some(segment => ignoredSegments.has(segment));
}
