import type { WorkflowScriptLanguage } from "./definition";
import type { WorkflowNodeRuntimeHost, WorkflowReviewNodeOutput } from "./node-runtime";
import { WorkflowNodeRuntimeError } from "./node-runtime";
import { validateWorkflowActivationOutput, type WorkflowActivationOutput } from "./state";

export interface WorkflowSessionRuntimeOptions {
	cwd: string;
	runEvalScript?: WorkflowScriptEvalRunner;
	runShellScript?: WorkflowShellScriptRunner;
	runAgentTask?: WorkflowAgentTaskRunner;
	runHumanInput?: WorkflowHumanInputRunner;
}

export interface WorkflowAgentTaskRequest {
	agent: string;
	activationId: string;
	nodeId: string;
	modelOverride?: string;
	modelOverrideAuthFallback?: boolean;
	signal?: AbortSignal;
	task: WorkflowAgentTaskItem;
}

export interface WorkflowAgentTaskItem {
	id: string;
	description: string;
	assignment: string;
}

export interface WorkflowAgentTaskResult {
	exitCode: number;
	output: string;
	stderr?: string;
	error?: string;
	outputPath?: string;
}

export type WorkflowAgentTaskRunner = (request: WorkflowAgentTaskRequest) => Promise<WorkflowAgentTaskResult>;

export type WorkflowScriptEvalLanguage = Exclude<WorkflowScriptLanguage, "sh">;
export type WorkflowShellScriptLanguage = Extract<WorkflowScriptLanguage, "sh">;

export interface WorkflowScriptEvalRequest {
	activationId: string;
	nodeId: string;
	code: string;
	language: WorkflowScriptEvalLanguage;
	title: string;
}

export interface WorkflowShellScriptRequest {
	activationId: string;
	nodeId: string;
	code: string;
	language: WorkflowShellScriptLanguage;
	title: string;
	signal?: AbortSignal;
}

export interface WorkflowScriptEvalResult {
	exitCode: number;
	output: string;
	error?: string;
	artifactId?: string;
	language?: WorkflowScriptLanguage;
}

export type WorkflowScriptEvalRunner = (request: WorkflowScriptEvalRequest) => Promise<WorkflowScriptEvalResult>;
export type WorkflowShellScriptRunner = (request: WorkflowShellScriptRequest) => Promise<WorkflowScriptEvalResult>;

export interface WorkflowHumanInputRequest {
	activationId: string;
	nodeId: string;
	question: string;
}

export interface WorkflowHumanInputResult {
	response: string;
	selectedOptions?: string[];
	customInput?: string;
}

export type WorkflowHumanInputRunner = (request: WorkflowHumanInputRequest) => Promise<WorkflowHumanInputResult>;

export function createSessionWorkflowRuntimeHost(options: WorkflowSessionRuntimeOptions): WorkflowNodeRuntimeHost {
	return {
		runAgentNode: async input => {
			if (!options.runAgentTask) {
				throw new WorkflowNodeRuntimeError(
					`workflow agent node "${input.node.id}" requires a subagent runtime adapter`,
				);
			}
			const task: WorkflowAgentTaskItem = {
				id: taskIdForNode(input.node.id),
				description: input.node.id,
				assignment: input.prompt?.trim() || `Run workflow node "${input.node.id}".`,
			};
			const request: WorkflowAgentTaskRequest = {
				agent: input.agent,
				activationId: input.activation.id,
				nodeId: input.node.id,
				task,
			};
			if (input.modelOverride !== undefined) {
				request.modelOverride = input.modelOverride;
				request.modelOverrideAuthFallback = false;
			}
			if (input.signal !== undefined) {
				request.signal = input.signal;
			}
			const result = await options.runAgentTask(request);
			return activationOutputFromTaskResult(input.node.id, result);
		},
		runScriptNode: async input => {
			const code = input.script?.trim();
			if (!code) {
				throw new WorkflowNodeRuntimeError(`workflow script node "${input.node.id}" must define script code`);
			}
			const language = input.scriptLanguage ?? "js";
			const result =
				language === "sh"
					? await runShellWorkflowScript(input.node.id, code, input, options)
					: await runEvalWorkflowScript(input.node.id, code, input, options);
			if (result.exitCode !== 0) {
				const reason = result.error || `exit code ${result.exitCode}`;
				throw new WorkflowNodeRuntimeError(`workflow script node "${input.node.id}" failed: ${reason}`);
			}
			return activationOutputFromScriptResult(input.node.id, result);
		},
		runHumanNode: async input => {
			if (!options.runHumanInput) {
				throw new WorkflowNodeRuntimeError(`workflow human node "${input.node.id}" requires a human input adapter`);
			}
			const question = input.prompt?.trim();
			if (!question) {
				throw new WorkflowNodeRuntimeError(`workflow human node "${input.node.id}" must define a question prompt`);
			}
			const result = await options.runHumanInput({
				activationId: input.activation.id,
				nodeId: input.node.id,
				question,
			});
			return activationOutputFromHumanInputResult(result);
		},
		runReviewNode: async input => {
			if (!options.runAgentTask) {
				throw new WorkflowNodeRuntimeError(
					`workflow review node "${input.node.id}" requires a review runtime adapter`,
				);
			}
			const assignment = input.prompt?.trim();
			if (!assignment) {
				throw new WorkflowNodeRuntimeError(`workflow review node "${input.node.id}" must define a review prompt`);
			}
			const request: WorkflowAgentTaskRequest = {
				agent: input.agent ?? "reviewer",
				activationId: input.activation.id,
				nodeId: input.node.id,
				task: {
					id: taskIdForNode(input.node.id),
					description: input.node.id,
					assignment,
				},
			};
			if (input.modelOverride !== undefined) {
				request.modelOverride = input.modelOverride;
				request.modelOverrideAuthFallback = false;
			}
			if (input.signal !== undefined) {
				request.signal = input.signal;
			}
			const result = await options.runAgentTask(request);
			return reviewOutputFromTaskResult(input.node.id, result, input.gates, input.fallbackVerdict);
		},
	};
}

async function runEvalWorkflowScript(
	nodeId: string,
	code: string,
	input: { activation: { id: string }; scriptLanguage?: WorkflowScriptLanguage; scriptPath?: string },
	options: WorkflowSessionRuntimeOptions,
): Promise<WorkflowScriptEvalResult> {
	if (!options.runEvalScript) {
		throw new WorkflowNodeRuntimeError(`workflow script node "${nodeId}" requires an eval runtime adapter`);
	}
	const language = input.scriptLanguage ?? "js";
	if (language === "sh") {
		throw new WorkflowNodeRuntimeError(`workflow script node "${nodeId}" requires a shell runtime adapter`);
	}
	return options.runEvalScript({
		activationId: input.activation.id,
		nodeId,
		code,
		language,
		title: input.scriptPath ?? nodeId,
	});
}

async function runShellWorkflowScript(
	nodeId: string,
	code: string,
	input: { activation: { id: string }; scriptPath?: string; signal?: AbortSignal },
	options: WorkflowSessionRuntimeOptions,
): Promise<WorkflowScriptEvalResult> {
	if (!options.runShellScript) {
		throw new WorkflowNodeRuntimeError(`workflow script node "${nodeId}" requires a shell runtime adapter`);
	}
	const request: WorkflowShellScriptRequest = {
		activationId: input.activation.id,
		nodeId,
		code,
		language: "sh",
		title: input.scriptPath ?? nodeId,
	};
	if (input.signal !== undefined) {
		request.signal = input.signal;
	}
	return options.runShellScript(request);
}

function activationOutputFromScriptResult(nodeId: string, result: WorkflowScriptEvalResult): WorkflowActivationOutput {
	const structured = parseStructuredActivationOutput(result.output);
	if (structured) return structured;
	const summary = result.output.trim() || `script node "${nodeId}" completed`;
	const output: WorkflowActivationOutput = {
		summary,
		data: { exitCode: result.exitCode },
	};
	if (result.artifactId) {
		output.artifacts = [`artifact://${result.artifactId}`];
	}
	return output;
}

function parseStructuredActivationOutput(output: string): WorkflowActivationOutput | undefined {
	const trimmed = output.trim();
	const parsed = parseJsonObject(trimmed) ?? parseLastJsonObjectLine(trimmed);
	if (!parsed || !hasActivationOutputField(parsed)) return undefined;
	return validateWorkflowActivationOutput(parsed);
}

function parseLastJsonObjectLine(output: string): Record<string, unknown> | undefined {
	const lines = output
		.split(/\r?\n/)
		.map(line => line.trim())
		.filter(line => line.length > 0);
	for (const line of lines.toReversed()) {
		const parsed = parseJsonObject(line);
		if (parsed) return parsed;
	}
	return undefined;
}

function hasActivationOutputField(value: Record<string, unknown>): boolean {
	return (
		value.summary !== undefined ||
		value.data !== undefined ||
		value.statePatch !== undefined ||
		value.artifacts !== undefined
	);
}

function taskIdForNode(nodeId: string): string {
	const sanitized = nodeId.replaceAll(/[^A-Za-z0-9_]/g, "_").slice(0, 48);
	return sanitized || "workflow_node";
}

function activationOutputFromTaskResult(nodeId: string, result: WorkflowAgentTaskResult): WorkflowActivationOutput {
	if (result.exitCode !== 0) {
		const reason = result.error || result.stderr || `exit code ${result.exitCode}`;
		throw new WorkflowNodeRuntimeError(`workflow agent node "${nodeId}" failed: ${reason}`);
	}
	const structured = parseStructuredActivationOutput(result.output);
	if (structured) {
		if (result.outputPath && structured.artifacts === undefined) {
			return { ...structured, artifacts: [`local://${result.outputPath}`] };
		}
		return structured;
	}
	const output: WorkflowActivationOutput = {
		summary: result.output.trim() || `agent node "${nodeId}" completed`,
		data: { exitCode: result.exitCode },
	};
	if (result.outputPath) {
		output.artifacts = [`local://${result.outputPath}`];
	}
	return output;
}

function activationOutputFromHumanInputResult(result: WorkflowHumanInputResult): WorkflowActivationOutput {
	const data: Record<string, unknown> = {
		response: result.response,
	};
	if (result.selectedOptions !== undefined) data.selectedOptions = result.selectedOptions;
	if (result.customInput !== undefined) data.customInput = result.customInput;
	return {
		summary: result.response,
		data,
	};
}

function reviewOutputFromTaskResult(
	nodeId: string,
	result: WorkflowAgentTaskResult,
	gates: string[] | undefined,
	fallbackVerdict: string | undefined,
): WorkflowReviewNodeOutput {
	if (result.exitCode !== 0) {
		const reason = result.error || result.stderr || `exit code ${result.exitCode}`;
		throw new WorkflowNodeRuntimeError(`workflow review node "${nodeId}" failed: ${reason}`);
	}
	const parsed = parseReviewTaskOutput(nodeId, result.output, gates, fallbackVerdict);
	const output: WorkflowReviewNodeOutput = {
		summary: parsed.summary,
		verdict: parsed.verdict,
	};
	if (result.outputPath) {
		output.artifacts = [`local://${result.outputPath}`];
	}
	return output;
}

function parseReviewTaskOutput(
	nodeId: string,
	output: string,
	gates: string[] | undefined,
	fallbackVerdict: string | undefined,
): { verdict: string; summary: string } {
	const trimmed = output.trim();
	const parsed = parseJsonObject(trimmed);
	if (parsed) {
		return parseReviewObject(nodeId, parsed, trimmed, gates, fallbackVerdict);
	}
	if (gates?.includes(trimmed)) {
		return { verdict: trimmed, summary: trimmed };
	}
	const finalLine = lastNonEmptyLine(trimmed);
	if (finalLine && finalLine !== trimmed) {
		const finalJson = parseJsonObject(finalLine);
		if (finalJson) {
			return parseReviewObject(nodeId, finalJson, trimmed, gates, fallbackVerdict);
		}
		if (gates?.includes(finalLine)) {
			return { verdict: finalLine, summary: trimmed };
		}
	}
	if (fallbackVerdict !== undefined) {
		return { verdict: fallbackVerdict, summary: trimmed || fallbackVerdict };
	}
	throw new WorkflowNodeRuntimeError(`workflow review node "${nodeId}" must return a verdict`);
}

function lastNonEmptyLine(output: string): string | undefined {
	const lines = output
		.split(/\r?\n/)
		.map(line => line.trim())
		.filter(line => line.length > 0);
	return lines.at(-1);
}

function parseReviewObject(
	nodeId: string,
	parsed: Record<string, unknown>,
	fallbackSummary: string,
	gates: string[] | undefined,
	fallbackVerdict: string | undefined,
): { verdict: string; summary: string } {
	const direct = reviewVerdictFromObject(parsed, fallbackSummary);
	if (direct) return direct;

	const nested = nestedReviewVerdictFromObject(parsed, fallbackSummary);
	if (nested) return nested;

	const textGate = reviewVerdictFromObjectText(parsed, fallbackSummary, gates);
	if (textGate) return textGate;

	const correctness = parsed.overall_correctness;
	if (correctness === "correct" || correctness === "incorrect") {
		return {
			verdict: verdictFromReviewerCorrectness(correctness, gates, fallbackVerdict),
			summary: reviewSummaryFromObject(parsed, fallbackSummary),
		};
	}

	throw new WorkflowNodeRuntimeError(`workflow review node "${nodeId}" must return a string verdict`);
}

function reviewVerdictFromObject(
	parsed: Record<string, unknown>,
	fallbackSummary: string,
): { verdict: string; summary: string } | undefined {
	const verdict = parsed.verdict;
	if (typeof verdict !== "string" || verdict.length === 0) return undefined;
	return { verdict, summary: reviewSummaryFromObject(parsed, fallbackSummary) };
}

function nestedReviewVerdictFromObject(
	parsed: Record<string, unknown>,
	fallbackSummary: string,
): { verdict: string; summary: string } | undefined {
	for (const source of [parsed.summary, parsed.explanation]) {
		if (typeof source !== "string") continue;
		const nested = parseJsonObject(source.trim());
		if (!nested) continue;
		const verdict = reviewVerdictFromObject(nested, fallbackSummary);
		if (verdict) return verdict;
	}
	return undefined;
}

function reviewVerdictFromObjectText(
	parsed: Record<string, unknown>,
	fallbackSummary: string,
	gates: string[] | undefined,
): { verdict: string; summary: string } | undefined {
	if (!gates?.length) return undefined;
	const summary = reviewSummaryFromObject(parsed, fallbackSummary);
	const finalLine = lastNonEmptyLine(summary);
	if (finalLine === undefined || !gates.includes(finalLine)) return undefined;
	return { verdict: finalLine, summary };
}

function reviewSummaryFromObject(parsed: Record<string, unknown>, fallbackSummary: string): string {
	for (const source of [parsed.summary, parsed.explanation]) {
		if (typeof source === "string" && source.length > 0) return source;
	}
	return fallbackSummary;
}

function verdictFromReviewerCorrectness(
	correctness: "correct" | "incorrect",
	gates: string[] | undefined,
	fallbackVerdict: string | undefined,
): string {
	const candidates =
		correctness === "correct"
			? ["correct", "pass", "approve", "approved", "finish"]
			: ["incorrect", "fail", "reject", "rejected", "retry", "continue"];
	if (gates) {
		const declared = candidates.find(candidate => gates.includes(candidate));
		if (declared) return declared;
	}
	if (fallbackVerdict !== undefined) return fallbackVerdict;
	return correctness === "correct" ? "pass" : "fail";
}

function parseJsonObject(source: string): Record<string, unknown> | undefined {
	try {
		const parsed: unknown = JSON.parse(source);
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}
