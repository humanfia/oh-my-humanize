const task = workflowContext.state?.task;
const command = task?.reproductionCommand;
if (typeof command !== "string" || command.trim() === "") {
	throw new Error("research-reproduction requires /task.reproductionCommand before reproduceBaseline");
}

const result = await runShell(command);
const exerciseSummary = analyzeExercise(result, command);
const outputPath = "workflow-output/reproduction-baseline.md";
const evidencePath = "workflow-output/reproduction-baseline.json";
await Bun.write(outputPath, evidenceMarkdown("Reproduction", command, result));
await writeStructuredEvidence(evidencePath, { label: "Reproduction", command, result, exerciseSummary });

return {
	summary: `reproduction ${result.exitCode === 0 && exerciseSummary.exercised ? "pass" : "fail"}`,
	data: { exitCode: result.exitCode, exerciseSummary },
	statePatch: [{ op: "set", path: "/reproduction", value: stateValue(command, result, outputPath, evidencePath, exerciseSummary) }],
};

async function runShell(command) {
	const proc = Bun.spawn(["sh", "-c", command], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { exitCode, stdout, stderr };
}

function stateValue(command, result, outputPath, evidencePath, exerciseSummary) {
	return {
		status: result.exitCode === 0 && exerciseSummary.exercised ? "pass" : "fail",
		exercised: exerciseSummary.exercised,
		exerciseSummary,
		command,
		exitCode: result.exitCode,
		stdout: result.stdout,
		stderr: result.stderr,
		outputPath,
		evidencePath,
	};
}

function evidenceMarkdown(label, command, result) {
	return [
		`# ${label}`,
		"",
		"```sh",
		command,
		"```",
		"",
		`Exit code: ${result.exitCode}`,
		"",
		"```text",
		bounded(result.stdout || result.stderr || "(empty)"),
		"```",
		"",
	].join("\n");
}

function bounded(text) {
	const limit = 12000;
	if (text.length <= limit) return text;
	return `${text.slice(0, limit)}\n[truncated ${text.length - limit} bytes]`;
}

function nonExercisingOutput(result) {
	const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.toLowerCase();
	if (hasExercisingSignal(text)) return false;
	return !analyzeExercise(result, "").exercised;
}

function analyzeExercise(result, command) {
	const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.toLowerCase();
	const positiveSignals = exerciseSignals(text);
	if (result.exitCode === 0 && assertionBackedCommand(command) && text.trim().length > 0) {
		positiveSignals.push("assertion-backed-command");
	}
	const negativeSignals = (
		text.includes("[no test files]") ||
		text.includes("no tests ran") ||
		text.includes("collected 0 items") ||
		/\b0\s+tests?\b/u.test(text) ||
		text.includes("no test files")
	);
	return {
		exercised: positiveSignals.length > 0 && !negativeSignals,
		positiveSignals,
		negativeSignals,
		okPackages: countMatches(text, /^ok\s+\S+/gmu),
		passedCounts: countMatches(text, /\b\d+\s+(?:tests?\s+)?passed\b/gu),
	};
}

function hasExercisingSignal(text) {
	return exerciseSignals(text).length > 0;
}

function exerciseSignals(text) {
	const signals = [];
	if (/^ok\s+\S+/mu.test(text)) signals.push("go-ok-package");
	if (/\b\d+\s+passed\b/u.test(text)) signals.push("passed-count");
	if (/\b\d+\s+tests?\s+passed\b/u.test(text)) signals.push("tests-passed-count");
	if (/\b\d+\s+examples?\b/u.test(text)) signals.push("examples-count");
	return signals;
}

function assertionBackedCommand(command) {
	return /\b(?:assert|assertRaises|pytest\.raises|unittest\.TestCase\(\)\.assert)\b/u.test(command);
}

function countMatches(text, pattern) {
	return [...text.matchAll(pattern)].length;
}

async function writeStructuredEvidence(filePath, value) {
	await Bun.write(filePath, `${JSON.stringify(value, null, 2)}\n`);
}
