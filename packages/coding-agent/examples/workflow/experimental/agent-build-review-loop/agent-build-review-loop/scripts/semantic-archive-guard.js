const MAX_FILE_BYTES = 512_000;
const REPEATED_LINE_MIN_COUNT = 20;
const REPEATED_LINE_RATIO = 0.45;
const LOW_UNIQUE_LINE_RATIO = 0.2;
const PADDING_WORD_PATTERN = /\b(padding|dummy|placeholder|lorem|sleep|hold|no-op|noop|filler)\b/iu;
const VALIDATION_HARNESS_BOOTSTRAP_PATTERN =
	/\b(?:(?:npm|pnpm|yarn|bun)(?:\s+\S+){0,5}\s+(?:install|add|ci|update|upgrade)|(?:pip|pip3)(?:\s+\S+){0,5}\s+install|python(?:3)?\s+-m\s+pip(?:\s+\S+){0,5}\s+install|uv\s+(?:sync|add|pip\s+install)|poetry\s+(?:install|add|update)|cargo\s+(?:install|update)|bundle\s+install|go\s+(?:install|get))\b/iu;

const taskText = await readOptionalText("task.md");
const explicitAllowance = explicitLowSemanticAllowance(taskText);
const changedFiles = await changedProjectFiles();
const findings = [];

for (const file of changedFiles) {
	if (ignoredEvidencePath(file)) continue;
	const text = await readTextFileIfSmall(file);
	if (text === null) continue;
	const finding = analyzeTextFile(file, text);
	if (finding !== null) findings.push(finding);
}
findings.push(...(await dependencyBootstrapFindings()));
findings.push(...(await downstreamCompletionClaimFindings()));

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
	if (rename) return normalizeGitPath(rename[2]?.trim() ?? "");
	return normalizeGitPath(trimmed.slice(2).trim());
}

function normalizeGitPath(filePath) {
	if (filePath.startsWith('"') && filePath.endsWith('"')) return filePath.slice(1, -1);
	return filePath;
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

function normalizeLine(line) {
	return line.trim().replace(/\s+/gu, " ");
}

function explicitLowSemanticAllowance(text) {
	return /(^|\n)\s*(?:#+\s*)?(?:generated fixture allowed|low-semantic repetition allowed|bulk fixture allowed)\s*:\s*yes\b/iu.test(
		text,
	);
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
		file.includes("/.pytest_cache/") ||
		file.includes("/node_modules/") ||
		file.includes("/.venv/") ||
		file.includes("/dist/") ||
		file.includes("/build/")
	);
}
