const taskText = await readRequiredTaskText();
const tupleId = await tupleIdFromRunArtifacts();
const validationCommand = validationCommandFromTask(taskText);
const validationEnvironment = validationEnvironmentFromTask(taskText);
const manualEvidenceAllowed = hasHeadingOrField(taskText, "manual evidence allowed");

if (!validationCommand) {
	if (manualEvidenceAllowed) {
		const artifact = await writeValidationArtifact({
			tupleId,
			validationCommand: "",
			validationEnvironment,
			result: "manual",
			exitCode: 0,
			stdout: "Manual Evidence Allowed was declared; no validation command was run.\n",
			stderr: "",
		});
		return {
			summary: "manual evidence allowed; declared validation command not required",
			verdict: "PASS",
			data: artifact,
			statePatch: [{ op: "set", path: "/declaredValidation", value: artifact }],
		};
	}
	throw new Error("parallel-implementation-review task.md must declare a Validation Command");
}

assertSafeValidationCommand(validationCommand);
const reusableValidation = await reusableExactTestLaneValidation({
	tupleId,
	validationCommand,
	validationEnvironment,
});
if (reusableValidation) {
	const artifact = await writeReusedValidationArtifact({
		tupleId,
		validationCommand,
		validationEnvironment,
		reusableValidation,
	});
	return {
		summary: `declared validation reused exact ${reusableValidation.result} test-lane evidence: ${reusableValidation.artifact}`,
		verdict: reusableValidation.result === "passed" ? "PASS" : "FAIL",
		data: artifact,
		statePatch: [{ op: "set", path: "/declaredValidation", value: artifact }],
	};
}
throw new Error(
	"parallel-implementation-review requires reusable test-lane declared validation evidence; final validation nodes must not rerun long commands directly",
);

async function writeValidationArtifact({
	tupleId,
	validationCommand,
	validationEnvironment,
	runtimeEnvironment,
	result,
	exitCode,
	stdout,
	stderr,
}) {
	const suffix = tupleId ? `-${tupleId}` : "";
	const stdoutArtifact = `workflow-output/validation${suffix}.stdout`;
	const stderrArtifact = `workflow-output/validation${suffix}.stderr`;
	const artifactPath = `workflow-output/validation${suffix}.json`;
	await Bun.write(stdoutArtifact, stdout);
	await Bun.write(stderrArtifact, stderr);
	const artifact = {
		tuple_id: tupleId,
		artifact: artifactPath,
		producer_node: "runDeclaredValidation",
		producer_kind: "workflow-script",
		validation: {
			command: validationCommand,
			environment: validationEnvironment,
			runtime_environment: runtimeEnvironment,
			result,
			status: result,
			exitCode,
			stdoutArtifact,
			stderrArtifact,
		},
		checked_at_ms: Date.now(),
	};
	await Bun.write(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
	return artifact;
}

async function writeReusedValidationArtifact({ tupleId, validationCommand, validationEnvironment, reusableValidation }) {
	const suffix = tupleId ? `-${tupleId}` : "";
	const artifactPath = `workflow-output/validation${suffix}.json`;
	const artifact = {
		tuple_id: tupleId,
		artifact: artifactPath,
		producer_node: "runDeclaredValidation",
		producer_kind: "workflow-script",
		validation: {
			command: validationCommand,
			environment: validationEnvironment,
			runtime_environment: reusableValidation.runtimeEnvironment,
			result: reusableValidation.result,
			status: reusableValidation.result,
			exitCode: reusableValidation.exitCode,
			stdoutArtifact: reusableValidation.stdoutArtifact,
			stderrArtifact: reusableValidation.stderrArtifact,
			exitCodeArtifact: reusableValidation.exitCodeArtifact,
			reusedFromTestLane: reusableValidation.artifact,
			reusedArtifactHashes: reusableValidation.recordedHashes,
			reusedCoverageProfiles: reusableValidation.coverageProfiles,
		},
		checked_at_ms: Date.now(),
	};
	await Bun.write(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
	return artifact;
}

async function reusableExactTestLaneValidation({ tupleId, validationCommand, validationEnvironment }) {
	if ((await changedProjectFiles()).length > 0) return null;
	const candidates = await testLaneValidationArtifacts(tupleId);
	for (const artifact of candidates) {
		const data = await readJson(artifact);
		const validation = data?.validation;
		if (!data || data.producer_node !== "implementTests") continue;
		if (!validation || typeof validation !== "object") continue;
		if (validation.command !== validationCommand) continue;
		if (!environmentMatches(validation.environment, validationEnvironment)) continue;
		const outcome = validationOutcome(validation);
		if (!outcome) continue;
		const recordedHashes = await recordedValidationHashes(data);
		if (Object.keys(recordedHashes).length === 0) continue;
		if (!(await recordedHashesStillMatch(recordedHashes))) continue;
		return {
			artifact,
			result: outcome.result,
			exitCode: outcome.exitCode,
			stdoutArtifact: stringField(validation, "stdout_path") || stringField(validation, "stdoutArtifact"),
			stderrArtifact: stringField(validation, "stderr_path") || stringField(validation, "stderrArtifact"),
			exitCodeArtifact: stringField(validation, "exit_code_path") || stringField(validation, "exitCodeArtifact"),
			runtimeEnvironment: objectField(validation, "runtime_environment"),
			recordedHashes,
			coverageProfiles: await recordedCoverageProfiles(data),
		};
	}
	for (const artifact of candidates) {
		const data = await readJson(artifact);
		const fallback = await reusableTupleScopedValidationFiles({
			artifact,
			data,
			tupleId,
			validationCommand,
			validationEnvironment,
		});
		if (fallback) return fallback;
	}
	return null;
}

async function testLaneValidationArtifacts(tupleId) {
	const files = [];
	try {
		const glob = new Bun.Glob("workflow-output/tests-lane*.json");
		for await (const filePath of glob.scan({ cwd: process.cwd(), onlyFiles: true })) {
			if (tupleId && !filePath.includes(tupleId)) continue;
			files.push(filePath);
		}
	} catch {
		return [];
	}
	return files.sort((left, right) => left.localeCompare(right, "en"));
}

async function readJson(filePath) {
	try {
		return await Bun.file(filePath).json();
	} catch {
		return null;
	}
}

function validationOutcome(validation) {
	const result = String(validation.result ?? validation.status ?? "").toLowerCase();
	const exitCode = validation.exit_code ?? validation.exitCode;
	if ((result === "pass" || result === "passed") && exitCode === 0) {
		return { result: "passed", exitCode: 0 };
	}
	if ((result === "fail" || result === "failed") && typeof exitCode === "number" && exitCode !== 0) {
		return { result: "failed", exitCode };
	}
	return null;
}

async function reusableTupleScopedValidationFiles({
	artifact,
	data,
	tupleId,
	validationCommand,
	validationEnvironment,
}) {
	if (!tupleId || !data || data.producer_node !== "implementTests") return null;
	const validation = declaredValidationObject(data);
	if (!validation || typeof validation !== "object") return null;
	const stdoutArtifact =
		stringField(validation, "stdout_path") ||
		stringField(validation, "stdoutArtifact") ||
		`workflow-output/validation-${tupleId}.stdout`;
	const stderrArtifact =
		stringField(validation, "stderr_path") ||
		stringField(validation, "stderrArtifact") ||
		`workflow-output/validation-${tupleId}.stderr`;
	const exitCodeArtifact =
		stringField(validation, "exit_code_path") ||
		stringField(validation, "exitcode_path") ||
		stringField(validation, "exitCodeArtifact") ||
		`workflow-output/validation-${tupleId}.exitcode`;
	const artifacts = [stdoutArtifact, stderrArtifact, exitCodeArtifact];
	if (!artifacts.every(filePath => isSafeTupleWorkflowOutputPath(filePath, tupleId))) return null;
	if (!(await Promise.all(artifacts.map(fileExists))).every(Boolean)) return null;
	const exitCode = await readExitCodeArtifact(exitCodeArtifact);
	if (exitCode === null) return null;
	const result = exitCode === 0 ? "passed" : "failed";
	const recordedHashes = {
		...(await recordedValidationHashes(data)),
		...(await hashExistingArtifacts(artifacts)),
	};
	const coverageProfiles = await recordedCoverageProfiles(data);
	for (const profile of await discoverCoverageProfiles(tupleId)) {
		if (!coverageProfiles.some(existing => existing.path === profile.path && existing.sha256 === profile.sha256)) {
			coverageProfiles.push(profile);
		}
		recordedHashes[profile.path] = profile.sha256;
	}
	if (Object.keys(recordedHashes).length === 0) return null;
	if (!(await recordedHashesStillMatch(recordedHashes))) return null;
	return {
		artifact,
		result,
		exitCode,
		stdoutArtifact,
		stderrArtifact,
		exitCodeArtifact,
		runtimeEnvironment: objectField(validation, "runtime_environment"),
		recordedHashes,
		coverageProfiles,
		validationCommand,
		validationEnvironment,
	};
}

function declaredValidationObject(data) {
	return objectField(data, "declared_validation") || objectField(data, "validation");
}

async function recordedValidationHashes(data) {
	const hashes = {};
	addHashMap(hashes, data?.artifact_hashes);
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
	return hashes;
}

async function recordedCoverageProfiles(data) {
	const profiles = [];
	const seen = new Set();
	await collectCoverageProfiles(profiles, seen, data?.coverage_profiles);
	await collectCoverageProfiles(profiles, seen, data?.validation?.coverage_profiles);
	await collectCoverageProfiles(profiles, seen, data?.declared_validation?.coverage_profiles);
	await collectCoverageProfiles(profiles, seen, data?.validation?.reusedCoverageProfiles);
	await collectCoverageProfiles(profiles, seen, data?.declared_validation?.reusedCoverageProfiles);
	return profiles;
}

function environmentMatches(actual, expected) {
	const actualObject = actual && typeof actual === "object" && !Array.isArray(actual) ? actual : {};
	const expectedObject = expected && typeof expected === "object" && !Array.isArray(expected) ? expected : {};
	const actualEntries = Object.entries(actualObject).sort(([left], [right]) => left.localeCompare(right, "en"));
	const expectedEntries = Object.entries(expectedObject).sort(([left], [right]) => left.localeCompare(right, "en"));
	return JSON.stringify(actualEntries) === JSON.stringify(expectedEntries);
}

function addHashMap(hashes, value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	for (const [filePath, hash] of Object.entries(value)) {
		if (typeof hash === "string" && isSafeWorkflowOutputPath(filePath)) hashes[filePath] = hash;
	}
}

async function addCoverageProfileHashes(hashes, value) {
	for (const profile of coverageProfilesFromValue(value)) {
		const hash = profile.sha256 || (await sha256File(profile.path));
		if (hash) hashes[profile.path] = hash;
	}
}

async function collectCoverageProfiles(profiles, seen, value) {
	for (const profile of coverageProfilesFromValue(value)) {
		const hash = profile.sha256 || (await sha256File(profile.path));
		if (!hash) continue;
		const key = `${profile.path}\0${hash}`;
		if (seen.has(key)) continue;
		seen.add(key);
		profiles.push({ path: profile.path, sha256: hash });
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
		.map(([filePath, profile]) => ({
			path: typeof profile?.path === "string" ? profile.path : filePath,
			sha256: typeof profile?.sha256 === "string" ? profile.sha256 : "",
		}))
		.filter(profile => profile.path && isSafeWorkflowOutputPath(profile.path));
}

async function recordedHashesStillMatch(hashes) {
	for (const [filePath, hash] of Object.entries(hashes)) {
		if ((await sha256File(filePath)) !== hash) return false;
	}
	return true;
}

async function fileExists(filePath) {
	try {
		return await Bun.file(filePath).exists();
	} catch {
		return false;
	}
}

async function readExitCodeArtifact(filePath) {
	try {
		const text = await Bun.file(filePath).text();
		if (!/^-?\d+\s*$/u.test(text)) return null;
		return Number(text.trim());
	} catch {
		return null;
	}
}

async function hashExistingArtifacts(filePaths) {
	const hashes = {};
	for (const filePath of filePaths) {
		const hash = await sha256File(filePath);
		if (hash) hashes[filePath] = hash;
	}
	return hashes;
}

async function discoverCoverageProfiles(tupleId) {
	const profiles = [];
	try {
		const glob = new Bun.Glob(`workflow-output/*${tupleId}*.out`);
		for await (const filePath of glob.scan({ cwd: process.cwd(), onlyFiles: true })) {
			if (!isSafeTupleWorkflowOutputPath(filePath, tupleId)) continue;
			const hash = await sha256File(filePath);
			if (hash) profiles.push({ path: filePath, sha256: hash });
		}
	} catch {
		return [];
	}
	return profiles.sort((left, right) => left.path.localeCompare(right.path, "en"));
}

async function sha256File(filePath) {
	try {
		const bytes = new Uint8Array(await Bun.file(filePath).arrayBuffer());
		return new Bun.SHA256().update(bytes).digest("hex");
	} catch {
		return "";
	}
}

function isSafeWorkflowOutputPath(filePath) {
	return typeof filePath === "string" && filePath.startsWith("workflow-output/") && !filePath.includes("..");
}

function isSafeTupleWorkflowOutputPath(filePath, tupleId) {
	return isSafeWorkflowOutputPath(filePath) && filePath.includes(tupleId);
}

function objectField(value, key) {
	if (!value || typeof value !== "object") return {};
	const field = value[key];
	return field && typeof field === "object" && !Array.isArray(field) ? field : {};
}

async function changedProjectFiles() {
	const child = Bun.spawn(["git", "status", "--short", "--untracked-files=all"], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
	if (exitCode !== 0) return [];
	return stdout
		.split(/\r?\n/u)
		.map(line => line.trimEnd())
		.filter(Boolean)
		.map(statusLinePath)
		.filter(filePath => filePath && !isWorkflowControlPath(filePath))
		.sort((left, right) => left.localeCompare(right, "en"));
}

function statusLinePath(line) {
	const raw = line.slice(3).trim();
	if (raw.includes(" -> ")) return raw.split(" -> ").pop()?.trim() ?? raw;
	return raw;
}

function isWorkflowControlPath(filePath) {
	return (
		filePath === "task.md" ||
		filePath === "progress.md" ||
		filePath === "manifest-entry.json" ||
		filePath === "monitor-assignment.json" ||
		filePath === "evidence-ledger.jsonl" ||
		filePath.startsWith("workflow-output/") ||
		filePath.startsWith("transcripts/")
	);
}

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
	const taskTuple = /(?:tuple|monitor)[^A-Za-z0-9]+([A-Z][0-9]{2}-T[0-9]{2}(?:-[A-Za-z0-9]+)?)/u.exec(taskText);
	if (taskTuple?.[1]) return taskTuple[1];
	return "";
}

async function tupleIdFromJsonFile(filePath) {
	try {
		const data = await Bun.file(filePath).json();
		const candidate = stringField(data, "tupleId") || stringField(data, "tuple_id");
		return candidate.trim();
	} catch {
		return "";
	}
}

function stringField(value, key) {
	if (!value || typeof value !== "object") return "";
	const field = value[key];
	return typeof field === "string" ? field : "";
}

function validationCommandFromTask(text) {
	const lines = text.split(/\r?\n/u);
	for (let index = 0; index < lines.length; index += 1) {
		const match = /^\s*(?:verify|verification command|validation command)\s*:\s*(.*)\s*$/iu.exec(lines[index] ?? "");
		if (!match) continue;
		const inlineCommand = match[1]?.trim();
		if (inlineCommand) return inlineCommand;
		const followingCommand = firstFollowingCommandLine(lines, index + 1);
		if (followingCommand) return followingCommand;
	}
	return "";
}

function validationEnvironmentFromTask(text) {
	const lines = text.split(/\r?\n/u);
	for (let index = 0; index < lines.length; index += 1) {
		const match = /^\s*(?:validation environment|verification environment|verify environment)\s*:\s*(.*)\s*$/iu.exec(lines[index] ?? "");
		if (!match) continue;
		const inlineValue = match[1]?.trim();
		const entries = inlineValue ? [inlineValue] : followingEnvironmentLines(lines, index + 1);
		return Object.fromEntries(
			entries
				.flatMap(entry => entry.split(/\s+/u))
				.map(entry => /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(entry))
				.filter(Boolean)
				.map(matchResult => [matchResult[1] ?? "", matchResult[2] ?? ""]),
		);
	}
	return {};
}

function followingEnvironmentLines(lines, startIndex) {
	const entries = [];
	for (const line of lines.slice(startIndex)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("```")) continue;
		if (isTaskSectionHeading(trimmed)) break;
		entries.push(trimmed.replace(/^[-*]\s+/u, ""));
	}
	return entries;
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

function hasHeadingOrField(text, label) {
	const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const pattern = new RegExp(`(^|\\n)\\s*(?:#+\\s*)?${escaped}\\s*:`, "iu");
	const headingPattern = new RegExp(`(^|\\n)\\s*#+\\s*${escaped}\\s*$`, "iu");
	return pattern.test(text) || headingPattern.test(text);
}

function assertSafeValidationCommand(command) {
	const normalized = command.toLowerCase();
	if (/\b(sleep|watch|tail\s+-f|yes)\b/u.test(normalized)) {
		throw new Error("parallel-implementation-review validation command cannot be a wait/watch/sleep command");
	}
	const timeoutMatch = /\btimeout\s+(\d+)([smhd]?)\b/u.exec(normalized);
	if (!timeoutMatch) return;
	const value = Number(timeoutMatch[1]);
	const unit = timeoutMatch[2] || "s";
	const seconds = unit === "d" ? value * 86400 : unit === "h" ? value * 3600 : unit === "m" ? value * 60 : value;
	if (seconds > 3600) {
		throw new Error("parallel-implementation-review validation command timeout must be 1 hour or less");
	}
}
