const taskText = await readRequiredTaskText();
const tupleId = taskTupleId(taskText);
const progressText = await readOptionalText("progress.md");
const VALIDATION_RERUN_PATTERNS = [
	/\b(?:reran|re-ran|rerun|re-run)\s+(?:the\s+)?validation\b/iu,
	/\bvalidation\s+(?:was\s+)?(?:rerun|re-run|reran|re-ran)\b/iu,
	/\b(?:first|second|previous|earlier|prior)\s+validation\s+(?:run|attempt|failure)\b/iu,
	/\boverwrit(?:e|es|ten|ing)\s+validation[- /](?:stdout|stderr|logs?)\b/iu,
];
const reviewRoute = workflowContext.state?.reviewRoute && typeof workflowContext.state.reviewRoute === "object" ? workflowContext.state.reviewRoute : {};
const isRejectArchive = reviewRoute.decision === "reject";
const archivePath = isRejectArchive ? "workflow-output/final-agent-loop-reject.md" : "workflow-output/final-agent-loop-archive.md";
const verifyCommand = requiredTaskValidationCommand(taskText);
assertSafeVerificationCommand(verifyCommand);
assertReviewRouteCanArchive(reviewRoute, isRejectArchive);
const evidenceFiles = await loopEvidenceFiles();
const archivedEvidenceFiles = mergedEvidenceFiles(evidenceFiles, [
	...(isRejectArchive ? reviewRoute.setupBlockerEvidenceFiles ?? [] : []),
	reviewRoute.reviewDecisionTrailFile,
]);
const existingArchiveOwnedArtifacts = await existingArchiveOwnedFinalizationArtifacts();
if (existingArchiveOwnedArtifacts.length > 0) {
	throw new Error(
		`agent-build-review-loop cannot archive because archive-owned finalization artifacts already exist: ${existingArchiveOwnedArtifacts.join(", ")}`,
	);
}
const nonPositiveProgressRounds = nonPositiveProgressRoundLabels(progressText);
if (nonPositiveProgressRounds.length > 0) {
	throw new Error(
		`agent-build-review-loop cannot archive because progress.md uses non-positive workflow round numbers: ${nonPositiveProgressRounds.join(", ")}`,
	);
}
const roundCount = Math.max(progressRoundCount(progressText), evidenceRoundCount(evidenceFiles));
if (roundCount === 0 && !isRejectArchive) {
	throw new Error("agent-build-review-loop cannot archive without at least one ROUND entry in progress.md");
}
const changedFiles = await changedProjectFiles();
const outsideAllowedChangedFiles = changedFilesOutsideAllowedScopes(changedFiles, taskAllowedScopes(taskText));
if (outsideAllowedChangedFiles.length > 0 && !isRejectArchive) {
	throw new Error(
		`agent-build-review-loop cannot archive because changed files are outside task allowed paths: ${outsideAllowedChangedFiles.join(", ")}`,
	);
}
if (changedFiles.length === 0 && !allowsNoChange(taskText) && !isRejectArchive) {
	throw new Error("agent-build-review-loop cannot archive without project changes unless task.md explicitly allows No-Code/No-Change");
}
if (archivedEvidenceFiles.length === 0) {
	throw new Error("agent-build-review-loop cannot archive without loop evidence artifacts");
}
const downstreamClaimFiles = await downstreamCompletionClaimFiles(evidenceFiles);
if (downstreamClaimFiles.length > 0) {
	throw new Error(
		`agent-build-review-loop cannot archive because round evidence claims downstream workflow node completion: ${downstreamClaimFiles.join(", ")}`,
	);
}
const nondurableArtifactFiles = await nondurableArtifactReferenceFiles(evidenceFiles);
if (nondurableArtifactFiles.length > 0) {
	throw new Error(
		`agent-build-review-loop cannot archive because round evidence uses nondurable artifact references: ${nondurableArtifactFiles.join(", ")}`,
	);
}
const missingValidationArtifactRounds = await missingValidationArtifactRoundFiles(progressText);
if (missingValidationArtifactRounds.length > 0) {
	throw new Error(
		`agent-build-review-loop cannot archive because validation rounds are missing durable stdout/stderr artifacts: ${missingValidationArtifactRounds.join(", ")}`,
	);
}
const missingValidationAttemptRetentionRounds = await missingValidationAttemptRetentionRoundFiles(evidenceFiles);
if (missingValidationAttemptRetentionRounds.length > 0) {
	throw new Error(
		`agent-build-review-loop cannot archive because validation rerun evidence lacks immutable attempt logs: ${missingValidationAttemptRetentionRounds.join(", ")}`,
	);
}
const archive = [
	"# Agent Build/Review Loop Archive",
	"",
	"## Task Hash",
	"",
	String(Bun.hash(taskText)),
	"",
	"## Task",
	"",
	boundedLines(taskText, 160),
	"",
	"## Progress",
	"",
	progressText.trim() ? boundedLines(progressText, 160) : "No progress.md was present.",
	"",
	"## Loop Health",
	"",
	`- Terminal decision: ${isRejectArchive ? "reject" : "complete"}`,
	`- Review route: ${reviewRoute.reason ?? "not recorded"}`,
	`- Recorded rounds: ${roundCount}`,
	`- Changed files: ${changedFiles.length}`,
	`- Evidence files: ${archivedEvidenceFiles.length}`,
	"",
	"## Review Route",
	"",
	JSON.stringify(reviewRoute, null, 2),
	"",
	"## Changed Files",
	"",
	changedFiles.length > 0 ? changedFiles.map(file => `- ${file}`).join("\n") : "No changed files; task contract explicitly allowed no-code/no-change evidence.",
	"",
	"## Archived Evidence Files",
	"",
	archivedEvidenceFiles.map(file => `- ${file}`).join("\n"),
	"",
	"## Declared Verification Command",
	"",
	verifyCommand,
	"",
	"## Workspace Snapshot",
	"",
	"Workspace file listing is intentionally omitted from this portable flow script.",
	"Reviewers should inspect the current project diff and task contract directly.",
	"",
].join("\n");

await Bun.write(archivePath, archive);
await writeTupleState({
	status: isRejectArchive ? "rejected" : "completed",
	finalArtifact: archivePath,
	reviewRoute,
	roundCount,
	changedFiles,
	evidenceFiles: archivedEvidenceFiles,
	tupleId,
});

if (isRejectArchive) {
	throw new Error(`agent-build-review-loop rejected: ${reviewRoute.reason ?? "review route rejected"}; see ${archivePath}`);
}

return {
	summary: "archived completed agent build/review loop",
	statePatch: [
		{
			op: "set",
			path: "/archive",
			value: {
				file: archivePath,
				verification: "archived-from-loop-evidence",
				verificationCommand: verifyCommand,
				evidenceFiles: archivedEvidenceFiles,
				roundCount,
				changedFiles,
				terminalDecision: isRejectArchive ? "reject" : "complete",
				reviewRoute,
				taskHash: String(Bun.hash(taskText)),
			},
		},
	],
};

async function writeTupleState({ status, finalArtifact, reviewRoute, roundCount, changedFiles, evidenceFiles, tupleId }) {
	const verdict = status === "rejected" ? "reject" : (reviewRoute.decision ?? "complete");
	const state = {
		flow: "agent-build-review-loop",
		...(tupleId ? { tuple_id: tupleId } : {}),
		status,
		terminal: true,
		verdict,
		evidence_contract_verdict: status === "rejected" ? "REPAIR" : "READY",
		final_artifact: finalArtifact,
		reason: reviewRoute.reason ?? "",
		review_decision: reviewRoute.decision ?? "",
		review_verdict: reviewRoute.reviewVerdict ?? "",
		round_count: roundCount,
		changed_files: changedFiles,
		evidence_files: evidenceFiles,
		checked_at_ms: Date.now(),
	};
	await Bun.write("workflow-output/tuple-state.json", `${JSON.stringify(state, null, 2)}\n`);
}

function taskTupleId(taskText) {
	const match = /(?:^|\n)\s*(?:tuple(?:\s+id)?|tuple_id)\s*:\s*(\S[^\r\n]*)/iu.exec(taskText);
	return match?.[1]?.trim() ?? "";
}

async function existingArchiveOwnedFinalizationArtifacts() {
	const files = [];
	for (const file of [
		"workflow-output/tuple-state.json",
		"workflow-output/final-agent-loop-archive.md",
		"workflow-output/final-agent-loop-reject.md",
	]) {
		if (await Bun.file(file).exists()) files.push(file);
	}
	return files;
}

async function readOptionalText(filePath) {
	try {
		return await Bun.file(filePath).text();
	} catch {
		return "";
	}
}

function requiredTaskValidationCommand(taskText) {
	const lines = taskText.split(/\r?\n/u);
	for (let index = 0; index < lines.length; index += 1) {
		const match = /^\s*(?:verify|verification command|validation command)\s*:\s*(.*)\s*$/iu.exec(lines[index] ?? "");
		if (!match) continue;
		const inlineCommand = match[1]?.trim();
		if (inlineCommand) return inlineCommand;
		const followingCommand = firstFollowingCommandLine(lines, index + 1);
		if (followingCommand) return followingCommand;
	}
	throw new Error("agent-build-review-loop task.md must declare a Validation Command");
}

function assertSafeVerificationCommand(command) {
	const normalized = command.toLowerCase();
	if (/\b(sleep|watch|tail\s+-f|yes)\b/u.test(normalized)) {
		throw new Error("agent-build-review-loop validation command cannot be a wait/watch/sleep command");
	}
	const timeoutMatch = /\btimeout\s+(\d+)([smhd]?)\b/u.exec(normalized);
	if (timeoutMatch) {
		const value = Number(timeoutMatch[1]);
		const unit = timeoutMatch[2] || "s";
		const seconds = unit === "d" ? value * 86400 : unit === "h" ? value * 3600 : unit === "m" ? value * 60 : value;
		if (seconds > 900) {
			throw new Error("agent-build-review-loop validation command timeout must be 15 minutes or less");
		}
	}
}

function assertReviewRouteCanArchive(reviewRoute, isRejectArchive) {
	if (isRejectArchive) return;
	if (reviewRoute.decision && reviewRoute.decision !== "complete") {
		throw new Error(`agent-build-review-loop cannot archive because review route decision is ${reviewRoute.decision}`);
	}
	const reviewSummary =
		typeof reviewRoute.reviewSummary === "string"
			? reviewRoute.reviewSummary
			: typeof reviewRoute.reason === "string"
				? reviewRoute.reason
				: "";
	if (reviewRoute.reviewVerdict === "continue" && mentionsBuildOrRepairWorkStillNeeded(reviewSummary)) {
		throw new Error("agent-build-review-loop cannot archive because review route still requests build or repair work");
	}
}

function mentionsBuildOrRepairWorkStillNeeded(text) {
	return (
		/\banother\s+build(?:\/review)?(?:\/archive)?\s+(?:round|route|cycle)\s+(?:is\s+)?(?:still\s+)?needed\b/iu.test(
			text,
		) ||
		/\b(?:scope|evidence)\s+gaps?\b.{0,120}\b(?:resolve|repair|fix|needed|rather than archive)\b/ius.test(text) ||
		/\b(?:outside|escapes?)\b.{0,120}\b(?:task\.md'?s?\s+declared\s+)?allowed paths?\b/ius.test(text) ||
		/\boutside\b.{0,120}\b(?:scope|task[- ]declared)\b/ius.test(text) ||
		/\b(?:task[- ]specific acceptance|acceptance criteria)\b.{0,120}\b(?:not yet met|not met|unmet)\b/ius.test(
			text,
		)
	);
}

function firstFollowingCommandLine(lines, startIndex) {
	for (const line of lines.slice(startIndex)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("```")) continue;
		if (isTaskSectionHeading(trimmed)) return "";
		return trimmed;
	}
	return "";
}

function isTaskSectionHeading(line) {
	return line.startsWith("#") || /^[A-Z][A-Za-z /-]{0,80}:\s*$/u.test(line);
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

function changedFilesOutsideAllowedScopes(changedFiles, allowedScopes) {
	if (allowedScopes.length === 0) return [];
	return changedFiles
		.filter(file => allowedScopes.every(scope => !scopeMatchesPath(scope, file)))
		.sort((left, right) => left.localeCompare(right, "en"));
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
	return filePath.replace(/^\.\//u, "").replace(/\\/gu, "/").replace(/[),.;:]+$/u, "");
}

async function loopEvidenceFiles() {
	const files = [];
	try {
		const glob = new Bun.Glob("workflow-output/**");
		for await (const file of glob.scan({ cwd: process.cwd(), onlyFiles: true })) {
			if (/^workflow-output\/(?:round-\d+(?:-|\/)|review-route-\d+\.json|setup[-_]?blocker)/u.test(file)) {
				files.push(file);
			}
		}
	} catch {
		return [];
	}
	return files.sort((left, right) => left.localeCompare(right, "en"));
}

function mergedEvidenceFiles(files, extraFiles) {
	const merged = new Set(files);
	if (Array.isArray(extraFiles)) {
		for (const file of extraFiles) {
			if (typeof file === "string" && file.trim()) merged.add(file.trim());
		}
	}
	return Array.from(merged).sort((left, right) => left.localeCompare(right, "en"));
}

async function downstreamCompletionClaimFiles(files) {
	const claimFiles = [];
	for (const file of files) {
		if (!/^workflow-output\/round-\d+\//u.test(file)) continue;
		const text = await readOptionalText(file);
		if (claimsDownstreamWorkflowNodeCompletion(text)) claimFiles.push(file);
	}
	return claimFiles;
}

async function nondurableArtifactReferenceFiles(files) {
	const claimFiles = [];
	for (const file of files) {
		if (!/^workflow-output\/round-\d+\//u.test(file)) continue;
		const text = await readOptionalText(file);
		if (usesNondurableValidationArtifact(text)) claimFiles.push(file);
	}
	return claimFiles;
}

async function missingValidationArtifactRoundFiles(progressText) {
	const missingRoundDirs = [];
	for (const round of validationRounds(progressText)) {
		const roundDir = `workflow-output/round-${round}`;
		const hasStdout = await Bun.file(`${roundDir}/validation-stdout.txt`).exists();
		const hasStderr = await Bun.file(`${roundDir}/validation-stderr.txt`).exists();
		if (!hasStdout || !hasStderr) missingRoundDirs.push(roundDir);
	}
	return missingRoundDirs;
}

async function missingValidationAttemptRetentionRoundFiles(files) {
	const requiredAttemptsByRound = new Map();
	for (const file of files) {
		const roundDir = roundEvidenceDir(file);
		if (!roundDir) continue;
		const text = await readOptionalText(file);
		const attempts = requiredValidationAttempts(text);
		if (attempts.length > 0) addRequiredAttempts(requiredAttemptsByRound, roundDir, attempts);
	}
	return Array.from(requiredAttemptsByRound.entries())
		.filter(([roundDir, attempts]) => missingValidationAttemptLogFiles(files, roundDir, attempts).length > 0)
		.map(([roundDir, attempts]) => {
			const missingFiles = missingValidationAttemptLogFiles(files, roundDir, attempts);
			return `${roundDir} missing ${missingFiles.join(", ")}`;
		})
		.sort((left, right) => left.localeCompare(right, "en"));
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

function ignoredEvidencePath(file) {
	return (
		file === "evidence-ledger.jsonl" ||
		file === "manifest-entry.json" ||
		file === "monitor-assignment.json" ||
		file === "task.md" ||
		file === "progress.md" ||
		file.startsWith("workflow-output/") ||
		file.includes("/.pytest_cache/") ||
		file.includes("/node_modules/") ||
		file.includes("/.venv/")
	);
}

function progressRoundCount(progressText) {
	return progressRoundLabels(progressText).filter(round => round > 0).length;
}

function evidenceRoundCount(files) {
	let maxRound = 0;
	for (const file of files) {
		const match = /^workflow-output\/round-(\d+)(?:-|\/)/u.exec(file);
		if (!match) continue;
		maxRound = Math.max(maxRound, Number(match[1]));
	}
	return maxRound;
}

function nonPositiveProgressRoundLabels(progressText) {
	return progressRoundLabels(progressText).filter(round => round <= 0).map(round => `ROUND ${round}`);
}

function progressRoundLabels(progressText) {
	return [...progressText.matchAll(/^\s*ROUND\s+(\d+)\s*:/gimu)]
		.map(match => Number(match[1]))
		.filter(round => Number.isInteger(round));
}

function allowsNoChange(taskText) {
	return /(^|\n)\s*(?:#+\s*)?(?:no-code|no-change)\s+allowed\s*:/iu.test(taskText);
}

function boundedLines(text, limit) {
	const lines = text.split(/\r?\n/u);
	const kept = lines.slice(0, limit);
	if (lines.length > limit) kept.push(`[truncated ${lines.length - limit} additional lines]`);
	return kept.join("\n");
}

function uniqueSorted(files) {
	return Array.from(new Set(files)).sort((left, right) => left.localeCompare(right, "en"));
}

async function readRequiredTaskText() {
	const taskText = await readOptionalText("task.md");
	if (!taskText.trim()) {
		throw new Error("agent-build-review-loop requires a task.md contract in the project root");
	}
	return taskText;
}
