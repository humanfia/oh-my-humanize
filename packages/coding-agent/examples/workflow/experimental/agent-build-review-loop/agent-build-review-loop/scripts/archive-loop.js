const taskText = await readRequiredTaskText();
const progressText = await readOptionalText("progress.md");
const reviewRoute = workflowContext.state?.reviewRoute && typeof workflowContext.state.reviewRoute === "object" ? workflowContext.state.reviewRoute : {};
const isRejectArchive = reviewRoute.decision === "reject";
const archivePath = isRejectArchive ? "workflow-output/final-agent-loop-reject.md" : "workflow-output/final-agent-loop-archive.md";
const verifyCommand = requiredTaskValidationCommand(taskText);
assertSafeVerificationCommand(verifyCommand);
const evidenceFiles = await loopEvidenceFiles();
const archivedEvidenceFiles = mergedEvidenceFiles(evidenceFiles, isRejectArchive ? reviewRoute.setupBlockerEvidenceFiles : []);
const roundCount = Math.max(progressRoundCount(progressText), evidenceRoundCount(evidenceFiles));
if (roundCount === 0 && !isRejectArchive) {
	throw new Error("agent-build-review-loop cannot archive without at least one ROUND entry in progress.md");
}
const changedFiles = await changedProjectFiles();
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
	if (rename) return rename[2]?.trim() ?? "";
	return trimmed.slice(2).trim();
}

async function loopEvidenceFiles() {
	const files = [];
	try {
		const glob = new Bun.Glob("workflow-output/**");
		for await (const file of glob.scan({ cwd: process.cwd(), onlyFiles: true })) {
			if (/^workflow-output\/(?:round-\d+(?:-|\/)|setup[-_]?blocker)/u.test(file)) files.push(file);
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
	return progressText.split(/\r?\n/u).filter(line => line.startsWith("ROUND ")).length;
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

function allowsNoChange(taskText) {
	return /(^|\n)\s*(?:#+\s*)?(?:no-code|no-change)\s+allowed\s*:/iu.test(taskText);
}

function boundedLines(text, limit) {
	const lines = text.split(/\r?\n/u);
	const kept = lines.slice(0, limit);
	if (lines.length > limit) kept.push(`[truncated ${lines.length - limit} additional lines]`);
	return kept.join("\n");
}

async function readRequiredTaskText() {
	const taskText = await readOptionalText("task.md");
	if (!taskText.trim()) {
		throw new Error("agent-build-review-loop requires a task.md contract in the project root");
	}
	return taskText;
}
