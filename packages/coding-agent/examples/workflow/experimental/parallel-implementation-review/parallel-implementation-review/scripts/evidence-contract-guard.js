const taskText = await readRequiredTaskText();
const tupleId = await tupleIdFromRunArtifacts();
const validationCommand = validationCommandFromTask(taskText);
const validationEnvironment = validationEnvironmentFromTask(taskText);
const manualEvidenceAllowed = hasHeadingOrField(taskText, "manual evidence allowed");
const changedFiles = await changedProjectFiles();
const evidenceFiles = await workflowEvidenceFiles();
const validationMatch = await validationEvidenceMatches(evidenceFiles, validationCommand, validationEnvironment);
const staleValidationHashArtifacts = await staleValidationHashArtifactsFromEvidence(evidenceFiles);
const mechanicalSurfaceInventoryArtifacts = await mechanicalSurfaceInventoryArtifactsFromEvidence(evidenceFiles);
const validationArtifacts = validationMatch.passedFiles;
const finalValidationArtifacts = [...validationMatch.passedFiles, ...validationMatch.failedFiles]
	.filter(file => isFinalDeclaredValidationArtifact(file, tupleId))
	.sort((left, right) => left.localeCompare(right, "en"));
const trustedFinalValidationArtifacts = validationMatch.trustedFinalFiles.filter(file =>
	isFinalDeclaredValidationArtifact(file, tupleId),
);
const trustedFailedFinalValidationArtifacts = validationMatch.trustedFailedFinalFiles.filter(file =>
	isFinalDeclaredValidationArtifact(file, tupleId),
);
const trustedDeclaredValidationArtifacts = [
	...trustedFinalValidationArtifacts,
	...trustedFailedFinalValidationArtifacts,
].sort((left, right) => left.localeCompare(right, "en"));
const untrustedFinalValidationArtifacts = finalValidationArtifacts.filter(
	file => !trustedDeclaredValidationArtifacts.includes(file),
);
const genericValidationAliases = genericValidationAliasArtifacts(evidenceFiles);
const laneHardStopResult = laneHardStopResultFromState(workflowContext.state);
const activeLaneHardStopArtifacts = laneHardStopResult.active;
const reservedFinalArtifacts = laneHardStopResult.reservedFinalArtifacts;
const quarantinedReservedFinalArtifacts = laneHardStopResult.quarantinedReservedFinalArtifacts;
const supersededFailedValidationArtifacts =
	trustedDeclaredValidationArtifacts.length > 0
		? validationMatch.failedFiles.filter(file => !isFinalDeclaredValidationArtifact(file, tupleId))
		: [];
const failedValidationArtifacts = validationMatch.failedFiles.filter(file => !supersededFailedValidationArtifacts.includes(file));
const conflictingFailedValidationArtifacts = failedValidationArtifacts.filter(
	file => !trustedFailedFinalValidationArtifacts.includes(file),
);
const prematureDecisionArtifacts = await prematureDecisionArtifactFiles();
const coreArtifacts = evidenceFiles.filter(isCoreLaneEvidenceFile);
const testArtifacts = evidenceFiles.filter(isTestLaneEvidenceFile);
const docsArtifacts = evidenceFiles.filter(isDocsLaneEvidenceFile);
const integrationArtifacts = evidenceFiles.filter(isIntegrationReviewEvidenceFile);
const rollbackArtifacts = evidenceFiles.filter(isRollbackEvidenceFile);
const expectedReferencedArtifacts = expectedReferencedArtifactsFromState(workflowContext.state, tupleId);
const missingReferencedArtifacts = await missingExpectedArtifacts(expectedReferencedArtifacts);
const laneArtifacts = [...coreArtifacts, ...testArtifacts, ...docsArtifacts, ...integrationArtifacts].sort((left, right) =>
	left.localeCompare(right, "en"),
);
const missingRollbackFiles = await missingRollbackCoverage(changedFiles, rollbackArtifacts);
const validationAttemptLogFindings = await validationAttemptLogFindingsFromEvidence(testArtifacts);
const reasons = [];

if (!validationCommand && !manualEvidenceAllowed) {
	reasons.push("task.md must declare a Validation Command or Manual Evidence Allowed");
}

if (coreArtifacts.length === 0) {
	reasons.push("no core lane evidence artifact was found under workflow-output/");
}

if (testArtifacts.length === 0) {
	reasons.push("no tests lane evidence artifact was found under workflow-output/");
}

if (docsArtifacts.length === 0) {
	reasons.push("no docs/evidence lane artifact was found under workflow-output/");
}

if (integrationArtifacts.length === 0) {
	reasons.push("no tuple-scoped integration review artifact was found under workflow-output/");
}

if (missingReferencedArtifacts.length > 0) {
	reasons.push(
		`referenced workflow-output artifacts were not materialized: ${missingReferencedArtifacts.join(", ")}; plan and review handoffs must agree with the durable artifacts produced before strong review`,
	);
}

if (missingRollbackFiles.length > 0) {
	reasons.push(
		`rollback evidence does not cover changed project files: ${missingRollbackFiles.join(", ")}; rollback evidence must mention every changed file after parallel lanes join`,
	);
}

if (!manualEvidenceAllowed && validationArtifacts.length === 0) {
	reasons.push("no passed validation evidence artifact was found under workflow-output/");
	if (validationMatch.reasons.length > 0) reasons.push(...validationMatch.reasons);
}

if (!manualEvidenceAllowed && trustedDeclaredValidationArtifacts.length === 0) {
	reasons.push("no trusted runDeclaredValidation artifact was found under workflow-output/");
}

if (!manualEvidenceAllowed && trustedFailedFinalValidationArtifacts.length > 0) {
	reasons.push(
		`trusted runDeclaredValidation artifact reported failed validation: ${trustedFailedFinalValidationArtifacts.join(", ")}`,
	);
}

if (!manualEvidenceAllowed && untrustedFinalValidationArtifacts.length > 0) {
	reasons.push(
		`untrusted final validation artifact shape found: ${untrustedFinalValidationArtifacts.join(", ")}; final validation artifacts must be produced by runDeclaredValidation`,
	);
}

if (genericValidationAliases.length > 0) {
	reasons.push(
		`generic validation aliases found: ${genericValidationAliases.join(", ")}; validation evidence must be tuple-scoped and producer-owned`,
	);
}

if (!manualEvidenceAllowed && conflictingFailedValidationArtifacts.length > 0) {
	reasons.push(
		`conflicting failed validation evidence found under workflow-output/: ${conflictingFailedValidationArtifacts.join(", ")}; rerun the declared validation after all lane work and leave one unambiguous final validation record`,
	);
}

if (!manualEvidenceAllowed && staleValidationHashArtifacts.length > 0) {
	reasons.push(
		`stale validation evidence hashes found: ${staleValidationHashArtifacts.join(", ")}; validation artifacts must still match the hashes recorded by their producer`,
	);
}

if (!manualEvidenceAllowed && validationAttemptLogFindings.length > 0) {
	reasons.push(
		`validation rerun evidence is missing immutable attempt logs: ${validationAttemptLogFindings
			.map(finding => finding.file)
			.join(", ")}; every validation rerun must preserve attempt-scoped stdout, stderr, and exitcode artifacts`,
	);
}

if (mechanicalSurfaceInventoryArtifacts.length > 0) {
	reasons.push(
		`mechanical surface inventory used as semantic evidence: ${mechanicalSurfaceInventoryArtifacts.join(", ")}; parsed file/test/function inventories are index-only and cannot satisfy investigation or promotion evidence`,
	);
}

if (prematureDecisionArtifacts.length > 0) {
	reasons.push(
		`premature final decision artifacts found before strong review: ${prematureDecisionArtifacts.join(", ")}; only the strongReview node may write promotion artifacts`,
	);
}

if (reservedFinalArtifacts.length > 0) {
	reasons.push(
		`parallel lanes produced reserved final artifacts before the finalizer: ${reservedFinalArtifacts.join(", ")}; laneHardStopGuard quarantined them and promotion must be rejected`,
	);
}

if (activeLaneHardStopArtifacts.length > 0) {
	reasons.push(
		`parallel lane hard stop artifacts found: ${activeLaneHardStopArtifacts.join(", ")}; hard stops must be resolved or superseded before promotion`,
	);
}

const verdict = reasons.length === 0 ? "READY" : "REPAIR";
const diagnostic = {
	tuple_id: tupleId,
	verdict,
	status: verdict,
	reasons,
	validation_command: validationCommand,
	validation_environment: validationEnvironment,
	manual_evidence_allowed: manualEvidenceAllowed,
	changed_files: changedFiles.slice(0, 200),
	evidence_files: evidenceFiles.slice(0, 200),
	checked_inputs: {
		core_artifacts: coreArtifacts.slice(0, 40),
		test_artifacts: testArtifacts.slice(0, 40),
		docs_artifacts: docsArtifacts.slice(0, 40),
		integration_artifacts: integrationArtifacts.slice(0, 40),
		rollback_artifacts: rollbackArtifacts.slice(0, 40),
		missing_rollback_files: missingRollbackFiles.slice(0, 80),
		expected_referenced_artifacts: expectedReferencedArtifacts.slice(0, 80),
		missing_referenced_artifacts: missingReferencedArtifacts.slice(0, 80),
		lane_artifacts: laneArtifacts.slice(0, 80),
		validation_artifacts: validationArtifacts.slice(0, 80),
		final_validation_artifacts: finalValidationArtifacts.slice(0, 80),
		trusted_final_validation_artifacts: trustedFinalValidationArtifacts.slice(0, 80),
		trusted_failed_final_validation_artifacts: trustedFailedFinalValidationArtifacts.slice(0, 80),
		untrusted_final_validation_artifacts: untrustedFinalValidationArtifacts.slice(0, 80),
		generic_validation_aliases: genericValidationAliases.slice(0, 80),
		lane_hard_stop_artifacts: activeLaneHardStopArtifacts.slice(0, 80),
		ignored_historical_lane_hard_stop_artifacts: laneHardStopResult.ignored.slice(0, 80),
		ignored_nonterminal_lane_hard_stop_artifacts: laneHardStopResult.nonterminal.slice(0, 80),
		failed_validation_artifacts: failedValidationArtifacts.slice(0, 80),
		superseded_failed_validation_artifacts: supersededFailedValidationArtifacts.slice(0, 80),
		stale_validation_hash_artifacts: staleValidationHashArtifacts.slice(0, 80),
		validation_attempt_log_findings: validationAttemptLogFindings.slice(0, 80),
		mechanical_surface_inventory_artifacts: mechanicalSurfaceInventoryArtifacts.slice(0, 80),
		premature_decision_artifacts: prematureDecisionArtifacts.slice(0, 80),
		reserved_final_artifacts: reservedFinalArtifacts.slice(0, 80),
		quarantined_reserved_final_artifacts: quarantinedReservedFinalArtifacts.slice(0, 80),
	},
	checked_at_ms: Date.now(),
};
const guardArtifact = `workflow-output/evidence-contract-guard${tupleId ? `-${tupleId}` : ""}.json`;
const guardSummaryArtifact = `workflow-output/evidence-contract-summary${tupleId ? `-${tupleId}` : ""}.txt`;

await Bun.write(guardArtifact, `${JSON.stringify(diagnostic, null, 2)}\n`);
await Bun.write(
	guardSummaryArtifact,
	[
		"Parallel implementation review validation contract",
		"",
		`verdict: ${verdict}`,
		`validation command: ${validationCommand || "(none)"}`,
		`manual evidence allowed: ${manualEvidenceAllowed ? "yes" : "no"}`,
		`guard artifact: ${guardArtifact}`,
		"",
		"Validation artifacts:",
		...(validationArtifacts.length > 0 ? validationArtifacts.map(file => `- ${file}`) : ["- (none)"]),
		"",
		"Trusted final validation artifacts:",
		...(trustedFinalValidationArtifacts.length > 0
			? trustedFinalValidationArtifacts.map(file => `- ${file}`)
			: ["- (none)"]),
		"",
		"Trusted failed final validation artifacts:",
		...(trustedFailedFinalValidationArtifacts.length > 0
			? trustedFailedFinalValidationArtifacts.map(file => `- ${file}`)
			: ["- (none)"]),
		"",
		"Untrusted final validation artifacts:",
		...(untrustedFinalValidationArtifacts.length > 0
			? untrustedFinalValidationArtifacts.map(file => `- ${file}`)
			: ["- (none)"]),
		"",
		"Generic validation aliases:",
		...(genericValidationAliases.length > 0 ? genericValidationAliases.map(file => `- ${file}`) : ["- (none)"]),
		"",
		"Lane hard-stop artifacts:",
		...(activeLaneHardStopArtifacts.length > 0
			? activeLaneHardStopArtifacts.map(file => `- ${file}`)
			: ["- (none)"]),
		"",
		"Ignored historical lane hard-stop artifacts:",
		...(laneHardStopResult.ignored.length > 0 ? laneHardStopResult.ignored.map(file => `- ${file}`) : ["- (none)"]),
		"",
		"Failed validation artifacts:",
		...(failedValidationArtifacts.length > 0 ? failedValidationArtifacts.map(file => `- ${file}`) : ["- (none)"]),
		"",
		"Superseded failed validation artifacts:",
		...(supersededFailedValidationArtifacts.length > 0
			? supersededFailedValidationArtifacts.map(file => `- ${file}`)
			: ["- (none)"]),
		"",
		"Stale validation hash artifacts:",
		...(staleValidationHashArtifacts.length > 0
			? staleValidationHashArtifacts.map(file => `- ${file}`)
			: ["- (none)"]),
		"",
		"Validation attempt log findings:",
		...(validationAttemptLogFindings.length > 0
			? validationAttemptLogFindings.map(finding => {
					const missing = finding.missing_files?.length ? ` missing: ${finding.missing_files.join(", ")}` : "";
					return `- ${finding.file}: ${finding.reason}${missing}`;
				})
			: ["- (none)"]),
		"",
		"Mechanical surface inventory artifacts:",
		...(mechanicalSurfaceInventoryArtifacts.length > 0
			? mechanicalSurfaceInventoryArtifacts.map(file => `- ${file}`)
			: ["- (none)"]),
		"",
		"Premature final decision artifacts:",
		...(prematureDecisionArtifacts.length > 0 ? prematureDecisionArtifacts.map(file => `- ${file}`) : ["- (none)"]),
		"",
		"Lane-quarantined reserved final artifacts:",
		...(reservedFinalArtifacts.length > 0 ? reservedFinalArtifacts.map(file => `- ${file}`) : ["- (none)"]),
		"",
		"Rollback artifacts:",
		...(rollbackArtifacts.length > 0 ? rollbackArtifacts.map(file => `- ${file}`) : ["- (none)"]),
		"",
		"Changed files missing rollback coverage:",
		...(missingRollbackFiles.length > 0 ? missingRollbackFiles.map(file => `- ${file}`) : ["- (none)"]),
		"",
		"Expected referenced artifacts:",
		...(expectedReferencedArtifacts.length > 0
			? expectedReferencedArtifacts.map(file => `- ${file}`)
			: ["- (none)"]),
		"",
		"Missing referenced artifacts:",
		...(missingReferencedArtifacts.length > 0
			? missingReferencedArtifacts.map(file => `- ${file}`)
			: ["- (none)"]),
		"",
		"Reasons:",
		...(reasons.length > 0 ? reasons.map(reason => `- ${reason}`) : ["- ready for strong review"]),
		"",
	].join("\n"),
);

return {
	summary:
		verdict === "READY"
			? `evidence contract ready: ${laneArtifacts.length} lane artifacts, ${validationArtifacts.length} validation artifacts`
			: `evidence contract requires repair: ${reasons.join("; ")}`,
	verdict,
	data: diagnostic,
	statePatch: [{ op: "set", path: "/evidenceContract", value: diagnostic }],
};

async function readRequiredTaskText() {
	try {
		const text = await Bun.file("task.md").text();
		if (text.trim()) return text;
	} catch {
		// Fall through to the explicit contract error below.
	}
	throw new Error("parallel-implementation-review requires a task.md contract in the project root");
}

async function tupleIdFromRunArtifacts() {
	const monitorTuple = await tupleIdFromJsonFile("monitor-assignment.json");
	if (monitorTuple) return monitorTuple;
	const manifestTuple = await tupleIdFromJsonFile("manifest-entry.json");
	if (manifestTuple) return manifestTuple;
	const taskTuple = tupleIdFromTaskText(taskText);
	if (taskTuple) return taskTuple;
	return "";
}

async function tupleIdFromJsonFile(filePath) {
	try {
		const data = await Bun.file(filePath).json();
		const candidate =
			stringField(data, "tupleId") ||
			stringField(data, "tuple_id") ||
			stringField(data, "runId") ||
			stringField(data, "run_id");
		return normalizeTupleId(candidate);
	} catch {
		return "";
	}
}

function tupleIdFromTaskText(text) {
	const match = /\b(?:tuple|tuple id|tuple-id|monitor|run id|canary tuple)\b[^A-Za-z0-9]+([A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+){1,8})/iu.exec(
		text,
	);
	return normalizeTupleId(match?.[1]);
}

function normalizeTupleId(value) {
	if (typeof value !== "string") return "";
	const trimmed = value.trim().replace(/^`+|`+$/gu, "");
	return /^[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+){1,8}$/u.test(trimmed) ? trimmed : "";
}

function stringField(value, key) {
	if (!value || typeof value !== "object") return "";
	const field = value[key];
	return typeof field === "string" ? field : "";
}

function validationCommandFromTask(text) {
	const lines = text.split(/\r?\n/u);
	for (let index = 0; index < lines.length; index += 1) {
		const match = validationCommandLineMatch(lines[index] ?? "");
		if (!match) continue;
		const inlineCommand = match[1]?.trim();
		if (inlineCommand) return stripMarkdownInlineCode(inlineCommand);
		const followingCommand = firstFollowingCommandLine(lines, index + 1);
		if (followingCommand) return followingCommand;
	}
	return "";
}

function validationEnvironmentFromTask(text) {
	const commandEnvironment = validationEnvironmentFromCommand(validationCommandFromTask(text));
	const lines = text.split(/\r?\n/u);
	for (let index = 0; index < lines.length; index += 1) {
		const match = validationEnvironmentLineMatch(lines[index] ?? "");
		if (!match) continue;
		const inlineValue = match[1]?.trim();
		const entries = inlineValue ? [stripMarkdownInlineCode(inlineValue)] : followingEnvironmentLines(lines, index + 1);
		const explicitEnvironment = Object.fromEntries(
			entries
				.flatMap(entry => entry.split(/\s+/u))
				.map(entry => /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(stripMarkdownInlineCode(entry)))
				.filter(Boolean)
				.map(matchResult => [matchResult[1] ?? "", matchResult[2] ?? ""]),
		);
		return { ...commandEnvironment, ...explicitEnvironment };
	}
	return commandEnvironment;
}

function validationEnvironmentFromCommand(command) {
	const environment = {};
	for (const token of leadingShellAssignmentTokens(command)) {
		const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(token);
		if (!match) break;
		environment[match[1] ?? ""] = unquoteShellAssignmentValue(match[2] ?? "");
	}
	return environment;
}

function leadingShellAssignmentTokens(command) {
	const tokens = [];
	let index = 0;
	while (index < command.length) {
		while (index < command.length && /\s/u.test(command[index] ?? "")) index += 1;
		if (index >= command.length) break;
		const start = index;
		let quote = "";
		while (index < command.length) {
			const char = command[index] ?? "";
			if (quote) {
				if (char === "\\" && quote === "\"" && index + 1 < command.length) {
					index += 2;
					continue;
				}
				if (char === quote) quote = "";
				index += 1;
				continue;
			}
			if (char === "'" || char === "\"") {
				quote = char;
				index += 1;
				continue;
			}
			if (/\s/u.test(char)) break;
			index += 1;
		}
		const token = command.slice(start, index);
		if (!/^[A-Za-z_][A-Za-z0-9_]*=/u.test(token)) break;
		tokens.push(token);
	}
	return tokens;
}

function unquoteShellAssignmentValue(value) {
	const trimmed = value.trim();
	if (
		(trimmed.startsWith("'") && trimmed.endsWith("'")) ||
		(trimmed.startsWith("\"") && trimmed.endsWith("\""))
	) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

function validationCommandLineMatch(line) {
	return /^(?:verify|verification command|validation command)\s*:?\s*(.*)\s*$/iu.exec(normalizeTaskFieldLine(line));
}

function validationEnvironmentLineMatch(line) {
	return /^(?:validation environment|verification environment|verify environment)\s*:?\s*(.*)\s*$/iu.exec(
		normalizeTaskFieldLine(line),
	);
}

function normalizeTaskFieldLine(line) {
	return line.replace(/^\s*#+\s*/u, "").trim();
}

function stripMarkdownInlineCode(value) {
	const trimmed = value.trim();
	const singleLine = /^`([^`]+)`$/u.exec(trimmed);
	if (singleLine) return singleLine[1]?.trim() ?? "";
	const fenced = /^```[A-Za-z0-9_-]*\s*([\s\S]*?)\s*```$/u.exec(trimmed);
	if (fenced) return fenced[1]?.trim() ?? "";
	return trimmed;
}

function followingEnvironmentLines(lines, startIndex) {
	const entries = [];
	for (const line of lines.slice(startIndex)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("```")) continue;
		if (isTaskSectionHeading(trimmed)) break;
		entries.push(stripMarkdownInlineCode(trimmed.replace(/^[-*]\s+/u, "")));
	}
	return entries;
}

function firstFollowingCommandLine(lines, startIndex) {
	for (const line of lines.slice(startIndex)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("```")) continue;
		if (isTaskSectionHeading(trimmed)) return "";
		return stripMarkdownInlineCode(trimmed);
	}
	return "";
}

function isTaskSectionHeading(line) {
	return line.startsWith("#") || /^[A-Z][A-Za-z /-]{0,80}:\s*$/u.test(line);
}

function hasHeadingOrField(text, label) {
	const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const pattern = new RegExp(`(^|\\n)\\s*(?:#+\\s*)?${escaped}\\s*:`, "iu");
	const headingPattern = new RegExp(`(^|\\n)\\s*#+\\s*${escaped}\\s*$`, "iu");
	return pattern.test(text) || headingPattern.test(text);
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
	if (rename) return normalizeGitPath(rename[2]?.trim() ?? "");
	return normalizeGitPath(trimmed.slice(2).trim());
}

function normalizeGitPath(filePath) {
	if (filePath.startsWith('"') && filePath.endsWith('"')) return filePath.slice(1, -1);
	return filePath;
}

async function workflowEvidenceFiles() {
	const files = [];
	try {
		const glob = new Bun.Glob("workflow-output/**");
		for await (const file of glob.scan({ cwd: process.cwd(), onlyFiles: true })) {
			if (ignoredEvidenceArtifact(file)) continue;
			files.push(file);
		}
	} catch {
		return [];
	}
	return files.sort((left, right) => left.localeCompare(right, "en"));
}

async function prematureDecisionArtifactFiles() {
	const files = [];
	try {
		const glob = new Bun.Glob("workflow-output/**");
		for await (const file of glob.scan({ cwd: process.cwd(), onlyFiles: true })) {
			if (file.startsWith("workflow-output/tmp/")) continue;
			if (isPrematureDecisionArtifact(file)) files.push(file);
		}
	} catch {
		return [];
	}
	return files.sort((left, right) => left.localeCompare(right, "en"));
}

function isCoreLaneEvidenceFile(file) {
	return /(^|\/)core-lane[^/]*\.(?:json|md|txt)$/iu.test(file);
}

function isTestLaneEvidenceFile(file) {
	return /(^|\/)tests?-lane[^/]*\.(?:json|md|txt)$/iu.test(file);
}

function isDocsLaneEvidenceFile(file) {
	return /(^|\/)(docs?-lane|docs?-evidence|generated-help|generated-man)[^/]*\.(?:json|md|txt|log|[0-9]+)$/iu.test(file);
}

function isIntegrationReviewEvidenceFile(file) {
	return /(^|\/)integration-review-[^/]+\.(?:json|md|txt)$/iu.test(file);
}

function isRollbackEvidenceFile(file) {
	return /(^|\/)(?:final-rollback-coverage|rollback(?!-notes))[^/]*\.(?:json|md|txt)$/iu.test(file);
}

function isValidationEvidenceFile(file) {
	return /(^|\/)(validation|verify|test|tests|core-lane|tests?-lane|evidence-contract)[^/]*\.(?:json|md|txt|log)$/iu.test(file);
}

async function missingRollbackCoverage(files, rollbackFiles) {
	if (files.length === 0) return [];
	if (rollbackFiles.length === 0) return files;
	const rollbackText = (await Promise.all(rollbackFiles.map(readText))).join("\n");
	return files.filter(file => !rollbackText.includes(file));
}

async function readText(file) {
	try {
		return await Bun.file(file).text();
	} catch {
		return "";
	}
}

function isFinalDeclaredValidationArtifact(file, currentTupleId) {
	if (currentTupleId) return file === `workflow-output/validation-${currentTupleId}.json`;
	return /(^|\/)validation-[^/]+\.json$/iu.test(file);
}

function genericValidationAliasArtifacts(files) {
	return files.filter(file => /^workflow-output\/(?:validation|verify|test|tests)\.(?:json|md|txt|log)$/iu.test(file));
}

function laneHardStopResultFromState(state) {
	const laneHardStopGuard = stateValueAtPath(state, "/laneHardStopGuard");
	if (!laneHardStopGuard || typeof laneHardStopGuard !== "object") {
		return {
			active: [],
			ignored: [],
			nonterminal: [],
			reservedFinalArtifacts: [],
			quarantinedReservedFinalArtifacts: [],
		};
	}
	return {
		active: stringArrayField(laneHardStopGuard, "hard_stop_artifacts"),
		ignored: stringArrayField(laneHardStopGuard, "ignored_historical_hard_stop_artifacts"),
		nonterminal: stringArrayField(laneHardStopGuard, "ignored_nonterminal_hard_stop_artifacts"),
		reservedFinalArtifacts: stringArrayField(laneHardStopGuard, "reserved_final_artifacts"),
		quarantinedReservedFinalArtifacts: artifactMoveArrayField(
			laneHardStopGuard,
			"quarantined_reserved_final_artifacts",
		),
	};
}

function stateValueAtPath(state, pointer) {
	if (!state || typeof state !== "object") return null;
	const segments = pointer
		.split("/")
		.slice(1)
		.map(segment => segment.replace(/~1/gu, "/").replace(/~0/gu, "~"));
	let current = state;
	for (const segment of segments) {
		if (!current || typeof current !== "object" || !(segment in current)) return null;
		current = current[segment];
	}
	return current;
}

function expectedReferencedArtifactsFromState(state, tupleId) {
	const artifacts = new Set();
	for (const source of [
		{ pointer: "/planHandoff", plannedOnly: true },
		{ pointer: "/reviewHandoff", plannedOnly: false },
	]) {
		const pointer = source.pointer;
		for (const artifact of referencedWorkflowArtifacts(stateValueAtPath(state, pointer))) {
			if (ignoredEvidenceArtifact(artifact)) continue;
			if (isOptionalLaneArchiveArtifact(artifact)) continue;
			if (source.plannedOnly && isOptionalPlannedArtifact(artifact)) continue;
			if (tupleId && !artifact.includes(tupleId)) continue;
			artifacts.add(artifact);
		}
	}
	return [...artifacts].sort((left, right) => left.localeCompare(right, "en"));
}

function isOptionalPlannedArtifact(file) {
	return /(^|\/)reviewer-notes-[^/]*\.(?:json|md|txt)$/iu.test(file);
}

function isOptionalLaneArchiveArtifact(file) {
	return /(^|\/)lane-archive-(?:implementCore|implementTests|implementDocs|core|tests?|docs?)-[^/]*\.(?:json|md|txt)$/iu.test(
		file,
	);
}

function referencedWorkflowArtifacts(value) {
	if (typeof value === "string") return referencedWorkflowArtifactsFromText(value);
	if (Array.isArray(value)) return value.flatMap(referencedWorkflowArtifacts);
	if (!value || typeof value !== "object") return [];
	return Object.values(value).flatMap(referencedWorkflowArtifacts);
}

function referencedWorkflowArtifactsFromText(text) {
	const matches = text.match(/workflow-output\/[^\s"'`]+/gu) ?? [];
	return matches.map(normalizeReferencedWorkflowArtifact).filter(Boolean);
}

function normalizeReferencedWorkflowArtifact(value) {
	const normalized = value.replace(/[\\),.;:\]}]+$/gu, "");
	if (normalized.includes("...[truncated")) return "";
	if (normalized.includes("{") || normalized.includes("}")) return "";
	if (normalized.includes("<") || normalized.includes(">")) return "";
	if (/[*?[\]]/u.test(normalized)) return "";
	if (!normalized.startsWith("workflow-output/")) return "";
	return normalized;
}

async function missingExpectedArtifacts(artifacts) {
	const missing = [];
	for (const artifact of artifacts) {
		if (!(await referencedArtifactExists(artifact))) missing.push(artifact);
	}
	return missing;
}

async function referencedArtifactExists(artifact) {
	for (const candidate of referencedArtifactCandidates(artifact)) {
		if (await Bun.file(candidate).exists()) return true;
	}
	return false;
}

function referencedArtifactCandidates(artifact) {
	const candidates = [artifact];
	for (const alias of materializedArtifactAliases(artifact)) {
		if (!candidates.includes(alias)) candidates.push(alias);
	}
	const alternative = /^(workflow-output\/.+)\.([A-Za-z0-9]+)\/([A-Za-z0-9]+)$/u.exec(artifact);
	if (!alternative) return candidates;
	const base = alternative[1] ?? "";
	const firstExtension = alternative[2] ?? "";
	const secondExtension = alternative[3] ?? "";
	if (!workflowArtifactExtension(firstExtension) || !workflowArtifactExtension(secondExtension)) return candidates;
	for (const candidate of [`${base}.${firstExtension}`, `${base}.${secondExtension}`]) {
		if (!candidates.includes(candidate)) candidates.push(candidate);
	}
	return candidates;
}

function materializedArtifactAliases(artifact) {
	const aliases = [];
	const match = /^workflow-output\/(integration-review|review-handoff)-(.+)$/u.exec(artifact);
	if (match) {
		const kind = match[1];
		const suffix = match[2];
		aliases.push(`workflow-output/${kind}-materialized-${suffix}`);
	}
	const laneMatch = /^workflow-output\/(?:lane-)?(implementCore|implementTests|implementDocs)-(.+\.json)$/u.exec(artifact);
	if (laneMatch) {
		const lane = laneMatch[1];
		const suffix = laneMatch[2];
		const canonicalPrefix =
			lane === "implementCore" ? "core-lane" : lane === "implementTests" ? "tests-lane" : "docs-lane";
		aliases.push(`workflow-output/${canonicalPrefix}-${suffix}`);
	}
	const hardStopMatch = /^workflow-output\/lane-archive-laneHardStopGuard-(.+)\.(?:json|md|txt)$/u.exec(artifact);
	if (hardStopMatch) {
		aliases.push(`workflow-output/lane-hard-stop-guard-${hardStopMatch[1]}.json`);
	}
	return aliases;
}

function workflowArtifactExtension(value) {
	return /^(?:json|jsonl|md|txt|log|out|stderr|stdout|exitcode)$/iu.test(value);
}

function stringArrayField(value, key) {
	if (!value || typeof value !== "object") return [];
	const field = value[key];
	if (!Array.isArray(field)) return [];
	return field.filter(item => typeof item === "string").sort((left, right) => left.localeCompare(right, "en"));
}

function artifactMoveArrayField(value, key) {
	if (!value || typeof value !== "object") return [];
	const field = value[key];
	if (!Array.isArray(field)) return [];
	return field
		.filter(item => item && typeof item === "object")
		.map(item => ({
			original: typeof item.original === "string" ? item.original : "",
			quarantine: typeof item.quarantine === "string" ? item.quarantine : "",
		}))
		.filter(item => item.original && item.quarantine)
		.sort((left, right) => left.original.localeCompare(right.original, "en"));
}

function isPrematureDecisionArtifact(file) {
	if (/(^|\/)final-rollback-coverage[^/]*\.(?:json|md|txt)$/iu.test(file)) return false;
	return /(^|\/)(?:(?:strong-review|promotion-decision)[^/]*|[^/]*final-[^/]*)\.(?:json|md|txt)$/iu.test(file);
}

async function validationEvidenceMatches(files, command, environment) {
	const passedFiles = [];
	const failedFiles = [];
	const trustedFinalFiles = [];
	const trustedFailedFinalFiles = [];
	const reasons = [];
	for (const file of files.filter(isValidationEvidenceFile)) {
		const match = await fileValidationStatus(file, command, environment);
		if (match.status === "passed") {
			passedFiles.push(file);
			if (match.trustedFinal) trustedFinalFiles.push(file);
		} else if (match.status === "failed") {
			failedFiles.push(file);
			if (match.trustedFinal) trustedFailedFinalFiles.push(file);
		} else if (match.reason) {
			reasons.push(`${file}: ${match.reason}`);
		}
	}
	return { passedFiles, failedFiles, trustedFinalFiles, trustedFailedFinalFiles, reasons };
}

async function staleValidationHashArtifactsFromEvidence(files) {
	const stale = [];
	for (const file of files.filter(filePath => filePath.endsWith(".json"))) {
		const data = await readJson(file);
		if (!data) continue;
		for (const entry of await recordedValidationHashes(data)) {
			const actual = await sha256File(entry.path);
			if (!actual || actual !== entry.sha256) stale.push(`${file} -> ${entry.path}`);
		}
	}
	return stale.sort((left, right) => left.localeCompare(right, "en"));
}

async function mechanicalSurfaceInventoryArtifactsFromEvidence(files) {
	const artifacts = [];
	for (const file of files.filter(isReviewableLaneEvidenceFile)) {
		const text = await readText(file);
		if (mechanicalSurfaceInventoryClaim(text)) artifacts.push(file);
	}
	return artifacts.sort((left, right) => left.localeCompare(right, "en"));
}

async function validationAttemptLogFindingsFromEvidence(files) {
	const findings = [];
	for (const file of files) {
		const text = await readText(file);
		const data = file.endsWith(".json") ? await readJson(file) : null;
		const rerun = validationRerunSignal(text, data);
		const attempts = expectedValidationAttempts(text, data, rerun);
		if (!rerun && attempts.length <= 1) continue;
		const refs = validationAttemptRefs(text);
		const missing = missingValidationAttemptLogs(attempts, refs, tupleIdFromEvidence(file, data));
		if (missing.length === 0) continue;
		findings.push({
			file,
			reason: "validation rerun evidence is missing immutable attempt stdout/stderr/exitcode logs",
			missing_files: missing,
		});
	}
	return findings.sort((left, right) => left.file.localeCompare(right.file, "en"));
}

function validationRerunSignal(text, data) {
	if (validationAttemptsArray(data).length > 1) return true;
	const lower = text.toLowerCase();
	const explicitNoRerun = /\bno\s+(?:declared\s+)?validation\s+re[- ]?runs?\b/u.test(lower) || /\bvalidation\s+was\s+not\s+re[- ]?run\b/u.test(lower);
	const strongSignal =
		/\b(?:re[- ]?ran|re[- ]?run|reran|rerun|reruns|rerunning)\s+(?:the\s+)?(?:full\s+)?(?:declared\s+)?validation\b/u.test(lower) ||
		/\b(?:second|third|fourth|fifth)\s+(?:full\s+)?(?:declared\s+)?validation\s+(?:run|wrapper|attempt|pass)\b/u.test(lower) ||
		/\b(?:prior|previous|earlier|first)\s+(?:full\s+)?(?:declared\s+)?validation\s+(?:failed|failure|exit(?:ed)?\s+non[- ]?zero|exit(?:ed)?\s+1)\b/u.test(lower) ||
		/\battempt\s*[2-9]\b/u.test(lower);
	return strongSignal && !explicitNoRerun;
}

function expectedValidationAttempts(text, data, rerun) {
	const attempts = new Set();
	const explicitAttempts = validationAttemptsArray(data);
	const hasExplicitAttempts = explicitAttempts.length > 0;
	for (let index = 0; index < explicitAttempts.length; index += 1) {
		const attempt = Number(explicitAttempts[index]?.attempt ?? index + 1);
		if (Number.isInteger(attempt) && attempt > 0) attempts.add(attempt);
	}
	if (rerun && !hasExplicitAttempts) {
		for (const match of text.matchAll(/\battempt\s*[:#-]?\s*([1-9]\d*)\b/giu)) {
			attempts.add(Number(match[1]));
		}
	}
	for (const match of text.matchAll(/\bvalidation-attempt-([1-9]\d*)-(?:stdout|stderr|exitcode)-/giu)) {
		attempts.add(Number(match[1]));
	}
	if (!hasExplicitAttempts) {
		for (const match of text.matchAll(/\bvalidation[_ -]?attempts?\s*[:=]\s*([2-9]\d*)\b/giu)) {
			const count = Number(match[1]);
			for (let attempt = 1; attempt <= count; attempt += 1) attempts.add(attempt);
		}
	}
	const maxAttempt = Math.max(0, ...attempts);
	if (maxAttempt > 1) {
		return Array.from({ length: maxAttempt }, (_value, index) => index + 1);
	}
	if (rerun) return [1, 2];
	return maxAttempt === 1 ? [1] : [];
}

function validationAttemptsArray(data) {
	if (!data || typeof data !== "object" || Array.isArray(data)) return [];
	if (Array.isArray(data.validation_attempts)) return data.validation_attempts;
	if (Array.isArray(data.attempts)) return data.attempts;
	if (data.validation && typeof data.validation === "object" && Array.isArray(data.validation.attempts)) {
		return data.validation.attempts;
	}
	if (data.declared_validation && typeof data.declared_validation === "object" && Array.isArray(data.declared_validation.attempts)) {
		return data.declared_validation.attempts;
	}
	return [];
}

function validationAttemptRefs(text) {
	const refs = new Map();
	for (const match of text.matchAll(/\bvalidation-attempt-([1-9]\d*)-(stdout|stderr|exitcode)-[^"'\s,)}\]]+/giu)) {
		const attempt = Number(match[1]);
		const kind = match[2].toLowerCase();
		const key = `${attempt}:${kind}`;
		if (!refs.has(key)) refs.set(key, []);
		refs.get(key).push(match[0]);
	}
	return refs;
}

function tupleIdFromEvidence(file, data) {
	if (data && typeof data === "object" && !Array.isArray(data) && typeof data.tuple_id === "string") return data.tuple_id;
	const match = file.match(/(?:^|\/)tests?-lane-(.+?)\.(?:json|md|txt)$/iu);
	return match?.[1] || "<tuple-id>";
}

function missingValidationAttemptLogs(attempts, refs, tupleId) {
	const missing = [];
	for (const attempt of attempts) {
		for (const kind of ["stdout", "stderr", "exitcode"]) {
			if (refs.has(`${attempt}:${kind}`)) continue;
			missing.push(`workflow-output/validation-attempt-${attempt}-${kind}-${tupleId}.txt`);
		}
	}
	return missing;
}

async function readJson(file) {
	try {
		return JSON.parse(await Bun.file(file).text());
	} catch {
		return null;
	}
}

async function recordedValidationHashes(data) {
	const hashes = new Map();
	addHashMap(hashes, data?.artifact_hashes);
	addHashMap(hashes, data?.artifact_hashes_sha256);
	addHashMap(hashes, data?.file_hashes);
	addHashMap(hashes, data?.file_hashes_sha256);
	addHashMap(hashes, data?.checksums);
	addHashMap(hashes, data?.validation?.evidence_hashes);
	addHashMap(hashes, data?.declared_validation?.evidence_hashes);
	addHashMap(hashes, data?.validation?.reusedArtifactHashes);
	addHashMap(hashes, data?.declared_validation?.reusedArtifactHashes);
	await addCoverageProfileHashes(hashes, data?.coverage_profiles);
	await addCoverageProfileHashes(hashes, data?.validation?.coverage_profiles);
	await addCoverageProfileHashes(hashes, data?.declared_validation?.coverage_profiles);
	await addCoverageProfileHashes(hashes, data?.validation?.reusedCoverageProfiles);
	await addCoverageProfileHashes(hashes, data?.declared_validation?.reusedCoverageProfiles);
	return Array.from(hashes.entries()).map(([artifactPath, sha256]) => ({ path: artifactPath, sha256 }));
}

function addHashMap(hashes, value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	for (const [artifactPath, hash] of Object.entries(value)) {
		if (typeof hash === "string" && isSafeWorkflowOutputPath(artifactPath)) hashes.set(artifactPath, hash);
	}
}

async function addCoverageProfileHashes(hashes, value) {
	for (const profile of coverageProfilesFromValue(value)) {
		const hash = profile.sha256 || (await sha256File(profile.path));
		if (hash && isSafeWorkflowOutputPath(profile.path)) hashes.set(profile.path, hash);
	}
}

function coverageProfilesFromValue(value) {
	if (!value || typeof value !== "object") return [];
	if (Array.isArray(value)) {
		return value
			.map(profile => ({
				path: typeof profile?.path === "string" ? profile.path : "",
				sha256: typeof profile?.sha256 === "string" ? profile.sha256 : "",
			}))
			.filter(profile => profile.path && isSafeWorkflowOutputPath(profile.path));
	}
	return Object.entries(value)
		.map(([artifactPath, profile]) => ({
			path: typeof profile?.path === "string" ? profile.path : artifactPath,
			sha256: typeof profile?.sha256 === "string" ? profile.sha256 : "",
		}))
		.filter(profile => profile.path && isSafeWorkflowOutputPath(profile.path));
}

async function sha256File(file) {
	try {
		const bytes = new Uint8Array(await Bun.file(file).arrayBuffer());
		return new Bun.SHA256().update(bytes).digest("hex");
	} catch {
		return "";
	}
}

function isSafeWorkflowOutputPath(file) {
	return typeof file === "string" && file.startsWith("workflow-output/") && !file.includes("..");
}

function isReviewableLaneEvidenceFile(file) {
	return (
		isCoreLaneEvidenceFile(file) ||
		isDocsLaneEvidenceFile(file) ||
		isIntegrationReviewEvidenceFile(file) ||
		/(^|\/)(core-evidence|lane-archive-core|lane-archive-docs|reviewer-notes)[^/]*\.(?:json|md|txt)$/iu.test(file)
	);
}

function mechanicalSurfaceInventoryClaim(text) {
	if (!text) return false;
	const hasStrongMechanicalSignal =
		/\bcandidate test functions discovered\b/iu.test(text) ||
		/\bwrapper package (?:argument|expansion)/iu.test(text) ||
		/\bgate role:\s*stable_matrix_candidate\b/iu.test(text) ||
		/"(?:candidate_test_count|selected_concrete_surface_count|archived_concrete_entry_points)"\s*:/iu.test(text);
	const hasWeakMechanicalSignal = /\bparsed\s+(?:go\s+)?(?:test|benchmark|fuzz|entry point|wrapper|file)/iu.test(text);
	if (!hasStrongMechanicalSignal && !hasWeakMechanicalSignal) return false;
	const claimsSemanticCompletion =
		/\bconcrete surfaces selected\b/iu.test(text) ||
		/\barchived concrete\b/iu.test(text) ||
		/\bmeets[_ -]?\d*[_ -]?surface[_ -]?requirement\b/iu.test(text) ||
		/"meets_[^"]*_requirement"\s*:\s*true/iu.test(text) ||
		/\bverifies (?:unit )?behavior for\b/iu.test(text);
	const explicitlyIndexOnly = /\bindex[-_ ]only\b/iu.test(text) || /\bnavigation aids?\b/iu.test(text);
	const explicitlyNegated =
		/\bnot\s+(?:based\s+on\s+)?parsed\s+(?:go\s+)?(?:test|benchmark|fuzz|entry point|wrapper|file)/iu.test(text) ||
		/\bmechanical[_ -]inventory[_ -]used[_ -]as[_ -]completion[_ -]evidence["']?\s*:\s*false/iu.test(text);
	if (hasStrongMechanicalSignal) return claimsSemanticCompletion || !explicitlyIndexOnly;
	return claimsSemanticCompletion && !explicitlyNegated && !explicitlyIndexOnly;
}

async function fileValidationStatus(file, command, environment) {
	try {
		const text = await Bun.file(file).text();
		try {
			const result = jsonValidationStatus(JSON.parse(text), command, environment);
			if (result.status !== "unmatched") return result;
			return { status: "unmatched", reason: result.reason || "no matching validation object" };
		} catch {
			if (!text.includes(command)) {
				return { status: "unmatched", reason: "validation text does not include the declared command" };
			}
			if (/\b(fail(?:ed|ure|s)?|errors?|non[- ]?zero)\b/iu.test(text)) return { status: "failed" };
			if (/\b(pass(?:ed|es)?|succeeded|success|ready)\b/iu.test(text)) return { status: "passed" };
			return { status: "unmatched", reason: "validation text did not clearly pass" };
		}
	} catch {
		return { status: "unmatched", reason: "could not read validation evidence" };
	}
}

function jsonValidationStatus(value, command, environment) {
	const candidates = validationObjects(value);
	if (candidates.length === 0) return { status: "unmatched", reason: "no validation objects found" };
	const commandCandidates = candidates.filter(candidate => candidate.command === command);
	if (commandCandidates.length === 0) {
		return { status: "unmatched", reason: "no validation object used the declared command exactly" };
	}
	const environmentCandidates = commandCandidates.filter(candidate => environmentMatches(candidate.environment, environment));
	if (environmentCandidates.length === 0) {
		return { status: "unmatched", reason: "undeclared validation environment or missing declared environment" };
	}
	const failed = environmentCandidates.some(candidate => valueContainsFailedValidation(candidate));
	if (failed) return { status: "failed", trustedFinal: isTrustedRunDeclaredValidationArtifact(value) };
	const passed = environmentCandidates.some(candidate => valueContainsPassedValidation(candidate));
	if (passed) return { status: "passed", trustedFinal: isTrustedRunDeclaredValidationArtifact(value) };
	return { status: "unmatched", reason: "declared validation object did not pass" };
}

function isTrustedRunDeclaredValidationArtifact(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	return value.producer_node === "runDeclaredValidation" && value.producer_kind === "workflow-script";
}

function validationObjects(value) {
	const objects = [];
	collectValidationObjects(value, objects);
	return objects;
}

function collectValidationObjects(value, objects) {
	if (!value || typeof value !== "object") return;
	if (Array.isArray(value)) {
		for (const entry of value) collectValidationObjects(entry, objects);
		return;
	}
	if (typeof value.command === "string" || typeof value.validationCommand === "string") {
		objects.push({
			command: value.command ?? value.validationCommand,
			environment: value.environment,
			result: value.result,
			status: value.status,
			claimed: value.claimed,
			exitCode: value.exitCode ?? value.exit_code,
		});
	}
	for (const nested of Object.values(value)) collectValidationObjects(nested, objects);
}

function environmentMatches(actual, declared) {
	const actualEntries = environmentEntries(actual);
	const declaredEntries = environmentEntries(declared);
	if (actualEntries.length === 0) return declaredEntries.length === 0;
	if (actualEntries.length !== declaredEntries.length) return false;
	const declaredMap = new Map(declaredEntries);
	return actualEntries.every(([key, value]) => declaredMap.get(key) === value);
}

function environmentEntries(value) {
	if (!value || typeof value !== "object") return [];
	return Object.entries(value)
		.filter(([, entryValue]) => typeof entryValue === "string")
		.sort(([left], [right]) => left.localeCompare(right, "en"));
}

function valueContainsPassedValidation(value) {
	if (value === true) return true;
	if (typeof value === "string") return /^(pass(?:ed|es)?|succeeded|success|ready|complete)$/iu.test(value.trim());
	if (!value || typeof value !== "object") return false;
	if (Array.isArray(value)) return value.some(valueContainsPassedValidation);
	return Object.entries(value).some(([key, nested]) => {
		if (/^(result|status|verdict|claimed)$/iu.test(key) && valueContainsPassedValidation(nested)) return true;
		return valueContainsPassedValidation(nested);
	});
}

function valueContainsFailedValidation(value) {
	if (value === false) return true;
	if (typeof value === "number") return value !== 0;
	if (typeof value === "string") {
		return /^(fail(?:ed|ure|ures|s)?|errored?|error|non[- ]?zero|reject(?:ed)?|repair|blocked|incomplete)$/iu.test(
			value.trim(),
		);
	}
	if (!value || typeof value !== "object") return false;
	if (Array.isArray(value)) return value.some(valueContainsFailedValidation);
	return Object.entries(value).some(([key, nested]) => {
		if (/^(result|status|verdict|claimed|exitCode|exit_code)$/iu.test(key) && valueContainsFailedValidation(nested)) {
			return true;
		}
		return valueContainsFailedValidation(nested);
	});
}

function ignoredEvidencePath(file) {
	return (
		file === "evidence-ledger.jsonl" ||
		file === "manifest-entry.json" ||
		file === "monitor-assignment.json" ||
		file === "task.md" ||
		file === "progress.md" ||
		file.includes("workflow-output/") ||
		ignoredProjectArtifactPath(file)
	);
}

function ignoredEvidenceArtifact(file) {
	return (
		file === "workflow-output/integration-review.json" ||
		/(^|\/)evidence-contract-guard[^/]*\.json$/iu.test(file) ||
		/(^|\/)strong-review[^/]*\.(?:json|txt|md)$/iu.test(file) ||
		/(^|\/)rollback-notes[^/]*\.(?:json|txt|md)$/iu.test(file) ||
		file.startsWith("workflow-output/tmp/") ||
		ignoredProjectArtifactPath(file)
	);
}

function ignoredProjectArtifactPath(file) {
	const ignoredSegments = new Set([".venv", "node_modules", ".pytest_cache", ".mypy_cache", ".ruff_cache", "__pycache__"]);
	return file
		.replace(/\\/gu, "/")
		.split("/")
		.some(segment => ignoredSegments.has(segment));
}
