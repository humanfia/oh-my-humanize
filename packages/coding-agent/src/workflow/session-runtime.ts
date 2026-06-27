import { extractRetryHint } from "@oh-my-pi/pi-utils";
import { workflowAgentTaskIdForNode } from "./agent-task-id";
import type { WorkflowScriptLanguage } from "./definition";
import { formatWorkflowAgentWorkItemLabel } from "./display";
import type { WorkflowNodeRuntimeHost, WorkflowReviewNodeOutput, WorkflowScriptContext } from "./node-runtime";
import { WorkflowNodeRuntimeError } from "./node-runtime";
import { createWorkflowObservabilityRecorder, recordWorkflowActivationObservability } from "./observability";
import {
	DEFAULT_WORKFLOW_MAX_SUMMARY_BYTES,
	validateWorkflowActivationOutput,
	type WorkflowActivationOutput,
} from "./state";

const WORKFLOW_SUMMARY_TRUNCATION_SUFFIX =
	"\n\n[workflow summary truncated; full output is stored outside inline workflow state.]";

export interface WorkflowSessionRuntimeOptions {
	cwd: string;
	agentTaskRetryPolicy?: WorkflowAgentTaskRetryPolicy;
	retryDelay?: WorkflowRetryDelayRunner;
	retryRandom?: WorkflowRetryRandomSource;
	runEvalScript?: WorkflowScriptEvalRunner;
	runShellScript?: WorkflowShellScriptRunner;
	runAgentTask?: WorkflowAgentTaskRunner;
	runHumanInput?: WorkflowHumanInputRunner;
}

export interface WorkflowAgentTaskRetryPolicy {
	maxAttempts?: number;
	baseDelayMs?: number;
	maxDelayMs?: number;
	jitterRatio?: number;
}

export type WorkflowRetryDelayRunner = (delayMs: number, signal: AbortSignal | undefined) => Promise<void>;
export type WorkflowRetryRandomSource = () => number;

export interface WorkflowAgentTaskRequest {
	agent: string;
	activationId: string;
	nodeId: string;
	modelOverride?: string;
	modelOverrideAuthFallback?: boolean;
	isolated?: boolean;
	apply?: boolean;
	merge?: boolean;
	signal?: AbortSignal;
	task: WorkflowAgentTaskItem;
}

export interface WorkflowAgentTaskItem {
	id: string;
	description: string;
	role: string;
	assignment: string;
}

export interface WorkflowAgentTaskResult {
	exitCode: number;
	output: string;
	stderr?: string;
	error?: string;
	data?: Record<string, unknown>;
	agentId?: string;
	outputPath?: string;
	sessionFile?: string;
	patchPath?: string;
	branchName?: string;
	changesApplied?: boolean | null;
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
	timeoutMs?: number;
	resourceDir?: string;
	signal?: AbortSignal;
	context?: WorkflowScriptContext;
}

export interface WorkflowShellScriptRequest {
	activationId: string;
	nodeId: string;
	code: string;
	language: WorkflowShellScriptLanguage;
	title: string;
	timeoutMs?: number;
	resourceDir?: string;
	signal?: AbortSignal;
	context?: WorkflowScriptContext;
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
	signal?: AbortSignal;
}

export interface WorkflowHumanInputResult {
	response: string;
	question?: string;
	selectedOptions?: string[];
	customInput?: string;
}

export type WorkflowHumanInputRunner = (request: WorkflowHumanInputRequest) => Promise<WorkflowHumanInputResult>;

export function createSessionWorkflowRuntimeHost(options: WorkflowSessionRuntimeOptions): WorkflowNodeRuntimeHost {
	const recordObservability = createWorkflowObservabilityRecorder(options.cwd);
	return {
		runAgentNode: async input => {
			if (!options.runAgentTask) {
				throw new WorkflowNodeRuntimeError(
					`workflow agent node "${input.node.id}" requires a subagent runtime adapter`,
				);
			}
			const taskLabel = formatWorkflowAgentWorkItemLabel(input.node);
			const task: WorkflowAgentTaskItem = {
				id: workflowAgentTaskIdForNode(input.node.id),
				description: taskLabel,
				role: taskLabel,
				assignment: input.prompt?.trim() || `Run workflow node "${input.node.id}".`,
			};
			const request: WorkflowAgentTaskRequest = {
				agent: input.agent,
				activationId: input.activation.id,
				nodeId: input.node.id,
				task,
			};
			applyWorkflowNodeIsolation(request, input.node);
			if (input.modelOverride !== undefined) {
				request.modelOverride = input.modelOverride;
				request.modelOverrideAuthFallback = false;
			}
			if (input.signal !== undefined) {
				request.signal = input.signal;
			}
			const result = await runAgentTaskWithTransientRetry(options, request);
			const output = activationOutputFromTaskResult(input.node.id, result);
			await recordWorkflowActivationObservability(recordObservability, input.node, input.activation.id, output);
			return output;
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
			const output = activationOutputFromScriptResult(input.node.id, result);
			await recordWorkflowActivationObservability(recordObservability, input.node, input.activation.id, output);
			return output;
		},
		runHumanNode: async input => {
			if (!options.runHumanInput) {
				throw new WorkflowNodeRuntimeError(`workflow human node "${input.node.id}" requires a human input adapter`);
			}
			const question = input.prompt?.trim();
			if (!question) {
				throw new WorkflowNodeRuntimeError(`workflow human node "${input.node.id}" must define a question prompt`);
			}
			const request: WorkflowHumanInputRequest = {
				activationId: input.activation.id,
				nodeId: input.node.id,
				question,
			};
			if (input.signal !== undefined) request.signal = input.signal;
			const result = await options.runHumanInput(request);
			const output = activationOutputFromHumanInputResult({ ...result, question });
			await recordWorkflowActivationObservability(recordObservability, input.node, input.activation.id, output);
			return output;
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
			const taskLabel = formatWorkflowAgentWorkItemLabel(input.node);
			const request: WorkflowAgentTaskRequest = {
				agent: input.agent ?? "reviewer",
				activationId: input.activation.id,
				nodeId: input.node.id,
				task: {
					id: workflowAgentTaskIdForNode(input.node.id),
					description: taskLabel,
					role: taskLabel,
					assignment,
				},
			};
			applyWorkflowNodeIsolation(request, input.node);
			if (input.modelOverride !== undefined) {
				request.modelOverride = input.modelOverride;
				request.modelOverrideAuthFallback = false;
			}
			if (input.signal !== undefined) {
				request.signal = input.signal;
			}
			const result = await runAgentTaskWithTransientRetry(options, request);
			const output = reviewOutputFromTaskResult(input.node.id, result, input.gates, input.fallbackVerdict);
			await recordWorkflowActivationObservability(recordObservability, input.node, input.activation.id, output);
			return output;
		},
	};
}

function applyWorkflowNodeIsolation(
	request: WorkflowAgentTaskRequest,
	node: { isolation?: { enabled: boolean; apply?: boolean; merge?: boolean } },
): void {
	const isolation = node.isolation;
	if (isolation === undefined || isolation.enabled !== true) return;
	request.isolated = true;
	if (isolation.apply !== undefined) request.apply = isolation.apply;
	if (isolation.merge !== undefined) request.merge = isolation.merge;
}

interface NormalizedWorkflowAgentTaskRetryPolicy {
	maxAttempts: number;
	baseDelayMs: number;
	maxDelayMs: number;
	jitterRatio: number;
}

const DEFAULT_WORKFLOW_AGENT_TASK_RETRY_POLICY: NormalizedWorkflowAgentTaskRetryPolicy = {
	maxAttempts: 6,
	baseDelayMs: 30_000,
	maxDelayMs: 300_000,
	jitterRatio: 0.25,
};

async function runAgentTaskWithTransientRetry(
	options: WorkflowSessionRuntimeOptions,
	request: WorkflowAgentTaskRequest,
): Promise<WorkflowAgentTaskResult> {
	if (options.runAgentTask === undefined) {
		throw new WorkflowNodeRuntimeError(`workflow agent node "${request.nodeId}" requires a subagent runtime adapter`);
	}
	const policy = normalizeWorkflowAgentTaskRetryPolicy(options.agentTaskRetryPolicy);
	let lastTransientResult: WorkflowAgentTaskResult | undefined;
	for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
		throwIfWorkflowSignalAborted(request.signal);
		let transientReason: string;
		try {
			const result = await options.runAgentTask(request);
			transientReason = workflowAgentTaskFailureReason(result);
			if (result.exitCode === 0 || !workflowAgentTaskReasonIsTransient(transientReason)) return result;
			lastTransientResult = result;
			if (attempt >= policy.maxAttempts) return result;
		} catch (error) {
			if (workflowErrorWasAborted(error)) throw error;
			transientReason = formatWorkflowErrorReason(error);
			if (!workflowAgentTaskReasonIsTransient(transientReason) || attempt >= policy.maxAttempts) throw error;
		}
		await sleepBeforeWorkflowAgentTaskRetry(options, policy, attempt, request.signal, transientReason);
	}
	if (lastTransientResult !== undefined) return lastTransientResult;
	return {
		exitCode: 1,
		output: "",
		error: `workflow agent task "${request.nodeId}" exhausted transient retry attempts`,
	};
}

function normalizeWorkflowAgentTaskRetryPolicy(
	policy: WorkflowAgentTaskRetryPolicy | undefined,
): NormalizedWorkflowAgentTaskRetryPolicy {
	const maxAttempts = normalizePositiveInteger(
		policy?.maxAttempts,
		DEFAULT_WORKFLOW_AGENT_TASK_RETRY_POLICY.maxAttempts,
	);
	const baseDelayMs = normalizeNonNegativeInteger(
		policy?.baseDelayMs,
		DEFAULT_WORKFLOW_AGENT_TASK_RETRY_POLICY.baseDelayMs,
	);
	const maxDelayMs = normalizeNonNegativeInteger(
		policy?.maxDelayMs,
		DEFAULT_WORKFLOW_AGENT_TASK_RETRY_POLICY.maxDelayMs,
	);
	const jitterRatio = normalizeRetryJitterRatio(
		policy?.jitterRatio,
		DEFAULT_WORKFLOW_AGENT_TASK_RETRY_POLICY.jitterRatio,
	);
	return {
		maxAttempts,
		baseDelayMs,
		maxDelayMs: Math.max(baseDelayMs, maxDelayMs),
		jitterRatio,
	};
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	return Math.max(1, Math.floor(value));
}

function normalizeNonNegativeInteger(value: number | undefined, fallback: number): number {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	return Math.max(0, Math.floor(value));
}

function normalizeRetryJitterRatio(value: number | undefined, fallback: number): number {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	return Math.min(1, Math.max(0, value));
}

function workflowAgentTaskFailureReason(result: WorkflowAgentTaskResult): string {
	return [result.error, result.stderr, result.output].filter((part): part is string => part !== undefined).join("\n");
}

function workflowAgentTaskReasonIsTransient(reason: string): boolean {
	return WORKFLOW_AGENT_TRANSIENT_PROVIDER_ERROR_PATTERN.test(reason);
}

const WORKFLOW_AGENT_TRANSIENT_PROVIDER_ERROR_PATTERN =
	/(?:\b429\b|too many requests|rate[_ -]?limit|temporar(?:y|ily) unavailable|overloaded|service unavailable|bad gateway|gateway timeout|upstream[^.\n]*(?:unavailable|timeout|rate limit)|\b5\d\d\b|HTTP\/2[^.\n]*(?:error|not closed cleanly)|\bINTERNAL_ERROR\b|stream[_ -]read[_ -]error|stream[_ -]interrupted(?:[_ -]after[_ -]content)?|ECONNRESET|ETIMEDOUT|EAI_AGAIN)/iu;

function formatWorkflowErrorReason(error: unknown): string {
	if (error instanceof Error) return `${error.name}: ${error.message}`;
	return String(error);
}

async function sleepBeforeWorkflowAgentTaskRetry(
	options: WorkflowSessionRuntimeOptions,
	policy: NormalizedWorkflowAgentTaskRetryPolicy,
	completedAttempt: number,
	signal: AbortSignal | undefined,
	transientReason: string,
): Promise<void> {
	const delayMs = workflowAgentTaskRetryDelayMs(
		policy,
		completedAttempt,
		transientReason,
		options.retryRandom ?? Math.random,
	);
	if (delayMs <= 0) return;
	throwIfWorkflowSignalAborted(signal);
	await (options.retryDelay ?? sleepWorkflowRetryDelay)(delayMs, signal);
	throwIfWorkflowSignalAborted(signal);
}

function workflowAgentTaskRetryDelayMs(
	policy: NormalizedWorkflowAgentTaskRetryPolicy,
	completedAttempt: number,
	transientReason: string,
	random: WorkflowRetryRandomSource,
): number {
	const exponent = Math.max(0, completedAttempt - 1);
	const exponentialDelay = policy.baseDelayMs * 2 ** exponent;
	const retryHintMs = extractRetryHint(undefined, transientReason);
	const floorDelay = Math.max(exponentialDelay, retryHintMs ?? 0);
	const cappedDelay = Math.min(policy.maxDelayMs, floorDelay);
	if (policy.jitterRatio <= 0 || cappedDelay <= 0) return cappedDelay;
	const jitterRange = Math.floor(cappedDelay * policy.jitterRatio);
	if (jitterRange <= 0) return cappedDelay;
	const jitter = Math.floor(jitterRange * normalizeRetryRandomValue(random()));
	return Math.min(policy.maxDelayMs, cappedDelay + jitter);
}

function normalizeRetryRandomValue(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.min(1, Math.max(0, value));
}

async function sleepWorkflowRetryDelay(delayMs: number, signal: AbortSignal | undefined): Promise<void> {
	throwIfWorkflowSignalAborted(signal);
	if (signal === undefined) {
		await Bun.sleep(delayMs);
		return;
	}
	const abort = Promise.withResolvers<void>();
	const onAbort = () => abort.reject(workflowAbortError(signal));
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		await Promise.race([Bun.sleep(delayMs), abort.promise]);
	} finally {
		signal.removeEventListener("abort", onAbort);
		throwIfWorkflowSignalAborted(signal);
	}
}

function throwIfWorkflowSignalAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted === true) throw workflowAbortError(signal);
}

function workflowAbortError(signal: AbortSignal): Error {
	const reason = signal.reason;
	if (reason instanceof Error) return reason;
	return new Error(reason === undefined ? "workflow node aborted" : String(reason));
}

function workflowErrorWasAborted(error: unknown): boolean {
	return error instanceof Error && (error.name === "AbortError" || /aborted|abort signal/iu.test(error.message));
}

async function runEvalWorkflowScript(
	nodeId: string,
	code: string,
	input: {
		activation: { id: string };
		scriptLanguage?: WorkflowScriptLanguage;
		scriptPath?: string;
		timeoutMs?: number;
		resourceDir?: string;
		signal?: AbortSignal;
		context?: WorkflowScriptContext;
	},
	options: WorkflowSessionRuntimeOptions,
): Promise<WorkflowScriptEvalResult> {
	if (!options.runEvalScript) {
		throw new WorkflowNodeRuntimeError(`workflow script node "${nodeId}" requires an eval runtime adapter`);
	}
	const language = input.scriptLanguage ?? "js";
	if (language === "sh") {
		throw new WorkflowNodeRuntimeError(`workflow script node "${nodeId}" requires a shell runtime adapter`);
	}
	const context = input.context;
	const request: WorkflowScriptEvalRequest = {
		activationId: input.activation.id,
		nodeId,
		code: context === undefined ? code : workflowEvalScriptWithContext(code, context),
		language,
		title: input.scriptPath ?? nodeId,
	};
	if (input.timeoutMs !== undefined) {
		request.timeoutMs = input.timeoutMs;
	}
	if (input.resourceDir !== undefined) {
		request.resourceDir = input.resourceDir;
	}
	if (input.signal !== undefined) {
		request.signal = input.signal;
	}
	if (context !== undefined) {
		request.context = context;
	}
	return options.runEvalScript(request);
}

function workflowEvalScriptWithContext(code: string, context: WorkflowScriptContext): string {
	const serialized = JSON.stringify(context).replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
	const contextLines = [
		`const workflowContext = Object.freeze(${serialized});`,
		`const OMP_WORKFLOW_CONTEXT = workflowContext;`,
	];
	if (!workflowEvalScriptUsesTopLevelReturn(code)) {
		return [...contextLines, code].join("\n");
	}
	return [
		...contextLines,
		"const __workflowResult = await (async () => {",
		code,
		"})();",
		"if (__workflowResult !== undefined) console.log(JSON.stringify(__workflowResult));",
	].join("\n");
}

function workflowEvalScriptUsesTopLevelReturn(code: string): boolean {
	return /^\s*return\b/mu.test(code);
}

async function runShellWorkflowScript(
	nodeId: string,
	code: string,
	input: {
		activation: { id: string };
		scriptPath?: string;
		timeoutMs?: number;
		resourceDir?: string;
		signal?: AbortSignal;
		context?: WorkflowScriptContext;
	},
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
	if (input.timeoutMs !== undefined) {
		request.timeoutMs = input.timeoutMs;
	}
	if (input.resourceDir !== undefined) {
		request.resourceDir = input.resourceDir;
	}
	if (input.signal !== undefined) {
		request.signal = input.signal;
	}
	if (input.context !== undefined) {
		request.context = input.context;
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

interface StructuredActivationOutputOptions {
	allowObjectSummaryFallback?: boolean;
}

function parseStructuredActivationOutput(
	output: string,
	options: StructuredActivationOutputOptions = {},
): WorkflowActivationOutput | undefined {
	const trimmed = output.trim();
	const parsed = parseJsonObject(trimmed) ?? parseLastJsonObjectLine(trimmed);
	if (!parsed || !hasActivationOutputField(parsed)) return undefined;
	if (options.allowObjectSummaryFallback && isObjectSummaryOnly(parsed)) return undefined;
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

function isObjectSummaryOnly(value: Record<string, unknown>): boolean {
	return (
		value.summary !== undefined &&
		typeof value.summary === "object" &&
		value.summary !== null &&
		!Array.isArray(value.summary) &&
		value.data === undefined &&
		value.statePatch === undefined &&
		value.artifacts === undefined
	);
}

function activationOutputFromTaskResult(nodeId: string, result: WorkflowAgentTaskResult): WorkflowActivationOutput {
	if (result.exitCode !== 0) {
		const reason = result.error || result.stderr || `exit code ${result.exitCode}`;
		throw new WorkflowNodeRuntimeError(`workflow agent node "${nodeId}" failed: ${reason}`);
	}
	const artifacts = taskResultArtifactReferences(result);
	if (result.data !== undefined) {
		const summarySource =
			typeof result.data.summary === "string" && result.data.summary.trim().length > 0
				? result.data.summary
				: result.output;
		const boundedSummary = boundWorkflowSummary(summarySource, `agent node "${nodeId}" completed`);
		const data = { ...result.data };
		applyTaskIsolationResultData(data, result);
		return mergeActivationArtifacts(
			{
				summary: boundedSummary.summary,
				data,
			},
			artifacts,
		);
	}
	const structured = parseStructuredActivationOutput(result.output, { allowObjectSummaryFallback: true });
	if (structured) {
		return mergeActivationArtifacts(structured, artifacts);
	}
	const boundedSummary = boundWorkflowSummary(result.output, `agent node "${nodeId}" completed`);
	const data: Record<string, unknown> = { exitCode: result.exitCode };
	if (boundedSummary.truncated) {
		data.summaryTruncated = true;
		data.summaryBytes = boundedSummary.originalBytes;
	}
	applyTaskIsolationResultData(data, result);
	const output: WorkflowActivationOutput = {
		summary: boundedSummary.summary,
		data,
	};
	if (artifacts.length > 0) {
		output.artifacts = artifacts;
	}
	return output;
}

function applyTaskIsolationResultData(data: Record<string, unknown>, result: WorkflowAgentTaskResult): void {
	if (result.agentId !== undefined) data.agentId = result.agentId;
	if (result.outputPath !== undefined) data.outputPath = result.outputPath;
	if (result.sessionFile !== undefined) data.sessionFile = result.sessionFile;
	if (result.patchPath !== undefined) data.patchPath = result.patchPath;
	if (result.branchName !== undefined) data.branchName = result.branchName;
	if (result.changesApplied !== undefined) data.changesApplied = result.changesApplied;
}

function activationOutputFromHumanInputResult(result: WorkflowHumanInputResult): WorkflowActivationOutput {
	const data: Record<string, unknown> = {
		response: result.response,
	};
	if (result.question !== undefined) data.question = result.question;
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
	const boundedSummary = boundWorkflowSummary(parsed.summary, parsed.verdict);
	const output: WorkflowReviewNodeOutput = {
		summary: boundedSummary.summary,
		verdict: parsed.verdict,
	};
	const artifacts = taskResultArtifactReferences(result);
	if (artifacts.length > 0) {
		output.artifacts = artifacts;
	}
	return output;
}

function taskResultArtifactReferences(result: WorkflowAgentTaskResult): string[] {
	const artifacts: string[] = [];
	if (result.agentId !== undefined) artifacts.push(`agent-output://${result.agentId}`);
	if (result.outputPath !== undefined) artifacts.push(result.outputPath);
	if (result.sessionFile !== undefined) artifacts.push(result.sessionFile);
	return artifacts;
}

function mergeActivationArtifacts(
	output: WorkflowActivationOutput,
	additionalArtifacts: readonly string[],
): WorkflowActivationOutput {
	if (additionalArtifacts.length === 0) return output;
	const artifacts = output.artifacts === undefined ? [] : [...output.artifacts];
	for (const artifact of additionalArtifacts) {
		if (!artifacts.includes(artifact)) artifacts.push(artifact);
	}
	return { ...output, artifacts };
}

interface BoundedWorkflowSummary {
	summary: string;
	truncated: boolean;
	originalBytes: number;
}

function boundWorkflowSummary(source: string, fallback: string): BoundedWorkflowSummary {
	const summary = source.trim() || fallback;
	const bytes = textBytes(summary);
	if (bytes.length <= DEFAULT_WORKFLOW_MAX_SUMMARY_BYTES) {
		return { summary, truncated: false, originalBytes: bytes.length };
	}
	const suffixBytes = textBytes(WORKFLOW_SUMMARY_TRUNCATION_SUFFIX);
	const budget = Math.max(0, DEFAULT_WORKFLOW_MAX_SUMMARY_BYTES - suffixBytes.length);
	let prefix = new TextDecoder().decode(bytes.slice(0, budget));
	let bounded = `${prefix}${WORKFLOW_SUMMARY_TRUNCATION_SUFFIX}`;
	while (textBytes(bounded).length > DEFAULT_WORKFLOW_MAX_SUMMARY_BYTES && prefix.length > 0) {
		prefix = prefix.slice(0, -1);
		bounded = `${prefix}${WORKFLOW_SUMMARY_TRUNCATION_SUFFIX}`;
	}
	return { summary: bounded, truncated: true, originalBytes: bytes.length };
}

function textBytes(value: string): Uint8Array {
	return new TextEncoder().encode(value);
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
	const correctness = reviewerCorrectnessFromText(trimmed);
	if (correctness !== undefined) {
		return {
			verdict: verdictFromReviewerCorrectness(correctness, gates, fallbackVerdict),
			summary: trimmed,
		};
	}
	const trimmedGate = declaredGateFor(trimmed, gates);
	if (trimmedGate !== undefined) {
		return { verdict: trimmedGate, summary: trimmed };
	}
	const finalLine = lastNonEmptyLine(trimmed);
	if (finalLine && finalLine !== trimmed) {
		const finalJson = parseJsonObject(finalLine);
		if (finalJson) {
			return parseReviewObject(nodeId, finalJson, trimmed, gates, fallbackVerdict);
		}
		const finalLineGate = declaredGateFor(finalLine, gates);
		if (finalLineGate !== undefined) {
			return { verdict: finalLineGate, summary: trimmed };
		}
	}
	const firstLine = firstNonEmptyLine(trimmed);
	const firstLineExactGate = firstLine === undefined ? undefined : declaredGateFor(firstLine, gates);
	if (firstLine && firstLine !== trimmed && firstLine !== finalLine && firstLineExactGate !== undefined) {
		return { verdict: firstLineExactGate, summary: trimmed };
	}
	const firstLineGate = firstLine === undefined ? undefined : gatePrefixFromLine(firstLine, gates);
	if (firstLineGate !== undefined) {
		return { verdict: firstLineGate, summary: trimmed || firstLineGate };
	}
	if (fallbackVerdict !== undefined) {
		return { verdict: fallbackVerdict, summary: trimmed || fallbackVerdict };
	}
	throw new WorkflowNodeRuntimeError(`workflow review node "${nodeId}" must return a verdict`);
}

function gatePrefixFromLine(line: string, gates: string[] | undefined): string | undefined {
	if (!gates?.length) return undefined;
	const normalizedLine = line.toLowerCase();
	const verdictLabelGate = gateAfterVerdictLabel(line, gates);
	if (verdictLabelGate !== undefined) return verdictLabelGate;
	for (const gate of [...gates].sort((left, right) => right.length - left.length)) {
		if (!normalizedLine.startsWith(gate.toLowerCase())) continue;
		const next = line[gate.length];
		if (next === undefined || /[\s:;,.!?-]/u.test(next)) return gate;
	}
	return undefined;
}

function gateAfterVerdictLabel(line: string, gates: string[]): string | undefined {
	const match = /^\s*verdict\s+([^\s:;,.!?-]+)/iu.exec(line);
	const token = match?.[1];
	return token === undefined ? undefined : declaredGateFor(token, gates);
}

function firstNonEmptyLine(output: string): string | undefined {
	const lines = nonEmptyLines(output);
	return lines[0];
}

function lastNonEmptyLine(output: string): string | undefined {
	const lines = nonEmptyLines(output);
	return lines.at(-1);
}

function nonEmptyLines(output: string): string[] {
	return output
		.split(/\r?\n/)
		.map(line => line.trim())
		.filter(line => line.length > 0);
}

function parseReviewObject(
	nodeId: string,
	parsed: Record<string, unknown>,
	fallbackSummary: string,
	gates: string[] | undefined,
	fallbackVerdict: string | undefined,
): { verdict: string; summary: string } {
	const direct = reviewVerdictFromObject(parsed, fallbackSummary);
	const directGate = direct === undefined ? undefined : declaredGateFor(direct.verdict, gates);
	if (direct && (gates === undefined || directGate !== undefined)) {
		return directGate === undefined ? direct : { ...direct, verdict: directGate };
	}

	const nested = nestedReviewVerdictFromObject(parsed, fallbackSummary);
	const nestedGate = nested === undefined ? undefined : declaredGateFor(nested.verdict, gates);
	if (nested && (gates === undefined || nestedGate !== undefined)) {
		return nestedGate === undefined ? nested : { ...nested, verdict: nestedGate };
	}

	const textGate = reviewVerdictFromObjectText(parsed, fallbackSummary, gates);
	if (textGate) return textGate;

	if (direct && gates !== undefined && directGate === undefined && fallbackVerdict === undefined) {
		return direct;
	}
	if (nested && gates !== undefined && nestedGate === undefined && fallbackVerdict === undefined) {
		return nested;
	}

	const correctness = parsed.overall_correctness;
	if (correctness === "correct" || correctness === "incorrect") {
		return {
			verdict: verdictFromReviewerCorrectness(correctness, gates, fallbackVerdict),
			summary: reviewSummaryFromObject(parsed, fallbackSummary),
		};
	}

	if (fallbackVerdict !== undefined) {
		return { verdict: fallbackVerdict, summary: reviewFallbackSummaryFromObject(parsed, fallbackSummary) };
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
	for (const summary of reviewTextCandidatesFromObject(parsed, fallbackSummary)) {
		const finalLine = lastNonEmptyLine(summary);
		const exactFinalLineGate = finalLine === undefined ? undefined : declaredGateFor(finalLine, gates);
		if (exactFinalLineGate !== undefined) {
			return { verdict: exactFinalLineGate, summary };
		}
		const firstLine = firstNonEmptyLine(summary);
		const firstLineGate = firstLine === undefined ? undefined : gatePrefixFromLine(firstLine, gates);
		if (firstLineGate !== undefined) {
			return { verdict: firstLineGate, summary };
		}
		const finalLineGate = finalLine === undefined ? undefined : gateSuffixFromLine(finalLine, gates);
		if (finalLineGate !== undefined) {
			return { verdict: finalLineGate, summary };
		}
	}
	return undefined;
}

function reviewerCorrectnessFromText(output: string): "correct" | "incorrect" | undefined {
	for (const line of nonEmptyLines(output)) {
		const parsed = parseJsonObject(line);
		const correctness = parsed?.overall_correctness;
		if (correctness === "correct" || correctness === "incorrect") return correctness;
		const match = /\boverall_correctness\b\s*[:=]\s*["']?(correct|incorrect)\b/iu.exec(line);
		if (!match) continue;
		const value = match[1]?.toLowerCase();
		if (value === "correct" || value === "incorrect") return value;
	}
	return undefined;
}

function declaredGateFor(verdict: string, gates: string[] | undefined): string | undefined {
	if (!gates?.length) return undefined;
	const exact = gates.find(gate => gate === verdict);
	if (exact !== undefined) return exact;
	const normalized = verdict.toLowerCase();
	return gates.find(gate => gate.toLowerCase() === normalized);
}

function gateSuffixFromLine(line: string, gates: string[] | undefined): string | undefined {
	if (!gates?.length) return undefined;
	let terminal = line.trim();
	while (terminal.length > 0) {
		const last = terminal.at(-1);
		if (last === undefined || !/[\s:;,.!?)}\]"'`]/u.test(last)) break;
		terminal = terminal.slice(0, -1);
	}
	for (const gate of [...gates].sort((left, right) => right.length - left.length)) {
		if (!terminal.toLowerCase().endsWith(gate.toLowerCase())) continue;
		const previous = terminal[terminal.length - gate.length - 1];
		if (previous === undefined || /[\s:;,.!?([{'"`-]/u.test(previous)) return gate;
	}
	return undefined;
}

function reviewSummaryFromObject(parsed: Record<string, unknown>, fallbackSummary: string): string {
	for (const source of [parsed.summary, parsed.explanation]) {
		if (typeof source === "string" && source.length > 0) return source;
	}
	return fallbackSummary;
}

function reviewFallbackSummaryFromObject(parsed: Record<string, unknown>, fallbackSummary: string): string {
	return reviewTextCandidatesFromObject(parsed, fallbackSummary)[0] ?? fallbackSummary;
}

function reviewTextCandidatesFromObject(parsed: Record<string, unknown>, fallbackSummary: string): string[] {
	const candidates: string[] = [];
	for (const source of [parsed.summary, parsed.explanation]) {
		if (typeof source === "string" && source.length > 0) candidates.push(source);
	}
	for (const source of Object.values(parsed)) {
		if (typeof source !== "string" || source.length === 0 || candidates.includes(source)) continue;
		candidates.push(source);
	}
	if (fallbackSummary.length > 0 && !candidates.includes(fallbackSummary)) {
		candidates.push(fallbackSummary);
	}
	return candidates;
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
		const semantic = semanticGateForReviewerCorrectness(correctness, gates);
		if (semantic !== undefined && fallbackVerdict === undefined) return semantic;
	}
	if (fallbackVerdict !== undefined) return fallbackVerdict;
	return correctness === "correct" ? "pass" : "fail";
}

function semanticGateForReviewerCorrectness(correctness: "correct" | "incorrect", gates: string[]): string | undefined {
	const aliases =
		correctness === "correct"
			? ["complete", "completed", "done", "finish", "finished", "accept", "accepted"]
			: ["continue", "retry", "rework", "repair", "reject", "rejected", "fail"];
	for (const alias of aliases) {
		const declared = declaredGateFor(alias, gates);
		if (declared !== undefined) return declared;
	}
	return undefined;
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
