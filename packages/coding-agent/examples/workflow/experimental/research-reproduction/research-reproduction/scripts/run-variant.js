const task = workflowContext.state?.task;
const variantCommand = task?.variantCommand;
const validationCommand = task?.validationCommand;
const outputPath = "workflow-output/reproduction-variant.md";

if (typeof validationCommand !== "string" || validationCommand.trim() === "") {
	throw new Error("research-reproduction requires /task.validationCommand before runVariant");
}

const variant =
	typeof variantCommand === "string" && variantCommand.trim() !== "" ? await runShell(variantCommand) : undefined;
const validation = await runShell(validationCommand);
const variantExerciseSummary = variant ? analyzeExercise(variant, variantCommand) : undefined;
const validationExerciseSummary = analyzeExercise(validation, validationCommand);
const variantCommandEvidence = variant
	? commandEvidence("variant", variantCommand, variant, variantExerciseSummary)
	: null;
const validationCommandEvidence = commandEvidence(
	"validation",
	validationCommand,
	validation,
	validationExerciseSummary,
);
const evidencePath = "workflow-output/reproduction-variant.json";
await Bun.write(outputPath, evidenceMarkdown(variantCommand, variant, validationCommand, validation));
await writeStructuredEvidence(evidencePath, {
	variantCommand,
	variant,
	variantExerciseSummary,
	variantCommandEvidence,
	validationCommand,
	validation,
	validationExerciseSummary,
	validationCommandEvidence,
});

const variantPass = variant === undefined || variant.exitCode === 0;
const validationExercised = validationExerciseSummary.exercised;
const validationPass = validation.exitCode === 0 && validationExercised;

return {
	summary: `variant=${variantPass ? "pass" : "fail"} validation=${validationPass ? "pass" : "fail"}`,
	data: {
		variantExitCode: variant?.exitCode,
		variantExerciseSummary,
		validationExitCode: validation.exitCode,
		validationExerciseSummary,
	},
	statePatch: [
		{
			op: "set",
			path: "/variant",
			value: {
				variantCommand,
				variantExitCode: variant?.exitCode,
				variantStdoutPath: variant ? evidencePath : undefined,
				variantStderrPath: variant ? evidencePath : undefined,
				variantExerciseSummary,
				variantCommandEvidence: variant
					? stateCommandEvidence("variant", variantCommand, variant, variantExerciseSummary, evidencePath)
					: null,
				validationCommand,
				validationExitCode: validation.exitCode,
				validationStdoutPath: evidencePath,
				validationStderrPath: evidencePath,
				validationExercised,
				exerciseSummary: validationExerciseSummary,
				validationCommandEvidence: stateCommandEvidence(
					"validation",
					validationCommand,
					validation,
					validationExerciseSummary,
					evidencePath,
				),
				status: variantPass && validationPass ? "pass" : "fail",
				outputPath,
				evidencePath,
			},
		},
	],
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

function evidenceMarkdown(variantCommand, variant, validationCommand, validation) {
	const lines = ["# Reproduction Variant And Validation", ""];
	appendCommand(lines, "Variant", variantCommand, variant);
	appendCommand(lines, "Validation", validationCommand, validation);
	return lines.join("\n");
}

function appendCommand(lines, label, command, result) {
	lines.push(`## ${label}`, "");
	if (!command || !result) {
		lines.push("(not provided)", "");
		return;
	}
	lines.push(
		"```sh",
		command,
		"```",
		"",
		`Exit code: ${result.exitCode}`,
		"",
		`### ${label} stdout`,
		"",
		"```text",
		bounded(result.stdout || "(empty)"),
		"```",
		"",
		`### ${label} stderr`,
		"",
		"```text",
		bounded(result.stderr || "(empty)"),
		"```",
		"",
	);
}

function commandEvidence(role, command, result, exerciseSummary) {
	return {
		role,
		command,
		exitCode: result.exitCode,
		stdout: result.stdout,
		stderr: result.stderr,
		exerciseSummary,
	};
}

function stateCommandEvidence(role, command, result, exerciseSummary, evidencePath) {
	return {
		role,
		command,
		exitCode: result.exitCode,
		stdoutPath: evidencePath,
		stderrPath: evidencePath,
		stdoutPreview: statePreview(result.stdout || ""),
		stderrPreview: statePreview(result.stderr || ""),
		exerciseSummary,
	};
}

function statePreview(text) {
	const limit = 2000;
	if (text.length <= limit) return text;
	return `${text.slice(0, limit)}\n[see full stream in artifact; truncated ${text.length - limit} bytes]`;
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
	if (result.exitCode === 0 && negativeControlOutput(text)) {
		positiveSignals.push("negative-control-output");
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

function negativeControlOutput(text) {
	return /\b(?:reject(?:ed|ion)?|caught|raised|raises?|badsignature|bad signature|invalid|tamper(?:ed)?|failed as expected)\b/u.test(
		text,
	);
}

function countMatches(text, pattern) {
	return [...text.matchAll(pattern)].length;
}

async function writeStructuredEvidence(filePath, value) {
	await Bun.write(filePath, `${JSON.stringify(value, null, 2)}\n`);
}
