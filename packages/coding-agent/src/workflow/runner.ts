import * as path from "node:path";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import type { CanonicalModelRegistry, ModelMatchPreferences } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import type { WorkflowDefinition, WorkflowNode } from "./definition";
import { resolveWorkflowNodeModel, type WorkflowModelResolutionAudit } from "./model-resolution";
import { executeWorkflowNode, type WorkflowNodeRuntimeHost } from "./node-runtime";
import {
	resolveWorkflowPrompt,
	type WorkflowActivationInputSnapshot,
	type WorkflowResolvedPrompt,
} from "./prompt-source";
import {
	appendWorkflowActivationCompleted,
	appendWorkflowActivationFailed,
	appendWorkflowActivationStarted,
	appendWorkflowStatePatch,
	startWorkflowRun,
	type WorkflowRunSnapshot,
	type WorkflowRunStoreHost,
} from "./run-store";
import {
	runWorkflowScheduler,
	type WorkflowActivation,
	type WorkflowSchedulerExecutionContext,
	type WorkflowSchedulerResult,
} from "./scheduler";
import { validateWorkflowActivationOutput, type WorkflowActivationOutput } from "./state";

export interface WorkflowRunnerModelResolutionOptions {
	availableModels: Model<Api>[];
	settings?: Settings;
	matchPreferences?: ModelMatchPreferences;
	modelRegistry?: CanonicalModelRegistry;
	parentActiveModelPattern?: string;
	agentModels?: Record<string, string | string[]>;
}

export interface WorkflowRunnerOptions {
	host: WorkflowRunStoreHost;
	definition: WorkflowDefinition;
	runId: string;
	graphRevisionId?: string;
	startNodeId: string;
	runtimeHost: WorkflowNodeRuntimeHost;
	modelResolution?: WorkflowRunnerModelResolutionOptions;
	maxActivations?: number;
	maxNodeActivations?: number;
	signal?: AbortSignal;
	packageRoot?: string;
	maxPromptBytes?: number;
}

export interface WorkflowRunnerResult {
	run: WorkflowRunSnapshot;
	scheduler: WorkflowSchedulerResult;
}

export class WorkflowRunnerError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WorkflowRunnerError";
	}
}

export async function runWorkflow(options: WorkflowRunnerOptions): Promise<WorkflowRunnerResult> {
	const run = startWorkflowRun(options.host, options.definition, {
		runId: options.runId,
		graphRevisionId: options.graphRevisionId,
	});
	const scheduler = await runWorkflowScheduler(options.definition, {
		startNodeId: options.startNodeId,
		maxActivations: options.maxActivations,
		maxNodeActivations: options.maxNodeActivations,
		signal: options.signal,
		getCurrentDefinition: () => run.definition,
		getCurrentGraphRevisionId: () => run.currentGraphRevisionId,
		executeNode: async (activation, node, context) =>
			executeAndPersistActivation(options, run, activation, node, context),
	});
	return { run, scheduler };
}

async function executeAndPersistActivation(
	options: WorkflowRunnerOptions,
	run: WorkflowRunSnapshot,
	activation: WorkflowActivation,
	node: WorkflowNode,
	context: WorkflowSchedulerExecutionContext,
): Promise<WorkflowActivationOutput> {
	let started = false;
	try {
		const resolvedPrompt = await resolvePromptForActivation(options, activation, node, context);
		const input = inputSnapshotFromPrompt(resolvedPrompt);
		appendWorkflowActivationStarted(options.host, run.id, {
			activationId: activation.id,
			nodeId: node.id,
			graphRevisionId: activation.graphRevisionId,
			parentActivationIds: activation.parentActivationIds,
			input,
		});
		started = true;
		const promptedNode = resolvedPrompt ? { ...node, prompt: resolvedPrompt.value } : node;
		const nodeForExecution = await resolveScriptForExecution(options, promptedNode);
		const modelAudit = nodeRequiresModel(node) ? resolveModelAudit(options, node) : undefined;
		if (modelAudit?.error && nodeRequiresModel(node)) {
			throw new WorkflowRunnerError(modelAudit.error);
		}
		const output = validateWorkflowActivationOutput(
			await executeWorkflowNode(nodeForExecution, activation, options.runtimeHost),
			{
				allowedWritePaths: node.writes,
			},
		);
		if (output.statePatch) {
			appendWorkflowStatePatch(options.host, run.id, {
				patch: output.statePatch,
				reason: `activation ${activation.id}`,
			});
		}
		appendWorkflowActivationCompleted(options.host, run.id, {
			activationId: activation.id,
			output,
			modelAudit,
		});
		return output;
	} catch (error) {
		if (!started) {
			appendWorkflowActivationStarted(options.host, run.id, {
				activationId: activation.id,
				nodeId: node.id,
				graphRevisionId: activation.graphRevisionId,
				parentActivationIds: activation.parentActivationIds,
			});
		}
		appendWorkflowActivationFailed(options.host, run.id, {
			activationId: activation.id,
			error: error instanceof Error ? error.message : String(error),
		});
		throw error;
	}
}

async function resolvePromptForActivation(
	options: WorkflowRunnerOptions,
	activation: WorkflowActivation,
	node: WorkflowNode,
	context: WorkflowSchedulerExecutionContext,
): Promise<WorkflowResolvedPrompt | undefined> {
	if (!nodeConsumesPrompt(node)) return undefined;
	return resolveWorkflowPrompt(node, {
		state: context.state,
		completedActivations: context.completedActivations,
		parentActivationIds: activation.parentActivationIds,
		packageRoot: options.packageRoot,
		maxPromptBytes: options.maxPromptBytes,
	});
}

function inputSnapshotFromPrompt(
	resolvedPrompt: WorkflowResolvedPrompt | undefined,
): WorkflowActivationInputSnapshot | undefined {
	return resolvedPrompt ? { prompt: resolvedPrompt } : undefined;
}

function resolveModelAudit(
	options: WorkflowRunnerOptions,
	node: WorkflowNode,
): WorkflowModelResolutionAudit | undefined {
	const modelResolution = options.modelResolution;
	if (!modelResolution) return undefined;
	return resolveWorkflowNodeModel(options.definition, node, {
		availableModels: modelResolution.availableModels,
		settings: modelResolution.settings,
		matchPreferences: modelResolution.matchPreferences,
		modelRegistry: modelResolution.modelRegistry,
		parentActiveModelPattern: modelResolution.parentActiveModelPattern,
		agentModel: resolveAgentModelPattern(modelResolution, node),
	}).audit;
}

function resolveAgentModelPattern(
	modelResolution: WorkflowRunnerModelResolutionOptions,
	node: WorkflowNode,
): string | string[] | undefined {
	if (!node.agent) return undefined;
	return modelResolution.agentModels?.[node.agent] ?? modelResolution.agentModels?.[node.id];
}

async function resolveScriptForExecution(options: WorkflowRunnerOptions, node: WorkflowNode): Promise<WorkflowNode> {
	if (node.type !== "script" || !node.script?.file) return node;
	if (!options.packageRoot) {
		throw new WorkflowRunnerError(`workflow script file for node "${node.id}" requires a workflow package root`);
	}
	const root = path.resolve(options.packageRoot);
	const resolved = path.resolve(root, node.script.file);
	const relative = path.relative(root, resolved);
	if (relative.startsWith("..") || path.isAbsolute(relative)) {
		throw new WorkflowRunnerError(`workflow script file for node "${node.id}" escapes the package root`);
	}
	try {
		const code = await Bun.file(resolved).text();
		return {
			...node,
			script: {
				...node.script,
				code,
			},
		};
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new WorkflowRunnerError(`workflow script file for node "${node.id}" is not readable: ${reason}`);
	}
}

function nodeRequiresModel(node: WorkflowNode): boolean {
	return node.type === "agent" || node.type === "review" || node.model !== undefined;
}

function nodeConsumesPrompt(node: WorkflowNode): boolean {
	return node.type === "agent" || node.type === "review" || node.type === "human";
}
