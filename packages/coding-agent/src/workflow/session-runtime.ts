import { extractRetryHint, prompt as promptTemplate } from "@oh-my-pi/pi-utils";
import workflowAgentNodeOutputContractPrompt from "../prompts/system/workflow-agent-node-output-contract.md" with {
	type: "text",
};
import workflowReviewNodeAdapterPrompt from "../prompts/system/workflow-review-node-adapter.md" with { type: "text" };
import { workflowAgentTaskIdForNode } from "./agent-task-id";
import type { WorkflowNode, WorkflowScriptLanguage } from "./definition";
import { formatWorkflowAgentWorkItemLabel } from "./display";
import type { WorkflowNodeRuntimeHost, WorkflowReviewNodeOutput, WorkflowScriptContext } from "./node-runtime";
import { WorkflowNodeRuntimeError } from "./node-runtime";
import {
	createWorkflowObservabilityRecorder,
	recordWorkflowActivationFailureObservability,
	recordWorkflowActivationObservability,
	recordWorkflowActivationStartedObservability,
	type WorkflowObservabilityRecorder,
} from "./observability";
import {
	DEFAULT_WORKFLOW_MAX_SUMMARY_BYTES,
	validateWorkflowActivationOutput,
	type WorkflowActivationOutput,
	type WorkflowActivationRetryHistoryEntry,
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
	timeoutMs?: number;
	isolated?: boolean;
	apply?: boolean;
	merge?: boolean;
	capture?: WorkflowAgentTaskPatchCapture;
	signal?: AbortSignal;
	task: WorkflowAgentTaskItem;
}

export interface WorkflowAgentTaskPatchCapture {
	include?: string[];
	exclude?: string[];
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
	retryHistory?: WorkflowActivationRetryHistoryEntry[];
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
			const assignment = workflowAgentNodeAssignment(
				input.prompt?.trim() || `Run workflow node "${input.node.id}".`,
				input.node.writes,
				input.node.workspaceAccess,
			);
			const task: WorkflowAgentTaskItem = {
				id: workflowAgentTaskIdForNode(input.node.id),
				description: taskLabel,
				role: taskLabel,
				assignment,
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
			if (input.node.timeoutMs !== undefined) {
				request.timeoutMs = input.node.timeoutMs;
			}
			if (input.signal !== undefined) {
				request.signal = input.signal;
			}
			try {
				await recordWorkflowActivationStart(recordObservability, input.node, input.activation.id);
				const result = await runAgentTaskWithTransientRetry(options, request);
				const output = activationOutputFromTaskResult(input.node.id, result);
				await recordWorkflowActivationObservability(recordObservability, input.node, input.activation.id, output);
				return output;
			} catch (error) {
				await recordWorkflowActivationFailure(recordObservability, input.node, input.activation.id, error);
				throw error;
			}
		},
		runScriptNode: async input => {
			try {
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
			} catch (error) {
				await recordWorkflowActivationFailure(recordObservability, input.node, input.activation.id, error);
				throw error;
			}
		},
		runHumanNode: async input => {
			try {
				if (!options.runHumanInput) {
					throw new WorkflowNodeRuntimeError(
						`workflow human node "${input.node.id}" requires a human input adapter`,
					);
				}
				const question = input.prompt?.trim();
				if (!question) {
					throw new WorkflowNodeRuntimeError(
						`workflow human node "${input.node.id}" must define a question prompt`,
					);
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
			} catch (error) {
				await recordWorkflowActivationFailure(recordObservability, input.node, input.activation.id, error);
				throw error;
			}
		},
		runReviewNode: async input => {
			try {
				if (!options.runAgentTask) {
					throw new WorkflowNodeRuntimeError(
						`workflow review node "${input.node.id}" requires a review runtime adapter`,
					);
				}
				const assignment = input.prompt?.trim();
				if (!assignment) {
					throw new WorkflowNodeRuntimeError(
						`workflow review node "${input.node.id}" must define a review prompt`,
					);
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
						assignment: workflowReviewNodeAssignment(assignment, input.gates, input.fallbackVerdict),
					},
				};
				applyWorkflowNodeIsolation(request, input.node);
				if (input.modelOverride !== undefined) {
					request.modelOverride = input.modelOverride;
					request.modelOverrideAuthFallback = false;
				}
				if (input.node.timeoutMs !== undefined) {
					request.timeoutMs = input.node.timeoutMs;
				}
				if (input.signal !== undefined) {
					request.signal = input.signal;
				}
				await recordWorkflowActivationStart(recordObservability, input.node, input.activation.id);
				const result = await runAgentTaskWithTransientRetry(options, request, workflowReviewTaskReasonIsRetryable);
				const output = reviewOutputFromTaskResult(input.node.id, result, input.gates, input.fallbackVerdict);
				await recordWorkflowActivationObservability(recordObservability, input.node, input.activation.id, output);
				return output;
			} catch (error) {
				await recordWorkflowActivationFailure(recordObservability, input.node, input.activation.id, error);
				throw error;
			}
		},
	};
}

async function recordWorkflowActivationStart(
	record: WorkflowObservabilityRecorder,
	node: WorkflowNode,
	activationId: string,
): Promise<void> {
	try {
		await recordWorkflowActivationStartedObservability(record, node, activationId);
	} catch {
		// Start observability must never mask the workflow node's own execution.
	}
}

async function recordWorkflowActivationFailure(
	record: WorkflowObservabilityRecorder,
	node: WorkflowNode,
	activationId: string,
	error: unknown,
): Promise<void> {
	try {
		await recordWorkflowActivationFailureObservability(record, node, activationId, error);
	} catch {
		// Failure observability must never mask the workflow node's original error.
	}
}

function workflowReviewNodeAssignment(
	assignment: string,
	gates: readonly string[] | undefined,
	fallbackVerdict: string | undefined,
): string {
	return promptTemplate.render(workflowReviewNodeAdapterPrompt, {
		assignment,
		declaredGates: gates === undefined || gates.length === 0 ? "(none)" : gates.join(", "),
		fallbackVerdict: fallbackVerdict ?? "(none)",
	});
}

function workflowAgentNodeAssignment(
	assignment: string,
	writes: readonly string[] | undefined,
	workspaceAccess: WorkflowNode["workspaceAccess"],
): string {
	if (writes === undefined || writes.length === 0) return assignment;
	return promptTemplate.render(workflowAgentNodeOutputContractPrompt, {
		assignment,
		declaredWrites: writes.join(", "),
		readOnlyWorkspace: workspaceAccess === "read",
		workspaceAccess: workspaceAccess ?? "unspecified",
	});
}

function applyWorkflowNodeIsolation(
	request: WorkflowAgentTaskRequest,
	node: {
		isolation?: { enabled: boolean; apply?: boolean; merge?: boolean; capture?: WorkflowAgentTaskPatchCapture };
	},
): void {
	const isolation = node.isolation;
	if (isolation === undefined || isolation.enabled !== true) return;
	request.isolated = true;
	if (isolation.apply !== undefined) request.apply = isolation.apply;
	if (isolation.merge !== undefined) request.merge = isolation.merge;
	if (isolation.capture !== undefined) request.capture = isolation.capture;
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
	retryDispositionForReason: WorkflowAgentTaskRetryDispositionFactory = workflowAgentTaskRetryDispositionForReason,
): Promise<WorkflowAgentTaskResult> {
	if (options.runAgentTask === undefined) {
		throw new WorkflowNodeRuntimeError(`workflow agent node "${request.nodeId}" requires a subagent runtime adapter`);
	}
	const policy = normalizeWorkflowAgentTaskRetryPolicy(options.agentTaskRetryPolicy);
	let lastTransientResult: WorkflowAgentTaskResult | undefined;
	const retryHistory: WorkflowActivationRetryHistoryEntry[] = [];
	for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
		throwIfWorkflowSignalAborted(request.signal);
		let transientReason: string;
		let retryDisposition: WorkflowAgentTaskRetryDisposition;
		try {
			const result = await options.runAgentTask(request);
			transientReason = workflowAgentTaskFailureReason(result);
			retryDisposition = retryDispositionForReason(transientReason, policy);
			if (result.exitCode === 0 || !retryDisposition.retryable) {
				return attachWorkflowAgentTaskRetryHistory(result, retryHistory);
			}
			lastTransientResult = result;
			if (attempt >= retryDisposition.maxAttempts) return attachWorkflowAgentTaskRetryHistory(result, retryHistory);
		} catch (error) {
			if (workflowErrorWasAborted(error)) throw error;
			transientReason = formatWorkflowErrorReason(error);
			retryDisposition = retryDispositionForReason(transientReason, policy);
			if (!retryDisposition.retryable || attempt >= retryDisposition.maxAttempts) throw error;
		}
		const retryEntry = workflowAgentTaskRetryHistoryEntry(
			policy,
			attempt,
			transientReason,
			options.retryRandom ?? Math.random,
			retryDisposition,
		);
		retryHistory.push(retryEntry);
		await sleepBeforeWorkflowAgentTaskRetry(options, request.signal, retryEntry.delayMs);
	}
	if (lastTransientResult !== undefined) return attachWorkflowAgentTaskRetryHistory(lastTransientResult, retryHistory);
	return attachWorkflowAgentTaskRetryHistory(
		{
			exitCode: 1,
			output: "",
			error: `workflow agent task "${request.nodeId}" exhausted transient retry attempts`,
		},
		retryHistory,
	);
}

interface WorkflowAgentTaskRetryDisposition {
	retryable: boolean;
	maxAttempts: number;
	delayMs?: number;
}

type WorkflowAgentTaskRetryDispositionFactory = (
	reason: string,
	policy: NormalizedWorkflowAgentTaskRetryPolicy,
) => WorkflowAgentTaskRetryDisposition;

function attachWorkflowAgentTaskRetryHistory(
	result: WorkflowAgentTaskResult,
	retryHistory: readonly WorkflowActivationRetryHistoryEntry[],
): WorkflowAgentTaskResult {
	if (retryHistory.length === 0) return result;
	return { ...result, retryHistory: retryHistory.map(entry => ({ ...entry })) };
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

function workflowAgentTaskRetryDispositionForReason(
	reason: string,
	policy: NormalizedWorkflowAgentTaskRetryPolicy,
): WorkflowAgentTaskRetryDisposition {
	return {
		retryable: workflowAgentTaskReasonIsTransient(reason),
		maxAttempts: policy.maxAttempts,
	};
}

function workflowAgentTaskReasonIsTransient(reason: string): boolean {
	return WORKFLOW_AGENT_TRANSIENT_PROVIDER_ERROR_PATTERN.test(reason);
}

function workflowReviewTaskReasonIsRetryable(
	reason: string,
	policy: NormalizedWorkflowAgentTaskRetryPolicy,
): WorkflowAgentTaskRetryDisposition {
	if (workflowReviewTaskReasonIsSchemaContractFailure(reason)) {
		return {
			retryable: true,
			maxAttempts: Math.min(policy.maxAttempts, 2),
			delayMs: 0,
		};
	}
	return workflowAgentTaskRetryDispositionForReason(reason, policy);
}

function workflowReviewTaskReasonIsSchemaContractFailure(reason: string): boolean {
	return /\bschema_violation\b/iu.test(reason);
}

const WORKFLOW_AGENT_TRANSIENT_PROVIDER_ERROR_PATTERN =
	/(?:\b429\b|too many requests|rate[_ -]?limit|temporar(?:y|ily) unavailable|overloaded|service unavailable|bad gateway|gateway timeout|upstream[^.\n]*(?:unavailable|timeout|rate limit)|\b5\d\d\b|HTTP\/2[^.\n]*(?:error|not closed cleanly)|\bINTERNAL_ERROR\b|stream[_ -]read[_ -]error|stream[_ -]interrupted(?:[_ -]after[_ -]content)?|ECONNRESET|ETIMEDOUT|EAI_AGAIN)/iu;

function formatWorkflowErrorReason(error: unknown): string {
	if (error instanceof Error) return `${error.name}: ${error.message}`;
	return String(error);
}

function workflowAgentTaskRetryHistoryEntry(
	policy: NormalizedWorkflowAgentTaskRetryPolicy,
	completedAttempt: number,
	transientReason: string,
	random: WorkflowRetryRandomSource,
	disposition: WorkflowAgentTaskRetryDisposition,
): WorkflowActivationRetryHistoryEntry {
	const delayMs =
		disposition.delayMs ?? workflowAgentTaskRetryDelayMs(policy, completedAttempt, transientReason, random);
	return {
		attempt: completedAttempt,
		maxAttempts: disposition.maxAttempts,
		reason: boundWorkflowRetryReason(transientReason),
		nextAttempt: completedAttempt + 1,
		delayMs,
	};
}

function boundWorkflowRetryReason(reason: string): string {
	const compact = reason.replace(/\s+/gu, " ").trim();
	if (compact.length <= 1_000) return compact;
	return `${compact.slice(0, 997).trimEnd()}...`;
}

async function sleepBeforeWorkflowAgentTaskRetry(
	options: WorkflowSessionRuntimeOptions,
	signal: AbortSignal | undefined,
	delayMs: number,
): Promise<void> {
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
	if (!parsed) return undefined;
	const yielded = activationOutputFromYieldEnvelope(parsed);
	if (yielded !== undefined) return yielded;
	if (!hasActivationOutputField(parsed)) return undefined;
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
		throw new WorkflowNodeRuntimeError(`workflow agent node "${nodeId}" failed: ${reason}`, {
			artifacts: taskResultArtifactReferences(result),
		});
	}
	const artifacts = taskResultArtifactReferences(result);
	if (result.data !== undefined) {
		const yieldedActivationOutput = activationOutputFromYieldData(result.data);
		if (yieldedActivationOutput !== undefined) {
			return mergeActivationArtifacts(applyTaskResultMetadata(yieldedActivationOutput, result), artifacts);
		}
		const summarySource =
			typeof result.data.summary === "string" && result.data.summary.trim().length > 0
				? result.data.summary
				: result.output;
		const boundedSummary = boundWorkflowSummary(summarySource, `agent node "${nodeId}" completed`);
		const data = { ...result.data };
		applyTaskResultData(data, result);
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
		return mergeActivationArtifacts(applyTaskResultMetadata(structured, result), artifacts);
	}
	const boundedSummary = boundWorkflowSummary(result.output, `agent node "${nodeId}" completed`);
	const data: Record<string, unknown> = { exitCode: result.exitCode };
	if (boundedSummary.truncated) {
		data.summaryTruncated = true;
		data.summaryBytes = boundedSummary.originalBytes;
	}
	applyTaskResultData(data, result);
	const output: WorkflowActivationOutput = {
		summary: boundedSummary.summary,
		data,
	};
	if (artifacts.length > 0) {
		output.artifacts = artifacts;
	}
	return output;
}

function activationOutputFromYieldData(data: Record<string, unknown>): WorkflowActivationOutput | undefined {
	if (data.statePatch === undefined && data.artifacts === undefined && data.data === undefined) return undefined;
	return validateWorkflowActivationOutput(data);
}

function activationOutputFromYieldEnvelope(data: Record<string, unknown>): WorkflowActivationOutput | undefined {
	const result = workflowRecord(data.result);
	if (result === undefined) return undefined;
	const yieldedData = workflowRecord(result.data);
	if (yieldedData === undefined) return undefined;
	return activationOutputFromYieldData(yieldedData);
}

function workflowRecord(data: unknown): Record<string, unknown> | undefined {
	if (data === null || typeof data !== "object" || Array.isArray(data)) return undefined;
	return data as Record<string, unknown>;
}

function applyTaskResultMetadata(
	output: WorkflowActivationOutput,
	result: WorkflowAgentTaskResult,
): WorkflowActivationOutput {
	const statePatch = applyTaskResultStatePatchMetadata(output.statePatch, result);
	const data = output.data === undefined ? {} : { ...output.data };
	applyTaskResultData(data, result);
	if (Object.keys(data).length === 0 && statePatch === output.statePatch) return output;
	const nextOutput: WorkflowActivationOutput = { ...output };
	if (Object.keys(data).length > 0) nextOutput.data = data;
	if (statePatch !== output.statePatch) nextOutput.statePatch = statePatch;
	return nextOutput;
}

function applyTaskResultData(data: Record<string, unknown>, result: WorkflowAgentTaskResult): void {
	if (result.agentId !== undefined) data.agentId = result.agentId;
	if (result.outputPath !== undefined) data.outputPath = result.outputPath;
	if (result.sessionFile !== undefined) data.sessionFile = result.sessionFile;
	if (result.patchPath !== undefined) data.patchPath = result.patchPath;
	if (result.branchName !== undefined) data.branchName = result.branchName;
	if (result.changesApplied !== undefined) data.changesApplied = result.changesApplied;
	if (result.retryHistory !== undefined && result.retryHistory.length > 0) {
		data.retryHistory = result.retryHistory.map(entry => ({ ...entry }));
	}
}

function applyTaskResultStatePatchMetadata(
	statePatch: WorkflowActivationOutput["statePatch"],
	result: WorkflowAgentTaskResult,
): WorkflowActivationOutput["statePatch"] {
	const metadata = taskResultStateMetadata(result);
	if (metadata === undefined || statePatch === undefined) return statePatch;
	let changed = false;
	const patched = statePatch.map(operation => {
		if (!isPlainRecord(operation.value)) return operation;
		const nextValue = { ...operation.value };
		let operationChanged = false;
		for (const [key, value] of Object.entries(metadata)) {
			if (nextValue[key] === undefined) {
				nextValue[key] = value;
				operationChanged = true;
				continue;
			}
			if (key === "patchPath" && nextValue[key] !== value && nextValue.capturedPatchPath === undefined) {
				nextValue.capturedPatchPath = value;
				operationChanged = true;
			}
		}
		if (!operationChanged) return operation;
		changed = true;
		return { ...operation, value: nextValue };
	});
	return changed ? patched : statePatch;
}

function taskResultStateMetadata(result: WorkflowAgentTaskResult): Record<string, unknown> | undefined {
	const metadata: Record<string, unknown> = {};
	if (result.patchPath !== undefined) metadata.patchPath = result.patchPath;
	if (result.branchName !== undefined) metadata.branchName = result.branchName;
	if (result.changesApplied !== undefined) metadata.changesApplied = result.changesApplied;
	return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
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
		const recovered = recoverReviewOutputFromSchemaViolation(nodeId, result, gates, fallbackVerdict);
		if (recovered !== undefined) return recovered;
		const reason = result.error || result.stderr || `exit code ${result.exitCode}`;
		throw new WorkflowNodeRuntimeError(`workflow review node "${nodeId}" failed: ${reason}`, {
			artifacts: taskResultArtifactReferences(result),
		});
	}
	const parsed = parseReviewTaskOutput(nodeId, result.output, gates, fallbackVerdict);
	const boundedSummary = boundWorkflowSummary(parsed.summary, parsed.verdict);
	const output: WorkflowReviewNodeOutput = {
		summary: boundedSummary.summary,
		verdict: parsed.verdict,
	};
	if (result.retryHistory !== undefined && result.retryHistory.length > 0) {
		output.retryHistory = result.retryHistory.map(entry => ({ ...entry }));
	}
	const artifacts = taskResultArtifactReferences(result);
	if (artifacts.length > 0) {
		output.artifacts = artifacts;
	}
	return output;
}

function recoverReviewOutputFromSchemaViolation(
	nodeId: string,
	result: WorkflowAgentTaskResult,
	gates: string[] | undefined,
	fallbackVerdict: string | undefined,
): WorkflowReviewNodeOutput | undefined {
	const recoverySource = schemaViolationReviewRecoverySource(result, gates);
	if (recoverySource === undefined) return undefined;

	let parsed: { verdict: string; summary: string };
	try {
		parsed = parseReviewTaskOutput(nodeId, recoverySource, gates, fallbackVerdict);
	} catch {
		return undefined;
	}

	const reason = result.error || result.stderr || "schema_violation";
	const summary = `recovered schema_violation as verdict ${parsed.verdict}: ${reason}\n${parsed.summary}`;
	const boundedSummary = boundWorkflowSummary(summary, parsed.verdict);
	const output: WorkflowReviewNodeOutput = {
		summary: boundedSummary.summary,
		verdict: parsed.verdict,
	};
	if (result.retryHistory !== undefined && result.retryHistory.length > 0) {
		output.retryHistory = result.retryHistory.map(entry => ({ ...entry }));
	}
	const artifacts = taskResultArtifactReferences(result);
	if (artifacts.length > 0) {
		output.artifacts = artifacts;
	}
	return output;
}

function schemaViolationReviewRecoverySource(
	result: WorkflowAgentTaskResult,
	gates: string[] | undefined,
): string | undefined {
	const payload = parseJsonObject(result.output.trim());
	const isSchemaViolation =
		payload?.error === "schema_violation" || /\bschema_violation\b/iu.test(result.stderr ?? result.error ?? "");
	if (!isSchemaViolation || payload === undefined) return undefined;

	const data = schemaViolationData(payload.data);
	if (data === undefined) return undefined;
	const findingsRecovery = reviewFindingsRecoverySource(data, gates);
	if (findingsRecovery !== undefined) return findingsRecovery;
	if (!reviewRecoveryDataHasSignal(data, gates)) return undefined;
	if (typeof data === "string") return data;
	try {
		return JSON.stringify(data);
	} catch {
		return undefined;
	}
}

function schemaViolationData(data: unknown): unknown {
	if (typeof data !== "string") return data;
	const trimmed = data.trim();
	if (!trimmed) return undefined;
	const parsed = parseJsonObject(trimmed);
	return parsed ?? trimmed;
}

function reviewRecoveryDataHasSignal(data: unknown, gates: string[] | undefined): boolean {
	if (typeof data === "string") {
		const parsed = parseJsonObject(data.trim());
		if (parsed !== undefined) return reviewRecoveryDataHasSignal(parsed, gates);
		return reviewerCorrectnessFromText(data) !== undefined || reviewTextHasDeclaredGate(data, gates);
	}
	if (data === null || typeof data !== "object" || Array.isArray(data)) return false;
	const record = data as Record<string, unknown>;
	if (reviewRecoveryDataHasSignal(record.result, gates)) return true;
	if (reviewRecoveryDataHasSignal(record.data, gates)) return true;
	if (record.overall_correctness === "correct" || record.overall_correctness === "incorrect") return true;
	if (
		typeof record.overall_correctness === "string" &&
		declaredGateFor(record.overall_correctness, gates) !== undefined
	) {
		return true;
	}
	if (
		typeof record.verdict === "string" &&
		(gates === undefined || declaredGateFor(record.verdict, gates) !== undefined)
	) {
		return true;
	}
	for (const source of [record.summary, record.explanation]) {
		if (typeof source === "string" && reviewTextHasDeclaredGate(source, gates)) return true;
	}
	return false;
}

function reviewFindingsRecoverySource(data: unknown, gates: string[] | undefined): string | undefined {
	const record = schemaViolationRecord(data);
	const resultRecord = schemaViolationRecord(record?.result);
	const resultDataRecord = schemaViolationRecord(resultRecord?.data);
	const dataRecord = schemaViolationRecord(record?.data);
	const findings = record?.findings ?? resultRecord?.findings ?? resultDataRecord?.findings ?? dataRecord?.findings;
	if (!Array.isArray(findings) || findings.length === 0) return undefined;
	const summary = reviewFindingsSummary(findings);
	if (summary === undefined) return undefined;
	const repairGate = verdictFromReviewerCorrectness("incorrect", gates, undefined);
	return JSON.stringify({
		overall_correctness: "incorrect",
		explanation: `verdict ${repairGate}\n${summary}`,
		confidence: reviewFindingsConfidence(findings),
	});
}

function schemaViolationRecord(data: unknown): Record<string, unknown> | undefined {
	if (typeof data === "string") {
		const parsed = parseJsonObject(data.trim());
		return parsed ?? undefined;
	}
	if (data === null || typeof data !== "object" || Array.isArray(data)) return undefined;
	return data as Record<string, unknown>;
}

function reviewFindingsSummary(findings: unknown[]): string | undefined {
	const lines: string[] = [];
	for (const finding of findings.slice(0, 3)) {
		const line = reviewFindingLine(finding);
		if (line !== undefined) lines.push(line);
	}
	if (lines.length === 0) return undefined;
	const suffix =
		findings.length > lines.length ? `\n- ${findings.length - lines.length} additional finding(s) omitted` : "";
	return `Reviewer reported ${findings.length} finding(s):\n${lines.join("\n")}${suffix}`;
}

function reviewFindingLine(finding: unknown): string | undefined {
	if (typeof finding === "string") return `- ${finding}`;
	if (finding === null || typeof finding !== "object" || Array.isArray(finding)) return undefined;
	const record = finding as Record<string, unknown>;
	const title = typeof record.title === "string" ? record.title.trim() : "";
	const body = typeof record.body === "string" ? record.body.trim() : "";
	const priority =
		typeof record.priority === "number" && Number.isFinite(record.priority) ? `P${record.priority}: ` : "";
	const content = [title, body].filter(part => part.length > 0).join(" - ");
	return content.length > 0 ? `- ${priority}${content}` : undefined;
}

function reviewFindingsConfidence(findings: unknown[]): number {
	for (const finding of findings) {
		if (finding === null || typeof finding !== "object" || Array.isArray(finding)) continue;
		const confidence = (finding as Record<string, unknown>).confidence;
		if (typeof confidence === "number" && Number.isFinite(confidence)) return Math.max(0, Math.min(1, confidence));
	}
	return 0.8;
}

function reviewTextHasDeclaredGate(text: string, gates: string[] | undefined): boolean {
	if (!gates?.length) return false;
	for (const line of nonEmptyLines(text)) {
		if (declaredGateFor(line, gates) !== undefined) return true;
		if (gatePrefixFromLine(line, gates) !== undefined) return true;
		if (gateSuffixFromLine(line, gates) !== undefined) return true;
	}
	return false;
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
	const resultObject = reviewResultObject(parsed);
	if (resultObject !== undefined) {
		const nestedResult = tryParseReviewObject(
			nodeId,
			resultObject,
			reviewSummaryFromObject(resultObject, fallbackSummary),
			gates,
			fallbackVerdict,
		);
		if (nestedResult !== undefined) return nestedResult;
	}

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

function tryParseReviewObject(
	nodeId: string,
	parsed: Record<string, unknown>,
	fallbackSummary: string,
	gates: string[] | undefined,
	fallbackVerdict: string | undefined,
): { verdict: string; summary: string } | undefined {
	try {
		return parseReviewObject(nodeId, parsed, fallbackSummary, gates, fallbackVerdict);
	} catch {
		return undefined;
	}
}

function reviewResultObject(parsed: Record<string, unknown>): Record<string, unknown> | undefined {
	const result = schemaViolationRecord(parsed.result);
	if (result !== undefined) return schemaViolationRecord(result.data) ?? result;
	return schemaViolationRecord(parsed.data);
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
		for (const candidate of candidates) {
			const declared = declaredGateFor(candidate, gates);
			if (declared !== undefined) return declared;
		}
		const semantic = semanticGateForReviewerCorrectness(correctness, gates);
		if (semantic !== undefined) return semantic;
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
