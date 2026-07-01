import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { type ModelMatchPreferences, resolveAgentModelPatterns, resolveModelRoleValue } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import { AUTO_THINKING, type ConfiguredThinkingLevel } from "../thinking";
import type {
	WorkflowDefinition,
	WorkflowModelContext,
	WorkflowModelUnavailablePolicy,
	WorkflowNode,
} from "./definition";

export type WorkflowModelResolutionSource =
	| "activation-override"
	| "node"
	| "workflow-default"
	| "agent-frontmatter"
	| "parent-fallback"
	| "none";

export interface WorkflowModelResolutionOptions {
	availableModels: Model<Api>[];
	settings?: Settings;
	matchPreferences?: ModelMatchPreferences;
	agentModel?: string | string[];
	parentActiveModelPattern?: string;
	activationModel?: WorkflowModelContext;
}

export interface WorkflowModelResolutionAudit {
	nodeId: string;
	source: WorkflowModelResolutionSource;
	requestedRole?: string;
	requestedPattern?: string;
	requestedCandidates?: string[];
	unavailablePolicy: WorkflowModelUnavailablePolicy;
	resolvedModel?: string;
	thinkingLevel?: ThinkingLevel;
	explicitThinkingLevel: boolean;
	fallbackUsed: boolean;
	fallbackReason?: string;
	warning?: string;
	error?: string;
}

export interface WorkflowModelResolutionResult {
	model?: Model<Api>;
	thinkingLevel?: ThinkingLevel;
	audit: WorkflowModelResolutionAudit;
}

interface WorkflowModelRequest {
	source: Exclude<WorkflowModelResolutionSource, "parent-fallback" | "none">;
	role?: string;
	patterns: string[];
	candidates?: string[];
	modelContext?: WorkflowModelContext;
}

interface ResolvedWorkflowModelRequest {
	model: Model<Api>;
	thinkingLevel?: ThinkingLevel;
	explicitThinkingLevel: boolean;
	warning?: string;
	pattern: string;
}

function concreteThinkingLevel(level: ConfiguredThinkingLevel | undefined): ThinkingLevel | undefined {
	return level === AUTO_THINKING ? undefined : level;
}

export function resolveWorkflowNodeModel(
	definition: WorkflowDefinition,
	node: WorkflowNode,
	options: WorkflowModelResolutionOptions,
): WorkflowModelResolutionResult {
	const request = selectModelRequest(definition, node, options);
	const unavailablePolicy = resolveUnavailablePolicy(definition, node, request?.modelContext);
	const baseAudit = createAudit(node.id, request, unavailablePolicy);
	if (!request) {
		const parentDefault = resolveParentActiveModelDefault(options);
		if (parentDefault) {
			return {
				model: parentDefault.model,
				thinkingLevel: parentDefault.thinkingLevel,
				audit: {
					...baseAudit,
					source: "parent-fallback",
					resolvedModel: formatModel(parentDefault.model),
					thinkingLevel: parentDefault.thinkingLevel,
					explicitThinkingLevel: parentDefault.explicitThinkingLevel,
					fallbackUsed: true,
					fallbackReason: "no workflow model configured",
				},
			};
		}
		return { audit: baseAudit };
	}

	const portableOverrideReason = portableParentOverrideReason(request, unavailablePolicy);
	if (portableOverrideReason !== undefined) {
		const parentOverride = resolveParentActiveModelDefault(options);
		if (parentOverride) {
			return {
				model: parentOverride.model,
				thinkingLevel: parentOverride.thinkingLevel,
				audit: {
					...baseAudit,
					source: "parent-fallback",
					resolvedModel: formatModel(parentOverride.model),
					thinkingLevel: parentOverride.thinkingLevel,
					explicitThinkingLevel: parentOverride.explicitThinkingLevel,
					fallbackUsed: true,
					fallbackReason: portableOverrideReason,
				},
			};
		}
	}

	const resolved = resolveFirstPattern(request.patterns, options);
	if (resolved) {
		return {
			model: resolved.model,
			thinkingLevel: resolved.thinkingLevel,
			audit: {
				...baseAudit,
				resolvedModel: formatModel(resolved.model),
				thinkingLevel: resolved.thinkingLevel,
				explicitThinkingLevel: resolved.explicitThinkingLevel,
				fallbackUsed: false,
				warning: resolved.warning,
				requestedPattern: resolved.pattern,
			},
		};
	}

	if (unavailablePolicy === "fallback-to-parent" && options.parentActiveModelPattern) {
		const fallback = resolveFirstPattern([options.parentActiveModelPattern], options);
		if (fallback) {
			return {
				model: fallback.model,
				thinkingLevel: fallback.thinkingLevel,
				audit: {
					...baseAudit,
					source: "parent-fallback",
					resolvedModel: formatModel(fallback.model),
					thinkingLevel: fallback.thinkingLevel,
					explicitThinkingLevel: fallback.explicitThinkingLevel,
					fallbackUsed: true,
					fallbackReason: "requested model unavailable",
				},
			};
		}
	}

	return {
		audit: {
			...baseAudit,
			error: `workflow model for node "${node.id}" could not resolve requested model`,
		},
	};
}

function selectModelRequest(
	definition: WorkflowDefinition,
	node: WorkflowNode,
	options: WorkflowModelResolutionOptions,
): WorkflowModelRequest | undefined {
	if (options.activationModel) {
		return modelContextRequest(definition, options.activationModel, "activation-override");
	}
	if (node.model) {
		return modelContextRequest(definition, node.model, "node");
	}
	const defaultRole = definition.models.defaults[node.type];
	if (defaultRole) {
		return defaultRequest(definition, defaultRole);
	}
	if (node.type === "agent" && options.agentModel !== undefined) {
		const patterns = resolveAgentModelPatterns({
			agentModel: options.agentModel,
			settings: options.settings,
			activeModelPattern: options.parentActiveModelPattern,
		});
		if (patterns.length > 0) {
			return { source: "agent-frontmatter", patterns, candidates: patterns };
		}
	}
	return undefined;
}

function modelContextRequest(
	definition: WorkflowDefinition,
	model: WorkflowModelContext,
	source: Exclude<WorkflowModelResolutionSource, "parent-fallback" | "none">,
): WorkflowModelRequest {
	if (model.role) {
		const rolePattern = definition.models.roles[model.role];
		return {
			source,
			role: model.role,
			patterns: rolePattern ? [rolePattern] : [],
			modelContext: model,
		};
	}
	if (model.selector) {
		return { source, patterns: [model.selector], modelContext: model };
	}
	if (model.candidates) {
		return { source, patterns: [...model.candidates], candidates: [...model.candidates], modelContext: model };
	}
	return { source, patterns: [], modelContext: model };
}

function defaultRequest(definition: WorkflowDefinition, value: string): WorkflowModelRequest {
	const rolePattern = definition.models.roles[value];
	if (rolePattern) {
		return { source: "workflow-default", role: value, patterns: [rolePattern] };
	}
	return { source: "workflow-default", patterns: [value] };
}

function portableParentOverrideReason(
	request: WorkflowModelRequest,
	unavailablePolicy: WorkflowModelUnavailablePolicy,
): string | undefined {
	if (unavailablePolicy !== "fallback-to-parent" || request.patterns.length === 0) return undefined;
	if (request.source === "workflow-default") return "parent active model overrides workflow default";
	if (request.source === "node" && request.role !== undefined) {
		return "parent active model overrides workflow role default";
	}
	return undefined;
}

function resolveFirstPattern(
	patterns: string[],
	options: WorkflowModelResolutionOptions,
): ResolvedWorkflowModelRequest | undefined {
	for (const pattern of patterns) {
		const resolved = resolveModelRoleValue(pattern, options.availableModels, {
			settings: options.settings,
			matchPreferences: options.matchPreferences,
		});
		if (!resolved.model) continue;
		return {
			model: resolved.model,
			thinkingLevel: concreteThinkingLevel(resolved.thinkingLevel),
			explicitThinkingLevel: resolved.explicitThinkingLevel,
			warning: resolved.warning,
			pattern,
		};
	}
	return undefined;
}

function resolveParentActiveModelDefault(
	options: WorkflowModelResolutionOptions,
): ResolvedWorkflowModelRequest | undefined {
	if (!options.parentActiveModelPattern) return undefined;
	return resolveFirstPattern([options.parentActiveModelPattern], options);
}

function resolveUnavailablePolicy(
	definition: WorkflowDefinition,
	node: WorkflowNode,
	model: WorkflowModelContext | undefined,
): WorkflowModelUnavailablePolicy {
	if (model?.unavailable) return model.unavailable;
	if (definition.models.unavailable) return definition.models.unavailable;
	return node.type === "review" ? "fail" : "fallback-to-parent";
}

function createAudit(
	nodeId: string,
	request: WorkflowModelRequest | undefined,
	unavailablePolicy: WorkflowModelUnavailablePolicy,
): WorkflowModelResolutionAudit {
	return {
		nodeId,
		source: request?.source ?? "none",
		requestedRole: request?.role,
		requestedPattern: request?.patterns[0],
		requestedCandidates: request?.candidates,
		unavailablePolicy,
		explicitThinkingLevel: false,
		fallbackUsed: false,
	};
}

function formatModel(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}
