const broadChangePattern =
	/\b(repo[- ]?wide|whole[- ]?repo|whole[- ]?repository|global format|formatter migration|mechanical migration|format all|large refactor|mass update|broad(?:[- ]+\w+){0,3}[- ]?(?:churn|rewrite|refactor|change|changes|formatting))\b/iu;
const broadChangeAllowancePattern =
	/\b(allow|allowed|allows|may|can|expected|required|requires|perform|include|includes|scope includes)\b/iu;
const broadChangeDenialPattern =
	/\b(out[- ]of[- ]scope|out of scope|without|reject|rejecting|avoid|stop if|must not|do not|don't|forbid|forbidden|prohibit|prohibited|no)\b/iu;
const state = workflowContext.state && typeof workflowContext.state === "object" ? workflowContext.state : {};
const humanize = state.humanize && typeof state.humanize === "object" ? state.humanize : {};
const ledger = humanize.ledger && typeof humanize.ledger === "object" ? humanize.ledger : {};
const roundNumber = Number.isFinite(ledger.currentRound) ? ledger.currentRound + 1 : 1;
const evidenceFile = `workflow-output/round-${roundNumber}-diff-discipline-guard.json`;

async function runGit(args) {
	const child = Bun.spawn(["git", ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdoutPromise = new Response(child.stdout).text();
	const stderrPromise = new Response(child.stderr).text();
	const exitCode = await child.exited;
	const stdout = await stdoutPromise;
	const stderr = await stderrPromise;
	return { exitCode, stdout, stderr };
}

function parseNumstat(text) {
	const files = [];
	let added = 0;
	let deleted = 0;
	let binaryFiles = 0;
	for (const line of text.split(/\r?\n/u)) {
		if (!line.trim()) continue;
		const [rawAdded, rawDeleted, ...pathParts] = line.split("\t");
		const file = pathParts.join("\t");
		if (!file) continue;
		const fileAdded = Number(rawAdded);
		const fileDeleted = Number(rawDeleted);
		if (!Number.isFinite(fileAdded) || !Number.isFinite(fileDeleted)) {
			binaryFiles += 1;
			files.push({ file, added: 0, deleted: 0, binary: true });
			continue;
		}
		added += fileAdded;
		deleted += fileDeleted;
		files.push({ file, added: fileAdded, deleted: fileDeleted });
	}
	return {
		added,
		deleted,
		total: added + deleted,
		fileCount: files.length,
		binaryFiles,
		files,
	};
}

function changedPathFromStatus(line) {
	const path = line.slice(3).trim();
	const renameArrow = " -> ";
	return path.includes(renameArrow) ? path.split(renameArrow).at(-1)?.trim() ?? path : path;
}

function isWorkflowArtifactPath(path) {
	return (
		path === "task.md" ||
		path === "manifest-entry.json" ||
		path === "monitor-assignment.json" ||
		path === "evidence-ledger.jsonl" ||
		path === "progress.md" ||
		path.startsWith("workflow-output/") ||
		path.startsWith("transcripts/")
	);
}

let taskText = "";
try {
	taskText = await Bun.file("task.md").text();
} catch {
	taskText = "";
}

const broadChangeAllowed = declaresBroadChangeAllowance(taskText);
const mechanicalOverheadBudget = declaredMechanicalOverheadBudget(taskText);
const status = await runGit(["status", "--short", "--untracked-files=all"]);
const regularDiff = await runGit(["diff", "--numstat"]);
const semanticDiff = await runGit(["diff", "-w", "--numstat"]);

if (regularDiff.exitCode !== 0 || semanticDiff.exitCode !== 0 || status.exitCode !== 0) {
	const diagnostic = {
		verdict: "REPAIR",
		round: roundNumber,
		evidenceFile,
		reasons: ["git diff discipline guard could not inspect repository state"],
		statusExitCode: status.exitCode,
		regularExitCode: regularDiff.exitCode,
		semanticExitCode: semanticDiff.exitCode,
		stderr: [status.stderr, regularDiff.stderr, semanticDiff.stderr].filter(Boolean).join("\n").slice(0, 1200),
		checkedAtMs: Date.now(),
	};
	await writeEvidence(diagnostic);
	return {
		summary: "diff discipline guard requires repair: repository diff inspection failed",
		data: diagnostic,
		statePatch: [{ op: "set", path: "/humanize/diffGuard", value: diagnostic }],
	};
}

const regular = parseNumstat(regularDiff.stdout);
const semantic = parseNumstat(semanticDiff.stdout);
const statusLines = status.stdout
	.split(/\r?\n/u)
	.map(line => line.trimEnd())
	.filter(line => line.length > 0);
const untrackedFiles = statusLines.filter(line => line.startsWith("?? ")).map(changedPathFromStatus);
const untrackedProjectFiles = untrackedFiles.filter(path => !isWorkflowArtifactPath(path));
const nondurableArtifactFiles = await nondurableArtifactReferenceFiles();
const semanticRatio = regular.total === 0 ? 1 : semantic.total / regular.total;
const mechanicalOverhead = Math.max(0, regular.total - semantic.total);
const mechanicalOverheadRatio = regular.total === 0 ? 0 : mechanicalOverhead / regular.total;
const reasons = [];

if (!broadChangeAllowed && regular.fileCount >= 20) {
	reasons.push(`changed ${regular.fileCount} files without an explicit repo-wide task contract`);
}

if (!broadChangeAllowed && regular.total >= 600 && mechanicalOverhead >= 400 && semanticRatio <= 0.4) {
	reasons.push(
		`diff looks mechanically broad: ${regular.total} changed lines, ${semantic.total} semantic lines with -w, ${mechanicalOverhead} whitespace/style overhead`,
	);
}

if (
	!broadChangeAllowed &&
	mechanicalOverheadBudget !== undefined &&
	mechanicalOverheadRatio > mechanicalOverheadBudget
) {
	reasons.push(
		`mechanical whitespace/style overhead exceeds task diff gate: ${Math.round(
			mechanicalOverheadRatio * 100,
		)}% overhead > ${Math.round(mechanicalOverheadBudget * 100)}% budget`,
	);
}

if (!broadChangeAllowed && regular.total >= 4000) {
	reasons.push(`diff is too large for a bounded RLCR implementation round: ${regular.total} changed lines`);
}

if (untrackedProjectFiles.length > 0) {
	reasons.push(
		`untracked project files must be staged or explicitly excluded before review: ${untrackedProjectFiles
			.slice(0, 8)
			.join(", ")}`,
	);
}

if (nondurableArtifactFiles.length > 0) {
	reasons.push(
		`implementation evidence uses nondurable artifact references; copy validation stdout/stderr/status into workflow-output before review: ${nondurableArtifactFiles
			.slice(0, 8)
			.join(", ")}`,
	);
}

const verdict = reasons.length === 0 ? "PASS" : "REPAIR";
const diagnostic = {
	verdict,
	round: roundNumber,
	evidenceFile,
	reasons,
	broadChangeAllowed,
	regular: {
		added: regular.added,
		deleted: regular.deleted,
		total: regular.total,
		fileCount: regular.fileCount,
		binaryFiles: regular.binaryFiles,
		files: regular.files.slice(0, 40),
	},
	semantic: {
		added: semantic.added,
		deleted: semantic.deleted,
		total: semantic.total,
		fileCount: semantic.fileCount,
		binaryFiles: semantic.binaryFiles,
		files: semantic.files.slice(0, 40),
	},
	mechanicalOverhead,
	mechanicalOverheadRatio,
	mechanicalOverheadBudget,
	semanticRatio,
	untrackedFiles: untrackedFiles.slice(0, 40),
	untrackedProjectFiles: untrackedProjectFiles.slice(0, 40),
	nondurableArtifactFiles: nondurableArtifactFiles.slice(0, 40),
	checkedAtMs: Date.now(),
};

await writeEvidence(diagnostic);

return {
	summary:
		verdict === "PASS"
			? `diff discipline guard passed: ${regular.fileCount} files, ${regular.total} lines`
			: `diff discipline guard requires repair: ${reasons.join("; ")}`,
	data: diagnostic,
	statePatch: [{ op: "set", path: "/humanize/diffGuard", value: diagnostic }],
};

async function writeEvidence(diagnostic) {
	await Bun.write(
		evidenceFile,
		`${JSON.stringify(
			{
				flow: "humanize-rlcr",
				node: "diffDisciplineGuard",
				activationId: workflowContext.activation.id,
				...diagnostic,
			},
			null,
			2,
		)}\n`,
	);
}

function declaredMechanicalOverheadBudget(text) {
	if (!text.trim()) return undefined;
	const percentMatch =
		/\b(?:whitespace|formatter|formatting|mechanical|style)(?:[\s\S]{0,120}?)(?:below|under|less than|<=?|at most|max(?:imum)?)(?:\s+of)?\s+(\d{1,2})(?:\s*%|\s+percent)\b/iu.exec(
			text,
		) ??
		/\b(?:below|under|less than|<=?|at most|max(?:imum)?)(?:\s+of)?\s+(\d{1,2})(?:\s*%|\s+percent)(?:[\s\S]{0,120}?)(?:whitespace|formatter|formatting|mechanical|style)\b/iu.exec(
			text,
		);
	if (!percentMatch) return undefined;
	const percent = Number(percentMatch[1]);
	if (!Number.isFinite(percent) || percent < 0 || percent > 99) return undefined;
	return percent / 100;
}

function declaresBroadChangeAllowance(text) {
	if (!text.trim()) return false;
	for (const rawLine of text.split(/\r?\n/u)) {
		const line = rawLine.trim();
		if (!line || !broadChangePattern.test(line)) continue;
		if (broadChangeDenialPattern.test(line)) continue;
		if (broadChangeAllowancePattern.test(line)) return true;
	}
	return false;
}

async function nondurableArtifactReferenceFiles() {
	const files = [];
	try {
		const glob = new Bun.Glob("workflow-output/**/*");
		for await (const file of glob.scan({ cwd: process.cwd(), onlyFiles: true })) {
			if (!/^workflow-output\/(?:implementation|review-fix|round-\d+-summary|round-\d+\/)/u.test(file)) {
				continue;
			}
			const text = await readOptionalText(file);
			if (usesNondurableArtifactReference(text)) files.push(file);
		}
	} catch {
		return [];
	}
	return files.sort((left, right) => left.localeCompare(right, "en"));
}

function usesNondurableArtifactReference(text) {
	return (
		/\b(?:validation|stdout|stderr|evidence|harness|status).{0,160}\bartifact:\/\/\d+\b/ius.test(text) ||
		/\bartifact:\/\/\d+\b.{0,160}\b(?:validation|stdout|stderr|evidence|harness|status)\b/ius.test(text)
	);
}

async function readOptionalText(filePath) {
	try {
		return await Bun.file(filePath).text();
	} catch {
		return "";
	}
}
