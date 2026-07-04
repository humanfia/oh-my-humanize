import { describe, expect, it } from "bun:test";
import { type Api, Effort, type Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Settings } from "../../src/config/settings";
import { parseWorkflowDefinition } from "../../src/workflow/definition";
import {
	resolvePortableWorkflowModelRequest,
	resolvePortableWorkflowNodeModel,
	resolveWorkflowNodeModel,
} from "../../src/workflow/model-resolution";

const anthropicModel = createModel({
	provider: "anthropic",
	id: "claude-sonnet-4-5",
	name: "Claude Sonnet 4.5",
	reasoning: true,
	thinking: {
		mode: "budget",
		efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
	},
});

const openAiModel = createModel({
	provider: "openai",
	id: "gpt-4o",
	name: "GPT-4o",
	reasoning: false,
});

const availableModels = [anthropicModel, openAiModel];

function createModel(options: {
	provider: string;
	id: string;
	name: string;
	reasoning: boolean;
	thinking?: Model<Api>["thinking"];
}): Model<Api> {
	return buildModel({
		id: options.id,
		name: options.name,
		api: "openai-completions",
		provider: options.provider,
		baseUrl: `https://${options.provider}.example.test`,
		reasoning: options.reasoning,
		...(options.thinking ? { thinking: options.thinking } : {}),
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	});
}

function workflow(source: string) {
	return parseWorkflowDefinition(source, { sourcePath: "workflow.yml" });
}

describe("workflow model resolution", () => {
	it("resolves workflow roles through the existing model role resolver and records audit metadata", () => {
		const definition = workflow(`
name: model-demo
version: 1
models:
  roles:
    reviewer: anthropic/claude-sonnet-4-5:xhigh
  defaults: {}
nodes:
  review:
    type: review
    model:
      role: reviewer
      unavailable: fail
edges: []
`);

		const result = resolveWorkflowNodeModel(definition, definition.nodes[0]!, { availableModels });

		expect(result.model?.provider).toBe("anthropic");
		expect(result.model?.id).toBe("claude-sonnet-4-5");
		expect(result.audit).toMatchObject({
			nodeId: "review",
			source: "node",
			requestedRole: "reviewer",
			requestedPattern: "anthropic/claude-sonnet-4-5:xhigh",
			resolvedModel: "anthropic/claude-sonnet-4-5",
			thinkingLevel: Effort.High,
			explicitThinkingLevel: true,
			fallbackUsed: false,
		});
	});

	it("lets explicit node selectors override agent frontmatter models", () => {
		const definition = workflow(`
name: selector-demo
version: 1
nodes:
  build:
    type: agent
    agent: task
    model:
      selector: openai/gpt-4o
edges: []
`);

		const result = resolveWorkflowNodeModel(definition, definition.nodes[0]!, {
			availableModels,
			agentModel: "anthropic/claude-sonnet-4-5",
		});

		expect(result.model?.provider).toBe("openai");
		expect(result.audit.source).toBe("node");
		expect(result.audit.requestedPattern).toBe("openai/gpt-4o");
		expect(result.audit.fallbackUsed).toBe(false);
	});

	it("falls through node candidate selectors in order", () => {
		const definition = workflow(`
name: candidate-demo
version: 1
nodes:
  build:
    type: agent
    model:
      candidates:
        - missing-provider/missing-model
        - openai/gpt-4o
edges: []
`);

		const result = resolveWorkflowNodeModel(definition, definition.nodes[0]!, { availableModels });

		expect(result.model?.provider).toBe("openai");
		expect(result.audit.requestedCandidates).toEqual(["missing-provider/missing-model", "openai/gpt-4o"]);
		expect(result.audit.resolvedModel).toBe("openai/gpt-4o");
	});

	it("fails closed for review nodes when their requested model is unavailable", () => {
		const definition = workflow(`
name: fail-closed-demo
version: 1
models:
  roles:
    reviewer: missing-provider/missing-model
  defaults: {}
nodes:
  review:
    type: review
    model:
      role: reviewer
      unavailable: fail
edges: []
`);

		const result = resolveWorkflowNodeModel(definition, definition.nodes[0]!, {
			availableModels,
			parentActiveModelPattern: "openai/gpt-4o",
		});

		expect(result.model).toBeUndefined();
		expect(result.audit).toMatchObject({
			nodeId: "review",
			source: "node",
			requestedRole: "reviewer",
			requestedPattern: "missing-provider/missing-model",
			unavailablePolicy: "fail",
			fallbackUsed: false,
			error: 'workflow model for node "review" could not resolve requested model',
		});
	});

	it("falls back to the parent active model when policy allows it", () => {
		const definition = workflow(`
name: fallback-demo
version: 1
nodes:
  build:
    type: agent
    model:
      selector: missing-provider/missing-model
      unavailable: fallback-to-parent
edges: []
`);

		const result = resolveWorkflowNodeModel(definition, definition.nodes[0]!, {
			availableModels,
			parentActiveModelPattern: "openai/gpt-4o",
		});

		expect(result.model?.provider).toBe("openai");
		expect(result.audit).toMatchObject({
			nodeId: "build",
			source: "parent-fallback",
			requestedPattern: "missing-provider/missing-model",
			resolvedModel: "openai/gpt-4o",
			fallbackUsed: true,
			fallbackReason: "requested model unavailable",
		});
	});

	it("uses the parent active model for portable node role defaults when policy allows it", () => {
		const definition = workflow(`
name: role-parent-demo
version: 1
models:
  roles:
    planner: openai/gpt-4o
  defaults: {}
  unavailable: fallback-to-parent
nodes:
  build:
    type: agent
    model:
      role: planner
edges: []
`);

		const result = resolveWorkflowNodeModel(definition, definition.nodes[0]!, {
			availableModels,
			parentActiveModelPattern: "anthropic/claude-sonnet-4-5",
		});

		expect(result.model?.provider).toBe("anthropic");
		expect(result.audit).toMatchObject({
			nodeId: "build",
			source: "parent-fallback",
			requestedRole: "planner",
			requestedPattern: "openai/gpt-4o",
			resolvedModel: "anthropic/claude-sonnet-4-5",
			fallbackUsed: true,
			fallbackReason: "parent active model overrides workflow role default",
		});
	});

	it("uses the parent active model when the workflow leaves model selection to the session", () => {
		const definition = workflow(`
name: session-model-demo
version: 1
nodes:
  review:
    type: review
    prompt: Review with the active session model.
edges: []
`);

		const result = resolveWorkflowNodeModel(definition, definition.nodes[0]!, {
			availableModels,
			parentActiveModelPattern: "openai/gpt-4o",
		});

		expect(result.model?.provider).toBe("openai");
		expect(result.audit).toMatchObject({
			nodeId: "review",
			source: "parent-fallback",
			resolvedModel: "openai/gpt-4o",
			fallbackUsed: true,
			fallbackReason: "no workflow model configured",
		});
	});

	it("uses workflow defaults before agent frontmatter models", () => {
		const definition = workflow(`
name: default-demo
version: 1
models:
  roles:
    builder: anthropic/claude-sonnet-4-5:medium
  defaults:
    agent: builder
nodes:
  build:
    type: agent
    agent: task
edges: []
`);

		const result = resolveWorkflowNodeModel(definition, definition.nodes[0]!, {
			availableModels,
			agentModel: "openai/gpt-4o",
		});

		expect(result.model?.provider).toBe("anthropic");
		expect(result.audit.source).toBe("workflow-default");
		expect(result.audit.requestedRole).toBe("builder");
		expect(result.audit.thinkingLevel).toBe(Effort.Medium);
	});

	describe("portable child model resolution", () => {
		it("preserves candidate order and resolves the first candidate available to the child", () => {
			const definition = workflow(`
name: portable-candidate-demo
version: 1
nodes:
  build:
    type: agent
    model:
      candidates:
        - missing-provider/missing-model
        - openai/gpt-4o
      unavailable: fail
edges: []
`);

			const portable = resolvePortableWorkflowNodeModel(definition, definition.nodes[0]!);

			expect(portable.request).toEqual({
				version: 1,
				nodeId: "build",
				patterns: ["missing-provider/missing-model", "openai/gpt-4o"],
				unavailablePolicy: "fail",
			});
			if (!portable.request) throw new Error("Expected a portable model request");

			const resolved = resolvePortableWorkflowModelRequest(portable.request, {
				availableModels,
				settings: Settings.isolated(),
			});

			expect(resolved.model?.provider).toBe("openai");
			expect(resolved.model?.id).toBe("gpt-4o");
			expect(resolved.resolvedPattern).toBe("openai/gpt-4o");
		});

		it("expands a portable pi role from child settings without dropping explicit thinking effort", () => {
			const definition = workflow(`
name: portable-role-demo
version: 1
nodes:
  review:
    type: review
    model:
      selector: pi/slow:high
      unavailable: fail
edges: []
`);
			const settings = Settings.isolated();
			settings.setModelRole("slow", "anthropic/claude-sonnet-4-5");

			const portable = resolvePortableWorkflowNodeModel(definition, definition.nodes[0]!);

			expect(portable.request).toEqual({
				version: 1,
				nodeId: "review",
				patterns: ["pi/slow:high"],
				unavailablePolicy: "fail",
			});
			if (!portable.request) throw new Error("Expected a portable model request");

			const resolved = resolvePortableWorkflowModelRequest(portable.request, { availableModels, settings });

			expect(resolved.model?.provider).toBe("anthropic");
			expect(resolved.model?.id).toBe("claude-sonnet-4-5");
			expect(resolved.thinkingLevel).toBe(Effort.High);
			expect(resolved.explicitThinkingLevel).toBe(true);
		});

		it("leaves an unavailable explicit selector to the parent when the portable policy allows fallback", () => {
			const definition = workflow(`
name: portable-fallback-demo
version: 1
nodes:
  build:
    type: agent
    model:
      selector: missing-provider/missing-model
      unavailable: fallback-to-parent
edges: []
`);

			const portable = resolvePortableWorkflowNodeModel(definition, definition.nodes[0]!);

			expect(portable.request).toEqual({
				version: 1,
				nodeId: "build",
				patterns: ["missing-provider/missing-model"],
				unavailablePolicy: "fallback-to-parent",
			});
			if (!portable.request) throw new Error("Expected a portable model request");

			const resolved = resolvePortableWorkflowModelRequest(portable.request, {
				availableModels,
				settings: Settings.isolated(),
			});

			expect(resolved).toEqual({ explicitThinkingLevel: false });
		});

		it("returns a node-scoped error for the same unavailable selector when the portable policy is fail", () => {
			const definition = workflow(`
name: portable-fail-demo
version: 1
nodes:
  build:
    type: agent
    model:
      selector: missing-provider/missing-model
      unavailable: fail
edges: []
`);

			const portable = resolvePortableWorkflowNodeModel(definition, definition.nodes[0]!);

			expect(portable.request).toEqual({
				version: 1,
				nodeId: "build",
				patterns: ["missing-provider/missing-model"],
				unavailablePolicy: "fail",
			});
			if (!portable.request) throw new Error("Expected a portable model request");

			const resolved = resolvePortableWorkflowModelRequest(portable.request, {
				availableModels,
				settings: Settings.isolated(),
			});

			expect(resolved).toEqual({
				explicitThinkingLevel: false,
				error: 'workflow model for node "build" could not resolve requested model',
			});
		});
	});
});
